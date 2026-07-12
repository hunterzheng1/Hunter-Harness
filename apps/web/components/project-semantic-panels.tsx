"use client";

import { useEffect, useMemo, useState } from "react";
import type { SemanticDocument, SemanticEdge, SemanticOverview } from "@hunter-harness/contracts";

import type { HunterApi } from "../lib/api";
import { useI18n } from "../lib/i18n";

type SemanticTab = "overview" | "knowledge" | "rules" | "changes" | "graph";

interface SemanticData {
  overview: SemanticOverview;
  knowledge: SemanticDocument[];
  rules: SemanticDocument[];
  changes: SemanticDocument[];
  nodes: SemanticDocument[];
  edges: SemanticEdge[];
}

function exportContextPack(projectId: string, data: SemanticData): void {
  const lines = [
    `# Context pack — ${projectId}`,
    "",
    `Artifact: ${data.overview.artifact_id ?? "—"}`,
    `Documents: ${data.overview.counts.documents}`,
    "",
    "## Knowledge",
    ...data.knowledge.flatMap((item) => [`### ${item.title}`, item.body, ""]),
    "## Rules",
    ...data.rules.flatMap((item) => [`### ${item.title}`, item.body, ""]),
    "## Changes",
    ...data.changes.flatMap((item) => [`### ${item.title}`, item.body, ""])
  ];
  const blob = new Blob([lines.join("\n")], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `context-pack-${projectId}.md`;
  anchor.click();
  URL.revokeObjectURL(url);
}

function DocumentList({
  items,
  selectedId,
  onSelect,
  empty
}: {
  items: SemanticDocument[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  empty: string;
}) {
  if (items.length === 0) return <div className="empty-state">{empty}</div>;
  return (
    <div className="source-package-grid">
      <div className="source-file-tree">
        {items.map((item) => (
          <button
            key={item.document_id}
            type="button"
            className={item.document_id === selectedId ? "selected" : ""}
            onClick={() => onSelect(item.document_id)}
          >
            {item.title}
            <small>{item.kind}</small>
          </button>
        ))}
      </div>
      <div className="file-preview">
        {selectedId === null ? (
          <div className="empty-state">—</div>
        ) : (
          <pre className="code-view content-preview">
            {items.find((item) => item.document_id === selectedId)?.body ?? ""}
          </pre>
        )}
      </div>
    </div>
  );
}

function SemanticGraph({ nodes, edges }: { nodes: SemanticDocument[]; edges: SemanticEdge[] }) {
  const width = 640;
  const height = 360;
  const positioned = useMemo(() => {
    const cx = width / 2;
    const cy = height / 2;
    const radius = Math.min(width, height) * 0.36;
    return nodes.map((node, index) => {
      const angle = nodes.length === 0 ? 0 : (Math.PI * 2 * index) / nodes.length - Math.PI / 2;
      return {
        ...node,
        x: cx + radius * Math.cos(angle),
        y: cy + radius * Math.sin(angle)
      };
    });
  }, [nodes]);
  const byId = new Map(positioned.map((node) => [node.document_id, node]));

  if (nodes.length === 0) return <div className="empty-state">No graph nodes</div>;

  return (
    <svg className="semantic-graph" viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Semantic graph">
      {edges.map((edge) => {
        const from = byId.get(edge.from_document_id);
        const to = byId.get(edge.to_document_id);
        if (from === undefined || to === undefined) return null;
        return (
          <line
            key={edge.edge_id}
            x1={from.x}
            y1={from.y}
            x2={to.x}
            y2={to.y}
            stroke="currentColor"
            strokeOpacity={0.35}
          />
        );
      })}
      {positioned.map((node) => (
        <g key={node.document_id} transform={`translate(${node.x}, ${node.y})`}>
          <circle r={18} fill="var(--panel)" stroke="var(--accent)" />
          <title>{node.title}</title>
          <text textAnchor="middle" dy={4} fontSize={10} fill="var(--text)">
            {node.title.slice(0, 8)}
          </text>
        </g>
      ))}
    </svg>
  );
}

export function ProjectSemanticPanels({
  api,
  projectId
}: {
  api: HunterApi;
  projectId: string;
}) {
  const { t } = useI18n();
  const [tab, setTab] = useState<SemanticTab>("overview");
  const [data, setData] = useState<SemanticData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SemanticDocument[]>([]);

  useEffect(() => {
    let active = true;
    setData(null);
    setError(null);
    void (async () => {
      try {
        if (
          api.getProjectSemanticOverview === undefined ||
          api.listProjectSemanticKnowledge === undefined ||
          api.listProjectSemanticRules === undefined ||
          api.listProjectSemanticChanges === undefined ||
          api.getProjectSemanticGraph === undefined
        ) {
          throw new Error("semantic API unavailable");
        }
        const [overview, knowledge, rules, changes, graph] = await Promise.all([
          api.getProjectSemanticOverview(projectId),
          api.listProjectSemanticKnowledge(projectId),
          api.listProjectSemanticRules(projectId),
          api.listProjectSemanticChanges(projectId),
          api.getProjectSemanticGraph(projectId)
        ]);
        if (!active) return;
        setData({ overview, knowledge, rules, changes, nodes: graph.nodes, edges: graph.edges });
        setSelectedId(knowledge[0]?.document_id ?? null);
      } catch {
        if (active) setError(t.semantic.loadFailed);
      }
    })();
    return () => { active = false; };
  }, [api, projectId, t.semantic.loadFailed]);

  async function runSearch(): Promise<void> {
    if (api.searchSemanticDocuments === undefined || query.trim() === "") {
      setHits([]);
      return;
    }
    const result = await api.searchSemanticDocuments(query.trim(), projectId);
    setHits(result.map((item) => item.document));
  }

  if (error !== null) return <div className="notice">{error}</div>;
  if (data === null) return <div className="empty-state">{t.semantic.loading}</div>;

  const tabs: Array<{ id: SemanticTab; label: string }> = [
    { id: "overview", label: t.semantic.tabOverview },
    { id: "knowledge", label: t.semantic.tabKnowledge },
    { id: "rules", label: t.semantic.tabRules },
    { id: "changes", label: t.semantic.tabChanges },
    { id: "graph", label: t.semantic.tabGraph }
  ];

  return (
    <section className="stack">
      <div className="actions">
        <button type="button" className="secondary" onClick={() => exportContextPack(projectId, data)}>
          {t.semantic.exportPack}
        </button>
      </div>
      <div className="skill-detail-tabs" role="tablist" aria-label={t.semantic.tabsLabel}>
        {tabs.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={tab === item.id}
            className={tab === item.id ? "selected" : ""}
            onClick={() => setTab(item.id)}
          >
            {item.label}
          </button>
        ))}
      </div>

      {tab === "overview" ? (
        <div className="panel">
          <div className="metric-grid compact">
            <article className="metric"><strong>{data.overview.counts.documents}</strong><span>{t.semantic.documents}</span></article>
            <article className="metric"><strong>{data.overview.counts.knowledge}</strong><span>{t.semantic.knowledge}</span></article>
            <article className="metric"><strong>{data.overview.counts.rules}</strong><span>{t.semantic.rules}</span></article>
            <article className="metric"><strong>{data.overview.counts.changes}</strong><span>{t.semantic.changes}</span></article>
            <article className="metric"><strong>{data.overview.counts.edges}</strong><span>{t.semantic.edges}</span></article>
          </div>
          <p className="lede">{t.semantic.artifact}: <code>{data.overview.artifact_id ?? "—"}</code></p>
        </div>
      ) : null}

      {tab === "knowledge" ? (
        <div className="panel stack">
          <div className="actions">
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t.semantic.searchPlaceholder}
              aria-label={t.semantic.searchPlaceholder}
            />
            <button type="button" onClick={() => void runSearch()}>{t.semantic.search}</button>
          </div>
          <DocumentList
            items={hits.length > 0 ? hits : data.knowledge}
            selectedId={selectedId}
            onSelect={setSelectedId}
            empty={t.semantic.noKnowledge}
          />
        </div>
      ) : null}

      {tab === "rules" ? (
        <div className="panel">
          <DocumentList
            items={data.rules}
            selectedId={selectedId}
            onSelect={setSelectedId}
            empty={t.semantic.noRules}
          />
        </div>
      ) : null}

      {tab === "changes" ? (
        <div className="panel">
          <DocumentList
            items={data.changes}
            selectedId={selectedId}
            onSelect={setSelectedId}
            empty={t.semantic.noChanges}
          />
        </div>
      ) : null}

      {tab === "graph" ? (
        <div className="panel">
          <SemanticGraph nodes={data.nodes} edges={data.edges} />
          <p className="lede">{data.nodes.length} nodes · {data.edges.length} edges</p>
        </div>
      ) : null}
    </section>
  );
}
