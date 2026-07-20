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
      scanner_version: "1.1.0"
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

  it("does not treat relative paths, hex digests, or knowledge ids as high-entropy secrets", () => {
    const result = scanSensitiveFiles({
      ".harness/knowledge/index.json": JSON.stringify({
        projectRoot: "E:\\MyProject\\kld-sdd",
        summaryData: ".harness/archive/2026-07-12-opsx-rules-skill/reports/final/summary-data.json",
        summarySha256: "1081c466443c5c50d536ecaa9f1471da66fbec1f42d24d389518f4dfc4fd8bc0",
        sourceCommit: "fb45a8db539d1096f76d9946024f4e7a60fbf71a",
        id: "kld-sdd.2026-07-12-opencode-adapter-alignment.api-contract.b45a833ff8"
      }, null, 2)
    });
    expect(result.findings).toEqual([]);
    expect(result.blocked).toBe(false);
  });

  it("still blocks opaque high-entropy tokens that are not digests or paths", () => {
    const secret = "xK9mP2vL8nQ4wR7tY3uI6oP1aS5dF0gHj2";
    const result = scanSensitiveFiles({
      "notes.md": "api_key=" + secret + "\n"
    });
    expect(result.blocked).toBe(true);
    expect(result.findings.some((item) => item.rule_id === "HH_HIGH_ENTROPY")).toBe(true);
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it("still reports Windows absolute paths outside knowledge metadata", () => {
    const result = scanSensitiveFiles({
      "AGENTS.md": "Workspace rooted at E:\\MyProject\\demo-app for local agents.\n"
    });
    expect(result.blocked).toBe(true);
    expect(result.findings[0]).toMatchObject({
      rule_id: "HH_WINDOWS_ABSOLUTE_PATH",
      severity: "low",
      overridable: true
    });
  });

  it("does not block Windows absolute paths recorded in archive metadata", () => {
    const result = scanSensitiveFiles({
      ".harness/archive/2026-07-12-demo/reports/final/summary-data.json": JSON.stringify({
        projectRoot: "E:\\MyProject\\kld-sdd",
        summarySha256: "1081c466443c5c50d536ecaa9f1471da66fbec1f42d24d389518f4dfc4fd8bc0",
        sourceCommit: "fb45a8db539d1096f76d9946024f4e7a60fbf71a"
      }, null, 2)
    });
    expect(result.findings).toEqual([]);
    expect(result.blocked).toBe(false);
  });

  it("does not treat PowerShell location expressions as password values", () => {
    const result = scanSensitiveFiles({
      "scripts/check-frontend-env.ps1": 'Write-Host "pwd: $(Get-Location)"\n'
    });
    expect(result.findings.some((item) => item.rule_id === "HH_PASSWORD_VALUE")).toBe(false);
    expect(result.blocked).toBe(false);
  });

  it("ignores obvious credential placeholders", () => {
    const result = scanSensitiveFiles({
      "README.md": [
        "password=${PASSWORD}",
        "token=example",
        "api_key=<YOUR_API_KEY>"
      ].join("\n")
    });
    expect(result.findings.filter((item) =>
      item.rule_id === "HH_PASSWORD_VALUE" || item.rule_id === "HH_HIGH_ENTROPY"
    )).toEqual([]);
    expect(result.blocked).toBe(false);
  });
});
