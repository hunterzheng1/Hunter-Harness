# Hunter Harness 服务器部署与运维

本文件适用于 MVP 的生产/预生产部署。服务端技术栈为 Node.js 24 + Fastify + PostgreSQL；Web Console 为 Next.js；artifact 默认保存在本地持久卷，接口可后续替换为 S3/MinIO。Yao 不参与本部署和 MVP 验收。

## 1. 部署拓扑

```text
CLI / Browser
    │ HTTPS
    ▼
TLS reverse proxy / load balancer
    ├── /api/v1/* ──> hunter-harness-server:3001
    └── /*         ──> hunter-harness-web:3000
                           │ same-origin API rewrite
server ── PostgreSQL
server ── persistent artifact volume
```

公网入口必须是 HTTPS。Node 容器可以在受信任私网内使用 HTTP，但不得直接暴露 3001。建议首版运行 1 个 server replica；多副本必须为 artifact 使用共享 RWX 存储或实现 S3/MinIO adapter。PostgreSQL advisory lock 已保护跨副本幂等键。

## 2. 前置条件

- Docker Engine 25+ 和 Compose v2，或等价的 Kubernetes/托管容器平台。
- PostgreSQL 17（最低 15）。
- TLS 证书和可解析域名。
- 两个独立的高熵 secret：PostgreSQL 密码、bootstrap API token。
- artifact 与数据库备份目标；二者不得与运行卷共用故障域。

当前 Web 锁定 `next@16.3.0-canary.59`，原因是 2026-06-20 时 stable 16.2.9 自带已知漏洞的 PostCSS；该 canary 使用修复后的 PostCSS 8.5.10。Next 发布包含相同修复的 stable 后，应切回 stable，并完整执行本文第 11 节验收。

## 3. Compose 首次部署

从 [.env.example](../.env.example) 创建非敏感配置。不要把 token 或密码放入 `.env`。

```bash
mkdir -p secrets
openssl rand -base64 36 > secrets/postgres_password.txt
openssl rand -base64 48 > secrets/bootstrap_token.txt
chmod 600 secrets/*.txt
docker compose build --pull
docker compose up -d
docker compose ps
```

`server` 启动时在 PostgreSQL advisory lock 下按文件名顺序执行 `apps/server/migrations/*.sql`。migration 必须可重复执行；任一 migration 失败时 server 不开始监听。

Compose 仅把 Web 的 `${WEB_PORT:-3000}` 暴露到宿主机。生产环境应将该端口只绑定给 TLS reverse proxy 或内部负载均衡器。API 由 Next same-origin rewrite 转发到 server。

## 4. 必需配置与 secrets

### Server

| 变量 | 含义 |
|---|---|
| `DATABASE_URL` / `DATABASE_URL_FILE` | PostgreSQL DSN；二选一，file 优先用于 secret mount |
| `DATABASE_SSL=require` | 直连托管数据库时启用证书校验 |
| `ARTIFACT_ROOT` | 持久 artifact 根目录，默认 `/var/lib/hunter-harness/artifacts` |
| `HOST`, `PORT` | 监听地址和端口，容器默认 `0.0.0.0:3001` |
| `HUNTER_HARNESS_BOOTSTRAP_TOKEN` / `_FILE` | 首个 owner token；只在 bootstrap/rotation 窗口挂载 |
| `HUNTER_HARNESS_BOOTSTRAP_ACTOR` | owner actor ID |
| `HUNTER_HARNESS_BOOTSTRAP_NAME` | owner 显示名 |

原始 token 不写数据库；数据库只保存带域分隔的 SHA-256 token hash。bootstrap token 会在每次挂载时保持可用，因此首次登录验证后应从长期运行配置移除该 secret，并用受控发布流程管理后续 token。普通日志、审计、错误体和 Web 页面不得输出 token。

### Web

| 变量 | 含义 |
|---|---|
| `HUNTER_HARNESS_INTERNAL_API_URL` | Next same-origin rewrite 的内部 server URL |
| `NEXT_PUBLIC_HUNTER_HARNESS_API_URL` | 可选的公网 API 根；同域部署保持空值 |

浏览器 token 只保存在当前 tab 的 `sessionStorage`，关闭 tab 后消失。生产 Content Security Policy 应至少限制 `default-src 'self'`、`connect-src 'self'`，并由反向代理加入 HSTS、`X-Content-Type-Options: nosniff` 和合适的 `frame-ancestors`。

## 5. TLS 反向代理

Nginx 的最小关键配置如下；证书路径按环境替换：

```nginx
server {
  listen 443 ssl http2;
  server_name harness.example.com;
  ssl_certificate     /etc/letsencrypt/live/harness/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/harness/privkey.pem;

  add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
  add_header X-Content-Type-Options nosniff always;
  client_max_body_size 52m;

  location / {
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto https;
    proxy_pass http://127.0.0.1:3000;
  }
}
```

若代理直接拆分 `/api/v1/` 到 3001，也必须保持原始 method、`Authorization`、`Idempotency-Key`、`X-Request-Id`、`Content-Range`、`Range` 和完整响应头。不要把 `Authorization` 写入 access log。

## 6. 首次验证与客户端绑定

```bash
curl -fsS https://harness.example.com/
docker compose exec server node -e "fetch('http://127.0.0.1:3001/health').then(async r=>{console.log(await r.text());if(!r.ok)process.exit(1)})"
```

实际生产建议由负载均衡器对 server 的 `/health` 做内部探测，不必把该路径暴露公网。随后：

```bash
export HUNTER_HARNESS_TOKEN="$(cat /secure/bootstrap_token.txt)"
npx hunter-harness --adapter claude-code --profile java --non-interactive --yes
npx hunter-harness push \
  --server-url https://harness.example.com \
  --token-env HUNTER_HARNESS_TOKEN \
  --non-interactive --yes --json
```

在 Web Console 人工 approve 后执行：

```bash
npx hunter-harness update \
  --server-url https://harness.example.com \
  --token-env HUNTER_HARNESS_TOKEN \
  --non-interactive --yes --json
```

验证 push 只生成 proposal、baseline 未推进；approve 产生 append-only audit event 和 artifact；update 校验 hash 后推进逐文件 baseline。

## 7. 数据、容量与保留

- 默认单文件上限 10 MiB、单 proposal 50 MiB、chunk 4 MiB。
- proposal session 默认保留 24 小时；过期 session 可清理临时 chunk，但不得删除已引用 content-addressed blob。
- proposal、review、audit、project version 和 artifact manifest 位于 PostgreSQL。
- blob 正文位于 artifact volume；manifest 的 SHA-256 是恢复后一致性检查依据。
- 审计表通过数据库 trigger 禁止 `UPDATE`/`DELETE`；数据库超级用户仍应仅授予受控运维流程。
- MVP 不实现 artifact 数字签名；HTTPS、token、SHA-256、敏感扫描和审计为强制边界。

保留策略应根据法规配置。建议 proposal/review/audit 至少保留 180 天，已发布 artifact 保留至所有关联 project version 退役且备份窗口结束。删除必须先验证无 proposal/version/baseline 引用，并写独立运维审计。

## 8. 备份与恢复

### 一致性备份

1. 暂停 Review approve/finalize 写流量，健康检查保持读取可用。
2. 记录当前镜像 digest、migration commit 和 UTC 时间。
3. 执行 PostgreSQL custom-format 备份：

   ```bash
   pg_dump --format=custom --no-owner --file hunter-harness.dump "$DATABASE_URL"
   ```

4. 对 artifact volume 做同一时间窗的文件系统 snapshot/只读归档。
5. 保存 dump 与 artifact snapshot 的 SHA-256 清单到独立备份系统。
6. 恢复写流量。

只备份数据库或只备份 blob 都不是可恢复备份。

### 恢复演练

1. 新建空 PostgreSQL 数据库和空 artifact volume。
2. 用相同或兼容镜像启动一次 migration。
3. `pg_restore --clean --if-exists --no-owner --dbname "$RESTORE_DATABASE_URL" hunter-harness.dump`。
4. 恢复 artifact snapshot，修正只允许容器用户读写的权限。
5. 随机抽取 artifact manifest，重新计算每个 blob SHA-256。
6. 启动 server/Web，验证 project、proposal、audit、artifact history 和 update download。
7. 恢复环境不得复用生产 token；演练后销毁。

至少每季度执行一次可计时的恢复演练，并记录 RPO/RTO。

## 9. 可观测性与告警

- `/health` 仅证明进程存活；平台还应对 PostgreSQL 建立独立 readiness 检查。
- 收集 JSON stdout/stderr，按 `request_id` 关联 CLI、proxy 和 server；日志平台必须再次执行 secret redaction。
- 告警：5xx 比例、401 激增、409 version conflict、422 sensitive/hash mismatch、proposal session 过期、磁盘使用率、PostgreSQL 连接/锁等待、备份失败。
- 监控 artifact volume inode/容量；达到 70% 告警、85% 阻止大 proposal，避免磁盘满导致 finalize/update 失败。
- 不采集 artifact 原文、Authorization header、token、完整本机路径或敏感命中正文。

## 10. 升级与回滚

### 升级

1. 阅读 migration 和 API v1 兼容性变更，先备份数据库+artifact。
2. 在预生产使用备份副本执行 migration、`npm run check`、PostgreSQL integration 和 E2E。
3. 按 digest 构建镜像；不要部署浮动 `latest`。
4. 先部署 server，再部署 Web；运行 health、resolve、proposal dry-run、Review 和 update smoke。
5. 观察错误率、锁等待和 artifact hash 告警，再结束变更窗口。

API v1 不允许破坏性原地变更；破坏性协议必须发布 `/api/v2`。

### 回滚

- 仅代码回滚：切回上一个镜像 digest；前提是旧代码兼容已执行 migration。
- 不兼容 schema：停止写入，恢复升级前数据库与 artifact 的一致性备份，再启动旧镜像。
- 禁止只回滚数据库而保留新 artifact volume，或反之。
- 客户端 update 失败使用本地事务恢复菜单；服务端回滚不得修改客户端工作文件或 baseline。

## 11. 发布验收命令

```bash
npm ci
npm run lint
npm run typecheck
npm test
npm run build
npm audit --audit-level=moderate
docker compose config
```

有可用 PostgreSQL 时必须额外执行：

```bash
export HUNTER_HARNESS_TEST_DATABASE_URL=postgresql://...
npm run test:postgres -w apps/server
```

验收还应检查：只有三个公开 npx 命令；token 不落盘；未批准 proposal 无 artifact；owner 自审产生不可变 audit；tombstone、dirty skip、断点续传、事务中断恢复和 Claude IR 编译均由测试覆盖。

## 12. 已知部署边界

- Yao 完全退出 MVP；不向 Yao 发送源码、Knowledge、proposal 或 token。
- 默认 local filesystem storage 适合单 server replica；S3/MinIO adapter 是扩展点，不是当前实现。
- 数字签名、团队 reviewer 强制分离、向量库和多租户计费不在 MVP。
- PostgreSQL integration 测试需要真实数据库；没有 Docker daemon/本地 PostgreSQL 的开发机只会跳过该 profile，不能以跳过结果代替发布环境验证。
