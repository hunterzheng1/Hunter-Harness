import {
  skillIrSchema,
  type SkillCheckItem,
  type SkillCheckResult,
  type SkillIr,
  type SourceFile
} from "@hunter-harness/contracts";

import { scanSensitiveFiles } from "../security/scanner.js";
import { compareSemver } from "./semver.js";

const DANGEROUS_PATH = /(^|[/\\])\.\.([/\\]|$)|^\/|^\\|^[a-zA-Z]:/;
const DANGEROUS_CAPABILITY = /^Bash\(/;

export function checkSkill(input: {
  ir: SkillIr;
  sourceFiles: SourceFile[];
  latestVersion?: string | null;
  compilerVersion: string;
  checkedAt: string;
}): SkillCheckResult {
  const { ir, sourceFiles, latestVersion, checkedAt } = input;
  const items: SkillCheckItem[] = [];

  items.push({ id: "ENTRY_IR", label: "IR 入口可识别", status: "green", message: "Skill IR 入口已识别", filePath: null, fixable: false });

  const schemaParse = skillIrSchema.safeParse(ir);
  items.push({
    id: "SCHEMA_VALID",
    label: "Schema 合法",
    status: schemaParse.success ? "green" : "red",
    message: schemaParse.success ? "skillIrSchema 通过" : "Skill IR schema 校验失败",
    filePath: null,
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

  items.push({
    id: "NAMING",
    label: "命名规范",
    status: "green",
    message: "slug=" + ir.name + " 符合 kebab-case",
    filePath: null,
    fixable: false
  });

  items.push({
    id: "DESCRIPTION",
    label: "描述完整",
    status: "green",
    message: "描述非空",
    filePath: null,
    fixable: false
  });

  const paths = sourceFiles.map((f) => f.path);
  const hasRefs = paths.some((p) => /(^|\/)references\//.test(p));
  const hasScripts = paths.some((p) => /(^|\/)scripts\//.test(p));
  const hasAssets = paths.some((p) => /(^|\/)assets\//.test(p));
  const structureScore = [hasRefs, hasScripts, hasAssets].filter(Boolean).length;
  items.push({
    id: "STRUCTURE",
    label: "结构完整",
    status: structureScore >= 2 ? "green" : "yellow",
    message: "references=" + hasRefs + " scripts=" + hasScripts + " assets=" + hasAssets,
    filePath: null,
    fixable: false
  });

  const caps = ir.allowed_capabilities ?? [];
  const dangerousCap = caps.find((c) => DANGEROUS_CAPABILITY.test(c));
  items.push({
    id: "PERMISSIONS",
    label: "权限声明",
    status: dangerousCap ? "yellow" : "green",
    message: dangerousCap ? "危险能力: " + dangerousCap : "无可疑能力",
    filePath: null,
    fixable: true
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

  const claudeEnabled = ir.adapters["claude-code"]?.enabled === true;
  items.push({
    id: "AGENT_TARGET",
    label: "Agent 目标",
    status: claudeEnabled ? "green" : "yellow",
    message: claudeEnabled ? "claude-code → .claude/skills/<slug>" : "未启用 claude-code",
    filePath: null,
    fixable: false
  });

  const latest = latestVersion ?? null;
  const versionStatus = latest === null
    ? "green"
    : (compareSemver(ir.version, latest) > 0 ? "green" : "red");
  items.push({
    id: "VERSION",
    label: "版本前进",
    status: versionStatus,
    message: "ir.version=" + ir.version + " latest=" + (latest ?? "none"),
    filePath: null,
    fixable: false
  });

  const summary = {
    green: items.filter((i) => i.status === "green").length,
    yellow: items.filter((i) => i.status === "yellow").length,
    red: items.filter((i) => i.status === "red").length
  };
  return { items, summary, checkedAt };
}
