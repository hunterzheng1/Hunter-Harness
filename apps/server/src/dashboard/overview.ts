import {
  dashboardOverviewSchema,
  type DashboardOverview
} from "@hunter-harness/contracts";

import type { RegistryStore } from "../registry/store.js";
import type { ServerRepository } from "../repositories/interfaces.js";

const DAY_MS = 24 * 60 * 60 * 1000;

function dayKey(value: string | Date): string {
  return new Date(value).toISOString().slice(0, 10);
}

function daysBetween(now: Date, days: number): Array<{ date: string; submitted: number; approved: number; rejected: number; pending: number }> {
  return Array.from({ length: days }, (_, index) => {
    const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - DAY_MS * (days - index - 1));
    return { date: dayKey(date), submitted: 0, approved: 0, rejected: 0, pending: 0 };
  });
}

async function allProjects(repository: ServerRepository, actorId: string) {
  const values = [];
  let cursor: string | null = null;
  do {
    const page = await repository.listProjects({ actorId, limit: 100, cursor });
    values.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor !== null);
  return values;
}

async function allProjectRows<T>(
  projects: Awaited<ReturnType<typeof allProjects>>,
  list: (projectId: string, cursor: string | null) => Promise<{ items: T[]; nextCursor: string | null }>
): Promise<T[]> {
  const result = await Promise.all(projects.map(async (project) => {
    const values: T[] = [];
    let cursor: string | null = null;
    do {
      const page = await list(project.projectId, cursor);
      values.push(...page.items);
      cursor = page.nextCursor;
    } while (cursor !== null);
    return values;
  }));
  return result.flat();
}

function countBy(values: readonly string[]): Array<{ key: string; count: number }> {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts.entries()]
    .map(([key, count]) => ({ key, count }))
    .sort((left, right) => right.count - left.count || left.key.localeCompare(right.key));
}

export async function buildDashboardOverview(input: {
  repository: ServerRepository;
  registry: RegistryStore;
  actorId: string;
  days: number;
  now?: Date;
}): Promise<DashboardOverview> {
  const now = input.now ?? new Date();
  const projects = await allProjects(input.repository, input.actorId);
  const [projectProposals, projectArtifacts, auditEvents] = await Promise.all([
    allProjectRows(projects, (projectId, cursor) => input.repository.listProposals({
      actorId: input.actorId, projectId, limit: 100, cursor, status: null
    })),
    allProjectRows(projects, (projectId, cursor) => input.repository.listArtifacts({
      actorId: input.actorId, projectId, limit: 100, cursor
    })),
    input.repository.listAuditEvents({ actorId: input.actorId, limit: 12 })
  ]);
  const skills = input.registry.listSkills();
  const families = input.registry.listWorkflowFamilies();
  const skillProposals = input.registry.listProposals();
  const skillArtifacts = input.registry.listArtifacts();
  const trend = daysBetween(now, input.days);
  const points = new Map(trend.map((point) => [point.date, point]));
  const add = (at: string, field: "submitted" | "approved" | "rejected" | "pending"): void => {
    const point = points.get(dayKey(at));
    if (point !== undefined) point[field] += 1;
  };

  for (const proposal of projectProposals) {
    add(proposal.createdAt, "submitted");
    if (proposal.status === "pending_review") add(proposal.createdAt, "pending");
    for (const review of proposal.reviewHistory) {
      if (review.decision === "approve") add(review.createdAt, "approved");
      if (review.decision === "reject") add(review.createdAt, "rejected");
    }
  }
  for (const proposal of skillProposals) {
    add(proposal.created_at, "submitted");
    if (proposal.status === "pending_review") add(proposal.created_at, "pending");
    if (proposal.reviewed_at !== null && proposal.status === "approved") add(proposal.reviewed_at, "approved");
    if (proposal.reviewed_at !== null && proposal.status === "rejected") add(proposal.reviewed_at, "rejected");
  }

  const allArtifacts = [...projectArtifacts, ...skillArtifacts];
  const pendingReviews = projectProposals.filter((proposal) => proposal.status === "pending_review").length +
    skillProposals.filter((proposal) => proposal.status === "pending_review").length;
  const approvedProposals = projectProposals.filter((proposal) => proposal.status === "approved").length +
    skillProposals.filter((proposal) => proposal.status === "approved").length;
  const rejectedProposals = projectProposals.filter((proposal) => proposal.status === "rejected").length +
    skillProposals.filter((proposal) => proposal.status === "rejected").length;
  const resolvedProposals = approvedProposals + rejectedProposals;
  const traceableArtifacts = allArtifacts.filter((artifact) => {
    if ("proposalId" in artifact) return artifact.proposalId !== "" && artifact.projectId !== "";
    return artifact.source_proposal_id !== "" && artifact.content_sha256.startsWith("sha256:");
  }).length;
  const generatedAt = now.toISOString();
  const health = [
    {
      key: "review_backlog",
      label: "Review backlog",
      status: pendingReviews === 0 ? "healthy" as const : "attention" as const,
      value: `${pendingReviews} pending`,
      detail: pendingReviews === 0 ? "No proposal currently requires review." : "Human review is required before pending proposals can publish."
    },
    {
      key: "review_outcome",
      label: "Review outcome",
      status: resolvedProposals === 0 ? "unavailable" as const : approvedProposals >= rejectedProposals ? "healthy" as const : "attention" as const,
      value: resolvedProposals === 0 ? "No decisions yet" : `${approvedProposals}/${resolvedProposals} approved`,
      detail: "Calculated from recorded project and Skill review decisions."
    },
    {
      key: "artifact_traceability",
      label: "Artifact traceability",
      status: allArtifacts.length === 0 ? "unavailable" as const : traceableArtifacts === allArtifacts.length ? "healthy" as const : "attention" as const,
      value: `${traceableArtifacts}/${allArtifacts.length} linked`,
      detail: "Artifacts are checked for a source proposal and their governed owner or content hash."
    },
    {
      key: "audit_evidence",
      label: "Audit evidence",
      status: auditEvents.length === 0 ? "unavailable" as const : "healthy" as const,
      value: auditEvents.length === 0 ? "No events yet" : `${auditEvents.length} recent events`,
      detail: "Recent immutable audit entries were read from the governance repository."
    }
  ];

  return dashboardOverviewSchema.parse({
    generated_at: generatedAt,
    window: {
      days: input.days,
      starts_at: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - DAY_MS * (input.days - 1)).toISOString(),
      ends_at: generatedAt
    },
    metrics: {
      projects: projects.length,
      workflows: families.length,
      skills: skills.length,
      published_skills: skills.filter((skill) => skill.status === "published").length,
      pending_reviews: pendingReviews,
      approved_proposals: approvedProposals,
      rejected_proposals: rejectedProposals,
      artifacts: allArtifacts.length,
      project_artifacts: projectArtifacts.length,
      skill_artifacts: skillArtifacts.length
    },
    trend,
    distributions: {
      skill_categories: countBy(skills.map((skill) => skill.kind ?? "unknown")),
      workflow_profiles: countBy(families.flatMap((family) => family.required_profiles))
    },
    health,
    services: [
      { key: "api", label: "Governance API", status: "operational", detail: "Authenticated overview request completed.", checked_at: generatedAt },
      { key: "repository", label: "Project repository", status: "operational", detail: "Projects, proposals, and artifacts were read successfully.", checked_at: generatedAt },
      { key: "registry", label: "Skill registry", status: "operational", detail: "Skill, Workflow, proposal, and artifact metadata were read successfully.", checked_at: generatedAt },
      { key: "audit", label: "Audit log", status: "operational", detail: "Recent audit events were read without exposing event details.", checked_at: generatedAt }
    ],
    activity: auditEvents.map((event) => ({
      event_id: event.eventId,
      action: event.action,
      target_id: event.targetId,
      project_id: event.projectId,
      actor_id: event.actorId,
      created_at: event.createdAt
    }))
  });
}
