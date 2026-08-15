import { deepFreeze, stableHash } from "../instruction-governance/stable.js";
import { InstructionProposalError, type InstructionProposalErrorCode } from "./errors.js";

export const SHA256 = /^sha256:[a-f0-9]{64}$/u;
export const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u;
const RFC3339_PARTS = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-](\d{2}):(\d{2}))$/u;

function validCalendarTimestamp(value: string): boolean {
  const match = RFC3339_PARTS.exec(value);
  if (match === null) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  if (month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59) return false;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (day < 1 || day > (days[month - 1] ?? 0)) return false;
  if (match[7] !== "Z" && (Number(match[8]) > 23 || Number(match[9]) > 59)) return false;
  return true;
}

export function fail(code: InstructionProposalErrorCode, detail: string): never {
  throw new InstructionProposalError(code, detail);
}

export function boundedString(
  value: unknown,
  label: string,
  code: InstructionProposalErrorCode,
  max = 16_384
): string {
  if (typeof value !== "string" || value.trim() !== value || value.length === 0 ||
      value.length > max || Array.from(value).some((character) => character.charCodeAt(0) === 0)) {
    fail(code, `${label} must be a bounded non-empty string`);
  }
  return value;
}

export function sha256(value: unknown, label: string, code: InstructionProposalErrorCode): string {
  const result = boundedString(value, label, code, 71);
  if (!SHA256.test(result)) fail(code, `${label} must be a sha256 identity`);
  return result;
}

export function timestamp(
  value: unknown,
  label: string,
  code: InstructionProposalErrorCode
): string {
  const result = boundedString(value, label, code, 64);
  if (!RFC3339.test(result) || !validCalendarTimestamp(result) || Number.isNaN(Date.parse(result))) {
    fail(code, `${label} must be RFC3339`);
  }
  return result;
}

export function uniqueStrings(
  value: unknown,
  label: string,
  code: InstructionProposalErrorCode,
  max = 128
): readonly string[] {
  if (!Array.isArray(value) || value.length > max) fail(code, `${label} must be bounded`);
  const items = value.map((item, index) => boundedString(item, `${label}[${index}]`, code, 1_024));
  if (new Set(items).size !== items.length) fail(code, `${label} contains duplicates`);
  return items;
}

export function hashAndFreeze<T>(value: T): Readonly<T> {
  return deepFreeze(value);
}

export { stableHash };
