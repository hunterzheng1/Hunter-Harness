import {
  createArchiveOutbox,
  createArchiveRemoteAdapter,
  type ArchiveOutboxClaim
} from "@hunter-harness/core";

import type { ArchiveRetentionPolicy, SourceRef } from "@hunter-harness/core";
import type { ArchivePublishInput } from "../commands/push-pull.js";
import { createFsArchiveOutboxPort } from "./fs-outbox-port.js";
import { createLocalArchiveZipResolver } from "./cas-store.js";
import { createArchivePackageVerifier } from "./production-ports.js";

/**
 * 06B-3 W4 生产组合：FS outbox + CAS resolver + 包验证器 + RemoteSyncModule publisher
 * → ArchiveRemoteAdapter，以及 harness-push --scope archive 的 claim 供应工厂。
 *
 * CLI 单次调用语义：一次进程只发布一个归档，resolver 的项目绑定由
 * pushPullArchive 在 claim 前从 durable record 捕获（project 隔离在
 * 字节复核 + record↔receipt 校验两层仍成立）。
 */

interface PublisherLike {
  publishArchive(packageRef: unknown, sourceRef: unknown, expectedHash: string): Promise<unknown>;
}

interface OutboxModuleLike {
  claim(entryId: string, ownerId: string, leaseTtlMs: number): Promise<ArchiveOutboxClaim>;
  ack(claim: ArchiveOutboxClaim, receipt: unknown, policy: unknown): Promise<unknown>;
  nack(claim: ArchiveOutboxClaim, reasonCode: string, retryable: boolean): Promise<unknown>;
}

export interface ArchiveProductionComposition {
  readonly remoteAdapter: unknown;
  readonly pushPullArchive: (change: string) => Promise<ArchivePublishInput>;
}

const OWNER_ID = "cli:archive-push";
const LEASE_TTL_MS = 5 * 60_000;

export function composeArchiveProduction(options: {
  readonly projectRoot: string;
  readonly publisher: PublisherLike;
  readonly resolveSource: (change: string) => Promise<SourceRef>;
}): ArchiveProductionComposition {
  const root = options.projectRoot;
  const outboxModule = createArchiveOutbox({
    port: createFsArchiveOutboxPort({ projectRoot: root }) as never,
    package_verifier: createArchivePackageVerifier({ projectRoot: root }) as never
  }) as unknown as OutboxModuleLike;
  const resolver = createLocalArchiveZipResolver({ projectRoot: root });
  // 单次调用进程的项目上下文：claim 时从 source_ref 捕获
  let activeProjectId: string | undefined;
  const remoteAdapter = createArchiveRemoteAdapter({
    outbox: outboxModule as never,
    zip_reader: {
      read: (ref: Parameters<typeof resolver.resolve>[0]) => {
        if (activeProjectId === undefined) throw new Error("ARCHIVE_ZIP_REF_UNTRUSTED");
        return resolver.resolve(ref, activeProjectId);
      }
    } as never,
    publisher: options.publisher as never
  });

  async function pushPullArchive(change: string) {
    const port = createFsArchiveOutboxPort({ projectRoot: root });
    let cursor: string | undefined;
    let record: { entry_id: string; state: string; project_id?: string } | undefined;
    do {
      const page = await port.list(cursor, 100);
      for (const candidate of page.records as unknown as readonly { entry_id: string; state: string; change_identity?: string; project_id?: string }[]) {
        if ((candidate.state === "queued" || candidate.state === "retry_wait") &&
            candidate.change_identity === change) {
          record = candidate;
          break;
        }
      }
      if (record !== undefined) break;
      cursor = page.next_cursor;
    } while (cursor !== undefined);
    if (record === undefined) throw new Error("PUSH_PULL_ARCHIVE_UNAVAILABLE");
    if (typeof record.project_id !== "string" || record.project_id === "") {
      throw new Error("PUSH_PULL_ARCHIVE_UNAVAILABLE");
    }
    const claim = await outboxModule.claim(record.entry_id, OWNER_ID, LEASE_TTL_MS);
    const source_ref = await options.resolveSource(change);
    activeProjectId = source_ref.project_id;
    return {
      claim,
      source_ref: { ...source_ref, change_key: change },
      retention_policy: "retain" as ArchiveRetentionPolicy
    };
  }

  return Object.freeze({ remoteAdapter, pushPullArchive });
}
