# 能力感知验证图协议

Build Profile v3 用 `verificationGraph` 取代账本内的固定验证目标清单。项目可以声明后端、前端、浏览器、数据库、性能或发布候选等任意目标，同时保留统一的依赖、覆盖度和证据复用语义。

## 目标合同

每个目标必须声明：

- `commandKey`：指向 `commands` 中的真实命令；
- `dependsOn`：需要先完成的验证目标；
- `requiredCoverage`：`incremental/module-am/module`；
- `candidate`：是否为发布候选门禁；
- `requiredCapabilities`：执行环境必须具备的能力。
- `resourceLocks`：目标独占或共享的数据库、端口、浏览器、容器等资源身份；
- `estimatedDurationSeconds`：供默认串行策略和进度显示使用，不作为虚构 ETA 的依据；
- `reusePolicy`：允许复用时必须匹配的产品、环境、命令与覆盖身份。

`candidateTarget` 必须引用已声明目标。未知目标、未知依赖、循环依赖、命令缺失都 fail closed。

## 选择与执行

1. 从显式请求目标开始；未显式请求时使用 `candidateTarget`。
2. 展开完整依赖闭包并按拓扑顺序执行。
3. 缺失能力不得静默跳过：目标记录 `CAPABILITY_MISSING`，依赖它的目标记录 `DEPENDENCY_BLOCKED`。
4. 未进入闭包的目标是 `omitted`，与“执行失败”或“因能力阻断”分开报告。
5. 账本记录目标定义的规范化 identity；依赖、覆盖度或能力声明变化后，旧证据必须失效。
6. 候选目标即使自身命令可运行，也必须等待所有依赖和能力满足。
7. ready 目标按 `resourceLocks` 分 wave；锁相交的目标不得并行。预计 ≥60 秒且未声明锁的目标默认归入 `harness:unclassified-heavy` 串行队列。
8. code freeze 后产品 identity 漂移必须返回 `FROZEN_IDENTITY_DRIFT`；禁止在旧候选上补跑后声称覆盖新候选。
9. 每个 `RUN / REUSE / SKIP / BLOCKED` 决策都必须带稳定 `reasonCode` 和解释；`REUSE` 还必须绑定现有证据 identity。

JSON 合同见 `contracts/build-profile-v3.schema.json`；通用选择器为 `@hunter-harness/core` 的 `selectVerificationTargets`。
