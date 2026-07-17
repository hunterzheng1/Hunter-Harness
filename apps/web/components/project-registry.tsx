"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";

import { browserApi, type HunterApi, type ProjectSummary } from "../lib/api";
import { useI18n } from "../lib/i18n";
import { mockApi } from "../lib/mock-api";
import {
  formatProjectDateTime,
  paginateProjects,
  PROJECT_LIST_PAGE_SIZE,
  projectMatchesQuery,
  sortProjectsByUpdatedDesc
} from "../lib/project-list";
import { suppressMouseFocusScroll } from "../lib/preserve-scroll";
import { apiError } from "./skill-shared";

function resolveApi(): HunterApi {
  return process.env.NEXT_PUBLIC_HUNTER_HARNESS_DEMO === "true" ? mockApi : browserApi();
}

export function ProjectRegistry({ api: propApi }: { api?: HunterApi }) {
  const { t, lang } = useI18n();
  const api = useMemo(() => propApi ?? resolveApi(), [propApi]);
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null);
  const [archived, setArchived] = useState<ProjectSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [view, setView] = useState<"active" | "trash">("active");
  const [page, setPage] = useState(0);
  const [busy, setBusy] = useState(false);
  const [pendingAction, setPendingAction] = useState<{
    kind: "archive" | "restore" | "purge" | "empty";
    project?: ProjectSummary;
  } | null>(null);
  const dialogRef = useRef<HTMLElement | null>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const busyRef = useRef(false);
  busyRef.current = busy;

  const copy = lang === "zh" ? {
    eyebrow: "项目工作区", title: "项目", description: "集中查看项目文件、知识状态与版本记录。",
    active: "当前项目", trash: "回收站", search: "搜索项目", searchPlaceholder: "按名称或 ID 搜索",
    files: "受管文件", versioned: "已有版本", recentlyUpdated: "近 7 天更新",
    firstSync: "等待首次同步", fileUnit: "个文件", updated: "更新于",
    archive: "移到回收站", restore: "恢复", purge: "永久删除", emptyTrash: "清空回收站",
    noProjects: "还没有项目。运行 npx hunter-harness 完成首次同步后会显示在这里。", noTrash: "回收站是空的。",
    noMatch: "没有符合搜索条件的项目。", trashHint: "项目会在回收站保留 30 天，到期后自动清理。",
    purgeAt: "自动清理", confirmArchive: "将此项目移到回收站？30 天内可以恢复。",
    confirmRestore: "恢复此项目？", confirmPurge: "永久删除后无法恢复，是否继续？",
    confirmEmpty: "永久删除回收站中的所有项目？此操作无法撤销。", confirm: "确认", cancel: "取消",
    prev: "上一页", next: "下一页",
    count: (n: number) => `${n} 个`,
    page: (current: number, total: number, count: number) => `第 ${current}/${total} 页 · ${count} 个`
  } : {
    eyebrow: "Project workspace", title: "Projects", description: "View project files, knowledge health, and version history in one place.",
    active: "Active projects", trash: "Recycle bin", search: "Search projects", searchPlaceholder: "Search by name or ID",
    files: "Managed files", versioned: "With versions", recentlyUpdated: "Updated in 7 days",
    firstSync: "Awaiting first sync", fileUnit: "files", updated: "Updated",
    archive: "Move to recycle bin", restore: "Restore", purge: "Delete permanently", emptyTrash: "Empty recycle bin",
    noProjects: "No projects yet. Run npx hunter-harness to complete the first sync.", noTrash: "The recycle bin is empty.",
    noMatch: "No projects match your search.", trashHint: "Projects remain in the recycle bin for 30 days, then are removed automatically.",
    purgeAt: "Auto removal", confirmArchive: "Move this project to the recycle bin? You can restore it for 30 days.",
    confirmRestore: "Restore this project?", confirmPurge: "Permanent deletion cannot be undone. Continue?",
    confirmEmpty: "Permanently delete every project in the recycle bin? This cannot be undone.", confirm: "Confirm", cancel: "Cancel",
    prev: "Previous", next: "Next",
    count: (n: number) => `${n}`,
    page: (current: number, total: number, count: number) => `Page ${current}/${total} · ${count} projects`
  };

  async function reload(): Promise<void> {
    const [activeItems, archivedItems] = await Promise.all([
      api.listProjects("active"), api.listProjects("archived")
    ]);
    setProjects(activeItems);
    setArchived(archivedItems);
  }

  useEffect(() => {
    let active = true;
    setError(null);
    void Promise.all([api.listProjects("active"), api.listProjects("archived")])
      .then(([items, trash]) => { if (active) { setProjects(items); setArchived(trash); } })
      .catch((reason: unknown) => { if (active) setError(apiError(reason, t)); });
    return () => { active = false; };
  }, [api, t]);

  useEffect(() => {
    setPage(0);
  }, [query, view]);

  useEffect(() => {
    if (pendingAction === null) return;
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    cancelRef.current?.focus();

    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === "Escape") {
        if (busyRef.current) return;
        event.preventDefault();
        setPendingAction(null);
        return;
      }
      if (event.key !== "Tab" || dialogRef.current === null) return;
      const focusable = [...dialogRef.current.querySelectorAll<HTMLElement>("button:not([disabled])")];
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (first === undefined || last === undefined) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      previouslyFocused?.focus();
    };
  }, [pendingAction]);

  if (error !== null && projects === null) return <div className="empty-state">{error}</div>;
  if (projects === null) return <div className="empty-state">{t.projects.loading}</div>;

  const source = view === "active" ? projects : archived;
  const needle = query.trim().toLowerCase();
  const filtered = sortProjectsByUpdatedDesc(
    source.filter((project) => projectMatchesQuery(project, needle))
  );
  const { pageCount, safePage, pageItems } = paginateProjects(filtered, page, PROJECT_LIST_PAGE_SIZE);
  const withVersion = projects.filter((project) => project.latest_project_version !== null).length;
  const fileCount = projects.reduce((sum, project) => sum + (project.current_file_count ?? 0), 0);
  const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const recent = projects.filter((project) => Date.parse(project.updated_at ?? project.created_at) >= weekAgo).length;

  async function executeAction(): Promise<void> {
    if (pendingAction === null) return;
    setBusy(true);
    try {
      if (pendingAction.kind === "archive" && pendingAction.project !== undefined) {
        await api.archiveProject?.(pendingAction.project.project_id);
      } else if (pendingAction.kind === "restore" && pendingAction.project !== undefined) {
        await api.restoreProject?.(pendingAction.project.project_id);
      } else if (pendingAction.kind === "purge" && pendingAction.project !== undefined) {
        await api.purgeProject?.(pendingAction.project.project_id);
      } else if (pendingAction.kind === "empty") {
        const results = await Promise.allSettled(
          archived.map((project) => api.purgeProject?.(project.project_id))
        );
        await reload();
        const failed = results.filter((result) => result.status === "rejected").length;
        if (failed > 0) throw new Error(`${failed} project(s) could not be permanently deleted.`);
        setPendingAction(null);
        return;
      }
      await reload();
      setPendingAction(null);
    } catch (reason) {
      setError(apiError(reason, t));
    } finally {
      setBusy(false);
    }
  }

  const confirmText = pendingAction?.kind === "archive" ? copy.confirmArchive
    : pendingAction?.kind === "restore" ? copy.confirmRestore
      : pendingAction?.kind === "empty" ? copy.confirmEmpty : copy.confirmPurge;

  return <section className="stack governance-page project-registry-v2">
    <header className="project-registry-hero">
      <div><p className="eyebrow">{copy.eyebrow}</p><h1>{copy.title}</h1><p>{copy.description}</p></div>
      <div className="project-view-switch" role="tablist" aria-label={copy.title}>
        <button type="button" role="tab" aria-selected={view === "active"} className={view === "active" ? "selected" : ""} onMouseDown={suppressMouseFocusScroll} onClick={() => setView("active")}>{copy.active}<span>{projects.length}</span></button>
        <button type="button" role="tab" aria-selected={view === "trash"} className={view === "trash" ? "selected" : ""} onMouseDown={suppressMouseFocusScroll} onClick={() => setView("trash")}>{copy.trash}<span>{archived.length}</span></button>
      </div>
    </header>

    {view === "active" ? <div className="project-registry-metrics">
      <article><span>⌘</span><div><strong>{fileCount}</strong><small>{copy.files}</small></div></article>
      <article><span>↗</span><div><strong>{withVersion}</strong><small>{copy.versioned}</small></div></article>
      <article><span>◴</span><div><strong>{recent}</strong><small>{copy.recentlyUpdated}</small></div></article>
    </div> : <div className="project-trash-banner"><span>♲</span><div><strong>{copy.trashHint}</strong><p>{archived.length}</p></div>{archived.length > 0 ? <button type="button" className="danger secondary" onClick={() => setPendingAction({ kind: "empty" })}>{copy.emptyTrash}</button> : null}</div>}

    <div className="project-registry-toolbar">
      <label><span>⌕</span><input aria-label={copy.search} value={query} onChange={(event) => setQuery(event.target.value)} placeholder={copy.searchPlaceholder} /></label>
      <span>{copy.count(filtered.length)}</span>
    </div>

    <div className="project-card-list">
      {filtered.length === 0 ? <div className="empty-state">{needle !== "" ? copy.noMatch : view === "active" ? copy.noProjects : copy.noTrash}</div> : pageItems.map((project) => {
        const version = project.latest_project_version;
        const hasVersion = version !== null && version !== "";
        return <article key={project.project_id} className="project-list-card">
          {view === "active" ? <Link href={`/projects/${project.project_id}`} className="project-list-link" aria-label={project.display_name} /> : null}
          <div className="project-avatar" aria-hidden="true">{project.display_name.slice(0, 1).toUpperCase()}</div>
          <div className="project-list-main">
            <div>
              <h2>{project.display_name}</h2>
              <span className={hasVersion ? "synced" : "waiting"}>{hasVersion ? version : copy.firstSync}</span>
            </div>
            <p>{project.current_file_count ?? 0} {copy.fileUnit} · {copy.updated} {formatProjectDateTime(project.updated_at ?? project.created_at, lang)}</p>
          </div>
          <div className="project-list-actions">
            {view === "active" ? <button type="button" className="secondary danger" onClick={() => setPendingAction({ kind: "archive", project })}>{copy.archive}</button> : <><button type="button" onClick={() => setPendingAction({ kind: "restore", project })}>{copy.restore}</button><button type="button" className="secondary danger" onClick={() => setPendingAction({ kind: "purge", project })}>{copy.purge}</button></>}
            {view === "trash" && project.purge_after !== null && project.purge_after !== undefined ? <small>{copy.purgeAt} {formatProjectDateTime(project.purge_after, lang)}</small> : null}
          </div>
        </article>;
      })}
      {filtered.length === 0 || pageCount <= 1 ? null : <div className="knowledge-pager project-list-pager">
        <span>{copy.page(safePage + 1, pageCount, filtered.length)}</span>
        <div>
          <button type="button" className="text-button" disabled={safePage <= 0} onMouseDown={suppressMouseFocusScroll} onClick={() => setPage((current) => Math.max(0, current - 1))}>{copy.prev}</button>
          <button type="button" className="text-button" disabled={safePage >= pageCount - 1} onMouseDown={suppressMouseFocusScroll} onClick={() => setPage((current) => Math.min(pageCount - 1, current + 1))}>{copy.next}</button>
        </div>
      </div>}
    </div>

    {error === null || projects === null ? null : <div className="notice danger">{error}</div>}
    {pendingAction === null ? null : <div
      className="project-confirm-backdrop"
      role="presentation"
      onClick={() => { if (!busy) setPendingAction(null); }}
    >
      <section
        ref={dialogRef}
        className="project-confirm-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="project-confirm-title"
        aria-describedby="project-confirm-desc"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="project-confirm-icon" aria-hidden="true">!</div>
        <h2 id="project-confirm-title">{pendingAction.project?.display_name ?? copy.emptyTrash}</h2>
        <p id="project-confirm-desc">{confirmText}</p>
        <div className="actions">
          <button type="button" className={pendingAction.kind === "purge" || pendingAction.kind === "empty" ? "danger" : ""} disabled={busy} onClick={() => void executeAction()}>{copy.confirm}</button>
          <button ref={cancelRef} type="button" className="secondary" disabled={busy} onClick={() => setPendingAction(null)}>{copy.cancel}</button>
        </div>
      </section>
    </div>}
  </section>;
}
