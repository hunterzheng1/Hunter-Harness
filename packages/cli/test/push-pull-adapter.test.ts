import { describe, expect, it, vi } from "vitest";

import {
  PushPullCliAdapterError,
  createPushPullCliPort
} from "../src/push-pull-adapter/index.js";

const interaction = {
  schema_version: 1 as const,
  source_ref: {
    project_id: "project-1",
    branch_name: "main",
    commit_sha: "0123456789abcdef",
    client_id: "client-1"
  },
  source_mode: "current" as const,
  scopes: ["rules"] as const
};

function orchestration() {
  return {
    buildPushPreview: vi.fn(async () => ({
      schema_version: 1 as const,
      direction: "push" as const,
      preview_hash: "preview-1",
      source_ref: interaction.source_ref,
      scopes: ["rules"] as const,
      outcome: "no_changes" as const,
      base_version: null,
      remote_version: undefined,
      operations: [],
      conflicts: [],
      security_scan: {
        scanner_version: "1.1.0", scan_performed: false, blocked: false, hard_blocked: false,
        review_required: false, findings: []
      },
      display_zh: { heading: "Push 预览", summary: "没有变化", detail_lines: [] }
    })),
    confirmPush: vi.fn(() => ({
      schema_version: 1 as const,
      status: "confirmed" as const,
      direction: "push" as const,
      preview_hash: "preview-1",
      confirmation_id: "confirmation-1",
      display_zh: { heading: "确认", summary: "已确认", detail_lines: [] }
    })),
    executePush: vi.fn(async () => ({
      schema_version: 1 as const,
      direction: "push" as const,
      preview_hash: "preview-1",
      status: "retryable" as const,
      sync_receipt: {
        preview_hash: "preview-1",
        no_changes: false,
        applied: [],
        skipped: [],
        retryable: [{
          path: ".harness/rules/example.md", content_kind: "rule" as const,
          action: "modify" as const
        }],
        reason_code: "REMOTE_UNAVAILABLE" as const
      },
      display_zh: { heading: "Push 结果", summary: "可重试", detail_lines: [] }
    })),
    buildPullPreview: vi.fn(),
    resolvePull: vi.fn(),
    executePull: vi.fn()
  };
}

describe("PushPullCliPort", () => {
  it("dispatches exact preview input to the Stage 03 orchestration Interface", async () => {
    const module = orchestration();
    const port = createPushPullCliPort({ orchestration: module });

    const result = await port.dispatch({
      schema_version: 1,
      operation: "preview",
      direction: "push",
      interaction
    });

    expect(result).toMatchObject({
      schema_version: 1,
      operation: "preview",
      direction: "push",
      retry: { retryable: false, reason_code: null },
      result: { preview_hash: "preview-1" }
    });
    expect(module.buildPushPreview).toHaveBeenCalledOnce();
  });

  it("derives execute verification and retry metadata only from a successful Core receipt", async () => {
    const module = orchestration();
    const port = createPushPullCliPort({ orchestration: module });

    await port.dispatch({
      schema_version: 1,
      operation: "confirm",
      direction: "push",
      preview_hash: "preview-1",
      decision: { action: "continue", idempotency_key: "request-1", conflict_decisions: [] }
    });

    const result = await port.dispatch({
      schema_version: 1,
      operation: "execute",
      direction: "push",
      confirmation_id: "confirmation-1"
    });

    expect(result).toMatchObject({
      operation: "execute",
      verification: { status: "verified", preview_hash: "preview-1" },
      retry: { retryable: true, reason_code: "REMOTE_UNAVAILABLE" }
    });
    expect(module.executePush).toHaveBeenCalledWith("confirmation-1");
  });

  it("rejects unknown and foreign confirmations before execute Core calls", async () => {
    const module = orchestration();
    const port = createPushPullCliPort({ orchestration: module });

    await expect(port.dispatch({ schema_version: 1, operation: "execute", direction: "push",
      confirmation_id: "unknown" })).rejects.toMatchObject({ code: "PUSH_PULL_CLI_INPUT_INVALID" });
    await port.dispatch({ schema_version: 1, operation: "confirm", direction: "push",
      preview_hash: "preview-1",
      decision: { action: "continue", idempotency_key: "request-1", conflict_decisions: [] } });
    await expect(port.dispatch({ schema_version: 1, operation: "execute", direction: "pull",
      confirmation_id: "confirmation-1" })).rejects.toMatchObject({ code: "PUSH_PULL_CLI_INPUT_INVALID" });

    expect(module.executePush).not.toHaveBeenCalled();
    expect(module.executePull).not.toHaveBeenCalled();
  });

  it("does not verify an execution receipt that drifts from its registered preview", async () => {
    const module = orchestration();
    module.executePush.mockResolvedValueOnce({
      ...(await orchestration().executePush()),
      preview_hash: "preview-foreign",
      sync_receipt: { ...(await orchestration().executePush()).sync_receipt,
        preview_hash: "preview-foreign" }
    });
    const port = createPushPullCliPort({ orchestration: module });
    await port.dispatch({ schema_version: 1, operation: "confirm", direction: "push",
      preview_hash: "preview-1",
      decision: { action: "continue", idempotency_key: "request-1", conflict_decisions: [] } });

    await expect(port.dispatch({ schema_version: 1, operation: "execute", direction: "push",
      confirmation_id: "confirmation-1" })).rejects.toMatchObject({ code: "PUSH_PULL_CLI_OUTPUT_INVALID" });
  });

  it("binds a confirmation id to one request identity and keeps execute replay idempotent", async () => {
    const module = orchestration();
    const port = createPushPullCliPort({ orchestration: module });
    await port.dispatch({ schema_version: 1, operation: "confirm", direction: "push",
      preview_hash: "preview-1",
      decision: { action: "continue", idempotency_key: "request-1", conflict_decisions: [] } });

    await expect(port.dispatch({ schema_version: 1, operation: "confirm", direction: "push",
      preview_hash: "preview-1",
      decision: { action: "continue", idempotency_key: "request-foreign", conflict_decisions: [] }
    })).rejects.toMatchObject({ code: "PUSH_PULL_CLI_OUTPUT_INVALID" });
    await expect(Promise.all([
      port.dispatch({ schema_version: 1, operation: "execute", direction: "push",
        confirmation_id: "confirmation-1" }),
      port.dispatch({ schema_version: 1, operation: "execute", direction: "push",
        confirmation_id: "confirmation-1" })
    ])).resolves.toHaveLength(2);
    expect(module.executePush).toHaveBeenCalledTimes(2);
  });

  it("maps confirm through the direction-specific trusted confirmation method", async () => {
    const module = orchestration();
    const port = createPushPullCliPort({ orchestration: module });
    const decision = {
      action: "continue" as const,
      idempotency_key: "request-1",
      conflict_decisions: []
    };

    const result = await port.dispatch({
      schema_version: 1,
      operation: "confirm",
      direction: "push",
      preview_hash: "preview-1",
      decision
    });

    expect(result).toMatchObject({
      operation: "confirm",
      direction: "push",
      retry: { retryable: false, reason_code: null },
      result: { confirmation_id: "confirmation-1" }
    });
    expect(module.confirmPush).toHaveBeenCalledWith("preview-1", decision);
  });

  it("fails closed asynchronously when the requested capability is unavailable", async () => {
    const port = createPushPullCliPort({});
    let settled = false;
    const pending = port.dispatch({
      schema_version: 1,
      operation: "preview",
      direction: "push",
      interaction
    }).catch((error: unknown) => {
      expect(error).toBeInstanceOf(PushPullCliAdapterError);
      expect(error).toMatchObject({ code: "PUSH_PULL_CLI_UNAVAILABLE", retryable: true });
    }).finally(() => { settled = true; });

    expect(settled).toBe(false);
    await pending;
  });

  it("rejects an explicitly configured malformed dependency", () => {
    expect(() => createPushPullCliPort({ orchestration: {} as never })).toThrow(expect.objectContaining({
      code: "PUSH_PULL_CLI_DEPENDENCY_INVALID",
      retryable: false
    }));
  });

  it("rejects extra fields, accessors, and hostile Proxies before any Core call", async () => {
    const module = orchestration();
    const port = createPushPullCliPort({ orchestration: module });
    const getter = vi.fn(() => "push");
    const accessor = Object.defineProperty({
      schema_version: 1,
      operation: "preview",
      interaction
    }, "direction", { enumerable: true, get: getter });
    const hostile = new Proxy({}, {
      ownKeys() { throw new Error("trap"); }
    });
    const nestedHostile = new Proxy(interaction, {
      getOwnPropertyDescriptor() { throw new Error("nested trap"); }
    });

    for (const request of [
      { schema_version: 1, operation: "preview", direction: "push", interaction, extra: true },
      { schema_version: 1, operation: "preview", direction: "push", interaction: nestedHostile },
      accessor,
      hostile
    ]) {
      await expect(port.dispatch(request as never)).rejects.toMatchObject({
        code: "PUSH_PULL_CLI_INPUT_INVALID",
        retryable: false
      });
    }
    expect(getter).not.toHaveBeenCalled();
    expect(module.buildPushPreview).not.toHaveBeenCalled();
  });

  it("snapshots nested input arrays once and rejects chameleon Proxies with zero traps", async () => {
    const module = orchestration();
    const port = createPushPullCliPort({ orchestration: module });
    const traps = { getPrototypeOf: vi.fn(), ownKeys: vi.fn(), getOwnPropertyDescriptor: vi.fn() };
    const hostileScopes = new Proxy(["rules"], traps);

    await expect(port.dispatch({ schema_version: 1, operation: "preview", direction: "push",
      interaction: { ...interaction, scopes: hostileScopes } })).rejects.toMatchObject({
      code: "PUSH_PULL_CLI_INPUT_INVALID"
    });
    expect(traps.getPrototypeOf).not.toHaveBeenCalled();
    expect(traps.ownKeys).not.toHaveBeenCalled();
    expect(traps.getOwnPropertyDescriptor).not.toHaveBeenCalled();
    expect(module.buildPushPreview).not.toHaveBeenCalled();
  });

  it("rejects hostile choice and override arrays before confirmation Core calls", async () => {
    for (const field of ["conflict_decisions", "scan_overrides"] as const) {
      const module = orchestration();
      const port = createPushPullCliPort({ orchestration: module });
      const traps = { getPrototypeOf: vi.fn(), ownKeys: vi.fn(), getOwnPropertyDescriptor: vi.fn() };
      const hostile = new Proxy([], traps);
      const decision = { action: "continue", idempotency_key: "request-1",
        conflict_decisions: field === "conflict_decisions" ? hostile : [],
        ...(field === "scan_overrides" ? { scan_overrides: hostile } : {}) };

      await expect(port.dispatch({ schema_version: 1, operation: "confirm", direction: "push",
        preview_hash: "preview-1", decision })).rejects.toMatchObject({
        code: "PUSH_PULL_CLI_INPUT_INVALID"
      });
      expect(traps.getPrototypeOf).not.toHaveBeenCalled();
      expect(traps.ownKeys).not.toHaveBeenCalled();
      expect(traps.getOwnPropertyDescriptor).not.toHaveBeenCalled();
      expect(module.confirmPush).not.toHaveBeenCalled();
    }
  });

  it("passes only plain deeply frozen snapshots to orchestration", async () => {
    const module = orchestration();
    module.buildPushPreview.mockImplementationOnce(async (input) => {
      expect(Object.isFrozen(input)).toBe(true);
      expect(Object.isFrozen(input.source_ref)).toBe(true);
      expect(Object.isFrozen(input.scopes)).toBe(true);
      return orchestration().buildPushPreview();
    });
    module.confirmPush.mockImplementationOnce((_previewHash, input) => {
      expect(Object.isFrozen(input)).toBe(true);
      expect(Object.isFrozen(input.conflict_decisions)).toBe(true);
      expect(Object.isFrozen(input.conflict_decisions[0])).toBe(true);
      expect(Object.isFrozen(input.scan_overrides)).toBe(true);
      expect(Object.isFrozen(input.scan_overrides?.[0])).toBe(true);
      return orchestration().confirmPush();
    });
    const port = createPushPullCliPort({ orchestration: module });
    await port.dispatch({ schema_version: 1, operation: "preview", direction: "push", interaction });
    await port.dispatch({ schema_version: 1, operation: "confirm", direction: "push",
      preview_hash: "preview-1", decision: { action: "continue", idempotency_key: "request-1",
        conflict_decisions: [{ path: "rules/a.md", resolution: "skip" }],
        scan_overrides: [{ finding_fingerprint: "sha256:finding", actor: "operator", reason: "reviewed" }] }
    });
  });

  it("rejects archive in every ordinary operation before Core is called", async () => {
    const module = orchestration();
    const port = createPushPullCliPort({ orchestration: module });

    await expect(port.dispatch({
      schema_version: 1,
      operation: "preview",
      direction: "push",
      interaction: { ...interaction, scopes: ["archive"] }
    })).rejects.toMatchObject({ code: "PUSH_PULL_CLI_INPUT_INVALID" });
    expect(module.buildPushPreview).not.toHaveBeenCalled();
  });

  it("uses the Core outcome reader for restore and sensitive-review semantics", async () => {
    const restoreModule = orchestration();
    restoreModule.buildPullPreview = vi.fn(async () => ({
      ...(await orchestration().buildPushPreview()),
      direction: "pull" as const,
      outcome: "needs_resolution",
      operations: [{ path: ".harness/rules/restored.md", content_kind: "rule", action: "restore" }]
    }));
    await expect(createPushPullCliPort({ orchestration: restoreModule }).dispatch({
      schema_version: 1, operation: "preview", direction: "pull", interaction
    })).resolves.toMatchObject({ result: { outcome: "needs_resolution" } });

    const sensitiveModule = orchestration();
    sensitiveModule.buildPushPreview.mockResolvedValueOnce({
      ...(await orchestration().buildPushPreview()),
      outcome: "sensitive_confirmation_required",
      operations: [{ path: ".harness/rules/review.md", content_kind: "rule", action: "modify" }],
      security_scan: { scanner_version: "1.1.0", scan_performed: true, blocked: true, hard_blocked: false,
        review_required: true, findings: [{
          rule_id: "HH_PASSWORD_VALUE", severity: "medium", path: ".harness/rules/review.md",
          line: 1, column: 1, fingerprint: "sha256:finding", redacted_preview: "[REDACTED]",
          overridable: true, disposition: "blocked"
        }] }
    });
    await expect(createPushPullCliPort({ orchestration: sensitiveModule }).dispatch({
      schema_version: 1, operation: "preview", direction: "push", interaction
    })).resolves.toMatchObject({ result: { outcome: "sensitive_confirmation_required" } });

    const contradictory = orchestration();
    contradictory.buildPullPreview = vi.fn(async () => ({
      ...(await orchestration().buildPushPreview()),
      direction: "pull" as const,
      outcome: "ready",
      operations: [{ path: ".harness/rules/restored.md", content_kind: "rule", action: "restore" }]
    }));
    await expect(createPushPullCliPort({ orchestration: contradictory }).dispatch({
      schema_version: 1, operation: "preview", direction: "pull", interaction
    })).rejects.toMatchObject({ code: "PUSH_PULL_CLI_OUTPUT_INVALID" });
  });

  it("rejects malformed and hostile Core outputs instead of marking them verified", async () => {
    const getter = vi.fn(() => "preview-1");
    const previewProxy = new Proxy({}, { ownKeys() { throw new Error("preview output trap"); } });
    const confirmGetter = vi.fn(() => "confirmed");
    const cases = [
      { ...orchestration(), buildPushPreview: vi.fn(async () => previewProxy) },
      { ...orchestration(), confirmPush: vi.fn(() => Object.defineProperty({
        schema_version: 1, direction: "push", preview_hash: "preview-1",
        confirmation_id: "confirmation-1", display_zh: { heading: "x", summary: "x", detail_lines: [] }
      }, "status", { enumerable: true, get: confirmGetter })) },
      { ...orchestration(), executePush: vi.fn(async () => Object.defineProperty({
        schema_version: 1, direction: "push", status: "completed", sync_receipt: {},
        display_zh: { heading: "x", summary: "x", detail_lines: [] }
      }, "preview_hash", { enumerable: true, get: getter })) }
    ];

    await expect(createPushPullCliPort({ orchestration: cases[0] as never }).dispatch({
      schema_version: 1, operation: "preview", direction: "push", interaction
    })).rejects.toMatchObject({ code: "PUSH_PULL_CLI_OUTPUT_INVALID" });
    await expect(createPushPullCliPort({ orchestration: cases[1] as never }).dispatch({
      schema_version: 1, operation: "confirm", direction: "push", preview_hash: "preview-1",
      decision: { action: "continue", idempotency_key: "request-1", conflict_decisions: [] }
    })).rejects.toMatchObject({ code: "PUSH_PULL_CLI_OUTPUT_INVALID" });
    const executePort = createPushPullCliPort({ orchestration: cases[2] as never });
    await executePort.dispatch({
      schema_version: 1, operation: "confirm", direction: "push", preview_hash: "preview-1",
      decision: { action: "continue", idempotency_key: "request-1", conflict_decisions: [] }
    });
    await expect(executePort.dispatch({
      schema_version: 1, operation: "execute", direction: "push", confirmation_id: "confirmation-1"
    })).rejects.toMatchObject({ code: "PUSH_PULL_CLI_OUTPUT_INVALID" });
    expect(getter).not.toHaveBeenCalled();
    expect(confirmGetter).not.toHaveBeenCalled();
  });

});
