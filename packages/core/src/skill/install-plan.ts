import { isAbsolute, join, relative, resolve } from "node:path";

import type {
  AuthorSkillBundleManifest,
  SkillBundleComponent,
  SkillTargetAgent,
  SkillVariantStatus
} from "@hunter-harness/contracts";

import {
  getAgentSurface,
  resolveSkillDestination,
  resolveSubagentDestination,
  type SkillInstallScope
} from "./agent-surfaces.js";

export interface SkillInstallOperation {
  readonly agent: SkillTargetAgent;
  readonly role: "skill" | "subagent";
  readonly sourcePath: string;
  readonly destinationPath: string;
}

export interface SkillInstallVariantPlan {
  readonly agent: SkillTargetAgent;
  readonly status: SkillVariantStatus;
  readonly operations: readonly SkillInstallOperation[];
  readonly warnings: readonly string[];
}

export interface SkillInstallPlan {
  readonly slug: string;
  readonly scope: SkillInstallScope;
  readonly variants: readonly SkillInstallVariantPlan[];
  readonly operations: readonly SkillInstallOperation[];
}

export interface PlanSkillInstallInput {
  readonly slug: string;
  readonly agents: readonly SkillTargetAgent[];
  readonly scope: SkillInstallScope;
  readonly projectRoot?: string;
  readonly userHome?: string;
  readonly files: readonly string[];
  readonly manifest?: AuthorSkillBundleManifest;
}

function normalizeSourcePath(path: string): string {
  const normalized = path.replaceAll("\\", "/");
  if (normalized.length === 0 || normalized.includes("\0") ||
      normalized.startsWith("/") || /^[A-Za-z]:/.test(normalized) ||
      normalized.split("/").some((part) => part === "" || part === "." || part === "..")) {
    throw new Error(`invalid bundle file path: ${path}`);
  }
  return normalized;
}

function rootFor(input: PlanSkillInstallInput): string {
  const root = input.scope === "project" ? input.projectRoot : input.userHome;
  if (root === undefined || root.trim() === "") {
    throw new Error(`${input.scope} installation root is required`);
  }
  return resolve(root);
}

function relativeWithin(source: string, candidate: string): string | null {
  if (source === ".") return candidate;
  return candidate === source ? candidate.split("/").at(-1) ?? null :
    candidate.startsWith(source + "/") ? candidate.slice(source.length + 1) : null;
}

function assertWithin(destinationRoot: string, destination: string): string {
  const remainder = relative(resolve(destinationRoot), resolve(destination));
  if (remainder === "" || (!remainder.startsWith("..") && !isAbsolute(remainder))) {
    return resolve(destination);
  }
  throw new Error(`planned destination escapes install root: ${destination}`);
}

export function planSkillInstall(input: PlanSkillInstallInput): SkillInstallPlan {
  const root = rootFor(input);
  const files = [...new Set(input.files.map(normalizeSourcePath))].sort();
  if (!files.some((path) => path === "SKILL.md" || path.endsWith("/SKILL.md"))) {
    throw new Error("skill bundle requires SKILL.md");
  }
  const components: readonly SkillBundleComponent[] = input.manifest?.components ?? [{
    role: "skill",
    source: "."
  }];
  for (const component of components) {
    if (component.role !== "skill") continue;
    const entry = component.source === "." ? "SKILL.md" : `${normalizeSourcePath(component.source)}/SKILL.md`;
    if (!files.includes(entry)) throw new Error(`skill component is missing SKILL.md: ${component.source}`);
  }
  const reservedVariantFiles = new Set(components.flatMap((component) =>
    component.role === "subagent" ? Object.values(component.variants ?? {}) : []
  ));
  const variants: SkillInstallVariantPlan[] = [];

  for (const agent of [...new Set(input.agents)]) {
    const surface = getAgentSurface(agent);
    const operations: SkillInstallOperation[] = [];
    const warnings: string[] = [];
    let status: SkillVariantStatus = "ready";
    for (const component of components) {
      if (component.role === "skill") {
        const destinationRoot = resolveSkillDestination(surface, input.scope, root, input.slug);
        for (const file of files) {
          if (file === "hunter-skill.yaml" || file === "hunter-skill.yml" || reservedVariantFiles.has(file)) continue;
          const componentRelative = relativeWithin(component.source, file);
          if (componentRelative === null) continue;
          operations.push({
            agent,
            role: "skill",
            sourcePath: file,
            destinationPath: assertWithin(destinationRoot, join(destinationRoot, componentRelative))
          });
        }
        continue;
      }
      const sourcePath = component.variants?.[agent];
      if (sourcePath === undefined) {
        status = "degraded";
        warnings.push(`subagent ${component.name ?? "unknown"} has no ${agent} variant`);
        continue;
      }
      if (!files.includes(sourcePath)) {
        throw new Error(`subagent variant file is missing: ${sourcePath}`);
      }
      const expectedExtension = surface.subagentExtension;
      if (!sourcePath.endsWith(expectedExtension)) {
        throw new Error(`${agent} subagent must use ${expectedExtension}`);
      }
      const destination = resolveSubagentDestination(
        surface,
        input.scope,
        root,
        component.name ?? "subagent"
      );
      operations.push({ agent, role: "subagent", sourcePath, destinationPath: destination });
    }
    if (!operations.some((operation) => operation.role === "skill")) {
      throw new Error(`${agent} variant has no skill files`);
    }
    const destinations = new Set<string>();
    for (const operation of operations) {
      if (destinations.has(operation.destinationPath)) {
        throw new Error(`duplicate install destination: ${operation.destinationPath}`);
      }
      destinations.add(operation.destinationPath);
    }
    variants.push({ agent, status, operations, warnings });
  }

  return {
    slug: input.slug,
    scope: input.scope,
    variants,
    operations: variants.flatMap((variant) => variant.operations)
  };
}
