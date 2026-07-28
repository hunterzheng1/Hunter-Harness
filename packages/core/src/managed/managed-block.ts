export const MANAGED_BLOCK_START = "<!-- hunter-harness:start -->";
export const MANAGED_BLOCK_END = "<!-- hunter-harness:end -->";

export type ManagedBlockStructureErrorCode =
  | "DUPLICATE_MANAGED_BLOCK"
  | "NESTED_MANAGED_BLOCK"
  | "UNCLOSED_MANAGED_BLOCK"
  | "MISMATCHED_MANAGED_BLOCK";

export class ManagedBlockStructureError extends Error {
  readonly code: ManagedBlockStructureErrorCode;

  constructor(code: ManagedBlockStructureErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = "ManagedBlockStructureError";
    this.code = code;
  }
}

export interface ParsedManagedBlock {
  id: string | null;
  content: string;
  start: number;
  end: number;
}

export interface ParsedManagedBlocks {
  blocks: ParsedManagedBlock[];
  outsideContent: string;
}

export interface ManagedBlockRepair {
  content: string;
  repaired: boolean;
  conflict: boolean;
  reasonCode: "NO_REPAIR_NEEDED" | "EQUIVALENT_LEGACY_WRAPPER" |
    ManagedBlockStructureErrorCode;
}

function markerCount(content: string, marker: string): number {
  return content.split(marker).length - 1;
}

const MANAGED_MARKER_RE =
  /<!-- hunter-harness:(start|end)(?: id=([A-Za-z0-9_-]+))? -->/g;

/**
 * Parse the complete managed-marker structure before any mutation. Sibling
 * blocks are allowed; duplicate IDs, nesting, mismatched pairs and unclosed
 * markers are rejected deterministically.
 */
export function parseManagedBlocks(content: string): ParsedManagedBlocks {
  const blocks: ParsedManagedBlock[] = [];
  const seen = new Set<string>();
  let open: { id: string | null; start: number; bodyStart: number } | null = null;
  for (const match of content.matchAll(MANAGED_MARKER_RE)) {
    const kind = match[1];
    const id = match[2] ?? null;
    const markerStart = match.index;
    if (markerStart === undefined) continue;
    if (kind === "start") {
      if (open !== null) {
        throw new ManagedBlockStructureError(
          "NESTED_MANAGED_BLOCK",
          `block ${id ?? "<legacy>"} starts inside ${open.id ?? "<legacy>"}`
        );
      }
      const key = id ?? "<legacy>";
      if (seen.has(key)) {
        throw new ManagedBlockStructureError(
          "DUPLICATE_MANAGED_BLOCK",
          `managed block ${key} appears more than once`
        );
      }
      open = {
        id,
        start: markerStart,
        bodyStart: markerStart + match[0].length
      };
      continue;
    }
    if (open === null || open.id !== id) {
      throw new ManagedBlockStructureError(
        "MISMATCHED_MANAGED_BLOCK",
        `end marker ${id ?? "<legacy>"} has no matching start marker`
      );
    }
    const key = id ?? "<legacy>";
    seen.add(key);
    blocks.push({
      id,
      start: open.start,
      end: markerStart + match[0].length,
      content: content
        .slice(open.bodyStart, markerStart)
        .replace(/^\r?\n/, "")
        .replace(/\r?\n$/, "")
    });
    open = null;
  }
  if (open !== null) {
    throw new ManagedBlockStructureError(
      "UNCLOSED_MANAGED_BLOCK",
      `managed block ${open.id ?? "<legacy>"} has no end marker`
    );
  }
  let outsideContent = "";
  let cursor = 0;
  for (const block of blocks) {
    outsideContent += content.slice(cursor, block.start);
    cursor = block.end;
  }
  outsideContent += content.slice(cursor);
  // Removing adjacent line-oriented blocks can expose three separator
  // newlines. Collapse only that structural seam to one blank line.
  outsideContent = outsideContent.replace(/(\r?\n){3}/g, "$1$1");
  return { blocks, outsideContent };
}

/**
 * Repair the historical full-file rebase shape only when the legacy wrapper
 * contains the exact same per-ID blocks already present outside it.
 */
export function repairEquivalentLegacyWrapper(content: string): ManagedBlockRepair {
  const legacyStarts = markerCount(content, MANAGED_BLOCK_START);
  const legacyEnds = markerCount(content, MANAGED_BLOCK_END);
  if (legacyStarts === 0 && legacyEnds === 0) {
    try {
      parseManagedBlocks(content);
      return {
        content,
        repaired: false,
        conflict: false,
        reasonCode: "NO_REPAIR_NEEDED"
      };
    } catch (error) {
      if (error instanceof ManagedBlockStructureError) {
        return {
          content,
          repaired: false,
          conflict: true,
          reasonCode: error.code
        };
      }
      throw error;
    }
  }
  if (legacyStarts !== 1 || legacyEnds !== 1) {
    return {
      content,
      repaired: false,
      conflict: true,
      reasonCode: "DUPLICATE_MANAGED_BLOCK"
    };
  }
  const wrapperStart = content.indexOf(MANAGED_BLOCK_START);
  const wrapperEnd = content.lastIndexOf(MANAGED_BLOCK_END);
  if (wrapperStart < 0 || wrapperEnd < wrapperStart) {
    return {
      content,
      repaired: false,
      conflict: true,
      reasonCode: "MISMATCHED_MANAGED_BLOCK"
    };
  }
  const bodyStart = wrapperStart + MANAGED_BLOCK_START.length;
  const inner = content
    .slice(bodyStart, wrapperEnd)
    .replace(/^\r?\n/, "")
    .replace(/\r?\n$/, "");
  const afterStart = wrapperEnd + MANAGED_BLOCK_END.length;
  const before = content.slice(0, wrapperStart);
  const after = content.slice(afterStart);
  const newline = content.includes("\r\n") ? "\r\n" : "\n";
  const withoutWrapper =
    before.endsWith(newline) && after.startsWith(newline)
      ? before + after.slice(newline.length)
      : before + after;
  try {
    const innerParsed = parseManagedBlocks(inner);
    const outsideParsed = parseManagedBlocks(withoutWrapper);
    if (
      innerParsed.outsideContent.trim() !== "" ||
      innerParsed.blocks.length === 0 ||
      innerParsed.blocks.some((block) => block.id === null)
    ) {
      return {
        content,
        repaired: false,
        conflict: true,
        reasonCode: "NESTED_MANAGED_BLOCK"
      };
    }
    const outsideById = new Map(
      outsideParsed.blocks
        .filter((block): block is ParsedManagedBlock & { id: string } => block.id !== null)
        .map((block) => [block.id, block.content.replace(/\r\n/g, "\n")])
    );
    const equivalent = innerParsed.blocks.every((block) =>
      block.id !== null &&
      outsideById.get(block.id) === block.content.replace(/\r\n/g, "\n")
    );
    if (!equivalent) {
      return {
        content,
        repaired: false,
        conflict: true,
        reasonCode: "NESTED_MANAGED_BLOCK"
      };
    }
    return {
      content: withoutWrapper,
      repaired: true,
      conflict: false,
      reasonCode: "EQUIVALENT_LEGACY_WRAPPER"
    };
  } catch (error) {
    if (error instanceof ManagedBlockStructureError) {
      return {
        content,
        repaired: false,
        conflict: true,
        reasonCode: error.code
      };
    }
    throw error;
  }
}

function validateMarkers(content: string): "absent" | "present" {
  const parsed = parseManagedBlocks(content);
  const legacy = parsed.blocks.filter((block) => block.id === null);
  if (legacy.length === 0) {
    return "absent";
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

const startById = (id: string): string => `<!-- hunter-harness:start id=${id} -->`;
const endById = (id: string): string => `<!-- hunter-harness:end id=${id} -->`;

export function extractSingleManagedBlockById(
  content: string
): { id: string; content: string } | null {
  const blocks = parseManagedBlocks(content).blocks;
  if (blocks.length !== 1 || blocks[0]?.id === null || blocks[0] === undefined) return null;
  return { id: blocks[0].id, content: blocks[0].content };
}

/** Stable digest input for legacy, single-ID and multi-ID managed files. */
export function managedBlockDigestInput(content: string): string | null {
  const blocks = parseManagedBlocks(content).blocks;
  if (blocks.length === 0) return null;
  if (blocks.length === 1) return blocks[0]?.content ?? null;
  return JSON.stringify(blocks.map((block) => ({
    id: block.id,
    content: block.content
  })));
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
  const parsed = parseManagedBlocks(original);
  const newline = original.includes("\r\n") ? "\r\n" : "\n";
  const normalized = content.replace(/\r\n/g, "\n").replace(/\n/g, newline);
  const block = startById(id) + newline + normalized + newline + endById(id);
  const existing = parsed.blocks.find((item) => item.id === id);
  if (existing !== undefined) {
    return original.slice(0, existing.start) + block + original.slice(existing.end);
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
  try {
    parseManagedBlocks(original);
  } catch (error) {
    if (error instanceof ManagedBlockStructureError) {
      return { content: original, action: "preserved_conflict", conflict: true };
    }
    throw error;
  }
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
  const parsed = parseManagedBlocks(original);
  const idStart = startById(id);
  const idEnd = endById(id);
  if (markerCount(original, idStart) === 0 && markerCount(original, idEnd) === 0) {
    return original;
  }
  if (markerCount(original, idStart) !== 1 || markerCount(original, idEnd) !== 1 ||
      original.indexOf(idStart) > original.indexOf(idEnd)) {
    throw new Error("managed block markers are malformed or duplicated");
  }
  const block = parsed.blocks.find((item) => item.id === id);
  if (block === undefined) return original;
  const start = block.start;
  const end = block.end;
  const before = original.slice(0, start).replace(/(?:\r?\n){2}$/, "\n");
  const after = original.slice(end).replace(/^(?:\r?\n){1,2}/, "");
  return before + after;
}
