"use client";

import Link from "next/link";
import { type FormEvent, useEffect, useMemo, useState } from "react";
import type {
  DashboardOverview,
  RegistrySkillDetail,
  RegistryArtifact,
  RegistrySkillProposal
} from "@hunter-harness/contracts";

import {
  ApiClientError,
  browserApi,
  type HunterApi,
  type ArtifactSummary,
  type ProjectSummary,
  type ProposalDetailModel,
  type ProposalSummary,
  type ReviewInput,
} from "../lib/api";
import { useI18n } from "../lib/i18n";
import { mockApi } from "../lib/mock-api";

// ── Resolve API: real (with token) or mock (offline demo) ──

function resolveApi(): HunterApi {
  return process.env.NEXT_PUBLIC_HUNTER_HARNESS_DEMO === "true" ? mockApi : browserApi();
}

function errorMessage(error: unknown, t: ReturnType<typeof useI18n>["t"]): string {
  if (error instanceof ApiClientError && (error.status === 401 || error.status === 403)) {
    return t.error.authRequired;
  }
  if (error instanceof ApiClientError && error.code === "NETWORK_ERROR") {
    return t.error.networkError + " " + error.message;
  }
  if (error instanceof ApiClientError) {
    return t.error.apiFailed.replace("{code}", error.code);
  }
  return t.error.genericError;
}

// ── Shared helpers ────────────────────────────────────────

function Empty({ children }: { children: React.ReactNode }) {
  return <div className="empty-state">{children}</div>;
}

function Status({ value }: { value: string }) {
  return (
    <span className={`status status-${value.replaceAll("_", "-")}`}>
      {value.replaceAll("_", " ")}
    </span>
  );
}

// ── Dashboard ─────────────────────────────────────────────

export function DashboardConsole({ api: propApi }: { api?: HunterApi }) {
  const { t } = useI18n();
  const api = useMemo(() => propApi ?? resolveApi(), [propApi]);
  const [overview, setOverview] = useState<DashboardOverview | null>(null);
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [skills, setSkills] = useState<RegistrySkillDetail[]>([]);
  const [artifacts, setArtifacts] = useState<ArtifactSummary[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setError(null);
    void Promise.all([
      api.getDashboardOverview(7),
      api.listProjects(),
      api.listSkills?.() ?? Promise.resolve([]),
      api.listAllArtifacts()
    ])
      .then(([nextOverview, nextProjects, nextSkills, nextArtifacts]) => {
        if (!active) return;
        setOverview(nextOverview);
        setProjects(nextProjects);
        setSkills(nextSkills);
        setArtifacts(nextArtifacts);
      })
      .catch((reason: unknown) => {
        if (active) setError(errorMessage(reason, t));
      });
    return () => {
      active = false;
    };
  }, [api, t]);

  if (error !== null) return <Empty>{error}</Empty>;
  if (overview === null) {
    return <Empty>{t.dashboard.loading}</Empty>;
  }

  const attention = overview.health.some((item) => item.status === "attention");
  const metricCards = [
    { label: t.dashboard.registeredProjects, value: overview.metrics.projects, href: "/projects", icon: "projects" as const },
     { label: t.dashboard.workflows, value: overview.metrics.workflows, href: "/workflows", icon: "workflow" as const },
     { label: t.dashboard.publishedSkills, value: overview.metrics.published_skills, href: "/skills", icon: "skill" as const },
    { label: t.dashboard.pendingReviews, value: overview.metrics.pending_reviews, href: "/proposals", icon: "review" as const, attention: overview.metrics.pending_reviews > 0 },
     { label: t.dashboard.artifacts, value: overview.metrics.artifacts, href: "/artifacts", icon: "artifact" as const },
     { label: t.dashboard.approvedProposals, value: overview.metrics.approved_proposals, href: "/proposals", icon: "approval" as const }
  ];

  return (
    <section className="stack dashboard-stack">
      <div className="page-heading dashboard-heading">
        <div>
          <p className="eyebrow">{t.dashboard.eyebrow}</p>
          <h1>{t.dashboard.title}</h1>
          <p className="dashboard-subtitle">{t.dashboard.subtitle.replace("{days}", String(overview.window.days)).replace("{time}", new Date(overview.generated_at).toLocaleString())}</p>
        </div>
        <Status value={attention ? "attention" : "clear"} />
      </div>

      <div className="dashboard-metric-grid">
        {metricCards.map((metric) => (
          <Link className={`dashboard-metric ${metric.attention ? "metric-attention" : ""}`} href={metric.href} key={metric.label}>
            <DashboardIcon name={metric.icon} />
            <strong>{metric.value}</strong>
            <span>{metric.label}</span>
            <small>{t.dashboard.view}</small>
          </Link>
        ))}
      </div>

      <div className="dashboard-main-grid">
        <section className="panel dashboard-chart-panel">
          <div className="panel-title dashboard-panel-title">
            <div><p className="eyebrow">{t.dashboard.sevenDaySignal}</p><h2>{t.dashboard.proposalActivity}</h2></div>
            <div className="chart-legend"><span className="submitted">{t.dashboard.submitted}</span><span className="approved">{t.dashboard.approved}</span><span className="rejected">{t.dashboard.rejected}</span></div>
          </div>
          <TrendChart trend={overview.trend} />
        </section>

        <section className="panel dashboard-distribution-panel">
          <div className="panel-title dashboard-panel-title"><div><p className="eyebrow">{t.dashboard.registryComposition}</p><h2>{t.dashboard.skillDistribution}</h2></div><span>{overview.metrics.skills} {t.dashboard.total}</span></div>
          <DistributionChart items={overview.distributions.skill_categories} />
        </section>
      </div>

      <div className="dashboard-work-grid">
        <section className="panel dashboard-work-panel dashboard-project-panel">
          <div className="panel-title dashboard-panel-title">
            <div><p className="eyebrow">Project registry</p><h2>Recent projects</h2></div>
            <Link href="/projects">View all</Link>
          </div>
          <div className="dashboard-project-list">
            {projects.length === 0 ? <Empty>{t.dashboard.noProjects}</Empty> : projects.slice(0, 4).map((project) => (
              <Link href={`/projects/${project.project_id}`} key={project.project_id}>
                <span className="dashboard-project-mark" aria-hidden="true">{project.display_name.slice(0, 1).toUpperCase()}</span>
                <div><strong>{project.display_name}</strong><code>{project.latest_project_version ?? t.dashboard.noVersion}</code></div>
                <span className="dashboard-role">{project.role}</span>
              </Link>
            ))}
          </div>
        </section>

        <section className="panel dashboard-work-panel">
          <div className="panel-title dashboard-panel-title">
            <div><p className="eyebrow">Registry posture</p><h2>Skill usage</h2></div>
            <Link href="/skills">Open skills</Link>
          </div>
          <div className="skill-usage-summary">
            <div><span>Published coverage</span><strong>{overview.metrics.published_skills}/{overview.metrics.skills}</strong><i><b style={{ width: `${overview.metrics.skills === 0 ? 0 : (overview.metrics.published_skills / overview.metrics.skills) * 100}%` }} /></i></div>
            <div><span>Workflow bindings</span><strong>{overview.metrics.workflows}</strong><small>active governed paths</small></div>
          </div>
          <div className="dashboard-skill-list">
            {skills.slice(0, 3).map((skill) => <Link href={`/skills/${skill.slug}`} key={skill.skill_id}><span>{skill.ir.kind}</span><strong>{skill.name}</strong><code>{skill.latest_version ?? "unversioned"}</code></Link>)}
            {skills.length === 0 ? <Empty>No published Skills are available.</Empty> : null}
          </div>
        </section>

        <section className="panel dashboard-work-panel">
          <div className="panel-title dashboard-panel-title">
            <div><p className="eyebrow">Immutable release log</p><h2>Artifact changes</h2></div>
            <Link href="/artifacts">Open history</Link>
          </div>
          <div className="artifact-change-total"><strong>{overview.metrics.project_artifacts}</strong><span>project artifacts</span><small>{overview.metrics.skill_artifacts} Skill bundles</small></div>
          <div className="dashboard-artifact-list">
            {artifacts.slice(0, 3).map((artifact) => <Link href={`/artifacts/${artifact.artifact_id}`} key={artifact.artifact_id}><div><strong>{artifact.artifact_id}</strong><code>{artifact.project_id} / {artifact.project_version}</code></div><span><b>+{artifact.changed_item_count}</b> changes</span></Link>)}
            {artifacts.length === 0 ? <Empty>No artifacts have been published.</Empty> : null}
          </div>
        </section>
      </div>

      <div className="dashboard-lower-grid">
        <section className="panel dashboard-list-panel">
          <div className="panel-title dashboard-panel-title"><div><p className="eyebrow">{t.dashboard.controlChecks}</p><h2>{t.dashboard.governanceHealth}</h2></div><Status value={attention ? "attention" : "clear"} /></div>
          <div className="signal-list">
            {overview.health.map((item) => <article className="health-row" key={item.key}><Status value={item.status} /><div><strong>{item.label}</strong><p>{item.detail}</p></div><b>{item.value}</b></article>)}
          </div>
        </section>

        <section className="panel dashboard-list-panel">
          <div className="panel-title dashboard-panel-title"><div><p className="eyebrow">{t.dashboard.liveReads}</p><h2>{t.dashboard.systemSignals}</h2></div><span>{new Date(overview.generated_at).toLocaleTimeString()}</span></div>
          <div className="signal-list">
            {overview.services.map((service) => <article className="service-row" key={service.key}><span className={`service-dot ${service.status}`} aria-hidden="true" /><div><strong>{service.label}</strong><p>{service.detail}</p></div><Status value={service.status} /></article>)}
          </div>
        </section>

        <section className="panel dashboard-list-panel">
          <div className="panel-title dashboard-panel-title"><div><p className="eyebrow">{t.dashboard.immutableEvidence}</p><h2>{t.dashboard.recentActivity}</h2></div><Link href="/proposals">{t.dashboard.goReviewQueue}</Link></div>
          <div className="activity-list">
            {overview.activity.length === 0 ? <Empty>{t.dashboard.noActivity}</Empty> : overview.activity.map((event) => <article key={event.event_id}><DashboardIcon name="activity" /><div><strong>{event.action}</strong><p>{event.target_id} · {event.project_id ?? "registry"}</p></div><time dateTime={event.created_at}>{new Date(event.created_at).toLocaleString()}</time></article>)}
          </div>
        </section>
      </div>

      <section className="dashboard-actions">
        <div><p className="eyebrow">{t.dashboard.nextAction}</p><strong>{overview.metrics.pending_reviews === 0 ? t.dashboard.queueClear : `${overview.metrics.pending_reviews} ${t.dashboard.needReview}`}</strong><span>{overview.metrics.pending_reviews === 0 ? t.dashboard.queueClearHint : t.dashboard.needReviewHint}</span></div>
        <div className="dashboard-action-links"><Link href="/proposals">{t.dashboard.openReviewQueue}</Link><Link href="/workflows">{t.dashboard.maintainWorkflows}</Link><Link href="/skills">{t.dashboard.browseSkills}</Link></div>
      </section>
    </section>
  );
}

function DashboardIcon({ name }: { name: "projects" | "workflow" | "skill" | "review" | "artifact" | "approval" | "activity" }) {
  const paths: Record<typeof name, React.ReactNode> = {
    projects: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M7 8h10M7 12h6M7 16h4" /></>,
    workflow: <><circle cx="6" cy="6" r="2" /><circle cx="18" cy="12" r="2" /><circle cx="6" cy="18" r="2" /><path d="M8 7.5 16 11M8 16.5 16 13" /></>,
    skill: <><path d="m12 3 2.4 5.1L20 9l-4 4.1.9 5.9-4.9-2.7L7.1 19l.9-5.9L4 9l5.6-.9L12 3Z" /></>,
    review: <><path d="M5 4h14v16H5zM8 9h8M8 13h5" /><path d="m15 16 1.5 1.5L20 14" /></>,
    artifact: <><path d="M5 4h14v16H5zM8 4v5h8V4M8 15h8" /></>,
    approval: <><circle cx="12" cy="12" r="8" /><path d="m8.5 12 2.3 2.3 4.7-5" /></>,
    activity: <><path d="M4 12h3l2-6 4 12 2-6h5" /></>
  };
  return <svg className="dashboard-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}

function TrendChart({ trend }: { trend: DashboardOverview["trend"] }) {
  const { t } = useI18n();
  const maximum = Math.max(1, ...trend.flatMap((point) => [point.submitted, point.approved, point.rejected]));
  const points = (key: "submitted" | "approved" | "rejected") => trend.map((point, index) => `${(index / Math.max(1, trend.length - 1)) * 100},${88 - (point[key] / maximum) * 72}`).join(" ");
  const submittedPoints = points("submitted");
  const submittedArea = `0,100 ${submittedPoints} 100,100`;
  return <div className="trend-chart" role="img" aria-label="Proposal activity line chart"><div className="trend-chart-meta"><span>Review throughput</span><strong>{trend.reduce((sum, point) => sum + point.approved, 0)} <small>approved</small></strong></div><svg viewBox="0 0 100 100" preserveAspectRatio="none"><defs><linearGradient id="submitted-area" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="var(--accent)" stopOpacity=".26" /><stop offset="100%" stopColor="var(--accent)" stopOpacity="0" /></linearGradient></defs><path className="chart-grid-line" d="M0 16H100M0 52H100M0 88H100" /><polygon className="submitted-area" points={submittedArea} /><polyline className="chart-line submitted-line" points={submittedPoints} /><polyline className="chart-line approved-line" points={points("approved")} /><polyline className="chart-line rejected-line" points={points("rejected")} /></svg><div className="chart-axis">{trend.map((point) => <span key={point.date}>{point.date.slice(5)}</span>)}</div><div className="chart-summary"><span>{trend.reduce((sum, point) => sum + point.submitted, 0)} {t.dashboard.submitted}</span><span>{trend.reduce((sum, point) => sum + point.approved, 0)} {t.dashboard.approved}</span><span>{trend.reduce((sum, point) => sum + point.rejected, 0)} {t.dashboard.rejected}</span></div></div>;
}

function DistributionChart({ items }: { items: DashboardOverview["distributions"]["skill_categories"] }) {
  const { t } = useI18n();
  const total = items.reduce((sum, item) => sum + item.count, 0);
  let offset = 0;
  const palette = ["#17d4ff", "#8f7cff", "#20e3a2", "#f6a956"];
  const segments = items.map((item, index) => { const share = total === 0 ? 0 : item.count / total; const segment = { ...item, color: palette[index % palette.length], offset, share }; offset += share; return segment; });
  const style = { background: total === 0 ? "conic-gradient(var(--line) 0 100%)" : `conic-gradient(${segments.map((segment) => `${segment.color} ${segment.offset * 100}% ${(segment.offset + segment.share) * 100}%`).join(", ")})` };
  return <div className="distribution-chart"><div className="distribution-donut" style={style}><span>{total}</span><small>{t.dashboard.publishedSkills}</small></div><div className="distribution-list">{segments.map((item) => <div key={item.key}><i style={{ background: item.color }} /><span>{item.key}</span><b>{item.count}</b><small>{total === 0 ? 0 : Math.round(item.share * 100)}%</small></div>)}</div></div>;
}

// ── Project Registry ──────────────────────────────────────

export function ProjectRegistry({ api: propApi }: { api?: HunterApi }) {
  const { t } = useI18n();
  const api = useMemo(() => propApi ?? resolveApi(), [propApi]);
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null);
  const [workflowInfo, setWorkflowInfo] = useState<Record<string, { name: string; skillCount: number }>>({});
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [role, setRole] = useState("all");

  useEffect(() => {
    let active = true;
    setError(null);
    void api.listProjects().then(async (items) => {
      const workflows = await (api.listWorkflows?.() ?? Promise.resolve([]));
      const bindings = api.getProjectWorkflowBinding === undefined
        ? items.map(() => null)
        : await Promise.all(items.map((project) => api.getProjectWorkflowBinding?.(project.project_id) ?? Promise.resolve(null)));
      const nextInfo: Record<string, { name: string; skillCount: number }> = {};
      items.forEach((project, index) => {
        const binding = bindings[index];
        const workflow = workflows.find((item) => item.workflow_id === binding?.workflow_id);
        if (workflow !== undefined) nextInfo[project.project_id] = { name: workflow.name, skillCount: workflow.skill_slugs.length };
      });
      if (active) { setProjects(items); setWorkflowInfo(nextInfo); }
    }).catch((reason: unknown) => {
      if (active) setError(errorMessage(reason, t));
    });
    return () => {
      active = false;
    };
  }, [api, t]);

  if (error !== null) return <Empty>{error}</Empty>;
  if (projects === null) return <Empty>{t.projects.loading}</Empty>;

  const normalizedQuery = query.trim().toLowerCase();
  const filteredProjects = projects.filter((project) =>
    (normalizedQuery === "" || project.display_name.toLowerCase().includes(normalizedQuery) || project.project_id.toLowerCase().includes(normalizedQuery)) &&
    (role === "all" || project.role === role)
  );
  const roles = [...new Set(projects.map((project) => project.role))].sort();

  return (
    <section className="stack">
      <div className="page-heading">
        <div>
          <p className="eyebrow">{t.projects.eyebrow}</p>
          <h1>{t.projects.title}</h1>
        </div>
      </div>
      <div className="registry-toolbar compact-toolbar">
        <label>
          {t.projects.searchProjects}
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t.projects.searchPlaceholder} />
        </label>
        <label>
          {t.projects.role}
          <select value={role} onChange={(event) => setRole(event.target.value)}>
            <option value="all">{t.common.all}</option>
            {roles.map((item) => <option value={item} key={item}>{item}</option>)}
          </select>
        </label>
      </div>
      {projects.length === 0 ? (
        <Empty>{t.projects.noProjects}</Empty>
      ) : filteredProjects.length === 0 ? (
        <Empty>{t.projects.noMatch}</Empty>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>{t.projects.table.project}</th>
                <th>{t.projects.table.role}</th>
                <th>{t.projects.table.workflow}</th>
                <th>{t.projects.table.skills}</th>
                <th>{t.projects.table.version}</th>
                <th>{t.projects.table.artifact}</th>
                <th>{t.projects.table.registered}</th>
              </tr>
            </thead>
            <tbody>
              {filteredProjects.map((project) => (
                <tr key={project.project_id}>
                  <td>
                    <Link href={`/projects/${project.project_id}`}>
                      <strong>{project.display_name}</strong>
                      <code>{project.project_id}</code>
                    </Link>
                  </td>
                  <td>{project.role}</td>
                  <td>{workflowInfo[project.project_id]?.name ?? t.common.notBound}</td>
                  <td>{workflowInfo[project.project_id]?.skillCount ?? 0}</td>
                  <td>{project.latest_project_version ?? t.projects.table.none}</td>
                  <td>{project.latest_artifact_id ?? t.projects.table.none}</td>
                  <td>{project.created_at.slice(0, 10)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

// ── Review Queue ──────────────────────────────────────────

export function ReviewQueue({ api: propApi }: { api?: HunterApi }) {
  const { t } = useI18n();
  const api = useMemo(() => propApi ?? resolveApi(), [propApi]);
  const [proposals, setProposals] = useState<ProposalSummary[] | null>(null);
  const [skillProposals, setSkillProposals] = useState<RegistrySkillProposal[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setError(null);
    void Promise.all([
      api.listAllProposals(),
      api.listSkillProposals?.("pending_review") ?? Promise.resolve([])
    ])
      .then(([items, skillItems]) => {
        if (active) {
          setProposals(items.filter((item) => item.status === "pending_review"));
          setSkillProposals(skillItems);
        }
      })
      .catch((reason: unknown) => {
        if (active) setError(errorMessage(reason, t));
      });
    return () => {
      active = false;
    };
  }, [api, t]);

  if (error !== null) return <Empty>{error}</Empty>;
  if (proposals === null) return <Empty>{t.reviewQueue.loading}</Empty>;

  return (
    <section className="stack">
      <div className="page-heading">
        <div>
          <p className="eyebrow">{t.reviewQueue.eyebrow}</p>
          <h1>{t.reviewQueue.title}</h1>
        </div>
        <span>
          {proposals.length + skillProposals.length} {t.reviewQueue.waiting}
        </span>
      </div>
      {proposals.length === 0 && skillProposals.length === 0 ? (
        <Empty>{t.reviewQueue.clear}</Empty>
      ) : (
        <>{skillProposals.map((proposal) => (
          <Link className="proposal-card" href={`/skills/${proposal.skill_slug}`} key={proposal.proposal_id}>
            <div><strong>{proposal.proposal_id}</strong><code>{proposal.skill_slug} · v{proposal.proposed_ir.version}</code></div>
            <div><span>{t.reviewQueue.canonicalSkillIR}</span><Status value={proposal.status} /></div>
          </Link>
        ))}{proposals.map((proposal) => (
          <Link
            className="proposal-card"
            href={`/proposals/${proposal.proposal_id}`}
            key={proposal.proposal_id}
          >
            <div>
              <strong>{proposal.proposal_id}</strong>
              <code>{proposal.project_id}</code>
            </div>
            <div>
              <span>
                {proposal.changed_item_count} {t.reviewQueue.changes}
              </span>
              <Status value={proposal.status} />
            </div>
          </Link>
        ))}</>
      )}
    </section>
  );
}

// ── Artifact History ──────────────────────────────────────

export function ArtifactHistory({ api: propApi }: { api?: HunterApi }) {
  const { t } = useI18n();
  const api = useMemo(() => propApi ?? resolveApi(), [propApi]);
  const [artifacts, setArtifacts] = useState<ArtifactSummary[] | null>(null);
  const [skillArtifacts, setSkillArtifacts] = useState<RegistryArtifact[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setError(null);
    void Promise.all([
      api.listAllArtifacts(),
      api.listSkillArtifacts?.() ?? Promise.resolve([])
    ])
      .then(([items, nextSkillArtifacts]) => {
        if (active) {
          setArtifacts(items);
          setSkillArtifacts(nextSkillArtifacts);
        }
      })
      .catch((reason: unknown) => {
        if (active) setError(errorMessage(reason, t));
      });
    return () => {
      active = false;
    };
  }, [api, t]);

  if (error !== null) return <Empty>{error}</Empty>;
  if (artifacts === null) return <Empty>{t.artifacts.loading}</Empty>;

  return (
    <section className="stack">
      <div className="page-heading">
        <div>
          <p className="eyebrow">{t.artifacts.eyebrow}</p>
          <h1>{t.artifacts.title}</h1>
        </div>
        <span>
          {artifacts.length + skillArtifacts.length} {t.artifacts.published}
        </span>
      </div>
      {artifacts.length === 0 && skillArtifacts.length === 0 ? (
        <Empty>{t.artifacts.noArtifacts}</Empty>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>{t.artifacts.table.artifact}</th>
                <th>{t.artifacts.table.project}</th>
                <th>{t.artifacts.table.version}</th>
                <th>{t.artifacts.table.changes}</th>
                <th>{t.artifacts.table.proposal}</th>
              </tr>
            </thead>
            <tbody>
              {skillArtifacts.map((artifact) => (
                <tr key={artifact.artifact_id}>
                  <td><Link href={`/skills/${artifact.skill_slug}`}><strong>{artifact.artifact_id}</strong><code>{artifact.content_sha256.slice(0, 20)}…</code></Link></td>
                  <td>{artifact.skill_slug}</td>
                  <td>{artifact.version} · {artifact.agent}</td>
                  <td>{artifact.size_bytes} B</td>
                  <td>{artifact.source_proposal_id}</td>
                </tr>
              ))}
              {artifacts.map((artifact) => (
                <tr key={artifact.artifact_id}>
                  <td>
                    <Link href={`/artifacts/${artifact.artifact_id}`}>
                      <strong>{artifact.artifact_id}</strong>
                      <code>
                        {artifact.manifest_sha256.slice(0, 20)}…
                      </code>
                    </Link>
                  </td>
                  <td>{artifact.project_id}</td>
                  <td>{artifact.project_version}</td>
                  <td>{artifact.changed_item_count}</td>
                  <td>
                    <Link href={`/proposals/${artifact.proposal_id}`}>
                      {artifact.proposal_id}
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

// ── Proposal Detail ───────────────────────────────────────

function operationPath(
  operation: ProposalDetailModel["items"][number]["operation"]
): string {
  return operation.operation === "rename"
    ? operation.to_path
    : operation.path;
}

export function ProposalDetail({
  api: propApi,
  proposalId,
}: {
  api?: HunterApi;
  proposalId: string;
}) {
  const { t } = useI18n();
  const api = useMemo(() => propApi ?? resolveApi(), [propApi]);
  const [proposal, setProposal] = useState<ProposalDetailModel | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [comment, setComment] = useState("");
  const [result, setResult] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let active = true;
    setError(null);
    void api
      .getProposal(proposalId)
      .then((value) => {
        if (active) setProposal(value);
      })
      .catch((reason: unknown) => {
        if (active) setError(errorMessage(reason, t));
      });
    return () => {
      active = false;
    };
  }, [api, proposalId, t]);

  const totalBytes = useMemo(
    () =>
      proposal?.items.reduce(
        (total, item) =>
          total +
          ("size_bytes" in item.operation ? item.operation.size_bytes : 0),
        0
      ) ?? 0,
    [proposal]
  );

  if (error !== null) return <Empty>{error}</Empty>;
  if (proposal === null) return <Empty>{t.proposal.loading}</Empty>;

  async function decide(decision: ReviewInput["decision"]): Promise<void> {
    setBusy(true);
    setResult(null);
    try {
      const splitGroups =
        decision === "split"
          ? proposal?.items.map((item, index) => ({
              name: "item-" + (index + 1),
              item_ids: [item.item_id],
              target_scope: "project",
            })) ?? []
          : [];
      const reviewed = await api.reviewProposal(proposalId, {
        decision,
        comment: comment.trim() === "" ? null : comment.trim(),
        target_scope: "project",
        split_groups: splitGroups,
      });
      setResult(
        decision === "approve" && reviewed.artifact_id !== null
          ? t.proposal.approvedAs + " " + reviewed.artifact_id
          : decision === "split"
            ? t.proposal.splitInto +
              " " +
              reviewed.child_proposal_ids.length +
              t.proposal.proposals
            : t.proposal.decisionRecorded + decision.replaceAll("_", " ")
      );
    } catch (reason) {
      setError(errorMessage(reason, t));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="stack">
      <div className="page-heading">
        <div>
          <p className="eyebrow">{t.proposal.eyebrow}</p>
          <h1>{proposal.proposal_id}</h1>
          <code>{proposal.project_id}</code>
        </div>
        <Status value={proposal.status} />
      </div>
      <div className="metric-grid compact">
        <article className="metric">
          <strong>{proposal.items.length}</strong>
          <span>{t.proposal.changedItems}</span>
        </article>
        <article className="metric">
          <strong>{totalBytes}</strong>
          <span>{t.proposal.bytes}</span>
        </article>
        <article className="metric">
          <strong>{proposal.review_history.length}</strong>
          <span>{t.proposal.reviewEvents}</span>
        </article>
      </div>
      <div className="notice">{t.proposal.redactedNotice}</div>
      <div className="panel">
        <div className="panel-title">
          <h2>{t.proposal.changes}</h2>
        </div>
        {proposal.items.map((item) => (
          <div className="change" key={item.item_id}>
            <div>
              <Status value={item.operation.operation} />
              <strong>{operationPath(item.operation)}</strong>
            </div>
            <div>
              <span>{item.operation.file_kind}</span>
              <code>
                {"content_sha256" in item.operation
                  ? item.operation.content_sha256.slice(0, 20) + "…"
                  : "tombstone"}
              </code>
            </div>
          </div>
        ))}
      </div>
      <div className="decision-panel">
        <label htmlFor="review-comment">
          {t.proposal.reviewRationale}
        </label>
        <textarea
          id="review-comment"
          value={comment}
          onChange={(event) => setComment(event.target.value)}
          placeholder={t.proposal.placeholder}
        />
        <div className="actions">
          <button
            disabled={busy}
            onClick={() => void decide("approve")}
          >
            {t.proposal.approve}
          </button>
          <button
            className="secondary"
            disabled={busy}
            onClick={() => void decide("reject")}
          >
            {t.proposal.reject}
          </button>
          <button
            className="secondary"
            disabled={busy || proposal.items.length < 2}
            onClick={() => void decide("split")}
          >
            {t.proposal.split}
          </button>
        </div>
        {result === null ? null : (
          <p className="success">{result}</p>
        )}
      </div>
    </section>
  );
}

// ── Auth Token Form ───────────────────────────────────────

export function AuthTokenForm() {
  const { t } = useI18n();
  const [token, setToken] = useState("");
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function submitToken(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const nextToken = token.trim();
    setSaved(false);
    setMessage(null);
    if (nextToken === "") return;
    if (!/^hh_[A-Za-z0-9_-]+$/.test(nextToken)) {
      setMessage(t.token.invalidFormat);
      return;
    }
    setBusy(true);
    try {
      const response = await fetch("/api/v1/projects?limit=1", {
        headers: {
          Accept: "application/json",
          Authorization: "Bearer " + nextToken,
          "X-Request-Id": globalThis.crypto.randomUUID(),
        },
      });
      if (!response.ok) {
        setMessage(
          response.status === 401 || response.status === 403
            ? t.token.rejected
            : t.token.httpError + response.status + "."
        );
        return;
      }
      window.sessionStorage.setItem("hunter-harness-token", nextToken);
      setToken("");
      setSaved(true);
      window.location.assign(
        window.location.pathname + window.location.search
      );
    } catch {
      setMessage(t.token.networkPolicy);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      className="token-form"
      onSubmit={(event) => {
        void submitToken(event);
      }}
    >
      <label htmlFor="api-token">{t.token.label}</label>
      <input
        id="api-token"
        type="password"
        autoComplete="off"
        value={token}
        onChange={(event) => {
          setToken(event.target.value);
          setSaved(false);
          setMessage(null);
        }}
        placeholder={t.token.placeholder}
      />
      <button type="submit" disabled={busy}>
        {busy ? t.token.checking : t.token.setButton}
      </button>
      {saved ? <span>{t.token.saved}</span> : null}
      {message === null ? null : <span>{message}</span>}
    </form>
  );
}
