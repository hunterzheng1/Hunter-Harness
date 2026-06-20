import { describe, expect, it } from "vitest";

import { scanSensitiveFiles } from "../src/index.js";

describe("sensitive information scanner", () => {
  it("blocks private keys and tokens without returning the secret", () => {
    const token = "ghp_1234567890abcdefghijklmnopqrstuvwxyzAB";
    const result = scanSensitiveFiles({
      "config.txt": "token=" + token + "\n-----BEGIN PRIVATE KEY-----\nabc\n"
    });
    expect(result.blocked).toBe(true);
    expect(result.findings.map((item) => item.rule_id)).toEqual(
      expect.arrayContaining(["HH_PRIVATE_KEY", "HH_GITHUB_TOKEN"])
    );
    expect(JSON.stringify(result)).not.toContain(token);
    expect(result.findings.every((item) => item.overridable === false)).toBe(true);
  });

  it("detects high-entropy values and requires explicit evidence for medium risk", () => {
    const first = scanSensitiveFiles({
      "settings.md": "example_password = changeme-example-only\n"
    });
    const finding = first.findings.find((item) => item.rule_id === "HH_PASSWORD_VALUE");
    expect(first.blocked).toBe(true);
    expect(finding).toMatchObject({ severity: "medium", overridable: true });

    const allowed = scanSensitiveFiles({
      "settings.md": "example_password = changeme-example-only\n"
    }, {
      overrides: [{
        finding_fingerprint: finding?.fingerprint ?? "",
        actor: "local-owner",
        reason: "documented non-secret fixture"
      }],
      now: new Date("2026-06-20T00:00:00Z")
    });
    expect(allowed.blocked).toBe(false);
    expect(allowed.override_evidence[0]).toMatchObject({
      actor: "local-owner",
      reason: "documented non-secret fixture",
      scanner_version: "1.0.0"
    });
    expect(Object.isFrozen(allowed.override_evidence[0])).toBe(true);
  });

  it("permits versioned inline ignores only for medium or low rules", () => {
    const medium = scanSensitiveFiles({
      "fixtures.md": [
        "<!-- hunter-harness-ignore: HH_PASSWORD_VALUE reason=test-fixture -->",
        "password = sample-password-value"
      ].join("\n")
    });
    expect(medium.blocked).toBe(false);
    expect(medium.override_evidence[0]).toMatchObject({
      source: "inline-annotation",
      rule_id: "HH_PASSWORD_VALUE"
    });

    const high = scanSensitiveFiles({
      "unsafe.md": [
        "<!-- hunter-harness-ignore: HH_PRIVATE_KEY reason=test -->",
        "-----BEGIN PRIVATE KEY-----"
      ].join("\n")
    });
    expect(high.blocked).toBe(true);
  });
});
