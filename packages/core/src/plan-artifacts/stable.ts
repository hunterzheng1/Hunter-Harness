import { createHash } from "node:crypto";
import { isProxy } from "node:util/types";

export function compareCodepoint(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => compareCodepoint(left, right))
      .map(([key, child]) => [key, canonical(child)])
  );
  return value;
}

export function stableHash(value: unknown): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex")}`;
}

export function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

const arrayIndex = /^(?:0|[1-9]\d*)$/u;
export function snapshotData(input: unknown): unknown {
  let count = 0;
  function visit(value: unknown, depth: number): unknown {
    if (value === null || value === undefined || typeof value === "string" || typeof value === "number" ||
        typeof value === "boolean") return value;
    if (typeof value !== "object" || isProxy(value) || depth > 32 || ++count > 100_000) throw new Error("unsafe input");
    const array = Array.isArray(value);
    const prototype = Object.getPrototypeOf(value);
    if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) throw new Error("prototype");
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptors);
    if (keys.some((key) => typeof key === "symbol")) throw new Error("symbol");
    for (const key of keys as string[]) {
      const descriptor = descriptors[key];
      if (descriptor === undefined || !("value" in descriptor) || descriptor.get !== undefined || descriptor.set !== undefined ||
          (key !== "length" && descriptor.enumerable !== true)) throw new Error("descriptor");
    }
    if (array) {
      const length = descriptors.length?.value as unknown;
      if (typeof length !== "number" || !Number.isSafeInteger(length) || length < 0 ||
          keys.some((key) => typeof key === "string" && key !== "length" && !arrayIndex.test(key))) throw new Error("array");
      const result: unknown[] = [];
      for (let index = 0; index < length; index += 1) {
        const descriptor = descriptors[index.toFixed(0)];
        if (descriptor === undefined || !("value" in descriptor)) throw new Error("sparse");
        result.push(visit(descriptor.value, depth + 1));
      }
      return result;
    }
    const result: Record<string, unknown> = {};
    for (const key of keys as string[]) {
      const descriptor = descriptors[key];
      if (descriptor === undefined || !("value" in descriptor)) throw new Error("property");
      result[key] = visit(descriptor.value, depth + 1);
    }
    return result;
  }
  return visit(input, 0);
}

export function plainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function exact(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  const keys = Object.keys(value);
  return required.every((key) => Object.hasOwn(value, key)) &&
    keys.every((key) => required.includes(key) || optional.includes(key));
}

export function bounded(value: unknown, maximum = 4_096): value is string {
  return typeof value === "string" && value.trim() === value && value.length > 0 && value.length <= maximum;
}

export function stringArray(value: unknown, minimum: number, maximum: number, itemMax = 1_024): value is readonly string[] {
  return Array.isArray(value) && Object.getPrototypeOf(value) === Array.prototype && value.length >= minimum &&
    value.length <= maximum && value.every((item) => bounded(item, itemMax)) && new Set(value).size === value.length;
}

export function sortedUnique(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort(compareCodepoint);
}

export function canonicalPath(value: string): boolean {
  return value.length <= 512 && value === value.normalize("NFC") && !value.includes("\\") &&
    !value.startsWith("/") && !/^[A-Za-z]:/u.test(value) && value.split("/").every((part) =>
      part.length > 0 && part !== "." && part !== "..");
}
