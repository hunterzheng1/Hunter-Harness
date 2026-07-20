import { sha256Bytes, uuidV7 } from "@hunter-harness/core";
import AdmZip from "adm-zip";
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

function singleFileMultipart(filename: string, content: string): { payload: string; headers: Record<string, string> } {
  const boundary = "----single-skill-upload";
  const payload = [
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: text/markdown\r\n\r\n${content}\r\n`,
    `--${boundary}--\r\n`
  ].join("");
  return { payload, headers: { "content-type": `multipart/form-data; boundary=${boundary}` } };
}

function multiFileMultipart(files: Array<{ path: string; content: string }>): { payload: string; headers: Record<string, string> } {
  const boundary = "----multi-skill-upload";
  const parts = files.map(({ path, content }) =>
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${path}"\r\nContent-Type: text/plain\r\n\r\n${content}\r\n`
  );
  parts.push(`--${boundary}--\r\n`);
  return { payload: parts.join(""), headers: { "content-type": `multipart/form-data; boundary=${boundary}` } };
}

function corruptZipMultipart(): { payload: Buffer; headers: Record<string, string> } {
  const boundary = "----corrupt-zip-upload";
  return {
    payload: Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="skill.zip"\r\nContent-Type: application/zip\r\n\r\n`),
      Buffer.from("this is not a ZIP archive"),
      Buffer.from(`\r\n--${boundary}--\r\n`)
    ]),
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` }
  };
}

function maliciousZipMultipart(): { payload: Buffer; headers: Record<string, string> } {
  const zip = new AdmZip();
  zip.addFile("SKILL.md", Buffer.from(skill));
  zip.addFile("aa/secret.md", Buffer.from("blocked\n"));
  const bytes = zip.toBuffer();
  const safeName = Buffer.from("aa/secret.md");
  const unsafeName = Buffer.from("../secret.md");
  let offset = 0;
  let replacements = 0;
  while ((offset = bytes.indexOf(safeName, offset)) >= 0) {
    unsafeName.copy(bytes, offset);
    offset += unsafeName.length;
    replacements += 1;
  }
  if (replacements < 2) throw new Error("failed to construct malicious ZIP fixture");
  const boundary = "----malicious-zip-upload";
  return {
    payload: Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="skill.zip"\r\nContent-Type: application/zip\r\n\r\n`),
      bytes,
      Buffer.from(`\r\n--${boundary}--\r\n`)
    ]),
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` }
  };
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

  async function acceptReviewedDraft(): Promise<number> {
    const firstUpload = reviewedMultipart();
    const requested = await app.inject({
      method: "POST",
      url: "/api/v1/skills/draft?agent=claude-code",
      payload: firstUpload.payload,
      headers: { ...headers(), ...firstUpload.headers }
    });
    const details = requested.json().error.details as {
      scanner_version: string;
      findings: Array<{ fingerprint: string }>;
    };
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
    return accepted.json().revision as number;
  }

  async function mutatePersistedDraft(mutator: (files: Array<{ path: string; content: string }>) => void): Promise<void> {
    const snapshot = await repository.loadRegistryState() as {
      drafts?: Array<[string, Array<[string, { sourceFiles: Array<{ path: string; content: string }> }]>]>;
    } | null;
    const files = snapshot?.drafts?.[0]?.[1]?.[0]?.[1].sourceFiles;
    if (snapshot === null || files === undefined) throw new Error("persisted draft fixture is missing");
    mutator(files);
    await repository.saveRegistryState(snapshot);
    await app.close();
    app = await createServer({
      repository,
      storage,
      registryPersistence: {
        load: () => repository.loadRegistryState(),
        save: (nextSnapshot) => repository.saveRegistryState(nextSnapshot)
      },
      npmPublishConfig: { scope: "@hunter-harness", token: "npm-token" },
      npmPublisherDeps: {
        packDirectory: async () => Buffer.from("unified-tarball"),
        publish: async () => { publishCount += 1; }
      }
    });
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

  it("does not treat a new revision-one draft as an idempotent retry of an older release", async () => {
    const firstUpload = multipart();
    const firstDraft = await app.inject({
      method: "POST",
      url: "/api/v1/skills/draft?agent=claude-code",
      payload: firstUpload.payload,
      headers: { ...headers(), ...firstUpload.headers }
    });
    expect(firstDraft.json().revision).toBe(1);
    const firstPublish = await app.inject({
      method: "POST",
      url: "/api/v1/skills/frontend-ui-beautify/publish",
      payload: { version: "0.1.0", sourceAgent: "claude-code", draftRevision: 1 },
      headers: headers()
    });
    expect(firstPublish.statusCode).toBe(200);

    const secondUpload = multipart();
    const secondDraft = await app.inject({
      method: "POST",
      url: "/api/v1/skills/draft?agent=claude-code",
      payload: secondUpload.payload,
      headers: { ...headers(), ...secondUpload.headers }
    });
    expect(secondDraft.json().revision).toBe(1);
    const conflictingPublish = await app.inject({
      method: "POST",
      url: "/api/v1/skills/frontend-ui-beautify/publish",
      payload: { version: "0.1.0", sourceAgent: "claude-code", draftRevision: 1 },
      headers: headers()
    });
    expect(conflictingPublish.statusCode).toBe(409);
    expect(conflictingPublish.json().error.code).toBe("SKILL_VERSION_CONFLICT");
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

  it("requires a new review when persisted draft content changes the finding fingerprint", async () => {
    const revision = await acceptReviewedDraft();
    await mutatePersistedDraft((files) => {
      const notes = files.find((file) => file.path === "notes.md");
      if (notes === undefined) throw new Error("reviewed notes fixture is missing");
      notes.content = "password=changed-sample-password\n";
    });
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/skills/frontend-ui-beautify/publish",
      payload: { version: "0.1.0", sourceAgent: "claude-code", draftRevision: revision },
      headers: headers()
    });
    expect(response.statusCode).toBe(422);
    expect(response.json().error.code).toBe("SENSITIVE_CONTENT_REVIEW_REQUIRED");
    expect(publishCount).toBe(0);
  });

  it("preserves accepted review evidence when unrelated draft content changes", async () => {
    const revision = await acceptReviewedDraft();
    await mutatePersistedDraft((files) => {
      files.push({ path: "references/guide.md", content: "# guide\n" });
    });
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/skills/frontend-ui-beautify/publish",
      payload: { version: "0.1.0", sourceAgent: "claude-code", draftRevision: revision },
      headers: headers()
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().npmRelease.status).toBe("published");
    expect(publishCount).toBe(1);
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

  it("maps a missing SKILL.md entry to the Skill bundle contract", async () => {
    const upload = singleFileMultipart("README.md", "# missing entry\n");
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/skills/draft?agent=claude-code",
      payload: upload.payload,
      headers: { ...headers(), ...upload.headers }
    });
    expect(response.statusCode).toBe(422);
    expect(response.json().error.code).toBe("SKILL_BUNDLE_INVALID");
  });

  it("maps multipart size limits to the Skill upload contract", async () => {
    await app.close();
    const limitedRepository = new MemoryRepository();
    await limitedRepository.createActorWithToken({ actorId: "actor_owner", token });
    app = await createServer({
      repository: limitedRepository,
      storage: new MemoryArtifactStorage(),
      config: { maxFileBytes: 32 },
      npmPublishConfig: { scope: "@hunter-harness", token: "npm-token" }
    });
    const upload = singleFileMultipart("SKILL.md", skill);
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/skills/draft?agent=claude-code",
      payload: upload.payload,
      headers: { ...headers(), ...upload.headers }
    });
    expect(response.statusCode).toBe(413);
    expect(response.json().error.code).toBe("SKILL_UPLOAD_TOO_LARGE");
  });

  it("rejects folder uploads whose files cumulatively exceed maxProposalBytes", async () => {
    await app.close();
    const limitedRepository = new MemoryRepository();
    await limitedRepository.createActorWithToken({ actorId: "actor_owner", token });
    app = await createServer({
      repository: limitedRepository,
      storage: new MemoryArtifactStorage(),
      config: { maxFileBytes: 96, maxProposalBytes: 100 },
      npmPublishConfig: { scope: "@hunter-harness", token: "npm-token" }
    });
    const upload = multiFileMultipart([
      { path: "SKILL.md", content: skill },
      { path: "notes.md", content: "x".repeat(64) }
    ]);
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/skills/draft?agent=claude-code",
      payload: upload.payload,
      headers: { ...headers(), ...upload.headers }
    });
    expect(response.statusCode).toBe(413);
    expect(response.json().error.code).toBe("SKILL_UPLOAD_TOO_LARGE");
    const draft = await app.inject({
      method: "GET",
      url: "/api/v1/skills/frontend-ui-beautify/draft/claude-code",
      headers: headers()
    });
    expect(draft.statusCode).toBe(404);
  });

  it.each(["generic", "mcp"])("rejects legacy agent %s on new upload and publish APIs", async (agent) => {
    const upload = multipart();
    const uploaded = await app.inject({
      method: "POST",
      url: `/api/v1/skills/draft?agent=${agent}`,
      payload: upload.payload,
      headers: { ...headers(), ...upload.headers }
    });
    expect(uploaded.statusCode).toBe(422);
    expect(uploaded.json().error.code).toBe("SKILL_BUNDLE_INVALID");

    const published = await app.inject({
      method: "POST",
      url: "/api/v1/skills/frontend-ui-beautify/publish",
      payload: { version: "0.1.0", sourceAgent: agent, draftRevision: 1 },
      headers: headers()
    });
    expect(published.statusCode).toBe(422);
    expect(published.json().error.code).toBe("SKILL_BUNDLE_INVALID");
  });

  it("maps a corrupt ZIP archive to the Skill bundle contract", async () => {
    const upload = corruptZipMultipart();
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/skills/draft?agent=claude-code",
      payload: upload.payload,
      headers: { ...headers(), ...upload.headers }
    });
    expect(response.statusCode).toBe(422);
    expect(response.json().error.code).toBe("SKILL_BUNDLE_INVALID");
  });

  it("maps ZIP path traversal to the Skill bundle contract", async () => {
    const upload = maliciousZipMultipart();
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/skills/draft?agent=claude-code",
      payload: upload.payload,
      headers: { ...headers(), ...upload.headers }
    });
    expect(response.statusCode).toBe(422);
    expect(response.json().error.code).toBe("SKILL_BUNDLE_INVALID");
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

    const retained = await app.inject({
      method: "GET",
      url: "/api/v1/skills/frontend-ui-beautify/draft/claude-code",
      headers: headers()
    });
    expect(retained.statusCode).toBe(200);

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
    const retainedAfterRestart = await app.inject({
      method: "GET",
      url: "/api/v1/skills/frontend-ui-beautify/draft/claude-code",
      headers: headers()
    });
    expect(retainedAfterRestart.statusCode).toBe(200);
  });

  it("keeps the draft and returns a non-2xx response when npm rejects publish", async () => {
    await app.close();
    const repository = new MemoryRepository();
    await repository.createActorWithToken({ actorId: "actor_owner", token });
    const sensitiveMarker = "SENSITIVE_SENTINEL_VALUE";
    const sensitivePath = "C:\\Users\\Example\\private\\npmrc";
    app = await createServer({
      repository,
      storage: new MemoryArtifactStorage(),
      npmPublishConfig: { scope: "@hunter-harness", token: "npm-token" },
      npmPublisherDeps: {
        packDirectory: async () => Buffer.from("failed-tarball"),
        publish: async () => { throw new Error(`registry failed credential=${sensitiveMarker} at ${sensitivePath}`); }
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
    expect(JSON.stringify(failed.json())).not.toContain(sensitiveMarker);
    expect(JSON.stringify(failed.json())).not.toContain(sensitivePath);
    const retained = await app.inject({
      method: "GET",
      url: "/api/v1/skills/frontend-ui-beautify/draft/claude-code",
      headers: headers()
    });
    expect(retained.statusCode).toBe(200);
  });

  it("maps a remote package digest conflict to SKILL_VERSION_CONFLICT", async () => {
    await app.close();
    const conflictRepository = new MemoryRepository();
    await conflictRepository.createActorWithToken({ actorId: "actor_owner", token });
    app = await createServer({
      repository: conflictRepository,
      storage: new MemoryArtifactStorage(),
      npmPublishConfig: { scope: "@hunter-harness", token: "npm-token" },
      npmPublisherDeps: {
        packDirectory: async () => Buffer.from("local-tarball"),
        publish: async () => {
          const error = new Error("version conflict") as Error & { statusCode?: number };
          error.statusCode = 409;
          throw error;
        },
        readRemotePackageDigest: async () => sha256Bytes(Buffer.from("different-remote-tarball"))
      }
    });
    const upload = multipart();
    const draft = await app.inject({
      method: "POST",
      url: "/api/v1/skills/draft?agent=claude-code",
      payload: upload.payload,
      headers: { ...headers(), ...upload.headers }
    });
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/skills/frontend-ui-beautify/publish",
      payload: { version: "0.1.0", sourceAgent: "claude-code", draftRevision: draft.json().revision },
      headers: headers()
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("SKILL_VERSION_CONFLICT");
  });

  it("retries a persisted failed deprecated npm release after restart", async () => {
    await app.close();
    const sharedRepository = new MemoryRepository();
    const sharedStorage = new MemoryArtifactStorage();
    await sharedRepository.createActorWithToken({ actorId: "actor_owner", token });
    const registryPersistence = {
      load: () => sharedRepository.loadRegistryState(),
      save: (snapshot: unknown) => sharedRepository.saveRegistryState(snapshot)
    };
    app = await createServer({
      repository: sharedRepository,
      storage: sharedStorage,
      registryPersistence,
      npmPublishConfig: { scope: null, token: null }
    });
    const upload = multipart();
    await app.inject({
      method: "POST",
      url: "/api/v1/skills/draft?agent=claude-code",
      payload: upload.payload,
      headers: { ...headers(), ...upload.headers }
    });
    const internalPublish = await app.inject({
      method: "POST",
      url: "/api/v1/skills/frontend-ui-beautify/draft/claude-code/publish",
      payload: { version: "0.1.0" },
      headers: headers()
    });
    expect(internalPublish.statusCode).toBe(200);

    await app.close();
    app = await createServer({
      repository: sharedRepository,
      storage: sharedStorage,
      registryPersistence,
      npmPublishConfig: { scope: "@hunter-harness", token: "npm-token" },
      npmPublisherDeps: {
        packDirectory: async () => Buffer.from("legacy-tarball"),
        publish: async () => { throw new Error("registry unavailable"); }
      }
    });
    const failed = await app.inject({
      method: "POST",
      url: "/api/v1/skills/frontend-ui-beautify/npm-release",
      headers: headers()
    });
    expect(failed.statusCode).toBe(502);

    await app.close();
    app = await createServer({
      repository: sharedRepository,
      storage: sharedStorage,
      registryPersistence,
      npmPublishConfig: { scope: "@hunter-harness", token: "npm-token" },
      npmPublisherDeps: {
        packDirectory: async () => Buffer.from("legacy-tarball"),
        publish: async () => undefined
      }
    });
    const retried = await app.inject({
      method: "POST",
      url: "/api/v1/skills/frontend-ui-beautify/npm-release",
      headers: headers()
    });
    expect(retried.statusCode).toBe(200);
    expect(retried.json().release.status).toBe("published");
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
