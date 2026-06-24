"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import type { RegistryWorkflow } from "@hunter-harness/contracts";

import { ApiClientError, browserApi, type HunterApi } from "../lib/api";
import { useI18n } from "../lib/i18n";
import { mockApi } from "../lib/mock-api";

function resolveApi(): HunterApi {
  return process.env.NEXT_PUBLIC_HUNTER_HARNESS_DEMO === "true" ? mockApi : browserApi();
}

function required<K extends keyof HunterApi>(api: HunterApi, key: K): NonNullable<HunterApi[K]> {
  const method = api[key];
  if (typeof method !== "function") throw new Error(`API capability ${String(key)} is unavailable`);
  return method.bind(api) as NonNullable<HunterApi[K]>;
}

function apiError(error: unknown, t: ReturnType<typeof useI18n>["t"]): string {
  if (error instanceof ApiClientError && error.status === 401) return t.error.authRequiredSettings;
  if (error instanceof ApiClientError) return t.error.apiFailed.replace("{code}", error.code);
  return t.error.opFailed;
}

function Status({ value }: { value: string }) {
  return <span className={`status status-${value.replaceAll("_", "-")}`}>{value.replaceAll("_", " ")}</span>;
}

export function WorkflowList({ api: apiValue }: { api?: HunterApi }) {
  const { t } = useI18n();
  const api = useMemo(() => apiValue ?? resolveApi(), [apiValue]);
  const [workflows, setWorkflows] = useState<RegistryWorkflow[] | null>(null);
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  async function refresh(): Promise<void> {
    try {
      const items = await required(api, "listWorkflows")();
      setWorkflows(items);
      setError(null);
    } catch (reason) {
      setError(apiError(reason, t));
    }
  }

  useEffect(() => { void refresh(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [api]);

  async function remove(workflow: RegistryWorkflow): Promise<void> {
    if (!window.confirm(t.workflows.deleteConfirm)) return;
    try {
      await required(api, "deleteWorkflow")(workflow.workflow_id, workflow.revision);
      setMessage(t.workflows.deleted);
      await refresh();
    } catch (reason) {
      setError(t.workflows.deleteFailed + (reason instanceof Error ? reason.message : String(reason)));
    }
  }

  const needle = query.trim().toLowerCase();
  const filtered = (workflows ?? []).filter((w) =>
    needle === "" || `${w.name} ${w.key} ${w.profile}`.toLowerCase().includes(needle)
  );

  return (
    <section className="stack governance-page">
      <header className="page-heading command-hero">
        <div>
          <p className="eyebrow">{t.workflows.eyebrow}</p>
          <h1>{t.workflows.title}</h1>
          <p className="lede">{t.workflows.description}</p>
        </div>
        <Link className="primary-button" href="/workflows/new">+ {t.workflows.newWorkflow}</Link>
      </header>

      <div className="workflow-list-toolbar">
        <label className="search-wide">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t.workflows.searchPlaceholder} />
        </label>
        <span className="muted-stat">{filtered.length} / {workflows?.length ?? 0}</span>
      </div>

      {workflows === null ? (
        <div className="skeleton-block" />
      ) : workflows.length === 0 ? (
        <div className="empty-state">{t.workflows.noWorkflows}</div>
      ) : filtered.length === 0 ? (
        <div className="empty-state">{t.workflows.noMatch}</div>
      ) : (
        <div className="workflow-table-wrap">
          <table className="workflow-table">
            <thead>
              <tr>
                <th>{t.workflows.table.name}</th>
                <th>{t.workflows.table.profile}</th>
                <th>{t.workflows.table.skills}</th>
                <th>{t.workflows.table.agent}</th>
                <th>{t.workflows.table.status}</th>
                <th>{t.workflows.table.modified}</th>
                <th className="col-actions">{t.workflows.table.actions}</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((wf) => (
                <tr key={wf.workflow_id}>
                  <td>
                    <Link className="row-link" href={`/workflows/${wf.workflow_id}`}>
                      <strong>{wf.name}</strong>
                      <code>{wf.key}</code>
                    </Link>
                  </td>
                  <td><span className="meta-chip">{wf.profile}</span></td>
                  <td className="col-num">{wf.skill_slugs.length}</td>
                  <td className="muted-cell">{wf.default_agent}</td>
                  <td><Status value={wf.enabled ? "active" : "archived"} /></td>
                  <td className="muted-cell">{new Date(wf.updated_at).toLocaleDateString()}</td>
                  <td className="col-actions">
                    <Link className="icon-btn" href={`/workflows/${wf.workflow_id}`} aria-label={t.workflows.view} title={t.workflows.view}>
                      <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z" /><circle cx="12" cy="12" r="3" /></svg>
                    </Link>
                    <button className="icon-btn icon-btn-danger" type="button" onClick={() => void remove(wf)} aria-label={t.common.delete} title={t.common.delete}>
                      <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" /></svg>
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {message === null ? null : <div className="notice success">{message}</div>}
      {error === null ? null : <div className="notice danger">{error}</div>}
    </section>
  );
}
