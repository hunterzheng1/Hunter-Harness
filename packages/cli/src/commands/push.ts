import {
  assertHttpsServerUrl,
  ensureCredentialsGitignore,
  InvalidCredentialsError,
  mergeLocalCredentials,
  pushProject,
  PushWorkflowError,
  type PushWorkflowErrorDetails,
  readLocalCredentials,
  uuidV7,
  writeLocalCredentials
} from "@hunter-harness/core";

import type { CommandDependencies } from "./configure.js";
import { serializeCliResult, type CliResult } from "../output/json.js";

export interface PushOptions {
  serverUrl?: string;
  tokenEnv?: string;
  nonInteractive?: boolean;
  yes?: boolean;
  dryRun?: boolean;
  json?: boolean;
  skipSensitiveScan?: boolean;
}

function formatFindings(details: PushWorkflowErrorDetails | undefined): string {
  if (details?.findings === undefined || details.findings.length === 0) {
    return "";
  }
  const lines = [
    "敏感信息扫描发现 " + details.findings.length + " 个问题："
  ];
  for (const finding of details.findings) {
    lines.push(
      "  - " + finding.path + ":" + finding.line +
        " " + finding.rule_id + " (" + finding.severity +
        (finding.overridable ? ", 可覆盖" : ", 不可覆盖") + ")"
    );
  }
  return lines.join("\n") + "\n";
}

function errorPayload(
  error: unknown
): { exitCode: number; message: string; code: string; details?: PushWorkflowErrorDetails } {
  const exitCode = error instanceof PushWorkflowError ? error.exitCode : 1;
  const message = error instanceof Error ? error.message : String(error);
  const code = error instanceof PushWorkflowError ? error.code : "GENERAL_FAILURE";
  if (error instanceof PushWorkflowError && error.details !== undefined) {
    return { exitCode, message, code, details: error.details };
  }
  return { exitCode, message, code };
}

async function promptForCredentials(
  dependencies: CommandDependencies,
  missing: "url" | "token" | "both"
): Promise<{ serverUrl?: string; token?: string } | null> {
  const serverUrl = missing === "token"
    ? undefined
    : (await dependencies.prompt("服务端 URL (https://...): ")).trim();
  const token = missing === "url"
    ? undefined
    : (await (dependencies.promptSecret ?? dependencies.prompt)(
      "API Token（输入将隐藏）: "
    )).trim();
  if ((missing === "url" || missing === "both") &&
      (serverUrl === undefined || serverUrl === "")) {
    return null;
  }
  if ((missing === "token" || missing === "both") &&
      (token === undefined || token === "")) {
    return null;
  }
  if (serverUrl !== undefined && serverUrl !== "") {
    try {
      assertHttpsServerUrl(serverUrl);
    } catch (error) {
      if (error instanceof InvalidCredentialsError) {
        dependencies.stderr(error.message + "\n");
        return null;
      }
      throw error;
    }
  }
  return {
    ...(serverUrl === undefined ? {} : { serverUrl }),
    ...(token === undefined ? {} : { token })
  };
}

export async function runPush(
  options: PushOptions,
  dependencies: CommandDependencies
): Promise<number> {
  const requestId = uuidV7();
  if (options.nonInteractive === true && options.yes !== true &&
      options.dryRun !== true) {
    dependencies.stderr("非交互模式推送需要 --yes\n");
    return 2;
  }
  if (options.nonInteractive === true && options.skipSensitiveScan === true &&
      options.yes !== true) {
    dependencies.stderr("非交互跳过敏感扫描需要 --yes\n");
    return 2;
  }

  async function executePush(attempt = 0): Promise<number> {
    try {
      const result = await pushProject({
        projectRoot: dependencies.cwd,
        resourcesRoot: dependencies.resourcesRoot,
        ...(options.serverUrl === undefined ? {} : { serverUrl: options.serverUrl }),
        ...(options.tokenEnv === undefined ? {} : { tokenEnv: options.tokenEnv }),
        env: dependencies.env,
        dryRun: options.dryRun === true,
        fetch: dependencies.fetch,
        ...(options.skipSensitiveScan === true
          ? { sensitiveScanSkip: true }
          : {}),
        ...(options.yes === true || options.nonInteractive === true
          ? {}
          : { confirmProposal: async () => {
            const answer = await dependencies.prompt("Create this proposal? [y/N]: ");
            return /^(?:y|yes)$/i.test(answer.trim());
          } }),
        ...(options.yes === true || options.nonInteractive === true ||
            options.skipSensitiveScan === true
          ? {}
          : { confirmSensitiveScanSkip: async (preview) => {
            dependencies.stderr(formatFindings({
              findings: preview.security.findings
                .filter((finding) => finding.disposition === "blocked")
                .map((finding) => ({
                  path: finding.path,
                  rule_id: finding.rule_id,
                  severity: finding.severity,
                  overridable: finding.overridable,
                  fingerprint: finding.fingerprint,
                  line: finding.line,
                  column: finding.column
                })),
              finding_count: preview.security.findings.filter(
                (finding) => finding.disposition === "blocked"
              ).length,
              scanner_version: preview.security.scanner_version
            }));
            const answer = await dependencies.prompt(
              "敏感扫描已阻断推送。是否显式跳过并继续？[y/N]: "
            );
            if (!/^(?:y|yes)$/i.test(answer.trim())) {
              return "cancelled";
            }
            const reasonAnswer = await dependencies.prompt("跳过原因（可选，回车跳过）: ");
            const reason = reasonAnswer.trim();
            return reason === "" ? { skip: true } : { skip: true, reason };
          } })
      });
      if ("cancelled" in result && result.cancelled === true) {
        return 2;
      }
      const items = result.preview.operations.map((operation) => ({
        path: operation.operation === "rename" ? operation.to_path : operation.path,
        operation: operation.operation,
        file_kind: operation.file_kind,
        status: options.dryRun === true ? "planned" : "submitted",
        reason: null,
        size_bytes: "size_bytes" in operation ? operation.size_bytes : 0,
        content_sha256: "content_sha256" in operation
          ? operation.content_sha256
          : operation.tombstone.previous_sha256
      }));
      const output: CliResult = {
        schema_version: 1,
        command: "push",
        request_id: requestId,
        dry_run: options.dryRun === true,
        ok: true,
        exit_code: 0,
        project_id: result.projectId,
        summary: {
          planned: result.preview.operations.length,
          submitted: options.dryRun === true ? 0 : result.preview.operations.length,
          skipped: result.preview.skipped.length,
          findings: result.preview.security.findings.length
        },
        items,
        warnings: result.preview.skipped,
        errors: []
      };
      dependencies.stdout(options.json === true
        ? serializeCliResult(output)
        : options.dryRun === true
          ? "Push preview contains " + items.length + " operations.\n"
          : "Pushed artifact " +
            ("artifactId" in result ? String(result.artifactId) : "unknown") +
            " (proposal " + result.proposalId + ").\n");
      return 0;
    } catch (error) {
      if (attempt === 0 &&
          options.nonInteractive !== true &&
          options.dryRun !== true &&
          error instanceof PushWorkflowError &&
          (error.code === "SERVER_URL_REQUIRED" || error.code === "TOKEN_INVALID")) {
        const missingCredentials = error.details?.missing_credentials;
        const missing = missingCredentials?.includes("url") === true &&
            missingCredentials.includes("token")
          ? "both"
          : missingCredentials?.includes("url") === true ||
              error.code === "SERVER_URL_REQUIRED"
            ? "url"
            : "token";
        dependencies.stderr(
          error.message + "\n可在下方录入并写入 .harness/credentials.local.yaml。\n"
        );
        const entered = await promptForCredentials(dependencies, missing);
        if (entered !== null) {
          const existing = await readLocalCredentials(dependencies.cwd);
          try {
            await writeLocalCredentials(dependencies.cwd, mergeLocalCredentials(existing, {
              ...(entered.serverUrl === undefined ? {} : { server_url: entered.serverUrl }),
              ...(entered.token === undefined ? {} : { token: entered.token })
            }));
          } catch (error) {
            if (error instanceof InvalidCredentialsError) {
              dependencies.stderr(error.message + "\n");
              return 3;
            }
            throw error;
          }
          await ensureCredentialsGitignore(dependencies.cwd);
          dependencies.stderr(
            "已写入 .harness/credentials.local.yaml；upload session 由 CLI 自动管理，无需手配。\n"
          );
          return executePush(attempt + 1);
        }
      }

      const payload = errorPayload(error);
      dependencies.stderr(payload.message + "\n");
      dependencies.stderr(formatFindings(payload.details));
      if (options.json === true) {
        dependencies.stdout(serializeCliResult({
          schema_version: 1,
          command: "push",
          request_id: requestId,
          dry_run: options.dryRun === true,
          ok: false,
          exit_code: payload.exitCode as CliResult["exit_code"],
          project_id: null,
          summary: { planned: 0, submitted: 0 },
          items: [],
          warnings: [],
          errors: [{
            code: payload.code,
            message: payload.message,
            ...(payload.details === undefined ? {} : { details: payload.details })
          }]
        }));
      }
      return payload.exitCode;
    }
  }

  return executePush();
}
