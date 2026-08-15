import { ArchivePackageBuilderError } from "./errors.js";
import { compareCodepoint, sha256Bytes, stableJson } from "./stable.js";
import type {
  ArchivePackageCompletionEvidence,
  ArchivePackageEntry,
  ArchivePackagePort,
  DeterministicZipConfig,
  InspectedArchivePackage
} from "./types.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const prefix = "HUNTER_DETERMINISTIC_ZIP_V1\n";

interface WirePackage {
  zip_config: DeterministicZipConfig;
  entries: Array<{ path: string; content_base64: string }>;
}

function encodeBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

function decodeBase64(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, "base64"));
}

export class InMemoryArchivePackagePort implements ArchivePackagePort {
  build_calls = 0;
  private readonly completions = new Map<string, ArchivePackageCompletionEvidence>();
  private readonly operationIdentities = new Map<string, string>();

  async build(entries: readonly ArchivePackageEntry[], config: DeterministicZipConfig): Promise<Uint8Array> {
    this.build_calls += 1;
    const wire: WirePackage = {
      zip_config: config,
      entries: [...entries]
        .sort((left, right) => compareCodepoint(left.path, right.path))
        .map((entry) => ({ path: entry.path, content_base64: encodeBase64(entry.content) }))
    };
    return encoder.encode(prefix + stableJson(wire));
  }

  async inspect(package_bytes: Uint8Array): Promise<InspectedArchivePackage> {
    try {
      const text = decoder.decode(package_bytes);
      if (!text.startsWith(prefix)) throw new Error("prefix");
      const wire = JSON.parse(text.slice(prefix.length)) as WirePackage;
      if (wire === null || typeof wire !== "object" || !Array.isArray(wire.entries)) throw new Error("wire");
      const entries = wire.entries.map((entry) => {
        if (typeof entry.path !== "string" || typeof entry.content_base64 !== "string") throw new Error("entry");
        const content = decodeBase64(entry.content_base64);
        return {
          path: entry.path,
          content,
          content_hash: sha256Bytes(content),
          size_bytes: content.byteLength
        };
      });
      return { zip_config: wire.zip_config, entries };
    } catch {
      throw new ArchivePackageBuilderError("ARCHIVE_PACKAGE_PORT_INVALID", "包字节无法解析");
    }
  }

  async persistCompletion(
    evidence: ArchivePackageCompletionEvidence
  ): Promise<ArchivePackageCompletionEvidence> {
    const operationIdentity = this.operationIdentities.get(evidence.operation_id);
    if (operationIdentity !== undefined && operationIdentity !== evidence.immutable_identity) {
      throw new ArchivePackageBuilderError(
        "ARCHIVE_PACKAGE_IMMUTABLE_CONFLICT",
        "相同本地归档操作的 package identity 已持久化"
      );
    }
    const prior = this.completions.get(evidence.package_operation_id);
    if (prior !== undefined && JSON.stringify(prior) !== JSON.stringify(evidence)) {
      throw new ArchivePackageBuilderError(
        "ARCHIVE_PACKAGE_IMMUTABLE_CONFLICT",
        "不可变 package completion evidence 发生漂移"
      );
    }
    const stored = Object.freeze({ ...evidence });
    this.operationIdentities.set(evidence.operation_id, evidence.immutable_identity);
    this.completions.set(evidence.package_operation_id, stored);
    return Object.freeze({ ...stored });
  }

  async readCompletion(
    package_operation_id: ArchivePackageCompletionEvidence["package_operation_id"]
  ): Promise<ArchivePackageCompletionEvidence | undefined> {
    const evidence = this.completions.get(package_operation_id);
    return evidence === undefined ? undefined : Object.freeze({ ...evidence });
  }
}
