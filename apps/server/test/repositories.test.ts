import { describe, expect, it, vi } from "vitest";

import { MemoryRepository } from "../src/repositories/memory.js";

describe("repositories", () => {
  it("MemoryRepository.withTransaction is a no-op shell: runs fn, returns result, warns (UT-006)", async () => {
    const repo = new MemoryRepository();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = await repo.withTransaction(async (tx) => {
      // no-op 壳传 this 作为 tx（memory 无真事务，串行执行）
      expect(tx).toBe(repo);
      return { value: 42 };
    });
    expect(result).toEqual({ value: 42 });
    expect(warnSpy).toHaveBeenCalled();
    expect(String(warnSpy.mock.calls[0]?.[0])).toMatch(/withTransaction no-op/i);
    warnSpy.mockRestore();
  });
});
