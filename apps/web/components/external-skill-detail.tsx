"use client";

import type { ExternalSkill } from "@hunter-harness/contracts";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";

import { browserApi, type HunterApi } from "../lib/api";
import { useI18n } from "../lib/i18n";
import { mockApi } from "../lib/mock-api";
import { Empty, Status, apiError, required, MarkdownDocument } from "./skill-shared";

function useApi(value?: HunterApi): HunterApi {
  return useMemo(() => value ?? (
    process.env.NEXT_PUBLIC_HUNTER_HARNESS_DEMO === "true" ? mockApi : browserApi()
  ), [value]);
}

export function ExternalSkillDetail({ api: apiValue, skillId }: { api?: HunterApi; skillId: string }) {
  const { t } = useI18n();
  const api = useApi(apiValue);
  const router = useRouter();
  const [skill, setSkill] = useState<ExternalSkill | null>(null);
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function refresh(): Promise<void> {
    try {
      const next = await required(api, "getExternalSkill")(skillId);
      setSkill(next);
      setNote(next.curationNote);
      setError(null);
    } catch (reason) {
      setError(apiError(reason, t));
    }
  }

  useEffect(() => { void refresh(); }, [api, skillId]);

  async function saveNote(): Promise<void> {
    if (skill === null || busy) return;
    setBusy(true);
    try {
      const next = await required(api, "patchExternalSkill")(skill.id, {
        curationNote: note,
        revision: skill.revision
      });
      setSkill(next);
      setMessage(t.skills.externalNoteSaved);
    } catch (reason) {
      setError(apiError(reason, t));
    } finally {
      setBusy(false);
    }
  }

  async function refreshUpstream(): Promise<void> {
    if (skill === null || busy) return;
    setBusy(true);
    try {
      const next = await required(api, "refreshExternalSkill")(skill.id);
      setSkill(next);
      setNote(next.curationNote);
      setMessage(t.skills.externalRefreshed);
    } catch (reason) {
      setError(apiError(reason, t));
    } finally {
      setBusy(false);
    }
  }

  async function acknowledgeUpdate(): Promise<void> {
    if (skill === null || busy) return;
    setBusy(true);
    try {
      const next = await required(api, "patchExternalSkill")(skill.id, {
        acknowledgeUpdate: true,
        revision: skill.revision
      });
      setSkill(next);
    } catch (reason) {
      setError(apiError(reason, t));
    } finally {
      setBusy(false);
    }
  }

  async function copyInstall(): Promise<void> {
    if (skill === null) return;
    try {
      await navigator.clipboard.writeText(skill.snapshot.installCommand);
      setMessage(t.skills.externalCopied);
    } catch {
      setError(apiError(new Error("clipboard unavailable"), t));
    }
  }

  async function remove(): Promise<void> {
    if (skill === null || busy) return;
    if (!window.confirm(t.skills.externalDeleteConfirm.replace("{name}", skill.snapshot.name))) return;
    setBusy(true);
    try {
      await required(api, "deleteExternalSkill")(skill.id);
      setMessage(t.skills.externalDeleted.replace("{name}", skill.snapshot.name));
      router.push("/skills");
    } catch (reason) {
      setError(apiError(reason, t));
      setBusy(false);
    }
  }

  if (error !== null && skill === null) return <Empty>{error}</Empty>;
  if (skill === null) return <div className="skeleton-block" />;

  return (
    <section className="stack governance-page">
      <header className="page-heading command-hero">
        <div>
          <p className="eyebrow">{t.skills.externalDetailEyebrow}</p>
          <h1>{skill.snapshot.name}</h1>
          <p className="lede">{skill.snapshot.description || t.skills.externalDetailTitle}</p>
        </div>
        <div className="hero-actions">
          <Status value="governed" />
          <span className="tag">{t.skills.externalBadge}</span>
          <span className="tag">{skill.source.type}</span>
          {skill.updateAvailable ? <span className="tag">{t.skills.updateAvailableBadge}</span> : null}
        </div>
      </header>

      <div className="hub-grid">
        <div className="panel panel-themed stack">
          <div className="panel-title"><h2>{t.skills.externalInstallCommand}</h2></div>
          <pre className="code-block">{skill.snapshot.installCommand}</pre>
          <div className="modal-actions">
            <button type="button" className="secondary" onClick={() => void copyInstall()}>{t.skills.externalCopyInstall}</button>
            {skill.snapshot.releaseUrl ? (
              <a href={skill.snapshot.releaseUrl} target="_blank" rel="noreferrer">{t.skills.externalReleaseLink}</a>
            ) : null}
            <Link href="/skills">{t.common.back}</Link>
          </div>

          <div className="panel-title"><h2>{t.skills.importExternalNote}</h2></div>
          <textarea value={note} onChange={(event) => setNote(event.target.value)} rows={5} />
          <div className="modal-actions">
            <button type="button" disabled={busy} onClick={() => void saveNote()}>{t.skills.externalSaveNote}</button>
            <button type="button" className="secondary" disabled={busy} onClick={() => void refreshUpstream()}>{t.skills.externalRefresh}</button>
            {skill.updateAvailable ? (
              <button type="button" className="secondary" disabled={busy} onClick={() => void acknowledgeUpdate()}>
                {t.skills.externalAcknowledgeUpdate}
              </button>
            ) : null}
            <button type="button" className="danger" disabled={busy} onClick={() => void remove()}>{t.skills.externalDelete}</button>
          </div>

          <div className="panel-title"><h2>{t.skills.externalReadme}</h2></div>
          {skill.snapshot.readme !== null && skill.snapshot.readme.length > 0
            ? <MarkdownDocument content={skill.snapshot.readme} />
            : <pre className="code-block">—</pre>}
        </div>

        <aside className="hub-rail">
          <div className="panel panel-themed">
            <div className="panel-title"><h2>{t.skills.externalDetailTitle}</h2></div>
            <p><strong>{t.skills.source}</strong>: {skill.source.type} · {skill.source.ref}</p>
            <p><strong>{t.skills.version}</strong>: {skill.snapshot.version ?? "—"}</p>
            <p><strong>{t.skills.externalLicense}</strong>: {skill.snapshot.license ?? "—"}</p>
            <p><strong>{t.skills.externalLastChecked}</strong>: {skill.lastCheckedAt.slice(0, 19).replace("T", " ")}</p>
          </div>
        </aside>
      </div>

      {message === null ? null : <div className="notice success">{message}</div>}
      {error === null ? null : <div className="notice danger">{error}</div>}
    </section>
  );
}
