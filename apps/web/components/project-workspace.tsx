"use client";

import { useEffect, useMemo, useState } from "react";
import type { RegistryProjectWorkflowBinding, WorkflowFamily } from "@hunter-harness/contracts";

import {
  ApiClientError,
  type ArtifactManifestModel,
  type ArtifactSummary,
  type HunterApi,
  type ProjectDetailModel
} from "../lib/api";
import { classifyManagedFile, isProposalEditable, type WebFilePolicy } from "../lib/file-policy";
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

function safeError(error: unknown): string {
  if (error instanceof ApiClientError && (error.status === 401 || error.status === 403)) {
    return "Authentication required. Add a valid API token to this browser session.";
  }
  if (error instanceof ApiClientError) return "Workspace request failed (" + error.code + "). No sensitive details were displayed.";
  return "Workspace request failed. No sensitive details were displayed.";
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

function Policy({ policy }: { policy: WebFilePolicy }) {
  return <dl className="policy-grid">
    <dt>file kind</dt><dd>{policy.file_kind}</dd>
    <dt>edit</dt><dd>{policy.edit_policy}</dd>
    <dt>push</dt><dd>{policy.push_policy}</dd>
    <dt>update</dt><dd>{policy.update_policy}</dd>
    <dt>conflict</dt><dd>{policy.conflict_policy}</dd>
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
  const [data, setData] = useState<WorkspaceData | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [confirmedProjectLocal, setConfirmedProjectLocal] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

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
      if (active) setError(safeError(reason));
    });
    return () => { active = false; };
  }, [api, projectId]);

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
      setResult("Proposal " + created.proposal_id + " is pending review. No file was published directly.");
      setDraft(null);
    } catch (reason) {
      setError(safeError(reason));
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
      setResult("Workflow family binding saved directly with optimistic revision and audit evidence.");
    } catch (reason) {
      setError(safeError(reason));
    } finally {
      setBusy(false);
    }
  }

  if (error !== null) return <section className="empty-state">{error}</section>;
  if (data === null) return <section className="empty-state">Loading managed project workspace…</section>;
  const selectedEditable = selected !== null && isProposalEditable(selected.policy);
  const boundFamily = data.workflows.find((item) => item.slug === data.workflowBinding?.family_slug) ?? null;
  const bindingKey = data.workflowBinding === null
    ? ""
    : `${data.workflowBinding.family_slug}:${data.workflowBinding.profile}`;

  return <section className="stack">
    <div className="page-heading"><div><p className="eyebrow">Managed project</p><h1>{data.project.display_name}</h1><code>{data.project.project_id}</code></div><span className="status status-clear">{data.project.role}</span></div>
    <div className="metric-grid compact"><article className="metric"><strong>{data.files.length}</strong><span>reconstructed files</span></article><article className="metric"><strong>{data.artifacts.length}</strong><span>approved artifacts</span></article><article className="metric"><strong>{data.project.latest_project_version ?? "—"}</strong><span>latest version</span></article></div>
    {data.latestManifest === null ? <div className="notice">No approved baseline artifact exists. Create the first project proposal with the CLI; this console will not invent a baseline.</div> : null}
    <div className="panel project-governance">
      <div>
        <p className="eyebrow">Workflow Family</p>
        <h2>{boundFamily?.displayName ?? "No workflow family bound"}</h2>
        <p>Workflow family metadata is direct-maintenance; managed project files still require proposal review.</p>
        {data.workflowBinding === null ? null : (
          <p><code>{data.workflowBinding.family_slug}</code> · profile <strong>{data.workflowBinding.profile}</strong>{data.workflowBinding.version === null || data.workflowBinding.version === undefined ? null : <> · v{data.workflowBinding.version}</>}</p>
        )}
      </div>
      <label>Bound workflow family
        <select
          aria-label="Bound workflow family"
          disabled={busy}
          value={bindingKey}
          onChange={(event) => {
            const [familySlug, profile] = event.target.value.split(":");
            if (familySlug !== undefined && profile !== undefined && familySlug !== "" && profile !== "") {
              void bindWorkflow(familySlug, profile);
            }
          }}
        >
          <option value="">Select family · profile</option>
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
    <ProjectSemanticPanels api={api} projectId={projectId} />
    <div className="workspace-grid">
      <article className="panel file-browser"><div className="panel-title"><h2>Managed files</h2><button className="secondary-button" type="button" onClick={startAdd} disabled={data.latestManifest === null}>Propose new file</button></div>
        {data.files.length === 0 ? <div className="empty-state">No files are present in the approved artifact chain.</div> : <ul className="file-list">{data.files.map((file) => <li key={file.path}><button type="button" aria-label={file.path} className={file.path === selected?.path ? "selected" : ""} onClick={() => choose(file)}>{file.path}<small>{file.policy.file_kind}</small></button></li>)}</ul>}
      </article>
      <article className="panel file-detail"><div className="panel-title"><h2>{selected?.path ?? "New managed file"}</h2>{selected === null ? null : <span>{selected.size_bytes} bytes</span>}</div>
        {selected === null && draft === null ? <div className="empty-state">Choose a file to inspect its policy and propose a review-gated change.</div> : null}
        {selected === null && draft !== null ? <p className="lede">New paths are classified before they can enter a proposal.</p> : null}
        {selected !== null ? <><Policy policy={selected.policy} /><pre className="code-view content-preview">{selected.content ?? "Artifact content is unavailable for this blob."}</pre>
          {selectedEditable ? <div className="actions"><button type="button" onClick={() => startEdit("modify")}>Edit current file</button><button className="secondary" type="button" onClick={() => startEdit("rename")}>Rename</button><button className="secondary danger" type="button" onClick={() => startEdit("delete")}>Delete</button></div> : <div className="notice">Only the protocol layer can write this path. It remains inspectable, but cannot be changed from the Web Console.</div>}</> : null}
        {draft === null ? null : <div className="proposal-composer"><div className="panel-title"><h2>Review proposal</h2><span>{draft.action}</span></div>
          <label>File path<input aria-label="File path" value={draft.path} onChange={(event) => setDraft({ ...draft, path: event.target.value })} /></label>
          {draft.action === "rename" ? <label>Target path<input aria-label="Target path" value={draft.targetPath} onChange={(event) => setDraft({ ...draft, targetPath: event.target.value })} /></label> : null}
          {draft.action === "delete" ? <p className="notice">Deletion is represented as a tombstone in the review proposal. The current file is not removed locally or on the server now.</p> : <label>Draft content<textarea aria-label="Draft content" value={draft.content} onChange={(event) => setDraft({ ...draft, content: event.target.value })} /></label>}
          {draftPolicy === null ? null : <Policy policy={draftPolicy} />}
          {draftPolicy?.push_policy === "confirm-before-proposal" ? <label className="confirmation"><input type="checkbox" checked={confirmedProjectLocal} onChange={(event) => setConfirmedProjectLocal(event.target.checked)} /> I confirm this project-local knowledge is intended for server review.</label> : null}
          {draftPolicy !== null && !isProposalEditable(draftPolicy) ? <div className="notice">This path is not editable through the console policy. Choose a managed rules, skill, knowledge, or codebase-map path.</div> : null}
          <div className="actions"><button type="button" disabled={!canSubmit || busy} onClick={() => void submit()}>Create review proposal</button><button type="button" className="secondary" disabled={busy} onClick={() => setDraft(null)}>Cancel</button></div>
        </div>}
        {result === null ? null : <p className="success">{result}</p>}
      </article>
    </div>
  </section>;
}
