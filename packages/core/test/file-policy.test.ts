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
    ["src/index.ts", "external_unmanaged", "never"],
    [".cursor/rules/harness-general.mdc", "user_editable", "diff-proposal"],
    [".agent-skills/harness-review.md", "user_editable", "diff-proposal"],
    ["CODEBUDDY.md", "user_editable", "diff-proposal"],
    [".agents/skills/harness-review/SKILL.md", "user_editable", "diff-proposal"],
    [".cursor/skills/harness-review/SKILL.md", "user_editable", "diff-proposal"],
    [".codebuddy/skills/harness-review/SKILL.md", "user_editable", "diff-proposal"],
    [".codebuddy/agents/harness-reviewer.md", "user_editable", "diff-proposal"]
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

  it("treats CodeBuddy and all adapter working copies as editable diffs", () => {
    expect(classifyFile("CODEBUDDY.md").edit_policy).toBe("managed-block-only");
    for (const path of [
      ".agents/skills/harness-review/SKILL.md",
      ".cursor/skills/harness-review/SKILL.md",
      ".cursor/rules/harness-general.mdc",
      ".codebuddy/skills/harness-review/SKILL.md",
      ".codebuddy/agents/harness-reviewer.md"
    ]) {
      expect(classifyFile(path)).toMatchObject({
        file_kind: "user_editable",
        push_policy: "diff-proposal",
        update_policy: "skip-if-local-dirty"
      });
    }
  });

  it.each([
    ".codebuddy/settings.json",
    ".codex/config.toml",
    ".codex/hooks.json"
  ])("keeps external configuration unmanaged: %s", (path) => {
    expect(classifyFile(path).file_kind).toBe("external_unmanaged");
  });
});
