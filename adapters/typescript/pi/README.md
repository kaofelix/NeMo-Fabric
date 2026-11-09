<!--
SPDX-FileCopyrightText: Copyright (c) 2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
SPDX-License-Identifier: Apache-2.0
-->

# NVIDIA NeMo Fabric Pi Adapter

This package provides a Pi harness adapter for NVIDIA NeMo Fabric. It embeds the
Pi SDK in the Node process of the adapter and maps one NeMo Fabric runtime to one
in-memory Pi session.

The adapter supports:

- One explicit selected model from the `default` role or the sole configured
  role: either a model Pi already ships, or a model served by an
  OpenAI-compatible gateway Pi does not ship (set its wire protocol with the
  model's `api` field)
- Runtime API-key credentials named by `models.<role>.api_key_env`
- Optional `models.<role>.base_url` (the gateway endpoint, or an endpoint
  override for a Pi-known model)
- Optional Pi-specific model metadata set directly on the model
  (`api`, `context_window`, `max_tokens`, `cost`, `reasoning`, `input`, `name`);
  a field you set overrides, a field you omit keeps a Pi-known model's existing
  value. The adapter adds no defaults: a gateway model Pi does not ship must
  supply `api`, `base_url`, `context_window`, `max_tokens`, `input`, and `cost`. Adapter startup rejects missing required metadata before invoking the model.
- Optional replacement system instructions
- Tool allow and block policy
- NeMo Fabric custom tools loaded through normalized `tools.definitions`
- Explicit normalized `skills.paths`
- Native stdio and streamable HTTP MCP servers with per-server tool filters
- Explicit local `.ts` or `.js` extension files contained by the NeMo Fabric
  workspace
- Slash commands registered by those explicit extensions
- NeMo Relay 0.9–0.11 telemetry through a runtime-owned gateway and an explicitly
  configured Relay Pi extension
- Live model-turn ATOF records for successful Relay redirects through the
  default embedded NeMo Fabric collector. Startup `model_redirect` marks remain
  in the configured Relay ATOF artifacts and are not included in per-invocation
  `invoke_stream()` records
- Ordered plain-text invocations with a `{ "response": "..." }` terminal
  output, Relay runtime details, and collected ATOF and OTLP artifacts

Ambient Pi settings, context files, packages, extensions, skills, prompts,
themes, model files, credentials, and session files are disabled. Explicitly
configured extensions are trusted code. The adapter raises the compaction
reserve toward the selected model's maximum output while retaining at least
half of the context window for input.

## Invocation Usage

Each invocation reads only new entries from Pi's raw session ledger, including
retained failed attempts, compaction and branch summaries, nested tool usage,
and auxiliary usage records. Automatic cache warming is disabled so background
refresh calls cannot escape the invocation boundary. Session history and previous invocations are not
counted again. Input totals include cache reads and cache writes; output totals
already include reasoning tokens. Available breakdowns are returned through
`nemo_fabric.detailed_token_usage.v1`.

Missing or inconsistent usage leaves the complete counters unknown. Pi 1.0.3
initializes unreported provider usage to zero, so an all-zero record also remains
unknown. A failed or retried summary can omit attempt usage from the ledger;
complete counters remain unknown in that case. Nonzero records can retain real
zero input, output, or cache dimensions. Configured-rate SDK cost estimates are
not published as provider-reported `cost_usd`.

## Install the Adapter

Pi 1.0 requires Node.js 22.19.0 or newer.

### Install for Consumers

Install the adapter in the project that owns the NeMo Fabric configuration,
then install the supported Pi SDK package set:

```bash
npm install nemo-fabric-adapters-pi
npm install --save-exact @earendil-works/pi-ai@1.0.3 @earendil-works/pi-coding-agent@1.0.3 @earendil-works/pi-mcp@1.0.3 @earendil-works/pi-codemode@1.0.3
```

The adapter declares the Pi packages as optional peers. Installing the adapter
alone does not install a harness, and starting it without compatible Pi packages
returns `pi_harness_unavailable`.

The supported SDK packages are pinned together at 1.0.3. The coding-agent
package otherwise permits newer `pi-codemode` versions with incompatible exports;
installing all four packages keeps fresh installs on the tested combination.

### Install for Source Development

For focused Pi development in the NeMo Fabric source tree, install the Pi
adapter workspace and its pinned harness from the repository root:

```bash
just install-typescript-pi
```

To install and build all maintained TypeScript workspaces instead, run:

```bash
just build-typescript
```

The full build installs the required dependencies.

### Install NeMo Relay

Relay-enabled Pi runs require a NeMo Relay CLI in the `>=0.9.0,<0.12.0` range. Install the command-line tool:

```bash
pip install "nemo-relay-cli-bin>=0.9.0,<0.12.0"
```

The adapter finds `nemo-relay` on `PATH` by default. To select a specific executable, set `FABRIC_NEMO_RELAY_COMMAND` to its absolute path:

```bash
FABRIC_NEMO_RELAY_COMMAND="/absolute/path/to/nemo-relay" uv run python your_app.py
```

The adapter uses the selected executable to start the Relay gateway. With Relay 0.11, the Pi extension also uses that executable to forward hook events. Relay 0.9 and 0.10 extensions send hook events directly over HTTP. When the runtime stops, the adapter restores the extension's previous command setting.

Use the [Pi extension](https://github.com/NVIDIA/NeMo-Relay/tree/0.11.0/crates/cli/assets/pi-extension) from the same Relay release as the command-line tool. Configure the extension path as shown in the next section.

## Configure the Adapter

The npm package includes its adapter descriptor as `pi.fabric-adapter.json`.
NeMo Fabric descriptor discovery is path-based. Point discovery at the installed
descriptor and select the Pi adapter with the Python SDK:

```python
from nemo_fabric import DiscoveryConfig, HarnessConfig

discovery = DiscoveryConfig(
    local_paths=[
        "./node_modules/nemo-fabric-adapters-pi/pi.fabric-adapter.json"
    ]
)
harness = HarnessConfig(adapter_id="nvidia.fabric.pi")
```

For a source build, set `discovery.local_paths` to
`adapters/typescript/pi/pi.fabric-adapter.json` instead.

## Configure NeMo Relay

Enable Relay with the standard NeMo Fabric configuration and provide the Relay
Pi extension as an adapter setting:

```python
config.runtime.artifacts = "./artifacts/pi"
config.enable_relay(output_dir="./artifacts/relay")
config.harness.settings["relay_extension_path"] = (
    "/path/to/NeMo-Relay/crates/cli/assets/pi-extension"
)
```

Relay requires `runtime.artifacts` so NeMo Fabric can create the runtime-owned
configuration passed to the adapter. The extension path can be absolute or
relative to `environment.workspace`. It can identify a JavaScript or TypeScript
file or a Pi extension package directory. Unlike user-configured Pi extensions,
the Relay extension does not need to remain inside `environment.workspace` when
an absolute path is used.

When the runtime starts, the adapter validates the Relay CLI version, writes an
explicit `plugins.toml`, starts a loopback gateway, and loads the extension into
the isolated Pi session. The result includes `relay_runtime` and
`relay_artifacts` in `output`. The gateway can produce ATOF, ATIF,
OpenTelemetry, and OpenInference output from the Relay observability
configuration.

The adapter supports one Relay-enabled Pi runtime per adapter process because
the Relay Pi extension receives its gateway and upstream configuration through
process environment variables. NeMo Fabric starts each runtime in a separate
adapter process, so concurrent NeMo Fabric runtimes remain isolated. Direct
embedders must likewise place concurrent Relay-enabled Pi runtimes in separate
processes.

Local ATIF trajectories are finalized only after the Pi session closes and are
therefore not included in `relay_artifacts`. The adapter does not wait for local
ATIF during invocation; it collects per-invocation artifacts such as ATOF and
returns the result. After runtime shutdown, retrieve the finalized file directly
from the ATIF output directory. For the configuration above and the default
filename template, it is written to
`./artifacts/relay/<runtime_id>/trajectory-<session_id>.atif.json`. Invocation
results do not prevent subsequent turns.

Session, turn, and tool telemetry does not depend on model redirection. Model
telemetry is available only when Relay supports the selected model API and the
gateway upstream matches the model endpoint. Relay records a skipped redirect
as a `model_redirect` mark with the reason in configured ATOF artifacts. Pi
emits its startup redirect marks before NeMo Fabric registers an invocation, so
they are not included in the per-invocation records from `invoke_stream()`.

Install the matching collector for the embedded streaming path:

```bash
pip install "nemo-fabric[streaming]"
```

Start the runtime with streaming enabled to consume live model-turn ATOF
records for successful Relay redirects in one Pi invocation:

```python
from nemo_fabric import Fabric

async with await Fabric().start_runtime(config, streaming=True) as runtime:
    stream = runtime.invoke_stream(input="Review the latest patch")
    async for record in stream:
        print(record)
    result = await stream.result()
```

The terminal `RunResult` remains separate from the ATOF records. Fully consume
each stream, or call `await stream.aclose()` if iteration stops early, before
starting another invocation; the same runtime can then alternate
`invoke_stream()` and `invoke()` calls. The embedded collector serializes both
methods behind one Pi invocation lease. Streaming capture begins at the first
Pi `turn_start` and closes at `agent_settled`. If Relay output is interrupted or
late, the collector waits for a bounded interval, then admits the next native
invocation and uses Pi's cumulative turn count to discard ambiguous delayed
records until a higher `turn_start` arrives. This can thin the ATOF stream but
does not block later invocations. Increase `completion_wait_timeout` from its
one-second default when Relay delivery can take longer. Use the default embedded
collector for Pi streaming. The Pi extension does not attach NeMo Fabric
request IDs, so
`start_runtime(..., streaming=True, launch_collector=False)` cannot correlate
its records through an externally managed collector.

This Relay-backed path runs the adapter's ordinary `invoke` operation. It is
independent of native OpenAI streaming, so the adapter descriptor's
`capabilities.streaming` value remains `false`.

## Custom Tool Modules

The adapter accepts custom tools with `kind: "module"`. The `ref` is a
workspace-relative JavaScript or TypeScript file with an optional named export,
for example `tools/review.ts#createTool`. Without a fragment, the adapter uses
the default export.

The export is called with `{ name, settings, workspace }` and must return a Pi
`ToolDefinition` whose name matches the normalized `tools.definitions` key.
Tool modules are trusted executable code. Their real paths must remain inside
the NeMo Fabric workspace, and their names may not replace Pi built-in or
extension tools. The following configuration registers a custom tool module:

```json
{
  "tools": {
    "definitions": {
      "review_context": {
        "kind": "module",
        "ref": "tools/review-context.ts#createTool",
        "settings": {"format": "brief"}
      }
    },
    "enabled": ["read", "review_context"]
  }
}
```

## Configure MCP Servers

The adapter maps normalized stdio and streamable HTTP servers to Pi's native MCP extension. Stdio servers can define `args` and `env`, but not HTTP headers. Streamable HTTP servers can define `custom_headers`, but not process arguments or environment variables. Remote endpoints require HTTPS, except for loopback development endpoints.

Header values can reference `${NAME}`. Resolution checks the NeMo Fabric runtime environment first and then the adapter process environment. The adapter maps `allowed_tools` and `blocked_tools` to Pi's per-server tool exposure. Normalized MCP authentication and MCP extensions are not supported.

Only servers supplied by NeMo Fabric are loaded. Ambient Pi MCP configuration remains disabled.

## Run the Code-Review Example

The maintained code-review example exercises the Pi adapter with an explicit
NeMo Fabric skill and an example-specific tool policy. After building the
TypeScript packages, inspect the plan from the repository root:

```bash
.venv/bin/python -m examples.code_review_agent --variant pi --plan
```

Refer to the
[code-review example](../../../examples/code_review_agent/README.md) for the
live NVIDIA-backed run command. For a Relay-enabled Pi run, pass the extension
path explicitly:

```bash
.venv/bin/python -m examples.code_review_agent \
  --variant pi \
  --relay \
  --stream \
  --pi-relay-extension-path /path/to/NeMo-Relay/crates/cli/assets/pi-extension \
  --input "Review calculator.py"
```

The command collects per-invocation model-turn ATOF records for successful Relay
redirects, then prints one JSON document containing `atof_records` and the
separate terminal `result`. Redirect-decision marks remain in configured Relay
ATOF artifacts; Pi's startup marks are not included in `atof_records`.

## Agent Directory

Each runtime writes Pi's own configuration files to
`<artifact root>/.fabric/pi/runtimes/<runtime-id>/pi-agent`, and its Pi session
loads them from there. The artifact root is the runtime context's artifact
directory, or `<base_dir>/artifacts`.

| File | Contents |
| --- | --- |
| `models.json` | The selected model's definition and endpoint, with `apiKey` set to `$<api_key_env>` |
| `settings.json` | Startup model, compaction reserve, cache warming off, project trust `never`, install telemetry off |
| `SYSTEM.md` | The configured system instruction, when one is set |
| `mcp.json` | The configured MCP servers, with header `${NAME}` references unexpanded |

The files hold no secrets: the session keeps the model key in memory, and
`models.json` only names its environment variable. Pi may add its own cache
files, such as `models-store.json`. The directory, readable only by its owner,
stays after the runtime stops; a new runtime writes its own.

## Terminal TUI

The adapter offers two execution paths:

- **SDK:** NeMo Fabric invocations run in the embedded Pi session and return
  normalized results.
- **Terminal TUI:** a person runs Pi's own terminal UI on the runtime's
  configuration, in a separate conversation.

Unlike the Hermes adapter's terminal TUI, Pi's has no backend service to attach
to: each terminal TUI is its own Pi process, so the interface takes no port.

**Experimental terminal interface:** The `interfaces.terminal` configuration,
the launcher, and the `interfaces/tui.json` descriptor and
`interfaces/tui.clients` registrations may change as NeMo Fabric adopts the
[launcher contract in #579](https://github.com/NVIDIA/NeMo-Fabric/issues/579).
Compatibility across releases is not guaranteed for these surfaces.

### Native-Only Runtimes

Set `harness.settings.sdk.enabled` to `false`, with the terminal interface
enabled, for a runtime that only configures Pi for its terminal TUI:

```python
config.harness.settings["sdk"] = {"enabled": False}
config.harness.settings["interfaces"] = {"terminal": {}}
```

The runtime still resolves FabricConfig, writes the agent directory, checks that
the selected model resolves, and publishes the launcher, but it creates no
embedded session. Your application can still start, check, and stop it through
the NeMo Fabric SDK. Invocation returns a failed `RunResult` with
`pi_sdk_disabled`. Startup fails with `pi_no_execution_path` when neither path
is enabled. With NeMo Relay telemetry enabled, the runtime still runs its Relay
gateway, for terminal TUI turns.

### Open the Terminal TUI

With `harness.settings.interfaces.terminal` present and `enabled` not `false`,
the adapter writes an executable launcher to
`<artifact root>/.fabric/pi/runtimes/<runtime-id>/interfaces/terminal`
after the session starts. It opens Pi's own terminal UI on the runtime's agent
directory. In an OpenShell sandbox, a person runs it with:

```bash
openshell sandbox exec -n SANDBOX --tty -- <launcher path>
```

On a `noexec` mount, run it as `sh <launcher path>`.

- The launcher runs the `pi` CLI from the Pi package the adapter uses, so the
  terminal UI and the session run one Pi version; `pi` needn't be on `PATH`.
- It holds paths and switches, never secrets, and doesn't pass on the runtime
  environment's variables. Set the model key, under the configured
  `api_key_env` name, in the environment that runs the launcher, with any proxy
  or certificate variables the model endpoint needs, such as `HTTPS_PROXY` and
  `SSL_CERT_FILE`.
- It turns off what the session also turns off: project files, ambient
  extensions, skills, prompt templates, themes, and context files such as
  `AGENTS.md`. It passes the configured extensions, skills, and tool policy as
  flags, and loads Fabric module tools through a generated extension.
- The terminal UI opens a **separate conversation**, stored under
  `<runtime directory>/pi-sessions`. The runtime's own conversation is in
  memory, so the terminal UI can't open it and doesn't see invocations. Each
  launch starts a new conversation; to continue a saved one, pass Pi's
  `--session <path|id>` or `--resume` to the launcher, or use `/resume`.
- After the session starts, the adapter publishes an owner-only attachment
  descriptor, `interfaces/tui.json`. Like the Hermes adapter's, it carries
  `version`, `mode`, and `workspace`. Pi's has no backend port or token, so its
  `mode` is `launcher`, and it adds `launcher`, `agent_dir`, and `session_dir`
  in place of Hermes's `port` and `token_file`. The launcher refuses to start without it, and `stop` removes it
  first. Each open terminal UI registers itself under `interfaces/tui.clients`,
  notices the missing descriptor within a second, and closes; `stop` waits up
  to 5 seconds, then signals any that remain. If the adapter host is killed,
  the descriptor can remain until the sandbox is replaced.
- The agent runs as the same user and can modify the launcher.
- Pi's terminal UI asks no approvals; tools run as configured.
- Pi runs offline: it doesn't download `fd` or `ripgrep`. Install them in the
  environment to use the tools that need them.
- With NeMo Relay telemetry enabled, the launcher also loads the configured
  Relay Pi extension and sets its variables: the runtime's loopback gateway
  URL, the Relay command, and the model's upstream URL. Terminal UI model
  requests go through the runtime's gateway, and each terminal UI is its own
  Relay session, with its own ATIF trajectory under the runtime's Relay output.
  The gateway stops with the runtime, after open terminal UIs close.

### Terminal TUI Limitations

- **Credentials typed into the terminal UI are stored in the agent directory.**
  Pi creates an empty `pi-agent/auth.json` when the terminal UI starts. Signing
  in with `/login`, or saving a key from the terminal UI, writes that credential
  there, readable only by its owner, and the agent directory stays after the
  runtime stops. Supply keys through the environment instead.
- Changes made from the terminal UI, such as `/settings` or a model switch saved
  as the default, write to the shared agent directory. The runtime's session
  loaded the files at start and doesn't see them, and a new runtime writes its
  own directory from FabricConfig.
- Terminal UI turns produce no NeMo Fabric run results or usage. With NeMo
  Relay telemetry enabled, Relay captures them as described below, but they
  aren't in any invocation's `relay_artifacts`.
- Open terminal UIs don't change the runtime's health, and their turns aren't
  observed, so a passing check reports activity as `unknown`.

## Runtime Health

Local SDK callers can use `Fabric.check()` with the runtime's environment and
exact runtime ID. Pi supports three ordered health levels:

| Level | Evidence |
| --- | --- |
| `live` | Completed initialization, unchanged session identity, and a fresh native `extensionRunner.createContext().isIdle()` response. Both idle and busy responses pass. |
| `active` | Liveness plus completed extension binding and an available request interface. |
| `ready` | Earlier levels plus the selected model remaining configured, required tools remaining active or callable through other tools, and required MCP transports having no observed error or closure. |

With the terminal interface enabled, `active` and `ready` also require the
launcher and `interfaces/tui.json` to exist, and a passing check reports
activity as `unknown`, as the Hermes adapter does for its native interfaces,
because terminal UI turns aren't observed. With `sdk.enabled: false`, no session
is inspected: `live` passes until stop, and `ready` requires the selected model
to resolve from the agent directory's `models.json`; this is native-only
evidence, not a check of an SDK session.

Health probes use an authenticated channel during invocations. MCP failures and closures remain observable after startup. Stop and ownership changes invalidate observations collected in flight.

## Dependency Rationale

`@earendil-works/pi-coding-agent` provides the native Pi session, resources,
skills, extensions, and tools. Using the SDK keeps these integration points in
process; maintaining a second JSON-RPC translation was rejected for the bundled
adapter. `@earendil-works/pi-ai` supplies Pi's model catalog and credential
store, which the coding-agent SDK expects. Both packages are optional peer
dependencies so deployments control the compatible harness version. Exact
1.0.3 development dependencies keep repository builds and tests reproducible.

`jiti` loads explicitly configured, trusted JavaScript and TypeScript tool
modules. Native Node.js loading cannot execute TypeScript modules, while a
custom transpiler would duplicate this focused loader. The adapter contract
package supplies normalized types, and `nemo-fabric-adapters-common` supplies
the shared lifecycle host; copying either surface into the Pi package would
create divergent implementations.

`typescript` and `@types/node` are exact-pinned build inputs and are absent from
the published production dependency graph.


## Credential-free HTTP model gateways

For Relay-enabled runs, set `harness.settings.insecure_http_model_hosts` to the exact bare DNS hostnames or IP addresses of trusted inference gateways. This requires NeMo Relay CLI 0.11.x.

Remote HTTP model endpoints require `openai-completions`, `openai-responses`, or `anthropic-messages`. Other Pi model APIs, including `mistral-conversations`, require HTTPS or loopback HTTP because their requests bypass Relay's gateway. Fabric rejects unsupported remote HTTP APIs before session startup, including hosts listed in `insecure_http_model_hosts`.

```python
config.harness.settings["insecure_http_model_hosts"] = ["inference.internal", "10.0.0.10"]
```

Entries have no scheme, port, path, wildcard, brackets, or IPv6 zone identifier. DNS matching ignores case and a trailing dot. Each listed host may use custom ports and paths. NeMo Fabric writes explicit `[]` to revoke inherited trust and preserves omission when the setting is absent. System Relay configuration has higher priority and can enforce an empty list.

Relay strips authorization, API-key, cookie, custom credential headers, and middleware-added credentials before forwarding remote HTTP model requests, including model credentials supplied to Pi. Relay rejects conflicting upstream authorization configuration. Prompts and responses remain unencrypted. HTTPS is the default; this opt-in does not authorize MCP or observability endpoints, caller-selected destinations, or remote HTTP WebSockets.
