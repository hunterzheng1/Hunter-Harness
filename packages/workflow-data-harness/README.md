# @hunter-harness/workflow-harness

Harness 工作流族的**纯数据 npm 包**（bundles + manifests + migrations），供瘦身后 `hunter-harness` CLI 在运行时解析安装。

## 版本约定

- npm 包 `version` 与 Registry 中 **Workflow Family 发布版本** 1:1 对齐（例如 Family `1.0.0` → 本包 `1.0.0`）。
- `hunter-workflow-family.json` 记录族 slug、所需 profile 与 bundle 元数据。

## 布局

```
harness/
  bundles/{general|java}/{claude-code|codex|cursor|codebuddy}/...
  manifests/{general|java}/{agent}.json
  migrations/0.1.1/{general|java}.json
hunter-workflow-family.json
```

## 生成

仓库根目录执行 `npm run sync:harness`，产物会同步写入本包的 `harness/` 目录。
