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
  it("UT-001 applies clean modify and advances baseline", () => {
    const path = ".harness/knowledge/a.md";
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
    const path = ".harness/knowledge/a.md";
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
    const path = ".harness/knowledge/project-local/custom.md";
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

  it("UT-005 keeps local-dirty as manual conflict", () => {
    const path = ".harness/knowledge/a.md";
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
    const path = ".harness/knowledge/a.md";
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
    const path = ".harness/knowledge/a.md";
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
    const from = ".harness/knowledge/old.md";
    const to = ".harness/knowledge/existing.md";
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
