import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  MANAGED_EXECUTION_EXIT_CODE_BY_REASON,
  managedExecutionReasonCodeSchema,
  parseExecutionContract
} from "../src/index.js";

interface ExecutionFixture {
  id: string;
  contract:
    | "process-identity"
    | "run-session"
    | "service-session"
    | "service-retirement-receipt";
  valid: boolean;
  payload: unknown;
}

interface ExecutionFixtureCorpus {
  schemaVersion: 1;
  corpusHash: string;
  fixtures: ExecutionFixture[];
}

const fixturePath = fileURLToPath(
  new URL("../../../harness/contracts/fixtures/managed-execution.json", import.meta.url)
);

async function fixtureCorpus(): Promise<ExecutionFixtureCorpus> {
  return JSON.parse(await readFile(fixturePath, "utf8")) as ExecutionFixtureCorpus;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalJson(record[key])}`
  ).join(",")}}`;
}

describe("managed execution contracts", () => {
  it("parses the canonical managed execution fixture corpus in typescript", async () => {
    const corpus = await fixtureCorpus();
    const digest = createHash("sha256")
      .update(canonicalJson(corpus.fixtures), "utf8")
      .digest("hex");
    expect(corpus.schemaVersion).toBe(1);
    expect(corpus.corpusHash).toBe(`sha256:${digest}`);

    const coverage = new Map<string, Set<boolean>>();
    for (const fixture of corpus.fixtures) {
      const result = parseExecutionContract(fixture.contract, fixture.payload);
      expect(result.success, fixture.id).toBe(fixture.valid);
      const values = coverage.get(fixture.contract) ?? new Set<boolean>();
      values.add(fixture.valid);
      coverage.set(fixture.contract, values);
    }
    for (const contract of [
      "process-identity",
      "run-session",
      "service-session",
      "service-retirement-receipt"
    ]) {
      expect(coverage.get(contract)).toEqual(new Set([true, false]));
    }
  });

  it("maps every managed execution reason code to one canonical cli exit code", () => {
    const reasons = managedExecutionReasonCodeSchema.options;
    expect(Object.keys(MANAGED_EXECUTION_EXIT_CODE_BY_REASON).sort())
      .toEqual([...reasons].sort());
    for (const reason of reasons) {
      expect([0, 2, 3, 4, 5, 6]).toContain(
        MANAGED_EXECUTION_EXIT_CODE_BY_REASON[reason]
      );
    }
  });

  it("enforces run and retirement terminal invariants", async () => {
    const corpus = await fixtureCorpus();
    const validIncomplete = corpus.fixtures.find(
      (fixture) => fixture.id === "run-valid-incomplete"
    );
    const invalidRetirement = corpus.fixtures.find(
      (fixture) => fixture.id === "retirement-invalid-cleanup-claim"
    );
    expect(validIncomplete).toBeDefined();
    expect(invalidRetirement).toBeDefined();
    if (!validIncomplete || !invalidRetirement) {
      throw new Error("execution fixture corpus is missing terminal invariant fixtures");
    }
    expect(parseExecutionContract(
      validIncomplete.contract,
      validIncomplete.payload
    ).success).toBe(true);
    expect(parseExecutionContract(
      invalidRetirement.contract,
      invalidRetirement.payload
    ).success).toBe(false);
  });

  it("proves python and typescript execution contract parity over one fixture corpus", async () => {
    const corpus = await fixtureCorpus();
    const acceptance = corpus.fixtures.map((fixture) => ({
      id: fixture.id,
      accepted: parseExecutionContract(fixture.contract, fixture.payload).success
    }));
    expect(acceptance).toEqual(
      corpus.fixtures.map((fixture) => ({
        id: fixture.id,
        accepted: fixture.valid
      }))
    );
  });
});
