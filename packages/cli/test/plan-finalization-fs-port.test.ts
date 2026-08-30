import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { join } from "node:path";

import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  planDurablePublicationTargetPaths,
  readPlanDurablePublicationFilesystemJournal,
  type PlanArtifactPublicationPlan,
  type PlanDurablePublicationFilesystemPrepareRequest
} from "@hunter-harness/core";
import { canonicalJson } from "@hunter-harness/contracts";

import {
  buildFsPublicationAuthority,
  createFsPlanPublicationPort
} from "../src/plan-finalization/fs-publication-port.js";

const sha = (value: string): `sha256:${string}` =>
  `sha256:${createHash("sha256").update(value).digest("hex")}`;

const CHANGE_KEY = "chg_demo01";
const PROJECT_ID = "prj_demo";
const OPERATION_ID = "op_plan_publish_01";
const RECOVERY_TOKEN = `plan_recovery:${"f".repeat(64)}` as const;

function plan(): PlanArtifactPublicationPlan {
  const paths = planDurablePublicationTargetPaths(CHANGE_KEY);
  const payloads = paths.map((path, index) => {
    const content = `# ${path}\n\npayload ${index}\n`;
    const bytes = [...new TextEncoder().encode(content)];
    return Object.freeze({
      path,
      artifact_type: path.endsWith(".md") ? "plan_document" : "plan_meta",
      format: path.endsWith(".md") ? "markdown" : "json",
      classification: index < 4 ? "human_truth" : "machine_derived",
      serialized_content: content,
      bytes: Object.freeze(bytes),
      byte_length: bytes.length,
      serialized_sha256: sha(content),
      semantic_content_hash: sha(`semantic:${index}`)
    });
  });
  const entries = payloads.map((payload) => ({
    path: payload.path,
    artifact_type: payload.artifact_type,
    format: payload.format,
    classification: payload.classification,
    byte_length: payload.byte_length,
    serialized_sha256: payload.serialized_sha256,
    semantic_content_hash: payload.semantic_content_hash
  }));
  const derivationRefs = Object.freeze([sha("derive_a"), sha("derive_b"), sha("derive_c")]) as unknown as readonly [string, string, string];
  const sortedOwnership = Object.freeze([...paths].sort());
  const manifest = Object.freeze({
    schema_version: 1,
    change_key: CHANGE_KEY,
    approval_receipt_ref: "approval_demo",
    artifact_derivation_receipt_refs: derivationRefs,
    ownership_paths: sortedOwnership,
    entries: Object.freeze(entries)
  });
  // manifest_hash 必须是契约的 canonical hash（canonicalJson + sha256）
  const manifestHash = sha(canonicalJson(manifest));
  return Object.freeze({
    schema_version: 1,
    change_key: CHANGE_KEY,
    publication_intent_id: `plan_publication:${manifestHash.slice(7)}`,
    manifest_hash: manifestHash,
    manifest,
    approval_receipt_ref: "approval_demo",
    artifact_derivation_receipt_refs: derivationRefs,
    ownership_paths: sortedOwnership,
    payloads: Object.freeze(payloads)
  } as unknown as PlanArtifactPublicationPlan);
}

function request(projectRoot: string): PlanDurablePublicationFilesystemPrepareRequest {
  return Object.freeze({
    schema_version: 1,
    operation_id: OPERATION_ID,
    idempotency_key: "idem_01",
    project_id: PROJECT_ID,
    change_key: CHANGE_KEY,
    expected_baseline: Object.freeze({ state: "absent", manifest_hash: null, generation: 0 }),
    plan: plan(),
    authority: buildFsPublicationAuthority({ projectRoot, projectId: PROJECT_ID }, CHANGE_KEY),
    recovery_token: RECOVERY_TOKEN
  });
}

describe("FS plan durable publication port", () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(join(tmpdir(), "harness-plan-fs-"));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("prepares, applies and reads back the exact eight targets with a valid journal", async () => {
    const port = createFsPlanPublicationPort({ projectRoot: root, projectId: PROJECT_ID });
    const prepared = await port.prepare(request(root));
    expect(prepared).toMatchObject({ operation_id: OPERATION_ID, state: "prepared" });

    // journal 必须通过冻结契约 reader 的完整校验
    const journalRaw = JSON.parse(await fs.readFile(
      join(root, ".harness", "changes", CHANGE_KEY, "meta", "publication-journals", `${OPERATION_ID}.json`), "utf8"));
    const journalRead = readPlanDurablePublicationFilesystemJournal(journalRaw);
    expect(journalRead).toMatchObject({ ok: true, mode: "current" });

    const applied = await port.apply({ operation_id: OPERATION_ID, recovery_token: RECOVERY_TOKEN });
    expect(applied.state).toBe("committed");

    for (const [index, path] of planDurablePublicationTargetPaths(CHANGE_KEY).entries()) {
      const live = await fs.readFile(join(root, ".harness", "changes", CHANGE_KEY, path), "utf8");
      expect(live).toBe(plan().payloads[index]?.serialized_content);
    }

    const readback = await port.readback(OPERATION_ID);
    expect(readback.journal_committed).toBe(true);
    expect(readback.live_manifest_hash).toBe(plan().manifest_hash);
    expect(Object.keys(readback.payload_hashes)).toHaveLength(8);
  });

  it("is idempotent on replayed prepare/apply and rejects tampered staging", async () => {
    const port = createFsPlanPublicationPort({ projectRoot: root, projectId: PROJECT_ID });
    await port.prepare(request(root));
    const again = await port.prepare(request(root));
    expect(again.state).toBe("prepared");

    // 篡改 staging 内容 → apply fail closed
    const firstPath = planDurablePublicationTargetPaths(CHANGE_KEY)[0] ?? "";
    await fs.writeFile(join(root, ".harness", "changes", CHANGE_KEY, ".publication-staging", OPERATION_ID, firstPath), "tampered");
    await expect(port.apply({ operation_id: OPERATION_ID, recovery_token: RECOVERY_TOKEN }))
      .rejects.toThrow("PLAN_DURABLE_PUBLICATION_FILESYSTEM_STAGING_TAMPERED");
  });

  it("recover converges a crashed apply and unknown operations inspect as unknown", async () => {
    const port = createFsPlanPublicationPort({ projectRoot: root, projectId: PROJECT_ID });
    await port.prepare(request(root));
    // 模拟崩溃：journal 手写 applying
    const journalFile = join(root, ".harness", "changes", CHANGE_KEY, "meta", "publication-journals", `${OPERATION_ID}.json`);
    const journal = JSON.parse(await fs.readFile(journalFile, "utf8"));
    await fs.writeFile(journalFile, JSON.stringify({ ...journal, state: "applying" }));

    const recovered = await port.recover({ operation_id: OPERATION_ID, recovery_token: RECOVERY_TOKEN });
    expect(recovered.state).toBe("committed");

    const missing = await port.inspect({ operation_id: "op_missing" });
    expect(missing).toMatchObject({ operation_id: "op_missing", state: "unknown" });
  });

  it("cleans up the staging directory after commit and rollback", async () => {
    const port = createFsPlanPublicationPort({ projectRoot: root, projectId: PROJECT_ID });
    const staging = join(
      root, ".harness", "changes", CHANGE_KEY, ".publication-staging", OPERATION_ID
    );

    // commit 路径：committed 后暂存副本必须清掉，否则混进归档（2026-08-30 实测残留 282K）
    await port.prepare(request(root));
    await expect(fs.stat(staging)).resolves.toBeDefined();
    const applied = await port.apply({ operation_id: OPERATION_ID, recovery_token: RECOVERY_TOKEN });
    expect(applied.state).toBe("committed");
    await expect(fs.stat(staging)).rejects.toThrow();

    // rollback 路径：同理清理
    const rolled = await port.rollback({
      operation_id: OPERATION_ID,
      recovery_token: RECOVERY_TOKEN,
      authority: buildFsPublicationAuthority({ projectRoot: root, projectId: PROJECT_ID }, CHANGE_KEY),
      expected_published_manifest_hash: plan().manifest_hash
    });
    expect(rolled.state).toBe("rolled_back");
    await expect(fs.stat(staging)).rejects.toThrow();
  });
});
