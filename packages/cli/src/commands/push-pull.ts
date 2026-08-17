import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { isProxy } from "node:util/types";

import {
  uuidV7,
  type ArchiveOutboxClaim,
  type ArchiveRetentionPolicy,
  RemoteSyncError,
  type SourceRef
} from "@hunter-harness/core";
import { remoteSyncHttpErrorCodeSchema } from "@hunter-harness/contracts";

import { serializeCliResult, type CliResult } from "../output/json.js";
import type {
  PushPullCliPort,
  PushPullCliRequest,
  PushPullCliResult
} from "../push-pull-adapter/index.js";
import type { CommandDependencies } from "./configure.js";
import { detectProject } from "./refresh.js";

const execFileAsync = promisify(execFile);

export interface PushPullCommandOptions {
  scope?: string;
  branch?: string;
  change?: string;
  resolve?: string[];
  dryRun?: boolean;
  yes?: boolean;
  json?: boolean;
  nonInteractive?: boolean;
}

export interface ArchivePublishInput {
  claim: ArchiveOutboxClaim;
  source_ref: SourceRef;
  retention_policy: ArchiveRetentionPolicy;
}

export interface PushPullCommandDependencies extends CommandDependencies {
  pushPull: PushPullCliPort;
  pushPullSource: (input: Readonly<{
    direction: "push" | "pull";
    branch?: string;
  }>) => Promise<SourceRef>;
  pushPullArchive: ((change: string) => Promise<ArchivePublishInput>) | undefined;
}

const USER_SCOPES = new Set([
  "all", "config", "rules", "architecture", "instructions", "branch_files", "archive"
]);
const RESOLUTIONS = new Map([
  ["keep-local", "keep_local"],
  ["keep_local", "keep_local"],
  ["accept-remote", "accept_remote"],
  ["accept_remote", "accept_remote"],
  ["skip", "skip"]
] as const);

function safeErrorCode(error: unknown): string {
  try {
    if (error === null || (typeof error !== "object" && typeof error !== "function")) {
      return "PUSH_PULL_FAILED";
    }
    if (isProxy(error)) return "PUSH_PULL_FAILED";
    let owner: object | null = error as object;
    for (let depth = 0; owner !== null && depth < 8; depth += 1) {
      const code = Object.getOwnPropertyDescriptor(owner, "code");
      if (code !== undefined) {
        if (!(
          "value" in code && typeof code.value === "string"
        )) return "PUSH_PULL_FAILED";
        if (/^PUSH_PULL_[A-Z0-9_]+$/.test(code.value) ||
            remoteSyncHttpErrorCodeSchema.safeParse(code.value).success) {
          return code.value;
        }
        return "PUSH_PULL_FAILED";
      }
      owner = Object.getPrototypeOf(owner) as object | null;
    }
    const message = Object.getOwnPropertyDescriptor(error, "message");
    if (message !== undefined && "value" in message && typeof message.value === "string" &&
        (/^PUSH_PULL_[A-Z0-9_]+$/.test(message.value) ||
          remoteSyncHttpErrorCodeSchema.safeParse(message.value).success)) {
      return message.value;
    }
    return "PUSH_PULL_FAILED";
  } catch {
    return "PUSH_PULL_FAILED";
  }
}

export async function resolvePushPullSource(
  root: string,
  input: Readonly<{ direction: "push" | "pull"; branch?: string }>
): Promise<SourceRef> {
  const detection = await detectProject(root);
  if (detection.status !== "valid" || detection.config.project.project_id === null) {
    throw new Error("PUSH_PULL_PROJECT_NOT_BOUND");
  }
  const commit = (await execFileAsync("git", ["rev-parse", "HEAD"], {
    cwd: root, windowsHide: true, encoding: "utf8"
  })).stdout.trim();
  const currentBranch = input.branch ?? (await execFileAsync(
    "git", ["branch", "--show-current"], { cwd: root, windowsHide: true, encoding: "utf8" }
  )).stdout.trim();
  if (commit === "" || currentBranch === "") throw new Error("PUSH_PULL_GIT_IDENTITY_REQUIRED");
  return {
    project_id: detection.config.project.project_id,
    branch_name: currentBranch,
    commit_sha: commit,
    // remoteSyncSourceRefSchema requires client_id to start with `cli_`;
    // local_project_key is a UUID, so prefix it here. Server echoes this back
    // in source refs, so the same shape round-trips into sameHttpSource checks.
    client_id: `cli_${detection.config.project.local_project_key}`
  };
}

function parseScopes(value: string | undefined): string[] {
  const scopes = (value ?? "all").split(",").map((item) => item.trim());
  if (scopes.some((scope) => scope === "" || !USER_SCOPES.has(scope))) {
    throw new Error("PUSH_PULL_SCOPE_INVALID");
  }
  return [...new Set(scopes)];
}

function parseExplicitResolutions(values: readonly string[] | undefined): Map<string, string> {
  const result = new Map<string, string>();
  for (const value of values ?? []) {
    const separator = value.lastIndexOf("=");
    const path = separator < 1 ? "" : value.slice(0, separator).trim();
    const raw = separator < 1 ? "" : value.slice(separator + 1).trim();
    const resolution = RESOLUTIONS.get(raw as never);
    if (path === "" || resolution === undefined || result.has(path)) {
      throw new Error("PUSH_PULL_RESOLUTION_INVALID");
    }
    result.set(path, resolution);
  }
  return result;
}

function cliOutput(
  command: "push" | "pull",
  projectId: string,
  dryRun: boolean,
  response: PushPullCliResult
): CliResult {
  if (response.operation === "preview") {
    return {
      schema_version: 1, command, request_id: uuidV7(), dry_run: dryRun,
      ok: true, exit_code: 0, project_id: projectId,
      summary: {
        planned: response.result.operations.length + response.result.conflicts.length,
        applied: 0,
        conflicts: response.result.conflicts.length
      },
      items: [
        ...response.result.operations.map((item) => ({ ...item, status: "planned" })),
        ...response.result.conflicts.map((item) => ({ ...item, status: "conflict" }))
      ],
      warnings: [], errors: [], preview_hash: response.result.preview_hash,
      outcome: response.result.outcome
    };
  }
  if (response.operation === "confirm") {
    const exitCode = response.result.status === "cancelled" ? 2
      : response.result.status === "review_required" ? 5 : 0;
    return {
      schema_version: 1, command, request_id: uuidV7(), dry_run: false,
      ok: exitCode === 0, exit_code: exitCode, project_id: projectId,
      summary: { status: response.result.status }, items: [], warnings: [], errors: [],
      preview_hash: response.result.preview_hash
    };
  }
  if (response.operation === "execute") {
    const receipt = response.result.sync_receipt;
    const exitCode = response.retry.retryable ? 4 : 0;
    return {
      schema_version: 1, command, request_id: uuidV7(), dry_run: false,
      ok: exitCode === 0, exit_code: exitCode, project_id: projectId,
      summary: {
        applied: receipt.applied.length,
        skipped: receipt.skipped.length,
        retryable: receipt.retryable.length,
        status: response.result.status
      },
      items: [
        ...receipt.applied.map((item) => ({ ...item, status: "applied" })),
        ...receipt.skipped.map((item) => ({ ...item, status: "skipped" })),
        ...receipt.retryable.map((item) => ({ ...item, status: "retryable" }))
      ],
      warnings: response.retry.reason_code === null ? [] : [response.retry.reason_code],
      errors: [], preview_hash: response.verification.preview_hash
    };
  }
  throw new Error("PUSH_PULL_CLI_OUTPUT_INVALID");
}

function renderDisplay(response: PushPullCliResult): string {
  if (response.operation === "archive_publish") {
    return response.result.outcome === "stored"
      ? "归档包已上传到 Hunter Platform。\n"
      : `归档包未上传：${response.retry.reason_code ?? response.result.outcome}。\n`;
  }
  const detailLines = response.operation === "preview" && response.direction === "pull" &&
    response.result.remote_version !== undefined
    ? [
        ...response.result.display_zh.detail_lines.filter((line) =>
          !line.startsWith("来源分支：") && !line.startsWith("来源提交：") &&
          !line.startsWith("来源项目版本：")),
        `来源分支：${response.result.remote_version.branch_name}`,
        `来源项目版本：${response.result.remote_version.project_version}`,
        `来源提交：${response.result.remote_version.commit_sha}`
      ]
    : response.result.display_zh.detail_lines;
  return [
    response.result.display_zh.heading,
    response.result.display_zh.summary,
    ...detailLines
  ].join("\n") + "\n";
}

async function confirmed(
  direction: "push" | "pull",
  options: PushPullCommandOptions,
  dependencies: PushPullCommandDependencies,
  preview: Extract<PushPullCliResult, { operation: "preview" }>
): Promise<Extract<PushPullCliResult, { operation: "confirm" }>> {
  const explicit = parseExplicitResolutions(options.resolve);
  const choices: Array<{
    path: string;
    resolution: "keep_local" | "accept_remote" | "skip";
    source_artifact_id?: string;
    source_project_version?: string;
  }> = [];
  const eligible = [
    ...preview.result.conflicts.map((item) => item.path),
    ...preview.result.operations.filter((item) => item.action === "restore").map((item) => item.path)
  ];
  for (const path of eligible) {
    let resolution = explicit.get(path) as "keep_local" | "accept_remote" | "skip" | undefined;
    const isConflict = preview.result.conflicts.some((item) => item.path === path);
    if (resolution === undefined && isConflict && options.nonInteractive === true) {
      throw new Error("PUSH_PULL_DECISION_REQUIRED");
    }
    if (resolution === undefined && isConflict) {
      const answer = (await dependencies.prompt(
        `冲突 ${path}：1 保留本地，2 接受远端，3 跳过，0 取消 [0]：`
      )).trim();
      resolution = answer === "1" ? "keep_local" : answer === "2" ? "accept_remote"
        : answer === "3" ? "skip" : undefined;
      if (resolution === undefined) {
        return dependencies.pushPull.dispatch({
          schema_version: 1, operation: "confirm", direction,
          preview_hash: preview.result.preview_hash,
          decision: { action: "stop", idempotency_key: uuidV7(), conflict_decisions: [] }
        }) as Promise<Extract<PushPullCliResult, { operation: "confirm" }>>;
      }
    }
    // A local deletion remains intentional by default. Restore only on an explicit choice.
    if (resolution === undefined) continue;
    const restore = preview.result.operations.some((item) => item.action === "restore" && item.path === path);
    choices.push({ path, resolution,
      ...(restore && resolution === "accept_remote" && preview.result.remote_version !== undefined
        ? {
            source_artifact_id: preview.result.remote_version.artifact_id,
            source_project_version: preview.result.remote_version.project_version
          } : {}) });
  }
  for (const path of explicit.keys()) {
    if (!eligible.includes(path)) throw new Error("PUSH_PULL_RESOLUTION_INVALID");
  }

  if (preview.result.security_scan.hard_blocked) throw new Error("PUSH_PULL_SENSITIVE_HARD_BLOCKED");
  let scan_overrides: Array<{ finding_fingerprint: string; actor: string; reason: string }> | undefined;
  if (preview.result.outcome === "sensitive_confirmation_required") {
    if (options.nonInteractive === true) throw new Error("PUSH_PULL_SENSITIVE_CONFIRMATION_REQUIRED");
    const answer = (await dependencies.prompt("检测到可覆盖的敏感项，确认上传？[y/N]：")).trim();
    if (!/^(?:y|yes)$/i.test(answer)) {
      return dependencies.pushPull.dispatch({
        schema_version: 1, operation: "confirm", direction,
        preview_hash: preview.result.preview_hash,
        decision: { action: "stop", idempotency_key: uuidV7(), conflict_decisions: choices }
      }) as Promise<Extract<PushPullCliResult, { operation: "confirm" }>>;
    }
    const reason = (await dependencies.prompt("确认原因（必填）：")).trim();
    if (reason === "") throw new Error("PUSH_PULL_SENSITIVE_REASON_REQUIRED");
    scan_overrides = preview.result.security_scan.findings
      .filter((finding) => finding.overridable)
      .map((finding) => ({
        finding_fingerprint: finding.fingerprint,
        actor: "cli_operator",
        reason
      }));
  }

  let action: "continue" | "stop" = "continue";
  if (options.yes !== true) {
    if (options.nonInteractive === true) throw new Error("PUSH_PULL_CONFIRMATION_REQUIRED");
    const answer = (await dependencies.prompt(
      direction === "push" ? "确认上传到 Hunter Platform？[y/N]：" : "确认应用 Pull 结果？[y/N]："
    )).trim();
    if (!/^(?:y|yes)$/i.test(answer)) action = "stop";
  }
  return dependencies.pushPull.dispatch({
    schema_version: 1, operation: "confirm", direction,
    preview_hash: preview.result.preview_hash,
    decision: {
      action,
      idempotency_key: uuidV7(),
      conflict_decisions: choices,
      ...(scan_overrides === undefined ? {} : { scan_overrides })
    }
  }) as Promise<Extract<PushPullCliResult, { operation: "confirm" }>>;
}

async function runArchive(
  options: PushPullCommandOptions,
  dependencies: PushPullCommandDependencies
): Promise<number> {
  if (options.change === undefined || options.change.trim() === "") {
    throw new Error("PUSH_PULL_ARCHIVE_CHANGE_REQUIRED");
  }
  // The frozen Archive seam requires a live outbox claim. Until a separate
  // read-only inspection Interface exists, dry-run must not acquire a lease.
  if (options.dryRun === true) throw new Error("PUSH_PULL_ARCHIVE_UNAVAILABLE");
  if (dependencies.pushPullArchive === undefined) throw new Error("PUSH_PULL_ARCHIVE_UNAVAILABLE");
  const input = await dependencies.pushPullArchive(options.change.trim());
  if (options.yes !== true) {
    if (options.nonInteractive === true) throw new Error("PUSH_PULL_CONFIRMATION_REQUIRED");
    if (!/^(?:y|yes)$/i.test((await dependencies.prompt(
      `确认上传既有归档包 ${options.change}？[y/N]：`
    )).trim())) return 2;
  }
  const response = await dependencies.pushPull.dispatch({
    schema_version: 1, operation: "archive_publish", ...input
  } as PushPullCliRequest);
  if (response.operation !== "archive_publish") throw new Error("PUSH_PULL_CLI_OUTPUT_INVALID");
  const exitCode = response.retry.retryable ? 4 : response.result.outcome === "stored" ? 0 : 5;
  if (options.json === true) {
    dependencies.stdout(serializeCliResult({
      schema_version: 1,
      command: "push",
      request_id: uuidV7(),
      dry_run: false,
      ok: exitCode === 0,
      exit_code: exitCode,
      project_id: input.source_ref.project_id,
      summary: { status: response.result.outcome },
      items: [response.result],
      warnings: response.retry.retryable && response.retry.reason_code !== null
        ? [response.retry.reason_code] : [],
      errors: exitCode === 5
        ? [{ code: response.retry.reason_code ?? "ARCHIVE_PUBLISH_FAILED",
            message: "归档包未上传" }] : []
    }));
  } else dependencies.stdout(renderDisplay(response));
  return exitCode;
}

export async function runPushPull(
  direction: "push" | "pull",
  options: PushPullCommandOptions,
  dependencies: PushPullCommandDependencies
): Promise<number> {
  try {
    const scopes = parseScopes(options.scope);
    if (scopes.includes("archive")) {
      if (direction !== "push" || scopes.length !== 1) throw new Error("PUSH_PULL_ARCHIVE_ROUTE_REQUIRED");
      return await runArchive(options, dependencies);
    }
    if (options.change !== undefined) throw new Error("PUSH_PULL_ARCHIVE_ROUTE_REQUIRED");
    if (direction === "pull" && scopes.includes("branch_files") && options.branch === undefined) {
      throw new Error("PUSH_PULL_SOURCE_REQUIRED");
    }
    const source_ref = await dependencies.pushPullSource({
      direction,
      ...(options.branch === undefined ? {} : { branch: options.branch })
    });
    const response = await dependencies.pushPull.dispatch({
      schema_version: 1, operation: "preview", direction,
      interaction: {
        schema_version: 1, source_ref,
        source_mode: options.branch === undefined ? "current" : "explicit",
        scopes: scopes as never
      }
    });
    if (response.operation !== "preview" || response.direction !== direction) {
      throw new Error("PUSH_PULL_CLI_OUTPUT_INVALID");
    }
    if (options.dryRun === true || response.result.outcome === "no_changes") {
      dependencies.stdout(options.json === true
        ? serializeCliResult(cliOutput(direction, source_ref.project_id, options.dryRun === true, response))
        : renderDisplay(response));
      return 0;
    }
    if (options.json !== true) dependencies.stdout(renderDisplay(response));
    const confirmation = await confirmed(direction, options, dependencies, response);
    if (confirmation.operation !== "confirm" || confirmation.direction !== direction ||
        confirmation.result.preview_hash !== response.result.preview_hash) {
      throw new Error("PUSH_PULL_CLI_OUTPUT_INVALID");
    }
    if (confirmation.result.status !== "confirmed") {
      dependencies.stdout(options.json === true
        ? serializeCliResult(cliOutput(direction, source_ref.project_id, false, confirmation))
        : renderDisplay(confirmation));
      return confirmation.result.status === "cancelled" ? 2
        : confirmation.result.status === "review_required" ? 5 : 0;
    }
    let attempts = 0;
    for (;;) {
      const execution = await dependencies.pushPull.dispatch({
        schema_version: 1, operation: "execute", direction,
        confirmation_id: confirmation.result.confirmation_id
      });
      if (execution.operation !== "execute" || execution.direction !== direction ||
          execution.verification.preview_hash !== response.result.preview_hash) {
        throw new Error("PUSH_PULL_CLI_OUTPUT_INVALID");
      }
      if (!execution.retry.retryable || options.nonInteractive === true || attempts >= 2) {
        dependencies.stdout(options.json === true
          ? serializeCliResult(cliOutput(direction, source_ref.project_id, false, execution))
          : renderDisplay(execution));
        return execution.retry.retryable ? 4 : 0;
      }
      dependencies.stderr(`网络暂不可用：${execution.retry.reason_code ?? "REMOTE_UNAVAILABLE"}。\n`);
      if (!/^(?:y|yes)$/i.test((await dependencies.prompt("是否重试同一确认收据？[y/N]：")).trim())) {
        dependencies.stdout(options.json === true
          ? serializeCliResult(cliOutput(direction, source_ref.project_id, false, execution))
          : renderDisplay(execution));
        return 4;
      }
      attempts += 1;
    }
  } catch (error) {
    if (process.env.HUNTER_DEBUG_HTTP === "1" && error instanceof Error) {
      console.error("[hunter-push] uncaught: " + error.message);
      console.error((error.stack ?? "").split("\n").slice(0, 12).join("\n"));
    }
    const code = safeErrorCode(error);
    const retryable = error instanceof RemoteSyncError && error.retryable ||
      code === "REMOTE_UNAVAILABLE" || code === "SYNC_LOCK_UNAVAILABLE" ||
      code === "SYNC_LEASE_BUSY" || code === "SYNC_COMMIT_AMBIGUOUS" ||
      code === "SYNC_STREAM_ABORTED";
    const exitCode = retryable || code.includes("UNAVAILABLE") ? 4
      : code.includes("CONFIRMATION_REQUIRED") ? 2
        : code.includes("DECISION_REQUIRED") ? 5
          : code.includes("SENSITIVE") ? 6 : 3;
    const serverCode = error instanceof RemoteSyncError ? error.serverCode : undefined;
    const detail = serverCode === undefined ? "" : `（服务端返回：${serverCode}）`;
    dependencies.stderr(`${code}${detail}：Push/Pull 命令未执行。\n`);
    if (options.json === true) dependencies.stdout(serializeCliResult({
      schema_version: 1, command: direction, request_id: uuidV7(),
      dry_run: options.dryRun === true, ok: false,
      exit_code: exitCode,
      project_id: null, summary: { planned: 0, applied: 0 }, items: [], warnings: [],
      errors: [{ code, message: "Push/Pull 命令未执行", ...(serverCode === undefined ? {} : { server_code: serverCode }) }]
    }));
    return exitCode;
  }
}
