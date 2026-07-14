import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import { initializeProject } from "../src/project/initialize.js";
import { pushProject } from "../src/push/push.js";

const resourcesRoot = fileURLToPath(new URL("../../workflow-data-harness", import.meta.url));

describe("pushProject sensitive scan UX", () => {
  async function initRoot(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "hh-push-scan-"));
    await initializeProject({
      projectRoot: root,
      resourcesRoot,
      config: { agents: ["claude-code"], profile: "general" },
      dryRun: false
    });
    return root;
  }

  it("throws SENSITIVE_CONTENT_BLOCKED with findings details when blocked", async () => {
    const root = await initRoot();
    await writeFile(
      join(root, ".claude", "rules", "unsafe.md"),
      "Authorization: Bearer blocked-secret-token-1234567890\n"
    );
    await expect(pushProject({
      projectRoot: root,
      resourcesRoot,
      env: {},
      dryRun: true
    })).rejects.toMatchObject({
      code: "SENSITIVE_CONTENT_BLOCKED",
      details: {
        finding_count: expect.any(Number),
        findings: expect.arrayContaining([
          expect.objectContaining({
            path: ".claude/rules/unsafe.md",
            rule_id: "HH_AUTHORIZATION_BEARER"
          })
        ])
      }
    });
  });

  it("allows blocked preview when sensitiveScanSkip is true", async () => {
    const root = await initRoot();
    await writeFile(
      join(root, ".claude", "rules", "unsafe.md"),
      "Authorization: Bearer blocked-secret-token-1234567890\n"
    );
    const result = await pushProject({
      projectRoot: root,
      resourcesRoot,
      env: {},
      dryRun: true,
      sensitiveScanSkip: true
    });
    expect(result.preview.blocked).toBe(true);
    expect(result.preview.security.findings.length).toBeGreaterThan(0);
  });

  it("does not report TOKEN_INVALID when credentials.local supplies auth", async () => {
    const root = await initRoot();
    await writeFile(
      join(root, ".harness", "credentials.local.yaml"),
      "token: cred-token\nserver_url: https://cred.example.test\n"
    );
    const fetch = vi.fn(async (
      _input: string | URL | Request,
      init?: RequestInit
    ) => {
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toBe("Bearer cred-token");
      return new Response(JSON.stringify({
        schema_version: 1,
        project_id: "prj_cred",
        binding_status: "created",
        project_version: null,
        baseline_manifest: {
          schema_version: 1,
          project_id: "prj_cred",
          complete_project_version: null,
          artifact_manifest_hash: null,
          files: {}
        },
        request_id: "req"
      }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    });
    await expect(pushProject({
      projectRoot: root,
      resourcesRoot,
      env: {},
      dryRun: false,
      fetch
    })).rejects.not.toMatchObject({ code: "TOKEN_INVALID" });
    expect(fetch).toHaveBeenCalled();
  });
});
