<!-- @append-after section:"Workflow" -->

### Java 提交前验证补充

通用 `harness-submit` 的最终门禁已统一为 `unitTestFull`（见通用 SKILL.md 步骤 2 / checklist 步骤 2）。Java overlay **不重复定义门禁规则**，只补两点：

- **Maven 命令来源**：`--command` 取 `build-profile.json` 的 `buildCommands.unitTestFull`，典型 `mvn test -pl <module> -o`。`mvn test` 不带 `-Dtest=` 即模块级全量 → 记 `scope=module` 可复用；带 `-Dtest=<类>` 是增量 `unitTest`，**不能**冒充 `unitTestFull`。
- **Java 依赖闭包**：`verificationInputs.unitTestFull` 必须覆盖完整编译+测试依赖闭包，建议 `["pom.xml", "<module>/pom.xml", "<module>/src/main/**", "<module>/src/test/**"]`，避免只哈希 staged 文件而漏掉 pom 依赖变化导致误复用。`harness_preflight.py detect` 对单模块项目写入根级默认 `["pom.xml", "src/main/**", "src/test/**"]`，多模块项目需手工改为 module 专属 glob。
- **可选 package 前置**：若团队发版前需 jar 验证，在 submit 后接 `/harness-package`（默认时序 submit → package → archive）
