import { uuidV7, type BootstrapBundle } from "@hunter-harness/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createServer } from "../src/app.js";
import { MemoryRepository } from "../src/repositories/memory.js";
import { MemoryArtifactStorage } from "../src/storage/memory.js";

const bundle: BootstrapBundle = {
  registryVersion: "test-registry",
  compilerVersion: "1.0.0",
  bundleHash: "sha256:" + "a".repeat(64),
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

const bootstrapSkill = bundle.skills.at(0);
if (bootstrapSkill === undefined) throw new Error("test bootstrap bundle must contain a Skill");

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

  it("lists canonical bootstrap skills and directly maintains tags and workflows", async () => {
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

    const workflow = await app.inject({
      method: "POST",
      url: "/api/v1/workflows",
      headers: headers(),
      payload: {
        schema_version: 1,
        key: "general",
        name: "General",
        description: "Default governed workflow",
        profile: "general",
        default_agent: "claude-code",
        enabled: true,
        skill_slugs: ["harness-sync"]
      }
    });
    expect(workflow.statusCode).toBe(201);
    expect(workflow.json()).toMatchObject({ key: "general", revision: 1 });

    const updated = await app.inject({
      method: "PATCH",
      url: `/api/v1/workflows/${workflow.json().workflow_id}`,
      headers: headers(),
      payload: { revision: 1, description: "Updated without review" }
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toMatchObject({ revision: 2, description: "Updated without review" });

    const audit = await repository.listAuditEvents();
    expect(audit.map((event) => event.action)).toEqual(expect.arrayContaining([
      "tag.created",
      "workflow.created",
      "workflow.updated"
    ]));
  });

  it("publishes Skill IR and its Claude artifact only after owner review", async () => {
    const proposedIr = { ...bootstrapSkill, version: "1.1.0", description: "Updated safely." };
    const proposal = await app.inject({
      method: "POST",
      url: "/api/v1/skill-proposals",
      headers: headers(),
      payload: { schema_version: 1, skill_ir: proposedIr, agent: "claude-code" }
    });
    expect(proposal.statusCode).toBe(201);
    expect(proposal.json()).toMatchObject({ status: "pending_review", skill_slug: "harness-sync" });

    const before = await app.inject({
      method: "GET",
      url: "/api/v1/skills/harness-sync",
      headers: headers()
    });
    expect(before.json().latest_version).toBe("1.0.0");

    const review = await app.inject({
      method: "POST",
      url: `/api/v1/skill-proposals/${proposal.json().proposal_id}/review`,
      headers: headers(),
      payload: { schema_version: 1, decision: "approve", comment: "Owner reviewed" }
    });
    expect(review.statusCode).toBe(201);
    expect(review.json()).toMatchObject({ decision: "approve", published_version: "1.1.0" });

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
  it("rejects non-monotonic Skill versions before creating a proposal", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/skill-proposals",
      headers: headers(),
      payload: {
        schema_version: 1,
        skill_ir: { ...bootstrapSkill, version: "0.9.0" },
        agent: "claude-code"
      }
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("SKILL_VERSION_NOT_FORWARD");
  });
});
