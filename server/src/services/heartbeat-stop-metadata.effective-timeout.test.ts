/**
 * KEE-1087 hotfix 5 port proof: the recorded run timeout must be the timeout the
 * run actually ran under, not the one stored on the agent row.
 *
 * The pilot hotfix changed the call from `mergeRunStopMetadataForAgent(agent, …)`
 * to pass the *effective* runtime adapterConfig. This test pins the behaviour at
 * the pure function boundary so a future refactor cannot silently reintroduce
 * reporting the stored agent config instead of the runtime one.
 */

import { describe, expect, it } from "vitest";
import { resolveHeartbeatRunTimeoutPolicy } from "./heartbeat-stop-metadata.js";

const HERMES = "hermes_local";

describe("recorded run timeout uses the effective runtime adapter config", () => {
  it("reports a per-issue runtime override instead of the stored agent timeout", () => {
    // The stored agent config says 600s; the effective runtime config for this
    // run says 180s (issue-level adapter override or workspace-managed key).
    const storedAgentConfig = { timeoutSec: 600 };
    const effectiveRuntimeConfig = { timeoutSec: 180 };

    const fromStored = resolveHeartbeatRunTimeoutPolicy(HERMES, storedAgentConfig);
    const fromRuntime = resolveHeartbeatRunTimeoutPolicy(HERMES, effectiveRuntimeConfig);

    // The bug this hotfix fixes: recording `fromStored` would report 600s for a
    // run that was actually killed at 180s.
    expect(fromStored.effectiveTimeoutSec).toBe(600);
    expect(fromRuntime.effectiveTimeoutSec).toBe(180);
    expect(fromRuntime.timeoutConfigured).toBe(true);
    expect(fromRuntime.timeoutSource).toBe("config");
  });

  it("still falls back to the adapter default when the runtime config has no timeout", () => {
    // The runtime config is the connector's effective config. It must not lose
    // the default the stored agent config would have provided.
    const policy = resolveHeartbeatRunTimeoutPolicy(HERMES, {});

    expect(policy.timeoutConfigured).toBe(false);
    expect(policy.timeoutSource).toBe("default");
  });

  it("coerces a sub-second runtime timeout to a whole number of seconds", () => {
    const policy = resolveHeartbeatRunTimeoutPolicy(HERMES, { timeoutSec: 12.7 });

    expect(policy.effectiveTimeoutSec).toBe(12);
  });
});
