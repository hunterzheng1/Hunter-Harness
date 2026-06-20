import { describe, expect, it } from "vitest";

import {
  extractManagedBlock,
  upsertManagedBlock
} from "../src/managed/managed-block.js";

describe("managed blocks", () => {
  const block = "Read @AGENTS.md\n- Rules: .claude/rules/";

  it("adds a managed block without changing user content", () => {
    const result = upsertManagedBlock("# User instructions\nKeep this.", block);
    expect(result).toContain("# User instructions\nKeep this.");
    expect(extractManagedBlock(result)).toBe(block);
  });

  it("updates only the existing managed block", () => {
    const first = upsertManagedBlock("before\n\nafter", block);
    const second = upsertManagedBlock(first, "new content");
    expect(second).toContain("before\n\nafter");
    expect(extractManagedBlock(second)).toBe("new content");
  });

  it("is idempotent", () => {
    const first = upsertManagedBlock("", block);
    expect(upsertManagedBlock(first, block)).toBe(first);
  });

  it("rejects malformed or duplicate markers", () => {
    expect(() => upsertManagedBlock("<!-- hunter-harness:start -->", block)).toThrow();
    expect(() => upsertManagedBlock(
      "<!-- hunter-harness:start -->\na\n<!-- hunter-harness:end -->\n" +
      "<!-- hunter-harness:start -->\nb\n<!-- hunter-harness:end -->",
      block
    )).toThrow();
  });
});
