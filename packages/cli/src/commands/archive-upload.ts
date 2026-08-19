import {
  ApiError,
  ArchiveUploadError,
  uploadArchivePackage
} from "@hunter-harness/core";

import type { CommandDependencies } from "./configure.js";

export interface ArchiveUploadOptions {
  file: string;
  changeKey: string;
  serverUrl?: string;
  tokenEnv?: string;
  nonInteractive?: boolean;
  yes?: boolean;
  json?: boolean;
  onReceipt?: (
    receipt: Awaited<ReturnType<typeof uploadArchivePackage>>
  ) => void | Promise<void>;
}

export async function runArchiveUpload(
  options: ArchiveUploadOptions,
  dependencies: CommandDependencies
): Promise<number> {
  if (options.nonInteractive === true && options.yes !== true) {
    dependencies.stderr("非交互归档上传需要 --yes\n");
    return 2;
  }
  try {
    const receipt = await uploadArchivePackage({
      projectRoot: dependencies.cwd,
      archivePath: options.file,
      changeKey: options.changeKey,
      ...(options.serverUrl === undefined ? {} : { serverUrl: options.serverUrl }),
      ...(options.tokenEnv === undefined ? {} : { tokenEnv: options.tokenEnv }),
      env: dependencies.env,
      fetch: dependencies.fetch
    });
    await options.onReceipt?.(receipt);
    const output = {
      schema_version: 1,
      command: "archive upload",
      ok: true,
      exit_code: 0,
      project_id: receipt.project_id,
      archive_id: receipt.archive_id,
      change_key: receipt.change_key,
      package_sha256: receipt.package_sha256,
      archive_status: receipt.archive_status,
      knowledge_status: receipt.knowledge_status,
      stored_files: receipt.stored_files,
      request_id: receipt.request_id,
      warnings: receipt.knowledge_status === "failed"
        ? ["归档已在服务端持久化，但知识索引失败；可重试同一个 ZIP。"]
        : []
    };
    dependencies.stdout(options.json === true
      ? JSON.stringify(output) + "\n"
      : `归档 ${receipt.change_key} 已保存到服务端，知识状态：${receipt.knowledge_status}。\n`);
    return 0;
  } catch (error) {
    // The server's own code is the only thing that says *why* an upload was
    // refused (ARCHIVE_PACKAGE_CONFLICT vs a transport failure). Flattening it
    // to ARCHIVE_UPLOAD_FAILED left callers guessing from prose.
    const serverCode = error instanceof ApiError && /^[A-Z][A-Z0-9_]{0,79}$/u.test(error.code)
      ? error.code
      : undefined;
    const code = error instanceof ArchiveUploadError
      ? error.code
      : serverCode ?? "ARCHIVE_UPLOAD_FAILED";
    const exitCode = error instanceof ArchiveUploadError ? error.exitCode : 1;
    const message = error instanceof Error ? error.message : String(error);
    // The archive endpoint answers 409 ARCHIVE_ALREADY_EXISTS; ARCHIVE_PACKAGE_CONFLICT
    // is the remote-sync contract's spelling. Accept both so the guidance fires.
    const hint = serverCode === "ARCHIVE_ALREADY_EXISTS" ||
      serverCode === "ARCHIVE_PACKAGE_CONFLICT"
      ? "\n该 change key 在服务端已存有一个不可变归档包，不接受不同字节的替换；" +
        "补传只适用于从未成功上传、或重试盘上留存的原包（republish --retry-retained）。\n"
      : "";
    dependencies.stderr(message + "\n" + hint);
    if (options.json === true) {
      dependencies.stdout(JSON.stringify({
        schema_version: 1,
        command: "archive upload",
        ok: false,
        exit_code: exitCode,
        project_id: null,
        errors: [{
          code,
          message,
          ...(error instanceof ApiError ? { server_status: error.status } : {})
        }],
        warnings: []
      }) + "\n");
    }
    return exitCode;
  }
}
