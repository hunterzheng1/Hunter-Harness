import { deepFreeze, stableHash } from "../archive-package-builder/index.js";

export { deepFreeze, stableHash };

export function compareCodepoint(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function clone<T>(value: T): T {
  return structuredClone(value);
}
