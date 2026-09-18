import { describe, expect, it } from "vitest";
import {
  DEEPSEEK_FLASH_LATEST_MODEL,
  LEADERSHIP_ORG_DEPTH,
  OPENCODE_DEEPSEEK_FLASH_LATEST_MODEL,
  OPENCODE_FREE_ROUTER_MODEL,
  OPENCODE_PARETO_CODE_MODEL,
  OPENROUTER_FREE_ROUTER_MODEL,
  OPENROUTER_PARETO_CODE_MODEL,
  isLeadershipOrgDepth,
} from "./leadership-models.js";

describe("leadership model lanes", () => {
  it("keeps the top two org-chart layers on the frontier lane", () => {
    expect(LEADERSHIP_ORG_DEPTH).toBe(2);
    expect(isLeadershipOrgDepth(1)).toBe(true);
    expect(isLeadershipOrgDepth(2)).toBe(true);
    expect(isLeadershipOrgDepth(3)).toBe(false);
  });

  it("rejects depths that are not a real org-chart layer", () => {
    expect(isLeadershipOrgDepth(0)).toBe(false);
    expect(isLeadershipOrgDepth(-1)).toBe(false);
    expect(isLeadershipOrgDepth(1.5)).toBe(false);
    expect(isLeadershipOrgDepth(Number.NaN)).toBe(false);
  });

  it("prefixes the OpenRouter model ids with the provider OpenCode expects", () => {
    expect(OPENROUTER_FREE_ROUTER_MODEL).toBe("openrouter/free");
    expect(DEEPSEEK_FLASH_LATEST_MODEL).toBe("~deepseek/deepseek-flash-latest");
    expect(OPENCODE_FREE_ROUTER_MODEL).toBe("openrouter/openrouter/free");
    expect(OPENCODE_DEEPSEEK_FLASH_LATEST_MODEL).toBe("openrouter/~deepseek/deepseek-flash-latest");
    expect(OPENROUTER_PARETO_CODE_MODEL).toBe("openrouter/pareto-code");
    expect(OPENCODE_PARETO_CODE_MODEL).toBe("openrouter/openrouter/pareto-code");
  });
});
