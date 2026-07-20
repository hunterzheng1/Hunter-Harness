import { parse as parseYaml } from "yaml";
import { z } from "zod";

import {
  SKILL_ERROR_CODE,
  skillFrontmatterSchema,
  type RegistryAgent,
  type SkillFrontmatter,
  type SourceFile
} from "@hunter-harness/contracts";

import { SkillEntryError } from "./errors.js";

/**
 * 匹配 `---\n...\n---\n` 包裹的 YAML frontmatter。闭合 `---` 必须独占一行，
 * 缺失或未闭合 → FRONTMATTER_INVALID（UT-002 / UT-002c）。
 */
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

function formatFrontmatterError(error: unknown): string {
  if (error instanceof z.ZodError) {
    const issues = error.issues;
    if (issues.length === 0) return "frontmatter 校验失败";
    const parts = issues.map((i) => {
      const path = i.path.join(".") || "(root)";
      // Zod 4 invalid_type 无 received 字段，通过 message 判断是否缺字段
      if (i.code === "invalid_type" && i.message.toLowerCase().includes("received undefined")) {
        return `缺少必填字段 ${path}`;
      }
      return `${path}: ${i.message}`;
    });
    return "frontmatter 校验失败: " + parts.join("; ");
  }
  return "frontmatter 校验失败: " + (error as Error).message;
}

/**
 * 解析 SKILL.md frontmatter 为结构化元数据。.passthrough() 保留未声明字段（author/tags/license）。
 * 无 frontmatter / 未闭合 / YAML 解析失败 / schema 校验失败 → SkillEntryError("FRONTMATTER_INVALID")。
 */
export function parseFrontmatter(content: string): SkillFrontmatter {
  const match = FRONTMATTER_RE.exec(content);
  if (match === null) {
    throw new SkillEntryError(SKILL_ERROR_CODE.FRONTMATTER_INVALID, "no frontmatter block found (missing leading/trailing ---)");
  }
  const raw = match[1] ?? "";
  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (error) {
    throw new SkillEntryError(SKILL_ERROR_CODE.FRONTMATTER_INVALID, "frontmatter YAML parse failed: " + (error as Error).message);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new SkillEntryError(SKILL_ERROR_CODE.FRONTMATTER_INVALID, "frontmatter must be a YAML mapping");
  }
  try {
    return skillFrontmatterSchema.parse(parsed);
  } catch (error) {
    throw new SkillEntryError(SKILL_ERROR_CODE.FRONTMATTER_INVALID, formatFrontmatterError(error));
  }
}

/**
 * Native skills use SKILL.md for all active agents. Cursor's historical .mdc
 * entry remains a read-only fallback for v2 artifacts.
 * 找不到 → SkillEntryError("SKILL_ENTRY_NOT_FOUND")。
 */
export function findEntryFile(files: SourceFile[], agent: RegistryAgent): SourceFile {
  const nativeMatches = files.filter((file) => /(^|\/)SKILL\.md$/i.test(file.path));
  const matches = nativeMatches.length > 0
    ? nativeMatches
    : agent === "cursor"
      ? files.filter((file) => /(^|\/)[^/]+\.mdc$/i.test(file.path))
      : [];
  if (matches.length === 0) {
    throw new SkillEntryError(SKILL_ERROR_CODE.ENTRY_NOT_FOUND, `no ${agent === "cursor" ? ".mdc" : "SKILL.md"} entry found for agent ${agent}`);
  }
  // 取最浅路径的 entry（根级优先）
  matches.sort((a, b) => a.path.split("/").length - b.path.split("/").length);
  const entry = matches[0];
  if (entry === undefined) {
    throw new SkillEntryError(SKILL_ERROR_CODE.ENTRY_NOT_FOUND, `no entry found for agent ${agent}`);
  }
  return entry;
}
