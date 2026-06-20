# hunter-harness

Local-first, server-governed Agent Harness CLI.

```bash
npx hunter-harness
npx hunter-harness push
npx hunter-harness update
```

- 默认命令可离线初始化或打开事务恢复菜单。
- `push` 只创建 proposal，不发布、不推进本地 baseline。
- `update` 只事务化应用人工批准的 artifact。

需要 Node.js 24 或更高版本。token 只通过 `--token-env` 指定的环境变量读取，不要写入项目文件或命令参数。

本包当前为 `UNLICENSED`。参考迁移资产的上游 license、commit/tag 和允许再分发范围确认前，不得对外发布。
