import type { SKILL_ERROR_CODE } from "@hunter-harness/contracts";

/**
 * Skill 源文件驱动模型的入口/解析错误。
 * 取代旧 SkillIrError（canonical IR 移除后，源文件成为唯一真相源）。
 */
export class SkillEntryError extends Error {
  constructor(
    public readonly code: typeof SKILL_ERROR_CODE.ENTRY_NOT_FOUND | typeof SKILL_ERROR_CODE.FRONTMATTER_INVALID,
    message: string
  ) {
    super(message);
    this.name = "SkillEntryError";
  }
}
