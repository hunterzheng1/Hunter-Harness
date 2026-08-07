## P0 执行可信度规则

- 命令结果不得靠猜测；普通 Bash 被拒 → 立即改用等价 PowerShell 重试一次
- 仅 PowerShell 成功且有明确证据（构建/git/测试输出、文件存在、exit 0）时可标 ✅OK；否则 ❌FAIL 或 🟡WARN
- 禁止把 hook 拒绝、静态验证、无输出、用户跳过说成成功 → 详见 [[../protocols/powershell-protocol.md|powershell-protocol]]、[[../protocols/evidence-based-reporting-protocol.md|evidence-based-reporting-protocol]]

## 生成内容语言约定

- sync/ingest 等生成的文档、规则、知识条目、架构说明一律**优先使用中文**撰写（标识符、命令、代码、API 字段名保持原文）
- 面向平台展示的标题/摘要/正文默认中文；仅当用户明确要求或目标系统强制时才用英文
