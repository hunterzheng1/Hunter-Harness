"use client";

import type {
  DraftState,
  ExternalSkill,
  RegistryAgent,
  RegistrySkillDetail,
  RegistrySkillProposal,
  RegistrySkillVersion,
  RegistryTag
} from "@hunter-harness/contracts";
import JSZip from "jszip";
import Link from "next/link";
import { type ChangeEvent, useEffect, useMemo, useRef, useState } from "react";

import { browserApi, buildUploadFormData, type HunterApi } from "../lib/api";
import type { DemoAgent } from "../lib/demo-skills/types";
import { findDemoSourceSkill } from "../lib/demo-skills/sap-field-mapper";
import { useI18n } from "../lib/i18n";
import { mockApi } from "../lib/mock-api";
import { DemoSystemConfig } from "./demo-system-config";
import {
  AgentCheckPanel,
  AgentConfigsOverview,
  AgentContextSelector,
  ContractSecurityOverview,
  SkillConfigOverview,
  VersionHistoryPanel
} from "./skill-detail-panels";
import {
  Empty,
  FilePreview,
  SourceFileTree,
  Status,
  UsageExamples,
  agentLabel,
  apiError,
  detailAgents,
  displayValue,
  parseSkillFrontmatter,
  required
} from "./skill-shared";

function useApi(value?: HunterApi): HunterApi {
  return useMemo(() => value ?? (
    process.env.NEXT_PUBLIC_HUNTER_HARNESS_DEMO === "true" ? mockApi : browserApi()
  ), [value]);
}

function skillStatusGroup(status: RegistrySkillDetail["status"]): "published" | "unpublished" {
  return status === "published" ? "published" : "unpublished";
}

function skillStatusLabel(status: RegistrySkillDetail["status"], t: ReturnType<typeof useI18n>["t"]["skills"]): string {
  return skillStatusGroup(status) === "published" ? t.statusPublished : t.statusUnpublished;
}

type SkillDetailTab = "source" | "examples" | "definition" | "checks" | "versions" | "governance";

const SKILL_ENTRY_PATTERN = /(^|\/)SKILL\.md$/i;

// 客户端预览：从上传的 zip/folder 找 SKILL.md entry，解析 frontmatter 取 name（取代旧 skill IR 解析）。
// 后端 authoritative 解析；此处仅用于上传后提示文案，失败静默回退 draft.slug。
async function parseSkillFile(input: File | FileList | File[]): Promise<{ name: string; sourceName: string }> {
  const files: File[] = Array.isArray(input)
    ? input
    : input instanceof FileList
      ? Array.from(input)
      : [input];
  if (files.length === 0) throw new Error("No file selected");

  const first = files[0];
  if (first !== undefined && files.length === 1 && first.name.toLowerCase().endsWith(".zip")) {
    const zip = await JSZip.loadAsync(await first.arrayBuffer());
    const entry = Object.values(zip.files).find((item) =>
      !item.dir && SKILL_ENTRY_PATTERN.test(item.name) && !item.name.includes("..")
    );
    if (entry === undefined) throw new Error("ZIP: SKILL.md not found");
    const content = await entry.async("text");
    const fm = parseSkillFrontmatter(content);
    return { name: fm?.name ?? first.name, sourceName: first.name };
  }

  const folderEntry = files
    .map((file) => ({ file, path: (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name }))
    .filter(({ path }) => SKILL_ENTRY_PATTERN.test(path) && !path.includes(".."))
    .sort((left, right) => left.path.split("/").length - right.path.split("/").length)[0];
  if (folderEntry === undefined) throw new Error("Folder: SKILL.md not found");
  const content = await folderEntry.file.text();
  const fm = parseSkillFrontmatter(content);
  const rootName = folderEntry.path.includes("/") ? (folderEntry.path.split("/")[0] ?? folderEntry.file.name) : folderEntry.file.name;
  return { name: fm?.name ?? rootName, sourceName: rootName };
}

function uploadLabel(files: File[] | null, fallback: string): string {
  if (files === null || files.length === 0) return fallback;
  const first = files[0];
  if (first === undefined) return fallback;
  if (files.length === 1) return first.name;
  const relative = (first as File & { webkitRelativePath?: string }).webkitRelativePath ?? "";
  const segment = relative.split("/")[0];
  return segment !== undefined && segment !== "" ? segment : files.length + " files";
}

export function SkillRegistry({ api: apiValue }: { api?: HunterApi }) {
  const { t } = useI18n();
  const api = useApi(apiValue);
  const [skills, setSkills] = useState<RegistrySkillDetail[] | null>(null);
  const [externalSkills, setExternalSkills] = useState<ExternalSkill[]>([]);
  const [tags, setTags] = useState<RegistryTag[]>([]);
  const [search, setSearch] = useState("");
  const [agent, setAgent] = useState("");
  const [sourceFilter, setSourceFilter] = useState<"" | "registry" | "external" | "npm" | "github">("");
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [status, setStatus] = useState<"" | "published" | "unpublished">("");
  const [page, setPage] = useState(1);
  const [error, setError] = useState<string | null>(null);
  const [upload, setUpload] = useState<File[] | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [deleteModal, setDeleteModal] = useState<RegistrySkillDetail | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [importRef, setImportRef] = useState("");
  const [importNote, setImportNote] = useState("");
  const [importing, setImporting] = useState(false);

  async function refresh(): Promise<void> {
    try {
      const [nextSkills, nextTags, nextExternal] = await Promise.all([
        required(api, "listSkills")(),
        required(api, "listTags")(),
        api.listExternalSkills === undefined ? Promise.resolve([]) : required(api, "listExternalSkills")()
      ]);
      setSkills(nextSkills);
      setTags(nextTags);
      setExternalSkills(nextExternal);
      setError(null);
    } catch (reason) {
      setError(apiError(reason, t));
    }
  }

  useEffect(() => { void refresh(); }, [api]);
  useEffect(() => { setPage(1); }, [search, agent, status, selectedTags, sourceFilter]);

  const activeTags = tags.filter((tag) => tag.active);
  type MixedItem =
    | { kind: "registry"; skill: RegistrySkillDetail; sortKey: string }
    | { kind: "external"; skill: ExternalSkill; sortKey: string };

  const mixed: MixedItem[] = [
    ...(skills ?? []).map((skill) => ({ kind: "registry" as const, skill, sortKey: skill.name.toLowerCase() })),
    ...externalSkills.map((skill) => ({ kind: "external" as const, skill, sortKey: skill.snapshot.name.toLowerCase() }))
  ].sort((left, right) => left.sortKey.localeCompare(right.sortKey));

  const filtered = mixed.filter((item) => {
    const needle = search.trim().toLowerCase();
    if (item.kind === "registry") {
      if (sourceFilter === "external" || sourceFilter === "npm" || sourceFilter === "github") return false;
      const skill = item.skill;
      return (needle === "" || `${skill.name} ${skill.slug} ${skill.description}`.toLowerCase().includes(needle)) &&
        (selectedTags.length === 0 || selectedTags.every((tag) => skill.tags.includes(tag))) &&
        (agent === "" || skill.agents.some((a) => a.agent === agent)) &&
        (status === "" || skillStatusGroup(skill.status) === status);
    }
    if (sourceFilter === "registry") return false;
    if (sourceFilter === "npm" && item.skill.source.type !== "npm") return false;
    if (sourceFilter === "github" && item.skill.source.type !== "github") return false;
    if (sourceFilter === "" && (agent !== "" || status !== "")) return false;
    const skill = item.skill;
    return (needle === "" || `${skill.snapshot.name} ${skill.source.ref} ${skill.snapshot.description} ${skill.curationNote}`.toLowerCase().includes(needle)) &&
      (selectedTags.length === 0 || selectedTags.every((tag) => skill.tags.includes(tag)));
  });
  const pageSize = 6;
  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const currentPage = Math.min(page, totalPages);
  const pageItems = filtered.slice((currentPage - 1) * pageSize, currentPage * pageSize);
  const publishedCount = (skills ?? []).filter((skill) => skill.status === "published").length;
  const unpublishedCount = (skills ?? []).length - publishedCount;
  const configuredAgentCount = new Set((skills ?? []).flatMap((skill) => skill.agents.map((a) => a.agent))).size;
  const usedSkillCount = 0;

  function toggleTag(slug: string): void {
    setSelectedTags((current) => current.includes(slug) ? current.filter((item) => item !== slug) : [...current, slug]);
  }

  async function submitUpload(): Promise<void> {
    if (upload === null || upload.length === 0) return;
    const files = upload;
    try {
      const hasWorkflowYaml = files.some((f) => {
        const rel = (f as File & { webkitRelativePath?: string }).webkitRelativePath ?? f.name;
        return /(^|\/)workflow\.ya?ml$/i.test(rel);
      });
      if (hasWorkflowYaml) {
        setMessage(t.skills.uploadWorkflowFamilyRedirect);
        setUpload(null);
        return;
      }
      const draft = await required(api, "uploadSkillDraft")(buildUploadFormData(files), "claude-code");
      await refresh();
      let previewName = draft.slug;
      try { previewName = (await parseSkillFile(files)).name || draft.slug; } catch { /* optional client-side preview; backend re-parses authoritatively */ }
      setMessage(t.skills.uploadedAsDraft.replace("{name}", previewName));
      setUpload(null);
    } catch (reason) { setError(apiError(reason, t)); }
  }

  async function submitImport(): Promise<void> {
    const raw = importRef.trim();
    if (raw.length === 0 || importing) return;
    setImporting(true);
    try {
      const type = raw.includes("github.com") || /^[^/\s]+\/[^/\s]+$/.test(raw) ? "github" : "npm";
      const created = await required(api, "createExternalSkill")({
        source: { type, ref: raw },
        curationNote: importNote,
        tags: []
      });
      await refresh();
      setMessage(t.skills.importedExternal.replace("{name}", created.snapshot.name));
      setImportOpen(false);
      setImportRef("");
      setImportNote("");
    } catch (reason) {
      setError(apiError(reason, t));
    } finally {
      setImporting(false);
    }
  }

  function deleteSkill(skill: RegistrySkillDetail): void {
    setDeleteModal(skill);
  }

  async function confirmDelete(): Promise<void> {
    if (deleteModal === null) return;
    try {
      await required(api, "deleteSkill")(deleteModal.slug);
      await refresh();
      setMessage(t.skills.deletedSkill.replace("{name}", deleteModal.name));
      setDeleteModal(null);
    } catch (reason) { setError(apiError(reason, t)); }
  }

  function cancelDelete(): void {
    setDeleteModal(null);
  }

  if (error !== null && skills === null) return <Empty>{error}</Empty>;
  return (
    <section className="stack governance-page">
      <header className="page-heading command-hero">
         <div>
           <p className="eyebrow">{t.skills.eyebrow}</p>
           <h1>{t.skills.title}</h1>
           <p className="lede">{t.skills.description}</p>
        </div>
         <div className="hero-actions"><Status value="governed" /><span>{(skills?.length ?? 0) + externalSkills.length} {t.skills.publishedCount}</span></div>
      </header>

      <div className="registry-toolbar registry-toolbar-expanded panel panel-themed panel-toolbar">
        <label className="search-wide">{t.skills.searchSkills}<input value={search} onChange={(event) => setSearch(event.target.value)} placeholder={t.skills.searchPlaceholder} /></label>
        <label>{t.skills.source}<select value={sourceFilter} onChange={(event) => setSourceFilter(event.target.value as typeof sourceFilter)}><option value="">{t.skills.sourceAll}</option><option value="registry">{t.skills.sourceRegistry}</option><option value="external">{t.skills.sourceExternal}</option><option value="npm">{t.skills.sourceNpm}</option><option value="github">{t.skills.sourceGithub}</option></select></label>
        <label>{t.skills.agent}<select value={agent} onChange={(event) => setAgent(event.target.value)}><option value="">{t.common.all}</option><option value="claude-code">Claude Code</option><option value="codex">Codex</option><option value="cursor">Cursor</option><option value="generic">Generic</option><option value="mcp">MCP</option></select></label>
        <label>{t.skills.status}<select value={status} onChange={(event) => setStatus(event.target.value as "" | "published" | "unpublished")}><option value="">{t.common.all}</option><option value="published">{t.skills.statusPublished}</option><option value="unpublished">{t.skills.statusUnpublished}</option></select></label>
        <div className="tag-filter-panel">
          <span>{t.skills.tag}</span>
          <div className="tag-filter-list">
            {activeTags.map((tag) => <button type="button" className={`tag-filter-chip ${selectedTags.includes(tag.slug) ? "selected" : ""}`} key={tag.tag_id} onClick={() => toggleTag(tag.slug)}>{tag.label}</button>)}
          </div>
        </div>
      </div>

      <div className="hub-grid">
        <div className="panel panel-themed panel-list registry-list">
          <div className="panel-title"><h2>{t.skills.skillList}</h2><span>{filtered.length}</span></div>
          <div className="registry-list-body">
          {skills === null ? <div className="skeleton-block" /> : filtered.length === 0 ? <Empty>{t.skills.noMatch}</Empty> : pageItems.map((item) => {
            if (item.kind === "external") {
              const skill = item.skill;
              return (
                <div className="skill-row-with-actions" key={skill.id}>
                  <Link className="skill-row" href={`/external-skills/${skill.id}`}>
                    <div className="skill-row-main">
                      <strong className="skill-row-name">{skill.snapshot.name}</strong>
                      <p className="skill-row-desc" title={skill.snapshot.description}>{skill.snapshot.description || skill.curationNote}</p>
                      <div className="tag-row">
                        <span className="tag">{t.skills.externalBadge}</span>
                        <span className="tag">{skill.source.type}</span>
                        {skill.updateAvailable ? <span className="tag">{t.skills.updateAvailableBadge}</span> : null}
                        {skill.tags.map((tag) => <span className="tag" key={tag}>{tag}</span>)}
                      </div>
                    </div>
                    <div className="skill-meta">
                      <span className="meta-pill meta-pill-version">{skill.snapshot.version ?? "—"}</span>
                      <span className="skill-meta-cell" title={`${t.skills.updated} ${skill.updated_at.slice(0, 10)}`}>{skill.updated_at.slice(0, 10)}</span>
                      <span className="status status-published">{t.skills.externalBadge}</span>
                    </div>
                  </Link>
                </div>
              );
            }
            const skill = item.skill;
            const usageCount = 0;
            return (
              <div className="skill-row-with-actions" key={skill.skill_id}>
                <Link className="skill-row" href={`/skills/${skill.slug}`}>
                  <div className="skill-row-main"><strong className="skill-row-name">{skill.name}</strong><p className="skill-row-desc" title={displayValue(skill.description, t.skillDetail)}>{displayValue(skill.description, t.skillDetail)}</p><div className="tag-row">{skill.tags.map((tag) => <span className="tag" key={tag}>{tag}</span>)}</div></div>
                  <div className="skill-meta"><span className="meta-pill meta-pill-version">v{skill.latest_version ?? "0.0.0"}</span><span className="skill-meta-cell"><strong>{skill.agents.length}</strong>{t.skills.adapters}</span><span className="skill-meta-cell"><strong>{usageCount}</strong>{t.skills.workflowsPl}</span><span className="skill-meta-cell" title={`${t.skills.updated} ${skill.updated_at.slice(0, 10)}`}>{skill.updated_at.slice(0, 10)}</span><span className={`status ${skill.status === "published" ? "status-published" : "status-draft"}`}>{skillStatusLabel(skill.status, t.skills)}</span></div>
                </Link>
                <button type="button" className="skill-delete-button" aria-label={t.common.delete} title={t.common.delete} onClick={(event) => { event.preventDefault(); event.stopPropagation(); deleteSkill(skill); }}>×</button>
              </div>
            );
          })}
          </div>
          <div className="pagination-bar">
            <button type="button" className="secondary" disabled={currentPage <= 1} onClick={() => setPage(1)}>{t.skills.firstPage}</button>
            <button type="button" className="secondary" disabled={currentPage <= 1} onClick={() => setPage((value) => Math.max(1, value - 1))}>{t.skills.prevPage}</button>
            <span>{t.skills.pageInfo.replace("{page}", String(currentPage)).replace("{total}", String(totalPages))}</span>
            <button type="button" className="secondary" disabled={currentPage >= totalPages} onClick={() => setPage((value) => Math.min(totalPages, value + 1))}>{t.skills.nextPage}</button>
            <button type="button" className="secondary" disabled={currentPage >= totalPages} onClick={() => setPage(totalPages)}>{t.skills.lastPage}</button>
          </div>
        </div>
        <aside className="hub-rail">
          <div className="panel panel-themed panel-upload compact-form">
            <div className="panel-title"><h2>{t.skills.uploadSkill}</h2><Status value="draft" /></div>
            <p>{t.skills.uploadHint}</p>
            <label className="upload-drop-strip"><input type="file" multiple accept=".zip" onChange={(event: ChangeEvent<HTMLInputElement>) => { const files = event.target.files; setUpload(files === null || files.length === 0 ? null : Array.from(files)); }} {...{ webkitdirectory: "" }} /><strong>{t.skills.chooseFile}</strong><span>{uploadLabel(upload, t.skills.uploadDropHint)}</span></label>
            <button disabled={upload === null} onClick={() => void submitUpload()}>{t.skills.addUnpublishedSkill}</button>
          </div>
          <div className="panel panel-themed panel-upload compact-form">
            <div className="panel-title"><h2>{t.skills.importExternal}</h2><span>{t.skills.externalBadge}</span></div>
            <p>{t.skills.importExternalHint}</p>
            <button type="button" className="secondary" onClick={() => setImportOpen(true)}>{t.skills.importExternal}</button>
          </div>
          <div className="panel panel-themed panel-stats skill-stats-panel">
            <div className="panel-title"><h2>{t.skills.stats}</h2><span>{t.skills.liveLocal}</span></div>
            <div className="skill-stat-grid">
              <article><strong>{(skills?.length ?? 0) + externalSkills.length}</strong><span>{t.skills.totalSkills}</span></article>
              <article><strong>{publishedCount}</strong><span>{t.skills.statusPublished}</span></article>
              <article><strong>{unpublishedCount}</strong><span>{t.skills.statusUnpublished}</span></article>
              <article><strong>{externalSkills.length}</strong><span>{t.skills.sourceExternal}</span></article>
              <article><strong>{activeTags.length}</strong><span>{t.skills.activeTags}</span></article>
              <article><strong>{configuredAgentCount}</strong><span>{t.skills.configuredAgents}</span></article>
              <article><strong>{usedSkillCount}</strong><span>{t.skills.usedInWorkflows}</span></article>
            </div>
          </div>
        </aside>
      </div>
      {message === null ? null : <div className="notice success">{message}</div>}
      {error === null ? null : <div className="notice danger">{error}</div>}
      {deleteModal === null ? null : (
        <div className="modal-backdrop" role="presentation" onClick={cancelDelete}>
          <div className="check-confirm-modal delete-confirm-modal" role="dialog" aria-modal="true" aria-labelledby="delete-skill-title" onClick={(event) => event.stopPropagation()}>
            <div className="panel-title">
              <h2 id="delete-skill-title">{t.common.delete}</h2>
              <button type="button" className="icon-button" aria-label={t.common.cancel} onClick={cancelDelete}>×</button>
            </div>
            <p>{t.skills.deleteConfirm.replace("{name}", deleteModal.name)}</p>
            <div className="modal-actions">
              <button type="button" className="secondary" onClick={cancelDelete}>{t.common.cancel}</button>
              <button type="button" className="danger" onClick={() => void confirmDelete()}>{t.common.delete}</button>
            </div>
          </div>
        </div>
      )}
      {importOpen ? (
        <div className="modal-backdrop" role="presentation" onClick={() => setImportOpen(false)}>
          <div className="check-confirm-modal" role="dialog" aria-modal="true" aria-labelledby="import-external-title" onClick={(event) => event.stopPropagation()}>
            <div className="panel-title">
              <h2 id="import-external-title">{t.skills.importExternal}</h2>
              <button type="button" className="icon-button" aria-label={t.common.cancel} onClick={() => setImportOpen(false)}>×</button>
            </div>
            <p>{t.skills.importExternalHint}</p>
            <label>{t.skills.slug}<input value={importRef} onChange={(event) => setImportRef(event.target.value)} placeholder={t.skills.importExternalPlaceholder} /></label>
            <label>{t.skills.importExternalNote}<textarea value={importNote} onChange={(event) => setImportNote(event.target.value)} rows={3} /></label>
            <div className="modal-actions">
              <button type="button" className="secondary" onClick={() => setImportOpen(false)}>{t.common.cancel}</button>
              <button type="button" disabled={importRef.trim() === "" || importing} onClick={() => void submitImport()}>{t.skills.importExternalSubmit}</button>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}

export function SkillDetail({ api: apiValue, skillId }: { api?: HunterApi; skillId: string }) {
  const { t } = useI18n();
  const api = useApi(apiValue);
  const [skill, setSkill] = useState<RegistrySkillDetail | null>(null);
  const [versions, setVersions] = useState<RegistrySkillVersion[]>([]);
  const [proposals] = useState<RegistrySkillProposal[]>([]);
  const [tags, setTags] = useState<RegistryTag[]>([]);
  const [agent, setAgent] = useState<DemoAgent>("claude-code");
  const [currentAgent, setCurrentAgent] = useState<RegistryAgent>("claude-code");
  const [selectedTag, setSelectedTag] = useState("");
  const [draft, setDraft] = useState("");
  const [demoDefaultAgent, setDemoDefaultAgent] = useState<DemoAgent | null>(null);
  const [settingDefault, setSettingDefault] = useState(false);
  const [sourcePath, setSourcePath] = useState("SKILL.md");
  const [activeTab, setActiveTab] = useState<SkillDetailTab>("source");
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [skillDraft, setSkillDraft] = useState<DraftState | null>(null);
  const [npmPublishAvailable, setNpmPublishAvailable] = useState(false);
  const [publishingNpm, setPublishingNpm] = useState(false);
  const userTouchedRef = useRef(false);

  async function refresh(forAgent: RegistryAgent = currentAgent): Promise<void> {
    try {
      const [detail, history, allTags] = await Promise.all([
        required(api, "getSkill")(skillId), required(api, "listSkillVersions")(skillId, forAgent),
        required(api, "listTags")()
      ]);
      setSkill(detail); setVersions(history); setTags(allTags);
      setNpmPublishAvailable((detail as { npm_publish_available?: boolean }).npm_publish_available === true);
      setError(null);
    } catch (reason) {
      setError(apiError(reason, t));
    }
  }

  async function refreshVersions(forAgent: RegistryAgent = currentAgent): Promise<void> {
    try {
      const history = await required(api, "listSkillVersions")(skillId, forAgent);
      setVersions(history);
    } catch (reason) {
      setError(apiError(reason, t));
    }
  }

  async function refreshDraft(forAgent: RegistryAgent = currentAgent): Promise<void> {
    try {
      const d = await required(api, "getSkillDraft")(skillId, forAgent);
      setSkillDraft(d);
    } catch {
      setSkillDraft(null);
    }
  }

  function selectCurrentAgent(next: RegistryAgent): void {
    userTouchedRef.current = true;
    setCurrentAgent(next);
    setSkillDraft(null);
    void refreshDraft(next);
    void refreshVersions(next);
  }

  async function setDefaultAgentHandler(next: RegistryAgent): Promise<void> {
    if (skill === null) return;
    if (process.env.NEXT_PUBLIC_HUNTER_HARNESS_DEMO === "true") {
      setDemoDefaultAgent(next);
      return;
    }
    try {
      setSettingDefault(true);
      const updated = await required(api, "setDefaultAgent")(skillId, next, skill.revision);
      setSkill(updated);
      setMessage(t.skillDetail.defaultAgentUpdated);
    } catch (reason) {
      setError(apiError(reason, t));
    } finally {
      setSettingDefault(false);
    }
  }

  function handlePublished(): void {
    void refresh();
    void refreshDraft();
  }

  useEffect(() => {
    userTouchedRef.current = false;
    setCurrentAgent("claude-code");
    const stored = globalThis.localStorage?.getItem("hunter-harness-default-agent");
    if (stored === "claude-code" || stored === "cursor" || stored === "codex" || stored === "generic" || stored === "mcp") setAgent(stored as DemoAgent);
    void refresh("claude-code");
    void refreshDraft("claude-code");
  }, [api, skillId]);

  useEffect(() => {
    if (skill === null || userTouchedRef.current) return;
    const def = skill.defaultAgent ?? skill.agents.find((a) => a.enabled)?.agent ?? "claude-code";
    if (def !== currentAgent) {
      setCurrentAgent(def);
      setSkillDraft(null);
      void refreshDraft(def);
      void refreshVersions(def);
    }
  }, [skill]);

  useEffect(() => { setSourcePath("SKILL.md"); }, [skillId]);
  const command = `npx @hunter-harness/skill-cli install ${skillId} --agent ${agent}`;
  const npmCommand = `npx @hunter-harness/skill-cli install ${skillId} --agent ${agent} --from npm`;
  const latestNpmRelease = skill?.npmReleases.find((entry) => entry.version === skill.latest_version) ?? null;
  const npmBadgeLabel = latestNpmRelease?.status === "published"
    ? `${t.skillDetail.npmBadgePublished} v${latestNpmRelease.version}`
    : latestNpmRelease?.status === "failed"
      ? t.skillDetail.npmBadgeFailed
      : latestNpmRelease?.status === "conflict"
        ? t.skillDetail.npmBadgeConflict
        : t.skillDetail.npmBadgeUnpublished;
  const npmPublishDisabled = process.env.NEXT_PUBLIC_HUNTER_HARNESS_DEMO === "true"
    || !npmPublishAvailable
    || skill?.status !== "published"
    || skill?.latest_version === null
    || latestNpmRelease?.status === "published";
  async function publishToNpm(): Promise<void> {
    if (skill === null || npmPublishDisabled) return;
    try {
      setPublishingNpm(true);
      await required(api, "releaseSkillToNpm")(skillId);
      await refresh();
      setMessage(t.skillDetail.npmPublished);
    } catch (reason) {
      setError(apiError(reason, t));
    } finally {
      setPublishingNpm(false);
    }
  }
  async function copyCommand(): Promise<void> {
    await navigator.clipboard.writeText(command); setMessage(t.skillDetail.installCopied);
  }
  async function download(): Promise<void> {
    try {
      const artifact = await required(api, "downloadSkillArtifact")(skillId, agent);
      const url = URL.createObjectURL(artifact.blob);
      const anchor = document.createElement("a"); anchor.href = url; anchor.download = artifact.filename; anchor.click();
      URL.revokeObjectURL(url); setMessage(`{t.skillDetail.downloadedAudit}${artifact.hash.slice(0, 20)}…`);
    } catch (reason) { setError(apiError(reason, t)); }
  }
  async function submitDraft(): Promise<void> {
    setMessage(t.skillDetail.localDraftOnly);
  }
  async function review(proposalId: string, decision: "approve" | "reject"): Promise<void> {
    void proposalId;
    void decision;
    setMessage(t.skillDetail.localDraftOnly);
  }
  function saveLocalMeta(next: { description: string; tags: string[] }): void {
    setSkill((current) => current === null ? current : {
      ...current,
      description: next.description,
      tags: next.tags,
      updated_at: new Date().toISOString()
    });
    setMessage(t.skillDetail.savedLocalConfig);
  }
  function removeLocalTag(slug: string): void {
    if (skill === null) return;
    saveLocalMeta({
      description: skill.description,
      tags: skill.tags.filter((tag) => tag !== slug)
    });
  }
  async function bindTag(): Promise<void> {
    if (selectedTag === "") return;
    try { setSkill(await required(api, "bindSkillTag")(skillId, selectedTag)); setMessage(t.skills.tagSavedAudit); }
    catch (reason) { setError(apiError(reason, t)); }
  }
  if (error !== null && skill === null) return <Empty>{error}</Empty>;
  if (skill === null) return <Empty>{t.skillDetail.loading}</Empty>;
  const sourceSkill = process.env.NEXT_PUBLIC_HUNTER_HARNESS_DEMO === "true"
    ? findDemoSourceSkill(skill.slug)
    : undefined;
  const activeDefaultAgent = demoDefaultAgent ?? sourceSkill?.defaultAgent;
  const effectiveDefault = demoDefaultAgent ?? skill.defaultAgent;
  const selectedAgent = sourceSkill?.agents.find((item) => item.agent === agent);
  const defaultAgent = sourceSkill?.agents.find((item) => item.agent === activeDefaultAgent);
  const fallback = selectedAgent !== undefined && selectedAgent.configured === false && defaultAgent !== undefined;
  const sourceFile = sourceSkill?.source.files.find((file) => file.path === sourcePath) ?? sourceSkill?.source.entrypoint;
  const prodSourceFile = skill.sourceFiles.find((file) => file.path === sourcePath) ?? skill.sourceFiles[0];
  const adapterPatch = sourceSkill?.adapters[agent];
  const entryFile = skill.sourceFiles.find((file) => /(^|\/)SKILL\.md$/i.test(file.path)) ?? skill.sourceFiles[0];
  const frontmatter = entryFile !== undefined ? parseSkillFrontmatter(entryFile.content) : null;
  return (
    <section className="stack governance-page">
      <header className="page-heading command-hero skill-detail-hero">
        <div className="page-heading-main">
          <Link className="back-button" href="/skills" aria-label={t.common.back}>
            <span aria-hidden="true">‹</span>
          </Link>
          <div className="page-heading-content">
            <p className="eyebrow">{t.skillDetail.eyebrow}</p>
            <h1>{skill.name}</h1>
            <p className="lede">{displayValue(skill.description, t.skillDetail)}</p>
            <div className="tag-row">{skill.tags.map((tag) => <button type="button" className="tag tag-remove" aria-label={`remove-tag  ${tag}`} onClick={() => removeLocalTag(tag)} key={tag}>{tag}<span aria-hidden="true">×</span></button>)}</div>
          </div>
        </div>
        <div className="skill-meta skill-detail-meta">
          <Status value={skill.status} />
          <code className="skill-detail-version">v{skill.latest_version}</code>
          <span className={`npm-badge npm-badge-${latestNpmRelease?.status ?? "unpublished"}`}>{npmBadgeLabel}</span>
        </div>
      </header>

      <div className="command-panel skill-command-panel panel">
        <label>{t.skillDetail.targetAgent}<select value={agent} onChange={(event) => { const value = event.target.value as DemoAgent; setAgent(value); localStorage.setItem("hunter-harness-default-agent", value); }}>{detailAgents.map((item) => <option value={item.value} key={item.value}>{item.label}</option>)}</select></label>
        <code className="command-code">{command}</code>
        <button onClick={() => void copyCommand()}>{t.skillDetail.copyCommand}</button>
        <button className="secondary" onClick={() => void download()}>{t.skillDetail.downloadZip}</button>
        <button
          className="secondary"
          disabled={npmPublishDisabled || publishingNpm}
          title={npmPublishAvailable ? undefined : t.skillDetail.npmPublishUnavailable}
          onClick={() => void publishToNpm()}
        >
          {publishingNpm ? "…" : t.skillDetail.npmPublish}
        </button>
        <code className="command-code npm-command-code">{npmCommand}</code>
      </div>

      {fallback ? <div className="notice warning agent-fallback-banner">{t.skillDetail.fallbackBanner.replace("{agent}", selectedAgent.label).replace("{defaultAgent}", defaultAgent.label).replace("{path}", selectedAgent.targetPath)}</div> : null}

      <div className="skill-detail-tabs" role="tablist" aria-label="Skill detail sections">
        {([
          ["source", t.skillDetail.tabSource],
          ["examples", t.skillDetail.tabExamples],
          ["definition", t.skillDetail.tabDefinition],
          ["checks", t.skillDetail.tabChecks],
          ["versions", t.skillDetail.tabVersions]
        ] as const).map(([id, label]) => <button key={id} type="button" role="tab" aria-selected={activeTab === id} className={activeTab === id ? "selected" : ""} onClick={() => setActiveTab(id)}>{label}</button>)}
      </div>

      {activeTab === "source" && sourceSkill !== undefined && sourceFile !== undefined ? <article className="panel source-package">
        <div className="panel-title"><h2>{t.skillDetail.sourceFiles}</h2><span>{t.skillDetail.authoritativeDemoPackage}</span></div>
        <div className="source-package-grid">
          <SourceFileTree files={sourceSkill.source.files} selectedPath={sourceFile.path} onSelect={setSourcePath} />
          <FilePreview key={sourceFile.path} path={sourceFile.path} content={sourceFile.content} showRaw={t.skillDetail.showRaw} showRendered={t.skillDetail.showRendered} />
        </div>
        {adapterPatch === undefined ? null : <div className="adapter-patch"><strong>{t.skillDetail.codexAdaptation}</strong><p>{adapterPatch.patchSummary}</p></div>}
      </article> : null}

      {activeTab === "source" && sourceSkill === undefined && skill.sourceFiles.length > 0 && prodSourceFile !== undefined ? <article className="panel source-package">
        <div className="panel-title"><h2>{t.skillDetail.sourceFiles}</h2><span>{t.skillDetail.configSummary}</span></div>
        <div className="source-package-grid">
          <SourceFileTree files={skill.sourceFiles} selectedPath={prodSourceFile.path} onSelect={setSourcePath} />
          <FilePreview key={prodSourceFile.path} path={prodSourceFile.path} content={prodSourceFile.content} showRaw={t.skillDetail.showRaw} showRendered={t.skillDetail.showRendered} />
        </div>
      </article> : null}

      {activeTab === "source" && sourceSkill === undefined && skill.sourceFiles.length === 0 ? <article className="panel source-package">
        <div className="panel-title"><h2>{t.skillDetail.sourceFiles}</h2><span>{t.skillDetail.configSummary}</span></div>
        <Empty>{t.skillDetail.notAvailable}</Empty>
      </article> : null}

      {activeTab === "examples" ? <article className="panel">
        <div className="panel-title"><h2>{t.skillDetail.usageExamples}</h2><span>{t.skillDetail.usageExamplesSummary}</span></div>
        <UsageExamples examples={sourceSkill !== undefined ? sourceSkill.examples : skill.examples} t={t.skillDetail} />
      </article> : null}

      {activeTab === "definition" && sourceSkill !== undefined ? <div className="detail-grid system-config-layout">
        <article className="panel"><div className="panel-title"><h2>{t.skillDetail.systemConfig}</h2><span>{t.skillDetail.configSummary}</span></div><SkillConfigOverview name={skill.name} description={skill.description} version={frontmatter?.version ?? null} agents={skill.agents} t={t.skillDetail} tags={skill.tags} onSaveMeta={saveLocalMeta} top={<DemoSystemConfig agents={sourceSkill.agents} currentAgent={selectedAgent} defaultAgent={activeDefaultAgent ?? sourceSkill.defaultAgent} onSetDefault={setDemoDefaultAgent} t={t.skillDetail} />} /></article>
        <article className="panel"><div className="panel-title"><h2>{t.skillDetail.contractsSecurity}</h2><span>{t.skillDetail.contractsSecuritySummary}</span></div><ContractSecurityOverview frontmatter={frontmatter} t={t.skillDetail} /></article>
      </div> : null}

      {activeTab === "definition" && sourceSkill === undefined ? <div className="detail-grid system-config-layout">
        <article className="panel"><div className="panel-title"><h2>{t.skillDetail.systemConfig}</h2><span>{t.skillDetail.configSummary}</span></div><SkillConfigOverview name={skill.name} description={skill.description} version={frontmatter?.version ?? null} agents={skill.agents} t={t.skillDetail} tags={skill.tags} onSaveMeta={saveLocalMeta} top={<AgentConfigsOverview agents={skill.agents} t={t.skillDetail} />} /></article>
        <article className="panel"><div className="panel-title"><h2>{t.skillDetail.contractsSecurity}</h2><span>{t.skillDetail.contractsSecuritySummary}</span></div><ContractSecurityOverview frontmatter={frontmatter} t={t.skillDetail} /></article>
      </div> : null}

      {activeTab === "checks" ? <article className="panel">
        <div className="panel-title"><h2>{t.skillDetail.checkPublish}</h2><span>{agentLabel(currentAgent)}</span></div>
        <AgentContextSelector agents={skill.agents} currentAgent={currentAgent} defaultAgent={effectiveDefault} onSelect={selectCurrentAgent} onSetDefault={setDefaultAgentHandler} settingDefault={settingDefault} t={t.skillDetail} />
        <AgentCheckPanel key={currentAgent} api={api} slug={skillId} currentAgent={currentAgent} draft={skillDraft} onPublished={handlePublished} t={t} />
      </article> : null}

      {activeTab === "versions" ? <article className="panel">
        <div className="panel-title"><h2>{t.skillDetail.versionHistory}</h2><span>{agentLabel(currentAgent)}</span></div>
        <AgentContextSelector agents={skill.agents} currentAgent={currentAgent} defaultAgent={effectiveDefault} onSelect={selectCurrentAgent} onSetDefault={setDefaultAgentHandler} settingDefault={settingDefault} t={t.skillDetail} />
        <VersionHistoryPanel key={currentAgent} versions={versions} currentAgent={currentAgent} t={t.skillDetail} />
      </article> : null}

      {activeTab === "governance" ? <>
        <article className="panel compact-form"><div className="panel-title"><h2>{t.skillDetail.tagBinding}</h2><span>{t.skillDetail.noReview}</span></div><div className="inline-form"><select aria-label={t.skillDetail.selectTag} value={selectedTag} onChange={(event) => setSelectedTag(event.target.value)}><option value="">{t.skillDetail.selectTag}</option>{tags.filter((tag) => tag.active && !skill.tags.includes(tag.slug)).map((tag) => <option value={tag.tag_id} key={tag.tag_id}>{tag.label}</option>)}</select><button onClick={() => void bindTag()}>{t.skillDetail.addTag}</button></div></article>

        <article className="panel"><div className="panel-title"><h2>{t.skillDetail.createProposal}</h2><Status value="review-required" /></div><textarea className="ir-editor" aria-label="Skill IR draft" value={draft} onChange={(event) => setDraft(event.target.value)} /><div className="actions"><button onClick={() => void submitDraft()}>{t.skillDetail.validateSubmit}</button></div></article>

        <article className="panel"><div className="panel-title"><h2>{t.skillDetail.reviewRecord}</h2><span>{proposals.length}</span></div>{proposals.length === 0 ? <Empty>{t.skillDetail.noProposalLinked}</Empty> : proposals.map((proposal) => <div className="proposal-card" key={proposal.proposal_id}><div><strong>{proposal.proposal_id}</strong><code>{proposal.skill_slug}</code><small>schema {proposal.validation.schema_valid ? "valid" : "invalid"} · sensitive findings {proposal.validation.sensitive_findings} · Claude compile {proposal.validation.claude_compilable ? "passed" : "failed"}</small></div><div><Status value={proposal.status} />{proposal.status === "pending_review" ? <><button onClick={() => void review(proposal.proposal_id, "approve")}>{t.skillDetail.approve}</button><button className="secondary" onClick={() => void review(proposal.proposal_id, "reject")}>{t.skillDetail.reject}</button></> : null}</div></div>)}</article>
      </> : null}
      {message === null ? null : <div className="notice success">{message}</div>}{error === null ? null : <div className="notice danger">{error}</div>}
    </section>
  );
}
