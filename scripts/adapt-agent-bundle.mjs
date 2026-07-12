import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

const SKILL_ALLOW = {
  "claude-code": null,
  codex: ["name", "description"],
  cursor: ["name", "description"],
  codebuddy: ["name", "description"]
};

const AGENT_FILE_ALLOW = {
  "claude-code": null,
  codebuddy: ["name", "description", "permissionMode", "skills"]
};

const FORBIDDEN_SHARED = ["<!-- @include"];
const UNFINISHED_PLACEHOLDER = /\{\{[A-Z][A-Z0-9_]*\}\}/;
const FORBIDDEN_NON_CLAUDE_PATHS = [
  ".claude/rules/",
  ".claude/agents/",
  ".claude/skills/"
];
const FORBIDDEN_CUSTOM_AGENT = [
  "subagent_type: harness-",
  "spawn `harness-",
  "spawn harness-"
];

function splitFrontmatter(text) {
  if (!text.startsWith("---")) {
    throw new Error("missing YAML frontmatter");
  }
  const end = text.indexOf("\n---", 3);
  if (end < 0) {
    throw new Error("unclosed YAML frontmatter");
  }
  const frontmatter = text.slice(4, end).replace(/^\r?\n/, "");
  const body = text.slice(end + 4).replace(/^\r?\n/, "");
  return { frontmatter, body };
}

function rewriteFrontmatter(text, allow) {
  const { frontmatter, body } = splitFrontmatter(text);
  const data = parseYaml(frontmatter);
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("frontmatter must be a mapping");
  }
  if (allow === null) {
    return {
      text,
      name: data.name,
      description: data.description,
      rewritten: false
    };
  }
  const kept = {};
  for (const key of allow) {
    if (data[key] !== undefined) kept[key] = data[key];
  }
  const serialized = stringifyYaml(kept).trimEnd();
  return {
    text: `---\n${serialized}\n---\n${body}`,
    name: kept.name,
    description: kept.description,
    rewritten: true
  };
}

function scanForbidden(haystack, agent, pathLabel) {
  for (const token of FORBIDDEN_SHARED) {
    if (haystack.includes(token)) {
      throw new Error(`ADAPTER_SEMANTIC_INVALID: ${pathLabel} contains forbidden token ${token}`);
    }
  }
  if (UNFINISHED_PLACEHOLDER.test(haystack)) {
    throw new Error(`ADAPTER_SEMANTIC_INVALID: ${pathLabel} contains unfinished {{PLACEHOLDER}}`);
  }
  if (agent !== "claude-code") {
    for (const token of FORBIDDEN_NON_CLAUDE_PATHS) {
      if (haystack.includes(token)) {
        throw new Error(`ADAPTER_SEMANTIC_INVALID: ${pathLabel} references ${token}`);
      }
    }
  }
  if (agent === "codex" || agent === "cursor") {
    for (const token of FORBIDDEN_CUSTOM_AGENT) {
      if (haystack.includes(token)) {
        throw new Error(
          `ADAPTER_SEMANTIC_INVALID: ${pathLabel} requires custom agent call (${token})`
        );
      }
    }
  }
}

async function listFiles(directory, base = directory) {
  const result = [];
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error && error.code === "ENOENT") return result;
    throw error;
  }
  for (const entry of entries) {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) {
      result.push(...await listFiles(full, base));
    } else if (entry.isFile()) {
      result.push(full.slice(base.length + 1).replaceAll("\\", "/"));
    }
  }
  return result;
}

/**
 * Rewrite frontmatter and semantically validate an agent bundle directory in place.
 * @param {string} dir Absolute path to a built profile×agent bundle directory
 * @param {"claude-code"|"codex"|"cursor"|"codebuddy"} agent
 * @returns {Promise<{ rewritten: string[], validated: string[] }>}
 */
export async function adaptBundleDir(dir, agent) {
  if (!(agent in SKILL_ALLOW)) {
    throw new Error(`unknown agent: ${agent}`);
  }
  const rewritten = [];
  const validated = [];
  const files = await listFiles(dir);

  for (const rel of files) {
    if (!rel.endsWith(".md") && !rel.endsWith(".mdc")) continue;
    // Runtime docs outside skills/agents are not Agent-adapted surfaces.
    if (!rel.startsWith("harness-") && !rel.startsWith("agents/")) continue;

    const isSkill = /^harness-[^/]+\/SKILL\.md$/.test(rel);
    const isAgent = /^agents\/[^/]+\.md$/.test(rel);
    if (!isSkill && !isAgent) {
      const text = await readFile(join(dir, rel), "utf8");
      // Supporting docs (checklist/reference) still must not leak Claude-only paths.
      scanForbidden(text, agent, rel);
      validated.push(rel);
      continue;
    }

    const full = join(dir, rel);
    const original = await readFile(full, "utf8");
    const beforeHash = createHash("sha256").update(original).digest("hex");

    let allow;
    if (isSkill) {
      allow = SKILL_ALLOW[agent];
    } else if (agent === "codebuddy") {
      allow = AGENT_FILE_ALLOW.codebuddy;
    } else if (agent === "claude-code") {
      allow = AGENT_FILE_ALLOW["claude-code"];
    } else {
      throw new Error(`ADAPTER_SEMANTIC_INVALID: unexpected agent file for ${agent}: ${rel}`);
    }

    const result = rewriteFrontmatter(original, allow);
    if (typeof result.name !== "string" || result.name.trim() === "") {
      throw new Error(`ADAPTER_SEMANTIC_INVALID: ${rel} missing name`);
    }
    if (typeof result.description !== "string" || result.description.trim() === "") {
      throw new Error(`ADAPTER_SEMANTIC_INVALID: ${rel} missing description`);
    }
    if (isSkill) {
      const dirName = rel.split("/")[0];
      if (result.name !== dirName) {
        throw new Error(
          `ADAPTER_SEMANTIC_INVALID: ${rel} name "${result.name}" != directory "${dirName}"`
        );
      }
    }

    scanForbidden(result.text, agent, rel);

    if (result.rewritten || createHash("sha256").update(result.text).digest("hex") !== beforeHash) {
      if (result.rewritten) {
        await writeFile(full, result.text.endsWith("\n") ? result.text : result.text + "\n", "utf8");
        rewritten.push(rel);
      }
    } else if (agent === "claude-code") {
      // passthrough: still validate only
    }
    validated.push(rel);
  }

  return { rewritten, validated };
}

export default { adaptBundleDir };
