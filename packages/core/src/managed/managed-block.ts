export const MANAGED_BLOCK_START = "<!-- hunter-harness:start -->";
export const MANAGED_BLOCK_END = "<!-- hunter-harness:end -->";

function markerCount(content: string, marker: string): number {
  return content.split(marker).length - 1;
}

function validateMarkers(content: string): "absent" | "present" {
  const starts = markerCount(content, MANAGED_BLOCK_START);
  const ends = markerCount(content, MANAGED_BLOCK_END);
  if (starts === 0 && ends === 0) {
    return "absent";
  }
  if (starts !== 1 || ends !== 1) {
    throw new Error("managed block markers are malformed or duplicated");
  }
  if (content.indexOf(MANAGED_BLOCK_START) > content.indexOf(MANAGED_BLOCK_END)) {
    throw new Error("managed block markers are out of order");
  }
  return "present";
}

function renderBlock(content: string, newline: string): string {
  const normalized = content.replace(/\r\n/g, "\n").replace(/\n/g, newline);
  return MANAGED_BLOCK_START + newline + normalized + newline + MANAGED_BLOCK_END;
}

export function extractManagedBlock(content: string): string | null {
  if (validateMarkers(content) === "absent") {
    return null;
  }
  const start = content.indexOf(MANAGED_BLOCK_START) + MANAGED_BLOCK_START.length;
  const end = content.indexOf(MANAGED_BLOCK_END);
  return content.slice(start, end).replace(/^\r?\n/, "").replace(/\r?\n$/, "");
}

export function upsertManagedBlock(original: string, content: string): string {
  const newline = original.includes("\r\n") ? "\r\n" : "\n";
  const block = renderBlock(content, newline);
  if (validateMarkers(original) === "absent") {
    if (original.length === 0) {
      return block + newline;
    }
    const separator = original.endsWith(newline) ? newline : newline + newline;
    return original + separator + block + newline;
  }

  const start = original.indexOf(MANAGED_BLOCK_START);
  const end = original.indexOf(MANAGED_BLOCK_END) + MANAGED_BLOCK_END.length;
  return original.slice(0, start) + block + original.slice(end);
}

export function removeManagedBlock(original: string): string {
  if (validateMarkers(original) === "absent") {
    return original;
  }
  const start = original.indexOf(MANAGED_BLOCK_START);
  const end = original.indexOf(MANAGED_BLOCK_END) + MANAGED_BLOCK_END.length;
  const before = original.slice(0, start).replace(/(?:\r?\n){2}$/, "\n");
  const after = original.slice(end).replace(/^(?:\r?\n){1,2}/, "");
  return before + after;
}

export type ManagedBlockAction = "refreshed" | "appended" | "preserved_conflict";

export interface ManagedBlockRefresh {
  content: string;
  action: ManagedBlockAction;
  conflict: boolean;
}

// 非抛错的受管块刷新：标记缺失→追加；标记合法→替换块内正文；标记畸形/重复/倒序→
// 整文件原样保留并报告冲突（design §4.1）。--force-managed 也不得越界改写块外字节，
// 故冲突时始终返回 original。调用方据此决定是否写入与是否计入 exit 5。
export function refreshManagedBlock(original: string, blockContent: string): ManagedBlockRefresh {
  const starts = markerCount(original, MANAGED_BLOCK_START);
  const ends = markerCount(original, MANAGED_BLOCK_END);
  const absent = starts === 0 && ends === 0;
  const malformed = !absent &&
    (starts !== 1 || ends !== 1 ||
      original.indexOf(MANAGED_BLOCK_START) > original.indexOf(MANAGED_BLOCK_END));
  if (malformed) {
    return { content: original, action: "preserved_conflict", conflict: true };
  }
  const action: ManagedBlockAction = absent ? "appended" : "refreshed";
  return { content: upsertManagedBlock(original, blockContent), action, conflict: false };
}

function escapeRe(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const startById = (id: string): string => `<!-- hunter-harness:start id=${id} -->`;
const endById = (id: string): string => `<!-- hunter-harness:end id=${id} -->`;

/**
 * 按 id 插入/替换 per-id managed block（marker `<!-- hunter-harness:start id=<id> -->` ... `<!-- hunter-harness:end id=<id> -->`）。
 * 同 id block 存在则替换（幂等），否则追加；与无 id 的 {@link upsertManagedBlock} 因 id 后缀互不冲突，可在同一文件共存。
 * 用于 AGENTS.md 的 per-skill block（codex adapter 安装，blockId=`harness-skill-<name>`）。
 */
export function upsertManagedBlockById(
  original: string,
  id: string,
  content: string
): string {
  const newline = original.includes("\r\n") ? "\r\n" : "\n";
  const block = startById(id) + newline + content + newline + endById(id);
  const re = new RegExp(escapeRe(startById(id)) + "[\\s\\S]*?" + escapeRe(endById(id)));
  if (re.test(original)) {
    return original.replace(re, block);
  }
  const separator = original.length === 0
    ? ""
    : (original.endsWith(newline) ? newline : newline + newline);
  return original + separator + block + newline;
}
