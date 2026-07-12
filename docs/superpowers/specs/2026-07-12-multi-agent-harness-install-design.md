# Hunter Harness 多 Agent 安装与适配设计

- 日期：2026-07-12
- 状态：已确认，可进入实现计划
- 决策：采用 Adapter Matrix；首次安装可多选 Agent
- 支持目标：Claude Code、Codex、Cursor、CodeBuddy
- 目标读者：实现工程师，以及 Composer 2.5 等低成本编码模型
- 研究依据：[Codex、Cursor、CodeBuddy Agent 项目格式调研](../../research/2026-07-12-codex-cursor-codebuddy-agent-formats.md)

## 1. 目标

改造 `npx @hunter-harness/cli` 的首次安装、刷新、状态记录和 Bundle 构建流程，使一个项目可以同时启用以下一个或多个 Agent：

```text
claude-code
codex
cursor
codebuddy
```

安装结果必须符合各 Agent 的原生目录和文件规范。不能只改目录名；Skill frontmatter、正文中的工具名、规则引用、子 Agent 调用和降级路径也必须与目标 Agent 一致。

完成后的用户体验：

```text
? 请选择目标 Agent（可多选，使用逗号分隔）
  1. Claude Code
  2. Codex
  3. Cursor
  4. CodeBuddy
请输入编号 [1]: 1,2,4

? 请选择 Harness 类型
  1. 通用
  2. Java
请输入编号 [1]: 2
```

同一个项目可以同时得到 Claude Code、Codex 和 CodeBuddy 的工作副本。第二次执行相同命令时必须幂等。

## 2. 非目标

首期明确不做以下事项：

1. 不默认安装任何可执行 Hook。
2. 不声称四个 Agent 的高级能力完全相同；不支持的自定义子 Agent 必须回退到主会话执行。
3. 不生成未经官方文档确认的目录，例如 `.codex/commands/`。
4. 不把编码规范写入 Codex `.codex/rules/*.rules`；该目录是命令权限策略，不是模型规则。
5. 不将 `generic`、`mcp` 暴露为 Harness 初始化选项。它们可继续存在于 Skill Center registry，不属于本次项目初始化范围。
6. 不重写整个 Harness 工作流或服务端 Artifact 协议。
7. 不在仓库中生成 `settings.local.json`、`CODEBUDDY.local.md` 或其他个人配置。

## 3. 已确认的产品决策

### 3.1 安装允许多选

`adapters.enabled` 是集合，不是单值。内部始终按以下固定顺序排序，保证输出确定性：

```ts
const HARNESS_AGENT_ORDER = [
  "claude-code",
  "codex",
  "cursor",
  "codebuddy"
] as const;
```

不得保留“只有一个 primary adapter 才真正工作”的隐藏语义。

### 3.2 保持旧版本兼容

- 交互式首次安装：显示多选菜单；空输入仍选择 `claude-code`。
- 非交互式首次安装：未提供 Agent 参数时仍使用 `claude-code`，避免旧脚本突然失败。
- 新参数：`--agents <csv>`，例如 `--agents claude-code,codex,cursor`。
- 旧参数：`--adapter <name>` 保留一个小版本周期，等价于只选择一个 Agent，并输出 deprecation warning。
- 同时提供 `--agents` 和 `--adapter`：配置错误，退出码 `3`，不得猜测优先级。
- JSON 配置同时存在 `agents` 和旧 `adapter`：配置错误，退出码 `3`。

### 3.3 CodeBuddy 默认兼容 IDE 与 CLI

初始化层的 Agent 名仍只有 `codebuddy`。增加可选配置：

```ts
type CodeBuddySurface = "both" | "ide" | "cli";
```

- 默认值：`both`。
- 首期 `both` 生成 `CODEBUDDY.md`、Skills、Commands 和可验证的 Agent 文件。
- `both` 不生成模块化 Rules，避免 IDE 的 `RULE.mdc` 与 CLI 的 `.md` 双重注入。
- `ide` 可生成 `.codebuddy/rules/<slug>/RULE.mdc`。
- `cli` 可生成 `.codebuddy/rules/<slug>.md`。
- 首期 Harness 核心规则已经能放入 `CODEBUDDY.md`，因此实现可以只完成 `both`；但 schema、CLI 参数和 adapter 接口必须为三种 surface 留出明确位置。

CLI 参数：

```text
--codebuddy-surface both|ide|cli
```

未选择 `codebuddy` 却提供此参数：配置错误，退出码 `3`。

### 3.4 Hooks 默认关闭

本次不增加 `--with-hooks` 的实际安装行为。Adapter 接口保留 Hook capability 字段，但所有目标均返回 `false`。

原因：Hooks 能执行本地代码，各 Agent 的事件名、信任确认、配置结构和失败语义不同。首期若静默安装，会突破现有“离线、安全、保守刷新”边界。

## 4. 官方落位矩阵

| 能力 | Claude Code | Codex | Cursor | CodeBuddy `both` |
|---|---|---|---|---|
| 共享项目指令 | `AGENTS.md` | `AGENTS.md` | `AGENTS.md` | `CODEBUDDY.md`；`AGENTS.md` 仅回退 |
| Agent 路由文件 | `CLAUDE.md` | 无额外文件 | 无额外文件 | `CODEBUDDY.md` |
| Skills | `.claude/skills/<name>/` | `.agents/skills/<name>/` | `.cursor/skills/<name>/` | `.codebuddy/skills/<name>/` |
| 项目规则 | `.claude/rules/*.md` | 写入 `AGENTS.md`，不生成 `.codex/rules` | `.cursor/rules/*.mdc` | 写入 `CODEBUDDY.md` |
| 自定义 Agent | `.claude/agents/*.md` | 首期不生成，Skill 内联回退 | 首期不生成，Skill 内联回退 | `.codebuddy/agents/*.md` |
| Commands | Skill 直接调用 | Skill 直接调用 | `.cursor/commands/*.md`，仅确有独立命令时 | `.codebuddy/commands/*.md`，仅确有独立命令时 |
| Hooks | 不新增 | 不新增 | 不新增 | 不新增 |

### 4.1 为什么 Cursor 不复用 `.agents/skills`

Cursor 与 Codex 都能读取 `.agents/skills`，但本设计仍将 Cursor 输出到 `.cursor/skills`：

1. Cursor 的 `paths`、`disable-model-invocation` 等 frontmatter 扩展不得污染 Codex Skill。
2. 同一 Skill 的 Agent 专属正文可能不同。
3. 独立目录让 installed state、刷新冲突和卸载边界更清晰。

禁止通过符号链接复用目录；现有安全模型将符号链接视为不可信边界。

## 5. 当前代码的关键问题

实现前必须确认以下现状，不能绕过：

1. `packages/cli/src/config/init-config.ts` 将 `adapter` 固定为 `claude-code`。
2. `packages/core/src/project/profile-bundle.ts` 将所有 Skill 投射到 `.claude/skills`，Agent 投射到 `.claude/agents`。
3. `packages/core/src/project/initialize.ts` 总是写 `CLAUDE.md`，context index 中规则路径写死 `.claude/rules`。
4. `packages/core/src/project/refresh.ts` 的目录剪枝边界写死 `.claude`。
5. `packages/core/src/push/push.ts` 的受管根、Skill 枚举和 Bundle ignore 逻辑写死 `.claude`。
6. `packages/core/src/policy/file-policy.ts` 只部分识别 Cursor，尚未识别 `.agents/skills`、`.codebuddy` 和 `CODEBUDDY.md`。
7. 当前 `harness/**/SKILL.md` 含 Claude 专属字段、工具名、`.claude/rules/` 路径和自定义 Agent 调用。

因此实现不得只修改 `profile-bundle.ts` 的路径字符串。

## 6. 总体架构

采用三层模型：

```text
Canonical Harness source
        │
        ├── profile overlay: general | java
        │
        └── agent adapter: claude-code | codex | cursor | codebuddy
                │
                ├── metadata/frontmatter adaptation
                ├── semantic/path/tool adaptation
                ├── capability fallback
                └── project target projection
```

### 6.1 模块边界

新增或调整以下深模块：

```text
harness/adapters/                    Agent 专属编译输入
packages/core/src/project/
├── agent-adapters.ts                Adapter 描述符与能力矩阵
├── profile-bundle.ts                只负责加载、校验 Bundle
├── project-bundle.ts                source artifact -> project target 投影
├── initialize.ts                    组装 desired state 并事务写入
└── refresh.ts                       desired/current/trusted 三方协调
```

`initialize.ts` 和 `refresh.ts` 不允许出现四组大段 `if (agent === ...)`。所有 Agent 差异必须通过 `HarnessAgentAdapter` 表达。

建议接口：

```ts
export type HarnessAgent =
  | "claude-code"
  | "codex"
  | "cursor"
  | "codebuddy";

export interface AdapterContext {
  profile: "general" | "java";
  codebuddySurface: "both" | "ide" | "cli";
}

export interface HarnessAgentAdapter {
  readonly name: HarnessAgent;
  readonly skillsRoot: string;
  readonly rulesRoot: string | null;
  readonly agentsRoot: string | null;
  readonly commandsRoot: string | null;
  readonly supportsExecutableHooks: false;

  projectInstructionTargets(context: AdapterContext): readonly string[];
  projectBundle(
    bundle: LoadedAgentBundle,
    context: AdapterContext
  ): readonly ProjectedBundleFile[];
  contextIndex(context: AdapterContext): AdapterContextIndexEntry;
  pruneBoundaries(context: AdapterContext): readonly string[];
}
```

接口方法必须是纯计算；文件读写仍由 transaction/refresh 层统一完成。

## 7. Canonical 内容与 Agent 编译

### 7.1 目录

保留当前 `harness/` 为 canonical 源，但新增 Agent adapter 输入：

```text
harness/
├── harness-*/
├── agents/
├── overlays/java/
└── adapters/
    ├── claude-code/
    ├── codex/
    ├── cursor/
    └── codebuddy/
```

每个 adapter 目录允许：

```text
adapter.json                       能力和输出格式声明
skill-overlays/<skill>.overlay.md  仅覆盖平台特有段落
agents/*.md                        该平台确认支持时才存在
rules/                             该平台确认支持的原生规则模板
```

### 7.2 合成顺序

`harness_deploy.py build` 的确定顺序：

1. 展开 canonical `shared/` includes。
2. 应用 profile overlay，例如 Java。
3. 应用 Agent skill overlay。
4. 重写并严格校验 frontmatter。
5. 验证正文中不存在禁止的跨 Agent 路径或能力调用。
6. 复制该 Agent 允许的 Agent/Rule/Command 文件。
7. 生成 manifest 和所有文件 SHA-256。

增加参数：

```text
--agent claude-code|codex|cursor|codebuddy
```

缺少 `--agent` 时只允许内部兼容路径使用 `claude-code`，并输出 deprecation warning。`scripts/sync-harness.mjs` 必须显式传四个 Agent，不能依赖默认值。

### 7.3 Frontmatter 规范

Canonical Skill 的必需交集只有：

```yaml
---
name: harness-review
description: 明确说明做什么、何时触发以及不应触发的边界。
---
```

Adapter 生成规则：

- Claude Code：保留已确认支持的 `argument-hint`、`effort`、`allowed-tools`、`disallowed-tools` 等字段。
- Codex：只保留 `name`、`description`。首期不生成 `agents/openai.yaml`。
- Cursor：保留 `name`、`description`；只有确有需要时增加官方字段 `paths`、`disable-model-invocation`、`metadata`。
- CodeBuddy：至少保留 `name`、`description`；可增加已确认支持的 `allowed-tools`、`context`、`agent` 等，但首期不得增加 frontmatter hooks。

禁止事项：

- 不允许未知字段透传到非 Claude 目标。
- 不允许用正则拼接 YAML；必须解析、构造对象、序列化。
- Skill 目录名必须与 frontmatter `name` 完全相同。

### 7.4 语义适配

每个 Agent Bundle 必须通过以下语义检查：

1. 非 Claude Bundle 的正文不得引用 `.claude/rules/`、`.claude/agents/` 或 `.claude/skills/`。
2. Codex/Cursor Skill 不得要求调用未安装的 `harness-reviewer` 等自定义 Agent。
3. Codex/Cursor 必须把相关步骤改写为：若当前运行时支持隔离子任务则可委派，否则在主会话按同一检查清单执行。
4. CodeBuddy Skill 引用自定义 Agent 时，对应 `.codebuddy/agents/<name>.md` 必须存在。
5. 所有相对 Markdown 链接、`reference.md`、`checklist.md`、scripts 和 templates 必须存在。
6. 工具名必须属于 adapter 的已确认工具词表；无法可靠映射时删除工具限制，并在正文保留行为约束，不能猜测工具名。
7. PowerShell-first 是 Harness 的工作流要求，不等同于 Agent Hook shell。正文可继续要求 PowerShell；不得因此生成 CodeBuddy Hook。

## 8. 离线资源布局

构建后 npm 包携带完整的 profile × agent 矩阵：

```text
resources/harness/
├── bundles/
│   ├── general/
│   │   ├── claude-code/
│   │   ├── codex/
│   │   ├── cursor/
│   │   └── codebuddy/
│   └── java/
│       ├── claude-code/
│       ├── codex/
│       ├── cursor/
│       └── codebuddy/
└── manifests/
    ├── general/
    │   ├── claude-code.json
    │   ├── codex.json
    │   ├── cursor.json
    │   └── codebuddy.json
    └── java/                    与 general 相同的四个 manifest
```

Manifest schema v2：

```ts
interface AgentBundleManifestV2 {
  schema_version: 2;
  profile: "general" | "java";
  adapter: HarnessAgent;
  bundle_version: string;
  generator: "harness_deploy.py";
  files: Array<{ path: string; sha256: string }>;
}
```

Bundle 体积预计从约 2 MB 增长到约 8 MB，属于可接受的离线安装代价。不要为了去重引入运行时下载或符号链接。

## 9. 配置契约

### 9.1 InitConfig

新 schema：

```ts
const harnessAgentSchema = z.enum([
  "claude-code",
  "codex",
  "cursor",
  "codebuddy"
]);

const initConfigSchema = z.object({
  agents: z.array(harnessAgentSchema).min(1),
  profile: z.enum(["general", "java"]),
  codebuddy_surface: z.enum(["both", "ide", "cli"]).default("both"),
  server_url: httpsUrlSchema.nullable().optional(),
  token_env: tokenEnvSchema.nullable().optional(),
  project_id: projectIdSchema.nullable().optional(),
  features: existingFeaturesSchema.optional()
}).strict();
```

旧 `adapter` 不能直接加入严格新 schema。兼容逻辑必须先把 legacy input 规范化为 `agents`，再进入 `initConfigSchema`。

### 9.2 project.yaml

现有结构已经支持数组，继续使用：

```yaml
adapters:
  enabled:
    - claude-code
    - codex
    - cursor
    - codebuddy
```

数组按固定 Agent 顺序写入。增加：

```yaml
adapter_options:
  codebuddy:
    surface: both
```

只有启用 CodeBuddy 时才写 `adapter_options.codebuddy`。为兼容旧项目，`projectConfigSchema` 中 `adapter_options` 可选，读取缺失值时使用 `both`。

### 9.3 配置优先级

保持现有“配置文件字段优先于 CLI 字段”的产品行为：

```text
config file > CLI flags > interactive prompt > compatibility default
```

同一来源内出现互斥新旧字段必须报错，不做合并。

## 10. 交互和非交互行为

### 10.1 解析规则

交互输入允许：

```text
1
1,2,4
claude-code,codex,codebuddy
all
```

规则：

- 去除首尾空白。
- 只按英文逗号分隔。
- `all` 等于四个 Agent。
- 重复值去重。
- 空输入等于 `claude-code`。
- 任一未知 token 使整个输入失败；不得静默丢弃。
- 输出按固定 Agent 顺序排序，而不是用户输入顺序。

### 10.2 非交互例子

```powershell
npx @hunter-harness/cli --agents claude-code,codex,cursor,codebuddy `
  --profile general --non-interactive --yes
```

```json
{
  "agents": ["codex", "cursor"],
  "profile": "java"
}
```

配置未选择 CodeBuddy 时不应要求 `codebuddy_surface`；若配置文件显式给出则报错。该错误必须在 legacy/input normalization 阶段、Zod 默认值填充之前判定。

## 11. Project projection

### 11.1 Claude Code

保持现有输出：

```text
AGENTS.md                         managed block
CLAUDE.md                         managed block
.claude/rules/harness-general.md
.claude/rules/harness-profile-java.md  Java only
.claude/skills/harness-*/...
.claude/agents/harness-*.md
```

### 11.2 Codex

```text
AGENTS.md                         shared managed block
.agents/skills/harness-*/...
```

Codex 指令通过根 `AGENTS.md` 路由到 `.harness/context-index.json` 和 `.agents/skills/`。不生成：

```text
.codex/rules/
.codex/commands/
.codex/hooks.json
.codex/config.toml
```

### 11.3 Cursor

```text
AGENTS.md
.cursor/rules/harness-general.mdc
.cursor/rules/harness-profile-java.mdc  Java only
.cursor/skills/harness-*/...
```

Always Rule 示例：

```yaml
---
description: Hunter Harness project-wide safety and evidence rules
globs:
alwaysApply: true
---

# Hunter Harness Rules

- Report evidence honestly.
- Do not execute destructive actions without confirmation.
```

### 11.4 CodeBuddy

默认 `both`：

```text
AGENTS.md                         仍作为跨 Agent 共享文件
CODEBUDDY.md                      CodeBuddy managed block
.codebuddy/skills/harness-*/...
.codebuddy/agents/harness-*.md
```

`CODEBUDDY.md` 存在时 CodeBuddy 不依赖 `AGENTS.md`。因此它的 managed block 必须包含同一份共享核心指令，并增加 CodeBuddy 原生路径；不能只写“请读取 AGENTS.md”。

首期不生成 `.codebuddy/settings.json`，避免修改用户 permissions/hooks 配置。

## 12. 共享 managed block

根 `AGENTS.md` 只放跨 Agent 内容，不再引用 `.claude/skills`：

```markdown
# Hunter Harness

Use `.harness/context-index.json` to locate the instructions, skills, knowledge,
and codebase map for the active agent.
Treat installed `harness-*` skills as editable adapter working copies.
Do not modify `.harness/state` or `.harness/cache` directly.
```

Adapter 专属路径只能出现在 `CLAUDE.md`、`CODEBUDDY.md` 或 context index 中。

每个受管块使用稳定 ID：

```text
hunter-harness-core
hunter-harness-claude-code
hunter-harness-codebuddy
```

同一文件同一 ID 最多一个块。遇到重复开始/结束标记必须报告 conflict 并保留原文件。

## 13. Context index v2

`.harness/context-index.json` 升级为 schema 2：

```json
{
  "schema_version": 2,
  "project": {
    "shared_instructions": "AGENTS.md",
    "adapters": {
      "claude-code": {
        "instructions": "CLAUDE.md",
        "skills_root": ".claude/skills",
        "rules": [".claude/rules/harness-general.md"]
      },
      "codex": {
        "instructions": "AGENTS.md",
        "skills_root": ".agents/skills",
        "rules": []
      },
      "cursor": {
        "instructions": "AGENTS.md",
        "skills_root": ".cursor/skills",
        "rules": [".cursor/rules/harness-general.mdc"]
      },
      "codebuddy": {
        "instructions": "CODEBUDDY.md",
        "skills_root": ".codebuddy/skills",
        "rules": []
      }
    }
  },
  "knowledge": { "index": ".harness/knowledge/index.json" },
  "codebase": { "map": ".harness/codebase/map", "status": "missing" },
  "skill_bundles": {
    "claude-code": { "registry_version": "0.2.0", "bundle_hash": "sha256:0000000000000000000000000000000000000000000000000000000000000000" },
    "codex": { "registry_version": "0.2.0", "bundle_hash": "sha256:0000000000000000000000000000000000000000000000000000000000000000" }
  }
}
```

只输出已启用 Agent。Java 规则按实际文件追加。所有 key 顺序确定。

## 14. Installed state v3

现有 v2 只能描述一个 Claude 投影。升级：

```ts
interface InstalledBundleStateV3 {
  schema_version: 3;
  profile: "general" | "java";
  adapters: HarnessAgent[];
  installed_at: string;
  manifests: Array<{
    adapter: HarnessAgent;
    bundle_version: string;
    bundle_manifest_hash: string;
  }>;
  files: Array<{
    owner: HarnessAgent | "shared";
    source_path: string;
    target_path: string;
    sha256: string;
  }>;
  managed_blocks: Array<{
    owner: HarnessAgent | "shared";
    target_path: string;
    block_id: string;
    content_sha256: string;
  }>;
}
```

排序：

1. `manifests` 按固定 Agent 顺序。
2. `files` 按 `target_path`，再按 `source_path`。
3. `managed_blocks` 按 `target_path`，再按 `block_id`。

installed state 是审计记录，不是删除授权来源。删除授权只能来自当前受信 Bundle manifest、代码内 Adapter 目标白名单或已签入 migration manifest。

## 15. 刷新与 Agent 集合切换

### 15.1 Desired state

刷新命令增加可选 `--agents <csv>`：

- 未提供：刷新当前 `project.yaml` 中的 Agent 集合。
- 提供：执行 Agent 集合 transition。

示例：

```text
old: [claude-code, codex]
new: [codex, cursor, codebuddy]
```

行为：

- Codex 当前目标继续协调。
- Cursor、CodeBuddy 目标按 missing/add 处理。
- Claude-only 目标只有当前 hash 等于 trusted hash 时才能删除。
- 被用户修改的 Claude 文件保留并报告 conflict。
- `CLAUDE.md` 用户内容永远不整文件删除；只移除合法的 Harness managed block。
- `AGENTS.md` 共享块只要仍有任意 Agent 启用就保留。
- `CODEBUDDY.md` 同理只移除 Harness managed block，不删除用户正文。

### 15.2 通用协调规则

继续使用现有分类：

```text
missing                         -> add
current == incoming             -> unchanged
current == trusted              -> replace
current != trusted              -> preserve + conflict
old-only && current == trusted  -> delete/remove block
old-only && dirty               -> preserve + conflict
```

`--force-managed` 只能强制替换/删除代码定义的合法 Harness 目标，不能让 state 文件授权任意路径。

### 15.3 目录剪枝

删除文件后，只在 adapter 提供的边界内剪除空目录：

```text
.claude/skills/harness-*
.claude/agents/
.cursor/skills/harness-*
.agents/skills/harness-*
.codebuddy/skills/harness-*
.codebuddy/agents/
```

不得删除 `.claude`、`.cursor`、`.agents`、`.codebuddy` 顶层目录，也不得删除非 Harness 同级内容。

## 16. 迁移

### 16.1 v2 Claude-only 项目

当读取 installed state v2：

1. 将旧项目视为 `adapters = ["claude-code"]`。
2. 使用现有 migration manifest 验证旧 `bundle_manifest_hash`。
3. 将可信投影转换成 v3 的 `owner: "claude-code"`。
4. 生成共享 managed block 记录。
5. 只有用户显式选择新 Agent 时才增加其他投影。
6. 第一次成功 refresh 后写 v3；失败或冲突不破坏旧文件。

### 16.2 project.yaml 兼容

旧 `adapters.enabled: [claude-code]` 已合法。缺少 `adapter_options` 时不需要改写，除非发生 refresh/transition。

### 16.3 Migration manifest

后续 migration manifest 必须包含 adapter：

```json
{
  "schema_version": 2,
  "profile": "general",
  "adapter": "claude-code",
  "bundle_version": "0.1.1",
  "bundle_manifest_hash": "sha256:0000000000000000000000000000000000000000000000000000000000000000",
  "projection": []
}
```

旧 schema 1 仅可解释为 Claude Code，不可套用到其他 Agent。

## 17. Push、Update 和文件策略

### 17.1 动态受管根

`push.ts` 不再写死 `MANAGED_ROOTS`。从已启用 Agent adapter 生成候选路径，但只收集 Harness 命名空间：

```text
.claude/skills/harness-*
.claude/rules/harness-*.md
.claude/agents/harness-*.md
.agents/skills/harness-*
.cursor/skills/harness-*
.cursor/rules/harness-*.mdc
.codebuddy/skills/harness-*
.codebuddy/agents/harness-*.md
AGENTS.md
CLAUDE.md
CODEBUDDY.md
```

Bundle working copies继续不上传，但 managed blocks、项目规则、knowledge 和 context index 按既有 policy 处理。ignore path 必须由受信资源 manifest 重新计算，不能直接相信 installed state。

### 17.2 文件策略新增

| 路径 | file_kind | push | update |
|---|---|---|---|
| `CODEBUDDY.md` | user_editable | diff-proposal | managed-block-only |
| `.agents/skills/harness-*` | user_editable | diff-proposal | skip-if-local-dirty |
| `.cursor/skills/harness-*` | user_editable | diff-proposal | skip-if-local-dirty |
| `.cursor/rules/harness-*.mdc` | user_editable | diff-proposal | skip-if-local-dirty |
| `.codebuddy/skills/harness-*` | user_editable | diff-proposal | skip-if-local-dirty |
| `.codebuddy/agents/harness-*.md` | user_editable | diff-proposal | skip-if-local-dirty |
| `.codebuddy/settings.json` | external_unmanaged（首期） | never | never |
| `.codex/config.toml`、`.codex/hooks.json` | external_unmanaged（首期） | never | never |

路径分类必须先通过 `normalizeManagedPath`，并补充大小写冲突测试。

## 18. 错误处理

新增稳定错误码：

```text
AGENTS_REQUIRED                 Agent 列表为空
AGENT_UNSUPPORTED              Agent 名未知
AGENT_OPTIONS_CONFLICT         --agents 与 --adapter 同时出现
CODEBUDDY_SURFACE_UNUSED       未选 CodeBuddy 却指定 surface
ADAPTER_BUNDLE_MISSING         离线 Agent Bundle 缺失
ADAPTER_BUNDLE_INVALID         manifest/schema/hash 无效
ADAPTER_SEMANTIC_INVALID       Bundle 含禁止路径、字段或能力调用
TARGET_COLLISION               两个投影生成同一路径但字节不同
MANAGED_BLOCK_CONFLICT         managed block 标记损坏
```

所有错误：

- 文本模式写入 stderr。
- JSON 模式写入 `errors[].code/message`。
- 配置错误退出码 `3`。
- Bundle 完整性或安全错误退出码 `7`。
- 失败时 transaction 回滚，不留下半套 Agent 文件。

若多个 Adapter 生成相同目标：

- 字节完全相同且 owner 可定义为 `shared`：去重。
- 字节不同：`TARGET_COLLISION`，整个安装失败。
- 禁止“后执行者覆盖前执行者”。

## 19. 安全要求

实现必须满足：

1. Bundle source 和 target 都通过 path traversal、绝对路径、驱动器路径、空段和大小写碰撞校验。
2. 不跟随 Bundle 内符号链接。
3. 不覆盖整个用户 `AGENTS.md`、`CLAUDE.md`、`CODEBUDDY.md`。
4. 不修改已有 `.codebuddy/settings.json`、`.codex/config.toml` 或任何 Hook 配置。
5. 不从 installed state 获取删除授权。
6. 不把未知 YAML/JSON/TOML 字段删除；本次不管理的配置文件完全不触碰。
7. 干运行不得创建 `.harness` 或任意 Agent 目录。
8. `--force-managed` 不能越过 adapter 的合法目标集合。
9. 第二次相同安装不得改变文件字节或重复 managed block。
10. 日志不得输出 token 环境变量的值。

## 20. 实现工作包

低成本模型必须按顺序完成。每个工作包结束后运行其定向测试；失败时停止，不得跳到后续包。

### WP1：契约与 CLI 解析

修改：

- `packages/contracts/src/project.ts`
- `packages/contracts/test/schemas.test.ts`
- `packages/cli/src/bin.ts`
- `packages/cli/src/config/init-config.ts`
- `packages/cli/src/commands/configure.ts`
- `packages/cli/test/init.test.ts`

产出：`HarnessAgent`、agents 数组、legacy normalization、多选解析、CodeBuddy surface。

验证：

```powershell
npx vitest run packages/contracts/test/schemas.test.ts packages/cli/test/init.test.ts
```

### WP2：Agent Bundle 编译

修改：

- `harness/scripts/harness_deploy.py`
- `harness/scripts/tests/test_harness_deploy.py`
- `scripts/sync-harness.mjs`
- 新增 `harness/adapters/**`

产出：2 profiles × 4 agents 的离线 Bundle 和 schema-v2 manifests。

验证：

```powershell
python harness/scripts/tests/test_harness_deploy.py
npm run sync:harness
```

随后运行语义扫描；任何非 Claude Bundle 命中 `.claude/` 都失败。

### WP3：Adapter projection 与初始化

修改：

- 新增 `packages/core/src/project/agent-adapters.ts`
- 拆分 `packages/core/src/project/profile-bundle.ts`
- 修改 `packages/core/src/project/initialize.ts`
- 修改 `packages/core/src/project/managed-content.ts`
- 修改 context-index 相关代码
- 增加相应 core tests

产出：四 Agent 单选与任意组合的确定性 desired state。

验证：

```powershell
npx vitest run packages/core/test/profile-bundle.test.ts packages/core/test/initialize.test.ts packages/cli/test/init.test.ts
```

### WP4：刷新、迁移和安全删除

修改：

- `packages/core/src/project/refresh.ts`
- migration schema/fixtures
- `packages/cli/src/commands/refresh.ts`
- refresh/migration/managed-block tests

产出：installed state v3、Agent 集合 transition、v2 Claude-only 迁移。

验证：

```powershell
npx vitest run packages/core/test/refresh.test.ts packages/core/test/migration.test.ts packages/core/test/managed-block-refresh.test.ts packages/cli/test/refresh-cli.test.ts
```

### WP5：Push、policy、update 联动

修改：

- `packages/core/src/push/push.ts`
- `packages/core/src/policy/file-policy.ts`
- context、update 和相关测试

产出：动态 managed roots、受信 Bundle ignore、四 Agent 文件策略。

验证：

```powershell
npx vitest run packages/core/test/file-policy.test.ts packages/cli/test/push.test.ts packages/cli/test/update.test.ts
```

### WP6：Pack smoke、文档和全量关门

修改：

- `README.md`
- `packages/cli/README.md`
- `scripts/smoke-pack.mjs`
- changelog

验证：

```powershell
npm run check
```

不得以单测通过代替 `npm run check`。

## 21. 测试与验收矩阵

### 21.1 配置与交互

| ID | 场景 | 预期 |
|---|---|---|
| CLI-001 | 交互空输入 | 只选 Claude Code |
| CLI-002 | 输入 `1,2,4` | Claude Code、Codex、CodeBuddy |
| CLI-003 | 输入 `all` | 四个 Agent，固定顺序 |
| CLI-004 | 输入重复项 | 去重 |
| CLI-005 | 含未知项 | 整体失败，不写文件 |
| CLI-006 | `--agents` 与 `--adapter` 同时出现 | exit 3 + `AGENT_OPTIONS_CONFLICT` |
| CLI-007 | legacy `--adapter cursor` | 只选 Cursor + warning |
| CLI-008 | 非交互无 Agent 参数 | 保持旧默认 Claude Code |
| CLI-009 | 未选 CodeBuddy 提供 surface | exit 3 |

### 21.2 单 Agent 安装

| ID | Agent | 必须存在 | 必须不存在 |
|---|---|---|---|
| INS-CLAUDE | Claude Code | `CLAUDE.md`、`.claude/skills`、`.claude/agents` | CodeBuddy/Cursor 目标 |
| INS-CODEX | Codex | `AGENTS.md`、`.agents/skills` | `.codex/commands`、`.codex/rules`、`.claude/skills` |
| INS-CURSOR | Cursor | `AGENTS.md`、`.cursor/skills`、`.cursor/rules/*.mdc` | `.cursor/rules/*.md`、`.claude/skills` |
| INS-CB | CodeBuddy | `CODEBUDDY.md`、`.codebuddy/skills`、`.codebuddy/agents` | `.codebuddy/settings.json`、双份 Rules |

### 21.3 多 Agent 组合

必须至少覆盖：

```text
[claude-code, codex]
[codex, cursor]
[claude-code, codex, cursor, codebuddy]
```

断言：

- 所有目标共存。
- `AGENTS.md` 共享块只有一个。
- context index 只包含已启用 Agent。
- installed state 每个 target 唯一。
- 二次执行相同命令文件 hash 不变；仅 `installed_at` 也不得无意义变化。若 desired state 无变化，refresh 不应重写 state。

### 21.4 Profile 与 Agent transition

覆盖：

```text
general -> java
java -> general
[claude] -> [claude,codex]
[claude,codex] -> [cursor,codebuddy]
```

每个场景同时测试 clean target 和 locally modified target。

### 21.5 语义验收

对所有生成 Skill 扫描：

- frontmatter 可解析。
- `name` 与目录同名。
- `description` 非空并包含触发信息。
- 非 Claude 文件无 `.claude/` 路径。
- Codex/Cursor 文件无强制未安装自定义 Agent 调用。
- CodeBuddy Agent 引用均能解析到真实文件。
- 相对链接和资源全部存在。
- 无未完成标记或模板占位符。

### 21.6 安全验收

必须复用并扩展现有 forged-state 测试：伪造 state 指向 `notes.txt`、`.env` 或绝对路径，refresh/transition 不得删除或覆盖。

## 22. 人工 smoke 验收

自动测试全部通过后，在临时 Git 仓库执行：

```powershell
npx .\hunter-harness-cli-0.2.0.tgz --agents all --profile general --non-interactive --yes
```

检查：

1. 四个 Agent 目录均存在。
2. `git status --short` 只显示预期文件。
3. 再执行一次相同命令，`git diff --exit-code` 为 0。
4. 修改一个 Codex Skill 后执行 refresh，文件被保留并报告 conflict。
5. 从 all 切到 cursor，其他 Agent 的干净 Harness 文件被移除，用户正文保留。
6. `--dry-run --json` 不创建任何文件，JSON 列出按 Agent 分组的 planned items。

若本机安装了对应 Agent，可附加执行各自的“列出/调用 `harness-review` Skill” smoke；未安装时标为 `NOT_RUN`，不得伪造通过。

## 23. 低成本模型执行协议

实现本设计时必须遵守：

1. 先读本设计、研究文档以及所有待修改文件的现状。
2. 每个工作包先写或修改测试，再改实现。
3. 不扩大范围，不新增第五种初始化 Agent。
4. 不猜测 Agent 格式；只使用本文矩阵和研究文档已确认字段。
5. 发现官方格式与本文冲突时停止，并报告链接、版本和冲突点。
6. 不覆盖用户文件；只操作 Harness managed block 和受信 Harness 路径。
7. 不修改任何 Hooks、permissions、MCP 或个人 settings。
8. 不使用批量字符串替换迁移 Skill 正文；逐个 Skill 检查语义。
9. 每完成一个工作包运行指定测试并记录 exit code。
10. 全量 `npm run check` 通过前不得声称完成。
11. 最终报告必须列出：修改文件、测试证据、未运行的真实 Agent smoke、已知降级。

停止条件：

- 需要未在官方资料中确认的新 frontmatter 字段。
- 需要修改 Hook/permission 配置才能实现核心流程。
- 发现用户文件存在无法安全合并的 malformed managed block。
- Bundle 目标发生不同字节碰撞。
- migration manifest 无法证明旧文件可信。

遇到停止条件时不得自行选择危险默认值。

## 24. 完成定义

只有同时满足以下条件才能关闭本改造：

- 四个 Agent 均能单独安装。
- 任意组合可安装，至少完成文中三组组合测试。
- 旧 Claude-only 项目可安全刷新到 v3。
- Agent 集合和 profile 均可安全 transition。
- 非 Claude Skill 已完成语义适配，不只是路径适配。
- 用户修改和用户正文得到保留。
- 默认没有 Hook、permission 或个人 settings 副作用。
- pack 后的离线安装包含全部 8 个 Bundle。
- `npm run check` exit 0。
- 文档、帮助文本和 JSON 输出与实际行为一致。

## 25. 参考资料

访问日期均为 2026-07-12：

- [OpenAI Codex：AGENTS.md](https://developers.openai.com/codex/guides/agents-md)
- [OpenAI Codex：Build skills](https://developers.openai.com/codex/skills)
- [OpenAI Codex：Advanced configuration / Hooks](https://developers.openai.com/codex/config-advanced#hooks)
- [Cursor：Rules](https://cursor.com/docs/rules)
- [Cursor：Agent Skills](https://cursor.com/docs/skills)
- [Cursor：Hooks](https://cursor.com/docs/hooks)
- [Cursor：Agent 最佳实践](https://cursor.com/blog/agent-best-practices)
- [CodeBuddy：目录结构](https://www.codebuddy.ai/docs/cli/codebuddy-dir)
- [CodeBuddy：Memory 与 Rules](https://www.codebuddy.ai/docs/cli/memory)
- [CodeBuddy：Skills](https://www.codebuddy.ai/docs/cli/skills)
- [CodeBuddy：Hooks](https://www.codebuddy.ai/docs/cli/hooks)
- [CodeBuddy：Sub-Agents](https://www.codebuddy.ai/docs/cli/sub-agents)
