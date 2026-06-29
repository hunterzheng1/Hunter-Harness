import { describe, expect, it } from "vitest";

import { bootstrapSkills } from "../lib/catalog";

describe("catalog adapters (T17)", () => {
  it("allAdapters includes cursor as a production adapter", () => {
    const adapters = bootstrapSkills[0]?.adapters;
    expect(adapters).toBeDefined();
    expect(adapters).toContain("cursor");
    expect(adapters).toEqual(["claude-code", "codex", "cursor", "generic", "mcp"]);
  });
});
