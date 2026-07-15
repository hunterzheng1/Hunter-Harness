import type { FileOperation } from "@hunter-harness/contracts";

import { ServerDomainError, type ProjectFileRecord } from "./interfaces.js";

function conflict(path: string, reason: string): never {
  throw new ServerDomainError(409, "PROJECT_FILE_CONFLICT", reason, { path });
}

export function applyProjectFileOperations(
  source: Iterable<ProjectFileRecord>,
  operations: FileOperation[],
  projectVersion: string,
  updatedAt: string,
  strict = true
): ProjectFileRecord[] {
  const files = new Map([...source].map((file) => [file.path, { ...file }]));
  for (const operation of operations) {
    if (operation.operation === "add") {
      if (strict && files.has(operation.path)) {
        conflict(operation.path, "file already exists");
      }
      files.set(operation.path, {
        projectId: "",
        path: operation.path,
        fileKind: operation.file_kind,
        contentSha256: operation.content_sha256,
        sizeBytes: operation.size_bytes,
        projectVersion,
        updatedAt
      });
      continue;
    }

    if (operation.operation === "modify") {
      const current = files.get(operation.path);
      if (strict && current?.contentSha256 !== operation.base_content_sha256) {
        conflict(operation.path, "file changed since the proposal was created");
      }
      files.set(operation.path, {
        projectId: current?.projectId ?? "",
        path: operation.path,
        fileKind: operation.file_kind,
        contentSha256: operation.content_sha256,
        sizeBytes: operation.size_bytes,
        projectVersion,
        updatedAt
      });
      continue;
    }

    if (operation.operation === "rename") {
      const current = files.get(operation.from_path);
      if (strict && current?.contentSha256 !== operation.base_content_sha256) {
        conflict(operation.from_path, "source file changed since the proposal was created");
      }
      if (strict && operation.to_path !== operation.from_path && files.has(operation.to_path)) {
        conflict(operation.to_path, "rename target already exists");
      }
      files.delete(operation.from_path);
      files.set(operation.to_path, {
        projectId: current?.projectId ?? "",
        path: operation.to_path,
        fileKind: operation.file_kind,
        contentSha256: operation.content_sha256,
        sizeBytes: operation.size_bytes,
        projectVersion,
        updatedAt
      });
      continue;
    }

    const current = files.get(operation.path);
    if (strict && current?.contentSha256 !== operation.base_content_sha256) {
      conflict(operation.path, "file changed since the proposal was created");
    }
    files.delete(operation.path);
  }
  return [...files.values()].sort((left, right) => left.path.localeCompare(right.path));
}
