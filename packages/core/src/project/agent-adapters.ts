import { createHash } from "node:crypto";

import {
  HARNESS_AGENT_ORDER,
  type CodeBuddySurface,
  type HarnessAgent
} from "@hunter-harness/contracts";

import { assertNoCaseCollisions, normalizeManagedPath } from "../fs/path-safety.js";
import {
  CURSOR_GENERAL_RULES_CONTENT,
  CURSOR_JAVA_RULES_CONTENT,
  HARNESS_GENERAL_RULES_CONTENT,
  HARNESS_JAVA_RULES_CONTENT
} from "./managed-content.js";
import type {
  HarnessProfile,
  LoadedAgentBundle,
  ProjectedBundleFile
} from "./profile-bundle.js";

export { HARNESS_AGENT_ORDER };

export interface AdapterContext {
  profile: HarnessProfile;
  codebuddySurface: CodeBuddySurface;
}

export interface AdapterContextIndexEntry {
  instructions: string;
  skills_root: string;
  rules: string[];
}

export interface HarnessAgentAdapter {
  readonly name: HarnessAgent;
  readonly skillsRoot: string;
  readonly rulesRoot: string | null;
  readonly agentsRoot: string | null;
  readonly commandsRoot: string | null;
  readonly supportsExecutableHooks: false;
  projectInstructionTargets(context: AdapterContext): readonly string[];
  projectBundle(
    bundle: LoadedAgentBundle,
    context: AdapterContext
  ): readonly ProjectedBundleFile[];
  contextIndex(context: AdapterContext): AdapterContextIndexEntry;
  pruneBoundaries(context: AdapterContext): readonly string[];
}

const AGENT_SOURCE_PATH = /^agents\/([^/]+\.md)$/;

function validateRelativeBundlePath(path: unknown): asserts path is string {
  if (typeof path !== "string" || path.length === 0 || path.includes("\0") ||
      path.startsWith("/") || path.startsWith("\\") || /^[A-Za-z]:/.test(path) ||
      path.split("/").some((part) => part === "" || part === "." || part === "..")) {
    throw new Error("invalid Harness Bundle path");
  }
}

function ruleTarget(sourcePath: string, targetPath: string, content: string): ProjectedBundleFile {
  return {
    source_path: sourcePath,
    target_path: normalizeManagedPath(targetPath),
    sha256: createHash("sha256").update(content).digest("hex"),
    bytes: new TextEncoder().encode(content)
  };
}

function projectBundleFiles(
  bundle: LoadedAgentBundle,
  skillsRoot: string,
  agentsRoot: string | null
): ProjectedBundleFile[] {
  const records: ProjectedBundleFile[] = [];
  for (const [sourcePath, bytes] of bundle.files) {
    validateRelativeBundlePath(sourcePath);
    const agent = AGENT_SOURCE_PATH.exec(sourcePath);
    if (agent?.[1] !== undefined) {
      if (agentsRoot === null) continue;
      const projectedTarget = `${agentsRoot}/${agent[1]}`;
      const manifestEntry = bundle.manifest.files.find((entry) => entry.path === sourcePath);
      if (manifestEntry === undefined) {
        throw new Error(`Harness Bundle missing manifest entry: ${sourcePath}`);
      }
      records.push({
        source_path: sourcePath,
        target_path: normalizeManagedPath(projectedTarget),
        sha256: manifestEntry.sha256,
        bytes
      });
      continue;
    }
    const projectedTarget = `${skillsRoot}/${sourcePath}`;
    const manifestEntry = bundle.manifest.files.find((entry) => entry.path === sourcePath);
    if (manifestEntry === undefined) {
      throw new Error(`Harness Bundle missing manifest entry: ${sourcePath}`);
    }
    records.push({
      source_path: sourcePath,
      target_path: normalizeManagedPath(projectedTarget),
      sha256: manifestEntry.sha256,
      bytes
    });
  }
  assertNoCaseCollisions(records.map((record) => record.target_path));
  return records.sort((left, right) => left.target_path.localeCompare(right.target_path));
}

function makeAdapter(spec: {
  name: HarnessAgent;
  skillsRoot: string;
  rulesRoot: string | null;
  agentsRoot: string | null;
  commandsRoot: string | null;
  instructions: string;
  extraInstructionFiles: readonly string[];
  ruleExt: ".md" | ".mdc" | null;
}): HarnessAgentAdapter {
  return {
    name: spec.name,
    skillsRoot: spec.skillsRoot,
    rulesRoot: spec.rulesRoot,
    agentsRoot: spec.agentsRoot,
    commandsRoot: spec.commandsRoot,
    supportsExecutableHooks: false,
    projectInstructionTargets() {
      return ["AGENTS.md", ...spec.extraInstructionFiles];
    },
    projectBundle(bundle) {
      return projectBundleFiles(bundle, spec.skillsRoot, spec.agentsRoot);
    },
    contextIndex(context) {
      const rules: string[] = [];
      if (spec.rulesRoot !== null && spec.ruleExt !== null) {
        rules.push(`${spec.rulesRoot}/harness-general${spec.ruleExt}`);
        if (context.profile === "java") {
          rules.push(`${spec.rulesRoot}/harness-profile-java${spec.ruleExt}`);
        }
      }
      return {
        instructions: spec.instructions,
        skills_root: spec.skillsRoot,
        rules
      };
    },
    pruneBoundaries() {
      const boundaries = [spec.skillsRoot];
      if (spec.agentsRoot !== null) boundaries.push(spec.agentsRoot);
      if (spec.rulesRoot !== null) boundaries.push(spec.rulesRoot);
      const top = spec.skillsRoot.split("/")[0];
      if (top !== undefined) boundaries.push(top);
      return boundaries;
    }
  };
}

const ADAPTERS: Record<HarnessAgent, HarnessAgentAdapter> = {
  "claude-code": makeAdapter({
    name: "claude-code",
    skillsRoot: ".claude/skills",
    rulesRoot: ".claude/rules",
    agentsRoot: ".claude/agents",
    commandsRoot: null,
    instructions: "CLAUDE.md",
    extraInstructionFiles: ["CLAUDE.md"],
    ruleExt: ".md"
  }),
  codex: makeAdapter({
    name: "codex",
    skillsRoot: ".agents/skills",
    rulesRoot: null,
    agentsRoot: null,
    commandsRoot: null,
    instructions: "AGENTS.md",
    extraInstructionFiles: [],
    ruleExt: null
  }),
  cursor: makeAdapter({
    name: "cursor",
    skillsRoot: ".cursor/skills",
    rulesRoot: ".cursor/rules",
    agentsRoot: null,
    commandsRoot: ".cursor/commands",
    instructions: "AGENTS.md",
    extraInstructionFiles: [],
    ruleExt: ".mdc"
  }),
  codebuddy: makeAdapter({
    name: "codebuddy",
    skillsRoot: ".codebuddy/skills",
    rulesRoot: null,
    agentsRoot: ".codebuddy/agents",
    commandsRoot: ".codebuddy/commands",
    instructions: "CODEBUDDY.md",
    extraInstructionFiles: ["CODEBUDDY.md"],
    ruleExt: null
  })
};

export function getAdapter(name: HarnessAgent): HarnessAgentAdapter {
  return ADAPTERS[name];
}

export function getAdapters(names: readonly HarnessAgent[]): HarnessAgentAdapter[] {
  return HARNESS_AGENT_ORDER.filter((n) => names.includes(n)).map(getAdapter);
}

/** Bundle projection + generated rules for one adapter. */
export function managedTargetsFor(
  adapter: HarnessAgentAdapter,
  bundle: LoadedAgentBundle,
  context: AdapterContext
): ProjectedBundleFile[] {
  const records = [...adapter.projectBundle(bundle, context)];
  if (adapter.name === "claude-code") {
    records.push(ruleTarget(
      "rules/harness-general.md",
      ".claude/rules/harness-general.md",
      HARNESS_GENERAL_RULES_CONTENT
    ));
    if (context.profile === "java") {
      records.push(ruleTarget(
        "rules/harness-profile-java.md",
        ".claude/rules/harness-profile-java.md",
        HARNESS_JAVA_RULES_CONTENT
      ));
    }
  } else if (adapter.name === "cursor") {
    records.push(ruleTarget(
      "rules/harness-general.mdc",
      ".cursor/rules/harness-general.mdc",
      CURSOR_GENERAL_RULES_CONTENT
    ));
    if (context.profile === "java") {
      records.push(ruleTarget(
        "rules/harness-profile-java.mdc",
        ".cursor/rules/harness-profile-java.mdc",
        CURSOR_JAVA_RULES_CONTENT
      ));
    }
  }
  assertNoCaseCollisions(records.map((record) => record.target_path));
  return records.sort((left, right) => left.target_path.localeCompare(right.target_path));
}
