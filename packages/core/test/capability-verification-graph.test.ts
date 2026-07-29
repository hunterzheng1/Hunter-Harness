import { describe, expect, it } from "vitest";

import {
  selectVerificationTargets,
  type CapabilityVerificationGraph
} from "../src/verification/capability-graph.js";

function graph(): CapabilityVerificationGraph {
  return {
    schemaVersion: 1,
    candidateTarget: "candidate",
    targets: {
      lint: {
        commandKey: "lint",
        dependsOn: [],
        requiredCapabilities: ["node"]
      },
      unit: {
        commandKey: "unit",
        dependsOn: ["lint"],
        requiredCapabilities: ["node"]
      },
      candidate: {
        commandKey: "candidate",
        dependsOn: ["unit"],
        requiredCapabilities: ["node", "docker"],
        candidate: true
      },
      docs: {
        commandKey: "docs",
        dependsOn: [],
        requiredCapabilities: []
      }
    }
  };
}

describe("capability-aware verification graph", () => {
  it("expands dependencies in topological order and omits unrelated targets", () => {
    const result = selectVerificationTargets(graph(), {
      requestedTargets: ["unit"],
      availableCapabilities: ["node"]
    });

    expect(result.ok).toBe(true);
    expect(result.selected).toEqual(["lint", "unit"]);
    expect(result.blocked).toEqual([]);
    expect(result.omitted).toEqual(["candidate", "docs"]);
  });

  it("blocks a candidate when a required capability is unavailable", () => {
    const result = selectVerificationTargets(graph(), {
      requestedTargets: ["candidate"],
      availableCapabilities: ["node"]
    });

    expect(result.ok).toBe(false);
    expect(result.code).toBe("CAPABILITY_MISSING");
    expect(result.selected).toEqual(["lint", "unit"]);
    expect(result.blocked).toEqual([
      {
        target: "candidate",
        reasonCode: "CAPABILITY_MISSING",
        missingCapabilities: ["docker"],
        blockedBy: []
      }
    ]);
  });

  it("uses the declared candidate target when no explicit target is requested", () => {
    const result = selectVerificationTargets(graph(), {
      availableCapabilities: ["node", "docker"]
    });

    expect(result.ok).toBe(true);
    expect(result.selected).toEqual(["lint", "unit", "candidate"]);
  });

  it("fails closed for unknown targets and dependency cycles", () => {
    const unknown = selectVerificationTargets(graph(), {
      requestedTargets: ["invented"],
      availableCapabilities: ["node"]
    });
    expect(unknown.ok).toBe(false);
    expect(unknown.code).toBe("TARGET_UNKNOWN");

    const cyclic = graph();
    cyclic.targets.lint.dependsOn = ["candidate"];
    const cycle = selectVerificationTargets(cyclic, {
      requestedTargets: ["candidate"],
      availableCapabilities: ["node", "docker"]
    });
    expect(cycle.ok).toBe(false);
    expect(cycle.code).toBe("GRAPH_CYCLE");
  });
});
