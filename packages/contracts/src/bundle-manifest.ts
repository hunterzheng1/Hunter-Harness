import { createHash } from "node:crypto";
import { z } from "zod";

const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/, "must be a sha256 hex digest");

const relativePathSchema = z
  .string()
  .min(1)
  .refine((value) => !value.startsWith("/") && !/^[A-Za-z]:/.test(value), {
    message: "relpath must be relative"
  })
  .refine((value) => !value.split(/[\\/]/).includes(".."), {
    message: "relpath must not contain .. segments"
  });

export const adapterTransformationIdSchema = z.enum([
  "raw",
  "adapted",
  "workflow-packaged"
]);
export type AdapterTransformationId = z.infer<typeof adapterTransformationIdSchema>;

export const bundleFileManifestEntrySchema = z.object({
  relpath: relativePathSchema,
  sha256: sha256Schema,
  size: z.number().int().nonnegative(),
  mode: z.number().int().nonnegative(),
  adapterTransformationId: adapterTransformationIdSchema
});
export type BundleFileManifestEntry = z.infer<typeof bundleFileManifestEntrySchema>;

export const bundleManifestSchema = z.object({
  schemaVersion: z.literal(1),
  bundleVersion: z.string().min(1),
  bundleManifestHash: sha256Schema,
  files: z.array(bundleFileManifestEntrySchema)
});
export type BundleManifest = z.infer<typeof bundleManifestSchema>;

export const installedBundleStateSchema = z.object({
  schemaVersion: z.literal(1),
  bundleVersion: z.string().min(1),
  bundleManifestHash: sha256Schema,
  installedContentHash: sha256Schema,
  verifiedAt: z.string().min(1),
  verificationStatus: z.enum(["verified", "stale", "degraded"]),
  mismatchDetails: z
    .array(
      z.object({
        relpath: z.string().min(1),
        expected: sha256Schema,
        actual: sha256Schema
      })
    )
    .optional(),
  localOverride: z.boolean().optional()
});
export type InstalledBundleState = z.infer<typeof installedBundleStateSchema>;

function canonicalLine(parts: readonly string[]): string {
  return parts.join(":");
}

/**
 * Deterministic hash over a manifest's file entries.
 * Entries are sorted by relpath so the hash is independent of input order.
 */
function compareCodepoint(a: string, b: string): number {
  // Matches Python's default string ordering so TS/Python hashes agree.
  return a < b ? -1 : a > b ? 1 : 0;
}

export function computeBundleManifestHash(
  files: readonly BundleFileManifestEntry[]
): string {
  const lines = [...files]
    .sort((a, b) => compareCodepoint(a.relpath, b.relpath))
    .map((entry) =>
      canonicalLine([
        entry.relpath,
        entry.sha256,
        String(entry.size),
        String(entry.mode),
        entry.adapterTransformationId
      ])
    );
  return createHash("sha256").update(lines.join("\n"), "utf8").digest("hex");
}

/**
 * Deterministic aggregate hash over actually-installed file contents.
 */
export function aggregateInstalledContentHash(
  files: ReadonlyArray<{ relpath: string; sha256: string }>
): string {
  const lines = [...files]
    .sort((a, b) => a.relpath.localeCompare(b.relpath))
    .map((entry) => `${entry.relpath}:${entry.sha256}`);
  return createHash("sha256").update(lines.join("\n"), "utf8").digest("hex");
}
