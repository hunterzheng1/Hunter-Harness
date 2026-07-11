<!-- @append-after section:"Workflow" -->

### Java 测试环境补充

- **preflight 0.1**：写入 `runtime/preflight.json` 的 `executorPath`/`mvnVersion` 等；Maven 可用性 `mvn -version` exit 0
- **编译门禁**：测试前按 `build-profile.json` 的 `buildCommands.compile`；输出须含 `BUILD SUCCESS` 或 exit 0 证据
- **条件 install**：worktree 首建或上游模块变更时按 profile 执行 `buildCommands.install`（非每次强制 `-am`）
- **单元测试**：可复用 ledger unitTest 则跳过；否则 `buildCommands.unitTest`（典型 `mvn test -pl <module>`）
- **服务启动**：`build-profile.json` 的 `serviceStartTemplate`（典型 `spring-boot:run` + profile）；**禁止 hardcode 端口/模块路径**
- **服务指纹输入**（Task 3 §5.1）：`serviceStart.inputFiles` 必须列出 module 源 glob（如 `["<module>/pom.xml", "<module>/src/main/**/*.java", "<module>/src/main/resources/**"]`）；`harness_service.py ensure` 取 CLI `--files` ∪ `inputFiles` 计算 `moduleInputsHash`。**空输入被拒绝**，不得生成可复用空指纹。源码/command/profile/overlayPath 任一变化即 restart
- **runtime overlay**：`-Dspring.config.additional-location=file:<ascii-abs-path>/application-harness-test.yml`；禁止默认 Edit tracked `application*.yml`
- **known-good-test-profile**：profile 名、baseURL、healthUrl 写在 build-profile，非 skill 硬编码
- **多租户请求头**：header 名/值来自 build-profile 的 `httpHeaders` 配置
- **Service Gate**：`harness_service.py ensure` 返回 `needs-user-decision`（用户进程占端口）时**才** AskUserQuestion
