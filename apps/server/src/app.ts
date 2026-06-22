import { Buffer } from "node:buffer";

import {
  canonicalJson,
  fileOperationSchema,
  registryAgentSchema,
  registrySlugSchema,
  registryWorkflowMutationSchema,
  skillIrSchema,
  type FileOperation
} from "@hunter-harness/contracts";
import {
  classifyFile,
  decidePush,
  scanSensitiveFiles,
  sha256Bytes,
  uuidV7,
  type BootstrapBundle,
  type FindingOverride
} from "@hunter-harness/core";
import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest
} from "fastify";
import { z, ZodError } from "zod";

import { writeAudit } from "./audit/audit.js";
import { authenticateRequest } from "./auth/tokens.js";
import { defaultServerConfig, type ServerConfig } from "./config.js";
import { RegistryStore } from "./registry/store.js";
import type { RegistryPersistence } from "./registry/persistence.js";
import type {
  Actor,
  IdempotencyRecord,
  ServerRepository
} from "./repositories/interfaces.js";
import { ServerDomainError } from "./repositories/interfaces.js";
import type { ArtifactStorage } from "./storage/interface.js";

export interface CreateServerOptions {
  repository: ServerRepository;
  storage: ArtifactStorage;
  config?: Partial<ServerConfig>;
  logger?: boolean;
  bootstrapBundle?: BootstrapBundle;
  registryPersistence?: RegistryPersistence;
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

const finalizeSchema = z.object({
  schema_version: z.literal(1),
  manifest_sha256: z.string().regex(/^sha256:[a-f0-9]{64}$/)
}).strict();

const reviewSchema = z.object({
  schema_version: z.literal(1),
  decision: z.enum(["approve", "reject", "need_more_evidence", "split"]),
  comment: z.string().max(4000).nullable().optional(),
  target_scope: z.string().min(1),
  split_groups: z.array(z.object({
    name: z.string().min(1),
    item_ids: z.array(z.string().regex(/^item_/)).min(1),
    target_scope: z.string().min(1)
  }).strict()).default([])
}).strict();

const registryProposalCreateSchema = z.object({
  schema_version: z.literal(1),
  skill_ir: skillIrSchema,
  agent: registryAgentSchema
}).strict();

const registryReviewSchema = z.object({
  schema_version: z.literal(1),
  decision: z.enum(["approve", "reject"]),
  comment: z.string().max(4000).nullable().optional()
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

const workflowCreateSchema = registryWorkflowMutationSchema.extend({
  schema_version: z.literal(1)
}).strict();

const workflowUpdateSchema = registryWorkflowMutationSchema.partial().extend({
  revision: z.number().int().positive()
}).strict();

const projectWorkflowBindingSchema = z.object({
  schema_version: z.literal(1),
  workflow_id: z.string().regex(/^wf_/),
  revision: z.number().int().positive().nullable()
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
  action: () => Promise<MutationResult>
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
  const bodyHash = mutationBodyHash(request.body);
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
  const app = Fastify({
    logger: options.logger ?? false,
    bodyLimit: config.maxProposalBytes
  });
  app.addContentTypeParser(
    "application/octet-stream",
    { parseAs: "buffer" },
    (_request, body, done) => done(null, body)
  );

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
    const body = finalizeSchema.parse(request.body);
    const result = await mutation(request, repository, actor, requestId, async () => {
      const session = await repository.getProposalSession(actor.actorId, sessionId);
      if (body.manifest_sha256 !== sha256Bytes(canonicalJson(session.operations))) {
        throw new ServerDomainError(422, "ARTIFACT_HASH_MISMATCH", "proposal manifest hash mismatch");
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
      if (scan.blocked) {
        throw new ServerDomainError(
          422,
          "SENSITIVE_CONTENT_BLOCKED",
          "sensitive content scan blocked the proposal",
          { finding_count: scan.findings.length, scanner_version: scan.scanner_version }
        );
      }
      const proposal = await repository.createProposalFromSession(session);
      await storage.deleteSession(sessionId);
      await writeAudit(repository, {
        actorId: actor.actorId,
        projectId: proposal.projectId,
        action: "proposal.finalized",
        targetId: proposal.proposalId,
        requestId,
        details: { item_count: proposal.items.length }
      });
      return {
        statusCode: 201,
        body: {
          proposal_id: proposal.proposalId,
          status: proposal.status,
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
        created_at: review.createdAt
      })),
      request_id: requestId
    };
  });

  app.post("/api/v1/proposals/:proposalId/review-decisions", async (request, reply) => {
    const { actor, requestId } = await authenticated(request, repository);
    const { proposalId } = request.params as { proposalId: string };
    const body = reviewSchema.parse(request.body);
    const result = await mutation(request, repository, actor, requestId, async () => {
      const review = await repository.reviewProposal({
        actorId: actor.actorId,
        proposalId,
        decision: body.decision,
        comment: body.comment ?? null,
        targetScope: body.target_scope,
        splitGroups: body.split_groups.map((group) => ({
          name: group.name,
          itemIds: group.item_ids,
          targetScope: group.target_scope
        }))
      });
      const proposal = await repository.getProposal(actor.actorId, proposalId);
      await writeAudit(repository, {
        actorId: actor.actorId,
        projectId: proposal.projectId,
        action: body.decision === "approve"
          ? "proposal.approved"
          : body.decision === "reject"
            ? "proposal.rejected"
            : body.decision === "split"
              ? "proposal.split"
              : "proposal.needs_evidence",
        targetId: proposalId,
        requestId,
        details: {
          review_id: review.reviewId,
          artifact_id: review.artifactId,
          child_proposal_ids: review.childProposalIds
        }
      });
      return {
        statusCode: 201,
        body: {
          review_id: review.reviewId,
          proposal_id: proposalId,
          decision: review.decision,
          artifact_id: review.artifactId,
          child_proposal_ids: review.childProposalIds
        }
      };
    });
    return send(reply, requestId, result);
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
        category: query.category,
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
    return { ...registry.getSkill(slug), request_id: requestId };
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
    reply.header("X-Request-Id", requestId);
    return { items: registry.listVersions(slug), request_id: requestId };
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

  app.get("/api/v1/skill-proposals", async (request, reply) => {
    const { requestId } = await authenticated(request, repository);
    const query = request.query as Record<string, string | undefined>;
    reply.header("X-Request-Id", requestId);
    return { items: registry.listProposals(query.status), request_id: requestId };
  });

  app.get("/api/v1/skill-proposals/:proposalId", async (request, reply) => {
    const { requestId } = await authenticated(request, repository);
    const { proposalId } = request.params as { proposalId: string };
    reply.header("X-Request-Id", requestId);
    return { ...registry.getProposal(proposalId), request_id: requestId };
  });

  app.post("/api/v1/skill-proposals", async (request, reply) => {
    const { actor, requestId } = await authenticated(request, repository);
    const body = registryProposalCreateSchema.parse(request.body);
    const result = await mutation(request, repository, actor, requestId, async () => {
      const proposal = registry.createProposal({
        ir: body.skill_ir,
        actorId: actor.actorId,
        agent: body.agent
      });
      await registry.persist();
      await writeAudit(repository, {
        actorId: actor.actorId,
        projectId: null,
        action: "skill.proposal.created",
        targetId: proposal.proposal_id,
        requestId,
        details: { skill_slug: proposal.skill_slug, version: proposal.proposed_ir.version }
      });
      return { statusCode: 201, body: { ...proposal } };
    });
    return send(reply, requestId, result);
  });

  app.post("/api/v1/skill-proposals/:proposalId/review", async (request, reply) => {
    const { actor, requestId } = await authenticated(request, repository);
    const { proposalId } = request.params as { proposalId: string };
    const body = registryReviewSchema.parse(request.body);
    const result = await mutation(request, repository, actor, requestId, async () => {
      const proposal = await registry.reviewProposal({
        proposalId,
        actorId: actor.actorId,
        decision: body.decision,
        comment: body.comment ?? null
      });
      await registry.persist();
      await writeAudit(repository, {
        actorId: actor.actorId,
        projectId: null,
        action: body.decision === "approve" ? "skill.proposal.approved" : "skill.proposal.rejected",
        targetId: proposalId,
        requestId,
        details: {
          skill_slug: proposal.skill_slug,
          published_version: body.decision === "approve" ? proposal.proposed_ir.version : null,
          artifact_ids: proposal.publishedArtifacts.map((item) => item.artifact_id)
        }
      });
      return {
        statusCode: 201,
        body: {
          proposal_id: proposalId,
          decision: body.decision,
          status: proposal.status,
          published_version: body.decision === "approve" ? proposal.proposed_ir.version : null,
          artifacts: proposal.publishedArtifacts
        }
      };
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

  app.get("/api/v1/workflows", async (request, reply) => {
    const { requestId } = await authenticated(request, repository);
    reply.header("X-Request-Id", requestId);
    return { items: registry.listWorkflows(), request_id: requestId };
  });

  app.get("/api/v1/projects/:projectId/workflow-binding", async (request, reply) => {
    const { actor, requestId } = await authenticated(request, repository);
    const { projectId } = request.params as { projectId: string };
    await repository.getProject(actor.actorId, projectId);
    reply.header("X-Request-Id", requestId);
    return { binding: registry.getProjectBinding(projectId), request_id: requestId };
  });

  app.put("/api/v1/projects/:projectId/workflow-binding", async (request, reply) => {
    const { actor, requestId } = await authenticated(request, repository);
    const { projectId } = request.params as { projectId: string };
    await repository.getProject(actor.actorId, projectId);
    const body = projectWorkflowBindingSchema.parse(request.body);
    const result = await mutation(request, repository, actor, requestId, async () => {
      const binding = registry.bindProjectWorkflow({
        projectId, workflowId: body.workflow_id, revision: body.revision
      });
      await registry.persist();
      await writeAudit(repository, {
        actorId: actor.actorId, projectId, action: "project.workflow.bound",
        targetId: projectId, requestId,
        details: { workflow_id: binding.workflow_id, revision: binding.revision }
      });
      return { statusCode: 200, body: binding };
    });
    return send(reply, requestId, result);
  });

  app.get("/api/v1/workflows/:workflowId", async (request, reply) => {
    const { requestId } = await authenticated(request, repository);
    const { workflowId } = request.params as { workflowId: string };
    reply.header("X-Request-Id", requestId);
    return { ...registry.getWorkflow(workflowId), request_id: requestId };
  });

  app.post("/api/v1/workflows", async (request, reply) => {
    const { actor, requestId } = await authenticated(request, repository);
    const parsed = workflowCreateSchema.parse(request.body);
    const body = {
      key: parsed.key,
      name: parsed.name,
      description: parsed.description,
      profile: parsed.profile,
      default_agent: parsed.default_agent,
      enabled: parsed.enabled,
      skill_slugs: parsed.skill_slugs
    };
    const result = await mutation(request, repository, actor, requestId, async () => {
      const workflow = registry.createWorkflow(body);
      await registry.persist();
      await writeAudit(repository, {
        actorId: actor.actorId, projectId: null, action: "workflow.created",
        targetId: workflow.workflow_id, requestId, details: { key: workflow.key }
      });
      return { statusCode: 201, body: workflow };
    });
    return send(reply, requestId, result);
  });

  app.patch("/api/v1/workflows/:workflowId", async (request, reply) => {
    const { actor, requestId } = await authenticated(request, repository);
    const { workflowId } = request.params as { workflowId: string };
    const body = workflowUpdateSchema.parse(request.body);
    const result = await mutation(request, repository, actor, requestId, async () => {
      const workflow = registry.updateWorkflow(workflowId, body);
      await registry.persist();
      await writeAudit(repository, {
        actorId: actor.actorId, projectId: null, action: "workflow.updated",
        targetId: workflowId, requestId, details: { revision: workflow.revision }
      });
      return { statusCode: 200, body: workflow };
    });
    return send(reply, requestId, result);
  });

  app.delete("/api/v1/workflows/:workflowId", async (request, reply) => {
    const { actor, requestId } = await authenticated(request, repository);
    const { workflowId } = request.params as { workflowId: string };
    const query = z.object({ revision: z.coerce.number().int().positive() }).parse(request.query);
    const result = await mutation(request, repository, actor, requestId, async () => {
      registry.deleteWorkflow(workflowId, query.revision);
      await registry.persist();
      await writeAudit(repository, {
        actorId: actor.actorId, projectId: null, action: "workflow.deleted",
        targetId: workflowId, requestId
      });
      return { statusCode: 200, body: { workflow_id: workflowId, deleted: true } };
    });
    return send(reply, requestId, result);
  });

  await app.ready();
  return app;
}
