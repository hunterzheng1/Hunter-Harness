import { describe, expect, it } from "vitest";

import {
  classifyFile,
  decidePush,
  decideUpdate
} from "../src/policy/file-policy.js";

describe("file policy matrix", () => {
  it.each([
    ["CLAUDE.md", "user_editable", "diff-proposal"],
    [".claude/rules/harness-general.md", "user_editable", "diff-proposal"],
    [".claude/skills/harness-review/SKILL.md", "user_editable", "diff-proposal"],
    [".harness/knowledge/business/rule.md", "user_editable", "full-diff-proposal"],
    [".harness/knowledge/project-local/debug.md", "user_editable", "confirm-before-proposal"],
    [".harness/codebase/map/ARCHITECTURE.md", "generated_reviewable", "full-diff-proposal"],
    [".harness/state/baseline/manifest.json", "internal_state", "never"],
    [".harness/generated/codex/review.md", "generated_cache", "never"],
    [".harness/cache/server-artifacts/a", "generated_cache", "never"],
    [".codegraph/index.db", "external_unmanaged", "never"],
    ["src/index.ts", "external_unmanaged", "never"]
  ])("classifies %s uniquely", (path, kind, pushPolicy) => {
    const policy = classifyFile(path);
    expect(policy.file_kind).toBe(kind);
    expect(policy.push_policy).toBe(pushPolicy);
  });

  it("requires an exact confirmation for project-local knowledge", () => {
    const policy = classifyFile(".harness/knowledge/project-local/debug.md");
    expect(decidePush(policy, false)).toEqual({
      include: false,
      reason: "confirmation-required"
    });
    expect(decidePush(policy, true)).toEqual({ include: true });
  });

  it("skips dirty editable files during update", () => {
    const policy = classifyFile(".claude/rules/harness-general.md");
    expect(decideUpdate(policy, true)).toEqual({
      apply: false,
      reason: "local-dirty"
    });
    expect(decideUpdate(policy, false)).toEqual({ apply: true });
  });

  it("never pushes or updates unmanaged content", () => {
    const policy = classifyFile(".codegraph/index.db");
    expect(decidePush(policy, true).include).toBe(false);
    expect(decideUpdate(policy, false).apply).toBe(false);
  });
});
