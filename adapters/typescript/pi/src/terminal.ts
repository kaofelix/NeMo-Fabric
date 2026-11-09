// SPDX-FileCopyrightText: Copyright (c) 2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// Pi's terminal UI as a native interface of a Fabric runtime. The embedded SDK
// session already runs on Pi's own files in the runtime's agent directory
// (agent-directory.ts), so the terminal UI is the stock `pi` pointed at them:
// PI_CODING_AGENT_DIR plus the flags for what files can't carry. With
// harness.settings.interfaces.terminal, PiTerminalSessionFactory wraps the SDK
// session's factory and writes that launcher once the session is ready.
// A person starts the terminal UI with `openshell sandbox exec --tty`, outside
// the adapter's process tree, so the adapter can't own it as a child; a
// generated extension registers each one and closes it when the runtime stops.
// The launcher holds paths and switches, never secrets: models.json names the
// key's environment variable, and Pi reads it when the terminal UI starts.

import { access, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { AdapterCheckResult, CheckLevel } from "nemo-fabric-adapter-contract";
import { LifecycleError, type AdapterStartInput } from "nemo-fabric-adapters-common";

import { runtimeDirectory } from "./agent-directory.js";
import type { PiNativeConfiguration, PiNativeCustomTool } from "./native-configuration.js";
import type { PiPromptOutcome, PiSessionFactory, PiSessionHandle } from "./runtime.js";
import { terminalEnabled } from "./settings.js";

export { terminalEnabled };

/** How long `stop` waits for open terminal UIs to shut down after the descriptor is removed. */
const TERMINAL_SHUTDOWN_GRACE_MS = 5_000;
/** How long after SIGTERM `stop` waits before sending SIGKILL to a remaining terminal UI. */
const TERMINAL_KILL_GRACE_MS = 1_000;
/** A registration whose heartbeat is older than this belongs to a terminal UI that no longer runs. */
const TERMINAL_HEARTBEAT_STALE_MS = 3_000;
const TERMINAL_HEARTBEAT_MS = 500;
/** How long a terminal UI waits for its orderly shutdown before it sends itself SIGTERM. */
const TERMINAL_SELF_TERMINATE_MS = 2_000;
const TOOL_NAME = /^[A-Za-z0-9_.:-]+$/u;

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

/**
 * The `pi` arguments for what the agent directory's files can't carry: the embedded
 * session's isolation, its extension and skill paths, its tool policy, and the
 * terminal UI's own extensions.
 */
export function terminalArguments(plan: PiNativeConfiguration, terminalExtensions: readonly string[]): string[] {
  const args = [
    // The embedded session doesn't trust the project: no .pi/ settings, resources or MCP servers.
    "--no-approve",
    // The embedded session loads no ambient extensions, skills, prompts, themes or context files.
    "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files",
  ];
  for (const path of terminalExtensions) args.push("--extension", path);
  // --no-extensions also turns off built-in MCP, which reads the agent directory's mcp.json.
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
  descriptor: string;
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
    `if [ ! -e ${shellQuote(options.descriptor)} ]; then`,
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
 * Pi down in order when the runtime's tui.json descriptor disappears.
 */
export function supervisorExtension(descriptor: string, clients: string): string {
  return `// Generated by the NeMo Fabric Pi adapter. Ties this terminal UI to its runtime.
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const DESCRIPTOR = ${JSON.stringify(descriptor)};
const CLIENTS = ${JSON.stringify(clients)};

export default function (pi) {
  const entry = join(CLIENTS, String(process.pid));
  let context;
  let stopping = false;
  const beat = () => {
    if (stopping) return;
    if (!existsSync(DESCRIPTOR)) {
      stopping = true;
      clearInterval(timer);
      context?.ui?.notify?.("The NeMo Fabric runtime stopped; closing Pi.", "warning");
      // The terminal UI acts on shutdown() at once; other modes defer it until a
      // command finishes, so fall back to SIGTERM, which Pi also handles in order.
      setTimeout(() => process.kill(process.pid, "SIGTERM"), ${TERMINAL_SELF_TERMINATE_MS});
      context?.shutdown();
      return;
    }
    mkdirSync(CLIENTS, { recursive: true, mode: 0o700 });
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
export function toolBridgeExtension(workspace: string, tools: readonly PiNativeCustomTool[]): string {
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

async function writePrivate(path: string, contents: string, mode = 0o600): Promise<void> {
  await writeFile(path, contents, { mode });
}

/**
 * The attachment descriptor, in the shape of the Hermes adapter's `interfaces/tui.json`:
 * owner-only, published once the runtime is ready, removed first at stop. Pi's terminal
 * UI has no backend to attach to, so `mode` is `launcher` and names the launcher to run.
 */
export interface PiTuiDescriptor {
  version: 1;
  mode: "launcher";
  launcher: "terminal";
  workspace: string;
  agent_dir: string;
  session_dir: string;
}

/** The terminal TUI interface of one runtime. */
export class PiTerminal {
  readonly launcher: string;
  readonly descriptorPath: string;
  private readonly descriptor: PiTuiDescriptor;
  private readonly clients: string;
  private withdrawn = false;

  private constructor(launcher: string, descriptorPath: string, descriptor: PiTuiDescriptor, clients: string) {
    this.launcher = launcher;
    this.descriptorPath = descriptorPath;
    this.descriptor = descriptor;
    this.clients = clients;
  }

  /**
   * Write the launcher and the terminal UI's own extensions beside the runtime's agent
   * directory, which the session already wrote; the launcher refuses to run until {@link publish}.
   */
  static async prepare(plan: PiNativeConfiguration, directory: string, node: string, cli: string): Promise<PiTerminal> {
    const sessionDir = join(directory, "pi-sessions");
    const interfaces = join(directory, "interfaces");
    const descriptorPath = join(interfaces, "tui.json");
    const clients = join(interfaces, "tui.clients");
    for (const path of [sessionDir, interfaces]) {
      await mkdir(path, { recursive: true, mode: 0o700 });
    }
    // Only the terminal UI loads these, so they stay out of the shared agent directory.
    const extensions = [join(interfaces, "fabric-terminal.ts")];
    await writePrivate(extensions[0]!, supervisorExtension(descriptorPath, clients));
    if (plan.customTools.length > 0) {
      extensions.push(join(interfaces, "fabric-tools.ts"));
      await writePrivate(extensions[1]!, toolBridgeExtension(plan.workspace, plan.customTools));
    }
    const launcher = join(interfaces, "terminal");
    await writePrivate(launcher, launcherScript({
      node,
      cli,
      agentDir: plan.agentDir,
      sessionDir,
      workspace: plan.workspace,
      descriptor: descriptorPath,
      args: terminalArguments(plan, extensions),
    }), 0o700);
    const descriptor: PiTuiDescriptor = {
      version: 1,
      mode: "launcher",
      launcher: "terminal",
      workspace: plan.workspace,
      agent_dir: plan.agentDir,
      session_dir: sessionDir,
    };
    return new PiTerminal(launcher, descriptorPath, descriptor, clients);
  }

  /** Whether a person can open the terminal TUI now: the launcher and the published descriptor exist. */
  async available(): Promise<boolean> {
    if (this.withdrawn) return false;
    try {
      await Promise.all([access(this.launcher), access(this.descriptorPath)]);
      return true;
    } catch {
      return false;
    }
  }

  /** Let the launcher run: publish the descriptor once the runtime is ready. */
  async publish(): Promise<void> {
    await writePrivate(this.descriptorPath, `${JSON.stringify(this.descriptor)}\n`);
  }

  /**
   * Close the interface before the runtime stops: remove the descriptor so the
   * launcher refuses new terminal UIs and open ones close themselves, then
   * signal any that are still running after the grace period.
   */
  async withdraw(): Promise<void> {
    if (this.withdrawn) return;
    await rm(this.descriptorPath, { force: true });
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
    await rm(this.clients, { recursive: true, force: true });
  }

  /** Registered terminal UIs whose heartbeat is current; stale registrations are removed unsignalled. */
  private async liveTerminals(): Promise<number[]> {
    let entries: string[];
    try {
      entries = await readdir(this.clients);
    } catch {
      return [];
    }
    const live: number[] = [];
    for (const name of entries) {
      const path = join(this.clients, name);
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

  get configuration() {
    return this.inner.configuration;
  }

  prompt(text: string): Promise<PiPromptOutcome> {
    return this.inner.prompt(text);
  }

  async check(level: CheckLevel): Promise<AdapterCheckResult> {
    // As for Hermes's native interfaces: the interface must still be offered, and the
    // runtime's activity is unknown because turns in a terminal TUI aren't observed.
    // Open terminal TUIs are separate clients and don't change the result.
    if (level !== "live" && !(await this.terminal.available())) {
      return {
        outcome: "failed",
        reason_code: "endpoint_unavailable",
        activity: "unknown",
        source: level === "active" ? "fabric.adapter.interface" : "fabric.adapter.readiness",
        observed_at: new Date().toISOString(),
      };
    }
    const result = await this.inner.check(level);
    return result.outcome === "passed" ? { ...result, activity: "unknown" } : result;
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

/**
 * Adds the terminal interface around the embedded session's factory, as the
 * runtime composes other native processes beside the SDK session (Hermes's
 * InterfaceChildren, Pi's Relay gateway): the SDK factory resolves and starts
 * the session, and this factory writes the terminal's files from what that
 * session resolved, then withdraws them before the session stops.
 */
export class PiTerminalSessionFactory implements PiSessionFactory {
  private readonly inner: PiSessionFactory;

  constructor(inner: PiSessionFactory) {
    this.inner = inner;
  }

  async create(input: AdapterStartInput): Promise<PiSessionHandle> {
    // Malformed settings fail here, before the session starts.
    if (!terminalEnabled(input.config)) {
      return this.inner.create(input);
    }
    const handle = await this.inner.create(input);
    let terminal: PiTerminal | undefined;
    try {
      if (handle.configuration === undefined) {
        throw new LifecycleError(
          "pi_terminal_unavailable",
          "The Pi session did not report the configuration its terminal UI needs",
        );
      }
      terminal = await PiTerminal.prepare(handle.configuration, runtimeDirectory(input), process.execPath, await resolvePiCli());
      await terminal.publish();
      return new PiTerminalSessionHandle(handle, terminal);
    } catch (error) {
      await terminal?.withdraw().catch(() => {
        process.stderr.write("Pi terminal interface cleanup failed after adapter startup error\n");
      });
      await handle.stop().catch(() => {
        process.stderr.write("Pi session cleanup failed after adapter startup error\n");
      });
      throw error;
    }
  }
}
