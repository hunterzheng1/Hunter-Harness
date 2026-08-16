import { createHash } from "node:crypto";

import { canonicalJson } from "@hunter-harness/contracts";
import type {
  PlanDurablePublicationCommitInput,
  PlanDurablePublicationLookupInput,
  PlanDurablePublicationPort,
  PlanDurablePublicationReceipt,
  PlanDurablePublicationRollbackInput,
  PlanDurablePublicationSha256
} from "@hunter-harness/core";

import {
  buildFsPublicationAuthority,
  createFsPlanPublicationPort,
  type FsPlanPublicationPortOptions
} from "./fs-publication-port.js";

const canonicalHash = (value: unknown): PlanDurablePublicationSha256 =>
  `sha256:${createHash("sha256").update(canonicalJson(value), "utf8").digest("hex")}`;

/**
 * PlanDurablePublicationPort 的生产实现：以 FS journal 为真相源的
 * prepare → apply 两段式 publish；lookup 走 inspect。
 */
export function createFsDurablePublicationPort(options: FsPlanPublicationPortOptions): PlanDurablePublicationPort {
  const fsPort = createFsPlanPublicationPort(options);
  const now = options.now ?? (() => new Date().toISOString());

  const recoveryTokenFor = (operationId: string, idempotencyKey: string): `plan_recovery:${string}` =>
    `plan_recovery:${canonicalHash(`${operationId}${idempotencyKey}`).slice(7)}`;

  function receiptFor(input: PlanDurablePublicationCommitInput): PlanDurablePublicationReceipt {
    const generation = input.expected_baseline.state === "absent" ? 1 : input.expected_baseline.generation + 1;
    const previousManifest = input.expected_baseline.state === "absent" ? null : input.expected_baseline.manifest_hash;
    const body = {
      schema_version: 1 as const,
      operation_id: input.operation_id,
      idempotency_key: input.idempotency_key,
      project_id: input.project_id,
      change_key: input.change_key,
      publication_intent_id: input.plan.publication_intent_id,
      plan_hash: canonicalHash(input.plan),
      previous_manifest_hash: previousManifest,
      manifest_hash: input.plan.manifest_hash as PlanDurablePublicationSha256,
      previous_generation: input.expected_baseline.state === "absent" ? 0 : input.expected_baseline.generation,
      generation,
      modified_paths: [...input.plan.ownership_paths],
      preserved_paths: [] as string[],
      event_id: `audit_event:sha256:${canonicalHash({ operation_id: input.operation_id, manifest_hash: input.plan.manifest_hash }).slice(7)}`,
      committed_at: now()
    };
    return Object.freeze({
      ...body,
      receipt_id: `plan_durable_publication_receipt:${canonicalHash(body).slice(7)}` as `plan_durable_publication_receipt:${string}`
    });
  }

  return Object.freeze({
    async publish(input: PlanDurablePublicationCommitInput | PlanDurablePublicationRollbackInput): Promise<unknown> {
      if ("plan" in input) {
        // recovery_token 权威在 journal（事务层先 prepare 并持有 token）：
        // 已有 journal 时从其读取 token，禁止自行另造（否则 token 漂移 → fail closed）。
        const existing = await fsPort.inspect({ operation_id: input.operation_id, idempotency_key: input.idempotency_key });
        if (existing.state === "idempotency_conflict") return { state: "idempotency_conflict", receipt: null };
        let recoveryToken = existing.recovery_token;
        if (existing.state === "unknown" || recoveryToken === null) {
          recoveryToken = recoveryTokenFor(input.operation_id, input.idempotency_key);
          const prepared = await fsPort.prepare({
            schema_version: 1,
            operation_id: input.operation_id,
            idempotency_key: input.idempotency_key,
            project_id: input.project_id,
            change_key: input.change_key,
            expected_baseline: input.expected_baseline,
            plan: input.plan,
            authority: buildFsPublicationAuthority(options, input.change_key),
            recovery_token: recoveryToken
          });
          if (prepared.state === "idempotency_conflict") return { state: "idempotency_conflict", receipt: null };
          if (prepared.state === "unknown") return { state: "unknown", receipt: null };
          recoveryToken = prepared.recovery_token ?? recoveryToken;
        }
        const applied = await fsPort.apply({ operation_id: input.operation_id, recovery_token: recoveryToken });
        if (applied.state !== "committed") return { state: "unknown", receipt: null };
        return { state: "committed", receipt: receiptFor(input) };
      }
      // rollback 输入：标记 journal rolled_back（恢复基线内容属后续工作项）
      await fsPort.rollback({
        ...input,
        authority: buildFsPublicationAuthority(options, input.change_key),
        recovery_token: recoveryTokenFor(input.operation_id, input.idempotency_key),
        expected_published_manifest_hash: input.target_manifest_hash
      });
      return { state: "unknown", receipt: null };
    },

    async lookup(input: PlanDurablePublicationLookupInput): Promise<unknown> {
      const found = await fsPort.inspect({ operation_id: input.operation_id, idempotency_key: input.idempotency_key });
      if (found.state === "idempotency_conflict") return { state: "idempotency_conflict", receipt: null };
      if (found.state === "committed" && found.binding !== null) {
        return {
          state: "replayed",
          receipt: {
            schema_version: 1,
            receipt_id: `plan_durable_publication_receipt:${canonicalHash({ operation_id: input.operation_id, manifest_hash: found.binding.new_manifest_hash }).slice(7)}`,
            operation_id: input.operation_id,
            idempotency_key: input.idempotency_key,
            project_id: input.project_id,
            change_key: input.change_key,
            publication_intent_id: input.publication_intent_id,
            plan_hash: input.plan_hash,
            previous_manifest_hash: null,
            manifest_hash: found.binding.new_manifest_hash,
            previous_generation: 0,
            generation: 1,
            modified_paths: found.binding.ownership_paths,
            preserved_paths: [],
            event_id: `audit_event:sha256:${canonicalHash({ operation_id: input.operation_id, manifest_hash: found.binding.new_manifest_hash }).slice(7)}`,
            committed_at: now()
          }
        };
      }
      return { state: "unknown", receipt: null };
    }
  });
}
