import type { Sha256 } from "../archive-engine/index.js";

import { canonicalStableHash, canonicalStableJson } from "../fs/stable.js";

// 兼容转发层：实现收敛到 ../fs/stable.js（canonical JSON 模式）。
// 历史行为：过滤 undefined 键、跳过 ArrayBuffer 视图、键按码点排序。
export { compareCodepoint, deepFreeze, equalBytes, sha256Bytes } from "../fs/stable.js";

export function stableJson(value: unknown): string {
  return canonicalStableJson(value);
}

export function stableHash(value: unknown): Sha256 {
  return canonicalStableHash(value);
}
