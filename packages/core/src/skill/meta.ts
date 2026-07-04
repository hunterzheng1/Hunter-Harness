import type { RegistryAgent, SourceFile } from "@hunter-harness/contracts";

import { findEntryFile, parseFrontmatter } from "./frontmatter.js";

/**
 * 从 entry 文件 frontmatter 的 name 字段派生 slug。
 * name 已由 skillFrontmatterSchema 校验为 `^[a-z0-9]+(?:-[a-z0-9]+)*$` + ≤64 字符（与 registrySlugSchema 同源，不允许连续/尾连字符），与 slug 同形。
 * 无 entry / frontmatter 无 name → 抛 SkillEntryError。
 */
export function deriveSlug(files: SourceFile[], agent: RegistryAgent): string {
  const entry = findEntryFile(files, agent);
  const meta = parseFrontmatter(entry.content);
  return meta.name;
}
