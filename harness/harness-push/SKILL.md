---
name: harness-push
description: "上传本地配置/规则/架构/指令（及显式归档）到 Hunter Platform。仅当用户显式调用 /harness-push 或明确说'上传到平台'时使用；不得因存在本地修改就自动触发。"
disable-model-invocation: true
argument-hint: "[--scope config|rules|architecture|instructions|all] [--scope archive --change <change-key>]"
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
- 归档上传只选择已写入 outbox 的确定性包（阶段 06 产物）；不存在可复用包时提示先完成本地归档，**不得**在 Push 内隐式补做 finalize/重建 ZIP。

## 交互流程

1. **选择范围**：`config` / `rules` / `architecture` / `instructions` / `all`，或显式归档 `--scope archive --change <change-key>`。归档必须显式，避免误传历史包或无法确定目标 Change。
2. **展示预览**：分支、提交、远端基线和实际变化文件；无变化时直接结束，不创建空版本。
3. **用户确认**：可覆盖风险（hard 敏感阻断除外）必须显式确认后才上传；确认只对本次 preview 有效。
4. **按内容分类报告**：成功、跳过、冲突和可重试项分开列出；冲突只投影机器决策，可附 `--resolve <path=keep-local|accept-remote|skip>` 逐项选择。

## 命令

```powershell
npx hunter-harness harness-push --scope config,rules --json
npx hunter-harness harness-push --scope archive --change <change-key> --json
```

## 关键规则

| 规则 | 要点 |
|------|------|
| 无变化不上传 | 预览无变化时返回 `no_changes`，不创建确认、不调用执行入口 |
| 敏感与凭据 | 不做内容遮盖；路径白名单、凭据文件排除、哈希校验保持启用；hard 敏感阻断不得生成确认 |
| 归档边界 | 归档不进普通范围；`--scope archive` 必须带 `--change`；只消费已有 outbox claim |
| 失败语义 | `PUSH_PULL_RECEIPT_INVALID`/远端未确认 = 未上传，不得宣称成功；可重试项标注后交还用户 |

<!-- @include shared/p0-trust.md -->
> 片段：[[shared/p0-trust.md|p0-trust]]
