// dsh-archive.js — restore sessions the harness archived (un-hide them).
//
// DSH's own archiving is NOT a file move. `workspace.archiveSession` records the
// session id in the registry-global archive set persisted at
// `<dsh-home>/storages/workspace.json` → `global.archivedSessionIds`; the session
// artifact stays exactly where it was and keeps its accounting slot, it is simply
// hidden from every grouping surface. The public seam exposes `archiveSession`
// (add) and a read-only `archivedSessionIds` getter — there is **no unarchive**,
// which is what this module provides.
//
// Because the registry holds an in-memory snapshot that is written back on its
// next durable mutation, editing the file while DSH runs can be overwritten.
// Callers must stop DSH first (the CLI warns about this).
//
// Zero runtime deps; reuses the artifact discovery and title extraction used by
// the file-level archive module.

import { readFile, writeFile, rename, mkdir, stat } from 'node:fs/promises'
import path from 'node:path'
import { findArtifacts, sessionIdFromPath } from './backup.js'
import { summarizeSession } from './archive.js'

/** Default location of the workspace registry document inside a DSH home. */
export function workspaceStatePath(dshHome) {
  return path.join(dshHome, 'storages', 'workspace.json')
}

/** Read the registry-global archive set ([] when the field is absent). */
export async function readArchivedSessions(file) {
  const doc = JSON.parse(await readFile(file, 'utf8'))
  const ids = doc?.global?.archivedSessionIds
  return Array.isArray(ids) ? ids.filter((id) => typeof id === 'string') : []
}

/**
 * Remove ids from the archive set (i.e. un-hide those sessions).
 *
 * @param {string} file  path to workspace.json
 * @param {object} opts
 * @param {string[]} [opts.ids]  ids to restore
 * @param {boolean} [opts.all]   restore every archived id
 * @param {boolean} [opts.apply] false (default) = dry-run, nothing is written
 * @returns {Promise<{wouldRestore:string[], restored:string[], unknown:string[], archivedBefore:number, backup?:string}>}
 */
export async function restoreArchivedSessions(file, opts = {}) {
  const { ids, all = false, apply = false } = opts
  const hasIds = Array.isArray(ids) && ids.length > 0
  if (!hasIds && !all) {
    throw new Error('restore-archived: a filter is required — pass --ids <a,b> or --all')
  }
  const doc = JSON.parse(await readFile(file, 'utf8'))
  if (!doc?.global || typeof doc.global !== 'object') {
    throw new Error(`restore-archived: ${file} has no global section`)
  }
  const current = Array.isArray(doc.global.archivedSessionIds) ? doc.global.archivedSessionIds : []
  const wanted = all ? new Set(current) : new Set(ids)
  const wouldRestore = current.filter((id) => wanted.has(id))
  const unknown = hasIds ? ids.filter((id) => !current.includes(id)) : []
  const archivedBefore = current.length

  if (!apply || !wouldRestore.length) {
    return { wouldRestore, restored: [], unknown, archivedBefore }
  }

  // 1. keep the pre-change document verbatim before touching anything
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const backup = `${file}.bak-${stamp}`
  await writeFile(backup, JSON.stringify(doc, null, 2), 'utf8')

  // 2. mutate only the archive set, then swap the file in atomically
  doc.global.archivedSessionIds = current.filter((id) => !wanted.has(id))
  const tmp = `${file}.tmp-${process.pid}`
  await writeFile(tmp, JSON.stringify(doc, null, 2), 'utf8')
  await rename(tmp, file)

  return { wouldRestore, restored: wouldRestore, unknown, archivedBefore, backup }
}

/**
 * For each archived id, report whether its artifact still exists on disk
 * (archived ids whose files were moved away need a file-level restore too).
 */
export async function findArchivedSessions(dshHome, ids, { withTitle = false } = {}) {
  const root = path.join(dshHome, 'sessions')
  const artifacts = await findArtifacts(root)
  const byId = new Map()
  for (const file of artifacts) {
    const id = sessionIdFromPath(file)
    let st
    try { st = await stat(file) } catch { continue }
    byId.set(id, { file, size: st.size, mtime: st.mtimeMs })
  }
  const rows = []
  for (const id of ids) {
    const hit = byId.get(id)
    const row = {
      id,
      present: Boolean(hit),
      size: hit?.size ?? 0,
      mtime: hit?.mtime ?? 0,
      file: hit?.file ?? '',
      workspace: hit ? path.basename(path.dirname(path.dirname(hit.file))) : '',
      title: '',
    }
    if (withTitle && hit) {
      const summary = await summarizeSession(hit.file)
      row.title = summary.title
      row.cwd = summary.cwd
    }
    rows.push(row)
  }
  return rows
}
