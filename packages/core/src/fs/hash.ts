import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

export function sha256Bytes(content: Uint8Array | string): string {
  return "sha256:" + createHash("sha256").update(content).digest("hex");
}

export async function sha256File(path: string): Promise<string> {
  return sha256Bytes(await readFile(path));
}

export function aggregateInstalledContentHash(
  files: ReadonlyArray<{ relpath: string; sha256: string }>
): string {
  const lines = [...files]
    .sort((a, b) => a.relpath.localeCompare(b.relpath))
    .map((entry) => `${entry.relpath}:${entry.sha256}`);
  return createHash("sha256").update(lines.join("\n"), "utf8").digest("hex");
}
