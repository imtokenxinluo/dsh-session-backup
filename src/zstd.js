// zstd.js — the DSH concatenated-frame container primitives.
//
// DSH's JSONL persistence backend stores each session as a series of
// independently decodable, checksummed Zstandard frames (one per write
// batch), possibly ending in a torn (incomplete) final frame that the real
// loader simply drops. This module mirrors that physical format exactly:
//
//   scanFrames(buf)     — locate complete frames + an optional torn tail
//   decodeFrames(buf)   — concatenated plaintext of complete frames
//   encodeFrames(chunks) — compress JSONL chunks back into checksummed frames
//
// The constants mirror `dsh-session-persistence-jsonl`'s zstd section.

import { zstdDecompressSync, zstdCompressSync, constants } from "node:zlib";

export const ZSTD_MAGIC = 4247762216; // 0xFD2FB528 little-endian
export const CHECKSUM_OPTIONS = { params: { [constants.ZSTD_c_checksumFlag]: 1 } };

/**
 * Locate complete frames without decompressing their blocks. EOF inside the
 * final frame returns its start as a torn tail (repair drops it, exactly like
 * the real loader's cold recovery).
 * @param {Buffer} buffer - complete bytes of the session artifact.
 * @returns {{ frames: Array<{start:number,end:number}>, tornStart?: number }}
 */
export function scanFrames(buffer) {
  const frames = [];
  let offset = 0;
  let tornStart;
  while (offset < buffer.length) {
    const start = offset;
    if (buffer.length - offset < 4) { tornStart = start; break; }
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) {
      throw new Error(`corrupt Zstandard session log: invalid frame magic at byte ${offset}`);
    }
    offset += 4;
    if (offset === buffer.length) { tornStart = start; break; }
    const descriptor = buffer.readUInt8(offset);
    offset += 1;
    if ((descriptor & 24) !== 0) {
      throw new Error(`corrupt Zstandard session log: reserved frame-header bit at byte ${offset - 1}`);
    }
    const contentSizeFlag = descriptor >>> 6;
    const singleSegment = (descriptor & 32) !== 0;
    const checksum = (descriptor & 4) !== 0;
    const dictionaryFlag = descriptor & 3;
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag;
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag;
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
    if (buffer.length - offset < remainingHeaderBytes) { tornStart = start; break; }
    offset += remainingHeaderBytes;
    for (;;) {
      if (buffer.length - offset < 3) { tornStart = start; break; }
      const blockHeader = buffer.readUIntLE(offset, 3);
      offset += 3;
      const lastBlock = (blockHeader & 1) !== 0;
      const blockType = blockHeader >>> 1 & 3;
      const blockSize = blockHeader >>> 3;
      if (blockType === 3) {
        throw new Error(`corrupt Zstandard session log: reserved block type at byte ${offset - 3}`);
      }
      const payloadBytes = blockType === 1 ? 1 : blockSize;
      if (buffer.length - offset < payloadBytes) { tornStart = start; break; }
      offset += payloadBytes;
      if (lastBlock) break;
    }
    if (tornStart !== undefined) break;
    if (checksum) {
      if (buffer.length - offset < 4) { tornStart = start; break; }
      offset += 4;
    }
    frames.push({ start, end: offset });
  }
  return { frames, tornStart };
}

/** Decode all complete frames into one plaintext string (torn tail dropped). */
export function decodeFrames(buffer) {
  const { frames } = scanFrames(buffer);
  let text = "";
  for (const f of frames) {
    text += zstdDecompressSync(buffer.subarray(f.start, f.end)).toString("utf8");
  }
  return text;
}

/**
 * Re-encode plaintext chunks into the same container shape: one checksummed
 * frame per chunk. Pass the same chunk boundaries you decoded with to keep
 * the physical layout stable.
 * @param {string[]} chunks - plaintext chunks (frame-aligned).
 * @returns {Buffer}
 */
export function encodeFrames(chunks) {
  const parts = chunks.map((text) => zstdCompressSync(Buffer.from(text, "utf8"), CHECKSUM_OPTIONS));
  return Buffer.concat(parts);
}

/**
 * Split plaintext into whole lines and return { lines, newline } so a repair
 * can rewrite only target lines and rejoin byte-identically.
 */
export function splitLines(text) {
  const nl = text.includes("\r\n") ? "\r\n" : "\n";
  return { lines: text.split(nl), newline: nl };
}
