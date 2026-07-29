export type CapabilityProbeStatus =
  | "AVAILABLE"
  | "UNAVAILABLE"
  | "DEGRADED"
  | "UNKNOWN";

export interface CapabilityProbe {
  capability: string;
  status: CapabilityProbeStatus;
  reasonCode: string;
  observedAt: string;
  evidence: string[];
  details?: unknown;
}

export interface EnvironmentCapabilityAssessmentOptions {
  requiredCapabilities: readonly string[];
  optionalCapabilities?: readonly string[];
  probes: readonly CapabilityProbe[];
}

export interface EnvironmentCapabilityAssessment {
  status: "READY" | "DEGRADED" | "BLOCKED";
  missingRequired: string[];
  degradedRequired: string[];
  degradedOptional: string[];
  reasonCodes: string[];
  capabilities: Record<string, CapabilityProbe | null>;
}

export function assessEnvironmentCapabilities(
  options: EnvironmentCapabilityAssessmentOptions
): EnvironmentCapabilityAssessment {
  const probes = new Map(
    options.probes.map((probe) => [probe.capability, probe] as const)
  );
  const required = [...new Set(options.requiredCapabilities)];
  const optional = [...new Set(options.optionalCapabilities ?? [])]
    .filter((capability) => !required.includes(capability));
  const missingRequired: string[] = [];
  const degradedRequired: string[] = [];
  const degradedOptional: string[] = [];
  const reasonCodes: string[] = [];
  const capabilities: Record<string, CapabilityProbe | null> = {};

  for (const capability of [...required, ...optional]) {
    capabilities[capability] = probes.get(capability) ?? null;
  }
  for (const capability of required) {
    const probe = probes.get(capability);
    if (
      probe === undefined ||
      probe.status === "UNAVAILABLE" ||
      probe.status === "UNKNOWN"
    ) {
      missingRequired.push(capability);
      reasonCodes.push(
        probe?.reasonCode ?? `CAPABILITY_NOT_PROBED:${capability}`
      );
    } else if (probe.status === "DEGRADED") {
      degradedRequired.push(capability);
      reasonCodes.push(probe.reasonCode);
    }
  }
  for (const capability of optional) {
    const probe = probes.get(capability);
    if (
      probe !== undefined &&
      (probe.status === "DEGRADED" ||
        probe.status === "UNAVAILABLE" ||
        probe.status === "UNKNOWN")
    ) {
      degradedOptional.push(capability);
      reasonCodes.push(probe.reasonCode);
    }
  }

  return {
    status: missingRequired.length > 0
      ? "BLOCKED"
      : degradedRequired.length > 0 || degradedOptional.length > 0
        ? "DEGRADED"
        : "READY",
    missingRequired,
    degradedRequired,
    degradedOptional,
    reasonCodes,
    capabilities
  };
}
