import { describe, expect, it } from "vitest";

import {
  explainPushPullPreviewOutput,
  readPushPullPreviewOutput
} from "../src/index.js";
import type { PushPullInteractionInput } from "../src/push-pull-orchestration/types.js";

/**
 * `PUSH_PULL_CLI_OUTPUT_INVALID` used to collapse roughly twenty distinct
 * invariants into a single opaque code with `project_id: null` and no field
 * information — identical on dry-run. The 2026-08-19 kld-sdd session could not
 * diagnose its `--scope branch_files` failure at all, and shipped the archive
 * without its plan/spec/report as a result.
 */

const sourceRef = {
  project_id: "prj_1",
  branch_name: "main",
  commit_sha: "0".repeat(40),
  client_id: "cli_1"
} as const;

function input(scopes: readonly string[]): PushPullInteractionInput {
  return {
    schema_version: 1,
    source_mode: "detected",
    source_ref: { ...sourceRef },
    scopes: [...scopes]
  } as unknown as PushPullInteractionInput;
}

function preview(operations: readonly unknown[], scopes: readonly string[]): unknown {
  return {
    schema_version: 1,
    direction: "push",
    preview_hash: "preview-1",
    source_ref: { ...sourceRef },
    scopes: [...scopes],
    outcome: "ready",
    base_version: null,
    operations,
    conflicts: [],
    security_scan: {
      scanner_version: "1.1.0",
      blocked: false,
      hard_blocked: false,
      review_required: false,
      findings: []
    },
    display_zh: { heading: "Push 预览", summary: "s", detail_lines: [] }
  };
}

const hash = `sha256:${"a".repeat(64)}`;

describe("push/pull output diagnostics", () => {
  it("names the offending operation when a branch_file path belongs to another scope", () => {
    // 这是 branch_files 一直失败的真实原因：`.harness/` 下的文件已归属 rules 等范围，
    // 用 content_kind=branch_file 提交时 schema 直接判否，整个 preview 被丢弃。
    const value = preview(
      [
        { path: "src/app.ts", content_kind: "branch_file", action: "add", local_hash: hash },
        { path: ".harness/rules/x.md", content_kind: "branch_file", action: "add", local_hash: hash }
      ],
      ["branch_files"]
    );

    expect(readPushPullPreviewOutput(value, "push", input(["branch_files"]))).toBeUndefined();

    const violation = explainPushPullPreviewOutput(value, "push", input(["branch_files"]));
    expect(violation).toBeDefined();
    expect(violation?.violated).toBe("operations[1]");
    expect(violation?.detail).toContain(".harness/rules/x.md");
    expect(violation?.detail).toContain("rules");
  });

  it("accepts branch files whose paths belong to no other scope", () => {
    const value = preview(
      [{ path: "src/app.ts", content_kind: "branch_file", action: "add", local_hash: hash }],
      ["branch_files"]
    );

    expect(readPushPullPreviewOutput(value, "push", input(["branch_files"]))).toBeDefined();
    expect(explainPushPullPreviewOutput(value, "push", input(["branch_files"]))).toBeUndefined();
  });

  it("names a scope mismatch rather than reporting a bare code", () => {
    const value = preview([], ["rules"]);

    const violation = explainPushPullPreviewOutput(value, "push", input(["branch_files"]));
    expect(violation?.violated).toBe("scopes");
    expect(violation?.detail).toContain("branch_files");
    expect(violation?.detail).toContain("rules");
  });

  it("names the field for a wrong schema version", () => {
    const value = { ...(preview([], ["rules"]) as Record<string, unknown>), schema_version: 2 };

    expect(explainPushPullPreviewOutput(value, "push", input(["rules"]))?.violated)
      .toBe("schema_version");
  });
});
