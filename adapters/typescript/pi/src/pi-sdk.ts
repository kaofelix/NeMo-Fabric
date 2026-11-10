// SPDX-FileCopyrightText: Copyright (c) 2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// Pi SDK integration boundary. It runs a controlled in-memory Pi session on the
// runtime's Pi configuration (native-configuration.ts), with the model key in
// memory, MCP connections the session tracks, and Relay capture.

import { homedir } from "node:os";
import { join, resolve } from "node:path";

import type { AuthProvider, JsonRpcMessage, McpTransport } from "@earendil-works/pi-mcp";
import type {
  AgentSession,
  ExtensionCommandContextActions,
  ExtensionFactory,
  McpExtensionOptions,
  McpServerConfig,
  McpTransportFactory,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { AdapterCheckResult, CheckLevel, CheckSource } from "nemo-fabric-adapter-contract";
import { LifecycleError, unobservedHealth, type AdapterStartInput } from "nemo-fabric-adapters-common";

import {
  PiRelayFactory,
  type PiRelayControllerFactory,
  type PiRelayRuntime,
} from "./relay.js";
import {
  containedBy,
  PI_BUILTIN_TOOL_NAMES,
  preparePiConfiguration,
  type PiModelRuntime,
  type PiNativeConfiguration,
  type PiSdkModules,
} from "./native-configuration.js";
import { invocationUsage } from "./usage.js";
import type { PiPromptOutcome, PiSessionFactory, PiSessionHandle } from "./runtime.js";
import { sdkEnabled } from "./settings.js";

const MCP_STARTUP_TIMEOUT_MS = 10_000;

type McpCredentials = NonNullable<McpExtensionOptions["credentials"]>;

function isolatedMcpCredentials(): McpCredentials {
  const credentials = {
    forServer: () => ({
      load: () => undefined,
      save: () => undefined,
      withRefreshLock: (operation: () => Promise<unknown>) => operation(),
    }),
    tokens: () => undefined,
    remove: () => false,
  };
  // SAFETY: Pi types this option as its concrete credential-store class even though
  // the extension uses only this public method surface.
  return credentials as unknown as McpCredentials;
}

interface McpReadiness {
  healthy: boolean;
  fail(): void;
  ready(): void;
  result: Promise<boolean>;
}

function mcpReadiness(): McpReadiness {
  let settle: (ready: boolean) => void = () => undefined;
  let settled = false;
  const result = new Promise<boolean>((resolve) => {
    settle = resolve;
  });
  const finish = (ready: boolean) => {
    if (!settled) {
      settled = true;
      settle(ready);
    }
  };
  const status: McpReadiness = {
    healthy: false,
    fail: () => { status.healthy = false; finish(false); },
    ready: () => { status.healthy = true; finish(true); },
    result,
  };
  return status;
}

function trackedMcpTransport(transport: McpTransport, readiness: McpReadiness): McpTransport {
  const toolListRequests = new Set<unknown>();
  return {
    async start() {
      try {
        await transport.start();
      } catch (error) {
        readiness.fail();
        throw error;
      }
    },
    async send(message: JsonRpcMessage) {
      if ("method" in message && message.method === "tools/list" && "id" in message) {
        toolListRequests.add(message.id);
      }
      try {
        await transport.send(message);
      } catch (error) {
        readiness.fail();
        throw error;
      }
    },
    close: () => { readiness.fail(); return transport.close(); },
    onMessage: (listener) => transport.onMessage((message) => {
      if ("id" in message && toolListRequests.has(message.id)) {
        toolListRequests.delete(message.id);
        if ("error" in message) {
          readiness.fail();
        } else {
          readiness.ready();
        }
      }
      listener(message);
    }),
    onError: (listener) => transport.onError((error) => {
      readiness.fail();
      listener(error);
    }),
    onClose: (listener) => transport.onClose(() => {
      readiness.fail();
      listener();
    }),
    ...(transport.setProtocolVersion === undefined
      ? {}
      : { setProtocolVersion: (version: string) => transport.setProtocolVersion?.(version) }),
  };
}

function expandHome(value: string): string {
  if (value === "~") {
    return homedir();
  }
  if (value.startsWith("~/") || (process.platform === "win32" && value.startsWith("~\\"))) {
    return join(homedir(), value.slice(2));
  }
  return value;
}

function mcpTransportFactory(pi: PiSdkModules, readiness: Map<string, McpReadiness>): McpTransportFactory {
  return (entry, cwd, authProvider: AuthProvider | undefined) => {
    const status = readiness.get(entry.name);
    if (status === undefined) {
      throw new Error("Unrecognized Pi MCP server");
    }
    const transport = "url" in entry.config
      ? new pi.StreamableHttpTransport({
          url: entry.config.url,
          headers: entry.config.headers,
          authProvider,
        })
      : new pi.StdioTransport({
          command: expandHome(entry.config.command),
          args: entry.config.args?.map(expandHome),
          cwd: resolve(cwd, expandHome(entry.config.cwd ?? ".")),
          env: entry.config.env,
          stderr: "pipe",
        });
    return trackedMcpTransport(transport, status);
  };
}

async function requireMcpConnections(readiness: Map<string, McpReadiness>): Promise<void> {
  if (readiness.size === 0) {
    return;
  }
  let cancelTimer: () => void = () => undefined;
  const results = await Promise.race([
    Promise.all(Array.from(readiness.values(), (status) => status.result)),
    new Promise<undefined>((resolve) => {
      const timer = setTimeout(resolve, MCP_STARTUP_TIMEOUT_MS);
      cancelTimer = () => clearTimeout(timer);
    }),
  ]);
  cancelTimer();
  if (results === undefined || results.some((ready) => !ready)) {
    throw new LifecycleError(
      "pi_mcp_connection_failed",
      "One or more configured Pi MCP servers could not connect",
    );
  }
}

function mcpRegistrationExtension(servers: Record<string, McpServerConfig>): ExtensionFactory {
  return (api) => {
    for (const [name, server] of Object.entries(servers)) {
      api.registerMcpServer(name, server);
    }
  };
}

function rejectToolCollisions(customTools: ToolDefinition[], configuredExtensionTools: string[]): void {
  const customNames = new Set(customTools.map((tool) => tool.name));
  const seenExtensionNames = new Set<string>();
  for (const name of configuredExtensionTools) {
    if (PI_BUILTIN_TOOL_NAMES.has(name) || customNames.has(name) || seenExtensionNames.has(name)) {
      throw new LifecycleError("pi_tool_collision", "Two configured Pi tool sources use the same tool name", {
        metadata: { tool: name },
      });
    }
    seenExtensionNames.add(name);
  }
}

function relayExtensionLoadErrors(
  errors: Array<{ path: string; error: string }>,
  extensions: Array<{ path: string; resolvedPath?: string }>,
  relay: PiRelayRuntime | undefined,
  workspace: string,
): Array<{ path: string; error: string }> {
  if (relay === undefined) {
    return [];
  }
  const loaded = extensions.some((extension) =>
    [extension.path, extension.resolvedPath].some(
      (path) => path !== undefined && resolve(workspace, path) === relay.extensionPath,
    ),
  );
  if (loaded) {
    return [];
  }
  return errors.filter((error) => {
    const path = resolve(workspace, error.path);
    return path === relay.extensionPath || containedBy(relay.extensionPath, path);
  });
}

function promptText(message: { content?: unknown }): string {
  if (!Array.isArray(message.content)) {
    return "";
  }
  return message.content
    .filter((block): block is { type: "text"; text: string } => {
      return (
        typeof block === "object" &&
        block !== null &&
        "type" in block &&
        block.type === "text" &&
        "text" in block &&
        typeof block.text === "string"
      );
    })
    .map((block) => block.text)
    .join("");
}

function unsupportedSessionAction(name: string): never {
  throw new LifecycleError("pi_unsupported_session_operation", `Pi session operation ${name} is not supported`);
}

class PiSdkSessionHandle implements PiSessionHandle {
  readonly relay?: PiRelayRuntime;
  private readonly session: AgentSession;
  private readonly state: { shutdownRequested: boolean };
  private readonly unsubscribeTurnCounter: () => void;
  private stopped = false;
  private cumulativeTurnCount = 0;
  private initialized = false;
  private requiredTools: readonly string[] = [];
  private readonly nativeSessionId: string;
  private readonly modelRuntime: PiModelRuntime;
  private readonly expectedModel: { id: string; provider: string };
  private readonly connections: Map<string, McpReadiness>;
  readonly configuration: PiNativeConfiguration;

  constructor(session: AgentSession, state: { shutdownRequested: boolean },
    modelRuntime: PiModelRuntime, expectedModel: { id: string; provider: string },
    connections: Map<string, McpReadiness>, configuration: PiNativeConfiguration, relay?: PiRelayRuntime) {
    this.session = session;
    this.configuration = configuration;
    this.state = state;
    this.relay = relay;
    this.modelRuntime = modelRuntime;
    this.expectedModel = expectedModel;
    this.connections = connections;
    this.nativeSessionId = session.sessionId;
    this.unsubscribeTurnCounter = this.session.subscribe((event) => {
      if (event.type === "turn_start") {
        this.cumulativeTurnCount += 1;
      }
    });
  }

  get turnCount(): number {
    return this.cumulativeTurnCount;
  }

  initialize(requiredTools: readonly string[]): void {
    this.requiredTools = [...requiredTools];
    this.initialized = true;
  }

  async check(level: CheckLevel): Promise<AdapterCheckResult> {
    if (this.stopped) return { ...unobservedHealth("session_closed"), outcome: "failed", activity: "stopped" };
    if (!this.initialized) return unobservedHealth("capabilities_unverified");
    if (this.session.sessionId !== this.nativeSessionId) return unobservedHealth("observation_changed");
    try {
      // The native context checks that its runner has not been disposed.
      // Both idle and busy responses are current liveness evidence.
      const idle = this.session.extensionRunner.createContext().isIdle();
      if (typeof idle !== "boolean") return unobservedHealth("probe_error");
      const activity = idle ? "idle" : "busy";
      const source: CheckSource = level === "live" ? "fabric.adapter.liveness"
        : level === "active" ? "fabric.adapter.interface" : "fabric.adapter.readiness";
      const observed_at = new Date().toISOString();
      if (level !== "live" && this.state.shutdownRequested) return {
        outcome: "failed", reason_code: "endpoint_unavailable", activity: "stopping", source, observed_at,
      };
      if (level === "ready") {
        const model = this.session.model;
        const available = new Set([
          ...this.session.getActiveToolNames(), ...this.session.getCallableToolNames(),
        ]);
        if (model?.id !== this.expectedModel.id || model.provider !== this.expectedModel.provider
          || this.modelRuntime.getModel(model.provider, model.id) === undefined
          || this.requiredTools.some((name) => !available.has(name))
          || [...this.connections.values()].some((connection) => !connection.healthy)) {
          return { outcome: "failed", reason_code: "health_failed", activity, source, observed_at };
        }
      }
      return { outcome: "passed", reason_code: null, activity, source, observed_at };
    } catch { return unobservedHealth("probe_error"); }
  }

  async prompt(text: string): Promise<PiPromptOutcome> {
    const before = this.session.sessionManager.getEntries().map((entry) => entry.id);
    let accountingComplete = true;
    let accepted = false;
    let turnStarted = false;
    let finalAssistant:
      | { role: "assistant"; content: unknown; stopReason: string; errorMessage?: string }
      | undefined;
    const unsubscribe = this.session.subscribe((event) => {
      if (event.type === "summarization_retry_scheduled" ||
          (event.type === "compaction_end" && (event.aborted || event.errorMessage !== undefined))) {
        // Failed summary attempts do not survive in Pi's usage ledger.
        accountingComplete = false;
      }
      if (event.type === "turn_start") {
        turnStarted = true;
      }
      if (event.type === "message_end" && event.message.role === "assistant") {
        finalAssistant = event.message;
      }
    });
    try {
      await this.session.prompt(text, {
        expandPromptTemplates: true,
        source: "interactive",
        preflightResult: () => {
          accepted = true;
        },
      });
    } finally {
      unsubscribe();
    }
    return {
      usage: accountingComplete ? invocationUsage(before, this.session.sessionManager.getEntries()) : undefined,
      accepted,
      turnStarted,
      turnCount: this.cumulativeTurnCount,
      text: finalAssistant === undefined ? undefined : promptText(finalAssistant),
      stopReason: finalAssistant?.stopReason,
      errorMessage: finalAssistant?.errorMessage,
      shutdownRequested: this.state.shutdownRequested,
    };
  }

  async stop(): Promise<void> {
    if (this.stopped) {
      return;
    }
    this.stopped = true;
    // The runtime's agent directory stays: it holds no secrets, and like other adapters'
    // runtime directories it remains under the artifact root for inspection.
    let failure: unknown;
    try {
      await this.session.abort();
    } catch (error) {
      failure = error;
    }
    try {
      await this.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    } catch (error) {
      failure ??= error;
    }
    try {
      this.unsubscribeTurnCounter();
    } catch (error) {
      failure ??= error;
    }
    try {
      this.session.dispose();
    } catch (error) {
      failure ??= error;
    }
    if (failure !== undefined) {
      throw failure;
    }
  }
}

export class PiSdkSessionFactory implements PiSessionFactory {
  private readonly relayFactory: PiRelayControllerFactory;

  constructor(relayFactory: PiRelayControllerFactory = new PiRelayFactory()) {
    this.relayFactory = relayFactory;
  }

  async create(input: AdapterStartInput): Promise<PiSessionHandle> {
    if (!sdkEnabled(input.config)) {
      // A runtime without the SDK runs only native interfaces (see terminal.ts).
      throw new LifecycleError("pi_sdk_disabled", "Embedded Pi SDK execution is disabled");
    }
    const { pi, configuration, modelRuntime, model, extensionPaths, skillPaths, customTools, mcpServers } =
      await preparePiConfiguration(input);
    const { workspace, agentDir } = configuration;
    const settings = pi.SettingsManager.create(workspace, agentDir, { projectTrusted: false });
    let relay: PiRelayRuntime | undefined;
    let handle: PiSdkSessionHandle | undefined;
    try {
      relay = await this.relayFactory.start(input, {
        api: model.api,
        baseUrl: model.baseUrl,
      });
      if (relay !== undefined && !extensionPaths.includes(relay.extensionPath)) {
        extensionPaths.push(relay.extensionPath);
      }
      const mcpConnections = new Map(Object.keys(mcpServers).map((name) => [name, mcpReadiness()]));
      const extensionFactories = Object.keys(mcpServers).length === 0
        ? []
        : [
            { name: "nemo-fabric-mcp-servers", hidden: true, factory: mcpRegistrationExtension(mcpServers) },
            {
              name: "nemo-fabric-mcp",
              hidden: true,
              factory: pi.createMcpExtension({
                loadConfig: () => ({ servers: [], errors: [], autoEnableCodemode: false }),
                credentials: isolatedMcpCredentials(),
                logPath: join(agentDir, "mcp.log"),
                createTransport: mcpTransportFactory(pi, mcpConnections),
                startupWaitMs: MCP_STARTUP_TIMEOUT_MS,
              }),
            },
          ];
      const resourceLoader = new pi.DefaultResourceLoader({
        cwd: workspace,
        agentDir,
        settingsManager: settings,
        additionalExtensionPaths: extensionPaths,
        additionalSkillPaths: skillPaths,
        extensionFactories,
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        // The system prompt is <agent dir>/SYSTEM.md, which writeAgentDirectory wrote when one is configured.
        noContextFiles: true,
      });
      await resourceLoader.reload();
      const extensionResult = resourceLoader.getExtensions();
      rejectToolCollisions(
        customTools,
        extensionResult.extensions.flatMap((extension) => [...extension.tools.keys()]),
      );
      const extensionErrors = extensionResult.errors;
      const relayErrors = relayExtensionLoadErrors(extensionErrors, extensionResult.extensions, relay, workspace);
      if (relayErrors.length > 0) {
        throw new LifecycleError(
          "pi_relay_extension_load_failed",
          "The configured NeMo Relay Pi extension failed to load; use the Pi extension matching the installed NeMo Relay CLI release",
          {
            metadata: {
              count: relayErrors.length,
              relay_error: relayErrors.map((error) => error.error).join("; "),
            },
          },
        );
      }
      if (extensionErrors.length > 0) {
        throw new LifecycleError(
          "pi_extension_load_failed",
          "One or more configured Pi extensions failed to load or conflict",
          {
            metadata: {
              count: extensionErrors.length,
              extension_error: extensionErrors.map((error) => error.error).join("; "),
              extension_paths: extensionErrors.map((error) => error.path),
            },
          },
        );
      }
      const skillDiagnostics = resourceLoader.getSkills().diagnostics;
      const blockingSkillDiagnostics = skillDiagnostics.filter(
        (diagnostic) => diagnostic.type === "error" || diagnostic.type === "collision",
      );
      for (const diagnostic of skillDiagnostics.filter((entry) => entry.type === "warning")) {
        process.stderr.write(`Pi skill warning: ${diagnostic.message}\n`);
      }
      if (blockingSkillDiagnostics.length > 0) {
        throw new LifecycleError("pi_skill_load_failed", "One or more configured NeMo Fabric skills failed to load", {
          metadata: { count: blockingSkillDiagnostics.length },
        });
      }

      const enabled = input.config.tools?.enabled;
      const blocked = input.config.tools?.blocked ?? [];
      const state = { shutdownRequested: false };
      const { session } = await pi.createAgentSession({
        cwd: workspace,
        agentDir,
        model,
        modelRuntime,
        resourceLoader,
        sessionManager: pi.SessionManager.inMemory(workspace),
        settingsManager: settings,
        customTools,
        tools: enabled === null ? undefined : enabled,
        excludeTools: blocked,
      });
      handle = new PiSdkSessionHandle(session, state, modelRuntime,
        { id: model.id, provider: model.provider }, mcpConnections, configuration, relay);
      const blockedNames = new Set(blocked);
      const availableNames = new Set(session.getAllTools().map((tool) => tool.name));
      const missing = (enabled ?? []).filter((name) => !blockedNames.has(name) && !availableNames.has(name));
      if (missing.length > 0) {
        throw new LifecycleError("pi_tool_missing", "One or more enabled tools are not registered", {
          metadata: { tools: missing },
        });
      }

      const commandContextActions: ExtensionCommandContextActions = {
        waitForIdle: () => session.waitForIdle(),
        newSession: async () => unsupportedSessionAction("newSession"),
        fork: async () => unsupportedSessionAction("fork"),
        navigateTree: async () => unsupportedSessionAction("navigateTree"),
        switchSession: async () => unsupportedSessionAction("switchSession"),
        reload: async () => unsupportedSessionAction("reload"),
      };
      await session.bindExtensions({
        mode: "print",
        commandContextActions,
        abortHandler: () => {
          void session.abort();
        },
        shutdownHandler: () => {
          state.shutdownRequested = true;
          void session.abort();
        },
        onError: () => {
          process.stderr.write("Pi extension handler failed\n");
        },
      });
      await requireMcpConnections(mcpConnections);
      handle.initialize((enabled ?? session.getActiveToolNames()).filter((name) => !blockedNames.has(name)));
      // bindExtensions emits session_start; emitting it here would create a
      // duplicate Relay session scope.
      return handle;
    } catch (error) {
      await handle?.stop().catch(() => {
        process.stderr.write("Pi session cleanup failed after adapter startup error\n");
      });
      await relay?.stop().catch(() => {
        process.stderr.write("NeMo Relay cleanup failed after Pi adapter startup error\n");
      });
      throw error;
    }
  }
}
