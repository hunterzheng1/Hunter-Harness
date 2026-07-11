import { copyFile, cp, mkdir } from "node:fs/promises";
import { fileURLToPath, URL } from "node:url";

const source = fileURLToPath(
  new URL("../../../resources", import.meta.url)
);
const target = fileURLToPath(
  new URL("../resources", import.meta.url)
);
await mkdir(target, { recursive: true });
await cp(source, target, { recursive: true, force: true });

// 复制根 LICENSE 到包根，确保 npm tarball 含 MIT license（npm pack 默认包含包目录的 LICENSE）。
await copyFile(
  fileURLToPath(new URL("../../../LICENSE", import.meta.url)),
  fileURLToPath(new URL("../LICENSE", import.meta.url))
);
