export interface CapabilityVerificationTarget {
  commandKey: string;
  dependsOn: string[];
  requiredCapabilities: string[];
  candidate?: boolean;
}

export interface CapabilityVerificationGraph {
  schemaVersion: 1;
  candidateTarget: string | null;
  targets: Record<string, CapabilityVerificationTarget>;
}

export interface VerificationSelectionOptions {
  requestedTargets?: readonly string[];
  availableCapabilities: readonly string[];
}

export interface BlockedVerificationTarget {
  target: string;
  reasonCode: "CAPABILITY_MISSING" | "DEPENDENCY_BLOCKED";
  missingCapabilities: string[];
  blockedBy: string[];
}

export interface VerificationSelection {
  ok: boolean;
  code:
    | "OK"
    | "TARGET_UNKNOWN"
    | "DEPENDENCY_UNKNOWN"
    | "GRAPH_CYCLE"
    | "CANDIDATE_TARGET_MISSING"
    | "CAPABILITY_MISSING"
    | "DEPENDENCY_BLOCKED";
  selected: string[];
  blocked: BlockedVerificationTarget[];
  omitted: string[];
  detail?: string;
}

function failure(
  code: VerificationSelection["code"],
  detail: string,
  targetNames: readonly string[]
): VerificationSelection {
  return {
    ok: false,
    code,
    selected: [],
    blocked: [],
    omitted: [...targetNames].sort(),
    detail
  };
}

export function selectVerificationTargets(
  graph: CapabilityVerificationGraph,
  options: VerificationSelectionOptions
): VerificationSelection {
  const allTargets = Object.keys(graph.targets);
  const requested = options.requestedTargets === undefined
    ? graph.candidateTarget === null
      ? []
      : [graph.candidateTarget]
    : [...new Set(options.requestedTargets)];
  if (requested.length === 0) {
    return failure(
      "CANDIDATE_TARGET_MISSING",
      "no requested target or candidate target is declared",
      allTargets
    );
  }
  for (const name of requested) {
    if (graph.targets[name] === undefined) {
      return failure("TARGET_UNKNOWN", `unknown verification target: ${name}`, allTargets);
    }
  }

  const state = new Map<string, "visiting" | "visited">();
  const closure = new Set<string>();
  const ordered: string[] = [];
  let graphError: VerificationSelection | null = null;
  const visit = (name: string): void => {
    if (graphError !== null) return;
    if (state.get(name) === "visited") return;
    if (state.get(name) === "visiting") {
      graphError = failure("GRAPH_CYCLE", `verification graph cycle at ${name}`, allTargets);
      return;
    }
    const target = graph.targets[name];
    if (target === undefined) {
      graphError = failure(
        "DEPENDENCY_UNKNOWN",
        `unknown verification dependency: ${name}`,
        allTargets
      );
      return;
    }
    state.set(name, "visiting");
    closure.add(name);
    for (const dependency of target.dependsOn) {
      visit(dependency);
    }
    state.set(name, "visited");
    ordered.push(name);
  };
  for (const name of requested) visit(name);
  if (graphError !== null) return graphError;

  const available = new Set(options.availableCapabilities);
  const blocked: BlockedVerificationTarget[] = [];
  const blockedNames = new Set<string>();
  const selected: string[] = [];
  for (const name of ordered) {
    const target = graph.targets[name];
    if (target === undefined) {
      return failure(
        "DEPENDENCY_UNKNOWN",
        `unknown verification dependency: ${name}`,
        allTargets
      );
    }
    const missingCapabilities = [...new Set(target.requiredCapabilities)]
      .filter((capability) => !available.has(capability))
      .sort();
    const blockedBy = target.dependsOn.filter((dependency) =>
      blockedNames.has(dependency)
    );
    if (missingCapabilities.length > 0 || blockedBy.length > 0) {
      blockedNames.add(name);
      blocked.push({
        target: name,
        reasonCode: missingCapabilities.length > 0
          ? "CAPABILITY_MISSING"
          : "DEPENDENCY_BLOCKED",
        missingCapabilities,
        blockedBy
      });
    } else {
      selected.push(name);
    }
  }

  const omitted = allTargets.filter((name) => !closure.has(name)).sort();
  return {
    ok: blocked.length === 0,
    code: blocked[0]?.reasonCode ?? "OK",
    selected,
    blocked,
    omitted
  };
}
