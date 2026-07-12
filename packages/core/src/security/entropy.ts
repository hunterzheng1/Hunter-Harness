export function shannonEntropy(value: string): number {
  if (value.length === 0) {
    return 0;
  }
  const counts = new Map<string, number>();
  for (const character of value) {
    counts.set(character, (counts.get(character) ?? 0) + 1);
  }
  let entropy = 0;
  for (const count of counts.values()) {
    const probability = count / value.length;
    entropy -= probability * Math.log2(probability);
  }
  return entropy;
}

/** MD5 / Git SHA-1 / SHA-256 hex digests — high unique-char density but not secrets. */
const HEX_DIGEST = /^(?:[a-fA-F0-9]{32}|[a-fA-F0-9]{40}|[a-fA-F0-9]{64})$/;

/**
 * Dotted/kebab knowledge-style ids (e.g. project.change.type.suffix).
 * Must stay stricter than JWT (which mixes case / base64 alphabet).
 */
const STRUCTURED_LOWERCASE_ID =
  /^[a-z0-9]+(?:[.-][a-z0-9]+)+$/;

function isBenignHighEntropyLookalike(value: string): boolean {
  if (HEX_DIGEST.test(value)) {
    return true;
  }
  // Paths were previously matched because "/" sat in the token charset.
  if (value.includes("/")) {
    return true;
  }
  if (STRUCTURED_LOWERCASE_ID.test(value) && (value.match(/\./g) ?? []).length >= 2) {
    return true;
  }
  return false;
}

export function highEntropyCandidates(content: string): Array<{
  value: string;
  offset: number;
  entropy: number;
}> {
  // Intentionally omit "/" so relative paths are not treated as opaque secrets.
  const matches = content.matchAll(/\b[A-Za-z0-9_+.=\-]{24,}\b/g);
  return [...matches]
    .map((match) => ({
      value: match[0],
      offset: match.index,
      entropy: shannonEntropy(match[0])
    }))
    .filter((item) => item.entropy >= 4.5 && !isBenignHighEntropyLookalike(item.value));
}
