import { uuidV7 } from "@hunter-harness/core";
import type { SourceFile } from "@hunter-harness/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createServer } from "../src/app.js";
import { MemoryRepository } from "../src/repositories/memory.js";
import { MemoryArtifactStorage } from "../src/storage/memory.js";
import type { BootstrapBundle } from "../src/registry/store.js";

// 新模型：bootstrap skill 由 sourceFiles（SKILL.md frontmatter）驱动；canonical Skill IR 已删除。
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
  registryVersion: "dashboard-test-registry",
  compilerVersion: "1.0.0",
  skills: [{ slug: "harness-sync", version: "1.0.0", sourceFiles: bootstrapSourceFiles }]
};

describe("/api/v1/dashboard/overview", () => {
  const token = "dashboard-owner-token";
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

  it("returns a real governance snapshot with trend, distributions, health, and sanitized activity", async () => {
    const project = await app.inject({
      method: "POST",
      url: "/api/v1/projects:resolve",
      headers: headers(),
      payload: {
        schema_version: 1,
        local_project_key: crypto.randomUUID(),
        display_name: "Dashboard project",
        requested_project_id: null,
        client_id: "cli_dashboard_test"
      }
    });
    expect(project.statusCode).toBe(200);

    const workflow = await app.inject({
      method: "POST",
      url: "/api/v1/workflow-families",
      headers: headers(),
      payload: {
        schema_version: 1,
        slug: "harness",
        displayName: "Harness",
        description: "Workflow family included in the governance overview.",
        tags: [],
        required_profiles: ["general"]
      }
    });
    expect(workflow.statusCode).toBe(201);

    // 新模型：proposal 上传 source_files（SKILL.md frontmatter），不再 POST skill_ir。
    const proposedFiles: SourceFile[] = [
      { path: "SKILL.md", content: skillMd({ name: "harness-sync", version: "1.1.0", description: "Dashboard-reviewed Skill." }) },
      { path: "harness-sync.mdc", content: cursorMdc("harness-sync", "1.1.0") }
    ];
    const boundary = "----dashboard-draft";
    let body = "";
    for (const f of proposedFiles) {
      body += `--${boundary}\r\n`;
      body += `Content-Disposition: form-data; name="file"; filename="${f.path}"\r\n`;
      body += "Content-Type: application/octet-stream\r\n\r\n";
      body += f.content + "\r\n";
    }
    body += `--${boundary}--\r\n`;
    const draft = await app.inject({
      method: "POST",
      url: "/api/v1/skills/draft?agent=claude-code",
      headers: {
        ...headers(),
        "content-type": `multipart/form-data; boundary=${boundary}`
      },
      payload: body
    });
    expect(draft.statusCode).toBe(201);
    const publish = await app.inject({
      method: "POST",
      url: "/api/v1/skills/harness-sync/draft/claude-code/publish",
      headers: headers(),
      payload: { version: "1.1.0", releaseNote: "dashboard" }
    });
    expect(publish.statusCode).toBe(200);

    const overview = await app.inject({
      method: "GET",
      url: "/api/v1/dashboard/overview?days=7",
      headers: headers()
    });

    expect(overview.statusCode).toBe(200);
    expect(overview.json()).toMatchObject({
      window: { days: 7 },
      metrics: expect.objectContaining({
        projects: 1,
        workflows: 1,
        skills: 1,
        pending_reviews: 0,
        artifacts: 2,
        published_skills: 1
      }),
      distributions: {
        // kind 从 frontmatter 反范式化到 detail（与 description 同理），dashboard 分类分布按真实 kind
        skill_categories: [{ key: "workflow", count: 1 }],
        workflow_profiles: [{ key: "general", count: 1 }]
      }
    });
    expect(overview.json().trend).toHaveLength(7);
    expect(overview.json().trend.at(-1)).toEqual(expect.objectContaining({ submitted: 0, pending: 0 }));
    expect(overview.json().health).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: "review_backlog", status: "healthy" }),
      expect.objectContaining({ key: "artifact_traceability", status: "healthy" })
    ]));
    expect(overview.json().services).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: "api", status: "operational" }),
      expect.objectContaining({ key: "repository", status: "operational" }),
      expect.objectContaining({ key: "registry", status: "operational" })
    ]));
    expect(overview.json().activity).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: "workflow.family.created" })
    ]));
    expect(overview.json().activity.find((event: { action: string }) => event.action === "workflow.family.created"))
      .not.toHaveProperty("details");
  });

  it("rejects unauthenticated dashboard reads", async () => {
    const response = await app.inject({ method: "GET", url: "/api/v1/dashboard/overview" });
    expect(response.statusCode).toBe(401);
  });
});
