"use client";

import { useEffect, useMemo, useState } from "react";
import type { RegistryProjectWorkflowBinding, WorkflowFamily } from "@hunter-harness/contracts";
import Link from "next/link";

import {
  ApiClientError,
  type ArtifactManifestModel,
  type ArtifactSummary,
  type HunterApi,
  type ProjectDetailModel
} from "../lib/api";
import { classifyManagedFile, isProposalEditable, type WebFilePolicy } from "../lib/file-policy";
import { useI18n } from "../lib/i18n";
import { reconstructWorkspace, type WorkspaceArtifact, type WorkspaceFile } from "../lib/workspace";
import { ProjectSemanticPanels } from "./project-semantic-panels";

interface WorkspaceData {
  project: ProjectDetailModel;
  artifacts: ArtifactSummary[];
  files: WorkspaceFile[];
  latestManifest: ArtifactManifestModel | null;
  workflows: WorkflowFamily[];
  workflowBinding: RegistryProjectWorkflowBinding | null;
}

type DraftAction = "add" | "modify" | "rename" | "delete";

interface Draft {
  action: DraftAction;
  path: string;
  targetPath: string;
  content: string;
  baseContentHash?: string;
  fileKind: WorkspaceFile["policy"]["file_kind"];
}

type WorkspaceTab = "overview" | "files" | "semantic";

type WorkspaceT = ReturnType<typeof useI18n>["t"]["projects"]["workspace"];

function safeError(error: unknown, w: WorkspaceT): string {
  if (error instanceof ApiClientError && (error.status === 401 || error.status === 403)) {
    return w.error.auth;
  }
  return w.error.failed;
}

function textHashes(manifest: ArtifactManifestModel): string[] {
  return [...new Set(manifest.files.flatMap((operation) =>
    operation.operation === "delete" ? [] : [operation.content_sha256]
  ))];
}

async function loadWorkspace(api: HunterApi, projectId: string): Promise<WorkspaceData> {
  const [project, artifacts, workflows, workflowBinding] = await Promise.all([
    api.getProject(projectId),
    api.listProjectArtifacts(projectId),
    api.listWorkflowFamilies?.() ?? Promise.resolve([]),
    api.getProjectWorkflowBinding?.(projectId) ?? Promise.resolve(null)
  ]);
  const loadedArtifacts: WorkspaceArtifact[] = await Promise.all(artifacts.map(async (artifact) => {
    const manifest = await api.getArtifactManifest(artifact.artifact_id);
    const contents = await Promise.all(textHashes(manifest).map(async (hash) => [
      hash,
      await api.getArtifactText(artifact.artifact_id, hash)
    ] as const));
    return {
      artifactId: artifact.artifact_id,
      createdAt: artifact.created_at,
      manifest,
      textByHash: new Map(contents)
    };
  }));
  const latestArtifact = artifacts.find((artifact) => artifact.artifact_id === project.latest_artifact_id) ?? artifacts[0];
  const latestManifest = latestArtifact === undefined
    ? null
    : loadedArtifacts.find((artifact) => artifact.artifactId === latestArtifact.artifact_id)?.manifest ?? null;
  return {
    project, artifacts, files: reconstructWorkspace(loadedArtifacts), latestManifest,
    workflows, workflowBinding
  };
}

function Policy({ policy, w }: { policy: WebFilePolicy; w: WorkspaceT }) {
  return <dl className="policy-grid">
    <dt>{w.policy.fileKind}</dt><dd>{policy.file_kind}</dd>
    <dt>{w.policy.edit}</dt><dd>{policy.edit_policy}</dd>
    <dt>{w.policy.push}</dt><dd>{policy.push_policy}</dd>
    <dt>{w.policy.update}</dt><dd>{policy.update_policy}</dd>
    <dt>{w.policy.conflict}</dt><dd>{policy.conflict_policy}</dd>
  </dl>;
}

function draftFor(file: WorkspaceFile, action: Exclude<DraftAction, "add">): Draft {
  return {
    action,
    path: file.path,
    targetPath: action === "rename" ? file.path : "",
    content: file.content ?? "",
    baseContentHash: file.content_sha256,
    fileKind: file.policy.file_kind
  };
}

export function ProjectWorkspace({ api, projectId }: { api: HunterApi; projectId: string }) {
  const { t } = useI18n();
  const w = t.projects.workspace;
  const [data, setData] = useState<WorkspaceData | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [confirmedProjectLocal, setConfirmedProjectLocal] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [activeTab, setActiveTab] = useState<WorkspaceTab>("overview");

  useEffect(() => {
    let active = true;
    setData(null);
    setDraft(null);
    setResult(null);
    setError(null);
    void loadWorkspace(api, projectId).then((next) => {
      if (!active) return;
      setData(next);
      setSelectedPath(next.files[0]?.path ?? null);
    }).catch((reason: unknown) => {
      if (active) setError(safeError(reason, w));
    });
    return () => { active = false; };
  }, [api, projectId, w]);

  const selected = useMemo(() => data?.files.find((file) => file.path === selectedPath) ?? null, [data, selectedPath]);
  const draftPolicy = draft === null ? null : classifyManagedFile(draft.action === "rename" ? draft.targetPath || draft.path : draft.path);
  const canSubmit = data !== null && draft !== null && data.latestManifest !== null &&
    isProposalEditable(draftPolicy ?? classifyManagedFile(draft.path)) &&
    (draft.action !== "rename" || draft.targetPath.trim() !== "") &&
    (draftPolicy?.push_policy !== "confirm-before-proposal" || confirmedProjectLocal);

  function choose(file: WorkspaceFile): void {
    setSelectedPath(file.path);
    setDraft(null);
    setResult(null);
  }

  function startAdd(): void {
    setDraft({
      action: "add",
      path: ".harness/knowledge/new-note.md",
      targetPath: "",
      content: "# New knowledge\n",
      fileKind: classifyManagedFile(".harness/knowledge/new-note.md").file_kind
    });
    setConfirmedProjectLocal(false);
    setResult(null);
  }

  function startEdit(action: Exclude<DraftAction, "add">): void {
    if (selected === null || !isProposalEditable(selected.policy)) return;
    setDraft(draftFor(selected, action));
    setConfirmedProjectLocal(false);
    setResult(null);
  }

  async function submit(): Promise<void> {
    if (!canSubmit || data === null || draft === null || data.latestManifest === null) return;
    const policy = draftPolicy ?? classifyManagedFile(draft.path);
    setBusy(true);
    setError(null);
    try {
      const proposalInput = {
        projectId: data.project.project_id,
        baseProjectVersion: data.latestManifest.project_version,
        baseManifestHash: data.latestManifest.manifest_sha256,
        action: draft.action,
        path: draft.path.trim(),
        fileKind: policy.file_kind,
        confirmProjectLocal: confirmedProjectLocal,
        ...(draft.action === "rename" ? { targetPath: draft.targetPath.trim() } : {}),
        ...(draft.baseContentHash === undefined ? {} : { baseContentHash: draft.baseContentHash }),
        ...(draft.action === "delete" ? {} : { content: draft.content })
      };
      const created = await api.createProjectFileProposal(proposalInput);
      setResult(w.result.proposalPending.replace("{id}", created.proposal_id));
      setDraft(null);
    } catch (reason) {
      setError(safeError(reason, w));
    } finally {
      setBusy(false);
    }
  }

  async function bindWorkflow(familySlug: string, profile: string): Promise<void> {
    if (data === null || api.bindProjectWorkflow === undefined) return;
    setBusy(true);
    try {
      const binding = await api.bindProjectWorkflow(
        data.project.project_id,
        familySlug,
        profile,
        data.workflowBinding?.revision ?? null,
        data.workflowBinding?.version ?? null
      );
      setData({ ...data, workflowBinding: binding });
      setResult(w.workflow.bindingSaved);
    } catch (reason) {
      setError(safeError(reason, w));
    } finally {
      setBusy(false);
    }
  }

  if (error !== null) return <section className="empty-state">{error}</section>;
  if (data === null) return <section className="empty-state">{w.loading}</section>;
  const selectedEditable = selected !== null && isProposalEditable(selected.policy);
  const boundFamily = data.workflows.find((item) => item.slug === data.workflowBinding?.family_slug) ?? null;
  const bindingKey = data.workflowBinding === null
    ? ""
    : `${data.workflowBinding.family_slug}:${data.workflowBinding.profile}`;
  const boundSkillCount = boundFamily?.required_profiles.length ?? 0;

  return <section className="stack governance-page">
    <header className="page-heading command-hero skill-detail-hero">
      <div className="page-heading-main">
        <Link className="back-button" href="/projects" aria-label={w.back}><span aria-hidden="true">‹</span></Link>
        <div className="page-heading-content">
          <p className="eyebrow">{w.eyebrow}</p>
          <h1>{data.project.display_name}</h1>
          <p className="lede"><code>{data.project.project_id}</code></p>
        </div>
      </div>
      <div className="skill-meta skill-detail-meta">
        <span className="status status-clear">{data.project.role}</span>
        <code className="skill-detail-version">{data.project.latest_project_version ?? "-"}</code>
      </div>
    </header>

    <div className="skill-detail-tabs" role="tablist" aria-label={w.eyebrow}>
      {([
        ["overview", w.tabs.overview],
        ["files", w.tabs.files],
        ["semantic", w.tabs.semantic]
      ] as const).map(([id, label]) => (
        <button key={id} type="button" role="tab" aria-selected={activeTab === id} className={activeTab === id ? "selected" : ""} onClick={() => setActiveTab(id)}>{label}</button>
      ))}
    </div>

    {activeTab === "overview" ? (
      <>
        <div className="metric-grid compact">
          <article className="metric"><strong>{data.files.length}</strong><span>{w.metric.files}</span></article>
          <article className="metric"><strong>{data.artifacts.length}</strong><span>{w.metric.artifacts}</span></article>
          <article className="metric"><strong>{data.project.latest_project_version ?? "-"}</strong><span>{w.metric.version}</span></article>
          <article className="metric"><strong>{boundSkillCount}</strong><span>{w.metric.boundSkills}</span></article>
        </div>
        {data.latestManifest === null ? <div className="notice">{w.noBaseline}</div> : null}
        <div className="panel project-governance">
          <div>
            <p className="eyebrow">{w.workflow.eyebrow}</p>
            <h2>{boundFamily?.displayName ?? w.workflow.unbind}</h2>
            <p>{w.workflow.hint}</p>
            {data.workflowBinding === null ? null : (
              <p><code>{data.workflowBinding.family_slug}</code> · {w.workflow.profile} <strong>{data.workflowBinding.profile}</strong>{data.workflowBinding.version === null || data.workflowBinding.version === undefined ? null : <> · v{data.workflowBinding.version}</>}</p>
            )}
          </div>
          <label>{w.workflow.selectLabel}
            <select
              aria-label={w.workflow.selectLabel}
              disabled={busy}
              value={bindingKey}
              onChange={(event) => {
                const [familySlug, profile] = event.target.value.split(":");
                if (familySlug !== undefined && profile !== undefined && familySlug !== "" && profile !== "") {
                  void bindWorkflow(familySlug, profile);
                }
              }}
            >
              <option value="">{w.workflow.selectPlaceholder}</option>
              {data.workflows.flatMap((family) =>
                family.required_profiles.map((profile) => (
                  <option value={`${family.slug}:${profile}`} key={`${family.family_id}:${profile}`}>
                    {family.displayName} · {profile}
                  </option>
                ))
              )}
            </select>
          </label>
        </div>
      </>
    ) : null}

    {activeTab === "files" ? (
      <div className="workspace-grid">
        <article className="panel file-browser">
          <div className="panel-title"><h2>{w.files.eyebrow}</h2><button className="secondary-button" type="button" onClick={startAdd} disabled={data.latestManifest === null}>{w.files.proposeNew}</button></div>
          {data.files.length === 0 ? <div className="empty-state">{w.files.empty}</div> : <ul className="file-list">{data.files.map((file) => <li key={file.path}><button type="button" aria-label={file.path} className={file.path === selected?.path ? "selected" : ""} onClick={() => choose(file)}>{file.path}<small>{file.policy.file_kind}</small></button></li>)}</ul>}
        </article>
        <article className="panel file-detail">
          <div className="panel-title"><h2>{selected?.path ?? w.files.newFile}</h2>{selected === null ? null : <span>{selected.size_bytes} {t.common.bytes}</span>}</div>
          {selected === null && draft === null ? <div className="empty-state">{w.files.chooseHint}</div> : null}
          {selected === null && draft !== null ? <p className="lede">{w.files.newPathHint}</p> : null}
          {selected !== null ? <>
            <Policy policy={selected.policy} w={w} />
            <pre className="code-view content-preview">{selected.content ?? w.files.contentUnavailable}</pre>
            {selectedEditable ? <div className="actions">
              <button type="button" onClick={() => startEdit("modify")}>{w.action.edit}</button>
              <button className="secondary" type="button" onClick={() => startEdit("rename")}>{w.action.rename}</button>
              <button className="secondary danger" type="button" onClick={() => startEdit("delete")}>{w.action.delete}</button>
            </div> : <div className="notice">{w.notEditable}</div>}
          </> : null}
          {draft === null ? null : <div className="proposal-composer">
            <div className="panel-title"><h2>{w.draft.review}</h2><span>{draft.action}</span></div>
            <label>{w.draft.filePath}<input aria-label={w.draft.filePath} value={draft.path} onChange={(event) => setDraft({ ...draft, path: event.target.value })} /></label>
            {draft.action === "rename" ? <label>{w.draft.targetPath}<input aria-label={w.draft.targetPath} value={draft.targetPath} onChange={(event) => setDraft({ ...draft, targetPath: event.target.value })} /></label> : null}
            {draft.action === "delete" ? <p className="notice">{w.draft.deletionNotice}</p> : <label>{w.draft.content}<textarea aria-label={w.draft.content} value={draft.content} onChange={(event) => setDraft({ ...draft, content: event.target.value })} /></label>}
            {draftPolicy === null ? null : <Policy policy={draftPolicy} w={w} />}
            {draftPolicy?.push_policy === "confirm-before-proposal" ? <label className="confirmation"><input type="checkbox" checked={confirmedProjectLocal} onChange={(event) => setConfirmedProjectLocal(event.target.checked)} /> {w.draft.confirmProjectLocal}</label> : null}
            {draftPolicy !== null && !isProposalEditable(draftPolicy) ? <div className="notice">{w.draft.notEditable}</div> : null}
            <div className="actions">
              <button type="button" disabled={!canSubmit || busy} onClick={() => void submit()}>{w.draft.create}</button>
              <button type="button" className="secondary" disabled={busy} onClick={() => setDraft(null)}>{w.draft.cancel}</button>
            </div>
          </div>}
        </article>
      </div>
    ) : null}

    {activeTab === "semantic" ? <ProjectSemanticPanels api={api} projectId={projectId} /> : null}

    {result === null ? null : <div className="notice success">{result}</div>}
    {error === null ? null : <div className="notice danger">{error}</div>}
  </section>;
}
