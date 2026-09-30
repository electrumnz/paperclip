import { describe, expect, it } from "vitest";

import { classifyHermesProviderFailure } from "./provider-failure.js";

describe("classifyHermesProviderFailure", () => {
  it("treats a rendered quota exhaustion as terminal provider quota", () => {
    expect(classifyHermesProviderFailure("HTTP 429: Atria account quota exhausted; operator action required."))
      .toEqual({ errorCode: "provider_quota", errorFamily: "provider_quota" });
  });

  it("does not let a quota message become a transient retry", () => {
    const failure = classifyHermesProviderFailure("error atria_quota_exhausted");
    expect(failure?.errorFamily).toBe("provider_quota");
    expect(failure?.retryDelaySec).toBeUndefined();
  });

  it("keeps the observed Atria HTTP 502 in the transient family", () => {
    expect(
      classifyHermesProviderFailure(
        "API call failed after 1 retries: HTTP 502: Atria connection failed. No other model was used.",
      ),
    ).toEqual({ errorCode: "hermes_transient_upstream", errorFamily: "transient_upstream" });
  });

  it("reads a structured retry_after_seconds and never schedules less than 60s", () => {
    expect(classifyHermesProviderFailure('atria_rate_limited {"retry_after_seconds":120}')?.retryDelaySec).toBe(120);
    expect(classifyHermesProviderFailure("atria_rate_limited {\"retry_after_seconds\":5}")?.retryDelaySec).toBe(60);
  });

  it("reads a rendered long Retry-After", () => {
    expect(
      classifyHermesProviderFailure("HTTP 429: Atria rate limit reached. Retry after at least 120 seconds.")
        ?.retryDelaySec,
    ).toBe(120);
  });

  it("applies a bounded default backoff to a transient failure with no stated wait", () => {
    expect(classifyHermesProviderFailure("atria_unavailable")?.retryDelaySec).toBeUndefined();
    expect(classifyHermesProviderFailure("atria_unavailable")?.errorFamily).toBe("transient_upstream");
  });

  it("keeps authentication and input failures out of the retryable families", () => {
    expect(classifyHermesProviderFailure("atria_authentication")?.errorFamily).toBeUndefined();
    expect(classifyHermesProviderFailure("atria_input_budget")?.errorFamily).toBeUndefined();
    expect(classifyHermesProviderFailure("atria_authentication")?.errorCode).toBe("hermes_provider_authentication");
  });

  it("returns null for output that is not a provider failure", () => {
    expect(classifyHermesProviderFailure("missing workspace")).toBeNull();
    expect(classifyHermesProviderFailure("")).toBeNull();
    expect(classifyHermesProviderFailure("   ")).toBeNull();
  });

  it("prefers the missing outcome over provider text quoted in the same output", () => {
    expect(
      classifyHermesProviderFailure("HERMES_TASK_OUTCOME_MISSING; earlier Atria connection failed"),
    ).toEqual({ errorCode: "hermes_task_outcome_missing" });
  });
});
