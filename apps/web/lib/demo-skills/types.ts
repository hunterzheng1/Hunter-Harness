import type { RegistryAgent, SkillCheckItem, SkillDiffFile } from "@hunter-harness/contracts";

export type DemoAgent = RegistryAgent | "cursor";

export interface DemoSourceFile {
  path: string;
  content: string;
}

export interface DemoAdapterPatch {
  patchSummary: string;
  appendedContent: string;
}

export interface DemoAgentVersion {
  version: string;
  sourceLabel: string;
  releasedAt: string;
  sourceHash: string;
  artifactHash: string;
  targetPath: string;
  fileCount: number;
  status: "published" | "draft";
}

export interface DemoUsageExample {
  title: string;
  description: string;
  request: string;
  result: string;
  files?: readonly string[];
}

export interface DemoAgentConfig {
  agent: DemoAgent;
  label: string;
  configured: boolean;
  default: boolean;
  fallbackFrom?: DemoAgent;
  targetPath: string;
  latestVersion?: DemoAgentVersion;
  draftVersion?: DemoAgentVersion;
  checks: readonly SkillCheckItem[];
  diffFiles?: readonly SkillDiffFile[];
  metrics: {
    files: number;
    green: number;
    yellow: number;
    red: number;
    suggestions: number;
  };
  uploadHint: string;
}

export interface DemoSourcePackage {
  entrypoint: DemoSourceFile;
  files: readonly DemoSourceFile[];
}

export interface DemoSourceSkill {
  slug: string;
  defaultAgent: DemoAgent;
  source: DemoSourcePackage;
  examples: readonly DemoUsageExample[];
  agents: readonly DemoAgentConfig[];
  adapters: Partial<Record<DemoAgent, DemoAdapterPatch>>;
  preview(agent: DemoAgent): string | null;
}
