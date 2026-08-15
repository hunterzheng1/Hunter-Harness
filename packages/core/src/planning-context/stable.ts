import { createHash } from "node:crypto";
import type { PlanningSha256 } from "./types.js";

export const shaPattern = /^sha256:(?!0{64}$)[a-f0-9]{64}$/u;
export const idPattern = /^[a-z0-9][a-z0-9._:-]{0,127}$/u;
export function compareCodepoint(left: string, right: string): number { return left < right ? -1 : left > right ? 1 : 0; }
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => compareCodepoint(left, right)).map(([key, child]) => [key, canonical(child)])
  );
  return value;
}
export function stableHash(value: unknown): PlanningSha256 {
  return `sha256:${createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex")}`;
}
export function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
export function plainDataRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) return false;
  return Reflect.ownKeys(value).every((key) => {
    if (typeof key !== "string") return false;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor !== undefined && descriptor.enumerable && "value" in descriptor;
  });
}
export function sortedUnique(values: readonly string[]): string[] { return [...new Set(values)].sort(compareCodepoint); }
export function validTime(value: string): boolean { return value === new Date(value).toISOString(); }
export function exact(value: object, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}
export function exactWithOptional(
  value: object,
  required: readonly string[],
  optional: readonly string[] = []
): boolean {
  const actual = Object.keys(value);
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.hasOwn(value, key)) && actual.every((key) => allowed.has(key));
}
export function boundedText(value: unknown, max = 512): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max && value === value.trim() && value === value.normalize("NFC");
}
