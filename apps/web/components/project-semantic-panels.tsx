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

const PAGE_SIZE = 25;

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

function documentStatus(document: SemanticDocument, lang: "zh" | "en"): string {
  const status = document.metadata.status;
  if (typeof status === "string" && status.trim() !== "") return status;
  return lang === "zh" ? "有效" : "Active";
}

function DocumentBrowser({
  items, selectedId, onSelect, empty, lang, enableStatusFilter = false
}: {
  items: SemanticDocument[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  empty: string;
  lang: "zh" | "en";
  enableStatusFilter?: boolean;
}) {
  const [page, setPage] = useState(0);
  const [statusFilter, setStatusFilter] = useState("all");

  const statuses = useMemo(() => {
    if (!enableStatusFilter) return [] as string[];
    const values = new Set<string>();
    for (const item of items) {
      const status = item.metadata.status;
      if (typeof status === "string" && status.trim() !== "") values.add(status);
    }
    return [...values].sort((left, right) => left.localeCompare(right));
  }, [items, enableStatusFilter]);

  const showStatusFilters = statuses.length > 1;

  const filtered = useMemo(() => {
    if (!showStatusFilters || statusFilter === "all") return items;
    return items.filter((item) => String(item.metadata.status ?? "") === statusFilter);
  }, [items, showStatusFilters, statusFilter]);

  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage = Math.min(page, pageCount - 1);
  const pageItems = filtered.slice(safePage * PAGE_SIZE, (safePage + 1) * PAGE_SIZE);
  const selected = filtered.find((item) => item.document_id === selectedId)
    ?? items.find((item) => item.document_id === selectedId)
    ?? pageItems[0]
    ?? null;

  useEffect(() => {
    setPage(0);
  }, [items, statusFilter]);

  useEffect(() => {
    if (!showStatusFilters && statusFilter !== "all") setStatusFilter("all");
  }, [showStatusFilters, statusFilter]);

  useEffect(() => {
    if (selectedId === null || filtered.length === 0) return;
    const index = filtered.findIndex((item) => item.document_id === selectedId);
    if (index < 0) return;
    const nextPage = Math.floor(index / PAGE_SIZE);
    setPage((current) => (current === nextPage ? current : nextPage));
  }, [selectedId, filtered]);

  if (items.length === 0) return <div className="knowledge-empty"><span>◇</span><p>{empty}</p></div>;

  const copy = lang === "zh" ? {
    all: "全部状态",
    page: (current: number, total: number, count: number) => `第 ${current}/${total} 页 · ${count} 条`,
    prev: "上一页",
    next: "下一页",
    emptyFilter: "当前筛选下没有条目。"
  } : {
    all: "All statuses",
    page: (current: number, total: number, count: number) => `Page ${current}/${total} · ${count} items`,
    prev: "Previous",
    next: "Next",
    emptyFilter: "No items match this filter."
  };

  return <div className="knowledge-browser">
    <div className="knowledge-list-pane">
      {showStatusFilters ? <div className="knowledge-status-filters" role="toolbar" aria-label={lang === "zh" ? "按状态筛选" : "Filter by status"}>
        <button type="button" className={statusFilter === "all" ? "selected" : ""} onClick={() => setStatusFilter("all")}>{copy.all}</button>
        {statuses.map((status) => <button key={status} type="button" className={statusFilter === status ? "selected" : ""} onClick={() => setStatusFilter(status)}>{status}</button>)}
      </div> : null}
      <div className="knowledge-list">
        {pageItems.length === 0 ? <div className="knowledge-empty compact"><p>{copy.emptyFilter}</p></div> : pageItems.map((item) => <button key={item.document_id} type="button" className={item.document_id === selected?.document_id ? "selected" : ""} onClick={() => onSelect(item.document_id)}>
          <span className="knowledge-kind-icon">{item.kind === "rule" ? "R" : item.kind === "archive_record" ? "V" : "K"}</span>
          <span><strong>{item.title}</strong><small>{humanKind(item, lang)} · {documentStatus(item, lang)}</small></span>
          <i>›</i>
        </button>)}
      </div>
      <div className="knowledge-pager">
        <span>{copy.page(safePage + 1, pageCount, filtered.length)}</span>
        <div>
          <button type="button" className="text-button" disabled={safePage <= 0} onClick={() => setPage((current) => Math.max(0, current - 1))}>{copy.prev}</button>
          <button type="button" className="text-button" disabled={safePage >= pageCount - 1} onClick={() => setPage((current) => Math.min(pageCount - 1, current + 1))}>{copy.next}</button>
        </div>
      </div>
    </div>
    <article className="knowledge-preview">
      {selected === null ? <div className="knowledge-empty"><span>◇</span><p>{empty}</p></div> : <>
        <header><div><span>{humanKind(selected, lang)}</span><h2>{selected.title}</h2></div><p className="knowledge-source-path" title={selected.source_path}>{lang === "zh" ? "来源" : "Source"} · <code>{selected.source_path}</code></p></header>
        <div className="knowledge-body"><MarkdownDocument content={selected.body} /></div>
        <footer>{Object.entries(selected.metadata).filter(([, value]) => typeof value === "string" || Array.isArray(value)).slice(0, 5).map(([key, value]) => <span key={key}>{key}: {Array.isArray(value) ? value.join(", ") : String(value)}</span>)}</footer>
      </>}
    </article>
  </div>;
}

function edgeKindLabel(kind: SemanticEdge["kind"], lang: "zh" | "en"): string {
  const zh: Record<SemanticEdge["kind"], string> = {
    references_path: "引用",
    supersedes: "取代",
    conflicts_with: "冲突",
    shared_scope: "共享源码",
    related_archive: "关联变更",
    tag_cooccurrence: "共享标签"
  };
  return lang === "zh" ? zh[kind] : kind.replaceAll("_", " ");
}

function RelationWorkbench({
  graph,
  candidates,
  selectedId,
  onSelect,
  lang
}: {
  graph: ProjectSemanticGraph;
  candidates: SemanticDocument[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  lang: "zh" | "en";
}) {
  const [focusQuery, setFocusQuery] = useState("");
  const [kindFilter, setKindFilter] = useState<"all" | SemanticEdge["kind"]>("all");
  const [neighbourPage, setNeighbourPage] = useState(1);
  const NEIGHBOUR_PAGE_SIZE = 12;

  const copy = lang === "zh" ? {
    focus: "当前中心",
    focusSearch: "搜索条目，切换探索中心",
    focusHint: "同一时间只有一个中心。这里只展示与它直接相连的关系（一跳），不会一次展开全库。",
    health: (indexed: number, edges: number, neighbours: number) =>
      `索引 ${indexed} · 与中心直接相关 ${neighbours} 条` + (edges !== neighbours ? `（接口返回 ${edges} 条）` : ""),
    emptyTitle: "暂未发现可展示的知识关系",
    emptyBody: (indexed: number) =>
      `已索引 ${indexed} 份文档。系统不会把孤立节点画成装饰圆环；当知识声明取代、冲突、共享源码或引用后，选一个中心条目即可查看它的直接关系。`,
    neighbourhood: "直接关系",
    ego: "邻域示意",
    egoMore: (hidden: number) => `示意最多 12 个邻居；另有 ${hidden} 个请看左侧列表。`,
    allKinds: "全部类型",
    noMatch: "当前筛选下没有直接关系。",
    setFocus: "设为中心",
    outbound: "指出",
    inbound: "指入",
    noFocus: "请选择一个中心条目。",
    page: (current: number, total: number, count: number) => `第 ${current}/${total} 页 · ${count} 条`
  } : {
    focus: "Current center",
    focusSearch: "Search to change the exploration center",
    focusHint: "Only one center at a time. This view shows direct (one-hop) relations around it — never the whole library at once.",
    health: (indexed: number, edges: number, neighbours: number) =>
      `${indexed} indexed · ${neighbours} direct relations` + (edges !== neighbours ? ` (${edges} from API)` : ""),
    emptyTitle: "No useful knowledge relationships yet",
    emptyBody: (indexed: number) =>
      `${indexed} documents are indexed. Isolated nodes are not drawn as decoration; pick a center document to inspect its declared supersedes, conflicts, shared-source, and references.`,
    neighbourhood: "Direct relations",
    ego: "Neighbourhood sketch",
    egoMore: (hidden: number) => `Sketch shows up to 12 neighbours; ${hidden} more are in the list.`,
    allKinds: "All types",
    noMatch: "No direct relations match this filter.",
    setFocus: "Make center",
    outbound: "Out",
    inbound: "In",
    noFocus: "Choose a center document.",
    page: (current: number, total: number, count: number) => `Page ${current}/${total} · ${count}`
  };

  const focus = useMemo(() => {
    const focusId = graph.focus_document_id ?? selectedId;
    return graph.nodes.find((node) => node.document_id === focusId)
      ?? candidates.find((node) => node.document_id === focusId)
      ?? graph.nodes[0]
      ?? candidates[0]
      ?? null;
  }, [graph, selectedId, candidates]);

  useEffect(() => {
    setNeighbourPage(1);
    setKindFilter("all");
  }, [focus?.document_id]);

  useEffect(() => {
    setNeighbourPage(1);
  }, [kindFilter]);

  const filteredCandidates = useMemo(() => {
    const needle = focusQuery.trim().toLowerCase();
    const limit = needle === "" ? 12 : 24;
    const pool = needle === ""
      ? candidates
      : candidates.filter((item) =>
        item.title.toLowerCase().includes(needle)
        || item.source_path.toLowerCase().includes(needle)
      );
    const focusId = focus?.document_id;
    const ordered = focusId === undefined
      ? pool
      : [
        ...pool.filter((item) => item.document_id === focusId),
        ...pool.filter((item) => item.document_id !== focusId)
      ];
    return ordered.slice(0, limit);
  }, [candidates, focusQuery, focus]);

  const presentKinds = useMemo(() => {
    const kinds = new Set<SemanticEdge["kind"]>();
    for (const edge of graph.edges) kinds.add(edge.kind);
    return [...kinds].sort((left, right) => left.localeCompare(right));
  }, [graph.edges]);

  const neighbourhood = useMemo(() => {
    if (focus === null) return [];
    return graph.edges
      .filter((edge) =>
        edge.from_document_id === focus.document_id || edge.to_document_id === focus.document_id
      )
      .filter((edge) => kindFilter === "all" || edge.kind === kindFilter)
      .map((edge) => {
        const outbound = edge.from_document_id === focus.document_id;
        const otherId = outbound ? edge.to_document_id : edge.from_document_id;
        const other = graph.nodes.find((node) => node.document_id === otherId)
          ?? candidates.find((node) => node.document_id === otherId)
          ?? null;
        return { edge, outbound, other };
      })
      .sort((left, right) => {
        const kindCmp = left.edge.kind.localeCompare(right.edge.kind);
        if (kindCmp !== 0) return kindCmp;
        return (left.other?.title ?? "").localeCompare(right.other?.title ?? "");
      });
  }, [graph, focus, kindFilter, candidates]);

  const neighbourPages = Math.max(1, Math.ceil(neighbourhood.length / NEIGHBOUR_PAGE_SIZE));
  const pagedNeighbourhood = neighbourhood.slice(
    (neighbourPage - 1) * NEIGHBOUR_PAGE_SIZE,
    neighbourPage * NEIGHBOUR_PAGE_SIZE
  );

  const grouped = useMemo(() => {
    const map = new Map<SemanticEdge["kind"], typeof neighbourhood>();
    for (const item of pagedNeighbourhood) {
      const list = map.get(item.edge.kind) ?? [];
      list.push(item);
      map.set(item.edge.kind, list);
    }
    return [...map.entries()];
  }, [pagedNeighbourhood]);

  const width = 520;
  const height = 360;
  const egoOthers = useMemo(() => [...new Map(
    neighbourhood
      .filter((item) => item.other !== null)
      .map((item) => [item.other!.document_id, item] as const)
  ).values()], [neighbourhood]);
  const egoVisible = egoOthers.slice(0, 12);
  const egoHidden = Math.max(0, egoOthers.length - egoVisible.length);

  const egoPoints = useMemo(() => {
    const result = new Map<string, { x: number; y: number; label: string }>();
    if (focus === null) return result;
    result.set(focus.document_id, { x: width / 2, y: height / 2, label: focus.title });
    egoVisible.forEach((item, index) => {
      const angle = (Math.PI * 2 * index) / Math.max(1, egoVisible.length) - Math.PI / 2;
      result.set(item.other!.document_id, {
        x: width / 2 + Math.cos(angle) * 140,
        y: height / 2 + Math.sin(angle) * 120,
        label: item.other!.title
      });
    });
    return result;
  }, [focus, egoVisible]);

  const focusChrome = <>
    <div className="relation-toolbar">
      <label className="relation-focus-search">
        <span>{copy.focus}</span>
        <input
          aria-label={copy.focusSearch}
          placeholder={copy.focusSearch}
          value={focusQuery}
          onChange={(event) => setFocusQuery(event.target.value)}
        />
      </label>
      <p className="relation-health">{copy.health(graph.indexed_documents, graph.edges.length, neighbourhood.length)}</p>
    </div>
    <p className="relation-focus-hint">{copy.focusHint}</p>
    {focus !== null ? <div className="relation-center-chip">
      <span>{copy.focus}</span>
      <strong>{focus.title}</strong>
      <small>{focus.source_path}</small>
    </div> : null}
  </>;

  if (graph.relation_status === "no_relations" || graph.edges.length === 0) {
    return <div className="relation-workbench">
      {focusChrome}
      <div className="relation-empty">
        <div className="relation-empty-visual"><span /><span /><span /></div>
        <h2>{copy.emptyTitle}</h2>
        <p>{copy.emptyBody(graph.indexed_documents)}</p>
      </div>
      {filteredCandidates.length > 0 ? <div className="relation-focus-candidates" role="listbox" aria-label={copy.focus}>
        {filteredCandidates.map((item) => <button
          key={item.document_id}
          type="button"
          role="option"
          aria-selected={item.document_id === focus?.document_id}
          className={item.document_id === focus?.document_id ? "selected" : ""}
          onClick={() => onSelect(item.document_id)}
        >
          <strong>{item.title}</strong>
          <small>{item.source_path}</small>
        </button>)}
      </div> : null}
    </div>;
  }

  if (focus === null) {
    return <div className="relation-workbench"><p className="project-empty-copy">{copy.noFocus}</p></div>;
  }

  return <div className="relation-workbench">
    {focusChrome}
    <div className="relation-focus-candidates" role="listbox" aria-label={copy.focus}>
      {filteredCandidates.map((item) => <button
        key={item.document_id}
        type="button"
        role="option"
        aria-selected={item.document_id === focus.document_id}
        className={item.document_id === focus.document_id ? "selected" : ""}
        onClick={() => onSelect(item.document_id)}
      >
        <strong>{item.title}</strong>
        <small>{item.source_path}</small>
      </button>)}
    </div>
    <div className="relation-layout">
      <section className="relation-neighbourhood">
        <header>
          <h3>{copy.neighbourhood}</h3>
          {presentKinds.length > 1 ? <div className="relation-kind-filters" role="toolbar" aria-label={lang === "zh" ? "按关系类型筛选" : "Filter by relation kind"}>
            <button type="button" className={kindFilter === "all" ? "selected" : ""} onClick={() => setKindFilter("all")}>{copy.allKinds}</button>
            {presentKinds.map((kind) => <button
              key={kind}
              type="button"
              className={kindFilter === kind ? "selected" : ""}
              onClick={() => setKindFilter(kind)}
            >{edgeKindLabel(kind, lang)}</button>)}
          </div> : null}
        </header>
        {grouped.length === 0 ? <p className="project-empty-copy">{copy.noMatch}</p> : <>
          {grouped.map(([kind, items]) => <div key={kind} className="relation-group">
            <h4>{edgeKindLabel(kind, lang)} · {items.length}</h4>
            <ul>
              {items.map(({ edge, outbound, other }) => <li key={edge.edge_id}>
                <span className="relation-direction">{outbound ? copy.outbound : copy.inbound}</span>
                <div>
                  <strong>{other?.title ?? "—"}</strong>
                  <small>{other?.source_path ?? edge.edge_id}</small>
                </div>
                {other === null ? null : <button type="button" className="text-button" onClick={() => onSelect(other.document_id)}>{copy.setFocus}</button>}
              </li>)}
            </ul>
          </div>)}
          {neighbourPages > 1 ? <div className="relation-pager">
            <span>{copy.page(neighbourPage, neighbourPages, neighbourhood.length)}</span>
            <div>
              <button type="button" className="text-button" disabled={neighbourPage <= 1} onClick={() => setNeighbourPage((page) => page - 1)}>{lang === "zh" ? "上一页" : "Prev"}</button>
              <button type="button" className="text-button" disabled={neighbourPage >= neighbourPages} onClick={() => setNeighbourPage((page) => page + 1)}>{lang === "zh" ? "下一页" : "Next"}</button>
            </div>
          </div> : null}
        </>}
      </section>
      <aside className="relation-ego" aria-label={copy.ego}>
        <h3>{copy.ego}</h3>
        <svg className="relation-map" viewBox={`0 0 ${width} ${height}`} role="img">
          <defs>
            <marker id="relation-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
              <path d="M0,0 L8,4 L0,8 z" fill="currentColor" />
            </marker>
          </defs>
          {egoVisible.map(({ edge, other }) => {
            if (other === null) return null;
            const from = egoPoints.get(edge.from_document_id);
            const to = egoPoints.get(edge.to_document_id);
            if (from === undefined || to === undefined) return null;
            const midX = (from.x + to.x) / 2;
            const midY = (from.y + to.y) / 2;
            return <g key={`edge-${edge.edge_id}`}>
              <line x1={from.x} y1={from.y} x2={to.x} y2={to.y} markerEnd="url(#relation-arrow)" />
              <text className="relation-edge-label" x={midX} y={midY - 6} textAnchor="middle">{edgeKindLabel(edge.kind, lang)}</text>
            </g>;
          })}
          {[...egoPoints.entries()].map(([id, point]) => {
            const isFocus = id === focus.document_id;
            const title = point.label.length > (isFocus ? 18 : 14) ? `${point.label.slice(0, isFocus ? 18 : 14)}…` : point.label;
            return <g
              key={id}
              className={isFocus ? "focus" : ""}
              transform={`translate(${point.x}, ${point.y})`}
              onClick={() => onSelect(id)}
              onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") onSelect(id); }}
              role="button"
              tabIndex={0}
            >
              <circle r={isFocus ? 40 : 26} />
              <title>{point.label}</title>
              <text textAnchor="middle" dy="4">{title}</text>
            </g>;
          })}
        </svg>
        <p className="relation-ego-caption"><strong>{focus.title}</strong></p>
        {egoHidden > 0 ? <p className="relation-ego-more">{copy.egoMore(egoHidden)}</p> : null}
      </aside>
    </div>
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
    setHits(null);
    setQuery("");
    setSelectedId(null);
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
    {tab === "relations" ? graph === null ? <div className="empty-state">{copy.loading}</div> : <RelationWorkbench
      graph={graph}
      candidates={[...data.knowledge, ...data.rules, ...data.changes]}
      selectedId={selectedId}
      onSelect={setSelectedId}
      lang={lang}
    /> : <DocumentBrowser items={items} selectedId={selectedId} onSelect={setSelectedId} empty={tab === "rules" ? copy.noRules : tab === "changes" ? copy.noChanges : copy.noKnowledge} lang={lang} enableStatusFilter={tab === "library"} />}
    {error === null || data === null ? null : <div className="notice danger">{error}</div>}
  </section>;
}
