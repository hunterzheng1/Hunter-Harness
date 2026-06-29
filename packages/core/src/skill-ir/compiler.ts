import {
  canonicalJson,
  type RegistryAgent,
  type SkillIr
} from "@hunter-harness/contracts";

import { sha256Bytes } from "../fs/hash.js";
import { ADAPTERS } from "./adapters/index.js";
import {
  mergeSkillIr,
  type SkillOverlay
} from "./overlay.js";

export interface CompileSkillOptions {
  profile: string;
  projectOverride?: SkillOverlay;
  adapter: RegistryAgent;
  compilerVersion: string;
}

export interface CompiledSkill {
  path: string;
  content: string;
  sourceIrHash: string;
  compilerVersion: string;
  adapter: string;
}

export function compileSkill(
  source: SkillIr,
  options: CompileSkillOptions
): CompiledSkill {
  const merged = mergeSkillIr(source, options);
  const sourceIrHash = sha256Bytes(canonicalJson(merged));
  const descriptor = ADAPTERS[options.adapter];
  return {
    path: descriptor.targetPath(merged),
    content: descriptor.render(merged, sourceIrHash, options.compilerVersion),
    sourceIrHash,
    compilerVersion: options.compilerVersion,
    adapter: options.adapter
  };
}
