// scan.js — inspect stored session logs for loader-blocking corruption.
import { readFile, stat } from "node:fs/promises";
import { decodeFrames } from "./zstd.js";
import { validateLog } from "./validate.js";

/**
 * Scan one session artifact (session.jsonl.zstd or plain .jsonl).
 * @param {string} file - absolute path to the artifact.
 * @returns {Promise<object>} report:
 *   { file, ok, error?, lines?, events?, findings: [], header? }
 */
export async function scanSessionFile(file) {
  let buf;
  try {
    buf = await readFile(file);
  } catch (error) {
    return { file, ok: false, error: error?.code === "ENOENT" ? "file not found" : String(error?.message ?? error) };
  }
  try {
    const text = decodeFrames(buf);
    const { header, lines, events, findings } = validateLog(text);
    return { file, ok: findings.length === 0, lines, events, findings, header };
  } catch (error) {
    return { file, ok: false, error: String(error?.message ?? error) };
  }
}

/**
 * Discover every session artifact under a sessions root and scan it.
 * @param {string} root - DSH sessions root (e.g. <dsh>/sessions) or a project dir
 *   containing session-* subdirectories. Any directory tree is walked; files
 *   named session.jsonl.zstd / session.jsonl are treated as artifacts.
 * @returns {Promise<{ reports: object[], summary: {scanned:number,clean:number,corrupt:number} }>}
 */
export async function scanSessionRoot(root) {
  const reports = [];
  const summary = { scanned: 0, clean: 0, corrupt: 0 };
  const artifacts = await findArtifacts(root);
  for (const file of artifacts) {
    const report = await scanSessionFile(file);
    reports.push(report);
    summary.scanned++;
    if (report.ok) summary.clean++;
    else summary.corrupt++;
  }
  return { reports, summary };
}

import { readdir } from "node:fs/promises";
import path from "node:path";

/** Walk a root recursively and return artifact paths (session.jsonl[.zstd]). */
export async function findArtifacts(root) {
  const found = [];
  async function walk(dir, depth) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full, depth + 1);
      } else if (entry.isFile() && (entry.name === "session.jsonl.zstd" || entry.name === "session.jsonl")) {
        found.push(full);
      }
    }
  }
  await walk(root, 0);
  return found;
}
