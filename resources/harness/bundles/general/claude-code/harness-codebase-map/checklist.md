# harness-codebase-map 检查清单

## 执行前检查

| 检查项 | 必须 | 说明 |
|---|:---:|---|
| 当前目录是项目根或已给出项目路径 | 是 | 需要能定位源码、配置和 `.harness/` |
| 参数已解析 | 是 | 识别 full / fast / focus / paths / status / diff |
| `--paths` 已做安全校验 | 条件 | 拒绝 `..`、绝对路径、shell 元字符 |
| 已读取 `.harness/project.yaml` | 否 | 不存在时 profile 记为 unknown |
| 已读取 `.harness/context-index.json` | 否 | 不存在时可创建最小结构 |
| 已检查旧 map 状态 | 是 | 判断首次、缺失、过期、部分刷新 |
| 已确认输出路径为 `.harness/codebase/map/` | 是 | 禁止 `.planning/codebase/` |
| 已确认不执行 Git 写操作 | 是 | 禁止 add/commit/pull/merge/push/reset/checkout/rebase/clean；只允许 status / diff --name-only / rev-parse |

## 参数模式检查

| 模式 | 需要生成/检查 |
|---|---|
| `--status` | 只检查 map 完整性、manifest、summary、stale 状态 |
| `--diff` | 对比 manifest 与当前代码状态，输出可能过期范围 |
| full / `--refresh` | 生成或刷新 7 个文档 |
| `--fast` | 默认刷新 `STACK.md`、`STRUCTURE.md`、`CONCERNS.md` |
| `--focus tech` | `STACK.md`、`INTEGRATIONS.md` |
| `--focus arch` | `ARCHITECTURE.md`、`STRUCTURE.md` |
| `--focus quality` | `CONVENTIONS.md`、`TESTING.md` |
| `--focus concerns` | `CONCERNS.md` |
| `--paths` | 只扫描合法 repo-relative 路径，仍按 focus 决定输出文档 |

## 输出文件检查

全量模式必须存在：

```text
.harness/codebase/map/STACK.md
.harness/codebase/map/INTEGRATIONS.md
.harness/codebase/map/ARCHITECTURE.md
.harness/codebase/map/STRUCTURE.md
.harness/codebase/map/CONVENTIONS.md
.harness/codebase/map/TESTING.md
.harness/codebase/map/CONCERNS.md
.harness/codebase/map-summary.md
.harness/codebase/map-manifest.json
```

模板目录必须包含：

```text
templates/STACK.md
templates/INTEGRATIONS.md
templates/ARCHITECTURE.md
templates/STRUCTURE.md
templates/CONVENTIONS.md
templates/TESTING.md
templates/CONCERNS.md
templates/map-summary.md
templates/map-manifest.schema.json
```

局部刷新模式中，未刷新文件如果已存在，可以保留；如果不存在，必须在报告中标记 WARN。

## 文档质量检查

每个生成文档必须满足：

- 有 YAML frontmatter。
- 标明 `generator: harness-codebase-map`。
- 标明 `file_kind: generated_reviewable`。
- 包含实际文件路径，路径使用反引号包裹。
- 不包含明文 token、password、secret、Authorization、Cookie、API key。
- 不把猜测写成事实；不确定内容用“推测 / 待验证”。
- 至少包含 “Analysis Date” 或 “Mapped At”。

## Manifest 检查

`map-manifest.json` 必须包含：

- `generator`
- `generated_at`
- `mode`
- `profile`
- `last_mapped_commit`
- `path_scope`
- `documents[]`
- 每个文档的 `path` / `document_type` / `sha256` / `line_count`
- `warnings[]`

## Context Index 检查

如果 `.harness/context-index.json` 存在：

- 必须保留未知字段。
- 只更新 `codebase.map` 相关字段。
- 不得覆盖 rules、knowledge、skills 其他索引。

如果不存在：

- 可创建最小结构。
- 报告中标记 `context-index: created-minimal`。

## 失败判定

以下情况必须标记 `❌FAIL`：

- 无法写入 `.harness/codebase/map/`。
- 全量模式下 7 个文档未全部生成，且不是用户明确选择局部模式。
- manifest 无法生成或 JSON 不可读。
- 写入后的文件无法 Read 验证。

以下情况标记 `🟡WARN`：

- Agent 工具不可用，降级为顺序扫描。
- 部分路径非法，被剔除。
- 无法获取 git commit，使用 `unknown`。
- context-index 不存在并创建了最小结构。
- 局部刷新导致部分文档仍缺失。
- 检测到可能敏感信息并已脱敏。

## 结束前必检

- [ ] 输出目录是 `.harness/codebase/map/`。
- [ ] 没有创建 `.planning/`。
- [ ] 没有修改 `.codegraph/`。
- [ ] 没有执行 Git 写操作。
- [ ] 所有写入文件已通过 Read 或文件存在检查验证。
- [ ] 最终回复中列出生成文件、行数、状态和 warnings。
