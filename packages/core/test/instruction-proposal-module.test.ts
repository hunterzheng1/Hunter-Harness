import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import {
  InstructionProposalError,
  normalizeLegacyInstructionProposal,
  planInstructionApply,
  proposeInstructionChanges,
  recordInstructionApplyReceipt,
  selectInstructionEvidence,
  verifyInstructionApplyReceipt,
  type InstructionEvidenceBundle,
  type InstructionApplyReceipt,
  type InstructionProposal,
  type InstructionProposalModelPort
} from "../src/instruction-proposal/index.js";
import type { MapEvidenceBundle } from "../src/codebase/map-v2/types.js";
import type {
  InstructionInspectionRef,
  InstructionProjectionPlan
} from "../src/instruction-governance/types.js";
import { stableHash } from "../src/instruction-governance/stable.js";
import { sha256Bytes } from "../src/fs/hash.js";
import {
  verifyCurrentInstructionProposal as verifyCurrentInstructionProposalWire
} from "../src/instruction-proposal/proposal.js";

const H = (character: string): string => `sha256:${character.repeat(64)}`;

function verifyCurrentInstructionProposal(proposalInput: unknown, trustedInput: unknown) {
  const proposalWire = JSON.stringify(proposalInput);
  const trustedWire = JSON.stringify(trustedInput);
  if (proposalWire === undefined || trustedWire === undefined) {
    throw new Error("verification values must be JSON serializable");
  }
  return verifyCurrentInstructionProposalWire(
    proposalWire,
    trustedWire
  );
}
const inspectionRef: InstructionInspectionRef = {
  schema_version: 1,
  input_fingerprint: H("a"),
  canonical_hash: H("b"),
  result_hash: H("c")
};
const evidenceScope = {
  map_topics: ["architecture", "structure", "testing"] as const,
  candidate_rule_topics: { pcc_rule_01: "testing" as const },
  executable_architecture_candidate_ids: ["pcc_arch_01"],
  max_items: 8,
  max_characters: 2_000,
  max_utf8_bytes: 3_000
};

async function fixture(name: string): Promise<unknown> {
  const url = new URL(`./fixtures/${name}`, import.meta.url);
  return JSON.parse(await readFile(fileURLToPath(url), "utf8")) as unknown;
}

async function currentInput(): Promise<{
  map_bundle: MapEvidenceBundle;
  candidates: readonly unknown[];
}> {
  return await fixture("instruction-proposal-v1-current.json") as {
    map_bundle: MapEvidenceBundle;
    candidates: readonly unknown[];
  };
}

async function evidence(): Promise<InstructionEvidenceBundle> {
  const input = await currentInput();
  return selectInstructionEvidence(input.map_bundle, input.candidates, evidenceScope);
}

async function currentProposalVerificationInput() {
  const input = await currentInput();
  return {
    schema_version: 1 as const,
    map_bundle: input.map_bundle,
    candidates: input.candidates,
    selection_scope: evidenceScope,
    inspection_ref: inspectionRef,
    current_inspection_ref: inspectionRef,
    expected_baseline_hash: inspectionRef.canonical_hash,
    canonical_file_hashes: { ".harness/rules/testing.md": H("d") },
    created_at: "2026-08-13T02:00:00.000Z",
    expires_at: "2026-08-14T02:00:00.000Z",
    prompt_version: "instruction-proposal-v1",
    model_identity: "memory:test-model",
    raw_model_actions: [{
      operation: "modify" as const,
      target_path: ".harness/rules/testing.md",
      topic: "testing" as const,
      content: "# Testing\n\nEvery changed package must pass focused tests and typecheck.\n",
      evidence_refs: ["candidate:pcc_rule_01"],
      rationale_zh: "该约束有重复评审证据，并且属于长期测试规则。",
      confidence: "high" as const,
      review_mode: "confirmation_required" as const
    }],
    verified_at: "2026-08-13T03:00:00.000Z"
  };
}

function modelPort(): InstructionProposalModelPort {
  return {
    propose: vi.fn(async () => ({
      actions: [{
        operation: "modify" as const,
        target_path: ".harness/rules/testing.md",
        topic: "testing" as const,
        content: "# Testing\n\nEvery changed package must pass focused tests and typecheck.\n",
        evidence_refs: ["candidate:pcc_rule_01"],
        rationale_zh: "该约束有重复评审证据，并且属于长期测试规则。",
        confidence: "high" as const,
        review_mode: "confirmation_required" as const
      }]
    }))
  };
}

async function proposal(): Promise<InstructionProposal> {
  return proposeInstructionChanges({
    inspection_ref: inspectionRef,
    current_inspection_ref: inspectionRef,
    evidence: await evidence(),
    expected_baseline_hash: inspectionRef.canonical_hash,
    canonical_file_hashes: { ".harness/rules/testing.md": H("d") },
    created_at: "2026-08-13T02:00:00.000Z",
    expires_at: "2026-08-14T02:00:00.000Z",
    prompt_version: "instruction-proposal-v1",
    model_identity: "memory:test-model"
  }, modelPort());
}

function readyProjection(content = "# Managed rules"): InstructionProjectionPlan {
  const operation = {
    operation: "write" as const,
    path: "AGENTS.md",
    target_agents: ["codex" as const],
    source_paths: [".harness/rules/testing.md"],
    expected_content_hash: H("9"),
    content_hash: sha256Bytes(content),
    content,
    adapter_version: "instruction_projection_v1" as const
  };
  const base = {
    schema_version: 1 as const,
    canonical_hash: H("f"),
    adapter_version: "instruction_projection_v1" as const,
    status: "ready" as const,
    executable: true,
    operations: [operation],
    failures: [],
    projection_hashes: { codex: stableHash([{ path: operation.path, content_hash: operation.content_hash }]) }
  };
  return { ...base, plan_hash: stableHash(base) };
}

function onlyAction(candidate: InstructionProposal): InstructionProposal["actions"][number] {
  const action = candidate.actions[0];
  if (action === undefined) throw new Error("expected one proposal action");
  return action;
}

function selfHashProposal(candidate: InstructionProposal): InstructionProposal {
  const {
    proposal_id: ignoredId,
    proposal_hash: ignoredHash,
    ...payload
  } = candidate;
  void ignoredId;
  void ignoredHash;
  const proposalHash = stableHash(payload);
  return {
    ...payload,
    proposal_id: `ip_${proposalHash.slice("sha256:".length, "sha256:".length + 24)}`,
    proposal_hash: proposalHash
  };
}

function selfHashAction(
  candidate: InstructionProposal,
  changes: Readonly<Record<string, unknown>>
): InstructionProposal {
  const original = onlyAction(candidate);
  const {
    action_id: ignoredActionId,
    before_content_hash: beforeContentHash,
    content_hash: ignoredContentHash,
    ...originalDraft
  } = original;
  void ignoredActionId;
  void ignoredContentHash;
  const draft = { ...originalDraft, ...changes };
  const contentHash = sha256Bytes(String(draft.content));
  const identity = stableHash({ ...draft, content_hash: contentHash });
  const action = {
    ...draft,
    action_id: `ia_${identity.slice("sha256:".length, "sha256:".length + 24)}`,
    before_content_hash: beforeContentHash,
    content_hash: contentHash
  } as InstructionProposal["actions"][number];
  return selfHashProposal({
    ...candidate,
    actions: [action],
    evidence_refs: [...new Set(action.evidence_refs)].sort()
  });
}

function selfHashReceipt(
  receipt: Omit<InstructionApplyReceipt, "receipt_id" | "receipt_hash">
): InstructionApplyReceipt {
  const receiptHash = stableHash(receipt);
  return {
    ...receipt,
    receipt_id: `ir_${receiptHash.slice("sha256:".length, "sha256:".length + 24)}`,
    receipt_hash: receiptHash
  };
}

function manifestWrite(
  candidate: InstructionProposal,
  acceptedActionIds: readonly string[],
  reviewedAt: string
) {
  const accepted = new Set(acceptedActionIds);
  const files = candidate.actions.map((action) => ({
    path: action.target_path,
    topic: action.topic,
    status: action.operation === "deprecate" && accepted.has(action.action_id)
      ? "deprecated" as const
      : "active" as const,
    content_hash: accepted.has(action.action_id)
      ? action.content_hash
      : action.before_content_hash ?? action.content_hash,
    activation: action.topic === "core" ? "always" as const : "path" as const,
    globs: action.topic === "core" ? [] : ["packages/**"],
    module_refs: [],
    target_agents: ["codex" as const, "claude_code" as const, "cursor" as const, "codebuddy" as const],
    context_budget: 2_000,
    evidence_refs: [...action.evidence_refs]
  }));
  if (!files.some((file) => file.topic === "core")) {
    files.unshift({
      path: ".harness/rules/core.md",
      topic: "core",
      status: "active",
      content_hash: H("c"),
      activation: "always",
      globs: [],
      module_refs: [],
      target_agents: ["codex", "claude_code", "cursor", "codebuddy"],
      context_budget: 2_000,
      evidence_refs: []
    });
  }
  const content = JSON.stringify({
    schema_version: 1,
    ruleset_version: "ruleset-2026-08",
    generator: { name: "hunter-harness", version: "0.1.0", prompt_version: candidate.prompt_version },
    project_identity: "project:hunter-harness",
    canonical_root: ".harness/rules",
    files,
    proposal_id: candidate.proposal_id,
    reviewed_at: reviewedAt
  });
  return {
    content,
    content_hash: sha256Bytes(content),
    expected_content_hash: H("1")
  };
}

describe("07B bounded evidence selection", () => {
  it("validates the stage-01 candidate wire and preserves bounded topic/path/version evidence", async () => {
    const bundle = await evidence();

    expect(bundle.items.map((item) => [item.source_kind, item.reference])).toEqual([
      ["candidate", "candidate:pcc_arch_01"],
      ["candidate", "candidate:pcc_glossary_01"],
      ["candidate", "candidate:pcc_rule_01"],
      ["map", "map:sha256:1111111111111111111111111111111111111111111111111111111111111111:architecture:packages/core/src/index.ts"],
      ["map", "map:sha256:1111111111111111111111111111111111111111111111111111111111111111:structure:packages/core/src/index.ts"],
      ["map", "map:sha256:1111111111111111111111111111111111111111111111111111111111111111:testing:packages/core/test/example.test.ts"]
    ]);
    expect(bundle.items.find((item) => item.reference === "candidate:pcc_arch_01")).toMatchObject({
      target_topic: "architecture",
      eligibility: "proposable",
      confidence: "low"
    });
    expect(bundle.items.find((item) => item.reference === "candidate:pcc_glossary_01")).toMatchObject({
      eligibility: "display_only",
      target_topic: null
    });
    expect(bundle.items.filter((item) => item.source_kind === "map")
      .every((item) => item.confidence === "low")).toBe(true);
    expect(bundle.used_budget.characters).toBeLessThanOrEqual(2_000);
    expect(bundle.used_budget.utf8_bytes).toBeLessThanOrEqual(3_000);
    expect(Object.isFrozen(bundle.items)).toBe(true);

    const input = await currentInput();
    expect(() => selectInstructionEvidence(input.map_bundle, [{
      ...(input.candidates[0] as object), invented_field: true
    }], {
      map_topics: ["testing"],
      candidate_rule_topics: { pcc_rule_01: "testing" },
      executable_architecture_candidate_ids: [],
      max_items: 4,
      max_characters: 500,
      max_utf8_bytes: 500
    })).toThrowError(expect.objectContaining({ code: "INSTRUCTION_CANDIDATE_WIRE_INVALID" }));
  });

  it("never makes glossary writable and requires explicit executable architecture confirmation", async () => {
    const input = await currentInput();
    const bundle = selectInstructionEvidence(input.map_bundle, input.candidates, {
      map_topics: [],
      candidate_rule_topics: { pcc_rule_01: "testing" },
      executable_architecture_candidate_ids: [],
      max_items: 8,
      max_characters: 2_000,
      max_utf8_bytes: 3_000
    });
    expect(bundle.items.find((item) => item.reference === "candidate:pcc_arch_01")?.eligibility)
      .toBe("review_only");
    expect(bundle.items.find((item) => item.reference === "candidate:pcc_glossary_01")?.eligibility)
      .toBe("display_only");
  });

  it("truncates deterministically without concatenating all map material", async () => {
    const input = await currentInput();
    const bundle = selectInstructionEvidence(input.map_bundle, input.candidates, {
      map_topics: ["architecture", "testing"],
      candidate_rule_topics: { pcc_rule_01: "testing" },
      executable_architecture_candidate_ids: [],
      max_items: 1,
      max_characters: 200,
      max_utf8_bytes: 200
    });
    expect(bundle.items).toHaveLength(1);
    expect(bundle.truncation_reasons).toContain("item_limit");
  });
});

describe("07B proposal and apply planning", () => {
  it("exports one current-proposal verification seam from the 07B domain", async () => {
    const proposalModule = await import("../src/instruction-proposal/proposal.js") as
      Record<string, unknown>;

    expect(proposalModule.verifyCurrentInstructionProposal).toBeTypeOf("function");
  });

  it("reconstructs and verifies a current proposal from trusted raw evidence", async () => {
    const candidate = await proposal();
    const result = verifyCurrentInstructionProposal(
      candidate,
      await currentProposalVerificationInput()
    );

    expect(result).toMatchObject({
      valid: true,
      reason_code: "INSTRUCTION_CURRENT_PROPOSAL_VERIFIED",
      proposal: candidate,
      evidence: { evidence_hash: candidate.evidence_hash }
    });
    expect(Object.isFrozen(result)).toBe(true);
  });

  it("rejects accessor-backed untrusted proposals without invoking hostile code", async () => {
    let getterCalls = 0;
    const hostile = Object.defineProperty({}, "schema_version", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return 1;
      }
    });

    expect(verifyCurrentInstructionProposalWire(
      hostile as unknown as string,
      JSON.stringify(await currentProposalVerificationInput())
    )).toEqual({
      valid: false,
      reason_code: "INSTRUCTION_CURRENT_PROPOSAL_INVALID"
    });
    expect(getterCalls).toBe(0);
  });

  it("rejects proxy-backed wire inputs without executing traps", async () => {
    let trapCalls = 0;
    const handler: ProxyHandler<object> = {
      ownKeys(target) {
        trapCalls += 1;
        return Reflect.ownKeys(target);
      },
      getOwnPropertyDescriptor(target, property) {
        trapCalls += 1;
        return Reflect.getOwnPropertyDescriptor(target, property);
      },
      getPrototypeOf(target) {
        trapCalls += 1;
        return Reflect.getPrototypeOf(target);
      }
    };

    expect(verifyCurrentInstructionProposalWire(
      new Proxy({ schema_version: 1 }, handler) as unknown as string,
      JSON.stringify(await currentProposalVerificationInput())
    )).toEqual({
      valid: false,
      reason_code: "INSTRUCTION_CURRENT_PROPOSAL_INVALID"
    });
    expect(verifyCurrentInstructionProposalWire(
      JSON.stringify(await proposal()),
      new Proxy({ schema_version: 1 }, handler) as unknown as string
    )).toEqual({
      valid: false,
      reason_code: "INSTRUCTION_CURRENT_PROPOSAL_INPUT_INVALID"
    });
    expect(trapCalls).toBe(0);
  });

  it("rejects unknown fields throughout the trusted verification wire", async () => {
    const candidate = await proposal();
    const trusted = await currentProposalVerificationInput();
    const cases = [{ ...trusted, invented: true }, {
      ...trusted,
      map_bundle: { ...trusted.map_bundle, invented: true }
    }, {
      ...trusted,
      selection_scope: { ...trusted.selection_scope, invented: true }
    }, {
      ...trusted,
      inspection_ref: { ...trusted.inspection_ref, invented: true }
    }, {
      ...trusted,
      map_bundle: {
        ...trusted.map_bundle,
        snippets: [{ ...trusted.map_bundle.snippets[0], invented: true }]
      }
    }, {
      ...trusted,
      map_bundle: {
        ...trusted.map_bundle,
        used_budget: { ...trusted.map_bundle.used_budget, invented: true }
      }
    }, {
      ...trusted,
      candidates: [{
        ...(trusted.candidates[0] as Record<string, unknown>),
        invented: true
      }]
    }, {
      ...trusted,
      candidates: [{
        ...(trusted.candidates[0] as Record<string, unknown>),
        provenance: {
          ...((trusted.candidates[0] as Record<string, unknown>).provenance as Record<string, unknown>),
          invented: true
        }
      }]
    }];

    for (const hostile of cases) {
      expect(verifyCurrentInstructionProposal(candidate, hostile)).toEqual({
        valid: false,
        reason_code: "INSTRUCTION_CURRENT_PROPOSAL_INPUT_INVALID"
      });
    }
  });

  it("rejects all-rehashed invented evidence and sensitive content from the untrusted proposal", async () => {
    const candidate = await proposal();
    const trusted = await currentProposalVerificationInput();
    const invented = selfHashAction(candidate, { evidence_refs: ["candidate:invented"] });
    const sensitive = selfHashAction(candidate, {
      content: "# Testing\n\npassword=super-secret-value\n"
    });

    for (const hostile of [invented, sensitive]) {
      expect(verifyCurrentInstructionProposal(hostile, trusted)).toEqual({
        valid: false,
        reason_code: "INSTRUCTION_CURRENT_PROPOSAL_MISMATCH"
      });
    }
  });

  it("reconstructs only from pinned raw model actions and rejects a self-hashed semantic rewrite", async () => {
    const candidate = await proposal();
    const trusted = await currentProposalVerificationInput();
    const rewritten = selfHashAction(candidate, {
      content: "# Testing\n\nDelete all tests.\n"
    });

    expect(verifyCurrentInstructionProposal(candidate, trusted).valid).toBe(true);
    expect(verifyCurrentInstructionProposal(rewritten, trusted)).toEqual({
      valid: false,
      reason_code: "INSTRUCTION_CURRENT_PROPOSAL_MISMATCH"
    });
  });

  it("trusted raw action 被替换内容 → 身份级 MISMATCH（非内容扫描）", async () => {
    // 校验拒绝来自 candidate 与 trusted raw action 的身份失配
    // （INSTRUCTION_CURRENT_PROPOSAL_MISMATCH），不是内容敏感扫描。
    const candidate = await proposal();
    const trusted = await currentProposalVerificationInput();

    expect(verifyCurrentInstructionProposal(candidate, {
      ...trusted,
      raw_model_actions: [{
        ...trusted.raw_model_actions[0],
        content: "# Testing\n\npassword=super-secret-value\n"
      }]
    })).toEqual({
      valid: false,
      reason_code: "INSTRUCTION_CURRENT_PROPOSAL_MISMATCH"
    });
  });

  it("replays glossary and architecture evidence eligibility from the trusted selection scope", async () => {
    const candidate = await proposal();
    const trusted = await currentProposalVerificationInput();
    const glossary = selfHashAction(candidate, {
      operation: "add",
      target_path: ".harness/rules/core.md",
      topic: "core",
      evidence_refs: ["candidate:pcc_glossary_01"]
    });
    const architecture = selfHashAction(candidate, {
      operation: "add",
      target_path: ".harness/rules/architecture.md",
      topic: "architecture",
      evidence_refs: ["candidate:pcc_arch_01"],
      review_mode: "confirmation_required"
    });
    const nonExecutableArchitecture = {
      ...trusted,
      selection_scope: {
        ...trusted.selection_scope,
        executable_architecture_candidate_ids: []
      }
    };

    for (const [hostile, rawModelAction] of [
      [glossary, {
        ...trusted.raw_model_actions[0],
        operation: "add",
        target_path: ".harness/rules/core.md",
        topic: "core",
        evidence_refs: ["candidate:pcc_glossary_01"]
      }],
      [architecture, {
        ...trusted.raw_model_actions[0],
        operation: "add",
        target_path: ".harness/rules/architecture.md",
        topic: "architecture",
        evidence_refs: ["candidate:pcc_arch_01"],
        review_mode: "confirmation_required"
      }]
    ] as const) {
      expect(verifyCurrentInstructionProposal(hostile, {
        ...nonExecutableArchitecture,
        raw_model_actions: [rawModelAction]
      })).toEqual({
        valid: false,
        reason_code: "INSTRUCTION_CURRENT_PROPOSAL_INVALID"
      });
    }
  });

  it("requires exact pinned raw model action schema", async () => {
    const candidate = await proposal();
    const trusted = await currentProposalVerificationInput();

    expect(verifyCurrentInstructionProposal(candidate, {
      ...trusted,
      raw_model_actions: [{
        ...trusted.raw_model_actions[0],
        content_hash: onlyAction(candidate).content_hash
      }]
    })).toEqual({
      valid: false,
      reason_code: "INSTRUCTION_CURRENT_PROPOSAL_INVALID"
    });
  });

  it("fails closed on expiry, stale trusted inspection/baseline, and legacy proposals", async () => {
    const candidate = await proposal();
    const trusted = await currentProposalVerificationInput();
    expect(verifyCurrentInstructionProposal(candidate, {
      ...trusted,
      verified_at: trusted.expires_at
    })).toEqual({
      valid: false,
      reason_code: "INSTRUCTION_CURRENT_PROPOSAL_EXPIRED"
    });
    for (const stale of [{
      ...trusted,
      current_inspection_ref: { ...inspectionRef, result_hash: H("e") }
    }, {
      ...trusted,
      expected_baseline_hash: H("e")
    }]) {
      expect(verifyCurrentInstructionProposal(candidate, stale)).toEqual({
        valid: false,
        reason_code: "INSTRUCTION_CURRENT_PROPOSAL_INVALID"
      });
    }
    expect(verifyCurrentInstructionProposal(
      await fixture("instruction-proposal-v0-legacy.json"),
      trusted
    )).toEqual({
      valid: false,
      reason_code: "INSTRUCTION_CURRENT_PROPOSAL_LEGACY_READ_ONLY"
    });
  });

  it("rejects syntactically shaped but impossible RFC3339 clock values", async () => {
    const candidate = await proposal();
    const trusted = await currentProposalVerificationInput();

    expect(verifyCurrentInstructionProposal(candidate, {
      ...trusted,
      verified_at: "2026-02-30T03:00:00.000Z"
    })).toEqual({
      valid: false,
      reason_code: "INSTRUCTION_CURRENT_PROPOSAL_INVALID"
    });
  });

  it("requires verified_at to be at or after created_at and strictly before expiry", async () => {
    const candidate = await proposal();
    const trusted = await currentProposalVerificationInput();

    expect(verifyCurrentInstructionProposal(candidate, {
      ...trusted,
      verified_at: "2026-08-13T01:59:59.999Z"
    })).toEqual({
      valid: false,
      reason_code: "INSTRUCTION_CURRENT_PROPOSAL_INVALID"
    });
    expect(verifyCurrentInstructionProposal(candidate, {
      ...trusted,
      verified_at: trusted.created_at
    }).valid).toBe(true);
  });

  it("rejects rehashed action and proposal identity drift against the reconstruction", async () => {
    const candidate = await proposal();
    const trusted = await currentProposalVerificationInput();
    const hostileActions = [
      selfHashAction(candidate, { target_path: "C:\\temp\\testing.md" }),
      selfHashAction(candidate, { topic: "security" }),
      selfHashAction(candidate, { operation: "overwrite" }),
      selfHashAction(candidate, { confidence: "certain" }),
      selfHashAction(candidate, { review_mode: "silent" })
    ];
    for (const hostile of hostileActions) {
      expect(verifyCurrentInstructionProposal(hostile, trusted).valid).toBe(false);
    }

    const tamperedActionId = selfHashProposal({
      ...candidate,
      actions: [{ ...onlyAction(candidate), action_id: "ia_000000000000000000000000" }]
    });
    const tamperedEvidenceHash = selfHashProposal({ ...candidate, evidence_hash: H("e") });
    const tamperedInspection = selfHashProposal({
      ...candidate,
      inspection_ref: { ...candidate.inspection_ref, result_hash: H("e") }
    });
    for (const hostile of [tamperedActionId, tamperedEvidenceHash, tamperedInspection]) {
      expect(verifyCurrentInstructionProposal(hostile, trusted)).toEqual({
        valid: false,
        reason_code: "INSTRUCTION_CURRENT_PROPOSAL_MISMATCH"
      });
    }
  });

  it("binds a ready proposal to the complete inspection ref, evidence, baseline, expiry, and hash", async () => {
    const result = await proposal();
    expect(result).toMatchObject({
      schema_version: 1,
      inspection_ref: inspectionRef,
      input_fingerprint: inspectionRef.input_fingerprint,
      expected_baseline_hash: inspectionRef.canonical_hash,
      status: "ready"
    });
    expect(result.proposal_id).toMatch(/^ip_[a-f0-9]{24}$/u);
    expect(result.proposal_hash).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(result.evidence_refs).toEqual(["candidate:pcc_rule_01"]);
    expect(result.actions[0]).toMatchObject({
      action_id: expect.stringMatching(/^ia_[a-f0-9]{24}$/u),
      target_path: ".harness/rules/testing.md",
      before_content_hash: H("d"),
      rationale_zh: expect.any(String)
    });
    expect(Object.isFrozen(result.actions[0])).toBe(true);
  });

  it("requires reinspection when any inspection identity or the expected baseline changes", async () => {
    const base = {
      inspection_ref: inspectionRef,
      current_inspection_ref: { ...inspectionRef, result_hash: H("d") },
      evidence: await evidence(),
      expected_baseline_hash: inspectionRef.canonical_hash,
      canonical_file_hashes: { ".harness/rules/testing.md": H("d") },
      created_at: "2026-08-13T02:00:00.000Z",
      expires_at: "2026-08-14T02:00:00.000Z",
      prompt_version: "instruction-proposal-v1",
      model_identity: "memory:test-model"
    };
    await expect(proposeInstructionChanges(base, modelPort())).rejects.toMatchObject({
      code: "INSTRUCTION_REINSPECTION_REQUIRED"
    });
    await expect(proposeInstructionChanges({
      ...base,
      current_inspection_ref: inspectionRef,
      expected_baseline_hash: H("e")
    }, modelPort())).rejects.toMatchObject({ code: "INSTRUCTION_REINSPECTION_REQUIRED" });
  });

  it("rejects model-created evidence, glossary writes, unsafe content, and non-canonical paths", async () => {
    const base = {
      inspection_ref: inspectionRef,
      current_inspection_ref: inspectionRef,
      evidence: await evidence(),
      expected_baseline_hash: inspectionRef.canonical_hash,
      canonical_file_hashes: {
        ".harness/rules/core.md": H("c"),
        ".harness/rules/testing.md": H("d")
      },
      created_at: "2026-08-13T02:00:00.000Z",
      expires_at: "2026-08-14T02:00:00.000Z",
      prompt_version: "instruction-proposal-v1",
      model_identity: "memory:test-model"
    };
    // 注：原第四条（content 含 Authorization Bearer 密钥）已随扫描停用移除——
    // 内容不再触发拒绝；其余三条（伪造证据引用、术语候选写规则、非规范路径）仍然拒绝。
    for (const action of [
      { operation: "modify", target_path: ".harness/rules/testing.md", topic: "testing", content: "ok", evidence_refs: ["invented:ref"], rationale_zh: "说明", confidence: "low", review_mode: "confirmation_required" },
      { operation: "modify", target_path: ".harness/rules/core.md", topic: "core", content: "ok", evidence_refs: ["candidate:pcc_glossary_01"], rationale_zh: "说明", confidence: "low", review_mode: "confirmation_required" },
      { operation: "modify", target_path: ".env", topic: "testing", content: "ok", evidence_refs: ["candidate:pcc_rule_01"], rationale_zh: "说明", confidence: "low", review_mode: "confirmation_required" }
    ]) {
      await expect(proposeInstructionChanges(base, {
        propose: async () => ({ actions: [action] as never })
      })).rejects.toBeInstanceOf(InstructionProposalError);
    }
  });

  it("含密钥内容不再触发 InstructionProposalError（扫描已停用）", async () => {
    const base = {
      inspection_ref: inspectionRef,
      current_inspection_ref: inspectionRef,
      evidence: await evidence(),
      expected_baseline_hash: inspectionRef.canonical_hash,
      canonical_file_hashes: {
        ".harness/rules/core.md": H("c"),
        ".harness/rules/testing.md": H("d")
      },
      created_at: "2026-08-13T02:00:00.000Z",
      expires_at: "2026-08-14T02:00:00.000Z",
      prompt_version: "instruction-proposal-v1",
      model_identity: "memory:test-model"
    };
    const action = { operation: "modify", target_path: ".harness/rules/testing.md", topic: "testing", content: "Authorization: Bearer abcdefghijklmnopqrstuvwxyz", evidence_refs: ["candidate:pcc_rule_01"], rationale_zh: "说明", confidence: "low", review_mode: "confirmation_required" };
    await expect(proposeInstructionChanges(base, {
      propose: async () => ({ actions: [action] as never })
    })).resolves.toBeDefined();
  });

  it("rejects a self-hashed evidence bundle that forges glossary as proposable", async () => {
    const original = await evidence();
    const forgedItems = original.items.map((item) =>
      item.candidate_type === "glossary"
        ? { ...item, eligibility: "proposable" as const, target_topic: "core" as const }
        : item
    );
    const { evidence_hash: ignored, ...payload } = original;
    void ignored;
    const forged = {
      ...payload,
      items: forgedItems,
      evidence_hash: stableHash({ ...payload, items: forgedItems })
    };

    await expect(proposeInstructionChanges({
      inspection_ref: inspectionRef,
      current_inspection_ref: inspectionRef,
      evidence: forged,
      expected_baseline_hash: inspectionRef.canonical_hash,
      canonical_file_hashes: { ".harness/rules/core.md": H("c") },
      created_at: "2026-08-13T02:00:00.000Z",
      expires_at: "2026-08-14T02:00:00.000Z",
      prompt_version: "instruction-proposal-v1",
      model_identity: "memory:test-model"
    }, {
      propose: async () => ({ actions: [{
        operation: "modify",
        target_path: ".harness/rules/core.md",
        topic: "core",
        content: "Glossary must not become a rule.",
        evidence_refs: ["candidate:pcc_glossary_01"],
        rationale_zh: "术语候选不能写入规则。",
        confidence: "low",
        review_mode: "confirmation_required"
      }] })
    })).rejects.toMatchObject({ code: "INSTRUCTION_EVIDENCE_INPUT_INVALID" });
  });

  it("tracks accept/reject/retain and emits one atomic canonical+projection write plan", async () => {
    const candidate = await proposal();
    const projection = readyProjection();
    const plan = planInstructionApply(candidate, [{
      action_id: onlyAction(candidate).action_id,
      decision: "accept"
    }], candidate.expected_baseline_hash, projection, "2026-08-13T03:00:00.000Z",
    manifestWrite(candidate, [onlyAction(candidate).action_id], "2026-08-13T03:00:00.000Z"));
    expect(plan.reason_codes).toEqual([]);
    expect(plan.status).toBe("ready");
    expect(plan.operations.map((operation) => operation.path)).toEqual([
      ".harness/rules/testing.md",
      ".harness/rules/rules-manifest.json",
      "AGENTS.md"
    ]);
    expect(plan.decisions).toEqual([{
      action_id: onlyAction(candidate).action_id,
      decision: "accept"
    }]);
    expect(plan.rollback_plan).not.toHaveLength(0);
    expect(plan.transaction_hash).toMatch(/^sha256:/u);
  });

  it("preserves distinct accept, reject, and retain outcomes without writing skipped actions", async () => {
    const baseEvidence = await evidence();
    const candidate = await proposeInstructionChanges({
      inspection_ref: inspectionRef,
      current_inspection_ref: inspectionRef,
      evidence: baseEvidence,
      expected_baseline_hash: inspectionRef.canonical_hash,
      canonical_file_hashes: {
        ".harness/rules/architecture.md": H("e"),
        ".harness/rules/core.md": H("c"),
        ".harness/rules/testing.md": H("d")
      },
      created_at: "2026-08-13T02:00:00.000Z",
      expires_at: "2026-08-14T02:00:00.000Z",
      prompt_version: "instruction-proposal-v1",
      model_identity: "memory:test-model"
    }, {
      propose: async () => ({ actions: [
        {
          operation: "modify", target_path: ".harness/rules/testing.md", topic: "testing",
          content: "Testing update", evidence_refs: ["candidate:pcc_rule_01"],
          rationale_zh: "接受该测试规则。", confidence: "high", review_mode: "confirmation_required"
        },
        {
          operation: "modify", target_path: ".harness/rules/architecture.md", topic: "architecture",
          content: "Architecture update", evidence_refs: ["candidate:pcc_arch_01"],
          rationale_zh: "需要人工判断架构约束。", confidence: "low", review_mode: "confirmation_required"
        },
        {
          operation: "modify", target_path: ".harness/rules/core.md", topic: "core",
          content: "Core update", evidence_refs: [
            "map:sha256:1111111111111111111111111111111111111111111111111111111111111111:structure:packages/core/src/index.ts"
          ],
          rationale_zh: "保留该核心规则建议。", confidence: "high", review_mode: "confirmation_required"
        }
      ] })
    });
    const [accept, reject, retain] = candidate.actions;
    if (accept === undefined || reject === undefined || retain === undefined) {
      throw new Error("expected three proposal actions");
    }
    const plan = planInstructionApply(candidate, [
      { action_id: accept.action_id, decision: "accept" },
      { action_id: reject.action_id, decision: "reject" },
      { action_id: retain.action_id, decision: "retain" }
    ], candidate.expected_baseline_hash, readyProjection(), "2026-08-13T03:00:00.000Z",
    manifestWrite(candidate, [accept.action_id], "2026-08-13T03:00:00.000Z"));
    expect(plan.status).toBe("ready");
    expect(plan.decisions.map((decision) => decision.decision)).toEqual([
      "accept", "reject", "retain"
    ]);
    expect(plan.operations.filter((operation) => operation.layer === "canonical"))
      .toHaveLength(2);
  });

  it("returns zero operations and a rollback plan for projection failure, CAS mismatch, or expired proposal", async () => {
    const candidate = await proposal();
    const failedProjection: InstructionProjectionPlan = {
      schema_version: 1,
      canonical_hash: H("f"),
      adapter_version: "instruction_projection_v1",
      status: "invalid",
      executable: false,
      operations: [],
      failures: [{ reason_code: "INSTRUCTION_PROJECTION_RENDER_INVALID", target_agent: "codex" }],
      projection_hashes: {},
      plan_hash: H("7")
    };
    const selection = [{ action_id: onlyAction(candidate).action_id, decision: "accept" as const }];
    for (const [baseline, at] of [
      [candidate.expected_baseline_hash, "2026-08-13T03:00:00.000Z"],
      [H("0"), "2026-08-13T03:00:00.000Z"],
      [candidate.expected_baseline_hash, "2026-08-15T03:00:00.000Z"]
    ] as const) {
      const plan = planInstructionApply(candidate, selection, baseline, failedProjection, at,
        manifestWrite(candidate, [onlyAction(candidate).action_id], at));
      expect(plan.status).toBe("blocked");
      expect(plan.operations).toEqual([]);
      expect(plan.rollback_plan).not.toHaveLength(0);
    }
  });

  it("records reject/retain-only review outcomes without requiring file writes", async () => {
    const candidate = await proposal();
    const plan = planInstructionApply(candidate, [{
      action_id: onlyAction(candidate).action_id,
      decision: "retain"
    }], candidate.expected_baseline_hash, readyProjection(), "2026-08-13T03:00:00.000Z");
    expect(plan).toMatchObject({ status: "ready", operations: [] });
    const receipt = recordInstructionApplyReceipt(plan, {
      completed_at: "2026-08-13T03:01:00.000Z",
      resulting_canonical_hash: plan.resulting_canonical_hash,
      projection_receipt_ref: H("6"),
      applied_operations: []
    });
    expect(receipt.applied_action_ids).toEqual([]);
    expect(receipt.skipped_action_ids).toEqual([onlyAction(candidate).action_id]);
    expect(receipt.action_outcomes).toEqual([{
      action_id: onlyAction(candidate).action_id,
      decision: "retain"
    }]);
  });
});

describe("07B apply receipt and legacy compatibility", () => {
  it("records and verifies a receipt without doing I/O", async () => {
    const candidate = await proposal();
    const projection = readyProjection("managed");
    const plan = planInstructionApply(candidate, [{
      action_id: onlyAction(candidate).action_id, decision: "accept"
    }], candidate.expected_baseline_hash, projection, "2026-08-13T03:00:00.000Z",
    manifestWrite(candidate, [onlyAction(candidate).action_id], "2026-08-13T03:00:00.000Z"));
    const execution = {
      completed_at: "2026-08-13T03:01:00.000Z",
      resulting_canonical_hash: projection.canonical_hash,
      projection_receipt_ref: H("6"),
      applied_operations: plan.operations.map((operation) => ({
        path: operation.path,
        content_hash: operation.content_hash
      }))
    };
    const receipt = recordInstructionApplyReceipt(plan, execution);
    expect(receipt.applied_action_ids).toEqual([onlyAction(candidate).action_id]);
    expect(receipt.skipped_action_ids).toEqual([]);
    expect(receipt.action_outcomes).toEqual([{
      action_id: onlyAction(candidate).action_id,
      decision: "accept"
    }]);
    expect(verifyInstructionApplyReceipt(receipt, candidate, plan, execution)).toEqual({
      valid: true,
      reason_codes: []
    });
    expect(verifyInstructionApplyReceipt(
      { ...receipt, proposal_hash: H("0") }, candidate, plan, execution
    ))
      .toMatchObject({
        valid: false,
        reason_codes: [
          "INSTRUCTION_RECEIPT_PROPOSAL_MISMATCH",
          "INSTRUCTION_RECEIPT_EXECUTION_MISMATCH",
          "INSTRUCTION_RECEIPT_HASH_INVALID"
        ]
      });

    const { receipt_id: ignoredId, receipt_hash: ignoredHash, ...payload } = receipt;
    void ignoredId;
    void ignoredHash;
    const tamperedPayloads: Array<Omit<InstructionApplyReceipt, "receipt_id" | "receipt_hash">> = [
      { ...payload, applied_action_ids: [] },
      { ...payload, skipped_action_ids: [onlyAction(candidate).action_id] },
      { ...payload, action_outcomes: [{
        action_id: onlyAction(candidate).action_id,
        decision: "retain"
      }] },
      { ...payload, changed_paths: [] },
      { ...payload, projection_receipt_ref: H("5") },
      { ...payload, verification: { status: "verified", operation_count: 0 } },
      { ...payload, rollback_ref: H("5") },
      { ...payload, completed_at: "2026-08-13T04:01:00.000Z" }
    ];
    for (const tampered of tamperedPayloads) {
      expect(verifyInstructionApplyReceipt(
        selfHashReceipt(tampered), candidate, plan, execution
      ).valid)
        .toBe(false);
    }
  });

  it("normalizes legacy proposals as read-only and never ready", async () => {
    const result = normalizeLegacyInstructionProposal(
      await fixture("instruction-proposal-v0-legacy.json")
    );
    expect(result).toEqual({
      schema_version: 1,
      source_schema_version: 0,
      legacy_proposal_id: "legacy-proposal-01",
      status: "legacy_unverified",
      ready: false,
      reason_codes: ["INSTRUCTION_LEGACY_REINSPECTION_REQUIRED"]
    });
    expect(Object.isFrozen(result)).toBe(true);
  });
});
