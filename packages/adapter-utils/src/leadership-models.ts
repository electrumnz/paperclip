/**
 * Model lanes keyed off where an agent sits in the company org chart.
 *
 * Only the senior leadership team — the top two layers of the chart — runs on a
 * frontier model. Everyone below, plus Paperclip's own built-in utility agents,
 * runs on one of two low-cost OpenRouter routers:
 *
 * - The Free Models Router (`openrouter/free`) picks a free model that supports
 *   the features a request needs. It costs nothing and carries lower rate
 *   limits, so it suits read-and-report work where a retry is cheap.
 * - DeepSeek Flash latest (`~deepseek/deepseek-flash-latest`) always resolves to
 *   the newest DeepSeek Flash release. It is paid but cheap, and it keeps tool
 *   calling and reasoning, so it suits agents that actually do the work.
 *
 * The Pareto Router is offered alongside them as a choice, but it is never a
 * default. See {@link OPENROUTER_PARETO_CODE_MODEL}.
 */

/** Deepest org-chart layer that stays on a frontier model. The root is layer 1. */
export const LEADERSHIP_ORG_DEPTH = 2;

/** OpenRouter's Free Models Router, in OpenRouter's own model-id form. */
export const OPENROUTER_FREE_ROUTER_MODEL = "openrouter/free";

/** OpenRouter's latest-resolution alias for DeepSeek Flash. */
export const DEEPSEEK_FLASH_LATEST_MODEL = "~deepseek/deepseek-flash-latest";

/**
 * OpenRouter's Pareto Router, which picks the cheapest coding model above a
 * `min_coding_score` bar. That bar travels in the request body as a
 * `pareto-router` plugin, and Paperclip sends only a model string, so a bare
 * request lands on the router's default high tier — the strongest coders, not
 * the cheapest. It is therefore offered as a choice and never used as a
 * default: picking it means accepting the high tier, or setting a lower one
 * under OpenRouter Settings > Plugins.
 */
export const OPENROUTER_PARETO_CODE_MODEL = "openrouter/pareto-code";

/**
 * The routers in the `provider/model` form OpenCode and the Paperclip runner
 * expect, where the leading segment names the OpenRouter provider.
 */
export const OPENCODE_FREE_ROUTER_MODEL = `openrouter/${OPENROUTER_FREE_ROUTER_MODEL}` as const;
export const OPENCODE_DEEPSEEK_FLASH_LATEST_MODEL =
  `openrouter/${DEEPSEEK_FLASH_LATEST_MODEL}` as const;
export const OPENCODE_PARETO_CODE_MODEL =
  `openrouter/${OPENROUTER_PARETO_CODE_MODEL}` as const;

/** Adapter the non-leadership lane runs on, since only OpenCode routes to OpenRouter. */
export const NON_LEADERSHIP_ADAPTER_TYPE = "opencode_local";

/**
 * True for an org-chart depth that keeps its frontier model. Depth is 1-based
 * from the company root, so the root and its direct reports are leadership.
 */
export function isLeadershipOrgDepth(depth: number): boolean {
  return Number.isInteger(depth) && depth >= 1 && depth <= LEADERSHIP_ORG_DEPTH;
}
