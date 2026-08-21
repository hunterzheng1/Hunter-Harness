import { describe, expect, it } from "vitest";

import { generateProposalPreview, sha256Bytes } from "../src/index.js";

describe("proposal diff generation", () => {
  const oldA = "old A\n";
  const renamed = "same content\n";
  const deleted = "deleted content\n";
  const baseline = {
    "AGENTS.md": { content_sha256: sha256Bytes(oldA) },
    ".claude/rules/old-name.md": { content_sha256: sha256Bytes(renamed) },
    ".harness/knowledge/obsolete.md": { content_sha256: sha256Bytes(deleted) },
    ".harness/state/local/runtime.json": { content_sha256: sha256Bytes("state") }
  };

  it("emits only editable document changes and excludes all local knowledge", () => {
    const preview = generateProposalPreview({
      baseline,
      files: {
        "AGENTS.md": "new A\n",
        ".claude/rules/new-name.md": renamed,
        ".harness/knowledge/new.md": "new knowledge\n",
        ".harness/knowledge/project-local/private.md": "private context\n"
      },
      deletedAt: "2026-06-20T00:00:00Z",
      deleteReason: "removed locally",
      confirmedProjectLocal: []
    });

    expect(preview.blocked).toBe(false);
    expect(preview.operations.map((item) => item.operation).sort()).toEqual([
      "modify", "rename"
    ]);
    expect(preview.operations.find((item) => item.operation === "rename")).toMatchObject({
      from_path: ".claude/rules/old-name.md",
      to_path: ".claude/rules/new-name.md"
    });
    expect(preview.skipped).toEqual(expect.arrayContaining([
      expect.objectContaining({
        path: ".harness/state/local/runtime.json",
        reason: "policy-never"
      }),
      expect.objectContaining({
        path: ".harness/knowledge/project-local/private.md",
        reason: "policy-never"
      }),
      expect.objectContaining({
        path: ".harness/knowledge/new.md",
        reason: "policy-never"
      }),
      expect.objectContaining({
        path: ".harness/knowledge/obsolete.md",
        reason: "policy-never"
      })
    ]));
  });

  it("does not let per-path confirmation bypass the knowledge boundary", () => {
    const path = ".harness/knowledge/project-local/private.md";
    const preview = generateProposalPreview({
      baseline: {},
      files: { [path]: "private context\n" },
      deletedAt: "2026-06-20T00:00:00Z",
      deleteReason: "removed locally",
      confirmedProjectLocal: [path]
    });
    expect(preview.operations).toEqual([]);
    expect(preview.skipped).toContainEqual({ path, reason: "policy-never" });
  });

  it("filters current and baseline archive content before diff/rename detection", () => {
    const archive = ".harness/archive/change/spec/design.md";
    const report = ".harness/archive/change/reports/test/test-report.md";
    const preview = generateProposalPreview({
      baseline: {
        [archive]: { content_sha256: sha256Bytes("same\n") },
        [report]: { content_sha256: sha256Bytes("old report\n") }
      },
      files: {
        [archive]: "changed\n",
        ".harness/archive/change/plans/plan.md": "same\n"
      },
      deletedAt: "2026-06-20T00:00:00Z",
      deleteReason: "removed locally",
      confirmedProjectLocal: [archive, report]
    });

    expect(preview.operations).toEqual([]);
    expect(Object.keys(preview.blobs)).toEqual([]);
    expect(preview.skipped).toEqual(expect.arrayContaining([
      { path: archive, reason: "policy-never" },
      { path: report, reason: "policy-never" },
      { path: ".harness/archive/change/plans/plan.md", reason: "policy-never" }
    ]));
  });

  it("含高危密钥的内容不阻断 proposal preview（上传扫描已停用）", () => {
    // 停用契约（2026-08 4458708）：preview 的 security 恒为
    // disabled-for-publication，上传路径不做敏感检查。
    const preview = generateProposalPreview({
      baseline: {},
      files: {
        ".claude/rules/unsafe.md": "Authorization: Bearer secret-token-value-1234567890"
      },
      deletedAt: "2026-06-20T00:00:00Z",
      deleteReason: "removed locally",
      confirmedProjectLocal: []
    });
    expect(preview.blocked).toBe(false);
    expect(preview.security).toMatchObject({
      scan_performed: false,
      scanner_version: "disabled-for-publication",
      blocked: false,
      hard_blocked: false,
      findings: []
    });
  });
});
