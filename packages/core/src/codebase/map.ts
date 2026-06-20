export const CODEBASE_MAP_DOCUMENTS = [
  "STACK.md",
  "INTEGRATIONS.md",
  "ARCHITECTURE.md",
  "STRUCTURE.md",
  "CONVENTIONS.md",
  "TESTING.md",
  "CONCERNS.md"
] as const;

export interface CodebaseMapManifest {
  generated_at: string;
  source_revision: string | null;
  documents: string[];
}

export interface CodebaseMapAssessment {
  status: "missing" | "stale" | "fresh";
  recommend_refresh: boolean;
  auto_run: false;
  reason: string;
}

export function validateCodebaseMapArtifacts(
  files: Readonly<Record<string, string>>
): Array<{ path: string; file_kind: "generated_reviewable" }> {
  for (const name of CODEBASE_MAP_DOCUMENTS) {
    const content = files[name];
    if (content === undefined) {
      throw new Error("missing codebase map document: " + name);
    }
    if (content.trim() === "") {
      throw new Error("empty codebase map document: " + name);
    }
  }
  return CODEBASE_MAP_DOCUMENTS.map((name) => ({
    path: ".harness/codebase/map/" + name,
    file_kind: "generated_reviewable" as const
  }));
}

export function assessCodebaseMap(
  manifest: CodebaseMapManifest | null,
  now = new Date(),
  maxAgeDays = 7
): CodebaseMapAssessment {
  if (manifest === null) {
    return {
      status: "missing",
      recommend_refresh: true,
      auto_run: false,
      reason: "map manifest is missing"
    };
  }
  const missing = CODEBASE_MAP_DOCUMENTS.find(
    (name) => !manifest.documents.includes(name)
  );
  if (missing !== undefined) {
    return {
      status: "stale",
      recommend_refresh: true,
      auto_run: false,
      reason: "map manifest is incomplete: " + missing
    };
  }
  const generatedAt = Date.parse(manifest.generated_at);
  if (!Number.isFinite(generatedAt)) {
    return {
      status: "stale",
      recommend_refresh: true,
      auto_run: false,
      reason: "map generated_at is invalid"
    };
  }
  const stale = now.getTime() - generatedAt > maxAgeDays * 24 * 60 * 60 * 1000;
  return stale
    ? {
      status: "stale",
      recommend_refresh: true,
      auto_run: false,
      reason: "map is older than " + maxAgeDays + " days"
    }
    : {
      status: "fresh",
      recommend_refresh: false,
      auto_run: false,
      reason: "map is current"
    };
}
