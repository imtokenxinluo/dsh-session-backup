#!/usr/bin/env node
// dsh-session-backup CLI.
//   backup    <sessions-root> <target> [--force]
//   restore   <backup-dir> <dest> [--force] [--ids a,b]
//   list      <backup-dir>
//   archive   <sessions-root> <archive-dir> (--older-than 30d | --ids a,b) [--apply]
//   unarchive <archive-dir> <sessions-root> [--ids a,b] [--force] [--purge]
//   archives  <archive-dir>
//
// backup/restore = cold backup (copy, never touch the source).
// archive/unarchive = park old sessions elsewhere and bring them back.
import { backupSessionRoot, restoreFromManifest, readManifest } from '../src/backup.js'
import { archiveSessions, unarchiveSessions, listArchive } from '../src/archive.js'

const UNITS = { s: 1000, m: 60000, h: 3600000, d: 86400000, w: 604800000 }

function parseDuration(input) {
  const m = /^(\d+(?:\.\d+)?)([smhdw])$/.exec(String(input ?? ''))
  if (!m) throw new Error(`bad duration "${input}" — use e.g. 30d, 12h, 90m`)
  return Number(m[1]) * UNITS[m[2]]
}

function mb(bytes) {
  return `${(bytes / 1048576).toFixed(1)} MB`
}

function stamp(ms) {
  return ms ? new Date(ms).toISOString().slice(0, 16).replace('T', ' ') : '—'
}

/** Parse `--flag` / `--key=value` / `--key value` style args. */
function parseFlags(rest) {
  const flags = {}
  const positional = []
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]
    if (!a.startsWith('--')) { positional.push(a); continue }
    const eq = a.indexOf('=')
    if (eq !== -1) {
      flags[a.slice(2, eq)] = a.slice(eq + 1)
    } else {
      const key = a.slice(2)
      const next = rest[i + 1]
      if (next !== undefined && !next.startsWith('--')) { flags[key] = next; i++ }
      else flags[key] = true
    }
  }
  return { flags, positional }
}

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

  dsh-session-backup archive <sessions-root> <archive-dir> (--older-than 30d | --ids a,b) [--apply]
      Move matching sessions out of the live store into <archive-dir>.
      Dry-run by default: prints what WOULD move and changes nothing.
      With --apply: copy → verify sha256 → only then delete the live copy.
      A filter is mandatory (there is no "archive everything" path).

  dsh-session-backup unarchive <archive-dir> <sessions-root> [--ids a,b] [--force] [--purge]
      Move archived sessions back to their original live paths, verifying
      sha256. Refuses to overwrite an existing live session unless --force.
      --purge removes the archived copy after a successful restore.

  dsh-session-backup archives <archive-dir>
      List archived sessions (id / workspace / size / archived time / title).
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
      const { flags, positional } = parseFlags(rest)
      const ids = typeof flags.ids === 'string' ? flags.ids.split(',').filter(Boolean) : undefined
      const [backupDir, dest] = positional
      if (!backupDir || !dest) return usage()
      const r = await restoreFromManifest(backupDir, dest, { force: flags.force === true, ids })
      console.log(`restored ${r.length} session(s) to ${dest}`)
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
    case 'archive': {
      const { flags, positional } = parseFlags(rest)
      const [root, archiveDir] = positional
      if (!root || !archiveDir) return usage()
      const olderThanMs = flags['older-than'] !== undefined ? parseDuration(flags['older-than']) : undefined
      const ids = typeof flags.ids === 'string' ? flags.ids.split(',').filter(Boolean) : undefined
      const apply = flags.apply === true
      const r = await archiveSessions(root, archiveDir, { olderThanMs, ids, apply })
      const bytes = r.planned.reduce((n, p) => n + p.size, 0)
      const mode = apply ? 'apply' : 'dry-run'
      console.log(`archive (${mode}): ${r.planned.length} session(s) match — ${mb(bytes)}`)
      if (r.planned.length) {
        console.log(`  ${'id'.padEnd(38)} ${'workspace'.padEnd(34)} ${'size'.padStart(10)}  last activity`)
        for (const p of r.planned) {
          console.log(`  ${p.id.padEnd(38)} ${(p.workspace || '—').padEnd(34)} ${mb(p.size).padStart(10)}  ${stamp(p.mtime)}`)
        }
      }
      if (!apply) {
        console.log('\nnothing was moved (dry-run). re-run with --apply to archive these sessions.')
        return
      }
      console.log(`\nmoved ${r.archived.length} session(s), freed ${mb(r.freedBytes)}`)
      for (const f of r.failed) console.log(`  FAILED ${f.id}: ${f.error}`)
      console.log(`manifest: ${archiveDir}/archive.json`)
      if (r.failed.length) process.exitCode = 1
      return
    }
    case 'unarchive': {
      const { flags, positional } = parseFlags(rest)
      const [archiveDir, root] = positional
      if (!archiveDir || !root) return usage()
      const ids = typeof flags.ids === 'string' ? flags.ids.split(',').filter(Boolean) : undefined
      const r = await unarchiveSessions(archiveDir, root, {
        ids,
        force: flags.force === true,
        purge: flags.purge === true,
      })
      console.log(`restored ${r.restored.length} session(s) to ${root}`)
      if (flags.purge !== true && r.restored.length) console.log('archived copies kept (pass --purge to remove them)')
      return
    }
    case 'archives': {
      const [dir] = rest
      if (!dir) return usage()
      const rows = await listArchive(dir)
      if (!rows.length) { console.log(`no archived sessions in ${dir}`); return }
      console.log(`  ${'id'.padEnd(38)} ${'workspace'.padEnd(34)} ${'size'.padStart(10)}  archived          title`)
      for (const r of rows) {
        console.log(`  ${r.id.padEnd(38)} ${(r.workspace || '—').padEnd(34)} ${mb(r.size).padStart(10)}  ${stamp(r.archivedAt)}  ${r.title || ''}`)
      }
      console.log(`\ntotal: ${rows.length}`)
      return
    }
    default:
      return usage()
  }
}

main().catch((e) => { console.error(String(e?.message ?? e)); process.exit(1) })
