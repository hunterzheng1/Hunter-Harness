export const CODEBASE_MAP_DOCUMENTS = [
  "STACK.md",
  "INTEGRATIONS.md",
  "ARCHITECTURE.md",
  "STRUCTURE.md",
  "CONVENTIONS.md",
  "TESTING.md",
  "CONCERNS.md"
] as const;

export interface CodebaseMapManifest {
  generated_at: string;
  source_revision: string | null;
  documents: string[];
}

export interface CodebaseMapManifestDocument {
  path: string;
  sha256: string;
  status?: string;
}

export interface CodebaseMapDiskManifest {
  generated_at: string;
  source_revision?: string | null;
  last_mapped_commit?: string | null;
  documents: Array<string | CodebaseMapManifestDocument>;
  stale_policy?: {
    max_age_days?: number;
    changed_files_threshold?: number;
  };
}

export interface CodebaseMapAssessment {
  status: "missing" | "stale" | "fresh";
  recommend_refresh: boolean;
  auto_run: false;
  reason: string;
}

export function validateCodebaseMapArtifacts(
  files: Readonly<Record<string, string>>
): Array<{ path: string; file_kind: "generated_reviewable" }> {
  for (const name of CODEBASE_MAP_DOCUMENTS) {
    const content = files[name];
    if (content === undefined) {
      throw new Error("missing codebase map document: " + name);
    }
    if (content.trim() === "") {
      throw new Error("empty codebase map document: " + name);
    }
  }
  return CODEBASE_MAP_DOCUMENTS.map((name) => ({
    path: ".harness/codebase/map/" + name,
    file_kind: "generated_reviewable" as const
  }));
}

export function assessCodebaseMap(
  manifest: CodebaseMapManifest | null,
  now = new Date(),
  maxAgeDays = 7
): CodebaseMapAssessment {
  if (manifest === null) {
    return {
      status: "missing",
      recommend_refresh: true,
      auto_run: false,
      reason: "map manifest is missing"
    };
  }
  const missing = CODEBASE_MAP_DOCUMENTS.find(
    (name) => !manifest.documents.includes(name)
  );
  if (missing !== undefined) {
    return {
      status: "stale",
      recommend_refresh: true,
      auto_run: false,
      reason: "map manifest is incomplete: " + missing
    };
  }
  const generatedAt = Date.parse(manifest.generated_at);
  if (!Number.isFinite(generatedAt)) {
    return {
      status: "stale",
      recommend_refresh: true,
      auto_run: false,
      reason: "map generated_at is invalid"
    };
  }
  const stale = now.getTime() - generatedAt > maxAgeDays * 24 * 60 * 60 * 1000;
  return stale
    ? {
      status: "stale",
      recommend_refresh: true,
      auto_run: false,
      reason: "map is older than " + maxAgeDays + " days"
    }
    : {
      status: "fresh",
      recommend_refresh: false,
      auto_run: false,
      reason: "map is current"
    };
}

async function readOptionalFile(path: string): Promise<Uint8Array | null> {
  try {
    return await readFile(path);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

function stale(reason: string): CodebaseMapAssessment {
  return {
    status: "stale",
    recommend_refresh: true,
    auto_run: false,
    reason
  };
}

/**
 * Assess the actual codebase-map artifacts rather than preserving a display
 * status from context-index. Supports both the historical string list and the
 * current object-array manifest emitted by harness-codebase-map.
 */
export async function assessCodebaseMapOnDisk(
  projectRoot: string,
  now = new Date(),
  defaultMaxAgeDays = 7
): Promise<CodebaseMapAssessment> {
  const root = resolve(projectRoot);
  const mapRoot = join(root, ".harness", "codebase", "map");
  const manifestCandidates = [
    join(root, ".harness", "codebase", "map-manifest.json"),
    join(mapRoot, "manifest.json")
  ];
  const documentPresence = await Promise.all(
    CODEBASE_MAP_DOCUMENTS.map((name) => readOptionalFile(join(mapRoot, name)))
  );
  let manifestBytes: Uint8Array | null = null;
  for (const candidate of manifestCandidates) {
    manifestBytes = await readOptionalFile(candidate);
    if (manifestBytes !== null) break;
  }
  const existingDocuments = documentPresence.filter((bytes) => bytes !== null).length;
  if (manifestBytes === null && existingDocuments === 0) {
    return {
      status: "missing",
      recommend_refresh: true,
      auto_run: false,
      reason: "map directory and manifest are missing"
    };
  }
  if (manifestBytes === null) {
    return stale("map manifest is missing while map documents exist");
  }

  let manifest: CodebaseMapDiskManifest;
  try {
    manifest = JSON.parse(new TextDecoder().decode(manifestBytes)) as CodebaseMapDiskManifest;
  } catch {
    return stale("map manifest is unreadable");
  }
  if (!Array.isArray(manifest.documents)) {
    return stale("map manifest documents are invalid");
  }
  const byName = new Map<string, string | CodebaseMapManifestDocument>();
  for (const document of manifest.documents) {
    if (typeof document === "string") {
      byName.set(basename(document), document);
    } else if (
      document !== null &&
      typeof document === "object" &&
      typeof document.path === "string"
    ) {
      byName.set(basename(document.path), document);
    } else {
      return stale("map manifest contains an invalid document record");
    }
  }
  for (const [index, name] of CODEBASE_MAP_DOCUMENTS.entries()) {
    const bytes = documentPresence[index];
    if (bytes === null || bytes === undefined) {
      return stale("map document is missing: " + name);
    }
    if (bytes.byteLength === 0 || new TextDecoder().decode(bytes).trim() === "") {
      return stale("map document is empty: " + name);
    }
    const declared = byName.get(name);
    if (declared === undefined) {
      return stale("map manifest is incomplete: " + name);
    }
    if (typeof declared !== "string") {
      const expected = declared.sha256.replace(/^sha256:/, "");
      const actual = sha256Bytes(bytes).replace(/^sha256:/, "");
      if (!/^[a-f0-9]{64}$/i.test(expected) || expected.toLowerCase() !== actual) {
        return stale("map document hash mismatch: " + name);
      }
    }
  }
  const generatedAt = Date.parse(manifest.generated_at);
  if (!Number.isFinite(generatedAt)) {
    return stale("map generated_at is invalid");
  }
  const maxAgeDays = manifest.stale_policy?.max_age_days ?? defaultMaxAgeDays;
  if (now.getTime() - generatedAt > maxAgeDays * 24 * 60 * 60 * 1000) {
    return stale("map is older than " + maxAgeDays + " days");
  }
  try {
    const mapStat = await stat(mapRoot);
    if (!mapStat.isDirectory()) return stale("map path is not a directory");
  } catch {
    return stale("map directory is unavailable");
  }
  return {
    status: "fresh",
    recommend_refresh: false,
    auto_run: false,
    reason: "map documents and manifest hashes are current"
  };
}
import { readFile, stat } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

import { sha256Bytes } from "../fs/hash.js";
