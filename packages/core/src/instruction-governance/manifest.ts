import {
  canonicalRulePath,
  requiredString,
  rulesManifestSchema,
  sha256,
  strictRecord,
  targetAgents
} from "./schema.js";
import { compareCodepoint, deepFreeze } from "./stable.js";
import type {
  CompatibleRulesManifest,
  CompatibleRulesManifestFile,
  RulesManifestDegradationReason,
  RulesManifestReadResult
} from "./types.js";

const LEGACY_ROOT_FIELDS = [
  "schema_version",
  "ruleset_version",
  "canonical_root",
  "files"
] as const;

function sourceVersion(value: unknown): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return undefined;
  return Object.hasOwn(value, "schema_version")
    ? (value as Record<string, unknown>).schema_version
    : undefined;
}

function legacyManifest(value: unknown): CompatibleRulesManifest {
  const record = strictRecord(value, "legacy_manifest", LEGACY_ROOT_FIELDS);
  if (record.schema_version !== 0) throw new Error("legacy schema_version must equal 0");
  if (record.canonical_root !== ".harness/rules") {
    throw new Error("legacy canonical_root is invalid");
  }
  if (!Array.isArray(record.files) || record.files.length === 0 || record.files.length > 32) {
    throw new Error("legacy files are invalid");
  }
  const files: CompatibleRulesManifestFile[] = record.files.map((value, index) => {
    const file = strictRecord(value, `legacy_files[${index}]`, [
      "path",
      "content_hash",
      "target_agents"
    ]);
    const path = canonicalRulePath(file.path, `legacy_files[${index}].path`);
    if (!path.toLowerCase().endsWith(".md")) throw new Error("legacy rule must be markdown");
    return {
      path,
      content_hash: sha256(file.content_hash, `legacy_files[${index}].content_hash`),
      target_agents: targetAgents(file.target_agents, `legacy_files[${index}].target_agents`)
    };
  }).sort((left, right) => compareCodepoint(left.path, right.path));
  if (new Set(files.map((file) => file.path)).size !== files.length) {
    throw new Error("legacy files contain duplicates");
  }
  const result: CompatibleRulesManifest = {
    schema_version: 1,
    canonical_root: ".harness/rules",
    files
  };
  if (record.ruleset_version !== undefined) {
    result.ruleset_version = requiredString(record.ruleset_version, "ruleset_version");
  }
  return result;
}

export function readRulesManifest(input: unknown): RulesManifestReadResult {
  const version = sourceVersion(input);
  if (version !== 0 && version !== 1) {
    return deepFreeze(version === undefined
      ? { ok: false, reason_code: "RULES_MANIFEST_INVALID" as const }
      : { ok: false, reason_code: "RULES_MANIFEST_VERSION_UNSUPPORTED" as const });
  }
  if (version === 1) {
    const parsed = rulesManifestSchema.safeParse(input);
    return parsed.success
      ? deepFreeze({
        ok: true as const,
        source_schema_version: 1 as const,
        manifest: parsed.data,
        degradation_reasons: []
      })
      : deepFreeze({ ok: false as const, reason_code: "RULES_MANIFEST_INVALID" as const });
  }
  try {
    const degradationReasons: RulesManifestDegradationReason[] = [
      "RULES_MANIFEST_LEGACY_FILE_METADATA_UNAVAILABLE",
      "RULES_MANIFEST_LEGACY_GENERATOR_UNAVAILABLE",
      "RULES_MANIFEST_LEGACY_PROJECT_IDENTITY_UNAVAILABLE"
    ];
    return deepFreeze({
      ok: true as const,
      source_schema_version: 0 as const,
      manifest: legacyManifest(input),
      degradation_reasons: degradationReasons.sort(compareCodepoint)
    });
  } catch {
    return deepFreeze({ ok: false as const, reason_code: "RULES_MANIFEST_INVALID" as const });
  }
}
