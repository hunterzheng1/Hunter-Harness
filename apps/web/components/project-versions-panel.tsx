"use client";

import type { FileOperation } from "@hunter-harness/contracts";
import { useEffect, useMemo, useState } from "react";

import type { ArtifactSummary, HunterApi } from "../lib/api";
import { runPreservingWindowScroll, suppressMouseFocusScroll } from "../lib/preserve-scroll";

type Lang = "zh" | "en";
type OpFilter = "all" | FileOperation["operation"];

const PAGE_SIZE = 20;

function operationPath(operation: FileOperation): string {
  return operation.operation === "rename" ? operation.to_path : operation.path;
}

function operationDisplayPath(operation: FileOperation, rename: (from: string, to: string) => string): string {
  return operation.operation === "rename"
    ? rename(operation.from_path, operation.to_path)
    : operation.path;
}

function countOps(files: readonly FileOperation[]): Record<"add" | "modify" | "delete" | "rename", number> {
  const counts = { add: 0, modify: 0, delete: 0, rename: 0 };
  for (const file of files) counts[file.operation] += 1;
  return counts;
}

function opLabel(operation: FileOperation["operation"], lang: Lang): string {
  if (lang === "zh") {
    return operation === "add" ? "新增" : operation === "modify" ? "修改" : operation === "delete" ? "删除" : "重命名";
  }
  return operation === "add" ? "Added" : operation === "modify" ? "Modified" : operation === "delete" ? "Deleted" : "Renamed";
}

function opMark(operation: FileOperation["operation"]): string {
  return operation === "add" ? "+" : operation === "modify" ? "~" : operation === "delete" ? "−" : "→";
}

function VersionChangeSet({
  files,
  lang
}: {
  files: readonly FileOperation[];
  lang: Lang;
}) {
  const [opFilter, setOpFilter] = useState<OpFilter>("all");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(0);

  const copy = lang === "zh" ? {
    changeSet: "相对上一版本",
    search: "筛选路径",
    all: "全部类型",
    page: (current: number, total: number, count: number) => `第 ${current}/${total} 页 · ${count} 条`,
    prev: "上一页",
    next: "下一页",
    emptyFilter: "没有符合筛选的文件。",
    summary: (counts: ReturnType<typeof countOps>) => {
      const parts = [];
      if (counts.add > 0) parts.push(`+${counts.add} 新增`);
      if (counts.modify > 0) parts.push(`~${counts.modify} 修改`);
      if (counts.delete > 0) parts.push(`−${counts.delete} 删除`);
      if (counts.rename > 0) parts.push(`→${counts.rename} 重命名`);
      return parts.length === 0 ? "无文件变更" : parts.join(" · ");
    },
    rename: (from: string, to: string) => `${from} → ${to}`
  } : {
    changeSet: "Changes since previous version",
    search: "Filter paths",
    all: "All types",
    page: (current: number, total: number, count: number) => `Page ${current}/${total} · ${count} items`,
    prev: "Previous",
    next: "Next",
    emptyFilter: "No files match this filter.",
    summary: (counts: ReturnType<typeof countOps>) => {
      const parts = [];
      if (counts.add > 0) parts.push(`+${counts.add} added`);
      if (counts.modify > 0) parts.push(`~${counts.modify} modified`);
      if (counts.delete > 0) parts.push(`−${counts.delete} deleted`);
      if (counts.rename > 0) parts.push(`→${counts.rename} renamed`);
      return parts.length === 0 ? "No file changes" : parts.join(" · ");
    },
    rename: (from: string, to: string) => `${from} → ${to}`
  };

  const counts = useMemo(() => countOps(files), [files]);
  const presentOps = (["add", "modify", "delete", "rename"] as const).filter((op) => counts[op] > 0);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return [...files]
      .filter((file) => (opFilter === "all" ? true : file.operation === opFilter))
      .filter((file) => {
        if (needle === "") return true;
        const display = operationDisplayPath(file, (from, to) => `${from} ${to}`).toLowerCase();
        return display.includes(needle);
      })
      .sort((left, right) => operationPath(left).localeCompare(operationPath(right)));
  }, [files, opFilter, query]);

  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage = Math.min(page, pageCount - 1);
  const pageItems = filtered.slice(safePage * PAGE_SIZE, (safePage + 1) * PAGE_SIZE);

  return <div className="project-version-changeset">
    <div className="project-version-changeset-head">
      <h3>{copy.changeSet}</h3>
      <p className="project-version-ops">{copy.summary(counts)}</p>
    </div>
    <div className="project-version-changeset-tools">
      {presentOps.length > 1 ? <div className="project-version-op-filters" role="toolbar" aria-label={lang === "zh" ? "按变更类型筛选" : "Filter by change type"}>
        <button type="button" className={opFilter === "all" ? "selected" : ""} onMouseDown={suppressMouseFocusScroll} onClick={() => { setOpFilter("all"); setPage(0); }}>{copy.all}</button>
        {presentOps.map((op) => <button key={op} type="button" className={opFilter === op ? "selected" : ""} onMouseDown={suppressMouseFocusScroll} onClick={() => { setOpFilter(op); setPage(0); }}>{opLabel(op, lang)} · {counts[op]}</button>)}
      </div> : null}
      {files.length > PAGE_SIZE || query !== "" ? <label className="project-version-file-search">
        <span>⌕</span>
        <input aria-label={copy.search} placeholder={copy.search} value={query} onChange={(event) => { setQuery(event.target.value); setPage(0); }} />
      </label> : null}
    </div>
    {pageItems.length === 0 ? <p className="project-empty-copy">{copy.emptyFilter}</p> : <ul className="project-version-files">
      {pageItems.map((file) => <li key={`${file.operation}:${operationPath(file)}`} data-op={file.operation}>
        <span className="project-version-op" aria-label={opLabel(file.operation, lang)}>{opMark(file.operation)}</span>
        <code>{operationDisplayPath(file, copy.rename)}</code>
        <small>{opLabel(file.operation, lang)}</small>
      </li>)}
    </ul>}
    {filtered.length > PAGE_SIZE ? <div className="project-version-pager">
      <span>{copy.page(safePage + 1, pageCount, filtered.length)}</span>
      <div>
        <button type="button" className="text-button" disabled={safePage <= 0} onMouseDown={suppressMouseFocusScroll} onClick={() => setPage((current) => Math.max(0, current - 1))}>{copy.prev}</button>
        <button type="button" className="text-button" disabled={safePage >= pageCount - 1} onMouseDown={suppressMouseFocusScroll} onClick={() => setPage((current) => Math.min(pageCount - 1, current + 1))}>{copy.next}</button>
      </div>
    </div> : null}
  </div>;
}

export function ProjectVersionsPanel({
  api,
  artifacts,
  lang
}: {
  api: HunterApi;
  artifacts: ArtifactSummary[];
  lang: Lang;
}) {
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [manifestById, setManifestById] = useState<Map<string, FileOperation[]>>(new Map());
  const [loadingId, setLoadingId] = useState<string | null>(null);
  const [errorById, setErrorById] = useState<Map<string, string>>(new Map());

  const versionNumberByProjectVersion = useMemo(() => {
    const map = new Map<string, number>();
    artifacts.forEach((artifact, index) => {
      map.set(artifact.project_version, artifacts.length - index);
    });
    return map;
  }, [artifacts]);

  const copy = lang === "zh" ? {
    title: "版本记录",
    subtitle: "每次保存或 push 产生一个版本；展开可查看相对上一版的文件变更。",
    empty: "保存第一个文件后，这里会出现版本记录。",
    current: "当前",
    versionNumber: (index: number) => `版本 ${index}`,
    changedFiles: (count: number) => `${count} 个文件变更`,
    initial: "首个版本",
    basedOnVersion: (index: number) => `基于版本 ${index}`,
    basedOnPrevious: "基于上一版本",
    expand: "查看变更",
    collapse: "收起",
    loading: "正在加载变更清单…",
    failed: "变更清单暂不可用。",
    summary: (counts: ReturnType<typeof countOps>) => {
      const parts = [];
      if (counts.add > 0) parts.push(`+${counts.add} 新增`);
      if (counts.modify > 0) parts.push(`~${counts.modify} 修改`);
      if (counts.delete > 0) parts.push(`−${counts.delete} 删除`);
      if (counts.rename > 0) parts.push(`→${counts.rename} 重命名`);
      return parts.length === 0 ? "无文件变更" : parts.join(" · ");
    }
  } : {
    title: "Version history",
    subtitle: "Each save or push creates a version. Expand a row to see changes from the previous version.",
    empty: "Version history appears after the first file is saved.",
    current: "Current",
    versionNumber: (index: number) => `Version ${index}`,
    changedFiles: (count: number) => `${count} file changes`,
    initial: "Initial version",
    basedOnVersion: (index: number) => `Based on version ${index}`,
    basedOnPrevious: "Based on previous version",
    expand: "View changes",
    collapse: "Collapse",
    loading: "Loading change set…",
    failed: "Change set is unavailable.",
    summary: (counts: ReturnType<typeof countOps>) => {
      const parts = [];
      if (counts.add > 0) parts.push(`+${counts.add} added`);
      if (counts.modify > 0) parts.push(`~${counts.modify} modified`);
      if (counts.delete > 0) parts.push(`−${counts.delete} deleted`);
      if (counts.rename > 0) parts.push(`→${counts.rename} renamed`);
      return parts.length === 0 ? "No file changes" : parts.join(" · ");
    }
  };

  function basedOnLabel(base: string | null): string {
    if (base === null || base === "") return copy.initial;
    const number = versionNumberByProjectVersion.get(base);
    return number === undefined ? copy.basedOnPrevious : copy.basedOnVersion(number);
  }

  useEffect(() => {
    setExpandedId(null);
    setManifestById(new Map());
    setErrorById(new Map());
  }, [artifacts]);

  async function toggle(artifactId: string): Promise<void> {
    runPreservingWindowScroll(() => {
      if (expandedId === artifactId) {
        setExpandedId(null);
        return;
      }
      setExpandedId(artifactId);
    });
    if (expandedId === artifactId) return;
    if (manifestById.has(artifactId) || errorById.has(artifactId)) return;
    setLoadingId(artifactId);
    try {
      const manifest = await api.getArtifactManifest(artifactId);
      setManifestById((current) => new Map(current).set(artifactId, manifest.files));
      setErrorById((current) => {
        const next = new Map(current);
        next.delete(artifactId);
        return next;
      });
    } catch {
      setErrorById((current) => new Map(current).set(artifactId, copy.failed));
    } finally {
      setLoadingId(null);
    }
  }

  const locale = lang === "zh" ? "zh-CN" : "en-US";

  if (artifacts.length === 0) {
    return <section className="project-versions-card">
      <header><div><p className="eyebrow">{copy.title}</p><h2>{copy.subtitle}</h2></div></header>
      <p className="project-empty-copy">{copy.empty}</p>
    </section>;
  }

  return <section className="project-versions-card">
    <header>
      <div>
        <p className="eyebrow">{copy.title}</p>
        <h2>{artifacts.length}</h2>
        <p className="project-versions-subtitle">{copy.subtitle}</p>
      </div>
    </header>
    <div className="project-version-list">
      {artifacts.map((artifact, index) => {
        const versionIndex = artifacts.length - index;
        const expanded = expandedId === artifact.artifact_id;
        const files = manifestById.get(artifact.artifact_id);
        const counts = files === undefined ? null : countOps(files);
        const error = errorById.get(artifact.artifact_id);
        return <article key={artifact.artifact_id} className={expanded ? "expanded" : ""}>
          <div className="project-version-index">{versionIndex}</div>
          <div className="project-version-main">
            <div>
              <strong>{copy.versionNumber(versionIndex)}</strong>
              {index === 0 ? <span>{copy.current}</span> : null}
            </div>
            <p>
              {copy.changedFiles(artifact.changed_item_count)}
              {" · "}
              {basedOnLabel(artifact.base_project_version)}
              {" · "}
              {new Date(artifact.created_at).toLocaleString(locale)}
            </p>
            {counts !== null ? <p className="project-version-ops">{copy.summary(counts)}</p> : null}
          </div>
          <button
            type="button"
            className="secondary project-version-toggle"
            aria-expanded={expanded}
            onMouseDown={suppressMouseFocusScroll}
            onClick={() => void toggle(artifact.artifact_id)}
          >{expanded ? copy.collapse : copy.expand}</button>
          {expanded ? <>
            {loadingId === artifact.artifact_id ? <div className="project-version-changeset"><p className="project-empty-copy">{copy.loading}</p></div> : null}
            {error !== undefined ? <div className="project-version-changeset"><p className="notice danger">{error}</p></div> : null}
            {files !== undefined ? <VersionChangeSet files={files} lang={lang} /> : null}
          </> : null}
        </article>;
      })}
    </div>
  </section>;
}
