/**
 * Derive a committable fixture from REAL OpenCode 2.x message lists, the `GET /api/session/:id/message`
 * bodies the 2.x event source reads.
 *
 * The same discipline as `redact-opencode-session.mjs`, for the 2.x shape. Every output object is
 * BUILT from the fields `agui-source2.ts` declares, so a field the server adds later is dropped rather
 * than leaked. Closed enumerations and timestamps are kept verbatim, because they are the values the
 * settle rule and the stamps read. Message ids get pseudonyms numbered in ascending order of the
 * original, because the cursor compares them as strings. Tool call ids and tool names get pseudonyms
 * that keep only equality. Free text and tool payloads become placeholders that keep emptiness and
 * stay stable for one element across snapshots, so a cell can tell which element a published body
 * came from.
 *
 * A capture is either one response (`{ body: { data } }`) or a JSONL file of polled responses
 * (`{ snap: { body: { data } } }` per line). Consecutive snapshots that redact to the same list are
 * kept once.
 *
 * Usage: node scripts/redact-opencode2-session.mjs <out.json> <source note> <name>=<capture>[,<capture>...]...
 */
import { readFileSync, writeFileSync } from "node:fs";

const [, , outPath, source, ...specs] = process.argv;
if (!outPath || !source || specs.length === 0) {
  console.error("usage: node scripts/redact-opencode2-session.mjs <out.json> <source note> <name>=<capture>[,<capture>...]...");
  process.exit(2);
}

function lists(file) {
  const text = readFileSync(file, "utf8").trim();
  if (file.endsWith(".jsonl")) return text.split("\n").map((line) => JSON.parse(line).snap.body.data);
  return [JSON.parse(text).body.data];
}

function redactSession(captures) {
  const all = captures.flatMap(lists);
  const width = 2;
  const ids = [...new Set(all.flat().map((m) => m.id))].sort();
  const msgId = new Map(ids.map((id, i) => [id, `msg_${String(i + 1).padStart(width, "0")}`]));
  const equalOnly = (prefix) => {
    const map = new Map();
    return (v) => (map.has(v) ? map.get(v) : (map.set(v, `${prefix}_${map.size + 1}`), map.get(v)));
  };
  const callId = equalOnly("call");
  const toolName = equalOnly("tool");
  const placeholders = new Map();
  const placeholder = (key, kind, value) => {
    if (typeof value !== "string" || value.length === 0) return value;
    if (!placeholders.has(key)) placeholders.set(key, `[${kind} ${[...placeholders.keys()].filter((k) => k.endsWith(`|${kind}`)).length + 1}]`);
    return placeholders.get(key);
  };
  const time = (t) => {
    if (!t) return undefined;
    const out = {};
    for (const k of ["created", "streamed", "ran", "completed"]) if (t[k] !== undefined) out[k] = t[k];
    return out;
  };
  const error = (e, key) => (e ? { type: e.type, message: placeholder(`${key}|error`, "error", e.message) } : undefined);

  const element = (c, key) => {
    if (c.type === "text") return { type: "text", text: placeholder(`${key}|text`, "text", c.text) };
    if (c.type === "reasoning") return { type: "reasoning", text: placeholder(`${key}|reasoning`, "reasoning", c.text), ...(c.time ? { time: time(c.time) } : {}) };
    if (c.type === "tool") {
      const s = c.state ?? {};
      const state = { status: s.status };
      if (s.input !== undefined) state.input = typeof s.input === "string" ? placeholder(`${key}|input`, "input", s.input) : { value: placeholder(`${key}|input`, "input", JSON.stringify(s.input)) };
      if (s.content) state.content = s.content.map((x, i) => ({ type: x.type, ...(x.type === "text" ? { text: placeholder(`${key}|result${i}`, "result", x.text) } : {}) }));
      if (s.error) state.error = error(s.error, `${key}|tool`);
      return { type: "tool", id: callId(c.id), name: toolName(c.name), state, time: time(c.time) };
    }
    return { type: c.type };
  };

  const message = (m) => {
    const id = msgId.get(m.id);
    const out = { id, type: m.type, time: time(m.time) };
    if (m.type === "user") out.text = placeholder(`${id}|user`, "user", m.text);
    if (m.outcome !== undefined) out.outcome = m.outcome;
    if (m.error) out.error = error(m.error, id);
    if (Array.isArray(m.content)) out.content = m.content.map((c, i) => element(c, `${id}:${i}`));
    return out;
  };

  const snapshots = [];
  for (const list of all) {
    // Placeholders are numbered in session order, while the list keeps the order the server sent.
    const ascending = new Map([...list].sort((a, b) => (a.id < b.id ? -1 : 1)).map((m) => [m.id, message(m)]));
    const redacted = list.map((m) => ascending.get(m.id));
    if (JSON.stringify(redacted) !== JSON.stringify(snapshots.at(-1))) snapshots.push(redacted);
  }
  return snapshots;
}

const sessions = specs.map((spec) => {
  const eq = spec.indexOf("=");
  return { name: spec.slice(0, eq), snapshots: redactSession(spec.slice(eq + 1).split(",")) };
});
writeFileSync(outPath, `${JSON.stringify({ source, sessions }, null, 1)}\n`);
for (const s of sessions) console.log(`${s.name}: ${s.snapshots.length} snapshot(s), ${s.snapshots.at(-1).length} message(s) in the last`);
