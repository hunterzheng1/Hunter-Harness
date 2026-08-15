import {
  CODEBASE_MAP_V2_DOCUMENTS,
  type CompatibleMapManifestDocumentV2,
  type CompatibleMapManifestV2,
  type MapDocumentStatus,
  type MapGeneratorIdentity,
  type MapManifestDocumentV2,
  type MapManifestReadResult,
  type MapMode,
  type MapStatus
} from "./types.js";
import { compareCodepoint, isRecord } from "./stable.js";

const modes = new Set<MapMode>(["quick", "incremental", "full"]);
const mapStatuses = new Set<MapStatus>(["ready", "partial", "conflicted", "failed"]);
const documentStatuses = new Set<MapDocumentStatus>([
  "current", "refreshed", "unchanged", "conflicted", "failed"
]);
const sha256 = /^sha256:[a-f0-9]{64}$/u;
const v2ManifestKeys = new Set([
  "schema_version", "generator", "project_identity", "repository_identity", "branch_name",
  "source_commit", "worktree_identity", "mode", "scope", "path_filters",
  "input_fingerprint", "input_group_fingerprints", "documents", "summary_hash", "warnings",
  "degradation_reasons", "status", "published_at"
]);
const v2GeneratorKeys = new Set(["name", "version", "prompt_version"]);
const v2DocumentKeys = new Set([
  "path", "topics", "evidence_sources", "input_fingerprint", "content_hash",
  "estimated_tokens", "status"
]);

function hasUnknownKey(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(value).some((key) => !allowed.has(key));
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.some((item) =>
    typeof item !== "string" || item.length === 0 || item.trim() !== item)) return undefined;
  return [...value];
}

const rfc3339DateTime =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-](\d{2}):(\d{2}))$/u;

export function isRfc3339DateTime(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = rfc3339DateTime.exec(value);
  if (match === null) return false;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText,
    offsetHourText, offsetMinuteText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const offsetHour = Number(offsetHourText ?? 0);
  const offsetMinute = Number(offsetMinuteText ?? 0);
  if (month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59 ||
      offsetHour > 23 || offsetMinute > 59) return false;
  const maximumDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return day >= 1 && day <= maximumDay && Number.isFinite(Date.parse(value));
}

function fingerprintRecord(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value) || Object.entries(value).some(([key, item]) =>
    key.trim().length === 0 || typeof item !== "string" || !sha256.test(item))) {
    return undefined;
  }
  return Object.fromEntries(Object.entries(value).sort(([left], [right]) =>
    compareCodepoint(left, right)) as Array<[string, string]>);
}

function generatorIdentity(value: unknown): MapGeneratorIdentity | undefined {
  if (!isRecord(value)) return undefined;
  if (hasUnknownKey(value, v2GeneratorKeys)) return undefined;
  const name = optionalString(value.name);
  const version = optionalString(value.version);
  if (name === undefined || version === undefined) return undefined;
  const promptVersion = optionalString(value.prompt_version);
  if (value.prompt_version !== undefined && promptVersion === undefined) return undefined;
  return {
    name,
    version,
    ...(promptVersion === undefined ? {} : { prompt_version: promptVersion })
  };
}

function topicForPath(path: string): string[] {
  const name = path.split("/").at(-1);
  if (name === undefined) return [];
  return [name.replace(/\.md$/iu, "").toLowerCase()];
}

function v2Document(value: unknown): MapManifestDocumentV2 | undefined {
  if (!isRecord(value)) return undefined;
  if (hasUnknownKey(value, v2DocumentKeys)) return undefined;
  const path = optionalString(value.path);
  if (path === undefined) return undefined;
  const topics = stringArray(value.topics);
  const evidenceSources = stringArray(value.evidence_sources);
  if (topics === undefined || evidenceSources === undefined) return undefined;
  const status = documentStatuses.has(value.status as MapDocumentStatus)
    ? value.status as MapDocumentStatus
    : undefined;
  const inputFingerprint = optionalString(value.input_fingerprint);
  const contentHash = optionalString(value.content_hash);
  const estimatedTokens = typeof value.estimated_tokens === "number" &&
      Number.isSafeInteger(value.estimated_tokens) && value.estimated_tokens >= 0
    ? value.estimated_tokens
    : undefined;
  if (inputFingerprint === undefined || !sha256.test(inputFingerprint) ||
      contentHash === undefined || !sha256.test(contentHash) ||
      estimatedTokens === undefined || status === undefined) return undefined;
  return {
    path,
    topics,
    evidence_sources: evidenceSources,
    input_fingerprint: inputFingerprint,
    content_hash: contentHash,
    estimated_tokens: estimatedTokens,
    status
  };
}

function legacyDocument(value: unknown): CompatibleMapManifestDocumentV2 | undefined {
  if (typeof value === "string" && value.length > 0) {
    return { path: value, topics: topicForPath(value), evidence_sources: [] };
  }
  if (!isRecord(value)) return undefined;
  const path = optionalString(value.path);
  if (path === undefined) return undefined;
  const contentHash = optionalString(value.sha256);
  return {
    path,
    topics: topicForPath(path),
    evidence_sources: [],
    ...(contentHash === undefined || !sha256.test(contentHash) ? {} : { content_hash: contentHash })
  };
}

function readV2(input: Record<string, unknown>): MapManifestReadResult {
  if (hasUnknownKey(input, v2ManifestKeys)) {
    return { ok: false, reason_code: "MAP_MANIFEST_INVALID" };
  }
  if (!Array.isArray(input.documents)) return { ok: false, reason_code: "MAP_MANIFEST_INVALID" };
  const documents = input.documents.map(v2Document);
  if (documents.some((document) => document === undefined)) {
    return { ok: false, reason_code: "MAP_MANIFEST_INVALID" };
  }
  const documentPaths = documents.map((document) => document?.path ?? "");
  if (documentPaths.length !== CODEBASE_MAP_V2_DOCUMENTS.length ||
      new Set(documentPaths).size !== documentPaths.length || documentPaths.some((path) => {
    const name = path.split("/").at(-1);
    return name === undefined || !CODEBASE_MAP_V2_DOCUMENTS.includes(name as never) ||
      path !== `.harness/codebase/map/${name}`;
  })) {
    return { ok: false, reason_code: "MAP_MANIFEST_INVALID" };
  }
  const generator = generatorIdentity(input.generator);
  const projectIdentity = optionalString(input.project_identity);
  const repositoryIdentity = optionalString(input.repository_identity);
  const mode = modes.has(input.mode as MapMode) ? input.mode as MapMode : undefined;
  const pathFilters = stringArray(input.path_filters);
  const warnings = stringArray(input.warnings);
  const degradationReasons = stringArray(input.degradation_reasons);
  const scope = optionalString(input.scope);
  const inputFingerprint = optionalString(input.input_fingerprint);
  const summaryHash = optionalString(input.summary_hash);
  const status = mapStatuses.has(input.status as MapStatus) ? input.status as MapStatus : undefined;
  const publishedAt = optionalString(input.published_at);
  if (generator === undefined || projectIdentity === undefined || repositoryIdentity === undefined ||
      mode === undefined || pathFilters === undefined || warnings === undefined ||
      degradationReasons === undefined || scope === undefined || inputFingerprint === undefined ||
      !sha256.test(inputFingerprint) || summaryHash === undefined || !sha256.test(summaryHash) ||
      status === undefined || !isRfc3339DateTime(publishedAt)) {
    return { ok: false, reason_code: "MAP_MANIFEST_INVALID" };
  }
  const optionalStringFields = ["branch_name", "source_commit", "worktree_identity"] as const;
  if (optionalStringFields.some((field) =>
    input[field] !== undefined && optionalString(input[field]) === undefined)) {
    return { ok: false, reason_code: "MAP_MANIFEST_INVALID" };
  }
  const inputGroups = fingerprintRecord(input.input_group_fingerprints);
  if (input.input_group_fingerprints !== undefined && inputGroups === undefined) {
    return { ok: false, reason_code: "MAP_MANIFEST_INVALID" };
  }
  const manifest: CompatibleMapManifestV2 = {
    schema_version: 2,
    generator,
    project_identity: projectIdentity,
    repository_identity: repositoryIdentity,
    mode,
    scope,
    path_filters: pathFilters,
    input_fingerprint: inputFingerprint,
    documents: documents as MapManifestDocumentV2[],
    summary_hash: summaryHash,
    warnings,
    degradation_reasons: degradationReasons,
    status,
    published_at: publishedAt
  };
  const optionalFields = {
    branch_name: optionalString(input.branch_name),
    source_commit: optionalString(input.source_commit),
    worktree_identity: optionalString(input.worktree_identity),
    input_group_fingerprints: inputGroups
  };
  Object.assign(manifest, Object.fromEntries(Object.entries(optionalFields)
    .filter(([, value]) => value !== undefined)));
  return { ok: true, source_schema_version: 2, manifest };
}

function readLegacy(input: Record<string, unknown>): MapManifestReadResult {
  if (!Array.isArray(input.documents)) return { ok: false, reason_code: "MAP_MANIFEST_INVALID" };
  const documents = input.documents.map(legacyDocument);
  if (documents.some((document) => document === undefined)) {
    return { ok: false, reason_code: "MAP_MANIFEST_INVALID" };
  }
  const degradationReasons = [
    "LEGACY_GENERATOR_VERSION_UNKNOWN",
    "LEGACY_PROJECT_IDENTITY_UNKNOWN",
    "LEGACY_REPOSITORY_IDENTITY_UNKNOWN",
    "LEGACY_BRANCH_NAME_UNKNOWN",
    "LEGACY_WORKTREE_IDENTITY_UNKNOWN",
    "LEGACY_INPUT_FINGERPRINT_UNKNOWN",
    "LEGACY_SUMMARY_HASH_UNKNOWN"
  ];
  if (documents.some((document) => document?.content_hash === undefined)) {
    degradationReasons.push("LEGACY_DOCUMENT_METADATA_INCOMPLETE");
  }
  const sourceCommit = optionalString(input.last_mapped_commit) ??
    optionalString(input.source_revision);
  const generatedAt = optionalString(input.generated_at);
  return {
    ok: true,
    source_schema_version: 1,
    manifest: {
      schema_version: 2,
      ...(sourceCommit === undefined ? {} : { source_commit: sourceCommit }),
      path_filters: [],
      documents: documents as CompatibleMapManifestDocumentV2[],
      warnings: [],
      degradation_reasons: degradationReasons,
      ...(generatedAt === undefined ? {} : { published_at: generatedAt })
    }
  };
}

export function projectMapManifest(input: unknown): MapManifestReadResult {
  if (!isRecord(input)) return { ok: false, reason_code: "MAP_MANIFEST_INVALID" };
  if (input.schema_version === 2) return readV2(input);
  if (input.schema_version === 1 || input.schema_version === undefined) return readLegacy(input);
  return { ok: false, reason_code: "MAP_MANIFEST_VERSION_UNSUPPORTED" };
}

export function manifestDocumentNames(
  manifest: CompatibleMapManifestV2
): Set<string> {
  return new Set(manifest.documents.map((document) => document.path.split("/").at(-1) ?? "")
    .filter((name) => CODEBASE_MAP_V2_DOCUMENTS.includes(name as never)));
}
