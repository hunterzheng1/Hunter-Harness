import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  assertSecureServerUrl,
  ensureCredentialsGitignore,
  InvalidCredentialsError,
  mergeLocalCredentials,
  readLocalCredentials,
  uuidV7,
  writeLocalCredentials
} from "@hunter-harness/core";

import { serializeCliResult, type CliResult } from "../output/json.js";
import type { CommandDependencies } from "./configure.js";

export interface ConnectOptions {
  key?: string;
  nonInteractive?: boolean;
  yes?: boolean;
  /** Explicitly allow rewriting a different local project_id. `--yes` alone is not enough. */
  rebind?: boolean;
  json?: boolean;
}

interface KeyInfo {
  kind: string;
  actor_id?: string;
  project_id?: string;
  scopes?: string[];
  label?: string;
}

/** Read project.project_id from .harness/project.yaml when present. */
async function readLocalProjectId(projectRoot: string): Promise<string | null> {
  const path = join(projectRoot, ".harness", "project.yaml");
  let content: string;
  try {
    content = await readFile(path, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
  const match = content.match(/^[ \t]*project_id:\s*['"]?([^'"\n#]+)/m);
  if (match === null) return null;
  const value = match[1]?.trim() ?? "";
  if (value === "" || value === "null" || value === "~" || value === "none") {
    return null;
  }
  return value;
}

/** Persist platform project_id into .harness/project.yaml when present. */
async function bindProjectIdInProjectYaml(
  projectRoot: string,
  projectId: string
): Promise<void> {
  const path = join(projectRoot, ".harness", "project.yaml");
  let content: string;
  try {
    content = await readFile(path, "utf8");
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
      throw error;
    }
    // connect may run before init — leave a minimal project stub.
    await writeFile(
      path,
      [
        "harness:",
        "  name: hunter-harness",
        "  schema_version: 1",
        "project:",
        "  name: " + (projectRoot.split(/[\\/]/).pop() ?? "project"),
        "  root: \".\"",
        "  project_id: " + projectId,
        ""
      ].join("\n"),
      "utf8"
    );
    return;
  }
  if (/^[ \t]*project_id:\s*/m.test(content)) {
    content = content.replace(
      /^([ \t]*project_id:\s*)(['"]?)[^'"\n#]*\2/m,
      "$1" + projectId
    );
  } else if (/^project:\s*$/m.test(content)) {
    content = content.replace(
      /^(project:\s*\n)/m,
      "$1  project_id: " + projectId + "\n"
    );
  } else {
    content += (content.endsWith("\n") ? "" : "\n") +
      "project:\n  project_id: " + projectId + "\n";
  }
  await writeFile(path, content, "utf8");
}

/**
 * `hunter-harness connect <url>`：交互式绑定平台。
 * 验证 API Key 后写入 .harness/credentials.local.yaml（并确保 gitignore），
 * 替代手工编辑 project.yaml + 环境变量的流程。
 */
export async function runConnect(
  serverUrlArg: string,
  options: ConnectOptions,
  dependencies: CommandDependencies
): Promise<number> {
  const requestId = uuidV7();

  function fail(code: string, message: string, exitCode: number): number {
    dependencies.stderr(code + ": " + message + "\n");
    if (options.json === true) {
      dependencies.stdout(serializeCliResult({
        schema_version: 1,
        command: "connect",
        request_id: requestId,
        dry_run: false,
        ok: false,
        exit_code: exitCode as CliResult["exit_code"],
        project_id: null,
        summary: {},
        items: [],
        warnings: [],
        errors: [{ code, message }]
      }));
    }
    return exitCode;
  }

  let serverUrl: string;
  try {
    serverUrl = assertSecureServerUrl(serverUrlArg);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return fail("SERVER_URL_INVALID", message, 2);
  }

  let key = options.key?.trim() ?? "";
  if (key === "") {
    if (options.nonInteractive === true) {
      return fail("KEY_REQUIRED", "非交互模式必须通过 --key 提供 API Key", 2);
    }
    key = (await (dependencies.promptSecret ?? dependencies.prompt)(
      "项目 API Key（在平台项目页「API 密钥」签发，输入将隐藏）: "
    )).trim();
    if (key === "") {
      return fail("KEY_REQUIRED", "未输入 API Key", 2);
    }
  }

  let info: KeyInfo;
  try {
    const response = await dependencies.fetch(serverUrl + "/api/v1/auth/key-info", {
      headers: {
        Accept: "application/json",
        Authorization: "Bearer " + key,
        "X-Request-Id": requestId
      }
    });
    if (response.status === 401) {
      return fail("KEY_INVALID", "服务端拒绝了该 API Key（401）", 3);
    }
    if (!response.ok) {
      return fail("SERVER_ERROR", "key 校验失败：HTTP " + response.status, 3);
    }
    info = await response.json() as KeyInfo;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return fail("NETWORK_ERROR", "无法连接到 " + serverUrl + "：" + message, 3);
  }

  const localProjectId = await readLocalProjectId(dependencies.cwd);
  const keyProjectId = info.project_id?.trim() || undefined;
  if (
    localProjectId !== null &&
    keyProjectId !== undefined &&
    localProjectId !== keyProjectId
  ) {
    const driftMessage =
      `本地 project_id（${localProjectId}）与 API Key 对应的项目（${keyProjectId}）不一致。` +
      "改绑需显式传入 --rebind（--yes 不足以改绑）。";
    if (options.rebind === true) {
      dependencies.stderr(
        `REBIND: 将把本地 project_id 从 ${localProjectId} 改为 ${keyProjectId}。\n`
      );
    } else if (options.nonInteractive === true) {
      return fail("PROJECT_REBIND_REQUIRED", driftMessage, 2);
    } else {
      dependencies.stderr(
        `检测到 project_id 漂移：\n` +
        `  本地：${localProjectId}\n` +
        `  Key： ${keyProjectId}\n`
      );
      const answer = (await dependencies.prompt(
        "确认改绑到 Key 对应的项目？需显式确认 [y/N]："
      )).trim();
      if (!/^(?:y|yes)$/i.test(answer)) {
        return fail(
          "PROJECT_REBIND_REQUIRED",
          "已取消改绑。如需改绑请重试并传入 --rebind。",
          2
        );
      }
    }
  }

  try {
    // connect 可在项目 init 之前运行，先确保 .harness/ 存在。
    await mkdir(join(dependencies.cwd, ".harness"), { recursive: true });
    const existing = await readLocalCredentials(dependencies.cwd);
    await writeLocalCredentials(dependencies.cwd, mergeLocalCredentials(existing, {
      server_url: serverUrl,
      token: key,
      ...(info.project_id === undefined ? {} : { project_id: info.project_id })
    }));
    await ensureCredentialsGitignore(dependencies.cwd);
    if (info.project_id !== undefined) {
      await bindProjectIdInProjectYaml(dependencies.cwd, info.project_id);
    }
  } catch (error) {
    if (error instanceof InvalidCredentialsError) {
      return fail("CREDENTIALS_INVALID", error.message, 3);
    }
    throw error;
  }

  const summaryLines = [
    "已连接 " + serverUrl,
    "凭据类型：" + info.kind +
      (info.project_id === undefined ? "" : "（项目 " + info.project_id + "）"),
    ...(info.scopes === undefined ? [] : ["权限范围：" + info.scopes.join(", ")]),
    "已写入 .harness/credentials.local.yaml（已加入 .gitignore）。"
  ];
  if (options.json === true) {
    dependencies.stdout(serializeCliResult({
      schema_version: 1,
      command: "connect",
      request_id: requestId,
      dry_run: false,
      ok: true,
      exit_code: 0,
      project_id: info.project_id ?? null,
      summary: {
        server_url: serverUrl,
        credential_kind: info.kind,
        ...(info.scopes === undefined ? {} : { scopes: info.scopes.join(",") }),
        ...(localProjectId !== null &&
          keyProjectId !== undefined &&
          localProjectId !== keyProjectId
          ? { rebound_from: localProjectId }
          : {})
      },
      items: [],
      warnings: [],
      errors: []
    }));
  } else {
    dependencies.stdout(summaryLines.join("\n") + "\n");
  }
  return 0;
}
