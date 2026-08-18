/**
 * Derive a committable session fixture from a real Claude session JSONL.
 *
 * WHITELIST BY CONSTRUCTION, not by subtraction. Every output record is BUILT from an empty object
 * using only the fields `ClaudeEntry`/`ClaudeBlock` declare, which is exactly the set the mapper
 * reads. A field the input carries and this script does not name cannot reach the output, so a new
 * harness field appearing upstream is dropped rather than leaked. That is the whole reason it is a
 * build rather than a delete: a deleter has to know every field that exists, and it never does.
 *
 * THREE TREATMENTS, and which one a field gets is a privacy decision, not a convenience one.
 *
 *   VERBATIM  - closed enumerations, booleans and timestamps. `origin.kind`, `promptSource`,
 *               `entrypoint`, `stop_reason`, block `type`, `is_error`, the `is*` markers. These ARE
 *               the values under test: pseudonymising them would test the pseudonym.
 *   PSEUDONYM - identifiers, through a stable map so that equality survives and content does not.
 *               A session's whole identity structure (which uuid repeats, whether a provider message
 *               id recurs, whether a tool_result names a tool_use that exists) is preserved exactly,
 *               and none of the original strings are. Tool NAMES are pseudonymised too: an MCP tool
 *               name can carry a server name, and a fixture is the wrong place to find that out.
 *   PLACEHOLDER - free text and tool payloads. Only emptiness survives, because `promptText.length`
 *               decides whether a body is carried and a fixture that lost that would not exercise it.
 *
 * Usage: node scripts/redact-claude-session.mjs <in.jsonl> <out.jsonl> [maxRecords]
 */
import { readFileSync, writeFileSync } from "node:fs";

const [, , inPath, outPath, maxArg] = process.argv;
if (!inPath || !outPath) {
  console.error("usage: node scripts/redact-claude-session.mjs <in.jsonl> <out.jsonl> [maxRecords]");
  process.exit(2);
}
const max = maxArg ? Number(maxArg) : Infinity;

const pseudo = new Map();
const nextFor = new Map();
/** Stable, per-namespace, order-of-first-appearance. Same input string, same output, always. */
const id = (ns, v) => {
  if (typeof v !== "string" || v === "") return v;
  const key = `${ns} ${v}`;
  let out = pseudo.get(key);
  if (out === undefined) {
    const n = (nextFor.get(ns) ?? 0) + 1;
    nextFor.set(ns, n);
    out = `${ns}-${n}`;
    pseudo.set(key, out);
  }
  return out;
};
/** Free text: emptiness is the only property that survives. */
const text = (v) => (typeof v !== "string" ? v : v.length === 0 ? "" : "redacted");

const put = (o, k, v) => {
  if (v !== undefined) o[k] = v;
};

const block = (b) => {
  if (b === null || typeof b !== "object") return { type: "unknown" };
  const o = {};
  put(o, "type", typeof b.type === "string" ? b.type : undefined); // verbatim: the selector
  put(o, "text", b.text === undefined ? undefined : text(b.text));
  put(o, "thinking", b.thinking === undefined ? undefined : text(b.thinking));
  put(o, "id", id("toolu", b.id));
  put(o, "name", id("tool", b.name));
  put(o, "input", b.input === undefined ? undefined : { redacted: true });
  put(o, "tool_use_id", id("toolu", b.tool_use_id));
  put(
    o,
    "content",
    b.content === undefined
      ? undefined
      : typeof b.content === "string"
        ? text(b.content)
        : [{ type: "text", text: "redacted" }],
  );
  put(o, "is_error", typeof b.is_error === "boolean" ? b.is_error : undefined); // verbatim
  return o;
};

const entry = (e) => {
  const o = {};
  put(o, "type", typeof e.type === "string" ? e.type : undefined); // verbatim
  put(o, "uuid", id("uuid", e.uuid));
  put(o, "sessionId", id("sess", e.sessionId));
  put(o, "timestamp", typeof e.timestamp === "string" ? e.timestamp : undefined); // verbatim
  put(o, "isSidechain", typeof e.isSidechain === "boolean" ? e.isSidechain : undefined);
  if (e.origin !== undefined && e.origin !== null && typeof e.origin === "object")
    o.origin = typeof e.origin.kind === "string" ? { kind: e.origin.kind } : {}; // verbatim
  put(o, "promptSource", typeof e.promptSource === "string" ? e.promptSource : undefined); // verbatim
  put(o, "isCompactSummary", typeof e.isCompactSummary === "boolean" ? e.isCompactSummary : undefined);
  put(
    o,
    "isVisibleInTranscriptOnly",
    typeof e.isVisibleInTranscriptOnly === "boolean" ? e.isVisibleInTranscriptOnly : undefined,
  );
  put(o, "entrypoint", typeof e.entrypoint === "string" ? e.entrypoint : undefined); // verbatim
  const m = e.message;
  if (m !== undefined && m !== null && typeof m === "object") {
    const mo = {};
    put(mo, "id", id("msg", m.id));
    // verbatim, and `null` is a real value here rather than an absence
    put(mo, "stop_reason", m.stop_reason === undefined ? undefined : typeof m.stop_reason === "string" ? m.stop_reason : null);
    if (typeof m.content === "string") mo.content = text(m.content);
    else if (Array.isArray(m.content)) mo.content = m.content.map(block);
    o.message = mo;
  }
  return o;
};

const out = [];
let read = 0;
for (const line of readFileSync(inPath, "utf8").split("\n")) {
  if (!line.trim()) continue;
  let e;
  try {
    e = JSON.parse(line);
  } catch {
    continue;
  }
  read += 1;
  out.push(JSON.stringify(entry(e)));
  if (out.length >= max) break;
}
writeFileSync(outPath, `${out.join("\n")}\n`);
console.log(`redacted ${out.length} of ${read} records -> ${outPath}`);
