import { uuidV7 } from "@hunter-harness/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createServer } from "../src/app.js";
import { MemoryRepository } from "../src/repositories/memory.js";
import { MemoryArtifactStorage } from "../src/storage/memory.js";

const token = "skill-center-owner-token";

const skillYaml = `name: harness-x
kind: governance
description: demo skill
triggers: ["run"]
inputs: ["ctx"]
outputs: ["out"]
forbidden_actions: ["automatic_git_write"]
required_context: ["AGENTS.md"]
profiles:
  general:
    enabled: true
adapters:
  claude-code:
    enabled: true
version: "1.0.0"
`;

function multipart(files: Array<{ path: string; content: string }>): {
  payload: string;
  headers: Record<string, string>;
} {
  const boundary = "----skill-center-test-boundary";
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

describe("skill-center end-to-end (tasks 14-17)", () => {
  let repository: MemoryRepository;
  let app: Awaited<ReturnType<typeof createServer>>;

  beforeEach(async () => {
    repository = new MemoryRepository();
    await repository.createActorWithToken({ actorId: "actor_owner", token });
    app = await createServer({ repository, storage: new MemoryArtifactStorage() });
  });

  afterEach(async () => app.close());

  function headers(extra: Record<string, string> = {}): Record<string, string> {
    return {
      authorization: "Bearer " + token,
      "x-request-id": uuidV7(),
      "idempotency-key": uuidV7(),
      ...extra
    };
  }

  async function uploadDraft(files: Array<{ path: string; content: string }>): Promise<void> {
    const up = multipart(files);
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/skills/draft",
      payload: up.payload,
      headers: { ...headers(), ...up.headers }
    });
    expect(res.statusCode).toBe(201);
  }

  it("upload → check → diff → publish → download end-to-end", async () => {
    await uploadDraft([{ path: "skill.yaml", content: skillYaml }, { path: "SKILL.md", content: "# harness-x" }]);

    const checksRes = await app.inject({ method: "POST", url: "/api/v1/skills/harness-x/draft/checks", payload: {}, headers: headers() });
    expect(checksRes.statusCode).toBe(200);
    expect(checksRes.json().items.length).toBeGreaterThan(0);

    const diffRes = await app.inject({ method: "GET", url: "/api/v1/skills/harness-x/diff", headers: headers() });
    expect(diffRes.statusCode).toBe(200);

    const pubRes = await app.inject({ method: "POST", url: "/api/v1/skills/harness-x/publish", payload: { version: "1.0.0", releaseNote: "init" }, headers: headers() });
    expect(pubRes.statusCode).toBe(200);
    expect(pubRes.json().version).toBe("1.0.0");

    const skillRes = await app.inject({ method: "GET", url: "/api/v1/skills/harness-x", headers: headers() });
    expect(skillRes.statusCode).toBe(200);
    expect(skillRes.json().latest_version).toBe("1.0.0");
    expect(skillRes.json().defaultAgent).toBe("claude-code");

    const dlRes = await app.inject({ method: "GET", url: "/api/v1/skills/harness-x/artifacts/claude-code/download", headers: headers() });
    expect(dlRes.statusCode).toBe(200);
    expect(dlRes.headers["x-content-sha256"]).toBeDefined();
  });

  it("idempotent publish by Idempotency-Key returns the same result", async () => {
    await uploadDraft([{ path: "skill.yaml", content: skillYaml }]);
    const key = uuidV7();
    const body = { version: "1.0.0" };
    const first = await app.inject({ method: "POST", url: "/api/v1/skills/harness-x/publish", payload: body, headers: headers({ "idempotency-key": key }) });
    expect(first.statusCode).toBe(200);
    const second = await app.inject({ method: "POST", url: "/api/v1/skills/harness-x/publish", payload: body, headers: headers({ "idempotency-key": key }) });
    expect(second.statusCode).toBe(200);
    expect(second.json().version).toBe("1.0.0");
  });

  it("delete skill then GET returns 404", async () => {
    await uploadDraft([{ path: "skill.yaml", content: skillYaml }]);
    await app.inject({ method: "POST", url: "/api/v1/skills/harness-x/publish", payload: { version: "1.0.0" }, headers: headers() });
    const delRes = await app.inject({ method: "DELETE", url: "/api/v1/skills/harness-x", headers: headers() });
    expect(delRes.statusCode).toBe(200);
    const after = await app.inject({ method: "GET", url: "/api/v1/skills/harness-x", headers: headers() });
    expect(after.statusCode).toBe(404);
    expect(after.json().error.code).toBe("SKILL_NOT_FOUND");
  });

  it("upload rejects sensitive high-risk content", async () => {
    const up = multipart([
      { path: "skill.yaml", content: skillYaml },
      { path: "secret.md", content: "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----" }
    ]);
    const res = await app.inject({ method: "POST", url: "/api/v1/skills/draft", payload: up.payload, headers: { ...headers(), ...up.headers } });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe("SENSITIVE_CONTENT_BLOCKED");
  });

  it("publish rejects non-forward version", async () => {
    await uploadDraft([{ path: "skill.yaml", content: skillYaml }]);
    await app.inject({ method: "POST", url: "/api/v1/skills/harness-x/publish", payload: { version: "1.0.0" }, headers: headers() });
    await uploadDraft([{ path: "skill.yaml", content: skillYaml }]);
    const res = await app.inject({ method: "POST", url: "/api/v1/skills/harness-x/publish", payload: { version: "0.9.0" }, headers: headers() });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe("VERSION_NOT_FORWARD");
  });
});
