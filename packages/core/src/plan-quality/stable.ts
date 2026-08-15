import { createHash } from "node:crypto";
import { isProxy } from "node:util/types";

export const cp = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([, child]) => child !== undefined).sort(([a], [b]) => cp(a, b)).map(([key, child]) => [key, canonical(child)]));
  return value;
}
export const hash = (value: unknown): `sha256:${string}` =>
  `sha256:${createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex")}`;
export function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value); for (const child of Object.values(value as Record<string, unknown>)) freeze(child);
  } return value;
}
export function snapshot(input: unknown): unknown {
  let count = 0;
  function visit(value: unknown, depth: number): unknown {
    if (value === null || value === undefined || typeof value === "string" || typeof value === "boolean" ||
      typeof value === "number") return value;
    if (typeof value !== "object" || isProxy(value) || depth > 32 || ++count > 100_000) throw new Error("unsafe");
    const array = Array.isArray(value); const proto = Object.getPrototypeOf(value);
    if (array ? proto !== Array.prototype : proto !== Object.prototype && proto !== null) throw new Error("proto");
    const descriptors = Object.getOwnPropertyDescriptors(value); const keys = Reflect.ownKeys(descriptors);
    if (keys.some((key) => typeof key === "symbol")) throw new Error("symbol");
    for (const key of keys as string[]) { const descriptor = descriptors[key];
      if (descriptor === undefined || !("value" in descriptor) || (key !== "length" && !descriptor.enumerable)) throw new Error("descriptor"); }
    if (array) { const length = descriptors.length?.value as unknown;
      if (!Number.isSafeInteger(length) || (length as number) < 0) throw new Error("array");
      const result: unknown[] = []; for (let i = 0; i < (length as number); i += 1) {
        const descriptor = descriptors[String(i)]; if (descriptor === undefined || !("value" in descriptor)) throw new Error("sparse");
        result.push(visit(descriptor.value, depth + 1));
      } if (keys.some((key) => typeof key === "string" && key !== "length" && !/^(?:0|[1-9]\d*)$/u.test(key))) throw new Error("extra");
      return result;
    }
    const result: Record<string, unknown> = {}; for (const key of keys as string[]) {
      const descriptor = descriptors[key]; if (descriptor === undefined || !("value" in descriptor)) throw new Error("descriptor");
      result[key] = visit(descriptor.value, depth + 1);
    } return result;
  } return visit(input, 0);
}
export const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" &&
  !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
export const exact = (value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean =>
  required.every((key) => Object.hasOwn(value, key)) && Object.keys(value).every((key) => required.includes(key) || optional.includes(key));
export const text = (value: unknown, max = 2_048): value is string => typeof value === "string" && value.trim() === value &&
  value.length > 0 && value.length <= max;
export const strings = (value: unknown, min = 0, max = 128): value is readonly string[] => Array.isArray(value) &&
  value.length >= min && value.length <= max && value.every((item) => text(item)) && new Set(value).size === value.length;
export const path = (value: string): boolean => value.length <= 512 && !value.includes("\\") && !value.startsWith("/") &&
  !/^[A-Za-z]:/u.test(value) && value.split("/").every((part) => part !== "" && part !== "." && part !== "..");
export function time(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/u.exec(value);
  if (match === null) return false;
  const year = Number(match[1]); const month = Number(match[2]); const day = Number(match[3]);
  const hour = Number(match[4]); const minute = Number(match[5]); const second = Number(match[6]);
  if (month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59) return false;
  const maxDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (day < 1 || day > maxDay) return false;
  const zone = match[8] as string;
  if (zone !== "Z") { const zoneHour = Number(zone.slice(1, 3)); const zoneMinute = Number(zone.slice(4, 6));
    if (zoneHour > 23 || zoneMinute > 59) return false; }
  return true;
}
