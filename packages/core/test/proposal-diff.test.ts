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

  it("emits add, modify, tombstone delete, and explicit rename operations", () => {
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
      "add", "delete", "modify", "rename"
    ]);
    expect(preview.operations.find((item) => item.operation === "delete")).toMatchObject({
      path: ".harness/knowledge/obsolete.md",
      tombstone: {
        deleted_at: "2026-06-20T00:00:00Z",
        reason: "removed locally",
        previous_sha256: sha256Bytes(deleted)
      }
    });
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
        reason: "confirmation-required"
      })
    ]));
  });

  it("includes project-local only after per-path confirmation", () => {
    const path = ".harness/knowledge/project-local/private.md";
    const preview = generateProposalPreview({
      baseline: {},
      files: { [path]: "private context\n" },
      deletedAt: "2026-06-20T00:00:00Z",
      deleteReason: "removed locally",
      confirmedProjectLocal: [path]
    });
    expect(preview.operations).toEqual([
      expect.objectContaining({ operation: "add", path })
    ]);
  });

  it("blocks proposal preview when included content contains high-risk secrets", () => {
    const preview = generateProposalPreview({
      baseline: {},
      files: {
        ".claude/rules/unsafe.md": "Authorization: Bearer secret-token-value-1234567890"
      },
      deletedAt: "2026-06-20T00:00:00Z",
      deleteReason: "removed locally",
      confirmedProjectLocal: []
    });
    expect(preview.blocked).toBe(true);
    expect(preview.security.findings[0]).toMatchObject({ severity: "high" });
  });
});
