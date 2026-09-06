// verify-real.mjs — acceptance against REAL session copies (never touches live data).
import { mkdtemp, cp, readdir, stat, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { backupSessionRoot, restoreFromManifest } from '../src/backup.js'
import { scanSessionFile } from '../src/scan.js'

const ROOT = 'D:\\tool\\dsh_data\\sessions\\--D-tool-claude_code--'

async function sha256file(p) {
  const { readFile } = await import('node:fs/promises')
  return createHash('sha256').update(await readFile(p)).digest('hex')
}

const tmp = await mkdtemp(path.join(tmpdir(), 'dsh-backup-real-'))
try {
  // copy a handful of real sessions (dirs may hold session.jsonl.zstd)
  const dirs = (await readdir(ROOT, { withFileTypes: true })).filter((d) => d.isDirectory()).slice(0, 5)
  const sessions = path.join(tmp, 'sessions')
  for (const d of dirs) await cp(path.join(ROOT, d.name), path.join(sessions, d.name), { recursive: true })
  console.log(`copied ${dirs.length} real session dirs to temp`)

  const target = path.join(tmp, 'backup')
  const r1 = await backupSessionRoot(sessions, target)
  console.log(`full backup: copied=${r1.copied.length} skipped=${r1.skipped} corrupt=${r1.corrupt.length}`)

  // incremental: second run must skip everything
  const r2 = await backupSessionRoot(sessions, target)
  console.log(`incremental: copied=${r2.copied.length} skipped=${r2.skipped} (expect skipped=${dirs.length})`)
  if (r2.copied.length !== 0) { console.error('FAIL: incremental copied files'); process.exit(1) }

  // restore to another dir
  const dest = path.join(tmp, 'restored')
  const restored = await restoreFromManifest(target, dest)
  console.log(`restore: ${restored.length} sessions`)

  // verify: restored files byte-identical to originals + loader-clean
  let ok = 0
  for (const d of dirs) {
    const orig = path.join(sessions, d.name, 'session.jsonl.zstd')
    const back = path.join(dest, d.name, 'session.jsonl.zstd')
    const h1 = await sha256file(orig)
    const h2 = await sha256file(back)
    const scan = await scanSessionFile(back)
    const match = h1 === h2
    console.log(`  ${d.name}: bytesMatch=${match} loaderClean=${scan.ok}${scan.ok ? '' : ' (corrupt source)'}`)
    if (match) ok++
  }
  console.log(`\nSUMMARY: byte-identical restores ${ok}/${dirs.length}`)
  if (ok !== dirs.length) process.exitCode = 1
} finally {
  await rm(tmp, { recursive: true, force: true })
}
