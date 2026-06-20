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

export function highEntropyCandidates(content: string): Array<{
  value: string;
  offset: number;
  entropy: number;
}> {
  const matches = content.matchAll(/\b[A-Za-z0-9_+/.=-]{24,}\b/g);
  return [...matches]
    .map((match) => ({
      value: match[0],
      offset: match.index,
      entropy: shannonEntropy(match[0])
    }))
    .filter((item) => item.entropy >= 4.5);
}
