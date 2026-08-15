import { ArchiveEngineError } from "./errors.js";
import type {
  ArchiveLocalPort,
  ArchiveOperationRecord,
  ArchiveSnapshot,
  ArchiveSourceFile,
  ArchiveStage,
  ArchiveTerminalEvent,
  LocalArchiveReceipt,
  PublishedArchive,
  Sha256
} from "./types.js";

type CrashStep = "after_stage" | "after_publish" | "after_receipt";

export class InMemoryArchivePort implements ArchiveLocalPort {
  readonly changes = new Map<string, ArchiveSourceFile[]>();
  readonly operations = new Map<string, ArchiveOperationRecord>();
  readonly stages = new Map<string, ArchiveStage>();
  readonly archives = new Map<string, PublishedArchive>();
  readonly receipts = new Map<string, LocalArchiveReceipt>();
  readonly terminal_events: ArchiveTerminalEvent[] = [];
  readonly read_counts = new Map<string, number>();
  readonly stage_write_counts = new Map<string, number>();
  readonly quiesce_counts = new Map<string, number>();
  readonly active_owners = new Map<string, boolean>();
  network_calls = 0;
  model_calls = 0;
  private crashStep: CrashStep | undefined;

  constructor(input: { changes?: readonly ArchiveSnapshot[] } = {}) {
    for (const snapshot of input.changes ?? []) {
      this.setChange(snapshot.change_identity, snapshot.files);
    }
  }

  setChange(change_identity: string, files: readonly ArchiveSourceFile[]): void {
    this.changes.set(change_identity, files.map((file) => ({
      path: file.path,
      content: typeof file.content === "string" ? file.content : file.content.slice()
    })));
  }

  injectCrash(step: CrashStep): void {
    this.crashStep = step;
  }

  expireOperation(operation_id: string): void {
    const operation = this.operations.get(operation_id);
    if (operation !== undefined) {
      this.operations.set(operation_id, { ...operation, lease_expires_at: new Date(0).toISOString() });
    }
  }

  setOwnerActive(owner_id: string, active: boolean): void {
    this.active_owners.set(owner_id, active);
  }

  seedMismatchedArchive(
    operation_id: `archive_operation:${string}`,
    archive_path: string,
    archive_manifest_hash: Sha256
  ): void {
    const operation = this.operations.get(operation_id);
    if (operation === undefined) throw new Error("operation must exist before seeding archive");
    this.archives.set(archive_path, {
      operation_id,
      change_identity: operation.change_identity,
      archive_path,
      archive_manifest_hash,
      files: new Map()
    });
  }

  async readChangeSnapshot(change_identity: string): Promise<ArchiveSnapshot> {
    this.read_counts.set(change_identity, (this.read_counts.get(change_identity) ?? 0) + 1);
    const files = this.changes.get(change_identity);
    if (files === undefined) {
      throw new ArchiveEngineError(
        "ARCHIVE_INPUT_INVALID", "irrecoverable", "找不到待归档变更", false
      );
    }
    return {
      change_identity,
      files: files.map((file) => ({
        path: file.path,
        content: typeof file.content === "string" ? file.content : file.content.slice()
      }))
    };
  }

  async loadOperation(operation_id: string): Promise<ArchiveOperationRecord | undefined> {
    return this.operations.get(operation_id);
  }

  async saveOperation(record: ArchiveOperationRecord): Promise<void> {
    const existing = this.operations.get(record.operation_id);
    if (existing?.completed_at !== undefined &&
        record.completed_at !== existing.completed_at) {
      throw new ArchiveEngineError(
        "ARCHIVE_IMMUTABLE_CONFLICT", "irrecoverable", "归档完成时间证据不可变", false
      );
    }
    this.operations.set(record.operation_id, record);
  }

  async listOperations(change_identity: string): Promise<readonly ArchiveOperationRecord[]> {
    return [...this.operations.values()].filter((item) =>
      item.change_identity === change_identity
    );
  }

  async isOwnerActive(owner_id: string): Promise<boolean> {
    return this.active_owners.get(owner_id) ?? true;
  }

  async quiesce(change_identity: string): Promise<void> {
    this.quiesce_counts.set(
      change_identity,
      (this.quiesce_counts.get(change_identity) ?? 0) + 1
    );
  }

  async writeStage(stage: ArchiveStage): Promise<void> {
    const existing = this.stages.get(stage.operation_id);
    if (existing !== undefined && existing.archive_manifest_hash !== stage.archive_manifest_hash) {
      throw new ArchiveEngineError(
        "ARCHIVE_STAGE_INVALID", "irrecoverable", "暂存内容身份冲突", false
      );
    }
    this.stages.set(stage.operation_id, stage);
    this.stage_write_counts.set(
      stage.operation_id,
      (this.stage_write_counts.get(stage.operation_id) ?? 0) + 1
    );
    if (this.crashStep === "after_stage") {
      this.crashStep = undefined;
      throw new Error("injected crash after stage");
    }
  }

  async inspectStage(operation_id: string): Promise<ArchiveStage | undefined> {
    return this.stages.get(operation_id);
  }

  async publishStage(operation_id: string, archive_path: string): Promise<PublishedArchive> {
    const stage = this.stages.get(operation_id);
    if (stage === undefined || stage.archive_path !== archive_path) {
      throw new ArchiveEngineError(
        "ARCHIVE_STAGE_INVALID", "irrecoverable", "暂存归档不存在或路径不匹配", false
      );
    }
    const existing = this.archives.get(archive_path);
    if (existing !== undefined &&
        (existing.operation_id !== operation_id ||
         existing.archive_manifest_hash !== stage.archive_manifest_hash)) {
      throw new ArchiveEngineError(
        "ARCHIVE_IMMUTABLE_CONFLICT", "irrecoverable", "不可变归档路径已被其他内容占用", false
      );
    }
    const published = existing ?? {
      operation_id: stage.operation_id,
      change_identity: stage.change_identity,
      archive_path,
      archive_manifest_hash: stage.archive_manifest_hash,
      files: stage.files
    };
    this.archives.set(archive_path, published);
    if (this.crashStep === "after_publish") {
      this.crashStep = undefined;
      throw new Error("injected crash after publish");
    }
    return published;
  }

  async inspectArchive(archive_path: string): Promise<PublishedArchive | undefined> {
    return this.archives.get(archive_path);
  }

  async loadReceipt(operation_id: string): Promise<LocalArchiveReceipt | undefined> {
    return this.receipts.get(operation_id);
  }

  async writeReceipt(receipt: LocalArchiveReceipt): Promise<void> {
    const existing = this.receipts.get(receipt.operation_id);
    if (existing !== undefined && JSON.stringify(existing) !== JSON.stringify(receipt)) {
      throw new ArchiveEngineError(
        "ARCHIVE_IMMUTABLE_CONFLICT", "irrecoverable", "本地归档收据身份冲突", false
      );
    }
    this.receipts.set(receipt.operation_id, existing ?? receipt);
    if (this.crashStep === "after_receipt") {
      this.crashStep = undefined;
      throw new Error("injected crash after receipt");
    }
  }

  async appendTerminalEvent(event: ArchiveTerminalEvent): Promise<void> {
    if (!this.terminal_events.some((item) => item.operation_id === event.operation_id)) {
      this.terminal_events.push(event);
    }
  }
}
