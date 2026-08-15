import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  inspectInstructions,
  planAgentProjection,
  readRulesManifest,
  rulesManifestSchema,
  type AgentProjectionRequest,
  type CanonicalRulesRef,
  type InstructionInspectionInput,
  type RulesManifest
} from "../src/instruction-governance/index.js";
import { sha256Bytes } from "../src/fs/hash.js";

const fixtureUrl = (name: string): URL =>
  new URL(`./fixtures/${name}`, import.meta.url);

async function fixture(name: string): Promise<unknown> {
  return JSON.parse(await readFile(fileURLToPath(fixtureUrl(name)), "utf8")) as unknown;
}

describe("07A RulesManifest compatibility Interface", () => {
  it("strictly reads the current manifest and returns an alias-safe frozen value", async () => {
    const input = await fixture("instruction-governance-v1-current.json") as {
      files: Array<{ module_refs: string[] }>;
    };

    const result = readRulesManifest(input);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.reason_code);
    expect(result.source_schema_version).toBe(1);
    expect(result.degradation_reasons).toEqual([]);
    expect(result.manifest.project_identity).toBe("project:hunter-harness");
    expect(result.manifest.files.map((file) => file.path)).toEqual([
      ".harness/rules/core.md",
      ".harness/rules/testing.md"
    ]);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.manifest.files[0]?.module_refs)).toBe(true);

    input.files[0]?.module_refs.push("module:mutated");
    expect(result.manifest.files[0]?.module_refs).toEqual(["module:core"]);
  });

  it("rejects unknown current fields and sensitive or non-canonical rule paths", async () => {
    const current = await fixture("instruction-governance-v1-current.json") as Record<string, unknown>;
    expect(rulesManifestSchema.safeParse({ ...current, invented_field: true })).toMatchObject({
      success: false,
      error: { code: "RULES_MANIFEST_UNKNOWN_FIELD" }
    });

    const files = current.files as Array<Record<string, unknown>>;
    expect(rulesManifestSchema.safeParse({
      ...current,
      files: [{ ...files[0], invented_file_field: true }]
    })).toMatchObject({
      success: false,
      error: { code: "RULES_MANIFEST_UNKNOWN_FIELD" }
    });
    const invalid = {
      ...current,
      files: [{ ...files[0], path: ".harness/rules/credentials.local.md" }]
    };
    expect(readRulesManifest(invalid)).toEqual({
      ok: false,
      reason_code: "RULES_MANIFEST_INVALID"
    });
  });

  it("accepts project-relative globs and rejects unsafe glob syntax", async () => {
    const current = await fixture("instruction-governance-v1-current.json") as Record<string, unknown>;
    const files = current.files as Array<Record<string, unknown>>;
    const withGlobs = (globs: readonly string[]): Record<string, unknown> => ({
      ...current,
      files: files.map((file) => file.topic === "testing" ? { ...file, globs } : file)
    });

    expect(rulesManifestSchema.safeParse(withGlobs([
      "src/**",
      "packages/*/src/**"
    ])).success).toBe(true);
    for (const globs of [
      ["/src/**"],
      ["C:/src/**"],
      ["src\\**"],
      ["src//**"],
      ["./src/**"],
      ["src/../secrets/**"]
    ]) {
      expect(rulesManifestSchema.safeParse(withGlobs(globs))).toMatchObject({
        success: false,
        error: { code: "RULES_MANIFEST_INVALID" }
      });
    }
  });

  it("projects only provable legacy fields and records every unavailable identity", async () => {
    const result = readRulesManifest(
      await fixture("instruction-governance-v0-legacy.json")
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.reason_code);
    expect(result.source_schema_version).toBe(0);
    expect(result.manifest).toEqual({
      schema_version: 1,
      ruleset_version: "legacy-2026-08",
      canonical_root: ".harness/rules",
      files: [{
        path: ".harness/rules/project-guidance.md",
        content_hash: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        target_agents: ["claude_code", "codex"]
      }]
    });
    expect(result.degradation_reasons).toEqual([
      "RULES_MANIFEST_LEGACY_FILE_METADATA_UNAVAILABLE",
      "RULES_MANIFEST_LEGACY_GENERATOR_UNAVAILABLE",
      "RULES_MANIFEST_LEGACY_PROJECT_IDENTITY_UNAVAILABLE"
    ]);
    expect("project_identity" in result.manifest).toBe(false);
    expect("generator" in result.manifest).toBe(false);
    expect("topic" in (result.manifest.files[0] ?? {})).toBe(false);
  });

  it("returns fixed failures for malformed and unsupported versions", () => {
    expect(readRulesManifest({ schema_version: 9 })).toEqual({
      ok: false,
      reason_code: "RULES_MANIFEST_VERSION_UNSUPPORTED"
    });
    expect(readRulesManifest({ schema_version: 1, files: [] })).toEqual({
      ok: false,
      reason_code: "RULES_MANIFEST_INVALID"
    });
    expect(readRulesManifest(Object.create({ schema_version: 1 }))).toEqual({
      ok: false,
      reason_code: "RULES_MANIFEST_INVALID"
    });
  });
});

const h = (character: string): `sha256:${string}` =>
  `sha256:${character.repeat(64)}`;

async function currentManifest(): Promise<RulesManifest> {
  return rulesManifestSchema.parse(
    await fixture("instruction-governance-v1-current.json")
  );
}

async function inspectionInput(): Promise<InstructionInspectionInput> {
  const manifest = await currentManifest();
  return {
    schema_version: 1,
    project_identity: manifest.project_identity,
    enabled_agents: ["codex", "claude_code", "cursor", "codebuddy"],
    manifest,
    canonical_files: manifest.files.map((file) => ({
      path: file.path,
      content_hash: file.content_hash,
      references: []
    })),
    entrypoints: [
      { agent: "codex", path: "AGENTS.md", content_hash: h("1"), references: [".harness/rules/core.md"] },
      { agent: "claude_code", path: "CLAUDE.md", content_hash: h("2"), references: ["AGENTS.md"] },
      { agent: "cursor", path: "AGENTS.md", content_hash: h("1"), references: [".harness/rules/core.md"] },
      { agent: "codebuddy", path: "CODEBUDDY.md", content_hash: h("3"), references: ["AGENTS.md"] }
    ],
    projection_files: [
      {
        agent: "claude_code",
        path: ".claude/rules/testing.md",
        content_hash: h("4"),
        expected_content_hash: h("4"),
        canonical_refs: [".harness/rules/testing.md"]
      },
      {
        agent: "cursor",
        path: ".cursor/rules/testing.mdc",
        content_hash: h("5"),
        expected_content_hash: h("5"),
        canonical_refs: [".harness/rules/testing.md"]
      },
      {
        agent: "codebuddy",
        path: ".codebuddy/rules/testing.md",
        content_hash: h("6"),
        expected_content_hash: h("6"),
        canonical_refs: [".harness/rules/testing.md"]
      }
    ],
    map_evidence_refs: ["map:manifest:42"],
    archive_evidence_cursor: "archive:cursor:42",
    configuration_hashes: { package_manifest: h("7"), test_config: h("8") },
    prompt_version: "instruction-v1",
    agent_context_usage: { codex: 500, claude_code: 700, cursor: 700, codebuddy: 700 },
    agent_context_budgets: { codex: 8_000, claude_code: 8_000, cursor: 8_000, codebuddy: 8_000 },
    last_proposal_ref: "proposal:rules:42",
    last_apply_receipt_ref: "apply:rules:41"
  };
}

describe("07A deterministic InstructionInspection Interface", () => {
  it("keeps quality suggestions separate and returns current for an unchanged input", async () => {
    const input = await inspectionInput();
    const first = inspectInstructions(input);

    expect(first.status).toBe("review_required");
    expect(first.requires_reinspection).toBe(true);
    expect(first.structure_findings).toEqual([]);
    expect(first.quality_suggestions.map((item) => item.reason_code)).toEqual([
      "INSTRUCTION_TOPIC_ARCHITECTURE_MISSING",
      "INSTRUCTION_TOPIC_BUILD_MISSING"
    ]);
    expect(first.inspection_ref).toEqual({
      schema_version: 1,
      input_fingerprint: first.input_fingerprint,
      canonical_hash: first.canonical_hash,
      result_hash: first.inspection_ref.result_hash
    });
    expect(first.inspection_id).toBe(`inspection:${first.inspection_ref.result_hash.slice(7, 23)}`);

    const current = inspectInstructions({
      ...input,
      previous_input_fingerprint: first.input_fingerprint
    });
    expect(current.input_fingerprint).toBe(first.input_fingerprint);
    expect(current.canonical_hash).toBe(first.canonical_hash);
    expect(current.projection_hashes).toEqual(first.projection_hashes);
    expect(current.status).toBe("current");
    expect(current.requires_reinspection).toBe(false);
    expect(current.structure_findings.some((item) =>
      item.reason_code === "INSTRUCTION_AUDIT_REQUIRED"
    )).toBe(false);
    expect(Object.isFrozen(current.inspection_ref)).toBe(true);

    (input.canonical_files[0]?.references as string[]).push("mutated.md");
    expect(current.structure_findings).toEqual([]);
  });

  it("classifies missing entrypoints, invalid refs, cycles, conflicts, and budgets as structure", async () => {
    const input = await inspectionInput();
    const core = input.canonical_files[0];
    const testing = input.canonical_files[1];
    if (core === undefined || testing === undefined) throw new Error("fixture incomplete");

    const health = inspectInstructions({
      ...input,
      enabled_agents: ["codex", "claude_code"],
      canonical_files: [
        { ...core, references: [testing.path, ".env.secret", "AGENTS.md"] },
        { ...testing, references: [core.path] }
      ],
      entrypoints: input.entrypoints.filter((entry) => entry.agent === "codex"),
      projection_files: [
        {
          agent: "codex",
          path: "generated/shared.md",
          content_hash: h("a"),
          expected_content_hash: h("b"),
          canonical_refs: [core.path]
        },
        {
          agent: "claude_code",
          path: "generated/shared.md",
          content_hash: h("c"),
          expected_content_hash: h("c"),
          canonical_refs: [testing.path]
        }
      ],
      agent_context_usage: { codex: 9_000, claude_code: 100 },
      agent_context_budgets: { codex: 8_000, claude_code: 8_000 }
    });

    expect(health.status).toBe("conflicted");
    expect(new Set(health.structure_findings.map((item) => item.reason_code))).toEqual(new Set([
      "INSTRUCTION_CANONICAL_REFERENCE_INVALID",
      "INSTRUCTION_CONTEXT_BUDGET_EXCEEDED",
      "INSTRUCTION_ENTRYPOINT_MISSING",
      "INSTRUCTION_REFERENCE_CYCLE",
      "INSTRUCTION_PROJECTION_CONFLICT"
    ]));
    expect(health.structure_findings.every((item) =>
      item.finding_id.startsWith("finding:") && Object.isFrozen(item)
    )).toBe(true);
    expect(health.structure_findings.filter((item) =>
      item.reason_code === "INSTRUCTION_CANONICAL_REFERENCE_INVALID"
    ).map((item) => item.related_paths[0])).toEqual([".env.secret", "AGENTS.md"]);
  });

  it("rejects duplicate snapshots and observations for disabled agents at the typed seam", async () => {
    const input = await inspectionInput();
    const firstCanonicalFile = input.canonical_files[0];
    if (firstCanonicalFile === undefined) throw new Error("fixture incomplete");
    let duplicateCode: string | undefined;
    try {
      inspectInstructions({
        ...input,
        canonical_files: [...input.canonical_files, firstCanonicalFile]
      });
    } catch (error) {
      duplicateCode = error instanceof Error && "code" in error
        ? String(error.code)
        : undefined;
    }
    expect(duplicateCode).toBe("INSTRUCTION_INSPECTION_INPUT_INVALID");

    let disabledCode: string | undefined;
    try {
      inspectInstructions({
        ...input,
        enabled_agents: ["codex"],
        entrypoints: input.entrypoints.filter((entry) => entry.agent === "codex"),
        projection_files: input.projection_files,
        agent_context_usage: { codex: 1 },
        agent_context_budgets: { codex: 10 }
      });
    } catch (error) {
      disabledCode = error instanceof Error && "code" in error
        ? String(error.code)
        : undefined;
    }
    expect(disabledCode).toBe("INSTRUCTION_INSPECTION_INPUT_INVALID");
  });

  it("rejects canonical snapshots outside the manifest before inspecting their references", async () => {
    const input = await inspectionInput();
    const extraPath = ".harness/rules/client_secret.json";
    const firstFile = input.canonical_files[0];
    if (firstFile === undefined) throw new Error("fixture incomplete");
    let code: string | undefined;

    try {
      inspectInstructions({
        ...input,
        canonical_files: [
          { ...firstFile, references: [...firstFile.references, extraPath] },
          ...input.canonical_files.slice(1),
          { path: extraPath, content_hash: h("9"), references: [] }
        ]
      });
    } catch (error) {
      code = error instanceof Error && "code" in error ? String(error.code) : undefined;
    }

    expect(code).toBe("INSTRUCTION_INSPECTION_INPUT_INVALID");
  });

  it("is deterministic across equivalent set ordering and never performs I/O", async () => {
    const input = await inspectionInput();
    const left = inspectInstructions(input);
    const right = inspectInstructions({
      ...input,
      enabled_agents: [...input.enabled_agents].reverse(),
      map_evidence_refs: [...input.map_evidence_refs].reverse(),
      canonical_files: [...input.canonical_files].reverse(),
      entrypoints: [...input.entrypoints].reverse(),
      projection_files: [...input.projection_files].reverse(),
      configuration_hashes: Object.fromEntries(
        Object.entries(input.configuration_hashes).reverse()
      )
    });

    expect(right.input_fingerprint).toBe(left.input_fingerprint);
    expect(right.inspection_ref.result_hash).toBe(left.inspection_ref.result_hash);
  });
});

const expectedProjectionPaths = [
  ".claude/rules/testing.md",
  ".codebuddy/rules/testing.md",
  ".cursor/rules/testing.mdc",
  "AGENTS.md",
  "CLAUDE.md",
  "CODEBUDDY.md",
  "harness/AGENTS.md",
  "packages/AGENTS.md"
] as const;

async function canonicalRulesRef(
  testingGlobs?: readonly string[],
  testingBody?: string
): Promise<CanonicalRulesRef> {
  const raw = await fixture("instruction-governance-v1-current.json") as {
    files: Array<Record<string, unknown>>;
  } & Record<string, unknown>;
  const contents: Readonly<Record<string, string>> = {
    ".harness/rules/core.md": [
      "# Core rules",
      "",
      "## Must follow",
      "",
      "Use the repository validation commands."
    ].join("\n") + "\n",
    ".harness/rules/testing.md": testingBody ?? [
      "# Testing rules",
      "",
      "## Scope",
      "",
      "Product and test changes under packages or harness.",
      "",
      "## Verification",
      "",
      "Run focused tests before the affected package suite."
    ].join("\n") + "\n"
  };
  const manifest = rulesManifestSchema.parse({
    ...raw,
    files: raw.files.map((file) => ({
      ...file,
      ...(file.topic === "testing" && testingGlobs !== undefined
        ? { globs: testingGlobs }
        : {}),
      content_hash: sha256Bytes(contents[String(file.path)] ?? "")
    }))
  });
  const base = await inspectionInput();
  const canonicalFiles = manifest.files.map((file) => ({
    path: file.path,
    content_hash: file.content_hash,
    references: []
  }));
  const health = inspectInstructions({
    ...base,
    project_identity: manifest.project_identity,
    manifest,
    canonical_files: canonicalFiles
  });
  return {
    schema_version: 1,
    canonical_hash: health.canonical_hash,
    manifest,
    files: manifest.files.map((file) => ({
      path: file.path,
      content: contents[file.path] ?? ""
    }))
  };
}

function projectionRequests(): AgentProjectionRequest[] {
  return ["codex", "claude_code", "cursor", "codebuddy"].map((agent) => ({
    agent: agent as AgentProjectionRequest["agent"],
    max_context_budget: 8_000,
    observed_projection_hashes: {}
  }));
}

function absentExpectations(): Record<string, null> {
  return Object.fromEntries(expectedProjectionPaths.map((path) => [path, null]));
}

describe("07A deterministic native Agent projection planning", () => {
  it("renders one protected plan for Codex, Claude, Cursor, and CodeBuddy", async () => {
    const plan = planAgentProjection(
      await canonicalRulesRef(),
      projectionRequests(),
      absentExpectations()
    );

    expect(plan.executable).toBe(true);
    expect(plan.status).toBe("ready");
    expect(plan.failures).toEqual([]);
    expect(plan.operations.map((operation) => operation.path)).toEqual(expectedProjectionPaths);
    expect(plan.operations.every((operation) =>
      operation.operation === "write" &&
      operation.content.includes("generated_by: hunter-harness/instruction-governance") &&
      operation.content.includes("do_not_edit: true")
    )).toBe(true);

    const agents = plan.operations.find((operation) => operation.path === "AGENTS.md");
    expect(agents?.content).toContain("Use the repository validation commands.");
    expect(plan.operations.find((operation) => operation.path === "packages/AGENTS.md")?.content)
      .toContain("Run focused tests before the affected package suite.");
    expect(plan.operations.find((operation) => operation.path === "CLAUDE.md")?.content)
      .toContain("@AGENTS.md");
    const claudeEntrypoint = plan.operations.find((operation) => operation.path === "CLAUDE.md");
    expect(claudeEntrypoint?.content.split(/\r?\n/u).length).toBeLessThanOrEqual(200);
    const cursor = plan.operations.find((operation) =>
      operation.path === ".cursor/rules/testing.mdc"
    )?.content ?? "";
    expect(cursor).toMatch(/^---\ndescription:/u);
    expect(cursor).toContain("globs:\n  - \"harness/**\"\n  - \"packages/**\"");
    expect(cursor).toContain("alwaysApply: false");
    expect(cursor).not.toContain("alwaysApply: true");
    expect(plan.operations.some((operation) =>
      operation.path.startsWith(".codebuddy/.rules/")
    )).toBe(false);
    expect(plan.operations.filter((operation) =>
      operation.path.startsWith(".codebuddy/rules/")
    )).toHaveLength(1);
    expect(Object.keys(plan.projection_hashes).sort()).toEqual([
      "claude_code",
      "codebuddy",
      "codex",
      "cursor"
    ]);
    expect(plan.plan_hash).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(Object.isFrozen(plan.operations[0])).toBe(true);
  });

  it("tracks every active canonical source that affects the shared root projection", async () => {
    const plan = planAgentProjection(
      await canonicalRulesRef(),
      projectionRequests(),
      absentExpectations()
    );
    const root = plan.operations.find((operation) => operation.path === "AGENTS.md");

    expect(root?.source_paths).toEqual([
      ".harness/rules/core.md",
      ".harness/rules/testing.md"
    ]);
    expect(root?.target_agents).toEqual([
      "claude_code",
      "codebuddy",
      "codex",
      "cursor"
    ]);
  });

  it("preserves locally modified projections and empties operations on a required conflict", async () => {
    const ref = await canonicalRulesRef();
    const requests = projectionRequests();
    const codex = requests.find((request) => request.agent === "codex");
    if (codex === undefined) throw new Error("codex request missing");
    const expectations: Record<string, string | null> = {
      ...absentExpectations(),
      "AGENTS.md": h("e")
    };

    const plan = planAgentProjection(ref, requests.map((request) =>
      request.agent === "codex"
        ? {
          ...request,
          observed_projection_hashes: { "AGENTS.md": h("f") }
        }
        : request
    ), expectations);

    expect(plan.executable).toBe(false);
    expect(plan.status).toBe("conflicted");
    expect(plan.operations).toEqual([]);
    expect(plan.failures).toContainEqual(expect.objectContaining({
      reason_code: "INSTRUCTION_PROJECTION_BASELINE_CONFLICT",
      path: "AGENTS.md",
      target_agent: "codex"
    }));
    expect(ref.files[0]?.content).toContain("# Core rules");
  });

  it("fails closed for a required host budget or an invalid canonical ref", async () => {
    const ref = await canonicalRulesRef();
    const requests = projectionRequests().map((request) =>
      request.agent === "codex" ? { ...request, max_context_budget: 1 } : request
    );
    const budget = planAgentProjection(ref, requests, absentExpectations());
    expect(budget).toMatchObject({ executable: false, status: "invalid", operations: [] });
    expect(budget.failures).toContainEqual(expect.objectContaining({
      reason_code: "INSTRUCTION_PROJECTION_CONTEXT_BUDGET_EXCEEDED",
      target_agent: "codex"
    }));

    const invalid = planAgentProjection(
      { ...ref, canonical_hash: h("0") },
      projectionRequests(),
      absentExpectations()
    );
    expect(invalid).toMatchObject({ executable: false, status: "invalid", operations: [] });
    expect(invalid.failures).toContainEqual(expect.objectContaining({
      reason_code: "INSTRUCTION_CANONICAL_REF_INVALID"
    }));
  });

  it("checks every agent aggregate rendered UTF-8 bytes and enforces the Codex 32 KiB cap", async () => {
    const expectations = {
      "AGENTS.md": null,
      "harness/AGENTS.md": null,
      "packages/AGENTS.md": null
    };
    const requestBudgetRef = await canonicalRulesRef(undefined, "界".repeat(800));
    const requestBudget = planAgentProjection(
      requestBudgetRef,
      [{ agent: "codex", max_context_budget: 3_000, observed_projection_hashes: {} }],
      expectations
    );
    expect(requestBudget).toMatchObject({
      executable: false,
      status: "invalid",
      operations: [],
      failures: [{
        reason_code: "INSTRUCTION_PROJECTION_CONTEXT_BUDGET_EXCEEDED",
        target_agent: "codex"
      }]
    });

    const perAgentPaths: Readonly<Record<AgentProjectionRequest["agent"], readonly string[]>> = {
      codex: ["AGENTS.md", "harness/AGENTS.md", "packages/AGENTS.md"],
      claude_code: [".claude/rules/testing.md", "AGENTS.md", "CLAUDE.md"],
      cursor: [".cursor/rules/testing.mdc", "AGENTS.md"],
      codebuddy: [".codebuddy/rules/testing.md", "AGENTS.md", "CODEBUDDY.md"]
    };
    const allAgentsRef = await canonicalRulesRef(undefined, "界".repeat(2_000));
    for (const agent of ["codex", "claude_code", "cursor", "codebuddy"] as const) {
      const plan = planAgentProjection(
        allAgentsRef,
        [{ agent, max_context_budget: 6_000, observed_projection_hashes: {} }],
        Object.fromEntries(perAgentPaths[agent].map((path) => [path, null]))
      );
      expect(plan).toMatchObject({
        executable: false,
        status: "invalid",
        operations: [],
        failures: [{
          reason_code: "INSTRUCTION_PROJECTION_CONTEXT_BUDGET_EXCEEDED",
          target_agent: agent
        }]
      });
    }

    const hardCapRef = await canonicalRulesRef(undefined, "界".repeat(6_000));
    const hardCap = planAgentProjection(
      hardCapRef,
      [{ agent: "codex", max_context_budget: 100_000, observed_projection_hashes: {} }],
      expectations
    );
    expect(hardCap).toMatchObject({
      executable: false,
      status: "invalid",
      operations: [],
      failures: [{
        reason_code: "INSTRUCTION_PROJECTION_CONTEXT_BUDGET_EXCEEDED",
        target_agent: "codex"
      }]
    });
  });

  it("places a literal file glob in the nearest Codex directory chain", async () => {
    const ref = await canonicalRulesRef(["src/config.ts"]);
    const plan = planAgentProjection(
      ref,
      [{
        agent: "codex",
        max_context_budget: 8_000,
        observed_projection_hashes: {}
      }],
      { "AGENTS.md": null, "src/AGENTS.md": null }
    );

    expect(plan.executable).toBe(true);
    expect(plan.operations.map((operation) => operation.path)).toEqual([
      "AGENTS.md",
      "src/AGENTS.md"
    ]);
  });

  it("keeps plan and operation hashes stable across request ordering and input mutation", async () => {
    const ref = await canonicalRulesRef();
    const requests = projectionRequests();
    const expectations = absentExpectations();
    const left = planAgentProjection(ref, requests, expectations);
    const right = planAgentProjection(ref, [...requests].reverse(), {
      ...expectations
    });
    expect(right.plan_hash).toBe(left.plan_hash);
    expect(right.operations).toEqual(left.operations);

    const firstFile = ref.files[0];
    const firstRequest = requests[0];
    if (firstFile === undefined || firstRequest === undefined) throw new Error("fixture incomplete");
    (firstFile as { path: string; content: string }).content = "mutated";
    firstRequest.max_context_budget = 1;
    expect(left.operations.find((operation) => operation.path === "AGENTS.md")?.content)
      .toContain("Use the repository validation commands.");
  });
});
