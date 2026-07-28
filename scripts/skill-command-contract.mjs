const COMMAND_PATTERN =
  /(?:^|[\s`])(?:npx\s+)?hunter-harness(?:@[^\s`]+)?\s+([a-z][a-z0-9-]*)\b/gm;

export function extractHunterHarnessCommands(content) {
  return [...new Set(
    [...content.matchAll(COMMAND_PATTERN)].map((match) => match[1])
  )].sort((left, right) => left.localeCompare(right));
}
