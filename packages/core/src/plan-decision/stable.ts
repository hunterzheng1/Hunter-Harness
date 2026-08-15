import { createHash } from "node:crypto";
import { isProxy } from "node:util/types";

export const shaPattern = /^sha256:[a-f0-9]{64}$/u;

export function codepointCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => codepointCompare(left, right))
      .map(([key, child]) => [key, canonical(child)]));
  }
  return value;
}

export function stableHash(value: unknown): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex")}`;
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

export function denseArray(value: unknown): value is readonly unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype ||
      Object.keys(value).length !== value.length) return false;
  return value.every((_, index) => Object.hasOwn(value, index));
}

export function boundedText(value: unknown, maximum = 2_048): value is string {
  return typeof value === "string" && value.trim() === value && value.length > 0 && value.length <= maximum;
}

export function validTime(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|[+-](\d{2}):(\d{2}))$/u.exec(value);
  if (match === null) return false;
  const year = parseInt(match[1] ?? "", 10);
  const month = parseInt(match[2] ?? "", 10);
  const day = parseInt(match[3] ?? "", 10);
  const hour = parseInt(match[4] ?? "", 10);
  const minute = parseInt(match[5] ?? "", 10);
  const second = parseInt(match[6] ?? "", 10);
  const offsetHour = match[8] === undefined ? 0 : parseInt(match[8], 10);
  const offsetMinute = match[9] === undefined ? 0 : parseInt(match[9], 10);
  if (year < 1 || month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59 ||
      offsetHour > 23 || offsetMinute > 59) return false;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day >= 1 && day <= (days[month - 1] ?? 0);
}

export function strings(value: unknown, minimum: number, maximum: number, itemMaximum = 2_048): value is readonly string[] {
  return denseArray(value) && value.length >= minimum && value.length <= maximum &&
    value.every((item) => boundedText(item, itemMaximum)) && new Set(value).size === value.length;
}

export function sortedUnique(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort(codepointCompare);
}

export function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

const canonicalArrayIndex = /^(?:0|[1-9]\d*)$/u;

/**
 * Copies only ordinary own data properties. Descriptor inspection happens before
 * any value is read, so accessors and user-defined coercion hooks are never run.
 */
export function snapshotData(input: unknown): unknown {
  let visited = 0;
  function snapshot(value: unknown, depth: number): unknown {
    if (value === null || value === undefined || typeof value === "string" ||
        typeof value === "number" || typeof value === "boolean") return value;
    if (typeof value !== "object" || isProxy(value) || depth > 32 || ++visited > 50_000) throw new Error("unsafe input");
    const prototype = Object.getPrototypeOf(value);
    const array = Array.isArray(value);
    if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) {
      throw new Error("unsafe prototype");
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptors);
    if (keys.some((key) => typeof key === "symbol")) throw new Error("symbol property");
    for (const key of keys as string[]) {
      const descriptor = descriptors[key];
      if (descriptor === undefined || !("value" in descriptor) || descriptor.get !== undefined ||
          descriptor.set !== undefined || (key !== "length" && descriptor.enumerable !== true)) {
        throw new Error("accessor or hidden property");
      }
    }
    if (array) {
      const lengthDescriptor = descriptors.length;
      if (lengthDescriptor === undefined || typeof lengthDescriptor.value !== "number" ||
          !Number.isSafeInteger(lengthDescriptor.value) || lengthDescriptor.value < 0 ||
          keys.some((key) => typeof key === "string" && key !== "length" && !canonicalArrayIndex.test(key))) {
        throw new Error("invalid array descriptor");
      }
      const result: unknown[] = [];
      for (let index = 0; index < lengthDescriptor.value; index += 1) {
        const descriptor = descriptors[index.toFixed(0)];
        if (descriptor === undefined) throw new Error("sparse array");
        result.push(snapshot(descriptor.value, depth + 1));
      }
      return result;
    }
    const result: Record<string, unknown> = {};
    for (const key of keys as string[]) {
      const descriptor = descriptors[key];
      if (descriptor === undefined || !("value" in descriptor)) throw new Error("invalid property");
      result[key] = snapshot(descriptor.value, depth + 1);
    }
    return result;
  }
  return snapshot(input, 0);
}
