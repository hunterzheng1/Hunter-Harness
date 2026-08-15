import { compareCodepoint } from "./stable.js";

export function plainOwnDataRecord(value: unknown): value is Record<string, unknown> {
  try {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value) as unknown;
    if (prototype !== Object.prototype && prototype !== null) return false;
    return Reflect.ownKeys(value).every((key) => {
      if (typeof key !== "string") return false;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return descriptor !== undefined && descriptor.enumerable && "value" in descriptor;
    });
  } catch {
    return false;
  }
}

export function ownDataValue(value: unknown, key: string): unknown {
  try {
    if (value === null || typeof value !== "object") return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor !== undefined && "value" in descriptor ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

export function exactOwnDataKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  try {
    const actual = Object.keys(value).sort(compareCodepoint);
    const canonicalExpected = [...expected].sort(compareCodepoint);
    return actual.length === canonicalExpected.length &&
      actual.every((key, index) => key === canonicalExpected[index]);
  } catch {
    return false;
  }
}

export function denseCanonicalStrings(value: unknown): readonly string[] | undefined {
  try {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return undefined;
    const expectedKeys = [...Array.from({ length: value.length }, (_, index) => String(index)), "length"];
    const actualKeys = Reflect.ownKeys(value);
    if (actualKeys.length !== expectedKeys.length ||
        actualKeys.some((key, index) => key !== expectedKeys[index])) return undefined;
    const strings: string[] = [];
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable ||
          typeof descriptor.value !== "string") return undefined;
      strings.push(descriptor.value);
    }
    if (new Set(strings).size !== strings.length || strings.some((item, index) =>
      index > 0 && compareCodepoint(strings[index - 1] ?? "", item) >= 0)) return undefined;
    return strings;
  } catch {
    return undefined;
  }
}

export function canonicalPackagePath(path: unknown): path is string {
  return typeof path === "string" && path !== "" && path.length <= 240 &&
    path === path.normalize("NFC") && !path.includes("\\") && !path.includes("\0") &&
    !path.startsWith("/") && !/^[A-Za-z]:/u.test(path) &&
    !path.split("/").some((segment) => segment === "" || segment === "." || segment === "..");
}

export function strictRfc3339(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-](\d{2}):(\d{2}))$/u
    .exec(value);
  if (match === null) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const offsetHour = match[7] === undefined ? 0 : Number(match[7]);
  const offsetMinute = match[8] === undefined ? 0 : Number(match[8]);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return month >= 1 && month <= 12 && day >= 1 && day <= (days[month - 1] ?? 0) &&
    hour <= 23 && minute <= 59 && second <= 59 && offsetHour <= 23 && offsetMinute <= 59;
}
