import { artifactManifestSchema, canonicalJson } from "@hunter-harness/contracts";
import { sha256Bytes } from "@hunter-harness/core";

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

function tokenHash(token: string): string {
  return sha256Bytes("hunter-harness-token\0" + token);
}

export class MemoryRepository implements ServerRepository {
  private readonly tokens = new Map<string, Actor>();
  private readonly projects = new Map<string, ProjectRecord>();
  private readonly bindings = new Map<string, string>();
  private readonly sessions = new Map<string, ProposalSessionRecord>();
  private readonly proposals = new Map<string, ProposalRecord>();
  private readonly artifacts = new Map<string, ArtifactRecord>();
  private readonly idempotency = new Map<string, IdempotencyRecord>();
  private readonly auditEvents: AuditEvent[] = [];
  private readonly idempotencyLocks = new Map<string, Promise<void>>();
  private counters = {
    project: 0,
    session: 0,
    proposal: 0,
    item: 0,
    review: 0,
    artifact: 0,
    version: 0,
    event: 0
  };

  async createActorWithToken(input: { actorId: string; token: string }): Promise<void> {
    this.tokens.set(tokenHash(input.token), { actorId: input.actorId });
  }

  async acquireIdempotencyLock(input: {
    actorId: string;
    method: string;
    path: string;
    key: string;
  }): Promise<{ release(): Promise<void> }> {
    const key = this.idempotencyKey(input);
    const previous = this.idempotencyLocks.get(key) ?? Promise.resolve();
    let releaseCurrent: (() => void) | undefined;
    const current = new Promise<void>((resolve) => {
      releaseCurrent = resolve;
    });
    const tail = previous.then(async () => current);
    this.idempotencyLocks.set(key, tail);
    await previous;
    return {
      release: async () => {
        releaseCurrent?.();
        if (this.idempotencyLocks.get(key) === tail) {
          this.idempotencyLocks.delete(key);
        }
      }
    };
  }

  async authenticateToken(token: string): Promise<Actor | null> {
    return this.tokens.get(tokenHash(token)) ?? null;
  }

  async resolveProject(input: {
    actorId: string;
    localProjectKey: string;
    displayName: string;
    requestedProjectId: string | null;
  }): Promise<{ project: ProjectRecord; bindingStatus: "created" | "bound" }> {
    const bindingKey = input.actorId + "\0" + input.localProjectKey;
    const boundId = this.bindings.get(bindingKey);
    if (boundId !== undefined) {
      if (input.requestedProjectId !== null && input.requestedProjectId !== boundId) {
        throw new ServerDomainError(
          409,
          "PROJECT_BINDING_CONFLICT",
          "local project key is already bound"
        );
      }
      return { project: this.requireProject(input.actorId, boundId), bindingStatus: "bound" };
    }

    if (input.requestedProjectId !== null) {
      const requested = this.projects.get(input.requestedProjectId);
      if (requested === undefined || requested.ownerActorId !== input.actorId) {
        throw new ServerDomainError(
          403,
          "PROJECT_BIND_FORBIDDEN",
          "requested project is not owned by the actor"
        );
      }
      this.bindings.set(bindingKey, requested.projectId);
      return { project: requested, bindingStatus: "bound" };
    }

    const projectId = "prj_" + String(++this.counters.project).padStart(8, "0");
    const project: ProjectRecord = {
      projectId,
      ownerActorId: input.actorId,
      displayName: input.displayName,
      latestProjectVersion: null,
      latestArtifactId: null,
      createdAt: new Date().toISOString()
    };
    this.projects.set(projectId, project);
    this.bindings.set(bindingKey, projectId);
    return { project, bindingStatus: "created" };
  }

  private requireProject(actorId: string, projectId: string): ProjectRecord {
    const project = this.projects.get(projectId);
    if (project === undefined || project.ownerActorId !== actorId) {
      throw new ServerDomainError(404, "PROJECT_NOT_FOUND", "project not found");
    }
    return project;
  }

  async getProject(actorId: string, projectId: string): Promise<ProjectRecord> {
    return this.requireProject(actorId, projectId);
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
    const values = [...this.projects.values()]
      .filter((project) => project.ownerActorId === input.actorId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt) ||
        right.projectId.localeCompare(left.projectId));
    const items = values.slice(offset, offset + input.limit);
    const nextOffset = offset + items.length;
    return {
      items,
      nextCursor: nextOffset < values.length
        ? Buffer.from(String(nextOffset)).toString("base64url")
        : null
    };
  }

  async createProposalSession(
    input: Omit<ProposalSessionRecord, "sessionId">
  ): Promise<ProposalSessionRecord> {
    this.requireProject(input.actorId, input.projectId);
    const session: ProposalSessionRecord = {
      ...input,
      sessionId: "ups_" + String(++this.counters.session).padStart(8, "0")
    };
    this.sessions.set(session.sessionId, session);
    return session;
  }

  async getProposalSession(actorId: string, sessionId: string): Promise<ProposalSessionRecord> {
    const session = this.sessions.get(sessionId);
    if (session === undefined) {
      throw new ServerDomainError(404, "UPLOAD_SESSION_NOT_FOUND", "upload session not found");
    }
    this.requireProject(actorId, session.projectId);
    if (Date.parse(session.expiresAt) <= Date.now()) {
      throw new ServerDomainError(410, "UPLOAD_SESSION_EXPIRED", "upload session expired");
    }
    return session;
  }

  async updateProposalSession(session: ProposalSessionRecord): Promise<void> {
    this.sessions.set(session.sessionId, session);
  }

  async createProposalFromSession(session: ProposalSessionRecord): Promise<ProposalRecord> {
    if (session.status !== "open") {
      throw new ServerDomainError(409, "UPLOAD_SESSION_FINALIZED", "session is already finalized");
    }
    const proposal: ProposalRecord = {
      proposalId: "prp_" + String(++this.counters.proposal).padStart(8, "0"),
      projectId: session.projectId,
      createdBy: session.actorId,
      baseProjectVersion: session.baseProjectVersion,
      baseManifestHash: session.baseManifestHash,
      status: "pending_review",
      items: session.operations.map((operation) => ({
        itemId: "item_" + String(++this.counters.item).padStart(8, "0"),
        operation
      })),
      createdAt: new Date().toISOString(),
      parentProposalId: null,
      reviewHistory: []
    };
    session.status = "finalized";
    this.proposals.set(proposal.proposalId, proposal);
    this.sessions.set(session.sessionId, session);
    return proposal;
  }

  async finalizeSessionAutoApprove(session: ProposalSessionRecord): Promise<{
    proposal: ProposalRecord;
    review: ReviewRecord;
  }> {
    const proposal = await this.createProposalFromSession(session);
    const review = await this.reviewProposal({
      actorId: session.actorId,
      proposalId: proposal.proposalId,
      decision: "auto-approved",
      comment: null,
      targetScope: "auto-approved",
      splitGroups: []
    });
    return { proposal: this.requireProposal(session.actorId, proposal.proposalId), review };
  }

  private requireProposal(actorId: string, proposalId: string): ProposalRecord {
    const proposal = this.proposals.get(proposalId);
    if (proposal === undefined) {
      throw new ServerDomainError(404, "PROPOSAL_NOT_FOUND", "proposal not found");
    }
    this.requireProject(actorId, proposal.projectId);
    return proposal;
  }

  async getProposal(actorId: string, proposalId: string): Promise<ProposalRecord> {
    return this.requireProposal(actorId, proposalId);
  }

  async listProposals(input: {
    actorId: string;
    projectId: string;
    limit: number;
    cursor: string | null;
    status: string | null;
  }): Promise<{ items: ProposalRecord[]; nextCursor: string | null }> {
    this.requireProject(input.actorId, input.projectId);
    let offset = 0;
    if (input.cursor !== null) {
      try {
        offset = Number.parseInt(Buffer.from(input.cursor, "base64url").toString("utf8"), 10);
      } catch {
        throw new ServerDomainError(400, "INVALID_CURSOR", "cursor is invalid");
      }
      if (!Number.isSafeInteger(offset) || offset < 0) {
        throw new ServerDomainError(400, "INVALID_CURSOR", "cursor is invalid");
      }
    }
    const values = [...this.proposals.values()]
      .filter((proposal) => proposal.projectId === input.projectId &&
        (input.status === null || proposal.status === input.status))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt) ||
        right.proposalId.localeCompare(left.proposalId));
    const items = values.slice(offset, offset + input.limit);
    const nextOffset = offset + items.length;
    return {
      items,
      nextCursor: nextOffset < values.length
        ? Buffer.from(String(nextOffset)).toString("base64url")
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
    const proposal = this.requireProposal(input.actorId, input.proposalId);
    if (proposal.status !== "pending_review") {
      throw new ServerDomainError(409, "PROPOSAL_NOT_REVIEWABLE", "proposal is not pending review");
    }
    let artifactId: string | null = null;
    const childProposalIds: string[] = [];
    if (input.decision === "approve" || input.decision === "auto-approved") {
      const project = this.requireProject(input.actorId, proposal.projectId);
      if (proposal.parentProposalId === null &&
          proposal.baseProjectVersion !== project.latestProjectVersion) {
        throw new ServerDomainError(
          409,
          "PROJECT_VERSION_CONFLICT",
          "proposal base version is stale"
        );
      }
      if (proposal.parentProposalId !== null) {
        proposal.baseProjectVersion = project.latestProjectVersion;
      }
      const projectVersion = "pv_" + String(++this.counters.version).padStart(8, "0");
      artifactId = "art_" + String(++this.counters.artifact).padStart(8, "0");
      const payload = {
        schema_version: 1 as const,
        project_id: project.projectId,
        project_version: projectVersion,
        artifact_id: artifactId,
        files: proposal.items.map((item) => item.operation)
      };
      const manifest = artifactManifestSchema.parse({
        ...payload,
        manifest_sha256: sha256Bytes(canonicalJson(payload))
      });
      const artifact: ArtifactRecord = {
        artifactId,
        projectId: project.projectId,
        projectVersion,
        baseProjectVersion: proposal.baseProjectVersion,
        proposalId: proposal.proposalId,
        manifest,
        createdAt: new Date().toISOString()
      };
      this.artifacts.set(artifactId, artifact);
      project.latestProjectVersion = projectVersion;
      project.latestArtifactId = artifactId;
      proposal.status = "approved";
    } else if (input.decision === "reject") {
      proposal.status = "rejected";
    } else if (input.decision === "need_more_evidence") {
      proposal.status = "needs_evidence";
    } else {
      const allItemIds = new Set(proposal.items.map((item) => item.itemId));
      const assignedIds = input.splitGroups.flatMap((group) => group.itemIds);
      if (input.splitGroups.length < 2 ||
          assignedIds.length !== allItemIds.size ||
          new Set(assignedIds).size !== assignedIds.length ||
          assignedIds.some((itemId) => !allItemIds.has(itemId))) {
        throw new ServerDomainError(400, "VALIDATION_FAILED", "split requires at least two groups");
      }
      for (const group of input.splitGroups) {
        const child: ProposalRecord = {
          ...proposal,
          proposalId: "prp_" + String(++this.counters.proposal).padStart(8, "0"),
          status: "pending_review",
          items: proposal.items.filter((item) => group.itemIds.includes(item.itemId)),
          createdAt: new Date().toISOString(),
          parentProposalId: proposal.proposalId,
          reviewHistory: []
        };
        this.proposals.set(child.proposalId, child);
        childProposalIds.push(child.proposalId);
      }
      proposal.status = "split";
    }

    const review: ReviewRecord = {
      reviewId: "rev_" + String(++this.counters.review).padStart(8, "0"),
      proposalId: proposal.proposalId,
      actorId: input.actorId,
      decision: input.decision,
      comment: input.comment,
      targetScope: input.targetScope,
      createdAt: new Date().toISOString(),
      artifactId,
      childProposalIds
    };
    proposal.reviewHistory.push(review);
    return review;
  }

  async getArtifact(actorId: string, artifactId: string): Promise<ArtifactRecord> {
    const artifact = this.artifacts.get(artifactId);
    if (artifact === undefined) {
      throw new ServerDomainError(404, "ARTIFACT_NOT_FOUND", "artifact not found");
    }
    this.requireProject(actorId, artifact.projectId);
    return artifact;
  }

  async getLatestArtifact(actorId: string, projectId: string): Promise<ArtifactRecord | null> {
    const project = this.requireProject(actorId, projectId);
    return project.latestArtifactId === null
      ? null
      : this.getArtifact(actorId, project.latestArtifactId);
  }

  async getNextArtifact(
    actorId: string,
    projectId: string,
    baseProjectVersion: string | null
  ): Promise<ArtifactRecord | null> {
    this.requireProject(actorId, projectId);
    return [...this.artifacts.values()]
      .filter((artifact) => artifact.projectId === projectId &&
        artifact.baseProjectVersion === baseProjectVersion)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt) ||
        left.artifactId.localeCompare(right.artifactId))[0] ?? null;
  }

  async listArtifacts(input: {
    actorId: string;
    projectId: string;
    limit: number;
    cursor: string | null;
  }): Promise<{ items: ArtifactRecord[]; nextCursor: string | null }> {
    this.requireProject(input.actorId, input.projectId);
    const offset = input.cursor === null
      ? 0
      : Number.parseInt(Buffer.from(input.cursor, "base64url").toString("utf8"), 10);
    if (!Number.isSafeInteger(offset) || offset < 0) {
      throw new ServerDomainError(400, "INVALID_CURSOR", "cursor is invalid");
    }
    const values = [...this.artifacts.values()]
      .filter((artifact) => artifact.projectId === input.projectId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt) ||
        right.artifactId.localeCompare(left.artifactId));
    const items = values.slice(offset, offset + input.limit);
    return {
      items,
      nextCursor: offset + items.length < values.length
        ? Buffer.from(String(offset + items.length)).toString("base64url")
        : null
    };
  }

  async appendAudit(
    event: Omit<AuditEvent, "eventId" | "createdAt">
  ): Promise<AuditEvent> {
    const stored: AuditEvent = {
      ...event,
      eventId: "evt_" + String(++this.counters.event).padStart(8, "0"),
      createdAt: new Date().toISOString()
    };
    this.auditEvents.push(stored);
    return stored;
  }

  // memory 无真事务语义：no-op 壳，串行执行 fn 并警告（PG fallback 用）。
  // tx 传 this——MemoryRepository 即 ServerRepository 视图（in-memory 写无回滚）。
  async withTransaction<T>(fn: (tx: TransactionRepository) => Promise<T>): Promise<T> {
    console.warn("[memory] withTransaction no-op");
    return fn(this);
  }

  // memory 模式 registry 真相在 RegistryStore 内存 Map（不走 DB）；
  // save/loadRegistryState 满足 ServerRepository 接口契约，存进程内（不持久，重启丢）。
  private registryState: unknown = null;
  async saveRegistryState(snapshot: unknown): Promise<void> {
    this.registryState = snapshot;
  }

  async loadRegistryState(): Promise<unknown | null> {
    return this.registryState;
  }

  async listAuditEvents(input?: { actorId: string; limit: number }): Promise<AuditEvent[]> {
    const events = this.auditEvents
      .filter((event) => input === undefined || event.actorId === input.actorId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.eventId.localeCompare(left.eventId));
    return structuredClone(input === undefined ? events : events.slice(0, input.limit));
  }

  private idempotencyKey(input: {
    actorId: string;
    method: string;
    path: string;
    key: string;
  }): string {
    return [input.actorId, input.method, input.path, input.key].join("\0");
  }

  async getIdempotency(input: {
    actorId: string;
    method: string;
    path: string;
    key: string;
  }): Promise<IdempotencyRecord | null> {
    return this.idempotency.get(this.idempotencyKey(input)) ?? null;
  }

  async putIdempotency(record: IdempotencyRecord): Promise<void> {
    this.idempotency.set(this.idempotencyKey(record), structuredClone(record));
  }
}
