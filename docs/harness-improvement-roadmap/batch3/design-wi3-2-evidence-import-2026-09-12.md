# WI-3.2 设计：外部证据导入——宿主 CI 验证证据的校验式落账

> 日期：2026-09-12
>
> 状态：**已实施并收尾（2026-09-12）**。本文是
> `design-evidence-driven-delivery-2026-09-09.md` §2 WI-3 子项 2 的展开。
> §0 五项建议值全部采纳，按 §4 顺序实施；六步全部完成（实施记录见 §7），
> 试点复验 8/8 门槛通过。

## 0. 待裁决项

| # | 问题 | 建议 | 理由 |
|---|---|---|---|
| 1 | 导入入口形态 | **独立子命令 `harness_ledger.py import-ci-evidence`** | 语义与手工 `record` 分离：record 是「执行者自证」，import 是「外部凭证核验」，校验链完全不同；混入 record 会让两条信任路径共享一个入口，fail-closed 语义难表达 |
| 2 | 收据获取方式 | **CI 生成 JSON 收据 + upload-artifact，本地离线导入** | 离线、无网络/gh CLI 依赖、可离线测试；`gh run view` 在线查询引入网络与认证依赖，且拿不到 tree hash 与步骤级摘要的稳定结构 |
| 3 | 代码版本匹配口径 | **收据 `headTree` 与本地 `product_tree_hash()` 严格相等** | 提案 §4.6：「HEAD 相同不足以证明工作区相同」——tree hash 是内容身份；commit SHA 相同但工作区脏时 tree 不同，必须拒绝 |
| 4 | 可导入的 verification 集合 | **仅 `compile` 与 `unitTestFull`（全量类）** | CI 跑的是全仓库检查（`npm run check`/`npm test` 全量），增量 `unitTest` 的 scope 语义无法从 CI 收据建立；apiTest 需要环境状态，提案明示「代码相同不保证外部服务状态相同」 |
| 5 | 宿主执行（非 CI）证据是否纳入 | **不纳入，沿用 `record`** | 宿主本地执行与 record 的信任模型相同（执行者自证）；本项只补「外部来源」的缺口，避免重复建设 |

## 1. 背景与输入

- 提案 §4.6：「宿主执行或 CI 证据可以导入，导入必须校验**来源、代码版本和
  完整性**，不能接受模型口述『已通过』。」
- 主设计文档 §2 WI-3 子项 2：P14 决策维持不接入（can-reuse 封存）；本项只做
  「跨 change 的同类验证证据导入」。
- 现状缺口（勘察，基线 `802e1fd`）：
  - `record` 的 `evidence` 字段只是路径字符串，无来源校验——模型口述
    「已通过」+ 随手填路径即可落账，正是提案要堵的口子。
  - CI（`.github/workflows/check.yml`）跑 `npm run check` / `npm test` 全量，
    但无证据产物产出，跑完即丢。
  - `register_evidence`（harness_fixback.py:1408）只服务 change 内 fixback
    证据（kind ∈ red/green/verification/review），不覆盖外部来源。

## 2. 现状勘察

| 组件 | 现状 | 与本项的关系 |
|---|---|---|
| `harness_ledger.record` | 手工记账，v2 条目身份字段齐全（inputsHash/inputsFiles/toolchainHash…），但 evidence 无来源核验 | 导入条目复用其 v2 字段契约，使 gate close 无需改动 |
| `decide_can_reuse` | 封存（P14，2026-09-08） | 不接入；导入是落账，不是复用判定 |
| `harness_fixback.invalidate_affected_evidence` | 按 `inputsFiles` 交集失效条目 | imported 条目需新增 tree 绑定失效分支（§3.3） |
| `validate_ledger_for_phase_close` | required validations 须为 v2 完整条目；identity_mismatch 时步骤④已细化报错 | 无需改动；imported 条目失效后自然走 `EVIDENCE_INVALIDATED` |
| `.github/workflows/check.yml` | 4 jobs（check-linux/test-windows×2/package-smoke/node22-compat），无 artifact | 需加收据生成 + 上传步骤（§4 步骤④） |

## 3. 设计

### 3.1 CI 证据收据（`ci-evidence-receipt.json`）

CI workflow 末尾步骤生成并上传 artifact，字段：

```json
{
  "schemaVersion": 1,
  "repository": "github.com/<owner>/<repo>",
  "runId": 1234567890,
  "runAttempt": 1,
  "workflow": "check",
  "runUrl": "https://github.com/.../actions/runs/...",
  "headSha": "<commit sha>",
  "headTree": "sha256:<git rev-parse HEAD^{tree}>",
  "toolchain": {"node": "24.x.y"},
  "conclusion": "success",
  "jobs": [
    {"name": "check-linux", "conclusion": "success",
     "steps": [{"name": "Run full check", "conclusion": "success",
                "command": "npm run check"}]}
  ],
  "concludedAt": "2026-09-12T00:00:00Z",
  "receiptHash": "sha256:<除本字段外全部字段的规范化 JSON sha256>"
}
```

- `receiptHash`：完整性校验（防传输损坏与事后手改；篡改需仓库写权限，
  威胁模型内可接受，不做签名）。
- `headTree` 由 CI 侧 `git rev-parse HEAD^{tree}` 生成——代码版本三要素之一。
- `repository` 为 `host/owner/repo` 小写归一化形式（`GITHUB_SERVER_URL` 的
  host + `GITHUB_REPOSITORY`），与 `harness_paths._normalize_remote` 口径一致；
  GHES 场景由 `GITHUB_SERVER_URL` 自动推导 host。

### 3.2 导入命令与校验链（fail-closed）

`harness_ledger.py import-ci-evidence --receipt <path> --verification <name>
--job <ciJobName> --step <ciStepName> [--project <root>]`

校验链任一失败即拒绝，错误信封带 `field_path` 与 `recoveryAction`（F3 教训）：

1. 收据 schema 完整 + `receiptHash` 重算一致（**完整性**；哈希失配独立
   错误码 `RECEIPT_HASH_MISMATCH`）。
2. 收据 `conclusion == "success"` 且目标 job/step `conclusion == "success"`
   （**结果真实性**）。
3. `headTree == product_tree_hash(project_root)`（**代码版本**，裁决项 3）。
4. `repository == _normalize_remote(本地 origin remote)`（**来源**）。
5. `--verification ∈ {compile, unitTestFull}`（裁决项 4）。

注：`toolchain.node` 仅作收据自证信息，不做本地强制比对——CI 与本地
Node 版本差异不影响「CI 在该 tree 上验证通过」这一事实，强制比对会
无谓拒绝合法证据。

落账：`ledger.validations[verification]` 写 v2 完整条目，附加：

```json
{
  "imported": true,
  "importedFrom": {"importVersion": "ci-import-v1", "repository": "...",
                    "runId": "...", "runAttempt": 1, "runUrl": "...",
                    "headSha": "...", "headTree": "...", "job": "...",
                    "step": "...", "concludedAt": "...",
                    "supersededRunId": "(可选，被覆盖 run 的 runId)"},
  "inputsHash": "<headTree>",
  "inputsFiles": [],
  "coverage": "full",
  "algorithmVersion": "harness-ledger-2",
  "command": "<CI 命令>",
  "evidence": "<收据路径>",
  "status": "OK"
}
```

- `inputsFiles: []` + `imported: true` 组合表达「tree 绑定」（§3.3）；
  v2 校验对 unitTestFull 的 `inputsFiles` 非空要求需放行该组合
  （`imported` 条目以 `inputsHash`=tree 为身份，文件级闭包由 tree 蕴含）。
- 重复导入：同 `runId` 幂等覆盖；不同 `runId` 覆盖旧条目并在
  `importedFrom.supersededRunId` 记录被覆盖者。

### 3.3 fixback 失效语义：tree 绑定

`invalidate_affected_evidence.affected()` 新增分支：`entry.imported is True`
时，`changed_files` 非空即失效（CI 证据绑定整个 tree，任何产品变更都使
「CI 跑的是旧代码」）。失效条目带标准 `invalidation` 标志，close 时走
步骤④的 `EVIDENCE_INVALIDATED` 精准报错。

### 3.4 gate close：零改动

imported 条目满足 v2 字段契约，现有校验直接适用；identity_mismatch 与
失效路径均已被既有机制覆盖。

### 3.5 边界

- 不接入 can-reuse（P14 封存不变）。
- 不做宿主执行证据导入（裁决项 5）。
- 不做收据签名（威胁模型：篡改需仓库写权限）。
- CI 侧改动仅限本仓库 check.yml 加一个生成/上传步骤，不改验证内容。

## 4. 实施步骤（TDD，红测先行）

| # | 内容 | 交付 |
|---|---|---|
| ① | 收据 schema + 校验器纯函数（`_validate_ci_receipt`） | 红测→绿 |
| ② | `import-ci-evidence` 命令 + 落账 + 幂等/覆盖语义 | 红测→绿 |
| ③ | fixback `affected()` imported 分支 | 红测→绿 |
| ④ | check.yml 加收据生成 + upload-artifact 步骤 | workflow diff |
| ⑤ | testing-reference / SKILL 文档补导入语义 | docs |
| ⑥ | 试点复验：伪造/合法收据全路径走查（§5 门槛） | 记录回写本文 §7 |

## 5. 试点门槛

| # | 门槛 |
|---|---|
| G1 | 合法收据导入成功，ledger 条目 v2 完整 + importedFrom 齐全 |
| G2 | `conclusion != success` 拒绝 |
| G3 | `headTree` 与本地 tree 不匹配拒绝 |
| G4 | `repository` 与本地 origin 不匹配拒绝 |
| G5 | `receiptHash` 篡改拒绝 |
| G6 | 导入后 gate close 通过（required validation 被满足） |
| G7 | fixback 后 imported 条目失效，close 报 `EVIDENCE_INVALIDATED` |
| G8 | `--verification unitTest`（增量类）导入被拒 |

## 6. 风险与回滚

- 收据字段与 GitHub Actions 实际输出结构的偏差：步骤④落地时以真实
  workflow 调试为准；`steps[].command` 若不可得则省略（非校验字段）。
- 回滚：不导入即无影响；已导入条目可被 fixback 正常失效，无状态迁移。

## 7. 实施记录（2026-09-12）

| 步骤 | 交付 | 结果 |
|---|---|---|
| ①② | `CiEvidenceImportTests` 6 红测 → `_load_ci_evidence_receipt` + `_validate_ci_evidence_receipt` + `cmd_import_ci_evidence` + `import-ci-evidence` 子命令注册 | 6/6 绿（哈希失配独立错误码 `RECEIPT_HASH_MISMATCH`） |
| ③ | fixback `affected()` imported 分支（tree 绑定：`imported is True` 且 changed_files 非空即失效）+ gate 侧 `inputsFiles(non-empty)` 放行 imported 组合 | fixback 36/36、gate 140/140 绿 |
| ④ | `scripts/ci/generate-evidence-receipt.mjs` + check.yml 两个 job 的生成/上传步骤 | Node 侧 deepSort 对齐 Python `sort_keys`；repository 归一化对齐 `_normalize_remote`（host/owner/repo 小写） |
| ⑤⑥ | ledger-protocol §11 + testing-reference + 本文 §3 修订回写 | 端到端走查通过 |

端到端复验（模拟 `GITHUB_*` 环境变量 → 生成收据 → 导入 → 落账检查）：

- 合法收据导入成功，split-v1 契约落账至
  `.harness/state/changes/<id>/evidence/verification-ledger.json`，
  `importedFrom`/`verificationTargets`/`supersededRunId` 齐全（G1）。
- 语义校验链六个拒绝路径逐一验证（G2-G5、G8，含本地无 remote 场景）。
- 端到端中发现的真 bug 均已修复：Node 生成器浅排序（仅顶层键）导致哈希
  失配；repository 归一化口径不一致（`owner/repo` vs `host/owner/repo`）。
- 回归：ledger + fixback 138/138、gate 140/140 全绿。
