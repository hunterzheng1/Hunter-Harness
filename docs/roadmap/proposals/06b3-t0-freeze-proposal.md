# 06B-2b/06B-3 生产接线 T0 前置冻结提案（接线前置决策）

> 状态：提案待 owner 签字（2026-08-16 起草本）。
> 依据 06B-2b/06B-3 关闭记录的硬性前置：以下 5 项决策冻结前不得开始生产接线（"接线前必须冻结 durable layout/CAS、ZIP/CAS 项目隔离、verifier 输入、canonical Archive publish/legacy 迁移及 cleanup/reaper 语义"）。
> 每项给出：现状证据 → 冻结提案 → 备选与风险。owner 批准后可按文末工作项直接施工。

---

## T0-1 durable layout / CAS（Outbox 持久布局与 CAS 事务）

**问题**：`ArchiveOutboxPort`（put/read/compareAndSwap/list）的持久序列化、事务边界与跨进程重启语义是什么？

**现状证据**：
- Port 契约（archive-outbox/types.ts:97-107）：`compareAndSwap(entry_id, expected_generation, next)` 是唯一写边界；record 携带 `generation`、`lease{token,owner_id,generation,expires_at}`、`record_hash` 自证哈希。
- 同构先例：plan durable publication 的 journal 三段式（prepared/applying/committed + transition 矩阵 + tmp+fsync+rename）已在 `fs-publication-port.ts` 落地并通过集成；plan outbox 事务记录落盘布局（`meta/plan-finalization-transactions/<op>.json`）同模式。
- 06B 语义：断网/远端失败/重启不得删除本地 ZIP、不得修改 `LocalArchiveReceipt`；lease 过期不能 ack 也不产生 cleanup intent。

**冻结提案**：
- **布局**：`.harness/state/local/archive-outbox/<entry_id>.json`（entry_id 即 `archive_outbox:<hash>`，文件名 URL 编码）；写一律 tmp+fsync+原子 rename。
- **CAS 边界**：读 record → 校验 `generation === expected_generation` 且 lease 未过期 → 写 `next`（generation+1）→ 返回持久化后 record；三者任一漂移返回 `{swapped:false}`，不得静默合并。单文件单 record，无跨 record 事务（与契约一致）。
- **重启语义**：record 即唯一真相；启动不做恢复写，只在下次 claim/reap 时按 clock 判定 lease 过期。corrupt/unparseable record 按 `read=undefined` 处理并记 quarantine 文件，不自动修复。
- **project 隔离**：record 内含 project_id，resolver/reader 以 `(project_id, entry_id)` 双键定位，跨项目读取固定 Port 错误。

**备选与风险**：SQLite 单库可得多 record 事务，但引入二进制状态与锁迁移问题，且与 plan 系已验证的 JSON+journal 先例不一致——拒绝。

## T0-2 ZIP/CAS 项目隔离（LocalArchiveZipRef 受信 resolver）

**问题**：`LocalArchiveZipRef{ref_id, package_sha256, size_bytes}` 是 opaque 引用，谁把它解析为真实字节，根权威与项目隔离在哪？

**现状证据**：
- legacy 归档包 staging 在 change 目录内构建（06B-1 PackageBuilder 的确定性 ZIP），上传失败后保留待重试。
- ref 自身携带 `package_sha256 + size_bytes`——解析器可自证，无需信任调用方路径。
- plan durable 的 FS authority 先例：`buildFsPublicationAuthority`（target_root 相对化 + 八 target 精确集 + symlink 拒绝）已落地。

**冻结提案**：
- **CAS 存储**：`.harness/state/local/archive-cas/<package_sha256>.zip`（内容寻址，跨 change 去重）。PackageBuilder 产出即写入 CAS（tmp+rename），ref_id = `archive_cas:<package_sha256.slice(7,39)>` 派生身份，不含路径。
- **resolver**：`LocalArchiveZipResolverPort`，输入 ref → 读 CAS 路径 → 复核 `sha256(file) === ref.package_sha256 && size === ref.size_bytes` → 返回只读字节流；任一不符 `ARCHIVE_ZIP_REF_UNTRUSTED` fail closed。resolver 不接受调用方提供的文件路径。
- **项目隔离**：CAS 对象旁写 `<sha256>.binding.json`（`{project_id, change_identity, first_seen_at, record_hash}`）；resolver 要求调用方声明 project_id，与 binding 不符即拒绝。同 hash 跨项目引用合法（内容相同），binding 记录全部 project 列表。

**备选与风险**：把 ZIP 留在 change 目录内免迁移，但上传重试与 cleanup 需要跨 change 生命周期引用，目录删除会悬垂 ref——拒绝；CAS 迁移一次性成本由首次接线命令完成（扫描既有 staging 写入 CAS）。

## T0-3 verifier bridge 输入（可信三元组来源）

**问题**：06B-2a verifier bridge 缺可信 `LocalArchiveReceipt + inventory + CoreV2Projection` 输入，三者从哪来、谁担保一致？

**现状证据**：
- `ArchivePackageReceipt`（06B-1）与 `package_verification_evidence`（06B-2a）已内嵌在 Outbox record（types.ts:31-32），record_hash 自证。
- 阶段 01 `ArchiveIngestReceipt` 是 canonical serialized（06B-3 直接消费，不留影子类型）。

**冻结提案**：
- **唯一来源**：verifier bridge 的三元组**只从 durable Outbox record 读取**（package_receipt + package_verification_evidence + 由 record 重放的 projection），调用方只提供 `entry_id`；不接受外部传入的 receipt/inventory，杜绝拼接。
- **一致性担保**：bridge 先校验 record_hash 自证 + `package_sha256/manifest_sha256` 与 `LocalArchiveReceipt` 一致 + CAS resolver 复核字节，三者任一漂移 fail closed，不进入 verify。
- **CoreV2Projection**：来自 record 的 `archive_schema_version`（=1 current / =0 legacy_read_only）；v0 只读，不产 cleanup intent。

**备选与风险**：允许调用方直传三元组可减少一次 record 读，但打开伪造面（与"不得从调用方猜测身份"原则冲突）——拒绝。

## T0-4 canonical Archive publish seam 与 legacy 迁移

**问题**：RemoteSync production 的 Archive publish seam 走哪条路由；旧 `change_archive_packages` 表与 `/archive-package` 路由如何共存而不冒充新收据？

**现状证据**：
- 02 的 RemoteSync production HTTP 已落地 Push/Pull 路由（actor 绑定），Archive seam 缺失。
- legacy 上传路径：CLI `archive upload --file --change-key` → `/archive-package`，写 `change_archive_packages`；其收据 schema 与新 `ArchiveSyncReceipt` 不同构，文档已明确"不能无损冒充"。

**冻结提案**：
- **新路由**：`POST /api/v1/projects/<project_id>/archives:ingest`——请求体为 canonical serialized `ArchiveIngestRequest`（绑定 request/idempotency/project/change/package/manifest/project version），响应为 `ArchiveSyncReceipt`（stored/failed 嵌套状态）。服务端事务：写 archive + 发 ingest receipt + 后台 Change/Knowledge 嵌套失败不回滚 receipt。
- **legacy 共存**：`/archive-package` 保留旧语义，行打 `source:"legacy_http"` 标记；平台读取层把 legacy 行投影为 `legacy_read_only`，**不**生成新 `ArchiveSyncReceipt`，不参与新 outbox ack。CLI `archive upload`（legacy）与 `harness-push --scope archive`（新 outbox）并存到阶段 14，消费者迁完后 legacy 路由退役。
- **无迁移写入**：不把 legacy 行批量转写为新格式（无法补全 idempotency/immutable identity）；历史补处理以"重新经新链路 ingest"为准。

**备选与风险**：双路由并存有理解成本，但无损冒充新收据会污染 ack 语义（cleanup 依赖 verified ack）——共存+只读投影是唯一安全过渡。

## T0-5 cleanup / reaper 语义（租约调度与可恢复清理）

**问题**：lease/reaper 调度宿主是谁，cleanup intent 如何可恢复执行？

**现状证据**：
- Outbox 语义：只有 verified durable ack 且 retention 允许才返回 cleanup intent；Module 从不删除文件。
- lease 绑定 owner/token/generation/expiry；过期 lease 不能 ack 也不产生 cleanup intent。
- plan 系先例：CLI 侧 reaper 以命令形态存在（`retire-stale` 模式）。

**冻结提案**：
- **调度宿主**：CLI 维护命令 `hunter-harness archive outbox gc --project <path>`（dry-run 默认，`--apply` 执行）——claim 到期 entry → 对 verified-ack + retention-allowed 的产生 cleanup intent → 删除 CAS 对象**仅当无其他 record 引用同 hash** → 更新 record 终态。无后台 daemon；Platform Worker 侧 reaper 属 06 后续 Platform 工作包，不阻塞本仓接线。
- **可恢复**：cleanup 执行先写 `cleanup-intent-<entry_id>.json`（intent + ref + retention 证据）再删字节；中断后下次 gc 从 intent 文件继续，不产生二次 intent。删除失败保留 intent，重试有界（3 次）后进 dead-letter，不静默。
- **retention**：默认保留全部（无自动清理）；清理只响应显式 `--retain-days <n>` 或显式 entry 列表，绝不默认删除。

**备选与风险**：后台 daemon 可自动重试，但引入常驻进程治理（跨平台服务注册），与现有 CLI 命令治理不一致——拒绝，调度频率由 cron/CI 承担。

---

## 工作项（批准后按序施工）

1. `LocalArchiveZipResolverPort` + CAS 写入路径（PackageBuilder 产出 → CAS + binding）+ 迁移扫描。
2. `FsArchiveOutboxPort`（durable layout/CAS/lease/重启语义）+ Archive CLI `outbox gc`（cleanup/reaper）。
3. verifier bridge 可信三元组装配（record → bridge）+ RemoteSync HTTP `archives:ingest` seam + legacy 只读投影。
4. Archive CLI/Skill 触发接线（`harness-push --scope archive` 走新 outbox）+ 中文状态投影。
5. 全链路 e2e（构建 → 入队 → claim → 上传 → ack → cleanup intent → gc 执行）+ 阶段 14 验收材料。

每项 TDD，hostile 矩阵先行（伪造 ref/漂移 CAS/过期 lease/legacy 冒充/中断恢复）。
