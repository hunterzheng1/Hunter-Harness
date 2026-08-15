import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";

import { canonicalJson } from "../src/canonical-json.js";
import {
  platformInformationExportArtifactReceiptSchema,
  platformInformationExportProofPayload,
  PLATFORM_INFORMATION_EXPORT_LIMITS,
  readPlatformInformationExportArtifactReceipt,
  verifyPlatformInformationExportArtifact,
  type PlatformInformationExportChunkReaderPort,
  type PlatformInformationExportHashPort,
  type PlatformInformationExportHashSession,
} from "../src/platform-information-export.js";

const encoder = new TextEncoder();

class NodeHashSession implements PlatformInformationExportHashSession {
  readonly #hash = createHash("sha256");

  update(chunk: Uint8Array): void {
    this.#hash.update(chunk);
  }

  digest(): `sha256:${string}` {
    return `sha256:${this.#hash.digest("hex")}`;
  }
}

const nodeHashPort: PlatformInformationExportHashPort = {
  create_sha256: () => new NodeHashSession(),
  sha256: (bytes) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
};

const sha256 = (bytes: Uint8Array): `sha256:${string}` =>
  `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

function buildCurrentArtifact() {
  const range = {
    query_scope: {
      actor_id: "actor_1",
      accessible_project_ids: ["prj_demo"],
      content_types: ["knowledge_entry"],
    },
    limit: 25,
    source_cursor: null,
    cursor_verification: "server_port_required",
    sort: "extracted_at_desc_knowledge_id_asc",
  } as const;
  const item = {
    item_kind: "knowledge_entry",
    knowledge_id: "knowledge_1",
    display_title: "中文知识条目",
    lifecycle_status: "active",
    source_change_key: "change_1",
    extracted_at: "2026-08-14T00:00:00Z",
    relationship_count: 2,
    sort_key: "2026-08-14T00:00:00Z:knowledge_1",
  } as const;
  const itemLine = {
    schema_version: 1,
    line_kind: "item",
    ordinal: 1,
    item_sha: sha256(encoder.encode(canonicalJson(item))),
    item,
  } as const;
  const itemLineBytes = encoder.encode(`${canonicalJson(itemLine)}\n`);
  const items_sha = sha256(itemLineBytes);
  const m4_proof = {
    pages: [{ request_cursor: null, response_next_cursor: null, result_count: 1 }],
    exported_count: 1,
    items_sha,
    completed: true,
  } as const;
  const identity = {
    export_id: "export_knowledge_1",
    project_id: "prj_demo",
    view: "project_knowledge",
    range,
    m4_proof,
  } as const;
  const proof_sha = sha256(encoder.encode(canonicalJson({
    schema_version: 1,
    ...identity,
  })));
  const created_at = "2026-08-14T00:00:00Z";
  const expires_at = "2026-08-15T00:00:00Z";
  const manifest = {
    schema_version: 1,
    line_kind: "manifest",
    format: "canonical_jsonl_v1",
    ...identity,
    proof_sha,
    created_at,
    expires_at,
  } as const;
  const footer = {
    schema_version: 1,
    line_kind: "footer",
    export_id: identity.export_id,
    proof_sha,
    items_sha,
    item_count: 1,
    page_count: 1,
  } as const;
  const bytes = encoder.encode([
    canonicalJson(manifest),
    canonicalJson(itemLine),
    canonicalJson(footer),
    "",
  ].join("\n"));
  const content_sha = sha256(bytes);
  const receipt = {
    schema_version: 1,
    contract_kind: "platform_information_export_artifact_receipt",
    ...identity,
    proof_sha,
    artifact: {
      format: "canonical_jsonl_v1",
      media_type: "application/x-ndjson",
      content_sha,
      items_sha,
      byte_count: bytes.byteLength,
      item_count: 1,
      page_count: 1,
    },
    download_ref: {
      export_id: identity.export_id,
      project_id: identity.project_id,
      content_sha,
    },
    status: "ready",
    created_at,
    expires_at,
  } as const;
  return { bytes, receipt, manifest, itemLine, footer };
}

function chunkReader(bytes: Uint8Array, chunkSizes = [bytes.byteLength]): PlatformInformationExportChunkReaderPort {
  let offset = 0;
  let index = 0;
  return {
    read: () => {
      if (offset === bytes.byteLength) return null;
      const size = chunkSizes[index++ % chunkSizes.length] ?? bytes.byteLength;
      const chunk = bytes.slice(offset, Math.min(offset + size, bytes.byteLength));
      offset += chunk.byteLength;
      return chunk;
    },
  };
}

function buildManyItemArtifact(itemCount: number) {
  const range = {
    query_scope: { actor_id: "actor_1", accessible_project_ids: ["prj_demo"], content_types: ["knowledge_entry"] },
    limit: 100,
    source_cursor: null,
    cursor_verification: "server_port_required",
    sort: "extracted_at_desc_knowledge_id_asc",
  } as const;
  const itemLines = Array.from({ length: itemCount }, (_, index) => {
    const ordinal = index + 1;
    const item = {
      item_kind: "knowledge_entry" as const,
      knowledge_id: `knowledge_${ordinal}`,
      display_title: `知识条目 ${ordinal}`,
      lifecycle_status: "active" as const,
      source_change_key: `change_${ordinal}`,
      extracted_at: "2026-08-14T00:00:00Z",
      relationship_count: 0,
      sort_key: `2026-08-14T00:00:00Z:knowledge_${String(ordinal).padStart(7, "0")}`,
    };
    return { schema_version: 1 as const, line_kind: "item" as const, ordinal, item_sha: sha256(encoder.encode(canonicalJson(item))), item };
  });
  const itemBytes = encoder.encode(itemLines.map((line) => `${canonicalJson(line)}\n`).join(""));
  const items_sha = sha256(itemBytes);
  const pageCount = Math.ceil(itemCount / range.limit);
  const cursors = Array.from({ length: Math.max(0, pageCount - 1) }, (_, index) =>
    `cursor_${String(index + 1).padStart(12, "0")}`);
  const pages = Array.from({ length: pageCount }, (_, index) => ({
    request_cursor: index === 0 ? null : (cursors[index - 1] ?? null),
    response_next_cursor: index === pageCount - 1 ? null : (cursors[index] ?? null),
    result_count: Math.min(range.limit, itemCount - index * range.limit),
  }));
  const m4_proof = { pages, exported_count: itemCount, items_sha, completed: true as const };
  const identity = { export_id: "export_many", project_id: "prj_demo", view: "project_knowledge" as const, range, m4_proof };
  const proof_sha = sha256(encoder.encode(canonicalJson({ schema_version: 1, ...identity })));
  const created_at = "2026-08-14T00:00:00Z";
  const expires_at = "2026-08-15T00:00:00Z";
  const manifest = { schema_version: 1, line_kind: "manifest", format: "canonical_jsonl_v1", ...identity, proof_sha, created_at, expires_at } as const;
  const footer = { schema_version: 1, line_kind: "footer", export_id: identity.export_id, proof_sha, items_sha, item_count: itemCount, page_count: pageCount } as const;
  const bytes = encoder.encode(`${canonicalJson(manifest)}\n${new TextDecoder().decode(itemBytes)}${canonicalJson(footer)}\n`);
  const content_sha = sha256(bytes);
  const receipt = {
    schema_version: 1, contract_kind: "platform_information_export_artifact_receipt", ...identity, proof_sha,
    artifact: { format: "canonical_jsonl_v1", media_type: "application/x-ndjson", content_sha, items_sha, byte_count: bytes.byteLength, item_count: itemCount, page_count: pageCount },
    download_ref: { export_id: identity.export_id, project_id: identity.project_id, content_sha },
    status: "ready", created_at, expires_at,
  } as const;
  return { bytes, receipt };
}

describe("Platform Information Export Artifact v1 contract", () => {
  it("publishes the bounded receipt and canonical JSONL line schemas without an HTTP operation", async () => {
    const openApi = await readFile(new URL(
      "../openapi/hunter-harness-v1.yaml",
      import.meta.url,
    ), "utf8").catch(() => readFile(new URL(
      "../../../apps/server/openapi/hunter-harness-v1.yaml",
      import.meta.url,
    ), "utf8"));
    const document = parseYaml(openApi) as {
      paths?: Record<string, unknown>;
      components?: { schemas?: Record<string, {
        properties?: Record<string, unknown>;
        oneOf?: unknown[];
      }> };
    };
    const schemas = document.components?.schemas ?? {};
    expect(schemas.PlatformInformationExportArtifactSummary?.properties).toMatchObject({
      format: { const: "canonical_jsonl_v1" },
      media_type: { const: "application/x-ndjson" },
      byte_count: { maximum: 536870912 },
      item_count: { maximum: 1000000 },
      page_count: { maximum: 10000 },
    });
    expect(schemas.PlatformInformationExportArtifactReceipt?.properties?.status).toEqual({
      type: "string",
      const: "ready",
    });
    expect(schemas.PlatformInformationExportJsonlLine?.oneOf).toHaveLength(3);
    expect(Object.keys(document.paths ?? {}).some((path) => path.includes("export-artifact"))).toBe(false);
  });

  it("rejects hostile serialized metadata without executing hash or chunk ports", async () => {
    let executions = 0;
    const result = await verifyPlatformInformationExportArtifact(
      '{"schema_version":1,"contract_kind":"platform_information_export_artifact_receipt","extra":true}',
      {
        hash_port: {
          create_sha256: () => { executions += 1; return new NodeHashSession(); },
          sha256: () => { executions += 1; return `sha256:${"0".repeat(64)}`; },
        },
        chunk_reader: { read: () => { executions += 1; return null; } },
      },
    );

    expect(result).toEqual({
      ok: false,
      reason_code: "PLATFORM_INFORMATION_EXPORT_RECEIPT_INVALID",
    });
    expect(executions).toBe(0);
  });

  it("keeps legacy receipts read-only and fails unknown versions closed", () => {
    const legacy = JSON.stringify({
      schemaVersion: 0,
      exportId: "export_legacy_1",
      projectId: "prj_demo",
      format: "json",
      createdAt: "2026-08-14T00:00:00Z",
    });

    expect(readPlatformInformationExportArtifactReceipt(legacy)).toMatchObject({
      ok: true,
      mode: "legacy_read_only",
      source_schema_version: 0,
    });
    expect(readPlatformInformationExportArtifactReceipt(JSON.stringify({
      schema_version: 9,
      contract_kind: "platform_information_export_artifact_receipt",
    }))).toEqual({
      ok: false,
      reason_code: "PLATFORM_INFORMATION_EXPORT_VERSION_UNSUPPORTED",
    });
  });

  it("reads the current and legacy fixtures and verifies the canonical artifact fixture", async () => {
    const current = await readFile(new URL("./fixtures/platform-information-export-v1-current.json", import.meta.url), "utf8");
    const legacy = await readFile(new URL("./fixtures/platform-information-export-v0-legacy.json", import.meta.url), "utf8");
    const artifact = new Uint8Array(await readFile(new URL(
      "./fixtures/platform-information-export-canonical-v1-current.jsonl",
      import.meta.url,
    )));

    expect(readPlatformInformationExportArtifactReceipt(current)).toMatchObject({
      ok: true,
      mode: "current",
      source_schema_version: 1,
    });
    expect(readPlatformInformationExportArtifactReceipt(legacy)).toMatchObject({
      ok: true,
      mode: "legacy_read_only",
      source_schema_version: 0,
    });
    await expect(verifyPlatformInformationExportArtifact(current, {
      hash_port: nodeHashPort,
      chunk_reader: chunkReader(artifact, [7, 11, 17]),
    })).resolves.toMatchObject({ ok: true, value: { item_count: 1, byte_count: 1457 } });
  });

  it("verifies a canonical JSONL artifact incrementally across UTF-8 boundaries", async () => {
    const { bytes, receipt } = buildCurrentArtifact();
    expect(platformInformationExportArtifactReceiptSchema.safeParse(receipt).success).toBe(true);
    expect(platformInformationExportProofPayload(receipt)).toEqual({
      schema_version: 1,
      export_id: receipt.export_id,
      project_id: receipt.project_id,
      view: receipt.view,
      range: receipt.range,
      m4_proof: receipt.m4_proof,
    });

    await expect(verifyPlatformInformationExportArtifact(JSON.stringify(receipt), {
      hash_port: nodeHashPort,
      chunk_reader: chunkReader(bytes, [1, 2, 3, 5, 8, 13]),
    })).resolves.toEqual({
      ok: true,
      value: { receipt, item_count: 1, byte_count: bytes.byteLength },
    });
  });

  it("binds the proof, download identity, counts and strict lifetime in the receipt", () => {
    const { receipt } = buildCurrentArtifact();
    const invalid = [
      { ...receipt, proof_sha: "sha256:nope" },
      { ...receipt, artifact: { ...receipt.artifact, item_count: 0 } },
      { ...receipt, artifact: { ...receipt.artifact, page_count: 2 } },
      { ...receipt, download_ref: { ...receipt.download_ref, export_id: "export_other" } },
      { ...receipt, status: "processing" },
      { ...receipt, expires_at: receipt.created_at },
    ];
    for (const value of invalid) {
      expect(platformInformationExportArtifactReceiptSchema.safeParse(value).success).toBe(false);
    }
  });

  it("fails closed for a forged proof before reading artifact chunks", async () => {
    const { receipt } = buildCurrentArtifact();
    let reads = 0;
    const forged = { ...receipt, proof_sha: `sha256:${"f".repeat(64)}` };
    await expect(verifyPlatformInformationExportArtifact(JSON.stringify(forged), {
      hash_port: nodeHashPort,
      chunk_reader: { read: () => { reads += 1; return null; } },
    })).resolves.toEqual({
      ok: false,
      reason_code: "PLATFORM_INFORMATION_EXPORT_PROOF_HASH_MISMATCH",
    });
    expect(reads).toBe(0);
  });

  it("rejects a same-count same-view item replacement with all artifact hashes recomputed", async () => {
    const { receipt, manifest, itemLine, footer } = buildCurrentArtifact();
    const replacementItem = {
      ...itemLine.item,
      knowledge_id: "knowledge_replaced",
      display_title: "被替换的知识条目",
      sort_key: "2026-08-14T00:00:00Z:knowledge_replaced",
    };
    const replacementLine = {
      ...itemLine,
      item_sha: sha256(encoder.encode(canonicalJson(replacementItem))),
      item: replacementItem,
    };
    const replacementLineBytes = encoder.encode(`${canonicalJson(replacementLine)}\n`);
    const changedItemsSha = sha256(replacementLineBytes);
    const replacementFooter = { ...footer, items_sha: changedItemsSha };
    const bytes = encoder.encode([
      canonicalJson(manifest),
      canonicalJson(replacementLine),
      canonicalJson(replacementFooter),
      "",
    ].join("\n"));
    const changedContentSha = sha256(bytes);
    const forged = {
      ...receipt,
      artifact: {
        ...receipt.artifact,
        items_sha: changedItemsSha,
        content_sha: changedContentSha,
        byte_count: bytes.byteLength,
      },
      download_ref: { ...receipt.download_ref, content_sha: changedContentSha },
    };
    let reads = 0;
    await expect(verifyPlatformInformationExportArtifact(JSON.stringify(forged), {
      hash_port: nodeHashPort,
      chunk_reader: { read: () => { reads += 1; return bytes; } },
    })).resolves.toEqual({
      ok: false,
      reason_code: "PLATFORM_INFORMATION_EXPORT_RECEIPT_INVALID",
    });
    expect(reads).toBe(0);
  });

  it("rejects an oversized reader chunk before decoding it", async () => {
    const { receipt } = buildCurrentArtifact();
    const oversized = new Uint8Array(PLATFORM_INFORMATION_EXPORT_LIMITS.chunk_bytes + 1);
    await expect(verifyPlatformInformationExportArtifact(JSON.stringify(receipt), {
      hash_port: nodeHashPort,
      chunk_reader: chunkReader(oversized),
    })).resolves.toEqual({
      ok: false,
      reason_code: "PLATFORM_INFORMATION_EXPORT_CHUNK_INVALID",
    });
  });

  it("reports hash-session update failures as hash port failures", async () => {
    const { bytes, receipt } = buildCurrentArtifact();
    await expect(verifyPlatformInformationExportArtifact(JSON.stringify(receipt), {
      hash_port: {
        ...nodeHashPort,
        create_sha256: () => ({
          update: () => { throw new Error("hash backend failed"); },
          digest: () => `sha256:${"0".repeat(64)}`,
        }),
      },
      chunk_reader: chunkReader(bytes),
    })).resolves.toEqual({
      ok: false,
      reason_code: "PLATFORM_INFORMATION_EXPORT_HASH_PORT_FAILURE",
    });
  });

  it("processes thousands of short lines with fixed-size chunks and one-line buffering", async () => {
    const { bytes, receipt } = buildManyItemArtifact(2_500);
    await expect(verifyPlatformInformationExportArtifact(JSON.stringify(receipt), {
      hash_port: nodeHashPort,
      chunk_reader: chunkReader(bytes, [64 * 1024]),
    })).resolves.toMatchObject({ ok: true, value: { item_count: 2_500, byte_count: bytes.byteLength } });
  });

  it.each([
    ["BOM", (bytes: Uint8Array) => new Uint8Array([0xef, 0xbb, 0xbf, ...bytes]), "PLATFORM_INFORMATION_EXPORT_LINE_INVALID"],
    ["CRLF", (bytes: Uint8Array) => encoder.encode(new TextDecoder().decode(bytes).replaceAll("\n", "\r\n")), "PLATFORM_INFORMATION_EXPORT_LINE_INVALID"],
    ["missing final LF", (bytes: Uint8Array) => bytes.slice(0, -1), "PLATFORM_INFORMATION_EXPORT_TRUNCATED"],
  ])("rejects %s framing", async (_name, mutate, reasonCode) => {
    const { bytes, receipt } = buildCurrentArtifact();
    const mutated = mutate(bytes);
    const forgedReceipt = {
      ...receipt,
      artifact: { ...receipt.artifact, byte_count: mutated.byteLength, content_sha: sha256(mutated) },
      download_ref: { ...receipt.download_ref, content_sha: sha256(mutated) },
    };
    await expect(verifyPlatformInformationExportArtifact(JSON.stringify(forgedReceipt), {
      hash_port: nodeHashPort,
      chunk_reader: chunkReader(mutated),
    })).resolves.toEqual({ ok: false, reason_code: reasonCode });
  });

  it("rejects non-canonical JSON and item ordinal/hash/view drift", async () => {
    const { receipt, manifest, itemLine, footer } = buildCurrentArtifact();
    const cases = [
      { line: JSON.stringify(manifest), reason: "PLATFORM_INFORMATION_EXPORT_LINE_NOT_CANONICAL" },
      { line: canonicalJson({ ...itemLine, ordinal: 2 }), reason: "PLATFORM_INFORMATION_EXPORT_ITEM_ORDINAL_INVALID" },
      { line: canonicalJson({ ...itemLine, item_sha: `sha256:${"f".repeat(64)}` }), reason: "PLATFORM_INFORMATION_EXPORT_ITEM_HASH_MISMATCH" },
      { line: canonicalJson({ ...itemLine, item: { item_kind: "branch_snapshot", branch_name: "main", snapshot_version: "snap_1", commit_sha: "a".repeat(40), uploaded_at: "2026-08-14T00:00:00Z", file_count: 1, changed_file_count: 1, sort_key: "key" } }), reason: "PLATFORM_INFORMATION_EXPORT_ITEM_VIEW_MISMATCH" },
    ];
    for (const current of cases) {
      const bytes = encoder.encode([canonicalJson(manifest), current.line, canonicalJson(footer), ""].join("\n"));
      const forgedReceipt = {
        ...receipt,
        artifact: { ...receipt.artifact, byte_count: bytes.byteLength, content_sha: sha256(bytes) },
        download_ref: { ...receipt.download_ref, content_sha: sha256(bytes) },
      };
      await expect(verifyPlatformInformationExportArtifact(JSON.stringify(forgedReceipt), {
        hash_port: nodeHashPort,
        chunk_reader: chunkReader(bytes),
      })).resolves.toEqual({ ok: false, reason_code: current.reason });
    }
  });
});
