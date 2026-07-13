#!/usr/bin/env node
// runtime-helpers.test.mjs — Node tests for runtime-helpers.mjs (变更簇 5).
// UT-020..024: BOM-safe JSON I/O, identifier sanitizer, runner payload validation, credential scan.
// Run: node --test harness/harness-test/scripts/tests/runtime-helpers.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import {
  stripBom,
  readJsonUtf8BomSafe,
  writeJsonUtf8NoBom,
  sanitizeTestIdentifier,
  matchesPattern,
  validateRunnerPayload,
  findCredentialValues,
  DEFAULT_IDENTIFIER_PATTERN,
} from '../runtime-helpers.mjs';

function tmpFile(suffix = '.json') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-'));
  return path.join(dir, `t-${process.pid}-${suffix}`);
}

// ---------------------------------------------------------------------------
// UT-020: credential JSON 带 BOM → Node helper 正常解析
// ---------------------------------------------------------------------------

test('UT-020 stripBom removes a leading U+FEFF and is a no-op otherwise', () => {
  assert.equal(stripBom('﻿hello'), 'hello');
  assert.equal(stripBom('hello'), 'hello');
  assert.equal(stripBom(''), '');
});

test('UT-020 readJsonUtf8BomSafe parses a BOM-prefixed JSON file', () => {
  const f = tmpFile();
  // Write a real UTF-8 BOM (0xEF 0xBB 0xBF) followed by JSON bytes.
  const json = '{"token":"<TOKEN_REDACTED>","tenant":"1"}';
  fs.writeFileSync(f, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(json, 'utf8')]));
  const parsed = readJsonUtf8BomSafe(f);
  assert.equal(parsed.token, '<TOKEN_REDACTED>');
  assert.equal(parsed.tenant, '1');
});

test('UT-020 readJsonUtf8BomSafe parses a non-BOM JSON file unchanged', () => {
  const f = tmpFile();
  fs.writeFileSync(f, '{"a":1}\n', 'utf8');
  assert.deepEqual(readJsonUtf8BomSafe(f), { a: 1 });
});

test('UT-020 readJsonUtf8BomSafe throws on invalid JSON', () => {
  const f = tmpFile();
  fs.writeFileSync(f, '﻿{not json', 'utf8');
  assert.throws(() => readJsonUtf8BomSafe(f), SyntaxError);
});

// ---------------------------------------------------------------------------
// UT-021: JSON 写入 → UTF-8 no BOM, 原子替换
// ---------------------------------------------------------------------------

test('UT-021 writeJsonUtf8NoBom writes UTF-8 without BOM, LF, 2-space indent, trailing newline', () => {
  const f = tmpFile();
  writeJsonUtf8NoBom(f, { name: '测试', n: 1 });
  const buf = fs.readFileSync(f);
  // No BOM
  assert.equal(buf[0], 0x7b, 'first byte must be { (no BOM)');
  assert.ok(!buf.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])), 'must not start with BOM');
  const text = buf.toString('utf8');
  assert.ok(text.endsWith('\n'), 'trailing LF');
  assert.equal(text, '{\n  "name": "测试",\n  "n": 1\n}\n');
  assert.ok(!text.includes('\r\n'), 'no CRLF');
});

test('UT-021 writeJsonUtf8NoBom atomically replaces an existing file (no temp leftover)', () => {
  const f = tmpFile();
  writeJsonUtf8NoBom(f, { v: 1 });
  writeJsonUtf8NoBom(f, { v: 2 });
  assert.deepEqual(readJsonUtf8BomSafe(f), { v: 2 });
  const dir = path.dirname(f);
  const leftovers = fs.readdirSync(dir).filter((n) => n.endsWith('.tmp'));
  assert.equal(leftovers.length, 0, 'no .tmp leftovers after atomic rename');
});

test('UT-021 writeJsonUtf8NoBom creates parent directories', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-par-'));
  const f = path.join(dir, 'nested', 'deep', 'out.json');
  writeJsonUtf8NoBom(f, { ok: true });
  assert.deepEqual(readJsonUtf8BomSafe(f), { ok: true });
});

// ---------------------------------------------------------------------------
// UT-022: change-name 含连字符/中文 → sanitizer 输出符合 pattern
// ---------------------------------------------------------------------------

test('UT-022 sanitized identifiers match the default pattern for varied inputs', () => {
  const cases = ['change-X', 'change_with_underscore', '中文变更名', 'café-résumé', '123-numeric-start', 'has space', 'dot.in.name'];
  for (const c of cases) {
    const id = sanitizeTestIdentifier({ name: c });
    assert.match(id, /^[A-Za-z][A-Za-z0-9_-]*$/, `id '${id}' for '${c}' must match pattern`);
    assert.ok(id.length <= 64, `id '${id}' over maxLength`);
  }
});

test('UT-022 leading non-letter (digit/underscore/中文) gets a leading-letter prefix', () => {
  assert.match(sanitizeTestIdentifier({ name: '123abc' }), /^T123abc/);
  assert.match(sanitizeTestIdentifier({ name: '中文' }), /^T_/);
});

test('UT-022 prefix is prepended', () => {
  const id = sanitizeTestIdentifier({ name: 'my-change', prefix: 'JAVATEST' });
  assert.equal(id, 'JAVATEST_my-change');
  assert.match(id, /^[A-Za-z][A-Za-z0-9_-]*$/);
});

test('UT-022 sanitizeTestIdentifier is deterministic (same input → same output)', () => {
  const a = sanitizeTestIdentifier({ name: '稳定-标识-测试' });
  const b = sanitizeTestIdentifier({ name: '稳定-标识-测试' });
  assert.equal(a, b);
});

// ---------------------------------------------------------------------------
// UT-023: 超长名称 + 清洗后碰撞 → 截断 + 稳定短 hash, 不碰撞
// ---------------------------------------------------------------------------

test('UT-023 over-long names are truncated with a deterministic hash suffix within maxLength', () => {
  const long = 'a'.repeat(120); // 120 chars, all valid
  const id = sanitizeTestIdentifier({ name: long, maxLength: 30 });
  assert.ok(id.length <= 30, `id len ${id.length} > 30`);
  assert.match(id, /^[A-Za-z][A-Za-z0-9_-]*$/);
  assert.ok(/_[0-9a-f]{8}$/.test(id), 'truncated id should end with _<8hex>');
  // deterministic
  assert.equal(id, sanitizeTestIdentifier({ name: long, maxLength: 30 }));
});

test('UT-023 two near-identical long names that collide after truncation stay distinct', () => {
  const base = 'change-name-with-a-very-long-common-prefix-that-gets-truncated-away-';
  const n1 = base + 'AAA';
  const n2 = base + 'BBB';
  const id1 = sanitizeTestIdentifier({ name: n1, maxLength: 40 });
  const id2 = sanitizeTestIdentifier({ name: n2, maxLength: 40 });
  assert.notEqual(id1, id2, 'near-identical long names must not collide');
  assert.ok(id1.length <= 40 && id2.length <= 40);
  assert.match(id1, /^[A-Za-z][A-Za-z0-9_-]*$/);
  assert.match(id2, /^[A-Za-z][A-Za-z0-9_-]*$/);
});

test('UT-023 short names that fit need no hash suffix', () => {
  const id = sanitizeTestIdentifier({ name: 'short-change' });
  assert.equal(id, 'short-change');
  assert.ok(!/_[0-9a-f]{8}$/.test(id), 'short name should not get a hash suffix');
});

// ---------------------------------------------------------------------------
// Runner payload validation (spec §3.4 point 3)
// ---------------------------------------------------------------------------

test('validateRunnerPayload accepts a well-formed payload', () => {
  const r = validateRunnerPayload([
    { id: 'API-001', method: 'POST', url: '/api/x' },
    { id: 'API-002', method: 'GET', url: '/api/y' },
  ]);
  assert.equal(r.ok, true);
  assert.deepEqual(r.errors, []);
});

test('validateRunnerPayload flags missing required fields', () => {
  const r = validateRunnerPayload([{ id: 'API-001', method: 'POST' /* no url */ }]);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.code === 'MISSING_FIELD' && e.field.endsWith('.url')));
});

test('validateRunnerPayload flags invalid identifiers (catches script error before any service request)', () => {
  const r = validateRunnerPayload([{ id: 'bad id!', method: 'GET', url: '/x' }]);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.code === 'INVALID_IDENTIFIER'));
});

test('validateRunnerPayload flags duplicate ids', () => {
  const r = validateRunnerPayload([
    { id: 'API-001', method: 'GET', url: '/a' },
    { id: 'API-001', method: 'GET', url: '/b' },
  ]);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.code === 'DUPLICATE_ID'));
});

test('validateRunnerPayload flags unknown HTTP method', () => {
  const r = validateRunnerPayload([{ id: 'API-001', method: 'FETCH', url: '/x' }]);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.code === 'INVALID_METHOD'));
});

test('validateRunnerPayload rejects non-array and empty payload', () => {
  assert.equal(validateRunnerPayload({}).ok, false);
  assert.equal(validateRunnerPayload([]).ok, false);
});

// ---------------------------------------------------------------------------
// UT-024: profile/Markdown 含凭据值 → 扫描失败; 占位符/env 引用安全
// ---------------------------------------------------------------------------

test('UT-024 findCredentialValues flags a password value in profile JSON', () => {
  const text = '{\n  "password": "MySecretPass123",\n  "user": "admin"\n}\n';
  const f = findCredentialValues(text);
  assert.ok(f.length >= 1);
  assert.ok(f.some((x) => x.code === 'PASSWORD_VALUE'));
  assert.equal(f[0].line, 2);
});

test('UT-024 findCredentialValues flags token/Authorization/secret values', () => {
  const text = [
    'token: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload.sig',
    'Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.sig',
    'api_key: AKIAIOSFODNN7EXAMPLE',
  ].join('\n');
  const f = findCredentialValues(text);
  const codes = f.map((x) => x.code);
  assert.ok(codes.includes('SECRET_VALUE') || codes.includes('AUTH_HEADER'));
  assert.ok(f.length >= 2);
});

test('UT-024 findCredentialValues does NOT flag placeholders or env-var references', () => {
  const text = [
    'password: <PASSWORD_REDACTED>',
    'token: ${TEST_TOKEN}',
    'secret: $DB_PASSWORD',
    'api_key: <API_KEY_REDACTED>',
  ].join('\n');
  const f = findCredentialValues(text);
  assert.equal(f.length, 0, `expected no findings, got ${JSON.stringify(f)}`);
});

test('UT-024 findCredentialValues flags jdbc url with embedded password', () => {
  const text = 'spring.datasource.url: jdbc:mysql://host:3306/db?password=p4ssw0rd';
  const f = findCredentialValues(text);
  assert.ok(f.some((x) => x.code === 'DB_PASSWORD'));
});

test('matchesPattern validates identifiers against the default pattern', () => {
  assert.equal(matchesPattern('API-001'), true);
  assert.equal(matchesPattern('bad id!'), false);
  assert.equal(matchesPattern('1leading-digit'), false);
});
