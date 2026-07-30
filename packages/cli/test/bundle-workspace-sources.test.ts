import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  assertWorkspaceSourcesBoundToCheckout,
  workspaceSourceAliases
} from "../../../scripts/bundle-workspace-sources.mjs";

const repositoryRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../.."
);

describe("CLI bundle workspace source binding", () => {
  it("aliases private workspace packages to the current checkout sources", () => {
    expect(workspaceSourceAliases(repositoryRoot)).toEqual({
      "@hunter-harness/contracts": join(
        repositoryRoot,
        "packages",
        "contracts",
        "src",
        "index.ts"
      ),
      "@hunter-harness/core": join(
        repositoryRoot,
        "packages",
        "core",
        "src",
        "index.ts"
      )
    });
  });

  it("rejects a bundle that resolved workspace inputs from another checkout", () => {
    const foreignRoot = join(
      dirname(repositoryRoot),
      "foreign-checkout"
    );
    expect(() => assertWorkspaceSourcesBoundToCheckout(repositoryRoot, {
      inputs: {
        [join(foreignRoot, "packages", "core", "dist", "index.js")]: {},
        [join(
          foreignRoot,
          "packages",
          "contracts",
          "dist",
          "index.js"
        )]: {}
      }
    })).toThrow(/outside the current checkout/u);
  });
});
