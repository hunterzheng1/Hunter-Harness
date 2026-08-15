import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import {
  knowledgeQueryHttpErrorCodeSchema,
  projectConfigSchema
} from "@hunter-harness/contracts";
import type { KnowledgeQueryHttpReceipt } from "@hunter-harness/contracts";
import { parse as parseYaml } from "yaml";

import { ApiError, HunterHarnessApiClient } from "../api/client.js";
import { sha256Bytes } from "../fs/hash.js";
import { uuidV7 } from "../project/uuid-v7.js";
import { readLocalCredentials, resolvePushAuth } from "../push/credentials.js";

export type RemoteKnowledgeReceiptIdentity = Pick<KnowledgeQueryHttpReceipt,
  "schema_version" | "receipt_id" | "query_hash" | "project_id" | "index_generation" |
  "result_set_hash" | "status" | "executed_at" | "reason_code" | "supersedes"
>;

function receiptIdentity(receipt: KnowledgeQueryHttpReceipt): RemoteKnowledgeReceiptIdentity {
  return {
    schema_version: receipt.schema_version,
    receipt_id: receipt.receipt_id,
    query_hash: receipt.query_hash,
    project_id: receipt.project_id,
    ...(receipt.index_generation === undefined ? {} : { index_generation: receipt.index_generation }),
    result_set_hash: receipt.result_set_hash,
    status: receipt.status,
    executed_at: receipt.executed_at,
    reason_code: receipt.reason_code,
    ...(receipt.supersedes === undefined ? {} : { supersedes: receipt.supersedes })
  };
}

export class RemoteKnowledgeQueryError extends Error {
  readonly code: string;
  readonly exitCode: 3 | 4 | 8;
  readonly query_id: string | undefined;
  readonly receipt: RemoteKnowledgeReceiptIdentity | undefined;

  constructor(
    message: string,
    code: string,
    exitCode: 3 | 4 | 8,
    metadata: Readonly<{
      query_id?: string;
      receipt?: RemoteKnowledgeReceiptIdentity;
    }> = {}
  ) {
    super(message);
    this.name = "RemoteKnowledgeQueryError";
    this.code = code;
    this.exitCode = exitCode;
    this.query_id = metadata.query_id;
    this.receipt = metadata.receipt;
  }
}

export async function queryRemoteKnowledge(options: {
  projectRoot: string;
  query: string;
  limit: number;
  serverUrl?: string;
  tokenEnv?: string;
  env: Readonly<Record<string, string | undefined>>;
  fetch?: typeof globalThis.fetch;
}) {
  const root = resolve(options.projectRoot);
  if (options.query.trim() === "") {
    throw new RemoteKnowledgeQueryError("查询内容不能为空", "KNOWLEDGE_QUERY_EMPTY", 4);
  }
  if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 10) {
    throw new RemoteKnowledgeQueryError(
      "limit 必须是 1 到 10 的整数",
      "KNOWLEDGE_QUERY_LIMIT_INVALID",
      4
    );
  }
  let project: ReturnType<typeof projectConfigSchema.parse>;
  try {
    project = projectConfigSchema.parse(parseYaml(
      await readFile(join(root, ".harness", "project.yaml"), "utf8")
    ));
  } catch {
    throw new RemoteKnowledgeQueryError(
      "项目配置不存在或无效",
      "PROJECT_CONFIG_INVALID",
      3
    );
  }
  const credentials = await readLocalCredentials(root);
  const auth = resolvePushAuth({
    ...(options.serverUrl === undefined ? {} : { serverUrlFlag: options.serverUrl }),
    ...(options.tokenEnv === undefined ? {} : { tokenEnv: options.tokenEnv }),
    env: options.env,
    local: credentials,
    projectUrl: project.server.url,
    projectTokenEnv: project.server.token_env
  });
  if ("code" in auth) {
    throw new RemoteKnowledgeQueryError(
      auth.code === "SERVER_URL_REQUIRED" ? "未配置知识服务地址" : "未配置知识服务凭据",
      auth.code,
      auth.code === "SERVER_URL_REQUIRED" ? 3 : 8
    );
  }
  const projectId = credentials?.project_id ?? project.project.project_id;
  if (projectId === null || projectId === undefined) {
    throw new RemoteKnowledgeQueryError(
      "项目尚未绑定远端平台；请先运行 npx hunter-harness connect",
      "PROJECT_NOT_BOUND",
      3
    );
  }
  if (credentials?.project_id !== undefined &&
      project.project.project_id !== null &&
      credentials.project_id !== project.project.project_id) {
    throw new RemoteKnowledgeQueryError(
      "本地凭据与项目配置绑定了不同的远端项目",
      "PROJECT_BINDING_MISMATCH",
      4
    );
  }
  const client = new HunterHarnessApiClient({
    serverUrl: auth.serverUrl,
    token: auth.token,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch })
  });
  const query = options.query.trim();
  const query_hash = sha256Bytes(query);
  const requestId = uuidV7();
  let result;
  try {
    result = await client.queryKnowledge({
      projectId,
      body: {
        schema_version: 1,
        project_id: projectId,
        query_id: `knowledge_query:${query_hash.slice("sha256:".length)}`,
        query_hash,
        reason_code: "initial_intent",
        query,
        budget: {
          max_results: options.limit,
          max_total_summary_bytes: 65_536,
          deadline_ms: 60_000
        }
      },
      requestId,
      idempotencyKey: `knowledge-query:${query_hash.slice("sha256:".length)}`
    });
  } catch (error) {
    if (error instanceof ApiError) {
      const parsedCode = knowledgeQueryHttpErrorCodeSchema.safeParse(error.code);
      const code = parsedCode.success ? parsedCode.data : "REMOTE_UNAVAILABLE";
      throw new RemoteKnowledgeQueryError(
        "远端知识查询不可用",
        code,
        error.status === 401 || error.status === 403 ? 8 : 3
      );
    }
    throw new RemoteKnowledgeQueryError("远端知识查询不可用", "REMOTE_UNAVAILABLE", 3);
  }
  if (result.receipt.status === "failed") {
    const parsedFailureCode = result.receipt.failure_code === undefined
      ? null
      : knowledgeQueryHttpErrorCodeSchema.safeParse(result.receipt.failure_code);
    throw new RemoteKnowledgeQueryError(
      "远端知识查询不可用",
      parsedFailureCode !== null && parsedFailureCode.success
        ? parsedFailureCode.data
        : "REMOTE_UNAVAILABLE",
      3,
      { query_id: result.query_id, receipt: receiptIdentity(result.receipt) }
    );
  }
  return {
    ...result,
    project_id: projectId,
    items: result.results.slice(0, options.limit),
    request_id: requestId
  };
}
