# Java 通用踩坑（overlay）

> 项目专属端口/模块/tenant 值 → [[PROJECT-PROFILE-EXAMPLE.md|PROJECT-PROFILE-EXAMPLE]] / `build-profile.json`

| # | 规则 | 现象 | 原因 | 处理 |
|---|------|------|------|------|
| 1 | Maven 用 PowerShell | Bash 被拒/乱码 | 中文路径 + hook | `powershell.exe -NoProfile -Command "mvn ..."` |
| 2 | `-pl` 限定模块 | 无关子模块编译失败 | `-am` 拉起坏 POM | 用 `-pl <module>`，慎用 `-am` |
| 3 | settings 相对路径 | Maven 输出乱码 | settings 含中文绝对路径 | `.mvn/maven.config` 用相对 `-s` |
| 4 | 改代码后先 compile | 测试结果不变 | IDE 热重载未生效 | 测试前 `mvn compile -o` |
| 5 | 禁止 Bash 跑 node | runner 失败 | disallowed-tools | PowerShell + 绝对路径 node |
| 6 | Mock Mapper ≠ DB 验证 | 假绿 | 纯 Mock 返回值 | 🟡 静态验证，交 harness-test |
| 7 | 请求体禁止临场猜 | 大面积 400 | 字段与 VO 不一致 | 从 Controller/VO/契约生成 |
| 8 | 唯一字段加前缀 | 409/冲突 BLOCKED | 测试数据撞库 | `TEST_<change>_<ts>_<rand>` |
| 9 | runtime overlay | tracked 配置被改 | 直接 Edit yml | additional-location 叠加 |
| 10 | Service Gate 先决策 | 旧服务 500 | 端口已有进程 | ensure → needs-user-decision 才问 |
