import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { projectConfigSchema } from "@hunter-harness/contracts";
import { parse as parseYaml } from "yaml";

import { HunterHarnessApiClient } from "../api/client.js";
import { uuidV7 } from "../project/uuid-v7.js";
import { readLocalCredentials, resolvePushAuth } from "../push/credentials.js";

export class RemoteKnowledgeQueryError extends Error {
  readonly code: string;
  readonly exitCode: 3 | 4 | 8;

  constructor(message: string, code: string, exitCode: 3 | 4 | 8) {
    super(message);
    this.name = "RemoteKnowledgeQueryError";
    this.code = code;
    this.exitCode = exitCode;
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
  if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 50) {
    throw new RemoteKnowledgeQueryError(
      "limit 必须是 1 到 50 的整数",
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
      "项目尚未绑定远端平台；请先运行 hunter-harness connect",
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
  const result = await client.searchSemanticKnowledge({
    projectId,
    query: options.query.trim(),
    requestId: uuidV7()
  });
  return {
    ...result,
    project_id: projectId,
    items: result.items.slice(0, options.limit)
  };
}
