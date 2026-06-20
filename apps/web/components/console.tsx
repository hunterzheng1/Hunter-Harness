"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

import {
  ApiClientError,
  type HunterApi,
  type ArtifactSummary,
  type ProjectSummary,
  type ProposalDetailModel,
  type ProposalSummary,
  type ReviewInput
} from "../lib/api";

function errorMessage(error: unknown): string {
  if (error instanceof ApiClientError && (error.status === 401 || error.status === 403)) {
    return "Authentication required. Add a valid API token to this browser session.";
  }
  if (error instanceof ApiClientError) {
    return "Governance request failed (" + error.code + "). No sensitive details were displayed.";
  }
  return "Governance request failed. No sensitive details were displayed.";
}

function Empty({ children }: { children: React.ReactNode }) {
  return <div className="empty-state">{children}</div>;
}

function Status({ value }: { value: string }) {
  return <span className={`status status-${value.replaceAll("_", "-")}`}>{value.replaceAll("_", " ")}</span>;
}

export function DashboardConsole({ api }: { api: HunterApi }) {
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null);
  const [proposals, setProposals] = useState<ProposalSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    void Promise.all([api.listProjects(), api.listAllProposals()])
      .then(([nextProjects, nextProposals]) => {
        if (active) {
          setProjects(nextProjects);
          setProposals(nextProposals);
        }
      })
      .catch((reason: unknown) => {
        if (active) setError(errorMessage(reason));
      });
    return () => { active = false; };
  }, [api]);
  if (error !== null) return <Empty>{error}</Empty>;
  if (projects === null || proposals === null) {
    return <Empty>Loading governance overview…</Empty>;
  }
  const pending = proposals.filter((proposal) => proposal.status === "pending_review");
  return (
    <section className="stack">
      <div className="page-heading">
        <div><p className="eyebrow">Governance overview</p><h1>Local work, reviewed releases.</h1></div>
        <Status value={pending.length === 0 ? "clear" : "attention"} />
      </div>
      <div className="metric-grid">
        <article className="metric"><strong>{projects.length}</strong><span>registered projects</span></article>
        <article className="metric"><strong>{pending.length}</strong><span>{pending.length === 1 ? "pending review" : "pending reviews"}</span></article>
        <article className="metric"><strong>{proposals.filter((item) => item.status === "approved").length}</strong><span>approved proposals</span></article>
      </div>
      <div className="panel">
        <div className="panel-title"><h2>Projects</h2><Link href="/projects">Open registry</Link></div>
        {projects.length === 0 ? <Empty>No projects have been registered.</Empty> : projects.map((project) => (
          <div className="row" key={project.project_id}>
            <div><strong>{project.display_name}</strong><code>{project.project_id}</code></div>
            <span>{project.latest_project_version ?? "No published version"}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

export function ProjectRegistry({ api }: { api: HunterApi }) {
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    void api.listProjects().then((items) => { if (active) setProjects(items); })
      .catch((reason: unknown) => { if (active) setError(errorMessage(reason)); });
    return () => { active = false; };
  }, [api]);
  if (error !== null) return <Empty>{error}</Empty>;
  if (projects === null) return <Empty>Loading project registry…</Empty>;
  return (
    <section className="stack">
      <div className="page-heading"><div><p className="eyebrow">Registry</p><h1>Projects</h1></div></div>
      {projects.length === 0 ? <Empty>No projects have been registered.</Empty> : (
        <div className="table-wrap"><table><thead><tr><th>Project</th><th>Role</th><th>Version</th><th>Artifact</th></tr></thead>
          <tbody>{projects.map((project) => <tr key={project.project_id}>
            <td><Link href={`/projects/${project.project_id}`}><strong>{project.display_name}</strong><code>{project.project_id}</code></Link></td>
            <td>{project.role}</td><td>{project.latest_project_version ?? "—"}</td>
            <td>{project.latest_artifact_id ?? "—"}</td>
          </tr>)}</tbody></table></div>
      )}
    </section>
  );
}

export function ReviewQueue({ api }: { api: HunterApi }) {
  const [proposals, setProposals] = useState<ProposalSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    void api.listAllProposals().then((items) => {
      if (active) setProposals(items.filter((item) => item.status === "pending_review"));
    }).catch((reason: unknown) => { if (active) setError(errorMessage(reason)); });
    return () => { active = false; };
  }, [api]);
  if (error !== null) return <Empty>{error}</Empty>;
  if (proposals === null) return <Empty>Loading review queue…</Empty>;
  return (
    <section className="stack">
      <div className="page-heading"><div><p className="eyebrow">Human review gate</p><h1>Review queue</h1></div><span>{proposals.length} waiting</span></div>
      {proposals.length === 0 ? <Empty>The review queue is clear.</Empty> : proposals.map((proposal) => (
        <Link className="proposal-card" href={`/proposals/${proposal.proposal_id}`} key={proposal.proposal_id}>
          <div><strong>{proposal.proposal_id}</strong><code>{proposal.project_id}</code></div>
          <div><span>{proposal.changed_item_count} changes</span><Status value={proposal.status} /></div>
        </Link>
      ))}
    </section>
  );
}

export function ArtifactHistory({ api }: { api: HunterApi }) {
  const [artifacts, setArtifacts] = useState<ArtifactSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    void api.listAllArtifacts().then((items) => { if (active) setArtifacts(items); })
      .catch((reason: unknown) => { if (active) setError(errorMessage(reason)); });
    return () => { active = false; };
  }, [api]);
  if (error !== null) return <Empty>{error}</Empty>;
  if (artifacts === null) return <Empty>Loading artifact history…</Empty>;
  return (
    <section className="stack">
      <div className="page-heading"><div><p className="eyebrow">Approved releases</p><h1>Artifact history</h1></div><span>{artifacts.length} published</span></div>
      {artifacts.length === 0 ? <Empty>No artifacts have been published.</Empty> : (
        <div className="table-wrap"><table><thead><tr><th>Artifact</th><th>Project</th><th>Version</th><th>Changes</th><th>Proposal</th></tr></thead>
          <tbody>{artifacts.map((artifact) => <tr key={artifact.artifact_id}>
            <td><Link href={`/artifacts/${artifact.artifact_id}`}><strong>{artifact.artifact_id}</strong><code>{artifact.manifest_sha256.slice(0, 20)}…</code></Link></td>
            <td>{artifact.project_id}</td><td>{artifact.project_version}</td>
            <td>{artifact.changed_item_count}</td><td><Link href={`/proposals/${artifact.proposal_id}`}>{artifact.proposal_id}</Link></td>
          </tr>)}</tbody></table></div>
      )}
    </section>
  );
}

function operationPath(operation: ProposalDetailModel["items"][number]["operation"]): string {
  return operation.operation === "rename" ? operation.to_path : operation.path;
}

export function ProposalDetail({ api, proposalId }: { api: HunterApi; proposalId: string }) {
  const [proposal, setProposal] = useState<ProposalDetailModel | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [comment, setComment] = useState("");
  const [result, setResult] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let active = true;
    void api.getProposal(proposalId).then((value) => { if (active) setProposal(value); })
      .catch((reason: unknown) => { if (active) setError(errorMessage(reason)); });
    return () => { active = false; };
  }, [api, proposalId]);
  const totalBytes = useMemo(() => proposal?.items.reduce((total, item) =>
    total + ("size_bytes" in item.operation ? item.operation.size_bytes : 0), 0
  ) ?? 0, [proposal]);
  if (error !== null) return <Empty>{error}</Empty>;
  if (proposal === null) return <Empty>Loading proposal…</Empty>;

  async function decide(decision: ReviewInput["decision"]): Promise<void> {
    setBusy(true);
    setResult(null);
    try {
      const splitGroups = decision === "split"
        ? proposal?.items.map((item, index) => ({
          name: "item-" + (index + 1),
          item_ids: [item.item_id],
          target_scope: "project"
        })) ?? []
        : [];
      const reviewed = await api.reviewProposal(proposalId, {
        decision,
        comment: comment.trim() === "" ? null : comment.trim(),
        target_scope: "project",
        split_groups: splitGroups
      });
      setResult(
        decision === "approve" && reviewed.artifact_id !== null
          ? "Approved as " + reviewed.artifact_id
          : decision === "split"
            ? "Split into " + reviewed.child_proposal_ids.length + " proposals"
            : "Decision recorded: " + decision.replaceAll("_", " ")
      );
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="stack">
      <div className="page-heading"><div><p className="eyebrow">Proposal</p><h1>{proposal.proposal_id}</h1><code>{proposal.project_id}</code></div><Status value={proposal.status} /></div>
      <div className="metric-grid compact"><article className="metric"><strong>{proposal.items.length}</strong><span>changed items</span></article><article className="metric"><strong>{totalBytes}</strong><span>bytes</span></article><article className="metric"><strong>{proposal.review_history.length}</strong><span>review events</span></article></div>
      <div className="notice">Artifact content is redacted in the Web Console. Review metadata, paths, hashes, size, and risk evidence only.</div>
      <div className="panel"><div className="panel-title"><h2>Changes</h2></div>{proposal.items.map((item) => (
        <div className="change" key={item.item_id}><div><Status value={item.operation.operation} /><strong>{operationPath(item.operation)}</strong></div><div><span>{item.operation.file_kind}</span><code>{"content_sha256" in item.operation ? item.operation.content_sha256.slice(0, 20) + "…" : "tombstone"}</code></div></div>
      ))}</div>
      <div className="decision-panel"><label htmlFor="review-comment">Review rationale</label><textarea id="review-comment" value={comment} onChange={(event) => setComment(event.target.value)} placeholder="Optional, redacted rationale" />
        <div className="actions"><button disabled={busy} onClick={() => void decide("approve")}>Approve</button><button className="secondary" disabled={busy} onClick={() => void decide("reject")}>Reject</button><button className="secondary" disabled={busy || proposal.items.length < 2} onClick={() => void decide("split")}>Split</button></div>
        {result === null ? null : <p className="success">{result}</p>}
      </div>
    </section>
  );
}

export function AuthTokenForm() {
  const [token, setToken] = useState("");
  const [saved, setSaved] = useState(false);
  return (
    <form className="token-form" onSubmit={(event) => {
      event.preventDefault();
      if (token.trim() !== "") {
        window.sessionStorage.setItem("hunter-harness-token", token.trim());
        setToken("");
        setSaved(true);
      }
    }}>
      <label htmlFor="api-token">Session API token</label>
      <input id="api-token" type="password" autoComplete="off" value={token} onChange={(event) => { setToken(event.target.value); setSaved(false); }} placeholder="Stored in this tab only" />
      <button type="submit">Set token</button>{saved ? <span>Saved</span> : null}
    </form>
  );
}
