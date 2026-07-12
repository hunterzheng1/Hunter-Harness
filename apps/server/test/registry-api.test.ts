import { uuidV7 } from "@hunter-harness/core";
import type { SourceFile } from "@hunter-harness/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createServer } from "../src/app.js";
import { MemoryRepository } from "../src/repositories/memory.js";
import { MemoryArtifactStorage } from "../src/storage/memory.js";
import type { BootstrapBundle } from "../src/registry/store.js";

// 新模型：上传源文件（SKILL.md 含 frontmatter）是 skill 唯一源；canonical Skill IR 已删除。
// frontmatter 字段（name/description/kind/triggers/...）由 skillFrontmatterSchema 松校验，name 必填。
function skillMd(opts: { name: string; version: string; description?: string; kind?: string }): string {
  const description = opts.description ?? "Synchronize governed project context.";
  const kind = opts.kind ?? "workflow";
  return `---
name: ${opts.name}
description: ${description}
kind: ${kind}
triggers: ["sync context"]
inputs: ["project_root"]
outputs: ["sync_report"]
forbidden_actions: ["automatic_git_write"]
required_context: ["AGENTS.md"]
version: "${opts.version}"
---

# ${opts.name}
Inspect before changing context.
`;
}

// cursor entry（.mdc）：createProposal 验证闸门 buildArtifacts 遍历所有 installable agent，
// 需每个 agent 的 entry（claude-code/codex/generic 用 SKILL.md，cursor 用 .mdc）；与 store.test.ts filesMulti 同模式。
function cursorMdc(name: string, version: string): string {
  return `---
name: ${name}
description: cursor rule for ${name}
version: "${version}"
adapter: cursor
---
cursor rule body
`;
}

const bootstrapSourceFiles: SourceFile[] = [{ path: "SKILL.md", content: skillMd({ name: "harness-sync", version: "1.0.0" }) }];

const bundle: BootstrapBundle = {
  registryVersion: "test-registry",
  compilerVersion: "1.0.0",
  skills: [{ slug: "harness-sync", version: "1.0.0", sourceFiles: bootstrapSourceFiles }]
};

describe("/api/v1 Skill Registry and direct workflow metadata", () => {
  const token = "registry-owner-token";
  let repository: MemoryRepository;
  let app: Awaited<ReturnType<typeof createServer>>;

  beforeEach(async () => {
    repository = new MemoryRepository();
    await repository.createActorWithToken({ actorId: "actor_owner", token });
    app = await createServer({
      repository,
      storage: new MemoryArtifactStorage(),
      bootstrapBundle: bundle
    });
  });

  afterEach(async () => app.close());

  function headers(): Record<string, string> {
    return {
      authorization: "Bearer " + token,
      "x-request-id": uuidV7(),
      "idempotency-key": uuidV7()
    };
  }

  it("lists canonical bootstrap skills and directly maintains tags and workflow families", async () => {
    const skills = await app.inject({ method: "GET", url: "/api/v1/skills", headers: headers() });
    expect(skills.statusCode).toBe(200);
    expect(skills.json().items).toMatchObject([{ slug: "harness-sync", latest_version: "1.0.0" }]);

    const tag = await app.inject({
      method: "POST",
      url: "/api/v1/tags",
      headers: headers(),
      payload: { schema_version: 1, slug: "safety", label: "Safety" }
    });
    expect(tag.statusCode).toBe(201);

    const family = await app.inject({
      method: "POST",
      url: "/api/v1/workflow-families",
      headers: headers(),
      payload: {
        schema_version: 1,
        slug: "harness",
        displayName: "Harness",
        description: "Default harness workflow family",
        tags: [],
        required_profiles: ["general"]
      }
    });
    expect(family.statusCode).toBe(201);
    expect(family.json()).toMatchObject({ slug: "harness", revision: 1 });

    const upload = multipart([
      { path: ".harness-build.json", content: '{"profile":"general"}\n' },
      { path: "manifests/claude-code.json", content: '{"schema_version":1}\n' }
    ]);
    const draft = await app.inject({
      method: "POST",
      url: "/api/v1/workflow-families/harness/draft/profiles/general",
      payload: upload.payload,
      headers: { ...headers(), ...upload.headers }
    });
    expect(draft.statusCode).toBe(201);
    expect(draft.json()).toMatchObject({ family_slug: "harness", revision: 1 });

    const audit = await repository.listAuditEvents();
    expect(audit.map((event) => event.action)).toEqual(expect.arrayContaining([
      "tag.created",
      "workflow.family.created",
      "workflow.family.draft.created"
    ]));
  });

  function multipart(files: Array<{ path: string; content: string }>): {
    payload: string;
    headers: Record<string, string>;
  } {
    const boundary = "----registry-api-test";
    let body = "";
    for (const f of files) {
      body += `--${boundary}\r\n`;
      body += `Content-Disposition: form-data; name="file"; filename="${f.path}"\r\n`;
      body += "Content-Type: application/octet-stream\r\n\r\n";
      body += f.content + "\r\n";
    }
    body += `--${boundary}--\r\n`;
    return { payload: body, headers: { "content-type": `multipart/form-data; boundary=${boundary}` } };
  }

  it("publishes a Skill from source files via Direct Publish and serves Claude artifacts", async () => {
    const proposedFiles: SourceFile[] = [
      { path: "SKILL.md", content: skillMd({ name: "harness-sync", version: "1.1.0", description: "Updated safely." }) },
      { path: "harness-sync.mdc", content: cursorMdc("harness-sync", "1.1.0") }
    ];
    const upload = multipart(proposedFiles);
    const draft = await app.inject({
      method: "POST",
      url: "/api/v1/skills/draft?agent=claude-code",
      payload: upload.payload,
      headers: { ...headers(), ...upload.headers }
    });
    expect(draft.statusCode).toBe(201);

    const before = await app.inject({
      method: "GET",
      url: "/api/v1/skills/harness-sync",
      headers: headers()
    });
    expect(before.json().latest_version).toBe("1.0.0");

    const publish = await app.inject({
      method: "POST",
      url: "/api/v1/skills/harness-sync/draft/claude-code/publish",
      headers: headers(),
      payload: { version: "1.1.0", releaseNote: "Owner published" }
    });
    expect(publish.statusCode).toBe(200);
    expect(publish.json()).toMatchObject({ version: "1.1.0" });

    const download = await app.inject({
      method: "GET",
      url: "/api/v1/skills/harness-sync/artifacts/claude-code/download",
      headers: headers()
    });
    expect(download.statusCode).toBe(200);
    expect(download.headers["content-type"]).toContain("application/zip");
    expect(download.headers["x-content-sha256"]).toMatch(/^sha256:[a-f0-9]{64}$/);

    const detail = await app.inject({
      method: "GET",
      url: "/api/v1/skills/harness-sync",
      headers: headers()
    });
    expect(detail.json()).toMatchObject({ latest_version: "1.1.0", description: "Updated safely." });
  });

  it("rejects non-monotonic Skill versions on Direct Publish", async () => {
    const lowFiles: SourceFile[] = [
      { path: "SKILL.md", content: skillMd({ name: "harness-sync", version: "0.9.0" }) },
      { path: "harness-sync.mdc", content: cursorMdc("harness-sync", "0.9.0") }
    ];
    const upload = multipart(lowFiles);
    const draft = await app.inject({
      method: "POST",
      url: "/api/v1/skills/draft?agent=claude-code",
      payload: upload.payload,
      headers: { ...headers(), ...upload.headers }
    });
    expect(draft.statusCode).toBe(201);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/skills/harness-sync/draft/claude-code/publish",
      headers: headers(),
      payload: { version: "0.9.0" }
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("SKILL_VERSION_NOT_FORWARD");
  });

  it("releases the latest published skill version to npm with injected publisher", async () => {
    const npmConfig = { scope: "@hunter-skills", token: "npm-test-token" };
    const appWithNpm = await createServer({
      repository,
      storage: new MemoryArtifactStorage(),
      bootstrapBundle: bundle,
      npmPublishConfig: npmConfig,
      npmPublisherDeps: {
        packDirectory: async () => Buffer.from("fake-tarball"),
        publish: async () => undefined
      }
    });

    const release = await appWithNpm.inject({
      method: "POST",
      url: "/api/v1/skills/harness-sync/npm-release",
      headers: headers()
    });
    expect(release.statusCode).toBe(200);
    expect(release.json()).toMatchObject({
      slug: "harness-sync",
      release: {
        version: "1.0.0",
        packageName: "@hunter-skills/harness-sync",
        status: "published"
      }
    });

    const detail = await appWithNpm.inject({
      method: "GET",
      url: "/api/v1/skills/harness-sync",
      headers: headers()
    });
    expect(detail.json()).toMatchObject({
      npm_publish_available: true,
      npmReleases: [{ version: "1.0.0", status: "published", packageName: "@hunter-skills/harness-sync" }]
    });

    const idempotent = await appWithNpm.inject({
      method: "POST",
      url: "/api/v1/skills/harness-sync/npm-release",
      headers: headers()
    });
    expect(idempotent.statusCode).toBe(200);
    expect(idempotent.json().release.status).toBe("published");

    await appWithNpm.close();
  });

  it("returns 503 when npm publish is not configured", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/skills/harness-sync/npm-release",
      headers: headers()
    });
    expect(response.statusCode).toBe(503);
    expect(response.json().error.code).toBe("NPM_PUBLISH_NOT_CONFIGURED");
  });

  it("releases the latest published workflow family version to npm with injected publisher", async () => {
    const npmConfig = { scope: "@hunter-skills", token: "npm-test-token" };
    const appWithNpm = await createServer({
      repository,
      storage: new MemoryArtifactStorage(),
      bootstrapBundle: bundle,
      npmPublishConfig: npmConfig,
      npmPublisherDeps: {
        packDirectory: async () => Buffer.from("fake-tarball"),
        publish: async () => undefined
      }
    });

    await appWithNpm.inject({
      method: "POST",
      url: "/api/v1/workflow-families",
      headers: headers(),
      payload: {
        schema_version: 1,
        slug: "harness",
        displayName: "Harness",
        description: "Default harness workflow family",
        tags: [],
        required_profiles: ["general"]
      }
    });
    const upload = multipart([
      { path: ".harness-build.json", content: '{"profile":"general"}\n' },
      { path: "manifests/claude-code.json", content: '{"schema_version":1}\n' }
    ]);
    await appWithNpm.inject({
      method: "POST",
      url: "/api/v1/workflow-families/harness/draft/profiles/general",
      payload: upload.payload,
      headers: { ...headers(), ...upload.headers }
    });
    await appWithNpm.inject({
      method: "POST",
      url: "/api/v1/workflow-families/harness/publish",
      headers: headers(),
      payload: { version: "1.0.0" }
    });

    const release = await appWithNpm.inject({
      method: "POST",
      url: "/api/v1/workflow-families/harness/npm-release",
      headers: headers()
    });
    expect(release.statusCode).toBe(200);
    expect(release.json()).toMatchObject({
      slug: "harness",
      release: {
        version: "1.0.0",
        packageName: "@hunter-skills/workflow-harness",
        status: "published"
      }
    });

    const detail = await appWithNpm.inject({
      method: "GET",
      url: "/api/v1/workflow-families/harness",
      headers: headers()
    });
    expect(detail.json()).toMatchObject({
      npmReleases: [{ version: "1.0.0", status: "published", packageName: "@hunter-skills/workflow-harness" }]
    });

    const notConfigured = await app.inject({
      method: "POST",
      url: "/api/v1/workflow-families/harness/npm-release",
      headers: headers()
    });
    expect(notConfigured.statusCode).toBe(503);

    await appWithNpm.close();
  });
});
