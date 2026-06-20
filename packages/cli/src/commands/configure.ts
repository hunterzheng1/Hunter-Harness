import {
  initializeProject,
  uuidV7
} from "@hunter-harness/core";

import {
  InitConfigurationError,
  resolveInitConfig,
  type InitFlagValues
} from "../config/init-config.js";
import {
  serializeCliResult,
  type CliResult
} from "../output/json.js";

export interface ConfigureOptions extends InitFlagValues {
  nonInteractive?: boolean;
  yes?: boolean;
  dryRun?: boolean;
  json?: boolean;
}

export interface CommandDependencies {
  cwd: string;
  resourcesRoot: string;
  stdout(value: string): void;
  stderr(value: string): void;
  prompt(question: string): Promise<string>;
}

export async function runConfigure(
  options: ConfigureOptions,
  dependencies: CommandDependencies
): Promise<number> {
  const requestId = uuidV7();
  try {
    const config = await resolveInitConfig(
      dependencies.cwd,
      options,
      options.nonInteractive === true
        ? undefined
        : (field) => dependencies.prompt(
          field === "adapter"
            ? "Adapter (claude-code): "
            : "Profile (general/java): "
        ).then((answer) => answer.trim() || (
          field === "adapter" ? "claude-code" : "general"
        ))
    );
    if (options.nonInteractive === true && options.yes !== true &&
        options.dryRun !== true) {
      dependencies.stderr("non-interactive writes require --yes\n");
      return 2;
    }
    const result = await initializeProject({
      projectRoot: dependencies.cwd,
      resourcesRoot: dependencies.resourcesRoot,
      config,
      dryRun: options.dryRun === true
    });
    const output: CliResult = {
      schema_version: 1,
      command: "configure",
      request_id: requestId,
      dry_run: options.dryRun === true,
      ok: true,
      exit_code: 0,
      project_id: result.projectConfig.project.project_id,
      summary: { planned: result.paths.length, applied: options.dryRun === true ? 0 : result.paths.length },
      items: result.paths.map((path) => ({ path, status: options.dryRun === true ? "planned" : "applied" })),
      warnings: [],
      errors: []
    };
    dependencies.stdout(options.json === true
      ? serializeCliResult(output)
      : "Hunter Harness initialized " + result.paths.length + " files.\n");
    return 0;
  } catch (error) {
    const exitCode = error instanceof InitConfigurationError ? error.exitCode : 1;
    const message = error instanceof Error ? error.message : String(error);
    dependencies.stderr(message + "\n");
    if (options.json === true) {
      dependencies.stdout(serializeCliResult({
        schema_version: 1,
        command: "configure",
        request_id: requestId,
        dry_run: options.dryRun === true,
        ok: false,
        exit_code: exitCode,
        project_id: null,
        summary: { planned: 0, applied: 0 },
        items: [],
        warnings: [],
        errors: [{ message }]
      }));
    }
    return exitCode;
  }
}
