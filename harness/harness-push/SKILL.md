---
name: harness-push
description: "上传本地配置/规则/架构/指令（及显式归档）到 Hunter Platform。仅当用户显式调用 /harness-push 或明确说'上传到平台'时使用；不得因存在本地修改就自动触发。"
disable-model-invocation: true
argument-hint: "[--scope config|rules|architecture|instructions|branch_files|all] [--scope archive --change <change-key>] [--allow-sensitive]"
effort: medium
allowed-tools: [Read, Glob, Grep, Edit, Write, Bash(powershell.exe:*)]
disallowed-tools:
  - Bash(git *)
  - Bash(mvn *)
  - Bash(ls *)
  - Bash(find *)
  - Bash(grep *)
  - Bash(cat *)
  - Bash(cp *)
  - Bash(mv *)
  - Bash(rm *)
  - Bash(mkdir *)
  - Bash(touch *)
  - Bash(sed *)
  - Bash(awk *)
  - Bash(curl *)
---

# harness-push — 上传到 Hunter Platform

## Purpose

把本地受管内容（配置、规则、架构、指令，及显式选择的归档包）上传到 Hunter Platform。本 skill 只负责理解意图、展示预览和收集确认；三方 diff、敏感扫描、幂等与本地事务由 CLI/core 完成，不得绕过命令手工拼接上传。

## When to Use

仅当用户显式调用 `/harness-push`（或明确说"上传到 Hunter Platform"）时执行。用户只是修改了配置/规则/指令时，**不得**自动建议上传。

## 前置条件

- 远端同步已配置：优先读环境变量 `HUNTER_REMOTE_SYNC_URL`、`HUNTER_REMOTE_SYNC_TOKEN`、`HUNTER_REMOTE_SYNC_ACTOR_ID`；缺失字段回退到 `hunter-harness connect` 写入的 `.harness/credentials.local.yaml`（含 actor_id；旧绑定缺该字段时 CLI 经 key-info 自动补全并写回）。两者都缺时 CLI 固定 fail closed（`PUSH_PULL_CLI_UNAVAILABLE`），**不得**改用旧 HTTP fallback 或手工 API 调用。
- 归档有两条互斥入口，先判断走哪条，**不要**自己找目录或拼 ZIP：
  - **待发布包**（刚归档完、上传失败还没成功）：`--scope archive --change <key>` 消费 outbox claim。claim 记录在 `.harness/state/local/archive-outbox/`，ZIP 在 `.harness/state/local/archive-packages/`——不存在 `.harness/outbox` 这个目录。
  - **补传已封存归档**（上传早已成功、包被清理，或归档由旧版本产生从未入 outbox）：走 `harness_archive.py republish`（见下）。上传成功后 ZIP 与回执按设计会被删除，所以"没有可复用包"是常态而非故障。
- 两条入口都**不得**在 Push 内隐式补做 finalize/重建归档目录。

## 交互流程

1. **选择范围**：`config` / `rules` / `architecture` / `instructions` / `all`，或显式归档 `--scope archive --change <change-key>`。归档必须显式，避免误传历史包或无法确定目标 Change。
2. **展示预览**：分支、提交、远端基线和实际变化文件；无变化时直接结束，不创建空版本。
3. **用户确认**：敏感命中默认只打印不阻断（策略 `warn`），照常走正常确认流程；把 `HUNTER_HARNESS_SENSITIVE_SCAN` 设成 `block` 后，可覆盖项才需要显式确认（high 命中在该模式下不可逐条覆盖）。确认只对本次 preview 有效。
4. **按内容分类报告**：成功、跳过、冲突和可重试项分开列出；冲突只投影机器决策，可附 `--resolve <path=keep-local|accept-remote|skip>` 逐项选择。

## 命令

```powershell
npx hunter-harness harness-push --scope config,rules --json
# 待发布包（有 outbox claim 时）
npx hunter-harness harness-push --scope archive --change <change-key> --json
# 补传已封存归档：重建确定性包并上传（--dry-run 只看包内容）
python <skills-root>/scripts/harness_archive.py republish --change <change-key> --json
```

`<skills-root>` 是已部署 skills 的根目录，实际形态是 `.codebuddy/skills/`（`.claude`、`.cursor`、
`.codex` 同理）。**脚本在它下面的 `scripts/` 里共享，不在 `harness-push/scripts/`** —— 已有四份
执行日志先猜成后者、报 `No such file` 再回头找。

`--scope archive` 没有待发布 claim 时返回 `PUSH_PULL_ARCHIVE_NO_PENDING_CLAIM`（exit 5），
stderr 里直接给出上面的 republish 命令；`--dry-run` 会列出本地可补传的归档目录，不取租约。
`republish` 在项目根内任意目录直接跑即可，**不需要** `--project`。

**补传能做什么、不能做什么**：服务端对同一 change key 只保存**一个不可变包**。所以补传只适用于
「从未成功上传」与「字节完全一致的重试」两种情况。若该 change 已是 durable，`republish` 会读
`.harness/state/local/archive-packages/<key>.remote.json` 在**本地就判定**并返回：
字节一致 → `ARCHIVE_ALREADY_PUBLISHED`（exit 0，不重传）；字节不同 →
`ARCHIVE_REMOTE_IMMUTABLE_CONFLICT`（exit 1，**不发起上传**）。
**已发布的归档无法从客户端补上知识条目**——注入 `candidates/knowledge.json` 必然改变字节，
服务端拒绝替换。要让旧归档产生知识条目，需要平台侧提供重新索引或归档版本化能力。
只想重试**同一个包**（例如知识索引失败）时加 `--no-knowledge-injection`，它按封存目录原样重建，字节与已存包一致。

## 关键规则

| 规则 | 要点 |
|------|------|
| 无变化不上传 | 预览无变化时返回 `no_changes`，不创建确认、不调用执行入口 |
| 敏感与凭据 | 不做内容遮盖；路径白名单、凭据文件排除、哈希校验保持启用。扫描默认 `warn`：命中项按 `路径:行 规则(严重度)` 打印后照常上传。`HUNTER_HARNESS_SENSITIVE_SCAN=block` 恢复阻断，`=off` 完全关闭。阻断态下可覆盖项加 `--allow-sensitive`（非交互需配合 `--yes`，原因用 `--sensitive-reason`）；high 命中在 block 态仍不可逐条覆盖，要放行就改策略 |
| 归档边界 | 归档不进普通范围；`--scope archive` 必须带 `--change`；只消费已有 outbox claim，补传走 `harness_archive.py republish` |
| 知识条目 | 平台的知识条目只从归档包的 `candidates/knowledge.json` 产生。`--scope all` 把归档文档当 branch_file 上传，**不进**知识管道——要让页面出现条目必须走归档包 |
| 失败语义 | `PUSH_PULL_RECEIPT_INVALID`/远端未确认 = 未上传，不得宣称成功；可重试项标注后交还用户 |

<!-- @include shared/p0-trust.md -->
> 片段：[[shared/p0-trust.md|p0-trust]]
