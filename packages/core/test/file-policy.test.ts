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
    [".harness/knowledge/business/rule.md", "user_editable", "never"],
    [".harness/knowledge/entries/active/sample.json", "user_editable", "never"],
    [".harness/knowledge/entries/candidate/sample.json", "user_editable", "never"],
    [".harness/knowledge/index.json", "generated_cache", "never"],
    [".harness/knowledge/entries/stale/sample.json", "generated_cache", "never"],
    [".harness/knowledge/entries/superseded/sample.json", "generated_cache", "never"],
    [".harness/knowledge/rule-candidates.json", "user_editable", "never"],
    [".harness/knowledge/index.sqlite", "generated_cache", "never"],
    [".harness/knowledge/cache/archive-entries/sample.json", "generated_cache", "never"],
    [".harness/knowledge/views/knowledge-dashboard.md", "generated_cache", "never"],
    [".harness/knowledge/context-packs/latest.json", "generated_cache", "never"],
    [".harness/knowledge/reports/ingest-report-20260101.md", "generated_cache", "never"],
    [".harness/knowledge/project-local/debug.md", "user_editable", "never"],
    [".harness/archive/2026-07-16-sample/reports/final/summary-data.json", "generated_reviewable", "never"],
    [".harness/archive/2026-07-16-sample/spec/design.md", "generated_reviewable", "never"],
    [".harness/archive/2026-07-16-sample/plans/plan.md", "generated_reviewable", "never"],
    [".harness/archive/2026-07-16-sample/reports/review/review-report.md", "generated_reviewable", "never"],
    [".harness/archive/2026-07-16-sample/reports/test/test-report.md", "generated_reviewable", "never"],
    [".harness/archive/2026-07-16-sample/meta/archive-meta.md", "generated_reviewable", "never"],
    [".harness/archive/2026-07-16-sample/meta/change-context.json", "generated_reviewable", "never"],
    [".harness/codebase/map/ARCHITECTURE.md", "generated_reviewable", "full-diff-proposal"],
    [".harness/state/baseline/manifest.json", "internal_state", "never"],
    [".harness/generated/codex/review.md", "generated_cache", "never"],
    [".harness/cache/server-artifacts/a", "generated_cache", "never"],
    [".codegraph/index.db", "external_unmanaged", "never"],
    ["src/index.ts", "external_unmanaged", "never"],
    [".harness/archive/2026-07-16-sample/reports/final/final-summary.html", "generated_reviewable", "never"],
    [".harness/archive/2026-07-16-sample/evidence/blob.bin", "generated_reviewable", "never"],
    [".cursor/rules/harness-general.mdc", "user_editable", "diff-proposal"],
    [".agent-skills/harness-review.md", "user_editable", "diff-proposal"],
    ["CODEBUDDY.md", "user_editable", "diff-proposal"],
    [".agents/skills/harness-review/SKILL.md", "user_editable", "diff-proposal"],
    [".cursor/skills/harness-review/SKILL.md", "user_editable", "diff-proposal"],
    [".codebuddy/skills/harness-review/SKILL.md", "user_editable", "diff-proposal"],
    [".codebuddy/agents/harness-reviewer.md", "user_editable", "diff-proposal"],
    [".claude/skills/harness-review/scripts/__pycache__/tool.cpython-311.pyc", "generated_cache", "never"],
    [".agents/skills/harness-review/scripts/tool.PYO", "generated_cache", "never"],
    [".cursor/skills/harness-review/.pytest_cache/CACHEDIR.TAG", "generated_cache", "never"],
    [".codebuddy/skills/harness-review/.mypy_cache/3.12/cache.json", "generated_cache", "never"],
    [".claude/skills/harness-review/.coverage.worker-1", "generated_cache", "never"],
    [".claude/skills/harness-review/.venv/pyvenv.cfg", "generated_cache", "never"]
  ])("classifies %s uniquely", (path, kind, pushPolicy) => {
    const policy = classifyFile(path);
    expect(policy.file_kind).toBe(kind);
    expect(policy.push_policy).toBe(pushPolicy);
  });

  it.each([
    ".harness/knowledge/project-local/debug.md",
    ".harness/knowledge/entries/active/item.json",
    ".harness/knowledge/entries/candidate/item.json",
    ".harness/knowledge/entries/conflicted/item.json",
    ".harness/archive/change/spec/design.md",
    ".harness/archive/change/reports/review/report.md",
    ".harness/archive/change/reports/test/report.md",
    ".harness/archive/change/logs/debug.log"
  ])("never lets generic push bypass local archive/knowledge protection: %s", (path) => {
    const policy = classifyFile(path);
    expect(decidePush(policy, false)).toEqual({
      include: false,
      reason: "policy-never"
    });
    expect(decidePush(policy, true)).toEqual({
      include: false,
      reason: "policy-never"
    });
  });

  it.each([
    ".harness/knowledge/business/rule.md",
    ".harness/knowledge/entries/active/item.json",
    ".harness/knowledge/entries/candidate/item.json",
    ".harness/archive/change/spec/core.md"
  ])("never restores server archive/knowledge into the local project: %s", (path) => {
    const policy = classifyFile(path);
    expect(decideUpdate(policy, false)).toEqual({
      apply: false,
      reason: "policy-never"
    });
    expect(decideUpdate(policy, true)).toEqual({
      apply: false,
      reason: "policy-never"
    });
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

  it("treats root instruction documents and adapter working copies as editable diffs", () => {
    for (const path of ["AGENTS.md", "CLAUDE.md", "CODEBUDDY.md"]) {
      expect(classifyFile(path)).toMatchObject({
        edit_policy: "allow",
        push_policy: "diff-proposal",
        update_policy: "skip-if-local-dirty",
        conflict_policy: "skip-and-report"
      });
    }
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
