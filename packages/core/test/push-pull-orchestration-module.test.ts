import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { sha256Bytes } from "../src/fs/hash.js";
import {
  createPushPullOrchestration,
  normalizePushPullInput,
  PushPullOrchestrationError,
  type PushPullInteractionInput
} from "../src/push-pull-orchestration/index.js";
import {
  InMemoryRemoteSyncPort,
  RemoteSyncModule,
  type ContentFile,
  type SourceRef
} from "../src/remote-sync/index.js";

const source_ref: SourceRef = {
  project_id: "prj_interaction",
  branch_name: "unmarked",
  commit_sha: "abcdef123456",
  client_id: "cli_interaction"
};

function file(
  path: string,
  content_kind: ContentFile["content_kind"],
  content: string
): ContentFile {
  return {
    path,
    content_kind,
    content_hash: sha256Bytes(content),
    size: Buffer.byteLength(content),
    content
  };
}

function input(
  scopes?: PushPullInteractionInput["scopes"],
  source_mode: PushPullInteractionInput["source_mode"] = "current"
): PushPullInteractionInput {
  return { schema_version: 1, source_ref, source_mode, ...(scopes === undefined ? {} : { scopes }) };
}

function engine(seed: Parameters<InMemoryRemoteSyncPort["seed"]>[1] = {}) {
  const port = new InMemoryRemoteSyncPort();
  port.seed(source_ref, seed);
  return {
    port,
    interaction: createPushPullOrchestration(new RemoteSyncModule(port))
  };
}

describe("PushPullOrchestration v1", () => {
  it("maps a selected push scope and preserves the explicit unmarked identity", async () => {
    const rule = file(".harness/rules/a.md", "rule", "rule\n");
    const instruction = file("AGENTS.md", "instruction", "instructions\n");
    const { interaction } = engine({ local_files: [rule, instruction], remote_files: [] });

    const preview = await interaction.buildPushPreview(input(["rules"]));

    expect(preview).toMatchObject({
      schema_version: 1,
      direction: "push",
      source_ref: { branch_name: "unmarked" },
      scopes: ["rules"],
      outcome: "ready"
    });
    expect(preview.operations).toEqual([
      expect.objectContaining({ path: rule.path, content_kind: "rule", action: "add" })
    ]);
    expect(preview.display_zh.summary).toContain("上传到 Hunter Platform");
    const machine = structuredClone(preview) as { display_zh?: unknown };
    delete machine.display_zh;
    expect(JSON.stringify(machine)).not.toMatch(/[\u3400-\u9fff]/u);
  });

  it("expands push all without archive while default pull stays regular and read-only", async () => {
    const regular = file(".harness/rules/a.md", "rule", "remote rule\n");
    const branch = file("src/feature.txt", "branch_file", "remote branch\n");
    const { interaction, port } = engine({ remote_files: [regular, branch], local_files: [] });

    const pull = await interaction.buildPullPreview(input());
    expect(pull.scopes).toEqual(["architecture", "config", "instructions", "rules"]);
    expect(pull.operations.map((item) => item.path)).toEqual([regular.path]);
    expect(port.localFiles(source_ref)).toEqual([]);

    const push = await interaction.buildPushPreview(input(["all"]));
    expect(push.scopes).toEqual([
      "architecture", "branch_files", "config", "instructions", "rules"
    ]);
    expect(push.scopes).not.toContain("archive");
    await expect(interaction.buildPushPreview(input(["archive"]))).rejects.toMatchObject({
      code: "PUSH_PULL_SCOPE_INVALID"
    });
  });

  it("finishes a zero-item push locally without confirmation, write, or empty version", async () => {
    const shared = file(".harness/rules/a.md", "rule", "same\n");
    const { interaction, port } = engine({
      base_version: "pv_1",
      baseline_files: [shared],
      local_files: [shared],
      remote_files: [shared]
    });

    const preview = await interaction.buildPushPreview(input(["rules"]));
    const result = interaction.confirmPush(preview.preview_hash, {
      action: "continue",
      idempotency_key: "unused-no-change",
      conflict_decisions: []
    });

    expect(preview.outcome).toBe("no_changes");
    expect(result).toMatchObject({ status: "no_changes", preview_hash: preview.preview_hash });
    expect(result).not.toHaveProperty("confirmation_id");
    expect(port.versionCount(source_ref)).toBe(0);
    await expect(interaction.executePush("confirmation:missing")).rejects.toMatchObject({
      code: "PUSH_PULL_NOT_CONFIRMED"
    });
    expect(port.versionCount(source_ref)).toBe(0);
  });

  it("requires an explicit branch source before any branch_files pull preview", async () => {
    const branch = file("src/feature.txt", "branch_file", "remote\n");
    const { interaction, port } = engine({ remote_files: [branch], local_files: [] });

    await expect(interaction.buildPullPreview(input(["branch_files"]))).rejects.toMatchObject({
      code: "PUSH_PULL_SOURCE_REQUIRED"
    });
    expect(port.localFiles(source_ref)).toEqual([]);

    const preview = await interaction.buildPullPreview(input(["branch_files"], "explicit"));
    expect(preview.source_ref.branch_name).toBe("unmarked");
    expect(preview.operations).toEqual([
      expect.objectContaining({ path: branch.path, content_kind: "branch_file" })
    ]);
  });

  it("keeps ordinary pull deletions and restores only with bound artifact/version evidence", async () => {
    const deleted = file(".harness/rules/deleted.md", "rule", "remote\n");
    const { interaction, port } = engine({
      base_version: "pv_1",
      baseline_files: [deleted],
      local_files: [],
      remote_files: [deleted]
    });
    const preview = await interaction.buildPullPreview(input(["rules"]));
    expect(preview.operations).toEqual([
      expect.objectContaining({ path: deleted.path, action: "restore" })
    ]);

    const ordinary = interaction.resolvePull(preview.preview_hash, {
      action: "continue",
      idempotency_key: "pull-ordinary",
      conflict_decisions: []
    });
    if (ordinary.status !== "confirmed") throw new Error("ordinary pull should be confirmed");
    const ordinaryReceipt = await interaction.executePull(ordinary.confirmation_id);
    expect(ordinaryReceipt.sync_receipt.skipped).toEqual([
      expect.objectContaining({ path: deleted.path, action: "restore" })
    ]);
    expect(port.localFiles(source_ref)).toEqual([]);

    const next = await interaction.buildPullPreview(input(["rules"]));
    if (next.remote_version === undefined) throw new Error("restore source must be present");
    expect(() => interaction.resolvePull(next.preview_hash, {
      action: "continue",
      idempotency_key: "pull-restore-missing-source",
      conflict_decisions: [{ path: deleted.path, resolution: "accept_remote" }]
    })).toThrowError(expect.objectContaining({ code: "PUSH_PULL_RESTORE_SOURCE_REQUIRED" }));

    const restore = interaction.resolvePull(next.preview_hash, {
      action: "continue",
      idempotency_key: "pull-restore",
      conflict_decisions: [{
        path: deleted.path,
        resolution: "accept_remote",
        source_artifact_id: next.remote_version.artifact_id,
        source_project_version: next.remote_version.project_version
      }]
    });
    if (restore.status !== "confirmed") throw new Error("restore should be confirmed");
    const restored = await interaction.executePull(restore.confirmation_id);
    expect(restored.preview_hash).toBe(next.preview_hash);
    expect(restored.sync_receipt.applied).toEqual([
      expect.objectContaining({ path: deleted.path, action: "restore" })
    ]);
    expect(port.localFiles(source_ref)).toEqual([deleted]);
  });

  it("preserves rename source_path through preview and receipt", async () => {
    const oldFile = file(".harness/rules/old.md", "rule", "same\n");
    const newFile = file(".harness/rules/new.md", "rule", "same\n");
    const { interaction } = engine({
      base_version: "pv_1",
      baseline_files: [oldFile],
      local_files: [oldFile],
      remote_files: [newFile]
    });
    const preview = await interaction.buildPullPreview(input(["rules"]));
    expect(preview.operations).toEqual([
      expect.objectContaining({ action: "rename", path: newFile.path, source_path: oldFile.path })
    ]);
    const confirmed = interaction.resolvePull(preview.preview_hash, {
      action: "continue", idempotency_key: "pull-rename", conflict_decisions: []
    });
    if (confirmed.status !== "confirmed") throw new Error("rename should be confirmed");
    const receipt = await interaction.executePull(confirmed.confirmation_id);
    expect(receipt.sync_receipt.applied).toEqual([
      expect.objectContaining({ action: "rename", path: newFile.path, source_path: oldFile.path })
    ]);
  });

  it("binds overridable sensitive confirmation to the trusted preview hash", async () => {
    const sensitive = file(".harness/rules/review.md", "rule", "password=supersecret\n");
    const { interaction, port } = engine({ local_files: [sensitive], remote_files: [] });
    const preview = await interaction.buildPushPreview(input(["rules"]));
    expect(preview.security_scan).toMatchObject({ blocked: true, review_required: true });
    const finding = preview.security_scan.findings[0];
    if (finding === undefined) throw new Error("expected sensitive finding");

    expect(() => interaction.confirmPush(preview.preview_hash, {
      action: "continue",
      idempotency_key: "push-sensitive-missing-confirmation",
      conflict_decisions: []
    })).toThrowError(expect.objectContaining({
      code: "PUSH_PULL_SENSITIVE_CONFIRMATION_REQUIRED"
    }));

    const confirmed = interaction.confirmPush(preview.preview_hash, {
      action: "continue",
      idempotency_key: "push-sensitive",
      conflict_decisions: [],
      scan_overrides: [{
        finding_fingerprint: finding.fingerprint,
        actor: "reviewer",
        reason: "fixture credential is synthetic"
      }]
    });
    if (confirmed.status !== "confirmed") throw new Error("push should be confirmed");
    const receipt = await interaction.executePush(confirmed.confirmation_id);
    expect(receipt.preview_hash).toBe(preview.preview_hash);
    expect(receipt.status).toBe("completed");
    const machine = structuredClone(receipt) as { display_zh?: unknown };
    delete machine.display_zh;
    expect(JSON.stringify(machine)).not.toMatch(/[\u3400-\u9fff]/u);
    expect(port.versionCount(source_ref)).toBe(1);

    const replay = await interaction.executePush(confirmed.confirmation_id);
    expect(replay).toEqual(receipt);
    expect(port.versionCount(source_ref)).toBe(1);
  });

  it("delegates hard-block applicability to RemoteSync and preserves zero writes on rejection", async () => {
    const secret = file(
      ".harness/rules/secret.md",
      "rule",
      "Authorization: Bearer secret-token-value-1234567890"
    );
    const { interaction, port } = engine({ local_files: [secret], remote_files: [] });
    const preview = await interaction.buildPushPreview(input(["rules"]));
    expect(preview.security_scan).toMatchObject({ blocked: true, hard_blocked: true });

    const confirmed = interaction.confirmPush(preview.preview_hash, {
      action: "continue",
      idempotency_key: "hard-sensitive",
      conflict_decisions: [],
      scan_overrides: []
    });
    if (confirmed.status !== "confirmed") throw new Error("explicit confirmation should be bound");
    await expect(interaction.executePush(confirmed.confirmation_id)).rejects.toMatchObject({
      code: "SYNC_SENSITIVE_CONTENT_BLOCKED"
    });
    expect(port.versionCount(source_ref)).toBe(0);
  });

  it("supports conflict continue/review/stop without executing review or stop", async () => {
    const base = file(".harness/rules/conflict.md", "rule", "base\n");
    const local = file(base.path, "rule", "local\n");
    const remote = file(base.path, "rule", "remote\n");
    const { interaction, port } = engine({
      base_version: "pv_1", baseline_files: [base], local_files: [local], remote_files: [remote]
    });
    const preview = await interaction.buildPushPreview(input(["rules"]));
    expect(preview.outcome).toBe("needs_resolution");

    expect(interaction.confirmPush(preview.preview_hash, {
      action: "review", idempotency_key: "review", conflict_decisions: []
    })).toMatchObject({ status: "review_required" });
    expect(interaction.confirmPush(preview.preview_hash, {
      action: "stop", idempotency_key: "stop", conflict_decisions: []
    })).toMatchObject({ status: "cancelled" });
    expect(port.versionCount(source_ref)).toBe(0);
    expect(() => interaction.confirmPush(preview.preview_hash, {
      action: "continue", idempotency_key: "missing", conflict_decisions: []
    })).toThrowError(expect.objectContaining({ code: "PUSH_PULL_DECISION_REQUIRED" }));

    const confirmed = interaction.confirmPush(preview.preview_hash, {
      action: "continue",
      idempotency_key: "continue",
      conflict_decisions: [{ path: base.path, resolution: "keep_local" }]
    });
    if (confirmed.status !== "confirmed") throw new Error("conflict should be confirmed");
    const receipt = await interaction.executePush(confirmed.confirmation_id);
    expect(receipt.sync_receipt.applied).toEqual([
      expect.objectContaining({ path: base.path, action: "modify" })
    ]);
    expect(port.versionCount(source_ref)).toBe(1);
  });

  it("never calls RemoteSync execution for review, stop, no_changes, or forged confirmation", async () => {
    const base = file(".harness/rules/conflict.md", "rule", "base\n");
    const local = file(base.path, "rule", "local\n");
    const remote = file(base.path, "rule", "remote\n");
    const port = new InMemoryRemoteSyncPort();
    port.seed(source_ref, {
      base_version: "pv_1", baseline_files: [base], local_files: [local], remote_files: [remote]
    });
    const core = new RemoteSyncModule(port);
    let pushCalls = 0;
    let pullCalls = 0;
    const interaction = createPushPullOrchestration({
      previewPush: (scopes, source) => core.previewPush(scopes, source),
      previewPull: (scopes, source) => core.previewPull(scopes, source),
      push: async (scopes, source, confirmation) => {
        pushCalls += 1;
        return core.push(scopes, source, confirmation);
      },
      pull: async (scopes, source, confirmation) => {
        pullCalls += 1;
        return core.pull(scopes, source, confirmation);
      }
    });
    const preview = await interaction.buildPushPreview(input(["rules"]));
    interaction.confirmPush(preview.preview_hash, {
      action: "review", idempotency_key: "review-zero-call", conflict_decisions: []
    });
    interaction.confirmPush(preview.preview_hash, {
      action: "stop", idempotency_key: "stop-zero-call", conflict_decisions: []
    });
    await expect(interaction.executePush("confirmation:forged")).rejects.toMatchObject({
      code: "PUSH_PULL_NOT_CONFIRMED"
    });
    expect({ pushCalls, pullCalls }).toEqual({ pushCalls: 0, pullCalls: 0 });
    expect(port.versionCount(source_ref)).toBe(0);
  });

  it("lets RemoteSync reject a confirmation whose trusted preview became stale", async () => {
    const local = file(".harness/rules/a.md", "rule", "local\n");
    const { interaction, port } = engine({ local_files: [local], remote_files: [] });
    const preview = await interaction.buildPushPreview(input(["rules"]));
    const confirmed = interaction.confirmPush(preview.preview_hash, {
      action: "continue", idempotency_key: "stale-confirmation", conflict_decisions: []
    });
    if (confirmed.status !== "confirmed") throw new Error("push should be confirmed");
    port.setRemoteFiles(source_ref, [file(".harness/rules/concurrent.md", "rule", "remote\n")]);

    await expect(interaction.executePush(confirmed.confirmation_id)).rejects.toMatchObject({
      code: "SYNC_PREVIEW_STALE"
    });
    expect(port.versionCount(source_ref)).toBe(0);
  });

  it("rejects a forged or cross-direction confirmation before RemoteSync execution", async () => {
    const local = file(".harness/rules/a.md", "rule", "local\n");
    const { interaction, port } = engine({ local_files: [local], remote_files: [] });
    const preview = await interaction.buildPushPreview(input(["rules"]));
    const confirmed = interaction.confirmPush(preview.preview_hash, {
      action: "continue", idempotency_key: "push-only", conflict_decisions: []
    });
    if (confirmed.status !== "confirmed") throw new Error("push should be confirmed");

    await expect(interaction.executePull(confirmed.confirmation_id)).rejects.toMatchObject({
      code: "PUSH_PULL_DIRECTION_MISMATCH"
    });
    await expect(interaction.executePush(`${confirmed.confirmation_id}-forged`)).rejects.toBeInstanceOf(
      PushPullOrchestrationError
    );
    expect(port.versionCount(source_ref)).toBe(0);
  });

  it("rejects a dependency receipt that is not bound to the confirmed preview", async () => {
    const local = file(".harness/rules/a.md", "rule", "local\n");
    const port = new InMemoryRemoteSyncPort();
    port.seed(source_ref, { local_files: [local], remote_files: [] });
    const core = new RemoteSyncModule(port);
    let executions = 0;
    const interaction = createPushPullOrchestration({
      previewPush: (scopes, source) => core.previewPush(scopes, source),
      previewPull: (scopes, source) => core.previewPull(scopes, source),
      push: async (scopes, source, confirmation) => {
        executions += 1;
        const receipt = await core.push(scopes, source, confirmation);
        return { ...receipt, preview_hash: `sha256:${"f".repeat(64)}` };
      },
      pull: (scopes, source, confirmation) => core.pull(scopes, source, confirmation)
    });
    const preview = await interaction.buildPushPreview(input(["rules"]));
    const confirmed = interaction.confirmPush(preview.preview_hash, {
      action: "continue", idempotency_key: "misbound-receipt", conflict_decisions: []
    });
    if (confirmed.status !== "confirmed") throw new Error("push should be confirmed");

    await expect(interaction.executePush(confirmed.confirmation_id)).rejects.toMatchObject({
      code: "PUSH_PULL_RECEIPT_INVALID"
    });
    expect(executions).toBe(1);
  });

  it("normalizes current and legacy sync/upload inputs without retaining dual-write keys", async () => {
    const current: unknown = JSON.parse(await readFile(new URL(
      "./fixtures/push-pull-orchestration-v1-current.json", import.meta.url
    ), "utf8"));
    const legacy = JSON.parse(await readFile(new URL(
      "./fixtures/push-pull-orchestration-v0-legacy.json", import.meta.url
    ), "utf8")) as { inputs: unknown[] };

    expect(normalizePushPullInput(current)).toMatchObject({
      ok: true, source_schema_version: 1, request: { schema_version: 1 }
    });
    const migrated = legacy.inputs.map((item) => normalizePushPullInput(item));
    expect(migrated).toEqual([
      expect.objectContaining({
        ok: true,
        source_schema_version: 0,
        request: expect.objectContaining({
          schema_version: 1,
          direction: "push",
          source_ref: expect.objectContaining({ branch_name: "unmarked" }),
          scopes: ["rules"]
        })
      }),
      expect.objectContaining({
        ok: true,
        source_schema_version: 0,
        request: expect.objectContaining({
          schema_version: 1,
          direction: "pull",
          source_ref: expect.objectContaining({ branch_name: "feature/docs" }),
          source_mode: "explicit",
          scopes: ["branch_files"]
        })
      })
    ]);
    expect(JSON.stringify(migrated)).not.toMatch(/schemaVersion|projectId|branchName|commitSha|clientId/);
    expect(normalizePushPullInput({
      ...(current as object),
      legacy_output_path: ".harness/state/dual-write.json"
    })).toEqual({ ok: false, reason_code: "PUSH_PULL_COMPAT_INVALID" });
  });

  it.each([
    {
      schema_version: 1,
      direction: "push",
      source_ref,
      source_mode: "current",
      scopes: ["archive"]
    },
    {
      schema_version: 1,
      direction: "pull",
      source_ref,
      source_mode: "current",
      scopes: ["branch_files"]
    },
    {
      command: "upload",
      projectId: source_ref.project_id,
      commitSha: source_ref.commit_sha,
      clientId: source_ref.client_id,
      scope: "archive"
    },
    {
      command: "sync",
      direction: "pull",
      projectId: source_ref.project_id,
      commitSha: source_ref.commit_sha,
      clientId: source_ref.client_id,
      scope: "branch_files"
    }
  ])("fails closed when compatibility input cannot enter ordinary Push/Pull", (candidate) => {
    expect(normalizePushPullInput(candidate)).toEqual({
      ok: false,
      reason_code: "PUSH_PULL_COMPAT_INVALID"
    });
  });
});
