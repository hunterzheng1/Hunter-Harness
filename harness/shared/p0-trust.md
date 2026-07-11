## P0 执行可信度规则

- 命令结果不得靠猜测；普通 Bash 被拒 → 立即改用等价 PowerShell 重试一次
- 仅 PowerShell 成功且有明确证据（构建/git/测试输出、文件存在、exit 0）时可标 ✅OK；否则 ❌FAIL 或 🟡WARN
- 禁止把 hook 拒绝、静态验证、无输出、用户跳过说成成功 → 详见 [[../protocols/powershell-protocol.md|powershell-protocol]]、[[../protocols/evidence-based-reporting-protocol.md|evidence-based-reporting-protocol]]
