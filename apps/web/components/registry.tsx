"use client";

import type {
  RegistryAgent,
  RegistrySkillDetail,
  RegistrySkillProposal,
  RegistrySkillVersion,
  RegistryTag,
  RegistryWorkflow,
  RegistryWorkflowMutation,
  SkillIr
} from "@hunter-harness/contracts";
import JSZip from "jszip";
import Link from "next/link";
import { type ChangeEvent, useEffect, useMemo, useState } from "react";
import { parse as parseYaml } from "yaml";

import { ApiClientError, browserApi, buildUploadFormData, type HunterApi } from "../lib/api";
import type { DemoAgent, DemoAgentConfig, DemoAgentDiffFile, DemoAgentVersion, DemoUsageExample } from "../lib/demo-skills/types";
import { findDemoSourceSkill } from "../lib/demo-skills/sap-field-mapper";
import { useI18n } from "../lib/i18n";
import { mockApi } from "../lib/mock-api";

function apiError(error: unknown, t: ReturnType<typeof useI18n>["t"]): string {
  if (process.env.NEXT_PUBLIC_HUNTER_HARNESS_DEMO === "true" && error instanceof Error) {
    return t.error.demoFailed + error.message;
  }
  if (error instanceof ApiClientError && error.status === 401) {
    return t.error.authRequiredSettings;
  }
  if (error instanceof ApiClientError) return t.error.apiFailed.replace("{code}", error.code);
  return t.error.opFailed;
}

function required<K extends keyof HunterApi>(api: HunterApi, key: K): NonNullable<HunterApi[K]> {
  const method = api[key];
  if (typeof method !== "function") throw new Error(`API capability ${String(key)} is unavailable`);
  return method.bind(api) as NonNullable<HunterApi[K]>;
}

function useApi(value?: HunterApi): HunterApi {
  return useMemo(() => value ?? (
    process.env.NEXT_PUBLIC_HUNTER_HARNESS_DEMO === "true" ? mockApi : browserApi()
  ), [value]);
}

function Status({ value }: { value: string }) {
  return <span className={`status status-${value.replaceAll("_", "-")}`}>{value.replaceAll("_", " ")}</span>;
}

function Empty({ children }: { children: React.ReactNode }) {
  return <div className="empty-state">{children}</div>;
}

function displayValue(value: string, t: ReturnType<typeof useI18n>["t"]["skillDetail"]): string {
  const labels: Record<string, string> = t.valueLabels;
  return labels[value] ?? value;
}

function tagSlug(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function skillStatusGroup(status: RegistrySkillDetail["status"]): "published" | "unpublished" {
  return status === "published" ? "published" : "unpublished";
}

function skillStatusLabel(status: RegistrySkillDetail["status"], t: ReturnType<typeof useI18n>["t"]["skills"]): string {
  return skillStatusGroup(status) === "published" ? t.statusPublished : t.statusUnpublished;
}

function chipTone(value: string, index: number): string {
  const normalized = tagSlug(value);
  if (["read", "source", "input", "inputs"].includes(normalized)) return "blue";
  if (["search", "triggers", "trigger"].includes(normalized)) return "purple";
  if (["write", "output", "outputs"].includes(normalized)) return "green";
  if (["network-api", "network", "api", "tooling"].includes(normalized)) return "amber";
  if (["forbidden", "danger", "delete", "exec"].includes(normalized)) return "rose";
  const tones = ["blue", "purple", "green", "amber", "rose"];
  return tones[index % tones.length] ?? "blue";
}

function ValueChips({ values, empty, t }: { values: string[] | undefined; empty: string; t?: ReturnType<typeof useI18n>["t"]["skillDetail"] }) {
  if (values === undefined || values.length === 0) return <span className="muted-inline">{empty}</span>;
  return <span className="config-chip-row">{values.map((value, index) => (
    <span className={`config-chip config-chip-tone-${chipTone(value, index)}`} key={value}>{t === undefined ? value : displayValue(value, t)}</span>
  ))}</span>;
}

function EnabledTargets({
  targets,
  empty,
  enabledLabel,
  disabledLabel,
  labelFor
}: {
  targets: SkillIr["adapters"];
  empty: string;
  enabledLabel: string;
  disabledLabel: string;
  labelFor?: (name: string) => string;
}) {
  const entries = Object.entries(targets);
  if (entries.length === 0) return <span className="muted-inline">{empty}</span>;
  return <span className="config-chip-row">{entries.map(([name, config]) => (
    <span className={`config-chip config-chip-${config.enabled ? "enabled" : "disabled"}`} key={name}>
      <span>{labelFor?.(name) ?? name}</span>
      <small>{config.enabled ? enabledLabel : disabledLabel}</small>
    </span>
  ))}</span>;
}

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

function isMarkdownFile(path: string): boolean {
  return /\.md(?:own)?$/i.test(path);
}

function renderInlineMarkdown(value: string, keyPrefix: string): React.ReactNode {
  const tokens = value.split(/(`[^`]+`|\*\*[^*]+\*\*|\[[^\]]+\]\([^\s)]+\)|\*[^*]+\*)/g);
  return tokens.map((token, index) => {
    const key = `${keyPrefix}-${index}`;
    if (token.startsWith("`") && token.endsWith("`")) return <code key={key}>{token.slice(1, -1)}</code>;
    if (token.startsWith("**") && token.endsWith("**")) return <strong key={key}>{token.slice(2, -2)}</strong>;
    if (token.startsWith("*") && token.endsWith("*")) return <em key={key}>{token.slice(1, -1)}</em>;
    const link = token.match(/^\[([^\]]+)\]\(([^\s)]+)\)$/);
    if (link !== null) return <a key={key} href={link[2] ?? "#"} target="_blank" rel="noreferrer">{link[1] ?? ""}</a>;
    return <span key={key}>{token}</span>;
  });
}

function tableCells(line: string): string[] {
  return line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim());
}

function MarkdownDocument({ content }: { content: string }) {
  const lines = content.replace(/^---\s*\r?\n[\s\S]*?\r?\n---\s*(?:\r?\n|$)/, "").split(/\r?\n/);
  const blocks: React.ReactNode[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index] ?? "";
    if (line.trim() === "") { index += 1; continue; }
    const fence = line.match(/^```([^\s]*)/);
    if (fence !== null) {
      const code: string[] = [];
      index += 1;
      while (index < lines.length && !(lines[index] ?? "").startsWith("```")) code.push(lines[index++] ?? "");
      if (index < lines.length) index += 1;
      blocks.push(<pre className="markdown-code" key={`code-${blocks.length}`}><code>{code.join("\n")}</code></pre>);
      continue;
    }
    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading !== null) {
      const key = `heading-${blocks.length}`;
      const headingLevel = heading[1] ?? "";
      const headingContent = renderInlineMarkdown(heading[2] ?? "", key);
      blocks.push(headingLevel.length === 1 ? <h1 key={key}>{headingContent}</h1>
        : headingLevel.length === 2 ? <h2 key={key}>{headingContent}</h2>
          : headingLevel.length === 3 ? <h3 key={key}>{headingContent}</h3>
            : <h4 key={key}>{headingContent}</h4>);
      index += 1;
      continue;
    }
    if (/^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/.test(line)) { blocks.push(<hr key={`rule-${blocks.length}`} />); index += 1; continue; }
    if (line.startsWith("> ")) {
      const quote: string[] = [];
      while (index < lines.length && (lines[index] ?? "").startsWith("> ")) quote.push((lines[index++] ?? "").slice(2));
      blocks.push(<blockquote key={`quote-${blocks.length}`}>{renderInlineMarkdown(quote.join(" "), `quote-${blocks.length}`)}</blockquote>);
      continue;
    }
    if (line.includes("|") && index + 1 < lines.length && /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(lines[index + 1] ?? "")) {
      const header = tableCells(line); index += 2;
      const rows: string[][] = [];
      while (index < lines.length && (lines[index] ?? "").includes("|") && (lines[index] ?? "").trim() !== "") rows.push(tableCells(lines[index++] ?? ""));
      blocks.push(<div className="markdown-table-wrap" key={`table-${blocks.length}`}><table><thead><tr>{header.map((cell, cellIndex) => <th key={cellIndex}>{renderInlineMarkdown(cell, `head-${cellIndex}`)}</th>)}</tr></thead><tbody>{rows.map((row, rowIndex) => <tr key={rowIndex}>{header.map((_, cellIndex) => <td key={cellIndex}>{renderInlineMarkdown(row[cellIndex] ?? "", `cell-${rowIndex}-${cellIndex}`)}</td>)}</tr>)}</tbody></table></div>);
      continue;
    }
    const list = line.match(/^\s*([-+*]|\d+\.)\s+(.+)$/);
    if (list !== null) {
      const ordered = /\d+\./.test(list[1] ?? ""); const items: string[] = [];
      while (index < lines.length) {
        const item = (lines[index] ?? "").match(/^\s*([-+*]|\d+\.)\s+(.+)$/);
        if (item === null || /\d+\./.test(item[1] ?? "") !== ordered) break;
        items.push(item[2] ?? ""); index += 1;
      }
      const List = ordered ? "ol" : "ul";
      blocks.push(<List key={`list-${blocks.length}`}>{items.map((item, itemIndex) => <li key={itemIndex}>{renderInlineMarkdown(item, `list-${itemIndex}`)}</li>)}</List>);
      continue;
    }
    const paragraph: string[] = [];
    while (index < lines.length && (lines[index] ?? "").trim() !== "" && !/^(#{1,6})\s+|^```|^> |^\s*([-+*]|\d+\.)\s+/.test(lines[index] ?? "")) paragraph.push(lines[index++] ?? "");
    blocks.push(<p key={`paragraph-${blocks.length}`}>{renderInlineMarkdown(paragraph.join(" "), `paragraph-${blocks.length}`)}</p>);
  }
  return <div className="markdown-document">{blocks}</div>;
}

function FilePreview({ path, content, showRaw, showRendered }: { path: string; content: string; showRaw: string; showRendered: string }) {
  const [raw, setRaw] = useState(false);
  if (!isMarkdownFile(path)) return <pre className="code-view">{content}</pre>;
  return <div className="file-preview">
    {raw ? <pre className="code-view">{content}</pre> : <MarkdownDocument content={content} />}
    <button type="button" className="preview-toggle" onClick={() => setRaw((value) => !value)}>{raw ? showRendered : showRaw}</button>
  </div>;
}

type SkillDetailTab = "source" | "examples" | "definition" | "checks" | "versions" | "governance";

const detailAgents: Array<{ value: DemoAgent; label: string }> = [
  { value: "claude-code", label: "Claude Code" },
  { value: "cursor", label: "Cursor" },
  { value: "codex", label: "Codex" },
  { value: "generic", label: "Generic Markdown" },
  { value: "mcp", label: "MCP" }
];

function agentLabel(agent: DemoAgent): string {
  return detailAgents.find((item) => item.value === agent)?.label ?? agent;
}

function isRegistryAgent(agent: DemoAgent): agent is RegistryAgent {
  return agent === "claude-code" || agent === "codex" || agent === "generic" || agent === "mcp";
}

function DemoSystemConfig({
  agents,
  currentAgent,
  defaultAgent,
  onSetDefault,
  t
}: {
  agents: readonly DemoAgentConfig[];
  currentAgent: DemoAgentConfig | undefined;
  defaultAgent: DemoAgent;
  onSetDefault: (agent: DemoAgent) => void;
  t: ReturnType<typeof useI18n>["t"]["skillDetail"];
}) {
  const configuredAgents = agents.filter((item) => item.configured);
  const defaultConfig = agents.find((item) => item.agent === defaultAgent);
  return <article className="system-config-card system-config-card-wide">
    <span className="config-card-label">{t.defaultAgent}</span>
    <div className="default-agent-heading">
      <div>
        <h3>{defaultConfig?.label ?? agentLabel(defaultAgent)}</h3>
        <p>{t.defaultAgentDescription}</p>
      </div>
      {defaultConfig === undefined ? null : <Status value="default" />}
    </div>
    <dl>
      <dt>{t.currentAgent}</dt>
      <dd>{currentAgent?.label ?? agentLabel(defaultAgent)} · {currentAgent?.configured ? t.currentAgentConfigured : t.currentAgentFallback}</dd>
    </dl>
    <div className="default-agent-actions">
      {configuredAgents.map((item) => item.agent === defaultAgent
        ? <span className="config-chip config-chip-enabled" key={item.agent}>{item.label}<small>{t.defaultAgent}</small></span>
        : <button type="button" className="secondary" key={item.agent} onClick={() => onSetDefault(item.agent)}>{t.setDefault} · {item.label}</button>)}
    </div>
  </article>;
}

function UsageExamples({ examples, t }: { examples: readonly DemoUsageExample[]; t: ReturnType<typeof useI18n>["t"]["skillDetail"] }) {
  if (examples.length === 0) return <Empty>{t.noUsageExamples}</Empty>;
  return <div className="usage-example-grid">
    {examples.map((example, index) => <article className="usage-example-card" key={example.title}>
      <span className="config-card-label">{t.exampleLabel.replace("{index}", String(index + 1).padStart(2, "0"))}</span>
      <h3>{example.title}</h3>
      <p>{example.description}</p>
      <div className="usage-example-block"><strong>{t.exampleRequest}</strong><code>{example.request}</code></div>
      <div className="usage-example-block"><strong>{t.exampleResult}</strong><span>{example.result}</span></div>
      {example.files === undefined || example.files.length === 0 ? null : <div className="config-chip-row">{example.files.map((file) => <code className="config-chip" key={file}>{file}</code>)}</div>}
    </article>)}
  </div>;
}

function CheckLight({ status }: { status: "green" | "yellow" | "red" }) {
  return <span className={`check-light check-light-${status}`} aria-label={status} />;
}

function checkStatusCopy(status: "green" | "yellow" | "red", t: ReturnType<typeof useI18n>["t"]["skillDetail"]): { title: string; description: string } {
  if (status === "green") return { title: t.checkPassed, description: t.checkPassedDescription };
  if (status === "yellow") return { title: t.checkWarning, description: t.checkWarningDescription };
  return { title: t.checkFailed, description: t.checkFailedDescription };
}

function AgentVersionCard({ title, version, empty }: { title: string; version: DemoAgentVersion | undefined; empty: string }) {
  if (version === undefined) return <article className="version-summary-card empty"><span>{title}</span><p>{empty}</p></article>;
  return <article className="version-summary-card">
    <span>{title}</span>
    <strong>{version.version}</strong>
    <small>{version.fileCount} files · {new Date(version.releasedAt).toLocaleString()}</small>
  </article>;
}

function nextPatchVersion(version: string | undefined): string {
  const match = version?.match(/^(\d+)\.(\d+)\.(\d+)/);
  if (match === undefined || match === null) return "1.0.1";
  return `${match[1]}.${match[2]}.${Number(match[3]) + 1}`;
}

function shiftPatchVersion(version: string, delta: number): string {
  const match = version.match(/^(\d+)\.(\d+)\.(\d+)/);
  if (match === null) return version;
  return `${match[1]}.${match[2]}.${Math.max(0, Number(match[3]) + delta)}`;
}

function diffStats(files: readonly DemoAgentDiffFile[]): { changedFiles: number; addedFiles: number; modifiedFiles: number; removedFiles: number; changedLines: number } {
  return files.reduce((stats, file) => {
    const published = file.publishedContent.split("\n");
    const draft = file.draftContent.split("\n");
    const max = Math.max(published.length, draft.length);
    let changedLines = 0;
    for (let index = 0; index < max; index += 1) {
      if ((published[index] ?? "") !== (draft[index] ?? "")) changedLines += 1;
    }
    return {
      changedFiles: stats.changedFiles + 1,
      addedFiles: stats.addedFiles + (file.status === "added" ? 1 : 0),
      modifiedFiles: stats.modifiedFiles + (file.status === "modified" ? 1 : 0),
      removedFiles: stats.removedFiles + (file.status === "removed" ? 1 : 0),
      changedLines: stats.changedLines + changedLines
    };
  }, { changedFiles: 0, addedFiles: 0, modifiedFiles: 0, removedFiles: 0, changedLines: 0 });
}

function AgentCheckPanel({
  agent,
  fallbackAgent,
  t
}: {
  agent: DemoAgentConfig | undefined;
  fallbackAgent: DemoAgentConfig | undefined;
  t: ReturnType<typeof useI18n>["t"]["skillDetail"];
}) {
  const value = agent ?? fallbackAgent;
  const [selectedStatus, setSelectedStatus] = useState<"green" | "yellow" | "red" | "suggestions" | null>(null);
  const [selectedFile, setSelectedFile] = useState(0);
  const [checking, setChecking] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [publishVersion, setPublishVersion] = useState("");
  const [publishNote, setPublishNote] = useState("");
  if (value === undefined) return <Empty>{t.notAvailable}</Empty>;
  const diffFiles: readonly DemoAgentDiffFile[] = value.diffFiles ?? [];
  const stats = diffStats(diffFiles);
  const defaultPublishVersion = nextPatchVersion(value.latestVersion?.version);
  const resolvedPublishVersion = publishVersion || defaultPublishVersion;
  const resolvedPublishNote = publishNote || t.defaultPublishModalNote;
  const activeFile = diffFiles[selectedFile] ?? diffFiles[0];
  const selectedChecks = selectedStatus === null || selectedStatus === "suggestions"
    ? value.checks
    : value.checks.filter((check) => check.status === selectedStatus);
  const metricCards = [
    { key: "green" as const, count: value.metrics.green, ...checkStatusCopy("green", t) },
    { key: "yellow" as const, count: value.metrics.yellow, ...checkStatusCopy("yellow", t) },
    { key: "red" as const, count: value.metrics.red, ...checkStatusCopy("red", t) },
    { key: "suggestions" as const, count: value.metrics.suggestions, title: t.fixSuggestions, description: t.fixSuggestionsDescription }
  ];
  const publishedLines = activeFile?.publishedContent.split("\n") ?? [];
  const draftLines = activeFile?.draftContent.split("\n") ?? [];
  return <div className="check-publish-layout">
    <div className="publish-toolbar">
      <label className="upload-drop-strip">
        <input type="file" multiple accept=".zip" {...{ webkitdirectory: "" }} />
        <strong>{t.uploadSkillPackage}</strong>
        <span>{t.uploadSkillPackageHint}</span>
      </label>
      <div className="publish-toolbar-actions">
        <button type="button" className="secondary prominent-action" onClick={() => setChecking(true)}>{t.checkAction}</button>
        <button type="button" className={`prominent-action ${value.metrics.red > 0 ? "danger" : ""}`} onClick={() => { setPublishVersion(defaultPublishVersion); setPublishNote(t.defaultPublishModalNote); setPublishing(true); }}>{t.publishAction}</button>
        {value.metrics.red > 0 ? <span className="publish-warning">{t.redPublishWarning}</span> : null}
      </div>
    </div>
    <div className="check-metrics">
      {metricCards.map((metric) => <button type="button" className={`check-metric-card check-metric-${metric.key}`} key={metric.key} onClick={() => setSelectedStatus(metric.key)}>
        <strong>{metric.count}</strong>
        <span>{metric.title}</span>
        <small>{metric.description}</small>
      </button>)}
    </div>
    <div className="agent-version-row">
      <AgentVersionCard title={t.currentPublishedVersion} version={value.latestVersion} empty={t.noAgentVersion} />
      <AgentVersionCard title={t.stagedDraftVersion} version={value.draftVersion} empty={t.noDraftVersion} />
    </div>
    {activeFile === undefined ? <Empty>{t.noVersionDiff}</Empty> : <div className="version-diff-workbench">
      <aside className="version-file-tree">
        <div className="version-file-tree-title">{t.changedFiles}</div>
        {diffFiles.map((file, index) => <button type="button" className={index === selectedFile ? "selected" : ""} key={file.path} onClick={() => setSelectedFile(index)}>
          <span className={`file-change-dot file-change-${file.status}`} />
          <span>{file.path}</span>
          <small>{t.diffStatus[file.status]}</small>
        </button>)}
      </aside>
      <div className="version-diff-pane">
        <div className="diff-column-title"><span>{t.currentPublishedVersion}</span><code>{value.latestVersion?.version ?? "-"}</code></div>
        <pre>{publishedLines.map((line, index) => <span className={line !== (draftLines[index] ?? "") ? "diff-line diff-line-old" : "diff-line"} key={`old-${index}`}>{line || " "}</span>)}</pre>
      </div>
      <div className="version-diff-pane">
        <div className="diff-column-title"><span>{t.stagedDraftVersion}</span><code>{value.draftVersion?.version ?? "-"}</code></div>
        <pre>{draftLines.map((line, index) => <span className={line !== (publishedLines[index] ?? "") ? "diff-line diff-line-new" : "diff-line"} key={`new-${index}`}>{line || " "}</span>)}</pre>
      </div>
    </div>}
    {selectedStatus === null ? null : <div className="modal-backdrop" role="presentation" onClick={() => setSelectedStatus(null)}>
      <div className="check-result-modal" role="dialog" aria-modal="true" aria-labelledby="check-result-title" onClick={(event) => event.stopPropagation()}>
        <div className="panel-title">
          <h2 id="check-result-title">{selectedStatus === "suggestions" ? t.fixSuggestions : checkStatusCopy(selectedStatus, t).title}</h2>
          <button type="button" className="icon-button" aria-label={t.close} onClick={() => setSelectedStatus(null)}>×</button>
        </div>
        <div className="check-list">
          {selectedChecks.map((check) => <article className="check-row" key={check.id}>
            <CheckLight status={check.status} />
            <div><strong>{check.label}</strong><p>{check.message}</p>{check.filePath === undefined ? null : <code>{check.filePath}</code>}</div>
            {check.fixable ? <button type="button" className="secondary">{t.applyFix}</button> : null}
          </article>)}
        </div>
      </div>
    </div>}
    {!checking ? null : <div className="modal-backdrop" role="presentation" onClick={() => setChecking(false)}>
      <div className="check-confirm-modal" role="dialog" aria-modal="true" aria-labelledby="check-confirm-title" onClick={(event) => event.stopPropagation()}>
        <div className="panel-title">
          <h2 id="check-confirm-title">{t.checkConfirmTitle}</h2>
          <button type="button" className="icon-button" aria-label={t.close} onClick={() => setChecking(false)}>×</button>
        </div>
        <p>{t.checkConfirmDescription}</p>
        <div className="check-scope-grid">
          <article><CheckLight status="green" /><span>{t.checkScopeStructure}</span></article>
          <article><CheckLight status="yellow" /><span>{t.checkScopeCompatibility}</span></article>
          <article><CheckLight status="yellow" /><span>{t.checkScopeSecrets}</span></article>
          <article><CheckLight status="red" /><span>{t.checkScopePublish}</span></article>
        </div>
        <div className="editable-card-actions">
          <button type="button" onClick={() => setChecking(false)}>{t.confirmCheck}</button>
          <button type="button" className="secondary" onClick={() => setChecking(false)}>{t.cancelEdit}</button>
        </div>
      </div>
    </div>}
    {!publishing ? null : <div className="modal-backdrop" role="presentation" onClick={() => setPublishing(false)}>
      <div className="publish-modal" role="dialog" aria-modal="true" aria-labelledby="publish-modal-title" onClick={(event) => event.stopPropagation()}>
        <div className="panel-title">
          <h2 id="publish-modal-title">{t.publishConfirmTitle}</h2>
          <button type="button" className="icon-button" aria-label={t.close} onClick={() => setPublishing(false)}>×</button>
        </div>
        <div className="publish-hero-grid">
          <article className="publish-version-card">
            <div className="publish-version-pair">
              <div className="version-readonly"><span>{t.currentVersion}</span><strong>{value.latestVersion?.version ?? "-"}</strong></div>
              <span className="version-arrow">→</span>
              <label className="version-stepper"><span>{t.newVersion}</span><input value={resolvedPublishVersion} onChange={(event) => setPublishVersion(event.target.value)} /><span className="version-stepper-actions"><button type="button" aria-label={t.increaseVersion} onClick={() => setPublishVersion(shiftPatchVersion(resolvedPublishVersion, 1))}>↑</button><button type="button" aria-label={t.decreaseVersion} onClick={() => setPublishVersion(shiftPatchVersion(resolvedPublishVersion, -1))}>↓</button></span></label>
            </div>
          </article>
          <article className="publish-target-card"><span>{t.publishTarget}</span><strong>{value.label}</strong><small>{value.metrics.red > 0 ? t.publishHasWarnings : t.publishReady}</small></article>
        </div>
        <div className="publish-summary-grid">
          <article className="summary-changed"><strong>{stats.changedFiles}</strong><span>{t.changedFiles}</span></article>
          <article className="summary-modified"><strong>{stats.modifiedFiles}</strong><span>{t.modifiedFiles}</span></article>
          <article className="summary-added"><strong>{stats.addedFiles}</strong><span>{t.addedFiles}</span></article>
          <article className="summary-lines"><strong>{stats.changedLines}</strong><span>{t.changedLines}</span></article>
        </div>
        <label className="release-note-editor publish-note-field">
          <span className="publish-note-heading"><span className="config-card-label">{t.releaseNote}</span><button type="button" className="secondary" onClick={() => setPublishNote(t.aiPublishModalNote)}>{t.aiGenerate}</button></span>
          <textarea value={resolvedPublishNote} onChange={(event) => setPublishNote(event.target.value)} />
        </label>
        <div className="publish-modal-footer">
          <span>{t.publishModalHint}</span>
          <div className="editable-card-actions">
          <button type="button" onClick={() => setPublishing(false)}>{t.confirmPublish}</button>
          <button type="button" className="secondary" onClick={() => setPublishing(false)}>{t.cancelEdit}</button>
          </div>
        </div>
      </div>
    </div>}
  </div>;
}

interface VersionDisplayItem {
  version: string;
  createdAt: string;
  source: string;
  ir: SkillIr;
  changeNote: string;
}

function previousIrFor(current: SkillIr): SkillIr {
  return {
    ...current,
    version: "1.1.0",
    description: current.description.replace("entity-class mapping tables", "entity mapping tables"),
    forbidden_actions: current.forbidden_actions.filter((item) => item !== "discard_unmatched_fields"),
    instructions: current.instructions?.slice(0, Math.max(1, current.instructions.length - 1))
  };
}

function versionDiffFiles(current: VersionDisplayItem, previous: VersionDisplayItem | undefined): readonly DemoAgentDiffFile[] {
  const prior = previous?.ir;
  if (prior === undefined) {
    return [{
      path: "skill-ir.json",
      status: "added",
      publishedContent: "",
      draftContent: JSON.stringify(current.ir, null, 2)
    }];
  }
  return [
    {
      path: "skill-ir/basic-info.json",
      status: "modified",
      publishedContent: JSON.stringify({ name: prior.name, kind: prior.kind, description: prior.description, version: prior.version }, null, 2),
      draftContent: JSON.stringify({ name: current.ir.name, kind: current.ir.kind, description: current.ir.description, version: current.ir.version }, null, 2)
    },
    {
      path: "skill-ir/instructions.json",
      status: "modified",
      publishedContent: JSON.stringify(prior.instructions ?? [], null, 2),
      draftContent: JSON.stringify(current.ir.instructions ?? [], null, 2)
    },
    {
      path: "skill-ir/security-boundary.json",
      status: "modified",
      publishedContent: JSON.stringify({ forbidden_actions: prior.forbidden_actions, required_context: prior.required_context }, null, 2),
      draftContent: JSON.stringify({ forbidden_actions: current.ir.forbidden_actions, required_context: current.ir.required_context }, null, 2)
    }
  ];
}

function VersionHistoryPanel({
  versions,
  currentSkill,
  t
}: {
  versions: readonly RegistrySkillVersion[];
  currentSkill: RegistrySkillDetail;
  t: ReturnType<typeof useI18n>["t"]["skillDetail"];
}) {
  const currentIr = currentSkill.ir;
  const [selectedVersion, setSelectedVersion] = useState(currentSkill.latest_version ?? versions[0]?.version ?? "1.0.0");
  const [selectedFile, setSelectedFile] = useState(0);
  if (currentIr === null) return <Empty>{t.notAvailable}</Empty>;

  const fallbackPrevious = previousIrFor(currentIr);
  const displayVersions: VersionDisplayItem[] = [
    {
      version: currentSkill.latest_version ?? currentIr.version,
      createdAt: currentSkill.updated_at,
      source: "release",
      ir: currentIr,
      changeNote: t.defaultReleaseNote
    },
    ...versions
      .filter((version) => version.version !== currentSkill.latest_version)
      .map((version) => ({
        version: version.version,
        createdAt: version.created_at,
        source: version.source_proposal_id ?? "bootstrap",
        ir: version.ir,
        changeNote: t.defaultReleaseNote
      })),
    {
      version: fallbackPrevious.version,
      createdAt: "2026-06-24T12:00:00Z",
      source: "previous",
      ir: fallbackPrevious,
      changeNote: t.previousReleaseNote
    }
  ];
  const selectedIndex = Math.max(0, displayVersions.findIndex((version) => version.version === selectedVersion));
  const current = displayVersions[selectedIndex] ?? displayVersions[0];
  const previous = displayVersions[selectedIndex + 1];
  const files = current === undefined ? [] : versionDiffFiles(current, previous);
  const activeFile = files[selectedFile] ?? files[0];
  const publishedLines = activeFile?.publishedContent.split("\n") ?? [];
  const draftLines = activeFile?.draftContent.split("\n") ?? [];

  if (current === undefined) return <Empty>{t.noVersionHistory}</Empty>;
  return <div className="version-history-workbench">
    <aside className="version-history-list">
      <div className="version-file-tree-title">{t.versionHistory}</div>
      {displayVersions.map((version) => <button type="button" className={version.version === current.version ? "selected" : ""} key={version.version} onClick={() => { setSelectedVersion(version.version); setSelectedFile(0); }}>
        <strong>v{version.version}</strong>
        <span>{new Date(version.createdAt).toLocaleString()}</span>
        <small>{version.source}</small>
      </button>)}
    </aside>
    <section className="version-history-main">
      <article className="release-note-card">
        <div className="editable-card-heading">
          <div><span className="config-card-label">{t.releaseNote}</span><h3>v{current.version}</h3></div>
        </div>
        <p>{current.changeNote}</p>
      </article>
      <div className="version-diff-workbench">
        <aside className="version-file-tree">
          <div className="version-file-tree-title">{t.changedFiles}</div>
          {files.map((file, index) => <button type="button" className={index === selectedFile ? "selected" : ""} key={file.path} onClick={() => setSelectedFile(index)}>
            <span className={`file-change-dot file-change-${file.status}`} />
            <span>{file.path}</span>
            <small>{t.diffStatus[file.status]}</small>
          </button>)}
        </aside>
        <div className="version-diff-pane">
          <div className="diff-column-title"><span>{t.previousVersion}</span><code>{previous === undefined ? "-" : `v${previous.version}`}</code></div>
          <pre>{publishedLines.map((line, index) => <span className={line !== (draftLines[index] ?? "") ? "diff-line diff-line-old" : "diff-line"} key={`old-${index}`}>{line || " "}</span>)}</pre>
        </div>
        <div className="version-diff-pane">
          <div className="diff-column-title"><span>{t.selectedVersion}</span><code>v{current.version}</code></div>
          <pre>{draftLines.map((line, index) => <span className={line !== (publishedLines[index] ?? "") ? "diff-line diff-line-new" : "diff-line"} key={`new-${index}`}>{line || " "}</span>)}</pre>
        </div>
      </div>
    </section>
  </div>;
}

interface SourceTreeNode {
  files: string[];
  directories: Map<string, SourceTreeNode>;
}

function SourceFileTree({
  files,
  selectedPath,
  onSelect
}: {
  files: readonly { path: string }[];
  selectedPath: string;
  onSelect: (path: string) => void;
}) {
  const root: SourceTreeNode = { files: [], directories: new Map() };
  for (const file of files) {
    const segments = file.path.split("/");
    const name = segments.pop();
    if (name === undefined) continue;
    let node = root;
    for (const segment of segments) {
      let child = node.directories.get(segment);
      if (child === undefined) {
        child = { files: [], directories: new Map() };
        node.directories.set(segment, child);
      }
      node = child;
    }
    node.files.push(name);
  }

  function renderNode(node: SourceTreeNode, prefix: string): React.ReactNode {
    return <>
      {[...node.files].sort((left, right) => {
        if (left === "SKILL.md") return -1;
        if (right === "SKILL.md") return 1;
        return left.localeCompare(right);
      }).map((name) => {
        const path = prefix === "" ? name : `${prefix}/${name}`;
        return <button type="button" role="treeitem" key={path} className={path === selectedPath ? "selected" : ""} onClick={() => onSelect(path)}>{name}</button>;
      })}
      {[...node.directories.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([name, child]) => {
        const nextPrefix = prefix === "" ? name : `${prefix}/${name}`;
        return <details className="source-tree-directory" open key={nextPrefix}>
          <summary>{name}</summary>
          <div className="source-tree-children">{renderNode(child, nextPrefix)}</div>
        </details>;
      })}
    </>;
  }

  return <div className="source-file-tree" role="tree">{renderNode(root, "")}</div>;
}

const SKILL_IR_ENTRY_PATTERN = /(^|\/)(skill\.ya?ml|skill\.json|hunter-skill-ir\.json)$/i;

async function parseSkillFile(input: File | FileList | File[]): Promise<{ ir: SkillIr; sourceName: string }> {
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
      !item.dir && SKILL_IR_ENTRY_PATTERN.test(item.name) && !item.name.includes("..")
    );
    if (entry === undefined) throw new Error("ZIP: skill IR not found");
    const content = await entry.async("text");
    const ir = entry.name.toLowerCase().endsWith(".json") ? JSON.parse(content) : parseYaml(content);
    return { ir: ir as SkillIr, sourceName: first.name };
  }

  const folderEntry = files
    .map((file) => ({ file, path: (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name }))
    .filter(({ path }) => SKILL_IR_ENTRY_PATTERN.test(path) && !path.includes(".."))
    .sort((left, right) => left.path.split("/").length - right.path.split("/").length)[0];
  if (folderEntry === undefined) throw new Error("Folder: skill IR not found");
  const content = await folderEntry.file.text();
  const ir = folderEntry.path.toLowerCase().endsWith(".json") ? JSON.parse(content) : parseYaml(content);
  const rootName = folderEntry.path.includes("/") ? (folderEntry.path.split("/")[0] ?? folderEntry.file.name) : folderEntry.file.name;
  return { ir: ir as SkillIr, sourceName: rootName };
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
  const [tags, setTags] = useState<RegistryTag[]>([]);
  const [workflows, setWorkflows] = useState<RegistryWorkflow[]>([]);
  const [search, setSearch] = useState("");
  const [agent, setAgent] = useState("");
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [status, setStatus] = useState<"" | "published" | "unpublished">("");
  const [page, setPage] = useState(1);
  const [error, setError] = useState<string | null>(null);
  const [upload, setUpload] = useState<File[] | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [deleteModal, setDeleteModal] = useState<RegistrySkillDetail | null>(null);

  async function refresh(): Promise<void> {
    try {
      const [nextSkills, nextTags, nextWorkflows] = await Promise.all([
        required(api, "listSkills")(),
        required(api, "listTags")(),
        required(api, "listWorkflows")()
      ]);
      setSkills(nextSkills);
      setTags(nextTags);
      setWorkflows(nextWorkflows);
      setError(null);
    } catch (reason) {
      setError(apiError(reason, t));
    }
  }

  useEffect(() => { void refresh(); }, [api]);
  useEffect(() => { setPage(1); }, [search, agent, status, selectedTags]);

  const activeTags = tags.filter((tag) => tag.active);
  const filtered = (skills ?? []).filter((skill) => {
    const needle = search.trim().toLowerCase();
    return (needle === "" || `${skill.name} ${skill.slug} ${skill.description}`.toLowerCase().includes(needle)) &&
      (selectedTags.length === 0 || selectedTags.every((tag) => skill.tags.includes(tag))) &&
      (agent === "" || skill.agents.some((a) => a.agent === agent)) &&
      (status === "" || skillStatusGroup(skill.status) === status);
  });
  const pageSize = 6;
  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const currentPage = Math.min(page, totalPages);
  const pageItems = filtered.slice((currentPage - 1) * pageSize, currentPage * pageSize);
  const publishedCount = (skills ?? []).filter((skill) => skill.status === "published").length;
  const unpublishedCount = (skills ?? []).length - publishedCount;
  const configuredAgentCount = new Set((skills ?? []).flatMap((skill) => skill.agents.map((a) => a.agent))).size;
  const usedSkillCount = new Set(workflows.flatMap((workflow) => workflow.skill_slugs)).size;

  function toggleTag(slug: string): void {
    setSelectedTags((current) => current.includes(slug) ? current.filter((item) => item !== slug) : [...current, slug]);
  }

  async function submitUpload(): Promise<void> {
    if (upload === null || upload.length === 0) return;
    const files = upload;
    try {
      const draft = await required(api, "uploadSkillDraft")(buildUploadFormData(files));
      await refresh();
      let previewName = draft.slug;
      try { previewName = (await parseSkillFile(files)).ir.name || draft.slug; } catch { /* optional client-side preview; backend re-parses authoritatively */ }
      setMessage(t.skills.uploadedAsDraft.replace("{name}", previewName));
      setUpload(null);
    } catch (reason) { setError(apiError(reason, t)); }
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
         <div className="hero-actions"><Status value="governed" /><span>{skills?.length ?? 0} {t.skills.publishedCount}</span></div>
      </header>

      <div className="registry-toolbar registry-toolbar-expanded panel panel-themed panel-toolbar">
        <label className="search-wide">{t.skills.searchSkills}<input value={search} onChange={(event) => setSearch(event.target.value)} placeholder={t.skills.searchPlaceholder} /></label>
        <label>{t.skills.agent}<select value={agent} onChange={(event) => setAgent(event.target.value)}><option value="">{t.common.all}</option><option value="claude-code">Claude Code</option><option value="codex">Codex</option><option value="generic">Generic</option><option value="mcp">MCP</option></select></label>
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
          {skills === null ? <div className="skeleton-block" /> : filtered.length === 0 ? <Empty>{t.skills.noMatch}</Empty> : pageItems.map((skill) => {
            const usageCount = workflows.filter((workflow) => workflow.skill_slugs.includes(skill.slug)).length;
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
          <div className="panel panel-themed panel-stats skill-stats-panel">
            <div className="panel-title"><h2>{t.skills.stats}</h2><span>{t.skills.liveLocal}</span></div>
            <div className="skill-stat-grid">
              <article><strong>{skills?.length ?? 0}</strong><span>{t.skills.totalSkills}</span></article>
              <article><strong>{publishedCount}</strong><span>{t.skills.statusPublished}</span></article>
              <article><strong>{unpublishedCount}</strong><span>{t.skills.statusUnpublished}</span></article>
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
  const [selectedTag, setSelectedTag] = useState("");
  const [draft, setDraft] = useState("");
  const [demoDefaultAgent, setDemoDefaultAgent] = useState<DemoAgent | null>(null);
  const [sourcePath, setSourcePath] = useState("SKILL.md");
  const [activeTab, setActiveTab] = useState<SkillDetailTab>("source");
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function refresh(): Promise<void> {
    try {
      const [detail, history, allTags] = await Promise.all([
        required(api, "getSkill")(skillId), required(api, "listSkillVersions")(skillId),
        required(api, "listTags")()
      ]);
      setSkill(detail); setVersions(history); setTags(allTags);
      setError(null);
    } catch (reason) {
      setError(apiError(reason, t));
    }
  }

  useEffect(() => {
    const stored = globalThis.localStorage?.getItem("hunter-harness-default-agent") as DemoAgent | null;
    if (stored === "claude-code" || stored === "cursor" || stored === "codex" || stored === "generic" || stored === "mcp") setAgent(stored);
    void refresh();
  }, [api, skillId]);

  useEffect(() => { setSourcePath("SKILL.md"); }, [skillId]);
  const command = `npx @hunter-harness/skill-cli install ${skillId} --agent ${agent}`;
  async function copyCommand(): Promise<void> {
    await navigator.clipboard.writeText(command); setMessage(t.skillDetail.installCopied);
  }
  async function download(): Promise<void> {
    try {
      if (!isRegistryAgent(agent)) throw new Error("demo-only agent download is not wired to the API yet");
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
      updated_at: new Date().toISOString(),
      ir: current.ir === null ? current.ir : {
        ...current.ir,
        description: next.description
      }
    });
    setMessage(t.skillDetail.savedLocalConfig);
  }
  function removeLocalTag(slug: string): void {
    if (skill === null) return;
    saveLocalMeta({
      description: skill.ir?.description ?? skill.description,
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
  const selectedAgent = sourceSkill?.agents.find((item) => item.agent === agent);
  const defaultAgent = sourceSkill?.agents.find((item) => item.agent === activeDefaultAgent);
  const fallback = selectedAgent !== undefined && selectedAgent.configured === false && defaultAgent !== undefined;
  const sourceFile = sourceSkill?.source.files.find((file) => file.path === sourcePath) ?? sourceSkill?.source.entrypoint;
  const adapterPatch = sourceSkill?.adapters[agent];
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
        <div className="skill-meta skill-detail-meta"><Status value={skill.status} /><code className="skill-detail-version">v{skill.latest_version}</code></div>
      </header>

      <div className="command-panel skill-command-panel panel">
        <label>{t.skillDetail.targetAgent}<select value={agent} onChange={(event) => { const value = event.target.value as DemoAgent; setAgent(value); localStorage.setItem("hunter-harness-default-agent", value); }}>{detailAgents.map((item) => <option value={item.value} key={item.value}>{item.label}</option>)}</select></label>
        <code className="command-code">{command}</code>
        <button onClick={() => void copyCommand()}>{t.skillDetail.copyCommand}</button>
        <button className="secondary" onClick={() => void download()}>{t.skillDetail.downloadZip}</button>
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

      {activeTab === "source" && sourceSkill === undefined && skill.ir !== null ? <article className="panel source-package">
        <div className="panel-title"><h2>{t.skillDetail.sourceFiles}</h2><span>{t.skillDetail.configSummary}</span></div>
        <FilePreview path="skill-ir.json" content={JSON.stringify(skill.ir, null, 2)} showRaw={t.skillDetail.showRaw} showRendered={t.skillDetail.showRendered} />
      </article> : null}

      {activeTab === "examples" ? <article className="panel">
        <div className="panel-title"><h2>{t.skillDetail.usageExamples}</h2><span>{t.skillDetail.usageExamplesSummary}</span></div>
        <UsageExamples examples={sourceSkill?.examples ?? []} t={t.skillDetail} />
      </article> : null}

      {activeTab === "definition" && sourceSkill !== undefined && skill.ir !== null ? <div className="detail-grid system-config-layout">
        <article className="panel"><div className="panel-title"><h2>{t.skillDetail.systemConfig}</h2><span>{t.skillDetail.configSummary}</span></div><SkillConfigOverview ir={skill.ir} t={t.skillDetail} tags={skill.tags} onSaveMeta={saveLocalMeta} top={<DemoSystemConfig agents={sourceSkill.agents} currentAgent={selectedAgent} defaultAgent={activeDefaultAgent ?? sourceSkill.defaultAgent} onSetDefault={setDemoDefaultAgent} t={t.skillDetail} />} /></article>
        <article className="panel"><div className="panel-title"><h2>{t.skillDetail.contractsSecurity}</h2><span>{t.skillDetail.contractsSecuritySummary}</span></div><ContractSecurityOverview ir={skill.ir} t={t.skillDetail} /></article>
      </div> : null}

      {activeTab === "definition" && sourceSkill === undefined && skill.ir !== null ? <div className="detail-grid system-config-layout">
        <article className="panel"><div className="panel-title"><h2>{t.skillDetail.systemConfig}</h2><span>{t.skillDetail.configSummary}</span></div><SkillConfigOverview ir={skill.ir} t={t.skillDetail} tags={skill.tags} onSaveMeta={saveLocalMeta} /></article>
        <article className="panel"><div className="panel-title"><h2>{t.skillDetail.contractsSecurity}</h2><span>{t.skillDetail.contractsSecuritySummary}</span></div><ContractSecurityOverview ir={skill.ir} t={t.skillDetail} /></article>
      </div> : null}

      {activeTab === "definition" && skill.ir === null ? <div className="detail-grid">
        <article className="panel"><Empty>{t.skillDetail.notAvailable}</Empty></article>
      </div> : null}

      {activeTab === "checks" ? <article className="panel">
        <div className="panel-title"><h2>{t.skillDetail.checkPublish}</h2><span>{selectedAgent?.label ?? agentLabel(agent)}</span></div>
        <AgentCheckPanel agent={selectedAgent} fallbackAgent={defaultAgent} t={t.skillDetail} />
      </article> : null}

      {activeTab === "versions" ? <article className="panel">
        <div className="panel-title"><h2>{t.skillDetail.versionHistory}</h2><span>{versions.length}</span></div>
        <VersionHistoryPanel versions={versions} currentSkill={skill} t={t.skillDetail} />
      </article> : null}

      {activeTab === "governance" ? <>
        <article className="panel compact-form"><div className="panel-title"><h2>{t.skillDetail.tagBinding}</h2><span>{t.skillDetail.noReview}</span></div><div className="inline-form"><select aria-label={t.skillDetail.selectTag} value={selectedTag} onChange={(event) => setSelectedTag(event.target.value)}><option value="">{t.skillDetail.selectTag}</option>{tags.filter((tag) => tag.active && !skill.tags.includes(tag.slug)).map((tag) => <option value={tag.tag_id} key={tag.tag_id}>{tag.label}</option>)}</select><button onClick={() => void bindTag()}>{t.skillDetail.addTag}</button></div></article>

        <article className="panel"><div className="panel-title"><h2>{t.skillDetail.createProposal}</h2><Status value="review-required" /></div><textarea className="ir-editor" aria-label="Skill IR draft" value={draft} onChange={(event) => setDraft(event.target.value)} /><div className="actions"><button onClick={() => void submitDraft()}>{t.skillDetail.validateSubmit}</button></div></article>

        <article className="panel"><div className="panel-title"><h2>{t.skillDetail.reviewRecord}</h2><span>{proposals.length}</span></div>{proposals.length === 0 ? <Empty>{t.skillDetail.noProposalLinked}</Empty> : proposals.map((proposal) => <div className="proposal-card" key={proposal.proposal_id}><div><strong>{proposal.proposal_id}</strong><code>v{proposal.proposed_ir.version}</code><small>schema {proposal.validation.schema_valid ? "valid" : "invalid"} · sensitive findings {proposal.validation.sensitive_findings} · Claude compile {proposal.validation.claude_compilable ? "passed" : "failed"}</small></div><div><Status value={proposal.status} />{proposal.status === "pending_review" ? <><button onClick={() => void review(proposal.proposal_id, "approve")}>{t.skillDetail.approve}</button><button className="secondary" onClick={() => void review(proposal.proposal_id, "reject")}>{t.skillDetail.reject}</button></> : null}</div></div>)}</article>
      </> : null}
      {message === null ? null : <div className="notice success">{message}</div>}{error === null ? null : <div className="notice danger">{error}</div>}
    </section>
  );
}

const blankWorkflow: RegistryWorkflowMutation = {
  key: "", name: "", description: "", profile: "general", default_agent: "claude-code",
  enabled: true, skill_slugs: []
};

export function WorkflowRegistry({ api: apiValue }: { api?: HunterApi }) {
  const { t } = useI18n();
  const api = useApi(apiValue);
  const [workflows, setWorkflows] = useState<RegistryWorkflow[] | null>(null);
  const [skills, setSkills] = useState<RegistrySkillDetail[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [form, setForm] = useState<RegistryWorkflowMutation>(blankWorkflow);
  const [revision, setRevision] = useState<number | null>(null);
  const [workflowQuery, setWorkflowQuery] = useState("");
  const [skillQuery, setSkillQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const selected = workflows?.find((item) => item.workflow_id === selectedId) ?? null;
  const workflowNeedle = workflowQuery.trim().toLowerCase();
  const filteredWorkflows = (workflows ?? []).filter((workflow) => workflowNeedle === "" ||
    `${workflow.name} ${workflow.key} ${workflow.profile}`.toLowerCase().includes(workflowNeedle));
  const skillNeedle = skillQuery.trim().toLowerCase();
  const filteredLibrarySkills = skills.filter((skill) => skillNeedle === "" ||
    `${skill.name} ${skill.description} ${skill.ir.kind}`.toLowerCase().includes(skillNeedle));

  async function refresh(preferId?: string): Promise<void> {
    try {
      const [nextWorkflows, nextSkills] = await Promise.all([required(api, "listWorkflows")(), required(api, "listSkills")()]);
      setWorkflows(nextWorkflows); setSkills(nextSkills); setError(null);
      const id = preferId ?? selectedId ?? nextWorkflows[0]?.workflow_id ?? null;
      setSelectedId(id);
      const value = nextWorkflows.find((item) => item.workflow_id === id);
      if (value !== undefined) {
        setForm({ key: value.key, name: value.name, description: value.description, profile: value.profile, default_agent: value.default_agent, enabled: value.enabled, skill_slugs: value.skill_slugs });
        setRevision(value.revision);
      }
    } catch (reason) { setError(apiError(reason, t)); }
  }
  useEffect(() => { void refresh(); }, [api]);

  function edit(workflow: RegistryWorkflow): void {
    setSelectedId(workflow.workflow_id); setRevision(workflow.revision);
    setForm({ key: workflow.key, name: workflow.name, description: workflow.description, profile: workflow.profile, default_agent: workflow.default_agent, enabled: workflow.enabled, skill_slugs: workflow.skill_slugs });
  }
  function move(index: number, direction: -1 | 1): void {
    const next = [...form.skill_slugs]; const target = index + direction;
    const currentSkill = next[index]; const targetSkill = next[target];
    if (target < 0 || target >= next.length || currentSkill === undefined || targetSkill === undefined) return;
    next[index] = targetSkill; next[target] = currentSkill;
    setForm({ ...form, skill_slugs: next });
  }
  async function save(): Promise<void> {
    try {
      let saved: RegistryWorkflow;
      if (revision === null) {
        saved = await required(api, "createWorkflow")(form);
      } else {
        if (selectedId === null) throw new Error("selected Workflow is missing");
        saved = await required(api, "updateWorkflow")(selectedId, { ...form, revision });
      }
      await refresh(saved.workflow_id);
    } catch (reason) { setError(apiError(reason, t)); }
  }
  async function remove(): Promise<void> {
    if (selectedId === null || revision === null) return;
    try { await required(api, "deleteWorkflow")(selectedId, revision); setSelectedId(null); setRevision(null); setForm(blankWorkflow); await refresh(); }
    catch (reason) { setError(apiError(reason, t)); }
  }

  return (
    <section className="stack governance-page">
      <header className="page-heading command-hero"><div><p className="eyebrow">{t.workflows.eyebrow}</p><h1>Workflows</h1><p className="lede">{t.workflows.description}</p></div><button onClick={() => { setSelectedId(null); setRevision(null); setForm(blankWorkflow); }}>{t.workflows.newWorkflow}</button></header>
      <div className="workflow-workbench">
        <div className="panel workflow-index"><div className="panel-title"><h2>{t.workflows.profiles}</h2><span>{filteredWorkflows.length}</span></div><label className="rail-search">{t.workflows.search}<input value={workflowQuery} onChange={(event) => setWorkflowQuery(event.target.value)} placeholder="name, key, profile" /></label>{workflows === null ? <div className="skeleton-block" /> : workflows.length === 0 ? <Empty>{t.workflows.noWorkflows}</Empty> : filteredWorkflows.length === 0 ? <Empty>{t.workflows.noMatch}</Empty> : filteredWorkflows.map((workflow) => <button className={workflow.workflow_id === selectedId ? "selected" : ""} key={workflow.workflow_id} onClick={() => edit(workflow)}><strong>{workflow.name}</strong><span>{workflow.profile} · {workflow.skill_slugs.length} skills</span><Status value={workflow.enabled ? "active" : "archived"} /></button>)}</div>
        <div className="panel workflow-editor compact-form">
          <div className="panel-title"><h2>{selected === null ? t.workflows.editingNew : t.workflows.editingExisting}</h2><span>{revision === null ? "new" : `revision ${revision}`}</span></div>
          <div className="form-grid"><label>{t.workflows.name}<input value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} /></label><label>{t.workflows.key}<input value={form.key} onChange={(event) => setForm({ ...form, key: event.target.value })} /></label><label className="span-2">{t.workflows.description2}<textarea value={form.description} onChange={(event) => setForm({ ...form, description: event.target.value })} /></label><label>Profile<input value={form.profile} onChange={(event) => setForm({ ...form, profile: event.target.value })} /></label><label>{t.workflows.defaultAgent}<select value={form.default_agent} onChange={(event) => setForm({ ...form, default_agent: event.target.value as RegistryAgent })}><option value="claude-code">Claude Code</option></select></label></div>
          <div className="panel-title"><h3>{t.workflows.orderedSkillBinding}</h3><span>{t.workflows.directSaveAudit}</span></div>
          <ol className="binding-list">{form.skill_slugs.map((slug, index) => <li key={slug}><span className="sequence">{String(index + 1).padStart(2, "0")}</span><strong>{slug}</strong><div><button className="icon-button" aria-label={`move-up ${slug}`} onClick={() => move(index, -1)}>↑</button><button className="icon-button" aria-label={`move-down ${slug}`} onClick={() => move(index, 1)}>↓</button><button className="icon-button danger" aria-label={`remove ${slug}`} onClick={() => setForm({ ...form, skill_slugs: form.skill_slugs.filter((item) => item !== slug) })}>×</button></div></li>)}</ol>
          <label>{t.workflows.addPublishedSkill}<select value="" onChange={(event) => event.target.value !== "" && setForm({ ...form, skill_slugs: [...form.skill_slugs, event.target.value] })}><option value="">{t.workflows.selectSkill}</option>{skills.filter((skill) => !form.skill_slugs.includes(skill.slug) && skill.agents.some((a) => a.agent === form.default_agent) && skill.ir?.profiles[form.profile]?.enabled).map((skill) => <option value={skill.slug} key={skill.skill_id}>{skill.name}</option>)}</select></label>
          <div className="actions"><button disabled={!form.name || !form.key || !form.description} onClick={() => void save()}>{t.workflows.save}</button>{revision === null ? null : <button className="secondary danger" onClick={() => void remove()}>{t.workflows.archiveDelete}</button>}</div>
        </div>
        <div className="panel skill-library"><div className="panel-title"><h2>{t.workflows.availableSkills}</h2><span>{filteredLibrarySkills.length}</span></div><label className="rail-search">{t.workflows.searchAvailableSkills}<input value={skillQuery} onChange={(event) => setSkillQuery(event.target.value)} placeholder={t.workflows.availablePlaceholder} /></label>{filteredLibrarySkills.length === 0 ? <Empty>{t.workflows.noAvailable}</Empty> : filteredLibrarySkills.map((skill) => <div className="library-item" key={skill.skill_id}><div><strong>{skill.name}</strong><p>{skill.description}</p></div><Status value={skill.ir.kind} /></div>)}</div>
      </div>
      {error === null ? null : <div className="notice danger">{error}</div>}
    </section>
  );
}
