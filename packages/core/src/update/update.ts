import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import {
  harnessAgentSchema,
  projectConfigSchema,
  type FileOperation
} from "@hunter-harness/contracts";
import { parse as parseYaml } from "yaml";

import { ApiError, HunterHarnessApiClient } from "../api/client.js";
import { readLocalCredentials } from "../push/credentials.js";
import { readBaseline } from "../state/baseline.js";
import type { TransactionOptions } from "../transaction/transaction.js";
import type { UpdateConflict } from "./conflicts.js";
import type { RebaseConflict } from "../sync/artifact-rebase.js";
import {
  synchronizeArtifacts,
  type ConflictStrategy,
  type PerPathResolveStrategy
} from "../sync/synchronize.js";
import { uuidV7 } from "../project/uuid-v7.js";
import { synchronizeProjectRules } from "../project/project-rules.js";

export class UpdateWorkflowError extends Error {
  readonly exitCode: 3 | 4 | 5 | 7 | 8;
  readonly code: string;

  constructor(message: string, exitCode: 3 | 4 | 5 | 7 | 8, code: string) {
    super(message);
    this.name = "UpdateWorkflowError";
    this.exitCode = exitCode;
    this.code = code;
  }
}

export interface UpdateProjectOptions {
  projectRoot: string;
  serverUrl?: string;
  tokenEnv?: string;
  env: Readonly<Record<string, string | undefined>>;
  dryRun: boolean;
  fetch?: typeof globalThis.fetch;
  transactionOptions?: Omit<TransactionOptions, "id">;
  conflictStrategy?: ConflictStrategy;
  resolveOverrides?: ReadonlyMap<string, PerPathResolveStrategy>;
  confirmConflictStrategy?: (
    conflicts: readonly RebaseConflict[]
  ) => Promise<ConflictStrategy | false>;
}

export interface UpdateProjectResult {
  requestId: string;
  projectId: string;
  artifactId: string | null;
  observedProjectVersion: string | null;
  operations: readonly FileOperation[];
  applied: string[];
  acknowledged: UpdateConflict[];
  resolvedKeepLocal: string[];
  resolvedAcceptRemote: string[];
  alreadyApplied: string[];
  conflicts: RebaseConflict[];
  skipped: UpdateConflict[];
  transactionId: string | null;
  dryRun: boolean;
  baselineAdvanced: boolean;
}

export async function updateProject(
  options: UpdateProjectOptions
): Promise<UpdateProjectResult> {
  const root = resolve(options.projectRoot);
  let project;
  try {
    project = projectConfigSchema.parse(parseYaml(
      await readFile(join(root, ".harness", "project.yaml"), "utf8")
    ));
  } catch {
    throw new UpdateWorkflowError("project configuration is invalid", 3, "PROJECT_CONFIG_INVALID");
  }
  if (project.project.project_id === null) {
    throw new UpdateWorkflowError("project is not bound to a server", 3, "PROJECT_NOT_BOUND");
  }
  const tokenEnv = options.tokenEnv ?? project.server.token_env;
  if (!/^[A-Z_][A-Z0-9_]*$/.test(tokenEnv)) {
    throw new UpdateWorkflowError("token_env is invalid", 3, "TOKEN_ENV_INVALID");
  }
  const local = await readLocalCredentials(root);
  const serverUrl = options.serverUrl ?? local?.server_url ?? project.server.url;
  if (serverUrl === null || serverUrl === undefined) {
    throw new UpdateWorkflowError("server_url is required", 3, "SERVER_URL_REQUIRED");
  }
  const envToken = options.env[tokenEnv]?.trim();
  const localToken = local?.token?.trim();
  const token = envToken !== undefined && envToken !== ""
    ? envToken
    : localToken !== undefined && localToken !== ""
      ? localToken
      : undefined;
  if (token === undefined) {
    throw new UpdateWorkflowError(
      `API token 未配置：请设置环境变量 ${tokenEnv}，或在 .harness/credentials.local.yaml 配置 token（可通过 npx hunter-harness push 引导写入）`,
      8,
      "TOKEN_INVALID"
    );
  }
  const requestId = uuidV7();
  const baseline = await readBaseline(root);
  let parsedServerUrl: URL;
  try {
    parsedServerUrl = new URL(serverUrl);
  } catch {
    throw new UpdateWorkflowError("server_url is invalid", 3, "SERVER_URL_INVALID");
  }
  if (parsedServerUrl.protocol !== "https:") {
    throw new UpdateWorkflowError("server_url must use HTTPS", 3, "SERVER_URL_INVALID");
  }
  const client = new HunterHarnessApiClient({
    serverUrl: parsedServerUrl.toString(),
    token,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch })
  });
  try {
    const result = await synchronizeArtifacts({
      projectRoot: root,
      project,
      client,
      requestId,
      dryRun: options.dryRun,
      ...(options.conflictStrategy === undefined
        ? {}
        : { conflictStrategy: options.conflictStrategy }),
      ...(options.resolveOverrides === undefined
        ? {}
        : { resolveOverrides: options.resolveOverrides }),
      ...(options.confirmConflictStrategy === undefined
        ? {}
        : { confirmConflictStrategy: options.confirmConflictStrategy }),
      ...(options.transactionOptions === undefined
        ? {}
        : { transactionOptions: options.transactionOptions })
    }, baseline);
    if (!options.dryRun) {
      const agents = project.adapters.enabled.flatMap((agent) => {
        const parsed = harnessAgentSchema.safeParse(agent);
        return parsed.success ? [parsed.data] : [];
      });
      await synchronizeProjectRules(
        root,
        agents,
        project.adapter_options?.codebuddy?.surface ?? "both"
      );
    }
    return result;
  } catch (error) {
    if (error instanceof UpdateWorkflowError) {
      throw error;
    }
    if (error instanceof ApiError) {
      throw new UpdateWorkflowError(
        error.message,
        error.status === 401 || error.status === 403 ? 8 : error.status === 409 ? 5 : 4,
        error.code
      );
    }
    if (error instanceof Error && error.message === "ARTIFACT_HASH_MISMATCH") {
      throw new UpdateWorkflowError("artifact blob size or hash mismatch", 4, "ARTIFACT_HASH_MISMATCH");
    }
    if (error instanceof Error && error.name === "ZodError") {
      throw new UpdateWorkflowError("artifact schema validation failed", 7, "SCHEMA_VALIDATION_FAILED");
    }
    if (error instanceof Error && error.message.startsWith("DUPLICATE_ARTIFACT_ID")) {
      throw new UpdateWorkflowError(error.message, 4, "DUPLICATE_ARTIFACT_ID");
    }
    if (error instanceof Error && error.message === "MAX_SYNC_ARTIFACT_ITERATIONS_EXCEEDED") {
      throw new UpdateWorkflowError(error.message, 4, "SYNC_ITERATION_LIMIT");
    }
    throw new UpdateWorkflowError(
      error instanceof Error ? error.message : "update failed",
      4,
      "NETWORK_OR_SERVER_ERROR"
    );
  }
}
