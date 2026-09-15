import test from "node:test";
import assert from "node:assert/strict";

import {
  buildQuotaState,
  chooseProvider,
  chooseProviderDecision,
  chooseProviderWithTelemetry,
  isQuotaFailure,
  mergeRuntimePolicy,
  needsProviderConfigRefresh,
  needsRuntimePolicyRefresh,
  optimizedClaudeConfig,
  preferredProvider,
  providerForAgent,
  quotaFailureKind,
  QuotaAwareAgentRouter,
  routableAgents,
  sortAgentsManagersFirst,
  stabilizeQuotaState,
  summarizeQuota,
  targetConfig,
  withObservedProviderFailure,
  withObservedSessionWindowFailure,
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
  assert.equal(quota.sessionWindowHardBlocked, true);
  assert.equal(quota.fallbackHardBlocked, false);
  assert.equal(quota.limitingWindows[0].label, "Current session");
});

test("five-hour session pressure holds the primary account instead of consuming fallback", () => {
  const quota = buildQuotaState([
    {
      provider: "anthropic",
      ok: true,
      windows: [
        { label: "Current session", usedPercent: 95, resetsAt: "2099-01-01T00:00:00Z" },
        { label: "Current week (all models)", usedPercent: 25 },
      ],
    },
    {
      provider: "anthropic_personal",
      ok: true,
      windows: [{ label: "Current session", usedPercent: 10 }],
    },
  ], 5);
  assert.deepEqual(chooseProviderDecision({ preferred: "anthropic", quota }), {
    target: null,
    holdProvider: "anthropic",
  });
  assert.deepEqual(chooseProviderDecision({ preferred: "anthropic", quota, urgent: true }), {
    target: null,
    holdProvider: "anthropic",
  });
  assert.equal(quota.anthropic.sessionWindowResetsAt, "2099-01-01T00:00:00.000Z");
});

test("weekly pressure still advances from Keece Claude to Electrum Claude", () => {
  const quota = buildQuotaState([
    {
      provider: "anthropic",
      ok: true,
      windows: [
        { label: "Current session", usedPercent: 15 },
        { label: "Current week (all models)", usedPercent: 95 },
      ],
    },
    {
      provider: "anthropic_personal",
      ok: true,
      windows: [{ label: "Current session", usedPercent: 10 }],
    },
  ], 5);
  assert.equal(chooseProvider({ preferred: "anthropic", quota }), "anthropic_personal");
});

test("a five-hour limit on the weekly fallback account holds there", () => {
  const quota = buildQuotaState([
    {
      provider: "anthropic",
      ok: true,
      windows: [{ label: "Current week (all models)", usedPercent: 95 }],
    },
    {
      provider: "anthropic_personal",
      ok: true,
      windows: [
        { label: "Current session", usedPercent: 95 },
        { label: "Current week (all models)", usedPercent: 30 },
      ],
    },
  ], 5);
  assert.deepEqual(chooseProviderDecision({ preferred: "anthropic", quota }), {
    target: null,
    holdProvider: "anthropic_personal",
  });
});

test("a company tick pauses an idle agent at the five-hour reserve without switching accounts", async () => {
  const calls = [];
  const agent = {
    id: "agent-1",
    companyId: "company-1",
    name: "Coder",
    role: "engineer",
    status: "idle",
    adapterType: "claude_local",
    adapterConfig: {
      model: "claude-sonnet-5",
      effort: "medium",
      env: { CLAUDE_CONFIG_DIR: "/tmp/work-claude" },
    },
    runtimeConfig: {
      heartbeat: { maxConcurrentRuns: 1 },
      modelProfiles: {
        cheap: {
          enabled: true,
          adapterConfig: { model: "claude-haiku-4-5", effort: "low" },
        },
      },
    },
  };
  class SessionHoldRouter extends QuotaAwareAgentRouter {
    async claudeQuotaEntries() {
      return [{
        provider: "anthropic",
        ok: true,
        windows: [
          { label: "Current session", usedPercent: 95, resetsAt: "2099-01-01T00:00:00Z" },
          { label: "Current week (all models)", usedPercent: 20 },
        ],
      }];
    }

    async api(pathname, options = {}) {
      calls.push({ pathname, method: options.method ?? "GET" });
      if (pathname.endsWith("/agents")) return [agent];
      if (pathname.includes("/issues?")) return [];
      if (pathname.endsWith("/costs/quota-windows")) {
        return [{
          provider: "anthropic",
          ok: true,
          windows: [{ label: "Current session", usedPercent: 10 }],
        }];
      }
      if (pathname.endsWith("/live-runs?limit=200")) return [];
      if (pathname.includes("/heartbeat-runs?")) return [];
      if (pathname === "/agents/agent-1/pause") return { ...agent, status: "paused" };
      throw new Error(`Unexpected API call: ${options.method ?? "GET"} ${pathname}`);
    }

    async saveState() {}
    async log() {}
  }
  const router = new SessionHoldRouter({
    statePath: "/tmp/unused",
    logPath: "/tmp/unused.log",
    reservePercent: 10,
    reservePercentByProvider: { anthropic: 5 },
    defaultPrimaryProvider: "anthropic",
    claudeProfiles: {
      anthropic: { configDir: "/tmp/work-claude" },
      anthropic_personal: { configDir: "/tmp/personal-claude" },
    },
    cheapProfile: { enabled: true, model: "claude-haiku-4-5", effort: "low" },
  });
  await router.tickCompany({ id: "company-1", name: "Company" });
  assert.equal(calls.some((call) => call.pathname === "/agents/agent-1/pause"), true);
  assert.equal(calls.some((call) => call.pathname === "/agents/agent-1" && call.method === "PATCH"), false);
  assert.equal(router.state.agents[agent.id].sessionWindowHold.provider, "anthropic");
});

test("a router-owned session hold resumes and retries its task after reset", async () => {
  const calls = [];
  class SessionReleaseRouter extends QuotaAwareAgentRouter {
    async api(pathname, options = {}) {
      calls.push({ pathname, method: options.method ?? "GET", body: options.body ?? null });
      if (pathname === "/agents/agent-1/resume") {
        return { id: "agent-1", companyId: "company-1", name: "Coder", status: "idle" };
      }
      if (pathname === "/agents/agent-1/wakeup") return { status: "queued" };
      throw new Error(`Unexpected API call: ${options.method ?? "GET"} ${pathname}`);
    }

    async saveState() {}
    async log() {}
  }
  const router = new SessionReleaseRouter({ statePath: "/tmp/unused", logPath: "/tmp/unused.log" });
  const state = {
    sessionWindowHold: {
      provider: "anthropic",
      resetsAt: "2099-01-01T00:00:00.000Z",
      issueId: "issue-1",
      run: null,
    },
  };
  const released = await router.releaseAgentSessionWindowHold(
    { id: "company-1", name: "Company" },
    { id: "agent-1", companyId: "company-1", name: "Coder", status: "paused" },
    state,
    state.sessionWindowHold,
    { id: "issue-1", identifier: "KEE-1", status: "todo" },
  );
  assert.equal(released.status, "idle");
  assert.equal(state.sessionWindowHold, undefined);
  assert.deepEqual(calls.map((call) => [call.method, call.pathname]), [
    ["POST", "/agents/agent-1/resume"],
    ["POST", "/agents/agent-1/wakeup"],
  ]);
  assert.match(calls[1].body, /claude_five_hour_window_reset/);
});

test("session holds and releases process managers before their reports", () => {
  const agents = [
    { id: "coder", reportsTo: "lead" },
    { id: "chair", reportsTo: null },
    { id: "lead", reportsTo: "chair" },
    { id: "peer", reportsTo: "chair" },
  ];
  const positions = Object.fromEntries(
    sortAgentsManagersFirst(agents).map((agent, index) => [agent.id, index]),
  );
  assert.ok(positions.chair < positions.lead);
  assert.ok(positions.chair < positions.peer);
  assert.ok(positions.lead < positions.coder);
});

test("a held child stays paused when a manually paused manager blocks its release", async () => {
  class BlockedReleaseRouter extends QuotaAwareAgentRouter {
    async api(pathname) {
      throw new Error(`POST ${pathname} returned 409: reporting chain is paused`);
    }

    async saveState() {
      throw new Error("state must not be cleared");
    }

    async log() {}
  }
  const router = new BlockedReleaseRouter({ statePath: "/tmp/unused", logPath: "/tmp/unused.log" });
  const hold = { provider: "anthropic", resetsAt: "2099-01-01T00:00:00Z" };
  const state = { sessionWindowHold: hold };
  const agent = { id: "child", companyId: "company-1", name: "Child", status: "paused" };
  const result = await router.releaseAgentSessionWindowHold(
    { id: "company-1", name: "Company" },
    agent,
    state,
    hold,
    null,
  );
  assert.equal(result, agent);
  assert.equal(state.sessionWindowHold, hold);
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
  const failure = {
    errorCode: "acpx_turn_failed",
    log: "Upstream request failed with HTTP 401 Unauthorized",
  };
  assert.equal(isQuotaFailure(failure), true);
  assert.equal(quotaFailureKind(failure), "authentication");
});

test("observed five-hour failures are held without poisoning weekly fallback", () => {
  const quota = buildQuotaState([
    {
      provider: "anthropic",
      ok: true,
      windows: [
        { label: "Current session", usedPercent: 94 },
        { label: "Current week (all models)", usedPercent: 20 },
      ],
    },
    {
      provider: "anthropic_personal",
      ok: true,
      windows: [{ label: "Current session", usedPercent: 5 }],
    },
  ], 5);
  const observed = withObservedSessionWindowFailure(quota, "anthropic");
  assert.equal(observed.anthropic.fallbackHardBlocked, false);
  assert.deepEqual(chooseProviderDecision({ preferred: "anthropic", quota: observed }), {
    target: null,
    holdProvider: "anthropic",
  });
  assert.equal(quotaFailureKind({ log: "Current session / five-hour usage limit reached" }), "session_window");
});

test("an explicit five-hour failure still holds when quota polling is temporarily unavailable", () => {
  const quota = buildQuotaState([
    { provider: "anthropic", ok: false, error: "poll timeout" },
    {
      provider: "anthropic_personal",
      ok: true,
      windows: [{ label: "Current session", usedPercent: 5 }],
    },
  ], 5);
  const observed = withObservedSessionWindowFailure(quota, "anthropic");
  assert.deepEqual(chooseProviderDecision({ preferred: "anthropic", quota: observed }), {
    target: null,
    holdProvider: "anthropic",
  });
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
    anthropic: { configDir: "/tmp/paperclip-claude" },
    anthropic_personal: { configDir: "/tmp/personal-claude" },
  };
  assert.deepEqual(
    targetConfig("anthropic", {
      dangerouslySkipPermissions: true,
      env: { KEEP_ME: "yes", CLAUDE_CONFIG_DIR: "/wrong/account" },
    }, profiles, { model: "claude-sonnet-5", effort: "medium" }),
    {
      dangerouslySkipPermissions: true,
      model: "claude-sonnet-5",
      effort: "medium",
      env: { KEEP_ME: "yes", CLAUDE_CONFIG_DIR: "/tmp/paperclip-claude" },
    },
  );
});

test("only explicitly overridden principals use Fable while coder agents use Sonnet", () => {
  const overrides = {
    principal: { model: "claude-fable-5", effort: "high" },
    operations: { model: "claude-opus-5", effort: "high" },
  };
  assert.deepEqual(
    optimizedClaudeConfig({ id: "principal", name: "Principal Architect" }, overrides),
    { model: "claude-fable-5", effort: "high" },
  );
  for (const name of [
    "Frontend Delivery Coder",
    "Backend Delivery Coder",
    "Maintenance & Test Coder",
  ]) {
    assert.deepEqual(
      optimizedClaudeConfig({ id: name, name }, overrides),
      { model: "claude-sonnet-5", effort: "medium" },
    );
  }
  assert.deepEqual(
    optimizedClaudeConfig({ id: "chair", name: "Chair of Board" }, overrides),
    { model: "claude-opus-5", effort: "high" },
  );
  assert.deepEqual(
    optimizedClaudeConfig({ id: "operations", name: "AI Processing Operations Lead" }, overrides),
    { model: "claude-opus-5", effort: "high" },
  );
});

test("existing Claude agents are reconciled to their role model", () => {
  const profiles = {
    anthropic: { configDir: "/tmp/paperclip-claude" },
  };
  assert.equal(needsProviderConfigRefresh({
    adapterType: "claude_local",
    adapterConfig: { model: "claude-fable-5", effort: "high" },
  }, "anthropic", profiles, { model: "claude-sonnet-5", effort: "medium" }), true);
  assert.equal(needsProviderConfigRefresh({
    adapterType: "claude_local",
    adapterConfig: { model: "claude-sonnet-5", effort: "medium" },
  }, "anthropic", profiles, { model: "claude-sonnet-5", effort: "medium" }), false);
});

test("cheap runs are enabled on Haiku at low effort without dropping other profiles", () => {
  const runtime = mergeRuntimePolicy({
    heartbeat: { enabled: true },
    modelProfiles: { specialist: { enabled: true, adapterConfig: { model: "claude-opus-5" } } },
  }, { model: "claude-haiku-4-5", effort: "low" });
  assert.equal(runtime.heartbeat.maxConcurrentRuns, 1);
  assert.deepEqual(runtime.modelProfiles.cheap, {
    enabled: true,
    adapterConfig: { model: "claude-haiku-4-5", effort: "low" },
  });
  assert.equal(runtime.modelProfiles.specialist.adapterConfig.model, "claude-opus-5");
  assert.equal(needsRuntimePolicyRefresh(runtime, {
    model: "claude-haiku-4-5",
    effort: "low",
  }), false);
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
