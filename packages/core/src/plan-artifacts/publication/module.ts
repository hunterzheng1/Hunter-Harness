import { types as utilTypes } from "node:util";

import { canonicalJson } from "@hunter-harness/contracts";

import { sha256Bytes } from "../../fs/hash.js";
import { createPlanArtifactModel } from "../module.js";
import type { ArtifactIdentity } from "../types.js";
import type {
  PlanArtifactPublicationPlan,
  PlanArtifactPublicationManifest,
  PlanArtifactPublicationResult,
  PlanPublicationClassification,
  PlanPublicationFormat,
  PlanPublicationPathAuthorityPort,
  PlanPublicationPayload,
  TrustedPlanArtifactSet
} from "./types.js";

const CHANGE_KEY = /^[a-z][a-z0-9_.-]{0,159}$/u;
const MAX_INPUT_NODES = 100_000;
const MAX_INPUT_DEPTH = 64;
const MAX_STRING_BYTES = 2_000_000;
const MAX_TOTAL_STRING_CODE_UNITS = 4_000_000;
const MAX_TOTAL_STRING_BYTES = 8_000_000;
const MAX_ARRAY_ITEMS = 100_000;
const MAX_OBJECT_KEYS = 100_000;
const MAX_PAYLOAD_BYTES = 2_000_000;
const MAX_PUBLICATION_BYTES = 8_000_000;

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function plain(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) && !utilTypes.isProxy(value);
}

function data(value: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor !== undefined && Object.hasOwn(descriptor, "value") ? descriptor.value : undefined;
}

function snapshotInput(value: unknown): unknown | undefined {
  let nodes = 0;
  let arrayItems = 0;
  let objectKeys = 0;
  let stringCodeUnits = 0;
  let stringBytes = 0;
  const active = new Set<object>();
  function accountString(candidate: string): void {
    stringCodeUnits += candidate.length;
    if (candidate.length > MAX_STRING_BYTES || stringCodeUnits > MAX_TOTAL_STRING_CODE_UNITS) {
      throw new Error("string code unit bound");
    }
    const bytes = Buffer.byteLength(candidate, "utf8");
    stringBytes += bytes;
    if (bytes > MAX_STRING_BYTES || stringBytes > MAX_TOTAL_STRING_BYTES) throw new Error("string byte bound");
  }
  function visit(candidate: unknown, depth: number): unknown {
    nodes += 1;
    if (nodes > MAX_INPUT_NODES || depth > MAX_INPUT_DEPTH) throw new Error("input bound");
    if (typeof candidate === "string") {
      accountString(candidate);
      return candidate;
    }
    if (candidate === null || typeof candidate === "boolean" || typeof candidate === "number" ||
        candidate === undefined) return candidate;
    if (typeof candidate !== "object" || utilTypes.isProxy(candidate) || active.has(candidate)) {
      throw new Error("unsupported input");
    }
    const prototype = Object.getPrototypeOf(candidate);
    if (Array.isArray(candidate)) {
      if (prototype !== Array.prototype) throw new Error("array prototype");
    } else if (prototype !== Object.prototype && prototype !== null) {
      throw new Error("object prototype");
    }
    active.add(candidate);
    try {
      const descriptors = Object.getOwnPropertyDescriptors(candidate);
      if (Object.getOwnPropertySymbols(candidate).length !== 0) throw new Error("symbol key");
      if (Array.isArray(candidate)) {
        const keys = Object.keys(descriptors).filter((key) => key !== "length");
        arrayItems += keys.length;
        if (arrayItems > MAX_ARRAY_ITEMS) throw new Error("array item bound");
        if (keys.length !== candidate.length || keys.some((key, index) => key !== String(index))) {
          throw new Error("sparse array");
        }
        return keys.map((key) => {
          const descriptor = descriptors[key];
          if (descriptor === undefined || !Object.hasOwn(descriptor, "value") || !descriptor.enumerable) {
            throw new Error("array accessor");
          }
          return visit(descriptor.value, depth + 1);
        });
      }
      const output: Record<string, unknown> = {};
      const entries = Object.entries(descriptors);
      objectKeys += entries.length;
      if (objectKeys > MAX_OBJECT_KEYS) throw new Error("object key bound");
      for (const [key, descriptor] of entries) {
        accountString(key);
        if (!Object.hasOwn(descriptor, "value") || !descriptor.enumerable) throw new Error("object accessor");
        output[key] = visit(descriptor.value, depth + 1);
      }
      return output;
    } finally {
      active.delete(candidate);
    }
  }
  try { return visit(value, 0); } catch { return undefined; }
}

function exact(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function compareCodepoint(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function markdown(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll("\\", "\\\\").replaceAll("[", "\\[").replaceAll("]", "\\]")
    .replaceAll("*", "\\*").replaceAll("`", "\\`").replaceAll("#", "\\#")
    .replaceAll("\r\n", "<br>").replaceAll("\r", "<br>").replaceAll("\n", "<br>");
}

function sorted(values: readonly string[]): readonly string[] {
  return [...values].sort(compareCodepoint);
}

function list(title: string, values: readonly string[]): string {
  return `## ${title}\n\n${values.length === 0 ? "- None." : sorted(values).map((value) => `- ${markdown(value)}`).join("\n")}\n`;
}

function frontmatter(type: string, hash: string): string {
  return `---\nschema_version: 2\nartifact_type: ${type}\ncontent_hash: ${hash}\ngenerated: true\n---\n`;
}

function renderDesign(artifact: TrustedPlanArtifactSet["human"]["design"]): string {
  const value = artifact.content;
  return `${frontmatter(artifact.artifact_type, artifact.content_hash)}\n# Design\n\n` +
    `## Goal\n\n${markdown(value.goal)}\n\n## User-visible outcome\n\n${markdown(value.user_visible_outcome)}\n\n` +
    list("In scope", value.in_scope) + "\n" + list("Out of scope", value.out_of_scope) + "\n" +
    `## Behavior contract\n\n${markdown(value.behavior_contract)}\n\n` + list("Constraints", value.constraints) + "\n" +
    list("Invariants", value.invariants) + "\n" + list("Failure behaviors", value.failure_behaviors) + "\n" +
    list("Tradeoffs", value.tradeoffs) + "\n" + list("Compatibility boundaries", value.compatibility_boundaries) +
    `\n## Risks\n\n${value.risks.length === 0 ? "- None." : [...value.risks]
      .sort((left, right) => compareCodepoint(left.risk, right.risk)).map((risk) =>
        `- ${markdown(risk.risk)}\n  - Mitigation: ${markdown(risk.mitigation)}`).join("\n")}\n` +
    `\n## Requirements\n\n${[...value.requirements].sort((left, right) =>
      compareCodepoint(left.requirement_id, right.requirement_id)).map((item) =>
      `- ${markdown(item.requirement_id)} [${item.kind}]: ${markdown(item.text)}\n` +
      `  - Evidence refs: ${sorted(item.evidence_refs).map(markdown).join(", ")}\n` +
      `  - Approved scope refs: ${sorted(item.approved_scope_refs).map(markdown).join(", ")}`).join("\n")}\n` +
    `\n## Approved scopes\n\n${[...value.approved_scopes].sort((left, right) =>
      compareCodepoint(left.scope_ref, right.scope_ref)).map((item) =>
      `- ${markdown(item.scope_ref)}: ${markdown(item.text)}`).join("\n")}\n` +
    `\n## Ownership\n\n${[...value.ownership].sort((left, right) =>
      compareCodepoint(left.ownership_ref, right.ownership_ref)).map((item) =>
      `- ${markdown(item.ownership_ref)}: ${markdown(item.path)}\n` +
      `  - Evidence refs: ${sorted(item.evidence_refs).map(markdown).join(", ")}\n` +
      `  - Approved scope refs: ${sorted(item.approved_scope_refs).map(markdown).join(", ")}`).join("\n")}\n`;
}

function renderPlan(artifact: TrustedPlanArtifactSet["human"]["plan"]): string {
  return `${frontmatter(artifact.artifact_type, artifact.content_hash)}\n# Plan\n\n## Change key\n\n` +
    `${artifact.content.change_key}\n\n## Tasks\n\n${artifact.content.tasks.map((task) => [
      `### ${task.task_id}`,
      "",
      task.objective,
      "",
      `- Owner phase: ${task.owner_phase}`,
      `- Affected paths: ${task.affected_paths.join(", ") || "None"}`,
      `- Depends on: ${task.depends_on.join(", ") || "None"}`,
      `- Decision refs: ${task.decision_refs.join(", ") || "None"}`,
      `- Scenario refs: ${task.scenario_refs.join(", ") || "None"}`,
      `- Requirement refs: ${task.requirement_refs.join(", ") || "None"}`,
      `- Evidence refs: ${task.evidence_refs.join(", ") || "None"}`,
      `- Ownership refs: ${task.ownership_refs.join(", ") || "None"}`
    ].join("\n")).join("\n\n")}\n`;
}

function renderScenarios(artifact: TrustedPlanArtifactSet["human"]["test_scenarios"]): string {
  return `${frontmatter(artifact.artifact_type, artifact.content_hash)}\n# Test Scenarios\n\n` +
    artifact.content.scenarios.map((scenario) => [
      `## ${scenario.scenario_id}: ${scenario.title}`,
      "",
      scenario.acceptance,
      "",
      `- Coverage dimension: ${scenario.coverage_dimension}`,
      `- Execution level: ${scenario.execution_level}`,
      `- Risk level: ${scenario.risk_level}`,
      `- Priority: ${scenario.priority}`,
      `- Owner phase: ${scenario.owner_phase}`,
      `- Evidence requirements: ${scenario.evidence_requirements.join(", ") || "None"}`,
      `- Task refs: ${scenario.task_refs.join(", ") || "None"}`,
      `- Requirement refs: ${scenario.requirement_refs.join(", ") || "None"}`,
      ...(scenario.executable_test_id === undefined ? [] : [`- Executable test ID: ${scenario.executable_test_id}`]),
      ...(scenario.test_file === undefined ? [] : [`- Test file: ${scenario.test_file}`]),
      ...(scenario.test_title === undefined ? [] : [`- Test title: ${scenario.test_title}`]),
      ...(scenario.verification_command === undefined ? [] : [`- Verification command: ${scenario.verification_command}`])
    ].join("\n")).join("\n\n") +
    `\n\n## Coverage\n\n${artifact.content.coverage.map((item) =>
      `- ${item.coverage_dimension}: ${item.applicability}; scenarios=${item.scenario_refs.join(",") || "none"}` +
      (item.not_applicable_reason === undefined ? "" : `; reason=${item.not_applicable_reason}`)).join("\n")}\n`;
}

function renderCompatibility(artifact: TrustedPlanArtifactSet["detail"]): string {
  return `${frontmatter(artifact.artifact_type, artifact.content_hash)}\n# Implementation Detail\n\n` +
    Object.entries(artifact.content).map(([key, value]) =>
      `## ${key.replaceAll("_", " ")}\n\n${typeof value === "string" ? value : `\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\``}`
    ).join("\n\n") + "\n";
}

function payload(path: string, artifact: ArtifactIdentity, format: PlanPublicationFormat,
  classification: PlanPublicationClassification, serialized: string): PlanPublicationPayload {
  const bytes = [...Buffer.from(serialized, "utf8")];
  if (bytes.length > MAX_PAYLOAD_BYTES) throw new Error("publication payload bound");
  return deepFreeze({ path, artifact_type: artifact.artifact_type, format, classification,
    serialized_content: serialized, bytes, byte_length: bytes.length,
    serialized_sha256: sha256Bytes(serialized), semantic_content_hash: artifact.content_hash });
}

function paths(changeKey: string): readonly string[] {
  return deepFreeze([
    `plans/${changeKey}-design.md`,
    `plans/${changeKey}-plan.md`,
    `plans/${changeKey}-test-scenarios.md`,
    `plans/${changeKey}-implementation-detail.md`,
    "meta/gate-policy.json",
    "meta/worktree.json",
    "meta/implementation-checkpoints.json",
    "meta/scenario-manifest.json"
  ]);
}

function current(snapshot: unknown): { change_key: string; trusted: TrustedPlanArtifactSet } | undefined {
  if (!plain(snapshot) || !exact(snapshot, ["schema_version", "change_key", "trusted"]) ||
      data(snapshot, "schema_version") !== 1) return undefined;
  const changeKey = data(snapshot, "change_key");
  if (typeof changeKey !== "string" || !CHANGE_KEY.test(changeKey)) return undefined;
  const trusted = data(snapshot, "trusted");
  if (!plain(trusted)) return undefined;
  try {
    const candidate = trusted as unknown as TrustedPlanArtifactSet;
    if (!createPlanArtifactModel().verifyArtifactSet(candidate).valid ||
        candidate.human.plan.content.change_key !== changeKey) return undefined;
    return { change_key: changeKey, trusted: candidate };
  } catch { return undefined; }
}

function authorized(authority: PlanPublicationPathAuthorityPort, changeKey: string,
  targetPaths: readonly string[]): boolean {
  if (authority === null || typeof authority !== "object" || utilTypes.isProxy(authority) ||
      Array.isArray(authority)) return false;
  const prototype = Object.getPrototypeOf(authority);
  if (prototype !== Object.prototype && prototype !== null) return false;
  const descriptors = Object.getOwnPropertyDescriptors(authority);
  if (Object.getOwnPropertySymbols(authority).length !== 0 || Object.keys(descriptors).length !== 1) return false;
  const descriptor = descriptors.verify;
  if (descriptor === undefined || !Object.hasOwn(descriptor, "value") || !descriptor.enumerable ||
      typeof descriptor.value !== "function" || utilTypes.isProxy(descriptor.value)) return false;
  try { return descriptor.value({ change_key: changeKey, paths: targetPaths }) === true; } catch { return false; }
}

export function planArtifactPublication(input: unknown,
  authority: PlanPublicationPathAuthorityPort): PlanArtifactPublicationResult {
  const snapshot = snapshotInput(input);
  const parsed = current(snapshot);
  if (parsed === undefined) {
    if (plain(snapshot)) {
      const legacy = createPlanArtifactModel().normalizeLegacy(data(snapshot, "trusted"));
      if (legacy.ok && legacy.readiness === "legacy_read_only") return deepFreeze({ ok: false,
        reason_code: "PLAN_ARTIFACT_PUBLICATION_LEGACY_READ_ONLY" });
    }
    return deepFreeze({ ok: false, reason_code: "PLAN_ARTIFACT_PUBLICATION_INPUT_INVALID" });
  }
  const targetPaths = paths(parsed.change_key);
  if (!authorized(authority, parsed.change_key, targetPaths)) return deepFreeze({ ok: false,
    reason_code: "PLAN_ARTIFACT_PUBLICATION_PATH_UNAUTHORIZED" });
  const value = parsed.trusted;
  let payloads: PlanPublicationPayload[];
  try { payloads = [
    payload(targetPaths[0] as string, value.human.design, "markdown", "human_truth", renderDesign(value.human.design)),
    payload(targetPaths[1] as string, value.human.plan, "markdown", "human_truth", renderPlan(value.human.plan)),
    payload(targetPaths[2] as string, value.human.test_scenarios, "markdown", "human_truth",
      renderScenarios(value.human.test_scenarios)),
    payload(targetPaths[3] as string, value.detail, "markdown", "compatibility_derived",
      renderCompatibility(value.detail)),
    payload(targetPaths[4] as string, value.machine.gate_policy, "json", "machine_derived",
      canonicalJson(value.machine.gate_policy) + "\n"),
    payload(targetPaths[5] as string, value.machine.worktree, "json", "machine_derived",
      canonicalJson(value.machine.worktree) + "\n"),
    payload(targetPaths[6] as string, value.machine.implementation_checkpoints, "json", "machine_derived",
      canonicalJson(value.machine.implementation_checkpoints) + "\n"),
    payload(targetPaths[7] as string, value.machine.scenario_manifest, "json", "machine_derived",
      canonicalJson(value.machine.scenario_manifest) + "\n")
  ]; } catch { return deepFreeze({ ok: false, reason_code: "PLAN_ARTIFACT_PUBLICATION_INPUT_INVALID" }); }
  if (payloads.reduce((total, item) => total + item.byte_length, 0) > MAX_PUBLICATION_BYTES) {
    return deepFreeze({ ok: false, reason_code: "PLAN_ARTIFACT_PUBLICATION_INPUT_INVALID" });
  }
  const approval = value.human_input.approval_receipt.receipt_id;
  const derivation = [value.human.artifact_set_hash, value.machine.artifact_set_hash,
    value.detail.content_hash] as const;
  const ownership = [...new Set(value.human.plan.content.tasks.flatMap((task) => task.affected_paths))]
    .sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
  const manifest: PlanArtifactPublicationManifest = deepFreeze({ schema_version: 1,
    change_key: parsed.change_key, approval_receipt_ref: approval,
    artifact_derivation_receipt_refs: derivation, ownership_paths: ownership,
    entries: payloads.map(({ bytes: ignored, serialized_content: ignoredContent, ...descriptor }) => {
      void ignored; void ignoredContent; return descriptor;
    }) });
  const manifest_hash = sha256Bytes(canonicalJson(manifest));
  const plan: PlanArtifactPublicationPlan = { schema_version: 1, change_key: parsed.change_key,
    publication_intent_id: `plan_publication:${manifest_hash.slice(7)}`, manifest_hash, manifest,
    approval_receipt_ref: approval, artifact_derivation_receipt_refs: derivation,
    ownership_paths: ownership, payloads };
  return deepFreeze({ ok: true, mode: "current", plan });
}
