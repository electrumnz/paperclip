#!/usr/bin/env node

import { execFile } from "node:child_process";
import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";

const execFileAsync = promisify(execFile);
const scriptDir = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDir, "..");

export const PROVIDERS = {
  // The first Claude lane is the dedicated Paperclip subscription. The second
  // is an independently authenticated safety net using the same adapter.
  anthropic: { adapterType: "claude_local", family: "anthropic" },
  anthropic_personal: { adapterType: "claude_local", family: "anthropic" },
  openai: { adapterType: "codex_local" },
  // Retained only to recognize and migrate agents that were previously parked
  // on Grok. It is deliberately absent from every selectable fallback order.
  xai: { adapterType: "grok_local", quotaTelemetry: false },
};

const PROVIDER_FALLBACK_ORDER = {
  anthropic: ["anthropic", "anthropic_personal"],
  anthropic_personal: ["anthropic_personal", "anthropic"],
  // Retained only so agents parked on retired Codex or Grok lanes are migrated
  // back into the active dual-Claude chain. Neither is selectable afterward.
  openai: ["anthropic", "anthropic_personal"],
  xai: ["anthropic", "anthropic_personal"],
};

const ADAPTER_TO_PROVIDER = Object.fromEntries(
  Object.entries(PROVIDERS)
    .filter(([, value]) => value.family !== "anthropic")
    .map(([provider, value]) => [value.adapterType, provider]),
);
const ROUTABLE_ADAPTERS = new Set(Object.values(PROVIDERS).map((value) => value.adapterType));

const DEFAULT_CODEX_CONFIG = {
  graceSec: 15,
  timeoutSec: 0,
  dangerouslyBypassApprovalsAndSandbox: true,
};

const DEFAULT_GROK_CONFIG = {
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
  /(?:authentication[_ -]?error|invalid authentication|\b401\b|unauthorized|authentication required|not authenticated)/i,
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
  reservePercentByProvider = {},
) {
  const incoming = new Map(
    (Array.isArray(entries) ? entries : []).map((entry) => [entry?.provider, entry]),
  );
  const cache = { ...previous };
  const quota = {};
  const degradedProviders = [];
  const unknownProviders = [];

  for (const provider of Object.keys(PROVIDERS)) {
    const providerReserve = Number.isFinite(reservePercentByProvider?.[provider])
      ? Number(reservePercentByProvider[provider])
      : reservePercent;
    if (PROVIDERS[provider].quotaTelemetry === false) {
      quota[provider] = summarizeQuota({ provider, ok: true, windows: [] }, providerReserve);
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
      quota[provider] = summarizeQuota(cleanEntry, providerReserve);
      continue;
    }

    degradedProviders.push(provider);
    const cached = cache[provider];
    const cachedAt = Date.parse(cached?.updatedAt ?? "");
    const fresh = Number.isFinite(cachedAt) && now - cachedAt <= staleMs;
    if (!fresh) unknownProviders.push(provider);
    quota[provider] = fresh
      ? summarizeQuota(cached.entry, providerReserve)
      : summarizeQuota({ provider, ok: true, windows: [] }, providerReserve);
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
  if (agent?.adapterType === "claude_local") return "anthropic";
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
    (agent) => ROUTABLE_ADAPTERS.has(agent?.adapterType),
  );
}

export function providerForAgent(agent, claudeProfiles = {}) {
  if (agent?.adapterType !== "claude_local") {
    return ADAPTER_TO_PROVIDER[agent?.adapterType] ?? null;
  }
  const configDirValue = agent?.adapterConfig?.env?.CLAUDE_CONFIG_DIR;
  const configDir = typeof configDirValue === "string"
    ? configDirValue
    : configDirValue?.type === "plain" && typeof configDirValue.value === "string"
      ? configDirValue.value
      : null;
  if (typeof configDir === "string" && configDir.trim()) {
    const match = Object.entries(claudeProfiles).find(
      ([, profile]) => resolve(String(profile?.configDir ?? "")) === resolve(configDir.trim()),
    );
    if (match) return match[0];
  }
  // Legacy Claude agents without an explicit profile used the existing
  // ~/.claude login, which is now the personal fallback lane.
  return Object.hasOwn(claudeProfiles, "anthropic_personal")
    ? "anthropic_personal"
    : "anthropic";
}

export function optimizedClaudeConfig(agent, overrides = {}, policy = {}) {
  const override = overrides?.[agent?.id];
  if (typeof override === "string" && override.trim()) {
    return { model: override.trim(), effort: "high" };
  }
  if (override && typeof override === "object" && typeof override.model === "string") {
    return {
      model: override.model.trim(),
      effort: typeof override.effort === "string" ? override.effort : "high",
    };
  }
  const text = `${agent?.name ?? ""} ${agent?.role ?? ""} ${agent?.title ?? ""}`;
  if (/\b(?:chair|chief|managing director|director of people)\b/i.test(text)) {
    return {
      model: policy.executiveModel ?? "claude-opus-5",
      effort: policy.executiveEffort ?? "high",
    };
  }
  return {
    model: policy.defaultModel ?? "claude-sonnet-5",
    effort: policy.defaultEffort ?? "medium",
  };
}

export function needsProviderConfigRefresh(
  agent,
  provider,
  claudeProfiles = {},
  desiredConfig = {},
) {
  const profile = claudeProfiles?.[provider];
  if (PROVIDERS[provider]?.family !== "anthropic" || !profile) return false;
  return ["model", "effort"].some((key) => (
    typeof desiredConfig?.[key] === "string"
    && desiredConfig[key].trim()
    && agent?.adapterConfig?.[key] !== desiredConfig[key].trim()
  ));
}

function sortIssues(issues) {
  return [...issues].sort((left, right) => {
    const priority = (PRIORITY_ORDER[left.priority] ?? 99) - (PRIORITY_ORDER[right.priority] ?? 99);
    if (priority !== 0) return priority;
    return Date.parse(right.updatedAt ?? 0) - Date.parse(left.updatedAt ?? 0);
  });
}

export function mergeRuntimePolicy(runtimeConfig, cheapProfile = {}) {
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
    : {};
  const cheap = profiles.cheap && typeof profiles.cheap === "object" ? profiles.cheap : {};
  profiles.cheap = {
    ...cheap,
    enabled: cheapProfile.enabled !== false,
    adapterConfig: {
      ...(cheap.adapterConfig && typeof cheap.adapterConfig === "object" ? cheap.adapterConfig : {}),
      model: cheapProfile.model ?? "claude-haiku-4-5",
      effort: cheapProfile.effort ?? "low",
    },
  };
  return {
    ...runtime,
    heartbeat: { ...heartbeat, maxConcurrentRuns: 1 },
    modelProfiles: profiles,
  };
}

export function needsRuntimePolicyRefresh(runtimeConfig, cheapProfile = {}) {
  const cheap = runtimeConfig?.modelProfiles?.cheap;
  return runtimeConfig?.heartbeat?.maxConcurrentRuns !== 1
    || cheap?.enabled !== (cheapProfile.enabled !== false)
    || cheap?.adapterConfig?.model !== (cheapProfile.model ?? "claude-haiku-4-5")
    || cheap?.adapterConfig?.effort !== (cheapProfile.effort ?? "low");
}

export function targetConfig(provider, savedConfig, claudeProfiles = {}, desiredConfig = {}) {
  let target;
  if (savedConfig && typeof savedConfig === "object") {
    if (provider === "xai" && savedConfig.model === "grok-4.6") {
      const { model: _legacyPinnedModel, ...usingGrokBuildDefault } = savedConfig;
      target = usingGrokBuildDefault;
    } else {
      target = savedConfig;
    }
  } else if (provider === "openai") target = DEFAULT_CODEX_CONFIG;
  else if (provider === "xai") target = DEFAULT_GROK_CONFIG;
  else target = { dangerouslySkipPermissions: true };

  const profile = claudeProfiles?.[provider];
  if (PROVIDERS[provider]?.family === "anthropic" && profile?.configDir) {
    return {
      ...target,
      ...(typeof desiredConfig.model === "string" && desiredConfig.model.trim()
        ? { model: desiredConfig.model.trim() }
        : {}),
      ...(typeof desiredConfig.effort === "string" && desiredConfig.effort.trim()
        ? { effort: desiredConfig.effort.trim() }
        : {}),
      env: {
        ...(target?.env && typeof target.env === "object" ? target.env : {}),
        CLAUDE_CONFIG_DIR: resolve(String(profile.configDir)),
      },
    };
  }
  return target;
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
    this.execFile = config.execFile ?? execFileAsync;
    this.claudeQuotaCache = null;
  }

  currentProvider(agent) {
    return providerForAgent(agent, this.config.claudeProfiles);
  }

  desiredClaudeConfig(agent) {
    return optimizedClaudeConfig(
      agent,
      this.config.claudeModelOverrides,
      this.config.claudeRolePolicy,
    );
  }

  async probeClaudeProfile(provider, profile) {
    const tsxCommand = resolve(
      this.config.claudeQuotaProbeCommand
        ?? `${repositoryRoot}/node_modules/.pnpm/node_modules/.bin/tsx`,
    );
    const probeScript = resolve(
      this.config.claudeQuotaProbeScript
        ?? `${repositoryRoot}/packages/adapters/claude-local/src/cli/quota-probe.ts`,
    );
    try {
      const { stdout } = await this.execFile(
        tsxCommand,
        [probeScript, "--json", "--oauth-only"],
        {
          cwd: repositoryRoot,
          env: {
            ...process.env,
            CLAUDE_CONFIG_DIR: resolve(String(profile.configDir)),
          },
          timeout: this.config.claudeQuotaProbeTimeoutMs ?? 20_000,
          maxBuffer: 2 * 1024 * 1024,
        },
      );
      const result = JSON.parse(stdout);
      const oauth = result?.oauth;
      return {
        provider,
        ok: oauth?.ok === true,
        windows: Array.isArray(oauth?.windows) ? oauth.windows : [],
        ...(oauth?.ok === true ? {} : { error: oauth?.error ?? "Claude quota probe failed" }),
      };
    } catch (error) {
      return {
        provider,
        ok: false,
        windows: [],
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async claudeQuotaEntries() {
    const profiles = Object.entries(this.config.claudeProfiles ?? {})
      .filter(([provider, profile]) => (
        PROVIDERS[provider]?.family === "anthropic"
        && profile?.configDir
        && profile?.quotaSource !== "paperclip"
      ));
    if (!profiles.length) return [];

    const now = Date.now();
    const cacheMs = this.config.claudeQuotaPollMs ?? 60_000;
    if (this.claudeQuotaCache && now - this.claudeQuotaCache.updatedAt < cacheMs) {
      return this.claudeQuotaCache.entries;
    }
    const entries = await Promise.all(
      profiles.map(([provider, profile]) => this.probeClaudeProfile(provider, profile)),
    );
    this.claudeQuotaCache = { updatedAt: now, entries };
    return entries;
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
    const currentProvider = this.currentProvider(agent);
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
    if (entry.configs.xai?.model === "grok-4.6") {
      entry.configs.xai = targetConfig("xai", entry.configs.xai);
    }
    if (currentProvider && !entry.configs[currentProvider]) {
      entry.configs[currentProvider] = agent.adapterConfig ?? {};
    }
    return entry;
  }

  async enforceRuntimePolicy(agent) {
    if (!needsRuntimePolicyRefresh(agent.runtimeConfig, this.config.cheapProfile)) return agent;
    const updated = await this.api(`/agents/${agent.id}`, {
      method: "PATCH",
      body: JSON.stringify({
        runtimeConfig: mergeRuntimePolicy(agent.runtimeConfig, this.config.cheapProfile),
      }),
    });
    await this.log("runtime_policy_applied", {
      companyId: agent.companyId,
      agentId: agent.id,
      agentName: agent.name,
    });
    return updated;
  }

  async switchAgent(company, agent, targetProvider, reason) {
    const state = this.ensureAgentState(company, agent);
    const currentProvider = this.currentProvider(agent);
    if (currentProvider) state.configs[currentProvider] = agent.adapterConfig ?? {};

    const desiredConfig = PROVIDERS[targetProvider]?.family === "anthropic"
      ? this.desiredClaudeConfig(agent)
      : {};
    const updated = await this.api(`/agents/${agent.id}`, {
      method: "PATCH",
      body: JSON.stringify({
        adapterType: PROVIDERS[targetProvider].adapterType,
        adapterConfig: targetConfig(
          targetProvider,
          state.configs[targetProvider],
          this.config.claudeProfiles,
          desiredConfig,
        ),
        replaceAdapterConfig: true,
        runtimeConfig: mergeRuntimePolicy(agent.runtimeConfig, this.config.cheapProfile),
      }),
    });
    state.configs[targetProvider] = updated.adapterConfig ?? targetConfig(
      targetProvider,
      undefined,
      this.config.claudeProfiles,
      desiredConfig,
    );
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
    const claudeQuota = await this.claudeQuotaEntries();
    const endpointQuota = Array.isArray(quotaResult)
      ? quotaResult.map((entry) => (
        entry?.provider === "anthropic"
          ? { ...entry, provider: "anthropic_personal" }
          : entry
      ))
      : [];
    const stableQuota = stabilizeQuotaState(
      claudeQuota.length ? [...endpointQuota, ...claudeQuota] : quotaResult,
      companyState.quotaLastGood,
      this.config.reservePercent ?? 15,
      Date.now(),
      this.config.quotaStaleMs ?? 15 * 60_000,
      this.config.reservePercentByProvider,
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
      agent = await this.enforceRuntimePolicy(agent);

      const quotaRun = await this.quotaFailureForAgent(companyId, agent);
      const quotaIssueId = quotaRun?.contextSnapshot?.issueId ?? quotaRun?.contextSnapshot?.taskId ?? null;
      const assigned = sortIssues(issues.filter((issue) => issue.assigneeAgentId === agent.id));
      const quotaIssue = quotaIssueId ? issues.find((issue) => issue.id === quotaIssueId) ?? null : null;
      const actionable = assigned.find((issue) => ACTIONABLE_STATUSES.has(issue.status)) ?? quotaIssue;
      const urgent = Boolean(quotaRun) || ["critical", "high"].includes(actionable?.priority);
      const preferred = preferredProvider(agent, actionable, state.primaryProvider);
      const failedProvider = quotaRun ? this.currentProvider(agent) : null;
      const routingQuota = failedProvider
        ? withObservedProviderFailure(quota, failedProvider)
        : quota;
      const currentProvider = this.currentProvider(agent);
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

      const desiredConfig = PROVIDERS[target]?.family === "anthropic"
        ? this.desiredClaudeConfig(agent)
        : {};
      const configRefresh = currentProvider === target
        && needsProviderConfigRefresh(
          agent,
          target,
          this.config.claudeProfiles,
          desiredConfig,
        );
      if (currentProvider !== target || configRefresh) {
        const lastSwitch = Date.parse(state.lastSwitchAt ?? "");
        const cooldownMs = this.config.switchCooldownMs ?? 60_000;
        if (Number.isFinite(lastSwitch) && Date.now() - lastSwitch < cooldownMs && !quotaRun) continue;
        agent = await this.switchAgent(
          company,
          agent,
          target,
          quotaRun
            ? `quota failure in run ${quotaRun.id}; ${currentProvider} constrained`
            : configRefresh
              ? `${target} account configuration refreshed`
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
