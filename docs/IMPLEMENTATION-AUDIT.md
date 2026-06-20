# Hunter Harness MVP 实现审计

审计基线：`feat/local-mvp`。本文件记录实现证据，不替代 `requirements/hunter-harness-complete-dev/` 中的规范包。

## 自动验收入口

```bash
npm ci
npm run check
npm audit --audit-level=moderate
docker compose config --quiet
```

`npm run check` 强制执行 ESLint、TypeScript、Vitest、Next.js 生产构建和实际 npm tarball 安装烟测。可用 PostgreSQL 时还必须执行：

```bash
export HUNTER_HARNESS_TEST_DATABASE_URL=postgresql://...
npm run test:postgres -w apps/server
```

## 锁定设计逐项证据

| # | 验收项 | 状态 | 实现与测试证据 |
|---:|---|---|---|
| 1 | 仅三个公开 npx 命令 | 通过 | `packages/cli/src/bin.ts` 只注册默认初始化、`push`、`update`；CLI 测试和 package smoke 覆盖。事务恢复位于默认菜单，不增加公开命令。 |
| 2 | push/update 协议闭环 | 通过 | `packages/contracts/src/protocol.ts`、`packages/core/src/push.ts`、`packages/core/src/update.ts`；协议、push、update、E2E 测试覆盖幂等、分块、tombstone、dirty skip。 |
| 3 | 互斥文件策略矩阵 | 通过 | `packages/contracts/src/file-policy.ts` 和 `packages/core/src/file-policy.ts` 使用 `file_kind + policy`；策略测试覆盖所有要求路径。 |
| 4 | state 四分区 | 通过 | 初始化创建 `baseline/transactions/locks/local`；只有协议/事务层写内部状态。 |
| 5 | cache/server-artifacts | 通过 | update 缓存经 SHA-256 校验，可删除重建，永不 push。 |
| 6 | codebase map 可完整 push | 通过 | classified 为 `generated_reviewable`、`full-diff-proposal`、`skip-if-local-dirty`。 |
| 7 | `.codegraph/**` 外部不托管 | 通过 | classified 为 `external_unmanaged`，push/update 均 `never`；文件安全测试覆盖。 |
| 8 | `.claude/rules/**` working copy | 通过 | 初始化生成本地规则，push 生成 diff proposal，update dirty 时跳过。 |
| 9 | 默认不生成 `.harness/rules/` | 通过 | 初始化和 E2E 断言目录不存在。 |
| 10 | 服务端 canonical rules 模型 | 通过 | proposal/artifact 使用平台无关 manifest path；本地 adapter 映射到 Claude working copy，不改变服务端模型。 |
| 11 | 本地 harness Skill 可修改 | 通过 | `.claude/skills/harness-*/**` 为 `user_editable`，变更进入 proposal。 |
| 12 | dirty skill/rule 默认跳过 | 通过 | update 测试及 E2E 验证 eligible 文件应用、dirty 文件保留并返回冲突退出码。 |
| 13 | project-local knowledge 默认不 push | 通过 | 文件策略与 proposal builder 双重排除，只有显式确认才可进入 preview。 |
| 14 | CodeGraph 只初始化检查 | 通过 | 初始化 feature check 只提示、不安装；push/update 不管理 `.codegraph/`。 |
| 15 | Superpowers 只初始化检查 | 通过 | 缺失不阻塞、不自动安装，push/update 无后续接管。 |
| 16 | GSD 迁移为 `harness-codebase-map` | 通过 | bootstrap Skill IR 编译真实 Claude adapter，输出 `.harness/codebase/map/`，不携带 `.planning` 路径。 |
| 17 | Java 迁移无旧路径/自动 Git | 通过 | bootstrap IR 不含 `.javadev`；`harness-submit` 仅生成建议、消息和清单，真实 Git 需用户显式确认。 |
| 18 | 删除 env Skills | 通过 | bootstrap manifest 不含 `harness-env`/`javadev-env`。 |
| 19 | Skill IR 与 Claude adapter 闭环 | 通过 | `packages/contracts/src/skill-ir.ts`、`packages/core/src/skill-compiler.ts`；初始化真实编译全部 bootstrap IR 到 `SKILL.md`，package smoke 从发布 tarball 验证。 |
| 20 | CLI 自动化 flags/退出码 | 通过 | 三个命令共享 `--dry-run --yes --json --server-url --token-env --non-interactive`；初始化另有 `--adapter --profile --config`，稳定退出码有契约和测试。 |
| 21 | 服务端安全模型 | 通过 | Bearer token、HTTPS 客户端约束、owner 校验、append-only audit、限额、SHA-256、敏感扫描、拒绝风险文件均有实现/测试。 |
| 22 | 事务和回滚可执行 | 通过 | atomic temp-write/rename、journal、before/after、lock、恢复/回滚/清理菜单；中断和部分失败测试覆盖。 |
| 23 | 参考资产 provenance/SHA-256 | 通过（发布阻断保留） | 规范包含 `references/SOURCE-PROVENANCE.md` 与 `SHA256SUMS.txt`；未知上游 license/commit 不阻塞本地开发，但必须阻断对外再分发。 |
| 24 | Yao 退出 MVP | 通过 | CLI、server、Web 无 Yao 调用；仅规范保留未来 Review Gate 接口边界。 |
| 25 | 完整工程规格和实施资产 | 通过 | 规范包、contracts/core/CLI/server/Web、OpenAPI、migration、部署、E2E、审计齐全。 |

## 端到端闭环

`tests/e2e/harness.e2e.test.ts` 在单个场景内验证：离线初始化 → 首次 push 自动注册/绑定 → 分块上传/finalize → owner 自审并记录 audit → approved artifact update → 服务端生成混合 artifact → dirty rule 跳过且 knowledge 应用 → 默认菜单回滚上次 update。

`scripts/smoke-pack.mjs` 验证真实发布 tarball：安装后 dry-run 不落盘，真实初始化从包内 Skill IR 生成 `.claude/skills/harness-review/SKILL.md`。

## 需在有基础设施的发布环境完成

- 本机无 Docker daemon 和 PostgreSQL，无法执行镜像构建/启动及真实 PostgreSQL integration profile；Compose schema 已验证，内存 repository 的 HTTP/E2E 已通过。
- 对外发布前必须补齐参考资产的 upstream commit/tag、license、允许引用和再分发范围。
- 当前 Web 暂锁定安全修复后的 Next.js canary；有包含同等修复的 stable 后应切回 stable 并重跑全部验收。
