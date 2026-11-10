// SPDX-FileCopyrightText: Copyright (c) 2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// A runtime with sdk.enabled false. It writes the runtime's Pi configuration for
// the native interfaces and runs no embedded session, so it never takes a
// prompt. With Relay enabled it still runs the gateway for the interfaces' turns.

import type { AdapterCheckResult, CheckLevel, CheckSource } from "nemo-fabric-adapter-contract";
import { LifecycleError, unobservedHealth, type AdapterStartInput } from "nemo-fabric-adapters-common";

import { preparePiConfiguration, type PiModelRuntime, type PiNativeConfiguration } from "./native-configuration.js";
import { PiRelayFactory, type PiRelayControllerFactory, type PiRelayRuntime } from "./relay.js";
import type { PiPromptOutcome, PiSessionFactory, PiSessionHandle } from "./runtime.js";

class PiNativeOnlyHandle implements PiSessionHandle {
  readonly configuration: PiNativeConfiguration;
  readonly turnCount = 0;
  readonly relay?: PiRelayRuntime;
  private readonly modelRuntime: PiModelRuntime;
  private readonly expectedModel: { id: string; provider: string };
  private stopped = false;

  constructor(configuration: PiNativeConfiguration, modelRuntime: PiModelRuntime,
    expectedModel: { id: string; provider: string }, relay?: PiRelayRuntime) {
    this.configuration = configuration;
    this.relay = relay;
    this.modelRuntime = modelRuntime;
    this.expectedModel = expectedModel;
  }

  async prompt(): Promise<PiPromptOutcome> {
    // PiAdapterRuntime answers pi_sdk_disabled before it reaches the handle.
    throw new LifecycleError("pi_sdk_disabled", "Embedded Pi SDK execution is disabled");
  }

  async check(level: CheckLevel): Promise<AdapterCheckResult> {
    if (this.stopped) return { ...unobservedHealth("session_closed"), outcome: "failed", activity: "stopped" };
    const source: CheckSource = level === "live" ? "fabric.adapter.liveness"
      : level === "active" ? "fabric.adapter.interface" : "fabric.adapter.readiness";
    const observed_at = new Date().toISOString();
    if (level === "ready"
      && this.modelRuntime.getModel(this.expectedModel.provider, this.expectedModel.id) === undefined) {
      return { outcome: "failed", reason_code: "health_failed", activity: "unknown", source, observed_at };
    }
    return { outcome: "passed", reason_code: null, activity: "unknown", source, observed_at };
  }

  async stop(): Promise<void> {
    this.stopped = true;
  }
}

export class PiNativeOnlySessionFactory implements PiSessionFactory {
  private readonly relayFactory: PiRelayControllerFactory;

  constructor(relayFactory: PiRelayControllerFactory = new PiRelayFactory()) {
    this.relayFactory = relayFactory;
  }

  async create(input: AdapterStartInput): Promise<PiSessionHandle> {
    const { configuration, modelRuntime, model } = await preparePiConfiguration(input);
    const relay = await this.relayFactory.start(input, { api: model.api, baseUrl: model.baseUrl });
    return new PiNativeOnlyHandle(configuration, modelRuntime, { id: model.id, provider: model.provider }, relay);
  }
}
