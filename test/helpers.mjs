// Fixture helpers: build small session logs + fake sessions tree.
import { zstdCompressSync, constants } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'

export const CHECKSUM_OPTIONS = { params: { [constants.ZSTD_c_checksumFlag]: 1 } }

export function frame(text) {
  return zstdCompressSync(Buffer.from(text, 'utf8'), CHECKSUM_OPTIONS)
}

export function buildSessionLog({ id = 'session-test', events = [] }) {
  const header = { type: 'session', version: 0, id, createdAt: 1700000000000, cwd: 'C:\\test', delegationDepth: 0, agentPreset: 'standard' }
  const parts = [frame(JSON.stringify(header) + '\n')]
  let chunk = ''
  for (const ev of events) {
    chunk += JSON.stringify(ev) + '\n'
    if (chunk.length > 4000) { parts.push(frame(chunk)); chunk = '' }
  }
  if (chunk) parts.push(frame(chunk))
  return Buffer.concat(parts)
}

export function simpleEvents({ n = 3, bad = false } = {}) {
  const evs = []
  for (let i = 0; i < n; i++) {
    if (bad && i === n - 1) {
      evs.push({
        type: 'tool/result', seq: i, time: 1700000000000 + i,
        data: {
          turn: 1, step: 1,
          message: {
            source: { kind: 'tool', callId: 'c1' },
            content: [{ type: 'tool-result', toolCallId: 'c1', content: 'Wrote 42 bytes' }],
            role: 'user', id: `m${i}`,
          },
        },
        surfaceOp: 'append',
      })
    } else {
      evs.push({
        type: 'user/message', seq: i, time: 1700000000000 + i,
        data: { content: [{ type: 'text', text: `hello ${i}` }], source: { kind: 'user' }, role: 'user', id: `u${i}` },
        surfaceOp: 'append',
      })
    }
  }
  return evs
}

/** Write a session artifact at <dir>/<id>/session.jsonl.zstd. Returns the path. */
export function writeSession(dir, id, buffer) {
  const p = `${dir}/${id}/session.jsonl.zstd`
  mkdirSync(`${dir}/${id}`, { recursive: true })
  writeFileSync(p, buffer)
  return p
}
