import type { ArtifactManifest, FileOperation } from "@hunter-harness/contracts";
import type { FindingOverride } from "@hunter-harness/core";

export class ServerDomainError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: Record<string, unknown>;

  constructor(
    status: number,
    code: string,
    message: string,
    details: Record<string, unknown> = {}
  ) {
    super(message);
    this.name = "ServerDomainError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export interface Actor {
  actorId: string;
}

export interface ProjectRecord {
  projectId: string;
  ownerActorId: string;
  displayName: string;
  latestProjectVersion: string | null;
  latestArtifactId: string | null;
  createdAt: string;
}

export interface ProposalSessionRecord {
  sessionId: string;
  projectId: string;
  actorId: string;
  baseProjectVersion: string | null;
  baseManifestHash: string;
  operations: FileOperation[];
  scanOverrides: FindingOverride[];
  status: "open" | "finalized";
  expiresAt: string;
  maxChunkBytes: number;
}

export interface ProposalItemRecord {
  itemId: string;
  operation: FileOperation;
}

export type ProposalStatus =
  | "pending_review"
  | "approved"
  | "rejected"
  | "needs_evidence"
  | "split";

export interface ProposalRecord {
  proposalId: string;
  projectId: string;
  createdBy: string;
  baseProjectVersion: string | null;
  baseManifestHash: string;
  status: ProposalStatus;
  items: ProposalItemRecord[];
  createdAt: string;
  parentProposalId: string | null;
  reviewHistory: ReviewRecord[];
}

export interface ReviewRecord {
  reviewId: string;
  proposalId: string;
  actorId: string;
  decision: "approve" | "reject" | "need_more_evidence" | "split";
  comment: string | null;
  targetScope: string;
  createdAt: string;
  artifactId: string | null;
  childProposalIds: string[];
}

export interface ArtifactRecord {
  artifactId: string;
  projectId: string;
  projectVersion: string;
  baseProjectVersion: string | null;
  proposalId: string;
  manifest: ArtifactManifest;
  createdAt: string;
}

export interface AuditEvent {
  eventId: string;
  actorId: string;
  projectId: string | null;
  action: string;
  targetId: string;
  requestId: string;
  details: Record<string, unknown>;
  createdAt: string;
}

export interface IdempotencyRecord {
  actorId: string;
  method: string;
  path: string;
  key: string;
  bodyHash: string;
  statusCode: number;
  response: unknown;
}

export interface ServerRepository {
  acquireIdempotencyLock(input: {
    actorId: string;
    method: string;
    path: string;
    key: string;
  }): Promise<{ release(): Promise<void> }>;
  authenticateToken(token: string): Promise<Actor | null>;
  resolveProject(input: {
    actorId: string;
    localProjectKey: string;
    displayName: string;
    requestedProjectId: string | null;
  }): Promise<{ project: ProjectRecord; bindingStatus: "created" | "bound" }>;
  getProject(actorId: string, projectId: string): Promise<ProjectRecord>;
  createProposalSession(input: Omit<ProposalSessionRecord, "sessionId">): Promise<ProposalSessionRecord>;
  getProposalSession(actorId: string, sessionId: string): Promise<ProposalSessionRecord>;
  updateProposalSession(session: ProposalSessionRecord): Promise<void>;
  createProposalFromSession(session: ProposalSessionRecord): Promise<ProposalRecord>;
  getProposal(actorId: string, proposalId: string): Promise<ProposalRecord>;
  listProposals(input: {
    actorId: string;
    projectId: string;
    limit: number;
    cursor: string | null;
    status: string | null;
  }): Promise<{ items: ProposalRecord[]; nextCursor: string | null }>;
  reviewProposal(input: {
    actorId: string;
    proposalId: string;
    decision: ReviewRecord["decision"];
    comment: string | null;
    targetScope: string;
    splitGroups: Array<{ name: string; itemIds: string[]; targetScope: string }>;
  }): Promise<ReviewRecord>;
  getArtifact(actorId: string, artifactId: string): Promise<ArtifactRecord>;
  getLatestArtifact(actorId: string, projectId: string): Promise<ArtifactRecord | null>;
  getNextArtifact(
    actorId: string,
    projectId: string,
    baseProjectVersion: string | null
  ): Promise<ArtifactRecord | null>;
  appendAudit(event: Omit<AuditEvent, "eventId" | "createdAt">): Promise<AuditEvent>;
  getIdempotency(input: {
    actorId: string;
    method: string;
    path: string;
    key: string;
  }): Promise<IdempotencyRecord | null>;
  putIdempotency(record: IdempotencyRecord): Promise<void>;
}
