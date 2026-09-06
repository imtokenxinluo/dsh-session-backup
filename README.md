# dsh-session-backup

DeepSeek Harness 会话历史**冷备份**工具：全量 + 增量备份（带 sha256 manifest 与
loader-mirror 预校验），以及校验恢复。零运行时依赖。

> 会话历史是人与 DSH 之间交换记忆的唯一介质——备份是防"唯一记忆丢失"的
> 最后防线。与 [dsh-session-doctor](https://github.com/luoxin10086/dsh-session-doctor)
> 互补：doctor 管"坏了修"，backup 管"坏了能回滚/防丢"。

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
```

典型：备份整个 DSH 会话库到独立磁盘：

```bash
node bin/dsh-session-backup.js backup D:/tool/dsh_data/sessions D:/session-backups
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
