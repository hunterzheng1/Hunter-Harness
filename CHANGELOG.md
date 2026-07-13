# Changelog

## [0.2.4]

### Fixed

- Windows 上经 npm workspace junction / `npx` 调用时，CLI 入口不再因 `import.meta.url` 与 `argv` 实路径不一致而静默退出；monorepo 可用 `npm run hh` dogfood。

## [0.2.3]

### Fixed

- 工作流数据包获取失败时改为分类提示真实原因（pacote 缺失 / 网络 TLS / 404），不再笼统写成「无网络且本地缓存不存在」。

## [0.2.2]

### Fixed

- 重新发布 CLI：`0.2.1` 因本地 `tsc`/`esbuild` PATH 问题打进了未重建的旧 bundle；`0.2.2` 含完整敏感扫描误报修复。

## [0.2.1]

### Fixed

- 敏感扫描不再把相对路径、SHA/commit hex、知识条目 ID 误判为高熵 secret；`.harness/knowledge/**` 下的本地 `projectRoot` Windows 路径不再阻断 push。

## [0.2.0]

### Added

- 项目级 Harness 安装支持 Claude Code、Codex、Cursor 与 CodeBuddy 的任意组合，并提供 `--agents` 与 `--codebuddy-surface` 参数。
- 离线资源改为 2 profile × 4 Agent Bundle 矩阵；刷新支持安全 Agent 集合切换、v3 installed state 与 legacy Claude-only 迁移。
- Push/update 文件策略覆盖四种 Agent 的 working copy、规则与 CodeBuddy managed block。

## [Unreleased]

### Breaking Changes

- **移除 canonical Skill IR 数据模型与编译链**：删除 `SkillIr` schema 与 `compileSkill`/`findSkillIr`/`mergeSkillIr`/`normalizeSkillIr`/adapters 等编译链。skill 源文件（`sourceFiles`，含 `SKILL.md` entry）成为唯一源；安装 = 上传的原生文件夹（"上传什么 → 存什么 → 装什么"）。
  - `packages/contracts`：删 `skill-ir.ts`；`registrySkillSummarySchema`/`DetailSchema`/`VersionSchema` 去 `ir`（保留 `ir?: unknown` legacy 容忍）；新增 `skillFrontmatterSchema`（`.passthrough()` 容忍额外字段，避免合法 SKILL.md 被拒）；summary 新增 `kind` 字段（从 frontmatter 反范式化）。
  - `packages/core`：删 `skill-ir/{compiler,adapters/*,overlay,normalize,extract,bundle}.ts`；新增 `skill/{frontmatter,meta,errors,checker,fixer}.ts`；`initializeProject` 改复制 `resources/skills/<name>/` + 写 `source_hash`（取代 `source_ir_hash`）。
  - `apps/server`：`store.ts` 18 处 IR 调用重写为 sourceFiles 驱动；`buildArtifactFor` zip 全部 sourceFiles + manifest `source_sha256`（取代 `source_ir_sha256`）+ `target_path` 文件夹根；dashboard `kind` 从 frontmatter 反范式化。
  - `apps/web`：catalog/mock-api/组件去 ir，改 sourceFiles 模型；fix degraded UX 展示（buildFixPatch 返回 degraded 项时明确提示"建议手动改"）。
  - `packages/cli`：`init` 复制 `resources/skills/`（仅 claude-code adapter，cursor/codex 暂抛错）；managed block `source_ir_hash` → `source_hash`。
  - `packages/skill-cli`：install 解 folder zip 保留目录结构（修复多文件 skill 安装丢失 references/scripts 痛点）；manifest 兼容 `source_sha256`（新）与 `source_ir_sha256`（旧 zip）。
  - `resources`：12 个 `bootstrap-ir/skills/*.yaml` → `resources/skills/<name>/SKILL.md` 文件夹模型；删 `resources/bootstrap-ir/`。

### Behavior Changes

- **cli init 仅支持 claude-code adapter**：source-file 模型下，cursor/codex 等 adapter 的 `.mdc` 编译能力随 `compileSkill` 移除，init 抛 "adapter not yet supported"（仅 claude-code 复制 SKILL.md）。
- **dashboard skill 分类分布**：`kind` 从 SKILL.md frontmatter 反范式化到 detail（取代旧 `ir.kind`），新 skill 分类按真实 `kind`。
- **上传 SKILL.md-only 文件夹不再 422**：修复原痛点（旧 `findSkillIr` 只认 skill.yaml，SKILL.md 被拒）。

### Fixed

- 上传普通 Claude Code Skill 文件夹（仅 SKILL.md）被 422 拒绝（`SKILL_VALIDATION_FAILED / no canonical Skill IR file found`）。
- 多文件 skill（references/scripts）安装丢失：旧 `buildArtifactFor` zip 只含 2 文件（编译 SKILL.md + manifest），references/scripts 不进制品。

### Known Issues

- 🟡 `harness-skill-optimizer` skill 文案仍提及 "Skill IR"（按原 YAML 逐字迁移，保证 INT-002b 语义完整性）；IR 已移除，skill 内容待后续更新为 source-file 模型语义。
