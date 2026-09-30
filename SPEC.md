# dsh-session-backup — 需求契约 (doublecheck spec, 2026-09-06)

## Goal
交付可开源复用的 DSH 会话冷备份工具 dsh-session-backup（独立库+CLI，零运行时依赖），v1 支持全量备份（复制会话+manifest 含 sha256）、增量备份（按 hash+size 跳过未变）、备份前 loader-mirror 校验（坏会话标记不静默）、restore（按 manifest 恢复并校验），并用合成 fixture 与真实会话副本验证各路径。

## Scope
范围内：新建 D:\tool\claude_code\dsh-session-backup\ 独立 git 仓库（package.json/src/CLI/test/README/LICENSE/SPEC）；复用 dsh-session-doctor 的 zstd 帧解码与 loader-mirror 校验逻辑（复制保持独立）。范围外：不改 dsh 内核；不装 profile；不 push GitHub（本地建仓稍后自行发布）；不做多角色系统；不做压缩/加密/跨机同步。

## Acceptance criteria
1) 独立 git 仓库结构完整；2) backup 全量：扫描全部会话复制到目标（保持 <id>/session.jsonl.zstd + manifest 含 id/size/mtime/sha256/status）；3) backup 增量：二次运行按 size+mtime 跳过未变，源变更才重拷；4) 备份前校验：坏会话标 status=corrupt 并列出，但仍备份；5) restore：按 manifest 恢复，sha256 校验，拒绝覆盖已有（需 --force）；6) node --test 全绿（全量/增量/校验/restore/拒覆盖）；7) 真实会话副本验收：备份→增量→restore→字节一致+loader 干净。

## Failure modes
1) live 写入：stat+读取快照，manifest 记 mtime，增量以 size+mtime 判断；2) 目标不可写：中止明确报错；3) 源读失败：该会话跳过不崩；4) restore 目标已存在：默认拒绝覆盖（--force 覆盖）；5) 增量 manifest 丢失：退化为全量并重建；6) 会话 id 冲突（目录名多样）：以 artifact 父目录名为 id，flat 树回退文件 stem。

## Priorities
正确性优先：restore 可回滚与校验 > 备份速度；增量保守（宁多备不漏）；坏会话标记 > 静默跳过；代码可读与开源友好同等重要。

## Non-goals
不改 dsh 内核；不装 profile；不 push GitHub；不做多角色系统；不做压缩/加密/跨机同步。

## 验收记录 (2026-09-06)
- 单测 6/6 绿（node --test）
- 真实副本 5/5：全量复制 → 增量 skipped=5 copied=0 → restore 字节一致 + loader 干净
- 修复的 bug：sessionIdFromPath 目录名 id 冲突；restore exists 缺 await（Promise truthy 恒拒覆盖）

---

# v0.2 增量需求契约：会话归档 (2026-09-30)

## Goal
在既有冷备份之上，交付"归档"能力：把符合条件的会话**移出**活跃 sessions 库以腾空间，
并可按需**还原**回原始相对路径；全程 hash 校验，绝不出现"先删后备份"的数据丢失路径。

## Scope
范围内：新增 `src/archive.js` + CLI 子命令 `archive` / `unarchive` / `archives`；
复用既有 zstd 帧解码（标题提取）与 loader-mirror 校验（坏会话标记）逻辑；
新增 `test/archive.test.js`。范围外：不改 dsh 内核；不做压缩/加密；
不做投影缓存（`session_projcache.json`）自动清理；不做 UI。

## Acceptance criteria
1) `archive` 默认 dry-run，不移动任何文件、不创建归档目录；
2) `--apply` 时：逐文件复制 → sha256 校验 → **校验通过才删源**；manifest 记录
   id/workspace/原相对路径/每文件 sha256/mtime/status/archivedAt；
3) 过滤器（`olderThanMs` 或 `ids`）强制必填，无过滤器时报错且不动数据；
4) `unarchive` 还原到原相对路径并校验 sha256，**拒绝覆盖已存在 live 会话**（`--force` 放行）；
5) `archives` 列出归档内容，含**从首条 user/message 提取的可读标题**；
6) `node --test` 全绿（含 dry-run/apply/过滤器/还原/拒覆盖/标题 6 类）；
7) 真实会话副本端到端：归档 → 源清空 → 还原 → **字节一致**。

## Failure modes
1) 校验失败：该会话记入 `failed`，**不删源**；
2) 会话目录为空：报错跳过，不删源；
3) 归档后 workspace 目录空：一并清掉（避免残留空壳）；
4) 归档副本缺失时还原：报错列出该 id；
5) 还原目标已存在：默认拒绝（硬失败），`--force` 才覆盖。

## Priorities
**不丢数据** > 腾空间效果 > 易用性。任何"可能删掉唯一副本"的路径都必须先校验。

## Non-goals
不做压缩归档、不做自动定时归档、不做跨机同步、不做 UI（可后续包装同一套 core）。

## 验收记录 (2026-09-30)
- 单测 **15/15 绿**（新增 9 项：dry-run / apply / 无过滤器拒绝 / older-than 过滤 /
  ids 过滤 / older-than 0 边界 / 还原 / 拒覆盖 / 标题提取）
- 真实会话副本端到端：3 个真实会话 → `archive --apply` 移动成功（源清空、归档 3 个）
  → `archives` 正确提取中文标题 → `unarchive` 还原 **3/3 字节一致**
- 修复的 bug：
  1) `splitLines()` 返回 `{lines, newline}` 对象而非数组 —— 误当数组遍历导致标题恒为空；
  2) `olderThanMs: 0` 被 falsy 判断当作"无过滤器"；
  3) **亚毫秒 mtime**：NTFS 的 mtimeMs 带小数，`olderThanMs` 严格比较会把刚写入的文件
     误判为"未来时间"而跳过 → 语义改为 `olderThanMs <= 0` 表示不限年龄。
