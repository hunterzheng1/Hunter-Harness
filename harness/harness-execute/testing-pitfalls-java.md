---
description: Java/Feign 相关测试踩坑（harness-execute）。API 实测前通读；发现客户端路径缺陷时回写 plan 外修复记录。
---

# Java 测试踩坑补充（Feign / 远程客户端）

> 与 `testing-pitfalls.md`（通用）及 `overlays/java/pitfalls-java.md`（overlay 速查表）互补；本文件收录路径拼接类缺陷的症状与流程要求。

## Feign/客户端路径前缀缺失

**症状**：服务正常、接口 200，但客户端拿到 404 / 空数据 / fallback 生效。
**根因模式**：`@FeignClient` 方法上只写了 `@GetMapping("/type")`，漏掉服务端类级前缀（如 `/system/dict-data`）。
**定位**：对照服务端 controller 完整映射（类级 `@RequestMapping` + 方法级注解），或看服务端访问日志中的实际 404 路径。
**流程要求**：此类缺陷若在 test 阶段被 API 实测发现，属于"计划外修复"——必须记 decision 事件（含根因与修复文件），并检查同客户端文件的其余方法是否同源错误。

## Surefire 插件级 excludedGroups 压过命令行覆盖（静默 0 执行）

**症状**：`mvn test -Dgroups=mysql -DexcludedGroups=` 想跑集成测试，结果 `Tests run: 0` + **exit 0**——只看退出码就是假阳性。
**根因**：pom 在 surefire `<configuration>` 里写死 `<excludedGroups>mysql</excludedGroups>` 时，插件级配置压过命令行属性，空值覆盖不生效。
**修复**：pom 改用属性占位 `<excludedGroups>${excludedGroups}</excludedGroups>`，命令行空值才能生效。
**防线**：`harness_ledger.py record` 在命令含 `-Dgroups=`/`-Dtest=` 等选择器且证据显示 `Tests run: 0` 时输出 `ZERO_TESTS_WITH_SELECTOR` 警告（0.4.11 起）；看到它不要当噪音跳过。
