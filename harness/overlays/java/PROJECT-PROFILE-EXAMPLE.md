# build-profile.json 项目专属示例（勿写入 overlay / 合成 skill）

以下 UDP 项目硬编码**不得**出现在合成 skill 正文；首次 deploy 后在目标项目运行 `harness_preflight.py detect`，填入 `.harness/config/build-profile.json`：

```json
{
  "schemaVersion": 1,
  "buildCommands": {
    "compile": "mvn compile -pl udp-micros-runner/contribution-server -o -q",
    "unitTest": "mvn test -pl udp-micros-runner/contribution-server -o",
    "unitTestFull": "mvn test -pl udp-micros-runner/contribution-server -o",
    "install": "mvn install -pl udp-micros-runner/contribution-server -am -DskipTests -nsu",
    "package": "mvn package -pl udp-micros-runner/contribution-server -DskipTests -o"
  },
  "verificationInputs": {
    "unitTestFull": [
      "pom.xml",
      "udp-micros-runner/contribution-server/pom.xml",
      "udp-micros-runner/contribution-server/src/main/**",
      "udp-micros-runner/contribution-server/src/test/**"
    ]
  },
  "serviceStartTemplate": "mvn spring-boot:run -pl udp-micros-runner/contribution-server -Dspring-boot.run.profiles=local-dev -Dspring-boot.run.jvmArguments=\"-Dspring.config.additional-location=file:C:/temp/harness-test-overlay/<change-name>/application-harness-test.yml\"",
  "service": {
    "port": 9093,
    "healthUrl": "http://127.0.0.1:9093/contribution/meta",
    "module": "udp-micros-runner/contribution-server"
  },
  "httpHeaders": {
    "tenant-id": "1",
    "Content-Type": "application/json; charset=UTF-8"
  },
  "knownGoodTestProfile": "local-dev-remote-sdk"
}
```

| 字段 | 说明 |
|------|------|
| `buildCommands.*` | 含 `-pl` 模块路径；worktree 场景可含 `-f` 修正 |
| `verificationInputs.unitTestFull` | submit 最终门禁的依赖闭包 glob；`harness_ledger.py can-reuse --profile-input unitTestFull` 据此展开文件集，禁止用仅含 staged 的 `--files` 冒充 |
| `serviceStartTemplate` | spring-boot:run + overlay 路径占位 |
| `service.port` / `healthUrl` | Service Gate 与 runner baseURL |
| `httpHeaders.tenant-id` | 多租户 header（项目自定义） |
| `knownGoodTestProfile` | 文档/报告引用，非 skill 硬编码 |

测试数据前缀示例：`JAVATEST_<change-name>_`（项目可在 profile 增加 `testDataPrefix`）。
