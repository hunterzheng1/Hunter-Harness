"use client";

import { useState, useRef, useEffect } from "react";
import { useI18n } from "../lib/i18n";

export function ThemeToggle({ theme, setTheme }: { theme: "dark" | "light"; setTheme: (t: "dark" | "light") => void }) {
  const { t } = useI18n();
  return (
    <div>
      <label className="settings-label">{t.settings.theme}</label>
      <div className="theme-toggle-group">
        <button
          className={`theme-option ${theme === "dark" ? "active" : ""}`}
          onClick={() => setTheme("dark")}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
          </svg>
          {t.settings.dark}
        </button>
        <button
          className={`theme-option ${theme === "light" ? "active" : ""}`}
          onClick={() => setTheme("light")}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="5" />
            <line x1="12" y1="1" x2="12" y2="3" />
            <line x1="12" y1="21" x2="12" y2="23" />
            <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" />
            <line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
            <line x1="1" y1="12" x2="3" y2="12" />
            <line x1="21" y1="12" x2="23" y2="12" />
            <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" />
            <line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
          </svg>
          {t.settings.light}
        </button>
      </div>
    </div>
  );
}

function LanguageSwitch() {
  const { t, lang, toggleLang } = useI18n();
  const languages: { key: string; label: string; native: string }[] = [
    { key: "zh", label: "中文", native: "简体中文" },
    { key: "en", label: "English", native: "English" },
  ];

  return (
    <div>
      <label className="settings-label">{t.settings.language}</label>
      <div className="theme-toggle-group">
        {languages.map((l) => (
          <button
            key={l.key}
            className={`theme-option ${lang === l.key ? "active" : ""}`}
            onClick={() => lang !== l.key && toggleLang()}
          >
            {l.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function TokenSection() {
  const { t } = useI18n();
  const [token, setToken] = useState("");
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    const stored = sessionStorage.getItem("hunter-harness-token");
    if (stored) setToken(stored);
  }, []);

  async function handleSet() {
    const trimmed = token.trim();
    setSaved(false);
    setMessage(null);
    if (trimmed === "") {
      sessionStorage.removeItem("hunter-harness-token");
      setMessage("Session token removed.");
      return;
    }
    setBusy(true);
    try {
      const response = await fetch("/api/v1/projects?limit=1", {
        headers: {
          Accept: "application/json",
          Authorization: "Bearer " + trimmed,
          "X-Request-Id": globalThis.crypto.randomUUID()
        }
      });
      if (!response.ok) {
        setMessage(response.status === 401 || response.status === 403
          ? "Token was rejected by the server."
          : "Token check failed with HTTP " + response.status + ".");
        return;
      }
      sessionStorage.setItem("hunter-harness-token", trimmed);
      setSaved(true);
      setMessage("Token verified for this browser session.");
      window.setTimeout(() => window.location.reload(), 250);
    } catch {
      setMessage("The governance API could not be reached.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <label className="settings-label" htmlFor="settings-api-token">{t.settings.apiToken}</label>
      <div className="token-row">
        <input id="settings-api-token" className="token-input" type="password" autoComplete="off" value={token} onChange={(event) => setToken(event.target.value)} placeholder={t.token.placeholder} />
        <button className="token-set-btn" disabled={busy} onClick={() => void handleSet()}>
          {busy ? t.token.checking : saved ? t.token.saved : t.token.setButton}
        </button>
      </div>
      {message === null ? null : <small>{message}</small>}
    </div>
  );
}

function DefaultAgentSection() {
  const { t } = useI18n();
  const [agent, setAgent] = useState("claude-code");
  useEffect(() => {
    setAgent(localStorage.getItem("hunter-harness-default-agent") ?? "claude-code");
  }, []);
  return (
    <div>
      <label className="settings-label" htmlFor="default-agent">{t.settings.defaultAgent}</label>
      <select
        id="default-agent"
        className="token-input"
        value={agent}
        onChange={(event) => {
          setAgent(event.target.value);
          localStorage.setItem("hunter-harness-default-agent", event.target.value);
        }}
      >
        <option value="claude-code">Claude Code</option>
        <option value="codex">{t.settings.codexContract}</option>
        <option value="generic">{t.settings.genericContract}</option>
        <option value="mcp">{t.settings.mcpContract}</option>
      </select>
    </div>
  );
}

export function SettingsPanel({ theme, setTheme }: { theme: "dark" | "light"; setTheme: (t: "dark" | "light") => void }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function handleClick(e: MouseEvent) {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open]);

  return (
    <div className="settings-wrapper" ref={panelRef}>
      <button className="settings-gear" onClick={() => setOpen(!open)} title={t.settings.title}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
        </svg>
        {t.settings.title}
      </button>

      {open && (
        <div className="settings-dropdown">
          <div className="settings-header">{t.settings.title}</div>
          <LanguageSwitch />
          <ThemeToggle theme={theme} setTheme={setTheme} />
          <DefaultAgentSection />
          <div className="settings-divider" />
          <TokenSection />
        </div>
      )}
    </div>
  );
}
