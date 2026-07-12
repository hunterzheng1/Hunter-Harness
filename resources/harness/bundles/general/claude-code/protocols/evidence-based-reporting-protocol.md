---
description: harness 全流程的证据化报告协议。所有 skill 输出必须区分 ✅真实成功 / 🟡静态验证或跳过 / ❌失败或被拒绝。由原 harness-plan/evidence-based-reporting.md 迁移。
---

# Evidence-Based Reporting Protocol

> 本协议适用于所有 harness-skills 的最终输出。禁止把"静态验证"写成"测试通过"，禁止把"命令被拒绝"写成"成功"。

## 状态分类

所有 skill 的最终输出必须使用以下三类状态标记：

| 标记 | 含义 | 使用场景 |
|:----:|------|----------|
| ✅ | **已真实执行并成功** | 有构建成功证据（Java=`BUILD SUCCESS`；前端/Python 按各自工具成功标志） / git 成功信息 / 文件实际存在 / exit code 0 等明确证据 |
| 🟡 | **静态验证 / 用户确认跳过 / 证据不足** | 1. TDD 降级：仅做静态逻辑验证，未执行真实单元测试<br>2. 用户明确跳过 test/review<br>3. 命令执行但证据不充分<br>4. 需部署后验证的场景 |
| ❌ | **执行失败 / 被 hook 拒绝 / 未验证** | 1. 命令被 hook 拒绝（Denied / PreToolUse:Bash hook error）<br>2. exit code 非 0<br>3. 输出无有效 stdout<br>4. 场景未覆盖且未验证 |

## 禁止的表述

| 禁止表述 | 正确表述 | 原因 |
|----------|----------|------|
| "测试全部通过" | 🟡 静态逻辑验证通过，未执行真实单元测试 | TDD 降级时没有真实测试 |
| "编译成功" | ❌ 编译命令被 hook 拒绝 | 命令没有成功执行 |
| "打包成功" | ❌ 打包命令输出不包含构建成功证据 | 没有明确证据 |
| "拉取成功" | ❌ git pull 命令被 Denied | 命令被 hook 拦截 |
| "推送成功" | ❌ git push 返回非 0 exit code | 推送实际失败 |
| "覆盖率 100%" | 🟡 静态验证覆盖率 100%，未运行真实测试 | 覆盖率来源不实 |

## 编译验证状态映射

| 构建工具输出 | 状态标记 |
|-----------|:--------:|
| 包含构建成功证据（Java=`BUILD SUCCESS`；前端/Python 按各自工具成功标志） | ✅ 编译成功 |
| 包含构建失败标志（Java=`BUILD FAILURE`；前端/Python 按各自工具失败标志） | ❌ 编译失败 |
| 命令被 hook 拒绝 | ❌ 编译命令被拒绝 |
| 无输出 / 超时 | ❌ 编译状态未知 |
| 仅部分模块编译（跳过无关模块） | ✅ 目标模块编译成功 |

## 测试验证状态映射

| 情况 | 状态标记 | 报告表述 |
|------|:--------:|----------|
| 测试命令输出包含测试通过证据（Java=`Tests run: N, Failures: 0`；前端/Python 按各自工具） | ✅ | ✅ 已测试通过：N 个用例，0 失败 |
| TDD 降级（无测试基础设施） | 🟡 | 🟡 静态验证通过，未执行真实单元测试，待测试基础设施补齐后运行 harness-test |
| 测试命令被 hook 拒绝 | ❌ | ❌ 测试命令被拒绝，无法确认测试结果 |
| 测试失败（有 Failures > 0） | ❌ | ❌ 测试失败：N 个用例，M 个失败 |
| 用户确认跳过测试 | 🟡 | 🟡 用户确认跳过测试 |

## 场景覆盖状态映射

| 情况 | 状态标记 |
|------|:--------:|
| 有对应测试方法且测试通过 | ✅ 已测试通过 |
| 代码逻辑已覆盖但未执行测试 | 🟡 静态验证通过，未真实测试 |
| 代码逻辑未覆盖 | ❌ 未覆盖 |
| 需要端到端部署验证 | 🟡 待部署后验证 |
| 用户确认跳过 | 🟡 用户确认跳过 |

## Git 操作状态映射

| git 输出 | 状态标记 |
|----------|:--------:|
| `Already up to date.` 或实际更新记录 | ✅ 拉取成功 |
| `Denied: non-ASCII path in Bash` | ❌ 命令被 hook 拒绝 |
| `To <remote>` + 推送范围 | ✅ 推送成功 |
| 无输出 | ❌ 状态未知 |

## final-summary.html / summary-data.json 状态映射

final-summary.html 默认由 `summary-data.json + render-summary.mjs` 渲染；旧占位符模板仅作 legacy reference。

归档前必须执行 `harness_archive.py finalize` 内嵌 validate，或 `harness_archive.py replay` 等价校验。只有 validate 无 error 时，才能宣称 final-summary 与 summary-data 一致；validate error 不得被写成 WARN 或"已完成"。

| 数据来源 | 无报告时 |
|----------|----------|
| `summary-data.validations.unit/api` | 标记 `NOT_RUN` / `STATIC_ONLY`，不得显示 100% |
| `summary-data.review` | 标记 `ADVISORY_NOT_RUN`，不得显示 100% |
| `summary-data.package` | 缺失时标记 `WARN`，不得伪造 package 成功 |
| `summary-data.stageStatus` | 必须真实展示 ✅OK / 🟡WARN / 🔁REUSED / 📝ADVISORY 等状态 |

## 执行日志状态标注

所有 skill 的 execution-log.md 中，结果字段必须使用以下格式：

```markdown
- **结果**: ✅OK成功 / 🟡WARN(降级原因) / ❌FAIL(失败原因)
```

禁止使用模糊表述如"OK"、"成功"、"完成"，必须包含状态标记和具体原因。

## 两维度术语表

本协议的状态标记与 review 的发现严重级是**两个独立维度**，不得混用。下表统一登记各态的边界与关系，避免散落未对齐。

### 维度一：skill 执行状态三态

任何 skill 的最终执行结果必须落到以下三态之一：

| 标记 | 含义 | 适用场景 |
|:----:|------|----------|
| ✅OK | 已真实执行并成功 | 有构建成功证据 / git 成功信息 / 文件实际存在 / exit code 0 等明确证据 |
| 🟡WARN(原因) | 静态验证 / 用户确认跳过 / 证据不足 / 降级 | TDD 降级仅静态验证、用户跳过 test/review、命令执行但证据不充分、需部署后验证、远端有新提交需 pull/rebase、用户选择仅本地 commit |
| ❌FAIL(原因) | 执行失败 / 被 hook 拒绝 / 未验证 | 命令被 hook 拒绝、exit code 非 0、输出无有效 stdout、push 失败/被拒绝、commit 失败、hook 拒绝、场景未覆盖且未验证 |

### 维度二：review 发现严重级（审查发现维度，不等于 skill 执行状态）

harness-review 对代码/变更的审查发现按风险分级，反映的是**被审查对象的问题严重度**，而非 review 这个 skill 本身是否执行成功：

| 标记 | 含义 | 适用场景 |
|:----:|------|----------|
| RED | 高风险建议 | 存在安全/数据/契约级高风险问题，建议阻塞合并 |
| YELLOW | 中低风险 | 存在中低风险改进项，建议处理但不阻塞 |
| OK | 无问题 | 审查通过，未发现需处理项 |

> 注意：review skill 执行成功（✅OK）不等于发现严重级为 OK；review 发现 RED 时，review skill 本身仍可能是 ✅OK（执行成功并产出了 RED 发现）。

### 条件态 / 跳过态（特殊最终状态）

以下状态用于特定条件下的最终状态表达，不属于上述两个主维度的常规三态：

| 标记 | 含义 | 适用场景 |
|:----:|------|----------|
| CONDITIONAL_OK | 条件性通过 | API 测试 `USER_SKIPPED` 或 DB 兼容性 `BLOCKED_BY_DBA` 时的归档最终状态，不得写纯 OK，必须在 knownRisks/manualActions 说明风险接受与后续人工动作 |
| 🔁REUSED | 复用前阶段结果 | 复用了前一阶段验证结果，final-summary 必须显式标记，不得伪装成重新执行 |
| 📝ADVISORY | 参考性未运行 | review 参考性意见，未作为门禁执行 |
| ⏭️ | 用户选择跳过 | 用户主动选择跳过某步骤（如仅本地 commit 不 push、跳过 test/review） |

### 两维度关系

- skill 执行状态回答"这个步骤跑没跑、成没成"；
- review 发现严重级回答"被审查的东西有没有问题、问题多大"；
- 条件态/跳过态回答"这个步骤的最终结论是什么特殊情况"。
- 三者独立：例如 test skill 可 ✅OK 执行成功，但 review 发现其覆盖的代码存在 RED 问题；又如 archive 可因 `USER_SKIPPED` 给出 CONDITIONAL_OK，同时 review 发现为 YELLOW。final-summary 必须分别展示，不得用一个维度覆盖另一个。
