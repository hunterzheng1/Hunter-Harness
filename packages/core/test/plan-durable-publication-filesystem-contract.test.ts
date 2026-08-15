import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";
import { canonicalJson } from "@hunter-harness/contracts";

import { sha256Bytes } from "../src/fs/hash.js";
import {
  PLAN_DURABLE_PUBLICATION_FILESYSTEM_BOUNDS,
  PLAN_DURABLE_PUBLICATION_FILESYSTEM_SAFETY_POLICY,
  PLAN_DURABLE_PUBLICATION_FILESYSTEM_SCHEMA_VERSION,
  planDurablePublicationTargetPaths,
  planDurablePublicationTargetSetHash,
  readPlanDurablePublicationFilesystemJournal,
  snapshotPlanDurablePublicationFilesystemAuthority,
  snapshotPlanDurablePublicationFilesystemPrepareRequest,
  derivePlanDurablePublicationFilesystemBinding,
  type PlanDurablePublicationFilesystemJournal
} from "../src/plan-quality/durable-publication-filesystem-contract/index.js";

const changeKey = "change-contract";

function publicationPlan(firstPayloadBytes = 0, additionalPayloadBytes: readonly number[] = []) {
  const paths = planDurablePublicationTargetPaths(changeKey);
  const ownership = [...paths].sort();
  const payloads = paths.map((path, index) => {
    const requestedBytes = index === 0 ? firstPayloadBytes : additionalPayloadBytes[index - 1] ?? 0;
    const serialized_content = requestedBytes > 0 ? "x".repeat(requestedBytes) :
      index < 4 ? `# ${path}\n` : `{"path":"${path}"}\n`;
    const bytes = [...Buffer.from(serialized_content, "utf8")];
    return {
      path,
      artifact_type: index < 4 ? ["design", "plan", "test_scenarios", "implementation_detail"][index] : path.slice(5, -5),
      format: index < 4 ? "markdown" : "json",
      classification: index < 4 ? (index === 3 ? "compatibility_derived" : "human_truth") : "machine_derived",
      serialized_content,
      bytes,
      byte_length: bytes.length,
      serialized_sha256: sha256Bytes(serialized_content),
      semantic_content_hash: sha256Bytes(`semantic:${path}`)
    };
  });
  const manifest = {
    schema_version: 1 as const,
    change_key: changeKey,
    approval_receipt_ref: "approval:contract",
    artifact_derivation_receipt_refs: [sha256Bytes("derive:design"), sha256Bytes("derive:machine"), sha256Bytes("derive:detail")] as [string, string, string],
    ownership_paths: ownership,
    entries: payloads.map((payload) => Object.fromEntries(Object.entries(payload)
      .filter(([key]) => key !== "serialized_content" && key !== "bytes")))
  };
  const manifest_hash = sha256Bytes(canonicalJson(manifest));
  return {
    schema_version: 1 as const,
    change_key: changeKey,
    publication_intent_id: `plan_publication:${manifest_hash.slice(7)}`,
    manifest_hash,
    manifest,
    approval_receipt_ref: manifest.approval_receipt_ref,
    artifact_derivation_receipt_refs: manifest.artifact_derivation_receipt_refs,
    ownership_paths: ownership,
    payloads
  };
}

function makeAuthority() {
  return snapshotPlanDurablePublicationFilesystemAuthority({
    schema_version: 1,
    record_kind: "plan_durable_publication_filesystem_authority",
    root_identity: {
      schema_version: 1,
      project_identity: "project-contract",
      project_root_hash: "sha256:" + "a".repeat(64)
    },
    target_identity: {
      schema_version: 1,
      change_key: changeKey,
      target_root: "host-selected/plan-root",
      target_set_hash: planDurablePublicationTargetSetHash(changeKey),
      ownership_paths: planDurablePublicationTargetPaths(changeKey)
    },
    journal_identity: {
      schema_version: 1,
      journal_root: "host-selected/journal",
      journal_root_hash: "sha256:" + "c".repeat(64)
    }
  });
}

describe("Stage12-Plan durable publication filesystem contract", () => {
  it("keeps the host-selected target root separate from the exact eight Plan paths", () => {
    const paths = planDurablePublicationTargetPaths("change-contract");

    expect(paths).toEqual([
      "plans/change-contract-design.md",
      "plans/change-contract-plan.md",
      "plans/change-contract-test-scenarios.md",
      "plans/change-contract-implementation-detail.md",
      "meta/gate-policy.json",
      "meta/worktree.json",
      "meta/implementation-checkpoints.json",
      "meta/scenario-manifest.json"
    ]);
    expect(paths).toHaveLength(PLAN_DURABLE_PUBLICATION_FILESYSTEM_BOUNDS.exact_target_count);
    expect(Object.isFrozen(paths)).toBe(true);
  });

  it("snapshots descriptor-only host authority without persisting an absolute project path", () => {
    const authority = makeAuthority();

    expect(authority.target_identity.target_root).toBe("host-selected/plan-root");
    expect(Object.isFrozen(authority)).toBe(true);
    expect(Object.isFrozen(authority.target_identity)).toBe(true);
    expect("project_root" in (authority as object)).toBe(false);
  });

  it("consumes the M4A publication plan and binds baseline, bytes and readback to eight paths", () => {
    const plan = publicationPlan();
    const request = snapshotPlanDurablePublicationFilesystemPrepareRequest({
      schema_version: 1,
      operation_id: "publication:12:contract",
      idempotency_key: "idem:12:contract",
      project_id: "host-project-id",
      change_key: changeKey,
      expected_baseline: { state: "present", manifest_hash: "sha256:" + "f".repeat(64), generation: 4 },
      plan,
      authority: makeAuthority(),
      recovery_token: "plan_recovery:" + "e".repeat(64)
    });
    const binding = derivePlanDurablePublicationFilesystemBinding(request);

    expect(binding.ownership_paths).toEqual(planDurablePublicationTargetPaths(changeKey));
    expect(binding.expected_baseline).toEqual(request.expected_baseline);
    expect(Object.keys(binding.expected_payload_hashes)).toEqual(binding.ownership_paths);
    expect(binding.plan_hash).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(binding.expected_readback_hash).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(Object.isFrozen(request)).toBe(true);
    expect(Object.isFrozen(binding)).toBe(true);

    const malformed = structuredClone(request) as Record<string, unknown>;
    const malformedPlan = malformed.plan as Record<string, unknown>;
    malformedPlan.payloads = [...(malformedPlan.payloads as unknown[]), (malformedPlan.payloads as unknown[])[0]];
    expect(() => snapshotPlanDurablePublicationFilesystemPrepareRequest(malformed)).toThrow(
      "PLAN_DURABLE_PUBLICATION_FILESYSTEM_PREPARE_INVALID");
  });

  it("accepts a valid payload byte array beyond the old uniform array cap", () => {
    const plan = publicationPlan(4_097);
    const request = snapshotPlanDurablePublicationFilesystemPrepareRequest({
      schema_version: 1,
      operation_id: "publication:12:large",
      idempotency_key: "idem:12:large",
      project_id: "host-project-id",
      change_key: changeKey,
      expected_baseline: { state: "absent", manifest_hash: null, generation: 0 },
      plan,
      authority: makeAuthority(),
      recovery_token: "plan_recovery:" + "d".repeat(64)
    });

    expect(request.plan.payloads[0]?.byte_length).toBe(4_097);
    expect(request.plan.payloads[0]?.bytes).toHaveLength(4_097);
  });

  it("accepts a near-limit repeated-byte payload and rejects one byte over the limit", () => {
    const maxPayloadBytes = PLAN_DURABLE_PUBLICATION_FILESYSTEM_BOUNDS.max_payload_bytes;
    const request = snapshotPlanDurablePublicationFilesystemPrepareRequest({
      schema_version: 1,
      operation_id: "publication:12:max-payload",
      idempotency_key: "idem:12:max-payload",
      project_id: "host-project-id",
      change_key: changeKey,
      expected_baseline: { state: "absent", manifest_hash: null, generation: 0 },
      plan: publicationPlan(maxPayloadBytes),
      authority: makeAuthority(),
      recovery_token: "plan_recovery:" + "a".repeat(64)
    });
    expect(request.plan.payloads[0]?.byte_length).toBe(maxPayloadBytes);
    expect(request.plan.payloads[0]?.bytes[0]).toBe(120);

    expect(() => snapshotPlanDurablePublicationFilesystemPrepareRequest({
      schema_version: 1,
      operation_id: "publication:12:oversize-payload",
      idempotency_key: "idem:12:oversize-payload",
      project_id: "host-project-id",
      change_key: changeKey,
      expected_baseline: { state: "absent", manifest_hash: null, generation: 0 },
      plan: publicationPlan(maxPayloadBytes + 1),
      authority: makeAuthority(),
      recovery_token: "plan_recovery:" + "b".repeat(64)
    })).toThrow("PLAN_DURABLE_PUBLICATION_FILESYSTEM_PREPARE_INVALID");
  });

  it("rejects a plan whose payload bytes exceed the aggregate bound", () => {
    const maxPayloadBytes = PLAN_DURABLE_PUBLICATION_FILESYSTEM_BOUNDS.max_payload_bytes;
    expect(() => snapshotPlanDurablePublicationFilesystemPrepareRequest({
      schema_version: 1,
      operation_id: "publication:12:oversize-total",
      idempotency_key: "idem:12:oversize-total",
      project_id: "host-project-id",
      change_key: changeKey,
      expected_baseline: { state: "absent", manifest_hash: null, generation: 0 },
      plan: publicationPlan(maxPayloadBytes, [maxPayloadBytes, maxPayloadBytes, maxPayloadBytes, 1]),
      authority: makeAuthority(),
      recovery_token: "plan_recovery:" + "c".repeat(64)
    })).toThrow("PLAN_DURABLE_PUBLICATION_FILESYSTEM_PREPARE_INVALID");
  });

  it("reads a bounded current journal with staging, recovery, readback and ambiguity identities", async () => {
    const raw = JSON.parse(await readFile(new URL(
      "./fixtures/plan-durable-publication-filesystem-v1-current.json", import.meta.url), "utf8")) as unknown;
    const result = readPlanDurablePublicationFilesystemJournal(raw);

    expect(result).toMatchObject({ ok: true, mode: "current" });
    if (!result.ok || result.mode !== "current") throw new Error("fixture did not parse");
    const journal = result.value as PlanDurablePublicationFilesystemJournal;
    expect(journal.authority.target_identity.ownership_paths).toEqual(
      planDurablePublicationTargetPaths("change-contract"));
    expect(journal.safety_policy).toEqual(PLAN_DURABLE_PUBLICATION_FILESYSTEM_SAFETY_POLICY);
    expect(journal.state).toBe("committed");
    expect(journal.commit_ambiguity).toBe("resolved_committed");
    expect(journal.readback).toBe("verified");
    expect(journal.cleanup).toBe("completed");
    expect(journal.staging.state).toBe("verified");
    expect(journal.recovery.recovery_token).toMatch(/^plan_recovery:[a-f0-9]{64}$/u);
    expect(Object.isFrozen(journal)).toBe(true);
    expect(Object.isFrozen(journal.authority)).toBe(true);
    expect("project_root" in (journal as object)).toBe(false);
    expect(JSON.stringify(journal).length).toBeLessThanOrEqual(PLAN_DURABLE_PUBLICATION_FILESYSTEM_BOUNDS.max_journal_bytes);
  });

  it("keeps legacy journals read-only and rejects weaker or contradictory records", async () => {
    const legacy = JSON.parse(await readFile(new URL(
      "./fixtures/plan-durable-publication-filesystem-v0-legacy.json", import.meta.url), "utf8")) as unknown;
    expect(readPlanDurablePublicationFilesystemJournal(legacy)).toEqual({
      ok: true, mode: "legacy_read_only", source_schema_version: 0
    });

    const current = JSON.parse(await readFile(new URL(
      "./fixtures/plan-durable-publication-filesystem-v1-current.json", import.meta.url), "utf8")) as Record<string, unknown>;
    expect(readPlanDurablePublicationFilesystemJournal({
      ...structuredClone(current),
      authority: { ...(current.authority as Record<string, unknown>), project_root: "C:\\\\outside" }
    })).toEqual({ ok: false, reason_code: "PLAN_DURABLE_PUBLICATION_FILESYSTEM_JOURNAL_INVALID" });
    expect(readPlanDurablePublicationFilesystemJournal({
      ...structuredClone(current), state: "prepared", commit_ambiguity: "resolved_committed"
    })).toEqual({ ok: false, reason_code: "PLAN_DURABLE_PUBLICATION_FILESYSTEM_JOURNAL_INVALID" });
    expect(readPlanDurablePublicationFilesystemJournal({ schema_version: 9 })).toEqual({
      ok: false, reason_code: "PLAN_DURABLE_PUBLICATION_FILESYSTEM_VERSION_UNSUPPORTED"
    });
  });

  it("rejects proxies, accessors and traversal roots without executing traps", () => {
    let traps = 0;
    const proxy = new Proxy({}, { ownKeys() { traps += 1; return []; } });
    expect(() => snapshotPlanDurablePublicationFilesystemAuthority(proxy)).toThrow(
      "PLAN_DURABLE_PUBLICATION_FILESYSTEM_AUTHORITY_INVALID");
    const accessor = {} as Record<string, unknown>;
    Object.defineProperty(accessor, "schema_version", { enumerable: true, get() {
      traps += 1;
      return PLAN_DURABLE_PUBLICATION_FILESYSTEM_SCHEMA_VERSION;
    } });
    expect(() => snapshotPlanDurablePublicationFilesystemAuthority(accessor)).toThrow(
      "PLAN_DURABLE_PUBLICATION_FILESYSTEM_AUTHORITY_INVALID");
    expect(() => snapshotPlanDurablePublicationFilesystemAuthority({
      schema_version: 1,
      record_kind: "plan_durable_publication_filesystem_authority",
      root_identity: {
        schema_version: 1,
        project_identity: "project-contract",
        project_root_hash: "sha256:" + "a".repeat(64)
      },
      target_identity: {
        schema_version: 1,
        change_key: "change-contract",
        target_root: "../outside",
        target_set_hash: planDurablePublicationTargetSetHash("change-contract"),
        ownership_paths: planDurablePublicationTargetPaths("change-contract")
      },
      journal_identity: {
        schema_version: 1,
        journal_root: "host-selected/journal",
        journal_root_hash: "sha256:" + "c".repeat(64)
      }
    })).toThrow("PLAN_DURABLE_PUBLICATION_FILESYSTEM_AUTHORITY_INVALID");
    expect(traps).toBe(0);
  });
});
