import { sha256Bytes } from "../fs/hash.js";
import { scanSensitiveFiles } from "../security/scanner.js";
import { canonicalRulePath, rulesManifestSchema } from "./schema.js";
import { compareCodepoint, deepFreeze, stableHash } from "./stable.js";
import {
  INSTRUCTION_TARGET_AGENTS,
  type AgentProjectionRequest,
  type CanonicalRuleDocument,
  type CanonicalRulesRef,
  type ExpectedProjectionHashes,
  type InstructionProjectionFailure,
  type InstructionProjectionOperation,
  type InstructionProjectionPlan,
  type InstructionProjectionPlanStatus,
  type InstructionTargetAgent,
  type RulesManifest,
  type RulesManifestFile
} from "./types.js";

const ADAPTER_VERSION = "instruction_projection_v1" as const;
const SHA256 = /^sha256:[a-f0-9]{64}$/u;

interface NormalizedRequest extends AgentProjectionRequest {
  observed_projection_hashes: Readonly<Record<string, string | null>>;
}

interface NormalizedCanonicalRef {
  canonical_hash: string;
  manifest: RulesManifest;
  files: readonly CanonicalRuleDocument[];
}

interface RenderedFile {
  agent: InstructionTargetAgent;
  path: string;
  source_paths: readonly string[];
  content: string;
}

interface RenderResult {
  files: readonly RenderedFile[];
  failures: readonly InstructionProjectionFailure[];
}

function safePath(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > 240 ||
      value.trim() !== value ||
      Array.from(value).some((character) => character.charCodeAt(0) <= 31)) return null;
  const lower = value.toLowerCase();
  const segments = lower.split("/");
  if (value.startsWith("/") || value.startsWith("\\") || /^[A-Za-z]:/u.test(value) ||
      value.includes("\\") || segments.some((segment) =>
        segment.length === 0 || segment === "." || segment === ".." ||
        segment === ".git" || segment.startsWith(".env") ||
        segment === "credentials.local" || segment.startsWith("credentials.local.")
      ) || lower === ".harness/state" || lower.startsWith(".harness/state/")) {
    return null;
  }
  return value;
}

function normalizedHash(value: unknown): string | null | undefined {
  if (value === null) return null;
  return typeof value === "string" && SHA256.test(value) ? value : undefined;
}

function canonicalRef(input: CanonicalRulesRef): NormalizedCanonicalRef | null {
  if (input === null || typeof input !== "object" || input.schema_version !== 1 ||
      typeof input.canonical_hash !== "string" || !SHA256.test(input.canonical_hash) ||
      !Array.isArray(input.files)) return null;
  const parsed = rulesManifestSchema.safeParse(input.manifest);
  if (!parsed.success) return null;
  const files: CanonicalRuleDocument[] = [];
  const seen = new Set<string>();
  for (const item of input.files) {
    if (item === null || typeof item !== "object") return null;
    let canonicalPath: string;
    try {
      canonicalPath = canonicalRulePath(item.path, "canonical_ref.files.path");
    } catch {
      return null;
    }
    if (seen.has(canonicalPath) || typeof item.content !== "string") return null;
    seen.add(canonicalPath);
    files.push({ path: canonicalPath, content: item.content });
  }
  files.sort((left, right) => compareCodepoint(left.path, right.path));
  if (files.length !== parsed.data.files.length) return null;
  for (const manifestFile of parsed.data.files) {
    const document = files.find((file) => file.path === manifestFile.path);
    if (document === undefined || sha256Bytes(document.content) !== manifestFile.content_hash) {
      return null;
    }
  }
  const contentByPath = Object.fromEntries(files.map((file) => [file.path, file.content]));
  if (scanSensitiveFiles(contentByPath, { now: new Date(0) }).blocked) return null;
  const computed = stableHash({
    manifest: parsed.data,
    files: parsed.data.files.map(({ path, content_hash }) => ({ path, content_hash }))
  });
  if (computed !== input.canonical_hash) return null;
  return {
    canonical_hash: computed,
    manifest: parsed.data,
    files
  };
}

function normalizeRequests(input: readonly AgentProjectionRequest[]): readonly NormalizedRequest[] | null {
  if (!Array.isArray(input) || input.length === 0 ||
      input.length > INSTRUCTION_TARGET_AGENTS.length) return null;
  const requests: NormalizedRequest[] = [];
  for (const item of input) {
    if (item === null || typeof item !== "object" ||
        !INSTRUCTION_TARGET_AGENTS.includes(item.agent) ||
        !Number.isSafeInteger(item.max_context_budget) ||
        item.max_context_budget < 1 || item.observed_projection_hashes === null ||
        typeof item.observed_projection_hashes !== "object" ||
        Array.isArray(item.observed_projection_hashes)) return null;
    const observed: Record<string, string | null> = {};
    for (const [rawPath, rawHash] of Object.entries(item.observed_projection_hashes).sort(
      ([left], [right]) => compareCodepoint(left, right)
    )) {
      const path = safePath(rawPath);
      const hash = normalizedHash(rawHash);
      if (path === null || hash === undefined) return null;
      observed[path] = hash;
    }
    requests.push({
      agent: item.agent,
      max_context_budget: item.max_context_budget,
      observed_projection_hashes: observed
    });
  }
  if (new Set(requests.map((request) => request.agent)).size !== requests.length) return null;
  return requests.sort((left, right) => compareCodepoint(left.agent, right.agent));
}

function normalizeExpectations(input: ExpectedProjectionHashes): Record<string, string | null> | null {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return null;
  const result: Record<string, string | null> = {};
  for (const [rawPath, rawHash] of Object.entries(input).sort(([left], [right]) =>
    compareCodepoint(left, right)
  )) {
    const path = safePath(rawPath);
    const hash = normalizedHash(rawHash);
    if (path === null || hash === undefined) return null;
    result[path] = hash;
  }
  return result;
}

function marker(source: string, canonicalHash: string): string {
  return [
    "<!--",
    "generated_by: hunter-harness/instruction-governance",
    `adapter_version: ${ADAPTER_VERSION}`,
    `canonical_source: ${source}`,
    `canonical_hash: ${canonicalHash}`,
    "do_not_edit: true",
    "-->"
  ].join("\n");
}

function body(document: CanonicalRuleDocument): string {
  return document.content.replace(/\r\n/gu, "\n").trimEnd();
}

function stem(file: RulesManifestFile): string {
  return file.path.slice(file.path.lastIndexOf("/") + 1, -3);
}

function scopeRoot(glob: string): string | null {
  const wildcardOffset = glob.search(/[?*[]/u);
  const fixed = wildcardOffset === -1 ? glob : glob.slice(0, wildcardOffset);
  const directory = wildcardOffset === -1
    ? fixed.slice(0, fixed.lastIndexOf("/"))
    : fixed.endsWith("/")
      ? fixed.slice(0, -1)
      : fixed.slice(0, fixed.lastIndexOf("/"));
  return directory.length === 0 ? null : safePath(directory);
}

function quoteYaml(value: string): string {
  return JSON.stringify(value);
}

function agentRules(
  ref: NormalizedCanonicalRef,
  agent: InstructionTargetAgent
): readonly RulesManifestFile[] {
  return ref.manifest.files.filter((file) =>
    file.status === "active" && file.target_agents.includes(agent)
  );
}

function document(ref: NormalizedCanonicalRef, path: string): CanonicalRuleDocument {
  const result = ref.files.find((file) => file.path === path);
  if (result === undefined) throw new Error("canonical document disappeared after validation");
  return result;
}

function rootAgents(ref: NormalizedCanonicalRef): RenderedFile | null {
  const core = ref.manifest.files.find((file) =>
    file.topic === "core" && file.status === "active"
  );
  if (core === undefined) return null;
  const coreDocument = document(ref, core.path);
  const navigation = ref.manifest.files
    .filter((file) => file.status === "active" && file.topic !== "core")
    .map((file) => `- ${file.path} (${file.activation})`)
    .join("\n");
  const sources = ref.manifest.files
    .filter((file) => file.status === "active")
    .map((file) => file.path)
    .sort(compareCodepoint);
  return {
    agent: "codex",
    path: "AGENTS.md",
    source_paths: sources,
    content: [
      marker(core.path, ref.canonical_hash),
      "",
      body(coreDocument),
      "",
      "## Scoped canonical rules",
      "",
      navigation.length === 0 ? "- None." : navigation,
      ""
    ].join("\n")
  };
}

function renderCodex(
  ref: NormalizedCanonicalRef,
  request: NormalizedRequest
): RenderResult {
  const rules = agentRules(ref, "codex");
  const failures: InstructionProjectionFailure[] = [];
  const root = rootAgents(ref);
  if (root === null || !rules.some((file) => file.topic === "core")) {
    return { files: [], failures: [{
      reason_code: "INSTRUCTION_PROJECTION_RENDER_INVALID",
      target_agent: request.agent,
      path: "AGENTS.md"
    }] };
  }
  const byRoot = new Map<string, RulesManifestFile[]>();
  for (const file of rules.filter((item) => item.activation === "path")) {
    for (const glob of file.globs) {
      const scope = scopeRoot(glob);
      if (scope === null) {
        failures.push({
          reason_code: "INSTRUCTION_PROJECTION_RENDER_INVALID",
          target_agent: request.agent,
          path: file.path
        });
        continue;
      }
      const values = byRoot.get(scope) ?? [];
      if (!values.some((value) => value.path === file.path)) values.push(file);
      byRoot.set(scope, values);
    }
  }
  const files: RenderedFile[] = [{ ...root, agent: "codex" }];
  for (const [scope, scopedRules] of [...byRoot].sort(([left], [right]) =>
    compareCodepoint(left, right)
  )) {
    const sorted = scopedRules.sort((left, right) => compareCodepoint(left.path, right.path));
    files.push({
      agent: "codex",
      path: `${scope}/AGENTS.md`,
      source_paths: sorted.map((file) => file.path),
      content: sorted.map((file) => [
        marker(file.path, ref.canonical_hash),
        "",
        body(document(ref, file.path))
      ].join("\n")).join("\n\n") + "\n"
    });
  }
  return { files, failures };
}

function renderClaude(
  ref: NormalizedCanonicalRef,
  request: NormalizedRequest
): RenderResult {
  const rules = agentRules(ref, "claude_code");
  const root = rootAgents(ref);
  if (root === null || !rules.some((file) => file.topic === "core")) {
    return { files: [], failures: [{
      reason_code: "INSTRUCTION_PROJECTION_RENDER_INVALID",
      target_agent: request.agent,
      path: "CLAUDE.md"
    }] };
  }
  const files: RenderedFile[] = [
    { ...root, agent: "claude_code" },
    {
      agent: "claude_code",
      path: "CLAUDE.md",
      source_paths: ["AGENTS.md"],
      content: [
        marker("AGENTS.md", ref.canonical_hash),
        "",
        "@AGENTS.md",
        ""
      ].join("\n")
    }
  ];
  for (const file of rules.filter((item) => item.topic !== "core" && item.activation === "path")) {
    const paths = file.globs.map((glob) => `  - ${quoteYaml(glob)}`).join("\n");
    files.push({
      agent: "claude_code",
      path: `.claude/rules/${stem(file)}.md`,
      source_paths: [file.path],
      content: [
        "---",
        "paths:",
        paths,
        "---",
        marker(file.path, ref.canonical_hash),
        "",
        body(document(ref, file.path)),
        ""
      ].join("\n")
    });
  }
  return { files, failures: [] };
}

function renderCursor(
  ref: NormalizedCanonicalRef,
  request: NormalizedRequest
): RenderResult {
  const rules = agentRules(ref, "cursor");
  const root = rootAgents(ref);
  if (root === null || !rules.some((file) => file.topic === "core")) {
    return { files: [], failures: [{
      reason_code: "INSTRUCTION_PROJECTION_RENDER_INVALID",
      target_agent: request.agent,
      path: "AGENTS.md"
    }] };
  }
  const files: RenderedFile[] = [{ ...root, agent: "cursor" }];
  for (const file of rules.filter((item) => item.topic !== "core")) {
    const frontmatter = [
      "---",
      `description: ${quoteYaml(`Generated ${file.topic} rules from ${file.path}`)}`,
      ...(file.globs.length === 0
        ? []
        : ["globs:", ...file.globs.map((glob) => `  - ${quoteYaml(glob)}`)]),
      "alwaysApply: false",
      "---"
    ];
    files.push({
      agent: "cursor",
      path: `.cursor/rules/${stem(file)}.mdc`,
      source_paths: [file.path],
      content: [
        ...frontmatter,
        marker(file.path, ref.canonical_hash),
        "",
        body(document(ref, file.path)),
        ""
      ].join("\n")
    });
  }
  return { files, failures: [] };
}

function renderCodeBuddy(
  ref: NormalizedCanonicalRef,
  request: NormalizedRequest
): RenderResult {
  const rules = agentRules(ref, "codebuddy");
  const root = rootAgents(ref);
  if (root === null || !rules.some((file) => file.topic === "core")) {
    return { files: [], failures: [{
      reason_code: "INSTRUCTION_PROJECTION_RENDER_INVALID",
      target_agent: request.agent,
      path: "CODEBUDDY.md"
    }] };
  }
  const files: RenderedFile[] = [
    { ...root, agent: "codebuddy" },
    {
      agent: "codebuddy",
      path: "CODEBUDDY.md",
      source_paths: ["AGENTS.md"],
      content: [
        marker("AGENTS.md", ref.canonical_hash),
        "",
        "# CodeBuddy project instructions",
        "",
        "Follow the generated AGENTS.md entrypoint. Scoped projections are generated under .codebuddy/rules/.",
        ""
      ].join("\n")
    }
  ];
  for (const file of rules.filter((item) => item.topic !== "core")) {
    files.push({
      agent: "codebuddy",
      path: `.codebuddy/rules/${stem(file)}.md`,
      source_paths: [file.path],
      content: [
        marker(file.path, ref.canonical_hash),
        `<!-- activation: ${file.activation}; globs: ${file.globs.join(",")} -->`,
        "",
        body(document(ref, file.path)),
        ""
      ].join("\n")
    });
  }
  return { files, failures: [] };
}

function render(ref: NormalizedCanonicalRef, request: NormalizedRequest): RenderResult {
  switch (request.agent) {
    case "codex": return renderCodex(ref, request);
    case "claude_code": return renderClaude(ref, request);
    case "cursor": return renderCursor(ref, request);
    case "codebuddy": return renderCodeBuddy(ref, request);
  }
}

function aggregate(
  files: readonly RenderedFile[],
  expectations: Readonly<Record<string, string | null>>
): {
  operations: InstructionProjectionOperation[];
  failures: InstructionProjectionFailure[];
} {
  const grouped = new Map<string, RenderedFile[]>();
  for (const file of files) {
    const values = grouped.get(file.path) ?? [];
    values.push(file);
    grouped.set(file.path, values);
  }
  const operations: InstructionProjectionOperation[] = [];
  const failures: InstructionProjectionFailure[] = [];
  for (const [path, values] of [...grouped].sort(([left], [right]) =>
    compareCodepoint(left, right)
  )) {
    const contents = new Set(values.map((value) => value.content));
    if (contents.size !== 1) {
      failures.push({ reason_code: "INSTRUCTION_PROJECTION_PATH_COLLISION", path });
      continue;
    }
    if (!Object.hasOwn(expectations, path)) {
      failures.push({ reason_code: "INSTRUCTION_PROJECTION_EXPECTATION_MISSING", path });
      continue;
    }
    const content = values[0]?.content;
    if (content === undefined) continue;
    operations.push({
      operation: "write",
      path,
      target_agents: [...new Set(values.map((value) => value.agent))].sort(compareCodepoint),
      source_paths: [...new Set(values.flatMap((value) => value.source_paths))].sort(compareCodepoint),
      expected_content_hash: expectations[path] ?? null,
      content_hash: sha256Bytes(content),
      content,
      adapter_version: ADAPTER_VERSION
    });
  }
  for (const path of Object.keys(expectations).sort(compareCodepoint)) {
    if (!grouped.has(path)) {
      failures.push({ reason_code: "INSTRUCTION_PROJECTION_EXPECTATION_UNKNOWN", path });
    }
  }
  return { operations, failures };
}

function failurePlan(
  canonicalHash: string,
  failures: readonly InstructionProjectionFailure[],
  status: InstructionProjectionPlanStatus = "invalid",
  projectionHashes: Partial<Record<InstructionTargetAgent, string>> = {}
): InstructionProjectionPlan {
  const sortedFailures = [...failures].sort((left, right) => compareCodepoint(
    `${left.reason_code}\0${left.target_agent ?? ""}\0${left.path ?? ""}`,
    `${right.reason_code}\0${right.target_agent ?? ""}\0${right.path ?? ""}`
  ));
  const base = {
    schema_version: 1 as const,
    canonical_hash: canonicalHash,
    adapter_version: ADAPTER_VERSION,
    status,
    executable: false,
    operations: [] as const,
    failures: sortedFailures,
    projection_hashes: projectionHashes
  };
  return deepFreeze({ ...base, plan_hash: stableHash(base) }) as InstructionProjectionPlan;
}

export function planAgentProjection(
  inputRef: CanonicalRulesRef,
  inputRequests: readonly AgentProjectionRequest[],
  inputExpectations: ExpectedProjectionHashes
): InstructionProjectionPlan {
  const ref = canonicalRef(inputRef);
  if (ref === null) {
    return failurePlan(
      typeof inputRef?.canonical_hash === "string" ? inputRef.canonical_hash : "sha256:" + "0".repeat(64),
      [{ reason_code: "INSTRUCTION_CANONICAL_REF_INVALID" }]
    );
  }
  const requests = normalizeRequests(inputRequests);
  const expectations = normalizeExpectations(inputExpectations);
  if (requests === null || expectations === null) {
    return failurePlan(ref.canonical_hash, [{
      reason_code: "INSTRUCTION_PROJECTION_RENDER_INVALID"
    }]);
  }
  const rendered: RenderedFile[] = [];
  const failures: InstructionProjectionFailure[] = [];
  for (const request of requests) {
    const result = render(ref, request);
    rendered.push(...result.files);
    failures.push(...result.failures);
  }
  for (const request of requests) {
    const agentFiles = rendered.filter((file) => file.agent === request.agent);
    const effectiveBudget = request.agent === "codex"
      ? Math.min(request.max_context_budget, 32_768)
      : request.max_context_budget;
    const renderedBytes = agentFiles.reduce(
      (total, file) => total + Buffer.byteLength(file.content, "utf8"),
      0
    );
    const claudeEntrypointTooLong = request.agent === "claude_code" && agentFiles.some(
      (file) => file.path === "CLAUDE.md" && file.content.split(/\r?\n/u).length > 200
    );
    if (renderedBytes > effectiveBudget || claudeEntrypointTooLong) {
      failures.push({
        reason_code: "INSTRUCTION_PROJECTION_CONTEXT_BUDGET_EXCEEDED",
        target_agent: request.agent,
        ...(claudeEntrypointTooLong ? { path: "CLAUDE.md" } : {})
      });
    }
  }
  if (failures.length > 0) return failurePlan(ref.canonical_hash, failures);

  const aggregated = aggregate(rendered, expectations);
  failures.push(...aggregated.failures);
  for (const operation of aggregated.operations) {
    for (const targetAgent of operation.target_agents) {
      const request = requests.find((item) => item.agent === targetAgent);
      if (request === undefined) continue;
      const observed = Object.hasOwn(request.observed_projection_hashes, operation.path)
        ? request.observed_projection_hashes[operation.path]
        : null;
      if (observed !== operation.expected_content_hash) {
        failures.push({
          reason_code: "INSTRUCTION_PROJECTION_BASELINE_CONFLICT",
          target_agent: targetAgent,
          path: operation.path
        });
      }
    }
  }
  const projectionHashes: Partial<Record<InstructionTargetAgent, string>> = {};
  for (const request of requests) {
    projectionHashes[request.agent] = stableHash(aggregated.operations
      .filter((operation) => operation.target_agents.includes(request.agent))
      .map(({ path, content_hash }) => ({ path, content_hash })));
  }
  if (failures.length > 0) {
    const conflicted = failures.some((failure) =>
      failure.reason_code === "INSTRUCTION_PROJECTION_BASELINE_CONFLICT" ||
      failure.reason_code === "INSTRUCTION_PROJECTION_PATH_COLLISION"
    );
    return failurePlan(
      ref.canonical_hash,
      failures,
      conflicted ? "conflicted" : "invalid",
      projectionHashes
    );
  }
  const base = {
    schema_version: 1 as const,
    canonical_hash: ref.canonical_hash,
    adapter_version: ADAPTER_VERSION,
    status: "ready" as const,
    executable: true,
    operations: aggregated.operations,
    failures: [] as const,
    projection_hashes: projectionHashes
  };
  return deepFreeze({ ...base, plan_hash: stableHash(base) }) as InstructionProjectionPlan;
}
