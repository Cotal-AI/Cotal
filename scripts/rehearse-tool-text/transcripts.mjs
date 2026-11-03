// Reading what a seat's harness wrote down (#5625): its Cotal tool calls with their results, every
// tool call with its time, and what reached it from the mesh, as a Cotal tool result or a channel
// push. rehearse.mjs reads the live files of a run; grade.mjs reads the copies a run kept.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const KEEP = 20000;

function text(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((x) => (typeof x === "string" ? x : x?.text ?? "")).join("");
  return "";
}

const refused = (s) => /^(Couldn't|Can't|Cannot|Error|MCP error)/.test(s.trim());
const useOf = (seat, tool, at, input, cotal) => ({ seat, tool, at, input: JSON.stringify(input ?? {}).slice(0, 500), cotal });
const lines = (src) => src.split("\n").filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });

/** A Claude Code transcript's rows. A channel push is a user message carrying `source="cotal"`. */
export function claudeCalls(rows, seat) {
  const pending = new Map(), calls = [], uses = [], inbound = [];
  for (const o of rows) {
    const content = o.message?.content;
    if (o.type === "user" && typeof content === "string" && content.includes('source="cotal"')) inbound.push({ seat, at: o.timestamp, text: content.slice(0, KEEP) });
    for (const b of Array.isArray(content) ? content : []) {
      if (o.type === "user" && b.type === "text" && String(b.text).includes('source="cotal"')) inbound.push({ seat, at: o.timestamp, text: b.text.slice(0, KEEP) });
      const isCotal = b.type === "tool_use" && /^mcp__[^_]+(?:_[^_]+)*__cotal_/.test(b.name);
      if (b.type === "tool_use") uses.push(useOf(seat, b.name, o.timestamp, b.input, isCotal));
      if (isCotal) pending.set(b.id, { seat, tool: b.name.replace(/^mcp__.*__(cotal_)/, "$1"), args: b.input });
      if (b.type === "tool_result" && pending.has(b.tool_use_id)) {
        const result = text(b.content);
        calls.push({ ...pending.get(b.tool_use_id), ok: !b.is_error && !refused(result), result });
        inbound.push({ seat, at: o.timestamp, text: result.slice(0, KEEP) });
      }
    }
  }
  return { calls, uses, inbound };
}

/** A jcode session's messages. A channel push is a user text block marked 📨. */
export function jcodeCalls(msgs, seat) {
  const pending = new Map(), calls = [], uses = [], inbound = [];
  for (const m of msgs) for (const b of m.content ?? []) {
    if (m.role === "user" && b.type === "text" && String(b.text).includes("📨")) inbound.push({ seat, at: m.timestamp, text: b.text.slice(0, KEEP) });
    if (b.type === "tool_use") {
      const viaProxy = ["mcp_call", "mcp_search"].includes(b.name) && b.input?.server === "cotal";
      const direct = /^mcp__cotal__cotal_/.test(b.name);
      uses.push(useOf(seat, b.name, m.timestamp, b.input, viaProxy || direct));
      if (viaProxy && b.name === "mcp_call") pending.set(b.id, { seat, tool: b.input.tool, args: b.input.arguments ?? {} });
      else if (direct) pending.set(b.id, { seat, tool: b.name.replace(/^mcp__cotal__/, ""), args: b.input });
    }
    if (b.type === "tool_result" && pending.has(b.tool_use_id)) {
      const result = text(b.content);
      calls.push({ ...pending.get(b.tool_use_id), ok: !b.is_error && !refused(result), result });
      inbound.push({ seat, at: m.timestamp, text: result.slice(0, KEEP) });
    }
  }
  return { calls, uses, inbound };
}

/** A jcode session is a snapshot (<id>.json) plus a journal of what was appended since
 *  (<id>.journal.jsonl). A seat that has stopped may have folded its journal into the snapshot, so
 *  both are read and each message is kept once. */
export function jcodeSession(snapshot, journal) {
  const seen = new Set(), msgs = [];
  const add = (m) => { if (m && !(m.id && seen.has(m.id))) { if (m.id) seen.add(m.id); msgs.push(m); } };
  if (snapshot && existsSync(snapshot)) { try { (JSON.parse(readFileSync(snapshot, "utf8")).messages ?? []).forEach(add); } catch {} }
  if (journal && existsSync(journal)) for (const row of lines(readFileSync(journal, "utf8"))) (row.append_messages ?? []).forEach(add);
  return msgs;
}

export const claudeRows = (file) => lines(readFileSync(file, "utf8"));

/** Everything in a run's kept transcripts/ folder, named claude-<seat>-<session>.jsonl and
 *  jcode-<seat>-<session>.json or .journal.jsonl. */
export function fromTranscripts(dir) {
  const out = { calls: [], uses: [], inbound: [] };
  const add = (got) => { for (const k of Object.keys(out)) out[k].push(...got[k]); };
  if (!existsSync(dir)) return out;
  const files = readdirSync(dir).sort();
  for (const f of files) {
    const m = /^claude-(.+)-([0-9a-f-]{36})\.jsonl$/.exec(f);
    if (m) add(claudeCalls(claudeRows(join(dir, f)), m[1]));
  }
  const sessions = new Map();
  for (const f of files) {
    const m = /^jcode-(.+)-(session_.+?)\.(json|journal\.jsonl)$/.exec(f);
    if (m) sessions.set(`${m[1]}\0${m[2]}`, { seat: m[1], id: m[2] });
  }
  for (const { seat, id } of sessions.values()) add(jcodeCalls(jcodeSession(join(dir, `jcode-${seat}-${id}.json`), join(dir, `jcode-${seat}-${id}.journal.jsonl`)), seat));
  return out;
}
