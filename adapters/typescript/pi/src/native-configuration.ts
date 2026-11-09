// SPDX-FileCopyrightText: Copyright (c) 2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// The configuration the adapter resolved from FabricConfig, as plain data. The
// adapter writes it to the runtime's Pi agent directory (agent-directory.ts),
// which the embedded SDK session and Pi's terminal UI both read.

import type { McpServerConfig } from "@earendil-works/pi-coding-agent";
import type { JsonObject } from "nemo-fabric-adapter-contract";

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
