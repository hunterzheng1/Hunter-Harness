# harness-task reference

错误码表、档位映射与平台陷阱。命令统一形态：
`python <skills-root>/scripts/harness_task.py <subcommand> --project . --change <cn> --json`

## 命令面

```
harness_task.py begin  --project . --change <cn> --executor <tool> \
                      --goal "<目标一句话>" --acceptance "<条件>" (可重复) \
                      [--tier fast|standard] [--write-scope <路径>] (可重复) \
                      [--depends-on <cn>] (可重复) --json
harness_task.py finish --project . --change <cn> [--commit-message <msg>] \
                       [--closure abandoned|superseded --closure-reason <r>] \
                       [--no-commit] --json
harness_task.py status --project . --change <cn> --json
```

- `begin`：建 `.harness/changes/<cn>/`（change-context + state-snapshot +
  task.json + phase.start + decision）。重跑幂等——复用同一 runId。
  `--tier` 声明档位下限（floor）：声明比 finish 裁决高时抬升裁决，
  反之不压低（classify 信号升级仍生效）；`--tier full` 直接拒绝
  （rc=3，不建 change 目录）；改口声明不同档位 → TASK_INPUT_INVALID。
- `begin --write-scope`（WI-3.3）：声明写入范围（仓库相对 POSIX 路径，
  尾斜杠自动剥除；绝对路径/`..`/空路径 → TASK_SCOPE_INVALID）。与其他
  open 任务的声明按**前缀包含**判定相交（相等或一方是另一方父目录）→
  TASK_SCOPE_CONFLICT（rc=2，不建目录，带 conflicts 明细）；既有未声明
  scope 的 open 任务不参与判定，响应 `unscopedOpenChanges` 提示。
- `begin --depends-on`（WI-3.3）：声明依赖的 change id。目标不存在 →
  TASK_DEPENDENCY_MISSING；非 completed（含 abandoned/superseded，不可
  强行 begin）→ TASK_DEPENDENCY_UNMET；沿声明图成环（含自环）→
  TASK_DEPENDENCY_CYCLE（环检测先于状态检查报出）。
- 声明不可改：open 任务重复 begin 带不同 writeScope/dependsOn →
  TASK_SCOPE_REDECLARED（改范围 = 新协调，须 abandon 后重开）；未带参数
  = 不表态（幂等放行）；首次补声明（既有为 null）正常补写。
- `finish` 越界校验：声明 writeScope 的任务，实际产品 diff（含吸纳的
  外来路径）越出声明范围 → TASK_SCOPE_VIOLATION（rc=2，不声明 ownership、
  不提交，改动留工作区）；未声明 scope 的任务行为不变。
- `finish`：classify → 档位裁决 → 验证 → ledger → plan.md → commit →
  归档（record-only）。幂等——验证失败修复后、归档失败处理后都直接重跑。
- `status`：只读恢复视图（档位/声明档位/已记验证/未提交 diff/下一步）。
  跨代际统一视图用 `harness_change.py status --project . --change <cn> --json`
  （批次 2 WI-3，返回 `CHANGE_RECOVERY_VIEW`：轻任务与完整流程同一输出
  结构，含阶段身份/plannedPhases 进度/租约/外来脏路径/nextAction）；
  `harness_task.py status` 保持可用，轻任务场景两者信息等价。

## 档位映射

| 档位 | 触发 | 验证序列 | 回退链 |
|------|------|----------|--------|
| fast | docs-only / no-code-diff（.md/.txt/.rst、docs/） | unitTest | unitTest → unitTestFull |
| standard | 其余全部代码 diff | compile + unitTest + unitTestFull | compile → unitTest → unitTestFull；unitTest → unitTestFull |
| full | auth/security/migration/concurrency/artifact-protocol/shared-state/delete/contract-schema 信号 | **拒绝**（TASK_TIER_UPGRADE_REQUIRED） | — |

- 档位由 finish 从 classify signals 自行裁决（classify 的单调升级只升
  不降，docs-only 不会把默认 standard 降为 fast）。
- **声明档位下限（floor）**：begin `--tier` 写入 task.json
  `declaredTier`（与 finish 裁决的 `tier` 分离）；声明比裁决高时抬升
  裁决（声明 standard + docs-only → 按 standard 记账），反之不压低
  （声明 fast + auth 信号 → 仍拒）。与归档重跑的 recorded_tier 保留
  机制并行，任意顺序组合无冲突。
- **契约文件清单（contract-schema 信号）**：`harness/scripts/` 下
  harness_change/fixback/efficiency/events/ledger/state/archive/gate
  .py 的输出 schema 被跨语言/跨模块消费，变更即升 full。精确路径匹配
  （非子串——纯测试文件如 test_harness_change.py 不触发）。权威来源：
  harness_gate.py `CONTRACT_SCHEMA_PATHS`；文件改名需同步维护。
- 回退后 ledger 记录**真实执行**的验证名（如 unitTestFull），不伪造
  缺失项；build-profile 缺 target 时按回退链找更广覆盖的目标。
- 归档失败重跑时产品树已提交（classify 只见 no-code-diff），档位沿用
  task.json 里上次裁决的记录，不降级。

## 验证计划（P1/P5/P6，变更感知选择）

finish 在执行前先生成验证计划（`_plan_verifications`），摘要项带
`reason` 字段供审计：

| reason | 含义 | ledger 记账 |
|--------|------|-------------|
| fallback | 按回退链解析 build-profile target | verification=resolvedAs，profile-input=resolvedAs |
| doc-contract | docs-only 且变更命中 doc contract 扫描范围（`harness/protocols/*.md`、`harness/harness-*/{SKILL,reference,checklist}.md`）→ unitTest 项替换为 `python -m unittest test_harness_doc_contract`（~1s） | verification=unitTest，显式 files=被改文档 |
| python-targeted | 变更含 `harness/scripts/harness_*.py` 或 `tests/test_*.py` → unitTest 项替换为定向 `python -m unittest <模块...>`（~5s；源→测试映射与 scripts/changed-test-selection.mjs 对齐） | verification=unitTest，显式 files=变更源+测试文件 |
| deduped | 与前项解析到同一 argv（P5）→ 不执行不记账，摘要标 `dedupedFrom` | 无（首个可执行项已覆盖） |

- P5 去重按 resolved argv 元组：三项全落同一 target 时只执行 1 次
  （对照试点 3×240s → 1×240s）。
- compile/unitTestFull 不做定向替换（编译面+全量回归本就该跑全链），
  但受 P5 去重约束。
- docs-only 但不在 doc contract 扫描范围（如根 README.md）→ 保持回退
  （doc contract 覆盖不到，跑了不构成证据）。
- 定向项不用 unitTestFull 的 profile 输入集记账——输入集声称覆盖全部
  harness/scripts/*.py 而实际只测了部分，是假证据；显式 files 路径下
  derive_coverage("unitTest", None)→"incremental" 恰是定向测试的真实
  覆盖语义。

## 错误码表

| code | 含义 | recoveryAction |
|------|------|----------------|
| TASK_INPUT_INVALID | begin 输入缺失/非法（change 名、goal、acceptance） | 按 problems[] 补参重跑 begin |
| TASK_SCOPE_INVALID | `--write-scope` 含绝对路径/`..`/空路径 | 改为仓库相对 POSIX 路径 |
| TASK_SCOPE_REDECLARED | open 任务重复 begin 改口 writeScope/dependsOn | abandon 后以新声明重开（声明不可改） |
| TASK_SCOPE_CONFLICT | 写入范围与其他 open 任务声明相交（前缀包含） | 等冲突方 finish 后重试，或收窄 scope 到不相交 |
| TASK_SCOPE_VIOLATION | finish 实际 diff 越出 begin 声明范围 | 收窄改动；或 abandon 后以更大范围重开 |
| TASK_DEPENDENCY_MISSING | `--depends-on` 目标 change 不存在 | 确认名字或先 begin 依赖任务 |
| TASK_DEPENDENCY_UNMET | 依赖目标非 completed（含 abandoned/superseded） | 等目标完成；abandoned 须重开/替换依赖 |
| TASK_DEPENDENCY_CYCLE | 依赖声明成环（含自环），先于状态检查报出 | 解开环后重试 |
| TASK_NOT_BEGUN | change 缺 meta/task.json | 先运行 begin |
| TASK_ALREADY_FINISHED | 任务已终态（completed/abandoned/superseded） | `status` 查看结果；新任务换 change 名 |
| TASK_TIER_UPGRADE_REQUIRED | diff 触发 full 档信号（rc=3）；begin `--tier full` 也返回（rc=3，field_path=args.tier，不建 change 目录）；手改 task.json declaredTier=full 同样拒绝（field_path=meta/task.json.declaredTier） | 改用 `/harness-plan` 完整流程；change 目录保留可续用 |
| FOREIGN_PATHS_PRESENT | begin 前预存且任务未触碰的脏路径（或 .harness 结构越界） | 移出工作区/提交/stash 后重跑 finish |
| VERIFICATION_TARGET_MISSING | build-profile 未声明验证目标（含回退链） | `harness_preflight.py detect --project . --json` 重新探测 |
| VERIFICATION_FAILED | 验证命令 exit≠0（ledger 已记失败） | 修复后重跑 finish（ledger 覆盖） |
| GIT_COMMIT_FAILED | git add/commit 失败 | 手工检查 git status；或 `--no-commit` 跳过 |
| ARCHIVE_FAILED | 归档被阻断（task.json 已回滚 open） | 按 problems[] 处理后重跑 finish 补归档 |
| TASK_FINISHED_NO_ARCHIVE | `--no-commit` 成功但未提交未归档 | 手工提交后如需归档见 nextAction 命令 |
| POLICY_LOAD_FAILED | workflow-policy.json 加载失败 | 检查 `.harness/config/workflow-policy.json` |
| PROJECT_ROOT_INVALID | 项目未初始化（无 .harness/） | `npx hunter-harness init --profile general` |

错误信封统一带 `code` + `message` + `field_path` + `problems[]` +
`recoveryAction`（精确重跑命令）。

## finish 编排步骤（对照排障）

1. classify（post-run，读脏树 git status）
2. 档位裁决 + 外来脏路径检测（begin 脏树基线 + classify foreignPaths
   双通道；重试时上次验证副作用弄脏的产品树文件按任务工作并入
   ownership，不拒绝——P9）；declaredTier 纵深防御（非法值拒绝）+
   floor 抬升（声明比裁决高时）
3. writeScope 越界校验（WI-3.3：声明 scope 的任务实际产品 diff 越界 →
   TASK_SCOPE_VIOLATION，停止且不提交）；声明 ownership.productPaths
   （classify 的 productPaths + 契约外产品树脏路径）
4. 写 gate-policy（plannedPhases=["task","archive"]）
5. 生成验证计划（P1/P5/P6：doc-contract / python-targeted 定向替换 +
   同 argv 去重；见「验证计划」节）
6. 逐项执行计划并写 ledger（evidence 落 `evidence/<key>-<ts>.log`；
   deduped 项跳过执行与记账）
7. 生成 `plans/<cn>-plan.md`（目标:/风险等级:/## Tasks 契约行）
8. 刷新 state snapshot
9. git add -A + commit（不 push）
10. 写 `logs/execution-log.md`（final pushed hash 行）
11. phase.end + decision
12. task.json 终态 → 归档（record-only；失败回滚 open）
13. 简短摘要（完成内容/验证结果/残余风险/代码位置）

abandoned/superseded 闭包跳过 5-9 的验证与提交要求。

## Windows Git Bash 路径陷阱

- `--goal` 的值以 `/` 开头时（如 `/harness-task 的目标`），Git Bash 的
  MSYS 路径改写会把它变成 `C:/Program Files/Git/harness-task ...`。
  规避：目标不要以 `/` 开头，或用 `MSYS_NO_PATHCONV=1` 前缀执行。
- `--project` 用 `.`（相对）或正斜杠绝对路径；脚本内部已统一处理
  Windows 反斜杠。
- JSON 输出含中文/UTF-8，管道到文件时无 BOM。

## 产物清单（change 目录终态）

`meta/change-context.json`、`meta/state-snapshot.json`、
`meta/gate-policy.json`、`meta/task.json`、`meta/risk-classification.json`、
`events.ndjson`、`evidence/verification-ledger.json`、
`evidence/<verification>-<ts>.log`、`plans/<cn>-plan.md`、
`logs/execution-log.md`。归档移走整个目录到
`.harness/archive/<date>-<cn>/`。
