import { uuidV7 } from "@hunter-harness/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createServer } from "../src/app.js";
import type { RegistryPersistence } from "../src/registry/persistence.js";
import { MemoryRepository } from "../src/repositories/memory.js";
import { MemoryArtifactStorage } from "../src/storage/memory.js";

class MemoryPersistence implements RegistryPersistence {
  snapshot: unknown = null;
  async load(): Promise<unknown | null> { return this.snapshot; }
  async save(snapshot: unknown): Promise<void> { this.snapshot = structuredClone(snapshot); }
}

function fakeNpmFetch(version: string): typeof fetch {
  return async (input) => {
    const url = String(input);
    if (url.includes("registry.npmjs.org")) {
      return new Response(JSON.stringify({
        name: "@acme/widget",
        description: "A widget skill",
        license: "MIT",
        homepage: "https://example.com/widget",
        readme: "# Widget\nInstall me.",
        "dist-tags": { latest: version }
      }), { status: 200 });
    }
    return new Response("not found", { status: 404 });
  };
}

describe("/api/v1/external-skills", () => {
  const token = "external-owner-token";
  let repository: MemoryRepository;
  let persistence: MemoryPersistence;
  let app: Awaited<ReturnType<typeof createServer>>;

  beforeEach(async () => {
    repository = new MemoryRepository();
    persistence = new MemoryPersistence();
    await repository.createActorWithToken({ actorId: "actor_owner", token });
    app = await createServer({
      repository,
      storage: new MemoryArtifactStorage(),
      registryPersistence: persistence,
      config: { externalSkillRefreshIntervalMs: 0 },
      externalFetch: fakeNpmFetch("1.0.0")
    });
  });

  afterEach(async () => {
    await app.close();
  });

  function headers(): Record<string, string> {
    return {
      authorization: "Bearer " + token,
      "x-request-id": uuidV7(),
      "idempotency-key": uuidV7()
    };
  }

  it("creates, lists, patches curation note, refreshes without touching note, and deletes", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/external-skills",
      headers: headers(),
      payload: {
        source: { type: "npm", ref: "@acme/widget" },
        curationNote: "Owner picked this for SAP mapping",
        tags: ["sap"]
      }
    });
    expect(created.statusCode).toBe(201);
    const skill = created.json() as {
      id: string;
      curationNote: string;
      snapshot: { version: string | null };
      updateAvailable: boolean;
      revision: number;
    };
    expect(skill.curationNote).toBe("Owner picked this for SAP mapping");
    expect(skill.snapshot.version).toBe("1.0.0");
    expect(skill.updateAvailable).toBe(false);

    const listed = await app.inject({ method: "GET", url: "/api/v1/external-skills", headers: headers() });
    expect(listed.statusCode).toBe(200);
    expect((listed.json() as { items: unknown[] }).items).toHaveLength(1);

    const patched = await app.inject({
      method: "PATCH",
      url: `/api/v1/external-skills/${skill.id}`,
      headers: headers(),
      payload: { curationNote: "Still the best pick", revision: skill.revision }
    });
    expect(patched.statusCode).toBe(200);
    expect((patched.json() as { curationNote: string }).curationNote).toBe("Still the best pick");

    await app.close();
    app = await createServer({
      repository,
      storage: new MemoryArtifactStorage(),
      registryPersistence: persistence,
      config: { externalSkillRefreshIntervalMs: 0 },
      externalFetch: fakeNpmFetch("2.0.0")
    });

    const refreshed = await app.inject({
      method: "POST",
      url: `/api/v1/external-skills/${skill.id}/refresh`,
      headers: headers()
    });
    expect(refreshed.statusCode).toBe(200);
    const after = refreshed.json() as {
      curationNote: string;
      snapshot: { version: string | null };
      updateAvailable: boolean;
      revision: number;
    };
    expect(after.curationNote).toBe("Still the best pick");
    expect(after.snapshot.version).toBe("2.0.0");
    expect(after.updateAvailable).toBe(true);

    const acknowledged = await app.inject({
      method: "PATCH",
      url: `/api/v1/external-skills/${skill.id}`,
      headers: headers(),
      payload: { acknowledgeUpdate: true, revision: after.revision }
    });
    expect(acknowledged.statusCode).toBe(200);
    expect((acknowledged.json() as { updateAvailable: boolean }).updateAvailable).toBe(false);

    const deleted = await app.inject({
      method: "DELETE",
      url: `/api/v1/external-skills/${skill.id}`,
      headers: headers()
    });
    expect(deleted.statusCode).toBe(200);
    expect((deleted.json() as { deleted: boolean }).deleted).toBe(true);
  });

  it("loads snapshots without externalSkills as empty list", async () => {
    persistence.snapshot = {
      schemaVersion: 4,
      compilerVersion: "1.0.0",
      skills: [],
      proposals: [],
      tags: [],
      projectBindings: [],
      drafts: [],
      workflowFamilies: [],
      workflowFamilyDrafts: [],
      aiConfig: { defaultProvider: null, providers: [], usage: [] }
    };
    await app.close();
    app = await createServer({
      repository,
      storage: new MemoryArtifactStorage(),
      registryPersistence: persistence,
      config: { externalSkillRefreshIntervalMs: 0 },
      externalFetch: fakeNpmFetch("1.0.0")
    });
    const listed = await app.inject({ method: "GET", url: "/api/v1/external-skills", headers: headers() });
    expect(listed.statusCode).toBe(200);
    expect((listed.json() as { items: unknown[] }).items).toEqual([]);
  });

  it("rejects unauthenticated access", async () => {
    const response = await app.inject({ method: "GET", url: "/api/v1/external-skills" });
    expect(response.statusCode).toBe(401);
  });
});
