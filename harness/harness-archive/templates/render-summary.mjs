#!/usr/bin/env node
// Compact deterministic renderer for Harness archive summary-data.json.
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};
const summaryPath = arg("--summary", args[0]);
const outPath = arg("--out", args[1] || "final-summary.html");
if (!summaryPath) {
  console.error("Usage: node render-summary.mjs --summary summary-data.json --out final-summary.html");
  process.exit(2);
}

const data = JSON.parse(fs.readFileSync(summaryPath, "utf8"));
const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
})[char]);
const list = (value) => Array.isArray(value) ? value : [];
const record = (value) => value && typeof value === "object" && !Array.isArray(value) ? value : {};
const number = (value) => Number(value) || 0;
const shortHash = (value) => String(value || "N/A").slice(0, 10);
const statusClass = (value) => {
  const status = String(value || "UNKNOWN").toUpperCase();
  if (/FAIL|ERROR/.test(status)) return "danger";
  if (/WARN|BLOCK|SKIP|CONDITIONAL|PARTIAL|NOT_RUN|UNKNOWN/.test(status)) return "warning";
  if (/ADVISORY|REUSED/.test(status)) return "neutral";
  return "success";
};
const pill = (value) => `<span class="pill ${statusClass(value)}">${esc(value || "UNKNOWN")}</span>`;
const describe = (value) => {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return String(value ?? "");
  return value.message || value.action || value.note || value.summary || JSON.stringify(value);
};
const duration = (minutes) => {
  const value = number(minutes);
  if (value < 1) return `${Math.round(value * 60)} 秒`;
  if (value < 60) return `${Math.round(value * 10) / 10} 分钟`;
  return `${Math.floor(value / 60)} 小时 ${Math.round(value % 60)} 分钟`;
};
const durationMs = (ms) => {
  const value = number(ms);
  if (value <= 0) return "0 秒";
  if (value < 1000) return `${value}ms`;
  const seconds = value / 1000;
  if (seconds < 60) return `${Math.round(seconds * 10) / 10} 秒`;
  const minutes = seconds / 60;
  if (minutes < 60) return `${Math.round(minutes * 10) / 10} 分钟`;
  return `${Math.floor(minutes / 60)} 小时 ${Math.round(minutes % 60)} 分钟`;
};

const stages = Object.entries(record(data.stageStatus));
const verification = record(data.verification);
const unit = record(verification.unitTests);
const api = record(verification.apiTests);
const durations = record(data.durations);
const durationStages = list(durations.stages);
const timing = record(data.timing);
const wallLabel = timing.workflowWallClockMs != null
  ? durationMs(timing.workflowWallClockMs)
  : (durations.totalLabel || duration(durations.totalMinutes));
const timingColumnsHtml = `
<article class="card" id="timingColumns"><h2>时长（三列）</h2>
<div class="row"><div><strong>活动执行</strong><small>stageActiveExecution</small></div><span>${esc(durationMs(timing.stageActiveExecutionMs))}</span></div>
<div class="row"><div><strong>阶段墙钟</strong><small>stageWallClockSpan</small></div><span>${esc(durationMs(timing.stageWallClockSpanMs))}</span></div>
<div class="row"><div><strong>全流程墙钟</strong><small>workflowWallClock</small></div><span>${esc(durationMs(timing.workflowWallClockMs))}</span></div>
<p><small>reportCutoffAt=<code id="reportCutoffAt">${esc(timing.reportCutoffAt || "N/A")}</code> · durations.totalMinutes 仅为活动执行，不冒充墙钟</small></p>
</article>`;
const maxMinutes = Math.max(1, ...durationStages.map((item) => number(item.minutes)));
const diff = record(data.diffStat);
const risks = list(data.knownRisks);
const actions = list(data.manualActions);
const files = list(data.changedFiles);
const commands = list(record(data.reportPipeline).commands);
const timeline = list(data.timeline);
const statusReasons = list(data.finalStatusReasons);
const reasonHtml = statusReasons.length
  ? `<small>${statusReasons.map((item) => esc(item)).join(" · ")}</small>`
  : "";

const stageHtml = stages.map(([name, status]) => `<div class="row"><span>${esc(name)}</span>${pill(status)}</div>`).join("") || '<p class="empty">没有阶段状态记录</p>';
const verificationHtml = [
  ["单元测试", unit.status || ((number(unit.failures) + number(unit.errors)) > 0 ? "FAIL" : (number(unit.run) > 0 ? "OK" : "NOT_RUN")), `${number(unit.run)} 个 · ${number(unit.failures)} 失败 · ${number(unit.errors)} 错误`],
  ["API 测试", api.status || "NOT_RUN", `${number(api.passed)}/${number(api.total)} 通过 · ${number(api.blocked)} 阻塞`],
  ["数据库兼容", verification.dbCompatibility || "NOT_RUN", verification.coverageDisplay || "未记录覆盖率"]
].map(([name, status, note]) => `<div class="row"><div><strong>${esc(name)}</strong><small>${esc(note)}</small></div>${pill(status)}</div>`).join("");
const durationHtml = durationStages.map((item) => {
  const width = Math.max(2, Math.round(number(item.minutes) / maxMinutes * 100));
  const attempts = list(item.attempts).length;
  return `<div class="duration"><div><span>${esc(item.skill || item.stage)}</span><span>${duration(item.minutes)}${attempts > 1 ? ` · ${attempts} 次尝试` : ""}</span></div><i><b style="width:${width}%"></b></i></div>`;
}).join("") || '<p class="empty">没有可计算的阶段耗时</p>';
const riskHtml = risks.map((item) => `<li>${esc(describe(item))}</li>`).join("") || "<li>未记录已知风险</li>";
const actionHtml = actions.map((item) => `<li>${esc(describe(item))}</li>`).join("") || "<li>无需人工后续动作</li>";
const fileRows = files.map((item) => `<tr><td><code>${esc(item.path || item.file)}</code></td><td class="plus">+${number(item.insertions)}</td><td class="minus">-${number(item.deletions)}</td></tr>`).join("") || '<tr><td colspan="3">没有变更文件证据</td></tr>';
const timelineRows = timeline.map((item) => `<tr><td>${esc(item.phase || item.stage || "-")}</td><td>${esc(item.attempt || "-")}</td><td>${pill(item.status || item.result || item.type)}</td><td>${esc(item.executorTool || item.executor_tool || item.summary || "-")}</td></tr>`).join("") || '<tr><td colspan="4">没有时间线记录</td></tr>';
const commandRows = commands.map((item) => `<tr><td>${esc(item.phase || "-")}</td><td><code>${esc(item.command)}</code></td><td>${pill(number(item.exit_code) === 0 ? "OK" : "FAIL")}</td></tr>`).join("") || '<tr><td colspan="3">没有命令证据</td></tr>';

const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Harness 最终报告 · ${esc(data.changeName)}</title><style>
:root{color-scheme:light dark;--bg:#f3f6fa;--card:#fff;--soft:#f7f9fc;--text:#182132;--muted:#667085;--line:#dce3ed;--blue:#2563eb;--good:#087443;--warn:#9b5a00;--bad:#b42318;--shadow:0 8px 24px rgba(18,35,70,.07)}
@media(prefers-color-scheme:dark){:root{--bg:#0b1018;--card:#121925;--soft:#182130;--text:#eef3fb;--muted:#9aa8bc;--line:#29364a;--blue:#7aa9ff;--good:#55d99d;--warn:#f0bc63;--bad:#ff8b83;--shadow:0 12px 30px rgba(0,0,0,.25)}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:14px/1.5 Inter,"Segoe UI","Microsoft YaHei",sans-serif}main{width:min(1140px,calc(100% - 28px));margin:22px auto 44px}.hero,.card,.metric,details{background:var(--card);border:1px solid var(--line);border-radius:14px;box-shadow:var(--shadow)}.hero{padding:23px 25px;border-top:3px solid var(--blue)}.eyebrow{color:var(--blue);font-weight:750;letter-spacing:.08em}h1{font-size:27px;line-height:1.2;margin:5px 0 7px;overflow-wrap:anywhere}.goal,.empty,small{color:var(--muted)}.status{display:flex;align-items:center;gap:10px;margin-top:16px}.metrics{display:grid;grid-template-columns:repeat(4,1fr);gap:11px;margin:11px 0}.metric{padding:14px 15px}.metric strong{display:block;font-size:19px;margin:4px 0}.grid{display:grid;grid-template-columns:1.12fr .88fr;gap:11px}.card{padding:17px;margin-bottom:11px}h2{font-size:16px;margin:0 0 10px}.row{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:9px 0;border-bottom:1px solid var(--line)}.row:last-child{border:0}.row small{display:block;margin-top:2px}.pill{display:inline-flex;border-radius:999px;padding:3px 9px;font-size:11px;font-weight:750;white-space:nowrap}.pill.success{color:var(--good);background:color-mix(in srgb,var(--good) 13%,transparent)}.pill.warning{color:var(--warn);background:color-mix(in srgb,var(--warn) 14%,transparent)}.pill.danger{color:var(--bad);background:color-mix(in srgb,var(--bad) 13%,transparent)}.pill.neutral{color:var(--blue);background:color-mix(in srgb,var(--blue) 12%,transparent)}.duration{margin:11px 0}.duration>div{display:flex;justify-content:space-between;color:var(--muted);font-size:12px}.duration>div span:first-child{color:var(--text);font-weight:650}.duration i{display:block;height:7px;background:var(--soft);border-radius:99px;overflow:hidden;margin-top:6px}.duration b{display:block;height:100%;background:linear-gradient(90deg,var(--blue),#7c70ff)}.risk{display:grid;grid-template-columns:1fr 1fr;gap:10px}.risk>div{background:var(--soft);border-radius:10px;padding:11px}.risk h3{font-size:13px;margin:0 0 5px}.risk ul{padding-left:18px;margin:0;color:var(--muted)}details{margin:9px 0}summary{cursor:pointer;padding:13px 15px;font-weight:650}details>div{padding:0 15px 15px;overflow:auto}table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:8px 9px;border-bottom:1px solid var(--line);vertical-align:top}th{color:var(--muted);font-size:11px;letter-spacing:.04em}code{font-family:"Cascadia Code",Consolas,monospace;color:var(--blue);overflow-wrap:anywhere}.plus{color:var(--good)}.minus{color:var(--bad)}dl{display:grid;grid-template-columns:145px 1fr;gap:7px 11px}dt{color:var(--muted)}dd{margin:0;overflow-wrap:anywhere}
@media(max-width:800px){.metrics{grid-template-columns:1fr 1fr}.grid,.risk{grid-template-columns:1fr}}@media(max-width:480px){main{width:calc(100% - 18px);margin-top:9px}.metrics{grid-template-columns:1fr}.hero{padding:19px}h1{font-size:23px}dl{grid-template-columns:1fr}}
</style></head><body><main>
<section class="hero"><div class="eyebrow">HARNESS EXECUTION REPORT</div><h1>${esc(data.changeName || "未命名变更")}</h1><p class="goal">${esc(data.businessGoal || "未记录业务目标")}</p><div class="status">${pill(data.finalStatus)}<span>基于事件、验证账本与 Git 证据生成${data.riskTier ? ` · riskTier=${esc(data.riskTier)}` : ""}</span></div>${reasonHtml ? `<div class="status">${reasonHtml}</div>` : ""}</section>
<section class="metrics"><article class="metric"><small>产品提交</small><strong><code title="${esc(data.productCommit || data.finalCommit)}">${esc(shortHash(data.productCommit || data.finalCommit))}</code></strong><small>archive=${esc(shortHash(data.archiveCommit || data.finalCommit))}</small></article><article class="metric"><small>代码范围</small><strong>${number(diff.filesChanged)} 个文件</strong><small><span class="plus">+${number(diff.insertions)}</span> · <span class="minus">-${number(diff.deletions)}</span></small></article><article class="metric"><small>全流程墙钟</small><strong>${esc(wallLabel)}</strong><small>活动=${esc(durationMs(timing.stageActiveExecutionMs))} · ${durationStages.length} 阶段</small></article><article class="metric"><small>归档完整性</small><strong>${esc(record(data.archiveManifest).checksumStatus || "UNKNOWN")}</strong><small>${number(record(data.archiveManifest).totalArchiveFiles)} 个归档文件</small></article></section>
<section class="grid"><div><article class="card"><h2>验证结论</h2>${verificationHtml}</article><article class="card"><h2>阶段耗时（活动）</h2>${durationHtml}</article>${timingColumnsHtml}</div><div><article class="card"><h2>阶段状态</h2>${stageHtml}</article><article class="card"><h2>风险与后续</h2><div class="risk"><div><h3>已知风险</h3><ul>${riskHtml}</ul></div><div><h3>人工动作</h3><ul>${actionHtml}</ul></div></div></article></div></section>
<details><summary>变更文件（${files.length}）</summary><div><table><thead><tr><th>文件</th><th>新增</th><th>删除</th></tr></thead><tbody>${fileRows}</tbody></table></div></details>
<details><summary>执行时间线与工具交接（${timeline.length}）</summary><div><table><thead><tr><th>阶段</th><th>尝试</th><th>状态</th><th>来源 / 摘要</th></tr></thead><tbody>${timelineRows}</tbody></table></div></details>
<details><summary>命令证据（${commands.length}）</summary><div><table><thead><tr><th>阶段</th><th>命令</th><th>结果</th></tr></thead><tbody>${commandRows}</tbody></table></div></details>
<details><summary>技术元数据</summary><div><dl><dt>产品提交</dt><dd><code>${esc(data.productCommit || data.finalCommit || "N/A")}</code></dd><dt>产品树哈希</dt><dd><code>${esc(data.productTreeHash || "N/A")}</code></dd><dt>归档提交</dt><dd><code>${esc(data.archiveCommit || data.finalCommit || "N/A")}</code></dd><dt>基线提交</dt><dd><code>${esc(data.baseCommit || "N/A")}</code></dd><dt>Git 范围</dt><dd><code>${esc(diff.range || "N/A")}</code></dd><dt>报告数据版本</dt><dd>${esc(data.schemaVersion || "N/A")}</dd><dt>事实来源</dt><dd>${esc(list(record(data.reportPipeline).sources).join(" · ") || "N/A")}</dd></dl></div></details>
</main></body></html>`;

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, html, "utf8");
