"use client";

import { useEffect, useState } from "react";

import { browserApi } from "../lib/api";
import type { AiProviderConfig, AiQuotaUsage } from "@hunter-harness/contracts";
import { useI18n } from "../lib/i18n";

// ── 纯前端 UI 版本（先设计，功能后续接入） ───────────────────
// 列表态：单选互斥启用 + toast 反馈 + 用量弹窗
// 详情态：精简字段（基本信息 + 接入配置 + 模型映射）+ sticky 右下角保存

type ApiFormat = "openai" | "anthropic" | "custom";

interface ProviderModel {
  id: string;
  displayModel: string; // 模型实际名称（展示）
  requestModel: string; // 实际请求模型（API 调用）
  inputCost: number; // 输入成本（每百万 tokens，USD）
  outputCost: number; // 输出成本
  cacheHitCost: number; // 缓存命中
  cacheCreateCost: number; // 缓存创建
}

interface ProviderDraft {
  provider_id: string;
  label: string; // 供应商名称
  note: string; // 备注
  website: string; // 官网链接
  apiKey: string; // API Key（前端占位，实际走 secret file）
  base_url: string; // 请求地址
  api_format: ApiFormat; // API 格式
  enabled: boolean; // 单选互斥：同时只一个 enabled
  models: ProviderModel[];
  selectedModelId: string; // 列表行选中的模型
}

interface UsageRecord {
  provider_id: string;
  model: string;
  date: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cacheHitTokens: number;
  cost: number;
}

interface Toast {
  msg: string;
  tone: "success" | "info" | "danger";
}

const uid = (): string => Math.random().toString(36).slice(2, 9);

function emptyModel(): ProviderModel {
  return { id: uid(), displayModel: "", requestModel: "", inputCost: 0, outputCost: 0, cacheHitCost: 0, cacheCreateCost: 0 };
}

function emptyProvider(id: string): ProviderDraft {
  const m = emptyModel();
  return {
    provider_id: id, label: "", note: "", website: "https://", apiKey: "",
    base_url: "https://", api_format: "openai", enabled: false, models: [m], selectedModelId: m.id,
  };
}

const API_FORMATS: ApiFormat[] = ["openai", "anthropic", "custom"];

// ── 后端 AiProviderConfig（snake_case）↔ 前端 ProviderDraft（camelCase）转换 ──
function toDraft(p: AiProviderConfig): ProviderDraft {
  return {
    provider_id: p.provider_id,
    label: p.label,
    note: p.note,
    website: p.website,
    apiKey: "",
    base_url: p.base_url,
    api_format: p.api_format,
    enabled: p.enabled,
    models: p.models.map((m) => ({
      id: m.id,
      displayModel: m.display_model,
      requestModel: m.request_model,
      inputCost: m.input_cost,
      outputCost: m.output_cost,
      cacheHitCost: m.cache_hit_cost,
      cacheCreateCost: m.cache_create_cost
    })),
    selectedModelId: p.selected_model_id ?? p.models[0]?.id ?? ""
  };
}

function fromDraft(d: ProviderDraft): {
  models: Array<{ id: string; display_model: string; request_model: string; input_cost: number; output_cost: number; cache_hit_cost: number; cache_create_cost: number }>;
  api_format: ApiFormat;
  note: string;
  website: string;
  base_url: string;
  model: string;
  selected_model_id: string | null;
} {
  const selected = d.models.find((m) => m.id === d.selectedModelId) ?? d.models[0];
  return {
    models: d.models.map((m) => ({
      id: m.id, display_model: m.displayModel, request_model: m.requestModel,
      input_cost: m.inputCost, output_cost: m.outputCost, cache_hit_cost: m.cacheHitCost, cache_create_cost: m.cacheCreateCost
    })),
    api_format: d.api_format,
    note: d.note,
    website: d.website,
    base_url: d.base_url,
    model: selected?.requestModel ?? "",
    selected_model_id: d.selectedModelId || null
  };
}

function toUsageRecord(u: AiQuotaUsage): UsageRecord {
  return {
    provider_id: u.provider_id,
    model: u.model,
    date: u.date,
    requests: u.requests,
    inputTokens: u.input_tokens,
    outputTokens: u.output_tokens,
    cacheHitTokens: u.cache_hit_tokens,
    cost: u.cost
  };
}

const fmt = (n: number): string => new Intl.NumberFormat("en-US").format(n);

export function AiConfigPanel() {
  const { t } = useI18n();
  const [providers, setProviders] = useState<ProviderDraft[]>([]);
  const [revisions, setRevisions] = useState<Map<string, number>>(new Map());
  const [usage, setUsage] = useState<UsageRecord[]>([]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [usageProviderId, setUsageProviderId] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [toast, setToast] = useState<Toast | null>(null);

  useEffect(() => {
    const api = browserApi();
    Promise.all([
      api.listAiProviders?.() ?? Promise.resolve({ items: [] as AiProviderConfig[], default_provider: null }),
      api.getAiUsage?.() ?? Promise.resolve([] as AiQuotaUsage[])
    ]).then(([list, u]) => {
      setProviders(list.items.map(toDraft));
      setRevisions(new Map(list.items.map((p) => [p.provider_id, p.revision])));
      setUsage(u.map(toUsageRecord));
    }).catch(() => setToast({ msg: t.aiConfig.keySaveFailed, tone: "danger" }));
  }, [t]);

  useEffect(() => {
    if (toast === null) return;
    const id = setTimeout(() => setToast(null), 2800);
    return () => clearTimeout(id);
  }, [toast]);

  const editing = providers.find((p) => p.provider_id === editingId) ?? null;
  const enabledCount = providers.filter((p) => p.enabled).length;

  function patch(id: string, fn: (p: ProviderDraft) => ProviderDraft): void {
    setProviders((cur) => cur.map((p) => (p.provider_id === id ? fn(p) : p)));
  }

  async function reorder(draggedId: string, targetId: string): Promise<void> {
    if (draggedId === targetId) return;
    const from = providers.findIndex((p) => p.provider_id === draggedId);
    const to = providers.findIndex((p) => p.provider_id === targetId);
    if (from === -1 || to === -1) return;
    const next = [...providers];
    const [moved] = next.splice(from, 1);
    if (moved === undefined) return;
    next.splice(to, 0, moved);
    setProviders(next);
    try {
      const api = browserApi();
      await api.reorderAiProviders?.(next.map((p) => p.provider_id));
    } catch {
      setToast({ msg: t.aiConfig.keySaveFailed, tone: "danger" });
    }
  }

  // 单选互斥：后端 PATCH enabled=true 时联动其他 false（API-04）；前端乐观更新 + 失败回滚由 toast 提示
  async function toggleEnabled(id: string): Promise<void> {
    const target = providers.find((p) => p.provider_id === id);
    if (target === undefined) return;
    const newEnabled = !target.enabled;
    patch(id, (cur) => ({ ...cur, enabled: newEnabled }));
    try {
      const api = browserApi();
      const rev = revisions.get(id) ?? 1;
      const updated = await api.updateAiProvider?.(id, rev, { enabled: newEnabled });
      if (updated !== undefined) {
        setRevisions((cur) => { const m = new Map(cur); m.set(id, updated.revision); return m; });
        // 后端单选：其他 provider enabled=false 同步本地
        if (newEnabled) {
          setProviders((cur) => cur.map((p) => (p.provider_id === id ? p : { ...p, enabled: false })));
        }
      }
    } catch {
      setToast({ msg: t.aiConfig.keySaveFailed, tone: "danger" });
    }
  }

  async function duplicate(id: string): Promise<void> {
    const src = providers.find((p) => p.provider_id === id);
    if (src === undefined) return;
    const newId = `${id}-copy-${uid()}`;
    const copy: ProviderDraft = {
      ...src,
      provider_id: newId,
      label: `${src.label} ${t.aiConfig.copySuffix}`,
      enabled: false,
      models: src.models.map((m) => ({ ...m, id: uid() })),
    };
    if (copy.models[0] !== undefined) copy.selectedModelId = copy.models[0].id;
    const payload = fromDraft(copy);
    try {
      const api = browserApi();
      const created = await api.createAiProvider?.({
        provider_id: copy.provider_id,
        label: copy.label,
        enabled: copy.enabled,
        api_key_env: "secret-file",
        ...payload
      });
      setProviders((cur) => [...cur, created ? toDraft(created) : copy]);
      if (created !== undefined) {
        setRevisions((cur) => { const m = new Map(cur); m.set(created.provider_id, created.revision); return m; });
      }
      setToast({ msg: t.aiConfig.duplicated.replace("{provider}", src.label), tone: "success" });
    } catch {
      setToast({ msg: t.aiConfig.keySaveFailed, tone: "danger" });
    }
  }

  async function testConnection(id: string): Promise<void> {
    const p = providers.find((x) => x.provider_id === id);
    try {
      const api = browserApi();
      const res = await api.testAiProvider?.(id);
      if (res?.ok === true) {
        setToast({ msg: t.aiConfig.testPassed.replace("{provider}", p?.label ?? ""), tone: "success" });
      } else {
        setToast({ msg: t.aiConfig.keySaveFailed, tone: "danger" });
      }
    } catch {
      setToast({ msg: t.aiConfig.keySaveFailed, tone: "danger" });
    }
  }

  async function remove(id: string): Promise<void> {
    const target = providers.find((p) => p.provider_id === id);
    if (target === undefined) return;
    try {
      const api = browserApi();
      await api.deleteAiProvider?.(id);
      setProviders((cur) => cur.filter((p) => p.provider_id !== id));
      setConfirmDeleteId(null);
      setToast({ msg: t.aiConfig.deletedNotice.replace("{provider}", target.label), tone: "info" });
    } catch {
      setToast({ msg: t.aiConfig.keySaveFailed, tone: "danger" });
    }
  }

  function addProvider(): void {
    const id = `provider-${uid()}`;
    setProviders((cur) => [...cur, emptyProvider(id)]);
    setEditingId(id);
  }

  async function saveDetail(): Promise<void> {
    if (editing === null) return;
    const api = browserApi();
    const payload = fromDraft(editing);
    try {
      if (revisions.has(editing.provider_id)) {
        const rev = revisions.get(editing.provider_id) ?? 1;
        const updated = await api.updateAiProvider?.(editing.provider_id, rev, payload);
        if (updated !== undefined) {
          setRevisions((cur) => { const m = new Map(cur); m.set(editing.provider_id, updated.revision); return m; });
          patch(editing.provider_id, () => toDraft(updated));
        }
      } else {
        const created = await api.createAiProvider?.({
          provider_id: editing.provider_id,
          label: editing.label,
          enabled: editing.enabled,
          api_key_env: "secret-file",
          ...payload
        });
        if (created !== undefined) {
          setRevisions((cur) => { const m = new Map(cur); m.set(editing.provider_id, created.revision); return m; });
          patch(editing.provider_id, () => toDraft(created));
        }
      }
      setToast({ msg: t.aiConfig.saveSuccess.replace("{provider}", editing.label || editing.provider_id), tone: "success" });
      setEditingId(null);
    } catch {
      setToast({ msg: t.aiConfig.keySaveFailed, tone: "danger" });
    }
  }

  async function saveKey(): Promise<void> {
    if (editing === null) return;
    if (editing.apiKey === "") {
      setToast({ msg: t.aiConfig.keyEmpty, tone: "danger" });
      return;
    }
    const api = browserApi();
    if (typeof api.setAiProviderKey !== "function") {
      setToast({ msg: t.aiConfig.keySaveFailed, tone: "danger" });
      return;
    }
    try {
      await api.setAiProviderKey(editing.provider_id, { api_key: editing.apiKey });
      setToast({ msg: t.aiConfig.keySaved.replace("{provider}", editing.label || editing.provider_id), tone: "success" });
    } catch {
      setToast({ msg: t.aiConfig.keySaveFailed, tone: "danger" });
    }
  }

  async function selectModel(id: string, mid: string): Promise<void> {
    patch(id, (cur) => ({ ...cur, selectedModelId: mid }));
    try {
      const api = browserApi();
      const rev = revisions.get(id) ?? 1;
      const updated = await api.updateAiProvider?.(id, rev, { selected_model_id: mid });
      if (updated !== undefined) {
        setRevisions((cur) => { const m = new Map(cur); m.set(id, updated.revision); return m; });
      }
    } catch {
      setToast({ msg: t.aiConfig.keySaveFailed, tone: "danger" });
    }
  }

  if (editing !== null) {
    return (
      <>
        <ProviderDetail
          draft={editing}
          t={t}
          onChange={(fn) => patch(editing.provider_id, fn)}
          onBack={() => setEditingId(null)}
          onSave={saveDetail}
          onSaveKey={saveKey}
        />
        <ToastView toast={toast} />
      </>
    );
  }

  const confirmTarget = providers.find((p) => p.provider_id === confirmDeleteId) ?? null;
  const usageProvider = providers.find((p) => p.provider_id === usageProviderId) ?? null;

  return (
    <section className="stack governance-page">
      <header className="page-heading command-hero">
        <div>
          <p className="eyebrow">{t.aiConfig.eyebrow}</p>
          <h1>{t.aiConfig.title}</h1>
          <p className="lede">{t.aiConfig.description}</p>
        </div>
        <div className="hero-actions">
          <span className="status status-clear">{enabledCount} {t.aiConfig.enabled}</span>
          <button type="button" className="prominent-action" onClick={addProvider}>+ {t.aiConfig.addProvider}</button>
        </div>
      </header>

      <div className="panel provider-table">
        <div className="panel-title">
          <h2>{t.aiConfig.providers}</h2>
          <span>{providers.length}</span>
        </div>
        {providers.length === 0 ? (
          <div className="empty-state">{t.aiConfig.noProviders}</div>
        ) : (
          <div className="provider-rows">
            {providers.map((p) => (
              <ProviderRow
                key={p.provider_id}
                provider={p}
                t={t}
                isDragging={draggingId === p.provider_id}
                onDragStart={() => setDraggingId(p.provider_id)}
                onDrop={() => {
                  if (draggingId !== null) void reorder(draggingId, p.provider_id);
                  setDraggingId(null);
                }}
                onDragEnd={() => setDraggingId(null)}
                onToggleEnabled={() => void toggleEnabled(p.provider_id)}
                onSelectModel={(mid) => void selectModel(p.provider_id, mid)}
                onEdit={() => setEditingId(p.provider_id)}
                onDuplicate={() => duplicate(p.provider_id)}
                onTest={() => void testConnection(p.provider_id)}
                onUsage={() => setUsageProviderId(p.provider_id)}
                onDelete={() => setConfirmDeleteId(p.provider_id)}
              />
            ))}
          </div>
        )}
      </div>

      {usageProvider !== null ? (
        <UsageModal
          provider={usageProvider}
          records={usage.filter((r) => r.provider_id === usageProvider.provider_id)}
          t={t}
          onClose={() => setUsageProviderId(null)}
        />
      ) : null}

      {confirmTarget !== null ? (
        <div className="modal-backdrop" onClick={() => setConfirmDeleteId(null)}>
          <div className="delete-confirm-modal check-confirm-modal" onClick={(e) => e.stopPropagation()}>
            <div className="panel-title"><h2>{t.aiConfig.deleteConfirm.replace("{provider}", confirmTarget.label)}</h2></div>
            <p>{t.aiConfig.deleteHint}</p>
            <div className="modal-actions">
              <button type="button" onClick={() => setConfirmDeleteId(null)}>{t.common.cancel}</button>
              <button type="button" className="danger" onClick={() => void remove(confirmTarget.provider_id)}>{t.common.delete}</button>
            </div>
          </div>
        </div>
      ) : null}

      <ToastView toast={toast} />
    </section>
  );
}

// ── Toast ──────────────────────────────────────────────────
function ToastView({ toast }: { toast: Toast | null }) {
  if (toast === null) return null;
  return (
    <div className="toast-stack" role="status" aria-live="polite">
      <div className={`toast toast-${toast.tone}`}>{toast.msg}</div>
    </div>
  );
}

// ── 列表行 ──────────────────────────────────────────────────
interface ProviderRowProps {
  provider: ProviderDraft;
  t: ReturnType<typeof useI18n>["t"];
  isDragging: boolean;
  onDragStart: () => void;
  onDrop: () => void;
  onDragEnd: () => void;
  onToggleEnabled: () => void;
  onSelectModel: (modelId: string) => void;
  onEdit: () => void;
  onDuplicate: () => void;
  onTest: () => void;
  onUsage: () => void;
  onDelete: () => void;
}

function ProviderRow(props: ProviderRowProps) {
  const { provider: p, t } = props;
  const selectedModel = p.models.find((m) => m.id === p.selectedModelId) ?? p.models[0] ?? null;

  return (
    <div
      className={`provider-row${props.isDragging ? " dragging" : ""}`}
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => { e.preventDefault(); props.onDrop(); }}
    >
      <span
        className="drag-handle"
        draggable
        onDragStart={(e) => { if (e.dataTransfer) { e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", p.provider_id); } props.onDragStart(); }}
        onDragEnd={props.onDragEnd}
        aria-hidden
      >⋮⋮</span>
      <span className={`service-dot ${p.enabled ? "operational" : "disabled"}`} />
      <div className="provider-row-main">
        <strong>{p.label || p.provider_id}</strong>
        <small>{p.note || p.base_url}</small>
      </div>

      <label className="provider-model-select">
        <select value={selectedModel?.id ?? ""} onChange={(e) => props.onSelectModel(e.target.value)} disabled={p.models.length === 0}>
          {p.models.length === 0 ? <option value="">{t.aiConfig.noModels}</option> : null}
          {p.models.map((m) => (
            <option key={m.id} value={m.id}>{m.displayModel || m.requestModel}</option>
          ))}
        </select>
      </label>

      <button
        type="button"
        className={`toggle-pill ${p.enabled ? "on" : "off"}`}
        onClick={props.onToggleEnabled}
        title={p.enabled ? t.aiConfig.enabled : t.aiConfig.disabled}
      >
        <span className="toggle-knob" />
        <span className="toggle-label">{p.enabled ? t.aiConfig.enabled : t.aiConfig.disabled}</span>
      </button>

      <div className="provider-row-actions">
        <button type="button" className="icon-action" onClick={props.onEdit} title={t.common.edit}>{t.common.edit}</button>
        <button type="button" className="icon-action" onClick={props.onDuplicate} title={t.aiConfig.duplicate}>{t.aiConfig.duplicate}</button>
        <button type="button" className="icon-action" onClick={props.onTest} title={t.aiConfig.testConnection}>{t.aiConfig.testConnection}</button>
        <button type="button" className="icon-action" onClick={props.onUsage} title={t.aiConfig.usageStats}>{t.aiConfig.usage}</button>
        <button type="button" className="icon-action danger" onClick={props.onDelete} title={t.common.delete}>✕</button>
      </div>
    </div>
  );
}

// ── 详情编辑态 ──────────────────────────────────────────────
interface ProviderDetailProps {
  draft: ProviderDraft;
  t: ReturnType<typeof useI18n>["t"];
  onChange: (fn: (p: ProviderDraft) => ProviderDraft) => void;
  onBack: () => void;
  onSave: () => void;
  onSaveKey: () => void;
}

function ProviderDetail(props: ProviderDetailProps) {
  const { draft: p, t, onChange } = props;
  const [showKey, setShowKey] = useState(false);

  function setField<K extends keyof ProviderDraft>(key: K, value: ProviderDraft[K]): void {
    onChange((cur) => ({ ...cur, [key]: value }));
  }
  function setModel(id: string, fn: (m: ProviderModel) => ProviderModel): void {
    onChange((cur) => ({ ...cur, models: cur.models.map((m) => (m.id === id ? fn(m) : m)) }));
  }
  function addModel(): void {
    const m = emptyModel();
    onChange((cur) => ({ ...cur, models: [...cur.models, m], selectedModelId: cur.selectedModelId || m.id }));
  }
  function removeModel(id: string): void {
    onChange((cur) => {
      const models = cur.models.filter((m) => m.id !== id);
      const selectedModelId = cur.selectedModelId === id ? (models[0]?.id ?? "") : cur.selectedModelId;
      return { ...cur, models, selectedModelId };
    });
  }

  return (
    <section className="stack governance-page provider-detail">
      <header className="page-heading command-hero">
        <div className="skill-detail-hero">
          <div className="page-heading-main">
            <button type="button" className="back-button" onClick={props.onBack} title={t.common.back} aria-label={t.common.back}>←</button>
            <div>
              <p className="eyebrow">{t.aiConfig.editProvider}</p>
              <h1>{p.label || t.aiConfig.newProvider}</h1>
            </div>
          </div>
        </div>
      </header>

      <div className="provider-detail-body">
        <div className="provider-detail-form">
          <article className="panel compact-form">
            <div className="panel-title"><h2>{t.aiConfig.basicInfo}</h2></div>
            <div className="form-grid form-grid-compact">
              <label className="span-2">{t.aiConfig.provider}<input value={p.label} onChange={(e) => setField("label", e.target.value)} placeholder={t.aiConfig.providerPlaceholder} /></label>
              <label className="span-2">{t.aiConfig.note}<input value={p.note} onChange={(e) => setField("note", e.target.value)} placeholder={t.aiConfig.notePlaceholder} /></label>
              <label className="span-2">{t.aiConfig.website}<input value={p.website} onChange={(e) => setField("website", e.target.value)} placeholder="https://" /></label>
            </div>
          </article>

          <article className="panel compact-form">
            <div className="panel-title"><h2>{t.aiConfig.accessConfig}</h2></div>
            <div className="form-grid form-grid-compact">
              <label className="span-2">{t.aiConfig.baseUrl}<input value={p.base_url} onChange={(e) => setField("base_url", e.target.value)} placeholder="https://" /></label>
              <label>{t.aiConfig.apiFormat}
                <select value={p.api_format} onChange={(e) => setField("api_format", e.target.value as ApiFormat)}>
                  {API_FORMATS.map((f) => <option key={f} value={f}>{f}</option>)}
                </select>
              </label>
              <label>{t.aiConfig.apiKey}
                <div className="api-key-input">
                  <input type={showKey ? "text" : "password"} value={p.apiKey} onChange={(e) => setField("apiKey", e.target.value)} placeholder={t.aiConfig.apiKeyPlaceholder} />
                  <button type="button" className="icon-action" onClick={() => setShowKey((v) => !v)} aria-label={t.aiConfig.toggleKey}>{showKey ? "🙈" : "👁"}</button>
                  <button type="button" className="icon-action save-key-btn" onClick={props.onSaveKey} title={t.aiConfig.saveKey}>{t.aiConfig.saveKey}</button>
                </div>
              </label>
              <p className="span-2 api-key-hint">{t.aiConfig.apiKeyHint}</p>
            </div>
          </article>
        </div>

        <article className="panel provider-models-panel">
          <div className="panel-title">
            <h2>{t.aiConfig.modelMapping}</h2>
            <button type="button" className="add-model-btn" onClick={addModel}>+ {t.aiConfig.addModel}</button>
          </div>
          <div className="model-mapping-list">
            {p.models.length === 0 ? <div className="empty-state">{t.aiConfig.noModels}</div> : null}
            {p.models.map((m) => (
              <div key={m.id} className="model-mapping-card">
                <div className="model-mapping-head">
                  <label>{t.aiConfig.displayModel}<input value={m.displayModel} onChange={(e) => setModel(m.id, (cur) => ({ ...cur, displayModel: e.target.value }))} placeholder={t.aiConfig.displayModelPh} /></label>
                  <label>{t.aiConfig.requestModel}<input value={m.requestModel} onChange={(e) => setModel(m.id, (cur) => ({ ...cur, requestModel: e.target.value }))} placeholder={t.aiConfig.requestModelPh} /></label>
                  <button type="button" className="icon-action danger" onClick={() => removeModel(m.id)} title={t.common.delete} aria-label={t.common.delete}>✕</button>
                </div>
                <div className="pricing-grid">
                  <label className="pricing-cell">{t.aiConfig.inputCost}<input type="number" min={0} step={0.01} value={m.inputCost} onChange={(e) => setModel(m.id, (cur) => ({ ...cur, inputCost: Number(e.target.value) }))} /><span>$/M</span></label>
                  <label className="pricing-cell">{t.aiConfig.outputCost}<input type="number" min={0} step={0.01} value={m.outputCost} onChange={(e) => setModel(m.id, (cur) => ({ ...cur, outputCost: Number(e.target.value) }))} /><span>$/M</span></label>
                  <label className="pricing-cell">{t.aiConfig.cacheHitCost}<input type="number" min={0} step={0.01} value={m.cacheHitCost} onChange={(e) => setModel(m.id, (cur) => ({ ...cur, cacheHitCost: Number(e.target.value) }))} /><span>$/M</span></label>
                  <label className="pricing-cell">{t.aiConfig.cacheCreateCost}<input type="number" min={0} step={0.01} value={m.cacheCreateCost} onChange={(e) => setModel(m.id, (cur) => ({ ...cur, cacheCreateCost: Number(e.target.value) }))} /><span>$/M</span></label>
                </div>
              </div>
            ))}
          </div>
        </article>
      </div>

      <footer className="provider-detail-footer">
        <button type="button" className="secondary" onClick={props.onBack}>{t.common.cancel}</button>
        <button type="button" className="prominent-action" onClick={props.onSave}>{t.common.save}</button>
      </footer>
    </section>
  );
}

// ── 用量弹窗 ────────────────────────────────────────────────
interface UsageModalProps {
  provider: ProviderDraft;
  records: UsageRecord[];
  t: ReturnType<typeof useI18n>["t"];
  onClose: () => void;
}

function UsageModal(props: UsageModalProps) {
  const { provider: p, records, t } = props;
  const totalRequests = records.reduce((s, r) => s + r.requests, 0);
  const totalTokens = records.reduce((s, r) => s + r.inputTokens + r.outputTokens, 0);
  const totalCost = records.reduce((s, r) => s + r.cost, 0);

  // 按模型聚合
  const byModel = new Map<string, { requests: number; tokens: number; cost: number }>();
  for (const r of records) {
    const cur = byModel.get(r.model) ?? { requests: 0, tokens: 0, cost: 0 };
    cur.requests += r.requests;
    cur.tokens += r.inputTokens + r.outputTokens;
    cur.cost += r.cost;
    byModel.set(r.model, cur);
  }
  // 按日期聚合（升序）
  const byDate = new Map<string, { requests: number; tokens: number; cost: number }>();
  for (const r of records) {
    const cur = byDate.get(r.date) ?? { requests: 0, tokens: 0, cost: 0 };
    cur.requests += r.requests;
    cur.tokens += r.inputTokens + r.outputTokens;
    cur.cost += r.cost;
    byDate.set(r.date, cur);
  }
  const dateRows = Array.from(byDate.entries()).sort(([a], [b]) => (a < b ? -1 : 1));
  const maxDayTokens = dateRows.reduce((m, [, v]) => Math.max(m, v.tokens), 1);

  return (
    <div className="modal-backdrop" onClick={props.onClose}>
      <div className="usage-modal" onClick={(e) => e.stopPropagation()}>
        <div className="panel-title">
          <h2>{p.label} · {t.aiConfig.usageStats}</h2>
          <button type="button" className="icon-action" onClick={props.onClose} aria-label={t.common.cancel}>✕</button>
        </div>

        <div className="usage-overview">
          <article><strong>{fmt(totalRequests)}</strong><span>{t.aiConfig.requests}</span></article>
          <article><strong>{fmt(totalTokens)}</strong><span>{t.aiConfig.tokens}</span></article>
          <article><strong>${totalCost.toFixed(2)}</strong><span>{t.aiConfig.cost}</span></article>
          <article><strong>{records.length}</strong><span>{t.aiConfig.records}</span></article>
        </div>

        <div className="usage-section">
          <h3>{t.aiConfig.byModel}</h3>
          <div className="usage-table">
            <div className="usage-table-head">
              <span>{t.aiConfig.model}</span><span>{t.aiConfig.requests}</span><span>{t.aiConfig.tokens}</span><span>{t.aiConfig.cost}</span>
            </div>
            {Array.from(byModel.entries()).map(([model, v]) => (
              <div key={model} className="usage-table-row">
                <span>{model}</span><span>{fmt(v.requests)}</span><span>{fmt(v.tokens)}</span><span>${v.cost.toFixed(2)}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="usage-section">
          <h3>{t.aiConfig.byDay}（{t.aiConfig.last7Days}）</h3>
          <div className="usage-bars">
            {dateRows.map(([date, v]) => (
              <div key={date} className="usage-bar-row">
                <span className="usage-bar-date">{date.slice(5)}</span>
                <div className="usage-bar-track">
                  <div className="usage-bar-fill tokens" style={{ width: `${(v.tokens / maxDayTokens) * 100}%` }} />
                </div>
                <span className="usage-bar-val">{fmt(v.tokens)}</span>
                <span className="usage-bar-cost">${v.cost.toFixed(2)}</span>
              </div>
            ))}
          </div>
          <div className="usage-bar-legend">
            <span><i className="dot tokens" /> {t.aiConfig.tokens}</span>
          </div>
        </div>
      </div>
    </div>
  );
}
