import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

// Windows 上杀毒/索引器会短暂持有刚写入的文件句柄，rename 偶发 EPERM/EBUSY。
// 这是瞬态而非真实冲突：删除目标后重试 rename，并在瞬态错误码上短退避多试几次。
// 真实错误（EINVAL 等）仍立即抛出，行为不变。
const ATOMIC_RENAME_RETRY_DELAYS_MS = [50, 150, 400] as const;
const TRANSIENT_RENAME_CODES = new Set(["EPERM", "EBUSY", "EACCES", "ENOENT"]);

export async function atomicWriteFile(
  target: string,
  content: string | Uint8Array
): Promise<void> {
  await mkdir(dirname(target), { recursive: true });
  const temporary = target + ".tmp-" + randomUUID();
  await writeFile(temporary, content, { flag: "wx" });
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(temporary, target);
      return;
    } catch {
      await rm(target, { force: true }).catch(() => undefined);
      try {
        await rename(temporary, target);
        return;
      } catch (error) {
        const code = (error as { code?: unknown }).code;
        const transient = typeof code === "string" && TRANSIENT_RENAME_CODES.has(code);
        if (!transient || attempt >= ATOMIC_RENAME_RETRY_DELAYS_MS.length) {
          throw error;
        }
        await new Promise((resolveDelay) =>
          setTimeout(resolveDelay, ATOMIC_RENAME_RETRY_DELAYS_MS[attempt]));
      }
    }
  }
}

export async function atomicWriteJson(target: string, value: unknown): Promise<void> {
  await atomicWriteFile(target, JSON.stringify(value, null, 2) + "\n");
}
