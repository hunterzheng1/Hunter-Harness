import { describe, expect, it } from "vitest";

import type { BaselineManifest, FileOperation } from "@hunter-harness/contracts";

import { sha256Bytes } from "../src/fs/hash.js";
import {
  planArtifactRebase,
  type OperationContext
} from "../src/sync/artifact-rebase.js";

function hash(content: string): string {
  return sha256Bytes(content);
}

function emptyBaseline(files: Record<string, BaselineManifest["files"][string]> = {}): BaselineManifest {
  return {
    schema_version: 1,
    project_id: "prj_test",
    complete_project_version: "pv_0",
    artifact_manifest_hash: null,
    files
  };
}

function modifyOp(
  path: string,
  base: string,
  content: string
): FileOperation {
  return {
    operation: "modify",
    path,
    file_kind: "user_editable",
    base_content_sha256: hash(base),
    content_sha256: hash(content),
    size_bytes: Buffer.byteLength(content)
  };
}

function context(
  operation: FileOperation,
  incoming: string | null,
  source: string | null,
  target: string | null
): OperationContext {
  return {
    operation,
    incomingContent: incoming,
    sourceContent: source,
    targetContent: target
  };
}

describe("planArtifactRebase", () => {
  it("restores a marker-free root instruction document as an exact full file", () => {
    const path = "AGENTS.md";
    const local = "# 项目约定\n\n旧内容。\n";
    const incoming = "# 项目约定\n\n保留用户说明。\n\n## 新规则\n\n使用完整文件同步。\n";
    const operation = modifyOp(path, local, incoming);
    const plan = planArtifactRebase({
      baseline: emptyBaseline({
        [path]: {
          baseline_hash: hash(local),
          local_hash_at_apply: hash(local),
          file_kind: "user_editable",
          last_applied_version: "pv_0",
          deleted: false
        }
      }),
      projectVersion: "pv_1",
      contexts: [context(operation, incoming, local, local)],
      conflictStrategy: "manual"
    });

    expect(plan.conflicts).toHaveLength(0);
    expect(plan.applied[0]?.content).toBe(incoming);
    expect(plan.applied[0]?.content).not.toContain("hunter-harness:start");
  });

  it.each(["AGENTS.md", "CLAUDE.md", "CODEBUDDY.md"])(
    "removes valid legacy markers once while preserving the complete %s artifact",
    (path) => {
      const local = "# 旧版本\n";
      const incoming = [
        "# 用户前言",
        "",
        "<!-- hunter-harness:start id=hunter-harness-core -->",
        "## 项目规则",
        "",
        "默认使用中文。",
        "<!-- hunter-harness:end id=hunter-harness-core -->",
        "",
        "用户尾注。",
        ""
      ].join("\n");
      const operation = modifyOp(path, local, incoming);
      const plan = planArtifactRebase({
        baseline: emptyBaseline({
          [path]: {
            baseline_hash: hash(local),
            local_hash_at_apply: hash(local),
            file_kind: "user_editable",
            last_applied_version: "pv_0",
            deleted: false
          }
        }),
        projectVersion: "pv_1",
        contexts: [context(operation, incoming, local, local)],
        conflictStrategy: "manual"
      });

      expect(plan.conflicts).toHaveLength(0);
      expect(plan.applied[0]?.content).toBe(
        "# 用户前言\n\n## 项目规则\n\n默认使用中文。\n\n用户尾注。\n"
      );
    }
  );

  it("migrates an already-applied legacy artifact exactly once", () => {
    const path = "AGENTS.md";
    const legacy = [
      "# 用户内容",
      "",
      "<!-- hunter-harness:start -->",
      "## 旧受管规则",
      "<!-- hunter-harness:end -->",
      ""
    ].join("\n");
    const operation = modifyOp(path, "# Previous\n", legacy);
    const plan = planArtifactRebase({
      baseline: emptyBaseline({
        [path]: {
          baseline_hash: hash(legacy),
          local_hash_at_apply: hash(legacy),
          file_kind: "user_editable",
          last_applied_version: "pv_1",
          deleted: false
        }
      }),
      projectVersion: "pv_1",
      contexts: [context(operation, legacy, legacy, legacy)],
      conflictStrategy: "manual"
    });

    expect(plan.alreadyApplied).toHaveLength(0);
    expect(plan.applied[0]?.content).toBe("# 用户内容\n\n## 旧受管规则\n");
    expect(plan.baselineUpdates[0]?.entry).toMatchObject({
      baseline_hash: hash(legacy),
      local_hash_at_apply: hash("# 用户内容\n\n## 旧受管规则\n")
    });
  });

  it("does not migrate an already-applied legacy artifact over a later user edit", () => {
    const path = "AGENTS.md";
    const legacy = "<!-- hunter-harness:start -->\n旧规则\n<!-- hunter-harness:end -->\n";
    const dirty = "# 用户后来新增\n\n" + legacy;
    const operation = modifyOp(path, "# Previous\n", legacy);
    const plan = planArtifactRebase({
      baseline: emptyBaseline({
        [path]: {
          baseline_hash: hash(legacy),
          local_hash_at_apply: hash(legacy),
          file_kind: "user_editable",
          last_applied_version: "pv_1",
          deleted: false
        }
      }),
      projectVersion: "pv_1",
      contexts: [context(operation, legacy, dirty, dirty)],
      conflictStrategy: "accept-remote"
    });

    expect(plan.applied).toHaveLength(0);
    expect(plan.resolvedAcceptRemote).toHaveLength(0);
    expect(plan.conflicts).toEqual([
      expect.objectContaining({ path, reason: "local-dirty" })
    ]);
    expect(plan.baselineAdvanced).toBe(false);
  });

  it("does not overwrite a concurrent user edit during a cross-client update", () => {
    const path = "AGENTS.md";
    const base = "# 项目规则\n\n旧规则。\n";
    const local = base + "\n本客户端新增说明。\n";
    const incoming = "# 项目规则\n\n另一客户端的新规则。\n";
    const operation = modifyOp(path, base, incoming);
    const plan = planArtifactRebase({
      baseline: emptyBaseline({
        [path]: {
          baseline_hash: hash(base),
          local_hash_at_apply: hash(base),
          file_kind: "user_editable",
          last_applied_version: "pv_0",
          deleted: false
        }
      }),
      projectVersion: "pv_1",
      contexts: [context(operation, incoming, local, local)],
      conflictStrategy: "manual"
    });

    expect(plan.applied).toHaveLength(0);
    expect(plan.conflicts).toEqual([
      expect.objectContaining({ path, reason: "local-dirty" })
    ]);
    expect(plan.baselineAdvanced).toBe(false);
  });

  it("rejects a root instruction update whose remote base hash diverged", () => {
    const path = "CLAUDE.md";
    const base = "# Base\n";
    const incoming = "# Incoming\n";
    const operation = modifyOp(path, base, incoming);
    const plan = planArtifactRebase({
      baseline: emptyBaseline({
        [path]: {
          baseline_hash: hash("# Different server base\n"),
          local_hash_at_apply: hash(base),
          file_kind: "user_editable",
          last_applied_version: "pv_0",
          deleted: false
        }
      }),
      projectVersion: "pv_1",
      contexts: [context(operation, incoming, base, base)],
      conflictStrategy: "manual"
    });

    expect(plan.applied).toHaveLength(0);
    expect(plan.conflicts).toEqual([
      expect.objectContaining({ path, reason: "baseline-diverged" })
    ]);
  });

  it("fails closed when a legacy root instruction artifact has malformed markers", () => {
    const path = "CODEBUDDY.md";
    const local = "# Old\n";
    const incoming = "# User\n<!-- hunter-harness:start -->\nunterminated\n";
    const operation = modifyOp(path, local, incoming);
    const plan = planArtifactRebase({
      baseline: emptyBaseline({
        [path]: {
          baseline_hash: hash(local),
          local_hash_at_apply: hash(local),
          file_kind: "user_editable",
          last_applied_version: "pv_0",
          deleted: false
        }
      }),
      projectVersion: "pv_1",
      contexts: [context(operation, incoming, local, local)],
      conflictStrategy: "accept-remote"
    });

    expect(plan.applied).toHaveLength(0);
    expect(plan.resolvedAcceptRemote).toHaveLength(0);
    expect(plan.conflicts).toEqual([
      expect.objectContaining({ path, reason: "invalid-managed-artifact" })
    ]);
    expect(plan.baselineAdvanced).toBe(false);
  });

  it("UT-001 applies clean modify and advances baseline", () => {
    const path = ".harness/rules/a.md";
    const old = "old\n";
    const next = "new\n";
    const baseline = emptyBaseline({
      [path]: {
        baseline_hash: hash(old),
        local_hash_at_apply: hash(old),
        file_kind: "user_editable",
        last_applied_version: "pv_0",
        deleted: false
      }
    });
    const operation = modifyOp(path, old, next);
    const plan = planArtifactRebase({
      baseline,
      projectVersion: "pv_1",
      contexts: [context(operation, next, old, old)],
      conflictStrategy: "manual"
    });
    expect(plan.applied).toHaveLength(1);
    expect(plan.conflicts).toHaveLength(0);
    expect(plan.baselineAdvanced).toBe(true);
    expect(plan.baselineUpdates[0]?.entry.baseline_hash).toBe(hash(next));
  });

  it("UT-002 treats equivalent local content as alreadyApplied", () => {
    const path = ".harness/rules/a.md";
    const old = "old\n";
    const next = "new\n";
    const baseline = emptyBaseline({
      [path]: {
        baseline_hash: hash(old),
        local_hash_at_apply: hash(old),
        file_kind: "user_editable",
        last_applied_version: "pv_0",
        deleted: false
      }
    });
    const operation = modifyOp(path, old, next);
    const plan = planArtifactRebase({
      baseline,
      projectVersion: "pv_1",
      contexts: [context(operation, next, next, next)],
      conflictStrategy: "manual"
    });
    expect(plan.alreadyApplied).toHaveLength(1);
    expect(plan.applied).toHaveLength(0);
    expect(plan.baselineAdvanced).toBe(true);
  });

  it("UT-003 acknowledges policy-never without conflict", () => {
    const path = ".harness/knowledge/entries/active/custom.json";
    const local = "local-only\n";
    const remote = "remote\n";
    const baseline = emptyBaseline({
      [path]: {
        baseline_hash: hash(local),
        local_hash_at_apply: hash(local),
        file_kind: "user_editable",
        last_applied_version: "pv_0",
        deleted: false
      }
    });
    const operation = modifyOp(path, local, remote);
    const plan = planArtifactRebase({
      baseline,
      projectVersion: "pv_1",
      contexts: [context(operation, remote, local, local)],
      conflictStrategy: "manual"
    });
    expect(plan.acknowledged).toHaveLength(1);
    expect(plan.conflicts).toHaveLength(0);
    expect(plan.baselineAdvanced).toBe(true);
    expect(plan.baselineUpdates[0]?.entry.baseline_hash).toBe(hash(remote));
  });

  it("acknowledges a rename when either side is policy-never", () => {
    const source = ".harness/knowledge/project-local/secret.md";
    const target = ".harness/rules/restored.md";
    const content = "local-only secret\n";
    const operation: FileOperation = {
      operation: "rename",
      from_path: source,
      to_path: target,
      file_kind: "user_editable",
      base_content_sha256: hash(content),
      content_sha256: hash(content),
      size_bytes: Buffer.byteLength(content)
    };
    const plan = planArtifactRebase({
      baseline: emptyBaseline({
        [source]: {
          baseline_hash: hash(content),
          local_hash_at_apply: hash(content),
          file_kind: "user_editable",
          last_applied_version: "pv_0",
          deleted: false
        }
      }),
      projectVersion: "pv_1",
      contexts: [context(operation, null, content, null)],
      conflictStrategy: "manual"
    });

    expect(plan.acknowledged).toHaveLength(1);
    expect(plan.applied).toHaveLength(0);
    expect(plan.conflicts).toHaveLength(0);
  });

  it("UT-005 keeps local-dirty as manual conflict", () => {
    const path = ".harness/rules/a.md";
    const old = "old\n";
    const next = "new\n";
    const dirty = "dirty\n";
    const baseline = emptyBaseline({
      [path]: {
        baseline_hash: hash(old),
        local_hash_at_apply: hash(old),
        file_kind: "user_editable",
        last_applied_version: "pv_0",
        deleted: false
      }
    });
    const operation = modifyOp(path, old, next);
    const plan = planArtifactRebase({
      baseline,
      projectVersion: "pv_1",
      contexts: [context(operation, next, dirty, dirty)],
      conflictStrategy: "manual"
    });
    expect(plan.conflicts).toHaveLength(1);
    expect(plan.conflicts[0]?.reason).toBe("local-dirty");
    expect(plan.baselineAdvanced).toBe(false);
  });

  it("UT-006 resolves local-dirty with keep-local", () => {
    const path = ".harness/rules/a.md";
    const old = "old\n";
    const next = "new\n";
    const dirty = "dirty\n";
    const baseline = emptyBaseline({
      [path]: {
        baseline_hash: hash(old),
        local_hash_at_apply: hash(old),
        file_kind: "user_editable",
        last_applied_version: "pv_0",
        deleted: false
      }
    });
    const operation = modifyOp(path, old, next);
    const plan = planArtifactRebase({
      baseline,
      projectVersion: "pv_1",
      contexts: [context(operation, next, dirty, dirty)],
      conflictStrategy: "keep-local"
    });
    expect(plan.resolvedKeepLocal).toHaveLength(1);
    expect(plan.conflicts).toHaveLength(0);
    expect(plan.baselineUpdates[0]?.entry.baseline_hash).toBe(hash(next));
    expect(plan.baselineUpdates[0]?.entry.local_hash_at_apply).toBe(hash(dirty));
  });

  it("UT-007 resolves local-dirty with accept-remote", () => {
    const path = ".harness/rules/a.md";
    const old = "old\n";
    const next = "new\n";
    const dirty = "dirty\n";
    const baseline = emptyBaseline({
      [path]: {
        baseline_hash: hash(old),
        local_hash_at_apply: hash(old),
        file_kind: "user_editable",
        last_applied_version: "pv_0",
        deleted: false
      }
    });
    const operation = modifyOp(path, old, next);
    const plan = planArtifactRebase({
      baseline,
      projectVersion: "pv_1",
      contexts: [context(operation, next, dirty, dirty)],
      conflictStrategy: "accept-remote"
    });
    expect(plan.resolvedAcceptRemote).toHaveLength(1);
    expect(plan.resolvedAcceptRemote[0]?.content).toBe(next);
    expect(plan.baselineAdvanced).toBe(true);
  });

  it("UT-012 keeps rename target collision manual even with keep-local", () => {
    const from = ".harness/rules/old.md";
    const to = ".harness/rules/existing.md";
    const content = "renamed\n";
    const existing = "other\n";
    const baseline = emptyBaseline({
      [from]: {
        baseline_hash: hash(content),
        local_hash_at_apply: hash(content),
        file_kind: "user_editable",
        last_applied_version: "pv_0",
        deleted: false
      }
    });
    const operation: FileOperation = {
      operation: "rename",
      from_path: from,
      to_path: to,
      file_kind: "user_editable",
      base_content_sha256: hash(content),
      content_sha256: hash(content),
      size_bytes: Buffer.byteLength(content)
    };
    const plan = planArtifactRebase({
      baseline,
      projectVersion: "pv_1",
      contexts: [context(operation, content, content, existing)],
      conflictStrategy: "keep-local"
    });
    expect(plan.conflicts).toHaveLength(1);
    expect(plan.conflicts[0]?.reason).toBe("target-collision");
    expect(plan.baselineAdvanced).toBe(false);
  });
});
