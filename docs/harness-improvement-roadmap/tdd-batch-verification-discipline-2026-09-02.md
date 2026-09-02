# Issue：TDD 执行效率——coding-reference 应固化「批量验证纪律」（先冒烟编译再合并测试）

> 日期：2026-09-02
> 来源：sales-insight-agent `agentscope-channel` execute 阶段复盘（76 分钟，其中 ~32 分钟为可避免的修复循环）
> 严重度：P1（效率问题，不影响正确性；同类问题在多个 change 的 execute 阶段反复出现）
> 状态：OPEN

## 背景

`harness-execute` 的 `coding-reference.md` 已有「批量构建验证策略」章节（"每个变更簇最多一次 RED 构建测试、一次 GREEN 构建测试……不得每新增一个测试类就立即单独跑一次"），但实际执行中该纪律频繁滑坡：

### 复盘数据（agentscope-channel，2026-09-02）

| 环节 | 耗时 | 性质 |
|---|---|---|
| 代码+测试编写（6 主类 + 6 测试类） | ~25 分钟 | 合理工作量 |
| SDK 契约探查（javap 反编译） | ~10 分钟 | 合理（必要前置） |
| **编译错误修复循环** | **~20 分钟** | **可避免** |
| **mock 设计返工**（BodyPublisher 不可回读 + 断言残留，改 4 轮） | **~12 分钟** | **可避免** |

### 滑坡模式

1. **逐类验证**：agent 每写一个类就跑一次完整 `mvn test`（冷启动 30~60s），6 个测试类跑了 8+ 轮
2. **跳过冒烟编译**：新类写完直接跑 test，Shim 签名错误、import 缺失、类型转换错误等**编译期错误**每轮要等完整 mvn 周期才能看到下一个（一次只暴露一个错）
3. **mock 设计反模式**：试图从 `HttpRequest.BodyPublisher` 回读 body 字节（Java 不可回读），运行时才发现，多轮修复

## 建议修复：coding-reference.md 批量构建章节增补三条

```markdown
### 冒烟编译前置（新增）

新增多个类时的强制顺序：
1. 全部类写完 → 先跑 `mvn -f backend test-compile`（冒烟编译，<10s，一次暴露全部编译错误）
2. 修完所有编译错（每轮只看编译输出，快）
3. 编译全绿后 → 合并跑一次 `mvn -f backend test -Dtest=...`

禁止：每写一个类就跑完整 test；跳过冒烟编译直接 test。

### Mock 设计约束（新增）

- 不可回读的流（`BodyPublisher` / `InputStream` / 已消费的 request body）不得作为 mock 断言来源
- 正确模式：把请求体构造提为**静态方法**（如 `buildBody`）单独单测；HTTP 层 mock 只断言 URL（含 query）、header、状态码
- 响应 mock 用薄 shim 类（非 java.net.http.HttpResponse 子类化）

### 断言修改自检（新增）

修改测试断言字符串后，grep 确认旧断言已删除（字符串替换的转义不匹配会导致旧断言残留，
靠测试报错行号逐轮排查平均多耗 2~3 轮 mvn 周期）。
```

## 为什么放 skill 而不是记忆库/AGENTS.md

- AGENTS.md / 记忆库是**会话级防线**（依赖 agent 当次读到并遵守）；skill 协议是**流程级防线**（每次 `/harness-execute` 自动生效，对所有 agent 工具一致）
- 已同步在项目 AGENTS.md 与记忆库做了会话级兜底（`工作流/java-http-mock-bodypublisher模式.md`），但根修应在 skill

## 复现/验证方式

任选一个含 3+ 新类的新 change，观察执行日志中的 mvn 调用次数：滑坡时单次 execute 出现 8+ 次 `mvn test`（正常应 ≤ 3 次：1 冒烟编译 + 1 RED/GREEN 合并 + 1 全量）。
