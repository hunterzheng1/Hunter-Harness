import { assertNoCaseCollisions, normalizeManagedPath } from "../fs/path-safety.js";
import {
  AdapterBundleError,
  FIXED_PROFILE,
  PROJECTION_SURFACES,
  validateRelativeBundlePath,
  type LoadedAgentBundle,
  type ProjectedBundleFile,
  type ProjectionSurface
} from "./profile-bundle.js";

// v1.0 fixed projection: the 5-agent × 2-profile selection matrix is gone.
// Every project gets the same canonical surface — `.agents/skills` + `AGENTS.md`
// (the agents.md standard) — plus an unconditional CodeBuddy skills double-write
// at `.codebuddy/skills`. The surface keys double as the identity keys baked
// into bundle build markers and validated by the gate (`harness_gate.py`).
export { FIXED_PROFILE, PROJECTION_SURFACES };
export type { ProjectionSurface };
export const CANONICAL_SURFACE: ProjectionSurface = "codex";
export const CODEBUDDY_SURFACE: ProjectionSurface = "codebuddy";

export const PRIMARY_SKILLS_ROOT = ".agents/skills";
export const CODEBUDDY_SKILLS_ROOT = ".codebuddy/skills";
export const INSTRUCTION_FILE = "AGENTS.md";

const SKILLS_ROOTS: Record<ProjectionSurface, string> = {
  codex: PRIMARY_SKILLS_ROOT,
  codebuddy: CODEBUDDY_SKILLS_ROOT
};

export function skillsRootFor(surface: ProjectionSurface): string {
  const root = SKILLS_ROOTS[surface];
  // 类型边界之外的调用方（反序列化输入等）必须 fail-closed，而非返回 undefined。
  if (root === undefined) {
    throw new AdapterBundleError(
      "ADAPTER_BUNDLE_INVALID",
      `unknown projection surface: ${surface as string}`
    );
  }
  return root;
}

export interface ContextIndexEntry {
  instructions: string;
  skills_root: string;
  rules: string[];
}

export function contextIndexEntryFor(surface: ProjectionSurface): ContextIndexEntry {
  // `.harness/rules/` projections are retired; the field stays (empty) because
  // context-index consumers (gate, push, doctor) read it.
  return { instructions: INSTRUCTION_FILE, skills_root: skillsRootFor(surface), rules: [] };
}

/** Directories whose managed files may be pruned when no longer shipped. */
export function pruneBoundaries(): string[] {
  return [PRIMARY_SKILLS_ROOT, CODEBUDDY_SKILLS_ROOT];
}

function projectBundleFiles(bundle: LoadedAgentBundle, skillsRoot: string): ProjectedBundleFile[] {
  const records: ProjectedBundleFile[] = [];
  const seenTargets = new Map<string, string>();
  for (const [sourcePath, bytes] of bundle.files) {
    validateRelativeBundlePath(sourcePath);
    // v1.0: bundle `agents/` definitions (custom subagent docs) are no longer
    // installed on any surface; everything else projects under the skills root.
    if (sourcePath.startsWith("agents/")) continue;
    const target = normalizeManagedPath(`${skillsRoot}/${sourcePath}`);
    const manifestEntry = bundle.manifest.files.find((entry) => entry.path === sourcePath);
    if (manifestEntry === undefined) {
      throw new Error(`Harness Bundle missing manifest entry: ${sourcePath}`);
    }
    const existing = seenTargets.get(target);
    if (existing !== undefined && existing !== sourcePath) {
      throw new AdapterBundleError(
        "ADAPTER_BUNDLE_INVALID",
        `bundle file collision: "${sourcePath}" and "${existing}" both project to "${target}"`
      );
    }
    seenTargets.set(target, sourcePath);
    records.push({
      source_path: sourcePath,
      target_path: target,
      sha256: manifestEntry.sha256,
      bytes
    });
  }
  assertNoCaseCollisions(records.map((record) => record.target_path));
  return records;
}

/** Project a loaded bundle onto one fixed surface (skills only). */
export function projectBundleToSurface(
  bundle: LoadedAgentBundle,
  surface: ProjectionSurface
): ProjectedBundleFile[] {
  return projectBundleFiles(bundle, skillsRootFor(surface));
}
