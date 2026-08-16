import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { canonicalJson } from "@hunter-harness/contracts";
import { createPlanStageVerifier, type PlanFinalizationEventOutboxEnqueueInput } from "@hunter-harness/core";

import { createFsPlanEventOutboxPort } from "../src/plan-finalization/fs-event-outbox-port.js";

const sha = (value: string): string => `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
const CHANGE_KEY = "chg_outbox01";
const ROOT_CHANGE_DIR = join(".harness", "changes", CHANGE_KEY);

function planEvent(seq: number) {
  return Object.freeze({
    schema_version: 1 as const,
    event_id: `plan_event:${sha(`event:${seq}`).slice(7)}`,
    lifecycle_kind: "change" as const,
    run_id: "run_01",
    change_key: CHANGE_KEY,
    phase: "plan" as const,
    attempt: 1,
    type: "artifact_published" as const,
    producer_seq: seq,
    occurred_at: "2026-08-16T08:00:00.000Z",
    idempotency_key: sha(`idem:${seq}`)
  });
}

function enqueueInput(): PlanFinalizationEventOutboxEnqueueInput {
  return Object.freeze({
    schema_version: 1,
    record_kind: "plan_finalization_event_outbox",
    outbox_id: "outbox_01",
    operation_id: "op_01",
    idempotency_key: "idem_01",
    context: Object.freeze({
      project_id: "prj_demo",
      change_key: CHANGE_KEY,
      run_id: "run_01",
      branch_name: "main",
      attempt: 1
    }),
    publication_receipt: Object.freeze({
      schema_version: 1,
      receipt_id: "receipt_01",
      project_id: "prj_demo",
      change_key: CHANGE_KEY,
      publication_intent_id: "plan_publication:abc",
      plan_hash: sha("plan"),
      previous_manifest_hash: null,
      manifest_hash: sha("manifest"),
      previous_generation: 0,
      generation: 1,
      modified_paths: Object.freeze([]),
      ownership_paths: Object.freeze([]),
      idempotency_key: "idem_01",
      committed_at: "2026-08-16T08:00:00.000Z"
    }),
    event_bundle_hash: sha("bundle"),
    events: Object.freeze([planEvent(1), planEvent(2)])
  }) as unknown as PlanFinalizationEventOutboxEnqueueInput;
}

describe("FS plan event outbox port", () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(join(tmpdir(), "harness-outbox-"));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("enqueues, delivers events to plan-events.ndjson idempotently and replays after crash", async () => {
    const port = createFsPlanEventOutboxPort({ projectRoot: root });
    const enqueued = await port.enqueue(enqueueInput());
    expect(enqueued.state).toBe("pending");

    const delivered = await port.deliver({
      schema_version: 1,
      outbox_id: "outbox_01",
      operation_id: "op_01",
      idempotency_key: "idem_01",
      event_bundle_hash: sha("bundle"),
      publication_receipt_id: "receipt_01"
    });
    expect(delivered.state).toBe("delivered");

    const ndjson = await fs.readFile(join(root, ROOT_CHANGE_DIR, "meta", "plan-events.ndjson"), "utf8");
    expect(ndjson.trim().split("\n")).toHaveLength(2);

    // 重复 deliver：ndjson 去重，不追加重复事件
    await port.deliver({
      schema_version: 1,
      outbox_id: "outbox_01",
      operation_id: "op_01",
      idempotency_key: "idem_01",
      event_bundle_hash: sha("bundle"),
      publication_receipt_id: "receipt_01"
    });
    const ndjsonAgain = await fs.readFile(join(root, ROOT_CHANGE_DIR, "meta", "plan-events.ndjson"), "utf8");
    expect(ndjsonAgain.trim().split("\n")).toHaveLength(2);
  });

  it("rejects identity drift on deliver", async () => {
    const port = createFsPlanEventOutboxPort({ projectRoot: root });
    await port.enqueue(enqueueInput());
    await expect(port.deliver({
      schema_version: 1,
      outbox_id: "outbox_01",
      operation_id: "op_01",
      idempotency_key: "idem_other",
      event_bundle_hash: sha("bundle"),
      publication_receipt_id: "receipt_01"
    })).rejects.toThrow("PLAN_FINALIZATION_EVENT_OUTBOX_IDENTITY_MISMATCH");
  });
});

describe("plan stage verifier", () => {
  const artifact = { artifact_type: "design", content_hash: "", content: { goal: "g" } };
  artifact.content_hash = sha(canonicalJson({ artifact_type: artifact.artifact_type, content: artifact.content }));
  const stagedFile = {
    path: "plans/chg-design.md",
    serialized_content: ["---", "schema_version: 2", `artifact_type: ${artifact.artifact_type}`, `content_hash: ${artifact.content_hash}`, "---", JSON.stringify(artifact)].join("\n"),
    serialized_hash: sha("file"),
    format: "markdown" as const
  };
  const files = Object.freeze([stagedFile]);
  const filesHash = sha(canonicalJson(files));
  const expectedContentHashes = { "plans/chg-design.md": artifact.content_hash };
  const body = {
    stage_id: "stage_1",
    publication_intent_id: "plan_publication:abc",
    files_hash: filesHash,
    files,
    expected_content_hashes: expectedContentHashes,
    approval_receipt_ref: "approval_1",
    artifact_derivation_receipt_refs: Object.freeze([sha("a"), sha("b"), sha("c")])
  };
  const input = Object.freeze({ ...body, input_hash: sha(canonicalJson(body)) });

  it("recomputes content hashes three-way consistently and produces self-hashed evidence", () => {
    const verifier = createPlanStageVerifier({ now: () => "2026-08-16T08:00:00.000Z" });
    const evidence = verifier.verify(input);
    expect(evidence.stage_id).toBe("stage_1");
    expect(evidence.files_hash).toBe(filesHash);
    expect(evidence.readback_hash).toBe(filesHash);
    expect(evidence.content_hashes).toEqual(expectedContentHashes);
    const { evidence_hash, ...rest } = evidence;
    expect(evidence_hash).toBe(sha(canonicalJson(rest)));
  });

  it("fails closed on files_hash tampering and content drift", () => {
    const verifier = createPlanStageVerifier();
    expect(() => verifier.verify({ ...input, files_hash: sha("wrong") }))
      .toThrow("PLAN_STAGE_VERIFICATION_INPUT_MISMATCH");
    const drifted = Object.freeze([{ ...stagedFile, serialized_content: stagedFile.serialized_content.replace('"goal":"g"', '"goal":"evil"') }]);
    expect(() => verifier.verify({
      ...input,
      files: drifted,
      files_hash: sha(canonicalJson(drifted)),
      expected_content_hashes: expectedContentHashes
    })).toThrow("PLAN_STAGE_VERIFICATION_CONTENT_MISMATCH");
  });
});
