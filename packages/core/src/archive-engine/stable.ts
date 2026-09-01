import type { Sha256 } from "./types.js";

import { canonicalStableHash, canonicalStableJson } from "../fs/stable.js";

// 兼容转发层：实现收敛到 ../fs/stable.js（canonical JSON 模式）。
// 历史行为：过滤 undefined 键、键按码点排序、JSON.stringify 输出。
export { compareCodepoint, contentHash, deepFreeze } from "../fs/stable.js";

export function stableJson(value: unknown): string {
  return canonicalStableJson(value);
}

export function stableHash(value: unknown): Sha256 {
  return canonicalStableHash(value);
}
