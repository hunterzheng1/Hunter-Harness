export interface ContextIndexOptions {
  rules: string[];
  enabledSkills: string[];
  mapStatus: "missing" | "stale" | "fresh";
  codegraphAvailable: boolean;
}

export function buildContextIndex(options: ContextIndexOptions): object {
  return {
    schema_version: 1,
    project: { claude_md: "CLAUDE.md", agents_md: "AGENTS.md" },
    rules: [...options.rules].sort(),
    knowledge: {
      source: "remote",
      local_index: null,
      query: "npx hunter-harness knowledge query",
      fallback: false
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
      "remote-knowledge",
      "codebase-map",
      "codegraph",
      "source"
    ]
  };
}
