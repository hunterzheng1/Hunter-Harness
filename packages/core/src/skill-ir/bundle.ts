import { readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  canonicalJson,
  type SkillIr
} from "@hunter-harness/contracts";
import { parse as parseYaml } from "yaml";

import { sha256Bytes } from "../fs/hash.js";
import { normalizeSkillIr } from "./normalize.js";

interface BundleManifest {
  schema_version: 1;
  registry_version: string;
  compiler_version: string;
  skills: string[];
}

export interface BootstrapBundle {
  registryVersion: string;
  compilerVersion: string;
  bundleHash: string;
  skills: SkillIr[];
}

export async function loadBootstrapBundle(root: string): Promise<BootstrapBundle> {
  const manifest = JSON.parse(
    await readFile(join(root, "manifest.json"), "utf8")
  ) as BundleManifest;
  if (manifest.schema_version !== 1) {
    throw new Error("unsupported bootstrap bundle schema version");
  }
  const skills = [];
  for (const name of manifest.skills) {
    const value = parseYaml(
      await readFile(join(root, "skills", name + ".yaml"), "utf8")
    ) as SkillIr;
    skills.push(normalizeSkillIr(value));
  }
  skills.sort((left, right) => left.name.localeCompare(right.name));
  return {
    registryVersion: manifest.registry_version,
    compilerVersion: manifest.compiler_version,
    bundleHash: sha256Bytes(canonicalJson({
      registry_version: manifest.registry_version,
      compiler_version: manifest.compiler_version,
      skills
    })),
    skills
  };
}
