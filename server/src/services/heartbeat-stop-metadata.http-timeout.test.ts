/**
 * KEE-1087 hotfix 5 wiring proof, second case: the `http` adapter.
 *
 * The review flagged that `resolveHeartbeatRunTimeoutPolicy` reads `timeoutMs`
 * for `adapterType === "http"` and `timeoutSec` for everything else, and asked
 * whether the effective-config change is safe for that adapter. Answered here by
 * measurement rather than by inspection:
 *
 *   1. The `http` adapter is real: `server/src/adapters/http/index.ts`
 *      registers `type: "http"`, and `server/src/adapters/http/execute.ts:11`
 *      reads `config.timeoutMs` to arm its abort timer.
 *   2. `adapter.execute({ config: runtimeConfig })` (heartbeat.ts:24353) means
 *      the adapter runs under `runtimeConfig`, and
 *      `stripWorkspaceRuntimeFromExecutionRunConfig` removes only
 *      `workspaceRuntime`, so `timeoutMs` survives the merge.
 *   3. So the recorded timeout now reflects the `timeoutMs` the request
 *      actually used, instead of reporting `default` because the *stored* agent
 *      config carried no `timeoutSec`.
 */

import { describe, expect, it } from "vitest";
import { resolveHeartbeatRunTimeoutPolicy } from "./heartbeat-stop-metadata.js";

describe("effective runtime config reporting covers the http adapter", () => {
  it("records the millisecond timeout the http adapter actually used", () => {
    const HTTP = "http";

    // Stored agent config: a per-run override supplies timeoutMs. An http
    // adapter reads milliseconds, so a stored `timeoutSec` would be ignored by
    // the adapter and must not be what gets recorded.
    const storedAgentConfig = { timeoutSec: 30, url: "https://example.test/hook" };
    const effectiveRuntimeConfig = { timeoutMs: 45_000, url: "https://example.test/hook" };

    const fromStored = resolveHeartbeatRunTimeoutPolicy(HTTP, storedAgentConfig);
    const fromRuntime = resolveHeartbeatRunTimeoutPolicy(HTTP, effectiveRuntimeConfig);

    // Pre-port this recorded `fromStored`: 30s reported for a request that was
    // actually aborted at 45s.
    expect(fromStored.effectiveTimeoutSec).toBe(0);
    expect(fromStored.timeoutConfigured).toBe(false);
    expect(fromStored.timeoutSource).toBe("default");

    expect(fromRuntime.effectiveTimeoutSec).toBe(45);
    expect(fromRuntime.effectiveTimeoutMs).toBe(45_000);
    expect(fromRuntime.timeoutConfigured).toBe(true);
    expect(fromRuntime.timeoutSource).toBe("config");
  });

  it("does not read timeoutSec for the http adapter", () => {
    // Documents the asymmetry the reviewer asked about: `timeoutSec` is the
    // field every other adapter uses, and http is the exception.
    const http = resolveHeartbeatRunTimeoutPolicy("http", { timeoutSec: 120 });
    const hermes = resolveHeartbeatRunTimeoutPolicy("hermes_local", { timeoutSec: 120 });

    expect(http.timeoutConfigured).toBe(false);
    expect(hermes.effectiveTimeoutSec).toBe(120);
  });
});
