import {
  INSTRUCTION_TARGET_AGENTS,
  InstructionGovernanceError,
  type InstructionCanonicalFileSnapshot,
  type InstructionEntrypointSnapshot,
  type InstructionHealth,
  type InstructionHealthStatus,
  type InstructionInspectionInput,
  type InstructionProjectionSnapshot,
  type InstructionQualityReasonCode,
  type InstructionQualitySuggestion,
  type InstructionStructureFinding,
  type InstructionStructureReasonCode,
  type InstructionTargetAgent
} from "./types.js";
import { rulesManifestSchema } from "./schema.js";
import { compareCodepoint, deepFreeze, stableHash } from "./stable.js";

const SHA256 = /^sha256:[a-f0-9]{64}$/u;
const EXPECTED_ENTRYPOINT: Readonly<Record<InstructionTargetAgent, string>> = {
  codex: "AGENTS.md",
  claude_code: "CLAUDE.md",
  cursor: "AGENTS.md",
  codebuddy: "CODEBUDDY.md"
};

interface NormalizedInspectionInput extends Omit<
  InstructionInspectionInput,
  "previous_input_fingerprint" | "manifest"
> {
  manifest: ReturnType<typeof rulesManifestSchema.parse>;
}

function fail(detail: string): never {
  throw new InstructionGovernanceError("INSTRUCTION_INSPECTION_INPUT_INVALID", detail);
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() !== value || value.length === 0 ||
      value.length > 512 || Array.from(value).some((character) => character.charCodeAt(0) <= 31)) {
    fail(`${label} must be a bounded non-empty string`);
  }
  return value;
}

function hash(value: unknown, label: string): string {
  const result = text(value, label);
  if (!SHA256.test(result)) fail(`${label} must be a sha256 identity`);
  return result;
}

function path(value: unknown, label: string): string {
  const result = text(value, label);
  const lower = result.toLowerCase();
  const segments = lower.split("/");
  if (result.startsWith("/") || result.startsWith("\\") || /^[A-Za-z]:/u.test(result) ||
      result.includes("\\") || segments.some((segment) =>
        segment.length === 0 || segment === "." || segment === ".." ||
        segment === ".git" || segment.startsWith(".env") ||
        segment === "credentials.local" || segment.startsWith("credentials.local.")
      ) || lower === ".harness/state" || lower.startsWith(".harness/state/") ||
      lower === ".harness/runtime" || lower.startsWith(".harness/runtime/")) {
    fail(`${label} is not a safe canonical path`);
  }
  return result;
}

function stringSet(values: readonly string[], label: string, paths = false): readonly string[] {
  if (!Array.isArray(values) || values.length > 256) fail(`${label} must be a bounded array`);
  const normalized = values.map((value, index) =>
    paths ? path(value, `${label}[${index}]`) : text(value, `${label}[${index}]`)
  );
  if (new Set(normalized).size !== normalized.length) fail(`${label} contains duplicates`);
  return normalized.sort(compareCodepoint);
}

function agent(value: unknown, label: string): InstructionTargetAgent {
  if (typeof value !== "string" ||
      !INSTRUCTION_TARGET_AGENTS.includes(value as InstructionTargetAgent)) {
    fail(`${label} is outside the frozen agent enum`);
  }
  return value as InstructionTargetAgent;
}

function canonicalFile(
  value: InstructionCanonicalFileSnapshot,
  index: number
): InstructionCanonicalFileSnapshot {
  return {
    path: path(value.path, `canonical_files[${index}].path`),
    content_hash: hash(value.content_hash, `canonical_files[${index}].content_hash`),
    references: stringSet(value.references, `canonical_files[${index}].references`)
  };
}

function entrypoint(
  value: InstructionEntrypointSnapshot,
  index: number
): InstructionEntrypointSnapshot {
  return {
    agent: agent(value.agent, `entrypoints[${index}].agent`),
    path: path(value.path, `entrypoints[${index}].path`),
    content_hash: hash(value.content_hash, `entrypoints[${index}].content_hash`),
    references: stringSet(value.references, `entrypoints[${index}].references`)
  };
}

function projection(
  value: InstructionProjectionSnapshot,
  index: number
): InstructionProjectionSnapshot {
  return {
    agent: agent(value.agent, `projection_files[${index}].agent`),
    path: path(value.path, `projection_files[${index}].path`),
    content_hash: hash(value.content_hash, `projection_files[${index}].content_hash`),
    expected_content_hash: value.expected_content_hash === null
      ? null
      : hash(value.expected_content_hash, `projection_files[${index}].expected_content_hash`),
    canonical_refs: stringSet(
      value.canonical_refs,
      `projection_files[${index}].canonical_refs`
    )
  };
}

function numericAgentRecord(
  value: Readonly<Partial<Record<InstructionTargetAgent, number>>>,
  label: string,
  enabled: readonly InstructionTargetAgent[]
): Readonly<Partial<Record<InstructionTargetAgent, number>>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail(`${label} invalid`);
  const record = value as Readonly<Record<string, unknown>>;
  if (Object.keys(record).some((key) =>
    !INSTRUCTION_TARGET_AGENTS.includes(key as InstructionTargetAgent)
  )) fail(`${label} has an unknown agent`);
  const result: Partial<Record<InstructionTargetAgent, number>> = {};
  for (const currentAgent of enabled) {
    const amount = record[currentAgent];
    if (!Number.isSafeInteger(amount) || Number(amount) < 0) {
      fail(`${label}.${currentAgent} must be a non-negative safe integer`);
    }
    result[currentAgent] = Number(amount);
  }
  return result;
}

function normalize(input: InstructionInspectionInput): NormalizedInspectionInput {
  if (input === null || typeof input !== "object" || input.schema_version !== 1) {
    fail("schema_version must equal 1");
  }
  const manifest = rulesManifestSchema.parse(input.manifest);
  const enabled = input.enabled_agents.map((value, index) =>
    agent(value, `enabled_agents[${index}]`)
  );
  if (enabled.length === 0 || new Set(enabled).size !== enabled.length) {
    fail("enabled_agents must be non-empty and unique");
  }
  enabled.sort(compareCodepoint);
  const projectIdentity = text(input.project_identity, "project_identity");
  if (projectIdentity !== manifest.project_identity) fail("project_identity does not match manifest");
  const canonicalFiles = input.canonical_files.map(canonicalFile).sort((left, right) =>
    compareCodepoint(left.path, right.path)
  );
  const entrypoints = input.entrypoints.map(entrypoint).sort((left, right) =>
    compareCodepoint(`${left.agent}\0${left.path}`, `${right.agent}\0${right.path}`)
  );
  const projectionFiles = input.projection_files.map(projection).sort((left, right) =>
    compareCodepoint(`${left.agent}\0${left.path}`, `${right.agent}\0${right.path}`)
  );
  if (new Set(canonicalFiles.map((file) => file.path)).size !== canonicalFiles.length) {
    fail("canonical_files contains duplicate paths");
  }
  const manifestPaths = manifest.files.map((file) => file.path).sort(compareCodepoint);
  const snapshotPaths = canonicalFiles.map((file) => file.path);
  if (manifestPaths.length !== snapshotPaths.length || manifestPaths.some(
    (manifestPath, index) => manifestPath !== snapshotPaths[index]
  )) {
    fail("canonical_files paths must exactly match manifest.files");
  }
  if (new Set(entrypoints.map((entry) => `${entry.agent}\0${entry.path}`)).size !==
      entrypoints.length) {
    fail("entrypoints contains duplicate agent paths");
  }
  if (new Set(projectionFiles.map((file) => `${file.agent}\0${file.path}`)).size !==
      projectionFiles.length) {
    fail("projection_files contains duplicate agent paths");
  }
  if ([...entrypoints, ...projectionFiles].some((item) => !enabled.includes(item.agent))) {
    fail("agent observations must belong to enabled_agents");
  }
  const configurationHashes: Record<string, string> = {};
  for (const [key, value] of Object.entries(input.configuration_hashes).sort(([left], [right]) =>
    compareCodepoint(left, right)
  )) {
    configurationHashes[text(key, "configuration_hashes key")] = hash(
      value,
      `configuration_hashes.${key}`
    );
  }
  return {
    schema_version: 1,
    project_identity: projectIdentity,
    enabled_agents: enabled,
    manifest,
    canonical_files: canonicalFiles,
    entrypoints,
    projection_files: projectionFiles,
    map_evidence_refs: stringSet(input.map_evidence_refs, "map_evidence_refs"),
    ...(input.archive_evidence_cursor === undefined
      ? {}
      : { archive_evidence_cursor: text(input.archive_evidence_cursor, "archive_evidence_cursor") }),
    configuration_hashes: configurationHashes,
    prompt_version: text(input.prompt_version, "prompt_version"),
    agent_context_usage: numericAgentRecord(
      input.agent_context_usage,
      "agent_context_usage",
      enabled
    ),
    agent_context_budgets: numericAgentRecord(
      input.agent_context_budgets,
      "agent_context_budgets",
      enabled
    ),
    ...(input.last_proposal_ref === undefined
      ? {}
      : { last_proposal_ref: text(input.last_proposal_ref, "last_proposal_ref") }),
    ...(input.last_apply_receipt_ref === undefined
      ? {}
      : { last_apply_receipt_ref: text(input.last_apply_receipt_ref, "last_apply_receipt_ref") })
  };
}

function finding(
  reasonCode: InstructionStructureReasonCode,
  options: {
    path?: string;
    target_agent?: InstructionTargetAgent;
    related_paths?: readonly string[];
  } = {}
): InstructionStructureFinding {
  const relatedPaths = [...(options.related_paths ?? [])].sort(compareCodepoint);
  const identity = stableHash({
    reason_code: reasonCode,
    path: options.path,
    target_agent: options.target_agent,
    related_paths: relatedPaths
  });
  return {
    finding_id: `finding:${identity.slice(7, 23)}`,
    reason_code: reasonCode,
    ...(options.path === undefined ? {} : { path: options.path }),
    ...(options.target_agent === undefined ? {} : { target_agent: options.target_agent }),
    related_paths: relatedPaths
  };
}

function cycles(adjacency: ReadonlyMap<string, ReadonlySet<string>>): readonly string[][] {
  const visited = new Set<string>();
  const active = new Set<string>();
  const stack: string[] = [];
  const found = new Map<string, string[]>();
  function visit(node: string): void {
    if (active.has(node)) {
      const offset = stack.indexOf(node);
      const cycle = stack.slice(offset).sort(compareCodepoint);
      found.set(cycle.join("\0"), cycle);
      return;
    }
    if (visited.has(node)) return;
    visited.add(node);
    active.add(node);
    stack.push(node);
    for (const next of [...(adjacency.get(node) ?? [])].sort(compareCodepoint)) visit(next);
    stack.pop();
    active.delete(node);
  }
  for (const node of [...adjacency.keys()].sort(compareCodepoint)) visit(node);
  return [...found.values()].sort((left, right) =>
    compareCodepoint(left.join("\0"), right.join("\0"))
  );
}

function structureFindings(input: NormalizedInspectionInput): InstructionStructureFinding[] {
  const result: InstructionStructureFinding[] = [];
  const manifestFiles = new Map(input.manifest.files.map((file) => [file.path, file]));
  const canonicalFiles = new Map(input.canonical_files.map((file) => [file.path, file]));
  for (const [canonicalPath, file] of manifestFiles) {
    const snapshot = canonicalFiles.get(canonicalPath);
    if (snapshot === undefined) {
      result.push(finding("INSTRUCTION_CANONICAL_FILE_MISSING", { path: canonicalPath }));
    } else if (snapshot.content_hash !== file.content_hash) {
      result.push(finding("INSTRUCTION_CANONICAL_HASH_MISMATCH", { path: canonicalPath }));
    }
  }
  for (const currentAgent of input.enabled_agents) {
    const expectedPath = EXPECTED_ENTRYPOINT[currentAgent];
    if (!input.entrypoints.some((entry) =>
      entry.agent === currentAgent && entry.path === expectedPath
    )) {
      result.push(finding("INSTRUCTION_ENTRYPOINT_MISSING", {
        path: expectedPath,
        target_agent: currentAgent
      }));
    }
    const usage = input.agent_context_usage[currentAgent] ?? 0;
    const budget = input.agent_context_budgets[currentAgent] ?? 0;
    if (usage > budget) {
      result.push(finding("INSTRUCTION_CONTEXT_BUDGET_EXCEEDED", {
        target_agent: currentAgent
      }));
    }
  }

  const canonicalKnown = new Set(input.canonical_files.map((file) => file.path));
  const entrypointKnown = new Set(input.entrypoints.map((entry) => entry.path));
  const entrypointReferences = new Set([...canonicalKnown, ...entrypointKnown]);
  const adjacency = new Map<string, Set<string>>();
  const addRefs = (
    from: string,
    references: readonly string[],
    allowed: ReadonlySet<string>
  ): void => {
    const values = adjacency.get(from) ?? new Set<string>();
    adjacency.set(from, values);
    for (const reference of references) {
      if (!allowed.has(reference)) {
        result.push(finding("INSTRUCTION_CANONICAL_REFERENCE_INVALID", {
          path: from,
          related_paths: [reference]
        }));
      } else {
        values.add(reference);
      }
    }
  };
  for (const file of input.canonical_files) {
    addRefs(file.path, file.references, canonicalKnown);
  }
  for (const entry of input.entrypoints) {
    addRefs(entry.path, entry.references, entrypointReferences);
  }
  for (const projectionFile of input.projection_files) {
    addRefs(projectionFile.path, projectionFile.canonical_refs, canonicalKnown);
  }
  for (const cycle of cycles(adjacency)) {
    result.push(finding("INSTRUCTION_REFERENCE_CYCLE", { related_paths: cycle }));
  }

  const byProjectionPath = new Map<string, InstructionProjectionSnapshot[]>();
  for (const projectionFile of input.projection_files) {
    const group = byProjectionPath.get(projectionFile.path) ?? [];
    group.push(projectionFile);
    byProjectionPath.set(projectionFile.path, group);
    if (projectionFile.expected_content_hash !== projectionFile.content_hash) {
      result.push(finding("INSTRUCTION_PROJECTION_CONFLICT", {
        path: projectionFile.path,
        target_agent: projectionFile.agent
      }));
    }
  }
  for (const [projectionPath, group] of byProjectionPath) {
    if (new Set(group.map((item) => item.content_hash)).size > 1) {
      result.push(finding("INSTRUCTION_PROJECTION_CONFLICT", {
        path: projectionPath,
        related_paths: group.map((item) => `${item.agent}:${item.content_hash}`)
      }));
    }
  }
  const unique = new Map<string, InstructionStructureFinding>();
  for (const item of result) unique.set(item.finding_id, item);
  return [...unique.values()].sort((left, right) =>
    compareCodepoint(
      `${left.reason_code}\0${left.path ?? ""}\0${left.target_agent ?? ""}`,
      `${right.reason_code}\0${right.path ?? ""}\0${right.target_agent ?? ""}`
    )
  );
}

function qualitySuggestions(input: NormalizedInspectionInput): InstructionQualitySuggestion[] {
  const active = new Set(input.manifest.files
    .filter((file) => file.status === "active")
    .map((file) => file.topic));
  const missing: Array<{
    topic: InstructionQualitySuggestion["topic"];
    reason_code: InstructionQualityReasonCode;
    present: boolean;
  }> = [
    {
      topic: "architecture",
      reason_code: "INSTRUCTION_TOPIC_ARCHITECTURE_MISSING",
      present: active.has("architecture")
    },
    {
      topic: "build",
      reason_code: "INSTRUCTION_TOPIC_BUILD_MISSING",
      present: active.has("workflow")
    },
    {
      topic: "testing",
      reason_code: "INSTRUCTION_TOPIC_TESTING_MISSING",
      present: active.has("testing")
    }
  ];
  return missing.filter((item) => !item.present).map(({ topic, reason_code: reasonCode }) => ({
    suggestion_id: `suggestion:${stableHash({ topic, reason_code: reasonCode }).slice(7, 23)}`,
    reason_code: reasonCode,
    topic
  }));
}

function projectionHashes(
  input: NormalizedInspectionInput
): Partial<Record<InstructionTargetAgent, string>> {
  const result: Partial<Record<InstructionTargetAgent, string>> = {};
  for (const currentAgent of input.enabled_agents) {
    result[currentAgent] = stableHash({
      entrypoints: input.entrypoints.filter((entry) => entry.agent === currentAgent),
      files: input.projection_files.filter((file) => file.agent === currentAgent)
    });
  }
  return result;
}

export function inspectInstructions(input: InstructionInspectionInput): InstructionHealth {
  const normalized = normalize(input);
  const fingerprintInput = {
    ...normalized,
    last_proposal_ref: normalized.last_proposal_ref,
    last_apply_receipt_ref: normalized.last_apply_receipt_ref
  };
  const inputFingerprint = stableHash(fingerprintInput);
  const canonicalHash = stableHash({
    manifest: normalized.manifest,
    files: normalized.canonical_files.map(({ path: canonicalPath, content_hash }) => ({
      path: canonicalPath,
      content_hash
    }))
  });
  const findings = structureFindings(normalized);
  const suggestions = qualitySuggestions(normalized);
  const requiresReinspection = input.previous_input_fingerprint !== inputFingerprint;
  let status: InstructionHealthStatus;
  if (findings.some((item) => item.reason_code === "INSTRUCTION_PROJECTION_CONFLICT")) {
    status = "conflicted";
  } else if (findings.length > 0) {
    status = "invalid";
  } else {
    status = requiresReinspection ? "review_required" : "current";
  }
  const base = {
    schema_version: 1 as const,
    input_fingerprint: inputFingerprint,
    canonical_hash: canonicalHash,
    projection_hashes: projectionHashes(normalized),
    status,
    structure_findings: findings,
    quality_suggestions: suggestions,
    ...(normalized.last_proposal_ref === undefined
      ? {}
      : { last_proposal_ref: normalized.last_proposal_ref }),
    ...(normalized.last_apply_receipt_ref === undefined
      ? {}
      : { last_apply_receipt_ref: normalized.last_apply_receipt_ref }),
    requires_reinspection: requiresReinspection
  };
  const resultHash = stableHash(base);
  return deepFreeze({
    ...base,
    inspection_id: `inspection:${resultHash.slice(7, 23)}`,
    inspection_ref: {
      schema_version: 1 as const,
      input_fingerprint: inputFingerprint,
      canonical_hash: canonicalHash,
      result_hash: resultHash
    }
  }) as InstructionHealth;
}
