import { lstat, readFile, readdir, rm } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

import {
  artifactManifestSchema,
  baselineManifestSchema,
  canonicalJson,
  harnessAgentSchema,
  projectConfigSchema,
  type BaselineManifest,
  type HarnessAgent,
  type ProjectConfig
} from "@hunter-harness/contracts";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

import { ApiError, HunterHarnessApiClient } from "../api/client.js";
import { sha256Bytes } from "../fs/hash.js";
import { normalizeManagedPath } from "../fs/path-safety.js";
import {
  generateProposalPreview
} from "../proposal/preview.js";
import type { ProposalBaselineEntry } from "../proposal/diff.js";
import {
  readLocalCredentials,
  resolvePushAuth
} from "./credentials.js";
import type { SensitiveFinding } from "../security/scanner.js";
import {
  managedBundleTargets,
  parseHarnessProfile
} from "../project/profile-bundle.js";
import { getAdapters } from "../project/agent-adapters.js";
import { uuidV7 } from "../project/uuid-v7.js";
import { atomicWriteJson } from "../state/atomic.js";
import { readBaseline } from "../state/baseline.js";
import { acquireProtocolLock } from "../state/locks.js";
import { runTransaction } from "../transaction/transaction.js";
import {
  advanceBaselineFromArtifact,
  synchronizeArtifacts
} from "../sync/synchronize.js";
import type { RebaseConflict } from "../sync/artifact-rebase.js";

export interface SensitiveFindingSummary {
  path: string;
  rule_id: string;
  severity: string;
  overridable: boolean;
  fingerprint: string;
  line: number;
  column: number;
}

export interface PushWorkflowErrorDetails {
  findings?: SensitiveFindingSummary[];
  finding_count?: number;
  scanner_version?: string;
  missing_credentials?: Array<"url" | "token">;
}

export class PushWorkflowError extends Error {
  readonly exitCode: 3 | 4 | 5 | 6 | 7 | 8;
  readonly code: string;
  readonly details?: PushWorkflowErrorDetails;

  constructor(
    message: string,
    exitCode: 3 | 4 | 5 | 6 | 7 | 8,
    code: string,
    details?: PushWorkflowErrorDetails
  ) {
    super(message);
    this.name = "PushWorkflowError";
    this.exitCode = exitCode;
    this.code = code;
    if (details !== undefined) {
      this.details = details;
    }
  }
}

export interface PushProjectOptions {
  projectRoot: string;
  resourcesRoot: string;
  serverUrl?: string;
  tokenEnv?: string;
  env: Readonly<Record<string, string | undefined>>;
  clientId?: string;
  dryRun: boolean;
  confirmedProjectLocal?: readonly string[];
  fetch?: typeof globalThis.fetch;
  confirmProposal?: (preview: ReturnType<typeof generateProposalPreview>) => Promise<boolean>;
  sensitiveScanSkip?: boolean;
  sensitiveScanSkipReason?: string;
  confirmSensitiveScanSkip?: (
    preview: ReturnType<typeof generateProposalPreview>
  ) => Promise<{ skip: boolean; reason?: string } | "cancelled">;
}

interface PushWorkflowState {
  schema_version: 1;
  local_project_key: string;
  project_id: string | null;
  request_id: string;
  created_at: string;
  client_id: string;
  resolve_idempotency_key: string;
  proposal_manifest_hash: string | null;
  session_id: string | null;
  session_expires_at: string | null;
  max_chunk_bytes: number | null;
  session_idempotency_key: string;
  query_idempotency_key: string;
  finalize_idempotency_key: string;
  chunk_idempotency_keys: Record<string, string>;
}

const SHARED_MANAGED_ROOTS = [
  ".harness/knowledge",
  ".harness/codebase"
];
const SHARED_MANAGED_FILES = [
  "AGENTS.md",
  ".harness/project.yaml",
  ".harness/context-index.json"
];

// init 写入的已安装 Harness Bundle 清单：记录 Bundle 安装的受管文件路径。
// push 对这些文件豁免敏感扫描（Harness 自有文件含教学示例，非用户引入的 secret），
// 但仍照常 propose（diff-proposal 不变）。
async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function walkFiles(root: string, current: string, output: string[]): Promise<void> {
  if (!await exists(current)) {
    return;
  }
  for (const item of await readdir(current, { withFileTypes: true })) {
    const path = join(current, item.name);
    if (item.isSymbolicLink()) {
      throw new PushWorkflowError("symlink is not pushable", 6, "UNSAFE_SYMLINK");
    }
    if (item.isDirectory()) {
      await walkFiles(root, path, output);
    } else if (item.isFile()) {
      output.push(normalizeManagedPath(relative(root, path).replaceAll("\\", "/")));
    }
  }
}

function enabledHarnessAgents(project: ProjectConfig): HarnessAgent[] {
  return project.adapters.enabled.flatMap((agent) => {
    const parsed = harnessAgentSchema.safeParse(agent);
    return parsed.success ? [parsed.data] : [];
  });
}

async function walkHarnessEntries(
  root: string,
  directory: string,
  output: string[]
): Promise<void> {
  if (!await exists(directory)) return;
  for (const item of await readdir(directory, { withFileTypes: true })) {
    if (item.name.startsWith("harness-")) {
      const path = join(directory, item.name);
      if (item.isDirectory()) {
        await walkFiles(root, path, output);
      } else if (item.isFile()) {
        output.push(normalizeManagedPath(relative(root, path).replaceAll("\\", "/")));
      }
    }
  }
}

async function managedFiles(
  projectRoot: string,
  project: ProjectConfig
): Promise<Record<string, string>> {
  const root = resolve(projectRoot);
  const paths = [];
  const adapters = getAdapters(enabledHarnessAgents(project));
  const managedFiles = [
    ...SHARED_MANAGED_FILES,
    ...(adapters.some((adapter) => adapter.name === "claude-code") ? ["CLAUDE.md"] : []),
    ...(adapters.some((adapter) => adapter.name === "codebuddy") ? ["CODEBUDDY.md"] : [])
  ];
  for (const path of managedFiles) {
    if (await exists(join(root, path))) {
      paths.push(path);
    }
  }
  for (const path of SHARED_MANAGED_ROOTS) {
    await walkFiles(root, join(root, path), paths);
  }
  for (const adapter of adapters) {
    if (adapter.rulesRoot !== null) {
      await walkFiles(root, join(root, adapter.rulesRoot), paths);
    }
    await walkHarnessEntries(root, join(root, adapter.skillsRoot), paths);
    if (adapter.agentsRoot !== null) {
      await walkHarnessEntries(root, join(root, adapter.agentsRoot), paths);
    }
  }
  const result: Record<string, string> = {};
  for (const path of [...new Set(paths)].sort()) {
    result[path] = await readFile(join(root, path), "utf8");
  }
  return result;
}

function proposalBaseline(baseline: BaselineManifest): Record<string, ProposalBaselineEntry> {
  return Object.fromEntries(Object.entries(baseline.files)
    .filter(([, entry]) => entry.baseline_hash !== null && !entry.deleted)
    .map(([path, entry]) => [path, { content_sha256: entry.baseline_hash ?? "" }]));
}

async function readProject(root: string): Promise<ProjectConfig> {
  try {
    return projectConfigSchema.parse(parseYaml(
      await readFile(join(root, ".harness", "project.yaml"), "utf8")
    ));
  } catch {
    throw new PushWorkflowError(
      "project configuration is missing or invalid",
      3,
      "PROJECT_CONFIG_INVALID"
    );
  }
}

async function readOptionalJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function clientIdFor(root: string, explicit?: string): Promise<string> {
  if (explicit !== undefined) {
    return explicit;
  }
  const path = join(root, ".harness", "state", "local", "client.json");
  const existing = await readOptionalJson<{ client_id?: unknown }>(path);
  if (typeof existing?.client_id === "string" && /^cli_[A-Za-z0-9_-]+$/.test(
    existing.client_id
  )) {
    return existing.client_id;
  }
  const clientId = "cli_" + uuidV7().replaceAll("-", "");
  await atomicWriteJson(path, {
    schema_version: 1,
    client_id: clientId,
    created_at: new Date().toISOString()
  });
  return clientId;
}

function newWorkflowState(project: ProjectConfig, clientId: string): PushWorkflowState {
  return {
    schema_version: 1,
    local_project_key: project.project.local_project_key,
    project_id: project.project.project_id,
    request_id: uuidV7(),
    created_at: new Date().toISOString(),
    client_id: clientId,
    resolve_idempotency_key: uuidV7(),
    proposal_manifest_hash: null,
    session_id: null,
    session_expires_at: null,
    max_chunk_bytes: null,
    session_idempotency_key: uuidV7(),
    query_idempotency_key: uuidV7(),
    finalize_idempotency_key: uuidV7(),
    chunk_idempotency_keys: {}
  };
}

function resetSession(
  state: PushWorkflowState,
  proposalManifestHash: string
): PushWorkflowState {
  return {
    ...state,
    proposal_manifest_hash: proposalManifestHash,
    session_id: null,
    session_expires_at: null,
    max_chunk_bytes: null,
    session_idempotency_key: uuidV7(),
    query_idempotency_key: uuidV7(),
    finalize_idempotency_key: uuidV7(),
    chunk_idempotency_keys: {}
  };
}

function summarizeFindings(
  security: { findings: readonly SensitiveFinding[]; scanner_version: string }
): PushWorkflowErrorDetails {
  const blocked = security.findings.filter((finding) => finding.disposition === "blocked");
  return {
    findings: blocked.map((finding) => ({
      path: finding.path,
      rule_id: finding.rule_id,
      severity: finding.severity,
      overridable: finding.overridable,
      fingerprint: finding.fingerprint,
      line: finding.line,
      column: finding.column
    })),
    finding_count: blocked.length,
    scanner_version: security.scanner_version
  };
}

function sensitiveBlockedError(
  preview: ReturnType<typeof generateProposalPreview>
): PushWorkflowError {
  return new PushWorkflowError(
    "sensitive information scan blocked the proposal",
    6,
    "SENSITIVE_CONTENT_BLOCKED",
    summarizeFindings(preview.security)
  );
}

async function resolveSensitiveScanSkip(
  preview: ReturnType<typeof generateProposalPreview>,
  options: PushProjectOptions
): Promise<{ skip: boolean; reason?: string; cancelled?: boolean }> {
  if (!preview.blocked) {
    return { skip: false };
  }
  if (options.sensitiveScanSkip === true) {
    return {
      skip: true,
      ...(options.sensitiveScanSkipReason === undefined
        ? {}
        : { reason: options.sensitiveScanSkipReason })
    };
  }
  if (options.confirmSensitiveScanSkip !== undefined) {
    const answer = await options.confirmSensitiveScanSkip(preview);
    if (answer === "cancelled") {
      return { skip: false, cancelled: true };
    }
    return answer.skip
      ? { skip: true, ...(answer.reason === undefined ? {} : { reason: answer.reason }) }
      : { skip: false };
  }
  throw sensitiveBlockedError(preview);
}

function assertPreviewAllowed(
  preview: ReturnType<typeof generateProposalPreview>,
  skip: boolean
): void {
  if (preview.blocked && !skip) {
    throw sensitiveBlockedError(preview);
  }
}

const CREDENTIALS_HINT =
  "可在交互模式下录入，或写入 .harness/credentials.local.yaml（勿提交 git）";

const STALE_BASELINE_MESSAGE =
  "服务端 artifact 已更新，请先执行 npx hunter-harness update（冲突可用 update --resolve <path>=keep-local|accept-remote）再推";

function staleBaselineError(
  code: "STALE_PUSH" | "PROJECT_VERSION_CONFLICT",
  conflicts?: readonly RebaseConflict[]
): PushWorkflowError {
  const conflictHint = conflicts !== undefined && conflicts.length > 0
    ? " 冲突文件：" + conflicts.map((item) => item.path).join(", ")
    : "";
  return new PushWorkflowError(STALE_BASELINE_MESSAGE + conflictHint, 5, code);
}

async function syncToLatest(
  root: string,
  project: ProjectConfig,
  baseline: BaselineManifest,
  client: HunterHarnessApiClient
): Promise<BaselineManifest> {
  const syncResult = await synchronizeArtifacts({
    projectRoot: root,
    project,
    client,
    requestId: uuidV7(),
    dryRun: false,
    conflictStrategy: "manual"
  }, baseline);
  if (syncResult.conflicts.length > 0) {
    throw staleBaselineError("PROJECT_VERSION_CONFLICT", syncResult.conflicts);
  }
  return await readBaseline(root);
}

async function autoRebaseIfServerAdvanced(
  root: string,
  project: ProjectConfig,
  baseline: BaselineManifest,
  client: HunterHarnessApiClient,
  remoteVersion: string | null
): Promise<BaselineManifest> {
  if (remoteVersion === baseline.complete_project_version) {
    return baseline;
  }
  const updated = await syncToLatest(root, project, baseline, client);
  if (remoteVersion !== null &&
      updated.complete_project_version !== remoteVersion) {
    throw staleBaselineError("PROJECT_VERSION_CONFLICT");
  }
  return updated;
}

function makePreview(
  baseline: BaselineManifest,
  files: Record<string, string>,
  confirmedProjectLocal: readonly string[],
  ignorePaths: ReadonlySet<string>,
  deletedAt = new Date().toISOString()
) {
  // Harness Bundle 安装的文件是 adapter working copy（含教学示例与本地路径），
  // 不纳入服务端治理 proposal：既不上传也不扫描，避免教学 secret 触发 SENSITIVE_CONTENT_BLOCKED。
  // 其余受管文件（rules/knowledge/CLAUDE.md 等）照常 diff-proposal。
  const filteredFiles: Record<string, string> = {};
  for (const [path, content] of Object.entries(files)) {
    if (!ignorePaths.has(path)) filteredFiles[path] = content;
  }
  return generateProposalPreview({
    baseline: proposalBaseline(baseline),
    files: filteredFiles,
    deletedAt,
    deleteReason: "removed from local managed working copy",
    confirmedProjectLocal
  });
}

async function bindProject(
  root: string,
  project: ProjectConfig,
  baseline: BaselineManifest,
  projectId: string
): Promise<{ project: ProjectConfig; baseline: BaselineManifest }> {
  const nextProject = projectConfigSchema.parse({
    ...project,
    project: { ...project.project, project_id: projectId }
  });
  const nextBaseline = baselineManifestSchema.parse({
    ...baseline,
    project_id: projectId
  });
  await runTransaction(root, [
    {
      operation: "modify",
      path: ".harness/project.yaml",
      content: stringifyYaml(nextProject, { sortMapEntries: true })
    },
    {
      operation: "modify",
      path: ".harness/state/baseline/manifest.json",
      content: JSON.stringify(nextBaseline, null, 2) + "\n"
    }
  ]);
  return { project: nextProject, baseline: nextBaseline };
}

export async function pushProject(options: PushProjectOptions) {
  const root = resolve(options.projectRoot);
  let project = await readProject(root);
  let baseline = await readBaseline(root);
  const profile = parseHarnessProfile(project.project.profiles[0]);
  const installedPaths = profile === null
    ? new Set<string>()
    : new Set(await Promise.all(
      enabledHarnessAgents(project).map((agent) =>
        managedBundleTargets(options.resourcesRoot, profile, agent)
      )
    ).then((targets) => targets.flatMap((target) => [...target])));
  let preview = makePreview(
    baseline,
    await managedFiles(root, project),
    options.confirmedProjectLocal ?? [],
    installedPaths
  );
  if (options.dryRun) {
    const drySkip = await resolveSensitiveScanSkip(preview, options);
    if (drySkip.cancelled === true) {
      return { preview, proposalId: null, projectId: project.project.project_id, cancelled: true };
    }
    assertPreviewAllowed(preview, drySkip.skip);
    return { preview, proposalId: null, projectId: project.project.project_id };
  }
  const localCredentials = await readLocalCredentials(root);
  const auth = resolvePushAuth({
    ...(options.serverUrl === undefined ? {} : { serverUrlFlag: options.serverUrl }),
    ...(options.tokenEnv === undefined ? {} : { tokenEnv: options.tokenEnv }),
    env: options.env,
    local: localCredentials,
    projectUrl: project.server.url,
    projectTokenEnv: project.server.token_env
  });
  if ("code" in auth) {
    if (auth.code === "SERVER_URL_REQUIRED") {
      throw new PushWorkflowError(
        "server_url is required; use --server-url, project.yaml server.url, or " +
          CREDENTIALS_HINT,
        3,
        "SERVER_URL_REQUIRED",
        { missing_credentials: auth.missing }
      );
    }
    const tokenEnv = options.tokenEnv ?? project.server.token_env;
    throw new PushWorkflowError(
      "API token is unset; set " + tokenEnv + " or " + CREDENTIALS_HINT,
      8,
      "TOKEN_INVALID",
      { missing_credentials: auth.missing }
    );
  }
  const serverUrl = auth.serverUrl;
  const token = auth.token;
  const tokenEnv = options.tokenEnv ?? project.server.token_env;
  if (!/^[A-Z_][A-Z0-9_]*$/.test(tokenEnv)) {
    throw new PushWorkflowError("token_env is invalid", 3, "TOKEN_ENV_INVALID");
  }
  let parsedServerUrl: URL;
  try {
    parsedServerUrl = new URL(serverUrl);
  } catch {
    throw new PushWorkflowError("server_url is invalid", 3, "SERVER_URL_INVALID");
  }
  if (parsedServerUrl.protocol !== "https:") {
    throw new PushWorkflowError("server_url must use HTTPS", 3, "SERVER_URL_INVALID");
  }
  const client = new HunterHarnessApiClient({
    serverUrl: parsedServerUrl.toString(),
    token,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch })
  });
  // 仅对开始时已绑定的项目做预检；本轮 resolve 首次绑定不预检。
  const boundAtStart = project.project.project_id;
  if (boundAtStart !== null) {
    const remote = await client.getProject(boundAtStart, uuidV7());
    baseline = await autoRebaseIfServerAdvanced(
      root,
      project,
      baseline,
      client,
      remote.latest_project_version
    );
    preview = makePreview(
      baseline,
      await managedFiles(root, project),
      options.confirmedProjectLocal ?? [],
      installedPaths
    );
  }
  const initialSkip = await resolveSensitiveScanSkip(preview, options);
  if (initialSkip.cancelled === true) {
    return { preview, proposalId: null, projectId: project.project.project_id, cancelled: true };
  }
  let sensitiveScanSkip = initialSkip.skip;
  let sensitiveScanSkipReason = initialSkip.reason;
  assertPreviewAllowed(preview, sensitiveScanSkip);
  if (options.confirmProposal !== undefined && !await options.confirmProposal(preview)) {
    return { preview, proposalId: null, projectId: project.project.project_id, cancelled: true };
  }
  const workflowPath = join(
    root, ".harness", "state", "local", "push-workflow.json"
  );
  const priorWorkflow = await readOptionalJson<PushWorkflowState>(workflowPath);
  const provisionalRequestId = priorWorkflow?.local_project_key ===
    project.project.local_project_key
    ? priorWorkflow.request_id
    : uuidV7();
  const lock = await acquireProtocolLock(root, "push", { requestId: provisionalRequestId });
  try {
    const clientId = await clientIdFor(root, options.clientId);
    let workflow = priorWorkflow?.local_project_key === project.project.local_project_key
      ? priorWorkflow
      : newWorkflowState(project, clientId);
    workflow.client_id = clientId;
    await atomicWriteJson(workflowPath, workflow);
    preview = makePreview(
      baseline,
      await managedFiles(root, project),
      options.confirmedProjectLocal ?? [],
      installedPaths,
      workflow.created_at
    );
    const requestId = workflow.request_id;
    if (project.project.project_id === null) {
      const resolved = await client.resolveProject({
        schema_version: 1,
        local_project_key: project.project.local_project_key,
        display_name: project.project.name,
        requested_project_id: null,
        client_id: clientId
      }, requestId, workflow.resolve_idempotency_key);
      ({ project, baseline } = await bindProject(
        root, project, baseline, resolved.project_id
      ));
      workflow.project_id = resolved.project_id;
      await atomicWriteJson(workflowPath, workflow);
      preview = makePreview(
        baseline,
        await managedFiles(root, project),
        options.confirmedProjectLocal ?? [],
        installedPaths,
        workflow.created_at
      );
      if (!sensitiveScanSkip) {
        const reboundSkip = await resolveSensitiveScanSkip(preview, options);
        if (reboundSkip.cancelled === true) {
          return { preview, proposalId: null, projectId: project.project.project_id, cancelled: true };
        }
        sensitiveScanSkip = reboundSkip.skip;
        sensitiveScanSkipReason = reboundSkip.reason;
      }
      assertPreviewAllowed(preview, sensitiveScanSkip);
    }
    const projectId = project.project.project_id;
    if (projectId === null) {
      throw new PushWorkflowError("project binding failed", 4, "PROJECT_BIND_FAILED");
    }
    const baseManifestHash = sha256Bytes(canonicalJson(baseline));
    const proposalManifestHash = sha256Bytes(canonicalJson(preview.operations));
    if (workflow.proposal_manifest_hash !== proposalManifestHash ||
        (workflow.session_expires_at !== null &&
          Date.parse(workflow.session_expires_at) <= Date.now())) {
      workflow = resetSession(workflow, proposalManifestHash);
      await atomicWriteJson(workflowPath, workflow);
    }
    let session: {
      session_id: string;
      expires_at: string;
      missing_blobs: string[];
      max_chunk_bytes: number;
      request_id: string;
    };
    if (workflow.session_id === null || workflow.max_chunk_bytes === null ||
        workflow.session_expires_at === null) {
      session = await client.createProposalSession(projectId, {
        schema_version: 1,
        request_id: requestId,
        client_id: clientId,
        base_project_version: baseline.complete_project_version,
        base_manifest_hash: baseManifestHash,
        proposal_manifest: { files: preview.operations },
        artifact_manifest: { schema_version: 1, files: preview.operations }
      }, requestId, workflow.session_idempotency_key);
      workflow.session_id = session.session_id;
      workflow.session_expires_at = session.expires_at;
      workflow.max_chunk_bytes = session.max_chunk_bytes;
      await atomicWriteJson(workflowPath, workflow);
    } else {
      session = {
        session_id: workflow.session_id,
        expires_at: workflow.session_expires_at,
        missing_blobs: [],
        max_chunk_bytes: workflow.max_chunk_bytes,
        request_id: requestId
      };
    }
    const hashes = Object.keys(preview.blobs).sort();
    const query = await client.queryBlobs(
      session.session_id,
      hashes,
      requestId,
      workflow.query_idempotency_key
    );
    const missing = new Set([...session.missing_blobs, ...query.missing]);
    for (const hash of missing) {
      const content = preview.blobs[hash];
      if (content === undefined) {
        throw new PushWorkflowError("server requested undeclared blob", 4, "BLOB_NOT_DECLARED");
      }
      const bytes = new TextEncoder().encode(content);
      for (let start = 0; start < bytes.byteLength; start += session.max_chunk_bytes) {
        const chunkKey = hash + ":" + start;
        workflow.chunk_idempotency_keys[chunkKey] ??= uuidV7();
        await atomicWriteJson(workflowPath, workflow);
        await client.uploadBlobChunk({
          sessionId: session.session_id,
          contentSha256: hash,
          chunk: bytes.slice(start, Math.min(bytes.byteLength, start + session.max_chunk_bytes)),
          start,
          total: bytes.byteLength,
          requestId,
          idempotencyKey: workflow.chunk_idempotency_keys[chunkKey] ?? uuidV7()
        });
      }
    }
    let finalizeRetried = false;
    let finalized: {
      proposal_id: string;
      status: string;
      artifact_id: string | null;
    };
    const finalizeOnce = async () => client.finalizeProposal(
      session.session_id,
      {
        schema_version: 1,
        manifest_sha256: proposalManifestHash,
        base_artifact_id: baseline.latest_artifact_id ?? null,
        ...(sensitiveScanSkip
          ? {
            sensitive_scan_skip: true as const,
            ...(sensitiveScanSkipReason === undefined
              ? {}
              : { sensitive_scan_skip_reason: sensitiveScanSkipReason })
          }
          : {})
      },
      requestId,
      workflow.finalize_idempotency_key
    );
    try {
      finalized = await finalizeOnce();
    } catch (error) {
      if (error instanceof ApiError &&
          (error.code === "STALE_PUSH" || error.code === "PROJECT_VERSION_CONFLICT") &&
          !finalizeRetried) {
        finalizeRetried = true;
        baseline = await syncToLatest(root, project, baseline, client);
        workflow = resetSession(workflow, proposalManifestHash);
        await atomicWriteJson(workflowPath, workflow);
        session = await client.createProposalSession(projectId, {
          schema_version: 1,
          request_id: requestId,
          client_id: clientId,
          base_project_version: baseline.complete_project_version,
          base_manifest_hash: sha256Bytes(canonicalJson(baseline)),
          proposal_manifest: { files: preview.operations },
          artifact_manifest: { schema_version: 1, files: preview.operations }
        }, requestId, workflow.session_idempotency_key);
        workflow.session_id = session.session_id;
        workflow.session_expires_at = session.expires_at;
        workflow.max_chunk_bytes = session.max_chunk_bytes;
        await atomicWriteJson(workflowPath, workflow);
        try {
          finalized = await finalizeOnce();
        } catch (retryError) {
          if (retryError instanceof ApiError &&
              (retryError.code === "STALE_PUSH" ||
                retryError.code === "PROJECT_VERSION_CONFLICT")) {
            throw staleBaselineError(retryError.code);
          }
          throw retryError;
        }
      } else if (error instanceof ApiError &&
          (error.code === "STALE_PUSH" || error.code === "PROJECT_VERSION_CONFLICT")) {
        throw staleBaselineError(error.code);
      } else {
        throw error;
      }
    }
    let pushWarning: string | undefined;
    if (finalized.artifact_id !== null) {
      try {
        const publishedManifest = artifactManifestSchema.parse(
          await client.getArtifactManifest(finalized.artifact_id, requestId)
        );
        const advanced = await advanceBaselineFromArtifact({
          projectRoot: root,
          manifest: publishedManifest,
          requestId
        }, baseline);
        if (advanced.localChanged) {
          pushWarning = "LOCAL_CHANGED_DURING_PUSH";
        } else {
          baseline = advanced.baseline;
        }
      } catch {
        // Finalize is already committed server-side. A follow-up manifest read
        // must never turn a successful publish into an apparent failed push.
        pushWarning = "BASELINE_ADVANCE_DEFERRED";
      }
    }
    await atomicWriteJson(join(
      root,
      ".harness",
      "state",
      "local",
      "push-results",
      finalized.proposal_id + ".json"
    ), {
      schema_version: 1,
      request_id: requestId,
      project_id: projectId,
      proposal_id: finalized.proposal_id,
      status: finalized.status,
      artifact_id: finalized.artifact_id,
      operation_count: preview.operations.length,
      warning: pushWarning ?? null,
      recorded_at: new Date().toISOString()
    });
    await rm(workflowPath, { force: true });
    return {
      preview,
      proposalId: finalized.proposal_id,
      projectId,
      artifactId: finalized.artifact_id,
      ...(pushWarning === undefined ? {} : { warning: pushWarning })
    };
  } catch (error) {
    if (error instanceof PushWorkflowError) {
      throw error;
    }
    if (error instanceof ApiError) {
      if (error.code === "STALE_PUSH" || error.code === "PROJECT_VERSION_CONFLICT") {
        throw staleBaselineError(error.code);
      }
      if (error.code === "SENSITIVE_CONTENT_BLOCKED") {
        const details = error.details as Record<string, unknown> | null;
        throw new PushWorkflowError(
          error.message,
          6,
          "SENSITIVE_CONTENT_BLOCKED",
          details === null || typeof details !== "object"
            ? undefined
            : {
              ...(typeof details.finding_count === "number"
                ? { finding_count: details.finding_count }
                : {}),
              ...(typeof details.scanner_version === "string"
                ? { scanner_version: details.scanner_version }
                : {}),
              ...(Array.isArray(details.findings)
                ? { findings: details.findings as SensitiveFindingSummary[] }
                : {})
            }
        );
      }
      const exitCode = error.status === 401 ? 8 : error.status === 409 ? 5 : 4;
      throw new PushWorkflowError(error.message, exitCode, error.code);
    }
    throw new PushWorkflowError(
      error instanceof Error ? error.message : "push failed",
      4,
      "NETWORK_OR_SERVER_ERROR"
    );
  } finally {
    await lock.release();
  }
}
