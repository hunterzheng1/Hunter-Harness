import { createHash } from "node:crypto";

function canonical(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.keys(value as Record<string, unknown>).sort()
    .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
    .map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
  throw new Error("REMOTE_ARCHIVE_INPUT_INVALID");
}

export function remoteArchiveV2StableHash(value: unknown): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(canonical(value)).digest("hex")}`;
}
