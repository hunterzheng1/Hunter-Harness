# connect 默认平台地址固定化与密钥信息瘦身决策记录

日期：2026-09-17 决策并实施
状态：已落地（CLI 侧改动，配合 hunter-platform 密钥去 scope）

本文档记录 CLI 侧两条收敛决策。服务端配套（API 密钥去权限范围）见 `hunter-platform/docs/decisions/2026-09-17-project-api-keys-drop-scopes.md`。

## D1 connect 菜单默认平台地址固定为生产地址

- 背景：交互式"连接平台"菜单的地址默认值来自两处：已有凭据的 `server_url` 或 `last-server.json`（最近一次成功连接地址）。新用户首次使用时没有记忆值，提示为空指引不足；记忆机制本身又是一个只被单个读者消费的用户级状态文件，维护价值低。
- 决策：新增常量 `DEFAULT_PLATFORM_URL = "https://harness.hunter-z.com"`，菜单提示与回车兜底恒用该值，与凭据/历史记录解耦；手动输入仍以输入为准。`last-server` 机制（`config/last-server.ts`、connect 成功后的写入调用、测试）整体移除；`resolveUserStateRoot` 因 uninstall 仍在消费，迁往 `config/user-state.ts`。
- 后果：新用户 `npx hunter-harness` → 连接平台直接回车即指向生产平台；用户级状态根语义不变，uninstall 的清理行为不变（历史 last-server.json 残留仍会被 `--global` 清掉）。

## D2 connect 不再展示/透传"权限范围"

- 背景：服务端已把项目 API 密钥从"按 scope 签发"改为"项目级全权限"（platform 侧 ADR 同日期），`/auth/key-info` 不再返回 `scopes` 字段。CLI 摘要里的"权限范围："行与 JSON 输出的 `scopes` 字段随之失去来源。
- 决策：`KeyInfo.scopes` 字段、人类可读本摘要"权限范围："行、JSON summary 的 `scopes` 键全部删除。老版本服务端若仍返回 scopes 字段，zod 宽松解析直接忽略，不报错。
- 后果：connect 成功摘要只剩"已连接 / 凭据类型 / 写入路径"三行；测试断言同步（含清洗用例中针对 scopes 的伪造断言删除）。

## 配套清理

- 全仓测试中的示例地址 `platform.example.test`（含 `env-platform.example.test`）统一替换为 `harness.hunter-z.com`（docs/plans 历史文档除外）。
- 旧版凭据文件（CRLF 行尾）重新绑定路径有回归测试覆盖。

## 验收状态（2026-09-17）

- CLI 受影响测试：connect 9 + project-menu-connect 4 + uninstall 12 全绿
- typecheck 全绿；`npm run release:preflight` 通过
