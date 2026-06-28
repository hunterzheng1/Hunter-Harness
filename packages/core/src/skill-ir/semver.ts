export function compareSemver(left: string, right: string): number {
  const leftParts = left.split(".").map(Number);
  const rightParts = right.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

export function bumpPatch(version: string): string {
  const parts = version.split(".").map(Number);
  return (parts[0] ?? 0) + "." + (parts[1] ?? 0) + "." + ((parts[2] ?? 0) + 1);
}
