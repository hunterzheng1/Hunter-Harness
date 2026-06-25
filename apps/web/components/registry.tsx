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
import { type ChangeEvent, type FormEvent, useEffect, useMemo, useState } from "react";
import { parse as parseYaml } from "yaml";

import { ApiClientError, browserApi, type HunterApi } from "../lib/api";
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
    if (link !== null) return <a key={key} href={link[2]} target="_blank" rel="noreferrer">{link[1]}</a>;
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
    const line = lines[index];
    if (line.trim() === "") { index += 1; continue; }
    const fence = line.match(/^```([^\s]*)/);
    if (fence !== null) {
      const code: string[] = [];
      index += 1;
      while (index < lines.length && !lines[index].startsWith("```")) code.push(lines[index++]);
      if (index < lines.length) index += 1;
      blocks.push(<pre className="markdown-code" key={`code-${blocks.length}`}><code>{code.join("\n")}</code></pre>);
      continue;
    }
    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading !== null) {
      const key = `heading-${blocks.length}`;
      const headingContent = renderInlineMarkdown(heading[2], key);
      blocks.push(heading[1].length === 1 ? <h1 key={key}>{headingContent}</h1>
        : heading[1].length === 2 ? <h2 key={key}>{headingContent}</h2>
          : heading[1].length === 3 ? <h3 key={key}>{headingContent}</h3>
            : <h4 key={key}>{headingContent}</h4>);
      index += 1;
      continue;
    }
    if (/^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/.test(line)) { blocks.push(<hr key={`rule-${blocks.length}`} />); index += 1; continue; }
    if (line.startsWith("> ")) {
      const quote: string[] = [];
      while (index < lines.length && lines[index].startsWith("> ")) quote.push(lines[index++].slice(2));
      blocks.push(<blockquote key={`quote-${blocks.length}`}>{renderInlineMarkdown(quote.join(" "), `quote-${blocks.length}`)}</blockquote>);
      continue;
    }
    if (line.includes("|") && index + 1 < lines.length && /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(lines[index + 1])) {
      const header = tableCells(line); index += 2;
      const rows: string[][] = [];
      while (index < lines.length && lines[index].includes("|") && lines[index].trim() !== "") rows.push(tableCells(lines[index++]));
      blocks.push(<div className="markdown-table-wrap" key={`table-${blocks.length}`}><table><thead><tr>{header.map((cell, cellIndex) => <th key={cellIndex}>{renderInlineMarkdown(cell, `head-${cellIndex}`)}</th>)}</tr></thead><tbody>{rows.map((row, rowIndex) => <tr key={rowIndex}>{header.map((_, cellIndex) => <td key={cellIndex}>{renderInlineMarkdown(row[cellIndex] ?? "", `cell-${rowIndex}-${cellIndex}`)}</td>)}</tr>)}</tbody></table></div>);
      continue;
    }
    const list = line.match(/^\s*([-+*]|\d+\.)\s+(.+)$/);
    if (list !== null) {
      const ordered = /\d+\./.test(list[1]); const items: string[] = [];
      while (index < lines.length) {
        const item = lines[index].match(/^\s*([-+*]|\d+\.)\s+(.+)$/);
        if (item === null || /\d+\./.test(item[1]) !== ordered) break;
        items.push(item[2]); index += 1;
      }
      const List = ordered ? "ol" : "ul";
      blocks.push(<List key={`list-${blocks.length}`}>{items.map((item, itemIndex) => <li key={itemIndex}>{renderInlineMarkdown(item, `list-${itemIndex}`)}</li>)}</List>);
      continue;
    }
    const paragraph: string[] = [];
    while (index < lines.length && lines[index].trim() !== "" && !/^(#{1,6})\s+|^```|^> |^\s*([-+*]|\d+\.)\s+/.test(lines[index])) paragraph.push(lines[index++]);
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

type SkillDetailTab = "content" | "source" | "definition" | "versions" | "governance";

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

async function parseSkillFile(file: File): Promise<SkillIr> {
  let name = file.name;
  let content: string;
  if (name.toLowerCase().endsWith(".zip")) {
    const zip = await JSZip.loadAsync(await file.arrayBuffer());
    const entry = Object.values(zip.files).find((item) =>
      !item.dir && /(^|\/)(skill\.ya?ml|skill\.json|hunter-skill-ir\.json)$/i.test(item.name) && !item.name.includes("..")
    );
    if (entry === undefined) throw new Error("ZIP: skill IR not found");
    name = entry.name;
    content = await entry.async("text");
  } else {
    content = await file.text();
  }
  const candidate = name.toLowerCase().endsWith(".json") ? JSON.parse(content) : parseYaml(content);
  return candidate as SkillIr;
}

export function SkillRegistry({ api: apiValue }: { api?: HunterApi }) {
  const { t } = useI18n();
  const api = useApi(apiValue);
  const [skills, setSkills] = useState<RegistrySkillDetail[] | null>(null);
  const [tags, setTags] = useState<RegistryTag[]>([]);
  const [workflows, setWorkflows] = useState<RegistryWorkflow[]>([]);
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("");
  const [tagFilter, setTagFilter] = useState("");
  const [profile, setProfile] = useState("");
  const [agent, setAgent] = useState("");
  const [status, setStatus] = useState("");
  const [version, setVersion] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [tagSlug, setTagSlug] = useState("");
  const [tagLabel, setTagLabel] = useState("");
  const [mergeTargets, setMergeTargets] = useState<Record<string, string>>({});
  const [upload, setUpload] = useState<File | null>(null);
  const [message, setMessage] = useState<string | null>(null);

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

  const profiles = [...new Set((skills ?? []).flatMap((skill) =>
    Object.entries(skill.ir?.profiles ?? {}).filter(([, value]) => value.enabled).map(([key]) => key)
  ))].sort();
  const filtered = (skills ?? []).filter((skill) => {
    const needle = search.trim().toLowerCase();
    return (needle === "" || `${skill.name} ${skill.slug} ${skill.description}`.toLowerCase().includes(needle)) &&
      (category === "" || skill.category === category) &&
      (tagFilter === "" || skill.tags.includes(tagFilter)) &&
      (profile === "" || skill.ir?.profiles[profile]?.enabled === true) &&
      (agent === "" || skill.adapters.includes(agent as RegistryAgent)) &&
      (status === "" || skill.status === status) &&
      (version.trim() === "" || skill.latest_version === version.trim());
  });

  async function createTag(event: FormEvent): Promise<void> {
    event.preventDefault();
    try {
      await required(api, "createTag")(tagSlug, tagLabel);
      setTagSlug(""); setTagLabel(""); setMessage(t.skills.tagSavedAudit);
      await refresh();
    } catch (reason) { setError(apiError(reason, t)); }
  }

  async function updateTag(tag: RegistryTag, input: { label?: string; active?: boolean }): Promise<void> {
    try { await required(api, "updateTag")(tag.tag_id, { revision: tag.revision, ...input }); setMessage(t.skills.tagUpdatedAudit); await refresh(); }
    catch (reason) { setError(apiError(reason, t)); }
  }

  async function mergeTag(tag: RegistryTag): Promise<void> {
    const target = mergeTargets[tag.tag_id];
    if (target === undefined || target === "") return;
    try { await required(api, "mergeTag")(tag.tag_id, target, tag.revision); setMessage(t.skills.tagMergedAudit); await refresh(); }
    catch (reason) { setError(apiError(reason, t)); }
  }

  async function submitUpload(): Promise<void> {
    if (upload === null) return;
    try {
      const ir = await parseSkillFile(upload);
      const proposal = await required(api, "createSkillProposal")(ir, "claude-code");
      setMessage(`${t.skills.proposalCreated.replace("{id}", proposal.proposal_id)}`);
      setUpload(null);
    } catch (reason) { setError(apiError(reason, t)); }
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

      <div className="registry-toolbar registry-toolbar-expanded panel">
        <label className="search-wide">{t.skills.searchSkills}<input value={search} onChange={(event) => setSearch(event.target.value)} placeholder={t.skills.searchPlaceholder} /></label>
        <label>{t.skills.category}<select value={category} onChange={(event) => setCategory(event.target.value)}><option value="">{t.common.all}</option><option value="workflow">Workflow</option><option value="governance">Governance</option><option value="tooling">Tooling</option><option value="migration">Migration</option></select></label>
        <label>{t.skills.tag}<select value={tagFilter} onChange={(event) => setTagFilter(event.target.value)}><option value="">{t.common.all}</option>{tags.filter((tag) => tag.active).map((tag) => <option value={tag.slug} key={tag.tag_id}>{tag.label}</option>)}</select></label>
        <label>Profile<select value={profile} onChange={(event) => setProfile(event.target.value)}><option value="">{t.common.all}</option>{profiles.map((item) => <option value={item} key={item}>{item}</option>)}</select></label>
        <label>Agent<select value={agent} onChange={(event) => setAgent(event.target.value)}><option value="">{t.common.all}</option><option value="claude-code">Claude Code</option><option value="codex">Codex</option><option value="generic">Generic</option><option value="mcp">MCP</option></select></label>
        <label>{t.skills.status}<select value={status} onChange={(event) => setStatus(event.target.value)}><option value="">{t.common.all}</option><option value="published">Published</option><option value="pending_review">Pending review</option><option value="draft">Draft</option><option value="rejected">Rejected</option><option value="deprecated">Deprecated</option></select></label>
        <label>{t.skills.version}<input value={version} onChange={(event) => setVersion(event.target.value)} placeholder="1.0.0" /></label>
      </div>

      <div className="hub-grid">
        <div className="panel registry-list">
          <div className="panel-title"><h2>{t.skills.publishedSkill}</h2><span>{filtered.length}</span></div>
          {skills === null ? <div className="skeleton-block" /> : filtered.length === 0 ? <Empty>{t.skills.noMatch}</Empty> : filtered.map((skill) => {
            const usageCount = workflows.filter((workflow) => workflow.skill_slugs.includes(skill.slug)).length;
            return (
              <Link className="skill-row" href={`/skills/${skill.slug}`} key={skill.skill_id}>
                <div><strong>{skill.name}</strong><p>{skill.description}</p><div className="tag-row"><Status value={skill.category} />{skill.tags.map((tag) => <span className="tag" key={tag}>{tag}</span>)}</div></div>
                <div className="skill-meta"><code>v{skill.latest_version}</code><span>{skill.adapters.length} adapters</span><span>{usageCount} {usageCount === 1 ? "workflow" : "workflows"}</span><span>updated {skill.updated_at.slice(0, 10)}</span><Status value="validated" /><Status value={skill.status} /></div>
              </Link>
            );
          })}
        </div>
        <aside className="hub-rail">
          <form className="panel compact-form" onSubmit={(event) => void createTag(event)}>
            <div className="panel-title"><h2>{t.skills.tagManagement}</h2><span>{t.skills.directEffective}</span></div>
            <label>Slug<input required value={tagSlug} onChange={(event) => setTagSlug(event.target.value)} placeholder="security" /></label>
            <label>{t.skills.displayName}<input required value={tagLabel} onChange={(event) => setTagLabel(event.target.value)} placeholder="Security" /></label>
            <button type="submit">{t.skills.createTag}</button>
            <div className="tag-admin-list">{tags.map((tag) => <div key={tag.tag_id}>
              <input aria-label={`rename ${tag.slug}`} defaultValue={tag.label} onBlur={(event) => event.target.value !== tag.label && void updateTag(tag, { label: event.target.value })} />
              <Status value={tag.active ? "active" : "inactive"} />
              {tag.active ? <button className="secondary" type="button" onClick={() => void updateTag(tag, { active: false })}>{t.skills.deactivate}</button> : null}
              {tag.active ? <><select aria-label={`{t.skills.merge} ${tag.slug}`} value={mergeTargets[tag.tag_id] ?? ""} onChange={(event) => setMergeTargets({ ...mergeTargets, [tag.tag_id]: event.target.value })}><option value="">{t.skills.mergeInto}</option>{tags.filter((target) => target.active && target.tag_id !== tag.tag_id).map((target) => <option value={target.tag_id} key={target.tag_id}>{target.label}</option>)}</select><button type="button" className="secondary" onClick={() => void mergeTag(tag)}>{t.skills.merge}</button></> : null}
            </div>)}</div>
          </form>
          <div className="panel compact-form">
            <div className="panel-title"><h2>{t.skills.uploadSkill}</h2><Status value="review-required" /></div>
            <p>{t.skills.uploadHint}</p>
            <label className="file-drop">{t.skills.chooseFile}<input type="file" accept=".zip,.yaml,.yml,.json" onChange={(event: ChangeEvent<HTMLInputElement>) => setUpload(event.target.files?.[0] ?? null)} /></label>
            <button disabled={upload === null} onClick={() => void submitUpload()}>{t.skills.validateSubmit}</button>
          </div>
        </aside>
      </div>
      {message === null ? null : <div className="notice success">{message}</div>}
      {error === null ? null : <div className="notice danger">{error}</div>}
    </section>
  );
}

export function SkillDetail({ api: apiValue, skillId }: { api?: HunterApi; skillId: string }) {
  const { t } = useI18n();
  const api = useApi(apiValue);
  const [skill, setSkill] = useState<RegistrySkillDetail | null>(null);
  const [versions, setVersions] = useState<RegistrySkillVersion[]>([]);
  const [proposals, setProposals] = useState<RegistrySkillProposal[]>([]);
  const [tags, setTags] = useState<RegistryTag[]>([]);
  const [agent, setAgent] = useState<RegistryAgent>("claude-code");
  const [selectedTag, setSelectedTag] = useState("");
  const [draft, setDraft] = useState("");
  const [adapterPreview, setAdapterPreview] = useState<{ path: string; content: string; sourceIrHash: string; compilerVersion: string } | null>(null);
  const [sourcePath, setSourcePath] = useState("SKILL.md");
  const [activeTab, setActiveTab] = useState<SkillDetailTab>("content");
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function refresh(): Promise<void> {
    try {
      const [detail, history, pending, allTags] = await Promise.all([
        required(api, "getSkill")(skillId), required(api, "listSkillVersions")(skillId),
        required(api, "listSkillProposals")(), required(api, "listTags")()
      ]);
      setSkill(detail); setVersions(history); setTags(allTags);
      setProposals(pending.filter((proposal) => proposal.skill_slug === skillId));
      setDraft(JSON.stringify(detail.ir, null, 2)); setError(null);
    } catch (reason) { setError(apiError(reason, t)); }
  }

  useEffect(() => {
    const stored = globalThis.localStorage?.getItem("hunter-harness-default-agent") as RegistryAgent | null;
    if (stored === "claude-code" || stored === "codex" || stored === "generic" || stored === "mcp") setAgent(stored);
    void refresh();
  }, [api, skillId]);

  useEffect(() => {
    let active = true;
    setAdapterPreview(null);
    if (api.getSkillAdapterPreview === undefined) return () => { active = false; };
    void api.getSkillAdapterPreview(skillId, agent)
      .then((value) => { if (active) setAdapterPreview(value); })
      .catch((reason: unknown) => {
        if (active && agent === "claude-code") setError(apiError(reason, t));
      });
    return () => { active = false; };
  }, [api, skillId, agent]);

  useEffect(() => { setSourcePath("SKILL.md"); }, [skillId]);
  const command = `npx @hunter-harness/skill-cli install ${skillId} --agent ${agent}`;
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
    try {
      const proposal = await required(api, "createSkillProposal")(JSON.parse(draft) as SkillIr, "claude-code");
      setMessage(`${t.skillDetail.proposalCreatedHint.replace("{id}", proposal.proposal_id)}`); await refresh();
    } catch (reason) { setError(apiError(reason, t)); }
  }
  async function review(proposalId: string, decision: "approve" | "reject"): Promise<void> {
    try { await required(api, "reviewSkillProposal")(proposalId, decision, "Owner review from Web Console"); setMessage(`{t.skillDetail.proposalCreatedHint.replace("{id}", proposalId)}`); await refresh(); }
    catch (reason) { setError(apiError(reason, t)); }
  }
  async function bindTag(): Promise<void> {
    if (selectedTag === "") return;
    try { setSkill(await required(api, "bindSkillTag")(skillId, selectedTag)); setMessage(t.skills.tagSavedAudit); }
    catch (reason) { setError(apiError(reason, t)); }
  }
  async function unbindTag(slug: string): Promise<void> {
    const tag = tags.find((item) => item.slug === slug);
    if (tag === undefined) {
      setError(t.skillDetail.tagMissing);
      return;
    }
    try {
      setSkill(await required(api, "bindSkillTag")(skillId, tag.tag_id, true));
      setMessage(t.skillDetail.tagRemovedAudit);
    } catch (reason) { setError(apiError(reason, t)); }
  }

  if (error !== null && skill === null) return <Empty>{error}</Empty>;
  if (skill === null) return <Empty>{t.skillDetail.loading}</Empty>;
  const previous = versions[1];
  const sourceSkill = process.env.NEXT_PUBLIC_HUNTER_HARNESS_DEMO === "true"
    ? findDemoSourceSkill(skill.slug)
    : undefined;
  const sourceFile = sourceSkill?.source.files.find((file) => file.path === sourcePath) ?? sourceSkill?.source.entrypoint;
  const adapterPatch = sourceSkill?.adapters[agent];
  return (
    <section className="stack governance-page">
      <header className="page-heading command-hero">
        <div><p className="eyebrow">{t.skillDetail.eyebrow}</p><h1>{skill.name}</h1><p className="lede">{skill.description}</p><div className="tag-row"><Status value={skill.category} />{skill.tags.map((tag) => <button type="button" className="tag tag-remove" aria-label={`remove-tag  ${tag}`} onClick={() => void unbindTag(tag)} key={tag}>{tag}<span aria-hidden="true">×</span></button>)}</div></div>
        <div className="skill-meta"><Status value={skill.status} /><code>v{skill.latest_version}</code></div>
      </header>

      <div className="command-panel panel">
        <label>{t.skillDetail.targetAgent}<select value={agent} onChange={(event) => { const value = event.target.value as RegistryAgent; setAgent(value); localStorage.setItem("hunter-harness-default-agent", value); }}><option value="claude-code">Claude Code</option><option value="codex">{t.skillDetail.codexShort}</option><option value="generic">{t.skillDetail.genericShort}</option><option value="mcp">{t.skillDetail.mcpShort}</option></select></label>
        <code>{command}</code>
        <button onClick={() => void copyCommand()}>{t.skillDetail.copyCommand}</button>
        <button className="secondary" disabled={agent !== "claude-code"} onClick={() => void download()}>{t.skillDetail.downloadZip}</button>
      </div>

      <div className="skill-detail-tabs" role="tablist" aria-label="Skill detail sections">
        {([
          ["content", t.skillDetail.tabContent],
          ["source", t.skillDetail.tabSource],
          ["definition", t.skillDetail.tabDefinition],
          ["versions", t.skillDetail.tabVersions],
          ["governance", t.skillDetail.tabGovernance]
        ] as const).map(([id, label]) => <button key={id} type="button" role="tab" aria-selected={activeTab === id} className={activeTab === id ? "selected" : ""} onClick={() => setActiveTab(id)}>{label}</button>)}
      </div>

      {activeTab === "content" ? <>
        <article className="panel adapter-preview">
        <div className="panel-title"><h2>{t.skillDetail.publishedAdapter}</h2><span>{t.skillDetail.adapterPreviewDescription} · {adapterPreview?.path ?? t.skillDetail.contractOnlyText.replace("{agent}", agent)}</span></div>
        {adapterPreview === null
          ? <Empty>{agent === "claude-code" ? t.skillDetail.loadingAdapter : t.skillDetail.notAvailable}</Empty>
          : <><FilePreview key={`${adapterPreview.path}-${agent}`} path={adapterPreview.path} content={adapterPreview.content} showRaw={t.skillDetail.showRaw} showRendered={t.skillDetail.showRendered} /><div className="artifact-proof"><code>{adapterPreview.sourceIrHash}</code><span>compiler {adapterPreview.compilerVersion}</span></div></>}
        </article>
      </> : null}

      {activeTab === "source" && sourceSkill !== undefined && sourceFile !== undefined ? <article className="panel source-package">
        <div className="panel-title"><h2>{t.skillDetail.sourceFiles}</h2><span>{t.skillDetail.authoritativeDemoPackage}</span></div>
        <div className="source-package-grid">
          <SourceFileTree files={sourceSkill.source.files} selectedPath={sourceFile.path} onSelect={setSourcePath} />
          <FilePreview key={sourceFile.path} path={sourceFile.path} content={sourceFile.content} showRaw={t.skillDetail.showRaw} showRendered={t.skillDetail.showRendered} />
        </div>
        {adapterPatch === undefined ? null : <div className="adapter-patch"><strong>{t.skillDetail.codexAdaptation}</strong><p>{adapterPatch.patchSummary}</p></div>}
      </article> : null}

      {activeTab === "definition" ? <div className="detail-grid">
        <article className="panel"><div className="panel-title"><h2>{t.skillDetail.eyebrow}</h2><span>review required</span></div><pre className="code-view">{JSON.stringify(skill.ir, null, 2)}</pre></article>
        <article className="panel"><div className="panel-title"><h2>{t.skillDetail.contractsSecurity}</h2></div><dl className="definition-list"><dt>Triggers</dt><dd>{skill.ir?.triggers.join(" · ")}</dd><dt>Inputs</dt><dd>{skill.ir?.inputs.join(" · ") || t.skillDetail.noneShort}</dd><dt>Outputs</dt><dd>{skill.ir?.outputs.join(" · ")}</dd><dt>Forbidden actions</dt><dd>{skill.ir?.forbidden_actions.join(" · ") || t.skillDetail.noneShort}</dd><dt>Required context</dt><dd>{skill.ir?.required_context.join(" · ") || t.skillDetail.noneShort}</dd><dt>Provenance</dt><dd>{skill.ir?.source_provenance ?? t.skillDetail.provenanceDefault}</dd></dl></article>
      </div> : null}

      {activeTab === "versions" ? <div className="detail-grid">
        <article className="panel"><div className="panel-title"><h2>{t.skillDetail.versionHistory}</h2><span>{versions.length}</span></div>{versions.map((version) => <div className="version-row" key={version.version}><div><strong>v{version.version}</strong><code>{version.source_proposal_id ?? "bootstrap"}</code></div><span>{new Date(version.created_at).toLocaleString()}</span></div>)}</article>
        <article className="panel"><div className="panel-title"><h2>Version Diff</h2><span>{previous === undefined ? "first version" : `${previous.version} → ${skill.latest_version}`}</span></div><div className="diff-panel"><pre>{previous === undefined ? "No previous version." : JSON.stringify(previous.ir, null, 2)}</pre><pre>{JSON.stringify(skill.ir, null, 2)}</pre></div></article>
      </div> : null}

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
    `${skill.name} ${skill.description} ${skill.category}`.toLowerCase().includes(skillNeedle));

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
          <label>{t.workflows.addPublishedSkill}<select value="" onChange={(event) => event.target.value !== "" && setForm({ ...form, skill_slugs: [...form.skill_slugs, event.target.value] })}><option value="">{t.workflows.selectSkill}</option>{skills.filter((skill) => !form.skill_slugs.includes(skill.slug) && skill.adapters.includes(form.default_agent) && skill.ir?.profiles[form.profile]?.enabled).map((skill) => <option value={skill.slug} key={skill.skill_id}>{skill.name}</option>)}</select></label>
          <div className="actions"><button disabled={!form.name || !form.key || !form.description} onClick={() => void save()}>{t.workflows.save}</button>{revision === null ? null : <button className="secondary danger" onClick={() => void remove()}>{t.workflows.archiveDelete}</button>}</div>
        </div>
        <div className="panel skill-library"><div className="panel-title"><h2>{t.workflows.availableSkills}</h2><span>{filteredLibrarySkills.length}</span></div><label className="rail-search">{t.workflows.searchAvailableSkills}<input value={skillQuery} onChange={(event) => setSkillQuery(event.target.value)} placeholder={t.workflows.availablePlaceholder} /></label>{filteredLibrarySkills.length === 0 ? <Empty>{t.workflows.noAvailable}</Empty> : filteredLibrarySkills.map((skill) => <div className="library-item" key={skill.skill_id}><div><strong>{skill.name}</strong><p>{skill.description}</p></div><Status value={skill.category} /></div>)}</div>
      </div>
      {error === null ? null : <div className="notice danger">{error}</div>}
    </section>
  );
}
