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
  await Promise.all([
    mkdir(layout.baseline, { recursive: true }),
    mkdir(layout.transactions, { recursive: true }),
    mkdir(layout.locks, { recursive: true }),
    mkdir(layout.local, { recursive: true }),
    mkdir(layout.serverArtifacts, { recursive: true }),
    mkdir(layout.reports, { recursive: true })
  ]);
  return layout;
}
