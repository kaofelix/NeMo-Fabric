// SPDX-FileCopyrightText: Copyright (c) 2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// Pi's terminal UI as a native interface of a Fabric runtime. With
// harness.settings.interfaces.terminal, the adapter writes the configuration it
// gives its embedded SDK session to a runtime-owned Pi agent directory, plus a
// launcher that opens the stock `pi` terminal UI on it in a separate session.
// The launcher holds paths and switches, never secrets: models.json names the
// key's environment variable, and Pi reads it when the terminal UI starts.

import { access, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { McpServerConfig } from "@earendil-works/pi-coding-agent";
import type { AgentConfig, JsonObject } from "nemo-fabric-adapter-contract";
import { LifecycleError, type AdapterStartInput } from "nemo-fabric-adapters-common";

import type { PiPromptOutcome, PiSessionHandle } from "./runtime.js";

/** How long `stop` waits for open terminal UIs to shut down after the marker is removed. */
const TERMINAL_SHUTDOWN_GRACE_MS = 5_000;
/** How long after SIGTERM `stop` waits before sending SIGKILL to a remaining terminal UI. */
const TERMINAL_KILL_GRACE_MS = 1_000;
/** A registration whose heartbeat is older than this belongs to a terminal UI that no longer runs. */
const TERMINAL_HEARTBEAT_STALE_MS = 3_000;
const TERMINAL_HEARTBEAT_MS = 500;
/** How long a terminal UI waits for its orderly shutdown before it sends itself SIGTERM. */
const TERMINAL_SELF_TERMINATE_MS = 2_000;
const TOOL_NAME = /^[A-Za-z0-9_.:-]+$/u;

export interface PiTerminalCustomTool {
  name: string;
  path: string;
  exportName: string;
  settings: JsonObject;
}

/** What the terminal UI must share with the runtime's embedded session. */
export interface PiTerminalPlan {
  workspace: string;
  provider: string;
  /** The provider-scope endpoint the session registered, if any. */
  baseUrl?: string;
  /** The model definition the session registered, without its endpoint. */
  model: Record<string, unknown>;
  apiKeyEnv: string;
  compactionReserveTokens: number;
  extensionPaths: string[];
  skillPaths: string[];
  systemPrompt?: string;
  toolsEnabled?: string[] | null;
  toolsBlocked: string[];
  customTools: PiTerminalCustomTool[];
  /** MCP servers in Pi's mcp.json shape, with header variable references left unexpanded. */
  mcpServers: Record<string, McpServerConfig>;
}

/** Whether the configuration enables Pi's terminal UI interface. */
export function terminalEnabled(config: AgentConfig): boolean {
  const interfaces = config.harness?.settings?.interfaces;
  if (interfaces === undefined || interfaces === null) return false;
  if (typeof interfaces !== "object" || Array.isArray(interfaces)) {
    throw new LifecycleError("pi_invalid_settings", "Pi interface settings do not match the adapter schema");
  }
  const terminal = (interfaces as Record<string, unknown>).terminal;
  if (terminal === undefined || terminal === null) return false;
  if (typeof terminal !== "object" || Array.isArray(terminal)) {
    throw new LifecycleError("pi_invalid_settings", "Pi interface settings do not match the adapter schema");
  }
  const enabled = (terminal as Record<string, unknown>).enabled;
  if (enabled !== undefined && typeof enabled !== "boolean") {
    throw new LifecycleError("pi_invalid_settings", "Pi interface settings do not match the adapter schema");
  }
  return enabled !== false;
}

/** `<artifact root>/.fabric/pi/runtimes/<runtime-id>`, as the other adapters' interfaces use. */
export function runtimeDirectory(input: AdapterStartInput): string {
  const root = input.runtimeContext.artifacts.root;
  const artifactRoot =
    root === undefined || root === null
      ? resolve(input.baseDir, "artifacts")
      : resolve(input.baseDir, String(root));
  return join(artifactRoot, ".fabric", "pi", "runtimes", input.runtimeContext.runtime_id);
}

/** The bundled `pi` CLI of the Pi package the adapter's SDK session uses, so both run one version. */
export async function resolvePiCli(): Promise<string> {
  let entry: string;
  try {
    entry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
  } catch {
    throw new LifecycleError("pi_harness_unavailable", "The Pi coding agent package is not installed");
  }
  for (let directory = dirname(entry); directory !== dirname(directory); directory = dirname(directory)) {
    let manifest: { name?: unknown; bin?: unknown };
    try {
      manifest = JSON.parse(await readFile(join(directory, "package.json"), "utf8")) as typeof manifest;
    } catch {
      continue;
    }
    if (manifest.name !== "@earendil-works/pi-coding-agent") continue;
    const bin = typeof manifest.bin === "object" && manifest.bin !== null
      ? (manifest.bin as Record<string, unknown>).pi
      : undefined;
    if (typeof bin !== "string") break;
    const cli = join(directory, bin);
    try {
      await access(cli);
      return cli;
    } catch {
      break;
    }
  }
  throw new LifecycleError("pi_harness_incompatible", "The installed Pi package does not provide its `pi` CLI");
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function toolList(names: readonly string[], field: string): string {
  for (const name of names) {
    if (!TOOL_NAME.test(name)) {
      throw new LifecycleError("pi_invalid_settings", `Pi's terminal UI can't pass ${field} tool name ${JSON.stringify(name)}`);
    }
  }
  return names.join(",");
}

/** The `pi` arguments that reproduce the embedded session's isolation and tool policy. */
export function terminalArguments(plan: PiTerminalPlan, agentDir: string): string[] {
  const args = [
    // The embedded session doesn't trust the project: no .pi/ settings, resources or MCP servers.
    "--no-approve",
    // The embedded session loads no ambient extensions, skills, prompts, themes or context files.
    "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files",
    "--extension", join(agentDir, "fabric-terminal.ts"),
  ];
  if (plan.customTools.length > 0) args.push("--extension", join(agentDir, "fabric-tools.ts"));
  if (Object.keys(plan.mcpServers).length > 0) args.push("--extension", "builtin:mcp");
  for (const path of plan.extensionPaths) args.push("--extension", path);
  for (const path of plan.skillPaths) args.push("--skill", path);
  if (plan.toolsEnabled !== undefined && plan.toolsEnabled !== null) {
    if (plan.toolsEnabled.length === 0) args.push("--no-tools");
    else args.push("--tools", toolList(plan.toolsEnabled, "enabled"));
  }
  if (plan.toolsBlocked.length > 0) args.push("--exclude-tools", toolList(plan.toolsBlocked, "blocked"));
  return args;
}

export function launcherScript(options: {
  node: string;
  cli: string;
  agentDir: string;
  sessionDir: string;
  workspace: string;
  marker: string;
  args: string[];
}): string {
  const exports = Object.entries({
    PI_CODING_AGENT_DIR: options.agentDir,
    PI_CODING_AGENT_SESSION_DIR: options.sessionDir,
    // The embedded session makes no model-catalog, version or telemetry requests.
    PI_OFFLINE: "1",
    PI_SKIP_VERSION_CHECK: "1",
    PI_TELEMETRY: "0",
  }).map(([name, value]) => `export ${name}=${shellQuote(value)}`);
  return [
    "#!/bin/sh",
    "# Opens Pi's terminal UI in a separate session with this NeMo Fabric runtime's",
    "# configuration. It holds paths and switches, never secrets: set the model key's",
    "# environment variable in the environment that runs this launcher.",
    `if [ ! -e ${shellQuote(options.marker)} ]; then`,
    "  echo 'This NeMo Fabric runtime is not running.' >&2",
    "  exit 1",
    "fi",
    ...exports,
    `cd ${shellQuote(options.workspace)} || exit 1`,
    `exec ${[options.node, options.cli, ...options.args].map(shellQuote).join(" ")} "$@"`,
    "",
  ].join("\n");
}

/**
 * A Pi extension that ties each terminal UI to the runtime: it registers the
 * process while it runs, refreshes the registration as a heartbeat, and shuts
 * Pi down in order when the runtime's marker disappears.
 */
export function supervisorExtension(marker: string, registry: string): string {
  return `// Generated by the NeMo Fabric Pi adapter. Ties this terminal UI to its runtime.
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const MARKER = ${JSON.stringify(marker)};
const REGISTRY = ${JSON.stringify(registry)};

export default function (pi) {
  const entry = join(REGISTRY, String(process.pid));
  let context;
  let stopping = false;
  const beat = () => {
    if (stopping) return;
    if (!existsSync(MARKER)) {
      stopping = true;
      clearInterval(timer);
      context?.ui?.notify?.("The NeMo Fabric runtime stopped; closing Pi.", "warning");
      // The terminal UI acts on shutdown() at once; other modes defer it until a
      // command finishes, so fall back to SIGTERM, which Pi also handles in order.
      setTimeout(() => process.kill(process.pid, "SIGTERM"), ${TERMINAL_SELF_TERMINATE_MS});
      context?.shutdown();
      return;
    }
    mkdirSync(REGISTRY, { recursive: true, mode: 0o700 });
    writeFileSync(entry, "", { mode: 0o600 });
  };
  const timer = setInterval(beat, ${TERMINAL_HEARTBEAT_MS});
  timer.unref?.();
  process.once("exit", () => rmSync(entry, { force: true }));
  pi.on("session_start", (_event, ctx) => {
    context = ctx;
    beat();
  });
}
`;
}

/** A module that registers the runtime's Fabric module tools in the terminal UI. */
export function toolBridgeExtension(workspace: string, tools: readonly PiTerminalCustomTool[]): string {
  const imports = tools.map((tool, index) => `import * as tool${index} from ${JSON.stringify(tool.path)};`);
  const registrations = tools.map((tool, index) =>
    `  pi.registerTool(await tool${index}[${JSON.stringify(tool.exportName)}](` +
    `{ name: ${JSON.stringify(tool.name)}, settings: ${JSON.stringify(tool.settings)}, workspace: WORKSPACE }));`);
  return [
    "// Generated by the NeMo Fabric Pi adapter. Registers the runtime's tools.definitions.",
    ...imports,
    "",
    `const WORKSPACE = ${JSON.stringify(workspace)};`,
    "",
    "export default async function (pi) {",
    ...registrations,
    "}",
    "",
  ].join("\n");
}

function piSettings(plan: PiTerminalPlan): JsonObject {
  return {
    defaultProvider: plan.provider,
    defaultModel: String(plan.model.id),
    // Only agent-directory settings can set this; the launcher's --no-approve also applies it.
    defaultProjectTrust: "never",
    cacheWarming: "off",
    compaction: { reserveTokens: plan.compactionReserveTokens },
    enableInstallTelemetry: false,
    packages: [],
  };
}

function piModels(plan: PiTerminalPlan): JsonObject {
  return {
    providers: {
      [plan.provider]: {
        ...(plan.baseUrl === undefined ? {} : { baseUrl: plan.baseUrl }),
        // Pi resolves the reference when the terminal UI starts; the file holds no secret.
        apiKey: `$${plan.apiKeyEnv}`,
        models: [plan.model as JsonObject],
      },
    },
  };
}

async function writePrivate(path: string, contents: string, mode = 0o600): Promise<void> {
  await writeFile(path, contents, { mode });
}

/** The terminal interface of one runtime. */
export class PiTerminal {
  readonly launcher: string;
  readonly marker: string;
  private readonly registry: string;
  private withdrawn = false;

  private constructor(launcher: string, marker: string, registry: string) {
    this.launcher = launcher;
    this.marker = marker;
    this.registry = registry;
  }

  /** Write the agent directory and launcher; the launcher refuses to run until {@link publish}. */
  static async prepare(plan: PiTerminalPlan, directory: string, node: string, cli: string): Promise<PiTerminal> {
    const agentDir = join(directory, "pi-agent");
    const sessionDir = join(directory, "pi-sessions");
    const interfaces = join(directory, "interfaces");
    const marker = join(interfaces, "terminal.running");
    const registry = join(interfaces, "terminal.d");
    for (const path of [agentDir, sessionDir, interfaces]) {
      await mkdir(path, { recursive: true, mode: 0o700 });
    }
    await writePrivate(join(agentDir, "settings.json"), `${JSON.stringify(piSettings(plan), null, 2)}\n`);
    await writePrivate(join(agentDir, "models.json"), `${JSON.stringify(piModels(plan), null, 2)}\n`);
    if (Object.keys(plan.mcpServers).length > 0) {
      await writePrivate(join(agentDir, "mcp.json"), `${JSON.stringify({ mcpServers: plan.mcpServers }, null, 2)}\n`);
    }
    if (plan.systemPrompt !== undefined) await writePrivate(join(agentDir, "SYSTEM.md"), plan.systemPrompt);
    await writePrivate(join(agentDir, "fabric-terminal.ts"), supervisorExtension(marker, registry));
    if (plan.customTools.length > 0) {
      await writePrivate(join(agentDir, "fabric-tools.ts"), toolBridgeExtension(plan.workspace, plan.customTools));
    }
    const launcher = join(interfaces, "terminal");
    await writePrivate(launcher, launcherScript({
      node,
      cli,
      agentDir,
      sessionDir,
      workspace: plan.workspace,
      marker,
      args: terminalArguments(plan, agentDir),
    }), 0o700);
    return new PiTerminal(launcher, marker, registry);
  }

  /** Let the launcher run: called once the runtime's embedded session is ready. */
  async publish(): Promise<void> {
    await writePrivate(this.marker, `${process.pid}\n`);
  }

  /**
   * Close the interface before the runtime stops: remove the marker so the
   * launcher refuses new terminals and open ones shut themselves down, then
   * signal any that are still running after the grace period.
   */
  async withdraw(): Promise<void> {
    if (this.withdrawn) return;
    await rm(this.marker, { force: true });
    this.withdrawn = true;
    const deadline = Date.now() + TERMINAL_SHUTDOWN_GRACE_MS;
    let remaining = await this.liveTerminals();
    while (remaining.length > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      remaining = await this.liveTerminals();
    }
    if (remaining.length === 0) return;
    signal(remaining, "SIGTERM");
    await new Promise((resolve) => setTimeout(resolve, TERMINAL_KILL_GRACE_MS));
    signal(await this.liveTerminals(), "SIGKILL");
    await rm(this.registry, { recursive: true, force: true });
  }

  /** Registered terminal UIs whose heartbeat is current; stale registrations are removed unsignalled. */
  private async liveTerminals(): Promise<number[]> {
    let entries: string[];
    try {
      entries = await readdir(this.registry);
    } catch {
      return [];
    }
    const live: number[] = [];
    for (const name of entries) {
      const path = join(this.registry, name);
      const pid = Number(name);
      try {
        const fresh = Date.now() - (await stat(path)).mtimeMs < TERMINAL_HEARTBEAT_STALE_MS;
        if (Number.isSafeInteger(pid) && pid > 1 && fresh && alive(pid)) {
          live.push(pid);
          continue;
        }
      } catch {
        // Removed while reading: that terminal UI exited.
      }
      await rm(path, { force: true });
    }
    return live;
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function signal(pids: readonly number[], name: NodeJS.Signals): void {
  for (const pid of pids) {
    try {
      process.kill(pid, name);
    } catch {
      // It exited between the check and the signal.
    }
  }
}

/** Withdraws the terminal interface before the embedded session stops. */
export class PiTerminalSessionHandle implements PiSessionHandle {
  private readonly inner: PiSessionHandle;
  private readonly terminal: PiTerminal;

  constructor(inner: PiSessionHandle, terminal: PiTerminal) {
    this.inner = inner;
    this.terminal = terminal;
  }

  get relay() {
    return this.inner.relay;
  }

  get turnCount() {
    return this.inner.turnCount;
  }

  prompt(text: string): Promise<PiPromptOutcome> {
    return this.inner.prompt(text);
  }

  check(level: Parameters<PiSessionHandle["check"]>[0]) {
    // A terminal UI is a separate client; its state doesn't change the runtime's health.
    return this.inner.check(level);
  }

  async stop(): Promise<void> {
    let failure: unknown;
    try {
      await this.terminal.withdraw();
    } catch (error) {
      failure = error;
    }
    await this.inner.stop();
    if (failure !== undefined) throw failure;
  }
}
