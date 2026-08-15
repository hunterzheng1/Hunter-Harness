import {
  projectContentCandidateSchema,
  type ProjectContentCandidate
} from "@hunter-harness/contracts";

import { assessMapEvidencePath } from "../codebase/map-v2/evidence.js";
import type {
  MapEvidenceBundle,
  MapEvidenceCandidate,
  MapEvidenceTopic
} from "../codebase/map-v2/types.js";
import { scanSensitiveFiles } from "../security/scanner.js";
import { deepFreeze } from "../instruction-governance/stable.js";
import type { RuleTopic } from "../instruction-governance/types.js";
import { fail, sha256, stableHash } from "./shared.js";
import type {
  InstructionEvidenceBundle,
  InstructionEvidenceConfidence,
  InstructionEvidenceItem,
  InstructionEvidenceScope
} from "./types.js";

const MAP_TOPICS = new Set<MapEvidenceTopic>([
  "stack", "integrations", "architecture", "structure", "conventions", "testing", "concerns"
]);
const RULE_TOPICS = new Set<RuleTopic>([
  "core", "architecture", "coding", "testing", "workflow", "security"
]);
const TOPIC_TARGET: Readonly<Record<MapEvidenceTopic, RuleTopic>> = {
  stack: "architecture",
  integrations: "architecture",
  architecture: "architecture",
  structure: "core",
  conventions: "coding",
  testing: "testing",
  concerns: "security"
};

function validateLimit(value: number, label: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    fail("INSTRUCTION_EVIDENCE_INPUT_INVALID", `${label} must be a positive bounded integer`);
  }
  return value;
}

function validateScope(scope: InstructionEvidenceScope): InstructionEvidenceScope {
  if (scope === null || typeof scope !== "object") {
    fail("INSTRUCTION_EVIDENCE_INPUT_INVALID", "scope must be an object");
  }
  const mapTopics = [...new Set(scope.map_topics)];
  if (mapTopics.length > MAP_TOPICS.size ||
      mapTopics.some((topic) => !MAP_TOPICS.has(topic))) {
    fail("INSTRUCTION_EVIDENCE_INPUT_INVALID", "map_topics contains an unknown topic");
  }
  const rules = { ...scope.candidate_rule_topics };
  if (Object.keys(rules).length > 128 ||
      Object.values(rules).some((topic) => !RULE_TOPICS.has(topic))) {
    fail("INSTRUCTION_EVIDENCE_INPUT_INVALID", "candidate_rule_topics is invalid");
  }
  const executable = [...new Set(scope.executable_architecture_candidate_ids)];
  if (executable.length > 128 || executable.some((id) => !/^pcc_[A-Za-z0-9_-]{1,156}$/u.test(id))) {
    fail("INSTRUCTION_EVIDENCE_INPUT_INVALID", "architecture candidate ids are invalid");
  }
  return {
    map_topics: mapTopics,
    candidate_rule_topics: rules,
    executable_architecture_candidate_ids: executable,
    max_items: validateLimit(scope.max_items, "max_items", 128),
    max_characters: validateLimit(scope.max_characters, "max_characters", 131_072),
    max_utf8_bytes: validateLimit(scope.max_utf8_bytes, "max_utf8_bytes", 262_144)
  };
}

function confidenceForCandidate(candidate: ProjectContentCandidate): InstructionEvidenceConfidence {
  // A single observation is never upgraded merely because its producer supplied a high score.
  if (candidate.evidence_refs.length < 2) return "low";
  if (candidate.confidence >= 0.85) return "high";
  if (candidate.confidence >= 0.6) return "medium";
  return "low";
}

function confidenceForMap(candidate: MapEvidenceCandidate): InstructionEvidenceConfidence {
  void candidate;
  // A selected map snippet is still one observation. It may support a proposal,
  // but it cannot promote itself into a high-confidence governance rule.
  return "low";
}

function validateMapBundle(bundle: MapEvidenceBundle): void {
  if (bundle === null || typeof bundle !== "object" || bundle.schema_version !== 2 ||
      !Array.isArray(bundle.requested_topics) || !Array.isArray(bundle.snippets)) {
    fail("INSTRUCTION_EVIDENCE_INPUT_INVALID", "map bundle is not MapEvidenceBundle v2");
  }
  sha256(bundle.manifest_hash, "map_bundle.manifest_hash", "INSTRUCTION_EVIDENCE_INPUT_INVALID");
  if (bundle.snippets.length > 128) {
    fail("INSTRUCTION_EVIDENCE_INPUT_INVALID", "map bundle contains too many snippets");
  }
}

function mapItems(
  bundle: MapEvidenceBundle,
  scope: InstructionEvidenceScope
): InstructionEvidenceItem[] {
  const topics = new Set(scope.map_topics);
  const items: InstructionEvidenceItem[] = [];
  for (const snippet of bundle.snippets) {
    if (!MAP_TOPICS.has(snippet.topic) || !topics.has(snippet.topic) ||
        !bundle.requested_topics.includes(snippet.topic) ||
        typeof snippet.content !== "string" || snippet.content.length === 0 ||
        snippet.content.length > 65_536) {
      continue;
    }
    const path = assessMapEvidencePath(snippet.source_path);
    if (!path.allowed) {
      fail("INSTRUCTION_EVIDENCE_INPUT_INVALID", `unsafe map evidence path: ${snippet.source_path}`);
    }
    if (scanSensitiveFiles({ [path.path]: snippet.content }).blocked) {
      fail("INSTRUCTION_EVIDENCE_SENSITIVE", `sensitive map evidence: ${path.path}`);
    }
    items.push({
      source_kind: "map",
      reference: `map:${bundle.manifest_hash}:${snippet.topic}:${path.path}`,
      source_version: bundle.source_commit ?? bundle.manifest_hash,
      source_path: path.path,
      content: snippet.content,
      confidence: confidenceForMap(snippet),
      eligibility: "supporting_only",
      target_topic: TOPIC_TARGET[snippet.topic],
      source_payload: {
        schema_version: 2,
        manifest_hash: bundle.manifest_hash,
        ...(bundle.source_commit === undefined ? {} : { source_commit: bundle.source_commit }),
        requested_topics: [...bundle.requested_topics],
        snippet: { ...snippet }
      }
    });
  }
  return items;
}

function parseCandidate(input: unknown, index: number): ProjectContentCandidate {
  const result = projectContentCandidateSchema.safeParse(input);
  if (!result.success) {
    fail("INSTRUCTION_CANDIDATE_WIRE_INVALID", `candidates[${index}] violates stage-01 schema`);
  }
  return result.data;
}

function candidateItems(
  candidates: readonly unknown[],
  scope: InstructionEvidenceScope
): InstructionEvidenceItem[] {
  if (!Array.isArray(candidates) || candidates.length > 128) {
    fail("INSTRUCTION_CANDIDATE_WIRE_INVALID", "candidates must be a bounded array");
  }
  const executable = new Set(scope.executable_architecture_candidate_ids);
  const items: InstructionEvidenceItem[] = [];
  for (const [index, input] of candidates.entries()) {
    const candidate = parseCandidate(input, index);
    if (candidate.status !== "pending" && candidate.status !== "proposed") continue;
    let targetTopic: RuleTopic | null = null;
    let eligibility: InstructionEvidenceItem["eligibility"];
    if (candidate.candidate_type === "rule") {
      targetTopic = scope.candidate_rule_topics[candidate.candidate_id] ?? null;
      eligibility = targetTopic === null ? "review_only" : "proposable";
    } else if (candidate.candidate_type === "architecture-decision") {
      targetTopic = executable.has(candidate.candidate_id) ? "architecture" : null;
      eligibility = targetTopic === null ? "review_only" : "proposable";
    } else {
      eligibility = "display_only";
    }
    const scanPath = targetTopic === null
      ? ".harness/rules/core.md"
      : `.harness/rules/${targetTopic}.md`;
    if (scanSensitiveFiles({ [scanPath]: candidate.proposed_content }).blocked) {
      fail("INSTRUCTION_EVIDENCE_SENSITIVE", `candidate:${candidate.candidate_id}`);
    }
    items.push({
      source_kind: "candidate",
      reference: `candidate:${candidate.candidate_id}`,
      source_version: `${candidate.provenance.producer}@${candidate.provenance.producer_version}`,
      source_path: candidate.provenance.source_ref,
      content: candidate.proposed_content,
      confidence: confidenceForCandidate(candidate),
      eligibility,
      target_topic: targetTopic,
      candidate_type: candidate.candidate_type,
      source_payload: structuredClone(candidate)
    });
  }
  return items;
}

function addReason(
  reasons: InstructionEvidenceBundle["truncation_reasons"][number][],
  reason: InstructionEvidenceBundle["truncation_reasons"][number]
): void {
  if (!reasons.includes(reason)) reasons.push(reason);
}

export function evidencePayload(bundle: Omit<InstructionEvidenceBundle, "evidence_hash">): unknown {
  return bundle;
}

function ownRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value) ||
      (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    fail("INSTRUCTION_EVIDENCE_INPUT_INVALID", `${label} must be a plain object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(record: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const unknown = Object.keys(record).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) {
    fail("INSTRUCTION_EVIDENCE_INPUT_INVALID", `${label} contains unknown fields`);
  }
}

function normalizedCandidateItem(
  raw: unknown,
  scope: InstructionEvidenceScope,
  index: number
): InstructionEvidenceItem {
  const candidate = parseCandidate(raw, index);
  if (candidate.status !== "pending" && candidate.status !== "proposed") {
    fail("INSTRUCTION_EVIDENCE_INPUT_INVALID", `items[${index}] candidate is not reviewable`);
  }
  let targetTopic: RuleTopic | null = null;
  let eligibility: InstructionEvidenceItem["eligibility"];
  if (candidate.candidate_type === "rule") {
    targetTopic = scope.candidate_rule_topics[candidate.candidate_id] ?? null;
    eligibility = targetTopic === null ? "review_only" : "proposable";
  } else if (candidate.candidate_type === "architecture-decision") {
    targetTopic = scope.executable_architecture_candidate_ids.includes(candidate.candidate_id)
      ? "architecture"
      : null;
    eligibility = targetTopic === null ? "review_only" : "proposable";
  } else {
    eligibility = "display_only";
  }
  const scanPath = targetTopic === null ? ".harness/rules/core.md" : `.harness/rules/${targetTopic}.md`;
  if (scanSensitiveFiles({ [scanPath]: candidate.proposed_content }).blocked) {
    fail("INSTRUCTION_EVIDENCE_SENSITIVE", `candidate:${candidate.candidate_id}`);
  }
  return {
    source_kind: "candidate",
    reference: `candidate:${candidate.candidate_id}`,
    source_version: `${candidate.provenance.producer}@${candidate.provenance.producer_version}`,
    source_path: candidate.provenance.source_ref,
    content: candidate.proposed_content,
    confidence: confidenceForCandidate(candidate),
    eligibility,
    target_topic: targetTopic,
    candidate_type: candidate.candidate_type,
    source_payload: structuredClone(candidate)
  };
}

function normalizedMapItem(
  raw: unknown,
  scope: InstructionEvidenceScope,
  bundleManifestHash: string,
  index: number
): InstructionEvidenceItem {
  const payload = ownRecord(raw, `items[${index}].source_payload`);
  exactKeys(payload, [
    "schema_version", "manifest_hash", "source_commit", "requested_topics", "snippet"
  ], `items[${index}].source_payload`);
  if (payload.schema_version !== 2 || payload.manifest_hash !== bundleManifestHash ||
      !Array.isArray(payload.requested_topics) ||
      payload.requested_topics.some((topic) => !MAP_TOPICS.has(topic as MapEvidenceTopic)) ||
      (payload.source_commit !== undefined &&
        (typeof payload.source_commit !== "string" || payload.source_commit.length === 0))) {
    fail("INSTRUCTION_EVIDENCE_INPUT_INVALID", `items[${index}] map source identity is invalid`);
  }
  const snippet = ownRecord(payload.snippet, `items[${index}].source_payload.snippet`);
  exactKeys(snippet, [
    "topic", "source_path", "content", "confidence", "evidence_source"
  ], `items[${index}].source_payload.snippet`);
  if (!MAP_TOPICS.has(snippet.topic as MapEvidenceTopic) ||
      !["verified", "inferred", "unverified"].includes(String(snippet.confidence)) ||
      !["codegraph", "filesystem", "manifest"].includes(String(snippet.evidence_source)) ||
      typeof snippet.source_path !== "string" || typeof snippet.content !== "string" ||
      snippet.content.length === 0 || snippet.content.length > 65_536) {
    fail("INSTRUCTION_EVIDENCE_INPUT_INVALID", `items[${index}] map snippet is invalid`);
  }
  const topic = snippet.topic as MapEvidenceTopic;
  if (!payload.requested_topics.includes(topic) || !scope.map_topics.includes(topic)) {
    fail("INSTRUCTION_EVIDENCE_INPUT_INVALID", `items[${index}] map topic is outside scope`);
  }
  const path = assessMapEvidencePath(snippet.source_path);
  if (!path.allowed) {
    fail("INSTRUCTION_EVIDENCE_INPUT_INVALID", `items[${index}] map path is unsafe`);
  }
  if (scanSensitiveFiles({ [path.path]: snippet.content }).blocked) {
    fail("INSTRUCTION_EVIDENCE_SENSITIVE", `items[${index}] map content is sensitive`);
  }
  const typedSnippet = {
    topic,
    source_path: path.path,
    content: snippet.content,
    confidence: snippet.confidence as MapEvidenceCandidate["confidence"],
    evidence_source: snippet.evidence_source as MapEvidenceCandidate["evidence_source"]
  };
  return {
    source_kind: "map",
    reference: `map:${bundleManifestHash}:${topic}:${path.path}`,
    source_version: payload.source_commit as string | undefined ?? bundleManifestHash,
    source_path: path.path,
    content: typedSnippet.content,
    confidence: "low",
    eligibility: "supporting_only",
    target_topic: TOPIC_TARGET[topic],
    source_payload: {
      schema_version: 2,
      manifest_hash: bundleManifestHash,
      ...(payload.source_commit === undefined ? {} : { source_commit: payload.source_commit as string }),
      requested_topics: [...payload.requested_topics] as MapEvidenceTopic[],
      snippet: typedSnippet
    }
  };
}

/** The sole runtime trust boundary for selected evidence, including proposal input. */
export function normalizeInstructionEvidence(input: unknown): InstructionEvidenceBundle {
  const record = ownRecord(input, "evidence");
  exactKeys(record, [
    "schema_version", "map_manifest_hash", "selection_scope", "items", "used_budget", "limits",
    "truncation_reasons", "evidence_hash"
  ], "evidence");
  if (record.schema_version !== 1 || !Array.isArray(record.items) || record.items.length > 128) {
    fail("INSTRUCTION_EVIDENCE_INPUT_INVALID", "evidence must be a bounded v1 bundle");
  }
  const mapManifestHash = sha256(
    record.map_manifest_hash,
    "evidence.map_manifest_hash",
    "INSTRUCTION_EVIDENCE_INPUT_INVALID"
  );
  const scope = validateScope(record.selection_scope as InstructionEvidenceScope);
  const normalizedItems = record.items.map((rawItem, index) => {
    const item = ownRecord(rawItem, `items[${index}]`);
    if (item.source_kind === "candidate") {
      exactKeys(item, [
        "source_kind", "reference", "source_version", "source_path", "content", "confidence",
        "eligibility", "target_topic", "candidate_type", "source_payload"
      ], `items[${index}]`);
      return normalizedCandidateItem(item.source_payload, scope, index);
    }
    if (item.source_kind === "map") {
      exactKeys(item, [
        "source_kind", "reference", "source_version", "source_path", "content", "confidence",
        "eligibility", "target_topic", "source_payload"
      ], `items[${index}]`);
      return normalizedMapItem(item.source_payload, scope, mapManifestHash, index);
    }
    fail("INSTRUCTION_EVIDENCE_INPUT_INVALID", `items[${index}].source_kind is invalid`);
  });
  if (record.items.some((item, index) => stableHash(item) !== stableHash(normalizedItems[index]))) {
    fail("INSTRUCTION_EVIDENCE_INPUT_INVALID", "derived evidence fields do not match raw sources");
  }
  const references = normalizedItems.map((item) => item.reference);
  if (new Set(references).size !== references.length ||
      references.some((reference, index) => {
        const previous = references[index - 1];
        return previous !== undefined && previous > reference;
      })) {
    fail("INSTRUCTION_EVIDENCE_INPUT_INVALID", "evidence references must be unique and sorted");
  }
  const limits = ownRecord(record.limits, "evidence.limits");
  exactKeys(limits, ["max_items", "max_characters", "max_utf8_bytes"], "evidence.limits");
  if (limits.max_items !== scope.max_items || limits.max_characters !== scope.max_characters ||
      limits.max_utf8_bytes !== scope.max_utf8_bytes) {
    fail("INSTRUCTION_EVIDENCE_INPUT_INVALID", "evidence limits do not match selection scope");
  }
  const characters = normalizedItems.reduce((sum, item) => sum + Array.from(item.content).length, 0);
  const utf8Bytes = normalizedItems.reduce((sum, item) => sum + Buffer.byteLength(item.content, "utf8"), 0);
  const used = ownRecord(record.used_budget, "evidence.used_budget");
  exactKeys(used, ["items", "characters", "utf8_bytes"], "evidence.used_budget");
  if (used.items !== normalizedItems.length || used.characters !== characters ||
      used.utf8_bytes !== utf8Bytes || normalizedItems.length > scope.max_items ||
      characters > scope.max_characters || utf8Bytes > scope.max_utf8_bytes) {
    fail("INSTRUCTION_EVIDENCE_INPUT_INVALID", "evidence budget is invalid");
  }
  if (!Array.isArray(record.truncation_reasons) ||
      record.truncation_reasons.some((reason) =>
        !["item_limit", "character_limit", "utf8_byte_limit"].includes(String(reason))) ||
      new Set(record.truncation_reasons).size !== record.truncation_reasons.length) {
    fail("INSTRUCTION_EVIDENCE_INPUT_INVALID", "truncation reasons are invalid");
  }
  const withoutHash: Omit<InstructionEvidenceBundle, "evidence_hash"> = {
    schema_version: 1,
    map_manifest_hash: mapManifestHash,
    selection_scope: scope,
    items: normalizedItems,
    used_budget: { items: normalizedItems.length, characters, utf8_bytes: utf8Bytes },
    limits: {
      max_items: scope.max_items,
      max_characters: scope.max_characters,
      max_utf8_bytes: scope.max_utf8_bytes
    },
    truncation_reasons: [...record.truncation_reasons] as InstructionEvidenceBundle["truncation_reasons"]
  };
  const evidenceHash = stableHash(evidencePayload(withoutHash));
  if (record.evidence_hash !== evidenceHash) {
    fail("INSTRUCTION_EVIDENCE_INPUT_INVALID", "evidence_hash does not match normalized evidence");
  }
  return deepFreeze({ ...withoutHash, evidence_hash: evidenceHash });
}

export function selectInstructionEvidence(
  mapBundle: MapEvidenceBundle,
  candidates: readonly unknown[],
  inputScope: InstructionEvidenceScope
): InstructionEvidenceBundle {
  validateMapBundle(mapBundle);
  const scope = validateScope(inputScope);
  const eligible = [...candidateItems(candidates, scope), ...mapItems(mapBundle, scope)]
    .sort((left, right) => left.reference.localeCompare(right.reference, "en"));
  const reasons: InstructionEvidenceBundle["truncation_reasons"][number][] = [];
  const items: InstructionEvidenceItem[] = [];
  let characters = 0;
  let utf8Bytes = 0;
  for (const item of eligible) {
    const itemCharacters = Array.from(item.content).length;
    const itemBytes = Buffer.byteLength(item.content, "utf8");
    if (items.length >= scope.max_items) {
      addReason(reasons, "item_limit");
      continue;
    }
    if (characters + itemCharacters > scope.max_characters) {
      addReason(reasons, "character_limit");
      continue;
    }
    if (utf8Bytes + itemBytes > scope.max_utf8_bytes) {
      addReason(reasons, "utf8_byte_limit");
      continue;
    }
    items.push(item);
    characters += itemCharacters;
    utf8Bytes += itemBytes;
  }
  const withoutHash: Omit<InstructionEvidenceBundle, "evidence_hash"> = {
    schema_version: 1,
    map_manifest_hash: mapBundle.manifest_hash,
    selection_scope: scope,
    items,
    used_budget: { items: items.length, characters, utf8_bytes: utf8Bytes },
    limits: {
      max_items: scope.max_items,
      max_characters: scope.max_characters,
      max_utf8_bytes: scope.max_utf8_bytes
    },
    truncation_reasons: reasons
  };
  return normalizeInstructionEvidence({
    ...withoutHash,
    evidence_hash: stableHash(evidencePayload(withoutHash))
  });
}
