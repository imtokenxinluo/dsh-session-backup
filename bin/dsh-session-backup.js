#!/usr/bin/env node
// dsh-session-backup CLI.
//   backup <sessions-root> <target> [--force]
//   restore <backup-dir> <dest> [--force] [--ids a,b]
//   list <backup-dir>
import { backupSessionRoot, restoreFromManifest, readManifest } from '../src/backup.js'

function usage() {
  console.log(`dsh-session-backup

usage:
  dsh-session-backup backup <sessions-root> <target>
      Cold-backup every session artifact under <sessions-root> into <target>.
      Copies artifacts + writes manifest.json (id/sha256/status). Second run
      skips unchanged sessions (incremental). Corrupt sessions are reported
      and marked status=corrupt but still backed up.

  dsh-session-backup restore <backup-dir> <dest> [--force] [--ids a,b]
      Restore sessions from <backup-dir>/manifest.json into <dest>, verifying
      each file's sha256. Refuses to overwrite existing files unless --force.

  dsh-session-backup list <backup-dir>
      List manifest contents.
`)
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2)
  switch (cmd) {
    case 'backup': {
      const [root, target] = rest.filter((a) => !a.startsWith('--'))
      if (!root || !target) return usage()
      const r = await backupSessionRoot(root, target)
      console.log(`backup: copied=${r.copied.length} skipped=${r.skipped} corrupt=${r.corrupt.length}`)
      for (const id of r.corrupt) console.log(`  CORRUPT (backed up, needs repair): ${id}`)
      console.log(`manifest: ${target}/manifest.json`)
      return
    }
    case 'restore': {
      const args = rest.filter((a) => !a.startsWith('--'))
      const force = rest.includes('--force')
      const idsArg = rest.find((a) => a.startsWith('--ids='))
      const ids = idsArg ? idsArg.slice(6).split(',').filter(Boolean) : undefined
      const [backupDir, dest] = args
      if (!backupDir || !dest) return usage()
      const restored = await restoreFromManifest(backupDir, dest, { force, ids })
      console.log(`restored ${restored.length} session(s) to ${dest}`)
      return
    }
    case 'list': {
      const [dir] = rest
      if (!dir) return usage()
      const m = await readManifest(dir)
      if (!m) { console.log('no manifest'); process.exitCode = 1; return }
      for (const s of m.sessions) {
        console.log(`${s.status.padEnd(7)} ${s.id}  ${s.size} bytes  ${new Date(s.backedUpAt ?? s.mtime).toISOString().slice(0, 19)}`)
      }
      console.log(`\ntotal: ${m.sessions.length}`)
      return
    }
    default:
      return usage()
  }
}

main().catch((e) => { console.error(String(e?.message ?? e)); process.exit(1) })
