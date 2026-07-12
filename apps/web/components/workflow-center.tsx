"use client";

import { useEffect, useMemo, useState } from "react";

import type {
  WorkflowFamily,
  WorkflowFamilyDraftState,
  WorkflowFamilyMutation,
  WorkflowFamilyVersion
} from "@hunter-harness/contracts";

import { browserApi, buildUploadFormData, type HunterApi } from "../lib/api";
import { useI18n } from "../lib/i18n";
import { mockApi } from "../lib/mock-api";
import { apiError, required, Status } from "./skill-shared";

function resolveApi(): HunterApi {
  return process.env.NEXT_PUBLIC_HUNTER_HARNESS_DEMO === "true" ? mockApi : browserApi();
}

const blankFamily: WorkflowFamilyMutation = {
  slug: "",
  displayName: "",
  description: "",
  tags: [],
  required_profiles: ["general"]
};

export function WorkflowCenter({ api: apiValue }: { api?: HunterApi }) {
  const { t } = useI18n();
  const api = useMemo(() => apiValue ?? resolveApi(), [apiValue]);
  const [families, setFamilies] = useState<WorkflowFamily[] | null>(null);
  const [selectedSlug, setSelectedSlug] = useState<string | null>(null);
  const [draft, setDraft] = useState<WorkflowFamilyDraftState | null>(null);
  const [versions, setVersions] = useState<WorkflowFamilyVersion[]>([]);
  const [profileUploads, setProfileUploads] = useState<Record<string, File[] | null>>({});
  const [publishVersion, setPublishVersion] = useState("");
  const [releaseNote, setReleaseNote] = useState("");
  const [createForm, setCreateForm] = useState<WorkflowFamilyMutation>(blankFamily);
  const [showCreate, setShowCreate] = useState(false);
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const selected = families?.find((family) => family.slug === selectedSlug) ?? null;

  async function refreshFamilies(): Promise<void> {
    try {
      const items = await required(api, "listWorkflowFamilies")();
      setFamilies(items);
      setError(null);
    } catch (reason) {
      setError(apiError(reason, t));
    }
  }

  async function loadFamilyDetail(slug: string): Promise<void> {
    setSelectedSlug(slug);
    setDraft(null);
    setVersions([]);
    setProfileUploads({});
    try {
      const [vers, nextDraft] = await Promise.all([
        required(api, "listWorkflowFamilyVersions")(slug),
        required(api, "getWorkflowFamilyDraft")(slug).catch(() => null)
      ]);
      setVersions(vers);
      setDraft(nextDraft);
    } catch (reason) {
      setError(apiError(reason, t));
    }
  }

  useEffect(() => { void refreshFamilies(); }, [api]);

  async function createFamily(): Promise<void> {
    setBusy(true);
    try {
      const saved = await required(api, "createWorkflowFamily")(createForm);
      setShowCreate(false);
      setCreateForm(blankFamily);
      setMessage(t.workflows.familyCreated.replace("{name}", saved.displayName));
      await refreshFamilies();
      await loadFamilyDetail(saved.slug);
    } catch (reason) {
      setError(apiError(reason, t));
    } finally {
      setBusy(false);
    }
  }

  async function uploadProfile(profile: string): Promise<void> {
    if (selectedSlug === null) return;
    const files = profileUploads[profile];
    if (files === null || files === undefined || files.length === 0) return;
    setBusy(true);
    try {
      const nextDraft = await required(api, "uploadWorkflowFamilyProfileDraft")(
        selectedSlug,
        profile,
        buildUploadFormData(files)
      );
      setDraft(nextDraft);
      setProfileUploads((current) => ({ ...current, [profile]: null }));
      setMessage(t.workflows.profileUploaded.replace("{profile}", profile));
      setError(null);
    } catch (reason) {
      setError(apiError(reason, t));
    } finally {
      setBusy(false);
    }
  }

  async function runChecks(): Promise<void> {
    if (selectedSlug === null) return;
    setBusy(true);
    try {
      const result = await required(api, "runWorkflowFamilyDraftChecks")(selectedSlug);
      setDraft((current) => current === null ? current : { ...current, checks: result });
      setError(null);
    } catch (reason) {
      setError(apiError(reason, t));
    } finally {
      setBusy(false);
    }
  }

  async function publish(): Promise<void> {
    if (selectedSlug === null || publishVersion === "") return;
    setBusy(true);
    try {
      await required(api, "publishWorkflowFamilyDraft")(selectedSlug, {
        version: publishVersion,
        ...(releaseNote === "" ? {} : { releaseNote })
      });
      setPublishVersion("");
      setReleaseNote("");
      setMessage(t.workflows.publishedVersion.replace("{version}", publishVersion));
      await refreshFamilies();
      await loadFamilyDetail(selectedSlug);
    } catch (reason) {
      setError(apiError(reason, t));
    } finally {
      setBusy(false);
    }
  }

  async function discardDraft(): Promise<void> {
    if (selectedSlug === null || draft === null) return;
    setBusy(true);
    try {
      await required(api, "discardWorkflowFamilyDraft")(selectedSlug, draft.revision);
      setDraft(null);
      setMessage(t.workflows.draftDiscarded);
    } catch (reason) {
      setError(apiError(reason, t));
    } finally {
      setBusy(false);
    }
  }

  const needle = query.trim().toLowerCase();
  const filtered = (families ?? []).filter((family) =>
    needle === "" || `${family.displayName} ${family.slug} ${family.description}`.toLowerCase().includes(needle)
  );

  return (
    <section className="stack governance-page">
      <header className="page-heading command-hero">
        <div>
          <p className="eyebrow">{t.workflows.eyebrow}</p>
          <h1>{t.workflows.familyTitle}</h1>
          <p className="lede">{t.workflows.familyDescription}</p>
        </div>
        <button type="button" className="primary-button" onClick={() => setShowCreate((value) => !value)}>
          + {t.workflows.newFamily}
        </button>
      </header>

      {showCreate ? (
        <div className="panel panel-themed compact-form">
          <div className="panel-title"><h2>{t.workflows.newFamily}</h2></div>
          <div className="form-grid">
            <label>{t.workflows.name}<input value={createForm.displayName} onChange={(e) => setCreateForm({ ...createForm, displayName: e.target.value })} /></label>
            <label>{t.workflows.key}<input value={createForm.slug} onChange={(e) => setCreateForm({ ...createForm, slug: e.target.value })} /></label>
            <label className="span-2">{t.workflows.description2}<textarea value={createForm.description} onChange={(e) => setCreateForm({ ...createForm, description: e.target.value })} /></label>
            <label>{t.workflows.requiredProfiles}<input value={createForm.required_profiles.join(", ")} onChange={(e) => setCreateForm({ ...createForm, required_profiles: e.target.value.split(",").map((item) => item.trim()).filter((item) => item !== "") })} placeholder="general, enterprise" /></label>
          </div>
          <div className="actions">
            <button type="button" disabled={busy || !createForm.slug || !createForm.displayName || !createForm.description} onClick={() => void createFamily()}>{t.workflows.save}</button>
            <button type="button" className="secondary" onClick={() => setShowCreate(false)}>{t.common.cancel}</button>
          </div>
        </div>
      ) : null}

      <div className="workflow-list-toolbar">
        <label className="search-wide">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t.workflows.searchPlaceholder} />
        </label>
        <span className="muted-stat">{filtered.length} / {families?.length ?? 0}</span>
      </div>

      <div className="workflow-workbench">
        <div className="panel workflow-index">
          <div className="panel-title"><h2>{t.workflows.families}</h2><span>{filtered.length}</span></div>
          {families === null ? <div className="skeleton-block" /> : filtered.length === 0 ? (
            <div className="empty-state">{t.workflows.noFamilies}</div>
          ) : filtered.map((family) => (
            <button
              type="button"
              className={family.slug === selectedSlug ? "selected" : ""}
              key={family.family_id}
              onClick={() => void loadFamilyDetail(family.slug)}
            >
              <strong>{family.displayName}</strong>
              <span><code>{family.slug}</code> · {family.required_profiles.join(", ")}</span>
              <Status value={family.latest_version === null ? "draft" : "published"} />
            </button>
          ))}
        </div>

        {selected === null ? (
          <div className="panel workflow-editor"><div className="empty-state">{t.workflows.selectFamily}</div></div>
        ) : (
          <div className="panel workflow-editor compact-form">
            <div className="panel-title">
              <h2>{selected.displayName}</h2>
              <span>{selected.latest_version ?? t.workflows.unpublished}</span>
            </div>
            <p>{selected.description}</p>
            <p><small>{t.workflows.requiredProfiles}: {selected.required_profiles.join(", ")}</small></p>

            <div className="panel-title"><h3>{t.workflows.profileUploads}</h3></div>
            {selected.required_profiles.map((profile) => (
              <div className="compact-form panel-upload" key={profile}>
                <strong>{profile}</strong>
                <input
                  type="file"
                  multiple
                  accept=".zip"
                  onChange={(e) => setProfileUploads((current) => ({
                    ...current,
                    [profile]: e.target.files === null || e.target.files.length === 0 ? null : Array.from(e.target.files)
                  }))}
                />
                <button type="button" disabled={busy || profileUploads[profile] === null || profileUploads[profile] === undefined} onClick={() => void uploadProfile(profile)}>
                  {t.workflows.uploadProfile}
                </button>
                {draft?.profiles.some((item) => item.profile === profile) ? (
                  <span className="status status-published">{t.workflows.profileDraftReady}</span>
                ) : null}
              </div>
            ))}

            {draft === null ? (
              <div className="notice">{t.workflows.noDraft}</div>
            ) : (
              <div className="panel panel-themed">
                <div className="panel-title"><h3>{t.workflows.draftTitle}</h3><span>rev {draft.revision}</span></div>
                <p><small>{t.workflows.draftProfiles}: {draft.profiles.map((item) => item.profile).join(", ") || "—"}</small></p>
                <div className="compact-form">
                  <button type="button" disabled={busy} onClick={() => void runChecks()}>{t.workflows.runChecks}</button>
                  <input value={publishVersion} onChange={(e) => setPublishVersion(e.target.value)} placeholder="1.0.0" />
                  <input value={releaseNote} onChange={(e) => setReleaseNote(e.target.value)} placeholder={t.workflows.releaseNotePlaceholder} />
                  <button type="button" disabled={busy || publishVersion === ""} onClick={() => void publish()}>{t.workflows.publish}</button>
                  <button type="button" className="secondary danger" disabled={busy} onClick={() => void discardDraft()}>{t.workflows.discardDraft}</button>
                  <button type="button" className="secondary" disabled title={t.workflows.npmComingSoon}>{t.workflows.npmRelease}</button>
                </div>
                {draft.checks === null ? null : (
                  <ul className="check-list">
                    {draft.checks.items.map((item) => (
                      <li key={item.id}><Status value={item.status} /> <strong>{item.label}</strong> <span>{item.message}</span></li>
                    ))}
                  </ul>
                )}
              </div>
            )}

            {versions.length === 0 ? null : (
              <div>
                <div className="panel-title"><h3>{t.workflows.versionHistory}</h3></div>
                <ul>
                  {versions.map((version) => (
                    <li key={version.version}>
                      <strong>{version.version}</strong>{" "}
                      <span>{version.profiles.map((item) => item.profile).join(", ")}</span>{" "}
                      <span>{version.changeNote ?? ""}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
      </div>

      {message === null ? null : <div className="notice success">{message}</div>}
      {error === null ? null : <div className="notice danger">{error}</div>}
    </section>
  );
}
