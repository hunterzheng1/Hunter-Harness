import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  assessCodebaseMapOnDisk,
  assessCodebaseMap,
  CODEBASE_MAP_DOCUMENTS,
  validateCodebaseMapArtifacts
} from "../src/index.js";

describe("codebase map support", () => {
  it("requires the seven generated-reviewable documents", () => {
    expect(CODEBASE_MAP_DOCUMENTS).toEqual([
      "STACK.md",
      "INTEGRATIONS.md",
      "ARCHITECTURE.md",
      "STRUCTURE.md",
      "CONVENTIONS.md",
      "TESTING.md",
      "CONCERNS.md"
    ]);
    expect(() => validateCodebaseMapArtifacts({ "STACK.md": "# Stack\n" })).toThrow(
      /missing.*INTEGRATIONS\.md/i
    );
  });

  it("accepts complete non-empty documents and labels every output", () => {
    const files = Object.fromEntries(
      CODEBASE_MAP_DOCUMENTS.map((name) => [name, "# " + name + "\nEvidence.\n"])
    );
    expect(validateCodebaseMapArtifacts(files)).toEqual(
      CODEBASE_MAP_DOCUMENTS.map((name) => ({
        path: ".harness/codebase/map/" + name,
        file_kind: "generated_reviewable"
      }))
    );
  });

  it("recommends but never automatically runs missing or stale mapping", () => {
    expect(assessCodebaseMap(null, new Date("2026-06-20T00:00:00Z"))).toEqual({
      status: "missing",
      recommend_refresh: true,
      auto_run: false,
      reason: "map manifest is missing"
    });
    expect(assessCodebaseMap({
      generated_at: "2026-06-01T00:00:00Z",
      source_revision: "abc",
      documents: [...CODEBASE_MAP_DOCUMENTS]
    }, new Date("2026-06-20T00:00:00Z"))).toMatchObject({
      status: "stale",
      recommend_refresh: true,
      auto_run: false
    });
  });

  it("SYNC-STATE-005 accepts the real object-array manifest and verifies document hashes", async () => {
    const root = await mkdtemp(join(tmpdir(), "hunter-map-assess-"));
    try {
      const mapRoot = join(root, ".harness", "codebase", "map");
      await mkdir(mapRoot, { recursive: true });
      const documents = [];
      for (const [index, name] of CODEBASE_MAP_DOCUMENTS.entries()) {
        const content = `# ${name}\nEvidence ${index}.\n`;
        await writeFile(join(mapRoot, name), content);
        documents.push({
          document_type: name.replace(/\.md$/i, "").toLowerCase(),
          path: `.harness/codebase/map/${name}`,
          sha256: "sha256:" + createHash("sha256").update(content).digest("hex"),
          line_count: 2,
          focus: "test",
          status: "generated"
        });
      }
      await writeFile(
        join(root, ".harness", "codebase", "map-manifest.json"),
        JSON.stringify({
          schema_version: 1,
          generator: "harness-codebase-map",
          generated_at: "2026-07-28T00:00:00.000Z",
          last_mapped_commit: "abc",
          documents,
          stale_policy: { max_age_days: 7, changed_files_threshold: 20 }
        })
      );

      const fresh = await assessCodebaseMapOnDisk(
        root,
        new Date("2026-07-29T00:00:00.000Z")
      );
      expect(fresh.status).toBe("fresh");

      await writeFile(join(mapRoot, "STACK.md"), "# drifted\n");
      const drifted = await assessCodebaseMapOnDisk(
        root,
        new Date("2026-07-29T00:00:00.000Z")
      );
      expect(drifted.status).toBe("stale");
      expect(drifted.reason).toContain("hash");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
