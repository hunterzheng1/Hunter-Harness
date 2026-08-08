---
name: harness-knowledge-query
description: "在规划、实现或排查前，通过 hunter-harness CLI 查询远端项目知识库。远端不可用时直接报告不可用，不建立本地索引或离线回退。"
argument-hint: "<需求或问题原文> [--limit <n>]"
effort: low
allowed-tools: [Bash(powershell.exe:*), Read, Glob, Grep]
disallowed-tools:
  - Bash(git *)
  - Bash(curl *)
---

# harness-knowledge-query

项目知识以 Hunter Platform 的服务端索引为唯一真源。客户端只提交查询并消费结果：

- 不创建或读取 `.harness/knowledge`；
- 不运行本地 Python ingest、SQLite、FTS 或 context-pack 脚本；
- 不在网络或服务不可用时回退到本地归档；
- 查询失败只记录“本轮无远端知识”，后续工作必须依靠当前代码和用户提供的信息。

所有面向人的总结默认使用中文，代码标识符和原始路径保持原样。

## Triggers

- query knowledge / knowledge query
- 查询历史需求、决策或实现经验
- 结合之前做过的内容
- 规划或排查前读取项目知识

## Command

在项目根目录执行一次：

```powershell
powershell.exe -Command "npx hunter-harness knowledge query '<用户需求原文>' --limit 10 --json"
```

只允许通过 CLI 访问平台，不得直接拼接 HTTP 请求，也不得调用旧的
本地知识查询脚本（该脚本已从当前分发包移除）。

## Workflow

1. 原样保留用户的需求或问题作为查询文本；已知范围较大时可将关键模块名一并放入文本。
2. 执行一次远端查询，不在查询前重建或同步知识。
3. 读取 JSON 中的命中项、来源路径、变更键和相关度。
4. 把命中内容作为历史线索；涉及当前行为时仍以当前代码和验证结果为准。
5. 若命令返回远端不可达、未绑定或未认证，记录明确 issue 后继续，不重试本地方案。

## Output Contract

必须说明：

- 查询文本与 limit；
- 是否成功访问远端；
- 命中数量及最相关来源；
- 远端不可用时，明确写“未使用本地回退”；
- 下一步是进入规划/实现，还是先核对当前代码。

## Forbidden Actions

- create_local_knowledge_index
- query_local_sqlite_or_archive_as_fallback
- generate_local_context_pack
- retry_with_legacy_python_knowledge_script
- treat_remote_history_as_current_code_fact
- copy_secrets_into_query

<!-- @include shared/p0-trust.md -->
> 片段：[[shared/p0-trust.md|p0-trust]] · 远端查询成功必须有 CLI JSON 证据；失败不得伪装为已读取历史

<!-- @include shared/logging.md -->
> 片段：[[shared/logging.md|logging]] · phase=`knowledge-query` · 成功记录命中摘要，失败记录远端错误码且不做本地回退
