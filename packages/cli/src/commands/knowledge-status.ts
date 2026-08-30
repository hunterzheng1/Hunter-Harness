import {
  knowledgeRemoteStatus,
  RemoteKnowledgeQueryError
} from "@hunter-harness/core";

import type { CommandDependencies } from "./configure.js";

export interface KnowledgeStatusOptions {
  serverUrl?: string;
  tokenEnv?: string;
  json?: boolean;
}

/**
 * P0-1 自查入口：ingest 回执宣称 ready 但查询全空时，需要能区分
 * 「job 没跑 / job 失败 / 结果为空」——一次性给出 fence 代数、
 * job 状态计数、结果条目数与最近活动时间。
 */
export async function runKnowledgeStatus(
  options: KnowledgeStatusOptions,
  dependencies: CommandDependencies
): Promise<number> {
  try {
    const { projectId, status } = await knowledgeRemoteStatus({
      projectRoot: dependencies.cwd,
      ...(options.serverUrl === undefined ? {} : { serverUrl: options.serverUrl }),
      ...(options.tokenEnv === undefined ? {} : { tokenEnv: options.tokenEnv }),
      env: dependencies.env,
      fetch: dependencies.fetch
    });
    const output = {
      schema_version: 1,
      command: "knowledge status",
      ok: true,
      exit_code: 0,
      project_id: projectId,
      pending_count: status.pending_count,
      pending_capped: status.pending_capped,
      ...(status.pipeline === undefined ? {} : { pipeline: status.pipeline }),
      request_id: status.request_id
    };
    if (options.json === true) {
      dependencies.stdout(JSON.stringify(output) + "\n");
      return 0;
    }
    const pipeline = status.pipeline;
    if (pipeline === undefined) {
      dependencies.stdout(
        `知识投影待处理 ${status.pending_count} 条（服务端未返回 pipeline 状态——平台版本过旧？）\n`
      );
      return 0;
    }
    const lines = [
      `知识管道状态（generation ${pipeline.generation}）`,
      `  可查询条目: ${pipeline.results_count}`,
      `  job: queued=${pipeline.jobs.queued} extracting=${pipeline.jobs.extracting} ` +
        `ready=${pipeline.jobs.ready} failed=${pipeline.jobs.failed}`,
      `  最近活动: ${pipeline.latest_job_updated_at ?? "无"}`,
      `  语义投影待处理: ${status.pending_count}${status.pending_capped ? "（已达上限）" : ""}`
    ];
    if (pipeline.results_count === 0 &&
        (pipeline.jobs.queued > 0 || pipeline.jobs.extracting > 0)) {
      lines.push("  提示: 有排队/进行中的提取 job——稍等后重查；长时间不动请检查平台 scheduler。");
    } else if (pipeline.results_count === 0 && pipeline.jobs.failed > 0) {
      lines.push("  提示: 存在失败的提取 job——平台侧查看 reason_code 后重试。");
    } else if (pipeline.results_count === 0 && pipeline.generation > 0) {
      lines.push("  提示: 已有归档但 0 条目——候选可能全部低于自动提升阈值或被裁决拒绝。");
    }
    dependencies.stdout(lines.join("\n") + "\n");
    return 0;
  } catch (error) {
    if (error instanceof RemoteKnowledgeQueryError) {
      dependencies.stdout(JSON.stringify({
        schema_version: 1,
        command: "knowledge status",
        ok: false,
        exit_code: error.exitCode,
        error: { code: error.code, message: error.message }
      }) + "\n");
      return error.exitCode;
    }
    throw error;
  }
}
