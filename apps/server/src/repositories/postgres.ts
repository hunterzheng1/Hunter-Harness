import { randomUUID } from "node:crypto";

import { artifactManifestSchema, canonicalJson, fileOperationSchema } from "@hunter-harness/contracts";
import { sha256Bytes } from "@hunter-harness/core";
import type { Pool, PoolClient, QueryResultRow } from "pg";

import type {
  Actor,
  ArtifactRecord,
  AuditEvent,
  IdempotencyRecord,
  ProjectRecord,
  ProposalRecord,
  ProposalSessionRecord,
  ReviewRecord,
  ServerRepository,
  TransactionRepository
} from "./interfaces.js";
import { ServerDomainError } from "./interfaces.js";
import { PgTransactionRepository } from "./transaction-repository.js";

function id(prefix: string): string {
  return prefix + randomUUID().replaceAll("-", "");
}

function tokenHash(token: string): string {
  return sha256Bytes("hunter-harness-token\0" + token);
}

function timestamp(value: unknown): string {
  return value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString();
}

function projectFrom(row: QueryResultRow): ProjectRecord {
  return {
    projectId: String(row.project_id),
    ownerActorId: String(row.owner_actor_id),
    displayName: String(row.display_name),
    latestProjectVersion: row.latest_project_version === null
      ? null
      : String(row.latest_project_version),
    latestArtifactId: row.latest_artifact_id === null ? null : String(row.latest_artifact_id),
    createdAt: timestamp(row.created_at)
  };
}

function sessionFrom(row: QueryResultRow): ProposalSessionRecord {
  return {
    sessionId: String(row.session_id),
    projectId: String(row.project_id),
    actorId: String(row.actor_id),
    baseProjectVersion: row.base_project_version === null
      ? null
      : String(row.base_project_version),
    baseManifestHash: String(row.base_manifest_hash),
    operations: fileOperationSchema.array().parse(row.operations),
    scanOverrides: row.scan_overrides as ProposalSessionRecord["scanOverrides"],
    status: row.status as ProposalSessionRecord["status"],
    expiresAt: timestamp(row.expires_at),
    maxChunkBytes: Number(row.max_chunk_bytes)
  };
}

function reviewFrom(row: QueryResultRow): ReviewRecord {
  return {
    reviewId: String(row.review_id),
    proposalId: String(row.proposal_id),
    actorId: String(row.actor_id),
    decision: row.decision as ReviewRecord["decision"],
    comment: row.comment === null ? null : String(row.comment),
    targetScope: String(row.target_scope),
    createdAt: timestamp(row.created_at),
    artifactId: row.artifact_id === null ? null : String(row.artifact_id),
    childProposalIds: row.child_proposal_ids as string[]
  };
}

export function idempotencyLockKey(input: {
  actorId: string;
  method: string;
  path: string;
  key: string;
}): string {
  return JSON.stringify([input.actorId, input.method, input.path, input.key]);
}

export class PostgresRepository implements ServerRepository {
  constructor(readonly pool: Pool) {}

  async acquireIdempotencyLock(input: {
    actorId: string;
    method: string;
    path: string;
    key: string;
  }): Promise<{ release(): Promise<void> }> {
    const client = await this.pool.connect();
    const lockKey = idempotencyLockKey(input);
    try {
      await client.query(`SELECT pg_advisory_lock(hashtextextended($1, 0))`, [lockKey]);
    } catch (error) {
      client.release();
      throw error;
    }
    return {
      release: async () => {
        try {
          await client.query(`SELECT pg_advisory_unlock(hashtextextended($1, 0))`, [lockKey]);
        } finally {
          client.release();
        }
      }
    };
  }

  private async transaction<T>(action: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await action(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async createActorWithToken(input: {
    actorId: string;
    token: string;
    displayName?: string;
    label?: string;
  }): Promise<void> {
    await this.transaction(async (client) => {
      await client.query(
        `INSERT INTO actors(actor_id, display_name)
         VALUES ($1, $2)
         ON CONFLICT (actor_id) DO UPDATE SET display_name = EXCLUDED.display_name`,
        [input.actorId, input.displayName ?? input.actorId]
      );
      await client.query(
        `INSERT INTO api_tokens(token_hash, actor_id, label)
         VALUES ($1, $2, $3)
         ON CONFLICT (token_hash) DO UPDATE
         SET actor_id = EXCLUDED.actor_id, label = EXCLUDED.label, revoked_at = NULL`,
        [tokenHash(input.token), input.actorId, input.label ?? "bootstrap"]
      );
    });
  }

  async authenticateToken(token: string): Promise<Actor | null> {
    const result = await this.pool.query(
      `SELECT actor_id FROM api_tokens
       WHERE token_hash = $1 AND revoked_at IS NULL`,
      [tokenHash(token)]
    );
    return result.rowCount === 0 ? null : { actorId: String(result.rows[0]?.actor_id) };
  }

  async resolveProject(input: {
    actorId: string;
    localProjectKey: string;
    displayName: string;
    requestedProjectId: string | null;
  }): Promise<{ project: ProjectRecord; bindingStatus: "created" | "bound" }> {
    return this.transaction(async (client) => {
      const bound = await client.query(
        `SELECT p.* FROM project_bindings b
         JOIN projects p ON p.project_id = b.project_id
         WHERE b.actor_id = $1 AND b.local_project_key = $2
         FOR UPDATE OF b, p`,
        [input.actorId, input.localProjectKey]
      );
      if (bound.rowCount !== 0) {
        const project = projectFrom(bound.rows[0] ?? {});
        if (input.requestedProjectId !== null && input.requestedProjectId !== project.projectId) {
          throw new ServerDomainError(
            409,
            "PROJECT_BINDING_CONFLICT",
            "local project key is already bound"
          );
        }
        return { project, bindingStatus: "bound" as const };
      }
      let project: ProjectRecord;
      let bindingStatus: "created" | "bound";
      if (input.requestedProjectId !== null) {
        const requested = await client.query(
          `SELECT * FROM projects WHERE project_id = $1 FOR UPDATE`,
          [input.requestedProjectId]
        );
        if (requested.rowCount === 0 ||
            requested.rows[0]?.owner_actor_id !== input.actorId) {
          throw new ServerDomainError(
            403,
            "PROJECT_BIND_FORBIDDEN",
            "requested project is not owned by the actor"
          );
        }
        project = projectFrom(requested.rows[0] ?? {});
        bindingStatus = "bound";
      } else {
        const projectId = id("prj_");
        const created = await client.query(
          `INSERT INTO projects(project_id, owner_actor_id, display_name)
           VALUES ($1, $2, $3) RETURNING *`,
          [projectId, input.actorId, input.displayName]
        );
        project = projectFrom(created.rows[0] ?? {});
        bindingStatus = "created";
      }
      await client.query(
        `INSERT INTO project_bindings(actor_id, local_project_key, project_id)
         VALUES ($1, $2, $3)`,
        [input.actorId, input.localProjectKey, project.projectId]
      );
      return { project, bindingStatus };
    });
  }

  async getProject(actorId: string, projectId: string): Promise<ProjectRecord> {
    const result = await this.pool.query(
      `SELECT * FROM projects WHERE project_id = $1 AND owner_actor_id = $2`,
      [projectId, actorId]
    );
    if (result.rowCount === 0) {
      throw new ServerDomainError(404, "PROJECT_NOT_FOUND", "project not found");
    }
    return projectFrom(result.rows[0] ?? {});
  }

  async listProjects(input: {
    actorId: string;
    limit: number;
    cursor: string | null;
  }): Promise<{ items: ProjectRecord[]; nextCursor: string | null }> {
    const offset = input.cursor === null
      ? 0
      : Number.parseInt(Buffer.from(input.cursor, "base64url").toString("utf8"), 10);
    if (!Number.isSafeInteger(offset) || offset < 0) {
      throw new ServerDomainError(400, "INVALID_CURSOR", "cursor is invalid");
    }
    const result = await this.pool.query(
      `SELECT * FROM projects WHERE owner_actor_id = $1
       ORDER BY created_at DESC, project_id DESC LIMIT $2 OFFSET $3`,
      [input.actorId, input.limit + 1, offset]
    );
    return {
      items: result.rows.slice(0, input.limit).map(projectFrom),
      nextCursor: result.rows.length > input.limit
        ? Buffer.from(String(offset + input.limit)).toString("base64url")
        : null
    };
  }

  async createProposalSession(
    input: Omit<ProposalSessionRecord, "sessionId">
  ): Promise<ProposalSessionRecord> {
    await this.getProject(input.actorId, input.projectId);
    const sessionId = id("ups_");
    const result = await this.pool.query(
      `INSERT INTO proposal_sessions(
         session_id, project_id, actor_id, base_project_version,
         base_manifest_hash, operations, scan_overrides, status,
         expires_at, max_chunk_bytes
       ) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8,$9,$10)
       RETURNING *`,
      [
        sessionId,
        input.projectId,
        input.actorId,
        input.baseProjectVersion,
        input.baseManifestHash,
        JSON.stringify(input.operations),
        JSON.stringify(input.scanOverrides),
        input.status,
        input.expiresAt,
        input.maxChunkBytes
      ]
    );
    return sessionFrom(result.rows[0] ?? {});
  }

  async getProposalSession(actorId: string, sessionId: string): Promise<ProposalSessionRecord> {
    const result = await this.pool.query(
      `SELECT s.* FROM proposal_sessions s
       JOIN projects p ON p.project_id = s.project_id
       WHERE s.session_id = $1 AND p.owner_actor_id = $2`,
      [sessionId, actorId]
    );
    if (result.rowCount === 0) {
      throw new ServerDomainError(404, "UPLOAD_SESSION_NOT_FOUND", "upload session not found");
    }
    const session = sessionFrom(result.rows[0] ?? {});
    if (Date.parse(session.expiresAt) <= Date.now()) {
      throw new ServerDomainError(410, "UPLOAD_SESSION_EXPIRED", "upload session expired");
    }
    return session;
  }

  async updateProposalSession(session: ProposalSessionRecord): Promise<void> {
    await this.pool.query(
      `UPDATE proposal_sessions SET status = $2, operations = $3::jsonb,
       scan_overrides = $4::jsonb WHERE session_id = $1`,
      [
        session.sessionId,
        session.status,
        JSON.stringify(session.operations),
        JSON.stringify(session.scanOverrides)
      ]
    );
  }

  async createProposalFromSession(session: ProposalSessionRecord): Promise<ProposalRecord> {
    return this.transaction(async (client) => {
      const locked = await client.query(
        `SELECT * FROM proposal_sessions WHERE session_id = $1 FOR UPDATE`,
        [session.sessionId]
      );
      if (locked.rowCount === 0 || locked.rows[0]?.status !== "open") {
        throw new ServerDomainError(409, "UPLOAD_SESSION_FINALIZED", "session is finalized");
      }
      const proposalId = id("prp_");
      await client.query(
        `INSERT INTO proposals(
          proposal_id, project_id, created_by, base_project_version,
          base_manifest_hash, status
        ) VALUES ($1,$2,$3,$4,$5,'pending_review')`,
        [
          proposalId,
          session.projectId,
          session.actorId,
          session.baseProjectVersion,
          session.baseManifestHash
        ]
      );
      for (let index = 0; index < session.operations.length; index += 1) {
        await client.query(
          `INSERT INTO proposal_items(item_id, proposal_id, item_index, operation)
           VALUES ($1,$2,$3,$4::jsonb)`,
          [id("item_"), proposalId, index, JSON.stringify(session.operations[index])]
        );
      }
      await client.query(
        `UPDATE proposal_sessions SET status = 'finalized' WHERE session_id = $1`,
        [session.sessionId]
      );
      return this.getProposalWith(client, session.actorId, proposalId);
    });
  }

  async finalizeSessionAutoApprove(session: ProposalSessionRecord): Promise<{
    proposal: ProposalRecord;
    review: ReviewRecord;
  }> {
    return this.transaction(async (client) => {
      const locked = await client.query(
        `SELECT * FROM proposal_sessions WHERE session_id = $1 FOR UPDATE`,
        [session.sessionId]
      );
      if (locked.rowCount === 0 || locked.rows[0]?.status !== "open") {
        throw new ServerDomainError(409, "UPLOAD_SESSION_FINALIZED", "session is finalized");
      }
      const proposalId = id("prp_");
      await client.query(
        `INSERT INTO proposals(
          proposal_id, project_id, created_by, base_project_version,
          base_manifest_hash, status
        ) VALUES ($1,$2,$3,$4,$5,'pending_review')`,
        [
          proposalId,
          session.projectId,
          session.actorId,
          session.baseProjectVersion,
          session.baseManifestHash
        ]
      );
      for (let index = 0; index < session.operations.length; index += 1) {
        await client.query(
          `INSERT INTO proposal_items(item_id, proposal_id, item_index, operation)
           VALUES ($1,$2,$3,$4::jsonb)`,
          [id("item_"), proposalId, index, JSON.stringify(session.operations[index])]
        );
      }
      await client.query(
        `UPDATE proposal_sessions SET status = 'finalized' WHERE session_id = $1`,
        [session.sessionId]
      );

      const proposal = await this.getProposalWith(client, session.actorId, proposalId, true);
      const project = await client.query(
        `SELECT latest_project_version FROM projects WHERE project_id = $1 FOR UPDATE`,
        [proposal.projectId]
      );
      const latest = project.rows[0]?.latest_project_version === null
        ? null
        : String(project.rows[0]?.latest_project_version);
      if (proposal.baseProjectVersion !== latest) {
        throw new ServerDomainError(
          409,
          "PROJECT_VERSION_CONFLICT",
          "proposal base version is stale"
        );
      }
      const projectVersion = id("pv_");
      const artifactId = id("art_");
      const payload = {
        schema_version: 1 as const,
        project_id: proposal.projectId,
        project_version: projectVersion,
        artifact_id: artifactId,
        files: proposal.items.map((item) => item.operation)
      };
      const manifest = artifactManifestSchema.parse({
        ...payload,
        manifest_sha256: sha256Bytes(canonicalJson(payload))
      });
      await client.query(
        `INSERT INTO artifacts(
          artifact_id, project_id, project_version, base_project_version,
          proposal_id, manifest
        ) VALUES ($1,$2,$3,$4,$5,$6::jsonb)`,
        [
          artifactId,
          proposal.projectId,
          projectVersion,
          proposal.baseProjectVersion,
          proposal.proposalId,
          JSON.stringify(manifest)
        ]
      );
      await client.query(
        `UPDATE projects SET latest_project_version = $2, latest_artifact_id = $3
         WHERE project_id = $1`,
        [proposal.projectId, projectVersion, artifactId]
      );
      await client.query(
        `UPDATE proposals SET status = $2 WHERE proposal_id = $1`,
        [proposal.proposalId, "approved"]
      );
      const reviewId = id("rev_");
      const inserted = await client.query(
        `INSERT INTO reviews(
          review_id, proposal_id, actor_id, decision, comment, target_scope,
          artifact_id, child_proposal_ids
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb) RETURNING *`,
        [
          reviewId,
          proposal.proposalId,
          session.actorId,
          "auto-approved",
          null,
          "auto-approved",
          artifactId,
          JSON.stringify([])
        ]
      );
      return {
        proposal: await this.getProposalWith(client, session.actorId, proposalId),
        review: reviewFrom(inserted.rows[0] ?? {})
      };
    });
  }

  private async getProposalWith(
    client: Pool | PoolClient,
    actorId: string,
    proposalId: string,
    lock = false
  ): Promise<ProposalRecord> {
    const proposalResult = await client.query(
      `SELECT pr.* FROM proposals pr
       JOIN projects p ON p.project_id = pr.project_id
       WHERE pr.proposal_id = $1 AND p.owner_actor_id = $2${lock ? " FOR UPDATE OF pr" : ""}`,
      [proposalId, actorId]
    );
    if (proposalResult.rowCount === 0) {
      throw new ServerDomainError(404, "PROPOSAL_NOT_FOUND", "proposal not found");
    }
    const row = proposalResult.rows[0] ?? {};
    const [itemsResult, reviewsResult] = await Promise.all([
      client.query(
        `SELECT * FROM proposal_items WHERE proposal_id = $1 ORDER BY item_index`,
        [proposalId]
      ),
      client.query(
        `SELECT * FROM reviews WHERE proposal_id = $1 ORDER BY created_at`,
        [proposalId]
      )
    ]);
    return {
      proposalId: String(row.proposal_id),
      projectId: String(row.project_id),
      createdBy: String(row.created_by),
      baseProjectVersion: row.base_project_version === null
        ? null
        : String(row.base_project_version),
      baseManifestHash: String(row.base_manifest_hash),
      status: row.status as ProposalRecord["status"],
      items: itemsResult.rows.map((item) => ({
        itemId: String(item.item_id),
        operation: fileOperationSchema.parse(item.operation)
      })),
      createdAt: timestamp(row.created_at),
      parentProposalId: row.parent_proposal_id === null
        ? null
        : String(row.parent_proposal_id),
      reviewHistory: reviewsResult.rows.map(reviewFrom)
    };
  }

  async getProposal(actorId: string, proposalId: string): Promise<ProposalRecord> {
    return this.getProposalWith(this.pool, actorId, proposalId);
  }

  async listProposals(input: {
    actorId: string;
    projectId: string;
    limit: number;
    cursor: string | null;
    status: string | null;
  }): Promise<{ items: ProposalRecord[]; nextCursor: string | null }> {
    await this.getProject(input.actorId, input.projectId);
    let offset = 0;
    if (input.cursor !== null) {
      offset = Number.parseInt(Buffer.from(input.cursor, "base64url").toString("utf8"), 10);
      if (!Number.isSafeInteger(offset) || offset < 0) {
        throw new ServerDomainError(400, "INVALID_CURSOR", "cursor is invalid");
      }
    }
    const rows = await this.pool.query(
      `SELECT proposal_id FROM proposals
       WHERE project_id = $1 AND ($2::text IS NULL OR status = $2)
       ORDER BY created_at DESC, proposal_id DESC
       LIMIT $3 OFFSET $4`,
      [input.projectId, input.status, input.limit + 1, offset]
    );
    const selected = rows.rows.slice(0, input.limit);
    const items = [];
    for (const row of selected) {
      items.push(await this.getProposal(input.actorId, String(row.proposal_id)));
    }
    return {
      items,
      nextCursor: rows.rows.length > input.limit
        ? Buffer.from(String(offset + input.limit)).toString("base64url")
        : null
    };
  }

  async reviewProposal(input: {
    actorId: string;
    proposalId: string;
    decision: ReviewRecord["decision"];
    comment: string | null;
    targetScope: string;
    splitGroups: Array<{ name: string; itemIds: string[]; targetScope: string }>;
  }): Promise<ReviewRecord> {
    return this.transaction(async (client) => {
      const proposal = await this.getProposalWith(client, input.actorId, input.proposalId, true);
      if (proposal.status !== "pending_review") {
        throw new ServerDomainError(409, "PROPOSAL_NOT_REVIEWABLE", "proposal is not pending");
      }
      let status: ProposalRecord["status"];
      let artifactId: string | null = null;
      const childProposalIds: string[] = [];
      if (input.decision === "approve" || input.decision === "auto-approved") {
        status = "approved";
        const project = await client.query(
          `SELECT latest_project_version FROM projects WHERE project_id = $1 FOR UPDATE`,
          [proposal.projectId]
        );
        const latest = project.rows[0]?.latest_project_version === null
          ? null
          : String(project.rows[0]?.latest_project_version);
        if (proposal.parentProposalId === null && proposal.baseProjectVersion !== latest) {
          throw new ServerDomainError(
            409,
            "PROJECT_VERSION_CONFLICT",
            "proposal base version is stale"
          );
        }
        if (proposal.parentProposalId !== null) {
          proposal.baseProjectVersion = latest;
          await client.query(
            `UPDATE proposals SET base_project_version = $2 WHERE proposal_id = $1`,
            [proposal.proposalId, latest]
          );
        }
        const projectVersion = id("pv_");
        artifactId = id("art_");
        const payload = {
          schema_version: 1 as const,
          project_id: proposal.projectId,
          project_version: projectVersion,
          artifact_id: artifactId,
          files: proposal.items.map((item) => item.operation)
        };
        const manifest = artifactManifestSchema.parse({
          ...payload,
          manifest_sha256: sha256Bytes(canonicalJson(payload))
        });
        await client.query(
          `INSERT INTO artifacts(
            artifact_id, project_id, project_version, base_project_version,
            proposal_id, manifest
          ) VALUES ($1,$2,$3,$4,$5,$6::jsonb)`,
          [
            artifactId,
            proposal.projectId,
            projectVersion,
            proposal.baseProjectVersion,
            proposal.proposalId,
            JSON.stringify(manifest)
          ]
        );
        await client.query(
          `UPDATE projects SET latest_project_version = $2, latest_artifact_id = $3
           WHERE project_id = $1`,
          [proposal.projectId, projectVersion, artifactId]
        );
      } else if (input.decision === "reject") {
        status = "rejected";
      } else if (input.decision === "need_more_evidence") {
        status = "needs_evidence";
      } else {
        status = "split";
        const allIds = new Set(proposal.items.map((item) => item.itemId));
        const assigned = input.splitGroups.flatMap((group) => group.itemIds);
        if (input.splitGroups.length < 2 || assigned.length !== allIds.size ||
            new Set(assigned).size !== assigned.length ||
            assigned.some((itemId) => !allIds.has(itemId))) {
          throw new ServerDomainError(400, "VALIDATION_FAILED", "split assignment is invalid");
        }
        for (const group of input.splitGroups) {
          const childId = id("prp_");
          await client.query(
            `INSERT INTO proposals(
              proposal_id, project_id, created_by, base_project_version,
              base_manifest_hash, status, parent_proposal_id
            ) VALUES ($1,$2,$3,$4,$5,'pending_review',$6)`,
            [
              childId,
              proposal.projectId,
              proposal.createdBy,
              proposal.baseProjectVersion,
              proposal.baseManifestHash,
              proposal.proposalId
            ]
          );
          const groupItems = proposal.items.filter((item) => group.itemIds.includes(item.itemId));
          for (let index = 0; index < groupItems.length; index += 1) {
            const item = groupItems[index];
            await client.query(
              `INSERT INTO proposal_items(item_id, proposal_id, item_index, operation)
               VALUES ($1,$2,$3,$4::jsonb)`,
              [id("item_"), childId, index, JSON.stringify(item?.operation)]
            );
          }
          childProposalIds.push(childId);
        }
      }
      await client.query(
        `UPDATE proposals SET status = $2 WHERE proposal_id = $1`,
        [proposal.proposalId, status]
      );
      const reviewId = id("rev_");
      const inserted = await client.query(
        `INSERT INTO reviews(
          review_id, proposal_id, actor_id, decision, comment, target_scope,
          artifact_id, child_proposal_ids
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb) RETURNING *`,
        [
          reviewId,
          proposal.proposalId,
          input.actorId,
          input.decision,
          input.comment,
          input.targetScope,
          artifactId,
          JSON.stringify(childProposalIds)
        ]
      );
      return reviewFrom(inserted.rows[0] ?? {});
    });
  }

  async getArtifact(actorId: string, artifactId: string): Promise<ArtifactRecord> {
    const result = await this.pool.query(
      `SELECT a.* FROM artifacts a
       JOIN projects p ON p.project_id = a.project_id
       WHERE a.artifact_id = $1 AND p.owner_actor_id = $2`,
      [artifactId, actorId]
    );
    if (result.rowCount === 0) {
      throw new ServerDomainError(404, "ARTIFACT_NOT_FOUND", "artifact not found");
    }
    const row = result.rows[0] ?? {};
    return {
      artifactId: String(row.artifact_id),
      projectId: String(row.project_id),
      projectVersion: String(row.project_version),
      baseProjectVersion: row.base_project_version === null
        ? null
        : String(row.base_project_version),
      proposalId: String(row.proposal_id),
      manifest: artifactManifestSchema.parse(row.manifest),
      createdAt: timestamp(row.created_at)
    };
  }

  async getLatestArtifact(actorId: string, projectId: string): Promise<ArtifactRecord | null> {
    const project = await this.getProject(actorId, projectId);
    return project.latestArtifactId === null
      ? null
      : this.getArtifact(actorId, project.latestArtifactId);
  }

  async getNextArtifact(
    actorId: string,
    projectId: string,
    baseProjectVersion: string | null
  ): Promise<ArtifactRecord | null> {
    await this.getProject(actorId, projectId);
    const result = await this.pool.query(
      `SELECT artifact_id FROM artifacts
       WHERE project_id = $1 AND base_project_version IS NOT DISTINCT FROM $2
       ORDER BY created_at ASC, artifact_id ASC LIMIT 1`,
      [projectId, baseProjectVersion]
    );
    return result.rowCount === 0
      ? null
      : this.getArtifact(actorId, String(result.rows[0]?.artifact_id));
  }

  async listArtifacts(input: {
    actorId: string;
    projectId: string;
    limit: number;
    cursor: string | null;
  }): Promise<{ items: ArtifactRecord[]; nextCursor: string | null }> {
    await this.getProject(input.actorId, input.projectId);
    const offset = input.cursor === null
      ? 0
      : Number.parseInt(Buffer.from(input.cursor, "base64url").toString("utf8"), 10);
    if (!Number.isSafeInteger(offset) || offset < 0) {
      throw new ServerDomainError(400, "INVALID_CURSOR", "cursor is invalid");
    }
    const result = await this.pool.query(
      `SELECT artifact_id FROM artifacts WHERE project_id = $1
       ORDER BY created_at DESC, artifact_id DESC LIMIT $2 OFFSET $3`,
      [input.projectId, input.limit + 1, offset]
    );
    const selected = result.rows.slice(0, input.limit);
    const items = [];
    for (const row of selected) {
      items.push(await this.getArtifact(input.actorId, String(row.artifact_id)));
    }
    return {
      items,
      nextCursor: result.rows.length > input.limit
        ? Buffer.from(String(offset + input.limit)).toString("base64url")
        : null
    };
  }

  async appendAudit(
    event: Omit<AuditEvent, "eventId" | "createdAt">
  ): Promise<AuditEvent> {
    const result = await this.pool.query(
      `INSERT INTO audit_events(
        event_id, actor_id, project_id, action, target_id, request_id, details
      ) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb) RETURNING *`,
      [
        id("evt_"),
        event.actorId,
        event.projectId,
        event.action,
        event.targetId,
        event.requestId,
        JSON.stringify(event.details)
      ]
    );
    const row = result.rows[0] ?? {};
    return {
      eventId: String(row.event_id),
      actorId: String(row.actor_id),
      projectId: row.project_id === null ? null : String(row.project_id),
      action: String(row.action),
      targetId: String(row.target_id),
      requestId: String(row.request_id),
      details: row.details as Record<string, unknown>,
      createdAt: timestamp(row.created_at)
    };
  }

  async listAuditEvents(input: { actorId: string; limit: number }): Promise<AuditEvent[]> {
    const result = await this.pool.query(
      `SELECT * FROM audit_events
       WHERE actor_id = $1
       ORDER BY created_at DESC, event_id DESC
       LIMIT $2`,
      [input.actorId, input.limit]
    );
    return result.rows.map((row) => ({
      eventId: String(row.event_id),
      actorId: String(row.actor_id),
      projectId: row.project_id === null ? null : String(row.project_id),
      action: String(row.action),
      targetId: String(row.target_id),
      requestId: String(row.request_id),
      details: row.details as Record<string, unknown>,
      createdAt: timestamp(row.created_at)
    }));
  }

  async getIdempotency(input: {
    actorId: string;
    method: string;
    path: string;
    key: string;
  }): Promise<IdempotencyRecord | null> {
    const result = await this.pool.query(
      `SELECT * FROM idempotency_records
       WHERE actor_id = $1 AND method = $2 AND canonical_path = $3
         AND idempotency_key = $4`,
      [input.actorId, input.method, input.path, input.key]
    );
    if (result.rowCount === 0) {
      return null;
    }
    const row = result.rows[0] ?? {};
    return {
      ...input,
      bodyHash: String(row.body_hash),
      statusCode: Number(row.status_code),
      response: row.response
    };
  }

  async putIdempotency(record: IdempotencyRecord): Promise<void> {
    await this.pool.query(
      `INSERT INTO idempotency_records(
        actor_id, method, canonical_path, idempotency_key,
        body_hash, status_code, response
      ) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)
      ON CONFLICT DO NOTHING`,
      [
        record.actorId,
        record.method,
        record.path,
        record.key,
        record.bodyHash,
        record.statusCode,
        JSON.stringify(record.response)
      ]
    );
  }

  // 事务边界：fn 收到 PgTransactionRepository（绑定 PoolClient，SQL 走 client）。
  // publish 路由用它包 publish+persist+writeAudit，确保 audit 与 registry_state 原子（治 R3）。
  async withTransaction<T>(fn: (tx: TransactionRepository) => Promise<T>): Promise<T> {
    return this.transaction(async (client) => fn(new PgTransactionRepository(client)));
  }

  // 非事务路径的 registry_state 读写（接口契约；实际非事务 persist 由 PostgresRegistryPersistence 直接走 pool，
  // 事务内 persist 走 PgTransactionRepository.saveRegistryState）。
  async saveRegistryState(snapshot: unknown): Promise<void> {
    await this.pool.query(
      `INSERT INTO registry_state(state_id, snapshot, updated_at)
       VALUES ('canonical', $1::jsonb, now())
       ON CONFLICT (state_id) DO UPDATE
       SET snapshot = EXCLUDED.snapshot, updated_at = now()`,
      [JSON.stringify(snapshot)]
    );
  }

  async loadRegistryState(): Promise<unknown | null> {
    const result = await this.pool.query(
      "SELECT snapshot FROM registry_state WHERE state_id = 'canonical'"
    );
    return result.rowCount === 0 ? null : result.rows[0]?.snapshot ?? null;
  }
}
