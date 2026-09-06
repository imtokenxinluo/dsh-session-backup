// backup.js — DSH session cold-backup core: full + incremental + pre-validate + restore.
//
// A session's history is the only durable memory of a person⇄DSH exchange. This
// module gives that memory a cold backup: copy each session artifact into a
// target directory with a manifest (id / source / time / size / sha256 /
// loader-mirror status), skip unchanged files on later runs, and restore from
// the manifest with hash verification.
//
// Zero runtime deps. Works on the on-disk artifact layout DSH's JSONL backend
// uses (…/sessions/<project>/<session-id>/session.jsonl.zstd) and on any flat
// tree of the same artifact names.

import { readFile, writeFile, mkdir, copyFile, stat, readdir } from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { scanSessionFile } from './scan.js'

const MANIFEST = 'manifest.json'

export function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex')
}

/** Discover session artifacts under a root (any nesting). */
export async function findArtifacts(root) {
  const found = []
  async function walk(dir) {
    let entries
    try { entries = await readdir(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      const full = path.join(dir, e.name)
      if (e.isDirectory()) await walk(full)
      else if (e.isFile() && (e.name === 'session.jsonl.zstd' || e.name === 'session.jsonl')) found.push(full)
    }
  }
  await walk(root)
  return found
}

/** Derive a session id from its artifact path: in DSH's layout the artifact
 * (session.jsonl.zstd) always sits directly under a directory whose name IS
 * the session id (session-…, scheduled-run-…, or a bare uuid). Flat trees
 * (artifact directly in the scanned root) fall back to the file stem. */
export function sessionIdFromPath(file) {
  const parent = path.basename(path.dirname(file))
  const artifactName = path.basename(file)
  // artifact named session.jsonl[.zstd] under a real dir → dir is the id
  if (/^session\.jsonl(\.zstd)?$/.test(artifactName) && parent && parent !== path.sep) return parent
  return artifactName.replace(/\.jsonl(\.zstd)?$/, '')
}

/** Read a manifest from a backup dir; null when absent/corrupt. */
export async function readManifest(target) {
  try {
    const raw = await readFile(path.join(target, MANIFEST), 'utf8')
    const m = JSON.parse(raw)
    if (!m || !Array.isArray(m.sessions)) return null
    return m
  } catch { return null }
}

/**
 * Backup sessions under `root` into `target`.
 * @returns {{ sessions: string[], skipped: number, corrupt: string[], manifest: object }}
 */
export async function backupSessionRoot(root, target) {
  const artifacts = await findArtifacts(root)
  const prev = await readManifest(target)
  const prevById = new Map((prev?.sessions ?? []).map((s) => [s.id, s]))

  await mkdir(target, { recursive: true })
  const copied = []
  const corrupt = []
  let skipped = 0

  for (const file of artifacts) {
    const id = sessionIdFromPath(file)
    let st
    try { st = await stat(file) } catch { continue }
    // incremental: unchanged (size + mtime match manifest) → skip
    const known = prevById.get(id)
    if (known && known.size === st.size && known.mtime === st.mtimeMs && known.status !== 'corrupt') {
      skipped++
      continue
    }
    let buf
    try { buf = await readFile(file) } catch { continue }
    const h = sha256(buf)
    const dest = path.join(target, id, path.basename(file))
    await mkdir(path.dirname(dest), { recursive: true })
    await copyFile(file, dest)
    // pre-validation (loader-mirror) on the SOURCE content
    const scan = await scanSessionFile(file)
    const status = scan.ok ? 'ok' : 'corrupt'
    if (!scan.ok) corrupt.push(id)
    const entry = {
      id,
      source: file,
      fileName: path.basename(file),
      size: st.size,
      mtime: st.mtimeMs,
      sha256: h,
      status,
      backedUpAt: Date.now(),
      ...(!scan.ok ? { findings: scan.findings?.map((f) => `${f.seq ?? '?'} ${f.reason}`).slice(0, 5) } : {}),
    }
    copied.push(entry)
    prevById.set(id, entry)
  }

  const manifest = { version: 1, createdAt: Date.now(), sessions: [...prevById.values()] }
  await writeFile(path.join(target, MANIFEST), JSON.stringify(manifest, null, 2), 'utf8')
  return { copied: copied.map((s) => s.id), skipped, corrupt, manifest }
}

/**
 * Restore sessions from a backup dir's manifest into `dest`.
 * Refuses to overwrite existing files unless `force`.
 * @returns {Promise<string[]>} restored session ids
 */
export async function restoreFromManifest(target, dest, { force = false, ids } = {}) {
  const manifest = await readManifest(target)
  if (!manifest) throw new Error(`restore: no valid manifest in ${target}`)
  const wanted = ids ? new Set(ids) : null
  const restored = []
  for (const entry of manifest.sessions) {
    if (wanted && !wanted.has(entry.id)) continue
    const src = path.join(target, entry.id, entry.fileName)
    const out = path.join(dest, entry.id, entry.fileName)
    try {
      const buf = await readFile(src)
      if (sha256(buf) !== entry.sha256) throw new Error(`hash mismatch for ${entry.id} (backup corrupt?)`)
      if (await exists(out) && !force) throw new Error(`refusing to overwrite existing ${out} (use --force)`)
      await mkdir(path.dirname(out), { recursive: true })
      await writeFile(out, buf)
      restored.push(entry.id)
    } catch (e) {
      if (/refusing to overwrite/.test(String(e.message))) throw e
      // read/hash failure: report but continue others? Spec says restore verifies; a corrupt backup entry should fail loud.
      throw new Error(`restore failed for ${entry.id}: ${e.message}`)
    }
  }
  return restored
}

async function exists(p) {
  try { await stat(p); return true } catch { return false }
}
