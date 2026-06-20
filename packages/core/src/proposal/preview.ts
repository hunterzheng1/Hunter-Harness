import { buildProposalDiff, type ProposalDiffInput } from "./diff.js";
import {
  scanSensitiveFiles,
  type ScanOptions
} from "../security/scanner.js";

export function generateProposalPreview(
  input: ProposalDiffInput,
  scanOptions: ScanOptions = {}
) {
  const diff = buildProposalDiff(input);
  const includedFiles = Object.fromEntries(
    Object.values(diff.operations)
      .filter((operation) => operation.operation !== "delete")
      .map((operation) => {
        const hash = operation.content_sha256;
        const path = operation.operation === "rename" ? operation.to_path : operation.path;
        return [path, diff.blobs[hash] ?? ""];
      })
  );
  const security = scanSensitiveFiles(includedFiles, scanOptions);
  return {
    blocked: security.blocked,
    operations: diff.operations,
    skipped: diff.skipped,
    blobs: diff.blobs,
    security
  };
}
