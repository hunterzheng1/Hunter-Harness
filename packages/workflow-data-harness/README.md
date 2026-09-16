# @hunter-harness/workflow-harness

Harness 工作流族的**纯数据 npm 包**（bundles + manifests），供 `hunter-harness` CLI 在运行时解析安装。

## 版本约定

- npm 包 `version` 与 Registry 中 **Workflow Family 发布版本** 1:1 对齐（例如 Family `1.0.0` → 本包 `1.0.0`）。
- `hunter-workflow-family.json` 记录族 slug、bundle 元数据，以及 `content_sha256`
  ——对 `harness/` 下所有文件按路径排序后 `{path, content}` 规范化 JSON（`canonicalJson`）取 SHA-256，
  与 hunter-platform `apps/server/src/npm/publisher.ts` 的 `buildWorkflowFamilyManifest` 使用同一算法，
  供离线/本地校验本包内容完整性。

## 布局（1.0 起：单一规范 bundle × 两个投影 surface）

```
harness/
  bundles/{codex|codebuddy}/...   # 内容一致，差异仅在 .harness-build.json 的 agent 字段
  manifests/{codex|codebuddy}.json
  contracts/  protocols/
hunter-workflow-family.json
```

## 生成

仓库根目录执行 `npm run sync:harness`，产物会同步写入本包的 `harness/` 目录。
