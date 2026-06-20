import { describe, expect, it } from "vitest";

import { idempotencyLockKey } from "../src/repositories/postgres.js";

describe("idempotencyLockKey", () => {
  it("encodes lock identity without a PostgreSQL-invalid NUL byte", () => {
    const key = idempotencyLockKey({
      actorId: "actor\0with-nul",
      method: "POST",
      path: "/api/v1/projects:resolve",
      key: "idempotency-key"
    });

    expect(key).not.toContain("\0");
    expect(key).toBe(JSON.stringify([
      "actor\0with-nul",
      "POST",
      "/api/v1/projects:resolve",
      "idempotency-key"
    ]));
  });

  it("does not collide when field boundaries differ", () => {
    expect(idempotencyLockKey({
      actorId: "a",
      method: "BC",
      path: "/d",
      key: "e"
    })).not.toBe(idempotencyLockKey({
      actorId: "aB",
      method: "C",
      path: "/d",
      key: "e"
    }));
  });
});
