import { describe, expect, it } from "vitest";

import {
  extractManagedBlock,
  upsertManagedBlock,
  upsertManagedBlockById
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

describe("per-id managed blocks (T8)", () => {
  it("upsertManagedBlockById is defined", () => {
    expect(typeof upsertManagedBlockById).toBe("function");
  });

  it("inserts a per-id block into empty file", () => {
    const out = upsertManagedBlockById("", "harness-skill-x", "body");
    expect(out).toContain("<!-- hunter-harness:start id=harness-skill-x -->");
    expect(out).toContain("<!-- hunter-harness:end id=harness-skill-x -->");
    expect(out).toContain("body");
  });

  it("replaces existing per-id block keeping outside content", () => {
    const existing = "p\n<!-- hunter-harness:start id=harness-skill-x -->\nold\n<!-- hunter-harness:end id=harness-skill-x -->\ns";
    const out = upsertManagedBlockById(existing, "harness-skill-x", "new");
    expect(out).toContain("new");
    expect(out).not.toContain("old");
    expect(out).toContain("p\n");
    expect(out).toContain("\ns");
  });

  it("appends a new per-id block preserving original content", () => {
    const out = upsertManagedBlockById("base content", "harness-skill-y", "Y");
    expect(out).toContain("base content");
    expect(out).toContain("<!-- hunter-harness:start id=harness-skill-y -->");
  });

  it("is idempotent", () => {
    const a = upsertManagedBlockById("base", "id1", "c");
    expect(upsertManagedBlockById(a, "id1", "c")).toBe(a);
  });

  it("handles file without trailing newline", () => {
    const out = upsertManagedBlockById("no-newline", "id2", "c");
    expect(out).toContain("no-newline");
    expect(out).toContain("<!-- hunter-harness:start id=id2 -->");
  });

  it("RED-1 regression: existing upsertManagedBlock unaffected (no id marker)", () => {
    const existing = "<!-- hunter-harness:start -->\nH\n<!-- hunter-harness:end -->";
    const out = upsertManagedBlock(existing, "NEW");
    expect(out).toContain("NEW");
    expect(out).not.toContain("id=");
  });

  it("RED-1: two marker sets coexist in same AGENTS.md", () => {
    const base = "<!-- hunter-harness:start -->\nH\n<!-- hunter-harness:end -->";
    const out = upsertManagedBlockById(base, "harness-skill-x", "X");
    expect(out).toContain("<!-- hunter-harness:start -->");
    expect(out).toContain("<!-- hunter-harness:end -->");
    expect(out).toContain("<!-- hunter-harness:start id=harness-skill-x -->");
    expect(out).toContain("<!-- hunter-harness:end id=harness-skill-x -->");
  });
});
