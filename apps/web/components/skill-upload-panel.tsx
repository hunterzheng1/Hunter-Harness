"use client";

import type {
  DraftState,
  RegistryAgent,
  SensitiveFindingView,
  SensitiveReviewSubmission
} from "@hunter-harness/contracts";
import JSZip from "jszip";
import { useState } from "react";

import { ApiClientError, buildUploadFormData, type HunterApi } from "../lib/api";
import { useI18n } from "../lib/i18n";

interface ReviewDetails {
  scanner_version: string;
  findings: SensitiveFindingView[];
}

interface UploadSummary {
  sourceName: string;
  fileCount: number;
  totalBytes: number;
  entryPath: string | null;
}

function isReviewDetails(value: unknown): value is ReviewDetails {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { scanner_version?: unknown; findings?: unknown };
  return typeof candidate.scanner_version === "string" && Array.isArray(candidate.findings) &&
    candidate.findings.every((finding) => typeof finding === "object" && finding !== null &&
      typeof (finding as { fingerprint?: unknown }).fingerprint === "string" &&
      typeof (finding as { redacted_preview?: unknown }).redacted_preview === "string");
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

async function summarize(files: File[], kind: "folder" | "zip"): Promise<UploadSummary> {
  if (kind === "zip") {
    const archiveFile = files[0];
    if (archiveFile === undefined) throw new Error("ZIP file is missing");
    const archive = await JSZip.loadAsync(await archiveFile.arrayBuffer());
    const entries = Object.values(archive.files).filter((entry) =>
      !entry.dir && !entry.name.replaceAll("\\", "/").split("/").includes("..")
    );
    const entry = entries
      .filter((item) => /(^|\/)SKILL\.md$/i.test(item.name))
      .sort((left, right) => left.name.split("/").length - right.name.split("/").length)[0];
    return {
      sourceName: archiveFile.name,
      fileCount: entries.length,
      totalBytes: archiveFile.size,
      entryPath: entry?.name ?? null
    };
  }
  const paths = files.map((file) => ({
    file,
    path: (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name
  }));
  const entry = paths
    .filter(({ path }) => /(^|\/)SKILL\.md$/i.test(path) && !path.replaceAll("\\", "/").split("/").includes(".."))
    .sort((left, right) => left.path.split("/").length - right.path.split("/").length)[0];
  const firstPath = paths[0]?.path ?? "";
  return {
    sourceName: firstPath.includes("/") ? (firstPath.split("/")[0] ?? firstPath) : (files[0]?.name ?? ""),
    fileCount: files.length,
    totalBytes: files.reduce((total, file) => total + file.size, 0),
    entryPath: entry?.path ?? null
  };
}

export function SkillUploadPanel(props: {
  api: HunterApi;
  agent: RegistryAgent;
  onUploaded: (draft: DraftState) => void;
  hasDraft?: boolean;
  className?: string;
}): React.JSX.Element {
  const { t } = useI18n();
  const copy = t.skills;
  const [files, setFiles] = useState<File[]>([]);
  const [summary, setSummary] = useState<UploadSummary | null>(null);
  const [state, setState] = useState<"idle" | "selected" | "uploading" | "review" | "success" | "failed">("idle");
  const [review, setReview] = useState<ReviewDetails | null>(null);
  const [reviewReason, setReviewReason] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function selectFiles(nextFiles: File[], kind: "folder" | "zip"): Promise<void> {
    setError(null);
    setReview(null);
    setReviewReason("");
    try {
      const nextSummary = await summarize(nextFiles, kind);
      setFiles(nextFiles);
      setSummary(nextSummary);
      if (nextSummary.entryPath === null) {
        setState("failed");
        setError(copy.uploadEntryMissing);
      } else {
        setState("selected");
      }
    } catch {
      setFiles(nextFiles);
      setSummary(null);
      setState("failed");
      setError(copy.uploadReadFailed);
    }
  }

  async function submit(evidence?: SensitiveReviewSubmission): Promise<void> {
    const upload = props.api.uploadSkillDraft;
    if (upload === undefined || files.length === 0 || summary?.entryPath === null) return;
    setState("uploading");
    setError(null);
    try {
      const draft = await upload.call(props.api, buildUploadFormData(files, evidence), props.agent);
      setState("success");
      setReview(null);
      props.onUploaded(draft);
    } catch (reason) {
      if (reason instanceof ApiClientError && reason.code === "SENSITIVE_CONTENT_REVIEW_REQUIRED" && isReviewDetails(reason.details)) {
        setReview(reason.details);
        setState("review");
        return;
      }
      setState("failed");
      setError(reason instanceof ApiClientError ? `${reason.code}: ${reason.message}` : copy.uploadFailed);
    }
  }

  function confirmReview(): void {
    if (review === null || reviewReason.trim().length < 3) return;
    void submit({
      scanner_version: review.scanner_version,
      finding_fingerprints: review.findings.map((finding) => finding.fingerprint),
      reason: reviewReason.trim()
    });
  }

  return <div data-slot="skill-upload-panel" className={`skill-upload-panel${props.className === undefined ? "" : ` ${props.className}`}`} aria-busy={state === "uploading"}>
    <div data-slot="skill-upload-choices" className="skill-upload-choices">
      <label data-slot="skill-upload-folder-choice" className="secondary upload-choice-button">
        <input
          className="visually-hidden-input"
          type="file"
          multiple
          aria-label={copy.chooseFolder}
          onChange={(event) => void selectFiles(Array.from(event.target.files ?? []), "folder")}
          {...{ webkitdirectory: "" }}
        />
        <strong>{copy.chooseFolder}</strong>
        <span>{copy.chooseFolderHint}</span>
      </label>
      <label data-slot="skill-upload-zip-choice" className="secondary upload-choice-button">
        <input
          className="visually-hidden-input"
          type="file"
          accept=".zip"
          aria-label={copy.chooseZip}
          onChange={(event) => void selectFiles(Array.from(event.target.files ?? []), "zip")}
        />
        <strong>{copy.chooseZip}</strong>
        <span>{copy.chooseZipHint}</span>
      </label>
    </div>

    {summary === null ? <p className="skill-upload-placeholder">{copy.uploadDropHint}</p> : <div data-slot="skill-upload-summary" className="skill-upload-summary" aria-live="polite">
      <div><span>{copy.uploadSource}</span><strong>{summary.sourceName}</strong></div>
      <div><span>{copy.uploadFiles}</span><strong>{copy.uploadFileCount.replace("{count}", String(summary.fileCount))}</strong></div>
      <div><span>{copy.uploadSize}</span><strong>{formatBytes(summary.totalBytes)}</strong></div>
      <div><span>{copy.uploadEntry}</span><strong className={summary.entryPath === null ? "danger-text" : "success-text"}>{summary.entryPath ?? copy.uploadEntryMissing}</strong></div>
    </div>}

    {state === "uploading" ? <div className="skill-upload-progress" role="status"><span />{copy.uploading}</div> : null}
    {review === null ? null : <div data-slot="skill-upload-review" className="skill-review-panel">
      <div className="panel-title"><h3>{copy.sensitiveReviewTitle}</h3><span>{review.findings.length}</span></div>
      <p>{copy.sensitiveReviewHint}</p>
      <div className="skill-review-findings">
        {review.findings.map((finding) => <article key={finding.fingerprint}>
          <div><strong>{finding.rule_id}</strong><span className={`risk-badge risk-${finding.severity}`}>{finding.severity}</span></div>
          <code>{finding.path}:{finding.line}</code>
          <small>{finding.redacted_preview}</small>
        </article>)}
      </div>
      <label className="skill-review-reason">{copy.reviewReason}<textarea value={reviewReason} onChange={(event) => setReviewReason(event.target.value)} /></label>
      <button type="button" disabled={reviewReason.trim().length < 3 || state === "uploading"} onClick={confirmReview}>{copy.confirmReviewRetry}</button>
    </div>}
    {error === null ? null : <div className="notice danger" role="alert">{error}</div>}
    {state === "success" ? <div className="notice success" role="status">{copy.uploadSuccess}</div> : null}
    {review === null ? <button type="button" disabled={files.length === 0 || summary?.entryPath === null || state === "uploading"} onClick={() => void submit()}>
      {state === "uploading" ? copy.uploading : props.hasDraft === true ? copy.replaceDraft : copy.addUnpublishedSkill}
    </button> : null}
  </div>;
}
