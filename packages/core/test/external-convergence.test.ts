import { describe, expect, it } from "vitest";

import {
  ExternalObservationError,
  convergeAuthoritativeState,
  type AuthoritativeObservation
} from "../src/external/convergence.js";

function observation(
  overrides: Partial<AuthoritativeObservation> = {}
): AuthoritativeObservation {
  return {
    subjectIdentity: "release:sha256:abc",
    businessState: "RUNNING",
    observationState: "PENDING",
    freshness: "FRESH",
    retryable: true,
    reasonCode: "REMOTE_RUNNING",
    observedAt: "2026-07-29T12:00:00.000Z",
    ...overrides
  };
}

describe("authoritative external-state convergence", () => {
  it("retries only pending observations and accepts the authoritative terminal success", async () => {
    const values = [
      observation({ freshness: "STALE", reasonCode: "STALE_READ" }),
      observation(),
      observation({
        businessState: "SUCCEEDED",
        observationState: "TERMINAL",
        retryable: false,
        reasonCode: "REMOTE_SUCCEEDED"
      })
    ];
    const delays: number[] = [];
    let clock = 0;

    const result = await convergeAuthoritativeState({
      expectedSubjectIdentity: "release:sha256:abc",
      observe: async () => {
        const observation = values.shift();
        if (observation === undefined) {
          throw new Error("test observation sequence exhausted");
        }
        return observation;
      },
      maxAttempts: 4,
      maxElapsedMs: 10_000,
      retryScheduleMs: [10, 20, 40],
      now: () => clock,
      sleep: async (milliseconds) => {
        delays.push(milliseconds);
        clock += milliseconds;
      }
    });

    expect(result.status).toBe("CONVERGED");
    expect(result.attempts).toBe(3);
    expect(delays).toEqual([10, 20]);
    expect(result.lastObservation?.businessState).toBe("SUCCEEDED");
    expect(result.history.map((item) => item.reasonCode)).toEqual([
      "STALE_READ",
      "REMOTE_RUNNING",
      "REMOTE_SUCCEEDED"
    ]);
  });

  it("does not retry non-retryable transport failures", async () => {
    let calls = 0;
    const result = await convergeAuthoritativeState({
      expectedSubjectIdentity: "release:sha256:abc",
      observe: async () => {
        calls += 1;
        throw new ExternalObservationError(
          "AUTH_REJECTED",
          "remote credentials were rejected",
          false
        );
      },
      maxAttempts: 5,
      maxElapsedMs: 10_000,
      sleep: async () => undefined
    });

    expect(calls).toBe(1);
    expect(result.status).toBe("OBSERVATION_FAILED");
    expect(result.reasonCode).toBe("AUTH_REJECTED");
  });

  it("stops on terminal failure and never converts it into success", async () => {
    const result = await convergeAuthoritativeState({
      expectedSubjectIdentity: "release:sha256:abc",
      observe: async () => observation({
        businessState: "FAILED",
        observationState: "TERMINAL",
        retryable: false,
        reasonCode: "REMOTE_FAILED"
      })
    });

    expect(result.status).toBe("TERMINAL_FAILURE");
    expect(result.reasonCode).toBe("REMOTE_FAILED");
    expect(result.attempts).toBe(1);
  });

  it("fails closed when an observation belongs to another subject", async () => {
    const result = await convergeAuthoritativeState({
      expectedSubjectIdentity: "release:sha256:abc",
      observe: async () => observation({
        subjectIdentity: "release:sha256:different",
        businessState: "SUCCEEDED",
        observationState: "TERMINAL",
        retryable: false
      })
    });

    expect(result.status).toBe("IDENTITY_MISMATCH");
    expect(result.reasonCode).toBe("SUBJECT_IDENTITY_MISMATCH");
  });

  it("honors the elapsed-time budget before sleeping again", async () => {
    let clock = 0;
    const result = await convergeAuthoritativeState({
      expectedSubjectIdentity: "release:sha256:abc",
      observe: async () => observation(),
      maxAttempts: 10,
      maxElapsedMs: 15,
      retryScheduleMs: [10, 10, 10],
      now: () => clock,
      sleep: async (milliseconds) => {
        clock += milliseconds;
      }
    });

    expect(result.status).toBe("EXHAUSTED");
    expect(result.reasonCode).toBe("OBSERVATION_BUDGET_EXHAUSTED");
    expect(result.attempts).toBe(2);
    expect(clock).toBe(10);
  });
});
