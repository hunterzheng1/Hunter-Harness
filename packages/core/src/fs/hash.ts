import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

export function sha256Bytes(content: Uint8Array | string): string {
  return "sha256:" + createHash("sha256").update(content).digest("hex");
}

export async function sha256File(path: string): Promise<string> {
  return sha256Bytes(await readFile(path));
}
