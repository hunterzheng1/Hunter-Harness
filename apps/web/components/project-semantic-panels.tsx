"use client";

import type { SemanticDocument, SemanticEdge, SemanticOverview } from "@hunter-harness/contracts";
import { useEffect, useMemo, useState } from "react";

import type { HunterApi, ProjectSemanticGraph } from "../lib/api";
import { useI18n } from "../lib/i18n";
import { MarkdownDocument } from "./skill-shared";

type SemanticTab = "library" | "rules" | "changes" | "relations";

interface SemanticData {
  overview: SemanticOverview;
  knowledge: SemanticDocument[];
  rules: SemanticDocument[];
  changes: SemanticDocument[];
}

function exportContextPack(projectId: string, data: SemanticData): void {
  const lines = [
    `# Context pack — ${projectId}`, "", `Documents: ${data.overview.counts.documents}`, "",
    "## Knowledge", ...data.knowledge.flatMap((item) => [`### ${item.title}`, item.body, ""]),
    "## Rules", ...data.rules.flatMap((item) => [`### ${item.title}`, item.body, ""]),
    "## Changes", ...data.changes.flatMap((item) => [`### ${item.title}`, item.body, ""])
  ];
  const url = URL.createObjectURL(new Blob([lines.join("\n")], { type: "text/markdown;charset=utf-8" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `context-pack-${projectId}.md`;
  anchor.click();
  URL.revokeObjectURL(url);
}

function humanKind(document: SemanticDocument, lang: "zh" | "en"): string {
  const labels = lang === "zh" ? {
    knowledge_entry: "知识条目", knowledge_markdown: "知识文档", rule: "项目规则",
    archive_record: "变更总结", agent_instruction: "Agent 指令"
  } : {
    knowledge_entry: "Knowledge entry", knowledge_markdown: "Knowledge document", rule: "Project rule",
    archive_record: "Change summary", agent_instruction: "Agent instruction"
  };
  return labels[document.kind];
}

function DocumentBrowser({
  items, selectedId, onSelect, empty, lang
}: {
  items: SemanticDocument[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  empty: string;
  lang: "zh" | "en";
}) {
  const selected = items.find((item) => item.document_id === selectedId) ?? items[0] ?? null;
  if (items.length === 0) return <div className="knowledge-empty"><span>◇</span><p>{empty}</p></div>;
  return <div className="knowledge-browser">
    <div className="knowledge-list">
      {items.map((item) => <button key={item.document_id} type="button" className={item.document_id === selected?.document_id ? "selected" : ""} onClick={() => onSelect(item.document_id)}>
        <span className="knowledge-kind-icon">{item.kind === "rule" ? "R" : item.kind === "archive_record" ? "V" : "K"}</span>
        <span><strong>{item.title}</strong><small>{humanKind(item, lang)} · {String(item.metadata.status ?? (lang === "zh" ? "有效" : "Active"))}</small></span>
        <i>›</i>
      </button>)}
    </div>
    <article className="knowledge-preview">
      {selected === null ? null : <>
        <header><div><span>{humanKind(selected, lang)}</span><h2>{selected.title}</h2></div><details><summary>{lang === "zh" ? "技术详情" : "Technical details"}</summary><code>{selected.source_path}</code></details></header>
        <div className="knowledge-body"><MarkdownDocument content={selected.body} /></div>
        <footer>{Object.entries(selected.metadata).filter(([, value]) => typeof value === "string" || Array.isArray(value)).slice(0, 5).map(([key, value]) => <span key={key}>{key}: {Array.isArray(value) ? value.join(", ") : String(value)}</span>)}</footer>
      </>}
    </article>
  </div>;
}

function RelationMap({
  graph, selectedId, onSelect, lang
}: {
  graph: ProjectSemanticGraph;
  selectedId: string | null;
  onSelect: (id: string) => void;
  lang: "zh" | "en";
}) {
  const width = 760;
  const height = 440;
  const focus = graph.nodes.find((node) => node.document_id === (graph.focus_document_id ?? selectedId)) ?? graph.nodes[0];
  const neighbours = graph.nodes.filter((node) => node.document_id !== focus?.document_id).slice(0, 18);
  const positioned = useMemo(() => {
    const result = new Map<string, { x: number; y: number }>();
    if (focus !== undefined) result.set(focus.document_id, { x: width / 2, y: height / 2 });
    neighbours.forEach((node, index) => {
      const angle = (Math.PI * 2 * index) / Math.max(1, neighbours.length) - Math.PI / 2;
      result.set(node.document_id, {
        x: width / 2 + Math.cos(angle) * 165,
        y: height / 2 + Math.sin(angle) * 150
      });
    });
    return result;
  }, [focus, neighbours]);

  if (graph.relation_status === "no_relations" || graph.edges.length === 0) {
    return <div className="relation-empty">
      <div className="relation-empty-visual"><span /><span /><span /></div>
      <h2>{lang === "zh" ? "暂未发现可展示的知识关系" : "No useful knowledge relationships yet"}</h2>
      <p>{lang === "zh"
        ? `已索引 ${graph.indexed_documents} 份文档。系统不会再把孤立节点画成无意义圆环；当知识条目声明取代、冲突、共享源码或引用关系后，这里会自动出现一跳关系图。`
        : `${graph.indexed_documents} documents are indexed. Isolated nodes are intentionally not drawn; declared supersedes, conflict, shared-source, and reference relationships appear here automatically.`}</p>
    </div>;
  }

  const label = (edge: SemanticEdge): string => {
    const zh: Record<SemanticEdge["kind"], string> = {
      references_path: "引用", supersedes: "取代", conflicts_with: "冲突", shared_scope: "共享源码",
      related_archive: "关联变更", tag_cooccurrence: "共享标签"
    };
    return lang === "zh" ? zh[edge.kind] : edge.kind.replaceAll("_", " ");
  };

  return <div className="relation-layout">
    <svg className="relation-map" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={lang === "zh" ? "知识关系图" : "Knowledge relationship map"}>
      <defs><marker id="relation-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 z" fill="currentColor" /></marker></defs>
      {graph.edges.map((edge) => {
        const from = positioned.get(edge.from_document_id);
        const to = positioned.get(edge.to_document_id);
        return from === undefined || to === undefined ? null : <line key={edge.edge_id} x1={from.x} y1={from.y} x2={to.x} y2={to.y} markerEnd="url(#relation-arrow)" />;
      })}
      {graph.nodes.slice(0, 19).map((node) => {
        const point = positioned.get(node.document_id);
        if (point === undefined) return null;
        const isFocus = node.document_id === focus?.document_id;
        return <g key={node.document_id} className={isFocus ? "focus" : ""} transform={`translate(${point.x}, ${point.y})`} onClick={() => onSelect(node.document_id)} role="button" tabIndex={0}>
          <circle r={isFocus ? 44 : 29} /><text textAnchor="middle" dy="4">{node.title.slice(0, isFocus ? 11 : 7)}</text><title>{node.title}</title>
        </g>;
      })}
    </svg>
    <aside className="relation-list"><h3>{lang === "zh" ? "当前一跳关系" : "Current one-hop relations"}</h3>{graph.edges.map((edge) => {
      const otherId = edge.from_document_id === focus?.document_id ? edge.to_document_id : edge.from_document_id;
      const other = graph.nodes.find((node) => node.document_id === otherId);
      return <button type="button" key={edge.edge_id} onClick={() => other !== undefined && onSelect(other.document_id)}><span>{label(edge)}</span><strong>{other?.title ?? "—"}</strong></button>;
    })}</aside>
  </div>;
}

export function ProjectSemanticPanels({ api, projectId }: { api: HunterApi; projectId: string }) {
  const { lang } = useI18n();
  const [tab, setTab] = useState<SemanticTab>("library");
  const [data, setData] = useState<SemanticData | null>(null);
  const [graph, setGraph] = useState<ProjectSemanticGraph | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [hits, setHits] = useState<SemanticDocument[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const copy = lang === "zh" ? {
    title: "项目知识", subtitle: "从项目文件自动建立的可检索知识与关系。", library: "知识库", rules: "项目规则", changes: "变更总结", relations: "关系探索",
    search: "搜索标题、正文或路径", export: "导出上下文", noKnowledge: "暂无项目知识。", noRules: "暂无项目规则。", noChanges: "暂无变更总结。",
    loading: "正在加载项目知识…", failed: "项目知识暂不可用。", documents: "索引文档", knowledge: "知识", edges: "关系"
  } : {
    title: "Project knowledge", subtitle: "Searchable knowledge and relationships derived from project files.", library: "Knowledge library", rules: "Project rules", changes: "Change summaries", relations: "Relationship explorer",
    search: "Search titles, content, or paths", export: "Export context", noKnowledge: "No project knowledge yet.", noRules: "No project rules yet.", noChanges: "No change summaries yet.",
    loading: "Loading project knowledge…", failed: "Project knowledge is unavailable.", documents: "Indexed documents", knowledge: "Knowledge", edges: "Relationships"
  };

  useEffect(() => {
    let active = true;
    setError(null);
    void (async () => {
      if (api.getProjectSemanticOverview === undefined || api.listProjectSemanticKnowledge === undefined || api.listProjectSemanticRules === undefined || api.listProjectSemanticChanges === undefined) throw new Error("semantic API unavailable");
      const [overview, knowledge, rules, changes] = await Promise.all([
        api.getProjectSemanticOverview(projectId), api.listProjectSemanticKnowledge(projectId),
        api.listProjectSemanticRules(projectId), api.listProjectSemanticChanges(projectId)
      ]);
      if (!active) return;
      setData({ overview, knowledge, rules, changes });
      setSelectedId(knowledge[0]?.document_id ?? null);
    })().catch(() => { if (active) setError(copy.failed); });
    return () => { active = false; };
  }, [api, projectId, copy.failed]);

  useEffect(() => {
    if (tab !== "relations" || api.getProjectSemanticGraph === undefined) return;
    let active = true;
    setGraph(null);
    void api.getProjectSemanticGraph(projectId, selectedId ?? undefined)
      .then((result) => { if (active) setGraph(result); })
      .catch(() => { if (active) setError(copy.failed); });
    return () => { active = false; };
  }, [api, projectId, selectedId, tab, copy.failed]);

  async function search(): Promise<void> {
    if (query.trim() === "") { setHits(null); return; }
    setSearching(true);
    try {
      const results = await api.searchSemanticDocuments?.(query.trim(), projectId) ?? [];
      setHits(results.map((item) => item.document));
      setSelectedId(results[0]?.document.document_id ?? null);
    } finally {
      setSearching(false);
    }
  }

  if (error !== null && data === null) return <div className="empty-state">{error}</div>;
  if (data === null) return <div className="empty-state">{copy.loading}</div>;
  const items = tab === "rules" ? data.rules : tab === "changes" ? data.changes : hits ?? data.knowledge;

  return <section className="project-knowledge-v2">
    <header className="knowledge-header"><div><p className="eyebrow">{copy.title}</p><h2>{copy.subtitle}</h2></div><button type="button" className="secondary" onClick={() => exportContextPack(projectId, data)}>⇩ {copy.export}</button></header>
    <div className="knowledge-metrics"><span><strong>{data.overview.counts.documents}</strong>{copy.documents}</span><span><strong>{data.overview.counts.knowledge}</strong>{copy.knowledge}</span><span><strong>{data.overview.counts.edges}</strong>{copy.edges}</span></div>
    <div className="knowledge-controls">
      <div className="knowledge-tabs" role="tablist" aria-label={copy.title}>{(["library", "rules", "changes", "relations"] as const).map((id) => <button key={id} type="button" role="tab" aria-selected={tab === id} className={tab === id ? "selected" : ""} onClick={() => { setTab(id); setHits(null); }}>{copy[id]}</button>)}</div>
      {tab === "library" ? <div className="knowledge-search"><span>⌕</span><input aria-label={copy.search} placeholder={copy.search} value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void search(); }} /><button type="button" disabled={searching} onClick={() => void search()}>{lang === "zh" ? "搜索" : "Search"}</button></div> : null}
    </div>
    {tab === "relations" ? graph === null ? <div className="empty-state">{copy.loading}</div> : <RelationMap graph={graph} selectedId={selectedId} onSelect={setSelectedId} lang={lang} /> : <DocumentBrowser items={items} selectedId={selectedId} onSelect={setSelectedId} empty={tab === "rules" ? copy.noRules : tab === "changes" ? copy.noChanges : copy.noKnowledge} lang={lang} />}
    {error === null || data === null ? null : <div className="notice danger">{error}</div>}
  </section>;
}
