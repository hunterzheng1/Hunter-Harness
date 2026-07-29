# 外部平台最终一致性协议

用于 CI、镜像仓库、部署控制面、证据回传等异步外部系统。目标是让网络传输、远端业务状态和本地观察新鲜度彼此独立，避免把“请求成功”误判为“业务成功”。

## 统一观察合同

每次观察至少包含：

- `subjectIdentity`：不可变业务对象身份，如提交、镜像 digest、运行 ID 与环境身份的规范化组合；
- `businessState`：`PENDING/RUNNING/SUCCEEDED/FAILED/CANCELLED/UNKNOWN`；
- `observationState`：`PENDING/TERMINAL/UNKNOWN`；
- `freshness`：`FRESH/STALE/UNKNOWN`；
- `retryable`、`reasonCode`、`observedAt`；
- 写操作还应携带稳定 `idempotencyKey`。

JSON 合同见 `contracts/external-platform-observation.schema.json`。

## 收敛规则

1. 只有身份一致、`freshness=FRESH` 且观察到权威终态，才能宣称完成。
2. `TERMINAL + SUCCEEDED` 才是成功；`FAILED/CANCELLED` 必须保留为业务失败，不能被 HTTP 2xx、回调成功或旧缓存覆盖。
3. 仅重试 retryable 的传输失败、陈旧观察或非终态；鉴权、参数、身份不匹配与权威失败不得重试成成功。
4. 重试必须同时受最大次数、总耗时和退避表约束；预算耗尽输出结构化失败收据。
5. 每次轮询继续使用同一 `subjectIdentity`/`idempotencyKey`，身份漂移立即 fail closed。
6. 回调只是触发再次观察的信号，最终结论仍以权威读取接口为准。

通用执行内核为 `@hunter-harness/core` 的 `convergeAuthoritativeState`。
