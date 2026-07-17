"use client";

import { skillFrontmatterSchema } from "@hunter-harness/contracts";
import type { AgentSkillConfig, SkillDiffFile, SkillFrontmatter, SourceFile } from "@hunter-harness/contracts";
import { parse as parseYaml } from "yaml";
import { useState } from "react";

import { ApiClientError, type HunterApi } from "../lib/api";
import type { DemoAgent, DemoUsageExample } from "../lib/demo-skills/types";
import { useI18n } from "../lib/i18n";

export function apiError(error: unknown, t: ReturnType<typeof useI18n>["t"]): string {
  if (process.env.NEXT_PUBLIC_HUNTER_HARNESS_DEMO === "true" && error instanceof Error) {
    return t.error.demoFailed + error.message;
  }
  if (error instanceof ApiClientError && error.status === 401) {
    return t.error.authRequiredSettings;
  }
  if (error instanceof ApiClientError) {
    const base = t.error.apiFailed.replace("{code}", error.code);
    const detail = error.message && error.code !== "HTTP_ERROR" ? error.message : "";
    return detail ? `${base} ${detail}` : base;
  }
  return t.error.opFailed;
}

function required<K extends keyof HunterApi>(api: HunterApi, key: K): NonNullable<HunterApi[K]> {
  const method = api[key];
  if (typeof method !== "function") throw new Error(`API capability ${String(key)} is unavailable`);
  return method.bind(api) as NonNullable<HunterApi[K]>;
}

function Status({ value }: { value: string }) {
  const { t } = useI18n();
  const key = value.replaceAll("_", "-");
  const labels = t.status as Record<string, string>;
  const label = labels[value] ?? labels[key] ?? value.replaceAll("_", " ");
  return <span className={`status status-${key}`}>{label}</span>;
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
  agents,
  empty,
  enabledLabel,
  disabledLabel,
  labelFor
}: {
  agents: readonly AgentSkillConfig[];
  empty: string;
  enabledLabel: string;
  disabledLabel: string;
  labelFor?: (name: string) => string;
}) {
  if (agents.length === 0) return <span className="muted-inline">{empty}</span>;
  return <span className="config-chip-row">{agents.map((cfg) => (
    <span className={`config-chip config-chip-${cfg.enabled ? "enabled" : "disabled"}`} key={cfg.agent}>
      <span>{labelFor?.(cfg.agent) ?? cfg.agent}</span>
      <small>{cfg.enabled ? enabledLabel : disabledLabel}</small>
    </span>
  ))}</span>;
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

function diffStats(files: readonly SkillDiffFile[]): { changedFiles: number; addedFiles: number; modifiedFiles: number; removedFiles: number; changedLines: number } {
  return files.reduce((stats, file) => {
    const published = (file.publishedContent ?? "").split("\n");
    const draft = (file.draftContent ?? "").split("\n");
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

// 与 packages/core/src/skill-ir/diff.ts 的 computeDiff 逻辑一致。
// web 端本地实现：apps/web import @hunter-harness/core 会触发 next build webpack 打包 core/dist（含 node: scheme，浏览器端 webpack 不兼容）。
// 改 core 端 computeDiff 需同步此副本；对等测试见 apps/web/test/compute-diff-parity.test.tsx。
function computeDiff(published: SourceFile[], draft: SourceFile[]): SkillDiffFile[] {
  const pubMap = new Map<string, string>();
  for (const f of published) pubMap.set(f.path, f.content);
  const draftMap = new Map<string, string>();
  for (const f of draft) draftMap.set(f.path, f.content);
  const result: SkillDiffFile[] = [];
  const paths = new Set<string>([...pubMap.keys(), ...draftMap.keys()]);
  for (const path of paths) {
    const pubContent = pubMap.get(path);
    const draftContent = draftMap.get(path);
    if (pubContent === undefined && draftContent !== undefined) {
      result.push({ path, status: "added", publishedContent: null, draftContent });
    } else if (pubContent !== undefined && draftContent === undefined) {
      result.push({ path, status: "removed", publishedContent: pubContent, draftContent: null });
    } else if (pubContent !== undefined && draftContent !== undefined && pubContent !== draftContent) {
      result.push({ path, status: "modified", publishedContent: pubContent, draftContent });
    }
  }
  return result;
}

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

/**
 * 从 SKILL.md 内容解析 frontmatter（取代 canonical Skill IR 的元数据来源）。
 * web 端轻量解析：parseYaml + skillFrontmatterSchema.parse；失败返回 null（UI 降级展示，不抛错）。
 * 与 core/skill/frontmatter.ts 的 parseFrontmatter 对齐，但容错而非抛错（展示用，非校验入口）。
 */
export function parseSkillFrontmatter(content: string): SkillFrontmatter | null {
  const match = FRONTMATTER_RE.exec(content);
  if (match === null) return null;
  const raw = match[1] ?? "";
  try {
    const parsed: unknown = parseYaml(raw);
    return skillFrontmatterSchema.parse(parsed);
  } catch {
    return null;
  }
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

export {
  required,
  Status,
  Empty,
  displayValue,
  tagSlug,
  chipTone,
  ValueChips,
  EnabledTargets,
  isMarkdownFile,
  renderInlineMarkdown,
  tableCells,
  MarkdownDocument,
  FilePreview,
  detailAgents,
  agentLabel,
  UsageExamples,
  CheckLight,
  nextPatchVersion,
  shiftPatchVersion,
  diffStats,
  computeDiff,
  SourceFileTree
};
