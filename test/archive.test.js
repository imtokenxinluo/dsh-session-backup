// archive core tests: dry-run, apply, filters, unarchive, list.
// Red-green discipline: these are written before src/archive.js exists.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, existsSync, mkdirSync, writeFileSync, readdirSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { buildSessionLog, simpleEvents } from './helpers.mjs'
import { archiveSessions, unarchiveSessions, listArchive, readArchiveManifest } from '../src/archive.js'

async function withDir(fn) {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-archive-'))
  try { await fn(dir) } finally { rmSync(dir, { recursive: true, force: true }) }
}

/** Build a sessions tree: <root>/<workspace>/<id>/session.jsonl.zstd */
function makeSession(root, workspace, id, { ageDays = 0, text = 'hello' } = {}) {
  const dir = path.join(root, workspace, id)
  mkdirSync(dir, { recursive: true })
  const buf = buildSessionLog({
    id,
    events: [{ type: 'user/message', seq: 0, time: 1700000000000, data: { content: [{ type: 'text', text }], source: { kind: 'user' }, role: 'user', id: 'u0' }, surfaceOp: 'append' }],
  })
  const file = path.join(dir, 'session.jsonl.zstd')
  writeFileSync(file, buf)
  if (ageDays > 0) {
    const t = (Date.now() - ageDays * 86400000) / 1000
    utimesSync(file, t, t)
    utimesSync(dir, t, t)
  }
  return file
}

test('dry-run: plans candidates but moves nothing', async () => {
  await withDir(async (root) => {
    const sessions = path.join(root, 'sessions')
    const archive = path.join(root, 'archive')
    makeSession(sessions, '--ws-a--', 'old-1', { ageDays: 40 })
    const r = await archiveSessions(sessions, archive, { olderThanMs: 30 * 86400000 })
    assert.equal(r.apply, false, 'reports dry-run')
    assert.equal(r.planned.length, 1, 'one candidate planned')
    assert.equal(r.archived.length, 0, 'nothing archived')
    assert.ok(existsSync(path.join(sessions, '--ws-a--', 'old-1')), 'source untouched')
    assert.ok(!existsSync(archive), 'archive dir not created in dry-run')
  })
})

test('apply: moves session into archive, removes it from live root, writes manifest', async () => {
  await withDir(async (root) => {
    const sessions = path.join(root, 'sessions')
    const archive = path.join(root, 'archive')
    makeSession(sessions, '--ws-a--', 'old-1', { ageDays: 40 })
    const r = await archiveSessions(sessions, archive, { olderThanMs: 30 * 86400000, apply: true })
    assert.equal(r.archived.length, 1)
    assert.ok(!existsSync(path.join(sessions, '--ws-a--', 'old-1')), 'source session removed')
    assert.ok(existsSync(path.join(archive, 'old-1', 'session.jsonl.zstd')), 'artifact in archive')
    const m = await readArchiveManifest(archive)
    assert.equal(m.sessions.length, 1)
    const e = m.sessions[0]
    assert.equal(e.id, 'old-1')
    assert.equal(e.workspace, '--ws-a--')
    assert.equal(e.relPath, path.join('--ws-a--', 'old-1'))
    assert.ok(e.sha256 && e.sha256.length === 64, 'hash recorded')
    assert.ok(e.archivedAt > 0)
    assert.ok(r.freedBytes > 0, 'reports freed bytes')
  })
})

test('apply: refuses to archive without a filter (guards against wiping everything)', async () => {
  await withDir(async (root) => {
    const sessions = path.join(root, 'sessions')
    makeSession(sessions, '--ws-a--', 's1')
    await assert.rejects(
      () => archiveSessions(sessions, path.join(root, 'archive'), { apply: true }),
      /filter|--older-than|--ids/i,
    )
    assert.ok(existsSync(path.join(sessions, '--ws-a--', 's1')), 'source kept')
  })
})

test('older-than: only archives sessions past the threshold', async () => {
  await withDir(async (root) => {
    const sessions = path.join(root, 'sessions')
    const archive = path.join(root, 'archive')
    makeSession(sessions, '--ws-a--', 'old-1', { ageDays: 40 })
    makeSession(sessions, '--ws-a--', 'fresh-1', { ageDays: 1 })
    const r = await archiveSessions(sessions, archive, { olderThanMs: 30 * 86400000, apply: true })
    assert.deepEqual(r.archived, ['old-1'])
    assert.ok(!existsSync(path.join(sessions, '--ws-a--', 'old-1')))
    assert.ok(existsSync(path.join(sessions, '--ws-a--', 'fresh-1')), 'fresh session kept')
  })
})

test('ids: only archives the named sessions', async () => {
  await withDir(async (root) => {
    const sessions = path.join(root, 'sessions')
    const archive = path.join(root, 'archive')
    makeSession(sessions, '--ws-a--', 'keep-me', { ageDays: 90 })
    makeSession(sessions, '--ws-a--', 'take-me', { ageDays: 90 })
    const r = await archiveSessions(sessions, archive, { ids: ['take-me'], apply: true })
    assert.deepEqual(r.archived, ['take-me'])
    assert.ok(existsSync(path.join(sessions, '--ws-a--', 'keep-me')), 'unlisted session kept')
  })
})

test('older-than 0s: archives everything (0 is a real threshold, not "no filter")', async () => {
  await withDir(async (root) => {
    const sessions = path.join(root, 'sessions')
    const archive = path.join(root, 'archive')
    makeSession(sessions, '--ws-a--', 's1')
    makeSession(sessions, '--ws-a--', 's2')
    const r = await archiveSessions(sessions, archive, { olderThanMs: 0, apply: true })
    assert.equal(r.archived.length, 2)
  })
})

test('unarchive: restores session to its original live path with hash check', async () => {
  await withDir(async (root) => {
    const sessions = path.join(root, 'sessions')
    const archive = path.join(root, 'archive')
    const src = makeSession(sessions, '--ws-a--', 'old-1', { ageDays: 40 })
    const before = readFileSync(src)
    await archiveSessions(sessions, archive, { olderThanMs: 30 * 86400000, apply: true })
    const r = await unarchiveSessions(archive, sessions, {})
    assert.deepEqual(r.restored, ['old-1'])
    const back = path.join(sessions, '--ws-a--', 'old-1', 'session.jsonl.zstd')
    assert.ok(existsSync(back), 'restored to original relative path')
    assert.deepEqual(readFileSync(back), before, 'byte-identical')
  })
})

test('unarchive: refuses to overwrite an existing live session unless forced', async () => {
  await withDir(async (root) => {
    const sessions = path.join(root, 'sessions')
    const archive = path.join(root, 'archive')
    makeSession(sessions, '--ws-a--', 'dup', { ageDays: 40 })
    await archiveSessions(sessions, archive, { olderThanMs: 30 * 86400000, apply: true })
    makeSession(sessions, '--ws-a--', 'dup')   // a new live session reuses the id
    await assert.rejects(() => unarchiveSessions(archive, sessions, {}), /refus|exist/i)
    const r = await unarchiveSessions(archive, sessions, { force: true })
    assert.deepEqual(r.restored, ['dup'])
  })
})

test('list: reports id, workspace, size and a readable title from first user message', async () => {
  await withDir(async (root) => {
    const sessions = path.join(root, 'sessions')
    const archive = path.join(root, 'archive')
    makeSession(sessions, '--ws-a--', 'old-1', { ageDays: 40, text: '打赏罐 UI 三行布局' })
    await archiveSessions(sessions, archive, { olderThanMs: 30 * 86400000, apply: true })
    const rows = await listArchive(archive)
    assert.equal(rows.length, 1)
    assert.equal(rows[0].id, 'old-1')
    assert.equal(rows[0].workspace, '--ws-a--')
    assert.ok(rows[0].size > 0)
    assert.match(rows[0].title, /打赏罐 UI 三行布局/, 'title extracted from first user message')
  })
})
