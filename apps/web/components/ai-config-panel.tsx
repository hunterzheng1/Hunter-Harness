"use client";

import { useEffect, useState } from "react";

import { browserApi } from "../lib/api";
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

const SAMPLE_PROVIDERS: ProviderDraft[] = [
  {
    provider_id: "deepseek", label: "DeepSeek",
    note: "主力供应商，用于 AI 检查与变更信息生成。",
    website: "https://platform.deepseek.com", apiKey: "",
    base_url: "https://api.deepseek.com", api_format: "openai", enabled: true,
    models: [
      { id: "ds-chat", displayModel: "DeepSeek Chat", requestModel: "deepseek-chat", inputCost: 0.27, outputCost: 1.1, cacheHitCost: 0.07, cacheCreateCost: 0.27 },
      { id: "ds-reasoner", displayModel: "DeepSeek Reasoner", requestModel: "deepseek-reasoner", inputCost: 0.55, outputCost: 2.19, cacheHitCost: 0.14, cacheCreateCost: 0.55 },
    ],
    selectedModelId: "ds-chat",
  },
  {
    provider_id: "openai", label: "OpenAI",
    note: "备用供应商，gpt-4o 系列用于跨模型对照。",
    website: "https://platform.openai.com", apiKey: "",
    base_url: "https://api.openai.com/v1", api_format: "openai", enabled: false,
    models: [
      { id: "o4o", displayModel: "GPT-4o", requestModel: "gpt-4o", inputCost: 2.5, outputCost: 10, cacheHitCost: 1.25, cacheCreateCost: 0 },
      { id: "o4o-mini", displayModel: "GPT-4o mini", requestModel: "gpt-4o-mini", inputCost: 0.15, outputCost: 0.6, cacheHitCost: 0.075, cacheCreateCost: 0 },
    ],
    selectedModelId: "o4o",
  },
  {
    provider_id: "anthropic", label: "Anthropic",
    note: "Claude 系列适配，API 格式走 anthropic 原生。",
    website: "https://console.anthropic.com", apiKey: "",
    base_url: "https://api.anthropic.com", api_format: "anthropic", enabled: false,
    models: [
      { id: "sonnet", displayModel: "Claude Sonnet 4.6", requestModel: "claude-sonnet-4-6", inputCost: 3, outputCost: 15, cacheHitCost: 0.3, cacheCreateCost: 3.75 },
    ],
    selectedModelId: "sonnet",
  },
];

const SAMPLE_USAGE: UsageRecord[] = [
  { provider_id: "deepseek", model: "deepseek-chat", date: "2026-06-25", requests: 38, inputTokens: 280000, outputTokens: 160000, cacheHitTokens: 40000, cost: 0.27 },
  { provider_id: "deepseek", model: "deepseek-chat", date: "2026-06-26", requests: 45, inputTokens: 310000, outputTokens: 175000, cacheHitTokens: 42000, cost: 0.29 },
  { provider_id: "deepseek", model: "deepseek-chat", date: "2026-06-27", requests: 52, inputTokens: 360000, outputTokens: 200000, cacheHitTokens: 48000, cost: 0.34 },
  { provider_id: "deepseek", model: "deepseek-reasoner", date: "2026-06-27", requests: 12, inputTokens: 180000, outputTokens: 220000, cacheHitTokens: 0, cost: 0.58 },
  { provider_id: "deepseek", model: "deepseek-chat", date: "2026-06-28", requests: 61, inputTokens: 420000, outputTokens: 240000, cacheHitTokens: 55000, cost: 0.41 },
  { provider_id: "deepseek", model: "deepseek-reasoner", date: "2026-06-28", requests: 18, inputTokens: 220000, outputTokens: 280000, cacheHitTokens: 0, cost: 0.72 },
  { provider_id: "deepseek", model: "deepseek-chat", date: "2026-06-29", requests: 48, inputTokens: 330000, outputTokens: 185000, cacheHitTokens: 46000, cost: 0.31 },
  { provider_id: "deepseek", model: "deepseek-chat", date: "2026-06-30", requests: 57, inputTokens: 390000, outputTokens: 215000, cacheHitTokens: 51000, cost: 0.37 },
  { provider_id: "deepseek", model: "deepseek-reasoner", date: "2026-06-30", requests: 15, inputTokens: 200000, outputTokens: 250000, cacheHitTokens: 0, cost: 0.65 },
  { provider_id: "deepseek", model: "deepseek-chat", date: "2026-07-01", requests: 33, inputTokens: 240000, outputTokens: 140000, cacheHitTokens: 38000, cost: 0.23 },
  { provider_id: "openai", model: "gpt-4o", date: "2026-06-27", requests: 8, inputTokens: 95000, outputTokens: 42000, cacheHitTokens: 12000, cost: 0.65 },
  { provider_id: "openai", model: "gpt-4o", date: "2026-06-29", requests: 11, inputTokens: 130000, outputTokens: 58000, cacheHitTokens: 15000, cost: 0.89 },
  { provider_id: "openai", model: "gpt-4o", date: "2026-07-01", requests: 6, inputTokens: 72000, outputTokens: 31000, cacheHitTokens: 9000, cost: 0.48 },
];

const API_FORMATS: ApiFormat[] = ["openai", "anthropic", "custom"];

const fmt = (n: number): string => new Intl.NumberFormat("en-US").format(n);

export function AiConfigPanel() {
  const { t } = useI18n();
  const [providers, setProviders] = useState<ProviderDraft[]>(SAMPLE_PROVIDERS);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [usageProviderId, setUsageProviderId] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [toast, setToast] = useState<Toast | null>(null);

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

  function reorder(draggedId: string, targetId: string): void {
    if (draggedId === targetId) return;
    setProviders((cur) => {
      const from = cur.findIndex((p) => p.provider_id === draggedId);
      const to = cur.findIndex((p) => p.provider_id === targetId);
      if (from === -1 || to === -1) return cur;
      const next = [...cur];
      const [moved] = next.splice(from, 1);
      if (moved === undefined) return cur;
      next.splice(to, 0, moved);
      return next;
    });
  }

  // 单选互斥：启用该 provider 时关闭所有其他；点已启用的则关闭它
  function toggleEnabled(id: string): void {
    setProviders((cur) => cur.map((p) => (p.provider_id === id ? { ...p, enabled: !p.enabled } : { ...p, enabled: false })));
  }

  function duplicate(id: string): void {
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
    setProviders((cur) => [...cur, copy]);
    setToast({ msg: t.aiConfig.duplicated.replace("{provider}", src.label), tone: "success" });
  }

  function testConnection(id: string): void {
    const p = providers.find((x) => x.provider_id === id);
    setToast({ msg: t.aiConfig.testPassed.replace("{provider}", p?.label ?? ""), tone: "success" });
  }

  function remove(id: string): void {
    const target = providers.find((p) => p.provider_id === id);
    if (target === undefined) return;
    setProviders((cur) => cur.filter((p) => p.provider_id !== id));
    setConfirmDeleteId(null);
    setToast({ msg: t.aiConfig.deletedNotice.replace("{provider}", target.label), tone: "info" });
  }

  function addProvider(): void {
    const id = `provider-${uid()}`;
    setProviders((cur) => [...cur, emptyProvider(id)]);
    setEditingId(id);
  }

  function saveDetail(): void {
    if (editing === null) return;
    setToast({ msg: t.aiConfig.saveSuccess.replace("{provider}", editing.label || editing.provider_id), tone: "success" });
    setEditingId(null);
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
                  if (draggingId !== null) reorder(draggingId, p.provider_id);
                  setDraggingId(null);
                }}
                onDragEnd={() => setDraggingId(null)}
                onToggleEnabled={() => toggleEnabled(p.provider_id)}
                onSelectModel={(mid) => patch(p.provider_id, (cur) => ({ ...cur, selectedModelId: mid }))}
                onEdit={() => setEditingId(p.provider_id)}
                onDuplicate={() => duplicate(p.provider_id)}
                onTest={() => testConnection(p.provider_id)}
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
          records={SAMPLE_USAGE.filter((r) => r.provider_id === usageProvider.provider_id)}
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
              <button type="button" className="danger" onClick={() => remove(confirmTarget.provider_id)}>{t.common.delete}</button>
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
