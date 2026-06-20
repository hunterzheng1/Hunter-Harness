import { lstat } from "node:fs/promises";
import { isAbsolute, join, posix, resolve, win32 } from "node:path";

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;
const WINDOWS_ILLEGAL = /[<>:"|?*]/;
const MAX_MANAGED_PATH = 240;

export class UnsafePathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsafePathError";
  }
}

function hasIllegalWindowsCharacter(segment: string): boolean {
  return WINDOWS_ILLEGAL.test(segment) ||
    Array.from(segment).some((character) => character.charCodeAt(0) <= 31);
}

export function normalizeManagedPath(input: string): string {
  if (input.length === 0 || input.length > MAX_MANAGED_PATH) {
    throw new UnsafePathError("path is empty or exceeds the managed path limit");
  }
  if (input.includes("\\") || isAbsolute(input) || win32.isAbsolute(input)) {
    throw new UnsafePathError("absolute paths and backslashes are not allowed");
  }

  const rawSegments = input.split("/");
  if (rawSegments.some((segment) => segment === "..")) {
    throw new UnsafePathError("path traversal is not allowed");
  }

  const normalized = posix.normalize(input)
    .replace(/^\.\/+/, "")
    .replace(/\/+/g, "/");
  if (normalized === "." || normalized.startsWith("../")) {
    throw new UnsafePathError("path must resolve inside the project");
  }

  for (const segment of normalized.split("/")) {
    if (
      segment.length === 0 ||
      segment.endsWith(".") ||
      segment.endsWith(" ") ||
      WINDOWS_RESERVED.test(segment) ||
      hasIllegalWindowsCharacter(segment)
    ) {
      throw new UnsafePathError("path contains an illegal cross-platform segment");
    }
  }
  return normalized;
}

export function assertNoCaseCollisions(paths: readonly string[]): void {
  const seen = new Map<string, string>();
  for (const item of paths) {
    const normalized = normalizeManagedPath(item);
    const folded = normalized.toLocaleLowerCase("en-US");
    const existing = seen.get(folded);
    if (existing !== undefined && existing !== normalized) {
      throw new UnsafePathError(
        "case-insensitive path collision: " + existing + " and " + normalized
      );
    }
    seen.set(folded, normalized);
  }
}

function volumeRoot(path: string): string {
  const windowsRoot = win32.parse(path).root;
  if (windowsRoot !== "") {
    return windowsRoot.toLocaleLowerCase("en-US");
  }
  return resolve(path).slice(0, 1);
}

export function assertSameVolume(first: string, second: string): void {
  if (volumeRoot(first) !== volumeRoot(second)) {
    throw new UnsafePathError("atomic rename requires the same filesystem volume");
  }
}

export async function assertNoSymlinks(
  root: string,
  relativePath: string
): Promise<void> {
  const normalized = normalizeManagedPath(relativePath);
  let current = resolve(root);
  for (const segment of normalized.split("/")) {
    current = join(current, segment);
    try {
      const stat = await lstat(current);
      if (stat.isSymbolicLink()) {
        throw new UnsafePathError("symbolic links are not managed");
      }
    } catch (error) {
      if (
        error instanceof UnsafePathError ||
        !(error instanceof Error) ||
        !("code" in error) ||
        error.code !== "ENOENT"
      ) {
        throw error;
      }
      break;
    }
  }
}
