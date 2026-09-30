#!/usr/bin/env node
// Restore sessions archived by the harness.
//
// Two things can make an archived session unreachable:
//   1. the registry flag — workspace.json → global.archivedSessionIds (hides it from
//      every list/search surface while the artifact stays on disk), and
//   2. a manual file move — the artifact was also relocated into an _archived_*
//      folder, so even after clearing the flag the session would have no file.
//
// This script fixes both in one pass, copying-then-verifying before it removes
// anything, and only mutating the registry after the file is safely back.
//
// usage:
//   node scripts/restore-harness-archived.mjs <dsh-home> [options]
//
// options:
//   --moved-from <dir>   folder holding sessions moved aside (repeatable), e.g.
//                        <dsh-home>/_archived_sessions/scheduled-runs-20260913
//   --workspace <slug>   workspace folder to restore files into when the original
//                        is unknown (default: --D-tool-claude_code--)
//   --ids a,b            restore only these ids (default: all archived ids)
//   --apply              actually write; without it this is a dry-run
//
// ⚠️ STOP DSH FIRST. The workspace registry keeps an in-memory snapshot and will
// overwrite an external edit of workspace.json on its next write.

import { readFile, writeFile, rename, mkdir, stat, readdir, rm } from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'

const DEFAULT_WORKSPACE = '--D-tool-claude_code--'

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex')
}

async function exists(p) {
  try { await stat(p); return true } catch { return false }
}

function parseArgs(argv) {
  const opts = { movedFrom: [], ids: undefined, workspace: DEFAULT_WORKSPACE, apply: false, dshHome: undefined }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--apply') opts.apply = true
    else if (a === '--moved-from') opts.movedFrom.push(argv[++i])
    else if (a === '--workspace') opts.workspace = argv[++i]
    else if (a === '--ids') opts.ids = argv[++i].split(',').filter(Boolean)
    else if (!a.startsWith('--') && !opts.dshHome) opts.dshHome = a
  }
  return opts
}

/** Map session id -> artifact path for everything currently under sessions/. */
async function indexLiveSessions(sessionsRoot) {
  const byId = new Map()
  async function walk(dir) {
    let entries
    try { entries = await readdir(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      const full = path.join(dir, e.name)
      if (e.isDirectory()) await walk(full)
      else if (e.isFile() && /^session\.jsonl(\.zstd)?$/.test(e.name)) byId.set(path.basename(dir), full)
    }
  }
  await walk(sessionsRoot)
  return byId
}

/** Find a session directory (containing session.jsonl[.zstd]) under the move sources. */
async function findMovedSession(id, sources) {
  for (const src of sources) {
    const candidate = path.join(src, id)
    if (!(await exists(candidate))) continue
    const entries = await readdir(candidate)
    const artifact = entries.find((f) => /^session\.jsonl(\.zstd)?$/.test(f))
    if (artifact) return { dir: candidate, artifact, fileName: artifact }
  }
  return null
}

/** Move a directory with copy → verify → remove (never lose the only copy). */
async function moveVerified(srcDir, destDir) {
  const files = []
  async function collect(dir, rel = '') {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name)
      const nextRel = path.join(rel, e.name)
      if (e.isDirectory()) await collect(full, nextRel)
      else files.push({ full, rel: nextRel })
    }
  }
  await collect(srcDir)
  await mkdir(destDir, { recursive: true })
  const digests = []
  for (const f of files) {
    const buf = await readFile(f.full)
    const out = path.join(destDir, f.rel)
    await mkdir(path.dirname(out), { recursive: true })
    await writeFile(out, buf)
    const copy = await readFile(out)
    const h = sha256(buf)
    if (sha256(copy) !== h) throw new Error(`verify failed for ${f.rel}`)
    digests.push({ rel: f.rel, sha256: h, size: buf.length })
  }
  await rm(srcDir, { recursive: true, force: true })
  return digests
}

async function main() {
  const opts = parseArgs(process.argv.slice(2))
  if (!opts.dshHome) {
    console.error('usage: node scripts/restore-harness-archived.mjs <dsh-home> [--moved-from <dir>] [--workspace <slug>] [--ids a,b] [--apply]')
    process.exit(2)
  }
  const stateFile = path.join(opts.dshHome, 'storages', 'workspace.json')
  const sessionsRoot = path.join(opts.dshHome, 'sessions')
  const doc = JSON.parse(await readFile(stateFile, 'utf8'))
  const archived = Array.isArray(doc?.global?.archivedSessionIds) ? doc.global.archivedSessionIds : []
  const wanted = opts.ids ? archived.filter((id) => opts.ids.includes(id)) : archived
  const live = await indexLiveSessions(sessionsRoot)

  console.log(`dsh home   : ${opts.dshHome}`)
  console.log(`archive set: ${archived.length} session(s)${opts.ids ? `, ${wanted.length} selected` : ''}`)
  console.log(`mode       : ${opts.apply ? 'APPLY' : 'dry-run'}\n`)
  if (!wanted.length) { console.log('nothing to do.'); return }

  const plan = { onDisk: [], toMove: [], missing: [] }
  for (const id of wanted) {
    if (live.has(id)) { plan.onDisk.push(id); continue }
    const moved = await findMovedSession(id, opts.movedFrom)
    if (moved) plan.toMove.push({ id, ...moved })
    else plan.missing.push(id)
  }

  console.log(`already on disk (only the flag needs clearing): ${plan.onDisk.length}`)
  console.log(`moved aside     (file must come back first)  : ${plan.toMove.length}`)
  console.log(`no artifact anywhere                         : ${plan.missing.length}`)
  if (plan.missing.length) for (const id of plan.missing) console.log(`   ⚠️ ${id} — cannot restore (no file found)`)
  console.log()

  if (!opts.apply) {
    console.log('dry-run: nothing written. re-run with --apply (DSH stopped) to perform the restore.')
    return
  }

  // 1. put moved artifacts back first, so clearing the flag never reveals an empty session
  let moved = 0
  for (const item of plan.toMove) {
    const destDir = path.join(sessionsRoot, opts.workspace, item.id)
    if (await exists(destDir)) {
      console.log(`   skip ${item.id}: destination already exists`)
      continue
    }
    await moveVerified(item.dir, destDir)
    moved++
    console.log(`   moved ${item.id} -> ${path.relative(opts.dshHome, destDir)}`)
  }

  // 2. clear the registry flag (timestamped backup + atomic swap inside)
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const backup = `${stateFile}.bak-${stamp}`
  await writeFile(backup, JSON.stringify(doc, null, 2), 'utf8')
  doc.global.archivedSessionIds = archived.filter((id) => !wanted.includes(id))
  const tmp = `${stateFile}.tmp-${process.pid}`
  await writeFile(tmp, JSON.stringify(doc, null, 2), 'utf8')
  await rename(tmp, stateFile)

  console.log(`\nfiles moved      : ${moved}`)
  console.log(`flags cleared    : ${wanted.length - plan.missing.length}`)
  if (plan.missing.length) console.log(`left archived    : ${plan.missing.length} (no artifact found)`)
  console.log(`registry backup  : ${backup}`)
  console.log(`\n✅ done — restart DSH to see the sessions again.`)
}

main().catch((e) => { console.error(String(e?.message ?? e)); process.exit(1) })
