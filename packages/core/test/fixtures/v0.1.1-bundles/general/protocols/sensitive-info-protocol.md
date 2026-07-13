---
description: harness 全流程的敏感信息脱敏协议。所有 skill 的输出（控制台、execution-log、报告、commit message、final-summary）按本协议脱敏，禁止明文 token/密码/密钥。由原 harness-plan/sensitive-info.md 迁移。
---

# Sensitive Info Protocol

> 本协议适用于所有 harness-skills 的输出（控制台、execution-log.md、package-report、review-report、final-summary.html、commit message）。

## 1. 禁止明文输出的信息类型

以下信息**不得以明文形式出现在任何输出中**：

| 类型 | 示例 |
|------|------|
| Token / JWT | `eyJhbGciOi...`、`access_token=xxx` |
| Authorization header | `Authorization: Bearer xxx` |
| Cookie | `Cookie: session_id=xxx` |
| 缓存凭证（如 Redis 密码） | `redis.password=xxx` |
| 数据库凭证 | `jdbc:mysql://...?password=xxx` |
| API key | `api_key=xxx`、`X-API-Key: xxx` |
| Access key / Secret key | `accessKeyId=xxx`、`secretAccessKey=xxx` |
| Jasypt 加密密钥 | `jasypt.encryptor.password=xxx` |
| SSO 登录凭据 | `admin / admin123`（仅在开发环境说明中可用占位符） |
| 任何含 `password`、`secret`、`token`、`key` 的字段值 | — |

## 2. 脱敏替换规则

如果用户贴出了敏感信息，后续引用时必须替换为以下占位符：

| 原始内容 | 替换为 |
|----------|--------|
| Token 值 | `<TOKEN_REDACTED>` |
| 密码值 | `<PASSWORD_REDACTED>` |
| 密钥值 | `<SECRET_REDACTED>` |
| API key 值 | `<API_KEY_REDACTED>` |
| Authorization header 值 | `<AUTH_HEADER_REDACTED>` |
| Cookie 值 | `<COOKIE_REDACTED>` |

> 示例：
> - 原始：`Authorization: Bearer eyJhbGciOiJIUzI1NiIs...`
> - 替换：`Authorization: Bearer <TOKEN_REDACTED>`

## 3. 禁止写入持久化文件

以下文件中**不得包含任何明文敏感信息**：

| 文件类型 | 路径示例 |
|----------|----------|
| 执行日志 | `.harness/changes/<change-name>/logs/execution-log.md` |
| 审查报告 | `.harness/changes/<change-name>/reports/review/review-report-*.md` |
| 测试报告 | `.harness/changes/<change-name>/reports/test/test-report-*.md` |
| 最终总结 | `.harness/archive/YYYY-MM-DD-<change-name>/reports/final/final-summary.html` |
| 归档元数据 | `.harness/archive/YYYY-MM-DD-<change-name>/meta/archive-meta.md` |
| Commit message | git log 中的提交信息 |

## 4. 命令示例使用占位符

如需要给命令示例，使用占位符，不要复述真实值：

```text
# ❌ 禁止：复述真实 token
curl -H "Authorization: Bearer eyJhbGciOi..." http://localhost:8083/api/...

# ✅ 正确：使用占位符
curl -H "Authorization: Bearer <TOKEN_REDACTED>" http://localhost:8083/api/...
```

```yaml
# ❌ 禁止：复述真实密码
spring:
  datasource:
    password: MySecretPass123

# ✅ 正确：使用占位符
spring:
  datasource:
    password: <PASSWORD_REDACTED>
```

## 5. 开发环境凭据的特殊处理

项目默认凭据（如 `admin / admin123`）仅在以下场景允许出现：

- 开发环境配置说明中（标注"仅供开发环境使用"）
- 环境检查报告中的状态描述（标注"⚠️ 使用默认开发凭据"）

但**不得出现在**：
- execution-log.md
- commit message
- API 测试报告的持久化记录中

> 对于 API 测试中获取的 token，在测试执行过程中可临时使用（如 Playwright 请求），但测试报告中必须用 `<TOKEN_REDACTED>` 替换。
