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
| **Mapper / LambdaQueryWrapper / SQL** | 纯 Mock 返回值**不得**宣称 DB 验证通过 → 🟡 静态验证，交 harness-test 真实 DB |
| **行为性新分支** | 正则/条件/分支逻辑变更新增分支须 RED→GREEN；不属于低价值豁免 |
| **ledger** | compile 必写；执行了 test 写 unitTest，否则 `NOT_RUN_BY_RUN`；diffHash 三部分合并（见 reference） |
