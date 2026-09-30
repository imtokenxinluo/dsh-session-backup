// archive.js — move old sessions out of the live sessions root into an archive
// store, and bring them back on demand.
//
// backup.js answers "what if the session store is lost?" — it copies and never
// touches the source. This module answers a different question: "the store keeps
// growing, how do I park old sessions somewhere else and get them back later?"
//
// Safety rules (deliberate, non-negotiable):
//   1. Copy first, verify sha256 of every archived file, and only then delete the
//      source. A failed verification leaves the live session untouched.
//   2. Dry-run by default. `apply: true` is required to move anything.
//   3. A filter (`olderThanMs` or `ids`) is mandatory — there is no "archive
//      everything" path, because that is one typo away from an empty store.
//   4. Restoring refuses to overwrite an existing live session unless forced.
//
// Zero runtime deps; reuses the zstd frame decoder used by scan/backup.

import { readFile, writeFile, mkdir, stat, rm, readdir } from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { findArtifacts, sessionIdFromPath } from './backup.js'
import { scanSessionFile } from './scan.js'
import { decodeFrames, splitLines } from './zstd.js'

const ARCHIVE_MANIFEST = 'archive.json'

export function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex')
}

async function exists(p) {
  try { await stat(p); return true } catch { return false }
}

/** List every file under `dir`, returned as paths relative to `dir`. */
async function listFiles(dir) {
  const out = []
  async function walk(current) {
    let entries
    try { entries = await readdir(current, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      const full = path.join(current, e.name)
      if (e.isDirectory()) await walk(full)
      else if (e.isFile()) out.push(path.relative(dir, full))
    }
  }
  await walk(dir)
  return out.sort()
}

/** Read the archive manifest; null when absent or unreadable. */
export async function readArchiveManifest(archiveDir) {
  try {
    const parsed = JSON.parse(await readFile(path.join(archiveDir, ARCHIVE_MANIFEST), 'utf8'))
    if (!parsed || !Array.isArray(parsed.sessions)) return null
    return parsed
  } catch { return null }
}

/** Pull the session cwd and a readable title (first user message) out of an artifact. */
export async function summarizeSession(file) {
  try {
    const text = decodeFrames(await readFile(file))
    const { lines } = splitLines(text)
    let cwd = ''
    let title = ''
    for (const line of lines) {
      let ev
      try { ev = JSON.parse(line) } catch { continue }
      if (!cwd && ev?.type === 'session' && typeof ev.cwd === 'string') cwd = ev.cwd
      if (!title && ev?.type === 'user/message') {
        const content = ev?.data?.content
        if (Array.isArray(content)) {
          const hit = content.find((c) => c?.type === 'text' && typeof c.text === 'string' && c.text.trim())
          if (hit) title = hit.text.replace(/\s+/g, ' ').trim().slice(0, 80)
        }
      }
      if (cwd && title) break
    }
    return { cwd, title }
  } catch {
    return { cwd: '', title: '' }
  }
}

/**
 * Plan (and optionally perform) archiving of sessions under `root` into `archiveDir`.
 *
 * @param {string} root      live sessions root
 * @param {string} archiveDir archive store
 * @param {object} [opts]
 * @param {number} [opts.olderThanMs] only sessions last modified longer ago than this
 * @param {string[]} [opts.ids]       only these session ids
 * @param {boolean} [opts.apply]      false (default) = dry-run, nothing moves
 * @param {number} [opts.now]         clock injection for tests
 * @returns {Promise<{apply:boolean, planned:object[], archived:string[], failed:object[], freedBytes:number}>}
 */
export async function archiveSessions(root, archiveDir, opts = {}) {
  const { olderThanMs, ids, apply = false, now = Date.now() } = opts
  const hasAgeFilter = olderThanMs !== undefined && olderThanMs !== null
  const hasIdFilter = Array.isArray(ids) && ids.length > 0
  if (!hasAgeFilter && !hasIdFilter) {
    throw new Error('archive: a filter is required — pass olderThanMs (--older-than) or ids (--ids)')
  }
  const wanted = hasIdFilter ? new Set(ids) : null
  const artifacts = await findArtifacts(root)
  const planned = []

  for (const file of artifacts) {
    const id = sessionIdFromPath(file)
    if (wanted && !wanted.has(id)) continue
    let st
    try { st = await stat(file) } catch { continue }
    // olderThanMs <= 0 means "no age limit" (everything matches). A strict `0`
    // comparison would also be wrong on filesystems whose mtime carries sub-ms
    // precision, where a just-written file can look fractionally "in the future".
    if (hasAgeFilter && olderThanMs > 0 && now - st.mtimeMs < olderThanMs) continue
    const sessionDir = path.dirname(file)
    const relPath = path.relative(root, sessionDir)
    const parts = relPath.split(path.sep).filter(Boolean)
    planned.push({
      id,
      workspace: parts.length > 1 ? parts[0] : '',
      relPath,
      sessionDir,
      file,
      fileName: path.basename(file),
      size: st.size,
      mtime: st.mtimeMs,
    })
  }

  if (!apply) return { apply: false, planned, archived: [], failed: [], freedBytes: 0 }

  await mkdir(archiveDir, { recursive: true })
  const previous = await readArchiveManifest(archiveDir)
  const byId = new Map((previous?.sessions ?? []).map((s) => [s.id, s]))
  const archived = []
  const failed = []
  let freedBytes = 0

  for (const candidate of planned) {
    try {
      const destDir = path.join(archiveDir, candidate.id)
      const relFiles = await listFiles(candidate.sessionDir)
      if (!relFiles.length) throw new Error('session directory is empty')

      // 1. copy every file, then 2. verify hashes before touching the source
      await mkdir(destDir, { recursive: true })
      const files = []
      for (const rel of relFiles) {
        const src = path.join(candidate.sessionDir, rel)
        const dst = path.join(destDir, rel)
        const buf = await readFile(src)
        await mkdir(path.dirname(dst), { recursive: true })
        await writeFile(dst, buf)
        const copy = await readFile(dst)
        const h = sha256(buf)
        if (sha256(copy) !== h) throw new Error(`archive verify failed for ${candidate.id}/${rel}`)
        files.push({ name: rel, size: buf.length, sha256: h })
      }

      const primary = files.find((f) => f.name === path.basename(candidate.file)) ?? files[0]
      const scan = await scanSessionFile(candidate.file)
      const summary = await summarizeSession(candidate.file)

      // 3. verified — now it is safe to drop the live copy
      await rm(candidate.sessionDir, { recursive: true, force: true })
      // remove the workspace folder when it just became empty
      const parent = path.dirname(candidate.sessionDir)
      if (path.relative(root, parent) && (await readdir(parent)).length === 0) {
        await rm(parent, { recursive: true, force: true })
      }

      byId.set(candidate.id, {
        id: candidate.id,
        workspace: candidate.workspace,
        relPath: candidate.relPath,
        fileName: candidate.fileName,
        size: candidate.size,
        mtime: candidate.mtime,
        sha256: primary.sha256,
        status: scan.ok ? 'ok' : 'corrupt',
        files,
        cwd: summary.cwd,
        title: summary.title,
        archivedAt: Date.now(),
        ...(scan.ok ? {} : { findings: scan.findings?.map((f) => `${f.seq ?? '?'} ${f.reason}`).slice(0, 5) }),
      })
      archived.push(candidate.id)
      freedBytes += files.reduce((n, f) => n + f.size, 0)
    } catch (error) {
      failed.push({ id: candidate.id, error: String(error?.message ?? error) })
    }
  }

  const manifest = { version: 1, updatedAt: Date.now(), sessions: [...byId.values()] }
  await writeFile(path.join(archiveDir, ARCHIVE_MANIFEST), JSON.stringify(manifest, null, 2), 'utf8')
  return { apply: true, planned, archived, failed, freedBytes }
}

/**
 * Restore archived sessions back into the live sessions root.
 * Refuses to overwrite an existing live session unless `force`.
 *
 * @returns {Promise<{restored:string[], failed:object[]}>}
 */
export async function unarchiveSessions(archiveDir, root, opts = {}) {
  const { ids, force = false, purge = false } = opts
  const manifest = await readArchiveManifest(archiveDir)
  if (!manifest) throw new Error(`unarchive: no valid archive manifest in ${archiveDir}`)
  const wanted = ids && ids.length ? new Set(ids) : null
  const restored = []
  const failed = []

  for (const entry of manifest.sessions) {
    if (wanted && !wanted.has(entry.id)) continue
    try {
      const srcDir = path.join(archiveDir, entry.id)
      const destDir = path.join(root, entry.relPath)
      if (!(await exists(srcDir))) throw new Error(`archived copy missing for ${entry.id}`)
      if ((await exists(destDir)) && !force) {
        throw new Error(`refusing to overwrite existing ${destDir} (use --force)`)
      }
      const files = entry.files?.length ? entry.files : [{ name: entry.fileName, size: entry.size, sha256: entry.sha256 }]
      for (const f of files) {
        const buf = await readFile(path.join(srcDir, f.name))
        if (f.sha256 && sha256(buf) !== f.sha256) throw new Error(`hash mismatch for ${entry.id}/${f.name}`)
        const out = path.join(destDir, f.name)
        await mkdir(path.dirname(out), { recursive: true })
        await writeFile(out, buf)
      }
      restored.push(entry.id)
      if (purge) await rm(srcDir, { recursive: true, force: true })
    } catch (error) {
      const message = String(error?.message ?? error)
      if (/refusing to overwrite/.test(message)) throw error   // hard stop: caller asked to protect live data
      failed.push({ id: entry.id, error: message })
    }
  }
  if (failed.length) throw new Error(`unarchive failed for ${failed.map((f) => f.id).join(', ')}: ${failed[0].error}`)
  return { restored, failed }
}

/** List archived sessions (newest first) with a readable title. */
export async function listArchive(archiveDir) {
  const manifest = await readArchiveManifest(archiveDir)
  if (!manifest) return []
  return manifest.sessions
    .map((s) => ({
      id: s.id,
      workspace: s.workspace,
      relPath: s.relPath,
      size: s.size,
      status: s.status ?? 'ok',
      title: s.title ?? '',
      cwd: s.cwd ?? '',
      archivedAt: s.archivedAt ?? 0,
      mtime: s.mtime ?? 0,
    }))
    .sort((a, b) => b.archivedAt - a.archivedAt)
}
