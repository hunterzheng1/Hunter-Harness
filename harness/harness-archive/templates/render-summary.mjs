#!/usr/bin/env node
// Deterministic executive renderer for normalized Harness archive reports.
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
const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (character) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
})[character]);
const list = (value) => Array.isArray(value) ? value : [];
const record = (value) => value && typeof value === "object" && !Array.isArray(value) ? value : {};
const numeric = (value) => Number.isFinite(Number(value)) ? Number(value) : null;
const normalized = record(data.normalizedReport);
const outcomes = record(normalized.outcomes);
const current = Object.keys(record(outcomes.current)).length
  ? record(outcomes.current)
  : {
      status: data.finalStatus || "UNKNOWN",
      reasons: list(data.finalStatusReasons),
      stages: record(data.stageStatus),
      knownRisks: list(data.knownRisks),
      findings: list(data.reviewFindings)
    };
const history = record(outcomes.history);
const release = Object.keys(record(outcomes.release)).length
  ? record(outcomes.release)
  : {
      decision: data.archiveIntent === "record-only" ? "NOT_REQUESTED" : record(data.releaseDecision).code,
      eligible: Boolean(record(data.releaseDecision).releaseEligible),
      candidate: record(data.candidateVerification),
      intent: data.archiveIntent || ""
    };
const identity = Object.keys(record(normalized.identity)).length
  ? record(normalized.identity)
  : record(data.changeIdentity);
const verification = Object.keys(record(normalized.verification)).length
  ? record(normalized.verification)
  : record(data.verification);
const scenarioCoverage = record(data.scenarioCoverage);
const unexecutedScenarios = list(scenarioCoverage.unexecuted);
const timing = Object.keys(record(normalized.timing)).length
  ? record(normalized.timing)
  : record(data.timing);
const measurements = record(normalized.measurements);
const recordOnly = release.intent === "record-only" || data.archiveIntent === "record-only";
const files = list(data.changedFiles);
const commands = list(record(data.reportPipeline).commands);
const timeline = list(history.timeline).length ? list(history.timeline) : list(data.timeline);
const attempts = list(history.attempts).length
  ? list(history.attempts)
  : list(timing.attempts);
const actions = list(data.manualActions);
const risks = list(current.findings).length
  ? list(current.findings)
  : list(current.knownRisks).length
  ? list(current.knownRisks)
  : list(data.knownRisks);

const statusTone = (raw) => {
  const status = String(raw || "UNKNOWN").toUpperCase();
  if (/FAIL|ERROR|BLOCKED/.test(status)) return "danger";
  if (/WARN|CONDITIONAL|PARTIAL|NOT_RUN|UNKNOWN|SKIP|EVIDENCE_MISSING/.test(status)) return "warning";
  if (/ADVISORY|REUSED|NOT_APPLICABLE/.test(status)) return "neutral";
  return "success";
};
const STATUS_LABELS = {
  OK: "通过", PASS: "通过", PASSED: "通过", CONDITIONAL_OK: "有条件通过",
  WARN: "警告", ADVISORY: "建议", FAIL: "失败", FAILED: "失败", ERROR: "错误",
  BLOCKED: "阻塞", NOT_RUN: "未运行", SKIPPED: "已跳过",
  NOT_APPLICABLE: "不适用", UNKNOWN: "未知", EVIDENCE_MISSING: "证据缺失"
};
const pill = (raw) => {
  const status = String(raw || "UNKNOWN").toUpperCase();
  return `<span class="pill ${statusTone(status)}" title="${esc(status)}">${esc(STATUS_LABELS[status] || status)}</span>`;
};
const describe = (value) => {
  if (typeof value === "string") return value;
  const item = record(value);
  return item.title || item.message || item.summary || item.action || item.remediation || item.note || JSON.stringify(item);
};
const shortHash = (value) => String(value || "N/A").slice(0, 10);
const duration = (raw) => {
  const value = numeric(raw);
  if (value === null) return "N/A";
  if (value < 1000) return `${Math.round(value)}ms`;
  if (value < 60000) return `${Math.round(value / 100) / 10} 秒`;
  if (value < 3600000) return `${Math.round(value / 6000) / 10} 分钟`;
  return `${Math.floor(value / 3600000)} 小时 ${Math.round(value % 3600000 / 60000)} 分钟`;
};
const measurement = (value, unit = "") => {
  const item = record(value);
  if (item.state === "unknown" || item.state === "not_applicable") return "N/A";
  if (item.state === "zero") return `0${unit}`;
  if (item.state === "known") return `${esc(item.value)}${unit}`;
  if (value === null || value === undefined || value === "") return "N/A";
  return `${esc(value)}${unit}`;
};
const verificationStatus = (value) => {
  if (typeof value === "string") return value;
  const item = record(value);
  if (item.status) return item.status;
  if ((numeric(item.failures) || 0) + (numeric(item.errors) || 0) > 0) return "FAIL";
  if ((numeric(item.run) || numeric(item.total) || 0) > 0) return "OK";
  return "NOT_RUN";
};
const verificationNote = (key, raw) => {
  const value = record(raw);
  if (key === "unitTests") {
    const unique = numeric(value.uniqueTestCount);
    const uniqueLabel = unique === null ? "唯一用例未记录" : `唯一 ${unique} 项`;
    return `${value.passRate || `${value.run ?? 0} 次执行`} · ${uniqueLabel} · 重跑 ${value.rerunCount ?? 0}`;
  }
  if (key === "dbCompatibility") {
    const evidence = record(verification.dbCompatibilityEvidence);
    return evidence.status === "EVIDENCE_MISSING"
      ? "缺少可验证的类型化账本/收据"
      : evidence.reason || evidence.evidenceHash || "类型化兼容性证据";
  }
  if (key === "apiTests") return `${value.passRate || `${value.passed ?? 0}/${value.total ?? 0}`} · 阻塞 ${value.blocked ?? 0}`;
  if (key === "browserE2E") return `${value.passed ?? 0}/${value.total ?? 0} 通过 · ${value.failed ?? 0} 失败 · 重试 ${value.retries ?? 0}`;
  if (value.checks !== undefined) return `${value.checks} 项检查`;
  if (value.coverageDisplay) return value.coverageDisplay;
  return Object.keys(value).filter((name) => name !== "status").slice(0, 3)
    .map((name) => `${name}=${value[name]}`).join(" · ") || "无额外指标";
};
const groups = [
  ["后端", ["unitTests", "dbCompatibility"]],
  ["Geo", ["geo"]],
  ["前端", ["frontend"]],
  ["浏览器", ["browserE2E"]],
  ["API", ["apiTests"]]
].map(([label, keys]) => {
  const present = keys.filter((key) => verification[key] !== undefined);
  const values = present.map((key) => verification[key]);
  const statuses = values.map(verificationStatus);
  const groupStatus = statuses.some((status) => /FAIL|ERROR|BLOCKED/.test(String(status)))
    ? "FAIL"
    : statuses.some((status) => /EVIDENCE_MISSING/.test(String(status)))
    ? "EVIDENCE_MISSING"
    : statuses.some((status) => /WARN|CONDITIONAL|PARTIAL/.test(String(status)))
    ? "WARN"
    : statuses.length && statuses.every((status) => /NOT_APPLICABLE/.test(String(status)))
    ? "NOT_APPLICABLE"
    : statuses.length && statuses.every((status) => /OK|PASS|NOT_APPLICABLE/.test(String(status)))
    ? "OK"
    : "NOT_RUN";
  const note = present.map((key) => verificationNote(key, verification[key])).join(" · ") || "未配置该组验证";
  return { label, status: groupStatus, note, present };
});
const passedGroups = groups.filter((group) => group.status === "OK").length;
const productCommit = identity.productCommit || data.productCommit || data.finalCommit;
const identityChain = [
  ["检查点", identity.checkpointCommit || data.checkpointCommit],
  ["产品", productCommit],
  ["功能尖端", identity.featureTip || data.featureTip],
  ["合并", identity.mergeCommit || data.mergeCommit || identity.featureMergeHash],
  ["发布尖端", identity.releaseTip || data.releaseTip || identity.releaseTipHash]
].filter(([, value]) => value).map(([label, value]) => `${label} ${shortHash(value)}`).join(" → ") || "N/A";
const wallClock = timing.workflowWallClockMs ?? record(data.durations).totalMs;

const groupHtml = groups.map((group) => `
  <article class="verify-card" title="${esc(group.present.map((key) => {
    const value = record(verification[key]);
    return `${key} · status=${verificationStatus(verification[key])}${value.failed === undefined ? "" : ` · failed=${value.failed}`}`;
  }).join(" / "))}">
    <div><span class="verify-name">${esc(group.label)}</span>${pill(group.status)}</div>
    <p>${esc(group.note)}</p>
  </article>`).join("");
const risksHtml = risks.map((item) => `<li>${esc(describe(item))}</li>`).join("") || "<li>当前没有未处置风险</li>";
const actionsHtml = actions.map((item) => `<li>${esc(describe(item))}</li>`).join("") || "<li>无需人工后续动作</li>";
const stageHtml = Object.entries(record(current.stages)).map(([name, status]) =>
  `<tr><td>${esc(name)}</td><td>${pill(status)}</td></tr>`
).join("") || '<tr><td colspan="2">没有阶段状态记录</td></tr>';
const fileHtml = files.map((item) =>
  `<tr><td><code>${esc(item.path || item.file)}</code></td><td class="positive">+${esc(item.insertions ?? 0)}</td><td class="negative">-${esc(item.deletions ?? 0)}</td></tr>`
).join("") || '<tr><td colspan="3">没有变更文件证据</td></tr>';
const timelineHtml = timeline.map((item) =>
  `<tr><td>${esc(item.phase || item.stage || "-")}</td><td>${esc(item.attempt || "-")}</td><td>${pill(item.status || item.result || item.type)}</td><td>${esc(item.executorTool || item.executor_tool || item.summary || "-")}</td></tr>`
).join("") || '<tr><td colspan="4">没有时间线记录</td></tr>';
const commandHtml = commands.map((item) =>
  `<tr><td>${esc(item.phase || "-")}</td><td><code>${esc(item.command || "")}</code></td><td>${pill(Number(item.exit_code ?? item.exitCode) === 0 ? "OK" : "FAIL")}</td></tr>`
).join("") || '<tr><td colspan="3">没有命令证据</td></tr>';
const candidate = record(release.candidate);
const releaseHtml = recordOnly ? "" : `
  <article class="card"><h2>发布与候选</h2>
    <div class="fact"><span>候选证明</span>${pill(candidate.ok ? "OK" : candidate.code || "NOT_RUN")}</div>
    <div class="fact"><span>发布资格</span>${pill(release.eligible ? "OK" : release.decision || "BLOCKED")}</div>
  </article>`;
const remoteCost = record(measurements.remoteCost);
const remoteCostTotals = record(remoteCost.totals);
const storage = record(measurements.artifactStorage);
const efficiency = record(data.efficiency);
const efficiencyTiming = record(efficiency.timing);
const environmentActions = record(efficiency.environment);
const failureClasses = record(efficiency.failureClasses);
const projection = record(data.projection);
const durability = record(data.archiveDurability);
const durabilityStatus = durability.status || "ARCHIVED_LOCAL_ONLY";
const scenarioCoverageStatus = scenarioCoverage.skipped
  ? "SKIPPED"
  : scenarioCoverage.ok
  ? "OK"
  : scenarioCoverage.code || "NOT_RUN";
const scenarioCoverageHtml = `
  <article class="card"><h2>场景执行闭环</h2>
    <div class="fact"><span>结构化运行回执</span>${pill(scenarioCoverageStatus)}</div>
    <div class="fact"><span>已执行并通过</span><strong>${list(scenarioCoverage.passed).length}</strong></div>
    <div class="fact"><span>未执行 / 未通过</span><span>${unexecutedScenarios.length
      ? `<code>${esc(unexecutedScenarios.join(", "))}</code>`
      : "无"}</span></div>
  </article>`;

const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Harness 最终报告 · ${esc(data.changeName || "未命名变更")}</title>
<style>
:root{color-scheme:light dark;--canvas:#f4f6f8;--surface:#fff;--surface-2:#f8fafc;--ink:#172033;--muted:#667085;--line:#dfe5ec;--accent:#2457d6;--good:#087443;--warn:#9a5b00;--bad:#b42318;--shadow:0 8px 26px rgba(22,34,58,.07)}
@media(prefers-color-scheme:dark){:root{--canvas:#0b1119;--surface:#121a26;--surface-2:#172231;--ink:#eef3f9;--muted:#9aa8ba;--line:#2a384a;--accent:#86abff;--good:#58d59b;--warn:#efbd68;--bad:#ff8b83;--shadow:0 12px 30px rgba(0,0,0,.28)}}
*{box-sizing:border-box}html,body{max-width:100%;overflow-x:hidden}body{margin:0;background:var(--canvas);color:var(--ink);font:14px/1.55 Inter,"Segoe UI","Microsoft YaHei",sans-serif}main{width:min(1180px,calc(100% - 32px));margin:24px auto 48px}.hero,.card,.metric,details,.verify-card{background:var(--surface);border:1px solid var(--line);border-radius:14px;box-shadow:var(--shadow)}.hero{padding:24px 26px;border-top:4px solid var(--accent)}.kicker{color:var(--accent);font-size:12px;font-weight:800;letter-spacing:.1em}.hero h1{font-size:28px;line-height:1.25;margin:5px 0 7px;overflow-wrap:anywhere}.goal,.muted,small{color:var(--muted)}.outcome{display:flex;align-items:center;gap:10px;margin-top:14px}.record-only{display:inline-flex;margin-top:12px;padding:6px 10px;border-radius:8px;background:var(--surface-2);color:var(--muted)}.metrics{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:10px;margin:11px 0}.metric{min-width:0;padding:13px 14px}.metric strong{display:block;font-size:18px;margin-top:3px;overflow-wrap:anywhere}.card{padding:17px;margin-bottom:11px}.card h2,details summary{font-size:16px;font-weight:760}.card h2{margin:0 0 11px}.verification-grid{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:9px}.verify-card{padding:13px;box-shadow:none;background:var(--surface-2)}.verify-card>div,.fact{display:flex;justify-content:space-between;gap:9px;align-items:center}.verify-name{font-weight:760}.verify-card p{margin:8px 0 0;color:var(--muted);font-size:12px}.two-column{display:grid;grid-template-columns:1.3fr .7fr;gap:11px}.risk-actions{display:grid;grid-template-columns:1fr 1fr;gap:10px}.risk-actions section{padding:12px;border-radius:10px;background:var(--surface-2)}.risk-actions h3{font-size:13px;margin:0 0 6px}.risk-actions ul{margin:0;padding-left:18px;color:var(--muted)}.fact{padding:8px 0;border-bottom:1px solid var(--line)}.fact:last-child{border:0}.pill{display:inline-flex;flex:none;border-radius:999px;padding:3px 9px;font-size:11px;font-weight:800;white-space:nowrap}.pill.success{color:var(--good);background:color-mix(in srgb,var(--good) 13%,transparent)}.pill.warning{color:var(--warn);background:color-mix(in srgb,var(--warn) 14%,transparent)}.pill.danger{color:var(--bad);background:color-mix(in srgb,var(--bad) 13%,transparent)}.pill.neutral{color:var(--accent);background:color-mix(in srgb,var(--accent) 12%,transparent)}details{margin:9px 0}summary{cursor:pointer;padding:13px 16px}details>div{padding:0 16px 16px;overflow:auto}.table-wrap{max-width:100%;overflow:auto}table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:8px 9px;border-bottom:1px solid var(--line);vertical-align:top}th{color:var(--muted);font-size:11px}code{font-family:"Cascadia Code",Consolas,monospace;color:var(--accent);overflow-wrap:anywhere}.positive{color:var(--good)}.negative{color:var(--bad)}dl{display:grid;grid-template-columns:155px minmax(0,1fr);gap:7px 12px}dt{color:var(--muted)}dd{margin:0;overflow-wrap:anywhere}
@media(max-width:900px){.metrics{grid-template-columns:repeat(2,minmax(0,1fr))}.verification-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.two-column{grid-template-columns:1fr}}
@media(max-width:600px){main{width:calc(100% - 18px);margin:9px auto 30px}.hero{padding:18px}.hero h1{font-size:23px}.metrics,.verification-grid,.risk-actions{grid-template-columns:1fr}.outcome{align-items:flex-start;flex-direction:column}.card{padding:14px}dl{grid-template-columns:1fr}.metric strong{font-size:17px}}
</style></head>
<body><main>
<section class="hero">
  <div class="kicker">HARNESS · 管理结论</div>
  <h1>${esc(data.changeName || "未命名变更")}</h1>
  <p class="goal">${esc(data.businessGoal || "未记录业务目标")}</p>
  <div class="outcome">${pill(current.status)}<span>${esc(list(current.reasons).join(" · ") || "结论基于事件、验证账本与 Git 事实")}</span></div>
  ${recordOnly ? '<div class="record-only">归档意图：仅记录 · 未请求发布</div>' : ""}
</section>
<section class="metrics">
  <article class="metric"><small>产品提交链</small><strong><code title="${esc(identityChain)}">${esc(identityChain)}</code></strong></article>
  <article class="metric"><small>验证概览</small><strong>${passedGroups}/${groups.length} 组通过</strong><small>按后端 / Geo / 前端 / 浏览器 / API</small></article>
  <article class="metric"><small>风险与动作</small><strong>${risks.length} / ${actions.length}</strong><small>当前风险 / 人工动作</small></article>
  <article class="metric"><small>全流程耗时</small><strong>${esc(duration(wallClock))}</strong><small>活动 ${esc(duration(timing.stageActiveExecutionMs))}</small></article>
  <article class="metric"><small>代码范围</small><strong>${esc(record(data.diffStat).filesChanged ?? files.length)} 个文件</strong><small class="positive">+${esc(record(data.diffStat).insertions ?? 0)} · <span class="negative">-${esc(record(data.diffStat).deletions ?? 0)}</span></small></article>
</section>
<article class="card"><h2>验证概览</h2><div class="verification-grid">${groupHtml}</div></article>
${scenarioCoverageHtml}
<section class="two-column">
  <article class="card"><h2>风险与动作</h2><div class="risk-actions"><section><h3>当前风险</h3><ul>${risksHtml}</ul></section><section><h3>人工动作</h3><ul>${actionsHtml}</ul></section></div></article>
  <div>
    ${releaseHtml}
    <article class="card"><h2>事实完整性</h2>
      <div class="fact"><span>归档完整性</span>${pill(record(data.archiveIntegrity).ok === false ? "FAIL" : record(data.archiveManifest).checksumStatus || "UNKNOWN")}</div>
      <div class="fact"><span>归档持久性</span><span>${pill(durabilityStatus === "ARCHIVED_DURABLE" ? "OK" : "WARN")} <code>${esc(durabilityStatus)}</code></span></div>
      <div class="fact"><span>时间守恒</span>${pill(numeric(timing.conservationDeltaMs) === 0 ? "OK" : "WARN")}</div>
    </article>
  </div>
</section>
<details><summary>技术证据 · 验证与时间守恒</summary><div>
  <div class="fact"><span>全流程墙钟 <code title="workflowWallClockMs">workflowWallClock</code></span><strong>${esc(duration(timing.workflowWallClockMs))}</strong></div>
  <div class="fact"><span>活动执行 <code title="stageActiveExecutionMs">stageActiveExecution</code></span><strong>${esc(duration(timing.stageActiveExecutionMs))}</strong></div>
  <div class="fact"><span>远端等待 <code title="externalWaitMs">externalWait</code></span><strong>${esc(duration(timing.externalWaitMs))}</strong></div>
  <div class="fact"><span>暂停 <code title="pausedMs">paused</code></span><strong>${esc(duration(timing.pausedMs))}</strong></div>
  <div class="fact"><span>未归因 <code title="agentOrToolUnattributedMs">agentOrToolUnattributed</code></span><strong>${esc(duration(timing.agentOrToolUnattributedMs))}</strong></div>
  <div class="fact"><span>远端 runner 成本</span><strong>${measurement(remoteCostTotals.runnerMinutes ?? remoteCost.runnerMinutes, " 分钟")}</strong></div>
  <div class="fact"><span>新增制品字节</span><strong>${measurement(storage.bytesAdded, " bytes")}</strong></div>
  <div class="fact"><span>验证尝试 / 资源等待</span><strong>${esc(efficiency.verificationAttempts ?? 0)} / ${esc(duration(efficiencyTiming.resourceWaitMs))}</strong></div>
  <div class="fact"><span>环境准备 / 复用 / 重置 / 清理</span><strong>${esc(environmentActions.prepare ?? 0)} / ${esc(environmentActions.reuse ?? 0)} / ${esc(environmentActions.reset ?? 0)} / ${esc(environmentActions.cleanup ?? 0)}</strong></div>
  <div class="fact"><span>启动器 / 环境 / 测试 / 外部失败</span><strong>${esc(failureClasses.launcher ?? 0)} / ${esc(failureClasses.environment ?? 0)} / ${esc(failureClasses.test ?? 0)} / ${esc(failureClasses.external ?? 0)}</strong></div>
  <div class="fact"><span>无新证据的重复命令</span><strong>${esc(efficiency.repeatedCommandsWithoutNewEvidence ?? 0)}</strong></div>
  <div class="fact"><span>守恒差值 <code>conservationDeltaMs</code></span><strong>${esc(timing.conservationDeltaMs ?? "N/A")}</strong></div>
</div></details>
<details><summary>阶段状态</summary><div class="table-wrap"><table><thead><tr><th>阶段</th><th>结果</th></tr></thead><tbody>${stageHtml}</tbody></table></div></details>
<details><summary>变更文件（${files.length}）</summary><div class="table-wrap"><table><thead><tr><th>文件</th><th>新增</th><th>删除</th></tr></thead><tbody>${fileHtml}</tbody></table></div></details>
<details><summary>执行时间线与工具交接（${timeline.length}）</summary><div class="table-wrap"><table><thead><tr><th>阶段</th><th>尝试</th><th>状态</th><th>来源 / 摘要</th></tr></thead><tbody>${timelineHtml}</tbody></table></div></details>
<details><summary>命令证据（${commands.length}）</summary><div class="table-wrap"><table><thead><tr><th>阶段</th><th>命令</th><th>结果</th></tr></thead><tbody>${commandHtml}</tbody></table></div></details>
<details><summary>技术元数据</summary><div><dl>
  <dt>产品提交</dt><dd><code>${esc(productCommit || "N/A")}</code></dd>
  <dt>检查点 → 产品 → 功能尖端 → 合并 → 发布尖端</dt><dd><code>${esc(identityChain)}</code></dd>
  <dt>产品树哈希</dt><dd><code>${esc(identity.productTreeHash || data.productTreeHash || "N/A")}</code></dd>
  <dt>环境哈希</dt><dd><code>${esc(identity.environmentHash || data.environmentHash || "N/A")}</code></dd>
  <dt>基线提交</dt><dd><code>${esc(identity.baseCommit || data.baseCommit || "N/A")}</code></dd>
  <dt>报告数据版本</dt><dd>${esc(data.schemaVersion || "N/A")}</dd>
  <dt>归档意图</dt><dd title="${esc(release.intent)}">${recordOnly ? "仅记录（未请求发布）" : esc(release.intent || "未声明")}</dd>
  <dt>归档持久性</dt><dd><code>${esc(durabilityStatus)}</code>${durability.risk ? ` · ${esc(durability.risk)}` : ""}</dd>
  <dt>保留策略</dt><dd>${esc(durability.retentionPolicy || "N/A")}</dd>
  <dt>场景回执状态</dt><dd><code>${esc(scenarioCoverage.code || scenarioCoverageStatus)}</code></dd>
  <dt>尝试记录</dt><dd>${attempts.length}</dd>
  <dt>历史质量</dt><dd>${numeric(timing.unclosedAttemptCount) === 0 ? "无未闭合尝试" : `${esc(timing.unclosedAttemptCount ?? "N/A")} 个未闭合尝试`}</dd>
  <dt>投影状态</dt><dd title="Projection / Fallback"><code>${esc(projection.code || projection.mode || "N/A")}</code></dd>
</dl></div></details>
</main></body></html>`;

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, html, "utf8");
