import { describe, expect, it, vi } from "vitest";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { runCli, type CliDependencies } from "../src/bin.js";
import {
  createPushPullCliPort,
  type PushPullCliPort
} from "../src/push-pull-adapter/index.js";
import { resolvePushPullSource } from "../src/commands/push-pull.js";

const execFileAsync = promisify(execFile);

const sourceRef = {
  project_id: "prj_cli",
  branch_name: "main",
  commit_sha: "0123456789abcdef",
  client_id: "client_cli"
} as const;

function preview(direction: "push" | "pull", outcome: "ready" | "no_changes" = "ready") {
  return {
    schema_version: 1 as const,
    operation: "preview" as const,
    direction,
    retry: { retryable: false, reason_code: null },
    result: {
      schema_version: 1 as const,
      direction,
      preview_hash: `preview-${direction}`,
      source_ref: sourceRef,
      scopes: ["rules"] as const,
      outcome,
      base_version: "pv-1",
      remote_version: undefined,
      operations: outcome === "no_changes" ? [] : [{
        path: ".harness/rules/example.md",
        content_kind: "rule" as const,
        action: "modify" as const
      }],
      conflicts: [],
      security_scan: {
        scanner_version: "1.1.0",
        blocked: false,
        hard_blocked: false,
        review_required: false,
        findings: []
      },
      display_zh: {
        heading: direction === "push" ? "Push 预览" : "Pull 预览",
        summary: "1 个变更",
        detail_lines: ["来源分支：main", "来源提交：0123456789abcdef", "远端基线：pv-1"]
      }
    }
  };
}

function dependencies(dispatch: PushPullCliPort["dispatch"]): CliDependencies & {
  pushPullSource: () => Promise<typeof sourceRef>;
} {
  return {
    cwd: process.cwd(),
    resourcesRoot: "",
    stdout: vi.fn(),
    stderr: vi.fn(),
    prompt: vi.fn(async () => "n"),
    fetch: vi.fn(),
    env: {},
    pushPull: { dispatch },
    pushPullSource: vi.fn(async () => sourceRef)
  };
}

function confirmation(direction: "push" | "pull", status: "confirmed" | "cancelled" = "confirmed") {
  return {
    schema_version: 1 as const,
    operation: "confirm" as const,
    direction,
    retry: { retryable: false, reason_code: null },
    result: status === "confirmed" ? {
      schema_version: 1 as const, status, direction,
      preview_hash: `preview-${direction}`,
      confirmation_id: `confirmation-${direction}`,
      display_zh: { heading: "确认", summary: "已确认", detail_lines: [] }
    } : {
      schema_version: 1 as const, status, direction,
      preview_hash: `preview-${direction}`,
      display_zh: { heading: "确认", summary: "已取消", detail_lines: [] }
    }
  };
}

function execution(direction: "push" | "pull", retryable = false) {
  return {
    schema_version: 1 as const,
    operation: "execute" as const,
    direction,
    verification: { status: "verified" as const, preview_hash: `preview-${direction}` },
    retry: { retryable, reason_code: retryable ? "REMOTE_UNAVAILABLE" : null },
    result: {
      schema_version: 1 as const, direction,
      preview_hash: `preview-${direction}`,
      status: retryable ? "retryable" as const : "completed" as const,
      sync_receipt: {
        preview_hash: `preview-${direction}`,
        no_changes: false,
        applied: retryable ? [] : [{
          path: ".harness/rules/example.md", content_kind: "rule" as const,
          action: "modify" as const
        }],
        skipped: [],
        retryable: retryable ? [{
          path: ".harness/rules/example.md", content_kind: "rule" as const,
          action: "modify" as const
        }] : [],
        ...(retryable ? { reason_code: "REMOTE_UNAVAILABLE" as const } : {})
      },
      display_zh: { heading: "结果", summary: retryable ? "可重试" : "已完成", detail_lines: [] }
    }
  };
}

describe("Stage 03 Push/Pull CLI commands", () => {
  it("maps a selective push preview only through PushPullCliPort", async () => {
    const buildPushPreview = vi.fn(async () => preview("push").result);
    const port = createPushPullCliPort({ orchestration: {
      buildPushPreview,
      buildPullPreview: vi.fn(),
      confirmPush: vi.fn(),
      resolvePull: vi.fn(),
      executePush: vi.fn(),
      executePull: vi.fn()
    } as never });
    const dispatch = vi.fn(port.dispatch.bind(port));
    const deps = dependencies(dispatch);

    const code = await runCli([
      "harness-push", "--scope", "rules", "--dry-run", "--json", "--non-interactive"
    ], deps);

    expect(code).toBe(0);
    expect(dispatch).toHaveBeenCalledWith({
      schema_version: 1,
      operation: "preview",
      direction: "push",
      interaction: {
        schema_version: 1,
        source_ref: sourceRef,
        source_mode: "current",
        scopes: ["rules"]
      }
    });
    expect(deps.fetch).not.toHaveBeenCalled();
    expect(buildPushPreview).toHaveBeenCalledWith(expect.objectContaining({ scopes: ["rules"] }));
    expect(JSON.parse(vi.mocked(deps.stdout).mock.calls.join(""))).toMatchObject({
      command: "push",
      dry_run: true,
      ok: true,
      summary: { planned: 1, applied: 0 }
    });
  });

  it("registers the canonical command names and Pull compatibility alias", async () => {
    const stdout: string[] = [];
    expect(await runCli(["harness-push", "--help"], {
      stdout: (value) => stdout.push(value), stderr: () => undefined, env: {}
    })).toBe(0);
    expect(stdout.join("")).toContain("--scope <scopes>");
    expect(stdout.join("")).toContain("RemoteSync 未配置时安全失败");
    stdout.length = 0;
    expect(await runCli(["pull", "--help"], {
      stdout: (value) => stdout.push(value), stderr: () => undefined, env: {}
    })).toBe(0);
    expect(stdout.join("")).toContain("harness-pull");
    stdout.length = 0;
    expect(await runCli(["update", "--help"], {
      stdout: (value) => stdout.push(value), stderr: () => undefined, env: {}
    })).toBe(0);
    expect(stdout.join("")).toContain("生产接线完成前继续使用本命令");
  });

  it("derives the production source identity from bound project state and Git", async () => {
    const root = await mkdtemp(join(tmpdir(), "hunter-push-pull-source-"));
    const resourcesRoot = fileURLToPath(new URL("../../workflow-data-harness", import.meta.url));
    expect(await runCli([
      "--profile", "general", "--non-interactive", "--yes"
    ], { cwd: root, resourcesRoot, stdout: () => undefined, stderr: () => undefined, env: {} }))
      .toBe(0);
    const projectPath = join(root, ".harness", "project.yaml");
    await writeFile(projectPath, (await readFile(projectPath, "utf8"))
      .replace("project_id: null", "project_id: prj_source"), "utf8");
    await execFileAsync("git", ["init", "-b", "main"], { cwd: root, windowsHide: true });
    await execFileAsync("git", ["config", "user.name", "Harness Test"], { cwd: root, windowsHide: true });
    await execFileAsync("git", ["config", "user.email", "harness@example.test"], { cwd: root, windowsHide: true });
    await writeFile(join(root, "fixture.txt"), "fixture\n", "utf8");
    await execFileAsync("git", ["add", "fixture.txt"], { cwd: root, windowsHide: true });
    await execFileAsync("git", ["commit", "-m", "fixture"], { cwd: root, windowsHide: true });

    await expect(resolvePushPullSource(root, { direction: "pull", branch: "release" }))
      .resolves.toMatchObject({
        project_id: "prj_source",
        branch_name: "release",
        commit_sha: expect.stringMatching(/^[0-9a-f]{40}$/),
        client_id: expect.stringMatching(/^[0-9a-f-]+$/)
      });
  }, 30_000);

  it("stops on no changes without creating a confirmation or empty version", async () => {
    const dispatch = vi.fn(async () => preview("push", "no_changes"));
    const deps = dependencies(dispatch);

    expect(await runCli(["harness-push", "--scope", "config", "--yes", "--json"], deps))
      .toBe(0);

    expect(dispatch).toHaveBeenCalledOnce();
    expect(JSON.parse(vi.mocked(deps.stdout).mock.calls.join(""))).toMatchObject({
      ok: true,
      outcome: "no_changes",
      summary: { planned: 0, applied: 0 }
    });
  });

  it("cancels through Core confirmation and never executes", async () => {
    const dispatch = vi.fn(async (request: unknown) => {
      const operation = (request as { operation: string }).operation;
      return operation === "preview" ? preview("push") : confirmation("push", "cancelled");
    }) as PushPullCliPort["dispatch"];
    const deps = dependencies(dispatch);

    expect(await runCli(["harness-push", "--scope", "rules"], deps)).toBe(2);

    expect(vi.mocked(dispatch).mock.calls.map(([request]) => (request as { operation: string }).operation))
      .toEqual(["preview", "confirm"]);
    expect(vi.mocked(dispatch).mock.calls[1]?.[0]).toMatchObject({
      decision: { action: "stop" }
    });
  });

  it("binds an explicit deleted-file restore to the preview artifact and branch", async () => {
    const pullPreview = preview("pull");
    pullPreview.result.scopes = ["branch_files"] as never;
    pullPreview.result.operations = [{
      path: "src/restored.ts", content_kind: "branch_file", action: "restore"
    }] as never;
    pullPreview.result.remote_version = {
      project_id: "prj_cli", branch_name: "release", commit_sha: "remote-commit",
      artifact_id: "art-7", project_version: "pv-7", uploaded_at: "2026-08-14T00:00:00.000Z",
      client_id: "remote-client", manifest_hash: "sha256:manifest"
    } as never;
    const dispatch = vi.fn(async (request: unknown) => {
      const operation = (request as { operation: string }).operation;
      if (operation === "preview") return pullPreview;
      if (operation === "confirm") return confirmation("pull");
      return execution("pull");
    }) as PushPullCliPort["dispatch"];
    const deps = dependencies(dispatch);

    expect(await runCli([
      "harness-pull", "--scope", "branch_files", "--branch", "release",
      "--resolve", "src/restored.ts=accept-remote", "--yes", "--json"
    ], deps)).toBe(0);

    expect(vi.mocked(dispatch).mock.calls[0]?.[0]).toMatchObject({
      interaction: { source_mode: "explicit", source_ref: { branch_name: "main" } }
    });
    expect(deps.pushPullSource).toHaveBeenCalledWith({ direction: "pull", branch: "release" });
    expect(vi.mocked(dispatch).mock.calls[1]?.[0]).toMatchObject({
      decision: { conflict_decisions: [{
        path: "src/restored.ts",
        resolution: "accept_remote",
        source_artifact_id: "art-7",
        source_project_version: "pv-7"
      }] }
    });
  });

  it("renders the selected remote Pull version instead of labelling local HEAD as its commit", async () => {
    const pullPreview = preview("pull");
    pullPreview.result.remote_version = {
      project_id: "prj_cli", branch_name: "release", commit_sha: "remote-release-commit",
      artifact_id: "art-7", project_version: "pv-7", uploaded_at: "2026-08-14T00:00:00.000Z",
      client_id: "remote-client", manifest_hash: "sha256:manifest"
    } as never;
    const dispatch = vi.fn(async () => pullPreview);
    const deps = dependencies(dispatch);

    expect(await runCli([
      "harness-pull", "--scope", "rules", "--branch", "release", "--dry-run"
    ], deps)).toBe(0);

    const output = vi.mocked(deps.stdout).mock.calls.join("");
    expect(output).toContain("来源项目版本：pv-7");
    expect(output).toContain("来源提交：remote-release-commit");
    expect(output).not.toContain("来源提交：0123456789abcdef");
  });

  it("keeps an intentional local deletion skipped in ordinary Pull", async () => {
    const pullPreview = preview("pull");
    pullPreview.result.operations = [{
      path: "src/deleted-locally.ts", content_kind: "branch_file", action: "restore"
    }] as never;
    const dispatch = vi.fn(async (request: unknown) => {
      const operation = (request as { operation: string }).operation;
      if (operation === "preview") return pullPreview;
      if (operation === "confirm") return confirmation("pull");
      return execution("pull");
    }) as PushPullCliPort["dispatch"];
    const deps = dependencies(dispatch);

    expect(await runCli(["harness-pull", "--scope", "rules", "--yes", "--json"], deps))
      .toBe(0);
    expect(vi.mocked(dispatch).mock.calls[1]?.[0]).toMatchObject({
      decision: { conflict_decisions: [] }
    });
  });

  it("requires explicit conflict decisions in non-interactive mode", async () => {
    const conflicted = preview("pull");
    conflicted.result.conflicts = [{
      path: ".harness/rules/conflict.md", content_kind: "rule",
      kind: "both_modified", base_hash: "sha256:base",
      local_hash: "sha256:local", remote_hash: "sha256:remote"
    }] as never;
    const dispatch = vi.fn(async () => conflicted);
    const deps = dependencies(dispatch);

    expect(await runCli([
      "harness-pull", "--scope", "rules", "--non-interactive", "--yes", "--json"
    ], deps)).toBe(5);

    expect(dispatch).toHaveBeenCalledOnce();
    expect(JSON.parse(vi.mocked(deps.stdout).mock.calls.join(""))).toMatchObject({
      ok: false,
      errors: [{ code: "PUSH_PULL_DECISION_REQUIRED" }]
    });
  });

  it("rejects a hostile confirmation binding before execute", async () => {
    const dispatch = vi.fn(async (request: unknown) => {
      const operation = (request as { operation: string }).operation;
      if (operation === "preview") return preview("push");
      return {
        ...confirmation("push"),
        result: { ...confirmation("push").result, preview_hash: "preview-foreign" }
      };
    }) as PushPullCliPort["dispatch"];
    const deps = dependencies(dispatch);

    expect(await runCli(["harness-push", "--scope", "rules", "--yes", "--json"], deps))
      .toBe(3);
    expect(vi.mocked(dispatch).mock.calls.map(([request]) => (request as { operation: string }).operation))
      .toEqual(["preview", "confirm"]);
    expect(JSON.parse(vi.mocked(deps.stdout).mock.calls.join(""))).toMatchObject({
      ok: false,
      errors: [{ code: "PUSH_PULL_CLI_OUTPUT_INVALID" }]
    });
  });

  it("does not expose or execute hostile Adapter error accessors", async () => {
    const getter = vi.fn(() => "PUSH_PULL_CLI_UNAVAILABLE");
    const hostile = Object.defineProperty({}, "code", { enumerable: true, get: getter });
    const deps = dependencies(vi.fn(async () => { throw hostile; }));

    expect(await runCli([
      "harness-push", "--scope", "rules", "--dry-run", "--json"
    ], deps)).toBe(3);
    expect(getter).not.toHaveBeenCalled();
    expect(JSON.parse(vi.mocked(deps.stdout).mock.calls.join(""))).toMatchObject({
      errors: [{ code: "PUSH_PULL_FAILED" }]
    });
  });

  it("preserves typed retryable RemoteSync errors for CLI retry handling", async () => {
    const deps = dependencies(vi.fn(async () => {
      const { RemoteSyncError } = await import("@hunter-harness/core");
      throw new RemoteSyncError("REMOTE_UNAVAILABLE", true);
    }));

    expect(await runCli([
      "harness-push", "--scope", "rules", "--dry-run", "--json"
    ], deps)).toBe(4);
    expect(JSON.parse(vi.mocked(deps.stdout).mock.calls.join(""))).toMatchObject({
      errors: [{ code: "REMOTE_UNAVAILABLE" }],
      exit_code: 4
    });
  });

  it("rejects branch restore without an explicit source and Archive in ordinary Pull", async () => {
    const dispatch = vi.fn();
    const deps = dependencies(dispatch);

    expect(await runCli([
      "harness-pull", "--scope", "branch_files", "--yes", "--json"
    ], deps)).toBe(3);
    expect(await runCli([
      "harness-pull", "--scope", "archive", "--yes", "--json"
    ], deps)).toBe(3);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("replays the same confirmation after a retryable network receipt", async () => {
    let executes = 0;
    const dispatch = vi.fn(async (request: unknown) => {
      const operation = (request as { operation: string }).operation;
      if (operation === "preview") return preview("push");
      if (operation === "confirm") return confirmation("push");
      executes += 1;
      return execution("push", executes === 1);
    }) as PushPullCliPort["dispatch"];
    const deps = dependencies(dispatch);
    deps.prompt = vi.fn(async () => "y");

    expect(await runCli(["harness-push", "--scope", "rules", "--yes", "--json"], deps))
      .toBe(0);

    expect(vi.mocked(dispatch).mock.calls.slice(2).map(([request]) => request)).toEqual([
      { schema_version: 1, operation: "execute", direction: "push", confirmation_id: "confirmation-push" },
      { schema_version: 1, operation: "execute", direction: "push", confirmation_id: "confirmation-push" }
    ]);
    expect(vi.mocked(deps.stderr).mock.calls.join("")).toContain("网络暂不可用");
  });

  it("keeps explicit Archive publish outside ordinary preview and never builds a package", async () => {
    const archiveResponse = {
      schema_version: 1 as const, operation: "archive_publish" as const,
      retry: { retryable: false, reason_code: null },
      result: { outcome: "stored" as const, sync_receipt: {}, ack: {}, cleanup_intent: null }
    } as never;
    const dispatch = vi.fn(async () => archiveResponse);
    const deps = {
      ...dependencies(dispatch),
      pushPullArchive: vi.fn(async () => ({
        claim: { entry_id: "outbox-1" }, source_ref: { ...sourceRef, change_key: "change-7" },
        retention_policy: "retain"
      }))
    } as unknown as CliDependencies;

    expect(await runCli([
      "harness-push", "--scope", "archive", "--change", "change-7", "--yes", "--json"
    ], deps)).toBe(0);

    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({
      operation: "archive_publish",
      claim: { entry_id: "outbox-1" }
    }));
    expect(JSON.stringify(vi.mocked(dispatch).mock.calls)).not.toContain("preview");
    expect(JSON.parse(vi.mocked(deps.stdout).mock.calls.join(""))).toMatchObject({
      schema_version: 1,
      command: "push",
      dry_run: false,
      ok: true,
      exit_code: 0,
      project_id: "prj_cli",
      summary: { status: "stored" },
      items: [{ outcome: "stored" }],
      warnings: [],
      errors: []
    });
  });

  it("keeps Archive dry-run unavailable without acquiring a claim or dispatching transport", async () => {
    const dispatch = vi.fn();
    const resolveArchive = vi.fn();
    const deps = {
      ...dependencies(dispatch),
      pushPullArchive: resolveArchive
    } as unknown as CliDependencies;

    expect(await runCli([
      "harness-push", "--scope", "archive", "--change", "change-7",
      "--dry-run", "--json", "--non-interactive"
    ], deps)).toBe(4);

    expect(resolveArchive).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
    expect(deps.fetch).not.toHaveBeenCalled();
    expect(JSON.parse(vi.mocked(deps.stdout).mock.calls.join(""))).toMatchObject({
      command: "push",
      dry_run: true,
      ok: false,
      errors: [{ code: "PUSH_PULL_ARCHIVE_UNAVAILABLE" }]
    });
  });

  it("fails closed in the default unavailable Port without old HTTP fallback", async () => {
    const deps = dependencies(vi.fn());
    delete deps.pushPull;

    expect(await runCli([
      "harness-push", "--scope", "rules", "--dry-run", "--json"
    ], deps)).toBe(4);
    expect(deps.fetch).not.toHaveBeenCalled();
    expect(JSON.parse(vi.mocked(deps.stdout).mock.calls.join(""))).toMatchObject({
      ok: false,
      errors: [{ code: "PUSH_PULL_CLI_UNAVAILABLE" }]
    });
  });
});
