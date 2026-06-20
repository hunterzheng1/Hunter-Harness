import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

export async function atomicWriteFile(
  target: string,
  content: string | Uint8Array
): Promise<void> {
  await mkdir(dirname(target), { recursive: true });
  const temporary = target + ".tmp-" + randomUUID();
  await writeFile(temporary, content, { flag: "wx" });
  try {
    await rename(temporary, target);
  } catch {
    await rm(target, { force: true });
    await rename(temporary, target);
  }
}

export async function atomicWriteJson(target: string, value: unknown): Promise<void> {
  await atomicWriteFile(target, JSON.stringify(value, null, 2) + "\n");
}
