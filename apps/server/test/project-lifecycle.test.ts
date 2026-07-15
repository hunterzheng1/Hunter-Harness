import { uuidV7 } from "@hunter-harness/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createServer } from "../src/app.js";
import { MemoryRepository } from "../src/repositories/memory.js";
import { MemoryArtifactStorage } from "../src/storage/memory.js";

describe("project recycle bin lifecycle", () => {
  let repository: MemoryRepository;
  let app: Awaited<ReturnType<typeof createServer>>;
  const token = "project-owner-token";

  beforeEach(async () => {
    repository = new MemoryRepository();
    await repository.createActorWithToken({ actorId: "actor_owner", token });
    await repository.createActorWithToken({ actorId: "actor_other", token: "other-token" });
    app = await createServer({ repository, storage: new MemoryArtifactStorage() });
  });

  afterEach(async () => {
    await app.close();
  });

  function headers(value = token): Record<string, string> {
    return {
      authorization: `Bearer ${value}`,
      "x-request-id": uuidV7(),
      "idempotency-key": uuidV7()
    };
  }

  async function createProject(name: string, localProjectKey = uuidV7()): Promise<string> {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/projects:resolve",
      headers: headers(),
      payload: {
        schema_version: 1,
        local_project_key: localProjectKey,
        display_name: name,
        requested_project_id: null,
        client_id: "cli_project_lifecycle"
      }
    });
    expect(response.statusCode).toBe(200);
    return response.json().project_id as string;
  }

  it("moves a project to a 30-day recycle bin and hides it from active projects", async () => {
    const projectId = await createProject("recyclable");
    await createProject("active");

    const archived = await app.inject({
      method: "DELETE",
      url: `/api/v1/projects/${projectId}`,
      headers: headers()
    });

    expect(archived.statusCode).toBe(200);
    expect(archived.json()).toMatchObject({
      project_id: projectId,
      lifecycle_state: "archived"
    });
    const archivedAt = Date.parse(archived.json().archived_at as string);
    const purgeAfter = Date.parse(archived.json().purge_after as string);
    expect(purgeAfter - archivedAt).toBe(30 * 24 * 60 * 60 * 1000);

    const active = await app.inject({
      method: "GET",
      url: "/api/v1/projects?limit=10",
      headers: headers()
    });
    expect(active.json().items).toHaveLength(1);
    expect(active.json().items[0].display_name).toBe("active");

    const trash = await app.inject({
      method: "GET",
      url: "/api/v1/projects?limit=10&state=archived",
      headers: headers()
    });
    expect(trash.json().items).toEqual([
      expect.objectContaining({ project_id: projectId, lifecycle_state: "archived" })
    ]);

    const inaccessible = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}`,
      headers: headers()
    });
    expect(inaccessible.statusCode).toBe(410);
    expect(inaccessible.json()).toMatchObject({ error: { code: "PROJECT_ARCHIVED" } });
  });

  it("restores a project from the recycle bin", async () => {
    const projectId = await createProject("restore-me");
    await app.inject({ method: "DELETE", url: `/api/v1/projects/${projectId}`, headers: headers() });

    const restored = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/restore`,
      headers: headers()
    });

    expect(restored.statusCode).toBe(200);
    expect(restored.json()).toMatchObject({
      project_id: projectId,
      lifecycle_state: "active",
      archived_at: null,
      purge_after: null
    });
    const detail = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}`,
      headers: headers()
    });
    expect(detail.statusCode).toBe(200);
  });

  it("permanently purges archived project data while retaining an inaccessible tombstone", async () => {
    const localProjectKey = uuidV7();
    const projectId = await createProject("purge-me", localProjectKey);
    await app.inject({ method: "DELETE", url: `/api/v1/projects/${projectId}`, headers: headers() });

    const purged = await app.inject({
      method: "DELETE",
      url: `/api/v1/projects/${projectId}/purge`,
      headers: headers()
    });

    expect(purged.statusCode).toBe(200);
    expect(purged.json()).toMatchObject({
      project_id: projectId,
      lifecycle_state: "purged"
    });
    const trash = await app.inject({
      method: "GET",
      url: "/api/v1/projects?limit=10&state=archived",
      headers: headers()
    });
    expect(trash.json().items).toEqual([]);

    const inaccessible = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}`,
      headers: headers()
    });
    expect(inaccessible.statusCode).toBe(410);
    expect(inaccessible.json()).toMatchObject({ error: { code: "PROJECT_PURGED" } });

    const cannotRestore = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/restore`,
      headers: headers()
    });
    expect(cannotRestore.statusCode).toBe(410);
    expect(cannotRestore.json()).toMatchObject({ error: { code: "PROJECT_PURGED" } });

    const replacement = await app.inject({
      method: "POST",
      url: "/api/v1/projects:resolve",
      headers: headers(),
      payload: {
        schema_version: 1,
        local_project_key: localProjectKey,
        display_name: "purge-me-again",
        requested_project_id: null,
        client_id: "cli_project_lifecycle"
      }
    });
    expect(replacement.statusCode).toBe(200);
    expect(replacement.json().project_id).not.toBe(projectId);
  });

  it("does not let another actor archive a project", async () => {
    const projectId = await createProject("private");

    const response = await app.inject({
      method: "DELETE",
      url: `/api/v1/projects/${projectId}`,
      headers: headers("other-token")
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: { code: "PROJECT_NOT_FOUND" } });
  });

  it("purges projects whose 30-day recycle-bin retention expired when the server starts", async () => {
    const projectId = await createProject("expired");
    const archivedAt = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString();
    await repository.archiveProject("actor_owner", projectId, archivedAt);

    await app.close();
    app = await createServer({ repository, storage: new MemoryArtifactStorage() });

    const trash = await app.inject({
      method: "GET",
      url: "/api/v1/projects?limit=10&state=archived",
      headers: headers()
    });
    expect(trash.json().items).toEqual([]);
    const detail = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}`,
      headers: headers()
    });
    expect(detail.json()).toMatchObject({ error: { code: "PROJECT_PURGED" } });
  });

  it("continues startup cleanup until more than one batch of expired projects is purged", async () => {
    const archivedAt = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString();
    const projectIds: string[] = [];
    for (let index = 0; index < 101; index += 1) {
      const { project } = await repository.resolveProject({
        actorId: "actor_owner",
        localProjectKey: uuidV7(),
        displayName: `expired-${index}`,
        requestedProjectId: null
      });
      projectIds.push(project.projectId);
      await repository.archiveProject("actor_owner", project.projectId, archivedAt);
    }

    await app.close();
    app = await createServer({ repository, storage: new MemoryArtifactStorage() });

    const trash = await app.inject({
      method: "GET",
      url: "/api/v1/projects?limit=100&state=archived",
      headers: headers()
    });
    expect(trash.json().items).toEqual([]);
    await expect(repository.getProject("actor_owner", projectIds.at(-1) ?? "")).rejects.toMatchObject({
      code: "PROJECT_PURGED"
    });
  });
});
