// validate.js — loader-mirror validation of a session event log.
//
// Mirrors the load-time invariants of @deepseek-ai/dsh-session's
// assertCurrentLlmShape + assertMessageEventShape so a doctor can reproduce
// exactly which stored events would make `SessionPersistence` reject the
// whole session on load. Non-message events (turn/step markers, chunks,
// compaction, retry records, etc.) are intentionally not shape-checked —
// the real loader does not check them at the seed boundary either.

/** Whether a value carries a non-empty provider/model pair (assistant sources). */
function hasProviderModel(value) {
  return !!value && typeof value === "object" &&
    typeof value.provider === "string" && value.provider.length > 0 &&
    typeof value.model === "string" && value.model.length > 0;
}

/**
 * Validate one event exactly like the loader seed boundary.
 * @param {object} ev - parsed session event.
 * @returns {string | null} a human-readable reason, or null when valid.
 */
export function validateEvent(ev) {
  const type = ev?.type;
  const record = ev?.data;
  if (type === "request/header") {
    const header = record?.header;
    const config = header?.config;
    if (!hasProviderModel(config)) return "request/header lacks provider/model";
    const reasoningEffort = config?.reasoningEffort;
    if (reasoningEffort !== undefined && (typeof reasoningEffort !== "string" || reasoningEffort.length === 0)) {
      return "request/header has an invalid reasoningEffort";
    }
    return null;
  }
  if (type !== "user/message" && type !== "assistant/message" && type !== "tool/result") return null;

  const message = type === "user/message" ? record : record?.message;
  if (!message || typeof message !== "object" || typeof message.id !== "string" || message.id === "") {
    return "lacks identified message";
  }
  const expectedRole = type === "assistant/message" ? "assistant" : "user";
  if (message.role !== expectedRole) return `message must have role "${expectedRole}"`;
  const source = message.source;
  if (!source || typeof source !== "object" || typeof source.kind !== "string" || source.kind === "") {
    return "message has invalid source";
  }
  if (!Array.isArray(message.content)) return "message has invalid content";
  if (type === "assistant/message") {
    if (source.kind !== "model" || !hasProviderModel(source)) return "message must have model source";
    return null;
  }
  if (type !== "tool/result") return null; // user/message: shape above is all the loader checks
  if (source.kind !== "tool" || typeof source.callId !== "string" || source.callId === "") {
    return "message must have tool source";
  }
  const content = message.content;
  const block = content[0];
  if (content.length !== 1 || !block || typeof block !== "object" || block.type !== "tool-result" ||
      !Array.isArray(block.content)) {
    const inner = block && typeof block === "object" ? block.content : undefined;
    return `tool-result block content must be an array (got ${typeof inner})`;
  }
  if (block.toolCallId !== source.callId) return "message has mismatched tool call ids";
  return null;
}

/** Parse a JSONL line without letting one malformed line abort the scan. */
export function parseLine(line) {
  try {
    return { ev: JSON.parse(line), error: null };
  } catch (error) {
    return { ev: null, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Run loader-mirror validation over decoded plaintext.
 * @param {string} text - full plaintext of a session artifact (header line + events).
 * @returns {{
 *   header: object | null,
 *   lines: number,
 *   events: number,
 *   findings: Array<{ line:number, seq:number|undefined, type:string|undefined, reason:string, tool?:string }>,
 *   toolNameByCallId: Map<string,string>
 * }}
 */
export function validateLog(text) {
  const { lines } = splitLines(text);
  const findings = [];
  const toolNameByCallId = new Map();
  let header = null;
  let events = 0;
  let nonEmpty = 0;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (raw.trim().length === 0) continue;
    nonEmpty++;
    if (nonEmpty === 1) {
      const parsed = parseLine(raw);
      if (parsed.ev && parsed.ev.type === "session") header = parsed.ev;
      else findings.push({ line: i + 1, reason: parsed.error ?? "header line is not a session record" });
      continue;
    }
    const { ev, error } = parseLine(raw);
    if (error) {
      findings.push({ line: i + 1, reason: `JSON parse: ${error.slice(0, 120)}` });
      continue;
    }
    events++;
    if (ev.type === "tool/call" && ev.data && typeof ev.data.callId === "string") {
      toolNameByCallId.set(ev.data.callId, ev.data.name);
    }
    const reason = validateEvent(ev);
    if (reason !== null) {
      const finding = {
        line: i + 1,
        seq: ev.seq,
        type: ev.type,
        reason
      };
      if (ev.type === "tool/result" && ev.data?.message?.source?.callId) {
        finding.tool = toolNameByCallId.get(ev.data.message.source.callId);
      }
      findings.push(finding);
    }
  }
  return { header, lines: nonEmpty, events, findings, toolNameByCallId };
}

function splitLines(text) {
  const nl = text.includes("\r\n") ? "\r\n" : "\n";
  return { lines: text.split(nl), newline: nl };
}
