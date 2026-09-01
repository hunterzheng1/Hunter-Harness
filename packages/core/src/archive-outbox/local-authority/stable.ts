import { strictLocalAuthorityHash } from "../../fs/stable.js";

// 兼容转发层：实现收敛到 ../../fs/stable.js（strict 模式）。
// 历史行为：字符串拼接 + 遇 undefined / 非有限数抛 LOCAL_ARCHIVE_AUTHORITY_INPUT_INVALID。
export const stableLocalArchiveAuthorityHash = strictLocalAuthorityHash;
