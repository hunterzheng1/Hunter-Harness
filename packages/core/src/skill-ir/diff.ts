import type { SkillDiffFile, SourceFile } from "@hunter-harness/contracts";

export function computeDiff(published: SourceFile[], draft: SourceFile[]): SkillDiffFile[] {
  const pubMap = new Map<string, string>();
  for (const f of published) pubMap.set(f.path, f.content);
  const draftMap = new Map<string, string>();
  for (const f of draft) draftMap.set(f.path, f.content);
  const result: SkillDiffFile[] = [];
  const paths = new Set<string>([...pubMap.keys(), ...draftMap.keys()]);
  for (const path of paths) {
    const pubContent = pubMap.get(path);
    const draftContent = draftMap.get(path);
    if (pubContent === undefined && draftContent !== undefined) {
      result.push({ path, status: "added", publishedContent: null, draftContent });
    } else if (pubContent !== undefined && draftContent === undefined) {
      result.push({ path, status: "removed", publishedContent: pubContent, draftContent: null });
    } else if (pubContent !== undefined && draftContent !== undefined && pubContent !== draftContent) {
      result.push({ path, status: "modified", publishedContent: pubContent, draftContent });
    }
  }
  return result;
}
