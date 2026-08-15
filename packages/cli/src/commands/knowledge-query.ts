import {
  queryRemoteKnowledge,
  RemoteKnowledgeQueryError
} from "@hunter-harness/core";

import type { CommandDependencies } from "./configure.js";

export interface KnowledgeQueryOptions {
  limit?: number;
  serverUrl?: string;
  tokenEnv?: string;
  json?: boolean;
}

export async function runKnowledgeQuery(
  query: string,
  options: KnowledgeQueryOptions,
  dependencies: CommandDependencies
): Promise<number> {
  try {
    const result = await queryRemoteKnowledge({
      projectRoot: dependencies.cwd,
      query,
      limit: options.limit ?? 10,
      ...(options.serverUrl === undefined ? {} : { serverUrl: options.serverUrl }),
      ...(options.tokenEnv === undefined ? {} : { tokenEnv: options.tokenEnv }),
      env: dependencies.env,
      fetch: dependencies.fetch
    });
    const items = result.items.map((item) => ({
      result_id: item.result_id,
      kind: item.kind,
      summary: item.summary,
      relevance: item.relevance,
      ...(item.source === undefined ? {} : { source: item.source }),
      ...(item.verified_at === undefined ? {} : { verified_at: item.verified_at }),
      ...(item.source_version === undefined ? {} : { source_version: item.source_version }),
      conflicts_with_intent: item.conflicts_with_intent,
      ...(item.conflict_summary === undefined ? {} : { conflict_summary: item.conflict_summary })
    }));
    const output = {
      schema_version: 1,
      command: "knowledge query",
      ok: true,
      exit_code: 0,
      source: "remote",
      fallback: false,
      project_id: result.project_id,
      query_id: result.query_id,
      receipt: result.receipt,
      query,
      count: items.length,
      items,
      request_id: result.request_id
    };
    dependencies.stdout(options.json === true
      ? JSON.stringify(output) + "\n"
      : items.length === 0
        ? "远端知识库中没有匹配内容。\n"
        : items.map((item, index) =>
          `${index + 1}. ${item.kind}（${item.relevance}）\n   来源：${item.source ?? "未提供"}\n   ${item.summary}`
        ).join("\n\n") + "\n");
    return 0;
  } catch (error) {
    const typedError = error instanceof RemoteKnowledgeQueryError ? error : undefined;
    const message = typedError?.message ?? "远端知识查询不可用";
    const code = typedError?.code ?? "REMOTE_UNAVAILABLE";
    const exitCode = typedError?.exitCode ?? 3;
    dependencies.stderr(message + "\n");
    if (options.json === true) {
      dependencies.stdout(JSON.stringify({
        schema_version: 1,
        command: "knowledge query",
        ok: false,
        exit_code: exitCode,
        source: "remote",
        fallback: false,
        project_id: typedError?.receipt?.project_id ?? null,
        ...(typedError?.query_id === undefined ? {} : { query_id: typedError.query_id }),
        ...(typedError?.receipt === undefined ? {} : { receipt: typedError.receipt }),
        items: [],
        errors: [{ code, message }]
      }) + "\n");
    }
    return exitCode;
  }
}
