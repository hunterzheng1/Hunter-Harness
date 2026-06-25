"use client";

import { useMemo, useState } from "react";

import { useI18n } from "../lib/i18n";

type AiProviderConfig = {
  id: string;
  provider: string;
  model: string;
  enabled: boolean;
  baseUrl: string;
  monthlyRequests: number;
  monthlyTokens: number;
  lastChecked: string;
};

const initialProviders: AiProviderConfig[] = [
  { id: "claude-code", provider: "Anthropic / Claude Code", model: "claude-sonnet-4", enabled: true, baseUrl: "Claude Code local session", monthlyRequests: 128, monthlyTokens: 1842000, lastChecked: "2026-06-25 09:30" },
  { id: "codex", provider: "OpenAI / Codex", model: "gpt-5-codex", enabled: true, baseUrl: "Codex desktop session", monthlyRequests: 96, monthlyTokens: 1215000, lastChecked: "2026-06-25 09:35" },
  { id: "cursor", provider: "Cursor", model: "cursor-default", enabled: false, baseUrl: "Cursor workspace", monthlyRequests: 32, monthlyTokens: 376000, lastChecked: "未测试" },
  { id: "custom", provider: "Custom OpenAI-compatible", model: "custom-model", enabled: false, baseUrl: "https://api.example.com/v1", monthlyRequests: 0, monthlyTokens: 0, lastChecked: "未测试" }
];

export function AiConfigPanel() {
  const { t } = useI18n();
  const [providers, setProviders] = useState(initialProviders);
  const [selectedId, setSelectedId] = useState(providers[0]?.id ?? "");
  const [testResult, setTestResult] = useState<string | null>(null);
  const selected = providers.find((provider) => provider.id === selectedId) ?? providers[0];
  const enabledCount = providers.filter((provider) => provider.enabled).length;
  const totalRequests = providers.reduce((sum, provider) => sum + provider.monthlyRequests, 0);
  const totalTokens = providers.reduce((sum, provider) => sum + provider.monthlyTokens, 0);
  const tokenText = useMemo(() => new Intl.NumberFormat().format(totalTokens), [totalTokens]);

  function updateSelected(input: Partial<AiProviderConfig>): void {
    if (selected === undefined) return;
    setProviders((current) => current.map((provider) => provider.id === selected.id ? { ...provider, ...input } : provider));
  }

  function testConnection(): void {
    if (selected === undefined) return;
    const now = new Date().toLocaleString();
    updateSelected({ lastChecked: now });
    setTestResult(t.aiConfig.testPassed.replace("{provider}", selected.provider));
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

    <div className="ai-config-grid">
      <aside className="panel ai-provider-list">
        <div className="panel-title"><h2>{t.aiConfig.providers}</h2><span>{providers.length}</span></div>
        {providers.map((provider) => <button type="button" className={provider.id === selected?.id ? "selected" : ""} key={provider.id} onClick={() => setSelectedId(provider.id)}>
          <span className={`service-dot ${provider.enabled ? "operational" : "unavailable"}`} />
          <div><strong>{provider.provider}</strong><small>{provider.model}</small></div>
          <span className={provider.enabled ? "status status-clear" : "status"}>{provider.enabled ? t.aiConfig.enabled : t.aiConfig.disabled}</span>
        </button>)}
      </aside>

      <article className="panel compact-form ai-provider-editor">
        <div className="panel-title"><h2>{t.aiConfig.configuration}</h2><span>{selected?.provider}</span></div>
        {selected === undefined ? null : <>
          <div className="form-grid">
            <label>{t.aiConfig.provider}<input value={selected.provider} onChange={(event) => updateSelected({ provider: event.target.value })} /></label>
            <label>{t.aiConfig.model}<input value={selected.model} onChange={(event) => updateSelected({ model: event.target.value })} /></label>
            <label className="span-2">{t.aiConfig.baseUrl}<input value={selected.baseUrl} onChange={(event) => updateSelected({ baseUrl: event.target.value })} /></label>
            <label>{t.aiConfig.enabled}<select value={selected.enabled ? "yes" : "no"} onChange={(event) => updateSelected({ enabled: event.target.value === "yes" })}><option value="yes">{t.common.yes}</option><option value="no">{t.common.no}</option></select></label>
            <label>{t.aiConfig.lastChecked}<input readOnly value={selected.lastChecked} /></label>
          </div>
          <div className="actions"><button type="button" onClick={testConnection}>{t.aiConfig.testConnection}</button><button type="button" className="secondary">{t.common.save}</button></div>
        </>}
      </article>

      <article className="panel ai-usage-panel">
        <div className="panel-title"><h2>{t.aiConfig.usageStats}</h2><span>{t.aiConfig.thisMonth}</span></div>
        <div className="skill-stat-grid">
          <article><strong>{enabledCount}</strong><span>{t.aiConfig.enabledProviders}</span></article>
          <article><strong>{totalRequests}</strong><span>{t.aiConfig.requests}</span></article>
          <article><strong>{tokenText}</strong><span>{t.aiConfig.tokens}</span></article>
          <article><strong>{providers.filter((provider) => provider.lastChecked !== "未测试").length}</strong><span>{t.aiConfig.testedProviders}</span></article>
        </div>
      </article>
    </div>

    {testResult === null ? null : <div className="notice success">{testResult}</div>}
  </section>;
}
