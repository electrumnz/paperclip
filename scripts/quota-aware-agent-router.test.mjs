import test from "node:test";
import assert from "node:assert/strict";

import {
  buildQuotaState,
  chooseProvider,
  chooseProviderWithTelemetry,
  isQuotaFailure,
  needsProviderConfigRefresh,
  preferredProvider,
  providerForAgent,
  QuotaAwareAgentRouter,
  routableAgents,
  stabilizeQuotaState,
  summarizeQuota,
  targetConfig,
  withObservedProviderFailure,
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

test("Keece Claude falls back only to Electrum Claude", () => {
  const quota = buildQuotaState([
    { provider: "anthropic", ok: true, windows: [{ label: "week", usedPercent: 100 }] },
    { provider: "anthropic_personal", ok: true, windows: [{ label: "week", usedPercent: 20 }] },
    { provider: "openai", ok: true, windows: [{ label: "5h", usedPercent: 30 }] },
  ], 15);
  assert.equal(chooseProvider({ preferred: "anthropic", quota, urgent: false }), "anthropic_personal");
  quota.anthropic_personal.reserveBlocked = true;
  assert.equal(chooseProvider({ preferred: "anthropic", quota, urgent: false }), null);
});

test("Keece Claude switches to Electrum Claude at the configured 90 percent threshold", () => {
  const quota = buildQuotaState([
    { provider: "anthropic", ok: true, windows: [{ label: "week", usedPercent: 90 }] },
    { provider: "anthropic_personal", ok: true, windows: [{ label: "week", usedPercent: 82 }] },
    { provider: "openai", ok: true, windows: [{ label: "5h", usedPercent: 20 }] },
  ], 10);
  assert.equal(chooseProvider({ preferred: "anthropic", quota, urgent: false }), "anthropic_personal");
});

test("per-provider reserve lets Keece Claude run to 95 percent", () => {
  const result = stabilizeQuotaState(
    [
      { provider: "anthropic", ok: true, windows: [{ label: "week", usedPercent: 94 }] },
      { provider: "anthropic_personal", ok: true, windows: [{ label: "week", usedPercent: 40 }] },
      { provider: "openai", ok: true, windows: [{ label: "5h", usedPercent: 20 }] },
    ],
    {},
    10,
    Date.now(),
    15 * 60_000,
    { anthropic: 5 },
  );
  assert.equal(result.quota.anthropic.reserveBlocked, false);
  result.quota.anthropic = summarizeQuota({
    provider: "anthropic",
    ok: true,
    windows: [{ label: "week", usedPercent: 95 }],
  }, 5);
  assert.equal(result.quota.anthropic.reserveBlocked, true);
  assert.equal(chooseProvider({ preferred: "anthropic", quota: result.quota }), "anthropic_personal");
});

test("a provider at hard exhaustion is never selected", () => {
  const quota = buildQuotaState([
    { provider: "anthropic", ok: true, windows: [{ label: "week", usedPercent: 100 }] },
    { provider: "anthropic_personal", ok: true, windows: [{ label: "week", usedPercent: 100 }] },
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
      { provider: "anthropic_personal", ok: true, windows: [{ label: "Current week", usedPercent: 20 }] },
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
  assert.deepEqual(result.unknownProviders, ["anthropic", "anthropic_personal", "openai"]);
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

test("generic 401 authentication failures trigger provider fallback", () => {
  assert.equal(isQuotaFailure({
    errorCode: "acpx_turn_failed",
    log: "Upstream request failed with HTTP 401 Unauthorized",
  }), true);
});

test("legacy Grok state can be normalized during migration without a model pin", () => {
  assert.deepEqual(targetConfig("xai"), {
    graceSec: 20,
    timeoutSec: 0,
    alwaysApprove: true,
    disableWebSearch: true,
  });
  assert.deepEqual(
    targetConfig("xai", { model: "grok-4.6", alwaysApprove: true }),
    { alwaysApprove: true },
  );
});

test("Claude account profiles remain distinguishable on the shared adapter", () => {
  const profiles = {
    anthropic: { configDir: "/tmp/paperclip-claude" },
    anthropic_personal: { configDir: "/tmp/personal-claude" },
  };
  assert.equal(providerForAgent({
    adapterType: "claude_local",
    adapterConfig: { env: { CLAUDE_CONFIG_DIR: { type: "plain", value: "/tmp/paperclip-claude" } } },
  }, profiles), "anthropic");
  assert.equal(providerForAgent({
    adapterType: "claude_local",
    adapterConfig: { env: { CLAUDE_CONFIG_DIR: "/tmp/personal-claude" } },
  }, profiles), "anthropic_personal");
  assert.equal(providerForAgent({ adapterType: "claude_local", adapterConfig: {} }, profiles), "anthropic_personal");
});

test("Claude profile switching forces the selected credential directory", () => {
  const profiles = {
    anthropic: { configDir: "/tmp/paperclip-claude", model: "claude-fable-5" },
    anthropic_personal: { configDir: "/tmp/personal-claude", model: "claude-fable-5" },
  };
  assert.deepEqual(
    targetConfig("anthropic", {
      dangerouslySkipPermissions: true,
      env: { KEEP_ME: "yes", CLAUDE_CONFIG_DIR: "/wrong/account" },
    }, profiles),
    {
      dangerouslySkipPermissions: true,
      model: "claude-fable-5",
      env: { KEEP_ME: "yes", CLAUDE_CONFIG_DIR: "/tmp/paperclip-claude" },
    },
  );
});

test("existing Claude agents are reconciled to the configured Fable model", () => {
  const profiles = {
    anthropic: { configDir: "/tmp/paperclip-claude", model: "claude-fable-5" },
  };
  assert.equal(needsProviderConfigRefresh({
    adapterType: "claude_local",
    adapterConfig: { model: "claude-sonnet-5" },
  }, "anthropic", profiles), true);
  assert.equal(needsProviderConfigRefresh({
    adapterType: "claude_local",
    adapterConfig: { model: "claude-fable-5" },
  }, "anthropic", profiles), false);
});

test("Claude profile quotas are polled with isolated credential environments", async () => {
  const calls = [];
  const router = new QuotaAwareAgentRouter({
    statePath: "/tmp/unused",
    logPath: "/tmp/unused.log",
    claudeProfiles: {
      anthropic: { configDir: "/tmp/paperclip-claude" },
      anthropic_personal: { configDir: "/tmp/personal-claude" },
    },
    execFile: async (command, args, options) => {
      calls.push({ command, args, configDir: options.env.CLAUDE_CONFIG_DIR });
      return {
        stdout: JSON.stringify({
          oauth: { ok: true, windows: [{ label: "Current session", usedPercent: 12 }] },
        }),
      };
    },
  });
  const entries = await router.claudeQuotaEntries();
  assert.deepEqual(entries.map((entry) => [entry.provider, entry.windows[0].usedPercent]), [
    ["anthropic", 12],
    ["anthropic_personal", 12],
  ]);
  assert.deepEqual(calls.map((call) => call.configDir), [
    "/tmp/paperclip-claude",
    "/tmp/personal-claude",
  ]);
  assert.equal(calls.every((call) => call.args.includes("--oauth-only")), true);
});

test("the dedicated Claude profile leads the fleet-wide fallback chain", () => {
  const quota = buildQuotaState([
    { provider: "anthropic", ok: true, windows: [{ label: "5h", usedPercent: 10 }] },
    { provider: "openai", ok: true, windows: [{ label: "5h", usedPercent: 20 }] },
    { provider: "xai", ok: true, windows: [] },
    { provider: "anthropic_personal", ok: true, windows: [{ label: "5h", usedPercent: 5 }] },
  ], 10);
  assert.equal(chooseProvider({ preferred: "anthropic", quota }), "anthropic");
  quota.anthropic.reserveBlocked = true;
  assert.equal(chooseProvider({ preferred: "anthropic", quota }), "anthropic_personal");
  quota.anthropic_personal.reserveBlocked = true;
  assert.equal(chooseProvider({ preferred: "anthropic", quota }), null);
});

test("one agent's observed failure does not poison shared fleet quota state", () => {
  const quota = buildQuotaState([
    { provider: "anthropic", ok: true, windows: [{ label: "week", usedPercent: 50 }] },
    { provider: "anthropic_personal", ok: true, windows: [{ label: "week", usedPercent: 20 }] },
    { provider: "openai", ok: true, windows: [{ label: "5h", usedPercent: 80 }] },
  ], 10);
  const affectedAgentQuota = withObservedProviderFailure(quota, "anthropic");

  assert.equal(affectedAgentQuota.anthropic.hardBlocked, true);
  assert.equal(chooseProvider({ preferred: "anthropic", quota: affectedAgentQuota }), "anthropic_personal");
  assert.equal(quota.anthropic.hardBlocked, false);
  assert.equal(chooseProvider({ preferred: "anthropic", quota }), "anthropic");
});

test("task fit prefers Codex for engineering and Claude for research", () => {
  assert.equal(preferredProvider({ role: "engineer" }, { title: "Build the API" }), "openai");
  assert.equal(preferredProvider({ role: "researcher" }, { title: "Demand evidence pass" }), "anthropic");
});

test("legacy configured Codex preference can still be recognized for migration", () => {
  assert.equal(
    preferredProvider({ role: "researcher" }, { title: "Demand evidence pass" }, "openai"),
    "openai",
  );
});

test("cheap model-profile runs use the same Claude account fallback chain", () => {
  const issue = {
    title: "Summarize routine status",
    assigneeAdapterOverrides: { modelProfile: "cheap" },
  };
  const quota = buildQuotaState([
    { provider: "anthropic", ok: true, windows: [{ label: "week", usedPercent: 92 }] },
    { provider: "anthropic_personal", ok: true, windows: [{ label: "week", usedPercent: 40 }] },
    { provider: "openai", ok: true, windows: [{ label: "5h", usedPercent: 20 }] },
  ], 10);
  const preferred = preferredProvider({ role: "operator" }, issue, "anthropic");
  assert.equal(chooseProvider({ preferred, quota, urgent: false }), "anthropic_personal");
});

test("legacy Grok agents remain discoverable only so the router can migrate them", () => {
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

test("the default Keece Claude primary policy is applied to existing and future agents", () => {
  const router = new QuotaAwareAgentRouter({
    statePath: "/tmp/unused",
    logPath: "/tmp/unused.log",
    defaultPrimaryProvider: "anthropic",
  });
  const company = { id: "company", name: "Company" };
  const existingClaude = router.ensureAgentState(company, {
    id: "existing-claude",
    adapterType: "claude_local",
    adapterConfig: {},
  });
  const futureGrok = router.ensureAgentState(company, {
    id: "future-grok",
    adapterType: "grok_local",
    adapterConfig: {},
  });
  assert.equal(existingClaude.primaryProvider, "anthropic");
  assert.equal(futureGrok.primaryProvider, "anthropic");
});

test("a pruned historical run log does not abort routing for its organisation", async () => {
  class MissingLogRouter extends QuotaAwareAgentRouter {
    async api(pathname) {
      if (pathname.includes("heartbeat-runs?")) {
        return [{
          id: "missing-log-run",
          status: "failed",
          errorCode: "process_lost",
          createdAt: new Date().toISOString(),
        }];
      }
      throw new Error(`GET ${pathname} returned 404: {"error":"Run log not found"}`);
    }

    async log() {}
  }

  const router = new MissingLogRouter({ statePath: "/tmp/unused", logPath: "/tmp/unused.log" });
  const result = await router.quotaFailureForAgent("company", { id: "agent" });
  assert.equal(result, null);
  assert.deepEqual(router.state.processedQuotaRunIds, ["missing-log-run"]);
});
