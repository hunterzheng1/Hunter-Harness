import { describe, expect, it } from "vitest";

import { LEGACY_PLAN_PHASE_ALIASES } from "../src/plan-phase-aliases.js";

describe("LEGACY_PLAN_PHASE_ALIASES", () => {
  it("mirrors harness_paths.LEGACY_PHASE_ALIASES exactly", () => {
    // 与 harness/scripts/harness_paths.py 互为镜像；漂移会在两侧单测同时炸响。
    expect(LEGACY_PLAN_PHASE_ALIASES).toEqual({
      run: "execute",
      test: "execute"
    });
  });
});
