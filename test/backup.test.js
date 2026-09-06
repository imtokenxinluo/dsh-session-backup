// backup core tests: full, incremental, pre-validation, restore.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, existsSync, mkdirSync, writeFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { buildSessionLog, simpleEvents } from './helpers.mjs'
import { backupSessionRoot, restoreFromManifest } from '../src/backup.js'
import { scanSessionFile } from '../src/scan.js'

async function withDir(fn) {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-backup-'))
  try { await fn(dir) } finally { rmSync(dir, { recursive: true, force: true }) }
}

function sha256(buf) { return createHash('sha256').update(buf).digest('hex') }

test('full backup: copies sessions and writes manifest with hash/status', async () => {
  await withDir(async (root) => {
    const sessions = path.join(root, 'sessions')
    const target = path.join(root, 'backup')
    mkdirSync(path.join(sessions, 'session-a'), { recursive: true })
    mkdirSync(path.join(sessions, 'session-b'), { recursive: true })
    const bufA = buildSessionLog({ id: 'session-a', events: simpleEvents({ n: 2 }) })
    const bufB = buildSessionLog({ id: 'session-b', events: simpleEvents({ n: 2 }) })
    writeFileSync(path.join(sessions, 'session-a', 'session.jsonl.zstd'), bufA)
    writeFileSync(path.join(sessions, 'session-b', 'session.jsonl.zstd'), bufB)

    const result = await backupSessionRoot(sessions, target)
    assert.equal(result.copied.length, 2)
    assert.equal(result.skipped, 0)
    assert.equal(result.corrupt.length, 0)
    const manifestPath = path.join(target, 'manifest.json')
    assert.ok(existsSync(manifestPath), 'manifest written')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    assert.equal(manifest.sessions.length, 2)
    const a = manifest.sessions.find((s) => s.id === 'session-a')
    assert.ok(a, 'session-a in manifest')
    assert.equal(a.status, 'ok')
    assert.equal(a.sha256, sha256(bufA))
    const backedA = path.join(target, 'session-a', 'session.jsonl.zstd')
    assert.ok(existsSync(backedA), 'backup file exists')
    assert.equal(sha256(readFileSync(backedA)), sha256(bufA), 'backup bytes identical')
  })
})

test('incremental: second run skips unchanged sessions', async () => {
  await withDir(async (root) => {
    const sessions = path.join(root, 'sessions')
    const target = path.join(root, 'backup')
    mkdirSync(path.join(sessions, 'session-a'), { recursive: true })
    const bufA = buildSessionLog({ id: 'session-a', events: simpleEvents({ n: 2 }) })
    writeFileSync(path.join(sessions, 'session-a', 'session.jsonl.zstd'), bufA)

    const r1 = await backupSessionRoot(sessions, target)
    assert.equal(r1.copied.length, 1)
    const r2 = await backupSessionRoot(sessions, target)
    assert.equal(r2.skipped, 1)
    assert.equal(r2.copied.length, 0, 'no new copies on unchanged')
    // change session -> re-copied
    const bufA2 = buildSessionLog({ id: 'session-a', events: simpleEvents({ n: 4 }) })
    writeFileSync(path.join(sessions, 'session-a', 'session.jsonl.zstd'), bufA2)
    const r3 = await backupSessionRoot(sessions, target)
    assert.equal(r3.copied.length, 1)
    assert.equal(r3.skipped, 0)
  })
})

test('pre-validation: corrupt session marked, still backed up, reported not silent', async () => {
  await withDir(async (root) => {
    const sessions = path.join(root, 'sessions')
    const target = path.join(root, 'backup')
    mkdirSync(path.join(sessions, 'session-good'), { recursive: true })
    mkdirSync(path.join(sessions, 'session-bad'), { recursive: true })
    const good = buildSessionLog({ id: 'session-good', events: simpleEvents({ n: 2 }) })
    const bad = buildSessionLog({ id: 'session-bad', events: simpleEvents({ n: 3, bad: true }) })
    writeFileSync(path.join(sessions, 'session-good', 'session.jsonl.zstd'), good)
    writeFileSync(path.join(sessions, 'session-bad', 'session.jsonl.zstd'), bad)

    const result = await backupSessionRoot(sessions, target)
    assert.equal(result.corrupt.length, 1, 'bad session reported')
    assert.equal(result.corrupt[0], 'session-bad')
    const manifest = JSON.parse(readFileSync(path.join(target, 'manifest.json'), 'utf8'))
    const badEntry = manifest.sessions.find((s) => s.id === 'session-bad')
    assert.equal(badEntry.status, 'corrupt', 'manifest marks corrupt')
    assert.ok(existsSync(path.join(target, 'session-bad', 'session.jsonl.zstd')), 'corrupt session still backed up')
    const goodEntry = manifest.sessions.find((s) => s.id === 'session-good')
    assert.equal(goodEntry.status, 'ok')
  })
})

test('restore: writes sessions back from manifest, verifies hash, loader-clean', async () => {
  await withDir(async (root) => {
    const sessions = path.join(root, 'sessions')
    const target = path.join(root, 'backup')
    const restoreTo = path.join(root, 'restored')
    mkdirSync(path.join(sessions, 'session-a'), { recursive: true })
    const bufA = buildSessionLog({ id: 'session-a', events: simpleEvents({ n: 3 }) })
    writeFileSync(path.join(sessions, 'session-a', 'session.jsonl.zstd'), bufA)

    await backupSessionRoot(sessions, target)
    const restored = await restoreFromManifest(target, restoreTo)
    assert.equal(restored.length, 1)
    const outFile = path.join(restoreTo, 'session-a', 'session.jsonl.zstd')
    assert.ok(existsSync(outFile), 'restored file exists')
    assert.equal(sha256(readFileSync(outFile)), sha256(bufA), 'restored bytes identical')
    const scan = await scanSessionFile(outFile)
    assert.equal(scan.ok, true, 'restored session loader-clean')
  })
})

test('restore refuses overwrite without --force', async () => {
  await withDir(async (root) => {
    const sessions = path.join(root, 'sessions')
    const target = path.join(root, 'backup')
    const restoreTo = path.join(root, 'restored')
    mkdirSync(path.join(sessions, 'session-a'), { recursive: true })
    writeFileSync(path.join(sessions, 'session-a', 'session.jsonl.zstd'), buildSessionLog({ id: 'session-a', events: simpleEvents({ n: 2 }) }))
    await backupSessionRoot(sessions, target)
    mkdirSync(path.join(restoreTo, 'session-a'), { recursive: true })
    writeFileSync(path.join(restoreTo, 'session-a', 'session.jsonl.zstd'), 'existing')
    await assert.rejects(() => restoreFromManifest(target, restoreTo), /refus/i)
    // --force succeeds
    const ok = await restoreFromManifest(target, restoreTo, { force: true })
    assert.equal(ok.length, 1)
  })
})
