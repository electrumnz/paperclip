#!/usr/bin/env node

import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const PROVIDERS = {
  anthropic: { adapterType: "claude_local" },
  openai: { adapterType: "codex_local" },
  // Grok Build exposes subscription use through OAuth but does not currently
  // expose quota windows through Paperclip. Treat it as available until an
  // actual run reports an auth, quota, or rate-limit failure.
  xai: { adapterType: "grok_local", quotaTelemetry: false },
};

const PROVIDER_FALLBACK_ORDER = {
  anthropic: ["anthropic", "openai", "xai"],
  openai: ["openai", "xai", "anthropic"],
  xai: ["xai", "openai", "anthropic"],
};

const ADAPTER_TO_PROVIDER = Object.fromEntries(
  Object.entries(PROVIDERS).map(([provider, value]) => [value.adapterType, provider]),
);

const DEFAULT_CODEX_CONFIG = {
  graceSec: 15,
  timeoutSec: 0,
  dangerouslyBypassApprovalsAndSandbox: true,
};

const DEFAULT_GROK_CONFIG = {
  model: "grok-4.6",
  graceSec: 20,
  timeoutSec: 0,
  alwaysApprove: true,
  disableWebSearch: true,
};

const QUOTA_FAILURE_PATTERNS = [
  /provider[_ -]?quota/i,
  /rate[_ -]?limit(?:ed| reached| exceeded)?/i,
  /usage[_ -]?limit/i,
  /spend[_ -]?limit/i,
  /monthly spend limit/i,
  /weekly (?:usage )?limit/i,
  /(?:five|5)[ -]?hour (?:usage )?limit/i,
  /too many requests/i,
  /insufficient[_ -]?quota/i,
  /(?:credits?|quota) (?:are )?(?:exhausted|depleted)/i,
  /no auth credentials for cli-chat-proxy/i,
  /(?:grok|xai).*(?:not authenticated|authentication required|unauthorized)/i,
  /(?:not authenticated|authentication required|unauthorized).*(?:grok|xai)/i,
];

const PRIORITY_ORDER = { critical: 0, high: 1, medium: 2, low: 3 };
const ACTIONABLE_STATUSES = new Set(["todo", "in_progress"]);

export function summarizeQuota(entry, reservePercent = 15) {
  const windows = Array.isArray(entry?.windows) ? entry.windows : [];
  const enforced = windows.filter((window) => Number.isFinite(window?.usedPercent));
  const hardWindows = enforced.filter((window) => Number(window.usedPercent) >= 100);
  const reserveWindows = enforced.filter(
    (window) => Number(window.usedPercent) >= 100 - reservePercent,
  );
  const resetCandidates = hardWindows
    .map((window) => Date.parse(window.resetsAt ?? ""))
    .filter((value) => Number.isFinite(value) && value > Date.now());

  return {
    ok: entry?.ok === true,
    hardBlocked: entry?.ok !== true || hardWindows.length > 0,
    reserveBlocked: entry?.ok !== true || reserveWindows.length > 0,
    maxUsedPercent: enforced.length
      ? Math.max(...enforced.map((window) => Number(window.usedPercent)))
      : null,
    limitingWindows: (hardWindows.length ? hardWindows : reserveWindows).map((window) => ({
      label: window.label ?? "Usage window",
      usedPercent: Number(window.usedPercent),
      resetsAt: window.resetsAt ?? null,
    })),
    resetsAt: resetCandidates.length ? new Date(Math.min(...resetCandidates)).toISOString() : null,
  };
}

export function buildQuotaState(entries, reservePercent = 15) {
  const byProvider = Object.fromEntries(
    (Array.isArray(entries) ? entries : []).map((entry) => [
      entry.provider,
      summarizeQuota(entry, reservePercent),
    ]),
  );
  for (const provider of Object.keys(PROVIDERS)) {
    byProvider[provider] ??= PROVIDERS[provider].quotaTelemetry === false
      ? summarizeQuota({ provider, ok: true, windows: [] }, reservePercent)
      : summarizeQuota(null, reservePercent);
  }
  return byProvider;
}

export function stabilizeQuotaState(
  entries,
  previous = {},
  reservePercent = 15,
  now = Date.now(),
  staleMs = 15 * 60_000,
) {
  const incoming = new Map(
    (Array.isArray(entries) ? entries : []).map((entry) => [entry?.provider, entry]),
  );
  const cache = { ...previous };
  const quota = {};
  const degradedProviders = [];
  const unknownProviders = [];

  for (const provider of Object.keys(PROVIDERS)) {
    if (PROVIDERS[provider].quotaTelemetry === false) {
      quota[provider] = summarizeQuota({ provider, ok: true, windows: [] }, reservePercent);
      continue;
    }
    const entry = incoming.get(provider);
    if (entry?.ok === true) {
      const cleanEntry = {
        provider,
        ok: true,
        windows: Array.isArray(entry.windows) ? entry.windows : [],
      };
      cache[provider] = {
        entry: cleanEntry,
        updatedAt: new Date(now).toISOString(),
      };
      quota[provider] = summarizeQuota(cleanEntry, reservePercent);
      continue;
    }

    degradedProviders.push(provider);
    const cached = cache[provider];
    const cachedAt = Date.parse(cached?.updatedAt ?? "");
    const fresh = Number.isFinite(cachedAt) && now - cachedAt <= staleMs;
    if (!fresh) unknownProviders.push(provider);
    quota[provider] = fresh
      ? summarizeQuota(cached.entry, reservePercent)
      : summarizeQuota({ provider, ok: true, windows: [] }, reservePercent);
  }

  return { quota, cache, degradedProviders, unknownProviders };
}

export function isQuotaFailure(value) {
  const text = [value?.errorCode, value?.errorMessage, value?.log]
    .filter((item) => typeof item === "string")
    .join("\n");
  return QUOTA_FAILURE_PATTERNS.some((pattern) => pattern.test(text));
}

export function preferredProvider(agent, issue, configuredPrimary) {
  if (Object.hasOwn(PROVIDERS, configuredPrimary)) return configuredPrimary;
  const text = `${agent?.name ?? ""} ${agent?.role ?? ""} ${issue?.title ?? ""} ${issue?.description ?? ""}`;
  if (/engineer|technical|code|implement|debug|test|build|backend|frontend|ui\b/i.test(text)) {
    return "openai";
  }
  if (/research|market|competitive|demand|strategy|synthesis|thesis|writing|brief/i.test(text)) {
    return "anthropic";
  }
  return ADAPTER_TO_PROVIDER[agent?.adapterType] ?? "openai";
}

export function chooseProvider({ preferred, quota, urgent = false }) {
  const candidates = PROVIDER_FALLBACK_ORDER[preferred] ?? Object.keys(PROVIDERS);
  const available = candidates.find((provider) => !quota[provider]?.reserveBlocked);
  if (available) return available;
  if (urgent) return candidates.find((provider) => !quota[provider]?.hardBlocked) ?? null;
  return null;
}

export function chooseProviderWithTelemetry({
  preferred,
  current,
  quota,
  urgent = false,
  quotaFailure = false,
  unknownProviders = [],
}) {
  const target = chooseProvider({ preferred, quota, urgent });
  if (
    !quotaFailure &&
    unknownProviders.includes(preferred) &&
    current &&
    !quota[current]?.hardBlocked
  ) {
    return current;
  }
  return target;
}

export function withObservedProviderFailure(quota, provider) {
  const current = quota[provider];
  if (!current) return quota;
  return {
    ...quota,
    [provider]: {
      ...current,
      hardBlocked: true,
      reserveBlocked: true,
      limitingWindows: [
        ...current.limitingWindows,
        { label: "Observed provider quota failure", usedPercent: 100, resetsAt: null },
      ],
    },
  };
}

export function routableAgents(agents) {
  return (Array.isArray(agents) ? agents : []).filter(
    (agent) => Boolean(ADAPTER_TO_PROVIDER[agent?.adapterType]),
  );
}

function sortIssues(issues) {
  return [...issues].sort((left, right) => {
    const priority = (PRIORITY_ORDER[left.priority] ?? 99) - (PRIORITY_ORDER[right.priority] ?? 99);
    if (priority !== 0) return priority;
    return Date.parse(right.updatedAt ?? 0) - Date.parse(left.updatedAt ?? 0);
  });
}

function mergeSingleConcurrency(runtimeConfig) {
  const runtime = runtimeConfig && typeof runtimeConfig === "object" ? runtimeConfig : {};
  const heartbeat = runtime.heartbeat && typeof runtime.heartbeat === "object" ? runtime.heartbeat : {};
  const profiles = runtime.modelProfiles && typeof runtime.modelProfiles === "object"
    ? Object.fromEntries(Object.entries(runtime.modelProfiles).map(([key, value]) => {
      const profile = value && typeof value === "object" ? value : {};
      return [key, {
        ...profile,
        adapterConfig: profile.adapterConfig && typeof profile.adapterConfig === "object"
          ? profile.adapterConfig
          : {},
      }];
    }))
    : undefined;
  return {
    ...runtime,
    heartbeat: { ...heartbeat, maxConcurrentRuns: 1 },
    ...(profiles ? { modelProfiles: profiles } : {}),
  };
}

function targetConfig(provider, savedConfig) {
  if (savedConfig && typeof savedConfig === "object") return savedConfig;
  if (provider === "openai") return DEFAULT_CODEX_CONFIG;
  if (provider === "xai") return DEFAULT_GROK_CONFIG;
  return { dangerouslySkipPermissions: true };
}

function nowIso() {
  return new Date().toISOString();
}

export class QuotaAwareAgentRouter {
  constructor(config) {
    this.config = config;
    this.apiBase = String(config.apiBase ?? "http://127.0.0.1:3100").replace(/\/$/, "");
    this.statePath = resolve(config.statePath);
    this.logPath = resolve(config.logPath);
    this.state = { version: 1, agents: {}, processedQuotaRunIds: [] };
  }

  async log(event, details = {}) {
    const line = JSON.stringify({ timestamp: nowIso(), event, ...details });
    await mkdir(dirname(this.logPath), { recursive: true });
    await appendFile(this.logPath, `${line}\n`, "utf8");
    console.log(line);
  }

  async loadState() {
    try {
      const parsed = JSON.parse(await readFile(this.statePath, "utf8"));
      if (parsed && typeof parsed === "object") this.state = parsed;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    this.state.agents ??= {};
    this.state.processedQuotaRunIds ??= [];
  }

  async saveState() {
    await mkdir(dirname(this.statePath), { recursive: true });
    const temporary = `${this.statePath}.tmp`;
    await writeFile(temporary, `${JSON.stringify(this.state, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, this.statePath);
  }

  async api(pathname, options = {}) {
    const response = await fetch(`${this.apiBase}/api${pathname}`, {
      ...options,
      headers: {
        Accept: "application/json",
        ...(options.body ? { "Content-Type": "application/json" } : {}),
        ...(options.headers ?? {}),
      },
      signal: AbortSignal.timeout(this.config.requestTimeoutMs ?? 20_000),
    });
    const text = await response.text();
    let body = null;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
    }
    if (!response.ok) {
      throw new Error(`${options.method ?? "GET"} ${pathname} returned ${response.status}: ${text.slice(0, 500)}`);
    }
    return body;
  }

  async quotaFailureForAgent(companyId, agent) {
    const runs = await this.api(
      `/companies/${companyId}/heartbeat-runs?agentId=${agent.id}&limit=5&summary=true`,
    );
    const recentFailures = (Array.isArray(runs) ? runs : []).filter((run) => {
      if (run.status !== "failed") return false;
      const finishedAt = Date.parse(run.finishedAt ?? run.createdAt ?? "");
      return Number.isFinite(finishedAt) && Date.now() - finishedAt <= (this.config.failureLookbackMs ?? 86_400_000);
    });

    for (const run of recentFailures) {
      if (this.state.processedQuotaRunIds.includes(run.id)) continue;
      if (isQuotaFailure(run)) return run;
      let logResult;
      try {
        logResult = await this.api(`/heartbeat-runs/${run.id}/log?offset=0&limitBytes=262144`);
      } catch (error) {
        if (!/ returned 404:/.test(error instanceof Error ? error.message : String(error))) throw error;
        this.state.processedQuotaRunIds.push(run.id);
        this.state.processedQuotaRunIds = this.state.processedQuotaRunIds.slice(-200);
        await this.log("provider_failure_log_missing", {
          companyId,
          agentId: agent.id,
          runId: run.id,
        });
        continue;
      }
      if (isQuotaFailure({ ...run, log: logResult?.content })) return run;
    }
    return null;
  }

  ensureAgentState(company, agent) {
    const currentProvider = ADAPTER_TO_PROVIDER[agent.adapterType];
    const configuredPrimary = this.config.primaryProviderByAgent?.[agent.id]
      ?? this.config.defaultPrimaryProvider;
    const initialPrimary = Object.hasOwn(PROVIDERS, configuredPrimary)
      ? configuredPrimary
      : currentProvider ?? "openai";
    const entry = (this.state.agents[agent.id] ??= {
      companyId: company.id,
      companyName: company.name,
      primaryProvider: initialPrimary,
      configs: {},
      lastSwitchAt: null,
      lastSwitchReason: null,
    });
    entry.companyId = company.id;
    entry.companyName = company.name;
    if (Object.hasOwn(PROVIDERS, configuredPrimary)) entry.primaryProvider = configuredPrimary;
    if (currentProvider && !entry.configs[currentProvider]) {
      entry.configs[currentProvider] = agent.adapterConfig ?? {};
    }
    return entry;
  }

  async enforceSingleConcurrency(agent) {
    if (agent.runtimeConfig?.heartbeat?.maxConcurrentRuns === 1) return agent;
    const updated = await this.api(`/agents/${agent.id}`, {
      method: "PATCH",
      body: JSON.stringify({ runtimeConfig: mergeSingleConcurrency(agent.runtimeConfig) }),
    });
    await this.log("concurrency_guard_applied", {
      companyId: agent.companyId,
      agentId: agent.id,
      agentName: agent.name,
    });
    return updated;
  }

  async switchAgent(company, agent, targetProvider, reason) {
    const state = this.ensureAgentState(company, agent);
    const currentProvider = ADAPTER_TO_PROVIDER[agent.adapterType];
    if (currentProvider) state.configs[currentProvider] = agent.adapterConfig ?? {};

    const updated = await this.api(`/agents/${agent.id}`, {
      method: "PATCH",
      body: JSON.stringify({
        adapterType: PROVIDERS[targetProvider].adapterType,
        adapterConfig: targetConfig(targetProvider, state.configs[targetProvider]),
        replaceAdapterConfig: true,
        runtimeConfig: mergeSingleConcurrency(agent.runtimeConfig),
      }),
    });
    state.configs[targetProvider] = updated.adapterConfig ?? targetConfig(targetProvider);
    state.lastSwitchAt = nowIso();
    state.lastSwitchReason = reason;
    await this.saveState();
    await this.log("agent_provider_switched", {
      agentId: agent.id,
      agentName: agent.name,
      companyId: company.id,
      companyName: company.name,
      from: currentProvider,
      to: targetProvider,
      reason,
    });
    return updated;
  }

  async recoverQuotaFailure(agent, run, issue) {
    if (agent.status === "error" || agent.status === "paused") {
      agent = await this.api(`/agents/${agent.id}/resume`, { method: "POST", body: "{}" });
      await this.log("agent_resumed_after_quota_failure", {
        companyId: agent.companyId,
        agentId: agent.id,
        runId: run.id,
      });
    }

    if (!issue) {
      this.state.processedQuotaRunIds.push(run.id);
      await this.log("quota_failure_has_no_issue", {
        companyId: agent.companyId,
        agentId: agent.id,
        runId: run.id,
      });
      return;
    }

    const recovery = await this.api(`/issues/${issue.id}/recovery-actions`);
    if (recovery?.active) {
      await this.api(`/issues/${issue.id}/recovery-actions/resolve`, {
        method: "POST",
        body: JSON.stringify({
          actionId: recovery.active.id,
          outcome: "restored",
          sourceIssueStatus: "todo",
          resolutionNote: `Quota-aware router moved ${agent.name} to ${agent.adapterType} and restored the task.`,
        }),
      });
      await this.log("quota_issue_restored", {
        companyId: agent.companyId,
        agentId: agent.id,
        issueId: issue.id,
        identifier: issue.identifier,
        recoveryActionId: recovery.active.id,
      });
    } else {
      if (issue.status === "blocked") {
        await this.api(`/issues/${issue.id}`, {
          method: "PATCH",
          body: JSON.stringify({ status: "todo" }),
        });
      }
      await this.api(`/agents/${agent.id}/wakeup`, {
        method: "POST",
        body: JSON.stringify({
          source: "automation",
          triggerDetail: "system",
          reason: "quota_aware_provider_fallback",
          payload: { issueId: issue.id, taskId: issue.id },
          idempotencyKey: `quota-router:${run.id}`,
        }),
      });
      await this.log("quota_issue_retried", {
        companyId: agent.companyId,
        agentId: agent.id,
        issueId: issue.id,
        identifier: issue.identifier,
      });
    }

    this.state.processedQuotaRunIds.push(run.id);
    this.state.processedQuotaRunIds = this.state.processedQuotaRunIds.slice(-200);
    await this.saveState();
  }

  async tickCompany(company) {
    const companyId = company.id;
    const [agentsResult, issuesResult, quotaResult, liveRunsResult] = await Promise.all([
      this.api(`/companies/${companyId}/agents`),
      this.api(`/companies/${companyId}/issues?limit=500`),
      this.api(`/companies/${companyId}/costs/quota-windows`),
      this.api(`/companies/${companyId}/live-runs?limit=200`),
    ]);
    this.state.companies ??= {};
    const companyState = (this.state.companies[companyId] ??= {});
    const stableQuota = stabilizeQuotaState(
      quotaResult,
      companyState.quotaLastGood,
      this.config.reservePercent ?? 15,
      Date.now(),
      this.config.quotaStaleMs ?? 15 * 60_000,
    );
    companyState.quotaLastGood = stableQuota.cache;
    const quota = stableQuota.quota;
    const agents = routableAgents(agentsResult);
    const issues = Array.isArray(issuesResult) ? issuesResult : [];
    const activeAgentIds = new Set(
      (Array.isArray(liveRunsResult) ? liveRunsResult : [])
        .filter((run) => run.status === "queued" || run.status === "running")
        .map((run) => run.agentId),
    );

    const quotaSnapshot = Object.fromEntries(Object.entries(quota).map(([provider, state]) => [provider, {
        hardBlocked: state.hardBlocked,
        reserveBlocked: state.reserveBlocked,
        maxUsedPercent: state.maxUsedPercent,
        limitingWindows: state.limitingWindows,
      }]));
    const quotaFingerprint = JSON.stringify(Object.fromEntries(
      Object.entries(quotaSnapshot).map(([provider, state]) => [provider, {
        hardBlocked: state.hardBlocked,
        reserveBlocked: state.reserveBlocked,
        maxUsedPercent: state.maxUsedPercent,
        limitingWindows: state.limitingWindows.map((window) => [window.label, window.usedPercent]),
      }]),
    ));
    const degradedFingerprint = JSON.stringify(stableQuota.degradedProviders);
    if (companyState.lastDegradedFingerprint !== degradedFingerprint) {
      companyState.lastDegradedFingerprint = degradedFingerprint;
      await this.log(
        stableQuota.degradedProviders.length ? "quota_poll_degraded" : "quota_poll_recovered",
        {
          companyId,
          companyName: company.name,
          providers: stableQuota.degradedProviders,
        },
      );
    }
    if (companyState.lastQuotaFingerprint !== quotaFingerprint) {
      companyState.lastQuotaFingerprint = quotaFingerprint;
      await this.log("quota_snapshot", {
        companyId,
        companyName: company.name,
        quota: quotaSnapshot,
      });
    }

    for (let agent of agents) {
      const state = this.ensureAgentState(company, agent);
      if (activeAgentIds.has(agent.id) || agent.status === "running") continue;
      agent = await this.enforceSingleConcurrency(agent);

      const quotaRun = await this.quotaFailureForAgent(companyId, agent);
      const quotaIssueId = quotaRun?.contextSnapshot?.issueId ?? quotaRun?.contextSnapshot?.taskId ?? null;
      const assigned = sortIssues(issues.filter((issue) => issue.assigneeAgentId === agent.id));
      const quotaIssue = quotaIssueId ? issues.find((issue) => issue.id === quotaIssueId) ?? null : null;
      const actionable = assigned.find((issue) => ACTIONABLE_STATUSES.has(issue.status)) ?? quotaIssue;
      const urgent = Boolean(quotaRun) || ["critical", "high"].includes(actionable?.priority);
      const preferred = preferredProvider(agent, actionable, state.primaryProvider);
      const failedProvider = quotaRun ? ADAPTER_TO_PROVIDER[agent.adapterType] : null;
      const routingQuota = failedProvider
        ? withObservedProviderFailure(quota, failedProvider)
        : quota;
      const currentProvider = ADAPTER_TO_PROVIDER[agent.adapterType];
      const target = chooseProviderWithTelemetry({
        preferred,
        current: currentProvider,
        quota: routingQuota,
        urgent,
        quotaFailure: Boolean(quotaRun),
        unknownProviders: stableQuota.unknownProviders,
      });

      if (!target) {
        const waitingDetails = {
          agentId: agent.id,
          agentName: agent.name,
          preferred,
          issueId: actionable?.id ?? null,
          earliestResetAt: Object.values(routingQuota)
            .map((entry) => entry.resetsAt)
            .filter(Boolean)
            .sort()[0] ?? null,
        };
        const decisionKey = JSON.stringify({
          event: "agent_waiting_for_quota",
          preferred,
          issueId: waitingDetails.issueId,
          quotaFingerprint,
        });
        if (state.lastDecisionKey !== decisionKey) {
          state.lastDecisionKey = decisionKey;
          await this.log("agent_waiting_for_quota", {
            companyId,
            companyName: company.name,
            ...waitingDetails,
          });
        }
        continue;
      }

      state.lastDecisionKey = null;

      if (currentProvider !== target) {
        const lastSwitch = Date.parse(state.lastSwitchAt ?? "");
        const cooldownMs = this.config.switchCooldownMs ?? 60_000;
        if (Number.isFinite(lastSwitch) && Date.now() - lastSwitch < cooldownMs && !quotaRun) continue;
        agent = await this.switchAgent(
          company,
          agent,
          target,
          quotaRun
            ? `quota failure in run ${quotaRun.id}; ${currentProvider} constrained`
            : target === preferred
              ? `${preferred} capacity available; restored preferred provider`
              : `${preferred} unavailable above reserve threshold`,
        );
      }

      if (quotaRun) await this.recoverQuotaFailure(agent, quotaRun, quotaIssue);
    }
    await this.saveState();
  }

  async tick() {
    const companiesResult = await this.api("/companies");
    const configuredCompanyIds = new Set(this.config.companyIds ?? []);
    const companies = (Array.isArray(companiesResult) ? companiesResult : []).filter((company) => {
      if (company.archivedAt || company.status === "archived") return false;
      return configuredCompanyIds.size === 0 || configuredCompanyIds.has(company.id);
    });
    for (const company of companies) {
      try {
        await this.tickCompany(company);
      } catch (error) {
        await this.log("company_tick_failed", {
          companyId: company.id,
          companyName: company.name,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
}

export async function loadConfig(configPath) {
  const parsed = JSON.parse(await readFile(resolve(configPath), "utf8"));
  const baseDir = dirname(resolve(configPath));
  parsed.statePath = resolve(baseDir, parsed.statePath ?? "quota-router-state.json");
  parsed.logPath = resolve(baseDir, parsed.logPath ?? "logs/quota-router.log");
  return parsed;
}

async function main() {
  const configPath = process.env.PAPERCLIP_QUOTA_ROUTER_CONFIG
    ?? process.argv[2]
    ?? `${process.env.HOME}/.paperclip/instances/default/quota-router.json`;
  const config = await loadConfig(configPath);
  const router = new QuotaAwareAgentRouter(config);
  await router.loadState();
  await router.tick();
  const intervalMs = Math.max(10_000, config.pollIntervalMs ?? 30_000);
  const scheduleNext = () => setTimeout(async () => {
    try {
      await router.tick();
    } catch (error) {
      await router.log("router_tick_failed", { error: error instanceof Error ? error.message : String(error) });
    }
    scheduleNext();
  }, intervalMs);
  scheduleNext();
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
