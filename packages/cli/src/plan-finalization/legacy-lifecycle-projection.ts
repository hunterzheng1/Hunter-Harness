import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { join } from "node:path";

/**
 * HP-09：v2 finalize 成功后向 legacy events.ndjson 幂等投影终态。
 * 唯一事实源仍是 v2 durable outbox；本投影只关闭 legacy 侧仍打开的
 * plan 尝试（同 run_id/attempt 的 phase.start 无终端事件时补 phase.end）。
 * 重复执行不产生第二个终态。
 */

interface LegacyEvent {
  readonly schema_version?: number;
  readonly phase?: string;
  readonly type?: string;
  readonly run_id?: string;
  readonly attempt?: number;
}

const TERMINAL_TYPES = new Set(["phase.end", "phase.auto_sealed"]);

export interface LegacyLifecycleProjectionResult {
  readonly projected: boolean;
  readonly reason: "closed_open_attempt" | "already_closed" | "no_legacy_events" | "no_open_attempt";
}

export async function projectLegacyPlanLifecycle(input: {
  readonly changeDir: string;
  readonly runId: string;
  readonly attempt: number;
  readonly receiptId: string;
  readonly now: () => string;
}): Promise<LegacyLifecycleProjectionResult> {
  const eventsPath = join(input.changeDir, "events.ndjson");
  let raw: string;
  try {
    raw = await fs.readFile(eventsPath, "utf8");
  } catch {
    return Object.freeze({ projected: false, reason: "no_legacy_events" });
  }
  const events = raw.trim().split("\n").filter((line) => line.length > 0)
    .map((line) => {
      try {
        return JSON.parse(line) as LegacyEvent;
      } catch {
        return {} as LegacyEvent;
      }
    });
  // 找最后一个匹配的 plan phase.start，且其后无终端事件
  let openStartIndex = -1;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index] as LegacyEvent;
    if (event.phase !== "plan" || event.run_id !== input.runId ||
        event.attempt !== input.attempt) continue;
    if (TERMINAL_TYPES.has(event.type ?? "")) break;
    if (event.type === "phase.start") {
      openStartIndex = index;
      break;
    }
  }
  if (openStartIndex < 0) {
    // 无打开的 start：已关闭或从未打开——查是否已有投影终态
    const alreadyClosed = events.some((event) => event.phase === "plan" &&
      event.run_id === input.runId && event.attempt === input.attempt &&
      TERMINAL_TYPES.has(event.type ?? ""));
    return Object.freeze({
      projected: false,
      reason: alreadyClosed ? "already_closed" : "no_open_attempt"
    });
  }
  const projection = {
    schema_version: 3,
    id: `evt-${randomUUID().replaceAll("-", "")}`,
    timestamp: input.now(),
    phase: "plan",
    type: "phase.end",
    run_id: input.runId,
    attempt: input.attempt,
    status: "OK",
    note: `v2 finalization committed: ${input.receiptId}`
  };
  await fs.appendFile(eventsPath, `${JSON.stringify(projection)}\n`, "utf8");
  return Object.freeze({ projected: true, reason: "closed_open_attempt" });
}
