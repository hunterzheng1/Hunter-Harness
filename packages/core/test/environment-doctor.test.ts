import { describe, expect, it } from "vitest";

import { assessEnvironmentCapabilities } from "../src/environment/doctor.js";

describe("environment doctor capability assessment", () => {
  it("distinguishes unavailable, degraded and optional capabilities", () => {
    const result = assessEnvironmentCapabilities({
      requiredCapabilities: ["python", "docker"],
      optionalCapabilities: ["wsl"],
      probes: [
        {
          capability: "python",
          status: "AVAILABLE",
          reasonCode: "PYTHON_OK",
          observedAt: "2026-07-29T12:00:00Z",
          evidence: []
        },
        {
          capability: "docker",
          status: "UNAVAILABLE",
          reasonCode: "DOCKER_DAEMON_UNREACHABLE",
          observedAt: "2026-07-29T12:00:00Z",
          evidence: []
        },
        {
          capability: "wsl",
          status: "DEGRADED",
          reasonCode: "WSL_DISTRO_STOPPED",
          observedAt: "2026-07-29T12:00:00Z",
          evidence: []
        }
      ]
    });

    expect(result.status).toBe("BLOCKED");
    expect(result.missingRequired).toEqual(["docker"]);
    expect(result.degradedOptional).toEqual(["wsl"]);
    expect(result.reasonCodes).toEqual([
      "DOCKER_DAEMON_UNREACHABLE",
      "WSL_DISTRO_STOPPED"
    ]);
  });

  it("fails closed when a required capability has no probe", () => {
    const result = assessEnvironmentCapabilities({
      requiredCapabilities: ["python", "docker"],
      probes: [
        {
          capability: "python",
          status: "AVAILABLE",
          reasonCode: "PYTHON_OK",
          observedAt: "2026-07-29T12:00:00Z",
          evidence: []
        }
      ]
    });

    expect(result.status).toBe("BLOCKED");
    expect(result.missingRequired).toEqual(["docker"]);
    expect(result.reasonCodes).toContain("CAPABILITY_NOT_PROBED:docker");
  });
});
