import { isPromise, isProxy } from "node:util/types";

export type TrustedAsyncResult<T> =
  | { readonly kind: "sync"; readonly value: T }
  | { readonly kind: "promise"; readonly promise: Promise<T> };

function synchronousPlainRoot(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value !== "object") {
    return typeof value !== "function" && typeof value !== "symbol";
  }
  try {
    const array = Array.isArray(value);
    const prototype = Object.getPrototypeOf(value) as unknown;
    if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) {
      return false;
    }
    return Reflect.ownKeys(value).every((key) => {
      if (typeof key !== "string") return false;
      if (array && key === "length") return true;
      if (key === "then") return false;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return descriptor !== undefined && descriptor.enumerable && "value" in descriptor &&
        typeof descriptor.value !== "function" && typeof descriptor.value !== "symbol";
    });
  } catch {
    return false;
  }
}

/**
 * Classifies an untrusted Port return without triggering Promise assimilation.
 * Callers await only the `promise` branch, then snapshot the resolved value at
 * their own Interface seam before interpreting it.
 */
export function discriminateTrustedAsyncResult<T>(value: T | Promise<T>): TrustedAsyncResult<T> | undefined {
  if (value !== null && (typeof value === "object" || typeof value === "function") && isProxy(value)) {
    return undefined;
  }
  if (isPromise(value)) {
    return Object.freeze({ kind: "promise", promise: value as Promise<T> });
  }
  return synchronousPlainRoot(value)
    ? Object.freeze({ kind: "sync", value: value as T })
    : undefined;
}
