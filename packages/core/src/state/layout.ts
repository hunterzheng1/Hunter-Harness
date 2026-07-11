import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";

export interface StateLayout {
  root: string;
  harness: string;
  baseline: string;
  transactions: string;
  locks: string;
  local: string;
  serverArtifacts: string;
  reports: string;
}

export function stateLayout(projectRoot: string): StateLayout {
  const root = resolve(projectRoot);
  const harness = join(root, ".harness");
  return {
    root,
    harness,
    baseline: join(harness, "state", "baseline"),
    transactions: join(harness, "state", "transactions"),
    locks: join(harness, "state", "locks"),
    local: join(harness, "state", "local"),
    serverArtifacts: join(harness, "cache", "server-artifacts"),
    reports: join(harness, "reports")
  };
}

export async function ensureStateLayout(projectRoot: string): Promise<StateLayout> {
  const layout = stateLayout(projectRoot);
  // 仅创建事务/协议运行必需的 state 子目录；cache/server-artifacts 与 reports
  // 由各自 feature 在写入时通过 atomicWrite*/installStaged 懒创建（design §9）。
  await Promise.all([
    mkdir(layout.baseline, { recursive: true }),
    mkdir(layout.transactions, { recursive: true }),
    mkdir(layout.locks, { recursive: true }),
    mkdir(layout.local, { recursive: true })
  ]);
  return layout;
}
