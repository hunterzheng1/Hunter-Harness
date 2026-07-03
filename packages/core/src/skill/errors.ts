/**
 * Skill 源文件驱动模型的入口/解析错误。
 * 取代旧 SkillIrError（canonical IR 移除后，源文件成为唯一真相源）。
 */
export class SkillEntryError extends Error {
  constructor(
    public readonly code: "SKILL_ENTRY_NOT_FOUND" | "FRONTMATTER_INVALID",
    message: string
  ) {
    super(message);
    this.name = "SkillEntryError";
  }
}
