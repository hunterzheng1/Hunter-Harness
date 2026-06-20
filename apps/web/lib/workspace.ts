import type { ArtifactManifestModel } from "./api";

import { classifyManagedFile, type WebFilePolicy } from "./file-policy";

export interface WorkspaceArtifact {
  artifactId: string;
  createdAt: string;
  manifest: ArtifactManifestModel;
  textByHash: ReadonlyMap<string, string>;
}

export interface WorkspaceFile {
  path: string;
  content: string | null;
  content_sha256: string;
  size_bytes: number;
  file_kind: string;
  policy: WebFilePolicy;
  artifact_id: string;
  project_version: string | null;
}

function target(operation: ArtifactManifestModel["files"][number]): string {
  return operation.operation === "rename" ? operation.to_path : operation.path;
}

export function reconstructWorkspace(artifacts: readonly WorkspaceArtifact[]): WorkspaceFile[] {
  const current = new Map<string, WorkspaceFile>();
  const ordered = [...artifacts].sort((left, right) =>
    left.createdAt.localeCompare(right.createdAt) || left.artifactId.localeCompare(right.artifactId)
  );
  for (const artifact of ordered) {
    for (const operation of artifact.manifest.files) {
      if (operation.operation === "delete") {
        current.delete(operation.path);
        continue;
      }
      const path = target(operation);
      if (operation.operation === "rename") current.delete(operation.from_path);
      current.set(path, {
        path,
        content: artifact.textByHash.get(operation.content_sha256) ?? null,
        content_sha256: operation.content_sha256,
        size_bytes: operation.size_bytes,
        file_kind: operation.file_kind,
        policy: classifyManagedFile(path),
        artifact_id: artifact.artifactId,
        project_version: artifact.manifest.project_version
      });
    }
  }
  return [...current.values()].sort((left, right) => left.path.localeCompare(right.path));
}
