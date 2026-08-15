import { runInNewContext } from "node:vm";

import { describe, expect, it, vi } from "vitest";

import { discriminateTrustedAsyncResult } from "../src/trusted-async-result/index.js";

describe("trusted async result discriminator", () => {
  it("accepts a synchronous plain-data root without Promise assimilation", () => {
    const value = { schema_version: 1, nested: { ok: true } };

    expect(discriminateTrustedAsyncResult(value)).toEqual({ kind: "sync", value });
  });

  it("accepts a real Promise and exposes it without reading a then property", async () => {
    const promise = Promise.resolve({ schema_version: 1 });
    const result = discriminateTrustedAsyncResult(promise);

    expect(result).toEqual({ kind: "promise", promise });
    if (result?.kind !== "promise") throw new Error("expected a trusted Promise");
    await expect(result.promise).resolves.toEqual({ schema_version: 1 });
  });

  it("rejects an ordinary then getter and callable then without invoking either", () => {
    const getter = vi.fn(() => vi.fn());
    const getterThenable = { schema_version: 1 } as Record<string, unknown>;
    Object.defineProperty(getterThenable, "then", { enumerable: true, get: getter });
    const callable = vi.fn();

    expect(discriminateTrustedAsyncResult(getterThenable)).toBeUndefined();
    expect(discriminateTrustedAsyncResult({ schema_version: 1, then: callable })).toBeUndefined();
    expect(getter).not.toHaveBeenCalled();
    expect(callable).not.toHaveBeenCalled();
  });

  it("rejects a Proxy before executing any reflection trap", () => {
    const traps = {
      get: vi.fn(() => { throw new Error("get trap"); }),
      getOwnPropertyDescriptor: vi.fn(() => { throw new Error("descriptor trap"); }),
      getPrototypeOf: vi.fn(() => { throw new Error("prototype trap"); }),
      ownKeys: vi.fn(() => { throw new Error("ownKeys trap"); })
    };
    const proxy = new Proxy({}, traps);

    expect(discriminateTrustedAsyncResult(proxy)).toBeUndefined();
    expect(traps.get).not.toHaveBeenCalled();
    expect(traps.getOwnPropertyDescriptor).not.toHaveBeenCalled();
    expect(traps.getPrototypeOf).not.toHaveBeenCalled();
    expect(traps.ownKeys).not.toHaveBeenCalled();
  });

  it("recognizes a genuine cross-realm Promise", async () => {
    const promise = runInNewContext("Promise.resolve({ schema_version: 1 })") as Promise<unknown>;
    const result = discriminateTrustedAsyncResult(promise);

    expect(result?.kind).toBe("promise");
    if (result?.kind !== "promise") throw new Error("expected a trusted cross-realm Promise");
    await expect(result.promise).resolves.toEqual({ schema_version: 1 });
  });
});
