#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { createInterface } from "node:readline/promises";

import { Command, CommanderError } from "commander";

import {
  runConfigure,
  type CommandDependencies,
  type ConfigureOptions
} from "./commands/configure.js";
import { runCleanup, type CleanupCommandOptions } from "./commands/cleanup.js";
import { runPush, type PushOptions } from "./commands/push.js";
import { runRefresh, type RefreshCommandOptions } from "./commands/refresh.js";
import { runUpdate, type UpdateOptions } from "./commands/update.js";
import { runRecoveryMenuIfApplicable } from "./commands/recovery.js";
import {
  resolveWorkflowResourcesRoot,
  WorkflowDataResolutionError
} from "./workflow-data/resolve.js";
import type { ResolveWorkflowDataOptions } from "./workflow-data/resolve.js";

export interface CliDependencies extends Partial<CommandDependencies> {
  cwd?: string;
  resourcesRoot?: string;
  pacoteExtract?: ResolveWorkflowDataOptions["pacoteExtract"];
}

function defaultDependencies(overrides: CliDependencies): CommandDependencies {
  return {
    cwd: overrides.cwd ?? process.cwd(),
    resourcesRoot: overrides.resourcesRoot ?? "",
    stdout: overrides.stdout ?? ((value) => process.stdout.write(value)),
    stderr: overrides.stderr ?? ((value) => process.stderr.write(value)),
    prompt: overrides.prompt ?? (async (question) => {
      const terminal = createInterface({ input: process.stdin, output: process.stdout });
      try {
        return await terminal.question(question);
      } finally {
        terminal.close();
      }
    }),
    fetch: overrides.fetch ?? globalThis.fetch,
    env: overrides.env ?? process.env
  };
}

function addCommonOptions(command: Command): Command {
  return command
    .option("--dry-run")
    .option("--yes")
    .option("--json")
    .option("--server-url <url>")
    .option("--token-env <ENV_NAME>")
    .option("--non-interactive")
    .option("--agents <csv>")
    .option("--codebuddy-surface <surface>")
    .option("--workflow-family <slug>")
    .option("--workflow-version <version>");
}

export async function runCli(
  argv: readonly string[],
  overrides: CliDependencies = {}
): Promise<number> {
  const dependencies = defaultDependencies(overrides);
  try {
    const resolveOptions: ResolveWorkflowDataOptions = {
      cwd: dependencies.cwd,
      env: dependencies.env,
      override: overrides.resourcesRoot
    };
    if (overrides.pacoteExtract !== undefined) {
      resolveOptions.pacoteExtract = overrides.pacoteExtract;
    }
    dependencies.resourcesRoot = await resolveWorkflowResourcesRoot(resolveOptions, argv);
  } catch (error) {
    if (error instanceof WorkflowDataResolutionError) {
      dependencies.stderr(error.message + "\n");
      return error.exitCode;
    }
    throw error;
  }

  const program = addCommonOptions(new Command())
    .name("hunter-harness")
    .description("Local-first, server-governed agent harness")
    .option("--profile <name>")
    .option("--config <file>")
    .option("--force-managed")
    .showHelpAfterError()
    .exitOverride()
    .configureOutput({
      writeOut: dependencies.stdout,
      writeErr: dependencies.stderr
    });

  let exitCode = 0;
  program.action(async (options: ConfigureOptions) => {
    const recoveryResult = await runRecoveryMenuIfApplicable(options, dependencies);
    if (recoveryResult !== null) {
      exitCode = recoveryResult;
      return;
    }
    exitCode = await runConfigure(options, dependencies);
  });
  addCommonOptions(program.command("refresh"))
    .description("本地保守刷新已安装的 Harness 项目")
    .option("--profile <name>")
    .option("--force-managed")
    .action(async (options: RefreshCommandOptions) => {
      exitCode = await runRefresh(
        { ...program.opts<RefreshCommandOptions>(), ...options },
        dependencies
      );
    });
  addCommonOptions(program.command("update"))
    .description("应用已批准的服务端产物")
    .action(async (options: UpdateOptions) => {
      exitCode = await runUpdate(
        { ...program.opts<UpdateOptions>(), ...options },
        dependencies
      );
    });
  addCommonOptions(program.command("push"))
    .description("创建受治理的变更提案")
    .action(async (options: PushOptions) => {
      exitCode = await runPush({ ...program.opts<PushOptions>(), ...options }, dependencies);
    });
  addCommonOptions(program.command("cleanup"))
    .description("清理已完成事务和过期服务端缓存")
    .action(async (options: CleanupCommandOptions) => {
      exitCode = await runCleanup(
        { ...program.opts<CleanupCommandOptions>(), ...options },
        dependencies
      );
    });

  try {
    await program.parseAsync(["node", "hunter-harness", ...argv]);
    return exitCode;
  } catch (error) {
    if (error instanceof CommanderError) {
      return error.code === "commander.helpDisplayed" ? 0 : 3;
    }
    throw error;
  }
}

if (process.argv[1] !== undefined &&
    import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await runCli(process.argv.slice(2));
}
