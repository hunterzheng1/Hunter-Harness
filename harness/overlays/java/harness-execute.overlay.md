<!-- @append-after section:"Workflow 概要" -->

### Java 构建验证（Maven）

- 所有 `mvn`/`git` 经 `powershell.exe -NoProfile -Command`；命令读 `.harness/config/build-profile.json` 的 `commands`（v2，按 profile key resolve；**禁止 hardcode 模块名/端口**）
- 增量编译：`commands.compile`（典型 `mvn compile -pl <module> -o -q`）
- 变更簇 TDD：多测试类合并一次按 `commands.unitTest` resolve（典型 `mvn test -pl <module> -Dtest=A,B,C -o`）；每簇最多一次 RED + 一次 GREEN Maven
- **轻量 run**：默认只 compile；全量 `mvn test` 仅当改了 mapper/sql/权限/controller/公共模块或用户要求 full-run-validation
- **install -am**：仅 worktree 首建或上游模块文件变化时（见 ledger-protocol）；非每次 run 强制
- worktree 中确认 `.mvn/maven.config` 等构建配置存在；缺失时从主目录复制

<!-- @append-after section:"关键规则（硬门禁速查）" -->

### Java TDD / 数据访问补充

| 项 | 规则 |
|----|------|
| **低价值豁免** | ErrorCode 常量、VO/DTO 字段、注释、import 清理、格式化、SQL 脚本、配置模板、文档 — 不单独建测试类；禁止为单个错误码单独跑 Maven |
| **Mapper / LambdaQueryWrapper / SQL** | 纯 Mock 返回值**不得**宣称 DB 验证通过 → 🟡 静态验证，交 harness-execute 真实 DB |
| **行为性新分支** | 正则/条件/分支逻辑变更新增分支须 RED→GREEN；不属于低价值豁免 |
| **ledger** | compile 必写；执行了 test 写 unitTest，否则 `NOT_RUN_BY_RUN`；diffHash 用 `harness_ledger.py diff-hash --change-dir`（见 reference） |
| **陈旧 Java 测试** | `cannot find symbol`/mapper 方法改名/DTO 字段迁移只有在当前接口和批准计划唯一确定替代契约时才允许只改测试；修复后定向 `mvn test -Dtest=<class>`，再跑目标测试并记录 `stale-test-repair` |
| **禁止规避** | 禁止把 `*Test.java` 改成 `.bak`、删除、`@Disabled`/`@Ignore`、Surefire exclude 或以 `-DskipTests` 充当 GREEN |

<!-- @append-after section:"Workflow 概要" -->

### Java 测试环境补充

- **preflight 0.1**：写入 `runtime/preflight.json` 的 `executorPath`/`mvnVersion` 等；Maven 可用性 `mvn -version` exit 0
- **编译门禁**：测试前按 `build-profile.json` 的 `commands.compile`（v2，profile key resolve）；输出须含 `BUILD SUCCESS` 或 exit 0 证据
- **条件 install**：worktree 首建或上游模块变更时按 profile 执行 `commands.install`（非每次强制 `-am`）
- **单元测试**：可复用 ledger unitTest 则跳过；否则 `commands.unitTest`（典型 `mvn test -pl <module>`）；执行模块全量 `commands.unitTestFull` 成功 → 记 `unitTestFull`（scope=module，供 submit 复用）
- **陈旧测试安全修复**：测试编译明确命中已移除/改名 API 且当前代码与批准计划唯一确定新契约时，只修测试并定向重跑，记录 `stale-test-repair`；有歧义则 `BLOCKED_PREEXISTING`，禁止 `.bak`/删除/禁用/exclude
- **服务启动**：`build-profile.json` 的 `serviceStartTemplate`（典型 `spring-boot:run` + profile）；**禁止 hardcode 端口/模块路径**
- **Maven 生命周期去重**：单元测试已独立通过后，服务启动命令可配置 `-Dmaven.test.skip=true` 避免重复测试编译；它仅优化启动，不是测试通过证据
- **服务指纹输入**（Task 3 §5.1）：`serviceStart.inputFiles` 必须列出 module 源 glob（如 `["<module>/pom.xml", "<module>/src/main/**/*.java", "<module>/src/main/resources/**"]`）；`harness_service.py ensure` 取 CLI `--files` ∪ `inputFiles` 计算 `moduleInputsHash`。**空输入被拒绝**，不得生成可复用空指纹。源码/command/profile/overlayPath 任一变化即 restart
- **runtime overlay**：`-Dspring.config.additional-location=file:<ascii-abs-path>/application-harness-execute.yml`；禁止默认 Edit tracked `application*.yml`
- **known-good-test-profile**：profile 名、baseURL、healthUrl 写在 build-profile，非 skill 硬编码
- **多租户请求头**：header 名/值来自 build-profile 的 `httpHeaders` 配置
- **Service Gate**：`harness_service.py ensure` 返回 `needs-user-decision`（用户进程占端口）时**才** blocking user confirmation
