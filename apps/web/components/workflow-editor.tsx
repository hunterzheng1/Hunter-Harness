"use client";

import Link from "next/link";
import { type DragEvent, useEffect, useMemo, useState } from "react";
import type { RegistryAgent, RegistrySkillDetail, RegistryWorkflow, RegistryWorkflowMutation } from "@hunter-harness/contracts";

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

const blankForm: RegistryWorkflowMutation = {
  key: "", name: "", description: "", profile: "general", default_agent: "claude-code",
  enabled: true, skill_slugs: []
};

export function WorkflowEditor({ api: apiValue, workflowId }: { api?: HunterApi; workflowId: string }) {
  const { t } = useI18n();
  const api = useMemo(() => apiValue ?? resolveApi(), [apiValue]);
  const isNew = workflowId === "new";

  const [workflow, setWorkflow] = useState<RegistryWorkflow | null>(null);
  const [skills, setSkills] = useState<RegistrySkillDetail[]>([]);
  const [form, setForm] = useState<RegistryWorkflowMutation>(blankForm);
  const [revision, setRevision] = useState<number | null>(null);
  const [skillQuery, setSkillQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [dragIdx, setDragIdx] = useState<number | null>(null);

  async function refresh(): Promise<void> {
    try {
      const [nextSkills] = await Promise.all([
        required(api, "listSkills")()
      ]);
      setSkills(nextSkills);
      if (!isNew) {
        const nextWorkflows = await required(api, "listWorkflows")();
        const wf = nextWorkflows.find((w) => w.workflow_id === workflowId);
        if (wf === undefined) throw new Error("Workflow not found");
        setWorkflow(wf);
        setForm({ key: wf.key, name: wf.name, description: wf.description, profile: wf.profile, default_agent: wf.default_agent, enabled: wf.enabled, skill_slugs: wf.skill_slugs });
        setRevision(wf.revision);
      }
      setError(null);
    } catch (reason) {
      setError(apiError(reason, t));
    }
  }

  useEffect(() => { void refresh(); }, [api, workflowId]);

  // ── Skill binding helpers ──

  function addSkill(slug: string): void {
    if (form.skill_slugs.includes(slug)) return;
    setForm({ ...form, skill_slugs: [...form.skill_slugs, slug] });
  }

  function removeSkill(index: number): void {
    setForm({ ...form, skill_slugs: form.skill_slugs.filter((_, i) => i !== index) });
  }

  function moveSkill(from: number, to: number): void {
    if (from === to) return;
    const next = [...form.skill_slugs];
    const moved = next[from];
    if (moved === undefined) return;
    next.splice(from, 1);
    next.splice(to, 0, moved);
    setForm({ ...form, skill_slugs: next });
  }

  function onDragStart(e: DragEvent<HTMLDivElement>, index: number): void {
    setDragIdx(index);
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", String(index));
  }

  function onDragOver(e: DragEvent<HTMLDivElement>): void {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
  }

  function onDrop(e: DragEvent<HTMLDivElement>, toIndex: number): void {
    e.preventDefault();
    if (dragIdx !== null) moveSkill(dragIdx, toIndex);
    setDragIdx(null);
  }

  function onDragEnd(): void {
    setDragIdx(null);
  }

  // ── Save ──

  async function save(): Promise<void> {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      if (isNew) {
        const saved = await required(api, "createWorkflow")(form);
        setWorkflow(saved);
        setRevision(saved.revision);
        setMessage(t.workflows.saveSuccess);
      } else {
        if (revision === null) throw new Error("Workflow revision is unavailable.");
        const saved = await required(api, "updateWorkflow")(workflowId, { ...form, revision });
        setWorkflow(saved);
        setRevision(saved.revision);
        setMessage(t.workflows.saveSuccess);
      }
    } catch (reason) {
      setError(apiError(reason, t));
    } finally {
      setBusy(false);
    }
  }

  async function remove(): Promise<void> {
    if (!isNew && revision !== null && window.confirm(t.workflows.deleteConfirm)) {
      try {
        await required(api, "deleteWorkflow")(workflowId, revision);
        window.location.assign("/workflows");
      } catch (reason) {
        setError(apiError(reason, t));
      }
    }
  }

  // ── Filtered available skills ──

  const needle = skillQuery.trim().toLowerCase();
  const availableSkills = skills.filter((s) =>
    !form.skill_slugs.includes(s.slug) && s.adapters.includes(form.default_agent as RegistryAgent) &&
    s.ir?.profiles[form.profile]?.enabled &&
    (needle === "" || `${s.name} ${s.description} ${s.category}`.toLowerCase().includes(needle))
  );

  const boundSkills = form.skill_slugs.map((slug) => skills.find((s) => s.slug === slug) ?? null);

  return (
    <section className="stack governance-page">
      {/* ── Header ── */}
      <header className="workflow-editor-header">
        <Link className="back-link" href="/workflows">{t.workflows.backToList}</Link>
        <div>
          <h1>{isNew ? t.workflows.editingNew : form.name || workflow?.name}</h1>
          {workflow && <code className="workflow-id-badge">{workflow.workflow_id}</code>}
        </div>
        <div className="header-actions">
          {!isNew && <span className="revision-badge">{t.workflows.revisionLabel} {revision}</span>}
          <button className="primary-button" disabled={busy || !form.name || !form.key} onClick={() => save()}>
            {t.workflows.save}
          </button>
          {!isNew && <button className="secondary-button danger" disabled={busy} onClick={() => void remove()}>{t.workflows.archiveDelete}</button>}
        </div>
      </header>

      {/* ── Body: two-column layout ── */}
      <div className="workflow-editor-grid">
        {/* ── Left: Metadata form ── */}
        <aside className="workflow-metadata-panel">
          <div className="panel-title"><h2>{isNew ? t.workflows.editingNew : t.workflows.editingExisting}</h2></div>
          <div className="form-stack">
            <label>
              <span className="field-label">{t.workflows.name}</span>
              <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="General" />
            </label>
            <label>
              <span className="field-label">{t.workflows.key}</span>
              <input value={form.key} onChange={(e) => setForm({ ...form, key: e.target.value })} placeholder="general" />
            </label>
            <label>
              <span className="field-label">{t.workflows.description2}</span>
              <textarea value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} placeholder="…" />
            </label>
            <label>
              <span className="field-label">{t.workflows.profile}</span>
              <input value={form.profile} onChange={(e) => setForm({ ...form, profile: e.target.value })} />
            </label>
            <label>
              <span className="field-label">{t.workflows.defaultAgent}</span>
              <select value={form.default_agent} onChange={(e) => setForm({ ...form, default_agent: e.target.value as RegistryAgent })}>
                <option value="claude-code">Claude Code</option>
              </select>
            </label>
          </div>
        </aside>

        {/* ── Center: Bound skill cards ── */}
        <section className="workflow-skills-panel">
          <div className="panel-title">
            <h2>{t.workflows.orderedSkillBinding}</h2>
            <span className="panel-hint">{t.workflows.dragHint}</span>
          </div>

          {boundSkills.length === 0 ? (
            <div className="empty-state">{t.workflows.noSkillsBound}</div>
          ) : (
            <div className="skill-card-grid">
              {boundSkills.map((skill, index) => (
                <div
                  key={skill?.slug ?? index}
                  className={`skill-card ${dragIdx === index ? "dragging" : ""}`}
                  draggable
                  onDragStart={(e) => onDragStart(e, index)}
                  onDragOver={onDragOver}
                  onDrop={(e) => onDrop(e, index)}
                  onDragEnd={onDragEnd}
                >
                  <span className="card-order">{String(index + 1).padStart(2, "0")}</span>
                  <div className="card-body">
                    <strong>{skill?.name ?? form.skill_slugs[index]}</strong>
                    <div className="card-meta">
                      {skill && <Status value={skill.category} />}
                      <span>{skill?.latest_version ?? "—"}</span>
                    </div>
                  </div>
                  <button className="card-remove" type="button" onClick={() => removeSkill(index)} aria-label={t.workflows.removeSkill}>
                    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
                  </button>
                </div>
              ))}
            </div>
          )}
        </section>

        {/* ── Right: Available skills library ── */}
        <aside className="workflow-library-panel">
          <div className="panel-title">
            <h2>{t.workflows.availableSkills}</h2>
            <span>{availableSkills.length}</span>
          </div>
          <label className="library-search">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
            <input value={skillQuery} onChange={(e) => setSkillQuery(e.target.value)} placeholder={t.workflows.searchSkills} />
          </label>
          <div className="library-list">
            {availableSkills.length === 0 ? (
              <div className="empty-state">{t.workflows.noAvailable}</div>
            ) : (
              availableSkills.map((s) => (
                <div className="library-item" key={s.skill_id}>
                  <div className="library-item-info">
                    <strong>{s.name}</strong>
                    <div className="library-item-meta">
                      <Status value={s.category} />
                      <code>v{s.latest_version}</code>
                      <span>{s.adapters.length} {t.skills.adapters}</span>
                    </div>
                  </div>
                  <button className="icon-btn icon-btn-add" type="button" onClick={() => addSkill(s.slug)} aria-label={t.workflows.addSkill} title={t.workflows.addSkill}>
                    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" /></svg>
                  </button>
                </div>
              ))
            )}
          </div>
        </aside>
      </div>

      {message === null ? null : <div className="notice success">{message}</div>}
      {error === null ? null : <div className="notice danger">{error}</div>}
    </section>
  );
}
