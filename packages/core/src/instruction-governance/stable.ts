import { rawStableHash, rawStableJson } from "../fs/stable.js";

// 兼容转发层：实现收敛到 ../fs/stable.js（raw 字符串拼接模式）。
// 历史行为：**不过滤** undefined 值、键按码点排序、无空白拼接——与
// canonical 模式输出不同，保持原样以免既有持久化哈希漂移。
export { compareCodepoint, deepFreeze } from "../fs/stable.js";

export function stableJson(value: unknown): string {
  return rawStableJson(value);
}

export function stableHash(value: unknown): string {
  return rawStableHash(value);
}
