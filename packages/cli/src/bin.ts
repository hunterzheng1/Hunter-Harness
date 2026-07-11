#!/usr/bin/env node
import { fileURLToPath, pathToFileURL } from "node:url";
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

export interface CliDependencies extends Partial<CommandDependencies> {
  cwd?: string;
  resourcesRoot?: string;
}

function defaultDependencies(overrides: CliDependencies): CommandDependencies {
  return {
    cwd: overrides.cwd ?? process.cwd(),
    resourcesRoot: overrides.resourcesRoot ?? fileURLToPath(
      new URL("../resources", import.meta.url)
    ),
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
    .option("--non-interactive");
}

export async function runCli(
  argv: readonly string[],
  overrides: CliDependencies = {}
): Promise<number> {
  const dependencies = defaultDependencies(overrides);
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
    .description("Local Conservative Refresh of an installed Harness project")
    .option("--profile <name>")
    .option("--force-managed")
    .action(async (options: RefreshCommandOptions) => {
      exitCode = await runRefresh(
        { ...program.opts<RefreshCommandOptions>(), ...options },
        dependencies
      );
    });
  addCommonOptions(program.command("update"))
    .description("Apply approved server artifacts")
    .action(async (options: UpdateOptions) => {
      exitCode = await runUpdate(
        { ...program.opts<UpdateOptions>(), ...options },
        dependencies
      );
    });
  addCommonOptions(program.command("push"))
    .description("Create a governed proposal")
    .action(async (options: PushOptions) => {
      exitCode = await runPush({ ...program.opts<PushOptions>(), ...options }, dependencies);
    });
  addCommonOptions(program.command("cleanup"))
    .description("Prune completed transactions and obsolete server cache")
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
