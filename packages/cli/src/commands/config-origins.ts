import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { sha256Bytes } from "@hunter-harness/core";

import type { CommandDependencies } from "./configure.js";

export interface ConfigShowOptions {
  origins?: boolean;
  json?: boolean;
}

export interface ConfigOriginRecord {
  name: string;
  canonicalPath: string;
  projectionPath: string;
  canonicalExists: boolean;
  projectionExists: boolean;
  canonicalSha256: string | null;
  projectionSha256: string | null;
  drift: boolean;
  source: "versioned-canonical" | "managed-projection" | "missing";
}

async function optionalBytes(path: string): Promise<Uint8Array | null> {
  try {
    return await readFile(path);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
}

export async function inspectConfigOrigins(projectRoot: string): Promise<ConfigOriginRecord[]> {
  const records: ConfigOriginRecord[] = [];
  for (const name of ["harness.json", "build-profile.json"]) {
    const canonicalPath = `docs/ai/harness/${name}`;
    const projectionPath = `.harness/config/${name}`;
    const canonical = await optionalBytes(join(projectRoot, canonicalPath));
    const projection = await optionalBytes(join(projectRoot, projectionPath));
    const canonicalSha256 = canonical === null ? null : sha256Bytes(canonical).slice(7);
    const projectionSha256 = projection === null ? null : sha256Bytes(projection).slice(7);
    records.push({
      name,
      canonicalPath,
      projectionPath,
      canonicalExists: canonical !== null,
      projectionExists: projection !== null,
      canonicalSha256,
      projectionSha256,
      drift: canonical !== null && projection !== null && canonicalSha256 !== projectionSha256,
      source: canonical !== null
        ? "versioned-canonical"
        : projection !== null
          ? "managed-projection"
          : "missing"
    });
  }
  return records;
}

export async function runConfigShow(
  _options: ConfigShowOptions,
  dependencies: CommandDependencies
): Promise<number> {
  const origins = await inspectConfigOrigins(dependencies.cwd);
  const status = origins.some((origin) => origin.drift) ? "WARN" : "OK";
  dependencies.stdout(JSON.stringify({
    schemaVersion: 1,
    status,
    reasonCode: status === "OK" ? "OK" : "CONFIG_PROJECTION_DRIFT",
    canonicalConfigPaths: origins
      .filter((origin) => origin.canonicalExists)
      .map((origin) => origin.canonicalPath),
    generatedProjectionPaths: origins
      .filter((origin) => origin.projectionExists)
      .map((origin) => origin.projectionPath),
    origins
  }) + "\n");
  return 0;
}
