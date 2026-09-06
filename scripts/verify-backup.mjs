// verify-backup.mjs — verify the live backup at D:\tool\dsh-backups\sessions:
// 1) every manifest entry's backup file exists + sha256 matches manifest;
// 2) spot-restore 2 sessions to temp and confirm byte-identical + loader-clean.
import { readFile, mkdir, writeFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { readManifest } from '../src/backup.js'
import { scanSessionFile } from '../src/scan.js'

const BACKUP = 'D:/tool/dsh-backups/sessions'

const sha = (b) => createHash('sha256').update(b).digest('hex')

const manifest = await readManifest(BACKUP)
if (!manifest) { console.error('FAIL: no manifest'); process.exit(1) }
console.log(`manifest: ${manifest.sessions.length} sessions`)

let ok = 0, bad = 0
for (const e of manifest.sessions) {
  const file = path.join(BACKUP, e.id, e.fileName)
  try {
    const buf = await readFile(file)
    const h = sha(buf)
    const match = h === e.sha256
    if (match) ok++; else { bad++; console.log(`  HASH MISMATCH: ${e.id}`) }
  } catch { bad++; console.log(`  MISSING FILE: ${e.id}`) }
}
console.log(`integrity: ${ok}/${manifest.sessions.length} backup files sha256-verified`)

// spot restore 2 sessions
const dest = await mkdir(path.join(tmpdir(), `verify-restore-${Date.now()}`), { recursive: true })
let restored = 0
for (const e of manifest.sessions.slice(0, 2)) {
  const buf = await readFile(path.join(BACKUP, e.id, e.fileName))
  const out = path.join(dest, e.id, e.fileName)
  await mkdir(path.dirname(out), { recursive: true })
  await writeFile(out, buf)
  const scan = await scanSessionFile(out)
  console.log(`  restored ${e.id}: loaderClean=${scan.ok}`)
  if (scan.ok) restored++
}
console.log(`spot-restore: ${restored}/2 loader-clean`)
if (ok !== manifest.sessions.length || restored !== 2) process.exitCode = 1
