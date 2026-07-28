import { describe, expect, it } from "vitest";

import {
  extractManagedBlock,
  ManagedBlockStructureError,
  parseManagedBlocks,
  repairEquivalentLegacyWrapper,
  refreshManagedBlockById,
  removeManagedBlockById,
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
  it("repairs an equivalent legacy wrapper without changing user content", () => {
    const core =
      "<!-- hunter-harness:start id=core -->\ncore\n" +
      "<!-- hunter-harness:end id=core -->";
    const rules =
      "<!-- hunter-harness:start id=rules -->\nrules\n" +
      "<!-- hunter-harness:end id=rules -->";
    const corrupted =
      `user-before\n${core}\n${rules}\n` +
      `<!-- hunter-harness:start -->\n${core}\n${rules}\n` +
      "<!-- hunter-harness:end -->\nuser-after\n";

    const result = repairEquivalentLegacyWrapper(corrupted);

    expect(result.repaired).toBe(true);
    expect(result.conflict).toBe(false);
    expect(result.content).toBe(
      `user-before\n${core}\n${rules}\nuser-after\n`
    );
  });

  it("refuses repair when the legacy wrapper body differs", () => {
    const source =
      "<!-- hunter-harness:start id=core -->\nlocal\n" +
      "<!-- hunter-harness:end id=core -->\n" +
      "<!-- hunter-harness:start -->\n" +
      "<!-- hunter-harness:start id=core -->\nremote\n" +
      "<!-- hunter-harness:end id=core -->\n" +
      "<!-- hunter-harness:end -->\n";

    const result = repairEquivalentLegacyWrapper(source);

    expect(result.repaired).toBe(false);
    expect(result.conflict).toBe(true);
    expect(result.content).toBe(source);
  });

  it("parses multiple sibling blocks without treating the full file as one body", () => {
    const source =
      "user-before\n" +
      "<!-- hunter-harness:start id=hunter-harness-core -->\ncore\n" +
      "<!-- hunter-harness:end id=hunter-harness-core -->\n" +
      "<!-- hunter-harness:start id=hunter-harness-project-rules -->\nrules\n" +
      "<!-- hunter-harness:end id=hunter-harness-project-rules -->\n" +
      "user-after\n";

    const parsed = parseManagedBlocks(source);

    expect(parsed.blocks.map((item) => [item.id, item.content])).toEqual([
      ["hunter-harness-core", "core"],
      ["hunter-harness-project-rules", "rules"]
    ]);
    expect(parsed.outsideContent).toBe("user-before\n\nuser-after\n");
  });

  it.each([
    {
      code: "DUPLICATE_MANAGED_BLOCK",
      source:
        "<!-- hunter-harness:start id=x -->\na\n<!-- hunter-harness:end id=x -->\n" +
        "<!-- hunter-harness:start id=x -->\nb\n<!-- hunter-harness:end id=x -->"
    },
    {
      code: "NESTED_MANAGED_BLOCK",
      source:
        "<!-- hunter-harness:start id=x -->\n" +
        "<!-- hunter-harness:start id=y -->\ny\n<!-- hunter-harness:end id=y -->\n" +
        "<!-- hunter-harness:end id=x -->"
    },
    {
      code: "UNCLOSED_MANAGED_BLOCK",
      source: "<!-- hunter-harness:start id=x -->\nmissing end"
    },
    {
      code: "MISMATCHED_MANAGED_BLOCK",
      source:
        "<!-- hunter-harness:start id=x -->\nbody\n" +
        "<!-- hunter-harness:end id=y -->"
    }
  ])("rejects invalid marker AST with $code", ({ code, source }) => {
    try {
      parseManagedBlocks(source);
      throw new Error("expected parseManagedBlocks to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(ManagedBlockStructureError);
      expect((error as ManagedBlockStructureError).code).toBe(code);
    }
  });

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

describe("refreshManagedBlockById", () => {
  it("upgrades a legacy no-id block in place", () => {
    const original = "user text\n\n<!-- hunter-harness:start -->\nold\n<!-- hunter-harness:end -->\n";
    const result = refreshManagedBlockById(original, "hunter-harness-core", "new", {
      upgradeLegacy: true
    });
    expect(result.conflict).toBe(false);
    expect(result.content).toContain("<!-- hunter-harness:start id=hunter-harness-core -->");
    expect(result.content).not.toMatch(/<!-- hunter-harness:start -->/);
    expect((result.content.match(/hunter-harness:start/g) ?? []).length).toBe(1);
    expect(result.content).toContain("user text");
    expect(result.content).toContain("new");
  });

  it("malformed legacy markers preserve file and report conflict", () => {
    const original =
      "<!-- hunter-harness:start -->\na\n<!-- hunter-harness:end -->\n" +
      "<!-- hunter-harness:start -->\nb\n<!-- hunter-harness:end -->\n";
    const result = refreshManagedBlockById(original, "hunter-harness-core", "new", {
      upgradeLegacy: true
    });
    expect(result.conflict).toBe(true);
    expect(result.content).toBe(original);
    expect(result.action).toBe("preserved_conflict");
  });

  it("replaces an existing id block", () => {
    const original =
      "keep\n<!-- hunter-harness:start id=hunter-harness-core -->\nold\n<!-- hunter-harness:end id=hunter-harness-core -->\n";
    const result = refreshManagedBlockById(original, "hunter-harness-core", "fresh");
    expect(result.conflict).toBe(false);
    expect(result.content).toContain("fresh");
    expect(result.content).not.toContain("old");
    expect(result.content).toContain("keep");
  });

  it("appends when no block exists", () => {
    const result = refreshManagedBlockById("user only\n", "hunter-harness-core", "body");
    expect(result.conflict).toBe(false);
    expect(result.action).toBe("appended");
    expect(result.content).toContain("user only");
    expect(result.content).toContain("<!-- hunter-harness:start id=hunter-harness-core -->");
  });
});

describe("removeManagedBlockById", () => {
  it("removes only the given id block", () => {
    const original =
      "A\n<!-- hunter-harness:start id=hunter-harness-core -->\ncore\n<!-- hunter-harness:end id=hunter-harness-core -->\n" +
      "B\n<!-- hunter-harness:start id=hunter-harness-claude-code -->\nclaude-only\n<!-- hunter-harness:end id=hunter-harness-claude-code -->\nC\n";
    const out = removeManagedBlockById(original, "hunter-harness-claude-code");
    expect(out).toContain("hunter-harness-core");
    expect(out).toContain("core");
    expect(out).not.toContain("hunter-harness-claude-code");
    expect(out).not.toContain("claude-only");
    expect(out).toContain("A\n");
    expect(out).toContain("C\n");
  });
});
