import { readFile } from "node:fs/promises";

import { afterEach, describe, expect, it, vi } from "vitest";

import { isNpmPublishConfigured, loadNpmPublishConfig, packageNameForSkill, packageNameForWorkflowFamily } from "../src/npm/config.js";
import {
  buildSkillNpmPackageJson,
  buildSkillNpmTarball,
  buildWorkflowFamilyNpmPackageJson,
  publishSkillNpmPackage,
  publishWorkflowFamilyNpmPackage,
  type SkillNpmPackageInput,
  type WorkflowFamilyNpmPackageInput
} from "../src/npm/publisher.js";

const sampleInput: SkillNpmPackageInput = {
  packageName: "@hunter-skills/harness-sync",
  version: "1.1.0",
  slug: "harness-sync",
  agent: "claude-code",
  description: "Synchronize governed project context.",
  sourceFiles: [
    {
      path: "SKILL.md",
      content: "---\nname: harness-sync\ndescription: sync\n---\n# harness-sync\n"
    }
  ]
};

describe("npm publish config", () => {
  it("reads scope and token from env", () => {
    const config = loadNpmPublishConfig({
      HUNTER_HARNESS_NPM_SCOPE: "@hunter-skills",
      HUNTER_HARNESS_NPM_TOKEN: "secret-token"
    });
    expect(config).toEqual({ scope: "@hunter-skills", token: "secret-token" });
    expect(isNpmPublishConfigured(config)).toBe(true);
    expect(packageNameForSkill(config, "harness-sync")).toBe("@hunter-skills/harness-sync");
    expect(packageNameForWorkflowFamily(config, "harness")).toBe("@hunter-skills/workflow-harness");
    expect(packageNameForWorkflowFamily(config, "enterprise")).toBe("@hunter-skills/workflow-enterprise");
  });

  it("reports unconfigured when scope or token is missing", () => {
    expect(isNpmPublishConfigured({ scope: null, token: "x" })).toBe(false);
    expect(isNpmPublishConfigured({ scope: "@scope", token: null })).toBe(false);
  });
});

describe("skill npm publisher", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("builds a data-only package.json without bin or scripts", () => {
    const packageJson = buildSkillNpmPackageJson(sampleInput);
    expect(packageJson).toMatchObject({
      name: "@hunter-skills/harness-sync",
      version: "1.1.0",
      license: "UNLICENSED",
      files: ["hunter-harness.skill.json", "SKILL.md"]
    });
    expect(packageJson).not.toHaveProperty("bin");
    expect(packageJson).not.toHaveProperty("scripts");
  });

  it("publishes via injected fake publish and records published status", async () => {
    let publishedManifest: Record<string, unknown> | null = null;
    const result = await publishSkillNpmPackage(
      sampleInput,
      { scope: "@hunter-skills", token: "secret-token" },
      {
        packDirectory: async () => Buffer.from("fake-tarball"),
        publish: async (manifest) => {
          publishedManifest = manifest;
        }
      }
    );
    expect(result).toMatchObject({ status: "published", error: null, tarballHash: expect.stringMatching(/^sha256:/) });
    expect(publishedManifest).toMatchObject({
      name: "@hunter-skills/harness-sync",
      version: "1.1.0"
    });
  });

  it("writes nested resources and emits a four-agent manifest v3", async () => {
    const built = await buildSkillNpmTarball({
      ...sampleInput,
      sourceFiles: [
        ...sampleInput.sourceFiles,
        { path: "examples/nested/prompt.md", content: "# prompt\n" }
      ]
    }, {
      packDirectory: async (directory) => {
        expect(await readFile(`${directory}/examples/nested/prompt.md`, "utf8")).toBe("# prompt\n");
        expect(JSON.parse(await readFile(`${directory}/hunter-harness.skill.json`, "utf8"))).toMatchObject({
          schema_version: 3,
          slug: "harness-sync"
        });
        return Buffer.from("fake-tarball");
      }
    });
    expect(built.hunterSkillManifest).toMatchObject({
      schema_version: 3,
      slug: "harness-sync",
      version: "1.1.0",
      variants: {
        "claude-code": { status: "ready" },
        codex: { status: "ready" },
        cursor: { status: "ready" },
        codebuddy: { status: "ready" }
      }
    });
  });

  it.each(["package.json", "hunter-harness.skill.json", "hunter-skill.json", ".npmrc", "package-lock.json"])(
    "rejects authored npm control file %s before packing",
    async (path) => {
      let packed = false;
      await expect(buildSkillNpmTarball({
        ...sampleInput,
        sourceFiles: [...sampleInput.sourceFiles, { path, content: "{}\n" }]
      }, {
        packDirectory: async () => { packed = true; return Buffer.from("unexpected"); }
      })).rejects.toThrow("reserved npm package path");
      expect(packed).toBe(false);
    }
  );

  it("rejects a skill component whose declared source has no SKILL.md", async () => {
    await expect(buildSkillNpmTarball({
      ...sampleInput,
      sourceFiles: [
        ...sampleInput.sourceFiles,
        { path: "hunter-skill.yaml", content: [
          "apiVersion: hunter-harness/v1",
          "kind: SkillBundle",
          "components:",
          "  - role: skill",
          "    source: missing"
        ].join("\n") + "\n" }
      ]
    }, { packDirectory: async () => Buffer.from("unexpected") })).rejects.toThrow("missing SKILL.md");
  });

  it("preserves author-declared subagent variants in the npm package manifest", async () => {
    const built = await buildSkillNpmTarball({
      ...sampleInput,
      sourceFiles: [
        ...sampleInput.sourceFiles,
        { path: "subagents/reviewer.md", content: "# reviewer\n" },
        { path: "subagents/reviewer.toml", content: "name = \"reviewer\"\n" },
        { path: "hunter-skill.yaml", content: [
          "apiVersion: hunter-harness/v1",
          "kind: SkillBundle",
          "components:",
          "  - role: skill",
          "    source: .",
          "  - role: subagent",
          "    source: .",
          "    name: reviewer",
          "    variants:",
          "      claude-code: subagents/reviewer.md",
          "      codex: subagents/reviewer.toml",
          "      cursor: subagents/reviewer.md",
          "      codebuddy: subagents/reviewer.md"
        ].join("\n") + "\n" }
      ]
    }, { packDirectory: async () => Buffer.from("fake-tarball") });

    expect(built.hunterSkillManifest).toMatchObject({
      components: [
        { role: "skill", source: "." },
        { role: "subagent", name: "reviewer", variants: {
          "claude-code": "subagents/reviewer.md",
          codex: "subagents/reviewer.toml",
          cursor: "subagents/reviewer.md",
          codebuddy: "subagents/reviewer.md"
        } }
      ],
      variants: {
        "claude-code": { status: "ready", components: ["skill:.", "subagent:reviewer"] },
        codex: { status: "ready", components: ["skill:.", "subagent:reviewer"] }
      }
    });
  });

  it("publishes scoped packages with public access", async () => {
    let access: string | undefined;
    await publishSkillNpmPackage(sampleInput, { scope: "@hunter-skills", token: "secret-token" }, {
      packDirectory: async () => Buffer.from("fake-tarball"),
      publish: async (_manifest, _tarball, options) => { access = options.access; }
    });
    expect(access).toBe("public");
  });

  it("treats a registry conflict with the same tarball digest as idempotent", async () => {
    const result = await publishSkillNpmPackage(sampleInput, { scope: "@hunter-skills", token: "secret-token" }, {
      packDirectory: async () => Buffer.from("same-tarball"),
      publish: async () => {
        const error = new Error("version conflict") as Error & { statusCode?: number };
        error.statusCode = 409;
        throw error;
      },
      readRemotePackageDigest: async () => "sha256:" + "same-tarball",
      createTarballDigest: () => "sha256:" + "same-tarball"
    });
    expect(result.status).toBe("idempotent");
  });

  it("does not forward npm authorization to a cross-origin tarball URL", async () => {
    const requests: Array<{ url: string; authorization: string | null }> = [];
    vi.stubEnv("npm_config_registry", "https://registry.example.test");
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      requests.push({
        url,
        authorization: new Headers(init?.headers).get("authorization")
      });
      if (url.startsWith("https://registry.example.test/")) {
        return new Response(JSON.stringify({
          versions: {
            "1.1.0": { dist: { tarball: "https://cdn.example.test/harness-sync.tgz" } }
          }
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response("same-tarball", { status: 200 });
    });

    const result = await publishSkillNpmPackage(
      sampleInput,
      { scope: "@hunter-skills", token: "secret-token" },
      {
        packDirectory: async () => Buffer.from("same-tarball"),
        publish: async () => {
          const error = new Error("version conflict") as Error & { statusCode?: number };
          error.statusCode = 409;
          throw error;
        }
      }
    );

    expect(result.status).toBe("idempotent");
    expect(requests).toEqual([
      {
        url: "https://registry.example.test/%40hunter-skills%2Fharness-sync",
        authorization: "Bearer secret-token"
      },
      {
        url: "https://cdn.example.test/harness-sync.tgz",
        authorization: null
      }
    ]);
  });

  it("maps npm 409 conflicts without throwing", async () => {
    const result = await publishSkillNpmPackage(
      sampleInput,
      { scope: "@hunter-skills", token: "secret-token" },
      {
        packDirectory: async () => Buffer.from("fake-tarball"),
        publish: async () => {
          const error = new Error("version conflict") as Error & { statusCode?: number };
          error.statusCode = 409;
          throw error;
        },
        readRemotePackageDigest: async () => null
      }
    );
    expect(result.status).toBe("conflict");
    expect(result.error).toContain("newer registry version");
  });

  it("redacts registry error details before returning a failed result", async () => {
    const sensitiveMarker = "SENSITIVE_SENTINEL_VALUE";
    const sensitivePath = "C:\\Users\\Example\\private\\npmrc";
    const result = await publishSkillNpmPackage(
      sampleInput,
      { scope: "@hunter-skills", token: "secret-token" },
      {
        packDirectory: async () => Buffer.from("fake-tarball"),
        publish: async () => {
          throw new Error(`registry rejected credential=${sensitiveMarker} at ${sensitivePath}`);
        }
      }
    );
    expect(result.status).toBe("failed");
    expect(result.error).toBe("npm registry rejected the publish request");
    expect(result.error).not.toContain(sensitiveMarker);
    expect(result.error).not.toContain(sensitivePath);
  });
});

const workflowFamilyInput: WorkflowFamilyNpmPackageInput = {
  packageName: "@hunter-skills/workflow-harness",
  version: "1.0.0",
  familySlug: "harness",
  description: "Default harness workflow family",
  requiredProfiles: ["general"],
  files: [
    { path: "harness/manifests/general/claude-code.json", content: '{"schema_version":2}\n' },
    { path: "harness/bundles/general/claude-code/harness-plan/SKILL.md", content: "# plan\n" }
  ]
};

describe("workflow family npm publisher", () => {
  it("builds a data-only package.json without bin or scripts", () => {
    const packageJson = buildWorkflowFamilyNpmPackageJson(workflowFamilyInput);
    expect(packageJson).toMatchObject({
      name: "@hunter-skills/workflow-harness",
      version: "1.0.0",
      license: "MIT",
      files: expect.arrayContaining([
        "hunter-workflow-family.json",
        "harness/manifests/general/claude-code.json"
      ])
    });
    expect(packageJson).not.toHaveProperty("bin");
    expect(packageJson).not.toHaveProperty("scripts");
  });

  it("publishes via injected fake publish and records published status", async () => {
    let publishedManifest: Record<string, unknown> | null = null;
    const result = await publishWorkflowFamilyNpmPackage(
      workflowFamilyInput,
      { scope: "@hunter-skills", token: "secret-token" },
      {
        packDirectory: async () => Buffer.from("fake-tarball"),
        publish: async (manifest) => {
          publishedManifest = manifest;
        }
      }
    );
    expect(result).toMatchObject({ status: "published", error: null, tarballHash: expect.stringMatching(/^sha256:/) });
    expect(publishedManifest).toMatchObject({
      name: "@hunter-skills/workflow-harness",
      version: "1.0.0"
    });
  });

  it("maps npm 409 conflicts without throwing", async () => {
    const result = await publishWorkflowFamilyNpmPackage(
      workflowFamilyInput,
      { scope: "@hunter-skills", token: "secret-token" },
      {
        packDirectory: async () => Buffer.from("fake-tarball"),
        publish: async () => {
          const error = new Error("version conflict") as Error & { statusCode?: number };
          error.statusCode = 409;
          throw error;
        }
      }
    );
    expect(result.status).toBe("conflict");
    expect(result.error).toContain("newer family version");
  });

  it("redacts workflow registry error details before returning a failed result", async () => {
    const sensitiveMarker = "SENSITIVE_SENTINEL_VALUE";
    const result = await publishWorkflowFamilyNpmPackage(
      workflowFamilyInput,
      { scope: "@hunter-skills", token: "secret-token" },
      {
        packDirectory: async () => Buffer.from("fake-tarball"),
        publish: async () => {
          throw new Error(`registry rejected credential=${sensitiveMarker}`);
        }
      }
    );
    expect(result.status).toBe("failed");
    expect(result.error).toBe("npm registry rejected the publish request");
    expect(result.error).not.toContain(sensitiveMarker);
  });
});
