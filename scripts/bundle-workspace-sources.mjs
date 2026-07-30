import { isAbsolute, join, relative, resolve, sep } from "node:path";

const WORKSPACE_PACKAGES = [
  {
    name: "@hunter-harness/contracts",
    path: ["packages", "contracts"]
  },
  {
    name: "@hunter-harness/core",
    path: ["packages", "core"]
  }
];

function isWithin(root, candidate) {
  const relativePath = relative(root, candidate);
  return relativePath === "" || (
    relativePath !== ".." &&
    !relativePath.startsWith(`..${sep}`) &&
    !isAbsolute(relativePath)
  );
}

function absoluteInput(repositoryRoot, input) {
  return isAbsolute(input) ? resolve(input) : resolve(repositoryRoot, input);
}

function referencesWorkspacePackage(input, packagePath) {
  const normalized = input.replaceAll("\\", "/").toLowerCase();
  const suffix = `/${packagePath.join("/").toLowerCase()}/`;
  return normalized.includes(suffix);
}

export function workspaceSourceAliases(repositoryRoot) {
  const root = resolve(repositoryRoot);
  return Object.fromEntries(WORKSPACE_PACKAGES.map((workspacePackage) => [
    workspacePackage.name,
    join(root, ...workspacePackage.path, "src", "index.ts")
  ]));
}

export function assertWorkspaceSourcesBoundToCheckout(repositoryRoot, metafile) {
  const root = resolve(repositoryRoot);
  const inputs = Object.keys(metafile.inputs ?? {});
  for (const workspacePackage of WORKSPACE_PACKAGES) {
    const packageRoot = join(root, ...workspacePackage.path);
    const sourceRoot = join(packageRoot, "src");
    const matchingInputs = inputs
      .map((input) => absoluteInput(root, input))
      .filter((input) => referencesWorkspacePackage(
        input,
        workspacePackage.path
      ));
    if (matchingInputs.length === 0) {
      throw new Error(
        `WORKSPACE_SOURCE_MISSING: ${workspacePackage.name} was not bundled`
      );
    }
    for (const input of matchingInputs) {
      if (!isWithin(sourceRoot, input)) {
        throw new Error(
          `WORKSPACE_SOURCE_MISMATCH: ${workspacePackage.name} resolved ` +
          `outside the current checkout sources: ${input}`
        );
      }
    }
  }
}
