import { sha256Bytes, uuidV7 } from "@hunter-harness/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createServer } from "../src/app.js";
import { MemoryRepository } from "../src/repositories/memory.js";
import { MemoryArtifactStorage } from "../src/storage/memory.js";

const skill = `---
name: frontend-ui-beautify
description: Refine frontend UI
---
# frontend-ui-beautify
`;

function multipart(root = ""): { payload: string; headers: Record<string, string> } {
  const boundary = "----unified-skill-publish";
  const payload = [
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${root}SKILL.md"\r\nContent-Type: text/markdown\r\n\r\n${skill}\r\n`,
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${root}examples/nested/prompt.md"\r\nContent-Type: text/markdown\r\n\r\n# Prompt\r\n`,
    `--${boundary}--\r\n`
  ].join("");
  return { payload, headers: { "content-type": `multipart/form-data; boundary=${boundary}` } };
}

function reviewedMultipart(review?: Record<string, unknown>): { payload: string; headers: Record<string, string> } {
  const boundary = "----reviewed-skill-upload";
  const parts = [
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="SKILL.md"\r\nContent-Type: text/markdown\r\n\r\n${skill}\r\n`,
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="notes.md"\r\nContent-Type: text/markdown\r\n\r\npassword=sample-password\r\n`
  ];
  if (review !== undefined) {
    parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="sensitive_review"\r\n\r\n${JSON.stringify(review)}\r\n`);
  }
  parts.push(`--${boundary}--\r\n`);
  return { payload: parts.join(""), headers: { "content-type": `multipart/form-data; boundary=${boundary}` } };
}

describe("unified skill publish", () => {
  const token = "owner-token";
  let app: Awaited<ReturnType<typeof createServer>>;
  let repository: MemoryRepository;
  let storage: MemoryArtifactStorage;
  let publishCount = 0;

  beforeEach(async () => {
    repository = new MemoryRepository();
    storage = new MemoryArtifactStorage();
    await repository.createActorWithToken({ actorId: "actor_owner", token });
    publishCount = 0;
    app = await createServer({
      repository,
      storage,
      registryPersistence: {
        load: () => repository.loadRegistryState(),
        save: (snapshot) => repository.saveRegistryState(snapshot)
      },
      npmPublishConfig: { scope: "@hunter-harness", token: "npm-token" },
      npmPublisherDeps: {
        packDirectory: async () => Buffer.from("unified-tarball"),
        publish: async () => { publishCount += 1; }
      }
    });
  });

  afterEach(async () => app.close());

  function headers(): Record<string, string> {
    return {
      authorization: `Bearer ${token}`,
      "x-request-id": uuidV7(),
      "idempotency-key": uuidV7()
    };
  }

  it("publishes one Registry version and npm package for all four agents", async () => {
    const upload = multipart();
    const draft = await app.inject({
      method: "POST",
      url: "/api/v1/skills/draft?agent=claude-code",
      payload: upload.payload,
      headers: { ...headers(), ...upload.headers }
    });
    expect(draft.statusCode).toBe(201);

    const payload = { version: "0.1.0", sourceAgent: "claude-code", draftRevision: draft.json().revision, releaseNote: "initial release" };
    const published = await app.inject({
      method: "POST",
      url: "/api/v1/skills/frontend-ui-beautify/publish",
      payload,
      headers: headers()
    });
    expect(published.statusCode).toBe(200);
    expect(published.json()).toMatchObject({
      release: { slug: "frontend-ui-beautify", version: "0.1.0" },
      npmRelease: {
        status: "published",
        packageName: "@hunter-harness/frontend-ui-beautify",
        version: "0.1.0",
        tarballHash: expect.stringMatching(/^sha256:/)
      }
    });
    expect(publishCount).toBe(1);

    for (const agent of ["claude-code", "codex", "cursor", "codebuddy"]) {
      const versions = await app.inject({
        method: "GET",
        url: `/api/v1/skills/frontend-ui-beautify/versions?agent=${agent}`,
        headers: headers()
      });
      expect(versions.statusCode).toBe(200);
      expect(versions.json().items).toMatchObject([{ version: "0.1.0", agent }]);
    }

    const retry = await app.inject({
      method: "POST",
      url: "/api/v1/skills/frontend-ui-beautify/publish",
      payload,
      headers: headers()
    });
    expect(retry.statusCode).toBe(200);
    expect(retry.json().npmRelease.status).toBe("idempotent");
    expect(publishCount).toBe(1);

    await app.close();
    app = await createServer({
      repository,
      storage,
      registryPersistence: {
        load: () => repository.loadRegistryState(),
        save: (snapshot) => repository.saveRegistryState(snapshot)
      },
      npmPublishConfig: { scope: "@hunter-harness", token: "npm-token" },
      npmPublisherDeps: {
        packDirectory: async () => Buffer.from("unified-tarball"),
        publish: async () => { publishCount += 1; }
      }
    });
    const retryAfterRestart = await app.inject({
      method: "POST",
      url: "/api/v1/skills/frontend-ui-beautify/publish",
      payload,
      headers: headers()
    });
    expect(retryAfterRestart.statusCode).toBe(200);
    expect(retryAfterRestart.json().npmRelease.status).toBe("idempotent");
    expect(publishCount).toBe(1);
  });

  it("returns safe review details and accepts a matching authenticated review", async () => {
    const firstUpload = reviewedMultipart();
    const requested = await app.inject({
      method: "POST",
      url: "/api/v1/skills/draft?agent=claude-code",
      payload: firstUpload.payload,
      headers: { ...headers(), ...firstUpload.headers }
    });
    expect(requested.statusCode).toBe(422);
    expect(requested.json().error.code).toBe("SENSITIVE_CONTENT_REVIEW_REQUIRED");
    const details = requested.json().error.details as {
      scanner_version: string;
      findings: Array<{ fingerprint: string; redacted_preview: string }>;
    };
    expect(JSON.stringify(details)).not.toContain("sample-password");

    const acceptedUpload = reviewedMultipart({
      scanner_version: details.scanner_version,
      finding_fingerprints: details.findings.map((finding) => finding.fingerprint),
      reason: "documented sample credential"
    });
    const accepted = await app.inject({
      method: "POST",
      url: "/api/v1/skills/draft?agent=claude-code",
      payload: acceptedUpload.payload,
      headers: { ...headers(), ...acceptedUpload.headers }
    });
    expect(accepted.statusCode).toBe(201);
  });

  it("strips one browser-selected bundle root before storing the draft", async () => {
    const upload = multipart("frontend-ui-beautify/");
    const draft = await app.inject({
      method: "POST",
      url: "/api/v1/skills/draft?agent=claude-code",
      payload: upload.payload,
      headers: { ...headers(), ...upload.headers }
    });
    expect(draft.statusCode).toBe(201);
    expect(draft.json().sourceFiles.map((file: { path: string }) => file.path)).toEqual([
      "SKILL.md",
      "examples/nested/prompt.md"
    ]);
  });

  it("uses sourceAgent to disambiguate drafts with the same revision", async () => {
    for (const agent of ["claude-code", "codebuddy"]) {
      const upload = multipart();
      expect((await app.inject({
        method: "POST",
        url: `/api/v1/skills/draft?agent=${agent}`,
        payload: upload.payload,
        headers: { ...headers(), ...upload.headers }
      })).statusCode).toBe(201);
    }
    const published = await app.inject({
      method: "POST",
      url: "/api/v1/skills/frontend-ui-beautify/publish",
      payload: { version: "0.1.0", sourceAgent: "codebuddy", draftRevision: 1 },
      headers: headers()
    });
    expect(published.statusCode).toBe(200);
    const detail = await app.inject({ method: "GET", url: "/api/v1/skills/frontend-ui-beautify", headers: headers() });
    expect(detail.json().defaultAgent).toBe("codebuddy");
  });

  it("keeps the draft and returns a non-2xx response when npm rejects publish", async () => {
    await app.close();
    const repository = new MemoryRepository();
    await repository.createActorWithToken({ actorId: "actor_owner", token });
    app = await createServer({
      repository,
      storage: new MemoryArtifactStorage(),
      npmPublishConfig: { scope: "@hunter-harness", token: "npm-token" },
      npmPublisherDeps: {
        packDirectory: async () => Buffer.from("failed-tarball"),
        publish: async () => { throw new Error("registry unavailable"); }
      }
    });
    const upload = multipart();
    const draft = await app.inject({
      method: "POST",
      url: "/api/v1/skills/draft?agent=claude-code",
      payload: upload.payload,
      headers: { ...headers(), ...upload.headers }
    });
    const failed = await app.inject({
      method: "POST",
      url: "/api/v1/skills/frontend-ui-beautify/publish",
      payload: { version: "0.1.0", sourceAgent: "claude-code", draftRevision: draft.json().revision },
      headers: headers()
    });
    expect(failed.statusCode).toBe(502);
    expect(failed.json().error.code).toBe("NPM_PUBLISH_FAILED");
    const retained = await app.inject({
      method: "GET",
      url: "/api/v1/skills/frontend-ui-beautify/draft/claude-code",
      headers: headers()
    });
    expect(retained.statusCode).toBe(200);
  });

  it("restores local state after final persistence fails and recovers through npm digest idempotency", async () => {
    await app.close();
    const repository = new MemoryRepository();
    const storage = new MemoryArtifactStorage();
    await repository.createActorWithToken({ actorId: "actor_owner", token });
    let failNextSave = false;
    let publishAttempts = 0;
    app = await createServer({
      repository,
      storage,
      registryPersistence: {
        load: () => repository.loadRegistryState(),
        save: async (snapshot) => {
          if (failNextSave) {
            failNextSave = false;
            throw new Error("injected final persistence failure");
          }
          await repository.saveRegistryState(snapshot);
        }
      },
      npmPublishConfig: { scope: "@hunter-harness", token: "npm-token" },
      npmPublisherDeps: {
        packDirectory: async () => Buffer.from("retry-tarball"),
        publish: async () => {
          publishAttempts += 1;
          if (publishAttempts > 1) {
            const error = new Error("version conflict") as Error & { statusCode?: number };
            error.statusCode = 409;
            throw error;
          }
        },
        readRemotePackageDigest: async () => sha256Bytes(Buffer.from("retry-tarball"))
      }
    });
    const upload = multipart();
    const draft = await app.inject({
      method: "POST",
      url: "/api/v1/skills/draft?agent=claude-code",
      payload: upload.payload,
      headers: { ...headers(), ...upload.headers }
    });
    const payload = { version: "0.1.0", sourceAgent: "claude-code", draftRevision: draft.json().revision };
    failNextSave = true;
    const failed = await app.inject({
      method: "POST", url: "/api/v1/skills/frontend-ui-beautify/publish", payload, headers: headers()
    });
    expect(failed.statusCode).toBe(500);
    expect((await app.inject({
      method: "GET", url: "/api/v1/skills/frontend-ui-beautify/draft/claude-code", headers: headers()
    })).statusCode).toBe(200);

    const recovered = await app.inject({
      method: "POST", url: "/api/v1/skills/frontend-ui-beautify/publish", payload, headers: headers()
    });
    expect(recovered.statusCode).toBe(200);
    expect(recovered.json().npmRelease.status).toBe("idempotent");
    expect(publishAttempts).toBe(2);
    for (const agent of ["claude-code", "codex", "cursor", "codebuddy"]) {
      const versions = await app.inject({
        method: "GET", url: `/api/v1/skills/frontend-ui-beautify/versions?agent=${agent}`, headers: headers()
      });
      expect(versions.json().items).toHaveLength(1);
    }
  });
});
