/**
 * Derive a committable session fixture from a REAL OpenCode session.
 *
 * WHITELIST BY CONSTRUCTION, not by subtraction. Every output object is BUILT from an empty object
 * using only the fields `OpenCodeMessageInfo` / `OpenCodePart` declare, which is exactly the set the
 * source and the mapper read. A field the store carries and this script does not name cannot reach
 * the output, so a new OpenCode field appearing upstream is dropped rather than leaked. That is why
 * it is a build rather than a delete: a deleter has to know every field that exists, and it never
 * does.
 *
 * THREE TREATMENTS, and which one a field gets is a privacy decision rather than a convenience one.
 *
 *   VERBATIM    closed enumerations, booleans and timestamps: `role`, part `type`, tool
 *               `state.status`, `synthetic`, `ignored`, every `time.*`. These ARE the values under
 *               test, so pseudonymising them would test the pseudonym.
 *   PSEUDONYM   identifiers, through a stable per-namespace map so equality survives and content
 *               does not: session, message, part and `callID`. The identity structure of a session,
 *               which id repeats, whether a result names a call that exists, and above all the
 *               ORDER relation the cursor depends on, is preserved exactly. Tool NAMES are
 *               pseudonymised too, because an MCP tool name can carry a server name.
 *   PLACEHOLDER free text and tool payloads: `text`, `state.input`, `state.output`, `state.error`.
 *               Only emptiness survives, because whether a body is present decides whether an arm
 *               emits, and a fixture that lost that would not exercise it.
 *
 * **THE PSEUDONYM MUST PRESERVE ORDER, NOT ONLY EQUALITY, AND THAT IS SPECIFIC TO THIS SOURCE.**
 * The Claude fixture only needs equality, because its cursor is a byte offset. Here the cursor IS
 * the id pair, so a pseudonym map that renamed ids without keeping their sort order would produce a
 * fixture on which the cursor's own correctness could not be tested. Ids are therefore numbered in
 * ASCENDING SOURCE ORDER within each namespace and emitted zero-padded, so string comparison of the
 * pseudonyms reproduces string comparison of the originals.
 *
 * Read from a COPY of the store, never the live database.
 *
 * Usage: node scripts/redact-opencode-session.mjs <copy-of-opencode.db> <sessionId> <out.json>
 */
import { writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

const [, , dbPath, sessionId, outPath] = process.argv;
if (!dbPath || !sessionId || !outPath) {
  console.error("usage: node scripts/redact-opencode-session.mjs <copy-of-opencode.db> <sessionId> <out.json>");
  process.exit(2);
}

const db = new DatabaseSync(dbPath, { readOnly: true });

/** Stable, per-namespace, ASCENDING order of the ORIGINAL string. Order-preserving by construction. */
function orderedPseudonyms(ns, values) {
  const sorted = [...new Set(values)].sort();
  const width = String(sorted.length).length;
  const map = new Map();
  sorted.forEach((v, i) => map.set(v, `${ns}_${String(i + 1).padStart(width, "0")}`));
  return map;
}

const rawMessages = db.prepare("select id, data from message where session_id = ? order by id").all(sessionId);
const rawParts = db.prepare("select id, message_id, data from part where session_id = ? order by id").all(sessionId);
if (rawMessages.length === 0) {
  console.error(`no messages for session ${sessionId} in ${dbPath}`);
  process.exit(1);
}

const msgIds = orderedPseudonyms("msg", rawMessages.map((r) => r.id));
const partIds = orderedPseudonyms("prt", rawParts.map((r) => r.id));
const callIds = orderedPseudonyms(
  "call",
  rawParts.map((r) => JSON.parse(r.data).callID).filter((v) => typeof v === "string"),
);
const toolNames = orderedPseudonyms(
  "tool",
  rawParts.map((r) => JSON.parse(r.data).tool).filter((v) => typeof v === "string"),
);
const sess = "ses_fixture";

/** Free text: only emptiness survives. */
const placeholder = (v) => (typeof v === "string" ? (v === "" ? "" : "x".repeat(Math.min(v.length, 16))) : undefined);

const partsByMessage = new Map();
for (const row of rawParts) {
  const p = JSON.parse(row.data);
  const out = { id: partIds.get(row.id), sessionID: sess, messageID: msgIds.get(row.message_id), type: p.type };
  if (typeof p.text === "string") out.text = placeholder(p.text);
  if (p.synthetic !== undefined) out.synthetic = p.synthetic;
  if (p.ignored !== undefined) out.ignored = p.ignored;
  if (typeof p.callID === "string") out.callID = callIds.get(p.callID);
  if (typeof p.tool === "string") out.tool = toolNames.get(p.tool);
  if (p.time && typeof p.time === "object") {
    out.time = {};
    if (typeof p.time.start === "number") out.time.start = p.time.start;
    if (typeof p.time.end === "number") out.time.end = p.time.end;
  }
  if (p.state && typeof p.state === "object") {
    out.state = {};
    if (typeof p.state.status === "string") out.state.status = p.state.status;
    // The INPUT is not carried as a shape. Only whether there was one, because the args arm
    // stringifies whatever it is given and a fixture is the wrong place to keep a tool's arguments.
    if (p.state.input !== undefined) out.state.input = p.state.input === null ? null : { redacted: true };
    if (typeof p.state.output === "string") out.state.output = placeholder(p.state.output);
    if (typeof p.state.error === "string") out.state.error = placeholder(p.state.error);
    if (p.state.time && typeof p.state.time === "object") {
      out.state.time = {};
      if (typeof p.state.time.start === "number") out.state.time.start = p.state.time.start;
      if (typeof p.state.time.end === "number") out.state.time.end = p.state.time.end;
    }
  }
  const key = msgIds.get(row.message_id);
  if (!partsByMessage.has(key)) partsByMessage.set(key, []);
  partsByMessage.get(key).push(out);
}

const messages = rawMessages.map((row) => {
  const m = JSON.parse(row.data);
  const id = msgIds.get(row.id);
  const info = { id, sessionID: sess, role: m.role };
  if (m.time && typeof m.time === "object") {
    info.time = {};
    if (typeof m.time.created === "number") info.time.created = m.time.created;
    if (typeof m.time.completed === "number") info.time.completed = m.time.completed;
  }
  return { info, parts: partsByMessage.get(id) ?? [] };
});

writeFileSync(outPath, `${JSON.stringify(messages, null, 2)}\n`);
const parts = messages.reduce((n, m) => n + m.parts.length, 0);
console.log(`wrote ${outPath}: ${messages.length} messages, ${parts} parts`);

// ORDER PRESERVATION IS ASSERTED, NOT ASSUMED. If the pseudonyms ever stopped sorting like the
// originals, every cursor cell in the suite would be testing a property the fixture no longer has,
// and it would still pass.
const originalOrder = rawParts.map((r) => r.id);
const mappedOrder = [...originalOrder].map((v) => partIds.get(v));
const sortedMapped = [...mappedOrder].sort();
if (JSON.stringify(mappedOrder) !== JSON.stringify(sortedMapped)) {
  console.error("REFUSED: the pseudonym map did not preserve part id order; the fixture would not test the cursor");
  process.exit(1);
}
console.log(`order preserved: ${mappedOrder.length} part ids sort identically before and after`);
