import { describe, expect, it } from "vitest";

import { packageName as cliPackageName } from "../../packages/cli/src/index.js";
import { packageName as contractsPackageName } from "../../packages/contracts/src/index.js";
import { packageName as corePackageName } from "../../packages/core/src/index.js";
import { packageName as serverPackageName } from "../../apps/server/src/index.js";

describe("workspace", () => {
  it("exposes every package entry point", () => {
    expect(contractsPackageName).toBe("@hunter-harness/contracts");
    expect(corePackageName).toBe("@hunter-harness/core");
    expect(cliPackageName).toBe("hunter-harness");
    expect(serverPackageName).toBe("@hunter-harness/server");
  });
});
