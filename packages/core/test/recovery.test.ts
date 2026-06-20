import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  recoverTransaction,
  runTransaction,
  stateLayout
} from "../src/index.js";

describe("transaction recovery", () => {
  it("recovers an interrupted update from its journal", async () => {
    const root = await mkdtemp(join(tmpdir(), "hunter-recover-"));
    await writeFile(join(root, "one.md"), "before");

    await expect(runTransaction(root, [
      { operation: "modify", path: "one.md", content: "after" },
      { operation: "add", path: "two.md", content: "new" }
    ], {
      id: "tx_interrupted",
      interruptAfterApply: 1
    })).rejects.toThrow(/interrupted/i);

    expect(await readFile(join(root, "one.md"), "utf8")).toBe("after");
    const recovery = await recoverTransaction(root, "tx_interrupted");
    expect(recovery.status).toBe("rolled_back");
    expect(await readFile(join(root, "one.md"), "utf8")).toBe("before");
    await expect(readFile(join(root, "two.md"))).rejects.toMatchObject({ code: "ENOENT" });

    const journal = JSON.parse(await readFile(
      join(stateLayout(root).transactions, "tx_interrupted", "journal.json"),
      "utf8"
    )) as { state: string };
    expect(journal.state).toBe("rolled_back");
  });

  it("does not roll back an already committed transaction", async () => {
    const root = await mkdtemp(join(tmpdir(), "hunter-committed-"));
    await runTransaction(root, [
      { operation: "add", path: "one.md", content: "committed" }
    ], { id: "tx_committed" });

    const recovery = await recoverTransaction(root, "tx_committed");
    expect(recovery.status).toBe("committed");
    expect(await readFile(join(root, "one.md"), "utf8")).toBe("committed");
  });
});
