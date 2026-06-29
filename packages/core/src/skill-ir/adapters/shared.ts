export function section(title: string, items: readonly string[]): string {
  return "## " + title + "\n\n" + items.map((item) => "- " + item).join("\n");
}
