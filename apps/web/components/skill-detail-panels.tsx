"use client";

import type {
  AgentSkillConfig,
  DraftState,
  FixPlan,
  FixPlanItem,
  SkillCheckItem,
  SkillCheckResult,
  SkillDiffFile,
  SkillIr,
  RegistrySkillVersion
} from "@hunter-harness/contracts";
import { type ChangeEvent, useEffect, useState } from "react";

import { buildUploadFormData, type HunterApi } from "../lib/api";
import type { useI18n } from "../lib/i18n";
import {
  CheckLight,
  Empty,
  EnabledTargets,
  FilePreview,
  SourceFileTree,
  ValueChips,
  apiError,
  diffStats,
  displayValue,
  nextPatchVersion,
  required,
  shiftPatchVersion,
  tagSlug
} from "./skill-shared";

function ContractSecurityOverview({ ir, t }: { ir: SkillIr; t: ReturnType<typeof useI18n>["t"]["skillDetail"] }) {
  return <div className="contract-card-grid">
    <article className="contract-card contract-card-wide">
      <div>
        <span className="contract-card-label">{t.triggers}</span>
        <p>{t.triggersDescription}</p>
      </div>
      <ValueChips values={ir.triggers} empty={t.noneShort} t={t} />
    </article>
    <article className="contract-card">
      <div>
        <span className="contract-card-label">{t.inputs}</span>
        <p>{t.inputsDescription}</p>
      </div>
      <ValueChips values={ir.inputs} empty={t.noneShort} t={t} />
    </article>
    <article className="contract-card">
      <div>
        <span className="contract-card-label">{t.outputs}</span>
        <p>{t.outputsDescription}</p>
      </div>
      <ValueChips values={ir.outputs} empty={t.noneShort} t={t} />
    </article>
    <article className="contract-card contract-card-danger">
      <div>
        <span className="contract-card-label">{t.forbiddenActions}</span>
        <p>{t.forbiddenActionsDescription}</p>
      </div>
      <ValueChips values={ir.forbidden_actions} empty={t.noneShort} t={t} />
    </article>
    <article className="contract-card">
      <div>
        <span className="contract-card-label">{t.requiredContext}</span>
        <p>{t.requiredContextDescription}</p>
      </div>
      <ValueChips values={ir.required_context} empty={t.noneShort} t={t} />
    </article>
    <article className="contract-card contract-card-wide">
      <div>
        <span className="contract-card-label">{t.provenance}</span>
        <p>{displayValue(ir.source_provenance ?? t.provenanceDefault, t)}</p>
      </div>
    </article>
  </div>;
}

function SkillConfigOverview({
  ir,
  t,
  top,
  tags,
  onSaveMeta
}: {
  ir: SkillIr;
  t: ReturnType<typeof useI18n>["t"]["skillDetail"];
  top?: React.ReactNode;
  tags?: string[];
  onSaveMeta?: (next: { description: string; tags: string[] }) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [description, setDescription] = useState(ir.description);
  const [tagDraft, setTagDraft] = useState("");
  const [tagValues, setTagValues] = useState<string[]>(tags ?? []);
  const tagLibrary = Array.from(new Set([...(tags ?? []), "sap", "mapping", "finance", "migration", "security"])).sort();

  useEffect(() => {
    if (editing) return;
    setDescription(ir.description);
    setTagValues(tags ?? []);
    setTagDraft("");
  }, [editing, ir.description, tags]);

  function save(): void {
    onSaveMeta?.({ description: description.trim() || ir.description, tags: tagValues });
    setEditing(false);
  }

  function addTag(value: string): void {
    const slug = tagSlug(value);
    if (slug === "" || tagValues.includes(slug)) return;
    setTagValues((current) => [...current, slug]);
    setTagDraft("");
  }

  return <div className="system-config-grid">
    {top}
    <article className="system-config-card system-config-card-wide">
      <div className="editable-card-heading">
        <span className="config-card-label">{t.basicInfo}</span>
        {onSaveMeta === undefined ? null : editing
          ? <div className="editable-card-actions"><button type="button" onClick={save}>{t.saveBasicInfo}</button><button type="button" className="secondary" onClick={() => setEditing(false)}>{t.cancelEdit}</button></div>
          : <button type="button" className="secondary" onClick={() => setEditing(true)}>{t.editBasicInfo}</button>}
      </div>
      <h3>{ir.name}</h3>
      {editing ? <div className="basic-info-editor">
        <label className="config-edit-field">{t.description}<textarea value={description} onChange={(event) => setDescription(event.target.value)} /></label>
        <section className="edit-panel">
          <div className="edit-panel-title"><span>{t.tags}</span><small>{t.tagsHint}</small></div>
          <div className="editable-tag-group">
            {tagValues.length === 0 ? <span className="muted-inline">{t.noneShort}</span> : tagValues.map((tag) => <button type="button" className="editable-tag selected" key={tag} onClick={() => setTagValues((current) => current.filter((item) => item !== tag))}>{tag}<span aria-hidden="true">−</span></button>)}
          </div>
          <div className="tag-library">
            <div className="edit-panel-title"><span>{t.tagLibrary}</span><small>{t.tagLibraryHint}</small></div>
            <div className="editable-tag-group">
              {tagLibrary.filter((tag) => !tagValues.includes(tag)).map((tag) => <button type="button" className="editable-tag addable" key={tag} onClick={() => addTag(tag)}>{tag}<span aria-hidden="true">＋</span></button>)}
            </div>
          </div>
          <div className="inline-add-control"><input value={tagDraft} onChange={(event) => setTagDraft(event.target.value)} placeholder={t.addTagPlaceholder} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); addTag(tagDraft); } }} /><button type="button" className="secondary" onClick={() => addTag(tagDraft)}>＋</button></div>
        </section>
      </div> : <p>{displayValue(ir.description, t)}</p>}
      {!editing ? <dl>
        <dt>{t.version}</dt><dd><span className="meta-pill meta-pill-version">v{ir.version}</span></dd>
        <dt>{t.tags}</dt>
        <dd><ValueChips values={tags} empty={t.noneShort} /></dd>
      </dl> : null}
    </article>
    <article className="system-config-card">
      <span className="config-card-label">{t.adapters}</span>
      <EnabledTargets targets={ir.adapters} empty={t.noneShort} enabledLabel={t.enabled} disabledLabel={t.disabled} />
    </article>
    <article className="system-config-card">
      <span className="config-card-label">{t.allowedCapabilities}</span>
      <ValueChips values={ir.allowed_capabilities} empty={t.noneShort} t={t} />
    </article>
    <article className="system-config-card system-config-card-wide">
      <span className="config-card-label">{t.instructions}</span>
      {ir.instructions === undefined || ir.instructions.length === 0
        ? <p className="muted-inline">{t.noneShort}</p>
        : <ol className="config-steps">{ir.instructions.map((instruction) => <li key={instruction}>{displayValue(instruction, t)}</li>)}</ol>}
    </article>
  </div>;
}

function checkStatusCopy(status: "green" | "yellow" | "red", t: ReturnType<typeof useI18n>["t"]["skillDetail"]): { title: string; description: string } {
  if (status === "green") return { title: t.checkPassed, description: t.checkPassedDescription };
  if (status === "yellow") return { title: t.checkWarning, description: t.checkWarningDescription };
  return { title: t.checkFailed, description: t.checkFailedDescription };
}

const SUGGEST_APPLICABLE: readonly string[] = ["examples", "allowed_capabilities", "instructions", "description"];

function canAdoptSuggestion(item: FixPlanItem): boolean {
  if (item.appliesTo === null || item.appliesTo === undefined) return false;
  if (!SUGGEST_APPLICABLE.includes(item.appliesTo)) return false;
  if (typeof item.suggestedContent !== "string" || item.suggestedContent.length === 0) return false;
  // 数组类字段（examples/allowed_capabilities/instructions）：LLM 返回空数组 "[]" 会清空字段 → 不显示采纳按钮。
  // 与 store.applyFixSuggestion 的空数组 422 纵深对齐；description 是标量，跳过 JSON 解析。
  if (item.appliesTo !== "description") {
    try {
      const parsed: unknown = JSON.parse(item.suggestedContent);
      if (!Array.isArray(parsed) || parsed.length === 0) return false;
    } catch {
      return false;
    }
  }
  return true;
}

function appliesToLabel(appliesTo: NonNullable<FixPlanItem["appliesTo"]>, sd: ReturnType<typeof useI18n>["t"]["skillDetail"]): string {
  switch (appliesTo) {
    case "examples": return sd.appliesToExamples;
    case "allowed_capabilities": return sd.appliesToAllowedCapabilities;
    case "instructions": return sd.appliesToInstructions;
    case "description": return sd.appliesToDescription;
    case "tags": return sd.appliesToTags;
  }
}

function AgentCheckPanel({
  api,
  slug,
  draft,
  onPublished,
  t
}: {
  api: HunterApi;
  slug: string;
  draft: DraftState | null;
  onPublished: () => void;
  t: ReturnType<typeof useI18n>["t"];
}) {
  const sd = t.skillDetail;
  const [checksResult, setChecksResult] = useState<SkillCheckResult | null>(draft?.checks ?? null);
  const [aiChecksResult, setAiChecksResult] = useState<SkillCheckResult | null>(draft?.aiChecks ?? null);
  const [aiChecking, setAiChecking] = useState(false);
  const [diffFiles, setDiffFiles] = useState<readonly SkillDiffFile[]>([]);
  const [diffRun, setDiffRun] = useState(false);
  const [selectedStatus, setSelectedStatus] = useState<"green" | "yellow" | "red" | "suggestions" | null>(null);
  const [selectedFile, setSelectedFile] = useState(0);
  const [checking, setChecking] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [publishVersion, setPublishVersion] = useState("");
  const [publishNote, setPublishNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [discarding, setDiscarding] = useState(false);
  const [pendingUpload, setPendingUpload] = useState<File[] | null>(null);
  const [fixPlan, setFixPlan] = useState<FixPlan | null>(null);
  const [fixing, setFixing] = useState(false);
  const [fixPreviewRun, setFixPreviewRun] = useState(false);
  const [fixCheckIds, setFixCheckIds] = useState<string[] | null>(null);
  const [generatingReleaseNote, setGeneratingReleaseNote] = useState(false);
  const [fixSuggestions, setFixSuggestions] = useState<FixPlan | null>(null);
  const [fixSuggestionRun, setFixSuggestionRun] = useState(false);
  const [adoptingSuggestion, setAdoptingSuggestion] = useState(false);

  useEffect(() => {
    setChecksResult(draft?.checks ?? null);
    setAiChecksResult(draft?.aiChecks ?? null);
  }, [draft]);

  const summary = {
    green: (checksResult?.summary.green ?? 0) + (aiChecksResult?.summary.green ?? 0),
    yellow: (checksResult?.summary.yellow ?? 0) + (aiChecksResult?.summary.yellow ?? 0),
    red: (checksResult?.summary.red ?? 0) + (aiChecksResult?.summary.red ?? 0)
  };
  const checks: readonly SkillCheckItem[] = [
    ...(checksResult?.items ?? []),
    ...(aiChecksResult?.items ?? [])
  ];
  const defaultPublishVersion = nextPatchVersion(draft?.draftVersion ?? undefined);
  const resolvedPublishVersion = publishVersion || defaultPublishVersion;
  const resolvedPublishNote = publishNote || sd.defaultPublishModalNote;
  const activeFile = diffFiles[selectedFile] ?? diffFiles[0];
  const stats = diffStats(diffFiles);
  const selectedChecks = selectedStatus === null
    ? checks
    : selectedStatus === "suggestions"
      ? checks.filter((check) => check.fixable)
      : checks.filter((check) => check.status === selectedStatus);
  const metricCards = [
    { key: "green" as const, count: summary.green, ...checkStatusCopy("green", sd) },
    { key: "yellow" as const, count: summary.yellow, ...checkStatusCopy("yellow", sd) },
    { key: "red" as const, count: summary.red, ...checkStatusCopy("red", sd) },
    { key: "suggestions" as const, count: checks.filter((c) => c.fixable).length, title: sd.fixSuggestions, description: sd.fixSuggestionsDescription }
  ];
  const publishedLines = (activeFile?.publishedContent ?? "").split("\n");
  const draftLines = (activeFile?.draftContent ?? "").split("\n");

  async function runChecks(): Promise<void> {
    setChecking(true);
    setError(null);
    try {
      const result = await required(api, "runSkillDraftChecks")(slug);
      setChecksResult(result);
    } catch (reason) { setError(apiError(reason, t)); }
    finally { setChecking(false); }
  }

  async function runAiChecks(): Promise<void> {
    setAiChecking(true);
    setError(null);
    try {
      const result = await required(api, "runSkillAiChecks")(slug);
      setAiChecksResult(result);
    } catch (reason) { setError(sd.aiCheckFailed + " " + apiError(reason, t)); }
    finally { setAiChecking(false); }
  }

  async function runDiff(): Promise<void> {
    setError(null);
    try {
      const files = await required(api, "diffSkillDraft")(slug);
      setDiffFiles(files);
      setSelectedFile(0);
      setDiffRun(true);
    } catch (reason) { setError(apiError(reason, t)); }
  }

  async function publish(): Promise<void> {
    setError(null);
    try {
      await required(api, "publishSkillDraft")(slug, { version: resolvedPublishVersion, releaseNote: resolvedPublishNote });
      setPublishing(false);
      setPublishVersion("");
      setPublishNote("");
      onPublished();
    } catch (reason) { setError(apiError(reason, t)); }
  }

  async function upload(files: File[]): Promise<void> {
    setError(null);
    try {
      await required(api, "uploadSkillDraft")(buildUploadFormData(files));
      onPublished();
    } catch (reason) { setError(apiError(reason, t)); }
  }

  async function discard(): Promise<void> {
    setError(null);
    try {
      await required(api, "discardSkillDraft")(slug, draft?.revision ?? 0);
      setDiscarding(false);
      onPublished();
    } catch (reason) { setError(apiError(reason, t)); }
  }

  async function confirmOverwrite(): Promise<void> {
    if (pendingUpload === null) return;
    const files = pendingUpload;
    setPendingUpload(null);
    await upload(files);
  }

  async function previewFix(checkIds: string[] | null): Promise<void> {
    setFixing(true);
    setError(null);
    try {
      const plan = await required(api, "previewSkillFix")(slug, checkIds);
      setFixPlan(plan);
      setFixCheckIds(checkIds);
      setFixPreviewRun(true);
    } catch (reason) { setError(apiError(reason, t)); }
    finally { setFixing(false); }
  }

  async function applyFix(checkIds: string[] | null): Promise<void> {
    setFixing(true);
    setError(null);
    try {
      await required(api, "applySkillFix")(slug, checkIds);
      setFixPlan(null);
      setFixPreviewRun(false);
      onPublished();
    } catch (reason) { setError(apiError(reason, t)); }
    finally { setFixing(false); }
  }

  async function aiGenerateReleaseNote(): Promise<void> {
    setGeneratingReleaseNote(true);
    setError(null);
    try {
      const result = await required(api, "generateReleaseNote")(slug);
      if (result.releaseNote === null || result.degraded === true) {
        setError(sd.aiGenerateFailed);
      } else {
        setPublishNote(result.releaseNote);
      }
    } catch {
      setError(sd.aiGenerateFailed);
    } finally {
      setGeneratingReleaseNote(false);
    }
  }

  async function fetchFixSuggestions(): Promise<void> {
    setFixSuggestionRun(true);
    setError(null);
    try {
      const plan = await required(api, "fetchFixSuggestions")(slug, null);
      setFixSuggestions(plan);
    } catch (reason) { setError(apiError(reason, t)); }
    finally { setFixSuggestionRun(false); }
  }

  async function adoptFixSuggestion(item: FixPlanItem): Promise<void> {
    setAdoptingSuggestion(true);
    setError(null);
    try {
      await required(api, "applyFixSuggestion")(slug, {
        checkId: item.checkId,
        suggestedContent: item.suggestedContent ?? "",
        appliesTo: item.appliesTo ?? null
      });
      setFixSuggestions(null);
      onPublished();
    } catch (reason) { setError(apiError(reason, t)); }
    finally { setAdoptingSuggestion(false); }
  }

  function onUploadChange(event: ChangeEvent<HTMLInputElement>): void {
    const files = event.target.files;
    if (files === null || files.length === 0) return;
    const list = Array.from(files);
    if (draft !== null) setPendingUpload(list);
    else void upload(list);
  }

  return <div className="check-publish-layout">
    <div className="publish-toolbar">
      <label className="upload-drop-strip">
        <input type="file" multiple accept=".zip" onChange={onUploadChange} {...{ webkitdirectory: "" }} />
        <strong>{sd.uploadSkillPackage}</strong>
        <span>{sd.uploadSkillPackageHint}</span>
      </label>
      <div className="publish-toolbar-actions">
        {draft === null ? null : <>
          <button type="button" className="secondary prominent-action" disabled={checking} onClick={() => void runChecks()}>{checking ? sd.checkRunning : sd.checkAction}</button>
          <button type="button" className="secondary prominent-action" disabled={aiChecking} onClick={() => void runAiChecks()}>{aiChecking ? sd.aiCheckRunning : sd.aiCheckAction}</button>
          {aiChecksResult !== null && aiChecksResult.items.length > 0 ? <span className="status">{sd.aiChecksLabel}</span> : null}
          <button type="button" className="secondary prominent-action" onClick={() => void runDiff()}>{sd.versionDiff}</button>
          <button type="button" className="secondary prominent-action" disabled={fixing} onClick={() => void previewFix(null)}>{sd.oneClickFix}</button>
          <button type="button" className="secondary prominent-action" disabled={fixSuggestionRun} onClick={() => void fetchFixSuggestions()}>{sd.aiFixSuggestion}</button>
          <button type="button" className={`prominent-action ${summary.red > 0 ? "danger" : ""}`} onClick={() => { setPublishVersion(defaultPublishVersion); setPublishNote(sd.defaultPublishModalNote); setPublishing(true); }}>{sd.publishAction}</button>
          <button type="button" className="secondary" onClick={() => setDiscarding(true)}>{sd.discardAction}</button>
          {summary.red > 0 ? <span className="publish-warning">{sd.redPublishWarning}</span> : null}
        </>}
      </div>
    </div>
    {draft === null ? <Empty>{sd.draftEmpty}</Empty> : <>
    <div className="check-metrics">
      {metricCards.map((metric) => <button type="button" className={`check-metric-card check-metric-${metric.key}`} key={metric.key} onClick={() => setSelectedStatus((cur) => cur === metric.key ? null : metric.key)}>
        <strong>{metric.count}</strong>
        <span>{metric.title}</span>
        <small>{metric.description}</small>
      </button>)}
    </div>
    {checks.length === 0 ? null : <div className="check-list">
      {selectedChecks.map((check) => <article className="check-row" key={check.id}>
        <CheckLight status={check.status} />
        <div><strong>{check.label}</strong><p>{check.message}</p>{check.filePath === null ? null : <code>{check.filePath}</code>}</div>
        {check.fixable ? <button type="button" className="secondary" disabled={fixing} onClick={() => void previewFix([check.id])}>{sd.applyFix}</button> : null}
      </article>)}
    </div>}
    {!fixPreviewRun || fixPlan === null ? null : fixPlan.items.length === 0 ? <Empty>{sd.fixEmpty}</Empty> : <div className="version-diff-workbench fix-preview-workbench">
      <aside className="version-file-tree">
        <div className="version-file-tree-title">{sd.fixPreview}</div>
        {fixPlan.items.map((item) => <div className="check-row" key={item.checkId}>
          <span className={`fix-action fix-action-${item.action}`}>{item.action}</span>
          <div><strong>{item.label}</strong><p>{item.message}</p>{item.riskDelta === null ? null : <small className="risk">{sd.riskDelta}: {item.riskDelta}</small>}</div>
        </div>)}
      </aside>
      <div className="version-diff-pane">
        <div className="diff-column-title"><span>{sd.currentPublishedVersion}</span></div>
        <pre>{(fixPlan.mergedFiles[0]?.publishedContent ?? "").split("\n").map((line, index) => <span className="diff-line diff-line-old" key={`fix-old-${index}`}>{line || " "}</span>)}</pre>
      </div>
      <div className="version-diff-pane">
        <div className="diff-column-title"><span>{sd.stagedDraftVersion}</span></div>
        <pre>{(fixPlan.mergedFiles[0]?.draftContent ?? "").split("\n").map((line, index) => <span className="diff-line diff-line-new" key={`fix-new-${index}`}>{line || " "}</span>)}</pre>
      </div>
      <div className="publish-modal-footer">
        <button type="button" disabled={fixing} onClick={() => void applyFix(fixCheckIds)}>{sd.applyFix}</button>
        <button type="button" className="secondary" onClick={() => { setFixPlan(null); setFixPreviewRun(false); }}>{sd.cancelEdit}</button>
      </div>
    </div>}
    {fixSuggestions === null ? null : fixSuggestions.items.length === 0 ? <Empty>{sd.fixEmpty}</Empty> : <div className="fix-suggestion-list">
      {fixSuggestions.items.map((item) => <article className="fix-suggestion-row" key={item.checkId}>
        <div><strong>{item.label}</strong><p>{item.message}</p></div>
        {item.suggestedContent === null || item.suggestedContent === undefined ? null : <div className="fix-suggestion-body">
          <pre>{item.suggestedContent}</pre>
          {item.explanation === null || item.explanation === undefined ? null : <p className="fix-suggestion-explanation"><span className="config-card-label">{sd.suggestionExplanation}</span> {item.explanation}</p>}
          {item.appliesTo === null || item.appliesTo === undefined ? null : <span className="fix-suggestion-target">{appliesToLabel(item.appliesTo, sd)}</span>}
          {canAdoptSuggestion(item) ? <button type="button" className="secondary" disabled={adoptingSuggestion} onClick={() => void adoptFixSuggestion(item)}>{sd.adoptSuggestion}</button> : null}
        </div>}
      </article>)}
    </div>}
    {!diffRun ? null : diffFiles.length === 0 ? <Empty>{sd.diffNoChange}</Empty> : <div className="version-diff-workbench">
      <aside className="version-file-tree">
        <div className="version-file-tree-title">{sd.changedFiles}</div>
        {diffFiles.map((file, index) => <button type="button" className={index === selectedFile ? "selected" : ""} key={file.path} onClick={() => setSelectedFile(index)}>
          <span className={`file-change-dot file-change-${file.status}`} />
          <span>{file.path}</span>
          <small>{sd.diffStatus[file.status]}</small>
        </button>)}
      </aside>
      <div className="version-diff-pane">
        <div className="diff-column-title"><span>{sd.currentPublishedVersion}</span></div>
        <pre>{publishedLines.map((line, index) => <span className={line !== (draftLines[index] ?? "") ? "diff-line diff-line-old" : "diff-line"} key={`old-${index}`}>{line || " "}</span>)}</pre>
      </div>
      <div className="version-diff-pane">
        <div className="diff-column-title"><span>{sd.stagedDraftVersion}</span></div>
        <pre>{draftLines.map((line, index) => <span className={line !== (publishedLines[index] ?? "") ? "diff-line diff-line-new" : "diff-line"} key={`new-${index}`}>{line || " "}</span>)}</pre>
      </div>
    </div>}
    </>}
    {!publishing ? null : <div className="modal-backdrop" role="presentation" onClick={() => setPublishing(false)}>
      <div className="publish-modal" role="dialog" aria-modal="true" aria-labelledby="publish-modal-title" onClick={(event) => event.stopPropagation()}>
        <div className="panel-title">
          <h2 id="publish-modal-title">{sd.publishConfirmTitle}</h2>
          <button type="button" className="icon-button" aria-label={sd.close} onClick={() => setPublishing(false)}>×</button>
        </div>
        <div className="publish-hero-grid">
          <article className="publish-version-card">
            <div className="publish-version-pair">
              <label className="version-stepper"><span>{sd.newVersion}</span><input value={resolvedPublishVersion} onChange={(event) => setPublishVersion(event.target.value)} /><span className="version-stepper-actions"><button type="button" aria-label={sd.increaseVersion} onClick={() => setPublishVersion(shiftPatchVersion(resolvedPublishVersion, 1))}>↑</button><button type="button" aria-label={sd.decreaseVersion} onClick={() => setPublishVersion(shiftPatchVersion(resolvedPublishVersion, -1))}>↓</button></span></label>
            </div>
          </article>
          <article className="publish-target-card"><span>{sd.publishTarget}</span><strong>{slug}</strong><small>{summary.red > 0 ? sd.publishHasWarnings : sd.publishReady}</small></article>
        </div>
        <div className="publish-summary-grid">
          <article className="summary-changed"><strong>{stats.changedFiles}</strong><span>{sd.changedFiles}</span></article>
          <article className="summary-modified"><strong>{stats.modifiedFiles}</strong><span>{sd.modifiedFiles}</span></article>
          <article className="summary-added"><strong>{stats.addedFiles}</strong><span>{sd.addedFiles}</span></article>
          <article className="summary-lines"><strong>{stats.changedLines}</strong><span>{sd.changedLines}</span></article>
        </div>
        <div className="publish-note-field">
          <div className="publish-note-heading">
            <span className="config-card-label">{sd.releaseNote}</span>
            <button type="button" className="secondary" disabled={generatingReleaseNote} onClick={() => void aiGenerateReleaseNote()}>{sd.aiGenerate}</button>
          </div>
          <label className="release-note-editor">
            <textarea value={resolvedPublishNote} onChange={(event) => setPublishNote(event.target.value)} aria-label={sd.releaseNote} />
          </label>
        </div>
        <div className="publish-modal-footer">
          <span>{sd.publishModalHint}</span>
          <div className="editable-card-actions">
            <button type="button" onClick={() => void publish()}>{sd.confirmPublish}</button>
            <button type="button" className="secondary" onClick={() => setPublishing(false)}>{sd.cancelEdit}</button>
          </div>
        </div>
      </div>
    </div>}
    {!discarding ? null : <div className="modal-backdrop" role="presentation" onClick={() => setDiscarding(false)}>
      <div className="publish-modal" role="dialog" aria-modal="true" aria-labelledby="discard-modal-title" onClick={(event) => event.stopPropagation()}>
        <div className="panel-title">
          <h2 id="discard-modal-title">{sd.discardAction}</h2>
          <button type="button" className="icon-button" aria-label={sd.close} onClick={() => setDiscarding(false)}>×</button>
        </div>
        <p>{sd.discardConfirm}</p>
        <div className="publish-modal-footer">
          <div className="editable-card-actions">
            <button type="button" onClick={() => void discard()}>{sd.confirmDiscard}</button>
            <button type="button" className="secondary" onClick={() => setDiscarding(false)}>{sd.cancelEdit}</button>
          </div>
        </div>
      </div>
    </div>}
    {pendingUpload === null ? null : <div className="modal-backdrop" role="presentation" onClick={() => setPendingUpload(null)}>
      <div className="publish-modal" role="dialog" aria-modal="true" aria-labelledby="overwrite-modal-title" onClick={(event) => event.stopPropagation()}>
        <div className="panel-title">
          <h2 id="overwrite-modal-title">{sd.overwriteConfirmTitle}</h2>
          <button type="button" className="icon-button" aria-label={sd.close} onClick={() => setPendingUpload(null)}>×</button>
        </div>
        <p>{sd.overwriteConfirm}</p>
        <div className="publish-modal-footer">
          <div className="editable-card-actions">
            <button type="button" onClick={() => void confirmOverwrite()}>{sd.overwriteConfirmAction}</button>
            <button type="button" className="secondary" onClick={() => setPendingUpload(null)}>{sd.cancelEdit}</button>
          </div>
        </div>
      </div>
    </div>}
    {error === null ? null : <div className="notice danger">{error}</div>}
  </div>;
}

function AgentConfigsOverview({ agents, t }: { agents: readonly AgentSkillConfig[]; t: ReturnType<typeof useI18n>["t"]["skillDetail"] }) {
  if (agents.length === 0) return <span className="muted-inline">{t.noneShort}</span>;
  return <article className="system-config-card system-config-card-wide">
    <span className="config-card-label">{t.adapters}</span>
    <div className="default-agent-actions">
      {agents.map((a) => (
        <span className={`config-chip config-chip-${a.enabled ? "enabled" : "disabled"}`} key={a.agent}>
          <span>{a.agent}</span>
          <small>{a.isDefault ? t.defaultAgent : a.enabled ? t.enabled : t.disabled}</small>
        </span>
      ))}
    </div>
  </article>;
}

function VersionHistoryPanel({
  versions,
  t
}: {
  versions: readonly RegistrySkillVersion[];
  t: ReturnType<typeof useI18n>["t"]["skillDetail"];
}) {
  const [selectedVersion, setSelectedVersion] = useState(versions[0]?.version ?? "");
  const [selectedVersionFile, setSelectedVersionFile] = useState(versions[0]?.sourceFiles[0]?.path ?? "");
  if (versions.length === 0) return <Empty>{t.noVersionHistory}</Empty>;
  const current = versions.find((v) => v.version === selectedVersion) ?? versions[0];
  if (current === undefined) return <Empty>{t.noVersionHistory}</Empty>;
  const sourceFiles = current.sourceFiles;
  const activeFile = sourceFiles.find((f) => f.path === selectedVersionFile) ?? sourceFiles[0];

  function selectVersion(version: string, firstFilePath: string): void {
    setSelectedVersion(version);
    setSelectedVersionFile(firstFilePath);
  }

  return <div className="version-history-workbench">
    <aside className="version-history-list">
      <div className="version-file-tree-title">{t.versionHistory}</div>
      {versions.map((v) => <button type="button" className={v.version === current.version ? "selected" : ""} key={v.version} onClick={() => selectVersion(v.version, v.sourceFiles[0]?.path ?? "")}>
        <strong>v{v.version}</strong>
        <span>{new Date(v.created_at).toLocaleString()}</span>
        <small>{v.source_proposal_id ?? "bootstrap"}</small>
      </button>)}
    </aside>
    <section className="version-history-main">
      <article className="release-note-card">
        <div className="editable-card-heading">
          <div><span className="config-card-label">{t.releaseNote}</span><h3>v{current.version}</h3></div>
          <small>{current.ir.version} · {current.artifacts.length} artifacts</small>
        </div>
        <p>{current.changeNote ?? t.defaultReleaseNote}</p>
      </article>
      {sourceFiles.length === 0 ? <Empty>{t.noVersionDiff}</Empty> : <div className="source-package-grid">
        <SourceFileTree files={sourceFiles} selectedPath={activeFile?.path ?? ""} onSelect={setSelectedVersionFile} />
        {activeFile === undefined ? null : <FilePreview key={activeFile.path} path={activeFile.path} content={activeFile.content} showRaw={t.showRaw} showRendered={t.showRendered} />}
      </div>}
      {current.examples.length === 0 ? null : <div className="usage-example-grid">
        {current.examples.map((example, index) => <article className="usage-example-card" key={example.title}>
          <span className="config-card-label">{t.exampleLabel.replace("{index}", String(index + 1).padStart(2, "0"))}</span>
          <h3>{example.title}</h3>
          <p>{example.description}</p>
        </article>)}
      </div>}
    </section>
  </div>;
}

export {
  AgentCheckPanel,
  AgentConfigsOverview,
  ContractSecurityOverview,
  SkillConfigOverview,
  VersionHistoryPanel
};
