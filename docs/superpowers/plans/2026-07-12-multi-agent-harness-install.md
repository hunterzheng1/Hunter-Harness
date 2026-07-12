# 多 Agent Harness 安装 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 `npx hunter-harness` 支持在同一项目中安装 claude-code / codex / cursor / codebuddy 四个 Agent 的任意组合，产物符合各 Agent 原生规范。

**Architecture:** 三层模型（canonical harness 源 → profile overlay → agent adapter）。Python `harness_deploy.py` 负责正文合成，Node `sync-harness.mjs` + 新增 `adapt-agent-bundle.mjs` 负责 frontmatter 重写、语义扫描和 schema-v2 manifest；TS 侧新增 `agent-adapters.ts` 描述符驱动 initialize/refresh/push，installed state 升 v3，context index 升 v2。

**Tech Stack:** TypeScript (Node 20+, zod v4, commander, vitest)、Python 3.10+ stdlib、npm workspaces。

**权威规格：** `docs/superpowers/specs/2026-07-12-multi-agent-harness-install-design.md`（下称 design）。本计划与 design 冲突时以 design 为准并停止报告。研究依据：`docs/research/2026-07-12-codex-cursor-codebuddy-agent-formats.md`。

---

## 执行铁律（每个任务都适用）

1. 先写测试 → 运行确认失败 → 实现 → 运行确认通过 → commit。禁止跳步。
2. 每个任务结束运行该任务的"验证"命令并记录 exit code；失败则停止修复，不得进入下一任务。
3. 不猜测 Agent frontmatter 字段；只用 design §7.3 和研究文档已确认字段。
4. 不修改任何 Hook、permission、MCP、个人 settings。
5. 不使用批量字符串替换迁移 Skill 正文；逐个 Skill 检查。
6. 遇到 design §23 停止条件时停止并报告，不选危险默认值。
7. 全部完成后必须 `npm run check` exit 0 才能宣称完成（WP6）。

## 文件结构总览

```text
packages/contracts/src/project.ts          改：harnessAgentSchema、initConfigSchema v2、adapter_options、+codebuddy
packages/cli/src/config/init-config.ts     改：agents 多选解析、legacy adapter normalization、surface 校验
packages/cli/src/bin.ts                    改：--agents、--codebuddy-surface；refresh 子命令 --agents
packages/cli/src/commands/configure.ts     改：交互多选菜单（Agent → profile 两问）
packages/cli/src/commands/refresh.ts       改：--agents 透传、渲染按 Agent 分组
harness/scripts/harness_deploy.py          改：--agent、agent skill overlay、agents/ 复制规则、SKIP adapters/
scripts/adapt-agent-bundle.mjs             新：frontmatter 重写 + 语义扫描（Node yaml）
scripts/sync-harness.mjs                   改：2×4 矩阵、bundles/<profile>/<agent> 新布局、manifest v2
harness/adapters/{claude-code,codex,cursor,codebuddy}/  新：skill-overlays/、（可选）agents/
packages/core/src/project/agent-adapters.ts 新：Adapter 描述符 + 能力矩阵 + 投影
packages/core/src/project/profile-bundle.ts 改：loadAgentBundle 新布局、manifest v2、migration v2
packages/core/src/project/managed-content.ts 改：per-agent 块内容 + cursor mdc 规则
packages/core/src/managed/managed-block.ts  改：refreshManagedBlockById（含 legacy 无 ID 升级）、removeManagedBlockById
packages/core/src/project/initialize.ts     改：多 Agent desired state、state v3、context index v2
packages/core/src/project/refresh.ts        改：Agent 集合 transition、v2/v1 迁移、动态剪枝边界
packages/core/src/push/push.ts              改：动态受管根 + 多 Agent ignore
packages/core/src/policy/file-policy.ts     改：CODEBUDDY.md、.agents/.cursor/.codebuddy 路径
scripts/smoke-pack.mjs                      改：8 Bundle 断言、多 Agent smoke
```

---

## Task 0：基线与分支

- [ ] **Step 1: 通读规格。** Read design 全文、研究文档全文，以及本计划涉及的每个"改"文件的现状。
- [ ] **Step 2: 建分支并确认基线绿。**

```powershell
git checkout -b feat/multi-agent-install
npx vitest run
```

预期：全部通过。记录测试数量作为基线。

---

## WP1：契约与 CLI 解析

### Task 1: contracts schema

**Files:**
- Modify: `packages/contracts/src/project.ts`
- Test: `packages/contracts/test/schemas.test.ts`

- [ ] **Step 1: 写失败测试。** 在 `schemas.test.ts` 追加：

```ts
import {
  harnessAgentSchema, HARNESS_AGENT_ORDER, sortHarnessAgents,
  initConfigSchema, projectConfigSchema, adapterNameSchema
} from "../src/project.js"; // 按该文件现有 import 路径风格调整

describe("multi-agent contracts", () => {
  it("harnessAgentSchema accepts exactly four agents", () => {
    for (const a of ["claude-code", "codex", "cursor", "codebuddy"]) {
      expect(harnessAgentSchema.parse(a)).toBe(a);
    }
    expect(() => harnessAgentSchema.parse("generic")).toThrow();
    expect(() => harnessAgentSchema.parse("mcp")).toThrow();
  });

  it("sortHarnessAgents dedupes and orders deterministically", () => {
    expect(sortHarnessAgents(["codebuddy", "claude-code", "codebuddy", "codex"]))
      .toEqual(["claude-code", "codex", "codebuddy"]);
  });

  it("initConfigSchema requires agents array and defaults codebuddy_surface", () => {
    const parsed = initConfigSchema.parse({ agents: ["codex", "cursor"], profile: "java" });
    expect(parsed.agents).toEqual(["codex", "cursor"]);
    expect(parsed.codebuddy_surface).toBe("both");
    expect(() => initConfigSchema.parse({ agents: [], profile: "java" })).toThrow();
    // 旧字段不得进入新 schema（strict）
    expect(() => initConfigSchema.parse({ adapter: "claude-code", profile: "java" })).toThrow();
  });

  it("adapterNameSchema now includes codebuddy and keeps legacy names", () => {
    for (const a of ["claude-code", "codex", "cursor", "codebuddy", "generic", "mcp"]) {
      expect(adapterNameSchema.parse(a)).toBe(a);
    }
  });

  it("projectConfigSchema accepts optional adapter_options.codebuddy.surface", () => {
    const base = {
      harness: { name: "hunter-harness", schema_version: 1 },
      project: { name: "x", root: ".", local_project_key: "018f6d00-0000-7000-8000-000000000000", project_id: null, profiles: ["general"] },
      server: { url: null, token_env: "HUNTER_HARNESS_TOKEN" },
      adapters: { enabled: ["claude-code", "codebuddy"] }
    };
    expect(projectConfigSchema.parse(base).adapter_options).toBeUndefined();
    const withOptions = { ...base, adapter_options: { codebuddy: { surface: "both" } } };
    expect(projectConfigSchema.parse(withOptions).adapter_options?.codebuddy.surface).toBe("both");
    expect(() => projectConfigSchema.parse({ ...base, adapter_options: { codebuddy: { surface: "web" } } })).toThrow();
  });
});
```

- [ ] **Step 2: 运行确认失败。** `npx vitest run packages/contracts/test/schemas.test.ts` — 预期 FAIL（符号不存在）。
- [ ] **Step 3: 实现。** 在 `packages/contracts/src/project.ts`：

```ts
export const HARNESS_AGENT_ORDER = ["claude-code", "codex", "cursor", "codebuddy"] as const;
export const harnessAgentSchema = z.enum(HARNESS_AGENT_ORDER);
export type HarnessAgent = z.infer<typeof harnessAgentSchema>;

export const codebuddySurfaceSchema = z.enum(["both", "ide", "cli"]);
export type CodeBuddySurface = z.infer<typeof codebuddySurfaceSchema>;

export function sortHarnessAgents(agents: readonly HarnessAgent[]): HarnessAgent[] {
  return HARNESS_AGENT_ORDER.filter((agent) => agents.includes(agent));
}

export const adapterNameSchema = z.enum([
  "claude-code", "codex", "cursor", "codebuddy", "generic", "mcp"
]);

export const initConfigSchema = z.object({
  agents: z.array(harnessAgentSchema).min(1),
  profile: z.enum(["general", "java"]),
  codebuddy_surface: codebuddySurfaceSchema.default("both"),
  server_url: httpsUrlSchema.nullable().optional(),
  token_env: tokenEnvSchema.nullable().optional(),
  project_id: projectIdSchema.nullable().optional(),
  features: z.object({
    codegraph_check: z.boolean().default(true),
    superpowers_check: z.boolean().default(true)
  }).strict().optional()
}).strict();
```

`projectConfigSchema` 追加（`.strict()` 对象内、`adapters` 之后）：

```ts
  adapter_options: z.object({
    codebuddy: z.object({ surface: codebuddySurfaceSchema }).strict()
  }).strict().optional()
```

- [ ] **Step 4: 运行通过。** `npx vitest run packages/contracts/test/schemas.test.ts` — 预期 PASS。此时 cli/core 可能类型报错，属预期，Task 2/7 修复；本任务只要求 contracts 测试绿。
- [ ] **Step 5: Commit。** `git add -A && git commit -m "feat(contracts): 多 Agent schema 与 adapter_options"`

### Task 2: init-config 多选解析与 legacy normalization

**Files:**
- Modify: `packages/cli/src/config/init-config.ts`
- Test: `packages/cli/test/init-config.test.ts`（新建；现有 init.test.ts 是端到端，本任务用单测覆盖解析逻辑）

- [ ] **Step 1: 写失败测试。** 新建 `packages/cli/test/init-config.test.ts`，覆盖 design §10.1 与 §21.1 CLI-001~009 的解析层部分：

```ts
import { describe, expect, it } from "vitest";
import { parseAgentsInput, resolveInitConfig, InitConfigurationError } from "../src/config/init-config.js";

describe("parseAgentsInput", () => {
  it.each([
    ["", ["claude-code"]],
    ["1", ["claude-code"]],
    ["1,2,4", ["claude-code", "codex", "codebuddy"]],
    ["claude-code,codex,codebuddy", ["claude-code", "codex", "codebuddy"]],
    ["all", ["claude-code", "codex", "cursor", "codebuddy"]],
    ["4,1,4", ["claude-code", "codebuddy"]],   // 去重 + 固定顺序
    [" 2 , 3 ", ["codex", "cursor"]]           // 去空白
  ])("parses %j", (input, expected) => {
    expect(parseAgentsInput(input)).toEqual(expected);
  });
  it("rejects any unknown token entirely", () => {
    expect(() => parseAgentsInput("codex,5")).toThrow(InitConfigurationError);
    expect(() => parseAgentsInput("gpt")).toThrow(InitConfigurationError);
  });
});

describe("resolveInitConfig agents/legacy/surface", () => {
  const cwd = process.cwd(); // 测试内用 mkdtemp 写临时 config JSON

  it("legacy adapter=claude-code normalizes with warning", async () => {
    // 写临时 config: {"adapter":"claude-code","profile":"general"}
    // 断言 config.agents == ["claude-code"]，且 warnings 含 deprecation
  });
  it("legacy adapter with non-claude value exits 3 AGENT_UNSUPPORTED", async () => {
    // config: {"adapter":"cursor",...} → 抛 InitConfigurationError，exitCode 3，code AGENT_UNSUPPORTED
  });
  it("agents and adapter in the same JSON exits 3 AGENT_OPTIONS_CONFLICT", async () => {
    // config: {"agents":["codex"],"adapter":"claude-code",...} → exitCode 3，code AGENT_OPTIONS_CONFLICT
  });
  it("surface without codebuddy exits 3 CODEBUDDY_SURFACE_UNUSED", async () => {
    // config: {"agents":["codex"],"codebuddy_surface":"ide",...} → exitCode 3
    // flags: { agents:"codex", codebuddySurface:"ide" } 同样报错
  });
  it("config file agents take precedence over --agents flag", async () => {
    // config agents=["codex"], flags.agents="cursor" → 结果 ["codex"]
  });
  it("non-interactive without agents keeps claude-code default", async () => {
    // flags 仅 profile → agents == ["claude-code"]
  });
});
```

（测试骨架内注释处写成真实断言：用 `mkdtemp` + `writeFile` 生成 config JSON，模式参考 `packages/cli/test/init.test.ts` 第 155-188 行的 config 用法。）

- [ ] **Step 2: 运行确认失败。** `npx vitest run packages/cli/test/init-config.test.ts`
- [ ] **Step 3: 实现。** 重写 `init-config.ts`：

```ts
import { HARNESS_AGENT_ORDER, harnessAgentSchema, sortHarnessAgents,
  initConfigSchema, type HarnessAgent, type InitConfig } from "@hunter-harness/contracts";

export interface InitFlagValues {
  agents?: string;            // --agents csv
  codebuddySurface?: string;  // --codebuddy-surface
  profile?: string;
  config?: string;
  serverUrl?: string;
  tokenEnv?: string;
}

export class InitConfigurationError extends Error {
  readonly exitCode: 3 | 7;
  readonly code: string;
  constructor(message: string, exitCode: 3 | 7 = 3, code = "INIT_CONFIG_INVALID", options?: ErrorOptions) {
    super(message, options);
    this.name = "InitConfigurationError";
    this.exitCode = exitCode;
    this.code = code;
  }
}

const AGENT_BY_INDEX: Record<string, HarnessAgent> = {
  "1": "claude-code", "2": "codex", "3": "cursor", "4": "codebuddy"
};

export function parseAgentsInput(raw: string): HarnessAgent[] {
  const trimmed = raw.trim();
  if (trimmed === "") return ["claude-code"];
  if (trimmed === "all") return [...HARNESS_AGENT_ORDER];
  const agents: HarnessAgent[] = [];
  for (const token of trimmed.split(",")) {
    const value = token.trim();
    const byIndex = AGENT_BY_INDEX[value];
    if (byIndex !== undefined) { agents.push(byIndex); continue; }
    const byName = harnessAgentSchema.safeParse(value);
    if (byName.success) { agents.push(byName.data); continue; }
    throw new InitConfigurationError(`未知 Agent：${value}`, 3, "AGENT_UNSUPPORTED");
  }
  if (agents.length === 0) throw new InitConfigurationError("Agent 列表为空", 3, "AGENTS_REQUIRED");
  return sortHarnessAgents(agents);
}
```

`resolveInitConfig` 新流程（保持"config file > flags > prompt > default"）：

1. 读 config JSON（现有逻辑不变）。
2. **legacy normalization（在 Zod 之前）**：若 `fileConfig.agents` 与 `fileConfig.adapter` 同时存在 → `AGENT_OPTIONS_CONFLICT` exit 3。仅有 `adapter`：值 `!== "claude-code"` → `AGENT_UNSUPPORTED` exit 3；否则等价 `agents: ["claude-code"]`，并通过新增的 `warnings: string[]` 输出参数（或回调）报告 deprecation。
3. **surface 前置校验（在 Zod default 之前）**：config 或 flags 显式给出 surface 但最终 agents 不含 `codebuddy` → `CODEBUDDY_SURFACE_UNUSED` exit 3。
4. agents 解析：`fileConfig.agents`（已是数组，直接走 schema）→ `flags.agents`（`parseAgentsInput`）→ 交互回调 `promptAgents()`（返回字符串再 `parseAgentsInput`）→ 默认 `["claude-code"]`。
5. profile 逻辑保持现状（`normalizeProfile` + `promptMissing`）。
6. `initConfigSchema.safeParse` 收口，失败 exit 7（现状不变）。

函数签名改为：

```ts
export interface InitPrompts {
  agents?: () => Promise<string>;
  profile?: () => Promise<string>;
}
export async function resolveInitConfig(
  cwd: string, flags: InitFlagValues, prompts: InitPrompts = {}, warnings: string[] = []
): Promise<InitConfig>
```

- [ ] **Step 4: 运行通过。** `npx vitest run packages/cli/test/init-config.test.ts`
- [ ] **Step 5: Commit。** `git commit -am "feat(cli): agents 多选解析与 legacy adapter 兼容"`

### Task 3: bin.ts / configure.ts 交互与参数

**Files:**
- Modify: `packages/cli/src/bin.ts`（全局 option `--agents <csv>`、`--codebuddy-surface <surface>`；refresh 子命令加 `--agents <csv>`）
- Modify: `packages/cli/src/commands/configure.ts`
- Test: `packages/cli/test/init.test.ts`

- [ ] **Step 1: 写失败测试。** 在 `init.test.ts` 追加（沿用文件内既有 `run()` helper）：

```ts
it("interactive first install asks agents then profile", async () => {
  const answers = ["1,2", ""];           // Agent 多选 → profile 默认 general
  const questions: string[] = [];
  const code = await runCli([], {
    cwd: root, resourcesRoot,
    stdout: (v) => stdout.push(v), stderr: (v) => stderr.push(v),
    prompt: async (q) => { questions.push(q); return answers.shift() ?? ""; }
  });
  expect(code).toBe(0);
  expect(questions[0]).toContain("请选择目标 Agent");
  expect(questions[1]).toContain("请选择 Harness 类型");
  const project = parseYaml(await readFile(join(root, ".harness", "project.yaml"), "utf8")) as
    { adapters: { enabled: string[] } };
  expect(project.adapters.enabled).toEqual(["claude-code", "codex"]);
});

it("non-interactive --agents all installs four agents", async () => {
  const code = await run(["--agents", "all", "--profile", "general", "--non-interactive", "--yes"]);
  expect(code).toBe(0);
  const project = parseYaml(await readFile(join(root, ".harness", "project.yaml"), "utf8")) as
    { adapters: { enabled: string[] } };
  expect(project.adapters.enabled).toEqual(["claude-code", "codex", "cursor", "codebuddy"]);
});

it("rejects unknown agent without writing files", async () => {
  const code = await run(["--agents", "codex,gpt", "--profile", "general", "--non-interactive", "--yes"]);
  expect(code).toBe(3);
  expect(await pathExists(join(root, ".harness"))).toBe(false);
});

it("rejects --codebuddy-surface when codebuddy not selected", async () => {
  const code = await run(["--agents", "codex", "--codebuddy-surface", "ide",
    "--profile", "general", "--non-interactive", "--yes"]);
  expect(code).toBe(3);
  expect(stderr.join(" ")).toContain("CODEBUDDY_SURFACE_UNUSED");
});
```

同时更新既有用例 `maps interactive profile input`：交互流程现在先问 Agent，prompt mock 需按提问内容分流（`q.includes("Agent") ? "" : answer`）。

- [ ] **Step 2: 运行确认失败。** `npx vitest run packages/cli/test/init.test.ts`
- [ ] **Step 3: 实现。**
  - `bin.ts`：主命令与 `refresh` 子命令均加 `.option("--agents <csv>")`；主命令加 `.option("--codebuddy-surface <surface>")`（commander 自动映射为 `options.codebuddySurface`）。
  - `configure.ts` `runFirstInstall`：交互模式下传入两个 prompt 回调，文案取自 design §1：

```ts
const config = await resolveInitConfig(dependencies.cwd, options, options.nonInteractive === true ? {} : {
  agents: () => dependencies.prompt(
    "请选择目标 Agent（可多选，使用逗号分隔）\n" +
    "1. Claude Code\n2. Codex\n3. Cursor\n4. CodeBuddy\n请输入编号 [1]: "
  ).then((a) => a.trim()),
  profile: () => dependencies.prompt(
    "请选择 Harness 类型：\n1. 通用（默认）\n2. Java\n请输入 1 或 2 [1]: "
  ).then((a) => a.trim())
}, warnings);
```

  - catch 分支：`InitConfigurationError` 时 stderr 输出 `error.code + ": " + message`，JSON 模式 `errors: [{ code, message }]`（对齐 design §18）。
  - warnings 数组内容写入 CLI 输出的 `warnings` 字段与 stderr。
- [ ] **Step 4: 运行 WP1 全部验证。**

```powershell
npx vitest run packages/contracts/test/schemas.test.ts packages/cli/test/init-config.test.ts packages/cli/test/init.test.ts
```

注意：此时 `initializeProject` 仍是单 Agent 实现，`init.test.ts` 里新的多 Agent 断言（installed 文件存在性等）尚不能全绿——**只把 project.yaml/agents 解析层断言放本任务**，投影类断言放 Task 8 再加。若无法只靠解析层让测试独立成立，可在本任务先让 `configure.ts` 把 `config.agents[0]` 传给现有 `initializeProject`（临时桥接，claude-code 行为不变），并在 Task 8 移除桥接。
- [ ] **Step 5: Commit。** `git commit -am "feat(cli): 首次安装 Agent 多选交互与 --agents/--codebuddy-surface"`

---

## WP2：Agent Bundle 编译

### Task 4: harness_deploy.py 增加 --agent

**Files:**
- Modify: `harness/scripts/harness_deploy.py`
- Test: `harness/scripts/tests/test_harness_deploy.py`

- [ ] **Step 1: 写失败测试。** 在 `test_harness_deploy.py` 追加 unittest 用例（沿用 `_fixture_root` 模式，fixture 内建 `adapters/codex/skill-overlays/harness-demo.overlay.md` 与 `agents/demo-agent.md`）：
  - `test_agent_flag_applies_adapter_overlay`：`cmd_build(..., agent="codex")` 后输出 SKILL.md 含 overlay 覆写内容。
  - `test_agents_dir_copied_only_for_claude_and_codebuddy`：`agent="codex"`/`"cursor"` 输出无 `agents/`；`"claude-code"`/`"codebuddy"` 有。
  - `test_adapters_dir_never_copied_into_bundle`：任何 agent 输出中不存在 `adapters/` 目录。
  - `test_missing_agent_defaults_claude_with_warning`：`agent=None` 行为等同 `claude-code` 且 stderr 含 `deprecat`。
  - `test_unknown_agent_rejected`：`agent="gpt"` 抛 `ValueError`。
- [ ] **Step 2: 运行确认失败。** `python harness/scripts/tests/test_harness_deploy.py` — 预期 FAIL/ERROR。
- [ ] **Step 3: 实现。**
  - `SKIP_DIR_NAMES` 加 `"adapters"`。
  - 常量 `HARNESS_AGENTS = ("claude-code", "codex", "cursor", "codebuddy")`。
  - `cmd_build(skills_root, out_dir, overlay, agent)`：
    - `agent is None` → `agent = "claude-code"` + `print("WARNING: --agent missing, defaulting to claude-code (deprecated)", file=sys.stderr)`。
    - `agent not in HARNESS_AGENTS` → `raise ValueError(f"unknown agent: {agent}")`。
    - agent overlay 目录：`skills_root / "adapters" / agent / "skill-overlays"`（可不存在）。`process_skill_md` 增加第二个 overlay 参数：profile overlay 应用后、注入 header 前再应用 agent overlay（同一 `apply_overlay_blocks` 机制；agent overlay 的 section-id 解析基于 profile overlay 之后的文本重新 `parse_section_ids`）。
    - `agents/` 复制：`copy_tree` 不再无条件复制 `agents/`（在 `iter_copy_entries` 处按 agent 过滤，或复制后对 codex/cursor 删除 staging 内 `agents/`——选前者，避免删除逻辑）。之后若 `adapters/<agent>/agents/` 存在，逐文件 `shutil.copy2` 覆盖 staging `agents/` 同名文件。
    - `synthesis_header` 与 build marker 增加 `agent=<name>` 字段，`core_content_hash` 把 agent overlay 目录纳入哈希输入（保持确定性）。
  - argparse：`build` 子命令加 `b.add_argument("--agent", choices=HARNESS_AGENTS)`，`main` 透传。
- [ ] **Step 4: 运行通过。** `python harness/scripts/tests/test_harness_deploy.py` — 预期 OK。
- [ ] **Step 5: Commit。** `git commit -am "feat(harness): harness_deploy 支持 --agent 与 adapter overlay"`

### Task 5: adapt-agent-bundle.mjs（frontmatter + 语义扫描）

**Files:**
- Create: `scripts/adapt-agent-bundle.mjs`
- Test: `tests/adapt-agent-bundle.test.ts`（vitest 已 include `tests/**/*.test.ts`）

- [ ] **Step 1: 写失败测试。** 用 `mkdtemp` 构造假 bundle 目录（`harness-demo/SKILL.md` 带 Claude 全字段 frontmatter + 含 `.claude/rules/` 的正文；`agents/demo.md` 带 `model/effort/maxTurns/memory/tools` 字段），断言：

```ts
import { adaptBundleDir } from "../scripts/adapt-agent-bundle.mjs";

it("codex skill keeps only name+description and body must be clean", async () => {
  // 正文不含 .claude/ 时：
  const report = await adaptBundleDir(dir, "codex");
  const text = await readFile(join(dir, "harness-demo", "SKILL.md"), "utf8");
  const fm = text.split("---")[1];
  expect(fm).toContain("name:");
  expect(fm).toContain("description:");
  expect(fm).not.toContain("allowed-tools");
  expect(report.rewritten).toContain("harness-demo/SKILL.md");
});
it("claude-code bundle is byte-identical passthrough", async () => { /* 前后 sha 相等 */ });
it("fails when non-claude body references .claude/", async () => {
  await expect(adaptBundleDir(dirWithClaudePath, "codex")).rejects.toThrow(/\.claude\//);
});
it("fails when codex/cursor body requires custom agent spawn", async () => {
  // 正文含 "subagent_type: harness-reviewer" → reject
});
it("fails when skill dir name != frontmatter name or description empty", async () => { /* ... */ });
it("codebuddy agents keep only confirmed fields", async () => {
  // agents/demo.md 输出 frontmatter 仅含 name/description/permissionMode/skills
});
it("fails on unresolved include or {{ placeholder", async () => { /* ... */ });
```

- [ ] **Step 2: 运行确认失败。** `npx vitest run tests/adapt-agent-bundle.test.ts`
- [ ] **Step 3: 实现 `scripts/adapt-agent-bundle.mjs`。** 核心结构：

```js
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

const SKILL_ALLOW = {
  "claude-code": null,                       // null = passthrough（仅校验可解析）
  codex: ["name", "description"],
  cursor: ["name", "description"],
  codebuddy: ["name", "description"]
};
const AGENT_FILE_ALLOW = {
  "claude-code": null,
  codebuddy: ["name", "description", "permissionMode", "skills"]
};
const FORBIDDEN_BODY = {
  shared: [".claude/rules/", ".claude/agents/", ".claude/skills/", "<!-- @include", "{{"],
  codex: ["subagent_type: harness-", "spawn `harness-"],
  cursor: ["subagent_type: harness-", "spawn `harness-"]
};

function splitFrontmatter(text) { /* 严格：必须以 --- 开头且有闭合 ---，否则 throw */ }
function rewriteFrontmatter(text, allow) {
  const { frontmatter, body } = splitFrontmatter(text);
  const data = parseYaml(frontmatter);            // 解析失败即 throw
  if (allow === null) return { text, name: data.name, description: data.description };
  const kept = {};
  for (const key of allow) if (data[key] !== undefined) kept[key] = data[key];
  return { text: `---\n${stringifyYaml(kept)}---\n${body}`, name: kept.name, description: kept.description };
}
export async function adaptBundleDir(dir, agent) { /* 遍历 harness-*/SKILL.md 与 agents/*.md，
  重写 + 校验 name==目录名 + description 非空 + 禁止串扫描（正文与 frontmatter 序列化结果都扫），
  返回 { rewritten: string[], validated: string[] } */ }
```

注意：claude-code 也要跑禁止串中的 `<!-- @include` 与 `{{` 检查，但跳过 `.claude/` 路径与 spawn 检查。
- [ ] **Step 4: 运行通过。** `npx vitest run tests/adapt-agent-bundle.test.ts`
- [ ] **Step 5: Commit。** `git commit -am "feat(build): Node 侧 Agent frontmatter 重写与语义扫描"`

### Task 6: canonical 中性化 + adapter overlays + sync-harness 矩阵

**Files:**
- Modify: `harness/harness-*/SKILL.md`（仅命中扫描的文件）、`harness/shared/*.md`（若命中）
- Create: `harness/adapters/{claude-code,codex,cursor,codebuddy}/skill-overlays/*.overlay.md`（按需）
- Modify: `scripts/sync-harness.mjs`
- Delete (git rm): `resources/harness/general/`、`resources/harness/java/`、`resources/harness/manifests/general.json`、`resources/harness/manifests/java.json`（旧布局构建产物，git 可恢复；`resources/harness/migrations/` 保留）

- [ ] **Step 1: 改造 sync-harness.mjs。**

```js
const PROFILES = ["general", "java"];
const AGENTS = ["claude-code", "codex", "cursor", "codebuddy"];
// out: resources/harness/bundles/<profile>/<agent>
// python 参数：build --skills-root harness --out <out> --agent <agent> [--overlay java] --json
// 构建后：await adaptBundleDir(out, agent)
// manifest: resources/harness/manifests/<profile>/<agent>.json：
// { schema_version: 2, profile, adapter: agent, bundle_version: "0.2.0",
//   generator: "harness_deploy.py", files: [...] }   // files 在 adapt 之后哈希
```

- [ ] **Step 2: 生成清单驱动的内容修复循环。** 运行 `npm run sync:harness`。语义扫描会报出所有违规文件（预期首轮失败：`harness-review`、`harness-plan`、`harness-sync` 等含 `.claude/rules/`、spawn 指令；见 design §5.7）。对每个命中逐一处理，**禁止全局替换**：
  - frontmatter `description` 含 `.claude/rules/` → 修改 canonical 描述为路径中性（如"对照项目规则（由 .harness/context-index.json 路由）"）。Claude 语义不损失（正文仍有细节）。
  - 正文 `.claude/rules/` 引用 → canonical 改为"项目规则（见 `.harness/context-index.json` 的 `adapters.<agent>.rules`）"；若 Claude 需要保留原路径，写 `harness/adapters/claude-code/skill-overlays/<skill>.overlay.md` 用 `@override section-id` 恢复 Claude 专属段落。
  - 自定义 Agent 委派段落（`harness-review` Workflow 步骤 2、`harness-plan` 等）→ 为 codex 与 cursor 各写 overlay，把该 section 覆写为 design §7.4.3 的语义："若当前运行时支持隔离子任务则可委派，否则在主会话按同一检查清单执行"，并删除 `harness_preflight.py check-agents` 对自定义 agent 的强制依赖。CodeBuddy 保留委派（有 `.codebuddy/agents/`）。
  - 若目标 section 无 `@section-id` 标记，先在 canonical SKILL.md 中给该标题加 `<!-- @section-id <skill>-<slug> -->`。
- [ ] **Step 3: 循环直到 `npm run sync:harness` exit 0。** 每轮修复后重跑。产物检查：

```powershell
npm run sync:harness
python harness/scripts/tests/test_harness_deploy.py
```

预期：`resources/harness/bundles/` 下 2×4=8 个目录、`manifests/{general,java}/` 各 4 个 JSON；codex/cursor bundle 无 `agents/`；`Select-String -Path resources/harness/bundles/*/codex/**/*.md -Pattern "\.claude/"` 无命中。
- [ ] **Step 4: 移除旧布局产物。** `git rm -r resources/harness/general resources/harness/java resources/harness/manifests/general.json resources/harness/manifests/java.json`（保留 `migrations/`）。注意：core 的 `loadProfileBundle` 此时仍指向旧布局，会导致 core/cli 测试暂红——Task 7 立即修复；本任务 commit 允许仅 WP2 验证绿。
- [ ] **Step 5: Commit。** `git commit -am "feat(harness): 2x4 Agent Bundle 矩阵与语义适配 overlay"`

---

## WP3：Adapter projection 与初始化

### Task 7: agent-adapters.ts + Bundle 加载新布局

**Files:**
- Create: `packages/core/src/project/agent-adapters.ts`
- Modify: `packages/core/src/project/profile-bundle.ts`
- Modify: `packages/core/src/project/managed-content.ts`
- Test: `packages/core/test/agent-adapters.test.ts`（新建）、`packages/core/test/profile-bundle.test.ts`

- [ ] **Step 1: 写失败测试。** `agent-adapters.test.ts`：

```ts
import { getAdapter, HARNESS_AGENT_ORDER } from "../src/project/agent-adapters.js";

it("every adapter reports no executable hooks", () => {
  for (const name of HARNESS_AGENT_ORDER) {
    expect(getAdapter(name).supportsExecutableHooks).toBe(false);
  }
});
it("claude-code projects agents/ to .claude/agents and rest to .claude/skills", () => { /* 用假 bundle */ });
it("codex projects everything to .agents/skills and has no rules", () => { /* rulesRoot null，contextIndex.rules == [] */ });
it("cursor emits .mdc rules and .cursor/skills targets", () => {
  // managedTargetsFor(adapter, ctx) 含 .cursor/rules/harness-general.mdc；java ctx 追加 harness-profile-java.mdc
  // mdc 内容以 "---\n" 开头且含 "alwaysApply: true"
});
it("codebuddy both surface projects skills+agents and no rules files", () => { /* ... */ });
it("pruneBoundaries stay inside own root", () => { /* codex → [".agents/skills"] 等 */ });
```

`profile-bundle.test.ts`：更新为新布局——`loadAgentBundle(resourcesRoot, profile, agent)` 读 `manifests/<profile>/<agent>.json`（schema_version 2、`adapter` 字段校验）与 `bundles/<profile>/<agent>/`；保留全部现有安全测试（路径校验、hash 校验、大小写冲突）改为新签名。
- [ ] **Step 2: 运行确认失败。** `npx vitest run packages/core/test/agent-adapters.test.ts packages/core/test/profile-bundle.test.ts`
- [ ] **Step 3: 实现。**
  - `profile-bundle.ts`：`ProfileBundleManifest` → `AgentBundleManifestV2`（design §8）；`loadProfileBundle(resourcesRoot, profile)` 改名/重载为 `loadAgentBundle(resourcesRoot, profile, agent)`；`projectBundle` 移入 adapter；`parseMigrationManifest` 增加 schema 2 分支（含 `adapter` 字段，schema 1 视为 `adapter: "claude-code"`，target 前缀校验按 adapter 的合法根，schema 1 仍限 `.claude/`）。
  - `agent-adapters.ts`（核心，数据表驱动，禁止 if-else 链）：

```ts
import type { HarnessAgent, CodeBuddySurface } from "@hunter-harness/contracts";
import { HARNESS_AGENT_ORDER } from "@hunter-harness/contracts";

export interface AdapterContext {
  profile: "general" | "java";
  codebuddySurface: CodeBuddySurface;
}
export interface AdapterContextIndexEntry {
  instructions: string;
  skills_root: string;
  rules: string[];
}
export interface HarnessAgentAdapter {
  readonly name: HarnessAgent;
  readonly skillsRoot: string;
  readonly rulesRoot: string | null;
  readonly agentsRoot: string | null;
  readonly commandsRoot: string | null;
  readonly supportsExecutableHooks: false;
  projectInstructionTargets(context: AdapterContext): readonly string[];
  projectBundle(bundle: LoadedAgentBundle, context: AdapterContext): readonly ProjectedBundleFile[];
  contextIndex(context: AdapterContext): AdapterContextIndexEntry;
  pruneBoundaries(context: AdapterContext): readonly string[];
}

const TABLE = {
  "claude-code": { skillsRoot: ".claude/skills", rulesRoot: ".claude/rules",
    agentsRoot: ".claude/agents", commandsRoot: null, instructions: "CLAUDE.md",
    ruleExt: ".md", extraInstructionFiles: ["CLAUDE.md"] },
  codex: { skillsRoot: ".agents/skills", rulesRoot: null, agentsRoot: null,
    commandsRoot: null, instructions: "AGENTS.md", ruleExt: null, extraInstructionFiles: [] },
  cursor: { skillsRoot: ".cursor/skills", rulesRoot: ".cursor/rules", agentsRoot: null,
    commandsRoot: ".cursor/commands", instructions: "AGENTS.md", ruleExt: ".mdc", extraInstructionFiles: [] },
  codebuddy: { skillsRoot: ".codebuddy/skills", rulesRoot: null, agentsRoot: ".codebuddy/agents",
    commandsRoot: ".codebuddy/commands", instructions: "CODEBUDDY.md", ruleExt: null,
    extraInstructionFiles: ["CODEBUDDY.md"] }
} as const;

export function getAdapter(name: HarnessAgent): HarnessAgentAdapter { /* 由 TABLE 构造 */ }
export function getAdapters(names: readonly HarnessAgent[]): HarnessAgentAdapter[] {
  return HARNESS_AGENT_ORDER.filter((n) => names.includes(n)).map(getAdapter);
}
```

  投影通用函数：`agents/<name>.md` → `agentsRoot` 非 null 时 `<agentsRoot>/<name>.md`，否则跳过（codex/cursor bundle 本就无 agents，双保险）；其余 → `<skillsRoot>/<source_path>`；rules 由 `managedTargetsFor(adapter, ctx)` 追加（claude `.md` 用现有正文；cursor `.mdc` 用带 frontmatter 的新常量）。全部走既有 `normalizeManagedPath` + `assertNoCaseCollisions`。
  命名说明：design §6.1 提到的 `project-bundle.ts`（source → target 投影）职责由 adapter 的 `projectBundle` 方法 + 本文件的共享投影 helper 承担；若共享 helper 变多可拆出 `project-bundle.ts`，两种落法都符合 design 的模块边界要求。
  - `managed-content.ts` 新增：

```ts
export const AGENTS_CORE_BLOCK_ID = "hunter-harness-core";
export const CLAUDE_BLOCK_ID = "hunter-harness-claude-code";
export const CODEBUDDY_BLOCK_ID = "hunter-harness-codebuddy";
export const AGENTS_MANAGED_BLOCK_CONTENT = [
  "# Hunter Harness", "",
  "Use `.harness/context-index.json` to locate the instructions, skills, knowledge,",
  "and codebase map for the active agent.",
  "Treat installed `harness-*` skills as editable adapter working copies.",
  "Do not modify `.harness/state` or `.harness/cache` directly."
].join("\n");
// CLAUDE_MANAGED_BLOCK_CONTENT 保持现有字节不变（design §11.1）
export const CODEBUDDY_MANAGED_BLOCK_CONTENT = [
  "# Hunter Harness", "",
  "Use `.harness/context-index.json` to locate the instructions, skills, knowledge,",
  "and codebase map for the active agent.",
  "Treat installed `harness-*` skills as editable adapter working copies.",
  "Do not modify `.harness/state` or `.harness/cache` directly.", "",
  "- Skills: .codebuddy/skills/harness-*/",
  "- Agents: .codebuddy/agents/harness-*.md",
  "- Knowledge: .harness/knowledge/",
  "- Codebase map: .harness/codebase/map/"
].join("\n");
export const CURSOR_GENERAL_RULES_CONTENT =
  "---\ndescription: Hunter Harness project-wide safety and evidence rules\nglobs:\nalwaysApply: true\n---\n\n" +
  "# Hunter Harness Rules\n\n- Report evidence honestly.\n- Do not execute destructive actions without confirmation.\n";
export const CURSOR_JAVA_RULES_CONTENT =
  "---\ndescription: Hunter Harness Java profile rules\nglobs:\nalwaysApply: true\n---\n\n" +
  "# Java Profile\n\n- Verify builds and tests with the project build tool.\n";
```

- [ ] **Step 4: 运行通过。** `npx vitest run packages/core/test/agent-adapters.test.ts packages/core/test/profile-bundle.test.ts`
- [ ] **Step 5: Commit。** `git commit -am "feat(core): Agent adapter 描述符与 Bundle v2 加载"`

### Task 8: managed-block ID 升级 + initialize 多 Agent

**Files:**
- Modify: `packages/core/src/managed/managed-block.ts`
- Modify: `packages/core/src/project/initialize.ts`
- Modify: `packages/cli/src/commands/configure.ts`（移除 Task 3 的临时桥接）
- Test: `packages/core/test/managed-block.test.ts`、`packages/core/test/initialize.test.ts`、`packages/cli/test/init.test.ts`

- [ ] **Step 1: 写失败测试。**
  - `managed-block.test.ts` 追加：

```ts
it("refreshManagedBlockById upgrades a legacy no-id block in place", () => {
  const original = "user text\n\n<!-- hunter-harness:start -->\nold\n<!-- hunter-harness:end -->\n";
  const result = refreshManagedBlockById(original, "hunter-harness-core", "new", { upgradeLegacy: true });
  expect(result.conflict).toBe(false);
  expect(result.content).toContain("<!-- hunter-harness:start id=hunter-harness-core -->");
  expect(result.content).not.toMatch(/<!-- hunter-harness:start -->/);   // 旧无 ID 标记消失
  expect((result.content.match(/hunter-harness:start/g) ?? []).length).toBe(1);
  expect(result.content).toContain("user text");
});
it("malformed legacy markers preserve file and report conflict", () => { /* 重复 start → conflict:true, content===original */ });
it("removeManagedBlockById removes only the given id block", () => { /* ... */ });
```

  - `initialize.test.ts` 追加多 Agent 场景（直接调 `initializeProject`，config 用 `agents` 数组）：
    - INS-CODEX：`agents: ["codex"]` → 存在 `AGENTS.md`、`.agents/skills/harness-review/SKILL.md`；不存在 `CLAUDE.md` 新增块、`.claude/`、`.codex/`。
    - INS-CURSOR：存在 `.cursor/rules/harness-general.mdc`（内容以 `---` 开头）、`.cursor/skills/`；不存在 `.cursor/rules/*.md`。
    - INS-CB：存在 `CODEBUDDY.md`（含 id 块）、`.codebuddy/skills/`、`.codebuddy/agents/harness-reviewer.md`；不存在 `.codebuddy/settings.json`、`.codebuddy/rules/`。
    - 组合 `["claude-code","codex","cursor","codebuddy"]`：全部共存；`AGENTS.md` 中 `hunter-harness:start` 恰一次；context index `schema_version === 2` 且 `project.adapters` 与 `skill_bundles` 的 key 恰为四个 agent；installed state `schema_version === 3`、`files[].owner` 覆盖各 agent、target 唯一。
    - 幂等：同 config 连跑两次，除 `installed_at` 外全部文件字节相同（对每个受管文件断言 hash 相等）。
  - `init.test.ts`：把 Task 3 延后的投影断言补上（`--agents all` 后四目录存在等），并更新既有 java/general byte-for-byte 用例读取路径为 `resources/harness/bundles/<profile>/claude-code`。
- [ ] **Step 2: 运行确认失败。**
- [ ] **Step 3: 实现。**
  - `managed-block.ts`：新增

```ts
export interface ManagedBlockByIdRefresh { content: string; action: ManagedBlockAction; conflict: boolean; }
export function refreshManagedBlockById(
  original: string, id: string, blockContent: string,
  options: { upgradeLegacy?: boolean } = {}
): ManagedBlockByIdRefresh
// 逻辑：id 块存在 → 替换；不存在且 upgradeLegacy 且存在合法无 ID 块 → 用 id 标记原位替换整块；
// 无任何块 → 追加；无 ID 标记畸形 → conflict（content=original）。
export function removeManagedBlockById(original: string, id: string): string
```

  - `initialize.ts`：
    - `InitializeProjectOptions.config` 用新 `InitConfig`（agents 数组）。
    - 每个启用 agent：`loadAgentBundle` + `adapter.projectBundle` + rules 目标 → 合并入 `files` Map；写前对同 target 校验：字节相同 → owner `shared` 去重；不同 → 抛 `TARGET_COLLISION`（`InitConfigurationError` 等价的 core error，exit 7 由 CLI 层映射）。
    - 指令文件：`AGENTS.md` 恒写 `hunter-harness-core` id 块（`upsertManagedBlockById`）；claude 启用 → `CLAUDE.md` id 块；codebuddy 启用 → `CODEBUDDY.md` id 块。
    - `project.yaml`：`adapters.enabled = sortHarnessAgents(config.agents)`；codebuddy 启用时写 `adapter_options: { codebuddy: { surface: config.codebuddy_surface } }`。
    - context index v2：完全按 design §13 构造（只含启用 agent；每个 agent 的 `skill_bundles` 记录该 agent bundle 的 `registry_version`/`bundle_hash`；key 顺序用固定构造顺序）。
    - installed state v3：按 design §14 的接口与排序规则（`manifests` 按 Agent 固定顺序；`files` 按 target 再 source；`managed_blocks` 按 target 再 block_id；块记录 `content_sha256 = sha256(块正文)`）。
  - `configure.ts`：移除临时桥接，传完整 config。
- [ ] **Step 4: 运行通过。**

```powershell
npx vitest run packages/core/test/managed-block.test.ts packages/core/test/initialize.test.ts packages/core/test/profile-bundle.test.ts packages/cli/test/init.test.ts
```

- [ ] **Step 5: Commit。** `git commit -am "feat(core): 多 Agent 初始化投影、state v3 与 context index v2"`

---

## WP4：刷新、迁移和安全删除

### Task 9: refresh 多 Agent 协调与 transition

**Files:**
- Modify: `packages/core/src/project/refresh.ts`
- Test: `packages/core/test/refresh.test.ts`、`packages/core/test/migration.test.ts`、`packages/core/test/managed-block-refresh.test.ts`

- [ ] **Step 1: 写失败测试。** 覆盖 design §15/§16/§21.4/§21.6：
  - `RefreshOptions` 增加 `agents: HarnessAgent[]`（desired 集合）与 `codebuddySurface`。
  - transition `[claude-code] → [claude-code, codex]`：codex 目标全部 add；claude 目标 unchanged；`AGENTS.md` 共享块保留一个。
  - transition `[claude-code, codex] → [cursor, codebuddy]`：claude/codex 干净目标 delete，`CLAUDE.md` 仅移除 managed block（用户正文保留，文件不删）；被用户改过的 `.claude/skills/...` preserve + conflict；`.agents/skills` 干净删除后 `.agents/skills` 目录本身保留为空或剪除到边界（断言 `.agents` 顶层仍存在与否遵循边界规则：只剪 `harness-*` 子树）。
  - v2 state（`schema_version: 2`，现有 fixture）+ desired `[claude-code]` → 正常刷新并写出 v3，`owner: "claude-code"`，AGENTS/CLAUDE 无 ID 块被原位升级为 id 块（文件中 `hunter-harness:start` 仍恰一次）。
  - v1 state + 0.1.1 migration manifest → 行为与现状测试等价（迁移路径回归）。
  - forged-state：伪造 v3 state `files` 指向 `notes.txt`、`.env`、绝对路径 → 刷新后文件原样（扩展现有 forged 测试到 v3）。
  - 幂等：desired 无变化的 refresh 不重写 installed state（对比刷新前后 state 文件 mtime/字节，`installed_at` 不变）。
  - profile transition `general → java`（多 Agent 启用下）：每个启用 agent 的 java-only 目标新增、general-only 干净目标删除。
- [ ] **Step 2: 运行确认失败。**
- [ ] **Step 3: 实现要点。**
  - state 读取：v3（`adapters`、`files[].owner`、`managed_blocks`）→ trusted map；v2 → `adapters=["claude-code"]`；v1 → 现有 migration 路径不变。
  - desired = `options.agents`（来自 CLI/`project.yaml`）；old = state.adapters（v3）或 `["claude-code"]`（v2/v1）。
  - `newManaged` = 各 desired adapter 的 `managedTargetsFor` 合并（TARGET_COLLISION 校验同 initialize）。
  - `oldOnly` = 各 old adapter（用**当前受信 Bundle** 重算投影，绝不用 state 路径）∪ 迁移 manifest 投影，减去 new target 集。
  - managed blocks：`AGENTS.md` core 块任一 agent 启用即 refresh（`refreshManagedBlockById(..., { upgradeLegacy: true })`）；`CLAUDE.md`：claude ∈ desired → refresh（含 legacy 升级），claude ∈ old − desired → `removeManagedBlockById`（含 legacy：无 ID 合法块也移除）；`CODEBUDDY.md` 同理。全部 agent 移除时 `AGENTS.md` 核心块场景不存在（enabled ≥ 1）。
  - state 写入：构造 v3 对象后与磁盘现值做除 `installed_at` 外的深比较，相同则跳过该 op。
  - `pruneEmptyParentDirs`：边界集合改为 `desired ∪ old` adapters 的 `pruneBoundaries(ctx)` 并集（design §15.3 列表）。
  - `project.yaml`：agents 或 profile 变化时重写 `adapters.enabled`/`adapter_options`/`profiles`。
- [ ] **Step 4: 运行通过。**

```powershell
npx vitest run packages/core/test/refresh.test.ts packages/core/test/migration.test.ts packages/core/test/managed-block-refresh.test.ts
```

- [ ] **Step 5: Commit。** `git commit -am "feat(core): Agent 集合 transition 与 v3 state 迁移"`

### Task 10: refresh CLI 与 configure 派发

**Files:**
- Modify: `packages/cli/src/commands/refresh.ts`、`packages/cli/src/commands/configure.ts`
- Test: `packages/cli/test/refresh-cli.test.ts`

- [ ] **Step 1: 写失败测试。**
  - `refresh --agents codex,cursor --non-interactive --yes`：transition 生效，`project.yaml` `adapters.enabled` 更新为 `["codex","cursor"]`。
  - `refresh --agents gpt`：exit 3，无文件变更。
  - 未提供 `--agents`：沿用 `project.yaml` 集合。
  - transition 前非 dry-run 输出预览（复用现有 profile 预览机制，items 含各 agent 目标）。
  - bare 命令在既有项目上仍走 refresh（现状回归）。
- [ ] **Step 2: 运行确认失败。**
- [ ] **Step 3: 实现。** `RefreshCommandOptions` 加 `agents?: string`；用 Task 2 的 `parseAgentsInput` 解析（错误 exit 3）；desired agents 传入 `refreshProject`；`codebuddySurface` 从 `project.yaml` `adapter_options` 读取（缺省 `both`）。
- [ ] **Step 4: 运行通过。** `npx vitest run packages/cli/test/refresh-cli.test.ts packages/cli/test/init.test.ts`
- [ ] **Step 5: Commit。** `git commit -am "feat(cli): refresh 支持 --agents 集合切换"`

---

## WP5：Push、policy、update 联动

### Task 11: file-policy + push 动态受管根

**Files:**
- Modify: `packages/core/src/policy/file-policy.ts`
- Modify: `packages/core/src/push/push.ts`
- Test: `packages/core/test/file-policy.test.ts`、`packages/cli/test/push.test.ts`、`packages/cli/test/update.test.ts`

- [ ] **Step 1: 写失败测试。** `file-policy.test.ts` 按 design §17.2 表逐行断言：

```ts
expect(classifyFile("CODEBUDDY.md").edit_policy).toBe("managed-block-only");
for (const p of [".agents/skills/harness-review/SKILL.md", ".cursor/skills/harness-review/SKILL.md",
  ".cursor/rules/harness-general.mdc", ".codebuddy/skills/harness-review/SKILL.md",
  ".codebuddy/agents/harness-reviewer.md"]) {
  expect(classifyFile(p)).toMatchObject({ file_kind: "user_editable", push_policy: "diff-proposal", update_policy: "skip-if-local-dirty" });
}
for (const p of [".codebuddy/settings.json", ".codex/config.toml", ".codex/hooks.json"]) {
  expect(classifyFile(p).file_kind).toBe("external_unmanaged");
}
// 大小写冲突：".CODEBUDDY.MD" 之类经 normalizeManagedPath 后的行为与现有大小写测试一致
```

`push.test.ts`：多 Agent 项目（all）push dry-run 的 preview 不含任何 Bundle working copy（`.claude/.agents/.cursor/.codebuddy` 的 harness-* Skill 均被 ignore），但含 `CODEBUDDY.md`、`.claude/rules/harness-general.md`、`.cursor/rules/harness-general.mdc`。
- [ ] **Step 2: 运行确认失败。**
- [ ] **Step 3: 实现。**
  - `file-policy.ts`：`classifyFile` 增加分支——`CODEBUDDY.md` → `USER_MANAGED_BLOCK`；`.agents/skills/harness-`、`.cursor/skills/harness-`、`.codebuddy/skills/harness-`、`.codebuddy/agents/harness-` 前缀 → `USER_DIFF`（`.cursor/rules/` 已覆盖）。`.codebuddy/settings.json`、`.codex/` 走默认 `EXTERNAL`（加显式测试即可，不必加代码分支）。
  - `push.ts`：删除写死的 `MANAGED_ROOTS`/skills 枚举，改为从 `project.adapters.enabled`（过滤出 `harnessAgentSchema` 合法值）构造：每个 adapter 的 `rulesRoot/harness-*`、`skillsRoot/harness-*`、`agentsRoot/harness-*`，加 `MANAGED_FILES`（含条件性 `CODEBUDDY.md`）与 `.harness/knowledge`、`.harness/codebase`。ignore 集合 = 各 enabled agent 的 `managedBundleTargets(resourcesRoot, profile, agent)` 并集（该函数改为按 adapter 计算，含各自 rules 目标）。
  - `update.ts`：确认 `classifyFile` 新分支自然生效即可；若有写死 `.claude` 的 target 校验则同步放宽到 adapter 白名单。
- [ ] **Step 4: 运行通过。**

```powershell
npx vitest run packages/core/test/file-policy.test.ts packages/cli/test/push.test.ts packages/cli/test/update.test.ts
```

- [ ] **Step 5: Commit。** `git commit -am "feat(core): 四 Agent 文件策略与动态受管根"`

---

## WP6：Pack smoke、文档和全量关门

### Task 12: smoke、文档、版本、全量验证

**Files:**
- Modify: `scripts/smoke-pack.mjs`、`README.md`、`packages/cli/README.md`、`CHANGELOG.md`、`packages/cli/package.json`（version → 0.2.0）

- [ ] **Step 1: smoke-pack.mjs 更新。**
  - 布局断言：`resources/harness/bundles/{general,java}/{claude-code,codex,cursor,codebuddy}` 8 个目录、`manifests/{general,java}/*.json` 各 4 个、`migrations/0.1.1/*` 保留；删除对旧 `manifests/general.json` 的断言。
  - 多 Agent smoke（对应 design §22）：`--agents all --profile general --non-interactive --yes` → 四目录存在；重跑同命令后对比受管文件字节不变；修改一个 `.agents/skills` 文件后 `refresh` exit 5 且文件保留；`refresh --agents cursor --non-interactive --yes` 后 `.claude`/`.agents`/`.codebuddy` 的干净 harness 目标消失、`CLAUDE.md` 用户正文保留；`--dry-run --json` 不创建文件。
  - 保留现有 claude-only 回归段（默认无 `--agents` 仍等价 claude-code）。
- [ ] **Step 2: 文档。** `README.md` 与 `packages/cli/README.md` 增加 `--agents`/`--codebuddy-surface` 用法与四 Agent 产物表（照抄 design §4 矩阵）；`CHANGELOG.md` 新条目 0.2.0；`packages/cli/package.json` version `0.2.0`。
- [ ] **Step 3: 全量关门。**

```powershell
npm run check
```

预期 exit 0（lint + typecheck + vitest + build + smoke:pack）。失败则回到对应任务修复；**不得以单测通过代替**。
- [ ] **Step 4: Commit。** `git commit -am "feat: 多 Agent Harness 安装（claude-code/codex/cursor/codebuddy）"`
- [ ] **Step 5: 最终报告。** 按 design §23.11 列出：修改文件、每个 WP 的测试证据（命令 + exit code）、未运行的真实 Agent smoke（本机未安装的标 `NOT_RUN`）、已知降级（codex/cursor 无自定义 Agent、CodeBuddy 首期仅 `both` surface 等）。

---

## Self-Review 记录

- 规格覆盖：design §3（多选/兼容/surface/hooks）→ Task 1-3；§7-8（编译矩阵）→ Task 4-6；§6/§11-14（adapter/投影/index/state）→ Task 7-8；§15-16（refresh/迁移）→ Task 9-10；§17（push/policy）→ Task 11；§20-24（验收）→ Task 12。§18 错误码分散在 Task 2（AGENTS_REQUIRED/AGENT_UNSUPPORTED/AGENT_OPTIONS_CONFLICT/CODEBUDDY_SURFACE_UNUSED）、Task 7（ADAPTER_BUNDLE_MISSING/INVALID 由 loadAgentBundle 抛出）、Task 5（ADAPTER_SEMANTIC_INVALID 于构建期拦截）、Task 8（TARGET_COLLISION）、Task 9（MANAGED_BLOCK_CONFLICT 复用既有机制）。
- 类型一致性：`HarnessAgent`/`sortHarnessAgents`/`parseAgentsInput`/`getAdapter`/`loadAgentBundle`/`refreshManagedBlockById` 的名称在各任务间已统一。
- 已知顺序依赖：Task 6 Step 4 删除旧布局后 core 测试暂红，Task 7 立即修复——执行者不得在 Task 6 与 Task 7 之间跑全量测试并误判失败为回归。
