// SPDX-FileCopyrightText: Copyright (c) 2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// The runtime's Pi agent directory: Pi's own configuration files, written from
// what the adapter resolved from FabricConfig. The embedded SDK session loads its
// settings, model catalog, MCP servers and system prompt from these files, and
// Pi's terminal UI reads the same files, so both run on one configuration.
// The files hold no secrets: models.json and mcp.json name environment variables,
// and the SDK session supplies the model key in memory.

import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import type { JsonObject } from "nemo-fabric-adapter-contract";
import type { AdapterStartInput } from "nemo-fabric-adapters-common";

import type { PiNativeConfiguration } from "./native-configuration.js";

/** `<artifact root>/.fabric/pi/runtimes/<runtime-id>`, as the other adapters' native state uses. */
export function runtimeDirectory(input: AdapterStartInput): string {
  const root = input.runtimeContext.artifacts.root;
  const artifactRoot =
    root === undefined || root === null
      ? resolve(input.baseDir, "artifacts")
      : resolve(input.baseDir, String(root));
  return join(artifactRoot, ".fabric", "pi", "runtimes", input.runtimeContext.runtime_id);
}

/** The Pi agent directory (PI_CODING_AGENT_DIR) inside a runtime directory. */
export function agentDirectory(runtimeDir: string): string {
  return join(runtimeDir, "pi-agent");
}

export function piSettings(configuration: PiNativeConfiguration): JsonObject {
  return {
    defaultProvider: configuration.provider,
    defaultModel: String(configuration.model.id),
    // Only agent-directory settings can set this; project files stay untrusted.
    defaultProjectTrust: "never",
    // Cache warming can finish outside a prompt and omit aborted refresh usage.
    cacheWarming: "off",
    compaction: { reserveTokens: configuration.compactionReserveTokens },
    enableInstallTelemetry: false,
    packages: [],
  };
}

export function piModels(configuration: PiNativeConfiguration): JsonObject {
  return {
    providers: {
      [configuration.provider]: {
        // Keep the endpoint at provider scope so Relay can redirect it without a
        // per-model baseUrl taking precedence over the extension's provider override.
        ...(configuration.baseUrl === undefined ? {} : { baseUrl: configuration.baseUrl }),
        // Pi resolves the reference when a process starts; the file holds no secret.
        apiKey: `$${configuration.apiKeyEnv}`,
        models: [configuration.model as JsonObject],
      },
    },
  };
}

async function writePrivate(path: string, contents: string): Promise<void> {
  await writeFile(path, contents, { mode: 0o600 });
}

/** Write Pi's configuration files for the runtime. */
export async function writeAgentDirectory(configuration: PiNativeConfiguration): Promise<void> {
  const directory = configuration.agentDir;
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writePrivate(join(directory, "settings.json"), `${JSON.stringify(piSettings(configuration), null, 2)}\n`);
  await writePrivate(join(directory, "models.json"), `${JSON.stringify(piModels(configuration), null, 2)}\n`);
  if (Object.keys(configuration.mcpServers).length > 0) {
    await writePrivate(
      join(directory, "mcp.json"),
      `${JSON.stringify({ mcpServers: configuration.mcpServers }, null, 2)}\n`,
    );
  }
  if (configuration.systemPrompt !== undefined) {
    // Pi replaces its default system prompt with <agent dir>/SYSTEM.md.
    await writePrivate(join(directory, "SYSTEM.md"), configuration.systemPrompt);
  }
}
