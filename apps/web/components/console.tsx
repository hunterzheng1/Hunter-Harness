"use client";

import Link from "next/link";
import { type FormEvent, useEffect, useMemo, useState } from "react";
import type { RegistryArtifact, RegistrySkillProposal } from "@hunter-harness/contracts";

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
    return "Governance request failed (" + error.code + "). No sensitive details were displayed.";
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
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null);
  const [proposals, setProposals] = useState<ProposalSummary[] | null>(null);
  const [registryCounts, setRegistryCounts] = useState({ skills: 0, workflows: 0, artifacts: 0 });
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setError(null);
    void Promise.all([
      api.listProjects(),
      api.listAllProposals(),
      api.listSkills?.() ?? Promise.resolve([]),
      api.listWorkflows?.() ?? Promise.resolve([]),
      api.listAllArtifacts()
    ])
      .then(([nextProjects, nextProposals, nextSkills, nextWorkflows, nextArtifacts]) => {
        if (active) {
          setProjects(nextProjects);
          setProposals(nextProposals);
          setRegistryCounts({
            skills: nextSkills.filter((skill) => skill.status === "published").length,
            workflows: nextWorkflows.length,
            artifacts: nextArtifacts.length
          });
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
  if (projects === null || proposals === null) {
    return <Empty>{t.dashboard.loading}</Empty>;
  }

  const pending = proposals.filter((p) => p.status === "pending_review");

  return (
    <section className="stack">
      <div className="page-heading">
        <div>
          <p className="eyebrow">{t.dashboard.eyebrow}</p>
          <h1>{t.dashboard.title}</h1>
        </div>
        <Status value={pending.length === 0 ? "clear" : "attention"} />
      </div>

      <div className="metric-grid">
              <article className="metric stagger-1">
                <strong>{projects.length}</strong>
                <span>{t.dashboard.registeredProjects}</span>
              </article>
              <article className="metric stagger-2">
                <strong>{pending.length}</strong>
                <span>
                  {pending.length === 1
                    ? t.dashboard.pendingReview
                    : t.dashboard.pendingReviews}
                </span>
              </article>
              <article className="metric stagger-3">
                <strong>
                  {proposals.filter((p) => p.status === "approved").length}
                </strong>
                <span>{t.dashboard.approvedProposals}</span>
              </article>
              <article className="metric"><strong>{registryCounts.workflows}</strong><span>Workflows</span></article>
              <article className="metric"><strong>{registryCounts.skills}</strong><span>Published Skills</span></article>
              <article className="metric"><strong>{registryCounts.artifacts}</strong><span>Project Artifacts</span></article>
            </div>

      <div className="panel">
        <div className="panel-title">
          <h2>{t.dashboard.projectsPanel}</h2>
          <Link href="/projects">{t.dashboard.openRegistry}</Link>
        </div>
        {projects.length === 0 ? (
          <Empty>{t.dashboard.noProjects}</Empty>
        ) : (
          projects.map((project) => (
            <div className="row" key={project.project_id}>
              <div>
                <strong>{project.display_name}</strong>
                <code>{project.project_id}</code>
              </div>
              <span>
                {project.latest_project_version ?? t.dashboard.noVersion}
              </span>
            </div>
          ))
        )}
      </div>
    </section>
  );
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
          搜索项目 / Search projects
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="name or project id" />
        </label>
        <label>
          角色 / Role
          <select value={role} onChange={(event) => setRole(event.target.value)}>
            <option value="all">全部 / All</option>
            {roles.map((item) => <option value={item} key={item}>{item}</option>)}
          </select>
        </label>
      </div>
      {projects.length === 0 ? (
        <Empty>{t.projects.noProjects}</Empty>
      ) : filteredProjects.length === 0 ? (
        <Empty>没有符合筛选条件的项目。</Empty>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>{t.projects.table.project}</th>
                <th>{t.projects.table.role}</th>
                <th>Workflow</th>
                <th>Skills</th>
                <th>{t.projects.table.version}</th>
                <th>{t.projects.table.artifact}</th>
                <th>Registered</th>
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
                  <td>{workflowInfo[project.project_id]?.name ?? "Not bound"}</td>
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
            <div><span>Canonical Skill IR</span><Status value={proposal.status} /></div>
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
      setMessage(
        "Token format looks invalid. Paste only the hh_… token value."
      );
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
            ? "Token was rejected by the server."
            : "Token check failed with HTTP " + response.status + "."
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
      setMessage(
        "Browser could not reach /api/v1/projects. Check extensions or network policy."
      );
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
