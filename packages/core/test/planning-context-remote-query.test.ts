import { isProxy } from "node:util/types";

import { describe, expect, it } from "vitest";

import {
  createRemoteKnowledgeQueryModule,
  type RemoteKnowledgeQueryRequest,
  type RemoteKnowledgeQueryResponse
} from "../src/planning-context/remote-query/index.js";
import {
  knowledgeQueryReceiptId,
  knowledgeResultSetHash,
  type KnowledgeQueryReceipt
} from "../src/planning-context/index.js";

const now = "2026-08-14T10:00:00.000Z";
const hash = (letter: string) => `sha256:${letter.repeat(64)}` as const;

function request(): RemoteKnowledgeQueryRequest {
  return {
    schema_version: 1,
    project_id: "project-remote",
    query_id: `knowledge_query:${"a".repeat(64)}`,
    query_hash: hash("a"),
    reason_code: "initial_intent",
    query: "find the durable publication receipt",
    budget: { max_results: 3, max_total_summary_bytes: 4096, deadline_ms: 5_000 }
  };
}

function responseFor(input: RemoteKnowledgeQueryRequest): RemoteKnowledgeQueryResponse {
  const results = [
    {
      result_id: "knowledge-a",
      kind: "implementation_fact" as const,
      summary: "The publication receipt is durable.",
      relevance: "high" as const,
      source: "docs/receipt.md",
      verified_at: now,
      source_version: "source-v1",
      conflicts_with_intent: false
    }
  ];
  const result_ids = results.map((item) => item.result_id);
  const source_versions = results.map((item) => item.source_version as string);
  const body = {
    schema_version: 1 as const,
    query_hash: input.query_hash,
    project_id: input.project_id,
    index_generation: "generation-7",
    result_ids,
    source_versions,
    result_set_hash: knowledgeResultSetHash({ index_generation: "generation-7", result_ids, source_versions }),
    status: "succeeded" as const,
    executed_at: now,
    reason_code: input.reason_code
  } satisfies Omit<KnowledgeQueryReceipt, "receipt_id">;
  const receipt: KnowledgeQueryReceipt = { ...body, receipt_id: knowledgeQueryReceiptId(body) };
  return {
    schema_version: 1,
    query_id: input.query_id,
    project_id: input.project_id,
    receipt,
    results
  };
}

describe("PlanningContext remote knowledge query seam", () => {
  it("accepts a strictly bound descriptor-only response and freezes it", async () => {
    const input = request();
    const module = createRemoteKnowledgeQueryModule({ execute: async () => responseFor(input) });
    const output = await module.query(input);
    expect(output.receipt.query_hash).toBe(input.query_hash);
    expect(output.results[0]?.summary).toContain("durable");
    expect(Object.isFrozen(output)).toBe(true);
    expect(Object.isFrozen(output.receipt)).toBe(true);
    expect(Object.isFrozen(output.results)).toBe(true);
  });

  it("rejects a response whose receipt or result set is bound to another request", async () => {
    const input = request();
    const foreign = responseFor({ ...input, project_id: "other-project" });
    const module = createRemoteKnowledgeQueryModule({ execute: async () => foreign });
    await expect(module.query(input)).rejects.toMatchObject({ code: "REMOTE_KNOWLEDGE_RESPONSE_INVALID" });
  });

  it("rejects a summary that exceeds the request byte budget", async () => {
    const input = request();
    const base = responseFor(input);
    const hostile = { ...base, results: [{ ...base.results[0], summary: "x".repeat(5_000) }] };
    const module = createRemoteKnowledgeQueryModule({ execute: async () => hostile });
    await expect(module.query(input)).rejects.toMatchObject({ code: "REMOTE_KNOWLEDGE_RESPONSE_INVALID" });
  });

  it("rejects duplicate result ids even when the receipt is otherwise valid", async () => {
    const input = request();
    const base = responseFor(input);
    const hostile = { ...base, results: [{ ...base.results[0] }, { ...base.results[0] }] };
    const module = createRemoteKnowledgeQueryModule({ execute: async () => hostile });
    await expect(module.query(input)).rejects.toMatchObject({ code: "REMOTE_KNOWLEDGE_RESPONSE_INVALID" });
  });

  it("rejects document-like result fields at the descriptor seam", async () => {
    const input = request();
    const base = responseFor(input);
    const hostile = { ...base, results: [{ ...base.results[0], content: "body must not cross the seam" }] };
    const module = createRemoteKnowledgeQueryModule({ execute: async () => hostile });
    await expect(module.query(input)).rejects.toMatchObject({ code: "REMOTE_KNOWLEDGE_RESPONSE_INVALID" });
  });

  it("rejects malformed requests before invoking the Port", async () => {
    let calls = 0;
    const module = createRemoteKnowledgeQueryModule({
      execute: async () => {
        calls += 1;
        return responseFor(request());
      }
    });
    await expect(module.query({ ...request(), query_id: "foreign" } as never))
      .rejects.toMatchObject({ code: "REMOTE_KNOWLEDGE_REQUEST_INVALID" });
    expect(calls).toBe(0);
  });

  it("rejects accessor and Proxy Port seams without executing traps", async () => {
    let getterCalls = 0;
    const accessorPort = Object.defineProperty({}, "execute", {
      enumerable: true,
      configurable: true,
      get() {
        getterCalls += 1;
        return async () => responseFor(request());
      }
    });
    expect(() => createRemoteKnowledgeQueryModule(accessorPort as never)).toThrowError(
      expect.objectContaining({ code: "REMOTE_KNOWLEDGE_PORT_INVALID" })
    );
    expect(getterCalls).toBe(0);

    let proxyCalls = 0;
    const proxy = new Proxy({ execute: async () => responseFor(request()) }, {
      get() {
        proxyCalls += 1;
        throw new Error("trap");
      },
      getOwnPropertyDescriptor() {
        proxyCalls += 1;
        throw new Error("trap");
      },
      ownKeys() {
        proxyCalls += 1;
        throw new Error("trap");
      },
      getPrototypeOf() {
        proxyCalls += 1;
        throw new Error("trap");
      }
    });
    expect(isProxy(proxy)).toBe(true);
    expect(() => createRemoteKnowledgeQueryModule(proxy as never)).toThrowError(
      expect.objectContaining({ code: "REMOTE_KNOWLEDGE_PORT_INVALID" })
    );
    expect(proxyCalls).toBe(0);
  });

  it("fails closed on abort and never falls back to a local result", async () => {
    const controller = new AbortController();
    controller.abort();
    let calls = 0;
    const module = createRemoteKnowledgeQueryModule({
      execute: async () => {
        calls += 1;
        return responseFor(request());
      }
    });
    await expect(module.query(request(), controller.signal)).rejects.toMatchObject({ code: "REMOTE_KNOWLEDGE_ABORTED" });
    expect(calls).toBe(0);
  });

  it("accepts the canonical failed receipt without inventing a local result", async () => {
    const input = request();
    const body = {
      schema_version: 1 as const,
      query_hash: input.query_hash,
      project_id: input.project_id,
      result_ids: [] as string[],
      source_versions: [] as string[],
      result_set_hash: knowledgeResultSetHash({ index_generation: null, result_ids: [], source_versions: [] }),
      status: "failed" as const,
      executed_at: now,
      reason_code: "remote_knowledge_unavailable" as const,
      failure_code: "REMOTE_TIMEOUT"
    };
    const response: RemoteKnowledgeQueryResponse = {
      schema_version: 1,
      query_id: input.query_id,
      project_id: input.project_id,
      receipt: { ...body, receipt_id: knowledgeQueryReceiptId(body) },
      results: []
    };
    const module = createRemoteKnowledgeQueryModule({ execute: async () => response });
    await expect(module.query(input)).resolves.toMatchObject({ receipt: { status: "failed" }, results: [] });
  });

  it("maps a hostile AbortSignal to a stable seam error without executing its trap", async () => {
    let traps = 0;
    const signal = new Proxy({}, {
      get() {
        traps += 1;
        throw new Error("signal trap");
      }
    }) as AbortSignal;
    const module = createRemoteKnowledgeQueryModule({ execute: async () => responseFor(request()) });
    await expect(module.query(request(), signal)).rejects.toMatchObject({ code: "REMOTE_KNOWLEDGE_ABORTED" });
    expect(traps).toBe(0);
  });

  it("does not execute an accessor on a non-native AbortSignal object", async () => {
    let getterCalls = 0;
    const signal = Object.defineProperty({}, "aborted", {
      enumerable: true,
      get() {
        getterCalls += 1;
        throw new Error("aborted getter");
      }
    }) as AbortSignal;
    const module = createRemoteKnowledgeQueryModule({ execute: async () => responseFor(request()) });
    await expect(module.query(request(), signal)).rejects.toMatchObject({ code: "REMOTE_KNOWLEDGE_ABORTED" });
    expect(getterCalls).toBe(0);
  });

  it("rejects Promise subclasses before awaiting a hostile then implementation", async () => {
    let traps = 0;
    class HostilePromise<T> extends Promise<T> {
      get then(): Promise<T>["then"] {
        traps += 1;
        throw new Error("then trap");
      }
    }
    const module = createRemoteKnowledgeQueryModule({
      execute: () => new HostilePromise<RemoteKnowledgeQueryResponse>((resolve) => resolve(responseFor(request())))
    });
    await expect(module.query(request())).rejects.toMatchObject({ code: "REMOTE_KNOWLEDGE_UNAVAILABLE" });
    expect(traps).toBe(0);
  });

  it("rejects a native Promise carrying an own accessor before awaiting it", async () => {
    let getterCalls = 0;
    const result = Promise.resolve(responseFor(request()));
    Object.defineProperty(result, "constructor", {
      configurable: true,
      get() {
        getterCalls += 1;
        throw new Error("constructor getter");
      }
    });
    const module = createRemoteKnowledgeQueryModule({ execute: () => result });
    await expect(module.query(request())).rejects.toMatchObject({ code: "REMOTE_KNOWLEDGE_UNAVAILABLE" });
    expect(getterCalls).toBe(0);
  });

  it("rejects a non-native thenable returned by the Port", async () => {
    const module = createRemoteKnowledgeQueryModule({
      execute: () => ({ then: () => responseFor(request()) } as never)
    });
    await expect(module.query(request())).rejects.toMatchObject({ code: "REMOTE_KNOWLEDGE_UNAVAILABLE" });
  });
});
