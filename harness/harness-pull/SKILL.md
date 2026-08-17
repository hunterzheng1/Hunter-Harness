---
name: harness-pull
description: "从 Hunter Platform 下拉配置/规则/架构/指令（及显式来源分支的分支文件恢复）。仅当用户显式调用 /harness-pull 或明确说'从平台拉取/恢复'时使用；不得自动触发。"
disable-model-invocation: true
argument-hint: "[--scope config|rules|architecture|instructions] [--scope branch_files --branch <来源分支>]"
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

# harness-pull — 从 Hunter Platform 下拉与恢复

## Purpose

从 Hunter Platform 下拉远端配置、规则、架构和指令，或按显式来源分支恢复分支受管文件。本 skill 只负责理解意图、展示预览和收集确认；冲突判断、哈希校验与本地事务由 CLI/core 完成。

## When to Use

仅当用户显式调用 `/harness-pull`（或明确说"从平台拉取/恢复"）时执行。日常刷新元数据请走 `harness-sync`，不是本 skill。

## 前置条件

- 远端同步已配置：优先读环境变量 `HUNTER_REMOTE_SYNC_URL`、`HUNTER_REMOTE_SYNC_TOKEN`、`HUNTER_REMOTE_SYNC_ACTOR_ID`；缺失字段回退到 `hunter-harness connect` 写入的 `.harness/credentials.local.yaml`（含 actor_id；旧绑定缺该字段时 CLI 经 key-info 自动补全并写回）。两者都缺时 CLI 固定 fail closed（`PUSH_PULL_CLI_UNAVAILABLE`）。
- 分支文件恢复必须显式 `--scope branch_files --branch <来源分支>`；归档不出现在常规下拉范围（单个归档 ZIP 经 Platform 变更记录单独下载）。

## 交互流程

1. **选择范围**：常规范围 `config` / `rules` / `architecture` / `instructions`；分支恢复单独显式声明来源分支。
2. **展示预览**：来源版本、提交、缺失文件与冲突；默认只读预览，未经确认不写入本地。
3. **冲突决策**：本地有修改时逐项展示差异与决策（`keep-local` / `accept-remote` / `skip`）；不得因关闭扫描直接覆盖本地有意修改。删除恢复只允许 `accept-remote` 并绑定 preview hash 与来源。
4. **报告结果**：应用、跳过、冲突遗留分列；冲突未决项保持本地原样。

## 命令

```powershell
npx hunter-harness harness-pull --scope config,rules --json
npx hunter-harness harness-pull --scope branch_files --branch main --json
```

## 关键规则

| 规则 | 要点 |
|------|------|
| 只读默认 | 未确认的预览不得写本地；`--dry-run` 不产生任何写入 |
| 本地修改保护 | 有本地修改时必须显示差异与决策，不静默覆盖 |
| 删除恢复 | 只接受 `accept-remote`，并绑定 preview hash、artifact、version 与来源分支 |
| 归档边界 | 归档不属于常规下拉；需要历史归档时提示用户走 Platform 变更记录下载 |

<!-- @include shared/p0-trust.md -->
> 片段：[[shared/p0-trust.md|p0-trust]]
