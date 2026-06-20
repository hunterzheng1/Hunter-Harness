import { lstat, readFile, readdir, rm } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

import {
  baselineManifestSchema,
  canonicalJson,
  projectConfigSchema,
  type BaselineManifest,
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
import { uuidV7 } from "../project/uuid-v7.js";
import { atomicWriteJson } from "../state/atomic.js";
import { readBaseline } from "../state/baseline.js";
import { acquireProtocolLock } from "../state/locks.js";
import { runTransaction } from "../transaction/transaction.js";

export class PushWorkflowError extends Error {
  readonly exitCode: 3 | 4 | 5 | 6 | 7 | 8;
  readonly code: string;

  constructor(message: string, exitCode: 3 | 4 | 5 | 6 | 7 | 8, code: string) {
    super(message);
    this.name = "PushWorkflowError";
    this.exitCode = exitCode;
    this.code = code;
  }
}

export interface PushProjectOptions {
  projectRoot: string;
  serverUrl?: string;
  tokenEnv?: string;
  env: Readonly<Record<string, string | undefined>>;
  clientId?: string;
  dryRun: boolean;
  confirmedProjectLocal?: readonly string[];
  fetch?: typeof globalThis.fetch;
  confirmProposal?: (preview: ReturnType<typeof generateProposalPreview>) => Promise<boolean>;
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

const MANAGED_ROOTS = [
  ".claude/rules",
  ".harness/knowledge",
  ".harness/codebase"
];
const MANAGED_FILES = [
  "CLAUDE.md",
  "AGENTS.md",
  ".harness/project.yaml",
  ".harness/context-index.json"
];

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

async function managedFiles(projectRoot: string): Promise<Record<string, string>> {
  const root = resolve(projectRoot);
  const paths = [];
  for (const path of MANAGED_FILES) {
    if (await exists(join(root, path))) {
      paths.push(path);
    }
  }
  for (const path of MANAGED_ROOTS) {
    await walkFiles(root, join(root, path), paths);
  }
  const skillsRoot = join(root, ".claude", "skills");
  if (await exists(skillsRoot)) {
    for (const item of await readdir(skillsRoot, { withFileTypes: true })) {
      if (item.isDirectory() && item.name.startsWith("harness-")) {
        await walkFiles(root, join(skillsRoot, item.name), paths);
      }
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

function makePreview(
  baseline: BaselineManifest,
  files: Record<string, string>,
  confirmedProjectLocal: readonly string[],
  deletedAt = new Date().toISOString()
) {
  return generateProposalPreview({
    baseline: proposalBaseline(baseline),
    files,
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
  let preview = makePreview(
    baseline,
    await managedFiles(root),
    options.confirmedProjectLocal ?? []
  );
  if (preview.blocked) {
    throw new PushWorkflowError(
      "sensitive information scan blocked the proposal",
      6,
      "SENSITIVE_CONTENT_BLOCKED"
    );
  }
  if (options.dryRun) {
    return { preview, proposalId: null, projectId: project.project.project_id };
  }
  if (options.confirmProposal !== undefined && !await options.confirmProposal(preview)) {
    return { preview, proposalId: null, projectId: project.project.project_id, cancelled: true };
  }

  const serverUrl = options.serverUrl ?? project.server.url;
  if (serverUrl === null || serverUrl === undefined) {
    throw new PushWorkflowError("server_url is required", 3, "SERVER_URL_REQUIRED");
  }
  const tokenEnv = options.tokenEnv ?? project.server.token_env;
  const token = options.env[tokenEnv];
  if (token === undefined || token.trim() === "") {
    throw new PushWorkflowError("API token environment variable is unset", 8, "TOKEN_INVALID");
  }
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
      await managedFiles(root),
      options.confirmedProjectLocal ?? [],
      workflow.created_at
    );
    const requestId = workflow.request_id;
    const client = new HunterHarnessApiClient({
      serverUrl: parsedServerUrl.toString(),
      token,
      ...(options.fetch === undefined ? {} : { fetch: options.fetch })
    });
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
        await managedFiles(root),
        options.confirmedProjectLocal ?? [],
        workflow.created_at
      );
      if (preview.blocked) {
        throw new PushWorkflowError(
          "sensitive information scan blocked the proposal",
          6,
          "SENSITIVE_CONTENT_BLOCKED"
        );
      }
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
    const finalized = await client.finalizeProposal(
      session.session_id,
      { schema_version: 1, manifest_sha256: proposalManifestHash },
      requestId,
      workflow.finalize_idempotency_key
    );
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
      operation_count: preview.operations.length,
      recorded_at: new Date().toISOString()
    });
    await rm(workflowPath, { force: true });
    return { preview, proposalId: finalized.proposal_id, projectId };
  } catch (error) {
    if (error instanceof PushWorkflowError) {
      throw error;
    }
    if (error instanceof ApiError) {
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
