// SPDX-FileCopyrightText: Copyright (c) 2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// Pi's configuration for a runtime, resolved from FabricConfig: the selected
// model, the API key's variable, extensions, skills, tools and MCP servers. The
// adapter writes it to the runtime's Pi agent directory (agent-directory.ts),
// which the embedded SDK session and Pi's terminal UI both read, and checks that
// Pi resolves the selected model from those files. It starts no session.

import { readFile, realpath, stat } from "node:fs/promises";
import { extname, isAbsolute, join, relative, resolve, sep } from "node:path";

import type { McpServerConfig, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti/static";
import type { AgentConfig, AgentModelConfig, AgentToolDefinition, JsonObject } from "nemo-fabric-adapter-contract";
import { LifecycleError, type AdapterStartInput } from "nemo-fabric-adapters-common";

import { agentDirectory, runtimeDirectory, writeAgentDirectory } from "./agent-directory.js";

export interface PiNativeCustomTool {
  name: string;
  path: string;
  exportName: string;
  settings: JsonObject;
}

export interface PiNativeConfiguration {
  /** The runtime's Pi agent directory, holding this configuration as Pi's own files. */
  agentDir: string;
  workspace: string;
  provider: string;
  /** The provider-scope endpoint the session registered, if any. */
  baseUrl?: string;
  /** The model definition the session registered, without its endpoint. */
  model: Record<string, unknown>;
  /** The variable that holds the model key; never the key itself. */
  apiKeyEnv: string;
  compactionReserveTokens: number;
  /** Configured extensions only; the Relay extension belongs to the runtime's own gateway. */
  extensionPaths: string[];
  skillPaths: string[];
  systemPrompt?: string;
  toolsEnabled?: string[] | null;
  toolsBlocked: string[];
  customTools: PiNativeCustomTool[];
  /** MCP servers in Pi's mcp.json shape, with header variable references left unexpanded. */
  mcpServers: Record<string, McpServerConfig>;
}

// ProviderConfigInput isn't re-exported from pi's public entrypoint; derive it from
// registerProvider's param type (ModelRuntime's constructor is private, so no InstanceType).
export type PiModelRuntime = Awaited<ReturnType<typeof import("@earendil-works/pi-coding-agent").ModelRuntime.create>>;
type PiProviderConfigInput = Parameters<PiModelRuntime["registerProvider"]>[1];
type PiCatalogModel = NonNullable<PiProviderConfigInput["models"]>[number];
// A model already resolved from Pi's catalog (getModel), used as the base to overlay onto.
export type PiResolvedModel = NonNullable<ReturnType<PiModelRuntime["getModel"]>>;

// Per-model Pi metadata (api, context_window, max_tokens, cost, reasoning, input) is adapter-
// owned data carried in the model `extensions` block. It is only used to DEFINE a model Pi does
// not already know (a gateway model); a model already in Pi's catalog is used as-is and never
// rebuilt, so none of its native properties change. The adapter supplies no defaults of its own
// — for an unknown model every field Pi requires must be configured, mirroring how defining a
// custom model in a local Pi models.json requires those fields.

// The wire protocols Pi understands; a configured model extensions.api must be one of these.
const SUPPORTED_MODEL_APIS = [
  "openai-completions",
  "openai-responses",
  "azure-openai-responses",
  "openai-codex-responses",
  "anthropic-messages",
  "bedrock-converse-stream",
  "google-generative-ai",
  "google-vertex",
  "mistral-conversations",
  "pi-messages",
] as const;

interface PiHarnessSettings {
  extensions: string[];
}

interface PiToolFactoryContext {
  name: string;
  settings: JsonObject;
  workspace: string;
}

export function withCustomBaseUrl<T extends { api: string; baseUrl: string; compat?: object }>(
  catalogModel: T,
  baseUrl: string | null | undefined,
  overrideBaseUrl = true,
): T {
  if (!baseUrl) {
    return catalogModel;
  }
  const model = overrideBaseUrl ? { ...catalogModel, baseUrl } : catalogModel;
  if (catalogModel.api !== "openai-completions") {
    return model;
  }
  return {
    ...model,
    // Generic OpenAI-compatible proxies may reject provider-specific
    // reasoning_content fields when Pi replays an assistant tool call.
    compat: { ...catalogModel.compat, requiresThinkingAsText: true },
  };
}

export function modelAwareCompactionReserveTokens(
  configuredReserveTokens: number,
  maxOutputTokens: number,
  contextWindow: number,
): number {
  const reserveTokens = Math.max(configuredReserveTokens, maxOutputTokens);
  if (contextWindow <= 0) {
    return reserveTokens;
  }
  return Math.min(reserveTokens, Math.floor(contextWindow / 2));
}

type PiToolFactory = (context: PiToolFactoryContext) => ToolDefinition | Promise<ToolDefinition>;

export const PI_BUILTIN_TOOL_NAMES = new Set(["read", "bash", "edit", "write", "grep", "find", "ls"]);
const TOOL_MODULE_EXTENSIONS = new Set([".js", ".mjs", ".cjs", ".ts", ".mts", ".cts"]);
const PI_HARNESS_INSTALL_COMMAND =
  "npm install --save-exact @earendil-works/pi-ai@1.0.3 @earendil-works/pi-coding-agent@1.0.3 @earendil-works/pi-mcp@1.0.3 @earendil-works/pi-codemode@1.0.3";
export interface PiSdkModules {
  InMemoryCredentialStore: typeof import("@earendil-works/pi-ai").InMemoryCredentialStore;
  StdioTransport: typeof import("@earendil-works/pi-mcp").StdioTransport;
  StreamableHttpTransport: typeof import("@earendil-works/pi-mcp").StreamableHttpTransport;
  createAgentSession: typeof import("@earendil-works/pi-coding-agent").createAgentSession;
  createMcpExtension: typeof import("@earendil-works/pi-coding-agent").createMcpExtension;
  DefaultResourceLoader: typeof import("@earendil-works/pi-coding-agent").DefaultResourceLoader;
  ModelRuntime: typeof import("@earendil-works/pi-coding-agent").ModelRuntime;
  SessionManager: typeof import("@earendil-works/pi-coding-agent").SessionManager;
  SettingsManager: typeof import("@earendil-works/pi-coding-agent").SettingsManager;
}

function isMissingModuleError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error.code === "ERR_MODULE_NOT_FOUND" || error.code === "MODULE_NOT_FOUND")
  );
}

async function loadPiSdk(): Promise<PiSdkModules> {
  let ai: typeof import("@earendil-works/pi-ai");
  let codingAgent: typeof import("@earendil-works/pi-coding-agent");
  let mcp: typeof import("@earendil-works/pi-mcp");
  try {
    [ai, codingAgent, mcp] = await Promise.all([
      import("@earendil-works/pi-ai"),
      import("@earendil-works/pi-coding-agent"),
      import("@earendil-works/pi-mcp"),
    ]);
  } catch (error) {
    if (isMissingModuleError(error)) {
      throw new LifecycleError(
        "pi_harness_unavailable",
        `The Pi SDK harness is not installed. Install a compatible harness with: ${PI_HARNESS_INSTALL_COMMAND}`,
      );
    }
    throw new LifecycleError("pi_harness_load_failed", "The installed Pi SDK harness could not be loaded");
  }

  if (
    typeof ai.InMemoryCredentialStore !== "function" ||
    typeof mcp.StdioTransport !== "function" ||
    typeof mcp.StreamableHttpTransport !== "function" ||
    typeof codingAgent.createAgentSession !== "function" ||
    typeof codingAgent.createMcpExtension !== "function" ||
    typeof codingAgent.DefaultResourceLoader !== "function" ||
    typeof codingAgent.ModelRuntime !== "function" ||
    typeof codingAgent.SessionManager !== "function" ||
    typeof codingAgent.SettingsManager !== "function"
  ) {
    throw new LifecycleError(
      "pi_harness_incompatible",
      "The installed Pi SDK harness does not expose the APIs required by this adapter",
    );
  }

  return {
    InMemoryCredentialStore: ai.InMemoryCredentialStore,
    StdioTransport: mcp.StdioTransport,
    StreamableHttpTransport: mcp.StreamableHttpTransport,
    createAgentSession: codingAgent.createAgentSession,
    createMcpExtension: codingAgent.createMcpExtension,
    DefaultResourceLoader: codingAgent.DefaultResourceLoader,
    ModelRuntime: codingAgent.ModelRuntime,
    SessionManager: codingAgent.SessionManager,
    SettingsManager: codingAgent.SettingsManager,
  };
}

const MCP_HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/u;
const MCP_ENV_REFERENCE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/gu;
const MCP_SERVER_NAME = /^[A-Za-z0-9_-]+$/u;

function loopbackHostname(hostname: string): boolean {
  return hostname === "localhost" || hostname === "[::1]" || /^127(?:\.\d{1,3}){3}$/u.test(hostname);
}

function expandMcpHeader(
  value: string,
  configuredEnvironment: Record<string, string>,
  parentEnvironment: NodeJS.ProcessEnv,
): string {
  return value.replaceAll(MCP_ENV_REFERENCE, (_reference, variable: string) => {
    const configured = configuredEnvironment[variable];
    if (Object.hasOwn(configuredEnvironment, variable) && configured !== undefined) {
      return configured;
    }
    const inherited = parentEnvironment[variable];
    if (Object.hasOwn(parentEnvironment, variable) && inherited !== undefined) {
      return inherited;
    }
    throw new LifecycleError(
      "pi_mcp_header_variable_missing",
      "A configured Pi MCP header references an environment variable that is not available",
    );
  });
}

function validateMcpHeader(name: string, value: string): void {
  if (!MCP_HEADER_NAME.test(name) || value.length === 0 || value.trim() !== value) {
    throw new LifecycleError("pi_mcp_invalid_header", "A configured Pi MCP HTTP header is invalid");
  }
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint === undefined || codePoint > 0xFF || (codePoint < 0x20 && codePoint !== 0x09) || codePoint === 0x7F) {
      throw new LifecycleError("pi_mcp_invalid_header", "A configured Pi MCP HTTP header is invalid");
    }
  }
}

function validateMcpToolNames(names: readonly string[] | null | undefined): void {
  if (names?.some((name) => name.includes("*")) === true) {
    throw new LifecycleError(
      "pi_mcp_tool_pattern_unsupported",
      "Pi MCP tool filters require exact tool names and do not accept patterns",
    );
  }
}

function mcpToolExposure(
  allowed: string[] | null | undefined,
  blocked: string[] | undefined,
): Pick<McpServerConfig, "exposure" | "toolExposure"> {
  validateMcpToolNames(allowed);
  validateMcpToolNames(blocked);
  const toolExposure: Record<string, "direct" | "hidden"> = {};
  if (allowed !== undefined && allowed !== null) {
    for (const name of allowed) {
      toolExposure[name] = "direct";
    }
  }
  for (const name of blocked ?? []) {
    toolExposure[name] = "hidden";
  }
  return {
    exposure: allowed === undefined || allowed === null ? "direct" : "hidden",
    ...(Object.keys(toolExposure).length === 0 ? {} : { toolExposure }),
  };
}

export function selectPiMcpServers(
  config: AgentConfig,
  configuredEnvironment: Record<string, string>,
  parentEnvironment: NodeJS.ProcessEnv,
  options: { expandHeaders?: boolean } = {},
): Record<string, McpServerConfig> {
  const expandHeaders = options.expandHeaders ?? true;
  if (config.mcp?.extensions !== undefined) {
    throw new LifecycleError("pi_mcp_extensions_unsupported", "Pi does not support Fabric MCP extensions");
  }
  const selected = Object.create(null) as Record<string, McpServerConfig>;
  for (const [name, server] of Object.entries(config.mcp?.servers ?? {})) {
    if (!MCP_SERVER_NAME.test(name) || server.extensions !== undefined) {
      throw new LifecycleError("pi_mcp_invalid_server", "Pi MCP server configuration is unsupported or invalid");
    }
    if (server.authentication !== undefined && server.authentication !== null) {
      throw new LifecycleError(
        "pi_mcp_authentication_unsupported",
        "Pi MCP authentication is unsupported; configure a custom authorization header instead",
      );
    }
    const exposure = mcpToolExposure(server.allowed_tools, server.blocked_tools);
    if (server.transport === "stdio") {
      if (server.url.trim().length === 0 || Object.keys(server.custom_headers ?? {}).length > 0) {
        throw new LifecycleError(
          "pi_mcp_invalid_server",
          "Pi stdio MCP servers require a command and do not accept HTTP headers",
        );
      }
      selected[name] = {
        type: "stdio",
        command: server.url,
        ...(server.args === undefined ? {} : { args: server.args }),
        ...(server.env === undefined ? {} : { env: server.env }),
        ...exposure,
      };
      continue;
    }
    if (server.transport === "streamable-http") {
      if ((server.args?.length ?? 0) > 0 || Object.keys(server.env ?? {}).length > 0) {
        throw new LifecycleError(
          "pi_mcp_invalid_server",
          "Pi streamable-HTTP MCP servers do not accept command arguments or environment variables",
        );
      }
      let endpoint: URL;
      try {
        endpoint = new URL(server.url);
      } catch {
        throw new LifecycleError(
          "pi_mcp_invalid_server",
          "Pi streamable-HTTP MCP servers require an HTTP or HTTPS URL",
        );
      }
      if (
        (endpoint.protocol !== "http:" && endpoint.protocol !== "https:") ||
        (endpoint.protocol === "http:" && !loopbackHostname(endpoint.hostname))
      ) {
        throw new LifecycleError(
          "pi_mcp_invalid_server",
          "Pi streamable-HTTP MCP servers require HTTPS unless the endpoint is loopback",
        );
      }
      const headerNames = new Set<string>();
      const headers = Object.fromEntries(
        Object.entries(server.custom_headers ?? {}).map(([headerName, value]) => {
          const normalizedName = headerName.toLowerCase();
          if (headerNames.has(normalizedName)) {
            throw new LifecycleError("pi_mcp_invalid_header", "A configured Pi MCP HTTP header is invalid");
          }
          headerNames.add(normalizedName);
          // Pi's mcp.json expands ${NAME} references itself, so a written configuration keeps them.
          const expanded = expandMcpHeader(value, configuredEnvironment, parentEnvironment);
          validateMcpHeader(headerName, expanded);
          return [headerName, expandHeaders ? expanded : value];
        }),
      );
      selected[name] = {
        type: "http",
        url: server.url,
        ...(Object.keys(headers).length === 0 ? {} : { headers }),
        ...exposure,
      };
      continue;
    }
    throw new LifecycleError(
      "pi_mcp_transport_unsupported",
      `Pi does not support MCP transport ${JSON.stringify(server.transport)}; supported transports: stdio, streamable-http`,
      {
        metadata: {
          field: `mcp.servers.${name}.transport`,
          transport: server.transport,
          supported_transports: ["stdio", "streamable-http"],
        },
      },
    );
  }
  return selected;
}

/**
 * Read the MCP servers from the runtime's mcp.json, expanding each HTTP header's
 * `${NAME}` references from the runtime's environment, then the adapter's, as
 * selectPiMcpServers validated them.
 */
async function readMcpServers(
  agentDir: string,
  configuredEnvironment: Record<string, string>,
  parentEnvironment: NodeJS.ProcessEnv,
): Promise<Record<string, McpServerConfig>> {
  let text: string;
  try {
    text = await readFile(join(agentDir, "mcp.json"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
  const servers = (JSON.parse(text) as { mcpServers: Record<string, McpServerConfig> }).mcpServers;
  return Object.fromEntries(Object.entries(servers).map(([name, server]) => {
    if (!("headers" in server) || server.headers === undefined) return [name, server];
    const headers = Object.fromEntries(Object.entries(server.headers).map(([header, value]) => {
      const expanded = expandMcpHeader(value, configuredEnvironment, parentEnvironment);
      validateMcpHeader(header, expanded);
      return [header, expanded];
    }));
    return [name, { ...server, headers }];
  }));
}

function selectModel(config: AgentConfig): AgentModelConfig {
  const entries = Object.entries(config.models ?? {});
  if (entries.length === 0) {
    throw new LifecycleError("pi_model_required", "The Pi adapter requires one configured model");
  }
  const selected = config.models?.default ?? (entries.length === 1 ? entries[0]?.[1] : undefined);
  if (selected === undefined) {
    throw new LifecycleError(
      "pi_model_ambiguous",
      "Configure a default model role when the Pi adapter receives multiple models",
    );
  }
  return selected;
}

/**
 * Build the Pi catalog entry to register for the selected model, as an OVERLAY on `base` (the
 * model's existing Pi catalog entry, or undefined when Pi doesn't know it). The rule is a thin
 * pass-through: a field the config SUPPLIES (via the model `extensions` block, or `base_url` for
 * the endpoint) is used; a field it OMITS falls back to `base`'s value, and if there is no base
 * (an unknown gateway model) an optional field is left UNSET so Pi applies its own default. The
 * adapter invents no defaults of its own.
 *
 * It does, however, require what Pi has no usable default for. For an unknown model that means a
 * complete-enough definition: `api` (enforced at registration — Pi can't resolve the wire
 * protocol otherwise), `base_url`, `context_window`/`max_tokens`, `input`, and `cost`. Supplied values
 * are validated (`api` a {@link SUPPORTED_MODEL_APIS} value, token limits positive, cost
 * well-formed) so a malformed override fails fast instead of reaching Pi.
 */
export function buildCatalogModel(model: AgentModelConfig, base: PiResolvedModel | undefined): PiCatalogModel {
  const meta = (model.extensions ?? {}) as Record<string, unknown>;
  const fail = (reason: string): never => {
    throw new LifecycleError("pi_model_extensions_invalid", reason, { metadata: { model: model.model } });
  };
  if (meta.api !== undefined && !SUPPORTED_MODEL_APIS.includes(meta.api as (typeof SUPPORTED_MODEL_APIS)[number])) {
    throw new LifecycleError(
      "pi_model_api_invalid",
      `Unsupported model api '${String(meta.api)}'; model extensions.api must be one of: ${SUPPORTED_MODEL_APIS.join(", ")}`,
      { metadata: { model: model.model } },
    );
  }
  // Validate a SUPPLIED token limit (positive number); when absent, inherit base's value or leave
  // it unset for Pi to default. Never fabricate a value.
  const positive = (value: unknown, inherited: number | undefined, field: string): number | undefined => {
    if (value === undefined) {
      return inherited;
    }
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
      return fail(`model extensions.${field} must be a positive number`);
    }
    return value;
  };
  if (Array.isArray(meta.input) && meta.input.some((item) => item !== "text" && item !== "image")) {
    fail("model extensions.input must contain only 'text' or 'image' values");
  }
  const suppliedInput = Array.isArray(meta.input)
    ? (meta.input.filter((item) => item === "text" || item === "image") as ("text" | "image")[])
    : undefined;
  const api = typeof meta.api === "string" ? (meta.api as PiCatalogModel["api"]) : base?.api;
  const baseUrl = model.base_url ?? base?.baseUrl;
  const reasoning = meta.reasoning !== undefined ? meta.reasoning === true : base?.reasoning;
  const input = suppliedInput !== undefined && suppliedInput.length > 0 ? suppliedInput : base?.input;
  const cost = parseCost(meta.cost, fail) ?? base?.cost;
  const contextWindow = positive(meta.context_window, base?.contextWindow, "context_window");
  const maxTokens = positive(model.max_tokens ?? meta.max_tokens, base?.maxTokens, "max_tokens");
  // An unknown model has no catalog entry to supply its endpoint, limits, input modalities,
  // or cost rates. Require those fields before Pi uses them; `api` is enforced at registration.
  if (base === undefined) {
    const missing = [
      baseUrl === undefined ? "base_url" : undefined,
      contextWindow === undefined ? "context_window" : undefined,
      maxTokens === undefined ? "max_tokens" : undefined,
      input === undefined ? "input" : undefined,
      cost === undefined ? "cost" : undefined,
    ].filter((field): field is string => field !== undefined);
    if (missing.length > 0) {
      fail(
        `model '${model.model}' is not known to Pi, so a complete definition is required; ` +
        `missing: ${missing.join(", ")} (set base_url and the required model extensions)`,
      );
    }
  }
  // Include only resolved fields; the adapter adds no defaults for optional metadata.
  const entry: Record<string, unknown> = { id: model.model };
  if (typeof meta.name === "string" || base?.name !== undefined) {
    entry.name = typeof meta.name === "string" ? meta.name : base?.name;
  }
  if (api !== undefined) entry.api = api;
  if (baseUrl !== undefined) entry.baseUrl = baseUrl;
  if (reasoning !== undefined) entry.reasoning = reasoning;
  if (input !== undefined) entry.input = input;
  if (cost !== undefined) entry.cost = cost;
  if (contextWindow !== undefined) entry.contextWindow = contextWindow;
  if (maxTokens !== undefined) entry.maxTokens = maxTokens;
  return entry as unknown as PiCatalogModel;
}

// Validate a supplied cost (all four numeric rates) and reject a partial object (e.g. `{}`),
// which Pi would turn into NaN costs. Returns undefined when no cost is configured, so the
// caller keeps the base/default cost instead.
function parseCost(value: unknown, fail: (reason: string) => never): PiCatalogModel["cost"] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "object" || value === null) {
    return fail("model extensions.cost must be an object with numeric input/output/cacheRead/cacheWrite rates");
  }
  const record = value as Record<string, unknown>;
  const rates = ["input", "output", "cacheRead", "cacheWrite"] as const;
  const parsed: Record<string, number> = {};
  for (const rate of rates) {
    const amount = record[rate];
    if (typeof amount !== "number" || !Number.isFinite(amount) || amount < 0) {
      return fail(`model extensions.cost.${rate} must be a non-negative number`);
    }
    parsed[rate] = amount;
  }
  // SAFETY: every rate was just validated as a finite non-negative number above.
  return parsed as unknown as PiCatalogModel["cost"];
}

function harnessSettings(config: AgentConfig): PiHarnessSettings {
  const raw = config.harness?.settings;
  const extensions = raw?.extensions;
  if (extensions === undefined) {
    return { extensions: [] };
  }
  if (!Array.isArray(extensions)) {
    throw new LifecycleError("pi_invalid_settings", "Pi extension settings do not match the adapter schema");
  }
  const values: string[] = [];
  for (const entry of extensions) {
    if (typeof entry !== "string") {
      throw new LifecycleError("pi_invalid_settings", "Pi extension settings do not match the adapter schema");
    }
    values.push(entry);
  }
  return { extensions: values };
}

export function containedBy(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function resolveToolModule(workspace: string, reference: string): Promise<{ path: string; exportName: string }> {
  const match = /^(?<path>[^#]+?)(?:#(?<export>[A-Za-z_$][\w$]*))?$/.exec(reference);
  const configuredPath = match?.groups?.path;
  if (configuredPath === undefined || isAbsolute(configuredPath)) {
    throw new LifecycleError(
      "pi_tool_ref_invalid",
      "Pi tool module references must use a workspace-relative path with an optional export fragment",
    );
  }
  let candidate: string;
  try {
    candidate = await realpath(resolve(workspace, configuredPath));
  } catch {
    throw new LifecycleError("pi_tool_module_not_found", "A configured Pi tool module does not exist");
  }
  if (!containedBy(workspace, candidate)) {
    throw new LifecycleError("pi_tool_module_outside_workspace", "Pi tool modules must be contained by the workspace");
  }
  if (!(await stat(candidate)).isFile() || !TOOL_MODULE_EXTENSIONS.has(extname(candidate))) {
    throw new LifecycleError(
      "pi_tool_module_invalid",
      "Pi tool modules must be JavaScript or TypeScript files",
    );
  }
  return { path: candidate, exportName: match?.groups?.export ?? "default" };
}

function validateToolDefinition(name: string, value: unknown): ToolDefinition {
  if (
    !isRecord(value) ||
    value.name !== name ||
    typeof value.label !== "string" ||
    value.label.length === 0 ||
    typeof value.description !== "string" ||
    value.description.length === 0 ||
    !isRecord(value.parameters) ||
    typeof value.execute !== "function"
  ) {
    throw new LifecycleError(
      "pi_tool_factory_invalid",
      "A Pi tool factory returned an invalid tool definition or a mismatched tool name",
      { metadata: { tool: name } },
    );
  }
  // SAFETY: the checks above verify every field of the ToolDefinition contract at runtime.
  return value as unknown as ToolDefinition;
}

export async function resolveCustomTools(
  workspace: string,
  definitions: Record<string, AgentToolDefinition>,
): Promise<ToolDefinition[]> {
  const jiti = createJiti(import.meta.url, { interopDefault: false });
  const tools: ToolDefinition[] = [];
  for (const [name, definition] of Object.entries(definitions)) {
    if (PI_BUILTIN_TOOL_NAMES.has(name)) {
      throw new LifecycleError("pi_tool_collision", "A Fabric tool definition collides with a Pi built-in tool", {
        metadata: { tool: name },
      });
    }
    if (definition.kind !== "module") {
      throw new LifecycleError("pi_tool_kind_unsupported", "Pi supports only module tool definitions");
    }
    const moduleReference = await resolveToolModule(workspace, definition.ref);
    let loaded: unknown;
    try {
      loaded = await jiti.import(moduleReference.path);
    } catch {
      throw new LifecycleError("pi_tool_module_load_failed", "A configured Pi tool module could not be loaded", {
        metadata: { tool: name },
      });
    }
    const factory = isRecord(loaded) ? loaded[moduleReference.exportName] : undefined;
    if (typeof factory !== "function") {
      throw new LifecycleError("pi_tool_factory_missing", "A configured Pi tool module export is not a factory", {
        metadata: { tool: name },
      });
    }
    let tool: unknown;
    try {
      tool = await (factory as PiToolFactory)({
        name,
        settings: definition.settings ?? {},
        workspace,
      });
    } catch {
      throw new LifecycleError("pi_tool_factory_failed", "A configured Pi tool factory failed", {
        metadata: { tool: name },
      });
    }
    tools.push(validateToolDefinition(name, tool));
  }
  return tools;
}

async function resolveExtensionPaths(workspace: string, configured: string[]): Promise<string[]> {
  const resolved: string[] = [];
  for (const entry of configured) {
    if (isAbsolute(entry)) {
      throw new LifecycleError("pi_extension_outside_workspace", "Pi extension paths must be workspace-relative");
    }
    let candidate: string;
    try {
      candidate = await realpath(resolve(workspace, entry));
    } catch {
      throw new LifecycleError("pi_extension_not_found", "A configured Pi extension path does not exist");
    }
    if (!containedBy(workspace, candidate)) {
      throw new LifecycleError("pi_extension_outside_workspace", "Pi extension path resolves outside the workspace");
    }
    const info = await stat(candidate);
    if (!info.isFile() || (!candidate.endsWith(".ts") && !candidate.endsWith(".js"))) {
      throw new LifecycleError("pi_unsupported_extension", "Pi extensions must be .ts or .js files");
    }
    resolved.push(candidate);
  }
  return resolved;
}

async function resolveSkillPaths(baseDir: string, configured: string[]): Promise<string[]> {
  const resolved: string[] = [];
  for (const entry of configured) {
    let candidate: string;
    try {
      candidate = await realpath(resolve(baseDir, entry));
    } catch {
      throw new LifecycleError("pi_skill_not_found", "A configured NeMo Fabric skill path does not exist");
    }
    let info;
    try {
      info = await stat(candidate);
    } catch {
      throw new LifecycleError("pi_skill_not_found", "A configured NeMo Fabric skill path does not exist");
    }
    if (!info.isDirectory()) {
      throw new LifecycleError("pi_skill_invalid", "NeMo Fabric skill paths must be directories");
    }
    try {
      if (!(await stat(join(candidate, "SKILL.md"))).isFile()) {
        throw new Error("not a file");
      }
    } catch {
      throw new LifecycleError(
        "pi_skill_invalid",
        "NeMo Fabric skill directories must contain a SKILL.md file",
      );
    }
    resolved.push(candidate);
  }
  return resolved;
}

function credentialValue(input: AdapterStartInput, name: string): string | undefined {
  return input.runtimeContext.environment.env?.[name] ?? process.env[name];
}

/** A runtime's Pi configuration, written to its agent directory, with the model Pi resolved from those files. */
export interface PiPreparedConfiguration {
  pi: PiSdkModules;
  configuration: PiNativeConfiguration;
  /** Pi's model runtime, loaded from the agent directory's models.json and holding the key in memory. */
  modelRuntime: PiModelRuntime;
  model: PiResolvedModel;
  /** The configured extensions, resolved to absolute paths. */
  extensionPaths: string[];
  skillPaths: string[];
  /** The configured Fabric module tools, loaded. */
  customTools: ToolDefinition[];
  /** The MCP servers from the agent directory's mcp.json, with header references expanded. */
  mcpServers: Record<string, McpServerConfig>;
}

/**
 * Resolve the runtime's Pi configuration from FabricConfig, write it to the
 * runtime's agent directory, and check that Pi resolves the selected model from
 * those files. Every execution path starts with this; it runs no session.
 */
export async function preparePiConfiguration(input: AdapterStartInput): Promise<PiPreparedConfiguration> {
  const systemInstruction = input.config.instructions?.system;
  if (systemInstruction?.mode === "append") {
    throw new LifecycleError(
      "unsupported_system_instruction_mode",
      "Pi does not support instructions.system.mode='append'; supported modes: replace",
      {
        metadata: {
          field: "instructions.system.mode",
          mode: systemInstruction.mode,
          supported_modes: ["replace"],
        },
      },
    );
  }
  // Validated here, before anything starts; mcp.json keeps header references unexpanded.
  const mcpConfiguration = selectPiMcpServers(
    input.config,
    input.runtimeContext.environment.env ?? {},
    process.env,
    { expandHeaders: false },
  );
  const pi = await loadPiSdk();
  let workspace: string;
  try {
    workspace = await realpath(resolve(input.runtimeContext.environment.workspace ?? input.baseDir));
    if (!(await stat(workspace)).isDirectory()) {
      throw new Error("not a directory");
    }
  } catch {
    throw new LifecycleError("pi_workspace_invalid", "The Fabric runtime workspace must be a directory");
  }
  const selected = selectModel(input.config);
  const apiKeyEnv = selected.api_key_env;
  if (apiKeyEnv === undefined || apiKeyEnv === null || apiKeyEnv.length === 0) {
    throw new LifecycleError("pi_api_key_env_required", "The selected Pi model requires api_key_env");
  }
  const apiKey = credentialValue(input, apiKeyEnv);
  if (apiKey === undefined || apiKey.length === 0) {
    throw new LifecycleError("pi_credential_missing", `Credential environment variable ${apiKeyEnv} is not set`);
  }

  const extensionPaths = await resolveExtensionPaths(workspace, harnessSettings(input.config).extensions);
  const skillPaths = await resolveSkillPaths(input.baseDir, input.config.skills?.paths ?? []);
  const customTools = await resolveCustomTools(workspace, input.config.tools?.definitions ?? {});

  // Resolve the selected model as an overlay on Pi's built-in catalog entry (if any): supplied
  // config fields override, omitted ones keep Pi's native value, and for an unknown (gateway)
  // model the overlay base is empty so its required metadata must be explicit. This way selecting
  // a known provider/model and changing nothing preserves all its native properties, while an
  // explicit base_url / extensions field is still honored. A Fabric agent runs ONE model role per
  // session (selectModel enforces default-or-sole), mirroring the other single-model adapters.
  const builtIns = await pi.ModelRuntime.create({
    credentials: new pi.InMemoryCredentialStore(),
    modelsPath: null,
    allowModelNetwork: false,
    refreshOnCreate: false,
  });
  // SAFETY: buildCatalogModel builds a plain object of these fields; here it is models.json data.
  const resolvedEntry = buildCatalogModel(selected, builtIns.getModel(selected.provider, selected.model)) as unknown as
    Record<string, unknown> & { api?: string; baseUrl?: string; compat?: object; maxTokens?: number; contextWindow?: number };
  // The OpenAI-compatible-proxy compat shim (see withCustomBaseUrl) goes into the definition
  // itself, so every process that reads models.json gets it.
  const catalogEntry = selected.base_url && resolvedEntry.api === "openai-completions"
    ? { ...resolvedEntry, compat: { ...resolvedEntry.compat, requiresThinkingAsText: true } }
    : resolvedEntry;
  const { baseUrl: providerBaseUrl, ...modelDefinition } = catalogEntry;
  const compactionReserveTokens = modelAwareCompactionReserveTokens(
    pi.SettingsManager.inMemory({}, { projectTrusted: false }).getCompactionReserveTokens(),
    catalogEntry.maxTokens ?? 0,
    catalogEntry.contextWindow ?? 0,
  );
  const configuration: PiNativeConfiguration = {
    agentDir: agentDirectory(runtimeDirectory(input)),
    workspace,
    provider: selected.provider,
    ...(providerBaseUrl === undefined ? {} : { baseUrl: providerBaseUrl }),
    model: modelDefinition as Record<string, unknown>,
    apiKeyEnv,
    compactionReserveTokens,
    extensionPaths: [...extensionPaths],
    skillPaths,
    ...(systemInstruction?.content === undefined ? {} : { systemPrompt: systemInstruction.content }),
    toolsEnabled: input.config.tools?.enabled,
    toolsBlocked: input.config.tools?.blocked ?? [],
    customTools: await Promise.all(
      Object.entries(input.config.tools?.definitions ?? {}).map(async ([name, definition]) => ({
        name,
        ...(await resolveToolModule(workspace, definition.ref)),
        settings: definition.settings ?? {},
      })),
    ),
    mcpServers: mcpConfiguration,
  };

  // Pi's own files are the configuration: the SDK session loads them as Pi's CLI and terminal UI do.
  const agentDir = configuration.agentDir;
  await writeAgentDirectory(configuration);
  const modelRuntime = await pi.ModelRuntime.create({
    // The key stays in memory; models.json only names its variable.
    credentials: new pi.InMemoryCredentialStore(),
    modelsPath: join(agentDir, "models.json"),
    allowModelNetwork: false,
    refreshOnCreate: false,
  });
  const modelsError = modelRuntime.getError();
  if (modelsError !== undefined) {
    // Pi reports 'no "api" specified' when it can't resolve the model's wire protocol (not a
    // built-in and no extensions.api). Only THAT cause maps to the api-required remediation;
    // any other load failure keeps a generic code so the message isn't misleading.
    if (/no "api" specified/i.test(modelsError)) {
      throw new LifecycleError(
        "pi_model_api_required",
        `Set extensions.api for a gateway-served model (one of: ${SUPPORTED_MODEL_APIS.join(", ")}); the selected model has no api Pi can resolve`,
        { metadata: { provider: selected.provider, model: selected.model, cause: modelsError } },
      );
    }
    throw new LifecycleError(
      "pi_provider_registration_failed",
      `Pi rejected the configuration for provider '${selected.provider}'`,
      { metadata: { provider: selected.provider, cause: modelsError } },
    );
  }
  await modelRuntime.setRuntimeApiKey(selected.provider, apiKey);
  const model = modelRuntime.getModel(selected.provider, selected.model);
  if (model === undefined) {
    throw new LifecycleError("pi_model_unknown", "The selected provider and model are not present in Pi's catalog");
  }
  const mcpServers = await readMcpServers(
    agentDir,
    input.runtimeContext.environment.env ?? {},
    process.env,
  );
  return { pi, configuration, modelRuntime, model, extensionPaths, skillPaths, customTools, mcpServers };
}

