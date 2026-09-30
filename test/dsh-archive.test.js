// DSH-level archive restore tests: un-hide sessions archived by the harness.
// Red-green: written before src/dsh-archive.js exists.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { readArchivedSessions, restoreArchivedSessions, findArchivedSessions } from '../src/dsh-archive.js'

async function withDir(fn) {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-unarchive-'))
  try { await fn(dir) } finally { rmSync(dir, { recursive: true, force: true }) }
}

/** A realistic slice of workspace.json (unit/global/tables), with archived ids. */
function writeWorkspace(dshHome, archivedIds) {
  const p = path.join(dshHome, 'storages', 'workspace.json')
  mkdirSync(path.dirname(p), { recursive: true })
  const doc = {
    unit: { domain: 'workspace', version: 2 },
    global: {
      initialized: true,
      workspaceIds: ['ws-1'],
      archivedSessionIds: archivedIds,
    },
    tables: { workspaces: { 'ws-1': { id: 'ws-1', path: 'D:\\tool\\claude_code' } } },
  }
  writeFileSync(p, JSON.stringify(doc, null, 2))
  return p
}

test('readArchivedSessions: returns the archive set', async () => {
  await withDir(async (dir) => {
    writeWorkspace(dir, ['session-a', 'session-b'])
    const ids = await readArchivedSessions(path.join(dir, 'storages', 'workspace.json'))
    assert.deepEqual(ids, ['session-a', 'session-b'])
  })
})

test('readArchivedSessions: tolerates a missing archive field', async () => {
  await withDir(async (dir) => {
    const p = path.join(dir, 'storages', 'workspace.json')
    mkdirSync(path.dirname(p), { recursive: true })
    writeFileSync(p, JSON.stringify({ unit: {}, global: {}, tables: {} }))
    assert.deepEqual(await readArchivedSessions(p), [])
  })
})

test('restoreArchivedSessions: dry-run reports but does not write', async () => {
  await withDir(async (dir) => {
    const p = writeWorkspace(dir, ['session-a', 'session-b'])
    const before = readFileSync(p, 'utf8')
    const r = await restoreArchivedSessions(p, { ids: ['session-a'] })
    assert.deepEqual(r.wouldRestore, ['session-a'])
    assert.equal(r.restored.length, 0)
    assert.equal(readFileSync(p, 'utf8'), before, 'file untouched in dry-run')
    assert.ok(!readdirSync(path.dirname(p)).some((f) => f.includes('.bak')), 'no backup written in dry-run')
  })
})

test('restoreArchivedSessions: apply removes the ids and keeps every other field', async () => {
  await withDir(async (dir) => {
    const p = writeWorkspace(dir, ['session-a', 'session-b', 'session-c'])
    const r = await restoreArchivedSessions(p, { ids: ['session-a', 'session-c'], apply: true })
    assert.deepEqual(r.restored.sort(), ['session-a', 'session-c'])
    const after = JSON.parse(readFileSync(p, 'utf8'))
    assert.deepEqual(after.global.archivedSessionIds, ['session-b'], 'only the named ids removed')
    assert.deepEqual(after.global.workspaceIds, ['ws-1'], 'workspaceIds preserved')
    assert.equal(after.global.initialized, true, 'other global fields preserved')
    assert.deepEqual(after.unit, { domain: 'workspace', version: 2 }, 'unit preserved')
    assert.ok(after.tables.workspaces['ws-1'], 'tables preserved')
  })
})

test('restoreArchivedSessions: writes a timestamped backup before mutating', async () => {
  await withDir(async (dir) => {
    const p = writeWorkspace(dir, ['session-a'])
    await restoreArchivedSessions(p, { ids: ['session-a'], apply: true })
    const backups = readdirSync(path.dirname(p)).filter((f) => f.includes('workspace.json.bak'))
    assert.equal(backups.length, 1, 'exactly one backup')
    const backup = JSON.parse(readFileSync(path.join(path.dirname(p), backups[0]), 'utf8'))
    assert.deepEqual(backup.global.archivedSessionIds, ['session-a'], 'backup holds the pre-change state')
  })
})

test('restoreArchivedSessions: refuses without a filter (no accidental mass restore)', async () => {
  await withDir(async (dir) => {
    const p = writeWorkspace(dir, ['session-a'])
    await assert.rejects(() => restoreArchivedSessions(p, { apply: true }), /filter|--ids|--all/i)
  })
})

test('restoreArchivedSessions: unknown ids are reported, not fatal', async () => {
  await withDir(async (dir) => {
    const p = writeWorkspace(dir, ['session-a'])
    const r = await restoreArchivedSessions(p, { ids: ['nope', 'session-a'], apply: true })
    assert.deepEqual(r.restored, ['session-a'])
    assert.deepEqual(r.unknown, ['nope'])
  })
})

test('restoreArchivedSessions: all=true clears the whole set', async () => {
  await withDir(async (dir) => {
    const p = writeWorkspace(dir, ['session-a', 'session-b'])
    const r = await restoreArchivedSessions(p, { all: true, apply: true })
    assert.equal(r.restored.length, 2)
    const after = JSON.parse(readFileSync(p, 'utf8'))
    assert.deepEqual(after.global.archivedSessionIds, [])
  })
})

test('findArchivedSessions: reports which archived sessions still exist on disk', async () => {
  await withDir(async (dir) => {
    const sessions = path.join(dir, 'sessions', '--ws--')
    mkdirSync(path.join(sessions, 'session-a'), { recursive: true })
    writeFileSync(path.join(sessions, 'session-a', 'session.jsonl.zstd'), Buffer.from('x'))
    const rows = await findArchivedSessions(dir, ['session-a', 'session-gone'])
    assert.equal(rows.length, 2)
    assert.equal(rows.find((r) => r.id === 'session-a').present, true)
    assert.equal(rows.find((r) => r.id === 'session-gone').present, false)
  })
})
