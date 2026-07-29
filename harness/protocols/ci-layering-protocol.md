# CI 分层与构建产物复用协议

所有项目将远端验证拆成四层，触发条件和产物身份必须彼此独立：

| 层 | 默认触发 | 工作内容 |
|---|---|---|
| `fast` | push / pull request | 影响选择后的格式、合同和单元门禁；分钟级反馈 |
| `candidate` | 冻结产品 identity 后手动触发 | 完整测试、真实栈、安全扫描、SBOM；每个 identity 最多一次 |
| `evidence-only` | 证据路径变化或候选证据续跑 | 校验 schema、hash、identity；禁止重新构建产品镜像 |
| `release` | 已通过候选的受控发布 | 校验既有 artifact/digest，附加发布标签并部署；禁止再次构建 |

## 必需控制

- 同分支同层启用 concurrency cancellation，取消过时运行；
- `candidate` 构建的镜像和制品以提交、产品树和环境 identity 命名并记录 digest；
- 产品路径冻结后，候选通过前不得夹带证据提交；候选通过后只允许 evidence-only 路径变化；
- 未知路径或影响图无法证明边界时扩大验证，不能缩小；
- Linux、Docker、shell 权限等行为先在受控 Linux 环境运行 canary；
- 发布层只消费候选产物，不执行源码构建；
- runner minutes、缓存命中和关键路径耗时写入周期报告，以实际基线评价优化。

项目可用自身 CI 语法实现该协议，但层名、身份和收据语义保持一致。
