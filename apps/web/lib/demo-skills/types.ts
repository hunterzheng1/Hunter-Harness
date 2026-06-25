import type { RegistryAgent } from "@hunter-harness/contracts";

export type DemoAgent = RegistryAgent | "cursor";

export type DemoCheckStatus = "green" | "yellow" | "red";

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

export interface DemoAgentCheck {
  id: string;
  label: string;
  status: DemoCheckStatus;
  message: string;
  filePath?: string;
  fixable?: boolean;
}

export interface DemoAgentDiffFile {
  path: string;
  status: "modified" | "added" | "removed";
  publishedContent: string;
  draftContent: string;
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
  checks: readonly DemoAgentCheck[];
  diffFiles?: readonly DemoAgentDiffFile[];
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
