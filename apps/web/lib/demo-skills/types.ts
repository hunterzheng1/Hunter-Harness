import type { RegistryAgent } from "@hunter-harness/contracts";

export interface DemoSourceFile {
  path: string;
  content: string;
}

export interface DemoAdapterPatch {
  patchSummary: string;
  appendedContent: string;
}

export interface DemoSourcePackage {
  entrypoint: DemoSourceFile;
  files: readonly DemoSourceFile[];
}

export interface DemoSourceSkill {
  slug: string;
  source: DemoSourcePackage;
  adapters: Partial<Record<RegistryAgent, DemoAdapterPatch>>;
  preview(agent: RegistryAgent): string | null;
}
