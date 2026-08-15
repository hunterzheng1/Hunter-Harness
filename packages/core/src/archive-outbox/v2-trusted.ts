import { isPromise, isProxy } from "node:util/types";

import { ArchiveOutboxError } from "./errors.js";
import type {
  ArchiveOutboxV2Record,
  ArchiveOutboxV2TransitionInspection,
  ArchiveOutboxV2TransitionOperation,
  ArchiveOutboxV2TransitionResult
} from "./v2-types.js";

type MethodName = "clock" | "put" | "read" | "list" | "commitTransition" | "inspectTransition";
type VerifierMethod = "verify";
type TrustedMethod = (...args: readonly unknown[]) => unknown;

export interface TrustedArchiveOutboxV2Port {
  clock(): Date;
  put(record: ArchiveOutboxV2Record): Promise<unknown>;
  read(entry_id: ArchiveOutboxV2Record["entry_id"]): Promise<unknown>;
  list(cursor: string | undefined, limit: number): Promise<unknown>;
  commitTransition(operation: ArchiveOutboxV2TransitionOperation,
    next: ArchiveOutboxV2Record): Promise<ArchiveOutboxV2TransitionResult>;
  inspectTransition(operation_id: ArchiveOutboxV2TransitionOperation["operation_id"]): Promise<ArchiveOutboxV2TransitionInspection>;
}

export interface TrustedArchiveOutboxV2Verifier {
  verify(input: { readonly package_receipt: unknown; readonly local_zip_ref: unknown }): Promise<unknown>;
}

function invalid(): never {
  throw new ArchiveOutboxError("ARCHIVE_OUTBOX_INPUT_INVALID");
}

function targetObject(value: unknown): object {
  if (value === null || (typeof value !== "object" && typeof value !== "function") || isProxy(value)) return invalid();
  return value;
}

function dataMethod(targetValue: unknown, name: MethodName | VerifierMethod): TrustedMethod {
  const target = targetObject(targetValue);
  let current: object | null = target;
  while (current !== null) {
    if (isProxy(current)) return invalid();
    const descriptor = Object.getOwnPropertyDescriptor(current, name);
    if (descriptor !== undefined) {
      if (!("value" in descriptor) || typeof descriptor.value !== "function" || isProxy(descriptor.value)) return invalid();
      return descriptor.value as TrustedMethod;
    }
    current = Object.getPrototypeOf(current) as object | null;
  }
  return invalid();
}

function hasThenableDescriptor(value: unknown): boolean {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) return false;
  if (isProxy(value) || isPromise(value)) return true;
  let current = value as object | null;
  while (current !== null) {
    if (isProxy(current)) return true;
    const descriptor = Object.getOwnPropertyDescriptor(current, "then");
    if (descriptor !== undefined) {
      return !("value" in descriptor) || typeof descriptor.value === "function";
    }
    current = Object.getPrototypeOf(current) as object | null;
  }
  return false;
}

function invokeSync(target: unknown, method: TrustedMethod): unknown {
  let result: unknown;
  try { result = Reflect.apply(method, target, []); } catch { throw new ArchiveOutboxError("ARCHIVE_OUTBOX_PORT_INVALID"); }
  if (hasThenableDescriptor(result)) throw new ArchiveOutboxError("ARCHIVE_OUTBOX_PORT_INVALID");
  return result;
}

async function invokeAsync(target: unknown, method: TrustedMethod, args: readonly unknown[]): Promise<unknown> {
  let result: unknown;
  try { result = Reflect.apply(method, target, args); } catch { throw new ArchiveOutboxError("ARCHIVE_OUTBOX_PORT_INVALID"); }
  // Only native promises cross this boundary. A generic thenable would execute
  // its `then` getter during await, so reject it before any assimilation.
  if (!isPromise(result) || hasThenableDescriptor(result) === false) {
    throw new ArchiveOutboxError("ARCHIVE_OUTBOX_PORT_INVALID");
  }
  return result;
}

export function trustedArchiveOutboxV2Port(value: unknown): TrustedArchiveOutboxV2Port {
  const target = targetObject(value);
  const methods = {
    clock: dataMethod(target, "clock"),
    put: dataMethod(target, "put"),
    read: dataMethod(target, "read"),
    list: dataMethod(target, "list"),
    commitTransition: dataMethod(target, "commitTransition"),
    inspectTransition: dataMethod(target, "inspectTransition")
  };
  return {
    clock: () => invokeSync(target, methods.clock) as Date,
    put: (record) => invokeAsync(target, methods.put, [record]),
    read: (entry_id) => invokeAsync(target, methods.read, [entry_id]),
    list: (cursor, limit) => invokeAsync(target, methods.list, [cursor, limit]),
    commitTransition: (operation, next) => invokeAsync(target, methods.commitTransition, [operation, next]) as Promise<ArchiveOutboxV2TransitionResult>,
    inspectTransition: (operation_id) => invokeAsync(target, methods.inspectTransition, [operation_id]) as Promise<ArchiveOutboxV2TransitionInspection>
  };
}

export function trustedArchiveOutboxV2Verifier(value: unknown): TrustedArchiveOutboxV2Verifier {
  const target = targetObject(value);
  const method = dataMethod(target, "verify");
  return {
    verify: (input) => invokeAsync(target, method, [input])
  };
}
