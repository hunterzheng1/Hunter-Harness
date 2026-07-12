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
  if (validateMarkers(content) === "present") {
    const start = content.indexOf(MANAGED_BLOCK_START) + MANAGED_BLOCK_START.length;
    const end = content.indexOf(MANAGED_BLOCK_END);
    return content.slice(start, end).replace(/^\r?\n/, "").replace(/\r?\n$/, "");
  }
  return extractSingleManagedBlockById(content)?.content ?? null;
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

export function extractSingleManagedBlockById(
  content: string
): { id: string; content: string } | null {
  const matches = [...content.matchAll(/<!-- hunter-harness:start id=([A-Za-z0-9_-]+) -->/g)];
  if (matches.length !== 1) return null;
  const id = matches[0]?.[1];
  if (id === undefined) return null;
  const start = startById(id);
  const end = endById(id);
  if (markerCount(content, start) !== 1 || markerCount(content, end) !== 1 ||
      content.indexOf(start) > content.indexOf(end)) {
    throw new Error("managed block markers are malformed or duplicated");
  }
  const bodyStart = content.indexOf(start) + start.length;
  const bodyEnd = content.indexOf(end);
  return {
    id,
    content: content.slice(bodyStart, bodyEnd).replace(/^\r?\n/, "").replace(/\r?\n$/, "")
  };
}

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
  const normalized = content.replace(/\r\n/g, "\n").replace(/\n/g, newline);
  const block = startById(id) + newline + normalized + newline + endById(id);
  const re = new RegExp(escapeRe(startById(id)) + "[\\s\\S]*?" + escapeRe(endById(id)));
  if (re.test(original)) {
    return original.replace(re, block);
  }
  const separator = original.length === 0
    ? ""
    : (original.endsWith(newline) ? newline : newline + newline);
  return original + separator + block + newline;
}

export interface ManagedBlockByIdRefresh {
  content: string;
  action: ManagedBlockAction;
  conflict: boolean;
}

/**
 * Refresh a per-id managed block. With `upgradeLegacy`, a single valid no-id
 * legacy block is replaced in-place by the id-marked block (no double inject).
 */
export function refreshManagedBlockById(
  original: string,
  id: string,
  blockContent: string,
  options: { upgradeLegacy?: boolean } = {}
): ManagedBlockByIdRefresh {
  const idStart = startById(id);
  const idEnd = endById(id);
  const idStarts = markerCount(original, idStart);
  const idEnds = markerCount(original, idEnd);
  if (idStarts > 0 || idEnds > 0) {
    if (idStarts !== 1 || idEnds !== 1 ||
        original.indexOf(idStart) > original.indexOf(idEnd)) {
      return { content: original, action: "preserved_conflict", conflict: true };
    }
    return {
      content: upsertManagedBlockById(original, id, blockContent),
      action: "refreshed",
      conflict: false
    };
  }

  const legacyStarts = markerCount(original, MANAGED_BLOCK_START);
  const legacyEnds = markerCount(original, MANAGED_BLOCK_END);
  const legacyAbsent = legacyStarts === 0 && legacyEnds === 0;
  const legacyMalformed = !legacyAbsent &&
    (legacyStarts !== 1 || legacyEnds !== 1 ||
      original.indexOf(MANAGED_BLOCK_START) > original.indexOf(MANAGED_BLOCK_END));

  if (legacyMalformed) {
    return { content: original, action: "preserved_conflict", conflict: true };
  }

  if (!legacyAbsent && options.upgradeLegacy === true) {
    const newline = original.includes("\r\n") ? "\r\n" : "\n";
    const normalized = blockContent.replace(/\r\n/g, "\n").replace(/\n/g, newline);
    const block = idStart + newline + normalized + newline + idEnd;
    const start = original.indexOf(MANAGED_BLOCK_START);
    const end = original.indexOf(MANAGED_BLOCK_END) + MANAGED_BLOCK_END.length;
    return {
      content: original.slice(0, start) + block + original.slice(end),
      action: "refreshed",
      conflict: false
    };
  }

  if (!legacyAbsent) {
    // Legacy block present but upgrade not requested: append id block (coexist).
    return {
      content: upsertManagedBlockById(original, id, blockContent),
      action: "appended",
      conflict: false
    };
  }

  return {
    content: upsertManagedBlockById(original, id, blockContent),
    action: "appended",
    conflict: false
  };
}

export function removeManagedBlockById(original: string, id: string): string {
  const idStart = startById(id);
  const idEnd = endById(id);
  if (markerCount(original, idStart) === 0 && markerCount(original, idEnd) === 0) {
    return original;
  }
  if (markerCount(original, idStart) !== 1 || markerCount(original, idEnd) !== 1 ||
      original.indexOf(idStart) > original.indexOf(idEnd)) {
    throw new Error("managed block markers are malformed or duplicated");
  }
  const start = original.indexOf(idStart);
  const end = original.indexOf(idEnd) + idEnd.length;
  const before = original.slice(0, start).replace(/(?:\r?\n){2}$/, "\n");
  const after = original.slice(end).replace(/^(?:\r?\n){1,2}/, "");
  return before + after;
}
