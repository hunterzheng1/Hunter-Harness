#!/usr/bin/env node
// runtime-helpers.mjs — BOM-safe JSON I/O + test-identifier sanitizer + runner payload validation + credential scan.
// 变更簇 5 (spec §3.4): BOM-safe Runner, identifier sanitizer, 凭据边界.
//
// 设计目标:
//  - readJsonUtf8BomSafe: 容忍 UTF-8 BOM (U+FEFF), credential-cache.json 等文件可能被 PS5.1 写入 BOM
//  - writeJsonUtf8NoBom: 原子写 (temp+rename), UTF-8 no BOM, LF — 结果/报告文件字节稳定
//  - sanitizeTestIdentifier: 按 pattern/maxLength/prefix 生成稳定标识; 超长截断 + 原文名短 hash 防碰撞
//  - validateRunnerPayload: Runner 生成前本地校验 payload schema/必填/identifier, 测试脚本错误不得请求服务后才发现
//  - findCredentialValues: 扫描 profile/Markdown/docs 中的凭据明文值 (sensitive-info-protocol §1)
//
// Node ≥18 ESM, stdlib only. 输出 JSON 内容确定性 (不含 Math.random); 仅临时文件名用 randomBytes.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const BOM = 0xfeff;
export const DEFAULT_IDENTIFIER_PATTERN = '^[A-Za-z][A-Za-z0-9_-]*$';
export const DEFAULT_IDENTIFIER_MAX_LENGTH = 64;
const HASH_LEN = 8;

// ---------------------------------------------------------------------------
// BOM-safe JSON I/O
// ---------------------------------------------------------------------------

/** Strip a single leading UTF-8 BOM (U+FEFF) from text. No-op if absent. */
export function stripBom(text) {
  return text.codePointAt(0) === BOM ? text.slice(1) : text;
}

/** Read a JSON file, tolerating a leading UTF-8 BOM. Throws on invalid JSON. */
export function readJsonUtf8BomSafe(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  return JSON.parse(stripBom(raw));
}

/** Atomically write JSON as UTF-8 (no BOM), LF, 2-space indent, trailing newline.
 *  Writes to a temp file then renames — readers never see a half-written file. */
export function writeJsonUtf8NoBom(filePath, value) {
  const json = JSON.stringify(value, null, 2) + '\n';
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${filePath}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, json, 'utf8');
  try {
    fs.renameSync(tmp, filePath);
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* best-effort cleanup */
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// sanitizeTestIdentifier
// ---------------------------------------------------------------------------

/**
 * Sanitize a change/test name into a stable identifier matching the default
 * pattern `^[A-Za-z][A-Za-z0-9_-]*$`.
 *
 * - runs of chars outside [A-Za-z0-9_-] → '_'
 * - prepend `prefix_` when prefix given; ensure leading letter (prepend 'T')
 * - if over maxLength: truncate and append a short sha256 hash of the ORIGINAL
 *   name, so two near-identical long names that collide after truncation stay
 *   distinct (UT-023). Hash is deterministic — no Math.random.
 *
 * @returns {string} identifier matching the default pattern, length ≤ maxLength.
 */
export function sanitizeTestIdentifier({
  name,
  pattern = DEFAULT_IDENTIFIER_PATTERN,
  maxLength = DEFAULT_IDENTIFIER_MAX_LENGTH,
  prefix = '',
}) {
  const raw = String(name ?? '');
  let base = prefix ? `${prefix}_` : '';
  base += raw.replace(/[^A-Za-z0-9_-]+/g, '_');
  // leading letter (pattern ^[A-Za-z]); prepend 'T' if first char is _ or digit
  if (!/^[A-Za-z]/.test(base)) base = `T${base}`;
  if (base.length <= maxLength) return base;
  const hash = crypto.createHash('sha256').update(raw, 'utf8').digest('hex').slice(0, HASH_LEN);
  const reserve = HASH_LEN + 1; // '_' + hash
  const cap = Math.max(1, maxLength - reserve);
  let truncated = base.slice(0, cap).replace(/_+$/, '');
  // if truncation removed the leading letter guarantee, restore it
  if (!/^[A-Za-z]/.test(truncated)) truncated = `T${truncated}`;
  return `${truncated}_${hash}`;
}

/** Compile a pattern safely; returns null if invalid. */
function safeRegex(pattern) {
  try {
    return new RegExp(`^(?:${pattern})$`);
  } catch {
    return null;
  }
}

/** True if id matches pattern. Invalid pattern → false. */
export function matchesPattern(id, pattern = DEFAULT_IDENTIFIER_PATTERN) {
  const re = safeRegex(pattern);
  return re ? re.test(String(id)) : false;
}

// ---------------------------------------------------------------------------
// validateRunnerPayload — Runner 生成前本地校验
// ---------------------------------------------------------------------------

const HTTP_METHODS = /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/i;

/**
 * Validate a runner payload (array of API test scenarios) BEFORE generating or
 * executing the runner. Catches script/schema errors locally so they don't
 * surface only after a service request (spec §3.4 point 3).
 *
 * Scenario required fields: id, method, url. id must match identifierPattern
 * and be unique. method must be a known HTTP method.
 *
 * @returns {{ ok: boolean, errors: Array<{code: string, field: string, message: string}> }}
 */
export function validateRunnerPayload(payload, opts = {}) {
  const errors = [];
  const pattern = opts.identifierPattern || DEFAULT_IDENTIFIER_PATTERN;
  const re = safeRegex(pattern);

  if (!Array.isArray(payload)) {
    return {
      ok: false,
      errors: [{ code: 'PAYLOAD_NOT_ARRAY', field: 'payload', message: 'payload must be an array of scenarios' }],
    };
  }
  if (payload.length === 0) {
    errors.push({ code: 'PAYLOAD_EMPTY', field: 'payload', message: 'payload has no scenarios' });
  }

  const seenIds = new Set();
  payload.forEach((scn, i) => {
    const where = `scenarios[${i}]`;
    if (!scn || typeof scn !== 'object' || Array.isArray(scn)) {
      errors.push({ code: 'SCENARIO_NOT_OBJECT', field: where, message: 'scenario must be an object' });
      return;
    }
    for (const f of ['id', 'method', 'url']) {
      if (scn[f] === undefined || scn[f] === null || scn[f] === '') {
        errors.push({ code: 'MISSING_FIELD', field: `${where}.${f}`, message: `required field '${f}' missing or empty` });
      }
    }
    if (scn.id !== undefined && scn.id !== null && scn.id !== '') {
      const idStr = String(scn.id);
      if (re && !re.test(idStr)) {
        errors.push({ code: 'INVALID_IDENTIFIER', field: `${where}.id`, message: `id '${idStr}' does not match pattern ${pattern}` });
      }
      if (seenIds.has(idStr)) {
        errors.push({ code: 'DUPLICATE_ID', field: `${where}.id`, message: `duplicate id '${idStr}'` });
      } else {
        seenIds.add(idStr);
      }
    }
    if (scn.method !== undefined && scn.method !== null && scn.method !== '') {
      if (!HTTP_METHODS.test(String(scn.method))) {
        errors.push({ code: 'INVALID_METHOD', field: `${where}.method`, message: `unknown HTTP method '${scn.method}'` });
      }
    }
  });

  return { ok: errors.length === 0, errors };
}

// ---------------------------------------------------------------------------
// findCredentialValues — 凭据明文扫描 (sensitive-info-protocol §1)
// ---------------------------------------------------------------------------

// 值占位符或 env 引用 (不会被当作凭据明文): <*_REDACTED> / ${ENV} / $ENV
// 前缀匹配 ${ENV (无需闭合 }) — value 正则在 } 处停止, 仍应识别为 env 引用。
const SAFE_VALUE = /<\w+_REDACTED>|\$\{[A-Z0-9_]+|\$[A-Z][A-Z0-9_]*\b/;

const CRED_PATTERNS = [
  // password / passwd / pwd = 或 : 后跟值 (字段名可带 JSON/YAML 引号)
  { code: 'PASSWORD_VALUE', re: /"?password"?\s*[:=]\s*(['"]?)([^'"\s,;)}\n]+)\1/i, group: 2 },
  // token / access_token / api_key / apikey / secret / accessKey / secretAccessKey
  { code: 'SECRET_VALUE', re: /(?:"?(?:access_token|apikey|api_key|secretAccessKey|accessKey|secret|token)"?)\s*[:=]\s*(['"]?)([^'"\s,;)}\n]+)\1/i, group: 2 },
  // Authorization: Bearer <jwt-ish>
  { code: 'AUTH_HEADER', re: /Authorization\s*:\s*Bearer\s+([A-Za-z0-9_.-]{10,})/i, group: 1 },
  // jdbc url with password=
  { code: 'DB_PASSWORD', re: /jdbc:[^\s?]*[?&]password=([^&\s]+)/i, group: 1 },
];

/**
 * Scan text for credential VALUES per sensitive-info-protocol §1.
 * Placeholders (`<TOKEN_REDACTED>`) and env refs (`${DB_PASSWORD}` / `$DB_PASSWORD`)
 * are NOT flagged — credential config may carry env keys, not values (spec §3.4 point 4).
 *
 * @returns {Array<{ line: number, code: string, snippet: string }>}
 */
export function findCredentialValues(text) {
  const findings = [];
  const lines = String(text ?? '').split(/\r?\n/);
  lines.forEach((line, idx) => {
    for (const { code, re, group } of CRED_PATTERNS) {
      const m = line.match(re);
      if (!m) continue;
      const value = m[group] || '';
      if (SAFE_VALUE.test(value)) continue; // placeholder / env ref — safe
      // Redact the captured credential value in the snippet so reports/logs
      // never leak it; field name + line number remain for locating the finding.
      const snippet = (value ? line.replace(value, '<REDACTED>') : line).trim().slice(0, 80);
      findings.push({ line: idx + 1, code, snippet });
    }
  });
  return findings;
}
