import { describe, expect, it } from "vitest";

import { buildContextIndex } from "../src/index.js";

describe("Context index", () => {
  it("routes knowledge exclusively to the remote CLI", () => {
    const context = buildContextIndex({
      rules: [".claude/rules/harness-general.md"],
      enabledSkills: ["harness-review", "harness-sync"],
      mapStatus: "fresh",
      codegraphAvailable: false
    });

    expect(context).toMatchObject({
      schema_version: 1,
      knowledge: {
        source: "remote",
        local_index: null,
        query: "npx hunter-harness knowledge query",
        fallback: false
      },
      codebase: { map: ".harness/codebase/map", status: "fresh" },
      integrations: { codegraph: { available: false, managed: false } }
    });
    expect(context.skills).toEqual(["harness-review", "harness-sync"]);
  });
});
