import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  aggregateInstalledContentHash,
  bundleFileManifestEntrySchema,
  bundleManifestSchema,
  computeBundleManifestHash,
  installedBundleStateSchema
} from "../src/bundle-manifest.js";

describe("bundle-manifest schema", () => {
  it("accepts a complete file entry", () => {
    const entry = bundleFileManifestEntrySchema.parse({
      relpath: "scripts/harness_events.py",
      sha256: "a".repeat(64),
      size: 12345,
      mode: 0o100755,
      adapterTransformationId: "adapted"
    });
    expect(entry.relpath).toBe("scripts/harness_events.py");
  });

  it("rejects entry with non-sha256 hash", () => {
    expect(() =>
      bundleFileManifestEntrySchema.parse({
        relpath: "scripts/x.py",
        sha256: "not-a-hash",
        size: 1,
        mode: 0o100644,
        adapterTransformationId: "raw"
      })
    ).toThrow();
  });

  it("rejects entry with absolute or escaping relpath", () => {
    for (const relpath of ["/etc/passwd", "../escape.py", "a/../../b.py"]) {
      expect(() =>
        bundleFileManifestEntrySchema.parse({
          relpath,
          sha256: "b".repeat(64),
          size: 1,
          mode: 0o100644,
          adapterTransformationId: "raw"
        })
      ).toThrow();
    }
  });

  it("accepts a full manifest and rejects unknown transformation id", () => {
    const manifest = bundleManifestSchema.parse({
      schemaVersion: 1,
      bundleVersion: "0.2.14",
      bundleManifestHash: "c".repeat(64),
      files: [
        {
          relpath: "scripts/a.py",
          sha256: "a".repeat(64),
          size: 10,
          mode: 0o100755,
          adapterTransformationId: "workflow-packaged"
        }
      ]
    });
    expect(manifest.files).toHaveLength(1);

    expect(() =>
      bundleManifestSchema.parse({
        schemaVersion: 1,
        bundleVersion: "0.2.14",
        bundleManifestHash: "c".repeat(64),
        files: [
          {
            relpath: "scripts/a.py",
            sha256: "a".repeat(64),
            size: 10,
            mode: 0o100755,
            adapterTransformationId: "unknown-kind"
          }
        ]
      })
    ).toThrow();
  });

  it("computes a deterministic manifest hash independent of file order", () => {
    const files = [
      {
        relpath: "scripts/b.py",
        sha256: "b".repeat(64),
        size: 2,
        mode: 0o100644,
        adapterTransformationId: "raw" as const
      },
      {
        relpath: "scripts/a.py",
        sha256: "a".repeat(64),
        size: 1,
        mode: 0o100755,
        adapterTransformationId: "adapted" as const
      }
    ];
    const hash1 = computeBundleManifestHash(files);
    const hash2 = computeBundleManifestHash([...files].reverse());
    expect(hash1).toBe(hash2);
    expect(hash1).toMatch(/^[0-9a-f]{64}$/);
  });

  it("computes installed content hash over actual installed files", () => {
    const installed = [
      { relpath: "scripts/b.py", sha256: "b".repeat(64) },
      { relpath: "scripts/a.py", sha256: "a".repeat(64) }
    ];
    const hash1 = aggregateInstalledContentHash(installed);
    const hash2 = aggregateInstalledContentHash([...installed].reverse());
    expect(hash1).toBe(hash2);
    expect(hash1).not.toBe(
      createHash("sha256").update("").digest("hex")
    );
  });

  it("accepts installed bundle state with verification status", () => {
    const state = installedBundleStateSchema.parse({
      schemaVersion: 1,
      bundleVersion: "0.2.14",
      bundleManifestHash: "c".repeat(64),
      installedContentHash: "d".repeat(64),
      verifiedAt: "2026-07-20T18:00:00+08:00",
      verificationStatus: "verified",
      mismatchDetails: [
        { relpath: "scripts/x.py", expected: "a".repeat(64), actual: "b".repeat(64) }
      ],
      localOverride: false
    });
    expect(state.verificationStatus).toBe("verified");
    expect(state.mismatchDetails).toHaveLength(1);
  });

  it("rejects installed state with invalid verification status", () => {
    expect(() =>
      installedBundleStateSchema.parse({
        schemaVersion: 1,
        bundleVersion: "0.2.14",
        bundleManifestHash: "c".repeat(64),
        installedContentHash: "d".repeat(64),
        verifiedAt: "2026-07-20T18:00:00+08:00",
        verificationStatus: "unknown"
      })
    ).toThrow();
  });
});
