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
      document_id: item.document.document_id,
      kind: item.document.kind,
      title: item.document.title,
      body: item.document.body,
      source_path: item.document.source_path,
      content_sha256: item.document.content_sha256,
      metadata: item.document.metadata
    }));
    const output = {
      schema_version: 1,
      command: "knowledge query",
      ok: true,
      exit_code: 0,
      source: "remote",
      fallback: false,
      project_id: result.project_id,
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
          `${index + 1}. ${item.title}\n   来源：${item.source_path}\n   ${item.body}`
        ).join("\n\n") + "\n");
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const code = error instanceof RemoteKnowledgeQueryError
      ? error.code
      : "REMOTE_KNOWLEDGE_UNAVAILABLE";
    const exitCode = error instanceof RemoteKnowledgeQueryError ? error.exitCode : 1;
    dependencies.stderr(message + "\n");
    if (options.json === true) {
      dependencies.stdout(JSON.stringify({
        schema_version: 1,
        command: "knowledge query",
        ok: false,
        exit_code: exitCode,
        source: "remote",
        fallback: false,
        project_id: null,
        items: [],
        errors: [{ code, message }]
      }) + "\n");
    }
    return exitCode;
  }
}
