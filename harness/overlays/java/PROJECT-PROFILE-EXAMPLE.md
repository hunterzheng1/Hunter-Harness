# build-profile.json 项目专属示例（勿写入 overlay / 合成 skill）

以下 UDP 项目硬编码**不得**出现在合成 skill 正文；首次 deploy 后在目标项目运行 `harness_preflight.py detect`（委托 `harness_profile`，产出 v2 schema），填入 `.harness/config/build-profile.json`。项目专属命令以 `source=user` 覆写保留（spec §3.1），detected 字段每次按 basis 重探测。

```json
{
  "schemaVersion": 2,
  "projectType": "java-maven",
  "excludedRoots": [
    ".git", ".harness", ".claude/worktrees", ".cursor/worktrees",
    "target", "build", "dist", "node_modules", ".gradle",
    ".idea", ".vscode", "__pycache__", ".pytest_cache", ".cache"
  ],
  "commands": {
    "compile": {
      "command": "mvn compile -pl udp-micros-runner/contribution-server -o -q",
      "argvTemplate": ["mvn", "compile", "-pl", "udp-micros-runner/contribution-server", "-o", "-q"],
      "scope": "module",
      "inputs": ["pom.xml", "udp-micros-runner/contribution-server/pom.xml", "udp-micros-runner/contribution-server/src/main/**"],
      "coverage": "compile",
      "source": "user",
      "basis": { "reactorModules": [".", "udp-micros-runner/contribution-server"] }
    },
    "unitTest": {
      "command": "mvn test -pl udp-micros-runner/contribution-server -o",
      "argvTemplate": ["mvn", "test", "-pl", "udp-micros-runner/contribution-server", "-o"],
      "scope": "incremental",
      "inputs": ["pom.xml", "udp-micros-runner/contribution-server/pom.xml", "udp-micros-runner/contribution-server/src/test/**"],
      "coverage": "unitTest",
      "source": "user",
      "basis": { "reactorModules": [".", "udp-micros-runner/contribution-server"] }
    },
    "unitTestFull": {
      "command": "mvn test -pl udp-micros-runner/contribution-server -o",
      "argvTemplate": ["mvn", "test", "-pl", "udp-micros-runner/contribution-server", "-o"],
      "scope": "full",
      "inputs": [
        "pom.xml",
        "udp-micros-runner/contribution-server/pom.xml",
        "udp-micros-runner/contribution-server/src/main/**",
        "udp-micros-runner/contribution-server/src/test/**"
      ],
      "coverage": "unitTestFull",
      "source": "user",
      "basis": { "reactorModules": [".", "udp-micros-runner/contribution-server"] }
    },
    "package": {
      "command": "mvn package -pl udp-micros-runner/contribution-server -DskipTests -o",
      "argvTemplate": ["mvn", "package", "-pl", "udp-micros-runner/contribution-server", "-DskipTests", "-o"],
      "scope": "module",
      "inputs": ["pom.xml", "udp-micros-runner/contribution-server/pom.xml", "udp-micros-runner/contribution-server/src/main/**", "udp-micros-runner/contribution-server/src/test/**"],
      "coverage": "package",
      "source": "user",
      "basis": { "reactorModules": [".", "udp-micros-runner/contribution-server"] }
    }
  },
  "verificationInputs": {
    "compile": ["pom.xml", "udp-micros-runner/contribution-server/pom.xml", "udp-micros-runner/contribution-server/src/main/**"],
    "unitTest": ["pom.xml", "udp-micros-runner/contribution-server/pom.xml", "udp-micros-runner/contribution-server/src/test/**"],
    "unitTestFull": [
      "pom.xml",
      "udp-micros-runner/contribution-server/pom.xml",
      "udp-micros-runner/contribution-server/src/main/**",
      "udp-micros-runner/contribution-server/src/test/**"
    ],
    "package": ["pom.xml", "udp-micros-runner/contribution-server/pom.xml", "udp-micros-runner/contribution-server/src/main/**", "udp-micros-runner/contribution-server/src/test/**"]
  },
  "serviceStart": {
    "command": "mvn spring-boot:run -pl udp-micros-runner/contribution-server -Dspring-boot.run.profiles=local-dev -Dspring-boot.run.jvmArguments=\"-Dspring.config.additional-location=file:C:/temp/harness-test-overlay/<change-name>/application-harness-test.yml\"",
    "healthUrl": "http://127.0.0.1:9093/contribution/meta",
    "startTimeoutSec": 120,
    "inputFiles": ["udp-micros-runner/contribution-server/src/main/**", "udp-micros-runner/contribution-server/src/main/resources/application*.yml"],
    "source": "user",
    "profile": "local-dev",
    "overlayPath": ""
  },
  "identifier": {
    "pattern": "^[A-Za-z][A-Za-z0-9_-]*$",
    "maxLength": 64,
    "prefix": "JAVATEST_"
  },
  "knownPreexistingErrors": [],
  "shellQuirks": [],
  "fingerprint": { "mvnVersion": "3.9.6", "nodeVersion": "", "pomHash": "" },
  "httpHeaders": { "tenant-id": "1", "Content-Type": "application/json; charset=UTF-8" },
  "knownGoodTestProfile": "local-dev-remote-sdk"
}
```

| 字段 | 说明 |
|------|------|
| `commands.<key>` | v2 命令对象：`command`/`argvTemplate`/`scope`/`inputs`/`coverage`/`source`/`basis`。项目专属模块命令用 `source=user` 覆写保留；detected 命令按 `basis.reactorModules`+`pomHash` 重探测 |
| `commands.<key>.inputs` | 该 verification 的依赖闭包 glob；`verificationInputs.<key>` 由它派生（兼容 ledger v1 消费） |
| `excludedRoots` | 排除策略（spec §3.1）：兄弟 worktree / target / node_modules 等不进 inputs |
| `verificationInputs.unitTestFull` | submit 最终门禁 `can-reuse --profile-input unitTestFull` 据此展开文件集，禁止用仅含 staged 的 `--files` 冒充 |
| `serviceStart` | 模板 serviceStart（command/healthUrl/inputFiles）；运行期由 `resolve_service_start` 注入 overlay/profile，不写回持久 profile |
| `identifier` | 测试标识符约束（pattern/maxLength/prefix），Runner 生成前校验 |
| `httpHeaders.tenant-id` | 多租户 header（项目自定义扩展字段） |
| `knownGoodTestProfile` | 文档/报告引用，非 skill 硬编码 |

测试数据前缀示例：`JAVATEST_<change-name>_`（项目可在 `identifier.prefix` 配置）。

## 凭据配置（spec §3.4 凭据边界）

profile **只声明 env key、cache path、角色，不含凭据值**。测试运行时由 `harness-test/scripts/runtime-helpers.mjs` 的 `readJsonUtf8BomSafe` 读 credential-cache.json，token/SSO 值只存在于运行期 cache，不写入 profile / 规则 / 报告：

```json
{
  "credential": {
    "mode": "token-cache",
    "envKey": "TEST_TOKEN",
    "cachePath": ".harness/changes/<change-name>/runtime/credential-cache.json",
    "role": "admin"
  }
}
```

| 字段 | 说明 |
|------|------|
| `credential.envKey` | 取 token 的环境变量名（值不入 profile） |
| `credential.cachePath` | 运行期 credential cache 路径（gitignored，含值但不上传） |
| `credential.role` | 角色（非凭据值） |

发布前用 `findCredentialValues` 扫 profile/规则/Markdown，命中明文 `password`/`token`/`secret`/`Authorization: Bearer` 值即 ❌FAIL；占位符 `<*_REDACTED>` 与 env 引用 `${ENV}`/`$ENV` 不报。
