import type { Command } from "commander";

import type { CommandDependencies } from "./configure.js";
import { readCliVersion } from "../version.js";
import {
  assessWorkflowCompatibility,
  CLI_CAPABILITIES
} from "../workflow-data/compatibility.js";
import { readWorkflowFamilyManifest } from "../workflow-data/resolve.js";

const COMMAND_SCHEMA_VERSIONS: Readonly<Record<string, number>> = {
  capabilities: 1,
  sync: 1,
  refresh: 1,
  update: 1,
  push: 1,
  cleanup: 1,
  "rules-sync": 1,
  "rules-review": 1,
  doctor: 1,
  config: 1
};

export async function runCapabilities(
  program: Command,
  dependencies: CommandDependencies
): Promise<number> {
  const cliVersion = await readCliVersion();
  const manifest = await readWorkflowFamilyManifest(dependencies.resourcesRoot);
  const commandNames = new Set(program.commands.map((command) => command.name()));
  const commands = Object.fromEntries(
    Object.entries(COMMAND_SCHEMA_VERSIONS).map(([name, schemaVersion]) => [
      name,
      { available: commandNames.has(name), schemaVersion }
    ])
  );
  const compatibility = assessWorkflowCompatibility(manifest, {
    cliVersion,
    capabilities: CLI_CAPABILITIES
  });
  dependencies.stdout(JSON.stringify({
    schemaVersion: 1,
    cliVersion,
    workflowBundleVersion:
      typeof manifest.bundle_version === "string" ? manifest.bundle_version : null,
    capabilities: CLI_CAPABILITIES,
    commands,
    compatibility
  }) + "\n");
  return compatibility.compatible ? 0 : 7;
}
