import { uuidV7, type BootstrapBundle } from "@hunter-harness/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createServer } from "../src/app.js";
import { MemoryRepository } from "../src/repositories/memory.js";
import { MemoryArtifactStorage } from "../src/storage/memory.js";

const bundle: BootstrapBundle = {
  registryVersion: "dashboard-test-registry",
  compilerVersion: "1.0.0",
  bundleHash: "sha256:" + "d".repeat(64),
  skills: [{
    name: "harness-sync",
    kind: "workflow",
    description: "Synchronize governed project context.",
    triggers: ["sync context"],
    inputs: ["project_root"],
    outputs: ["sync_report"],
    forbidden_actions: ["automatic_git_write"],
    required_context: ["AGENTS.md"],
    profiles: { general: { enabled: true } },
    adapters: { "claude-code": { enabled: true } },
    version: "1.0.0",
    instructions: ["Inspect before changing context."]
  }]
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
      url: "/api/v1/workflows",
      headers: headers(),
      payload: {
        schema_version: 1,
        key: "dashboard",
        name: "Dashboard Workflow",
        description: "Workflow included in the governance overview.",
        profile: "general",
        default_agent: "claude-code",
        enabled: true,
        skill_slugs: ["harness-sync"]
      }
    });
    expect(workflow.statusCode).toBe(201);

    const proposedSkill = { ...bundle.skills[0], version: "1.1.0", description: "Dashboard-reviewed Skill." };
    const proposal = await app.inject({
      method: "POST",
      url: "/api/v1/skill-proposals",
      headers: headers(),
      payload: { schema_version: 1, skill_ir: proposedSkill, agent: "claude-code" }
    });
    expect(proposal.statusCode).toBe(201);

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
        pending_reviews: 1,
        artifacts: 1
      }),
      distributions: {
        skill_categories: [{ key: "workflow", count: 1 }],
        workflow_profiles: [{ key: "general", count: 1 }]
      }
    });
    expect(overview.json().trend).toHaveLength(7);
    expect(overview.json().trend.at(-1)).toEqual(expect.objectContaining({ submitted: 1, pending: 1 }));
    expect(overview.json().health).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: "review_backlog", status: "attention" }),
      expect.objectContaining({ key: "artifact_traceability", status: "healthy" })
    ]));
    expect(overview.json().services).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: "api", status: "operational" }),
      expect.objectContaining({ key: "repository", status: "operational" }),
      expect.objectContaining({ key: "registry", status: "operational" })
    ]));
    expect(overview.json().activity).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: "workflow.created" })
    ]));
    expect(overview.json().activity.find((event: { action: string }) => event.action === "workflow.created"))
      .not.toHaveProperty("details");
  });

  it("rejects unauthenticated dashboard reads", async () => {
    const response = await app.inject({ method: "GET", url: "/api/v1/dashboard/overview" });
    expect(response.statusCode).toBe(401);
  });
});
