"use client";

import { useEffect, useMemo, useState } from "react";

import {
  ApiClientError,
  type ArtifactManifestModel,
  type ArtifactSummary,
  type HunterApi,
  type ProjectDetailModel
} from "../lib/api";
import { classifyManagedFile, isProposalEditable, type WebFilePolicy } from "../lib/file-policy";
import { reconstructWorkspace, type WorkspaceArtifact, type WorkspaceFile } from "../lib/workspace";

interface LoadedArtifact extends WorkspaceArtifact {
  summary: ArtifactSummary;
}

interface ArtifactDetailData {
  project: ProjectDetailModel;
  artifacts: LoadedArtifact[];
  selectedIndex: number;
}

function safeError(error: unknown): string {
  if (error instanceof ApiClientError && (error.status === 401 || error.status === 403)) {
    return "Authentication required. Add a valid API token to this browser session.";
  }
  if (error instanceof ApiClientError) return "Artifact request failed (" + error.code + "). No sensitive details were displayed.";
  return "Artifact request failed. No sensitive details were displayed.";
}

function operationPath(operation: ArtifactManifestModel["files"][number]): string {
  return operation.operation === "rename" ? operation.to_path : operation.path;
}

function hashes(manifest: ArtifactManifestModel): string[] {
  return [...new Set(manifest.files.flatMap((operation) =>
    operation.operation === "delete" ? [] : [operation.content_sha256]
  ))];
}

async function loadArtifactDetail(api: HunterApi, artifactId: string): Promise<ArtifactDetailData> {
  const selectedManifest = await api.getArtifactManifest(artifactId);
  const [project, summaries] = await Promise.all([
    api.getProject(selectedManifest.project_id),
    api.listProjectArtifacts(selectedManifest.project_id)
  ]);
  const orderedSummaries = [...summaries].sort((left, right) =>
    left.created_at.localeCompare(right.created_at) || left.artifact_id.localeCompare(right.artifact_id)
  );
  const loaded = await Promise.all(orderedSummaries.map(async (summary): Promise<LoadedArtifact> => {
    const manifest = summary.artifact_id === artifactId ? selectedManifest : await api.getArtifactManifest(summary.artifact_id);
    const texts = await Promise.all(hashes(manifest).map(async (hash) => [
      hash,
      await api.getArtifactText(summary.artifact_id, hash)
    ] as const));
    return {
      summary,
      artifactId: summary.artifact_id,
      createdAt: summary.created_at,
      manifest,
      textByHash: new Map(texts)
    };
  }));
  const selectedIndex = loaded.findIndex((artifact) => artifact.artifactId === artifactId);
  if (selectedIndex === -1) throw new ApiClientError(404, "ARTIFACT_NOT_FOUND", "Artifact is not visible in this project.");
  return { project, artifacts: loaded, selectedIndex };
}

function lineDiff(before: string | null, after: string | null): string {
  const beforeLines = (before ?? "").split("\n");
  const afterLines = (after ?? "").split("\n");
  let prefix = 0;
  while (prefix < beforeLines.length && prefix < afterLines.length && beforeLines[prefix] === afterLines[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < beforeLines.length - prefix && suffix < afterLines.length - prefix &&
    beforeLines[beforeLines.length - 1 - suffix] === afterLines[afterLines.length - 1 - suffix]
  ) suffix += 1;
  const sameStart = beforeLines.slice(0, prefix).map((line) => "  " + line);
  const removed = beforeLines.slice(prefix, beforeLines.length - suffix).map((line) => "- " + line);
  const added = afterLines.slice(prefix, afterLines.length - suffix).map((line) => "+ " + line);
  const sameEnd = suffix === 0 ? [] : beforeLines.slice(beforeLines.length - suffix).map((line) => "  " + line);
  return [...sameStart, ...removed, ...added, ...sameEnd].join("\n");
}

function policyFor(operation: ArtifactManifestModel["files"][number], afterFile: WorkspaceFile | null, beforeFile: WorkspaceFile | null): WebFilePolicy {
  return afterFile?.policy ?? beforeFile?.policy ?? classifyManagedFile(operationPath(operation));
}

function download(name: string, content: string): void {
  const url = URL.createObjectURL(new Blob([content], { type: "text/plain;charset=utf-8" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name.split("/").at(-1) ?? "artifact.txt";
  anchor.click();
  URL.revokeObjectURL(url);
}

export function ArtifactDetail({ api, artifactId }: { api: HunterApi; artifactId: string }) {
  const [data, setData] = useState<ArtifactDetailData | null>(null);
  const [operationIndex, setOperationIndex] = useState(0);
  const [confirmProjectLocal, setConfirmProjectLocal] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let active = true;
    setData(null);
    setOperationIndex(0);
    setConfirmProjectLocal(false);
    setError(null);
    setResult(null);
    void loadArtifactDetail(api, artifactId).then((next) => {
      if (active) setData(next);
    }).catch((reason: unknown) => {
      if (active) setError(safeError(reason));
    });
    return () => { active = false; };
  }, [api, artifactId]);

  const selectedArtifact = data === null ? null : data.artifacts[data.selectedIndex] ?? null;
  const operation = selectedArtifact?.manifest.files[operationIndex] ?? null;
  const beforeFiles = useMemo(() => data === null ? [] : reconstructWorkspace(data.artifacts.slice(0, data.selectedIndex)), [data]);
  const afterFiles = useMemo(() => data === null ? [] : reconstructWorkspace(data.artifacts.slice(0, data.selectedIndex + 1)), [data]);
  const beforeFile = operation === null ? null : beforeFiles.find((file) => file.path === (operation.operation === "rename" ? operation.from_path : operation.path)) ?? null;
  const afterFile = operation === null ? null : afterFiles.find((file) => file.path === operationPath(operation)) ?? null;
  const policy = operation === null ? null : policyFor(operation, afterFile, beforeFile);
  const latest = data !== null && data.project.latest_artifact_id === artifactId;
  const canRollback = latest && operation !== null && policy !== null && isProposalEditable(policy) &&
    (policy.push_policy !== "confirm-before-proposal" || confirmProjectLocal) &&
    (operation.operation === "add" ? afterFile !== null : operation.operation === "delete" ? beforeFile?.content !== null : operation.operation === "rename" ? afterFile?.content !== null : beforeFile?.content !== null && afterFile !== null);

  async function proposeRollback(): Promise<void> {
    if (!canRollback || data === null || selectedArtifact === null || operation === null || policy === null) return;
    setBusy(true);
    setError(null);
    try {
      let rollbackInput: Parameters<HunterApi["createProjectFileProposal"]>[0];
      if (operation.operation === "add") {
        if (afterFile === null) return;
        rollbackInput = { projectId: data.project.project_id, baseProjectVersion: selectedArtifact.manifest.project_version, baseManifestHash: selectedArtifact.manifest.manifest_sha256, action: "delete", path: operation.path, baseContentHash: afterFile.content_sha256, fileKind: policy.file_kind, confirmProjectLocal };
      } else if (operation.operation === "delete") {
        if (beforeFile === null || beforeFile.content === null) return;
        rollbackInput = { projectId: data.project.project_id, baseProjectVersion: selectedArtifact.manifest.project_version, baseManifestHash: selectedArtifact.manifest.manifest_sha256, action: "add", path: operation.path, content: beforeFile.content, fileKind: policy.file_kind, confirmProjectLocal };
      } else if (operation.operation === "rename") {
        if (afterFile === null || afterFile.content === null) return;
        rollbackInput = { projectId: data.project.project_id, baseProjectVersion: selectedArtifact.manifest.project_version, baseManifestHash: selectedArtifact.manifest.manifest_sha256, action: "rename", path: operation.to_path, targetPath: operation.from_path, baseContentHash: afterFile.content_sha256, content: afterFile.content, fileKind: policy.file_kind, confirmProjectLocal };
      } else {
        if (afterFile === null || beforeFile === null || beforeFile.content === null) return;
        rollbackInput = { projectId: data.project.project_id, baseProjectVersion: selectedArtifact.manifest.project_version, baseManifestHash: selectedArtifact.manifest.manifest_sha256, action: "modify", path: operation.path, baseContentHash: afterFile.content_sha256, content: beforeFile.content, fileKind: policy.file_kind, confirmProjectLocal };
      }
      const created = await api.createProjectFileProposal(rollbackInput);
      setResult("Rollback proposal " + created.proposal_id + " is pending review. The artifact remains immutable.");
    } catch (reason) {
      setError(safeError(reason));
    } finally {
      setBusy(false);
    }
  }

  if (error !== null) return <section className="empty-state">{error}</section>;
  if (data === null || selectedArtifact === null) return <section className="empty-state">Loading artifact manifest and verified content…</section>;
  const manifest = selectedArtifact.manifest;

  return <section className="stack">
    <div className="page-heading"><div><p className="eyebrow">Approved artifact</p><h1>{manifest.artifact_id}</h1><code>{manifest.project_id} · {manifest.project_version ?? "unversioned"}</code></div><span className={latest ? "status status-clear" : "status"}>{latest ? "latest baseline" : "historical"}</span></div>
    <div className="metric-grid compact"><article className="metric"><strong>{manifest.files.length}</strong><span>manifest operations</span></article><article className="metric"><strong>{selectedArtifact.summary.changed_item_count}</strong><span>reviewed changes</span></article><article className="metric"><strong>{manifest.project_version ?? "—"}</strong><span>project version</span></article></div>
    <div className="detail-grid"><article className="panel"><div className="panel-title"><h2>Artifact metadata</h2></div><dl className="policy-grid"><dt>manifest sha-256</dt><dd><code>{manifest.manifest_sha256}</code></dd><dt>proposal</dt><dd>{selectedArtifact.summary.proposal_id}</dd><dt>created</dt><dd>{selectedArtifact.summary.created_at}</dd><dt>base version</dt><dd>{selectedArtifact.summary.base_project_version ?? "none"}</dd></dl></article><article className="panel"><div className="panel-title"><h2>Canonical manifest</h2></div><pre className="code-view">{JSON.stringify(manifest, null, 2)}</pre></article></div>
    {operation === null ? <div className="empty-state">This artifact has no file operations.</div> : <div className="workspace-grid"><article className="panel file-browser"><div className="panel-title"><h2>Changed files</h2><span>{manifest.files.length}</span></div><ul className="file-list">{manifest.files.map((item, index) => <li key={index}><button type="button" aria-label={operationPath(item)} className={index === operationIndex ? "selected" : ""} onClick={() => { setOperationIndex(index); setConfirmProjectLocal(false); setResult(null); }}><strong>{operationPath(item)}</strong><small>{item.operation} · {item.file_kind}</small></button></li>)}</ul></article><article className="panel file-detail"><div className="panel-title"><h2>Verified file diff</h2><span>{operation.operation}</span></div><pre className="code-view content-preview">{lineDiff(beforeFile?.content ?? null, afterFile?.content ?? null)}</pre>{afterFile === null || afterFile.content === null ? null : <button type="button" className="secondary-button" onClick={() => download(afterFile.path, afterFile.content ?? "")}>Download current file</button>}<div className="policy-area"><h3>Rollback policy</h3>{policy === null ? null : <dl className="policy-grid"><dt>file kind</dt><dd>{policy.file_kind}</dd><dt>push</dt><dd>{policy.push_policy}</dd><dt>conflict</dt><dd>{policy.conflict_policy}</dd></dl>}{!latest ? <div className="notice">Only the latest artifact can seed a rollback proposal; historical rollback must first be rebased against the current baseline.</div> : null}{policy?.push_policy === "confirm-before-proposal" ? <label className="confirmation"><input type="checkbox" checked={confirmProjectLocal} onChange={(event) => setConfirmProjectLocal(event.target.checked)} /> I confirm this project-local rollback should enter server review.</label> : null}<div className="actions"><button type="button" disabled={!canRollback || busy} onClick={() => void proposeRollback()}>Propose rollback</button></div></div>{result === null ? null : <p className="success">{result}</p>}</article></div>}
  </section>;
}
