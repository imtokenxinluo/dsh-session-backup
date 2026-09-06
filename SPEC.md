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
