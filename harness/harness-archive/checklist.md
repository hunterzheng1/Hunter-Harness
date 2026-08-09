---
description: harness-archive 的归档前检查项和归档后验证项。仅在 Phase 1 检查和 Phase 4 验证时读取。
---

# harness-archive 检查清单

## P0 数据化归档门禁

归档遵循 `../protocols/archive-report-protocol.md`，门禁要点见 SKILL.md `## 关键规则` 四/五/九：

- 生成并校验 `reports/final/summary-data.json`；平台直接使用该文件展示结果。
- 归档前生成 `evidence/archive-manifest-before.json`，移动后生成 `archive-manifest-after.json`。
- 归档统计只能来自 summary-data 或 manifest。
- before/after checksum 不一致时，不得删除原目录。
- 需要跨工作区恢复时传 `--durable-root <独立存储>`；成功必须为 `ARCHIVED_DURABLE`，并验证 content-addressed object 与 durable receipt 可读回。
- `restore-durable` 只恢复到不存在的目标；目标已存在或对象 digest 不符时 fail closed，禁止覆盖。
- 未配置 durable root 时显式记录 `ARCHIVED_LOCAL_ONLY` 风险，不得把同工作区 move 宣称为独立备份。

### Wave-A 状态机与身份（IA-1 / IA-4）

硬顺序：feature frozen → local gates → product candidate CI → **CI green** → merge → authoritative CI → archive product candidate → archive-only governance → release。

- [ ] `evidence/product-candidate-ci.json`（或等价 ledger 字段）`conclusion=success`，含 `runUrl` + `commit`；否则 `PRODUCT_CI_NOT_GREEN` 阻断
- [ ] summary/identity 含 `productCommit` / `productTreeHash` / `archiveCommit`；`productTreeHash` 排除 `.harness/**`
- [ ] 产品输入在 archive 后变化 → `ARCHIVE_EVIDENCE_REOPEN_REQUIRED`，旧 archive 不可作发布证据
- [ ] Manifest：coverage 字节在最终 snapshot 后不得静默漂移；后写报告必须 `exclusionReasons`，禁止假绿 `checksumStatus=OK`

### Environment 合同（IA-3）

- [ ] 使用可写环境栈前：`harness_environment.py fingerprint` → `acquire` lease → run → `release`
- [ ] 租约落在主仓 `.harness/runtime/env-leases/`；跨 change 默认不得共享可写 volume

## 归档前检查（Phase 1）

> ⚠️ **单一所有权**：finalize 内部负责且仅负责一次 `phase.start` / `phase.end`。归档前检查不得自行追加 archive 阶段边界。

- [ ] 未在调用 finalize 前手工追加 archive 阶段边界
- [ ] 只有一个未归档变更目录（多个时终止或让用户选择）
- [ ] 已确认 `closure`：正常完成 / 主动废弃 / 被其他方案替代；后两者有中文 `closure-reason`
- [ ] 正常完成按 `plannedPhases` 核对；提前结束只要求可识别变更与安全封存的最小材料
- [ ] 变更目录下有 plans/ 子目录（至少有计划文件）
- [ ] `events.ndjson` 存在；执行日志允许由 finalize 从事件流重新渲染（旧 archive 才兼容根目录 `execution-log.md`）
- [ ] 准备生成 `archive-manifest-before.json`（path/size/sha256）
- [ ] 准备生成 `summary-data.json`（业务目标、阶段状态、验证、产物、维护者结论）
- [ ] Git 项目记录 dirty/HEAD/upstream；无 upstream 或仅本地 commit 允许归档，但 `releaseEligible=false`
- [ ] 非 Git 项目生成确定性内容清单与产品树散列，并记录 `sourceControl=none`
- [ ] 最终产品身份来自 Submit 收据或当前内容；提交前候选只允许在验证输入未变化时由 `certify-local` 自动重绑定
- [ ] **test/review 报告状态确认**：
  - ✅ `.harness/changes/<change-name>/tests/test-report-*.md` 存在 → 归档正常
  - 🟡 不存在 → 必须在 archive-meta.md 和 summary-data.json 中标记「跳过测试」或「未运行测试」，不得伪造通过率
  - ✅ `.harness/changes/<change-name>/reports/review/review-report-*.md` 存在（旧路径 `reviews/review-report-*.md` 兼容回退）→ 作为 📝ADVISORY 归档材料
  - 📝 `.harness/changes/<change-name>/reports/review/fixback-*.md` 存在 → 随 review 报告一并归档；默认 advisory，除非 `strict-review-gate=true`
  - 🟡 不存在但 `logs/execution-log.md` 有 harness-review 小节 → **review 已运行但未落盘**（harness-review `context:fork` 交接缝常见，见 `agent/case-candidates/2026-06-30-harness-review-forked-not-persisting-report.md`）：从 execution-log/会话补落盘到 `reports/review/review-report-YYYYMMDD-HHmm.md` 再归档，**不得误标"未运行 review"**（实际跑过）
  - 🟡 不存在且 execution-log 无 review 小节 → 在 archive-meta.md 和 summary-data.json 中标记「📝ADVISORY：未运行 review」

## 归档后验证（Phase 4）

- [ ] `.harness/archive/YYYY-MM-DD-<change-name>/` 目录存在（通过 Glob 实际扫描确认）
- [ ] 所有子目录（plans/, tests/, reviews/, sqls/）已完整移入（通过 Glob 实际扫描确认，不仅看预期路径）
- [ ] before/after manifest 校验通过（排除 `logs/execution-log.md`——归档追加结束记录预期 sha256 变化；其他 moved 文件 sha256 必须一致，missing/mismatch=0）
- [ ] archive-meta.md 由 finalize 自动生成且字段完整；调用者未手写或补改
- [ ] summary-data.json 已生成，且为合法 JSON
- [ ] **summary-data.json 真实性检查**：
  - 无测试报告时，`summary-data.json.verification.unitTests.status` / `summary-data.json.verification.apiTests.status` 必须标记为 `NOT_RUN`、`USER_SKIPPED`、`BLOCKED` 或 `STATIC_ONLY`，不得显示 100%
  - 无 review 报告时，`summary-data.json.reviewSummary.status` 必须标记为 `ADVISORY_NOT_RUN`，不得显示 100%
  - 跳过、复用、人工确认的部分必须明确标记，不伪装成 ✅
- [ ] 原目录 `.harness/changes/<change-name>/` 已删除（仅在前面所有验证通过后）
- [ ] .harness/ 下无残留未归档变更目录
