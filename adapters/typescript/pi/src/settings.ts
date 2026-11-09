// SPDX-FileCopyrightText: Copyright (c) 2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// The runtime's execution paths, read from harness.settings: the embedded SDK
// session (sdk.enabled, on by default) and Pi's terminal TUI
// (interfaces.terminal). A runtime needs at least one of them.

import type { AgentConfig } from "nemo-fabric-adapter-contract";
import { LifecycleError } from "nemo-fabric-adapters-common";

function invalid(): LifecycleError {
  return new LifecycleError("pi_invalid_settings", "Pi settings do not match the adapter schema");
}

/** The `enabled` switch of a settings object that is on when present unless `enabled` is false. */
function switchedOn(section: unknown, whenAbsent: boolean): boolean {
  if (section === undefined || section === null) return whenAbsent;
  if (typeof section !== "object" || Array.isArray(section)) throw invalid();
  const enabled = (section as Record<string, unknown>).enabled;
  if (enabled !== undefined && typeof enabled !== "boolean") throw invalid();
  return enabled !== false;
}

/** Whether the configuration initializes the embedded SDK session (`sdk.enabled`, default true). */
export function sdkEnabled(config: AgentConfig): boolean {
  return switchedOn(config.harness?.settings?.sdk, true);
}

/** Whether the configuration enables Pi's terminal TUI interface. */
export function terminalEnabled(config: AgentConfig): boolean {
  const interfaces = config.harness?.settings?.interfaces;
  if (interfaces === undefined || interfaces === null) return false;
  if (typeof interfaces !== "object" || Array.isArray(interfaces)) throw invalid();
  return switchedOn((interfaces as Record<string, unknown>).terminal, false);
}

/** The enabled execution paths; refuses a runtime with neither. */
export function executionPaths(config: AgentConfig): { sdk: boolean; terminal: boolean } {
  const paths = { sdk: sdkEnabled(config), terminal: terminalEnabled(config) };
  if (!paths.sdk && !paths.terminal) {
    throw new LifecycleError("pi_no_execution_path", "Enable the Pi SDK or the terminal interface");
  }
  return paths;
}
