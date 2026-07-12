import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  knowledgeIngestEntrySchema,
  knowledgeIngestIndexSchema
} from "../src/knowledge.js";

const fixtureRoot = fileURLToPath(new URL("./fixtures/", import.meta.url));

describe("knowledge ingest contracts", () => {
  it("parses the shared ingest entry fixture", async () => {
    const raw = await readFile(join(fixtureRoot, "knowledge-ingest-entry.json"), "utf8");
    const parsed = knowledgeIngestEntrySchema.parse(JSON.parse(raw));
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.id).toBe("sample.dup.decision.aaaaaaaaaa");
    expect(parsed.type).toBe("decision");
  });

  it("parses the shared ingest index fixture", async () => {
    const raw = await readFile(join(fixtureRoot, "knowledge-ingest-index.json"), "utf8");
    const parsed = knowledgeIngestIndexSchema.parse(JSON.parse(raw));
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.entries).toHaveLength(1);
    expect(parsed.entries[0]?.type).toBe("decision");
  });
});
