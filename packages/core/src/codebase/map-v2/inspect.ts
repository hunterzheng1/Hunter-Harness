import { manifestDocumentNames, projectMapManifest } from "./manifest.js";
import { stableHash } from "./stable.js";
import {
  CODEBASE_MAP_V2_DOCUMENTS,
  type MapConflict,
  type MapDocumentName,
  type MapHealth,
  type MapHealthReasonCode,
  type MapInspectionInput
} from "./types.js";

const allDocuments = [...CODEBASE_MAP_V2_DOCUMENTS];

function inspectFingerprint(input: MapInspectionInput): string {
  return stableHash({
    schema_version: input.schema_version,
    project_identity: input.project_identity,
    repository_identity: input.repository_identity,
    worktree_identity: input.worktree_identity,
    is_git: input.is_git,
    branch_name: input.branch_name,
    current_commit: input.current_commit,
    last_mapped_commit: input.last_mapped_commit,
    dirty_paths: [...input.dirty_paths].sort(),
    untracked_paths: [...input.untracked_paths].sort(),
    affected_paths: [...input.affected_paths].sort(),
    input_group_fingerprints: input.input_group_fingerprints,
    feature_flags: input.feature_flags,
    manifest_hash: input.manifest_hash
  });
}

function classifyAffectedPath(path: string): readonly MapDocumentName[] {
  const normalized = path.replaceAll("\\", "/").replace(/^\.\//u, "").toLowerCase();
  if (/(?:^|\/)(?:package(?:-lock)?\.json|pnpm-lock\.yaml|yarn\.lock|deno\.json|bun\.lockb?|pyproject\.toml|requirements(?:\/|\.|$)|pom\.xml|build\.gradle|cargo\.toml|go\.mod|tsconfig(?:\.[^/]+)?\.json)$/u.test(normalized) ||
      /(?:^|\/)(?:vite|webpack|rollup|esbuild|next|nuxt|svelte|astro)\.config\.[^/]+$/u.test(normalized)) {
    return ["STACK.md", "INTEGRATIONS.md"];
  }
  if (/^(?:\.github\/workflows|\.gitlab-ci|azure-pipelines|deploy|deployment|infra|terraform)(?:\/|\.|$)/u.test(normalized) ||
      /(?:^|\/)(?:dockerfile|docker-compose[^/]*|compose\.ya?ml)$/u.test(normalized)) {
    return ["INTEGRATIONS.md", "STACK.md"];
  }
  if (/(?:^|\/)(?:test|tests|__tests__|spec|specs)(?:\/|\.|$)/u.test(normalized) ||
      /(?:^|\/)(?:vitest|jest|pytest|playwright|cypress)(?:\.config)?\.[^/]+$/u.test(normalized) ||
      /\.(?:test|spec)\.[^/]+$/u.test(normalized)) {
    return ["TESTING.md", "CONVENTIONS.md"];
  }
  if (/(?:^|\/)(?:routes?|controllers?|handlers?|modules?|packages?|apps?|src)(?:\/|$)/u.test(normalized) ||
      /(?:^|\/)(?:index|main|app|server|entry)\.[^/]+$/u.test(normalized)) {
    return ["ARCHITECTURE.md", "STRUCTURE.md"];
  }
  return ["ARCHITECTURE.md", "CONCERNS.md"];
}

function affectedDocuments(paths: readonly string[]): MapDocumentName[] {
  const result: MapDocumentName[] = [];
  for (const path of [...new Set(paths)].sort()) {
    for (const document of classifyAffectedPath(path)) {
      if (!result.includes(document)) result.push(document);
    }
  }
  return result;
}

function compareIdentity(
  conflicts: MapConflict[],
  reasonCode:
    | "MAP_PROJECT_IDENTITY_MISMATCH"
    | "MAP_REPOSITORY_IDENTITY_MISMATCH"
    | "MAP_BRANCH_MISMATCH"
    | "MAP_WORKTREE_MISMATCH",
  expected: string | undefined,
  actual: string | undefined
): void {
  if (expected !== undefined && actual !== undefined && expected !== actual) {
    conflicts.push({ reason_code: reasonCode, expected, actual });
  }
}

function localMapModificationPaths(input: MapInspectionInput): string[] {
  return [...new Set([...input.dirty_paths, ...input.untracked_paths])]
    .filter((path) => {
      const normalized = path.replaceAll("\\", "/").replace(/^\.\//u, "").toLowerCase();
      return normalized.startsWith(".harness/codebase/map/") ||
        normalized === ".harness/codebase/map-summary.md" ||
        normalized === ".harness/codebase/map-manifest.json";
    })
    .sort();
}

function localMapAffectedDocuments(paths: readonly string[]): MapDocumentName[] {
  if (paths.some((path) => {
    const normalized = path.replaceAll("\\", "/").replace(/^\.\//u, "").toLowerCase();
    return normalized === ".harness/codebase/map-summary.md" ||
      normalized === ".harness/codebase/map-manifest.json";
  })) return [...allDocuments];
  const names = new Set(paths.map((path) => path.replaceAll("\\", "/").split("/").at(-1)));
  return CODEBASE_MAP_V2_DOCUMENTS.filter((name) => names.has(name));
}

function recordsEqual(
  left: Readonly<Record<string, string>> | undefined,
  right: Readonly<Record<string, string>>
): boolean {
  if (left === undefined) return Object.keys(right).length === 0;
  return stableHash(left) === stableHash(right);
}

function changedInputGroups(
  previous: Readonly<Record<string, string>> | undefined,
  current: Readonly<Record<string, string>>
): string[] {
  const names = new Set([...Object.keys(previous ?? {}), ...Object.keys(current)]);
  return [...names].filter((name) => previous?.[name] !== current[name]).sort();
}

function documentsForInputGroup(name: string): readonly MapDocumentName[] {
  const normalized = name.toLowerCase();
  if (/(?:runtime|stack|build|package|dependency|dependencies|config)/u.test(normalized)) {
    return ["STACK.md", "INTEGRATIONS.md"];
  }
  if (/(?:test|quality|spec)/u.test(normalized)) {
    return ["TESTING.md", "CONVENTIONS.md"];
  }
  if (/(?:ci|deploy|integration|service)/u.test(normalized)) {
    return ["INTEGRATIONS.md", "STACK.md"];
  }
  if (/(?:structure|module|route|entry|architecture)/u.test(normalized)) {
    return ["ARCHITECTURE.md", "STRUCTURE.md"];
  }
  return ["ARCHITECTURE.md", "CONCERNS.md"];
}

function addDocuments(target: MapDocumentName[], additions: readonly MapDocumentName[]): void {
  for (const document of additions) {
    if (!target.includes(document)) target.push(document);
  }
}

function baseHealth(input: MapInspectionInput, fingerprint: string): Pick<MapHealth,
  "schema_version" | "input_fingerprint" | "conflicts"> {
  return { schema_version: 2, input_fingerprint: fingerprint, conflicts: [] };
}

function appendCodeGraphDegradation(
  input: MapInspectionInput,
  reasons: MapHealthReasonCode[]
): void {
  if (input.feature_flags.codegraph_enabled && !input.feature_flags.codegraph_available) {
    reasons.push("MAP_CODEGRAPH_UNAVAILABLE");
  }
}

function manifestHash(
  input: MapInspectionInput,
  projectedManifest: unknown
): string {
  return input.manifest_hash ?? stableHash(projectedManifest);
}

export function inspectMap(input: MapInspectionInput): MapHealth {
  const fingerprint = inspectFingerprint(input);
  if (input.manifest === undefined && !input.feature_flags.map_enabled &&
      !input.feature_flags.auto_check_enabled && !input.feature_flags.explicit_request) {
    return {
      ...baseHealth(input, fingerprint),
      applicability: "not_applicable",
      status: "not_applicable",
      affected_documents: [],
      suggested_actions: ["offer_generate_map"],
      reason_codes: ["MAP_NOT_ADOPTED"]
    };
  }
  if (input.manifest === undefined) {
    const reasonCodes: MapHealthReasonCode[] = ["MAP_MANIFEST_MISSING"];
    appendCodeGraphDegradation(input, reasonCodes);
    return {
      ...baseHealth(input, fingerprint),
      applicability: "applicable",
      status: "missing",
      affected_documents: allDocuments,
      suggested_actions: ["run_full_refresh"],
      reason_codes: reasonCodes
    };
  }

  const projected = projectMapManifest(input.manifest);
  if (!projected.ok) {
    const reasonCodes: MapHealthReasonCode[] = ["MAP_MANIFEST_INVALID"];
    appendCodeGraphDegradation(input, reasonCodes);
    return {
      ...baseHealth(input, fingerprint),
      applicability: "applicable",
      status: "conflicted",
      affected_documents: allDocuments,
      suggested_actions: ["run_full_refresh"],
      reason_codes: reasonCodes
    };
  }
  const manifest = projected.manifest;
  const conflicts: MapConflict[] = [];
  compareIdentity(conflicts, "MAP_PROJECT_IDENTITY_MISMATCH",
    manifest.project_identity, input.project_identity);
  compareIdentity(conflicts, "MAP_REPOSITORY_IDENTITY_MISMATCH",
    manifest.repository_identity, input.repository_identity);
  compareIdentity(conflicts, "MAP_BRANCH_MISMATCH", manifest.branch_name, input.branch_name);
  compareIdentity(conflicts, "MAP_WORKTREE_MISMATCH",
    manifest.worktree_identity, input.worktree_identity);
  if (conflicts.length > 0) {
    const reasonCodes = conflicts.map((conflict) => conflict.reason_code);
    appendCodeGraphDegradation(input, reasonCodes);
    return {
      schema_version: 2,
      applicability: "applicable",
      status: "conflicted",
      input_fingerprint: fingerprint,
      manifest_version: projected.source_schema_version,
      manifest_hash: manifestHash(input, manifest),
      ...(manifest.source_commit === undefined ? {} : { source_commit: manifest.source_commit }),
      affected_documents: allDocuments,
      conflicts,
      suggested_actions: ["resolve_identity_conflict", "run_full_refresh"],
      reason_codes: reasonCodes
    };
  }

  const gitIdentityIncomplete = projected.source_schema_version === 2 && input.is_git &&
    (manifest.branch_name === undefined || manifest.source_commit === undefined ||
      manifest.worktree_identity === undefined);
  if (gitIdentityIncomplete) {
    const reasonCodes: MapHealthReasonCode[] = ["MAP_MANIFEST_IDENTITY_INCOMPLETE"];
    appendCodeGraphDegradation(input, reasonCodes);
    return {
      schema_version: 2,
      applicability: "applicable",
      status: "refresh_required",
      input_fingerprint: fingerprint,
      manifest_version: projected.source_schema_version,
      manifest_hash: manifestHash(input, manifest),
      affected_documents: allDocuments,
      conflicts: [],
      suggested_actions: ["run_full_refresh"],
      reason_codes: reasonCodes
    };
  }

  const localModifications = localMapModificationPaths(input);
  if (localModifications.length > 0) {
    const reasonCodes: MapHealthReasonCode[] = ["MAP_LOCAL_MODIFICATION_CONFLICT"];
    appendCodeGraphDegradation(input, reasonCodes);
    return {
      schema_version: 2,
      applicability: "applicable",
      status: "conflicted",
      input_fingerprint: fingerprint,
      manifest_version: projected.source_schema_version,
      manifest_hash: manifestHash(input, manifest),
      ...(manifest.source_commit === undefined ? {} : { source_commit: manifest.source_commit }),
      affected_documents: localMapAffectedDocuments(localModifications),
      conflicts: [{
        reason_code: "MAP_LOCAL_MODIFICATION_CONFLICT",
        paths: localModifications
      }],
      suggested_actions: ["keep_local", "use_new_result", "view_diff"],
      reason_codes: reasonCodes
    };
  }

  const legacyIdentityUnknown = projected.source_schema_version === 1 &&
    (manifest.project_identity === undefined || manifest.repository_identity === undefined ||
      (input.is_git && (manifest.branch_name === undefined ||
        manifest.worktree_identity === undefined)));
  if (legacyIdentityUnknown) {
    const reasonCodes: MapHealthReasonCode[] = ["MAP_LEGACY_IDENTITY_UNKNOWN"];
    appendCodeGraphDegradation(input, reasonCodes);
    return {
      schema_version: 2,
      applicability: "applicable",
      status: "refresh_required",
      input_fingerprint: fingerprint,
      manifest_version: projected.source_schema_version,
      manifest_hash: manifestHash(input, manifest),
      ...(manifest.source_commit === undefined ? {} : { source_commit: manifest.source_commit }),
      affected_documents: allDocuments,
      conflicts: [],
      suggested_actions: ["run_full_refresh"],
      reason_codes: reasonCodes
    };
  }

  const reasonCodes: MapHealthReasonCode[] = [];
  const paths = [...input.affected_paths, ...input.dirty_paths, ...input.untracked_paths];
  let documents = affectedDocuments(paths);
  if (manifest.status === "conflicted" ||
      manifest.documents.some((document) => document.status === "conflicted")) {
    reasonCodes.push("MAP_MANIFEST_CONFLICTED");
    appendCodeGraphDegradation(input, reasonCodes);
    return {
      schema_version: 2,
      applicability: "applicable",
      status: "conflicted",
      input_fingerprint: fingerprint,
      manifest_version: projected.source_schema_version,
      manifest_hash: manifestHash(input, manifest),
      ...(manifest.source_commit === undefined ? {} : { source_commit: manifest.source_commit }),
      affected_documents: allDocuments,
      conflicts: [],
      suggested_actions: ["run_full_refresh"],
      reason_codes: reasonCodes
    };
  }
  if (manifest.status === "failed" ||
      manifest.documents.some((document) => document.status === "failed")) {
    reasonCodes.push("MAP_MANIFEST_FAILED");
    documents = allDocuments;
  }
  if (manifest.status === "partial") {
    reasonCodes.push("MAP_MANIFEST_PARTIAL");
    documents = allDocuments;
  }
  const manifestNames = manifestDocumentNames(manifest);
  if (CODEBASE_MAP_V2_DOCUMENTS.some((name) => !manifestNames.has(name))) {
    reasonCodes.push("MAP_MANIFEST_INCOMPLETE");
    documents = allDocuments;
  }
  const mappedCommit = input.last_mapped_commit ?? manifest.source_commit;
  if (input.is_git && mappedCommit !== undefined && input.current_commit !== undefined &&
      mappedCommit !== input.current_commit) {
    reasonCodes.push("MAP_SOURCE_COMMIT_CHANGED");
    if (documents.length === 0) documents = allDocuments;
  }
  if (input.dirty_paths.length > 0 || input.untracked_paths.length > 0) {
    reasonCodes.push("MAP_WORKSPACE_DIRTY");
  }
  if (documents.some((name) => name === "ARCHITECTURE.md" || name === "STRUCTURE.md")) {
    reasonCodes.push("MAP_STRUCTURE_DRIFT");
  } else if (documents.length > 0) {
    reasonCodes.push("MAP_CONTENT_DRIFT");
  }
  if (!input.is_git && !recordsEqual(
    manifest.input_group_fingerprints,
    input.input_group_fingerprints
  )) {
    reasonCodes.push("MAP_INPUT_FINGERPRINT_CHANGED");
    const changedGroups = changedInputGroups(
      manifest.input_group_fingerprints,
      input.input_group_fingerprints
    );
    for (const group of changedGroups) addDocuments(documents, documentsForInputGroup(group));
    if (documents.length === 0) documents = allDocuments;
  }
  const needsRefresh = reasonCodes.length > 0;
  if (!needsRefresh) reasonCodes.push("MAP_CURRENT");
  appendCodeGraphDegradation(input, reasonCodes);
  const broadRefresh = documents.length >= 5 || paths.length >= 20 ||
    reasonCodes.includes("MAP_MANIFEST_INCOMPLETE");
  return {
    schema_version: 2,
    applicability: "applicable",
    status: needsRefresh ? "refresh_required" : "current",
    input_fingerprint: fingerprint,
    manifest_version: projected.source_schema_version,
    manifest_hash: manifestHash(input, manifest),
    ...(manifest.source_commit === undefined ? {} : { source_commit: manifest.source_commit }),
    affected_documents: documents,
    conflicts: [],
    suggested_actions: needsRefresh
      ? [broadRefresh ? "run_full_refresh" : "run_incremental_refresh"]
      : [],
    reason_codes: reasonCodes
  };
}
