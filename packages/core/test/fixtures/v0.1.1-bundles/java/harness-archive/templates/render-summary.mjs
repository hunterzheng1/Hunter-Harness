#!/usr/bin/env node
// render-summary.mjs
// Deterministic UTF-8 renderer for harness archive final-summary.html.
// Input: summary-data.json (schemaVersion 2.2). Output: final-summary.html.
// Keeps UTF-8, avoids PowerShell string interpolation issues.
// All numbers come from summary-data.json or manifest — never re-inferred here.

import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
function getArg(name, fallback) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}

const summaryPath = getArg('--summary', args[0]);
const outPath = getArg('--out', args[1] || 'final-summary.html');
if (!summaryPath) {
  console.error('Usage: node render-summary.mjs --summary summary-data.json --out final-summary.html');
  process.exit(2);
}

const data = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const arr = (v) => Array.isArray(v) ? v : [];
const obj = (v) => v && typeof v === 'object' ? v : {};
const num = (v) => Number(v) || 0;
const badgeClass = (s) => {
  const v = String(s ?? '').toUpperCase();
  if (v.includes('FAIL') || v.includes('ERROR')) return 'bad';
  if (v.includes('WARN') || v.includes('BLOCK') || v.includes('SKIP') || v.includes('CONDITIONAL') || v.includes('PARTIAL') || v.includes('NOT_RUN')) return 'warn';
  if (v.includes('ADVISORY') || v.includes('REUSED')) return 'info';
  return 'ok';
};
const badge = (s) => `<span class="badge ${badgeClass(s)}">${esc(s || 'N/A')}</span>`;

// pass-rate progress bar: parses "183/185" style strings
const parseRate = (rate) => {
  if (!rate) return null;
  const m = String(rate).match(/(\d+)\s*\/\s*(\d+)/);
  return m ? { passed: +m[1], total: +m[2] } : null;
};
const rateBar = (rateStr, status) => {
  const r = parseRate(rateStr);
  if (!r || r.total <= 0) return `<span class="muted">N/A</span>`;
  const pct = Math.round(r.passed / r.total * 100);
  const cls = badgeClass(status || (r.passed >= r.total ? 'OK' : 'WARN'));
  return `<div class="rate"><div class="bar-track"><div class="bar-fill ${cls}" style="width:${pct}%"></div></div><span class="muted small">${esc(rateStr)} · ${pct}%</span></div>`;
};

const stageRows = Object.entries(obj(data.stageStatus)).map(([k,v]) => `<tr><td>${esc(k)}</td><td>${badge(v)}</td></tr>`).join('\n') || `<tr><td colspan="2" class="muted">未记录阶段状态</td></tr>`;

const verification = obj(data.verification);
const unit = obj(verification.unitTests);
const api = obj(verification.apiTests);
const unitStatus = (num(unit.failures) + num(unit.errors)) > 0 ? 'WARN' : 'OK';
const verificationRows = [
  ['Unit Tests', `${rateBar(unit.passRate, unitStatus)}<div class="muted small">${esc(unit.run ?? 0)} run · ${esc(unit.failures ?? 0)} fail · ${esc(unit.errors ?? 0)} err · ${esc(unit.skipped ?? 0)} skip · ${esc(unit.source || 'not recorded')}</div>`],
  ['API Tests', `${rateBar(api.passRate, api.status)}<div class="muted small">${esc(api.passed ?? 0)}/${esc(api.total ?? 0)} · ${esc(api.status || data.stageStatus?.test || 'N/A')}</div>`],
  ['DB Compat', badge(verification.dbCompatibility || 'N/A')],
  ['Coverage', esc(verification.coverageDisplay || 'N/A')],
  ['Overall', badge(data.finalStatus || data.overallStatus || 'N/A')]
].map(([a,b]) => `<tr><td>${a}</td><td>${b}</td></tr>`).join('\n');

const diffStat = obj(data.diffStat);
const changedRows = arr(data.changedFiles).map(f => `<tr><td><code>${esc(f.path || f.file || '')}</code></td><td>${esc(f.summary || f.change || '')}</td><td class="ins">+${esc(f.insertions ?? 0)}</td><td class="del">-${esc(f.deletions ?? 0)}</td></tr>`).join('\n') || `<tr><td colspan="4" class="muted">未记录变更文件</td></tr>`;
const artifactList = arr(data.artifacts);
const artifactRows = artifactList.map(a => `<tr><td>${esc(a.name || '')}</td><td><code>${esc(a.path || '')}</code></td><td>${esc(a.size || '')}</td><td><code>${esc(a.sha256 || '')}</code></td></tr>`).join('\n');
const artifactCard = artifactList.length > 0 ? `<div class="card"><h2>📦 产物清单</h2><table><tr><th>名称</th><th>路径</th><th>大小</th><th>SHA-256</th></tr>${artifactRows}</table></div>` : '';
const notes = arr(data.maintenanceNotes).map(n => `<li>${esc(n)}</li>`).join('\n') || `<li class="muted">无额外维护说明</li>`;
const risks = arr(data.knownRisks).map(n => `<li>${esc(n)}</li>`).join('\n') || `<li class="muted">无已知遗留风险</li>`;
const manual = arr(data.manualActions).map(n => `<li>${esc(n)}</li>`).join('\n') || `<li class="muted">无人工后续动作</li>`;
const uncommittedList = arr(data.uncommittedTestEvidence);
const uncommittedTests = uncommittedList.map(n => `<li>${esc(n)}</li>`).join('\n');
const uncommittedCard = uncommittedList.length > 0 ? `<div class="card"><h2>🧪 未提交测试证据</h2><ul>${uncommittedTests}</ul></div>` : '';
const review = obj(data.reviewSummary);
const manifest = obj(data.archiveManifest);
const timeline = arr(data.timeline).map(t => `<tr><td>${esc(t.stage || '')}</td><td>${badge(t.result || '')}</td><td>${esc(t.evidence || '')}</td></tr>`).join('\n');

// durations + skillCalls (schema 2.1); fall back to timeline when absent
const durations = obj(data.durations);
const durStages = arr(durations.stages);
const maxMin = durStages.reduce((m, s) => Math.max(m, num(s.minutes)), 0);
const durRows = durStages.map(s => {
  const min = num(s.minutes);
  const pct = maxMin > 0 ? Math.round(min / maxMin * 100) : 0;
  return `<div class="dur-row"><div class="dur-label">${esc(s.skill || s.stage || '')} <span class="muted small">${esc(s.result || '')}</span></div><div class="dur-track"><div class="dur-bar" style="width:${pct}%"></div></div><div class="dur-min">${esc(min)}m</div></div>`;
}).join('\n');
const skillCallsHtml = arr(data.skillCalls).map(s => `${esc(s.skill)}×${esc(s.count)} ${badge(s.result)}`).join(' ') || '<span class="muted">未记录</span>';

const durCard = durStages.length > 0
  ? `<div class="card"><h2>⏱️ 阶段耗时与 Skill 调用</h2>${durRows}<div class="muted small" style="margin-top:10px">Skill 调用：${skillCallsHtml}</div></div>`
  : (timeline ? `<div class="card"><h2>阶段时间线</h2><table><tr><th>阶段</th><th>结果</th><th>证据</th></tr>${timeline}</table></div>` : '');

const totalLabel = durations.totalLabel || (durations.totalMinutes ? durations.totalMinutes + 'm' : 'N/A');

const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>变更最终报告 - ${esc(data.changeName || '')}</title>
<style>
:root { color-scheme: dark; }
* { box-sizing: border-box; }
body { font-family: -apple-system,BlinkMacSystemFont,'Segoe UI','Microsoft YaHei',sans-serif; margin: 0; background: #0b1020; color: #e5e7eb; }
main { max-width: 1120px; margin: 0 auto; padding: 32px; }
.card { background: rgba(255,255,255,.06); border: 1px solid rgba(255,255,255,.12); border-radius: 16px; padding: 20px; margin: 16px 0; box-shadow: 0 12px 40px rgba(0,0,0,.18); }
h1 { margin: 0 0 8px; font-size: 30px; }
h2 { margin: 0 0 12px; font-size: 20px; }
h3 { margin: 18px 0 8px; }
.muted { color: #94a3b8; }
.small { font-size: 12px; }
table { width: 100%; border-collapse: collapse; table-layout: fixed; }
th, td { border-bottom: 1px solid rgba(255,255,255,.12); padding: 10px; text-align: left; vertical-align: top; overflow-wrap: anywhere; }
th { color: #cbd5e1; font-weight: 600; }
tbody tr:nth-child(even) { background: rgba(255,255,255,.03); }
tbody tr:hover { background: rgba(96,165,250,.08); }
code { color: #bfdbfe; word-break: break-all; }
.ins { color: #86efac; font-weight: 600; }
.del { color: #fca5a5; font-weight: 600; }
.badge { display: inline-block; padding: 4px 8px; border-radius: 999px; font-weight: 700; font-size: 12px; }
.badge.ok { background: rgba(34,197,94,.16); color: #86efac; }
.badge.warn { background: rgba(245,158,11,.18); color: #fcd34d; }
.badge.bad { background: rgba(239,68,68,.18); color: #fca5a5; }
.badge.info { background: rgba(59,130,246,.18); color: #93c5fd; }
.grid { display: grid; grid-template-columns: repeat(auto-fit,minmax(200px,1fr)); gap: 16px; }
.kpi { font-size: 18px; font-weight: 700; margin-top: 4px; word-break: break-all; }
.hero { border-color: rgba(96,165,250,.35); background: linear-gradient(135deg, rgba(59,130,246,.12), rgba(255,255,255,.04)); }
ul { margin-top: 8px; }
.bar-track { background: rgba(255,255,255,.08); border-radius: 999px; height: 8px; overflow: hidden; margin: 4px 0; }
.bar-fill { height: 100%; border-radius: 999px; }
.bar-fill.ok { background: #22c55e; }
.bar-fill.warn { background: #f59e0b; }
.bar-fill.bad { background: #ef4444; }
.bar-fill.info { background: #3b82f6; }
.rate { display: flex; flex-direction: column; gap: 2px; min-width: 160px; }
.dur-row { display: grid; grid-template-columns: 150px 1fr 50px; align-items: center; gap: 10px; padding: 6px 0; }
.dur-label { color: #93c5fd; font-size: 13px; }
.dur-track { background: rgba(255,255,255,.06); border-radius: 4px; height: 18px; overflow: hidden; }
.dur-bar { height: 100%; background: linear-gradient(90deg, #3b82f6, #60a5fa); border-radius: 4px; }
.dur-min { color: #94a3b8; font-size: 13px; text-align: right; }
@media (max-width: 640px) { main { padding: 16px; } .grid { grid-template-columns: 1fr; } .dur-row { grid-template-columns: 100px 1fr 40px; } }
</style>
</head>
<body><main>
<div class="card hero">
  <h1>变更最终报告：${esc(data.changeName || '')}</h1>
  <p class="muted">${esc(data.businessGoal || '未记录业务目标')}</p>
</div>
<div class="grid">
  <div class="card"><div class="muted">🎯 最终状态</div><div class="kpi">${badge(data.finalStatus || data.overallStatus || 'N/A')}</div></div>
  <div class="card"><div class="muted">🔒 Final Commit</div><div class="kpi"><code>${esc(data.finalCommit || 'N/A')}</code></div><div class="muted small">${esc(data.finalCommitBranch || '')}</div></div>
  <div class="card"><div class="muted">📊 代码变更</div><div class="kpi">${esc(diffStat.filesChanged ?? 'N/A')} 文件</div><div class="muted small"><span class="ins">+${esc(diffStat.insertions ?? 0)}</span> <span class="del">-${esc(diffStat.deletions ?? 0)}</span></div></div>
  <div class="card"><div class="muted">⏱️ 总耗时</div><div class="kpi">${esc(totalLabel)}</div><div class="muted small">${esc(durStages.length)} 个阶段</div></div>
  <div class="card"><div class="muted">📝 Review</div><div class="kpi">${esc(review.status || 'N/A')}</div><div class="muted small">RED ${esc(review.red ?? 0)}(修${esc(review.redFixed ?? 0)}/确${esc(review.redConfirmed ?? 0)}) · YEL ${esc(review.yellow ?? 0)}(修${esc(review.yellowFixed ?? 0)}/留${esc(review.yellowDeferred ?? 0)})</div></div>
  <div class="card"><div class="muted">📦 Archive</div><div class="kpi">${esc(manifest.totalArchiveFiles ?? 'N/A')} 文件</div><div class="muted small">${esc(manifest.checksumStatus || 'N/A')}</div></div>
</div>
<div class="card"><h2>📋 阶段状态</h2><table><tr><th>阶段</th><th>状态</th></tr>${stageRows}</table></div>
${durCard}
<div class="card"><h2>🛡️ 验证明细</h2><table><tr><th>类型</th><th>结果</th></tr>${verificationRows}</table></div>
<div class="card"><h2>📁 变更文件</h2><table><tr><th>文件</th><th>说明</th><th>+</th><th>-</th></tr>${changedRows}</table></div>
${artifactCard}
${uncommittedCard}
<div class="card"><h2>👨‍🔧 给后续维护者</h2><ul>${notes}</ul></div>
<div class="card"><h2>⚠️ 已知风险 / 人工确认项</h2><ul>${risks}</ul><h3>人工后续动作</h3><ul>${manual}</ul></div>
</main></body></html>`;

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, html, 'utf8');
