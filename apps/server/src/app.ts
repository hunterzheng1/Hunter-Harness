import { Buffer } from "node:buffer";

import {
  aiProviderReorderRequestSchema,
  canonicalJson,
  fileOperationSchema,
  finalizeProposalSchema,
  providerModelSchema,
  publishSkillRequestSchema,
  publishWorkflowFamilyRequestSchema,
  registryAgentSchema,
  registrySlugSchema,
  setDefaultAgentRequestSchema,
  workflowFamilyMutationSchema,
  bindProjectWorkflowFamilyRequestSchema,
  createExternalSkillRequestSchema,
  patchExternalSkillRequestSchema,
  SKILL_ERROR_CODE,
  type AiProviderConfig,
  type FileOperation,
  type FixPlanItem,
  type SourceFile
} from "@hunter-harness/contracts";
import {
  buildAiCheckPrompt,
  buildFixSuggestionPrompt,
  buildReleaseNotePrompt,
  classifyFile,
  decidePush,
  findEntryFile,
  parseAiCheckResult,
  parseFixSuggestionResult,
  parseFrontmatter,
  parseReleaseNote,
  scanSensitiveFiles,
  sha256Bytes,
  uuidV7,
  type FindingOverride,
  type FixSuggestionParse,
  type LlmClient
} from "@hunter-harness/core";
import type { BootstrapBundle } from "./registry/store.js";
import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest
} from "fastify";
import { z, ZodError } from "zod";
import multipart from "@fastify/multipart";
import AdmZip from "adm-zip";

import { MemoryAiJobStore, type AiJobStore } from "./ai/ai-job-store.js";
import { createLlmClient } from "./ai/llm-factory.js";
import { loadAiSecret, writeAiSecret } from "./ai/secret-loader.js";
import { writeAudit } from "./audit/audit.js";
import { authenticateRequest } from "./auth/tokens.js";
import { defaultServerConfig, type ServerConfig } from "./config.js";
import { buildDashboardOverview } from "./dashboard/overview.js";
import { isNpmPublishConfigured, loadNpmPublishConfig } from "./npm/config.js";
import {
  publishSkillNpmPackage,
  publishWorkflowFamilyNpmPackage,
  type NpmPublisherDeps
} from "./npm/publisher.js";
import { RegistryStore } from "./registry/store.js";
import type { RegistryPersistence } from "./registry/persistence.js";
import type {
  Actor,
  IdempotencyRecord,
  ServerRepository
} from "./repositories/interfaces.js";
import { ServerDomainError } from "./repositories/interfaces.js";
import type { ArtifactStorage } from "./storage/interface.js";
import { buildSemanticIndex } from "./semantic/indexer.js";
import { SemanticMemoryStore } from "./semantic/memory-store.js";
import type { SemanticStore } from "./semantic/store.js";
import { registerSemanticMcpRoutes } from "./mcp/register.js";

export interface CreateServerOptions {
  repository: ServerRepository;
  storage: ArtifactStorage;
  config?: Partial<ServerConfig>;
  logger?: boolean;
  bootstrapBundle?: BootstrapBundle;
  registryPersistence?: RegistryPersistence;
  semanticStore?: SemanticStore;
  // AiJobStore ???PG ??? PgAiJobStore ????? + ?? recoverOrphans??? MemoryAiJobStore ??? fallback?
  aiJobStore?: AiJobStore;
  // AI LlmClient ????? createLlmClient ?? DeepSeek?????? mock?
  aiLlmClientFactory?: (provider: AiProviderConfig, apiKey: string) => LlmClient | null;
  npmPublisherDeps?: NpmPublisherDeps;
  npmPublishConfig?: ReturnType<typeof loadNpmPublishConfig>;
  /** External Skill ?? fetch ??????? */
  externalFetch?: typeof fetch;
}

interface MutationResult {
  statusCode: number;
  body: Record<string, unknown>;
}

const resolveSchema = z.object({
  schema_version: z.literal(1),
  local_project_key: z.uuid(),
  display_name: z.string().min(1).max(200),
  requested_project_id: z.string().regex(/^prj_/).nullable(),
  client_id: z.string().regex(/^cli_/)
}).strict();

const sessionSchema = z.object({
  schema_version: z.literal(1),
  request_id: z.uuid(),
  client_id: z.string().regex(/^cli_/),
  base_project_version: z.string().regex(/^pv_/).nullable(),
  base_manifest_hash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  proposal_manifest: z.object({ files: z.array(fileOperationSchema) }).passthrough(),
  artifact_manifest: z.object({
    schema_version: z.literal(1),
    files: z.array(fileOperationSchema)
  }).passthrough(),
  confirmations: z.object({
    project_local_paths: z.array(z.string()).default([])
  }).strict().optional(),
  scan_overrides: z.array(z.object({
    finding_fingerprint: z.string(),
    actor: z.string().min(1),
    reason: z.string().min(1)
  }).strict()).optional()
}).strict();

const blobQuerySchema = z.object({
  content_sha256: z.array(z.string().regex(/^sha256:[a-f0-9]{64}$/))
}).strict();

const tagCreateSchema = z.object({
  schema_version: z.literal(1),
  slug: registrySlugSchema,
  label: z.string().min(1).max(80)
}).strict();

const tagUpdateSchema = z.object({
  revision: z.number().int().positive(),
  label: z.string().min(1).max(80).optional(),
  active: z.boolean().optional()
}).strict();

const tagMergeSchema = z.object({
  revision: z.number().int().positive(),
  target_tag_id: z.string().regex(/^tag_/)
}).strict();

const projectWorkflowBindingSchema = bindProjectWorkflowFamilyRequestSchema;

// ?? provider ?? selected model ? request_model?fallback models[0] ? provider.model??test/ai-checks/release-note/fix-suggestions ???Y3 ????
function resolveRequestModel(provider: AiProviderConfig): string {
  return provider.models.find((m) => m.id === provider.selected_model_id)?.request_model
    ?? provider.models[0]?.request_model
    ?? provider.model;
}

const aiProviderCreateSchema = z.object({
  schema_version: z.literal(1),
  provider_id: z.string().min(1),
  label: z.string().min(1).max(120),
  base_url: z.url(),
  model: z.string().min(1),
  enabled: z.boolean(),
  api_key_env: z.string().min(1),
  is_default: z.boolean().optional(),
  daily_request_limit: z.number().int().nonnegative().nullable().optional(),
  daily_token_limit: z.number().int().nonnegative().nullable().optional(),
  models: z.array(providerModelSchema).optional(),
  api_format: z.enum(["openai", "anthropic", "custom"]).optional(),
  note: z.string().optional(),
  website: z.string().optional(),
  selected_model_id: z.string().nullable().optional(),
  sort_order: z.number().int().nonnegative().optional(),
  api_key: z.string().optional()
}).strict();

const aiProviderUpdateSchema = z.object({
  schema_version: z.literal(1),
  revision: z.number().int().positive(),
  label: z.string().min(1).max(120).optional(),
  base_url: z.url().optional(),
  model: z.string().min(1).optional(),
  enabled: z.boolean().optional(),
  api_key_env: z.string().min(1).optional(),
  daily_request_limit: z.number().int().nonnegative().nullable().optional(),
  daily_token_limit: z.number().int().nonnegative().nullable().optional(),
  models: z.array(providerModelSchema).optional(),
  api_format: z.enum(["openai", "anthropic", "custom"]).optional(),
  note: z.string().optional(),
  website: z.string().optional(),
  selected_model_id: z.string().nullable().optional(),
  sort_order: z.number().int().nonnegative().optional(),
  api_key: z.string().optional()
}).strict();

function routeRequestId(request: FastifyRequest): string {
  const header = request.headers["x-request-id"];
  if (header === undefined) {
    return uuidV7();
  }
  if (typeof header !== "string" || !z.uuid().safeParse(header).success) {
    throw new ServerDomainError(400, "VALIDATION_FAILED", "X-Request-Id is invalid");
  }
  return header;
}

function mutationBodyHash(body: unknown): string {
  if (body === undefined || body === null) return sha256Bytes("");
  return sha256Bytes(Buffer.isBuffer(body) ? body : canonicalJson(body));
}

function operationTarget(operation: FileOperation): string {
  return operation.operation === "rename" ? operation.to_path : operation.path;
}

function operationSource(operation: FileOperation): string {
  return operation.operation === "rename" ? operation.from_path : operation.path;
}

function operationSize(operation: FileOperation): number {
  return "size_bytes" in operation ? operation.size_bytes : 0;
}

// ???????? ? ? RegistryStore.DANGEROUS_PATH / checker DANGEROUS_PATH ????
// ?? ^\\ ????? UNC ?????? store ??????????
const DANGEROUS_PATH = /(^|[/\\])\.\.([/\\]|$)|^\/|^\\|^[a-zA-Z]:/;

// fix-suggestions ???? FixPlan summary?? aiChecks / LLM ????????
// Object.freeze ??????????????????? send ??? summary ???????????
// ????? WRITABLE_APPLIES_TO ? as const ?????????
const emptySummary = Object.freeze({ autoCount: 0, confirmCount: 0, suggestCount: 0, changedFiles: 0, changedLines: 0 });

function resolveUploadFiles(collected: ReadonlyArray<{ path: string; buffer: Buffer }>): SourceFile[] {
  if (collected.length === 1 && /\.zip$/i.test(collected[0]?.path ?? "")) {
    const zip = new AdmZip(collected[0]?.buffer ?? Buffer.alloc(0));
    const files: SourceFile[] = [];
    for (const entry of zip.getEntries()) {
      if (entry.isDirectory) continue;
      if (DANGEROUS_PATH.test(entry.entryName)) {
        throw new ServerDomainError(422, SKILL_ERROR_CODE.VALIDATION_FAILED, "zip slip detected: " + entry.entryName);
      }
      files.push({ path: entry.entryName, content: entry.getData().toString("utf8") });
    }
    return files;
  }
  return collected.map((c) => ({ path: c.path, content: c.buffer.toString("utf8") }));
}

async function authenticated(
  request: FastifyRequest,
  repository: ServerRepository
): Promise<{ actor: Actor; requestId: string }> {
  return {
    actor: await authenticateRequest(request, repository),
    requestId: routeRequestId(request)
  };
}

async function mutation(
  request: FastifyRequest,
  repository: ServerRepository,
  actor: Actor,
  requestId: string,
  action: () => Promise<MutationResult>,
  bodyHashOverride?: string
): Promise<MutationResult> {
  const idempotency = request.headers["idempotency-key"];
  if (typeof idempotency !== "string" || !z.uuid().safeParse(idempotency).success) {
    throw new ServerDomainError(
      400,
      "VALIDATION_FAILED",
      "Idempotency-Key is required and must be a UUID"
    );
  }
  const method = request.method.toUpperCase();
  const path = request.routeOptions.url ?? request.url.split("?")[0] ?? request.url;
  const bodyHash = bodyHashOverride ?? mutationBodyHash(request.body);
  const lockInput = {
    actorId: actor.actorId,
    method,
    path,
    key: idempotency
  };
  const lock = await repository.acquireIdempotencyLock(lockInput);
  try {
    const existing = await repository.getIdempotency(lockInput);
    if (existing !== null) {
      if (existing.bodyHash !== bodyHash) {
        throw new ServerDomainError(
          409,
          "IDEMPOTENCY_KEY_REUSED",
          "idempotency key was reused with a different request"
        );
      }
      return {
        statusCode: existing.statusCode,
        body: existing.response as Record<string, unknown>
      };
    }
    const result = await action();
    const response = { ...result.body, request_id: requestId };
    const record: IdempotencyRecord = {
      ...lockInput,
      bodyHash,
      statusCode: result.statusCode,
      response
    };
    await repository.putIdempotency(record);
    return { statusCode: result.statusCode, body: response };
  } finally {
    await lock.release();
  }
}

function send(reply: FastifyReply, requestId: string, result: MutationResult) {
  reply.header("X-Request-Id", requestId);
  return reply.code(result.statusCode).send(result.body);
}

export async function createServer(options: CreateServerOptions): Promise<FastifyInstance> {
  const config = { ...defaultServerConfig, ...options.config };
  const { repository, storage } = options;
  const registry = new RegistryStore(storage, options.registryPersistence);
  await registry.initialize(options.bootstrapBundle);
  registry.setExternalFetcherDeps({
    ...(options.externalFetch !== undefined ? { fetch: options.externalFetch } : {}),
    githubToken: config.githubToken
  });
  // AiJobStore ???§3.2??PG ??? PgAiJobStore ???????? MemoryAiJobStore ??? fallback?
  const aiJobStore = options.aiJobStore ?? new MemoryAiJobStore();
  const semanticStore = options.semanticStore ?? new SemanticMemoryStore();
  // R3???????? running/pending job?PG ??? failed ?? partial unique index?memory no-op??
  await aiJobStore.recoverOrphans();
  // AI LlmClient ???§12.9??? defaultProvider ??? provider + secret file key ?? DeepSeek ????
  // ???/? key/??? ? null?????? AI_NOT_CONFIGURED??key ??????? store/log/???
  const llmFactory = options.aiLlmClientFactory ?? createLlmClient;
  const resolveLlmClient = async (providerId: string | null): Promise<{
    client: LlmClient;
    provider: AiProviderConfig;
  } | null> => {
    const provider = providerId === null
      ? registry.getDefaultProvider()
      : registry.getProvider(providerId) ?? null;
    if (provider === null || !provider.enabled) return null;
    const secret = await loadAiSecret(config.aiSecretFile, provider.provider_id);
    if (secret === null) return null;
    const merged: AiProviderConfig = {
      ...provider,
      base_url: secret.baseUrl ?? provider.base_url,
      model: secret.model ?? provider.model
    };
    const client = llmFactory(merged, secret.apiKey);
    if (client === null) {
      // api_format=anthropic|custom ?? client ?? ? 422 ADAPTER_NOT_IMPLEMENTED??????? AI_NOT_CONFIGURED?
      throw new ServerDomainError(422, "ADAPTER_NOT_IMPLEMENTED", "ai provider api_format not supported", {
        provider_id: provider.provider_id, api_format: provider.api_format
      });
    }
    return { client, provider };
  };
  const app = Fastify({
    logger: options.logger ?? false,
    bodyLimit: config.maxProposalBytes
  });
  app.addContentTypeParser(
    "application/octet-stream",
    { parseAs: "buffer" },
    (_request, body, done) => done(null, body)
  );
  await app.register(multipart, {
    limits: { fileSize: config.maxFileBytes, files: config.maxUploadFiles }
  });

  app.setErrorHandler((error, request, reply) => {
    let status = 500;
    let code = "INTERNAL_ERROR";
    let message = "Internal server error.";
    let details: Record<string, unknown> = {};
    if (error instanceof ServerDomainError) {
      ({ status, code, message, details } = error);
    } else if (error instanceof ZodError) {
      status = 400;
      code = "VALIDATION_FAILED";
      message = "Request schema validation failed.";
      details = { issues: error.issues.map((issue) => ({
        path: issue.path.join("."),
        code: issue.code
      })) };
    } else if (typeof error === "object" && error !== null &&
        "statusCode" in error && error.statusCode === 413) {
      status = 413;
      code = "PROPOSAL_TOO_LARGE";
      message = "Request body exceeds the configured limit.";
    }
    let requestId: string;
    try {
      requestId = routeRequestId(request);
    } catch {
      requestId = uuidV7();
    }
    reply.header("X-Request-Id", requestId).code(status).send({
      error: { code, message, request_id: requestId, details }
    });
  });

  app.get("/health", async () => ({ status: "ok" }));

  app.get("/api/v1/dashboard/overview", async (request, reply) => {
    const { actor, requestId } = await authenticated(request, repository);
    const query = z.object({ days: z.coerce.number().int().min(7).max(30).default(7) }).strict().parse(request.query);
    const overview = await buildDashboardOverview({
      repository,
      registry,
      actorId: actor.actorId,
      days: query.days
    });
    reply.header("X-Request-Id", requestId);
    return { ...overview, request_id: requestId };
  });

  app.post("/api/v1/projects:resolve", async (request, reply) => {
    const { actor, requestId } = await authenticated(request, repository);
    const body = resolveSchema.parse(request.body);
    const result = await mutation(request, repository, actor, requestId, async () => {
      const resolved = await repository.resolveProject({
        actorId: actor.actorId,
        localProjectKey: body.local_project_key,
        displayName: body.display_name,
        requestedProjectId: body.requested_project_id
      });
      await writeAudit(repository, {
        actorId: actor.actorId,
        projectId: resolved.project.projectId,
        action: "project.resolved",
        targetId: resolved.project.projectId,
        requestId,
        details: { binding_status: resolved.bindingStatus }
      });
      return {
        statusCode: 200,
        body: {
          schema_version: 1,
          project_id: resolved.project.projectId,
          binding_status: resolved.bindingStatus,
          project_version: resolved.project.latestProjectVersion,
          baseline_manifest: {
            schema_version: 1,
            project_id: resolved.project.projectId,
            complete_project_version: resolved.project.latestProjectVersion,
            artifact_manifest_hash: null,
            files: {}
          }
        }
      };
    });
    return send(reply, requestId, result);
  });

  app.get("/api/v1/projects/:projectId", async (request, reply) => {
    const { actor, requestId } = await authenticated(request, repository);
    const { projectId } = request.params as { projectId: string };
    const project = await repository.getProject(actor.actorId, projectId);
    reply.header("X-Request-Id", requestId);
    return {
      schema_version: 1,
      project_id: project.projectId,
      display_name: project.displayName,
      role: "owner",
      latest_project_version: project.latestProjectVersion,
      latest_artifact_id: project.latestArtifactId,
      request_id: requestId
    };
  });

  app.get("/api/v1/projects", async (request, reply) => {
    const { actor, requestId } = await authenticated(request, repository);
    const query = request.query as Record<string, string | undefined>;
    const limit = query.limit === undefined ? 50 : Number(query.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new ServerDomainError(400, "VALIDATION_FAILED", "limit must be between 1 and 100");
    }
    const listed = await repository.listProjects({
      actorId: actor.actorId,
      limit,
      cursor: query.cursor ?? null
    });
    reply.header("X-Request-Id", requestId);
    return {
      items: listed.items.map((project) => ({
        project_id: project.projectId,
        display_name: project.displayName,
        role: "owner",
        latest_project_version: project.latestProjectVersion,
        latest_artifact_id: project.latestArtifactId,
        created_at: project.createdAt
      })),
      page: { next_cursor: listed.nextCursor, limit },
      request_id: requestId
    };
  });

  app.post("/api/v1/projects/:projectId/proposal-sessions", async (request, reply) => {
    const { actor, requestId } = await authenticated(request, repository);
    const { projectId } = request.params as { projectId: string };
    const body = sessionSchema.parse(request.body);
    const result = await mutation(request, repository, actor, requestId, async () => {
      const project = await repository.getProject(actor.actorId, projectId);
      if (body.base_project_version !== project.latestProjectVersion) {
        throw new ServerDomainError(409, "PROJECT_VERSION_CONFLICT", "base project version is stale", {
          latest_project_version: project.latestProjectVersion
        });
      }
      if (canonicalJson(body.proposal_manifest.files) !==
          canonicalJson(body.artifact_manifest.files)) {
        throw new ServerDomainError(400, "VALIDATION_FAILED", "proposal manifests disagree");
      }
      const confirmed = new Set(body.confirmations?.project_local_paths ?? []);
      let total = 0;
      for (const operation of body.proposal_manifest.files) {
        const target = operationTarget(operation);
        const targetPolicy = classifyFile(target);
        const sourcePolicy = classifyFile(operationSource(operation));
        if (operation.file_kind !== targetPolicy.file_kind ||
            !decidePush(targetPolicy, confirmed.has(target)).include ||
            !decidePush(sourcePolicy, confirmed.has(operationSource(operation))).include) {
          throw new ServerDomainError(
            422,
            "POLICY_PATH_FORBIDDEN",
            "proposal contains a forbidden path",
            { path: target }
          );
        }
        const size = operationSize(operation);
        if (size > config.maxFileBytes) {
          throw new ServerDomainError(413, "FILE_TOO_LARGE", "proposal file exceeds size limit", {
            path: target
          });
        }
        total += size;
      }
      if (total > config.maxProposalBytes) {
        throw new ServerDomainError(413, "PROPOSAL_TOO_LARGE", "proposal exceeds size limit");
      }
      const session = await repository.createProposalSession({
        projectId,
        actorId: actor.actorId,
        baseProjectVersion: body.base_project_version,
        baseManifestHash: body.base_manifest_hash,
        operations: body.proposal_manifest.files,
        scanOverrides: (body.scan_overrides ?? []) as FindingOverride[],
        status: "open",
        expiresAt: new Date(Date.now() + config.sessionTtlMs).toISOString(),
        maxChunkBytes: config.maxChunkBytes
      });
      const hashes = [...new Set(body.proposal_manifest.files.flatMap((operation) =>
        operation.operation === "delete" ? [] : [operation.content_sha256]
      ))];
      const missing = [];
      for (const hash of hashes) {
        if (hash === sha256Bytes(new Uint8Array())) {
          await storage.putBlob(hash, new Uint8Array());
        }
        if (!await storage.hasBlob(hash)) {
          missing.push(hash);
        }
      }
      return {
        statusCode: 201,
        body: {
          session_id: session.sessionId,
          expires_at: session.expiresAt,
          missing_blobs: missing,
          max_chunk_bytes: session.maxChunkBytes
        }
      };
    });
    return send(reply, requestId, result);
  });

  app.post("/api/v1/proposal-sessions/:sessionId/blobs:query", async (request, reply) => {
    const { actor, requestId } = await authenticated(request, repository);
    const { sessionId } = request.params as { sessionId: string };
    const body = blobQuerySchema.parse(request.body);
    const result = await mutation(request, repository, actor, requestId, async () => {
      const session = await repository.getProposalSession(actor.actorId, sessionId);
      const declared = new Set(session.operations.flatMap((operation) =>
        operation.operation === "delete" ? [] : [operation.content_sha256]
      ));
      const present: string[] = [];
      const missing: string[] = [];
      for (const hash of body.content_sha256) {
        if (!declared.has(hash)) {
          throw new ServerDomainError(409, "BLOB_NOT_DECLARED", "blob is not declared");
        }
        (await storage.hasBlob(hash) ? present : missing).push(hash);
      }
      return { statusCode: 200, body: { present, missing } };
    });
    return send(reply, requestId, result);
  });

  app.put("/api/v1/proposal-sessions/:sessionId/blobs/:hash", async (request, reply) => {
    const { actor, requestId } = await authenticated(request, repository);
    const { sessionId, hash } = request.params as { sessionId: string; hash: string };
    const result = await mutation(request, repository, actor, requestId, async () => {
      const session = await repository.getProposalSession(actor.actorId, sessionId);
      const operation = session.operations.find((item) =>
        item.operation !== "delete" && item.content_sha256 === hash
      );
      if (operation === undefined) {
        throw new ServerDomainError(409, "BLOB_NOT_DECLARED", "blob is not declared");
      }
      const content = request.body;
      if (!Buffer.isBuffer(content)) {
        throw new ServerDomainError(400, "VALIDATION_FAILED", "blob body is required");
      }
      if (content.byteLength > session.maxChunkBytes) {
        throw new ServerDomainError(413, "FILE_TOO_LARGE", "chunk exceeds size limit");
      }
      if (request.headers["x-chunk-sha256"] !== sha256Bytes(content)) {
        throw new ServerDomainError(
          422,
          "UPLOAD_CHUNK_HASH_MISMATCH",
          "upload chunk integrity check failed"
        );
      }
      const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(
        String(request.headers["content-range"] ?? "")
      );
      if (range === null) {
        throw new ServerDomainError(400, "VALIDATION_FAILED", "Content-Range is invalid");
      }
      const start = Number(range[1]);
      const end = Number(range[2]);
      const total = Number(range[3]);
      if (end - start + 1 !== content.byteLength || total !== operationSize(operation)) {
        throw new ServerDomainError(422, "UPLOAD_RANGE_INVALID", "upload range is invalid");
      }
      const written = await storage.writeSessionChunk({
        sessionId,
        contentSha256: hash,
        start,
        total,
        chunk: content
      });
      return {
        statusCode: written.complete ? 201 : 202,
        body: {
          received_ranges: written.receivedRanges,
          verified: written.complete
        }
      };
    });
    return send(reply, requestId, result);
  });

  app.post(
    "/api/v1/proposal-sessions/:sessionId(^ups_[^:]+):finalize",
    async (request, reply) => {
    const { actor, requestId } = await authenticated(request, repository);
    const { sessionId } = request.params as { sessionId: string };
    const body = finalizeProposalSchema.parse(request.body);
    const result = await mutation(request, repository, actor, requestId, async () => {
      const session = await repository.getProposalSession(actor.actorId, sessionId);
      if (body.manifest_sha256 !== sha256Bytes(canonicalJson(session.operations))) {
        throw new ServerDomainError(422, "ARTIFACT_HASH_MISMATCH", "proposal manifest hash mismatch");
      }
      const project = await repository.getProject(actor.actorId, session.projectId);
      if (project.latestArtifactId !== null &&
          body.base_artifact_id !== project.latestArtifactId) {
        throw new ServerDomainError(
          409,
          "STALE_PUSH",
          "server already has a newer artifact; sync before pushing",
          { latest_artifact_id: project.latestArtifactId }
        );
      }
      const files: Record<string, string> = {};
      for (const operation of session.operations) {
        if (operation.operation === "delete") {
          continue;
        }
        if (!await storage.hasBlob(operation.content_sha256)) {
          throw new ServerDomainError(409, "UPLOAD_INCOMPLETE", "required blob is missing");
        }
        const bytes = await storage.getBlob(operation.content_sha256);
        if (bytes.byteLength !== operation.size_bytes ||
            sha256Bytes(bytes) !== operation.content_sha256) {
          throw new ServerDomainError(422, "ARTIFACT_HASH_MISMATCH", "blob integrity check failed");
        }
        try {
          files[operationTarget(operation)] = new TextDecoder("utf-8", {
            fatal: true
          }).decode(bytes);
        } catch {
          throw new ServerDomainError(422, "POLICY_PATH_FORBIDDEN", "artifact must be UTF-8 text");
        }
      }
      const scan = scanSensitiveFiles(files, { overrides: session.scanOverrides });
      const blockedFindings = scan.findings.filter(
        (finding) => finding.disposition === "blocked"
      );
      if (scan.blocked && body.sensitive_scan_skip !== true) {
        throw new ServerDomainError(
          422,
          "SENSITIVE_CONTENT_BLOCKED",
          "sensitive content scan blocked the proposal",
          {
            finding_count: blockedFindings.length,
            scanner_version: scan.scanner_version,
            findings: blockedFindings.map((finding) => ({
              path: finding.path,
              rule_id: finding.rule_id,
              severity: finding.severity,
              overridable: finding.overridable,
              fingerprint: finding.fingerprint,
              line: finding.line,
              column: finding.column
            }))
          }
        );
      }
      const { proposal, review } = await repository.finalizeSessionAutoApprove(session);
      await storage.deleteSession(sessionId);
      await writeAudit(repository, {
        actorId: actor.actorId,
        projectId: proposal.projectId,
        action: "proposal.finalized",
        targetId: proposal.proposalId,
        requestId,
        details: {
          item_count: proposal.items.length,
          artifact_id: review.artifactId,
          ...(body.sensitive_scan_skip === true
            ? {
              sensitive_scan_skip: true,
              sensitive_scan_skip_reason: body.sensitive_scan_skip_reason ?? null,
              finding_count: scan.findings.length,
              blocked_finding_count: blockedFindings.length,
              scanner_version: scan.scanner_version
            }
            : {})
        }
      });
      if (review.artifactId !== null) {
        await semanticStore.rebuild(buildSemanticIndex({
          projectId: proposal.projectId,
          artifactId: review.artifactId,
          files
        }));
      }
      return {
        statusCode: 201,
        body: {
          proposal_id: proposal.proposalId,
          status: "approved" as const,
          artifact_id: review.artifactId,
          received_files: proposal.items.length
        }
      };
    });
    return send(reply, requestId, result);
    }
  );

  app.get("/api/v1/projects/:projectId/proposals", async (request, reply) => {
    const { actor, requestId } = await authenticated(request, repository);
    const { projectId } = request.params as { projectId: string };
    const query = request.query as Record<string, string | undefined>;
    const limit = query.limit === undefined ? 50 : Number(query.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new ServerDomainError(400, "VALIDATION_FAILED", "limit must be between 1 and 100");
    }
    const listed = await repository.listProposals({
      actorId: actor.actorId,
      projectId,
      limit,
      cursor: query.cursor ?? null,
      status: query.status ?? null
    });
    reply.header("X-Request-Id", requestId);
    return {
      items: listed.items.map((proposal) => ({
        proposal_id: proposal.proposalId,
        status: proposal.status,
        created_at: proposal.createdAt,
        changed_item_count: proposal.items.length,
        risk_count: 0,
        base_project_version: proposal.baseProjectVersion,
        created_by: proposal.createdBy
      })),
      page: { next_cursor: listed.nextCursor, limit },
      request_id: requestId
    };
  });

  app.get("/api/v1/projects/:projectId/artifacts", async (request, reply) => {
    const { actor, requestId } = await authenticated(request, repository);
    const { projectId } = request.params as { projectId: string };
    const query = request.query as Record<string, string | undefined>;
    const limit = query.limit === undefined ? 50 : Number(query.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new ServerDomainError(400, "VALIDATION_FAILED", "limit must be between 1 and 100");
    }
    const listed = await repository.listArtifacts({
      actorId: actor.actorId,
      projectId,
      limit,
      cursor: query.cursor ?? null
    });
    reply.header("X-Request-Id", requestId);
    return {
      items: listed.items.map((artifact) => ({
        artifact_id: artifact.artifactId,
        project_id: artifact.projectId,
        project_version: artifact.projectVersion,
        base_project_version: artifact.baseProjectVersion,
        proposal_id: artifact.proposalId,
        changed_item_count: artifact.manifest.files.length,
        manifest_sha256: artifact.manifest.manifest_sha256,
        created_at: artifact.createdAt
      })),
      page: { next_cursor: listed.nextCursor, limit },
      request_id: requestId
    };
  });

  app.get("/api/v1/proposals/:proposalId", async (request, reply) => {
    const { actor, requestId } = await authenticated(request, repository);
    const { proposalId } = request.params as { proposalId: string };
    const proposal = await repository.getProposal(actor.actorId, proposalId);
    reply.header("X-Request-Id", requestId);
    return {
      schema_version: 1,
      proposal_id: proposal.proposalId,
      project_id: proposal.projectId,
      status: proposal.status,
      created_by: proposal.createdBy,
      created_at: proposal.createdAt,
      items: proposal.items.map((item) => ({
        item_id: item.itemId,
        operation: item.operation
      })),
      scan_summary: { redacted: true },
      review_history: proposal.reviewHistory.map((review) => ({
        review_id: review.reviewId,
        decision: review.decision,
        created_at: review.createdAt,
        artifact_id: review.artifactId
      })),
      request_id: requestId
    };
  });

  app.get("/api/v1/projects/:projectId/update-manifest", async (request, reply) => {
    const { actor, requestId } = await authenticated(request, repository);
    const { projectId } = request.params as { projectId: string };
    await repository.getProject(actor.actorId, projectId);
    const query = request.query as Record<string, string | undefined>;
    const baseProjectVersion = query.base_project_version === undefined ||
      query.base_project_version === ""
      ? null
      : query.base_project_version;
    const artifact = await repository.getNextArtifact(
      actor.actorId,
      projectId,
      baseProjectVersion
    );
    reply.header("X-Request-Id", requestId);
    return {
      schema_version: 1,
      project_id: projectId,
      observed_project_version: artifact?.projectVersion ?? null,
      artifact_id: artifact?.artifactId ?? null,
      artifact_manifest_url: artifact === null
        ? null
        : "/api/v1/artifacts/" + artifact.artifactId + "/manifest",
      delta_available: artifact !== null,
      request_id: requestId
    };
  });

  app.get("/api/v1/artifacts/:artifactId/manifest", async (request, reply) => {
    const { actor, requestId } = await authenticated(request, repository);
    const { artifactId } = request.params as { artifactId: string };
    const artifact = await repository.getArtifact(actor.actorId, artifactId);
    reply.header("X-Request-Id", requestId);
    reply.header("ETag", artifact.manifest.manifest_sha256);
    return artifact.manifest;
  });

  app.get("/api/v1/artifacts/:artifactId/blobs/:hash", async (request, reply) => {
    const { actor, requestId } = await authenticated(request, repository);
    const { artifactId, hash } = request.params as { artifactId: string; hash: string };
    const artifact = await repository.getArtifact(actor.actorId, artifactId);
    if (!artifact.manifest.files.some((operation) =>
      operation.operation !== "delete" && operation.content_sha256 === hash
    )) {
      throw new ServerDomainError(404, "ARTIFACT_NOT_FOUND", "artifact blob not found");
    }
    const bytes = await storage.getBlob(hash);
    let start = 0;
    let end = bytes.byteLength - 1;
    let statusCode = 200;
    const range = request.headers.range;
    if (range !== undefined) {
      const match = /^bytes=(\d+)-(\d*)$/.exec(range);
      if (match === null) {
        throw new ServerDomainError(416, "RANGE_INVALID", "Range header is invalid");
      }
      start = Number(match[1]);
      end = match[2] === "" ? end : Number(match[2]);
      if (start > end || end >= bytes.byteLength) {
        throw new ServerDomainError(416, "RANGE_INVALID", "Range is outside the blob");
      }
      statusCode = 206;
      reply.header("Content-Range", `bytes ${start}-${end}/${bytes.byteLength}`);
    }
    const content = Buffer.from(bytes.slice(start, end + 1));
    reply
      .header("Content-Type", "application/octet-stream")
      .header("Content-Length", String(content.byteLength))
      .header("X-Content-SHA256", hash)
      .header("ETag", hash)
      .header("X-Request-Id", requestId)
      .code(statusCode);
    return content;
  });

  app.get("/api/v1/skills", async (request, reply) => {
    const { requestId } = await authenticated(request, repository);
    const query = request.query as Record<string, string | undefined>;
    reply.header("X-Request-Id", requestId);
    return {
      items: registry.listSkills({
        search: query.search,
        tag: query.tag,
        agent: query.agent,
        status: query.status
      }),
      page: { next_cursor: null },
      request_id: requestId
    };
  });

  app.get("/api/v1/skills/:slug", async (request, reply) => {
    const { requestId } = await authenticated(request, repository);
    const { slug } = request.params as { slug: string };
    reply.header("X-Request-Id", requestId);
    const npmConfig = options.npmPublishConfig ?? loadNpmPublishConfig();
    return {
      ...registry.getSkill(slug),
      npm_publish_available: isNpmPublishConfigured(npmConfig),
      request_id: requestId
    };
  });

  app.get("/api/v1/skills/:slug/adapter-preview/:agent", async (request, reply) => {
    const { requestId } = await authenticated(request, repository);
    const { slug, agent: agentValue } = request.params as { slug: string; agent: string };
    const preview = registry.adapterPreview(slug, registryAgentSchema.parse(agentValue));
    reply.header("X-Request-Id", requestId);
    return { ...preview, request_id: requestId };
  });
  app.get("/api/v1/skill-artifacts", async (request, reply) => {
    const { requestId } = await authenticated(request, repository);
    reply.header("X-Request-Id", requestId);
    return { items: registry.listArtifacts(), request_id: requestId };
  });

  app.get("/api/v1/skills/:slug/versions", async (request, reply) => {
    const { requestId } = await authenticated(request, repository);
    const { slug } = request.params as { slug: string };
    // agent ??????? ? ??????????? agent ???store.listVersions ????
    // ?? #1 ???????? registry.listVersions(slug) ?? ?agent= query???????????
    const query = request.query as Record<string, string | undefined>;
    const agentResult = registryAgentSchema.safeParse(query.agent);
    if (query.agent !== undefined && !agentResult.success) {
      throw new ServerDomainError(422, "VALIDATION_FAILED", "agent query param must be a valid registry agent");
    }
    const agent = agentResult.success ? agentResult.data : undefined;
    reply.header("X-Request-Id", requestId);
    return { items: registry.listVersions(slug, agent), request_id: requestId };
  });

  app.get("/api/v1/skills/:slug/artifacts/:agent/download", async (request, reply) => {
    const { actor, requestId } = await authenticated(request, repository);
    const { slug, agent: agentValue } = request.params as { slug: string; agent: string };
    const agent = registryAgentSchema.parse(agentValue);
    const artifact = registry.latestArtifact(slug, agent);
    const bytes = await registry.artifactBytes(artifact);
    await writeAudit(repository, {
      actorId: actor.actorId,
      projectId: null,
      action: "skill.artifact.downloaded",
      targetId: artifact.artifact_id,
      requestId,
      details: { skill_slug: slug, version: artifact.version, agent }
    });
    reply
      .header("Content-Type", "application/zip")
      .header("Content-Disposition", `attachment; filename="${slug}-${artifact.version}-${agent}.zip"`)
      .header("X-Content-SHA256", artifact.content_sha256)
      .header("ETag", artifact.content_sha256)
      .header("X-Request-Id", requestId);
    return Buffer.from(bytes);
  });

  app.post("/api/v1/skills/draft", async (request, reply) => {
    const { actor, requestId } = await authenticated(request, repository);
    const query = request.query as Record<string, string | undefined>;
    const agentResult = registryAgentSchema.safeParse(query.agent);
    if (!agentResult.success) {
      throw new ServerDomainError(422, "VALIDATION_FAILED", "agent query param is required and must be a valid registry agent");
    }
    const agent = agentResult.data;
    const collected: Array<{ path: string; buffer: Buffer }> = [];
    for await (const part of request.parts()) {
      if (part.type !== "file") continue;
      collected.push({ path: part.filename ?? "file", buffer: await part.toBuffer() });
    }
    const files = resolveUploadFiles(collected);
    // agent ?? bodyHash?? Idempotency-Key ? agent ??? IDEMPOTENCY_KEY_REUSED ??????
    const bodyHash = sha256Bytes(canonicalJson({ agent, files: files.map((f) => ({ path: f.path, content: f.content })) }));
    const result = await mutation(request, repository, actor, requestId, async () => {
      const draft = await registry.uploadDraft({ files, actorId: actor.actorId, agent });
      await writeAudit(repository, {
        actorId: actor.actorId, projectId: null,
        action: draft.revision === 1 ? "skill.draft.created" : "skill.draft.updated",
        targetId: draft.slug, requestId,
        details: { slug: draft.slug, agent, draft_version: draft.draftVersion, revision: draft.revision }
      });
      return { statusCode: 201, body: draft };
    }, bodyHash);
    return send(reply, requestId, result);
  });

  app.get("/api/v1/skills/:slug/draft/:agent", async (request, reply) => {
    const { requestId } = await authenticated(request, repository);
    const { slug, agent: agentValue } = request.params as { slug: string; agent: string };
    const agentResult = registryAgentSchema.safeParse(agentValue);
    if (!agentResult.success) {
      throw new ServerDomainError(422, "VALIDATION_FAILED", "agent path param must be a valid registry agent");
    }
    const draft = registry.getDraft(slug, agentResult.data);
    if (draft === undefined) throw new ServerDomainError(404, SKILL_ERROR_CODE.DRAFT_NOT_FOUND, "skill draft not found", { slug, agent: agentResult.data });
    reply.header("X-Request-Id", requestId);
    return { ...draft, request_id: requestId };
  });

  app.delete("/api/v1/skills/:slug/draft/:agent", async (request, reply) => {
    const { actor, requestId } = await authenticated(request, repository);
    const { slug, agent: agentValue } = request.params as { slug: string; agent: string };
    const agentResult = registryAgentSchema.safeParse(agentValue);
    if (!agentResult.success) {
      throw new ServerDomainError(422, "VALIDATION_FAILED", "agent path param must be a valid registry agent");
    }
    const agent = agentResult.data;
    const result = await mutation(request, repository, actor, requestId, async () => {
      const body = z.object({ revision: z.number().int().positive() }).strict().parse(request.body);
      await registry.deleteDraft(slug, agent, body.revision);
      await writeAudit(repository, {
        actorId: actor.actorId, projectId: null, action: "skill.draft.discarded",
        targetId: slug, requestId, details: { slug, agent }
      });
      return { statusCode: 200, body: { slug, agent, discarded: true } };
    });
    return send(reply, requestId, result);
  });

  app.post("/api/v1/skills/:slug/draft/:agent/checks", async (request, reply) => {
    const { actor, requestId } = await authenticated(request, repository);
    const { slug, agent: agentValue } = request.params as { slug: string; agent: string };
    const agentResult = registryAgentSchema.safeParse(agentValue);
    if (!agentResult.success) {
      throw new ServerDomainError(422, "VALIDATION_FAILED", "agent path param must be a valid registry agent");
    }
    const agent = agentResult.data;
    const result = await mutation(request, repository, actor, requestId, async () => {
      const checks = await registry.runChecks({ slug, agent, checkedAt: new Date().toISOString() });
      await writeAudit(repository, {
        actorId: actor.actorId, projectId: null, action: "skill.draft.checked",
        targetId: slug, requestId, details: { slug, agent, red: checks.summary.red }
      });
      return { statusCode: 200, body: checks };
    });
    return send(reply, requestId, result);
  });

  app.post("/api/v1/skills/:slug/draft/:agent/publish", async (request, reply) => {
    const { actor, requestId } = await authenticated(request, repository);
    const { slug, agent: agentValue } = request.params as { slug: string; agent: string };
    const agentResult = registryAgentSchema.safeParse(agentValue);
    if (!agentResult.success) {
      throw new ServerDomainError(422, "VALIDATION_FAILED", "agent path param must be a valid registry agent");
    }
    const agent = agentResult.data;
    const result = await mutation(request, repository, actor, requestId, async () => {
      const body = publishSkillRequestSchema.parse(request.body);
      // R3 ????publish???? persist(tx)?+ writeAudit(tx) ?? withTransaction?
      // audit ? registry_state ???? R3??memory fallback withTransaction no-op?????????
      // PG ?? ? registry_state/audit ??? + version ????in-memory ???? design §3.5 ?????? registry_state ????
      const version = await repository.withTransaction(async (tx) => {
        const v = await registry.publish({
          slug, agent, version: body.version, releaseNote: body.releaseNote ?? null, actorId: actor.actorId
        }, tx);
        await writeAudit(tx, {
          actorId: actor.actorId, projectId: null, action: "skill.published",
          targetId: slug, requestId, details: { slug, agent, version: v.version }
        });
        return v;
      });
      return { statusCode: 200, body: version };
    });
    return send(reply, requestId, result);
  });

  app.post("/api/v1/skills/:slug/npm-release", async (request, reply) => {
    const { actor, requestId } = await authenticated(request, repository);
    const { slug } = request.params as { slug: string };
    const npmConfig = options.npmPublishConfig ?? loadNpmPublishConfig();
    if (!isNpmPublishConfigured(npmConfig)) {
      throw new ServerDomainError(
        503,
        "NPM_PUBLISH_NOT_CONFIGURED",
        "npm publish is not configured on the server (set HUNTER_HARNESS_NPM_SCOPE and HUNTER_HARNESS_NPM_TOKEN)"
      );
    }
    const result = await mutation(request, repository, actor, requestId, async () => {
      const release = await registry.releaseSkillToNpm(
        slug,
        npmConfig,
        async (input) => publishSkillNpmPackage(input, npmConfig, options.npmPublisherDeps ?? {})
      );
      await writeAudit(repository, {
        actorId: actor.actorId,
        projectId: null,
        action: "skill.npm-released",
        targetId: slug,
        requestId,
        details: {
          slug,
          version: release.version,
          packageName: release.packageName,
          status: release.status
        }
      });
      if (release.status === "conflict") {
        throw new ServerDomainError(
          409,
          "NPM_PUBLISH_CONFLICT",
          release.error ?? "npm registry already has this package version",
          { release }
        );
      }
      return { statusCode: 200, body: { slug, release } };
    });
    return send(reply, requestId, result);
  });

  app.post("/api/v1/workflow-families/:slug/npm-release", async (request, reply) => {
    const { actor, requestId } = await authenticated(request, repository);
    const { slug } = request.params as { slug: string };
    const npmConfig = options.npmPublishConfig ?? loadNpmPublishConfig();
    if (!isNpmPublishConfigured(npmConfig)) {
      throw new ServerDomainError(
        503,
        "NPM_PUBLISH_NOT_CONFIGURED",
        "npm publish is not configured on the server (set HUNTER_HARNESS_NPM_SCOPE and HUNTER_HARNESS_NPM_TOKEN)"
      );
    }
    const result = await mutation(request, repository, actor, requestId, async () => {
      const release = await registry.releaseFamilyToNpm(
        slug,
        npmConfig,
        async (input) => publishWorkflowFamilyNpmPackage(input, npmConfig, options.npmPublisherDeps ?? {})
      );
      await writeAudit(repository, {
        actorId: actor.actorId,
        projectId: null,
        action: "workflow.family.npm-released",
        targetId: slug,
        requestId,
        details: {
          slug,
          version: release.version,
          packageName: release.packageName,
          status: release.status
        }
      });
      if (release.status === "conflict") {
        throw new ServerDomainError(
          409,
          "NPM_PUBLISH_CONFLICT",
          release.error ?? "npm registry already has this package version",
          { release }
        );
      }
      return { statusCode: 200, body: { slug, release } };
    });
    return send(reply, requestId, result);
  });

  app.get("/api/v1/skills/:slug/draft/:agent/diff", async (request, reply) => {
    const { requestId } = await authenticated(request, repository);
    const { slug, agent: agentValue } = request.params as { slug: string; agent: string };
    const agentResult = registryAgentSchema.safeParse(agentValue);
    if (!agentResult.success) {
      throw new ServerDomainError(422, "VALIDATION_FAILED", "agent path param must be a valid registry agent");
    }
    const diff = registry.diffDraft(slug, agentResult.data);
    reply.header("X-Request-Id", requestId);
    return { items: diff, request_id: requestId };
  });

  // ???? agent?§3.4??mutation ??? ? setDefaultAgent??? enabled + revision ???? + ?? agents?? audit?
  // 422 AGENT_NOT_ENABLED / 409 REVISION_CONFLICT / 404 SKILL_NOT_FOUND ? store ?? ServerDomainError?????????
  app.patch("/api/v1/skills/:slug/default-agent", async (request, reply) => {
    const { actor, requestId } = await authenticated(request, repository);
    const { slug } = request.params as { slug: string };
    const body = setDefaultAgentRequestSchema.parse(request.body);
    const result = await mutation(request, repository, actor, requestId, async () => {
      const detail = await registry.setDefaultAgent(slug, body.defaultAgent, body.revision);
      await writeAudit(repository, {
        actorId: actor.actorId, projectId: null, action: "skill.default-agent.changed",
        targetId: slug, requestId,
        details: { slug, defaultAgent: body.defaultAgent, revision: detail.revision }
      });
      return { statusCode: 200, body: detail };
    });
    return send(reply, requestId, result);
  });

  app.delete("/api/v1/skills/:slug", async (request, reply) => {
    const { actor, requestId } = await authenticated(request, repository);
    const { slug } = request.params as { slug: string };
    const result = await mutation(request, repository, actor, requestId, async () => {
      await registry.deleteSkill({ slug, actorId: actor.actorId });
      await writeAudit(repository, {
        actorId: actor.actorId, projectId: null, action: "skill.deleted",
        targetId: slug, requestId, details: { slug }
      });
      return { statusCode: 200, body: { slug, deleted: true } };
    });
    return send(reply, requestId, result);
  });

  app.get("/api/v1/tags", async (request, reply) => {
    const { requestId } = await authenticated(request, repository);
    reply.header("X-Request-Id", requestId);
    return { items: registry.listTags(), request_id: requestId };
  });

  app.post("/api/v1/tags", async (request, reply) => {
    const { actor, requestId } = await authenticated(request, repository);
    const body = tagCreateSchema.parse(request.body);
    const result = await mutation(request, repository, actor, requestId, async () => {
      const tag = registry.createTag(body);
      await registry.persist();
      await writeAudit(repository, {
        actorId: actor.actorId, projectId: null, action: "tag.created",
        targetId: tag.tag_id, requestId, details: { slug: tag.slug }
      });
      return { statusCode: 201, body: tag };
    });
    return send(reply, requestId, result);
  });

  app.patch("/api/v1/tags/:tagId", async (request, reply) => {
    const { actor, requestId } = await authenticated(request, repository);
    const { tagId } = request.params as { tagId: string };
    const body = tagUpdateSchema.parse(request.body);
    const result = await mutation(request, repository, actor, requestId, async () => {
      const tag = registry.updateTag(tagId, body);
      await registry.persist();
      await writeAudit(repository, {
        actorId: actor.actorId, projectId: null, action: "tag.updated",
        targetId: tagId, requestId, details: { revision: tag.revision }
      });
      return { statusCode: 200, body: tag };
    });
    return send(reply, requestId, result);
  });

  app.post("/api/v1/tags/:tagId/merge", async (request, reply) => {
    const { actor, requestId } = await authenticated(request, repository);
    const { tagId } = request.params as { tagId: string };
    const body = tagMergeSchema.parse(request.body);
    const result = await mutation(request, repository, actor, requestId, async () => {
      const source = registry.mergeTag(tagId, body.target_tag_id, body.revision);
      await registry.persist();
      await writeAudit(repository, {
        actorId: actor.actorId, projectId: null, action: "tag.merged",
        targetId: tagId, requestId, details: { target_tag_id: body.target_tag_id }
      });
      return { statusCode: 200, body: { ...source, merged_into: body.target_tag_id } };
    });
    return send(reply, requestId, result);
  });

  for (const method of ["PUT", "DELETE"] as const) {
    app.route({
      method,
      url: "/api/v1/skills/:slug/tags/:tagId",
      handler: async (request, reply) => {
        const { actor, requestId } = await authenticated(request, repository);
        const { slug, tagId } = request.params as { slug: string; tagId: string };
        const result = await mutation(request, repository, actor, requestId, async () => {
          const skill = registry.bindTag(slug, tagId, method === "DELETE");
          await registry.persist();
          await writeAudit(repository, {
            actorId: actor.actorId, projectId: null,
            action: method === "DELETE" ? "skill.tag.removed" : "skill.tag.bound",
            targetId: skill.skill_id, requestId, details: { tag_id: tagId }
          });
          return { statusCode: 200, body: skill };
        });
        return send(reply, requestId, result);
      }
    });
  }

  app.get("/api/v1/workflow-families", async (request, reply) => {
    const { requestId } = await authenticated(request, repository);
    reply.header("X-Request-Id", requestId);
    return { items: registry.listWorkflowFamilies(), request_id: requestId };
  });

  app.post("/api/v1/workflow-families", async (request, reply) => {
    const { actor, requestId } = await authenticated(request, repository);
    const body = workflowFamilyMutationSchema.extend({ schema_version: z.literal(1) }).strict().parse(request.body);
    const result = await mutation(request, repository, actor, requestId, async () => {
      const family = registry.createWorkflowFamily({
        slug: body.slug,
        displayName: body.displayName,
        description: body.description,
        tags: body.tags,
        required_profiles: body.required_profiles
      });
      await registry.persist();
      await writeAudit(repository, {
        actorId: actor.actorId, projectId: null, action: "workflow.family.created",
        targetId: family.family_id, requestId, details: { slug: family.slug }
      });
      return { statusCode: 201, body: family };
    });
    return send(reply, requestId, result);
  });

  app.get("/api/v1/workflow-families/:slug", async (request, reply) => {
    const { requestId } = await authenticated(request, repository);
    const { slug } = request.params as { slug: string };
    reply.header("X-Request-Id", requestId);
    return { ...registry.getWorkflowFamily(slug), request_id: requestId };
  });

  app.get("/api/v1/projects/:projectId/workflow-binding", async (request, reply) => {
    const { actor, requestId } = await authenticated(request, repository);
    const { projectId } = request.params as { projectId: string };
    await repository.getProject(actor.actorId, projectId);
    reply.header("X-Request-Id", requestId);
    return { binding: registry.getProjectBinding(projectId), request_id: requestId };
  });

  app.get("/api/v1/projects/:projectId/semantic/overview", async (request, reply) => {
    const { actor, requestId } = await authenticated(request, repository);
    const { projectId } = request.params as { projectId: string };
    await repository.getProject(actor.actorId, projectId);
    reply.header("X-Request-Id", requestId);
    return { ...(await semanticStore.overview(projectId)), request_id: requestId };
  });

  app.get("/api/v1/projects/:projectId/semantic/knowledge", async (request, reply) => {
    const { actor, requestId } = await authenticated(request, repository);
    const { projectId } = request.params as { projectId: string };
    await repository.getProject(actor.actorId, projectId);
    reply.header("X-Request-Id", requestId);
    return {
      items: await semanticStore.listByKinds(projectId, ["knowledge_entry", "knowledge_markdown"]),
      request_id: requestId
    };
  });

  app.get("/api/v1/projects/:projectId/semantic/rules", async (request, reply) => {
    const { actor, requestId } = await authenticated(request, repository);
    const { projectId } = request.params as { projectId: string };
    await repository.getProject(actor.actorId, projectId);
    reply.header("X-Request-Id", requestId);
    return {
      items: await semanticStore.listByKinds(projectId, ["rule"]),
      request_id: requestId
    };
  });

  app.get("/api/v1/projects/:projectId/semantic/changes", async (request, reply) => {
    const { actor, requestId } = await authenticated(request, repository);
    const { projectId } = request.params as { projectId: string };
    await repository.getProject(actor.actorId, projectId);
    reply.header("X-Request-Id", requestId);
    return {
      items: await semanticStore.listByKinds(projectId, ["archive_record"]),
      request_id: requestId
    };
  });

  app.get("/api/v1/projects/:projectId/semantic/graph", async (request, reply) => {
    const { actor, requestId } = await authenticated(request, repository);
    const { projectId } = request.params as { projectId: string };
    await repository.getProject(actor.actorId, projectId);
    reply.header("X-Request-Id", requestId);
    return {
      nodes: await semanticStore.listByKinds(projectId, [
        "knowledge_entry",
        "knowledge_markdown",
        "rule",
        "archive_record",
        "agent_instruction"
      ]),
      edges: await semanticStore.listEdges(projectId),
      request_id: requestId
    };
  });

  app.get("/api/v1/semantic/search", async (request, reply) => {
    const { actor, requestId } = await authenticated(request, repository);
    const query = request.query as Record<string, string | undefined>;
    const q = query.q?.trim() ?? "";
    if (q.length === 0) {
      throw new ServerDomainError(400, "VALIDATION_FAILED", "q is required");
    }
    const projectId = query.project_id;
    if (projectId !== undefined) {
      await repository.getProject(actor.actorId, projectId);
    }
    const items = await semanticStore.search(q, projectId);
    reply.header("X-Request-Id", requestId);
    return {
      items: items.map((document) => ({ document, project_id: document.project_id })),
      request_id: requestId
    };
  });

  app.put("/api/v1/projects/:projectId/workflow-binding", async (request, reply) => {
    const { actor, requestId } = await authenticated(request, repository);
    const { projectId } = request.params as { projectId: string };
    await repository.getProject(actor.actorId, projectId);
    const body = projectWorkflowBindingSchema.parse(request.body);
    const result = await mutation(request, repository, actor, requestId, async () => {
      const binding = registry.bindProjectWorkflowFamily({
        projectId,
        familySlug: body.family_slug,
        profile: body.profile,
        version: body.version ?? null,
        revision: body.revision
      });
      await registry.persist();
      await writeAudit(repository, {
        actorId: actor.actorId, projectId, action: "project.workflow.bound",
        targetId: projectId, requestId,
        details: { family_slug: binding.family_slug, profile: binding.profile, revision: binding.revision }
      });
      return { statusCode: 200, body: binding };
    });
    return send(reply, requestId, result);
  });

  app.post("/api/v1/workflow-families/:slug/draft/profiles/:profile", async (request, reply) => {
    const { actor, requestId } = await authenticated(request, repository);
    const { slug, profile } = request.params as { slug: string; profile: string };
    const collected: Array<{ path: string; buffer: Buffer }> = [];
    for await (const part of request.parts()) {
      if (part.type !== "file") continue;
      collected.push({ path: part.filename ?? "file", buffer: await part.toBuffer() });
    }
    const files = resolveUploadFiles(collected);
    const bodyHash = sha256Bytes(canonicalJson(files.map((f) => ({ path: f.path, content: f.content }))));
    const result = await mutation(request, repository, actor, requestId, async () => {
      const draft = await registry.uploadWorkflowFamilyProfileDraft({
        slug, profile, files, actorId: actor.actorId
      });
      await writeAudit(repository, {
        actorId: actor.actorId, projectId: null,
        action: draft.revision === 1 ? "workflow.family.draft.created" : "workflow.family.draft.updated",
        targetId: slug, requestId,
        details: { slug, profile, revision: draft.revision }
      });
      return { statusCode: 201, body: draft };
    }, bodyHash);
    return send(reply, requestId, result);
  });

  app.get("/api/v1/workflow-families/:slug/draft", async (request, reply) => {
    const { requestId } = await authenticated(request, repository);
    const { slug } = request.params as { slug: string };
    const draft = registry.getWorkflowFamilyDraft(slug);
    reply.header("X-Request-Id", requestId);
    return { ...draft, request_id: requestId };
  });

  app.delete("/api/v1/workflow-families/:slug/draft", async (request, reply) => {
    const { actor, requestId } = await authenticated(request, repository);
    const { slug } = request.params as { slug: string };
    const result = await mutation(request, repository, actor, requestId, async () => {
      const body = z.object({ revision: z.number().int().positive() }).strict().parse(request.body);
      await registry.discardWorkflowFamilyDraft(slug, body.revision);
      await writeAudit(repository, {
        actorId: actor.actorId, projectId: null, action: "workflow.family.draft.discarded",
        targetId: slug, requestId, details: { slug }
      });
      return { statusCode: 200, body: { slug, discarded: true } };
    });
    return send(reply, requestId, result);
  });

  app.post("/api/v1/workflow-families/:slug/draft/checks", async (request, reply) => {
    const { actor, requestId } = await authenticated(request, repository);
    const { slug } = request.params as { slug: string };
    const result = await mutation(request, repository, actor, requestId, async () => {
      const checks = await registry.runWorkflowFamilyChecks({ slug, checkedAt: new Date().toISOString() });
      await writeAudit(repository, {
        actorId: actor.actorId, projectId: null, action: "workflow.family.draft.checked",
        targetId: slug, requestId, details: { slug, red: checks.summary.red }
      });
      return { statusCode: 200, body: checks };
    });
    return send(reply, requestId, result);
  });

  app.post("/api/v1/workflow-families/:slug/publish", async (request, reply) => {
    const { actor, requestId } = await authenticated(request, repository);
    const { slug } = request.params as { slug: string };
    const result = await mutation(request, repository, actor, requestId, async () => {
      const body = publishWorkflowFamilyRequestSchema.parse(request.body);
      const version = await registry.publishWorkflowFamily(slug, {
        version: body.version, releaseNote: body.releaseNote ?? null, actorId: actor.actorId
      });
      await writeAudit(repository, {
        actorId: actor.actorId, projectId: null, action: "workflow.family.published",
        targetId: slug, requestId, details: { slug, version: version.version }
      });
      return { statusCode: 200, body: version };
    });
    return send(reply, requestId, result);
  });

  app.get("/api/v1/workflow-families/:slug/draft/diff", async (request, reply) => {
    const { requestId } = await authenticated(request, repository);
    const { slug } = request.params as { slug: string };
    const query = z.object({ profile: registrySlugSchema.optional() }).strict().parse(request.query);
    const diff = registry.diffWorkflowFamilyDraft(slug, query.profile);
    reply.header("X-Request-Id", requestId);
    return { items: diff, request_id: requestId };
  });

  app.get("/api/v1/workflow-families/:slug/versions", async (request, reply) => {
    const { requestId } = await authenticated(request, repository);
    const { slug } = request.params as { slug: string };
    const versions = registry.listWorkflowFamilyVersions(slug);
    reply.header("X-Request-Id", requestId);
    return { items: versions, request_id: requestId };
  });

  app.get("/api/v1/workflow-families/:slug/artifacts/:profile/download", async (request, reply) => {
    const { actor, requestId } = await authenticated(request, repository);
    const { slug, profile } = request.params as { slug: string; profile: string };
    const query = z.object({ version: z.string().optional() }).strict().parse(request.query);
    const bytes = await registry.getWorkflowFamilyProfileArtifactBytes(slug, profile, query.version);
    const family = registry.getWorkflowFamily(slug);
    const version = query.version ?? family.latest_version ?? "draft";
    const hash = sha256Bytes(bytes);
    await writeAudit(repository, {
      actorId: actor.actorId,
      projectId: null,
      action: "workflow.family.artifact.downloaded",
      targetId: slug,
      requestId,
      details: { slug, profile, version }
    });
    reply
      .header("Content-Type", "application/zip")
      .header("Content-Disposition", `attachment; filename="${slug}-${profile}-${version}.zip"`)
      .header("X-Content-SHA256", hash)
      .header("ETag", hash)
      .header("X-Request-Id", requestId);
    return Buffer.from(bytes);
  });

  // ---- AI ?? + AI ???§12.9 / §6.2?----

  app.get("/api/v1/ai-config/providers", async (request, reply) => {
    const { requestId } = await authenticated(request, repository);
    const providers = registry.listProviders();
    const defaultProvider = registry.getDefaultProvider();
    const items = await Promise.all(providers.map(async (p) => ({
      ...p,
      key_set: (await loadAiSecret(config.aiSecretFile, p.provider_id)) !== null
    })));
    reply.header("X-Request-Id", requestId);
    return {
      items,
      default_provider: defaultProvider?.provider_id ?? null,
      request_id: requestId
    };
  });

  app.post("/api/v1/ai-config/providers", async (request, reply) => {
    const { actor, requestId } = await authenticated(request, repository);
    const body = aiProviderCreateSchema.parse(request.body);
    const result = await mutation(request, repository, actor, requestId, async () => {
      const provider = await registry.upsertProvider({
        provider_id: body.provider_id,
        label: body.label,
        base_url: body.base_url,
        model: body.model,
        enabled: body.enabled,
        api_key_env: body.api_key_env,
        ...(body.is_default === undefined ? {} : { is_default: body.is_default }),
        ...(body.daily_request_limit === undefined ? {} : { daily_request_limit: body.daily_request_limit }),
        ...(body.daily_token_limit === undefined ? {} : { daily_token_limit: body.daily_token_limit }),
        ...(body.models === undefined ? {} : { models: body.models }),
        ...(body.api_format === undefined ? {} : { api_format: body.api_format }),
        ...(body.note === undefined ? {} : { note: body.note }),
        ...(body.website === undefined ? {} : { website: body.website }),
        ...(body.selected_model_id === undefined ? {} : { selected_model_id: body.selected_model_id }),
        ...(body.sort_order === undefined ? {} : { sort_order: body.sort_order })
      });
      await writeAudit(repository, {
        actorId: actor.actorId, projectId: null, action: "ai.provider.created",
        targetId: provider.provider_id, requestId,
        details: { provider_id: provider.provider_id, label: provider.label, revision: provider.revision }
      });
      if (body.api_key !== undefined && body.api_key !== "") {
        await writeAiSecret(config.aiSecretFile, body.provider_id, { apiKey: body.api_key });
        await writeAudit(repository, {
          actorId: actor.actorId, projectId: null, action: "ai.provider.key-set",
          targetId: provider.provider_id, requestId,
          details: { provider_id: provider.provider_id }
        });
      }
      return { statusCode: 201, body: provider };
    });
    return send(reply, requestId, result);
  });

  app.patch("/api/v1/ai-config/providers/:providerId", async (request, reply) => {
    const { actor, requestId } = await authenticated(request, repository);
    const { providerId } = request.params as { providerId: string };
    const body = aiProviderUpdateSchema.parse(request.body);
    const result = await mutation(request, repository, actor, requestId, async () => {
      const patch: Partial<Pick<AiProviderConfig, "label" | "base_url" | "model" | "enabled" | "api_key_env" | "daily_request_limit" | "daily_token_limit" | "models" | "api_format" | "note" | "website" | "selected_model_id" | "sort_order">> = {};
      if (body.label !== undefined) patch.label = body.label;
      if (body.base_url !== undefined) patch.base_url = body.base_url;
      if (body.model !== undefined) patch.model = body.model;
      if (body.enabled !== undefined) patch.enabled = body.enabled;
      if (body.api_key_env !== undefined) patch.api_key_env = body.api_key_env;
      if (body.daily_request_limit !== undefined) patch.daily_request_limit = body.daily_request_limit;
      if (body.daily_token_limit !== undefined) patch.daily_token_limit = body.daily_token_limit;
      if (body.models !== undefined) patch.models = body.models;
      if (body.api_format !== undefined) patch.api_format = body.api_format;
      if (body.note !== undefined) patch.note = body.note;
      if (body.website !== undefined) patch.website = body.website;
      if (body.selected_model_id !== undefined) patch.selected_model_id = body.selected_model_id;
      if (body.sort_order !== undefined) patch.sort_order = body.sort_order;
      let provider: AiProviderConfig;
      try {
        provider = await registry.updateProvider(providerId, body.revision, patch);
      } catch (err) {
        // UI tabs can issue rapid sequential PATCH requests while holding a stale revision.
        // Treat AI provider config updates as last-write-wins: on optimistic-lock conflict,
        // retry once with the server's current revision so older browser bundles are also safe.
        if (err instanceof ServerDomainError && err.code === SKILL_ERROR_CODE.REVISION_CONFLICT) {
          const current = registry.listProviders().find((p) => p.provider_id === providerId);
          if (current === undefined) throw err;
          provider = await registry.updateProvider(providerId, current.revision, patch);
        } else {
          throw err;
        }
      }
      // enabled ?????enabled=true ?? provider true??? false????????API-04?
      let exclusiveDisabled: string[] = [];
      if (body.enabled === true) {
        const before = await registry.listProviders();
        exclusiveDisabled = before.filter((p) => p.enabled && p.provider_id !== providerId).map((p) => p.provider_id);
        await registry.setEnabledExclusive(providerId);
      }
      await writeAudit(repository, {
        actorId: actor.actorId, projectId: null, action: "ai.provider.updated",
        targetId: providerId, requestId,
        details: { provider_id: provider.provider_id, revision: provider.revision, exclusive_disabled: exclusiveDisabled }
      });
      if (body.api_key !== undefined && body.api_key !== "") {
        await writeAiSecret(config.aiSecretFile, providerId, { apiKey: body.api_key });
        await writeAudit(repository, {
          actorId: actor.actorId, projectId: null, action: "ai.provider.key-set",
          targetId: providerId, requestId,
          details: { provider_id: providerId }
        });
      }
      return { statusCode: 200, body: provider };
    });
    return send(reply, requestId, result);
  });

  app.delete("/api/v1/ai-config/providers/:providerId", async (request, reply) => {
    const { actor, requestId } = await authenticated(request, repository);
    const { providerId } = request.params as { providerId: string };
    const result = await mutation(request, repository, actor, requestId, async () => {
      await registry.deleteProvider(providerId);
      await writeAudit(repository, {
        actorId: actor.actorId, projectId: null, action: "ai.provider.deleted",
        targetId: providerId, requestId, details: { provider_id: providerId }
      });
      return { statusCode: 200, body: { provider_id: providerId, deleted: true } };
    });
    return send(reply, requestId, result);
  });

  app.post("/api/v1/ai-config/providers/:providerId/test", async (request, reply) => {
    const { actor, requestId } = await authenticated(request, repository);
    const { providerId } = request.params as { providerId: string };
    const result = await mutation(request, repository, actor, requestId, async () => {
      const resolved = await resolveLlmClient(providerId);
      if (resolved === null) {
        throw new ServerDomainError(422, "AI_NOT_CONFIGURED", "ai provider not configured or missing secret", { provider_id: providerId });
      }
      const requestModel = resolveRequestModel(resolved.provider);
      try {
        const res = await resolved.client.analyze({ system: "Reply with the single word: ok", user: "ping" });
        await registry.recordUsage({
          provider_id: providerId,
          model: requestModel,
          requests: res.usage?.requests ?? 1,
          input_tokens: res.usage?.input_tokens ?? 0,
          output_tokens: res.usage?.output_tokens ?? 0,
          cache_hit_tokens: res.usage?.cache_hit_tokens ?? 0,
          cache_create_tokens: res.usage?.cache_create_tokens ?? 0
        });
        return { statusCode: 200, body: { provider_id: providerId, ok: true, model: requestModel } };
      } catch (err) {
        return { statusCode: 200, body: { provider_id: providerId, ok: false, error: err instanceof Error ? err.message : "unknown" } };
      }
    });
    return send(reply, requestId, result);
  });

  // ?? provider API key ? secret file??? DB/??/??????? + ?? key-set ????
  app.post("/api/v1/ai-config/providers/:providerId/key", async (request, reply) => {
    const { actor, requestId } = await authenticated(request, repository);
    const { providerId } = request.params as { providerId: string };
    const body = z.object({
      api_key: z.string().min(1),
      base_url: z.string().optional(),
      model: z.string().optional()
    }).parse(request.body);
    const result = await mutation(request, repository, actor, requestId, async () => {
      const provider = registry.listProviders().find((p) => p.provider_id === providerId);
      if (provider === undefined) {
        throw new ServerDomainError(404, "PROVIDER_NOT_FOUND", "ai provider not found", { provider_id: providerId });
      }
      await writeAiSecret(config.aiSecretFile, providerId, {
        apiKey: body.api_key,
        ...(body.base_url !== undefined ? { baseUrl: body.base_url } : {}),
        ...(body.model !== undefined ? { model: body.model } : {})
      });
      await writeAudit(repository, {
        actorId: actor.actorId, projectId: null, action: "ai.provider.key-set",
        targetId: providerId, requestId,
        details: { provider_id: providerId }
      });
      return { statusCode: 200, body: { provider_id: providerId, key_set: true } };
    });
    return send(reply, requestId, result);
  });

  app.get("/api/v1/ai-config/usage", async (request, reply) => {
    const { requestId } = await authenticated(request, repository);
    const usage = registry.getUsage();
    reply.header("X-Request-Id", requestId);
    return { usage, request_id: requestId };
  });

  // ???? providers?body {schema_version:1, provider_ids} ?????????/?? 422 VALIDATION_FAILED?store.reorderProviders ????
  app.post("/api/v1/ai-config/providers/reorder", async (request, reply) => {
    const { actor, requestId } = await authenticated(request, repository);
    const body = aiProviderReorderRequestSchema.parse(request.body);
    const result = await mutation(request, repository, actor, requestId, async () => {
      await registry.reorderProviders(body.provider_ids);
      await writeAudit(repository, {
        actorId: actor.actorId, projectId: null, action: "ai.provider.reordered",
        targetId: body.provider_ids[0] ?? "", requestId, details: { provider_ids: body.provider_ids }
      });
      return { statusCode: 200, body: { provider_ids: body.provider_ids } };
    });
    return send(reply, requestId, result);
  });

  // ?? AI ???§3.3??POST ???? job ?? jobId + status:pending????? GET /ai-jobs/:id?
  // mutation ???? job?Idempotency-Key ??? POST ??? jobId??job ????????
  // ??????? draft + resolveLlmClient + checkQuota ????? 429 ?? LLM?INT-002??
  // job ???buildAiCheckPrompt ? analyze ? recordUsage ? parseAiCheckResult ? setDraftAiChecks + audit?
  // LLM ?? ? job.failed?draft.aiChecks ?? degraded????? failed ???INT-003??
  app.post("/api/v1/skills/:slug/draft/:agent/ai-checks", async (request, reply) => {
    const { actor, requestId } = await authenticated(request, repository);
    const { slug, agent: agentValue } = request.params as { slug: string; agent: string };
    const agentResult = registryAgentSchema.safeParse(agentValue);
    if (!agentResult.success) {
      throw new ServerDomainError(422, "VALIDATION_FAILED", "agent path param must be a valid registry agent");
    }
    const agent = agentResult.data;
    const result = await mutation(request, repository, actor, requestId, async () => {
      const draft = registry.getDraft(slug, agent);
      if (draft === undefined) {
        throw new ServerDomainError(404, SKILL_ERROR_CODE.DRAFT_NOT_FOUND, "skill draft not found", { slug, agent });
      }
      const resolved = await resolveLlmClient(null);
      if (resolved === null) {
        throw new ServerDomainError(422, "AI_NOT_CONFIGURED", "no default ai provider configured or missing secret");
      }
      // ?????INT-002???? daily_limit ? 429 ?? LLM?
      registry.checkQuota({ provider_id: resolved.provider.provider_id, requests: 1, tokens: 0 });
      // AiJobStore.startJob(slug,agent,fn) dedup?? slug+agent active job ??? jobId?? R2??
      const job = await aiJobStore.startJob(slug, agent, async () => {
        const entry = findEntryFile(draft.sourceFiles, agent);
        const meta = parseFrontmatter(entry.content);
        const prompt = buildAiCheckPrompt({ meta, sourceFiles: draft.sourceFiles });
        const checkedAt = new Date().toISOString();
        const res = await resolved.client.analyze(prompt);
        await registry.recordUsage({
          provider_id: resolved.provider.provider_id,
          model: resolveRequestModel(resolved.provider),
          requests: res.usage?.requests ?? 1,
          input_tokens: res.usage?.input_tokens ?? 0,
          output_tokens: res.usage?.output_tokens ?? 0,
          cache_hit_tokens: res.usage?.cache_hit_tokens ?? 0,
          cache_create_tokens: res.usage?.cache_create_tokens ?? 0
        });
        const aiChecks = parseAiCheckResult(res.content);
        await registry.setDraftAiChecks({ slug, agent, aiChecks, checkedAt });
        await writeAudit(repository, {
          actorId: actor.actorId, projectId: null, action: "skill.draft.ai-checked",
          targetId: slug, requestId, details: { slug, agent, red: aiChecks.summary.red }
        });
        return aiChecks;
      });
      return { statusCode: 200, body: { jobId: job.jobId, status: "pending" } };
    });
    return send(reply, requestId, result);
  });

  // ?? job ???§3.3??completed ? result???/??? 404 JOB_NOT_FOUND?
  app.get("/api/v1/ai-jobs/:jobId", async (request, reply) => {
    const { requestId } = await authenticated(request, repository);
    const { jobId } = request.params as { jobId: string };
    const job = await aiJobStore.getJob(jobId);
    if (job === undefined) {
      throw new ServerDomainError(404, "JOB_NOT_FOUND", "ai job not found or expired", { jobId });
    }
    return send(reply, requestId, {
      statusCode: 200,
      body: {
        jobId: job.jobId,
        slug: job.slug,
        agent: job.agent,
        status: job.status,
        result: job.result,
        error: job.error,
        createdAt: job.createdAt,
        expiresAt: job.expiresAt
      }
    });
  });

  // AI ?????????§5.3??? diffDraft + ir ? LLM ?? releaseNote ? ??? draft.releaseNote + audit?
  // ??? = mutation?? Idempotency-Key+lock?? ai-checks ??????? LLM ????
  // ?? LLM ??? mutation ??????? 60s??????Idempotency-Key ??????draft ?????????
  //    ?????"? analyze ?? mutation ???"???????review YELLOW #1????????
  // ???? AI_TIMEOUT/AI_PARSE_FAILED?200 degraded:true?? 500???????????????
  app.post("/api/v1/skills/:slug/draft/:agent/release-note:generate", async (request, reply) => {
    const { actor, requestId } = await authenticated(request, repository);
    const { slug, agent: agentValue } = request.params as { slug: string; agent: string };
    const agentResult = registryAgentSchema.safeParse(agentValue);
    if (!agentResult.success) {
      throw new ServerDomainError(422, "VALIDATION_FAILED", "agent path param must be a valid registry agent");
    }
    const agent = agentResult.data;
    const result = await mutation(request, repository, actor, requestId, async () => {
      const draft = registry.getDraft(slug, agent);
      if (draft === undefined) {
        throw new ServerDomainError(404, SKILL_ERROR_CODE.DRAFT_NOT_FOUND, "skill draft not found", { slug, agent });
      }
      const resolved = await resolveLlmClient(null);
      if (resolved === null) {
        throw new ServerDomainError(422, "AI_NOT_CONFIGURED", "no default ai provider configured or missing secret");
      }
      const diff = registry.diffDraft(slug, agent);
      const entry = findEntryFile(draft.sourceFiles, agent);
      const meta = parseFrontmatter(entry.content);
      const prompt = buildReleaseNotePrompt({ meta, diff });
      const generatedAt = new Date().toISOString();
      try {
        const res = await resolved.client.analyze(prompt);
        await registry.recordUsage({
          provider_id: resolved.provider.provider_id,
          model: resolveRequestModel(resolved.provider),
          requests: res.usage?.requests ?? 1,
          input_tokens: res.usage?.input_tokens ?? 0,
          output_tokens: res.usage?.output_tokens ?? 0,
          cache_hit_tokens: res.usage?.cache_hit_tokens ?? 0,
          cache_create_tokens: res.usage?.cache_create_tokens ?? 0
        });
        const releaseNote = parseReleaseNote(res.content);
        if (releaseNote === null) {
          // LLM ???/???? ? ?? AI_PARSE_FAILED?? 500??????????????
          await writeAudit(repository, {
            actorId: actor.actorId, projectId: null, action: "skill.draft.release-note.generated",
            targetId: slug, requestId, details: { slug, agent, degraded: true, reason: "AI_PARSE_FAILED" }
          });
          return { statusCode: 200, body: { releaseNote: null, degraded: true, reason: "AI_PARSE_FAILED", generatedAt } };
        }
        await registry.setDraftReleaseNote({ slug, agent, releaseNote, generatedAt });
        await writeAudit(repository, {
          actorId: actor.actorId, projectId: null, action: "skill.draft.release-note.generated",
          targetId: slug, requestId, details: { slug, agent, degraded: false }
        });
        return { statusCode: 200, body: { releaseNote, generatedAt } };
      } catch (err) {
        // LLM ??/??? ? ?? AI_TIMEOUT?? 500???????err.message ?? audit ?????? key ???
        await writeAudit(repository, {
          actorId: actor.actorId, projectId: null, action: "skill.draft.release-note.generated",
          targetId: slug, requestId, details: { slug, agent, degraded: true, reason: "AI_TIMEOUT", error: err instanceof Error ? err.message : "unknown" }
        });
        return { statusCode: 200, body: { releaseNote: null, degraded: true, reason: "AI_TIMEOUT", generatedAt } };
      }
    });
    return send(reply, requestId, result);
  });

  // AI ???????§6.3 ?4???? draft.aiChecks.fixable ???? LLM ??
  // {suggestedContent,explanation,appliesTo}??? FixPlan??????? persist???? apply-fix-suggestion??
  // ? aiChecks ? ? FixPlan?LLM ??/???? ? ???? message-only?? 500??????
  app.post("/api/v1/skills/:slug/draft/:agent/fix-suggestions", async (request, reply) => {
    const { actor, requestId } = await authenticated(request, repository);
    const { slug, agent: agentValue } = request.params as { slug: string; agent: string };
    const agentResult = registryAgentSchema.safeParse(agentValue);
    if (!agentResult.success) {
      throw new ServerDomainError(422, "VALIDATION_FAILED", "agent path param must be a valid registry agent");
    }
    const agent = agentResult.data;
    const body = (request.body ?? {}) as { checkIds?: string[] | null };
    const checkIds = body.checkIds ?? null;
    const draft = registry.getDraft(slug, agent);
    if (draft === undefined) {
      throw new ServerDomainError(404, SKILL_ERROR_CODE.DRAFT_NOT_FOUND, "skill draft not found", { slug, agent });
    }
    if (draft.aiChecks === null) {
      // ? aiChecks ? ? FixPlan????? ai-checks?????? 422?
      return send(reply, requestId, { statusCode: 200, body: { items: [], mergedFiles: [], summary: emptySummary } });
    }
    const resolved = await resolveLlmClient(null);
    if (resolved === null) {
      throw new ServerDomainError(422, "AI_NOT_CONFIGURED", "no default ai provider configured or missing secret");
    }
    const fixableItems = draft.aiChecks.items.filter((i) => i.fixable && (checkIds === null || checkIds.includes(i.id)));
    const generatedAt = new Date().toISOString();
    const entry = findEntryFile(draft.sourceFiles, agent);
    const meta = parseFrontmatter(entry.content);
    const items: FixPlanItem[] = [];
    for (const ci of fixableItems) {
      const prompt = buildFixSuggestionPrompt({ checkItem: ci, meta, sourceFiles: draft.sourceFiles });
      let parsed: FixSuggestionParse | null;
      try {
        const res = await resolved.client.analyze(prompt);
        await registry.recordUsage({
          provider_id: resolved.provider.provider_id,
          model: resolveRequestModel(resolved.provider),
          requests: res.usage?.requests ?? 1,
          input_tokens: res.usage?.input_tokens ?? 0,
          output_tokens: res.usage?.output_tokens ?? 0,
          cache_hit_tokens: res.usage?.cache_hit_tokens ?? 0,
          cache_create_tokens: res.usage?.cache_create_tokens ?? 0
        });
        parsed = parseFixSuggestionResult(res.content);
      } catch {
        // LLM ?? ? ?? message-only?? 500?
        parsed = null;
      }
      const item: FixPlanItem = {
        checkId: ci.id,
        action: "suggest",
        label: ci.label,
        affectedPaths: [],
        riskDelta: null,
        message: ci.message
      };
      if (parsed !== null) {
        item.suggestedContent = parsed.suggestedContent;
        item.explanation = parsed.explanation;
        item.appliesTo = parsed.appliesTo;
        item.generatedAt = generatedAt;
      }
      items.push(item);
    }
    await writeAudit(repository, {
      actorId: actor.actorId, projectId: null, action: "skill.draft.fix-suggestion.generated",
      targetId: slug, requestId, details: { slug, agent, count: items.length }
    });
    return send(reply, requestId, {
      statusCode: 200,
      body: { items, mergedFiles: [], summary: { ...emptySummary, suggestCount: items.length } }
    });
  });

  // AI ???????§6.3 ?4?/§3.6??mutation ??? ? applyFixSuggestion????+? ir/examples+scanSensitive+? aiChecks+revision+1?? audit?
  // appliesTo ?????? store ????examples/allowed_capabilities/instructions/description?tags/null/?? ? 422 SKILL_VALIDATION_FAILED??
  app.post("/api/v1/skills/:slug/draft/:agent/apply-fix-suggestion", async (request, reply) => {
    const { actor, requestId } = await authenticated(request, repository);
    const { slug, agent: agentValue } = request.params as { slug: string; agent: string };
    const agentResult = registryAgentSchema.safeParse(agentValue);
    if (!agentResult.success) {
      throw new ServerDomainError(422, "VALIDATION_FAILED", "agent path param must be a valid registry agent");
    }
    const agent = agentResult.data;
    const body = z.object({
      checkId: z.string().min(1),
      suggestedContent: z.string(),
      appliesTo: z.string().nullable()
    }).strict().parse(request.body);
    const result = await mutation(request, repository, actor, requestId, async () => {
      const draft = await registry.applyFixSuggestion({
        slug,
        agent,
        checkId: body.checkId,
        suggestedContent: body.suggestedContent,
        appliesTo: body.appliesTo,
        actorId: actor.actorId
      });
      await writeAudit(repository, {
        actorId: actor.actorId, projectId: null, action: "skill.draft.fix-suggestion.applied",
        targetId: slug, requestId, details: { slug, agent, checkId: body.checkId, appliesTo: body.appliesTo }
      });
      return { statusCode: 200, body: draft };
    });
    return send(reply, requestId, result);
  });

  app.post("/api/v1/skills/:slug/draft/:agent/fix-preview", async (request, reply) => {
    const { requestId } = await authenticated(request, repository);
    const { slug, agent: agentValue } = request.params as { slug: string; agent: string };
    const agentResult = registryAgentSchema.safeParse(agentValue);
    if (!agentResult.success) {
      throw new ServerDomainError(422, "VALIDATION_FAILED", "agent path param must be a valid registry agent");
    }
    const agent = agentResult.data;
    const { checkIds } = (request.body ?? {}) as { checkIds?: string[] | null };
    const plan = await registry.buildDraftFix(slug, agent, checkIds ?? null);
    return send(reply, requestId, { statusCode: 200, body: { items: plan.items, mergedFiles: plan.mergedFiles, summary: plan.summary } });
  });

  app.post("/api/v1/skills/:slug/draft/:agent/apply-fix", async (request, reply) => {
    const { actor, requestId } = await authenticated(request, repository);
    const { slug, agent: agentValue } = request.params as { slug: string; agent: string };
    const agentResult = registryAgentSchema.safeParse(agentValue);
    if (!agentResult.success) {
      throw new ServerDomainError(422, "VALIDATION_FAILED", "agent path param must be a valid registry agent");
    }
    const agent = agentResult.data;
    const { checkIds } = (request.body ?? {}) as { checkIds?: string[] | null };
    const result = await mutation(request, repository, actor, requestId, async () => {
      const draft = await registry.applyDraftFix(slug, agent, checkIds ?? null);
      await writeAudit(repository, {
        actorId: actor.actorId, projectId: null, action: "skill.draft.fix-applied",
        targetId: slug, requestId, details: { slug, agent, checkIds: checkIds ?? "all" }
      });
      return { statusCode: 200, body: draft };
    });
    return send(reply, requestId, result);
  });

  app.get("/api/v1/external-skills", async (request, reply) => {
    const { requestId } = await authenticated(request, repository);
    const query = request.query as Record<string, string | undefined>;
    reply.header("X-Request-Id", requestId);
    return {
      items: registry.listExternalSkills({
        ...(query.search !== undefined ? { search: query.search } : {}),
        ...(query.source_type !== undefined ? { sourceType: query.source_type } : {})
      }),
      request_id: requestId
    };
  });

  app.get("/api/v1/external-skills/:id", async (request, reply) => {
    const { requestId } = await authenticated(request, repository);
    const { id } = request.params as { id: string };
    reply.header("X-Request-Id", requestId);
    return { ...registry.getExternalSkill(id), request_id: requestId };
  });

  app.post("/api/v1/external-skills", async (request, reply) => {
    const { actor, requestId } = await authenticated(request, repository);
    const body = createExternalSkillRequestSchema.parse(request.body);
    const result = await mutation(request, repository, actor, requestId, async () => {
      const skill = await registry.createExternalSkill(body);
      await writeAudit(repository, {
        actorId: actor.actorId,
        projectId: null,
        action: "external_skill.created",
        targetId: skill.id,
        requestId,
        details: { source: skill.source }
      });
      return { statusCode: 201, body: skill };
    });
    return send(reply, requestId, result);
  });

  app.patch("/api/v1/external-skills/:id", async (request, reply) => {
    const { actor, requestId } = await authenticated(request, repository);
    const { id } = request.params as { id: string };
    const body = patchExternalSkillRequestSchema.parse(request.body);
    const result = await mutation(request, repository, actor, requestId, async () => {
      const skill = await registry.patchExternalSkill({
        id,
        revision: body.revision,
        ...(body.curationNote !== undefined ? { curationNote: body.curationNote } : {}),
        ...(body.tags !== undefined ? { tags: body.tags } : {}),
        ...(body.acknowledgeUpdate !== undefined ? { acknowledgeUpdate: body.acknowledgeUpdate } : {})
      });
      await writeAudit(repository, {
        actorId: actor.actorId,
        projectId: null,
        action: "external_skill.updated",
        targetId: skill.id,
        requestId,
        details: { revision: skill.revision }
      });
      return { statusCode: 200, body: skill };
    });
    return send(reply, requestId, result);
  });

  app.post("/api/v1/external-skills/:id/refresh", async (request, reply) => {
    const { actor, requestId } = await authenticated(request, repository);
    const { id } = request.params as { id: string };
    const result = await mutation(request, repository, actor, requestId, async () => {
      const before = registry.getExternalSkill(id);
      const skill = await registry.refreshExternalSkill(id);
      await writeAudit(repository, {
        actorId: actor.actorId,
        projectId: null,
        action: "external_skill.refreshed",
        targetId: skill.id,
        requestId,
        details: {
          previous_version: before.snapshot.version,
          version: skill.snapshot.version,
          update_available: skill.updateAvailable
        }
      });
      return { statusCode: 200, body: skill };
    });
    return send(reply, requestId, result);
  });

  app.delete("/api/v1/external-skills/:id", async (request, reply) => {
    const { actor, requestId } = await authenticated(request, repository);
    const { id } = request.params as { id: string };
    const result = await mutation(request, repository, actor, requestId, async () => {
      const deleted = await registry.deleteExternalSkill(id);
      await writeAudit(repository, {
        actorId: actor.actorId,
        projectId: null,
        action: "external_skill.deleted",
        targetId: id,
        requestId,
        details: {}
      });
      return { statusCode: 200, body: deleted };
    });
    return send(reply, requestId, result);
  });

  registerSemanticMcpRoutes(app, { repository, semanticStore });

  let externalRefreshTimer: ReturnType<typeof setInterval> | null = null;
  if (config.externalSkillRefreshIntervalMs > 0) {
    externalRefreshTimer = setInterval(() => {
      void registry.refreshAllExternalSkills().catch((error: unknown) => {
        app.log.error({ err: error }, "external skill upstream refresh failed");
      });
    }, config.externalSkillRefreshIntervalMs);
    externalRefreshTimer.unref?.();
  }
  app.addHook("onClose", async () => {
    if (externalRefreshTimer !== null) clearInterval(externalRefreshTimer);
  });

  await app.ready();
  return app;
}
