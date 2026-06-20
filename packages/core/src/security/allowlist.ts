export interface InlineIgnore {
  ruleId: string;
  reason: string;
}

export function parseInlineIgnores(content: string): InlineIgnore[] {
  return [...content.matchAll(
    /hunter-harness-ignore:\s*([A-Z0-9_]+)\s+reason=([A-Za-z0-9._-]+)/g
  )].map((match) => ({
    ruleId: match[1] ?? "",
    reason: match[2] ?? "unspecified"
  }));
}
