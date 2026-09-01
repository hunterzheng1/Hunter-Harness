import { createHash } from "node:crypto";

import type { Sha256 } from "../archive-engine/types.js";

/**
 * 稳定序列化/哈希的唯一权威实现。
 *
 * 历史上 archive-engine / archive-package-builder / codebase/map-v2 /
 * instruction-governance / archive-outbox/local-authority 各自维护了一份语义
 * 微差的 stable.ts（过滤 undefined 与否、非有限数是否抛错、JSON 拼接方式不同），
 * 同一对象在不同子系统里会得到不同哈希——这是持久化哈希漂移的隐患。此处收敛：
 *
 * - `canonicalStableJson`：canonical JSON 模式（过滤 undefined 键、键按码点排序、
 *   JSON.stringify 输出），archive-engine / archive-package-builder / map-v2 用。
 * - `rawStableJson`：字符串拼接模式（**不过滤** undefined 值），
 *   instruction-governance 用（其历史输出即如此，直接改 canonical 会漂移既有哈希）。
 * - `strictLocalAuthorityHash`：raw 模式但遇 undefined / 非有限数抛错，
 *   archive-outbox/local-authority 用。
 *
 * 各子系统的 stable.ts 现在只是本模块的兼容转发层，行为与历史实现逐字节一致。
 */
export function compareCodepoint(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object" && !ArrayBuffer.isView(value)) {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => compareCodepoint(left, right))
      .map(([key, child]) => [key, canonicalize(child)]));
  }
  return value;
}

/** canonical JSON 模式：过滤 undefined 键、键按码点排序。 */
export function canonicalStableJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

/** canonical 模式的 sha256 稳定哈希。 */
export function canonicalStableHash(value: unknown): Sha256 {
  return `sha256:${createHash("sha256").update(canonicalStableJson(value)).digest("hex")}`;
}

/** raw 字符串拼接模式（保留 undefined 值、键按码点排序），与历史输出逐字节一致。 */
export function rawStableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => rawStableJson(item)).join(",")}]`;
  }
  const record = value as Readonly<Record<string, unknown>>;
  const keys = Object.keys(record).sort(compareCodepoint);
  return `{${keys.map((key) =>
    `${JSON.stringify(key)}:${rawStableJson(record[key])}`).join(",")}}`;
}

/** raw 模式的 sha256 稳定哈希。 */
export function rawStableHash(value: unknown): Sha256 {
  return `sha256:${createHash("sha256").update(rawStableJson(value)).digest("hex")}`;
}

/** local-authority 严格模式：undefined / 非有限数直接拒绝（历史行为即抛错）。 */
export function strictLocalAuthorityHash(value: unknown): Sha256 {
  return `sha256:${createHash("sha256").update(rawStrictCanonical(value)).digest("hex")}`;
}

function rawStrictCanonical(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(rawStrictCanonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value as Record<string, unknown>).sort().map((key) =>
      `${JSON.stringify(key)}:${rawStrictCanonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
  }
  throw new Error("LOCAL_ARCHIVE_AUTHORITY_INPUT_INVALID");
}

export function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}

export function sha256Bytes(bytes: Uint8Array): Sha256 {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

export function contentHash(value: string | Uint8Array): Sha256 {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

export function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength &&
    left.every((byte, index) => byte === right[index]);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
