import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";
import { scanSensitiveFiles } from "../src/security/scanner.js";
import { contentHash, stableJson } from "../src/codebase/map-v2/stable.js";

import {
  assessMapEvidencePath,
  CODEBASE_MAP_V2_DOCUMENTS,
  CODEBASE_MAP_PUBLICATION_TARGETS,
  estimateMapEvidenceTokenCost,
  inspectMap,
  planMapPublication as planMapPublicationCore,
  projectMapManifest,
  selectMapEvidence,
  selectMappingExecutionPolicy,
  type MapInspectionInput,
  type MapEvidenceSelectionInput,
  type MapManifestDraftV2,
  type MapManifestV2,
  type MapPublicationPlanInput
} from "../src/codebase/map-v2/index.js";

const sha = (character: string): `sha256:${string}` =>
  `sha256:${character.repeat(64)}`;
const PUBLISHED_AT = "2026-08-13T00:00:00.000+08:00";

function planMapPublication(
  input: Omit<MapPublicationPlanInput, "published_at">
): ReturnType<typeof planMapPublicationCore> {
  return planMapPublicationCore({ ...input, published_at: PUBLISHED_AT });
}

function manifest(overrides: Partial<MapManifestV2> = {}): MapManifestV2 {
  return {
    schema_version: 2,
    generator: { name: "harness-codebase-map", version: "2.0.0" },
    project_identity: "project-1",
    repository_identity: "repository-1",
    branch_name: "main",
    source_commit: "commit-1",
    worktree_identity: "worktree-1",
    mode: "full",
    scope: "repository",
    path_filters: [],
    input_fingerprint: sha("1"),
    documents: CODEBASE_MAP_V2_DOCUMENTS.map((name) => ({
      path: `.harness/codebase/map/${name}`,
      topics: [name.replace(/\.md$/u, "").toLowerCase()],
      evidence_sources: ["filesystem"],
      input_fingerprint: sha("2"),
      content_hash: sha("3"),
      estimated_tokens: 20,
      status: "current"
    })),
    summary_hash: sha("4"),
    warnings: [],
    degradation_reasons: [],
    status: "ready",
    published_at: "2026-08-12T00:00:00.000Z",
    ...overrides
  };
}

function inspectionInput(
  overrides: Partial<MapInspectionInput> = {}
): MapInspectionInput {
  return {
    schema_version: 2,
    project_identity: "project-1",
    repository_identity: "repository-1",
    worktree_identity: "worktree-1",
    is_git: true,
    branch_name: "main",
    current_commit: "commit-1",
    last_mapped_commit: "commit-1",
    dirty_paths: [],
    untracked_paths: [],
    affected_paths: [],
    input_group_fingerprints: {},
    feature_flags: {
      map_enabled: true,
      auto_check_enabled: true,
      explicit_request: false,
      codegraph_enabled: true,
      codegraph_available: true
    },
    manifest: manifest(),
    ...overrides
  };
}

function manifestDraft(): MapManifestDraftV2 {
  const draft = { ...manifest() } as MapManifestDraftV2 & { published_at?: string };
  delete draft.published_at;
  return draft;
}

function completeLegacyManifest(): unknown {
  return {
    schema_version: 1,
    generator: "harness-codebase-map",
    generated_at: "2026-07-28T00:00:00.000Z",
    last_mapped_commit: "commit-1",
    documents: CODEBASE_MAP_V2_DOCUMENTS.map((name) =>
      `.harness/codebase/map/${name}`)
  };
}

describe("CodebaseMapModule v2 manifest compatibility", () => {
  it("projects legacy manifests without inventing repository, branch, or worktree identity", async () => {
    const legacy = JSON.parse(await readFile(
      new URL("./fixtures/codebase-map-v1-legacy.json", import.meta.url),
      "utf8"
    )) as unknown;

    const result = projectMapManifest(legacy);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.source_schema_version).toBe(1);
    expect(result.manifest.schema_version).toBe(2);
    expect(result.manifest.source_commit).toBe("abc123");
    expect(result.manifest).not.toHaveProperty("repository_identity");
    expect(result.manifest).not.toHaveProperty("branch_name");
    expect(result.manifest).not.toHaveProperty("worktree_identity");
    expect(result.manifest).not.toHaveProperty("generator");
    expect(result.manifest.degradation_reasons).toEqual(expect.arrayContaining([
      "LEGACY_GENERATOR_VERSION_UNKNOWN",
      "LEGACY_REPOSITORY_IDENTITY_UNKNOWN",
      "LEGACY_BRANCH_NAME_UNKNOWN",
      "LEGACY_WORKTREE_IDENTITY_UNKNOWN",
      "LEGACY_DOCUMENT_METADATA_INCOMPLETE"
    ]));
    expect(result.manifest.documents[0]).not.toHaveProperty("content_hash");
  });

  it("returns a machine failure for malformed manifests instead of treating them as usable", () => {
    expect(projectMapManifest({ schema_version: 2, documents: "not-an-array" })).toEqual({
      ok: false,
      reason_code: "MAP_MANIFEST_INVALID"
    });
  });

  it("rejects a v2 manifest with incomplete durable document metadata", () => {
    const current = manifest();
    const malformed = {
      ...current,
      documents: [{
        ...current.documents[0],
        content_hash: undefined
      }]
    };

    expect(projectMapManifest(malformed)).toEqual({
      ok: false,
      reason_code: "MAP_MANIFEST_INVALID"
    });
  });

  it("rejects unknown v2 manifest fields instead of silently accepting schema drift", () => {
    expect(projectMapManifest({ ...manifest(), invented_field: true })).toEqual({
      ok: false,
      reason_code: "MAP_MANIFEST_INVALID"
    });
  });

  it("rejects a durable v2 manifest that does not declare all seven documents", () => {
    const current = manifest();
    expect(projectMapManifest({ ...current, documents: current.documents.slice(0, 6) }))
      .toEqual({ ok: false, reason_code: "MAP_MANIFEST_INVALID" });
  });

  it("rejects malformed non-Git input-group fingerprints", () => {
    expect(projectMapManifest({
      ...manifest(),
      input_group_fingerprints: { runtime: "not-a-sha256" }
    })).toEqual({ ok: false, reason_code: "MAP_MANIFEST_INVALID" });
  });

  it.each([
    ["path_filters", ["src/**", ""]],
    ["path_filters", [" src/**"]],
    ["warnings", ["warning", " "]],
    ["degradation_reasons", ["CODEGRAPH_UNAVAILABLE", " reason"]],
    ["topics", ["stack", ""]],
    ["topics", [" stack"]],
    ["evidence_sources", ["filesystem", " "]],
    ["evidence_sources", [" filesystem"]]
  ] as const)("rejects non-canonical string-array members for %s", (field, values) => {
    const current = manifest();
    const malformed = field === "topics" || field === "evidence_sources"
      ? {
        ...current,
        documents: current.documents.map((document, index) => index === 0
          ? { ...document, [field]: [...values] }
          : document)
      }
      : { ...current, [field]: [...values] };

    expect(projectMapManifest(malformed)).toEqual({
      ok: false,
      reason_code: "MAP_MANIFEST_INVALID"
    });
  });

  it.each([
    "2026-08-13",
    "2026-02-30T00:00:00Z",
    "2026-08-13 00:00:00Z",
    "2026-08-13T25:00:00Z",
    "not-a-time"
  ])("rejects non-RFC3339 published_at %s", (published_at) => {
    expect(projectMapManifest({ ...manifest(), published_at })).toEqual({
      ok: false,
      reason_code: "MAP_MANIFEST_INVALID"
    });
  });

  it.each([
    "2026-08-13T00:00:00Z",
    "2026-08-13T00:00:00.123+08:00",
    "2026-08-12T16:00:00-04:30"
  ])("accepts complete RFC3339 published_at %s", (published_at) => {
    expect(projectMapManifest({ ...manifest(), published_at }))
      .toMatchObject({ ok: true, source_schema_version: 2 });
  });

  it("does not call localeCompare while canonicalizing manifest maps", () => {
    const original = String.prototype.localeCompare;
    String.prototype.localeCompare = () => {
      throw new Error("localeCompare must not be used");
    };
    try {
      const result = projectMapManifest({
        ...manifest(),
        input_group_fingerprints: { "é": sha("3"), a: sha("2"), Z: sha("1") }
      });
      expect(result).toMatchObject({ ok: true, source_schema_version: 2 });
      if (!result.ok) return;
      expect(Object.keys(result.manifest.input_group_fingerprints ?? {}))
        .toEqual(["Z", "a", "é"]);
    } finally {
      String.prototype.localeCompare = original;
    }
  });
});

describe("CodebaseMapModule v2 inspectMap", () => {
  it("returns not_applicable without a warning when map was never adopted or enabled", () => {
    const result = inspectMap(inspectionInput({
      manifest: undefined,
      feature_flags: {
        map_enabled: false,
        auto_check_enabled: false,
        explicit_request: false,
        codegraph_enabled: false,
        codegraph_available: false
      }
    }));

    expect(result).toMatchObject({
      applicability: "not_applicable",
      status: "not_applicable",
      affected_documents: [],
      conflicts: [],
      suggested_actions: ["offer_generate_map"],
      reason_codes: ["MAP_NOT_ADOPTED"]
    });
  });

  it("treats identity drift as a conflict and never reuses another branch or worktree map", () => {
    const result = inspectMap(inspectionInput({
      branch_name: "feature/new-map",
      worktree_identity: "worktree-2"
    }));

    expect(result.status).toBe("conflicted");
    expect(result.conflicts).toEqual([
      { reason_code: "MAP_BRANCH_MISMATCH", expected: "main", actual: "feature/new-map" },
      { reason_code: "MAP_WORKTREE_MISMATCH", expected: "worktree-1", actual: "worktree-2" }
    ]);
    expect(result.suggested_actions).toContain("run_full_refresh");
  });

  it("requires complete Git identity before treating a v2 manifest as current", () => {
    const result = inspectMap(inspectionInput({
      manifest: manifest({
        branch_name: undefined,
        source_commit: undefined,
        worktree_identity: undefined
      })
    }));

    expect(result.status).toBe("refresh_required");
    expect(result.reason_codes).toContain("MAP_MANIFEST_IDENTITY_INCOMPLETE");
    expect(result.affected_documents).toEqual(CODEBASE_MAP_V2_DOCUMENTS);
    expect(result.suggested_actions).toEqual(["run_full_refresh"]);
  });

  it.each([
    ["package.json", ["STACK.md", "INTEGRATIONS.md"]],
    ["packages/web/package.json", ["STACK.md", "INTEGRATIONS.md"]],
    ["src/routes/users.ts", ["ARCHITECTURE.md", "STRUCTURE.md"]],
    ["apps/server/migrations/004_add_snapshot.sql", ["ARCHITECTURE.md", "STRUCTURE.md"]],
    ["test/api.test.ts", ["TESTING.md", "CONVENTIONS.md"]],
    [".github/workflows/ci.yml", ["INTEGRATIONS.md", "STACK.md"]],
    ["unknown/new-shape.xyz", ["ARCHITECTURE.md", "CONCERNS.md"]]
  ])("classifies %s deterministically", (path, expected) => {
    const result = inspectMap(inspectionInput({
      current_commit: "commit-2",
      affected_paths: [path]
    }));

    expect(result.status).toBe("refresh_required");
    expect(result.affected_documents).toEqual(expected);
  });

  it("uses non-Git input-group fingerprints and does not use elapsed time as freshness", () => {
    const currentManifest = manifest({
      branch_name: undefined,
      source_commit: undefined,
      worktree_identity: undefined,
      input_group_fingerprints: { runtime: sha("5"), tests: sha("6") },
      published_at: "2001-01-01T00:00:00.000Z"
    });
    const unchanged = inspectMap(inspectionInput({
      is_git: false,
      branch_name: undefined,
      current_commit: undefined,
      last_mapped_commit: undefined,
      worktree_identity: undefined,
      input_group_fingerprints: { tests: sha("6"), runtime: sha("5") },
      manifest: currentManifest
    }));
    const changed = inspectMap(inspectionInput({
      is_git: false,
      branch_name: undefined,
      current_commit: undefined,
      last_mapped_commit: undefined,
      worktree_identity: undefined,
      input_group_fingerprints: { runtime: sha("7"), tests: sha("6") },
      manifest: currentManifest
    }));

    expect(unchanged.status).toBe("current");
    expect(unchanged.reason_codes).not.toContain("MAP_AGE_EXCEEDED");
    expect(changed.status).toBe("refresh_required");
    expect(changed.reason_codes).toContain("MAP_INPUT_FINGERPRINT_CHANGED");
  });

  it("degrades explicitly when CodeGraph is enabled but unavailable", () => {
    const result = inspectMap(inspectionInput({
      feature_flags: {
        map_enabled: true,
        auto_check_enabled: true,
        explicit_request: false,
        codegraph_enabled: true,
        codegraph_available: false
      }
    }));

    expect(result.status).toBe("current");
    expect(result.reason_codes).toEqual(["MAP_CURRENT", "MAP_CODEGRAPH_UNAVAILABLE"]);
    expect(result.suggested_actions).not.toContain("build_codegraph_index");
  });

  it("preserves an Adapter-provided durable manifest hash", () => {
    const input = {
      ...inspectionInput(),
      manifest_hash: sha("f")
    } as MapInspectionInput & { manifest_hash: string };

    expect(inspectMap(input).manifest_hash).toBe(sha("f"));
  });

  it("refreshes only the non-Git input groups whose fingerprints changed", () => {
    const result = inspectMap(inspectionInput({
      is_git: false,
      branch_name: undefined,
      current_commit: undefined,
      last_mapped_commit: undefined,
      worktree_identity: undefined,
      affected_paths: [],
      input_group_fingerprints: {
        runtime: sha("7"),
        tests: sha("6")
      },
      manifest: manifest({
        branch_name: undefined,
        source_commit: undefined,
        worktree_identity: undefined,
        input_group_fingerprints: {
          runtime: sha("5"),
          tests: sha("6")
        }
      })
    }));

    expect(result.affected_documents).toEqual(["STACK.md", "INTEGRATIONS.md"]);
    expect(result.suggested_actions).toEqual(["run_incremental_refresh"]);
  });

  it("does not treat a conflicted manifest as current", () => {
    const result = inspectMap(inspectionInput({
      manifest: manifest({ status: "conflicted" })
    }));

    expect(result.status).toBe("conflicted");
    expect(result.reason_codes).toContain("MAP_MANIFEST_CONFLICTED");
    expect(result.affected_documents).toEqual(CODEBASE_MAP_V2_DOCUMENTS);
  });

  it("does not treat a partial manifest as current", () => {
    const result = inspectMap(inspectionInput({ manifest: manifest({ status: "partial" }) }));

    expect(result.status).toBe("refresh_required");
    expect(result.reason_codes).toContain("MAP_MANIFEST_PARTIAL");
    expect(result.affected_documents).toEqual(CODEBASE_MAP_V2_DOCUMENTS);
    expect(result.suggested_actions).toEqual(["run_full_refresh"]);
  });

  it("recommends a full refresh for broad structural drift", () => {
    const result = inspectMap(inspectionInput({
      current_commit: "commit-2",
      affected_paths: Array.from({ length: 21 }, (_, index) =>
        `packages/module-${index}/src/index.ts`)
    }));

    expect(result.affected_documents).toEqual(["ARCHITECTURE.md", "STRUCTURE.md"]);
    expect(result.suggested_actions).toEqual(["run_full_refresh"]);
  });

  it("reports local canonical map edits as conflicts rather than overwriting them", () => {
    const result = inspectMap(inspectionInput({
      dirty_paths: [".harness/codebase/map/STACK.md"]
    }));

    expect(result.status).toBe("conflicted");
    expect(result.reason_codes).toContain("MAP_LOCAL_MODIFICATION_CONFLICT");
    expect(result.affected_documents).toEqual(["STACK.md"]);
    expect(result.suggested_actions).toEqual([
      "keep_local",
      "use_new_result",
      "view_diff"
    ]);
    expect(result.conflicts).toEqual([{
      reason_code: "MAP_LOCAL_MODIFICATION_CONFLICT",
      paths: [".harness/codebase/map/STACK.md"]
    }]);
  });

  it.each([
    ".harness/codebase/map-summary.md",
    ".harness/codebase/map-manifest.json"
  ])("requires full review when %s has local edits", (path) => {
    const result = inspectMap(inspectionInput({ dirty_paths: [path] }));

    expect(result.affected_documents).toEqual(CODEBASE_MAP_V2_DOCUMENTS);
    expect(result.suggested_actions).toEqual([
      "keep_local",
      "use_new_result",
      "view_diff"
    ]);
  });

  it.each([true, false])(
    "never treats legacy unknown identity as current for is_git=%s",
    (is_git) => {
      const result = inspectMap(inspectionInput({
        is_git,
        branch_name: is_git ? "main" : undefined,
        current_commit: is_git ? "commit-1" : undefined,
        last_mapped_commit: is_git ? "commit-1" : undefined,
        worktree_identity: is_git ? "worktree-1" : undefined,
        manifest: completeLegacyManifest()
      }));

      expect(result).toMatchObject({
        applicability: "applicable",
        status: "refresh_required",
        affected_documents: CODEBASE_MAP_V2_DOCUMENTS,
        suggested_actions: ["run_full_refresh"],
        reason_codes: ["MAP_LEGACY_IDENTITY_UNKNOWN"]
      });
      expect(result.reason_codes).not.toContain("MAP_CURRENT");
    }
  );

  it("prioritizes legacy local-map conflicts before migration refresh", () => {
    const result = inspectMap(inspectionInput({
      manifest: completeLegacyManifest(),
      dirty_paths: [".harness/codebase/map/STACK.md"]
    }));

    expect(result.status).toBe("conflicted");
    expect(result.reason_codes).toContain("MAP_LOCAL_MODIFICATION_CONFLICT");
    expect(result.affected_documents).toEqual(["STACK.md"]);
    expect(result.suggested_actions).toEqual(["keep_local", "use_new_result", "view_diff"]);
  });
});

describe("CodebaseMapModule v2 evidence path policy", () => {
  it.each([
    [".env", "MAP_EVIDENCE_PATH_ENV_EXCLUDED"],
    ["config/.env.production", "MAP_EVIDENCE_PATH_ENV_EXCLUDED"],
    [".harness/credentials.local.json", "MAP_EVIDENCE_PATH_CREDENTIALS_EXCLUDED"],
    ["packages/web/.npmrc", "MAP_EVIDENCE_PATH_PACKAGE_AUTH_EXCLUDED"],
    [".pypirc", "MAP_EVIDENCE_PATH_PACKAGE_AUTH_EXCLUDED"],
    ["keys/id_ed25519", "MAP_EVIDENCE_PATH_PRIVATE_KEY_EXCLUDED"],
    ["certs/deploy.key", "MAP_EVIDENCE_PATH_PRIVATE_KEY_EXCLUDED"],
    ["keys/private.pem", "MAP_EVIDENCE_PATH_PRIVATE_KEY_EXCLUDED"],
    [".git/config", "MAP_EVIDENCE_PATH_VCS_EXCLUDED"],
    ["/etc/passwd", "MAP_EVIDENCE_PATH_INVALID"],
    ["C:/Users/me/token.txt", "MAP_EVIDENCE_PATH_INVALID"],
    ["packages/../.env", "MAP_EVIDENCE_PATH_INVALID"],
    ["client_secret.json", "MAP_EVIDENCE_PATH_CREDENTIALS_EXCLUDED"],
    ["config/CLIENT-SECRET.YAML", "MAP_EVIDENCE_PATH_CREDENTIALS_EXCLUDED"],
    ["client_secret", "MAP_EVIDENCE_PATH_CREDENTIALS_EXCLUDED"],
    ["nested/CLIENT-SECRET.txt", "MAP_EVIDENCE_PATH_CREDENTIALS_EXCLUDED"],
    ["nested/client_secret.conf", "MAP_EVIDENCE_PATH_CREDENTIALS_EXCLUDED"],
    ["nested/client-secret.custom", "MAP_EVIDENCE_PATH_CREDENTIALS_EXCLUDED"],
    ["nested/client_secret.prod.json", "MAP_EVIDENCE_PATH_CREDENTIALS_EXCLUDED"],
    ["config/client-secret.local.yaml", "MAP_EVIDENCE_PATH_CREDENTIALS_EXCLUDED"],
    ["secrets/credentials.json", "MAP_EVIDENCE_PATH_CREDENTIALS_EXCLUDED"],
    ["secrets/Credential.YmL", "MAP_EVIDENCE_PATH_CREDENTIALS_EXCLUDED"]
  ] as const)("rejects %s before a Collect Adapter reads it", (path, reason_code) => {
    expect(assessMapEvidencePath(path)).toEqual({ allowed: false, reason_code });
  });

  it("returns a canonical path decision for an allowed source file", () => {
    expect(assessMapEvidencePath("packages/core/src/index.ts")).toEqual({
      allowed: true,
      path: "packages/core/src/index.ts"
    });
  });

  it.each([
    "docs/credentials.locality.md",
    "docs/CREDENTIALS.LOCALITY.MD",
    "config/client_secretary.json",
    "config/my_client_secret.json",
    "config/client_secret_backup.txt",
    "config/not-client-secret.yaml"
  ])("allows credential lookalike %s", (path) => {
    expect(assessMapEvidencePath(path)).toEqual({ allowed: true, path });
  });
});

describe("CodebaseMapModule v2 evidence selection", () => {
  it("uses locale-independent code-point ordering for durable hashes", () => {
    expect(stableJson({ "é": 3, a: 2, Z: 1 })).toBe('{"Z":1,"a":2,"é":3}');
  });

  it("uses locale-independent code-point ordering for evidence", () => {
    const result = selectMapEvidence({
      schema_version: 2,
      manifest_hash: sha("8"),
      topics: ["stack"],
      budget: { max_characters: 20, max_tokens: 20 },
      candidates: [
        {
          topic: "stack",
          source_path: "a.ts",
          content: "a",
          confidence: "verified",
          evidence_source: "filesystem"
        },
        {
          topic: "stack",
          source_path: "Z.ts",
          content: "Z",
          confidence: "verified",
          evidence_source: "filesystem"
        }
      ]
    });

    expect(result.snippets.map((candidate) => candidate.source_path)).toEqual(["Z.ts", "a.ts"]);
  });

  it("selects requested topics in stable order, excludes sensitive paths, and enforces budget", () => {
    const input: MapEvidenceSelectionInput = {
      schema_version: 2 as const,
      manifest_hash: sha("8"),
      source_commit: "commit-1",
      topics: ["architecture", "testing"],
      budget: { max_characters: 36, max_tokens: 36 },
      candidates: [
        {
          topic: "testing",
          source_path: ".env.production",
          content: "SECRET=must-not-appear",
          confidence: "verified" as const,
          evidence_source: "filesystem"
        },
        {
          topic: "testing",
          source_path: "packages/z/test.ts",
          content: "testing evidence z",
          confidence: "verified" as const,
          evidence_source: "filesystem"
        },
        {
          topic: "architecture",
          source_path: "packages/a/src/index.ts",
          content: "architecture evidence a",
          confidence: "verified" as const,
          evidence_source: "codegraph"
        },
        {
          topic: "architecture",
          source_path: "packages/b/src/index.ts",
          content: "architecture evidence b",
          confidence: "inferred" as const,
          evidence_source: "filesystem"
        }
      ]
    };

    const first = selectMapEvidence(input);
    const second = selectMapEvidence({ ...input, candidates: [...input.candidates].reverse() });

    expect(first).toEqual(second);
    expect(first.snippets.map((item) => item.source_path)).toEqual([
      "packages/a/src/index.ts",
      "packages/b/src/index.ts"
    ]);
    expect(first.snippets.map((item) => item.content).join(" ")).not.toContain("SECRET");
    expect(first.used_budget.characters).toBeLessThanOrEqual(36);
    expect(first.used_budget.tokens).toBeLessThanOrEqual(36);
    expect(first.truncation_reasons).toEqual(expect.arrayContaining([
      "SENSITIVE_PATH_EXCLUDED",
      "CHARACTER_BUDGET_EXHAUSTED"
    ]));
  });

  it("扫描停用后不再按内容排除候选（SENSITIVE_CONTENT_EXCLUDED 不再出现）", () => {
    // 停用契约（2026-08 4458708）：evidence 选择不再做内容敏感排除。
    const result = selectMapEvidence({
      schema_version: 2,
      manifest_hash: sha("8"),
      topics: ["integrations"],
      budget: { max_characters: 200, max_tokens: 50 },
      candidates: [{
        topic: "integrations",
        source_path: "docs/integration-notes.md",
        content: "Authorization: Bearer abcdefghijklmnopqrstuvwxyz",
        confidence: "verified",
        evidence_source: "filesystem"
      }]
    });

    expect(result.truncation_reasons ?? []).not.toContain("SENSITIVE_CONTENT_EXCLUDED");
    expect(result.snippets.length).toBeGreaterThan(0);
  });

  it.each([
    ["ASCII", 5],
    ["中文", 6],
    ["😀", 4],
    ["中文😀", 10]
  ])("uses a UTF-8 byte upper bound for %s token cost", (content, tokens) => {
    expect(estimateMapEvidenceTokenCost(content)).toEqual({
      tokens,
      strategy: "utf8_byte_upper_bound"
    });
  });

  it.each([
    ["AB", 1, "A", 1],
    ["中文", 3, "中", 3],
    ["😀x", 4, "😀", 4],
    ["中文😀", 1, "", 0]
  ])("never exceeds token budget for %s", (content, max_tokens, expected, used) => {
    const result = selectMapEvidence({
      schema_version: 2,
      manifest_hash: sha("8"),
      topics: ["architecture"],
      budget: { max_characters: 20, max_tokens },
      candidates: [{
        topic: "architecture",
        source_path: "packages/core/src/index.ts",
        content,
        confidence: "verified",
        evidence_source: "filesystem"
      }]
    });

    expect(result.snippets.map((item) => item.content).join("")).toBe(expected);
    expect(result.used_budget.tokens).toBe(used);
    expect(result.used_budget.tokens).toBeLessThanOrEqual(max_tokens);
    expect(result.truncation_reasons).toContain("TOKEN_BUDGET_EXHAUSTED");
  });
});

describe("CodebaseMapModule v2 execution and publication planning", () => {
  it.each([
    ["quick", "light", 1, 2],
    ["incremental", "light", 3, 2],
    ["full", "standard", 4, 2]
  ] as const)("bounds %s execution policy", (mode, tier, mappers, attempts) => {
    expect(selectMappingExecutionPolicy({ mode, affected_topic_count: 3 })).toMatchObject({
      mode,
      model_tier: tier,
      max_parallel_mappers: mappers,
      max_model_attempts: attempts,
      escalation_conditions: ["VALIDATION_FAILED", "HIGH_RISK_AMBIGUITY"]
    });
  });

  it("plans a first full mapping with exactly seven documents, a summary, and a manifest", () => {
    const proposed_documents = Object.fromEntries(
      CODEBASE_MAP_V2_DOCUMENTS.map((name) => [name, `# ${name}\npackages/core/src/index.ts\n`])
    );
    const first = planMapPublication({
      schema_version: 2,
      mode: "full",
      affected_documents: [...CODEBASE_MAP_V2_DOCUMENTS],
      previous_documents: {},
      proposed_documents,
      manifest_draft: manifestDraft(),
      summary_content: "# Map summary\npackages/core/src/index.ts\n"
    });
    const second = planMapPublication({
      schema_version: 2,
      mode: "full",
      affected_documents: [...CODEBASE_MAP_V2_DOCUMENTS],
      previous_documents: {},
      proposed_documents: Object.fromEntries(Object.entries(proposed_documents).reverse()),
      manifest_draft: manifestDraft(),
      summary_content: "# Map summary\npackages/core/src/index.ts\n"
    });

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(Object.keys(first.documents)).toEqual(CODEBASE_MAP_V2_DOCUMENTS);
    expect(first.operations.filter((item) => item.operation === "stage_write"))
      .toHaveLength(9);
    expect(Object.keys(first.payloads)).toEqual(CODEBASE_MAP_PUBLICATION_TARGETS);
    expect(Object.isFrozen(first.payloads)).toBe(true);
    expect(first.payloads[".harness/codebase/map-summary.md"])
      .toBe("# Map summary\npackages/core/src/index.ts\n");
    expect(first.payloads[".harness/codebase/map-manifest.json"]).toBe(first.manifest_payload);
    const writes = first.operations.filter((item) => item.operation === "stage_write");
    expect(writes).toEqual(CODEBASE_MAP_PUBLICATION_TARGETS.map((path) => ({
      operation: "stage_write",
      path,
      content_hash: contentHash(first.payloads[path])
    })));
    expect(first.plan_hash).toBe(second.plan_hash);
    expect(first.manifest.published_at).toBe(PUBLISHED_AT);
    expect(JSON.parse(first.manifest_payload)).toEqual(first.manifest);
    expect(projectMapManifest(JSON.parse(first.manifest_payload)))
      .toMatchObject({ ok: true, source_schema_version: 2 });
    const manifestWrite = first.operations.find((item) =>
      item.operation === "stage_write" && item.path === ".harness/codebase/map-manifest.json");
    expect(manifestWrite).toEqual({
      operation: "stage_write",
      path: ".harness/codebase/map-manifest.json",
      content_hash: contentHash(first.manifest_payload)
    });
  });

  it("records the same conservative token-cost strategy in manifest metadata", () => {
    const proposed_documents = Object.fromEntries(
      CODEBASE_MAP_V2_DOCUMENTS.map((name) => [
        name,
        name === "STACK.md"
          ? "# Stack\n中文😀\n"
          : `# ${name}\npackages/core/src/index.ts\n`
      ])
    );
    const result = planMapPublication({
      schema_version: 2,
      mode: "full",
      affected_documents: [...CODEBASE_MAP_V2_DOCUMENTS],
      previous_documents: {},
      proposed_documents,
      manifest_draft: manifestDraft(),
      summary_content: "# Map summary\npackages/core/src/index.ts\n"
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.manifest.documents.find((item) =>
      item.path.endsWith("/STACK.md"))?.estimated_tokens)
      .toBe(estimateMapEvidenceTokenCost(proposed_documents["STACK.md"] ?? "").tokens);
  });

  it("preserves unaffected documents byte-for-byte in incremental publication plans", () => {
    const previous_documents = Object.fromEntries(
      CODEBASE_MAP_V2_DOCUMENTS.map((name) => [name, `# ${name}\npackages/core/src/index.ts\n`])
    );
    const result = planMapPublication({
      schema_version: 2,
      mode: "incremental",
      affected_documents: ["STRUCTURE.md"],
      previous_manifest_hash: sha("9"),
      previous_documents,
      proposed_documents: {
        "STRUCTURE.md": "# Structure\npackages/core/src/codebase/map-v2/index.ts\n"
      },
      manifest_draft: manifestDraft(),
      summary_content: "# Map summary\npackages/core/src/index.ts\n"
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.documents["STRUCTURE.md"]).toContain("map-v2/index.ts");
    expect(result.documents["STACK.md"]).toBe(previous_documents["STACK.md"]);
    expect(result.preserved_documents).toEqual(CODEBASE_MAP_V2_DOCUMENTS.filter(
      (name) => name !== "STRUCTURE.md"
    ));
    expect(result.operations.at(-1)).toEqual({
      operation: "atomic_replace_set",
      staged_paths: [
        ...CODEBASE_MAP_V2_DOCUMENTS.map((name) => `map/${name}`),
        "map-summary.md",
        "map-manifest.json"
      ],
      target_paths: [
        ...CODEBASE_MAP_V2_DOCUMENTS.map((name) => `.harness/codebase/map/${name}`),
        ".harness/codebase/map-summary.md",
        ".harness/codebase/map-manifest.json"
      ],
      rollback_on_failure: true,
      expected_previous_manifest_hash: sha("9")
    });
    expect(result.manifest.published_at).toBe(PUBLISHED_AT);
    expect(result.manifest_payload).toBe(stableJson(result.manifest));
    expect(result).not.toHaveProperty("receipt");
  });

  it.each([undefined, "", "2026-08-13", "2026-02-30T00:00:00Z"])(
    "requires a frozen RFC3339 publication timestamp: %s",
    (published_at) => {
      const proposed_documents = Object.fromEntries(
        CODEBASE_MAP_V2_DOCUMENTS.map((name) => [name, `# ${name}\npackages/core/src/index.ts\n`])
      );
      const input = {
        schema_version: 2,
        mode: "full",
        affected_documents: [...CODEBASE_MAP_V2_DOCUMENTS],
        previous_documents: {},
        proposed_documents,
        manifest_draft: manifestDraft(),
        summary_content: "# Map summary\npackages/core/src/index.ts\n",
        ...(published_at === undefined ? {} : { published_at })
      };

      expect(planMapPublicationCore(input as MapPublicationPlanInput)).toEqual({
        ok: false,
        reason_codes: ["MAP_PUBLICATION_TIMESTAMP_INVALID"],
        operations: []
      });
    }
  );

  it("binds the frozen publication timestamp into the manifest and plan hashes", () => {
    const proposed_documents = Object.fromEntries(
      CODEBASE_MAP_V2_DOCUMENTS.map((name) => [name, `# ${name}\npackages/core/src/index.ts\n`])
    );
    const common = {
      schema_version: 2 as const,
      mode: "full" as const,
      affected_documents: [...CODEBASE_MAP_V2_DOCUMENTS],
      previous_documents: {},
      proposed_documents,
      manifest_draft: manifestDraft(),
      summary_content: "# Map summary\npackages/core/src/index.ts\n"
    };
    const first = planMapPublicationCore({ ...common, published_at: PUBLISHED_AT });
    const changed = planMapPublicationCore({
      ...common,
      published_at: "2026-08-13T00:00:01.000+08:00"
    });

    expect(first.ok).toBe(true);
    expect(changed.ok).toBe(true);
    if (!first.ok || !changed.ok) return;
    const firstWrite = first.operations.find((item) =>
      item.operation === "stage_write" && item.path === ".harness/codebase/map-manifest.json");
    const changedWrite = changed.operations.find((item) =>
      item.operation === "stage_write" && item.path === ".harness/codebase/map-manifest.json");
    expect(first.plan_hash).not.toBe(changed.plan_hash);
    expect(firstWrite?.content_hash).not.toBe(changedWrite?.content_hash);
    const tamperedPayload = stableJson({
      ...first.manifest,
      published_at: changed.manifest.published_at
    });
    expect(contentHash(tamperedPayload)).not.toBe(firstWrite?.content_hash);
  });

  it("binds summary bytes into the authoritative payload map and plan hash", () => {
    const proposed_documents = Object.fromEntries(CODEBASE_MAP_V2_DOCUMENTS.map((name) =>
      [name, `# ${name}\npackages/core/src/index.ts\n`]));
    const common = { schema_version: 2 as const, mode: "full" as const,
      affected_documents: [...CODEBASE_MAP_V2_DOCUMENTS], previous_documents: {}, proposed_documents,
      manifest_draft: manifestDraft() };
    const first = planMapPublication({ ...common,
      summary_content: "# Map summary\npackages/core/src/index.ts\n" });
    const changed = planMapPublication({ ...common,
      summary_content: "# Changed summary\npackages/core/src/index.ts\n" });
    expect(first.ok).toBe(true); expect(changed.ok).toBe(true);
    if (!first.ok || !changed.ok) return;
    expect(first.plan_hash).not.toBe(changed.plan_hash);
    expect(first.payloads[".harness/codebase/map-summary.md"])
      .not.toBe(changed.payloads[".harness/codebase/map-summary.md"]);
    expect(first.operations.find((item) => item.operation === "stage_write" &&
      item.path === ".harness/codebase/map-summary.md")?.content_hash)
      .toBe(contentHash(first.payloads[".harness/codebase/map-summary.md"]));
  });

  it("produces no write operations and retains the old manifest when validation fails", () => {
    const previous_documents = Object.fromEntries(
      CODEBASE_MAP_V2_DOCUMENTS.map((name) => [name, `# ${name}\npackages/core/src/index.ts\n`])
    );
    const result = planMapPublication({
      schema_version: 2,
      mode: "incremental",
      affected_documents: ["ARCHITECTURE.md"],
      previous_manifest_hash: sha("9"),
      previous_documents,
      proposed_documents: {
        "ARCHITECTURE.md": "# Rules\nEveryone MUST obey this governance rule.\n"
      },
      manifest_draft: manifestDraft(),
      summary_content: "# Map summary\npackages/core/src/index.ts\n"
    });

    expect(result).toEqual({
      ok: false,
      reason_codes: ["ARCHITECTURE_GOVERNANCE_CONTENT_FORBIDDEN"],
      retained_manifest_hash: sha("9"),
      operations: []
    });
  });

  it.each([
    ["CONVENTIONS.md", "All agents MUST run npm test.",
      "CONVENTIONS_GOVERNANCE_CONTENT_FORBIDDEN"],
    ["CONVENTIONS.md", "ALL CONTRIBUTORS SHALL follow this rule.",
      "CONVENTIONS_GOVERNANCE_CONTENT_FORBIDDEN"],
    ["CONVENTIONS.md", "所有 Agent 必须运行测试。",
      "CONVENTIONS_GOVERNANCE_CONTENT_FORBIDDEN"],
    ["CONVENTIONS.md", "开发者不得绕过质量门。",
      "CONVENTIONS_GOVERNANCE_CONTENT_FORBIDDEN"],
    ["ARCHITECTURE.md", "所有 Agent 必须遵循此架构规则。",
      "ARCHITECTURE_GOVERNANCE_CONTENT_FORBIDDEN"],
    ["ARCHITECTURE.md", "You must run npm test.",
      "ARCHITECTURE_GOVERNANCE_CONTENT_FORBIDDEN"],
    ["CONVENTIONS.md", "You must run npm test.",
      "CONVENTIONS_GOVERNANCE_CONTENT_FORBIDDEN"],
    ["ARCHITECTURE.md", "Changes shall include verification.",
      "ARCHITECTURE_GOVERNANCE_CONTENT_FORBIDDEN"],
    ["CONVENTIONS.md", "Changes shall include verification.",
      "CONVENTIONS_GOVERNANCE_CONTENT_FORBIDDEN"],
    ["ARCHITECTURE.md", "必须运行全部测试。",
      "ARCHITECTURE_GOVERNANCE_CONTENT_FORBIDDEN"],
    ["CONVENTIONS.md", "必须运行全部测试。",
      "CONVENTIONS_GOVERNANCE_CONTENT_FORBIDDEN"],
    ["ARCHITECTURE.md", "本项目不得绕过验证。",
      "ARCHITECTURE_GOVERNANCE_CONTENT_FORBIDDEN"],
    ["CONVENTIONS.md", "本项目不得绕过验证。",
      "CONVENTIONS_GOVERNANCE_CONTENT_FORBIDDEN"],
    ["ARCHITECTURE.md", "Must run npm test.",
      "ARCHITECTURE_GOVERNANCE_CONTENT_FORBIDDEN"],
    ["CONVENTIONS.md", "Must run npm test.",
      "CONVENTIONS_GOVERNANCE_CONTENT_FORBIDDEN"],
    ["ARCHITECTURE.md", "Shall include verification.",
      "ARCHITECTURE_GOVERNANCE_CONTENT_FORBIDDEN"],
    ["CONVENTIONS.md", "Shall include verification.",
      "CONVENTIONS_GOVERNANCE_CONTENT_FORBIDDEN"],
    ["ARCHITECTURE.md", "May not skip validation.",
      "ARCHITECTURE_GOVERNANCE_CONTENT_FORBIDDEN"],
    ["CONVENTIONS.md", "May not skip validation.",
      "CONVENTIONS_GOVERNANCE_CONTENT_FORBIDDEN"]
  ] as const)("blocks governance directives in %s", (name, directive, reason_code) => {
    const previous_documents = Object.fromEntries(
      CODEBASE_MAP_V2_DOCUMENTS.map((document) => [
        document,
        `# ${document}\npackages/core/src/index.ts\n`
      ])
    );
    const result = planMapPublication({
      schema_version: 2,
      mode: "incremental",
      affected_documents: [name],
      previous_manifest_hash: sha("9"),
      previous_documents,
      proposed_documents: {
        [name]: `# ${name}\n${directive}\npackages/core/src/index.ts\n`
      },
      manifest_draft: manifestDraft(),
      summary_content: "# Map summary\npackages/core/src/index.ts\n"
    });

    expect(result).toEqual({
      ok: false,
      reason_codes: [reason_code],
      retained_manifest_hash: sha("9"),
      operations: []
    });
  });

  it("allows verified observations in architecture and conventions documents", () => {
    const previous_documents = Object.fromEntries(
      CODEBASE_MAP_V2_DOCUMENTS.map((document) => [
        document,
        `# ${document}\npackages/core/src/index.ts\n`
      ])
    );
    const result = planMapPublication({
      schema_version: 2,
      mode: "incremental",
      affected_documents: ["ARCHITECTURE.md", "CONVENTIONS.md"],
      previous_manifest_hash: sha("9"),
      previous_documents,
      proposed_documents: {
        "ARCHITECTURE.md":
          "# Architecture\nVerified call path: packages/core/src/index.ts.\n",
        "CONVENTIONS.md":
          "# Conventions\nObserved: tests use Vitest in packages/core/test/codebase-map.test.ts.\n"
      },
      manifest_draft: manifestDraft(),
      summary_content: "# Map summary\npackages/core/src/index.ts\n"
    });

    expect(result.ok).toBe(true);
  });

  it.each([
    "Observed: the parser stores the word must as ordinary text.",
    "Observed text: `Must run npm test.` appears in a fixture.",
    "The README quotes \"Shall include verification.\" as rejected input.",
    "Verified: the phrase May not skip is scanner test data, not an instruction.",
    "Verified: packages/core/src/index.ts exports the module.",
    "观察事实：测试夹具包含‘必须’字样，但不构成执行命令。"
  ])("allows descriptive, non-governance observations: %s", (observation) => {
    const previous_documents = Object.fromEntries(
      CODEBASE_MAP_V2_DOCUMENTS.map((name) => [name, `# ${name}\npackages/core/src/index.ts\n`])
    );
    const result = planMapPublication({
      schema_version: 2,
      mode: "incremental",
      affected_documents: ["CONVENTIONS.md"],
      previous_manifest_hash: sha("9"),
      previous_documents,
      proposed_documents: {
        "CONVENTIONS.md": `# Conventions\n${observation}\npackages/core/src/index.ts\n`
      },
      manifest_draft: manifestDraft(),
      summary_content: "# Map summary\npackages/core/src/index.ts\n"
    });

    expect(result.ok).toBe(true);
  });

  it("发布规划不再做内容敏感检查：含密钥文档照常产出计划", () => {
    // 停用契约（2026-08 4458708）：planMapPublication 不扫描内容，
    // SENSITIVE_OUTPUT_DETECTED 不再出现。
    const previous_documents = Object.fromEntries(
      CODEBASE_MAP_V2_DOCUMENTS.map((name) => [name, `# ${name}\npackages/core/src/index.ts\n`])
    );
    const result = planMapPublication({
      schema_version: 2,
      mode: "incremental",
      affected_documents: ["STACK.md"],
      previous_manifest_hash: sha("9"),
      previous_documents,
      proposed_documents: {
        "STACK.md": "# Stack\nAuthorization: Bearer abcdefghijklmnopqrstuvwxyz\n"
      },
      manifest_draft: manifestDraft(),
      summary_content: "# Map summary\npackages/core/src/index.ts\n"
    });

    expect(result).toMatchObject({ ok: true });
    expect("reason_codes" in result ? result.reason_codes : []).not.toContain("SENSITIVE_OUTPUT_DETECTED");
  });

  it.each([
    ["password=correct-horse-battery-staple", "HH_PASSWORD_VALUE"],
    ["aws_access_key_id=AKIA1234567890ABCDEF", "HH_AWS_ACCESS_KEY"],
    ["-----BEGIN PRIVATE KEY-----", "HH_PRIVATE_KEY"],
    [`token=ghp_${"a".repeat(36)}`, "HH_GITHUB_TOKEN"],
    ["database=postgresql://user:secret@example.invalid/db", "HH_DATABASE_URL"]
  ])("canonical 扫描器本体仍识别 %s（但发布路径不再调用它）", (secret, canonicalRule) => {
    // 扫描器模块保持完好——被停用的是发布/上传路径对它的调用。
    expect(scanSensitiveFiles({ "fixture.txt": secret }).findings.map((item) => item.rule_id))
      .toContain(canonicalRule);
    const previous_documents = Object.fromEntries(
      CODEBASE_MAP_V2_DOCUMENTS.map((name) => [name, `# ${name}\npackages/core/src/index.ts\n`])
    );
    const result = planMapPublication({
      schema_version: 2,
      mode: "incremental",
      affected_documents: ["STACK.md"],
      previous_manifest_hash: sha("9"),
      previous_documents,
      proposed_documents: { "STACK.md": `# Stack\n${secret}\n` },
      manifest_draft: manifestDraft(),
      summary_content: "# Map summary\npackages/core/src/index.ts\n"
    });

    expect(result).toMatchObject({ ok: true });
  });

  it("durable manifest 内容也不再触发 SENSITIVE_OUTPUT_DETECTED", () => {
    const previous_documents = Object.fromEntries(
      CODEBASE_MAP_V2_DOCUMENTS.map((name) => [name, `# ${name}\npackages/core/src/index.ts\n`])
    );
    const result = planMapPublication({
      schema_version: 2,
      mode: "incremental",
      affected_documents: ["STACK.md"],
      previous_manifest_hash: sha("9"),
      previous_documents,
      proposed_documents: { "STACK.md": previous_documents["STACK.md"] ?? "" },
      manifest_draft: {
        ...manifestDraft(),
        repository_identity: "postgresql://user:secret@example.invalid/db"
      },
      summary_content: "# Map summary\npackages/core/src/index.ts\n"
    });

    expect(result).toMatchObject({ ok: true });
  });

  it("does not reject ordinary password terminology or placeholders", () => {
    const previous_documents = Object.fromEntries(
      CODEBASE_MAP_V2_DOCUMENTS.map((name) => [name, `# ${name}\npackages/core/src/index.ts\n`])
    );
    const result = planMapPublication({
      schema_version: 2,
      mode: "incremental",
      affected_documents: ["STACK.md"],
      previous_manifest_hash: sha("9"),
      previous_documents,
      proposed_documents: {
        "STACK.md": "# Stack\nThe password field is required.\npassword=${DB_PASSWORD}\n"
      },
      manifest_draft: manifestDraft(),
      summary_content: "# Map summary\npackages/core/src/index.ts\n"
    });

    expect(result.ok).toBe(true);
  });

  it("requires an expected previous manifest for non-full publication", () => {
    const previous_documents = Object.fromEntries(
      CODEBASE_MAP_V2_DOCUMENTS.map((name) => [name, `# ${name}\npackages/core/src/index.ts\n`])
    );
    const result = planMapPublication({
      schema_version: 2,
      mode: "incremental",
      affected_documents: ["STACK.md"],
      previous_documents,
      proposed_documents: { "STACK.md": previous_documents["STACK.md"] ?? "" },
      manifest_draft: manifestDraft(),
      summary_content: "# Map summary\npackages/core/src/index.ts\n"
    });

    expect(result).toMatchObject({
      ok: false,
      reason_codes: ["PUBLICATION_SCOPE_INVALID"],
      operations: []
    });
  });

  it("rejects a malformed durable manifest draft before staging", () => {
    const previous_documents = Object.fromEntries(
      CODEBASE_MAP_V2_DOCUMENTS.map((name) => [name, `# ${name}\npackages/core/src/index.ts\n`])
    );
    const invalidDraft = { ...manifestDraft(), repository_identity: "" };
    const result = planMapPublication({
      schema_version: 2,
      mode: "incremental",
      affected_documents: ["STACK.md"],
      previous_manifest_hash: sha("9"),
      previous_documents,
      proposed_documents: { "STACK.md": previous_documents["STACK.md"] ?? "" },
      manifest_draft: invalidDraft,
      summary_content: "# Map summary\npackages/core/src/index.ts\n"
    });

    expect(result).toMatchObject({
      ok: false,
      reason_codes: ["MAP_MANIFEST_DRAFT_INVALID"],
      operations: []
    });
  });

  it.each([
    ["branch_name", ""],
    ["branch_name", "   "],
    ["source_commit", ""],
    ["source_commit", "   "],
    ["worktree_identity", ""]
  ] as const)("rejects empty optional identity field %s", (field, value) => {
    const previous_documents = Object.fromEntries(
      CODEBASE_MAP_V2_DOCUMENTS.map((name) => [name, `# ${name}\npackages/core/src/index.ts\n`])
    );
    const invalidDraft = { ...manifestDraft(), [field]: value };
    const result = planMapPublication({
      schema_version: 2,
      mode: "incremental",
      affected_documents: ["STACK.md"],
      previous_manifest_hash: sha("9"),
      previous_documents,
      proposed_documents: { "STACK.md": previous_documents["STACK.md"] ?? "" },
      manifest_draft: invalidDraft,
      summary_content: "# Map summary\npackages/core/src/index.ts\n"
    });

    expect(result).toMatchObject({
      ok: false,
      reason_codes: ["MAP_MANIFEST_DRAFT_INVALID"],
      operations: []
    });
  });

  it("rejects an empty optional generator prompt version", () => {
    const previous_documents = Object.fromEntries(
      CODEBASE_MAP_V2_DOCUMENTS.map((name) => [name, `# ${name}\npackages/core/src/index.ts\n`])
    );
    const draft = manifestDraft();
    const invalidDraft = { ...draft, generator: { ...draft.generator, prompt_version: "" } };
    const result = planMapPublication({
      schema_version: 2,
      mode: "incremental",
      affected_documents: ["STACK.md"],
      previous_manifest_hash: sha("9"),
      previous_documents,
      proposed_documents: { "STACK.md": previous_documents["STACK.md"] ?? "" },
      manifest_draft: invalidDraft,
      summary_content: "# Map summary\npackages/core/src/index.ts\n"
    });

    expect(result).toMatchObject({
      ok: false,
      reason_codes: ["MAP_MANIFEST_DRAFT_INVALID"],
      operations: []
    });
  });

  it.each(["all_optional", "no_optional", "prompt_version"])(
    "all legal publication plans round-trip through the v2 reader: %s",
    (variant) => {
      const proposed_documents = Object.fromEntries(
        CODEBASE_MAP_V2_DOCUMENTS.map((name) => [name, `# ${name}\npackages/core/src/index.ts\n`])
      );
      const draft = manifestDraft() as MapManifestDraftV2 & {
        branch_name?: string;
        source_commit?: string;
        worktree_identity?: string;
        input_group_fingerprints?: Readonly<Record<string, string>>;
      };
      if (variant === "no_optional") {
        delete draft.branch_name;
        delete draft.source_commit;
        delete draft.worktree_identity;
        delete draft.input_group_fingerprints;
      } else if (variant === "prompt_version") {
        draft.generator = { ...draft.generator, prompt_version: "prompt-v2" };
      }
      const result = planMapPublication({
        schema_version: 2,
        mode: "full",
        affected_documents: [...CODEBASE_MAP_V2_DOCUMENTS],
        previous_documents: {},
        proposed_documents,
        manifest_draft: draft,
        summary_content: "# Map summary\npackages/core/src/index.ts\n"
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.manifest_payload).toBe(stableJson(result.manifest));
      expect(projectMapManifest(JSON.parse(result.manifest_payload)))
        .toMatchObject({ ok: true, source_schema_version: 2 });
    }
  );
});
