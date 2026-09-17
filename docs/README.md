# docs 目录索引

本目录集中存放 Hunter-Harness 的**调研报告、决策记录与实施路线合同**。
运行时代码、契约 schema、协议文档不在此处（分别在 `packages/`、`harness/contracts/`、
`harness/protocols/`）。

## 分类结构

| 目录 | 定位 | 内容 |
|---|---|---|
| `research/` | 调研与分析报告（advisory，非合同） | 流程评估、精简分析等带日期的研究报告；其中建议须经 roadmap 流程立项后才成为合同 |
| `decisions/` | 决策记录（ADR / 变更决策） | 架构决策（0001–0004 编号 ADR）与版本破坏性变更的逐条决策（日期前缀）；只增不改，状态翻转用新记录 |
| `roadmap/` | 统一优化实施路线（**合同**） | 见 `roadmap/README.md`；内部再分 `stages/`（01–14 阶段文档）、`proposals/`（提案与任务书）、`issues/`（未关闭问题登记）、`batches/`（批次实施材料与试点数据）、`archive/`（已关闭问题） |

## 文档管理约定

- **纳入 Git 跟踪**：`.gitignore` 以 `docs/*` 默认忽略、按白名单放行；新增子目录或根级
  文件时必须同步更新白名单（此前 `docs/decisions/` 与 `docs/adr/` 曾长期未被跟踪，
  2026-09-17 重组时修复）。
- **链接即契约**：移动或重命名文档后，必须同步修复仓内全部 `docs/...` 引用（含代码注释、
  skill 文档）；跨目录引用一律用仓根相对路径（`docs/roadmap/...`），同目录或近邻可用
  相对链接。
- **CHANGELOG 为例外**：`CHANGELOG.md` 中的 `docs/...` 引用是发布时点的历史记录，路径
  随时间漂移属预期，不回改。
- **roadmap 一致性门禁**：`roadmap/` 下文档的状态/锚点变更须保持与 `roadmap/README.md`
  索引一致（详见该 README 文末的文档一致性门禁条款）。

## 2026-09-17 重组说明

- 新增 `research/`：接收调研报告（`2026-09-17-harness-flow-review.md`）与原根级
  `simplification-analysis-2026-09.md`。
- `adr/` 并入 `decisions/`（同为决策记录，消除双目录）；两组命名（编号 ADR、日期决策）均保留。
- `harness-improvement-roadmap/` 更名为 `roadmap/`，内部按 `stages/ proposals/ issues/
  batches/ archive/` 分类；全部交叉引用与代码注释已同步修复。
- 无文档被删除：经逐项评估，批次试点原始数据（`batches/*/collected|tasks`）是基线结论的
  唯一证据、冻结提案是治理记录、dogfood 记录是关闭凭证，均有保留价值。
