"use client";

import { useEffect, useMemo, useState } from "react";

import type { AiProviderConfig } from "@hunter-harness/contracts";
import { ApiClientError, browserApi, type HunterApi } from "../lib/api";
import { useI18n } from "../lib/i18n";
import { mockApi } from "../lib/mock-api";

function resolveApi(): HunterApi {
  return process.env.NEXT_PUBLIC_HUNTER_HARNESS_DEMO === "true" ? mockApi : browserApi();
}

function apiError(error: unknown, t: ReturnType<typeof useI18n>["t"]): string {
  if (error instanceof ApiClientError && error.status === 401) return t.error.authRequiredSettings;
  if (error instanceof ApiClientError) return t.error.apiFailed.replace("{code}", error.code);
  return t.error.opFailed;
}

function required<K extends keyof HunterApi>(api: HunterApi, key: K): NonNullable<HunterApi[K]> {
  const method = api[key];
  if (typeof method !== "function") throw new Error(`API capability ${String(key)} is unavailable`);
  return method.bind(api) as NonNullable<HunterApi[K]>;
}

const NEW_PROVIDER_ID = "__new__";

interface ProviderDraft {
  provider_id: string;
  label: string;
  base_url: string;
  model: string;
  enabled: boolean;
  api_key_env: string;
  is_default: boolean;
}

const emptyDraft: ProviderDraft = {
  provider_id: "", label: "", base_url: "https://", model: "",
  enabled: true, api_key_env: "secret-file", is_default: false
};

export function AiConfigPanel({ api: apiValue }: { api?: HunterApi } = {}) {
  const { t } = useI18n();
  const api = useMemo(() => apiValue ?? resolveApi(), [apiValue]);
  const [providers, setProviders] = useState<AiProviderConfig[]>([]);
  const [defaultProvider, setDefaultProvider] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string>("");
  const [usage, setUsage] = useState<{ requests: number; tokens: number }>({ requests: 0, tokens: 0 });
  const [draft, setDraft] = useState<ProviderDraft>(emptyDraft);
  const [testResult, setTestResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);

  const selected = providers.find((p) => p.provider_id === selectedId);
  const isNew = selectedId === NEW_PROVIDER_ID;
  const enabledCount = providers.filter((p) => p.enabled).length;
  const tokenText = useMemo(() => new Intl.NumberFormat().format(usage.tokens), [usage.tokens]);

  async function refresh(): Promise<void> {
    setLoading(true);
    setError(null);
    try {
      const [list, u] = await Promise.all([
        required(api, "listAiProviders")(),
        required(api, "getAiUsage")()
      ]);
      setProviders(list.items);
      setDefaultProvider(list.default_provider);
      setUsage(u);
      if (list.items.length > 0 && (selectedId === "" || selectedId === NEW_PROVIDER_ID)) {
        setSelectedId(list.items[0]?.provider_id ?? "");
      }
    } catch (reason) {
      setError(apiError(reason, t));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void refresh(); }, [api]);

  useEffect(() => {
    if (selected !== undefined) {
      setDraft({
        provider_id: selected.provider_id, label: selected.label, base_url: selected.base_url,
        model: selected.model, enabled: selected.enabled, api_key_env: selected.api_key_env,
        is_default: selected.is_default
      });
      setTestResult(null);
    }
  }, [selectedId]);

  function setField<K extends keyof ProviderDraft>(key: K, value: ProviderDraft[K]): void {
    setDraft((current) => ({ ...current, [key]: value }));
  }

  async function testConnection(): Promise<void> {
    if (selected === undefined) return;
    setTesting(true);
    setError(null);
    setTestResult(null);
    try {
      const res = await required(api, "testAiProvider")(selected.provider_id);
      setTestResult(res.ok
        ? t.aiConfig.testPassed.replace("{provider}", selected.label)
        : t.aiConfig.testFailed.replace("{provider}", selected.label).replace("{error}", res.error ?? "unknown"));
    } catch (reason) {
      setError(apiError(reason, t));
    } finally {
      setTesting(false);
    }
  }

  async function save(): Promise<void> {
    setSaving(true);
    setError(null);
    setTestResult(null);
    try {
      if (isNew) {
        const created = await required(api, "createAiProvider")({
          provider_id: draft.provider_id, label: draft.label, base_url: draft.base_url,
          model: draft.model, enabled: draft.enabled, api_key_env: draft.api_key_env,
          ...(draft.is_default ? { is_default: true } : {})
        });
        setProviders((cur) => [...cur.filter((p) => p.provider_id !== created.provider_id), created]);
        if (draft.is_default) setDefaultProvider(created.provider_id);
        setSelectedId(created.provider_id);
        setTestResult(t.aiConfig.saveSuccess.replace("{provider}", created.label));
      } else if (selected !== undefined) {
        const updated = await required(api, "updateAiProvider")(selected.provider_id, selected.revision, {
          label: draft.label, base_url: draft.base_url, model: draft.model,
          enabled: draft.enabled, api_key_env: draft.api_key_env
        });
        setProviders((cur) => cur.map((p) => p.provider_id === updated.provider_id ? updated : p));
        setTestResult(t.aiConfig.saveSuccess.replace("{provider}", updated.label));
      }
    } catch (reason) {
      setError(apiError(reason, t));
    } finally {
      setSaving(false);
    }
  }

  return <section className="stack governance-page">
    <header className="page-heading command-hero">
      <div>
        <p className="eyebrow">{t.aiConfig.eyebrow}</p>
        <h1>{t.aiConfig.title}</h1>
        <p className="lede">{t.aiConfig.description}</p>
      </div>
      <div className="hero-actions"><span className="status status-clear">{enabledCount} {t.aiConfig.enabled}</span></div>
    </header>

    {loading ? <div className="notice">{t.aiConfig.loading}</div> : <div className="ai-config-grid">
      <aside className="panel ai-provider-list">
        <div className="panel-title"><h2>{t.aiConfig.providers}</h2><span>{providers.length}</span></div>
        {providers.length === 0 ? <div className="empty-state">{t.aiConfig.noProviders}</div> : null}
        {providers.map((provider) => <button type="button" className={provider.provider_id === selectedId ? "selected" : ""} key={provider.provider_id} onClick={() => setSelectedId(provider.provider_id)}>
          <span className={`service-dot ${provider.enabled ? "operational" : "unavailable"}`} />
          <div><strong>{provider.label}</strong><small>{provider.model}</small></div>
          <span className={provider.enabled ? "status status-clear" : "status"}>{provider.enabled ? t.aiConfig.enabled : t.aiConfig.disabled}</span>
          {defaultProvider === provider.provider_id ? <span className="status">{t.aiConfig.isDefault}</span> : null}
        </button>)}
        <button type="button" className={isNew ? "selected" : ""} onClick={() => { setSelectedId(NEW_PROVIDER_ID); setDraft(emptyDraft); setTestResult(null); }}>+ {t.aiConfig.addProvider}</button>
      </aside>

      <article className="panel compact-form ai-provider-editor">
        <div className="panel-title"><h2>{t.aiConfig.configuration}</h2><span>{isNew ? t.aiConfig.newProvider : selected?.label}</span></div>
        <div className="form-grid">
          <label>{t.aiConfig.providerId}<input value={draft.provider_id} onChange={(e) => setField("provider_id", e.target.value)} disabled={!isNew} /></label>
          <label>{t.aiConfig.provider}<input value={draft.label} onChange={(e) => setField("label", e.target.value)} /></label>
          <label className="span-2">{t.aiConfig.baseUrl}<input value={draft.base_url} onChange={(e) => setField("base_url", e.target.value)} /></label>
          <label>{t.aiConfig.model}<input value={draft.model} onChange={(e) => setField("model", e.target.value)} /></label>
          <label>{t.aiConfig.apiKeyEnv}<input value={draft.api_key_env} onChange={(e) => setField("api_key_env", e.target.value)} /></label>
          <label>{t.aiConfig.enabled}<select value={draft.enabled ? "yes" : "no"} onChange={(e) => setField("enabled", e.target.value === "yes")}><option value="yes">{t.common.yes}</option><option value="no">{t.common.no}</option></select></label>
          <label>{t.aiConfig.isDefault}<select value={draft.is_default ? "yes" : "no"} onChange={(e) => setField("is_default", e.target.value === "yes")}><option value="yes">{t.common.yes}</option><option value="no">{t.common.no}</option></select></label>
        </div>
        <div className="actions">
          <button type="button" onClick={() => void testConnection()} disabled={testing || isNew}>{testing ? t.aiConfig.loading : t.aiConfig.testConnection}</button>
          <button type="button" className="secondary" onClick={() => void save()} disabled={saving}>{t.common.save}</button>
        </div>
      </article>

      <article className="panel ai-usage-panel">
        <div className="panel-title"><h2>{t.aiConfig.usageStats}</h2><span>{t.aiConfig.thisMonth}</span></div>
        <div className="skill-stat-grid">
          <article><strong>{enabledCount}</strong><span>{t.aiConfig.enabledProviders}</span></article>
          <article><strong>{usage.requests}</strong><span>{t.aiConfig.requests}</span></article>
          <article><strong>{tokenText}</strong><span>{t.aiConfig.tokens}</span></article>
        </div>
      </article>
    </div>}

    {testResult === null ? null : <div className="notice success">{testResult}</div>}
    {error === null ? null : <div className="notice danger">{error}</div>}
  </section>;
}
