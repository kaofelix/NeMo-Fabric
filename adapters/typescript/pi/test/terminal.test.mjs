// SPDX-FileCopyrightText: Copyright (c) 2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdtemp, readdir, readFile, realpath, rm, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { PiSdkSessionFactory } from "../dist/pi-sdk.js";
import { sdkEnabled } from "../dist/settings.js";
import { launcherScript, PiTerminalSessionFactory, terminalArguments, terminalEnabled } from "../dist/terminal.js";

const [major, minor] = process.versions.node.split(".").map(Number);
const skip = major > 22 || (major === 22 && minor >= 19) ? false : "Pi requires Node >=22.19";

/** The factory the adapter's CLI composes: the terminal interface around the SDK session. */
function sessionFactory() {
  return new PiTerminalSessionFactory(new PiSdkSessionFactory());
}

/** A session handle that records whether it was stopped. */
function fakeHandle(configuration) {
  return {
    configuration,
    stopped: false,
    async prompt() { return { accepted: true, turnStarted: false, turnCount: 0 }; },
    async check() { return { outcome: "passed" }; },
    async stop() { this.stopped = true; },
  };
}

const RUNTIME_KEY = "runtime-key-never-written";
const TERMINAL_KEY = "terminal-key-from-launcher-environment";
const SYSTEM_PROMPT = "You are the NeMo Fabric terminal test agent.";

async function modelServer() {
  const requests = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    requests.push({
      path: request.url,
      authorization: request.headers.authorization,
      body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
    });
    const frame = (value) =>
      `data: ${JSON.stringify({ id: "chatcmpl-1", object: "chat.completion.chunk", created: 0, model: "test-model", ...value })}\n\n`;
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(
      frame({ choices: [{ index: 0, delta: { role: "assistant", content: "terminal-answer" }, finish_reason: "stop" }] }) +
        frame({ choices: [], usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } }) +
        "data: [DONE]\n\n",
    );
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, requests, url: `http://127.0.0.1:${server.address().port}/v1` };
}

function startInput(workspace, baseUrl, settings) {
  return {
    agentName: "terminal-test",
    baseDir: workspace,
    config: {
      models: {
        default: {
          provider: "fabric-test",
          model: "test-model",
          base_url: baseUrl,
          api_key_env: "TEST_API_KEY",
          extensions: {
            api: "openai-completions",
            context_window: 32768,
            max_tokens: 1024,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          },
        },
      },
      instructions: { system: { mode: "replace", content: SYSTEM_PROMPT } },
      tools: { enabled: ["read", "ls"], blocked: [] },
      ...(settings === undefined ? {} : { harness: { settings } }),
    },
    runtimeContext: {
      artifacts: {},
      environment: {
        control_location: "external_control",
        environment_id: "terminal-test",
        ownership: "caller_owned",
        provider: "local",
        workspace,
        env: { TEST_API_KEY: RUNTIME_KEY },
      },
      invocation_id: "start",
      request_id: "start",
      runtime_id: "rt-terminal",
    },
  };
}

/** Run the launcher as a person would: a bare environment plus the model key, from another directory. */
function launch(launcher, home, args, options = {}) {
  const child = spawn("/bin/sh", [launcher, ...args], {
    cwd: home,
    env: { PATH: process.env.PATH, HOME: home, TEST_API_KEY: TERMINAL_KEY },
    stdio: [options.stdin ?? "ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
  const exited = new Promise((resolve) => child.once("close", (code, signal) => resolve({ code, signal, stdout, stderr })));
  return { child, exited };
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function filesUnder(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true, recursive: true })) {
    if (entry.isFile()) files.push(join(entry.parentPath, entry.name));
  }
  return files;
}

test("terminalEnabled follows interfaces.terminal and its enabled switch", () => {
  assert.equal(terminalEnabled({}), false);
  assert.equal(terminalEnabled({ harness: { settings: { interfaces: {} } } }), false);
  assert.equal(terminalEnabled({ harness: { settings: { interfaces: { terminal: {} } } } }), true);
  assert.equal(terminalEnabled({ harness: { settings: { interfaces: { terminal: { enabled: false } } } } }), false);
  assert.throws(() => terminalEnabled({ harness: { settings: { interfaces: { terminal: true } } } }), /schema/);
});

test("sdkEnabled is on unless sdk.enabled is false", () => {
  assert.equal(sdkEnabled({}), true);
  assert.equal(sdkEnabled({ harness: { settings: { sdk: {} } } }), true);
  assert.equal(sdkEnabled({ harness: { settings: { sdk: { enabled: false } } } }), false);
  assert.throws(() => sdkEnabled({ harness: { settings: { sdk: false } } }), /schema/);
});

test("terminal arguments reproduce the embedded session's isolation and tool policy", () => {
  const plan = {
    workspace: "/work",
    provider: "p",
    model: { id: "m" },
    apiKeyEnv: "K",
    compactionReserveTokens: 1,
    extensionPaths: ["/work/ext.ts"],
    skillPaths: ["/skills/review"],
    toolsEnabled: ["read", "ls"],
    toolsBlocked: ["bash"],
    customTools: [],
    mcpServers: { docs: { type: "http", url: "https://example.com/mcp" } },
  };
  const args = terminalArguments(plan, ["/rt/interfaces/fabric-terminal.ts"]);
  for (const flag of ["--no-approve", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files"]) {
    assert.ok(args.includes(flag), flag);
  }
  assert.ok(args.includes("/rt/interfaces/fabric-terminal.ts"));
  assert.deepEqual(args.slice(args.indexOf("--tools"), args.indexOf("--tools") + 2), ["--tools", "read,ls"]);
  assert.deepEqual(args.slice(args.indexOf("--exclude-tools"), args.indexOf("--exclude-tools") + 2), ["--exclude-tools", "bash"]);
  assert.ok(args.includes("builtin:mcp"));
  assert.ok(args.includes("/work/ext.ts"));
  assert.ok(args.includes("/skills/review"));
  assert.ok(terminalArguments({ ...plan, toolsEnabled: [] }, []).includes("--no-tools"));
  assert.throws(() => terminalArguments({ ...plan, toolsBlocked: ["a,b"] }, []), /tool name/);
});

test("the launcher quotes its paths and refuses to run without the tui.json descriptor", () => {
  const script = launcherScript({
    node: "/usr/bin/node",
    cli: "/opt/pi/cli.js",
    agentDir: "/a'b",
    sessionDir: "/s",
    workspace: "/w",
    descriptor: "/m",
    args: ["--no-approve"],
  });
  assert.match(script, /^#!\/bin\/sh\n/);
  assert.match(script, /if \[ ! -e '\/m' \]; then/);
  assert.match(script, /export PI_CODING_AGENT_DIR='\/a'\\''b'/);
  assert.match(script, /exec '\/usr\/bin\/node' '\/opt\/pi\/cli.js' '--no-approve' "\$@"\n$/);
});

test("the terminal factory passes a session through unchanged without interfaces.terminal", async () => {
  const handle = fakeHandle(undefined);
  const factory = new PiTerminalSessionFactory({ create: async () => handle });
  assert.equal(await factory.create(startInput("/nonexistent", "http://127.0.0.1:9/v1")), handle);
  await assert.rejects(
    factory.create(startInput("/nonexistent", "http://127.0.0.1:9/v1", { interfaces: { terminal: "on" } })),
    /schema/,
  );
});

test("the terminal factory stops the session when it can't write the terminal interface", async () => {
  const handle = fakeHandle(undefined);
  const factory = new PiTerminalSessionFactory({ create: async () => handle });
  await assert.rejects(
    factory.create(startInput("/nonexistent", "http://127.0.0.1:9/v1", { interfaces: { terminal: {} } })),
    (error) => error.code === "pi_terminal_unavailable",
  );
  assert.equal(handle.stopped, true);
});

test("the SDK session runs on the agent directory's files and ignores interfaces.terminal", { skip, timeout: 60_000 }, async () => {
  const workspace = await realpath(await mkdtemp(join(tmpdir(), "fabric-pi-terminal-sdk-")));
  const { server, requests, url } = await modelServer();
  const directory = join(workspace, "artifacts", ".fabric", "pi", "runtimes", "rt-terminal");
  let session;
  try {
    session = await new PiSdkSessionFactory().create(startInput(workspace, url, { interfaces: { terminal: {} } }));
    // The terminal interface is the wrapper's; the session only writes Pi's own files.
    assert.equal(await exists(join(directory, "interfaces")), false);
    assert.deepEqual((await readdir(join(directory, "pi-agent"))).sort(), ["SYSTEM.md", "models.json", "settings.json"]);
    assert.equal(session.configuration.agentDir, join(directory, "pi-agent"));
    // A prompt goes out with what the files say: endpoint, model and system prompt.
    const outcome = await session.prompt("hello");
    assert.equal(outcome.text, "terminal-answer");
    assert.equal(requests.length, 1);
    assert.equal(requests[0].body.model, "test-model");
    assert.match(JSON.stringify(requests[0].body.messages[0]), new RegExp(SYSTEM_PROMPT));
    // The SDK keeps the key in memory: the request uses it although models.json only names the variable.
    assert.equal(requests[0].authorization, `Bearer ${RUNTIME_KEY}`);
    assert.equal(session.configuration.provider, "fabric-test");
    assert.equal(session.configuration.apiKeyEnv, "TEST_API_KEY");
    assert.equal(session.configuration.systemPrompt, SYSTEM_PROMPT);
    assert.doesNotMatch(JSON.stringify(session.configuration), new RegExp(RUNTIME_KEY));
  } finally {
    await session?.stop();
    server.closeAllConnections();
    server.close();
    await rm(workspace, { recursive: true, force: true });
  }
});

test("without interfaces.terminal the adapter writes no launcher or tui.json", { skip }, async () => {
  const workspace = await realpath(await mkdtemp(join(tmpdir(), "fabric-pi-terminal-off-")));
  const { server, url } = await modelServer();
  let session;
  try {
    session = await sessionFactory().create(startInput(workspace, url));
    const directory = join(workspace, "artifacts", ".fabric", "pi", "runtimes", "rt-terminal");
    assert.equal(await exists(join(directory, "pi-agent", "models.json")), true);
    assert.equal(await exists(join(directory, "interfaces")), false);
  } finally {
    await session?.stop();
    server.closeAllConnections();
    server.close();
    await rm(workspace, { recursive: true, force: true });
  }
});

test("the launcher opens Pi on the runtime's model, key variable and system prompt", { skip, timeout: 60_000 }, async () => {
  const workspace = await realpath(await mkdtemp(join(tmpdir(), "fabric-pi-terminal-")));
  const home = await realpath(await mkdtemp(join(tmpdir(), "fabric-pi-terminal-home-")));
  const { server, requests, url } = await modelServer();
  const directory = join(workspace, "artifacts", ".fabric", "pi", "runtimes", "rt-terminal");
  const launcher = join(directory, "interfaces", "terminal");
  const descriptor = join(directory, "interfaces", "tui.json");
  let session;
  try {
    session = await sessionFactory().create(startInput(workspace, url, { interfaces: { terminal: {} } }));
    // The attachment descriptor is owner-only and versioned, with Pi's own launcher mode.
    assert.equal((await stat(descriptor)).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(await readFile(descriptor, "utf8")), {
      version: 1,
      mode: "launcher",
      launcher: "terminal",
      workspace,
      agent_dir: join(directory, "pi-agent"),
      session_dir: join(directory, "pi-sessions"),
    });
    assert.equal((await stat(launcher)).mode & 0o777, 0o700);
    assert.equal((await stat(join(directory, "interfaces"))).mode & 0o777, 0o700);
    // As for Hermes's native interfaces, terminal turns aren't observed, so activity is unknown.
    const health = await session.check("ready");
    assert.equal(health.outcome, "passed");
    assert.equal(health.activity, "unknown");
    for (const file of await filesUnder(directory)) {
      assert.doesNotMatch(await readFile(file, "utf8"), new RegExp(RUNTIME_KEY), `${file} holds the runtime's key`);
    }
    const models = JSON.parse(await readFile(join(directory, "pi-agent", "models.json"), "utf8"));
    assert.equal(models.providers["fabric-test"].apiKey, "$TEST_API_KEY");
    assert.equal(models.providers["fabric-test"].baseUrl, url);

    const run = await launch(launcher, home, ["--print", "say hello"]).exited;
    assert.equal(run.code, 0, run.stderr);
    assert.match(run.stdout, /terminal-answer/);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].path, "/v1/chat/completions");
    assert.equal(requests[0].authorization, `Bearer ${TERMINAL_KEY}`);
    assert.equal(requests[0].body.model, "test-model");
    assert.match(JSON.stringify(requests[0].body.messages[0]), new RegExp(SYSTEM_PROMPT));
    assert.deepEqual(requests[0].body.tools.map((tool) => tool.function.name).sort(), ["ls", "read"]);
    // The terminal UI keeps its own session, under the runtime's directory, not the person's home.
    assert.ok((await filesUnder(join(directory, "pi-sessions"))).some((file) => file.endsWith(".jsonl")));
    assert.equal(await exists(join(home, ".pi")), false);

    await session.stop();
    session = undefined;
    assert.equal(await exists(descriptor), false);
    const refused = await launch(launcher, home, ["--print", "again"]).exited;
    assert.equal(refused.code, 1);
    assert.match(refused.stderr, /not running/);
    assert.equal(requests.length, 1);
  } finally {
    await session?.stop();
    server.closeAllConnections();
    server.close();
    await rm(workspace, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  }
});

test("stopping the runtime closes an open terminal UI before the session stops", { skip, timeout: 60_000 }, async () => {
  const workspace = await realpath(await mkdtemp(join(tmpdir(), "fabric-pi-terminal-stop-")));
  const home = await realpath(await mkdtemp(join(tmpdir(), "fabric-pi-terminal-home-")));
  const { server, url } = await modelServer();
  const directory = join(workspace, "artifacts", ".fabric", "pi", "runtimes", "rt-terminal");
  const registry = join(directory, "interfaces", "tui.clients");
  let session;
  let terminal;
  try {
    session = await sessionFactory().create(startInput(workspace, url, { interfaces: { terminal: {} } }));
    // RPC mode keeps Pi running without a TTY while its stdin stays open, as a terminal UI would.
    terminal = launch(join(directory, "interfaces", "terminal"), home, ["--mode", "rpc"], { stdin: "pipe" });
    const deadline = Date.now() + 20_000;
    while (!(await exists(registry)) || (await readdir(registry)).length === 0) {
      assert.ok(Date.now() < deadline, "the terminal UI never registered");
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.deepEqual(await readdir(registry), [String(terminal.child.pid)]);

    const started = Date.now();
    await session.stop();
    session = undefined;
    const exit = await terminal.exited;
    // The terminal UI closes itself: shutdown() in TUI mode (exit 0); in RPC mode, which defers
    // shutdown(), its own SIGTERM handler (exit 143). Either way the adapter didn't have to kill it.
    assert.equal(exit.signal, null, "the terminal UI should shut itself down, not be killed");
    assert.ok([0, 143].includes(exit.code), `exit ${exit.code}: ${exit.stderr}`);
    assert.ok(Date.now() - started < 5_000, "stop waited for the terminal UI's grace period to expire");
    assert.equal(await exists(registry), false, "stop leaves the terminal UI registrations behind");
  } finally {
    terminal?.child.kill("SIGKILL");
    await session?.stop();
    server.closeAllConnections();
    server.close();
    await rm(workspace, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  }
});

test("a native-only runtime writes Pi's files and the launcher but runs no SDK session", { skip, timeout: 60_000 }, async () => {
  const workspace = await realpath(await mkdtemp(join(tmpdir(), "fabric-pi-native-only-")));
  const home = await realpath(await mkdtemp(join(tmpdir(), "fabric-pi-native-only-home-")));
  const { server, requests, url } = await modelServer();
  const directory = join(workspace, "artifacts", ".fabric", "pi", "runtimes", "rt-terminal");
  const launcher = join(directory, "interfaces", "terminal");
  const descriptor = join(directory, "interfaces", "tui.json");
  let session;
  try {
    session = await sessionFactory().create(
      startInput(workspace, url, { sdk: { enabled: false }, interfaces: { terminal: {} } }),
    );
    assert.equal(session.relay, undefined);
    assert.equal(await exists(join(directory, "pi-agent", "models.json")), true);
    assert.equal(await exists(descriptor), true);
    for (const level of ["live", "active", "ready"]) {
      const health = await session.check(level);
      assert.equal(health.outcome, "passed", level);
      assert.equal(health.activity, "unknown", level);
    }

    const run = await launch(launcher, home, ["--print", "say hello"]).exited;
    assert.equal(run.code, 0, run.stderr);
    assert.match(run.stdout, /terminal-answer/);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].authorization, `Bearer ${TERMINAL_KEY}`);

    // A withdrawn interface fails the runtime's active and ready checks.
    await rm(descriptor);
    assert.equal((await session.check("live")).outcome, "passed");
    assert.equal((await session.check("ready")).reason_code, "endpoint_unavailable");
  } finally {
    await session?.stop();
    server.closeAllConnections();
    server.close();
    await rm(workspace, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  }
});

test("a native-only runtime with Relay runs the gateway, and the launcher loads the Relay extension on it", { skip }, async () => {
  const workspace = await realpath(await mkdtemp(join(tmpdir(), "fabric-pi-terminal-relay-")));
  const extensionPath = join(workspace, "relay-extension");
  const started = [];
  const relayFactory = {
    async start(_input, model) {
      const relay = {
        extensionPath,
        extensionEnvironment: { NEMO_RELAY_PI_GATEWAY_URL: "http://127.0.0.1:1", NEMO_RELAY_PI_OPENAI_UPSTREAM: model.baseUrl },
        stop: async () => undefined,
      };
      started.push(relay);
      return relay;
    },
  };
  let session;
  try {
    const input = startInput(workspace, "http://127.0.0.1:9/v1", { sdk: { enabled: false }, interfaces: { terminal: {} } });
    input.runtimeContext.telemetry = { relay_enabled: true };
    session = await new PiTerminalSessionFactory(new PiSdkSessionFactory(relayFactory)).create(input);
    assert.equal(started.length, 1);
    // The runtime stops the session's Relay gateway after the session.
    assert.equal(session.relay, started[0]);
    const launcher = await readFile(join(workspace, "artifacts", ".fabric", "pi", "runtimes", "rt-terminal", "interfaces", "terminal"), "utf8");
    assert.match(launcher, /^export NEMO_RELAY_PI_GATEWAY_URL='http:\/\/127\.0\.0\.1:1'$/mu);
    assert.match(launcher, /^export NEMO_RELAY_PI_OPENAI_UPSTREAM='http:\/\/127\.0\.0\.1:9\/v1'$/mu);
    assert.ok(launcher.includes(`'--extension' '${extensionPath}'`), launcher);
  } finally {
    await session?.stop();
    await rm(workspace, { recursive: true, force: true });
  }
});
