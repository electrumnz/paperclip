import test from "node:test";
import assert from "node:assert/strict";

import {
  buildQuotaState,
  chooseProvider,
  chooseProviderWithTelemetry,
  isQuotaFailure,
  preferredProvider,
  QuotaAwareAgentRouter,
  routableAgents,
  stabilizeQuotaState,
  summarizeQuota,
} from "./quota-aware-agent-router.mjs";

test("Claude is blocked when either the current-session or weekly window is exhausted", () => {
  const quota = summarizeQuota({
    ok: true,
    windows: [
      { label: "Current session", usedPercent: 12 },
      { label: "Current week (all models)", usedPercent: 100, resetsAt: "2099-01-01T00:00:00Z" },
    ],
  });
  assert.equal(quota.hardBlocked, true);
  assert.equal(quota.limitingWindows[0].label, "Current week (all models)");
});

test("Claude is also blocked when only the five-hour session window is exhausted", () => {
  const quota = summarizeQuota({
    ok: true,
    windows: [
      { label: "Current session", usedPercent: 100, resetsAt: "2099-01-01T00:00:00Z" },
      { label: "Current week (all models)", usedPercent: 40 },
    ],
  });
  assert.equal(quota.hardBlocked, true);
  assert.equal(quota.limitingWindows[0].label, "Current session");
});

test("Grok is used before spending protected Codex or Claude reserve", () => {
  const quota = buildQuotaState([
    { provider: "anthropic", ok: true, windows: [{ label: "week", usedPercent: 100 }] },
    { provider: "openai", ok: true, windows: [{ label: "5h", usedPercent: 97 }] },
  ], 15);
  assert.equal(chooseProvider({ preferred: "anthropic", quota, urgent: false }), "xai");
  assert.equal(chooseProvider({ preferred: "anthropic", quota, urgent: true }), "xai");
});

test("Codex switches to Grok when its usage reaches the configured 90 percent threshold", () => {
  const quota = buildQuotaState([
    { provider: "anthropic", ok: true, windows: [{ label: "week", usedPercent: 82 }] },
    { provider: "openai", ok: true, windows: [{ label: "5h", usedPercent: 90 }] },
  ], 10);
  assert.equal(chooseProvider({ preferred: "openai", quota, urgent: false }), "xai");
});

test("a provider at hard exhaustion is never selected", () => {
  const quota = buildQuotaState([
    { provider: "anthropic", ok: true, windows: [{ label: "week", usedPercent: 100 }] },
    { provider: "openai", ok: true, windows: [{ label: "5h", usedPercent: 100 }] },
    { provider: "xai", ok: true, windows: [{ label: "week", usedPercent: 100 }] },
  ]);
  assert.equal(chooseProvider({ preferred: "anthropic", quota, urgent: true }), null);
});

test("a temporary quota polling failure reuses recent known-good windows", () => {
  const now = Date.parse("2026-09-15T00:00:00Z");
  const previous = {
    anthropic: {
      entry: {
        provider: "anthropic",
        ok: true,
        windows: [{ label: "Current week", usedPercent: 49 }],
      },
      updatedAt: "2026-09-14T23:55:00Z",
    },
  };
  const result = stabilizeQuotaState(
    [
      { provider: "anthropic", ok: false, error: "usage endpoint returned 429" },
      { provider: "openai", ok: true, windows: [{ label: "5h", usedPercent: 5 }] },
    ],
    previous,
    15,
    now,
  );
  assert.equal(result.quota.anthropic.hardBlocked, false);
  assert.equal(result.quota.anthropic.maxUsedPercent, 49);
  assert.deepEqual(result.degradedProviders, ["anthropic"]);
  assert.deepEqual(result.unknownProviders, []);
});

test("missing quota telemetry alone does not mark a provider exhausted", () => {
  const result = stabilizeQuotaState(
    [{ provider: "anthropic", ok: false, error: "temporary polling failure" }],
    {},
  );
  assert.equal(result.quota.anthropic.hardBlocked, false);
  assert.equal(result.quota.anthropic.reserveBlocked, false);
  assert.equal(result.quota.anthropic.maxUsedPercent, null);
  assert.deepEqual(result.unknownProviders, ["anthropic", "openai"]);
});

test("unknown telemetry never flips a healthy agent back to the preferred provider", () => {
  const quota = buildQuotaState([
    { provider: "anthropic", ok: true, windows: [] },
    { provider: "openai", ok: true, windows: [{ label: "5h", usedPercent: 5 }] },
  ]);
  assert.equal(
    chooseProviderWithTelemetry({
      preferred: "anthropic",
      current: "openai",
      quota,
      unknownProviders: ["anthropic"],
    }),
    "openai",
  );
});

test("generic ACPX failures are recognized from their actual quota message", () => {
  assert.equal(isQuotaFailure({
    errorCode: "acpx_turn_failed",
    log: "You've hit your monthly spend limit · raise it in settings",
  }), true);
  assert.equal(isQuotaFailure({ errorCode: "acpx_turn_failed", log: "Syntax error on line 10" }), false);
});

test("Grok OAuth failures are treated as provider-unavailable failures", () => {
  assert.equal(isQuotaFailure({
    errorCode: "adapter_failed",
    log: "Grok is not authenticated: No auth credentials for cli-chat-proxy",
  }), true);
});

test("task fit prefers Codex for engineering and Claude for research", () => {
  assert.equal(preferredProvider({ role: "engineer" }, { title: "Build the API" }), "openai");
  assert.equal(preferredProvider({ role: "researcher" }, { title: "Demand evidence pass" }), "anthropic");
});

test("cheap model-profile runs use the same fleet-wide Grok fallback", () => {
  const issue = {
    title: "Summarize routine status",
    assigneeAdapterOverrides: { modelProfile: "cheap" },
  };
  const quota = buildQuotaState([
    { provider: "anthropic", ok: true, windows: [{ label: "week", usedPercent: 92 }] },
    { provider: "openai", ok: true, windows: [{ label: "5h", usedPercent: 90 }] },
  ], 10);
  const preferred = preferredProvider({ role: "operator" }, issue, "openai");
  assert.equal(chooseProvider({ preferred, quota, urgent: false }), "xai");
});

test("all present and future Claude, Codex, and Grok agents are routable without an allowlist", () => {
  assert.deepEqual(
    routableAgents([
      { id: "existing", adapterType: "claude_local" },
      { id: "newly-approved", adapterType: "codex_local" },
      { id: "grok-backup", adapterType: "grok_local" },
      { id: "hermes", adapterType: "openclaw_gateway" },
    ]).map((agent) => agent.id),
    ["existing", "newly-approved", "grok-backup"],
  );
});

test("instance discovery visits every active organisation", async () => {
  const visited = [];
  class DiscoveryRouter extends QuotaAwareAgentRouter {
    async api(pathname) {
      assert.equal(pathname, "/companies");
      return [
        { id: "one", name: "One", status: "active", archivedAt: null },
        { id: "two", name: "Two", status: "active", archivedAt: null },
        { id: "old", name: "Old", status: "archived", archivedAt: "2026-01-01T00:00:00Z" },
      ];
    }

    async tickCompany(company) {
      visited.push(company.id);
    }
  }
  const router = new DiscoveryRouter({ statePath: "/tmp/unused", logPath: "/tmp/unused.log" });
  await router.tick();
  assert.deepEqual(visited, ["one", "two"]);
});
