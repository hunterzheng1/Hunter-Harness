import { cp, mkdir } from "node:fs/promises";
import { fileURLToPath, URL } from "node:url";

const source = fileURLToPath(
  new URL("../../../resources", import.meta.url)
);
const target = fileURLToPath(
  new URL("../resources", import.meta.url)
);
await mkdir(target, { recursive: true });
await cp(source, target, { recursive: true, force: true });
