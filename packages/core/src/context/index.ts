export interface ContextIndexOptions {
  rules: string[];
  enabledSkills: string[];
  mapStatus: "missing" | "stale" | "fresh";
  codegraphAvailable: boolean;
  knowledgeIndexHash: string | null;
}

export function buildContextIndex(options: ContextIndexOptions): object {
  return {
    schema_version: 1,
    project: { claude_md: "CLAUDE.md", agents_md: "AGENTS.md" },
    rules: [...options.rules].sort(),
    knowledge: {
      index: ".harness/knowledge/index.json",
      hash: options.knowledgeIndexHash
    },
    codebase: {
      map: ".harness/codebase/map",
      summary: ".harness/codebase/map-summary.md",
      status: options.mapStatus
    },
    skills: [...options.enabledSkills].sort(),
    integrations: {
      codegraph: {
        available: options.codegraphAvailable,
        managed: false,
        usage: "Use colbymchenry/codegraph through its official interface when available."
      }
    },
    routing_order: [
      "project-guidance",
      "rules",
      "skill",
      "knowledge",
      "codebase-map",
      "codegraph",
      "source"
    ]
  };
}
