import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  applyRuleReviewDecisions,
  exportRuleReviewQueue,
  pushProject,
  PushWorkflowError,
  uuidV7,
  type RuleDecisionManifest
} from "@hunter-harness/core";

import type { CommandDependencies } from "./configure.js";
import { detectProject } from "./refresh.js";
import { serializeCliResult, type CliResult } from "../output/json.js";

export interface RulesReviewCommandOptions {
  apply?: string;
  json?: boolean;
}

export async function runRulesReview(
  options: RulesReviewCommandOptions,
  dependencies: CommandDependencies
): Promise<number> {
  const detection = await detectProject(dependencies.cwd);
  if (detection.status === "absent") {
    dependencies.stderr("尚未初始化 Hunter Harness；请先运行 `hunter-harness`。\n");
    return 3;
  }
  if (detection.status === "invalid") {
    dependencies.stderr("PROJECT_CONFIG_INVALID：.harness/project.yaml 无效\n");
    return 3;
  }
  if (detection.status === "partial" || detection.status === "recovery-required") {
    dependencies.stderr(`${detection.reasonCode}：需要先恢复本地 Harness 主状态\n`);
    return 6;
  }
  try {
    const queue = await exportRuleReviewQueue(dependencies.cwd);
    let summary: Record<string, number>;
    let items: unknown[];
    let remoteSync: {
      status: "uploaded" | "unchanged" | "deferred";
      submitted: number;
      reason_code: string | null;
    } | null = null;
    if (options.apply === undefined) {
      summary = { pending: queue.pending.length, decided: queue.decided };
      items = queue.pending;
    } else {
      const input = JSON.parse(
        await readFile(resolve(dependencies.cwd, options.apply), "utf8")
      ) as RuleDecisionManifest;
      const result = await applyRuleReviewDecisions(dependencies.cwd, input);
      summary = { applied: result.applied, recorded: result.recorded };
      items = [{ path: result.path, status: "updated" }];
      try {
        const pushed = await pushProject({
          projectRoot: dependencies.cwd,
          resourcesRoot: dependencies.resourcesRoot,
          env: dependencies.env,
          dryRun: false,
          fetch: dependencies.fetch
        });
        remoteSync = {
          status: "noChanges" in pushed && pushed.noChanges ? "unchanged" : "uploaded",
          submitted: pushed.preview.operations.length,
          reason_code: null
        };
      } catch (error) {
        remoteSync = {
          status: "deferred",
          submitted: 0,
          reason_code: error instanceof PushWorkflowError
            ? error.code
            : "MANAGED_SNAPSHOT_UPLOAD_FAILED"
        };
      }
    }
    const payload: CliResult = {
      schema_version: 1,
      command: "rules-review",
      request_id: uuidV7(),
      dry_run: false,
      ok: true,
      exit_code: 0,
      project_id: detection.config.project.project_id,
      summary,
      items,
      ...(remoteSync === null ? {} : { remote_sync: remoteSync }),
      warnings: [],
      errors: []
    };
    if (options.json === true) dependencies.stdout(serializeCliResult(payload));
    else if (options.apply === undefined) {
      dependencies.stdout(
        `公共规则候选：待评审 ${summary.pending ?? 0}，已决定 ${summary.decided ?? 0}。\n`
      );
    } else {
      dependencies.stdout(
        `公共规则决策：应用 ${summary.applied ?? 0}，记录 ${summary.recorded ?? 0}。\n` +
        (remoteSync?.status === "uploaded"
          ? `已同步 ${remoteSync.submitted} 个受控文档到平台。\n`
          : remoteSync?.status === "unchanged"
            ? "平台上的受控文档已经是最新版本。\n"
            : `平台同步待重试（${remoteSync?.reason_code ?? "未知原因"}）；本地规则不受影响。\n`)
      );
    }
    return 0;
  } catch (error) {
    dependencies.stderr((error instanceof Error ? error.message : String(error)) + "\n");
    return 1;
  }
}
