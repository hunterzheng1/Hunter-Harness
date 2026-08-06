export const CLI_CAPABILITIES = [
  "sync@1",
  "sync@2",
  "rules-sync@1",
  "rules-review@1",
  "knowledge-sync@2",
  "knowledge-sync@3",
  "build-profile@3",
  "verification-graph@1",
  "execution-session@1",
  "external-convergence@1",
  "codegraph-status@1",
  "codegraph-status@2",
  "doctor-capability@1",
  "registry-governance@1",
  "progress-sync@1",
  "headless-stage@1"
] as const;

export interface WorkflowRequirements {
  minimumCliVersion?: unknown;
  capabilities?: unknown;
  requires?: unknown;
}

export interface CliCompatibilityIdentity {
  cliVersion: string;
  capabilities: readonly string[];
}

export interface WorkflowCompatibility {
  compatible: boolean;
  minimumCliVersion: string | null;
  missingCapabilities: string[];
  reasonCode: "OK" | "BLOCKED_CAPABILITY_MISMATCH";
}

export class WorkflowCompatibilityError extends Error {
  readonly code = "BLOCKED_CAPABILITY_MISMATCH";
  readonly exitCode = 7;
  readonly compatibility: WorkflowCompatibility;

  constructor(compatibility: WorkflowCompatibility, cliVersion: string) {
    const upgrade = compatibility.minimumCliVersion === null
      ? ""
      : `；请升级 hunter-harness 至 >= ${compatibility.minimumCliVersion}`;
    const missing = compatibility.missingCapabilities.length === 0
      ? ""
      : `；缺少能力：${compatibility.missingCapabilities.join(", ")}`;
    super(`BLOCKED_CAPABILITY_MISMATCH: CLI ${cliVersion} 与 workflow 不兼容${upgrade}${missing}`);
    this.name = "WorkflowCompatibilityError";
    this.compatibility = compatibility;
  }
}

function parseVersion(value: string): [number, number, number] | null {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(value);
  if (match === null) return null;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  return [major, minor, patch];
}

export function versionAtLeast(actual: string, minimum: string): boolean {
  const left = parseVersion(actual);
  const right = parseVersion(minimum);
  if (left === null || right === null) return false;
  for (let index = 0; index < 3; index += 1) {
    const leftPart = left[index] ?? 0;
    const rightPart = right[index] ?? 0;
    if (leftPart > rightPart) return true;
    if (leftPart < rightPart) return false;
  }
  return true;
}

function normalizeRequirements(manifest: WorkflowRequirements): {
  minimumCliVersion: string | null;
  capabilities: string[];
} {
  const nested = manifest.requires !== null &&
    typeof manifest.requires === "object" &&
    !Array.isArray(manifest.requires)
    ? manifest.requires as Record<string, unknown>
    : {};
  const minimumValue = manifest.minimumCliVersion ?? nested.minimumCliVersion;
  const capabilityValue = manifest.capabilities ?? nested.capabilities;
  return {
    minimumCliVersion: typeof minimumValue === "string" ? minimumValue : null,
    capabilities: Array.isArray(capabilityValue)
      ? capabilityValue.filter((item): item is string => typeof item === "string")
      : []
  };
}

export function assessWorkflowCompatibility(
  manifest: WorkflowRequirements,
  cli: CliCompatibilityIdentity
): WorkflowCompatibility {
  const requirements = normalizeRequirements(manifest);
  const supported = new Set(cli.capabilities);
  const missingCapabilities = requirements.capabilities.filter(
    (capability) => !supported.has(capability)
  );
  const versionCompatible = requirements.minimumCliVersion === null ||
    versionAtLeast(cli.cliVersion, requirements.minimumCliVersion);
  const compatible = versionCompatible && missingCapabilities.length === 0;
  return {
    compatible,
    minimumCliVersion: requirements.minimumCliVersion,
    missingCapabilities,
    reasonCode: compatible ? "OK" : "BLOCKED_CAPABILITY_MISMATCH"
  };
}

export function assertWorkflowCompatibility(
  manifest: WorkflowRequirements,
  cli: CliCompatibilityIdentity
): WorkflowCompatibility {
  const compatibility = assessWorkflowCompatibility(manifest, cli);
  if (!compatibility.compatible) {
    throw new WorkflowCompatibilityError(compatibility, cli.cliVersion);
  }
  return compatibility;
}
