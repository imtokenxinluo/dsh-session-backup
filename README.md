# dsh-session-backup

DeepSeek Harness 会话历史工具：**冷备份**（全量 + 增量，sha256 manifest + loader-mirror
预校验）与**归档**（把旧会话移出活跃库、按需还原）。零运行时依赖。

> 会话历史是人与 DSH 之间交换记忆的唯一介质——备份是防"唯一记忆丢失"的
> 最后防线；归档是防"记忆库无限膨胀"。与
> [dsh-session-doctor](https://github.com/luoxin10086/dsh-session-doctor)
> 互补：doctor 管"坏了修"，backup 管"坏了能回滚/防丢"，archive 管"旧了挪走还能取回"。

## 能力

- **全量备份**：扫描 sessions 根下全部会话 → 复制到目标目录（保持
  `<id>/session.jsonl.zstd` 结构），生成 `manifest.json`（id/源路径/大小/
  mtime/sha256/状态）。
- **增量备份**：二次运行按 manifest 的 size+mtime 跳过未变会话；源变更才重拷。
- **备份前校验**：每个会话先跑 loader-mirror 校验（与加载器同规则），坏会话
  在 manifest 标 `status: corrupt` 并列出警告（不静默），但**仍备份**以便未来
  用 doctor repair。
- **恢复 restore**：按 manifest 把会话恢复到目标路径，逐个 sha256 校验备份
  完整性；**拒绝覆盖已存在文件**（需 `--force`，防误覆盖 live 会话）。
- **归档 archive**（v0.2）：把符合条件的会话**移出**活跃库腾空间——
  **默认 dry-run**，`--apply` 时才执行"复制 → 逐文件 sha256 校验 → 校验通过才删源"；
  过滤器（`--older-than` / `--ids`）**强制必填**，没有"归档全部"的入口。
- **还原 unarchive**：按归档清单还原到**原始相对路径**，逐文件 sha256 校验，
  **拒绝覆盖已存在的 live 会话**（需 `--force`）；默认保留归档副本（`--purge` 才删）。

## 用法

```bash
# 全量备份（第二次跑自动增量）
node bin/dsh-session-backup.js backup <sessions-root> <backup-dir>

# 查看备份清单
node bin/dsh-session-backup.js list <backup-dir>

# 恢复全部（到新目录）
node bin/dsh-session-backup.js restore <backup-dir> <dest>

# 恢复指定会话 / 覆盖已有
node bin/dsh-session-backup.js restore <backup-dir> <dest> --ids a,b --force

# 归档：先 dry-run 看会动什么（默认就是 dry-run，什么都不改）
node bin/dsh-session-backup.js archive <sessions-root> <archive-dir> --older-than 30d

# 确认后真正执行（复制→校验→删除源）
node bin/dsh-session-backup.js archive <sessions-root> <archive-dir> --older-than 30d --apply

# 按 id 精确归档
node bin/dsh-session-backup.js archive <sessions-root> <archive-dir> --ids <id1>,<id2> --apply

# 查看归档库（含从首条用户消息提取的标题）
node bin/dsh-session-backup.js archives <archive-dir>

# 还原（拒绝覆盖同名 live 会话；--purge 同时清掉归档副本）
node bin/dsh-session-backup.js unarchive <archive-dir> <sessions-root> [--ids a,b] [--force] [--purge]
```

典型：备份整个 DSH 会话库到独立磁盘：

```bash
node bin/dsh-session-backup.js backup D:/tool/dsh_data/sessions D:/session-backups
```

典型：把 30 天没动过的会话挪去归档盘：

```bash
node bin/dsh-session-backup.js archive D:/tool/dsh_data/sessions D:/session-archive --older-than 30d --apply
```

## 归档安全设计

| 规则 | 原因 |
|---|---|
| **默认 dry-run** | 误敲回车不会移走任何东西 |
| **复制 → 校验 → 才删源** | 校验失败时 live 会话原封不动；不存在"先删后备份"路径 |
| **过滤器强制必填** | `archive` 没有"全部"入口，避免一次误操作清空会话库 |
| **还原拒绝覆盖** | 防把归档副本盖到正在用的同名会话上 |
| **归档副本默认保留** | `unarchive` 不删归档，确认无误后再 `--purge` |
| **坏会话照样归档并标记** | 与 backup 一致：标 `status: corrupt`，留给 doctor 修 |

```bash
# 归档库结构（archive.json 记录 id/workspace/原相对路径/每个文件的 sha256）
<archive-dir>/
├── archive.json
└── <session-id>/
    └── session.jsonl.zstd
```

## 测试

```bash
npm test                       # 合成 fixture：全量/增量/校验/restore/拒覆盖
node scripts/verify-real.mjs   # 真实会话副本验收（不碰真实数据）
```

## 安全边界

- 零运行时依赖（Node 内置 fs/crypto/zlib）。
- 备份前校验坏会话 → 标记而非静默；restore 校验 hash + 拒绝误覆盖。
- 不压缩/不加密（原样复制 zstd 产物，保持字节一致）。
- 验收全在副本上进行，不碰真实会话。

## License

MIT
