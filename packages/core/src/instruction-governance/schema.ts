import { classifyContentPath } from "@hunter-harness/contracts";

import {
  INSTRUCTION_TARGET_AGENTS,
  RULE_ACTIVATIONS,
  RULE_STATUSES,
  RULE_TOPICS,
  type InstructionTargetAgent,
  type RuleActivation,
  type RuleStatus,
  type RuleTopic,
  type RulesGeneratorIdentity,
  type RulesManifest,
  type RulesManifestFile
} from "./types.js";
import { compareCodepoint, deepFreeze } from "./stable.js";

export type RulesManifestSchemaErrorCode =
  | "RULES_MANIFEST_INVALID"
  | "RULES_MANIFEST_UNKNOWN_FIELD";

export class RulesManifestSchemaError extends Error {
  readonly code: RulesManifestSchemaErrorCode;

  constructor(code: RulesManifestSchemaErrorCode, detail: string) {
    super(`${code}: ${detail}`);
    this.name = "RulesManifestSchemaError";
    this.code = code;
  }
}

export interface RuntimeSchema<T> {
  parse(value: unknown): T;
  safeParse(value: unknown):
    | { success: true; data: T }
    | { success: false; error: RulesManifestSchemaError };
}

const SHA256 = /^sha256:[a-f0-9]{64}$/u;
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u;
const TOPIC_PATH: Readonly<Record<RuleTopic, string>> = {
  core: ".harness/rules/core.md",
  architecture: ".harness/rules/architecture.md",
  coding: ".harness/rules/coding.md",
  testing: ".harness/rules/testing.md",
  workflow: ".harness/rules/workflow.md",
  security: ".harness/rules/security.md"
};

function ownRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    invalid(`${label} must be an object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    invalid(`${label} must be a plain object`);
  }
  return value as Record<string, unknown>;
}

export function strictRecord(
  value: unknown,
  label: string,
  allowed: readonly string[]
): Record<string, unknown> {
  const record = ownRecord(value, label);
  const unknown = Object.keys(record).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) {
    throw new RulesManifestSchemaError(
      "RULES_MANIFEST_UNKNOWN_FIELD",
      `${label}.${unknown.sort(compareCodepoint).join(",")}`
    );
  }
  return record;
}

export function invalid(detail: string): never {
  throw new RulesManifestSchemaError("RULES_MANIFEST_INVALID", detail);
}

export function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() !== value || value.length === 0 ||
      value.length > 512 || Array.from(value).some((character) => character.charCodeAt(0) <= 31)) {
    invalid(`${label} must be a bounded non-empty string`);
  }
  return value;
}

export function sha256(value: unknown, label: string): string {
  const result = requiredString(value, label);
  if (!SHA256.test(result)) invalid(`${label} must be a sha256 identity`);
  return result;
}

function stringArray(
  value: unknown,
  label: string,
  options: { max: number; allowEmpty: boolean }
): readonly string[] {
  if (!Array.isArray(value) || value.length > options.max ||
      (!options.allowEmpty && value.length === 0)) {
    invalid(`${label} must be a bounded array`);
  }
  const entries = value.map((item, index) => requiredString(item, `${label}[${index}]`));
  if (new Set(entries).size !== entries.length) invalid(`${label} contains duplicates`);
  return entries.sort(compareCodepoint);
}

function projectGlob(value: string, label: string): string {
  const lower = value.toLowerCase();
  const segments = lower.split("/");
  if (value.startsWith("/") || value.startsWith("\\") || /^[A-Za-z]:/u.test(value) ||
      value.includes("\\") || segments.some((segment) =>
        segment.length === 0 || segment === "." || segment === ".." ||
        segment === ".git" || segment.startsWith(".env") ||
        segment === "credentials.local" || segment.startsWith("credentials.local.")
      ) || lower === ".harness/state" || lower.startsWith(".harness/state/") ||
      lower === ".harness/runtime" || lower.startsWith(".harness/runtime/")) {
    invalid(`${label} must be a safe project-relative glob`);
  }
  return value;
}

function oneOf<T extends string>(
  value: unknown,
  label: string,
  values: readonly T[]
): T {
  if (typeof value !== "string" || !values.includes(value as T)) {
    invalid(`${label} is outside the frozen enum`);
  }
  return value as T;
}

export function targetAgents(value: unknown, label: string): readonly InstructionTargetAgent[] {
  const entries = stringArray(value, label, {
    max: INSTRUCTION_TARGET_AGENTS.length,
    allowEmpty: false
  });
  return entries.map((entry) => oneOf(entry, label, INSTRUCTION_TARGET_AGENTS));
}

function generator(value: unknown): RulesGeneratorIdentity {
  const record = strictRecord(value, "generator", ["name", "version", "prompt_version"]);
  const result: RulesGeneratorIdentity = {
    name: requiredString(record.name, "generator.name"),
    version: requiredString(record.version, "generator.version")
  };
  if (record.prompt_version !== undefined) {
    result.prompt_version = requiredString(record.prompt_version, "generator.prompt_version");
  }
  return result;
}

export function canonicalRulePath(value: unknown, label: string): string {
  const path = requiredString(value, label);
  const classification = classifyContentPath({ schema_version: 1, path });
  if (!("content_kind" in classification) || classification.content_kind !== "rule") {
    invalid(`${label} is not a stage-01 canonical rule path`);
  }
  return path;
}

function manifestFile(value: unknown, index: number): RulesManifestFile {
  const label = `files[${index}]`;
  const record = strictRecord(value, label, [
    "path",
    "topic",
    "status",
    "content_hash",
    "activation",
    "globs",
    "module_refs",
    "target_agents",
    "context_budget",
    "evidence_refs"
  ]);
  const topic = oneOf<RuleTopic>(record.topic, `${label}.topic`, RULE_TOPICS);
  const path = canonicalRulePath(record.path, `${label}.path`);
  if (path !== TOPIC_PATH[topic]) invalid(`${label}.path does not match its topic`);
  const activation = oneOf<RuleActivation>(
    record.activation,
    `${label}.activation`,
    RULE_ACTIVATIONS
  );
  const globs = stringArray(record.globs, `${label}.globs`, {
    max: 32,
    allowEmpty: true
  }).map((glob, index) => projectGlob(glob, `${label}.globs[${index}]`));
  if (activation === "path" && globs.length === 0) {
    invalid(`${label}.globs are required for path activation`);
  }
  if (activation === "always" && globs.length > 0) {
    invalid(`${label}.always activation cannot carry globs`);
  }
  const contextBudget = record.context_budget;
  if (!Number.isSafeInteger(contextBudget) || Number(contextBudget) < 1 ||
      Number(contextBudget) > 32_768) {
    invalid(`${label}.context_budget must be a positive safe integer`);
  }
  return {
    path,
    topic,
    status: oneOf<RuleStatus>(record.status, `${label}.status`, RULE_STATUSES),
    content_hash: sha256(record.content_hash, `${label}.content_hash`),
    activation,
    globs,
    module_refs: stringArray(record.module_refs, `${label}.module_refs`, {
      max: 64,
      allowEmpty: true
    }),
    target_agents: targetAgents(record.target_agents, `${label}.target_agents`),
    context_budget: Number(contextBudget),
    evidence_refs: stringArray(record.evidence_refs, `${label}.evidence_refs`, {
      max: 128,
      allowEmpty: true
    })
  };
}

function parseRulesManifest(value: unknown): RulesManifest {
  const record = strictRecord(value, "manifest", [
    "schema_version",
    "ruleset_version",
    "generator",
    "project_identity",
    "canonical_root",
    "files",
    "map_manifest_hash",
    "archive_evidence_cursor",
    "proposal_id",
    "reviewed_at",
    "supersedes"
  ]);
  if (record.schema_version !== 1) invalid("schema_version must equal 1");
  if (record.canonical_root !== ".harness/rules") {
    invalid("canonical_root must equal .harness/rules");
  }
  if (!Array.isArray(record.files) || record.files.length === 0 ||
      record.files.length > RULE_TOPICS.length) {
    invalid("files must be a bounded non-empty array");
  }
  const files = record.files.map(manifestFile).sort((left, right) =>
    compareCodepoint(left.path, right.path)
  );
  if (new Set(files.map((file) => file.path)).size !== files.length) {
    invalid("files contains duplicate canonical paths");
  }
  if (!files.some((file) => file.topic === "core" && file.activation === "always")) {
    invalid("an always-active core rule is required");
  }
  const result: RulesManifest = {
    schema_version: 1,
    ruleset_version: requiredString(record.ruleset_version, "ruleset_version"),
    generator: generator(record.generator),
    project_identity: requiredString(record.project_identity, "project_identity"),
    canonical_root: ".harness/rules",
    files
  };
  if (record.map_manifest_hash !== undefined) {
    result.map_manifest_hash = sha256(record.map_manifest_hash, "map_manifest_hash");
  }
  for (const field of ["archive_evidence_cursor", "proposal_id", "supersedes"] as const) {
    if (record[field] !== undefined) result[field] = requiredString(record[field], field);
  }
  if (record.reviewed_at !== undefined) {
    const reviewedAt = requiredString(record.reviewed_at, "reviewed_at");
    if (!RFC3339.test(reviewedAt) || !Number.isFinite(Date.parse(reviewedAt))) {
      invalid("reviewed_at must be RFC3339 with an offset");
    }
    result.reviewed_at = reviewedAt;
  }
  return deepFreeze(result) as RulesManifest;
}

export const rulesManifestSchema: RuntimeSchema<RulesManifest> = {
  parse: parseRulesManifest,
  safeParse(value) {
    try {
      return { success: true, data: parseRulesManifest(value) };
    } catch (error) {
      return {
        success: false,
        error: error instanceof RulesManifestSchemaError
          ? error
          : new RulesManifestSchemaError("RULES_MANIFEST_INVALID", String(error))
      };
    }
  }
};
