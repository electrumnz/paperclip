/**
 * KEE-1087 / KEE-1101: the error codes the Hermes adapter emits must be the
 * vocabulary recovery already reads.
 *
 * The reviewer's finding was that my port introduced `hermes_*` codes that no
 * consumer matched. Measured against the fixed consumers:
 *
 *   errorCode                      classifyContinuationFailure   quota monitor
 *   adapter_failed (pre-port)      transient_infra               yes
 *   hermes_transient_upstream      default        <-- WORSE      no
 *   provider_quota (upstream)      transient_infra               yes
 *   hermes_provider_quota          default        <-- WORSE      no
 *
 * So the port made Hermes failures retry *less* than before. These tests pin
 * the producer and the consumer together, so that regression cannot come back
 * through a renamed string.
 *
 * Producer side: the real Hermes classifier, imported from the adapter package.
 * Consumer side: the real `classifyContinuationFailure` and
 * `classifyAdapterFailureForRecovery` from the recovery service.
 */

import { describe, expect, it } from "vitest";
// Imported through the package's public server entrypoint, not a relative path
// into its source: a relative import across the workspace boundary breaks the
// server tsconfig rootDir (TS6059).
import { classifyHermesProviderFailure } from "@paperclipai/hermes-paperclip-adapter/server";
import {
  classifyAdapterFailureForRecovery,
  classifyContinuationFailure,
} from "./service.js";

const run = (errorCode: string | null, error = "") =>
  ({ errorCode, error, resultJson: null }) as unknown as Parameters<
    typeof classifyContinuationFailure
  >[0];

describe("KEE-1101: Hermes provider-failure codes are readable by recovery", () => {
  it("emits the upstream quota literal, not an adapter-prefixed name", () => {
    // The Atria quota text observed in the pilot.
    const classification = classifyHermesProviderFailure(
      "atria_quota_exhausted: account has no remaining quota",
    );
    expect(classification?.errorCode).toBe("provider_quota");
    expect(classification?.errorFamily).toBe("provider_quota");
  });

  it("emits a transient code that recovery classifies as transient_infra", () => {
    const classification = classifyHermesProviderFailure(
      "HTTP 502: upstream provider is unavailable",
    );
    expect(classification?.errorCode).toBe("hermes_transient_upstream");
    expect(classification?.errorFamily).toBe("transient_upstream");

    // The regression the reviewer proved: before the fix this fell through to
    // `default` (1 attempt, 0 backoff).
    const continuation = classifyContinuationFailure(run(classification!.errorCode));
    expect(continuation.kind).toBe("transient_infra");
    expect(continuation.maxAttempts).toBeGreaterThan(1);
    expect(continuation.baseBackoffMs).toBeGreaterThan(0);
  });

  it("does not regress Hermes transient handling against the pre-port baseline", () => {
    // Pre-port, a Hermes failure arrived as an opaque `adapter_failed`.
    const before = classifyContinuationFailure(run("adapter_failed"));
    const after = classifyContinuationFailure(
      run(classifyHermesProviderFailure("atria_rate_limited")?.errorCode ?? null),
    );

    // Same or better retry budget than before the port existed.
    expect(after.kind).toBe(before.kind);
    expect(after.maxAttempts).toBe(before.maxAttempts);
    expect(after.baseBackoffMs).toBe(before.baseBackoffMs);
  });

  it("routes a Hermes quota failure to the quota recovery path", () => {
    const classification = classifyHermesProviderFailure(
      "insufficient_quota: Atria account quota exhausted",
    );
    expect(classification?.errorCode).toBe("provider_quota");

    // `classifyAdapterFailureForRecovery` allow-lists `provider_quota`
    // explicitly, so this is what schedules the quota recovery monitor.
    const recovery = classifyAdapterFailureForRecovery({
      errorCode: classification!.errorCode,
      error: "insufficient_quota",
      resultJson: null,
    } as unknown as Parameters<typeof classifyAdapterFailureForRecovery>[0]);
    expect(recovery?.kind).toBe("provider_quota");
  });

  it("keeps terminal auth and invalid-request codes non-retryable", () => {
    // Terminal provider conditions must not be retried as transient infra.
    for (const text of [
      "atria_authentication: credentials were rejected",
      "atria_input_budget: conservative atria context budget exceeded",
    ]) {
      const classification = classifyHermesProviderFailure(text);
      expect(classification).not.toBeNull();
      // Not transient, and not in the transient set.
      expect(classification!.errorFamily).toBeUndefined();
      expect(
        classifyContinuationFailure(run(classification!.errorCode)).kind,
      ).not.toBe("transient_infra");
    }
  });
});
