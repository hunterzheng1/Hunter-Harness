"use client";

import type { SemanticOverview } from "@hunter-harness/contracts";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";

import {
  ApiClientError,
  type ArtifactSummary,
  type HunterApi,
  type ProjectDetailModel,
  type ProjectFileMetadata
} from "../lib/api";
import { classifyManagedFile, isProposalEditable, type WebFilePolicy } from "../lib/file-policy";
import { useI18n } from "../lib/i18n";
import { ProjectSemanticPanels } from "./project-semantic-panels";

interface WorkspaceData {
  project: ProjectDetailModel;
  artifacts: ArtifactSummary[];
  files: ProjectFileMetadata[];
  overview: SemanticOverview | null;
}

type DraftAction = "add" | "modify" | "rename" | "delete";
type WorkspaceTab = "workbench" | "files" | "knowledge" | "versions";

interface Draft {
  action: DraftAction;
  path: string;
  targetPath: string;
  content: string;
  baseContentHash?: string;
}

interface TreeNode {
  name: string;
  path: string;
  directories: Map<string, TreeNode>;
  files: ProjectFileMetadata[];
}

const EMPTY_MANIFEST_HASH = "sha256:" + "0".repeat(64);

const COPY = {
  zh: {
    back: "返回项目列表",
    eyebrow: "项目工作台",
    tabs: { workbench: "工作台", files: "文件", knowledge: "项目知识", versions: "版本记录" },
    healthy: "项目状态正常",
    healthyHint: "文件快照、知识索引和版本记录已同步到最新保存。",
    noVersion: "尚未生成项目版本",
    fileCount: "当前文件",
    editableCount: "可直接编辑",
    knowledgeCount: "知识条目",
    relations: "知识关系",
    lastUpdated: "最近更新",
    quickActions: "常用操作",
    manageFiles: "管理文件",
    browseKnowledge: "浏览项目知识",
    recentVersions: "最近版本",
    noVersions: "保存第一个文件后，这里会出现版本记录。",
    changedFiles: (count: number) => `${count} 个文件变更`,
    fileTitle: "项目文件",
    newFile: "新建文件",
    searchFiles: "搜索文件或目录",
    allFiles: "全部文件",
    editableFiles: "可编辑",
    systemFiles: "系统只读",
    noFiles: "没有符合当前筛选的文件。",
    chooseFile: "从左侧目录中选择文件，正文将在打开时加载。",
    loadingContent: "正在加载文件内容…",
    editable: "可直接编辑",
    readOnly: "系统只读",
    edit: "编辑",
    rename: "重命名",
    delete: "删除",
    fileContent: "文件内容",
    filePath: "文件路径",
    targetPath: "新文件路径",
    save: "保存",
    confirmDelete: "确认删除",
    cancel: "取消",
    saved: "文件已保存并生成新版本。",
    saveFailed: "保存失败，请刷新后重试。",
    authFailed: "需要有效的 API 令牌才能访问此项目。",
    loadFailed: "项目数据加载失败。",
    technical: "技术详情",
    projectId: "项目 ID",
    versionId: "版本 ID",
    artifactId: "版本记录 ID",
    proposalId: "变更记录 ID",
    policy: "文件规则",
    pathRule: "路径类型",
    updateRule: "更新方式",
    conflictRule: "冲突处理",
    versionNumber: (index: number) => `版本 ${index}`,
    current: "当前",
    bytes: "字节"
  },
  en: {
    back: "Back to projects",
    eyebrow: "Project workbench",
    tabs: { workbench: "Workbench", files: "Files", knowledge: "Project knowledge", versions: "Version history" },
    healthy: "Project is healthy",
    healthyHint: "The file snapshot, knowledge index, and version history are synchronized.",
    noVersion: "No project version yet",
    fileCount: "Current files",
    editableCount: "Directly editable",
    knowledgeCount: "Knowledge entries",
    relations: "Knowledge relations",
    lastUpdated: "Last updated",
    quickActions: "Quick actions",
    manageFiles: "Manage files",
    browseKnowledge: "Browse project knowledge",
    recentVersions: "Recent versions",
    noVersions: "Version history appears after the first file is saved.",
    changedFiles: (count: number) => `${count} file changes`,
    fileTitle: "Project files",
    newFile: "New file",
    searchFiles: "Search files or folders",
    allFiles: "All files",
    editableFiles: "Editable",
    systemFiles: "System read-only",
    noFiles: "No files match the current filter.",
    chooseFile: "Choose a file from the directory. Content loads only when opened.",
    loadingContent: "Loading file content…",
    editable: "Directly editable",
    readOnly: "System read-only",
    edit: "Edit",
    rename: "Rename",
    delete: "Delete",
    fileContent: "File content",
    filePath: "File path",
    targetPath: "New file path",
    save: "Save",
    confirmDelete: "Confirm delete",
    cancel: "Cancel",
    saved: "File saved and a new version was created.",
    saveFailed: "Save failed. Refresh and try again.",
    authFailed: "A valid API token is required to access this project.",
    loadFailed: "Project data could not be loaded.",
    technical: "Technical details",
    projectId: "Project ID",
    versionId: "Version ID",
    artifactId: "Version record ID",
    proposalId: "Change record ID",
    policy: "File rules",
    pathRule: "Path type",
    updateRule: "Update behavior",
    conflictRule: "Conflict behavior",
    versionNumber: (index: number) => `Version ${index}`,
    current: "Current",
    bytes: "bytes"
  }
} as const;

function userError(error: unknown, copy: typeof COPY.zh | typeof COPY.en): string {
  if (error instanceof ApiClientError && (error.status === 401 || error.status === 403)) {
    return copy.authFailed;
  }
  return copy.loadFailed;
}

function buildTree(files: ProjectFileMetadata[]): TreeNode {
  const root: TreeNode = { name: "", path: "", directories: new Map(), files: [] };
  for (const file of files) {
    const segments = file.path.split("/");
    let current = root;
    for (const segment of segments.slice(0, -1)) {
      const childPath = current.path === "" ? segment : `${current.path}/${segment}`;
      const child = current.directories.get(segment) ?? {
        name: segment,
        path: childPath,
        directories: new Map<string, TreeNode>(),
        files: []
      };
      current.directories.set(segment, child);
      current = child;
    }
    current.files.push(file);
  }
  return root;
}

function DirectoryTree({
  node,
  selectedPath,
  onSelect,
  depth = 0
}: {
  node: TreeNode;
  selectedPath: string | null;
  onSelect: (file: ProjectFileMetadata) => void;
  depth?: number;
}) {
  const directories = [...node.directories.values()].sort((left, right) => left.name.localeCompare(right.name));
  const files = [...node.files].sort((left, right) => left.path.localeCompare(right.path));
  const content = <ul className="project-tree-list">
    {directories.map((directory) => (
      <li key={directory.path}>
        <details open>
          <summary><span className="project-tree-folder" aria-hidden="true" />{directory.name}</summary>
          <DirectoryTree node={directory} selectedPath={selectedPath} onSelect={onSelect} depth={depth + 1} />
        </details>
      </li>
    ))}
    {files.map((file) => (
      <li key={file.path}>
        <button
          type="button"
          aria-label={file.path}
          className={selectedPath === file.path ? "selected" : ""}
          onClick={() => onSelect(file)}
        >
          <span className="project-tree-file" aria-hidden="true" />
          {file.path.split("/").pop()}
        </button>
      </li>
    ))}
  </ul>;
  return depth === 0 ? <nav className="project-tree" aria-label="Project files">{content}</nav> : content;
}

function TechnicalDetails({
  policy,
  copy
}: {
  policy: WebFilePolicy;
  copy: typeof COPY.zh | typeof COPY.en;
}) {
  return <details className="project-tech-details">
    <summary>{copy.technical}</summary>
    <dl>
      <dt>{copy.pathRule}</dt><dd><code>{policy.file_kind}</code></dd>
      <dt>{copy.updateRule}</dt><dd><code>{policy.update_policy}</code></dd>
      <dt>{copy.conflictRule}</dt><dd><code>{policy.conflict_policy}</code></dd>
    </dl>
  </details>;
}

async function loadWorkspace(api: HunterApi, projectId: string): Promise<WorkspaceData> {
  if (api.listProjectFiles === undefined) throw new Error("project file API unavailable");
  const [project, artifacts, snapshot, overview] = await Promise.all([
    api.getProject(projectId),
    api.listProjectArtifacts(projectId),
    api.listProjectFiles(projectId),
    api.getProjectSemanticOverview?.(projectId).catch(() => null) ?? Promise.resolve(null)
  ]);
  return { project, artifacts, files: snapshot.items, overview };
}

export function ProjectWorkspace({ api, projectId }: { api: HunterApi; projectId: string }) {
  const { lang } = useI18n();
  const copy = COPY[lang];
  const [data, setData] = useState<WorkspaceData | null>(null);
  const [activeTab, setActiveTab] = useState<WorkspaceTab>("workbench");
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [contentByPath, setContentByPath] = useState<Map<string, string>>(new Map());
  const [loadingContent, setLoadingContent] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<"all" | "editable" | "system">("all");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const contentRequest = useRef(0);

  useEffect(() => {
    let active = true;
    setData(null);
    setError(null);
    void loadWorkspace(api, projectId).then((next) => {
      if (active) setData(next);
    }).catch((reason: unknown) => {
      if (active) setError(userError(reason, copy));
    });
    return () => { active = false; };
  }, [api, projectId, copy]);

  const selected = useMemo(
    () => data?.files.find((file) => file.path === selectedPath) ?? null,
    [data, selectedPath]
  );
  const selectedPolicy = selected === null ? null : classifyManagedFile(selected.path);
  const selectedContent = selectedPath === null ? undefined : contentByPath.get(selectedPath);
  const editableFiles = data?.files.filter((file) => isProposalEditable(classifyManagedFile(file.path))).length ?? 0;
  const visibleFiles = useMemo(() => {
    if (data === null) return [];
    const needle = query.trim().toLowerCase();
    return data.files.filter((file) => {
      const editable = isProposalEditable(classifyManagedFile(file.path));
      return (needle === "" || file.path.toLowerCase().includes(needle)) &&
        (filter === "all" || (filter === "editable" ? editable : !editable));
    });
  }, [data, query, filter]);
  const tree = useMemo(() => buildTree(visibleFiles), [visibleFiles]);
  const latestArtifact = data?.artifacts.find((artifact) => artifact.artifact_id === data.project.latest_artifact_id)
    ?? data?.artifacts[0]
    ?? null;

  async function choose(file: ProjectFileMetadata): Promise<void> {
    setSelectedPath(file.path);
    setDraft(null);
    if (contentByPath.has(file.path) || api.getProjectFileContent === undefined) return;
    const request = ++contentRequest.current;
    setLoadingContent(true);
    try {
      const loaded = await api.getProjectFileContent(projectId, file.path);
      setContentByPath((current) => new Map(current).set(file.path, loaded.content));
    } catch (reason) {
      setError(userError(reason, copy));
    } finally {
      if (request === contentRequest.current) setLoadingContent(false);
    }
  }

  function beginAdd(): void {
    setSelectedPath(null);
    setDraft({
      action: "add",
      path: ".harness/knowledge/new-note.md",
      targetPath: "",
      content: "# New knowledge\n"
    });
    setMessage(null);
  }

  function beginEdit(action: Exclude<DraftAction, "add">): void {
    if (selected === null || selectedPolicy === null || !isProposalEditable(selectedPolicy)) return;
    if (action !== "delete" && selectedContent === undefined) return;
    setDraft({
      action,
      path: selected.path,
      targetPath: action === "rename" ? selected.path : "",
      content: selectedContent ?? "",
      baseContentHash: selected.content_sha256
    });
    setMessage(null);
  }

  async function refreshWorkspace(preferredPath?: string): Promise<void> {
    const next = await loadWorkspace(api, projectId);
    setData(next);
    if (preferredPath !== undefined && next.files.some((file) => file.path === preferredPath)) {
      setSelectedPath(preferredPath);
      if (api.getProjectFileContent !== undefined) {
        const loaded = await api.getProjectFileContent(projectId, preferredPath);
        setContentByPath((current) => new Map(current).set(preferredPath, loaded.content));
      }
    } else {
      setSelectedPath(null);
    }
  }

  async function save(): Promise<void> {
    if (data === null || draft === null) return;
    const targetPath = draft.action === "rename" ? draft.targetPath.trim() : draft.path.trim();
    const policy = classifyManagedFile(targetPath);
    if (!isProposalEditable(policy) || targetPath === "") return;
    setBusy(true);
    setError(null);
    try {
      await api.createProjectFileProposal({
        projectId,
        baseProjectVersion: data.project.latest_project_version,
        baseManifestHash: latestArtifact?.manifest_sha256 ?? EMPTY_MANIFEST_HASH,
        baseArtifactId: data.project.latest_artifact_id,
        action: draft.action,
        path: draft.path.trim(),
        fileKind: policy.file_kind,
        confirmProjectLocal: policy.push_policy === "confirm-before-proposal",
        ...(draft.action === "rename" ? { targetPath } : {}),
        ...(draft.baseContentHash === undefined ? {} : { baseContentHash: draft.baseContentHash }),
        ...(draft.action === "delete" ? {} : { content: draft.content })
      });
      setDraft(null);
      setMessage(copy.saved);
      await refreshWorkspace(draft.action === "delete" ? undefined : targetPath);
    } catch {
      setError(copy.saveFailed);
    } finally {
      setBusy(false);
    }
  }

  if (error !== null && data === null) return <section className="empty-state">{error}</section>;
  if (data === null) return <section className="empty-state">{lang === "zh" ? "正在加载项目…" : "Loading project…"}</section>;

  const tabs: Array<[WorkspaceTab, string]> = [
    ["workbench", copy.tabs.workbench],
    ["files", copy.tabs.files],
    ["knowledge", copy.tabs.knowledge],
    ["versions", copy.tabs.versions]
  ];
  const lastUpdated = data.project.updated_at ?? data.project.created_at;

  return <section className="stack governance-page project-workspace-v2">
    <header className="project-workspace-hero">
      <div className="project-workspace-title">
        <Link href="/projects" className="project-back" aria-label={copy.back}>←</Link>
        <div>
          <p className="eyebrow">{copy.eyebrow}</p>
          <h1>{data.project.display_name}</h1>
          <p className="project-health-line"><span />{data.project.latest_project_version === null ? copy.noVersion : copy.healthy}</p>
        </div>
      </div>
      <details className="project-identity-details">
        <summary>{copy.technical}</summary>
        <dl>
          <dt>{copy.projectId}</dt><dd><code>{data.project.project_id}</code></dd>
          <dt>{copy.versionId}</dt><dd><code>{data.project.latest_project_version ?? "—"}</code></dd>
        </dl>
      </details>
    </header>

    <div className="project-tabs" role="tablist" aria-label={copy.eyebrow}>
      {tabs.map(([id, label]) => <button
        key={id}
        type="button"
        role="tab"
        aria-selected={activeTab === id}
        className={activeTab === id ? "selected" : ""}
        onClick={() => setActiveTab(id)}
      >{label}</button>)}
    </div>

    {activeTab === "workbench" ? <div className="project-workbench-grid">
      <section className="project-health-card">
        <div className="project-health-icon">✓</div>
        <div><p className="eyebrow">{copy.healthy}</p><h2>{copy.healthyHint}</h2><p>{new Date(lastUpdated).toLocaleString(lang === "zh" ? "zh-CN" : "en-US")}</p></div>
      </section>
      <section className="project-metric-strip">
        <article><strong>{data.files.length}</strong><span>{copy.fileCount}</span></article>
        <article><strong>{editableFiles}</strong><span>{copy.editableCount}</span></article>
        <article><strong>{data.overview?.counts.knowledge ?? "—"}</strong><span>{copy.knowledgeCount}</span></article>
        <article><strong>{data.overview?.counts.edges ?? "—"}</strong><span>{copy.relations}</span></article>
      </section>
      <section className="project-quick-card">
        <div className="panel-title"><h2>{copy.quickActions}</h2></div>
        <div className="project-quick-actions">
          <button type="button" onClick={() => setActiveTab("files")}><span>↗</span>{copy.manageFiles}</button>
          <button type="button" onClick={() => setActiveTab("knowledge")}><span>⌕</span>{copy.browseKnowledge}</button>
        </div>
      </section>
      <section className="project-recent-card">
        <div className="panel-title"><h2>{copy.recentVersions}</h2><button type="button" className="text-button" onClick={() => setActiveTab("versions")}>{copy.tabs.versions} →</button></div>
        {data.artifacts.length === 0 ? <p className="project-empty-copy">{copy.noVersions}</p> : <div className="project-version-mini-list">
          {data.artifacts.slice(0, 4).map((artifact, index) => <article key={artifact.artifact_id}>
            <span className="project-version-dot" />
            <div><strong>{copy.versionNumber(data.artifacts.length - index)}</strong><small>{copy.changedFiles(artifact.changed_item_count)}</small></div>
            <time>{new Date(artifact.created_at).toLocaleDateString(lang === "zh" ? "zh-CN" : "en-US")}</time>
          </article>)}
        </div>}
      </section>
    </div> : null}

    {activeTab === "files" ? <div className="project-files-shell">
      <aside className="project-files-sidebar">
        <div className="project-files-heading"><div><p className="eyebrow">{copy.fileTitle}</p><strong>{data.files.length}</strong></div><button type="button" onClick={beginAdd}>＋ {copy.newFile}</button></div>
        <div className="project-file-search"><span>⌕</span><input aria-label={copy.searchFiles} placeholder={copy.searchFiles} value={query} onChange={(event) => setQuery(event.target.value)} /></div>
        <div className="project-file-filters">
          {(["all", "editable", "system"] as const).map((value) => <button key={value} type="button" className={filter === value ? "selected" : ""} onClick={() => setFilter(value)}>{value === "all" ? copy.allFiles : value === "editable" ? copy.editableFiles : copy.systemFiles}</button>)}
        </div>
        {visibleFiles.length === 0 ? <p className="project-empty-copy">{copy.noFiles}</p> : <DirectoryTree node={tree} selectedPath={selectedPath} onSelect={(file) => void choose(file)} />}
      </aside>
      <main className="project-file-detail-v2">
        {selected === null && draft === null ? <div className="project-file-placeholder"><span>⌘</span><h2>{copy.chooseFile}</h2></div> : null}
        {selected !== null ? <>
          <header className="project-file-detail-header">
            <div><p className="project-file-path">{selected.path}</p><div className="project-file-badges"><span className={selectedPolicy !== null && isProposalEditable(selectedPolicy) ? "editable" : "readonly"}>{selectedPolicy !== null && isProposalEditable(selectedPolicy) ? copy.editable : copy.readOnly}</span><span>{selected.size_bytes} {copy.bytes}</span></div></div>
            {selectedPolicy !== null && isProposalEditable(selectedPolicy) ? <div className="project-file-actions"><button type="button" disabled={selectedContent === undefined} onClick={() => beginEdit("modify")}>{copy.edit}</button><button type="button" disabled={selectedContent === undefined} onClick={() => beginEdit("rename")}>{copy.rename}</button><button type="button" className="danger" onClick={() => beginEdit("delete")}>{copy.delete}</button></div> : null}
          </header>
          {selectedPolicy === null ? null : <TechnicalDetails policy={selectedPolicy} copy={copy} />}
          <pre className="project-file-content">{loadingContent && selectedContent === undefined ? copy.loadingContent : selectedContent ?? ""}</pre>
        </> : null}
        {draft !== null ? <section className="project-file-editor">
          <header><h2>{draft.action === "add" ? copy.newFile : draft.action === "delete" ? copy.confirmDelete : copy.edit}</h2><button type="button" className="icon-button" onClick={() => setDraft(null)}>×</button></header>
          <label>{copy.filePath}<input aria-label={copy.filePath} value={draft.path} disabled={draft.action !== "add"} onChange={(event) => setDraft({ ...draft, path: event.target.value })} /></label>
          {draft.action === "rename" ? <label>{copy.targetPath}<input aria-label={copy.targetPath} value={draft.targetPath} onChange={(event) => setDraft({ ...draft, targetPath: event.target.value })} /></label> : null}
          {draft.action === "delete" ? <p className="notice danger">{lang === "zh" ? "删除后会立即生成新版本；可通过历史版本追溯。" : "Deleting creates a new version immediately; prior versions remain traceable."}</p> : <label className="project-editor-content">{copy.fileContent}<textarea aria-label={copy.fileContent} value={draft.content} onChange={(event) => setDraft({ ...draft, content: event.target.value })} /></label>}
          <div className="actions"><button type="button" disabled={busy} onClick={() => void save()}>{draft.action === "delete" ? copy.confirmDelete : copy.save}</button><button type="button" className="secondary" disabled={busy} onClick={() => setDraft(null)}>{copy.cancel}</button></div>
        </section> : null}
      </main>
    </div> : null}

    {activeTab === "knowledge" ? <ProjectSemanticPanels api={api} projectId={projectId} /> : null}

    {activeTab === "versions" ? <section className="project-versions-card">
      <header><div><p className="eyebrow">{copy.tabs.versions}</p><h2>{data.artifacts.length}</h2></div></header>
      {data.artifacts.length === 0 ? <p className="project-empty-copy">{copy.noVersions}</p> : <div className="project-version-list">
        {data.artifacts.map((artifact, index) => <article key={artifact.artifact_id}>
          <div className="project-version-index">{data.artifacts.length - index}</div>
          <div className="project-version-main"><div><strong>{copy.versionNumber(data.artifacts.length - index)}</strong>{index === 0 ? <span>{copy.current}</span> : null}</div><p>{copy.changedFiles(artifact.changed_item_count)} · {new Date(artifact.created_at).toLocaleString(lang === "zh" ? "zh-CN" : "en-US")}</p></div>
          <details><summary>{copy.technical}</summary><dl><dt>{copy.versionId}</dt><dd><code>{artifact.project_version}</code></dd><dt>{copy.artifactId}</dt><dd><code>{artifact.artifact_id}</code></dd><dt>{copy.proposalId}</dt><dd><code>{artifact.proposal_id}</code></dd></dl></details>
        </article>)}
      </div>}
    </section> : null}

    {message === null ? null : <div className="project-toast success">✓ {message}</div>}
    {error === null || data === null ? null : <div className="project-toast danger">{error}</div>}
  </section>;
}
