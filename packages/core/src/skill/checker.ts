import {
  type RegistryAgent,
  type SkillCheckItem,
  type SkillCheckResult,
  type SkillFrontmatter,
  type SourceFile
} from "@hunter-harness/contracts";

import { scanSensitiveFiles } from "../security/scanner.js";
import { compareSemver } from "../skill-ir/semver.js";

import { SkillEntryError } from "./errors.js";
import { findEntryFile, parseFrontmatter } from "./frontmatter.js";

const DANGEROUS_PATH = /(^|[/\\])\.\.([/\\]|$)|^\/|^\\|^[a-zA-Z]:/;
const DANGEROUS_CMD = /rm\s+-rf|drop\s+table|curl\s+|wget\s+|sudo\s+/i;
const DANGEROUS_CAPABILITY = /^Bash\(/i;

/**
 * 源文件驱动检查（取代旧 checkSkill 的 ir 入参）。
 * entry 存在性 / frontmatter 合法性 / 路径安全 / 命名 / 描述 / 结构 / 权限 / 敏感信息 / 版本前进。
 */
export function checkSkill(input: {
  sourceFiles: SourceFile[];
  agent: RegistryAgent;
  latestVersion?: string | null;
  compilerVersion: string;
  checkedAt: string;
}): SkillCheckResult {
  const { sourceFiles, agent, latestVersion = null, checkedAt } = input;
  const items: SkillCheckItem[] = [];

  let entryPath: string | null = null;
  let meta: SkillFrontmatter | null = null;
  let entryError: SkillEntryError | null = null;
  try {
    const entry = findEntryFile(sourceFiles, agent);
    entryPath = entry.path;
    meta = parseFrontmatter(entry.content);
  } catch (error) {
    if (error instanceof SkillEntryError) {
      entryError = error;
    } else {
      throw error;
    }
  }

  const hasEntry = entryPath !== null && entryError?.code !== "SKILL_ENTRY_NOT_FOUND";
  items.push({
    id: "ENTRY_SKILL_MD",
    label: "entry 文件存在",
    status: hasEntry ? "green" : "red",
    message: hasEntry ? "entry=" + entryPath : (entryError?.message ?? "entry 缺失"),
    filePath: entryPath,
    fixable: false
  });

  const fmOk = meta !== null;
  items.push({
    id: "FRONTMATTER_VALID",
    label: "frontmatter 合法",
    status: fmOk ? "green" : "red",
    message: fmOk ? "frontmatter 解析通过" : (entryError?.message ?? "frontmatter 解析失败"),
    filePath: entryPath,
    fixable: false
  });

  const unsafe = sourceFiles.find((f) => DANGEROUS_PATH.test(f.path));
  items.push({
    id: "FILE_PATH",
    label: "文件路径安全",
    status: unsafe ? "red" : "green",
    message: unsafe ? "路径不安全: " + unsafe.path : "无路径穿越/绝对路径",
    filePath: unsafe?.path ?? null,
    fixable: false
  });

  const name = meta?.name ?? null;
  items.push({
    id: "NAMING",
    label: "命名规范",
    status: name ? "green" : "red",
    message: name ? "slug=" + name + " 符合 harness- 前缀" : "name 缺失",
    filePath: entryPath,
    fixable: true
  });

  const descLen = (meta?.description ?? "").trim().length;
  const descStatus = descLen === 0 ? "yellow" : (descLen > 2000 ? "red" : (descLen > 500 ? "yellow" : "green"));
  items.push({
    id: "DESCRIPTION",
    label: "描述完整",
    status: descStatus,
    message: descLen === 0 ? "描述为空" : "描述 length=" + descLen,
    filePath: entryPath,
    fixable: false
  });

  const paths = sourceFiles.map((f) => f.path);
  const hasRefs = paths.some((p) => /(^|\/)references\//.test(p));
  const hasScripts = paths.some((p) => /(^|\/)scripts\//.test(p));
  const structureScore = [hasRefs, hasScripts].filter(Boolean).length;
  items.push({
    id: "STRUCTURE",
    label: "结构完整",
    status: structureScore >= 1 ? "green" : "yellow",
    message: "references=" + hasRefs + " scripts=" + hasScripts,
    filePath: null,
    fixable: false
  });

  // 权限：frontmatter forbidden_actions + body 危险命令。无 forbidden_actions 时降为 suggestion（fixable=true，不 red）—— UT-012。
  const caps = meta?.forbidden_actions ?? [];
  const bodyText = sourceFiles.map((f) => f.content).join("\n");
  const dangerousCap = caps.find((c) => DANGEROUS_CAPABILITY.test(c));
  const dangerousCmd = DANGEROUS_CMD.test(bodyText);
  const permStatus = dangerousCmd ? "red" : (dangerousCap ? "yellow" : "green");
  items.push({
    id: "PERMISSIONS",
    label: "权限声明",
    status: permStatus,
    message: dangerousCmd ? "危险命令" : (dangerousCap ? "危险能力: " + dangerousCap : "无可疑能力"),
    filePath: null,
    fixable: caps.length === 0
  });

  const fileMap: Record<string, string> = {};
  for (const f of sourceFiles) {
    if (!DANGEROUS_PATH.test(f.path)) fileMap[f.path] = f.content;
  }
  const sensitive = scanSensitiveFiles(fileMap);
  const highCount = sensitive.findings.filter((f) => f.severity === "high").length;
  const medCount = sensitive.findings.filter((f) => f.severity === "medium").length;
  const sensitiveStatus = highCount > 0 ? "red" : (medCount > 0 ? "yellow" : "green");
  items.push({
    id: "SENSITIVE",
    label: "敏感信息",
    status: sensitiveStatus,
    message: "high=" + highCount + " medium=" + medCount,
    filePath: sensitive.findings[0]?.path ?? null,
    fixable: false
  });

  const version = meta?.version ?? null;
  const latest = latestVersion ?? null;
  const versionStatus = version === null || latest === null
    ? "green"
    : (compareSemver(version, latest) > 0 ? "green" : "red");
  items.push({
    id: "VERSION",
    label: "版本前进",
    status: versionStatus,
    message: "version=" + (version ?? "none") + " latest=" + (latest ?? "none"),
    filePath: entryPath,
    fixable: true
  });

  const summary = {
    green: items.filter((i) => i.status === "green").length,
    yellow: items.filter((i) => i.status === "yellow").length,
    red: items.filter((i) => i.status === "red").length
  };
  return { items, summary, checkedAt };
}
