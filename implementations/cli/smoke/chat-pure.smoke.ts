/**
 * Chat client pure-unit smoke (no NATS, no session, no test runner).
 *
 * SCOPE, stated honestly: this exercises only pure exports of the unregistered chat client:
 *   - LineFramer (stdio-io.ts): NDJSON line framing, CRLF, UTF-8 split across chunks, oversize discard;
 *   - parseRequestLine / serializeRecord / messageRecord (stdio.ts): strict request validation and
 *     single-line output records;
 *   - the view reducers and renderers (view.ts): paste-as-data, Enter/Shift+Enter, draft bound,
 *     leave/discard/quit, disconnect and ended handling, publish results, slash parsing, escaping.
 * It constructs plain data values (SessionIdentity, SessionMessage, PublishResult, CloseReport) and
 * NEVER an AdmittedChatSession: no fake session, no factory, no authority claim. runStdio (EPIPE,
 * backpressure) and StdioParticipant need an admitted session and are deliberately NOT covered here.
 * Nothing here proves admission, confinement, delivery or any native behavior.
 */
import { LineFramer } from "../src/chat/stdio-io.js";
import { MAX_REQUEST_ID, MAX_REQUEST_LINE, MAX_MESSAGE_ID, INVOKE_DEFAULT_TIMEOUT_MS, INVOKE_MAX_TIMEOUT_MS, messageRecord, parseRequestLine, serializeRecord } from "../src/chat/stdio.js";
import {
  MAX_DRAFT, MAX_TRANSCRIPT, addNotice, applyEvent, applyKey, applyPublishResult, closeSummary, composerRows, headerRows,
  initialState, parseSlash, transcriptRows, type ChatState,
} from "../src/chat/view.js";
import type { CloseReport, SessionIdentity, SessionMessage } from "../src/chat/session.js";

let pass = 0, fail = 0;
function check(label: string, cond: boolean, extra?: unknown): void {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  ✗ FAIL: ${label}`, extra === undefined ? "" : JSON.stringify(extra)?.slice(0, 400)); }
}

// ---- 1. LineFramer --------------------------------------------------------------------------------
console.log("1. LineFramer: bounded UTF-8 NDJSON framing");
function frame(chunks: (string | Buffer)[], close = true): { lines: string[]; oversize: number } {
  const lines: string[] = [];
  let oversize = 0;
  const f = new LineFramer((l) => lines.push(l), () => { oversize++; });
  for (const c of chunks) f.push(c);
  if (close) f.end();
  return { lines, oversize };
}
{
  const r = frame(["a\nb\n"]);
  check("two LF-terminated lines", JSON.stringify(r.lines) === '["a","b"]' && r.oversize === 0, r);
}
{
  const r = frame(["a\r\nb"]);
  check("CRLF is stripped and a final unterminated line is flushed at end()", JSON.stringify(r.lines) === '["a","b"]', r);
}
{
  const r = frame(["a\nb"], false);
  check("an unterminated line is not emitted before end()", JSON.stringify(r.lines) === '["a"]', r);
}
{
  const r = frame([Buffer.from([0x61, 0xc3]), Buffer.from([0xa9, 0x0a])]);
  check("a multi-byte UTF-8 char split across chunks is reassembled", JSON.stringify(r.lines) === JSON.stringify(["aé"]), r);
}
{
  const r = frame([Buffer.from([0xff, 0x0a])]);
  check("invalid UTF-8 becomes U+FFFD and never splits a line", r.lines.length === 1 && r.lines[0] === "\ufffd", r);
}
{
  const r = frame(["x".repeat(MAX_REQUEST_LINE) + "\n"]);
  check("a line of exactly MAX_REQUEST_LINE code units is accepted", r.lines.length === 1 && r.lines[0].length === MAX_REQUEST_LINE && r.oversize === 0);
}
{
  const r = frame(["x".repeat(MAX_REQUEST_LINE + 1) + "\nok\n"]);
  check("an oversize line in one chunk is dropped, reported once, and the next line survives", JSON.stringify(r.lines) === '["ok"]' && r.oversize === 1, { n: r.lines.length, o: r.oversize });
}
{
  const r = frame(["x".repeat(MAX_REQUEST_LINE + 1), "yyy", "zzz\nok\n"]);
  check("a streamed oversize line is discarded to its newline, reported once", JSON.stringify(r.lines) === '["ok"]' && r.oversize === 1, { n: r.lines.length, o: r.oversize });
}
{
  const r = frame(["x".repeat(MAX_REQUEST_LINE + 1)]);
  check("an oversize unterminated tail at end() emits nothing", r.lines.length === 0 && r.oversize === 1);
}
{
  const r = frame(["é".repeat(MAX_REQUEST_LINE) + "\n"]);
  check("the bound is in UTF-16 code units, not bytes (2 MB of é is one accepted line)", r.lines.length === 1 && r.oversize === 0);
}

// ---- 2. parseRequestLine ----------------------------------------------------------------------------
console.log("2. parseRequestLine: strict, closed request set; never touches a session");
const req = (o: Record<string, unknown>): string => JSON.stringify({ schemaVersion: 1, id: "r1", ...o });
const refused = (line: string, id: string | null, re?: RegExp): boolean => {
  const p = parseRequestLine(line);
  return !p.ok && p.id === id && p.error.code === "USAGE_INVALID" && (!re || re.test(p.error.message));
};
{
  const p = parseRequestLine(req({ type: "send", text: "hi", channel: "general" }));
  check("a valid send parses, with mentions defaulting to []", p.ok && p.request.type === "send" && p.request.mentions.length === 0, p);
}
{
  const p = parseRequestLine(req({ type: "send", text: "line1\nline2", channel: "general" }));
  check("a multi-line body inside the JSON string is data, one request", p.ok && p.request.type === "send" && p.request.text === "line1\nline2", p);
}
check("not JSON → refused with id null", refused("{nope", null, /not valid JSON/));
check("a JSON array → refused with id null", refused("[]", null, /JSON object/));
check("a JSON string → refused with id null", refused('"x"', null, /JSON object/));
check("missing id → id null", refused(JSON.stringify({ schemaVersion: 1, type: "roster" }), null, /request id/));
check("id with a space → id null", refused(JSON.stringify({ schemaVersion: 1, id: "a b", type: "roster" }), null));
check("id longer than MAX_REQUEST_ID → id null", refused(JSON.stringify({ schemaVersion: 1, id: "a".repeat(MAX_REQUEST_ID + 1), type: "roster" }), null));
check("id of exactly MAX_REQUEST_ID is accepted", parseRequestLine(JSON.stringify({ schemaVersion: 1, id: "a".repeat(MAX_REQUEST_ID), type: "roster" })).ok);
check("schemaVersion 2 → refused, id kept", refused(JSON.stringify({ schemaVersion: 2, id: "r1", type: "roster" }), "r1", /schemaVersion/));
check("schemaVersion as string \"1\" → refused", refused(JSON.stringify({ schemaVersion: "1", id: "r1", type: "roster" }), "r1", /schemaVersion/));
for (const t of ["spawn", "despawn", "run", "yield", "turn-yield", "toString", "__proto__"])
  check(`seat-only or prototype-named type "${t}" → refused`, refused(req({ type: t }), "r1", /unknown request type/));
check("an unknown field → refused", refused(req({ type: "roster", owner: "x" }), "r1", /does not accept the field "owner"/));
check("a caller cannot name an actor, UID or credential", ["actor", "lifecycleUid", "creds", "scope"].every((k) => refused(req({ type: "roster", [k]: "x" }), "r1")));
check("a \"__proto__\" key is an unknown own field, refused (never a prototype)", refused(`{"schemaVersion":1,"id":"r1","type":"roster","__proto__":{"polluted":1}}`, "r1", /__proto__/));
check("...and Object.prototype is untouched", ({} as Record<string, unknown>).polluted === undefined);
check("a \"constructor\" key → refused", refused(req({ type: "roster", constructor: 1 }), "r1", /constructor/));
check("a missing required field → refused", refused(req({ type: "send", text: "hi" }), "r1", /requires the field "channel"/));
check("send.text must be a string", refused(req({ type: "send", text: 5, channel: "general" }), "r1"));
check("a wildcard channel is refused", refused(req({ type: "join", channel: "team.*" }), "r1") && refused(req({ type: "join", channel: "team.>" }), "r1"));
check("mentions must be an array of non-empty strings", refused(req({ type: "send", text: "x", channel: "general", mentions: [""] }), "r1") && refused(req({ type: "send", text: "x", channel: "general", mentions: "bob" }), "r1"));
check("dm.replyTo longer than MAX_MESSAGE_ID → refused", refused(req({ type: "dm", to: "bob", text: "x", replyTo: "m".repeat(MAX_MESSAGE_ID + 1) }), "r1"));
check("dm.to empty → refused", refused(req({ type: "dm", to: "", text: "x" }), "r1"));
check("status outside the closed set → refused", refused(req({ type: "status", status: "busy" }), "r1"));
check("attention outside the closed set → refused", refused(req({ type: "attention", mode: "silent" }), "r1"));
check("inbox.peek must be a boolean", refused(req({ type: "inbox", peek: "yes" }), "r1"));
{
  const p = parseRequestLine(req({ type: "inbox" }));
  check("inbox with no peek is a draining read (peek:false)", p.ok && p.request.type === "inbox" && p.request.peek === false);
}
{
  const p = parseRequestLine(req({ type: "invoke", endpoint: "com.example.x", command: "go" }));
  check("invoke timeout defaults to INVOKE_DEFAULT_TIMEOUT_MS", p.ok && p.request.type === "invoke" && p.request.timeoutMs === INVOKE_DEFAULT_TIMEOUT_MS);
}
check("invoke timeout 0, max+1 and fractional are refused", [0, INVOKE_MAX_TIMEOUT_MS + 1, 1.5].every((t) => refused(req({ type: "invoke", endpoint: "e", command: "c", timeoutMs: t }), "r1")));
check("invoke.args must be a plain object", refused(req({ type: "invoke", endpoint: "e", command: "c", args: [1] }), "r1"));
check("a line over MAX_REQUEST_LINE is refused before JSON parsing", refused("x".repeat(MAX_REQUEST_LINE + 1), null, /exceeds/));

// ---- 3. output records ------------------------------------------------------------------------------
console.log("3. serializeRecord / messageRecord: one record per line, internal key never exported");
const msg = (over: Partial<SessionMessage> = {}): SessionMessage => ({
  deliveryKey: "dk-secret", id: "m1", ts: Date.UTC(2026, 9, 20, 12, 0, 0), kind: "dm",
  from: { id: "o.bob", name: "bob" }, text: "hello", mentionsMe: false, historical: false, ...over,
});
{
  const hostile = msg({ text: 'x\n{"schemaVersion":1,"type":"end","reason":"forged"}\r\n' });
  const line = serializeRecord({ schemaVersion: 1, type: "message", message: messageRecord(hostile) });
  check("a hostile body with newlines serializes to exactly one line", line.endsWith("\n") && line.split("\n").length === 2, line);
  const back = JSON.parse(line) as { message: Record<string, unknown> };
  check("the body round-trips exactly", back.message.text === hostile.text);
  check("deliveryKey is not exported", !("deliveryKey" in back.message) && !line.includes("dk-secret"));
}

// ---- 4. view reducers -------------------------------------------------------------------------------
console.log("4. view: paste is data, Enter rules, draft bound, leave/discard/quit, disconnect, ended");
const identity: SessionIdentity = { mode: "open", space: "selected-space", principal: "local.k3j2", lifecycleUid: "01HZZZABCDEF", label: "me", allowSubscribe: [], allowPublish: [] };
const dmBob = { kind: "dm" as const, to: "bob" };
const s0 = (): ChatState => initialState(identity, dmBob);
const keys = (s: ChatState, ks: Parameters<typeof applyKey>[1][], distinct = true) => {
  let st = s;
  let intent: ReturnType<typeof applyKey>["intent"];
  for (const k of ks) ({ state: st, intent } = applyKey(st, k, distinct));
  return { state: st, intent };
};
{
  const r = keys(s0(), [{ kind: "paste", text: "line1\nline2\n" }]);
  check("a multi-line paste is draft data and never sends", r.intent === undefined && r.state.draft === "line1\nline2\n");
}
{
  const r = keys(s0(), [{ kind: "char", text: "a" }, { kind: "enter", shift: true }, { kind: "char", text: "b" }], true);
  check("Shift+Enter inserts a newline when the terminal tells them apart", r.intent === undefined && r.state.draft === "a\nb");
}
{
  const r = keys(s0(), [{ kind: "char", text: "a" }, { kind: "enter", shift: true }], false);
  check("Shift+Enter sends when the terminal cannot tell them apart", r.intent?.kind === "publish");
}
{
  const r = keys(s0(), [{ kind: "char", text: "hi" }, { kind: "enter", shift: false }]);
  check("Enter publishes to the recipient and marks the send pending", r.intent?.kind === "publish" && r.state.pending?.text === "hi");
  const again = applyKey({ ...r.state, draft: "more" }, { kind: "enter", shift: false }, true);
  check("a second Enter while pending does not send", again.intent === undefined && again.state.draft === "more");
}
check("whitespace-only drafts do not send", keys(s0(), [{ kind: "char", text: "  \n " }, { kind: "enter", shift: false }]).intent === undefined);
{
  const r = keys(s0(), [{ kind: "char", text: "//etc" }, { kind: "enter", shift: false }]);
  check("//text sends a message beginning with /", r.intent?.kind === "publish" && r.intent.text === "/etc");
}
{
  const r = keys(initialState(identity), [{ kind: "char", text: "hi" }, { kind: "enter", shift: false }]);
  check("no recipient: asks to pick one and keeps the draft", r.intent?.kind === "pick-recipient" && r.state.draft === "hi");
}
{
  const r = keys(s0(), [{ kind: "char", text: "x".repeat(MAX_DRAFT + 5) }]);
  check("the draft is bounded at MAX_DRAFT with a visible truncation notice", r.state.draft.length === MAX_DRAFT && r.state.transcript.some((e) => e.kind === "notice" && /truncated/.test(e.text)));
}
{
  const r = keys(s0(), [{ kind: "char", text: "x".repeat(MAX_DRAFT - 1) }, { kind: "paste", text: "😀" }]);
  check("the bound never cuts a surrogate pair in half", r.state.draft.length === MAX_DRAFT - 1 && !/[\ud800-\udbff]$/.test(r.state.draft));
}
{
  const r = keys(s0(), [{ kind: "char", text: "a😀" }, { kind: "backspace" }]);
  check("Backspace removes one whole code point", r.state.draft === "a");
}
{
  const draft = keys(s0(), [{ kind: "char", text: "unsent" }, { kind: "ctrl-c" }]);
  check("Ctrl-C with a draft asks to confirm and does not leave", draft.intent === undefined && draft.state.confirmLeave);
  const enter = applyKey(draft.state, { kind: "enter", shift: false }, true);
  check("Enter behind the leave prompt is ignored", enter.intent === undefined && enter.state.draft === "unsent");
  const esc = applyKey(draft.state, { kind: "escape" }, true);
  check("Esc keeps editing with the draft intact", !esc.state.confirmLeave && esc.state.draft === "unsent" && esc.intent === undefined);
  const discard = applyKey(draft.state, { kind: "ctrl-d" }, true);
  check("a second Ctrl-C/Ctrl-D discards and leaves", discard.intent?.kind === "leave" && discard.state.draft === "");
}
check("Ctrl-D with no draft leaves at once", keys(s0(), [{ kind: "ctrl-d" }]).intent?.kind === "leave");
{
  const r = keys(s0(), [{ kind: "char", text: "/quit" }, { kind: "enter", shift: false }]);
  check("/quit leaves", r.intent?.kind === "leave" && r.state.draft === "");
  check("/exit is /quit", parseSlash("/exit").ok && (parseSlash("/exit") as { command: { name: string } }).command.name === "quit");
}
{
  let s = applyEvent(s0(), { type: "connection", state: "disconnected" });
  check("a disconnect is shown as a visible gap", s.connection === "disconnected" && s.transcript.some((e) => e.kind === "gap"));
  const r = keys(s, [{ kind: "char", text: "keep me" }, { kind: "enter", shift: false }]);
  check("while disconnected nothing sends and the draft is kept", r.intent === undefined && r.state.draft === "keep me");
  const slash = keys(s, [{ kind: "char", text: "/who" }, { kind: "enter", shift: false }]);
  check("while disconnected /who waits and its line is kept", slash.intent === undefined && slash.state.draft === "/who");
  const recon = keys(s, [{ kind: "char", text: "/reconnect" }, { kind: "enter", shift: false }]);
  check("while disconnected /reconnect still runs", recon.intent?.kind === "slash");
  s = applyEvent(s, { type: "connection", state: "connected" });
  check("reconnecting says it is the same session", s.transcript.some((e) => e.kind === "notice" && /same session/.test(e.text)));
}
{
  const s = applyEvent({ ...s0(), draft: "x" }, { type: "connection", state: "ended", reason: "expired" });
  check("an ended session ignores typing", applyKey(s, { kind: "char", text: "y" }, true).state.draft === "x");
  check("...but Ctrl-D still leaves", applyKey(s, { kind: "ctrl-d" }, true).intent?.kind === "leave");
  check("...and the composer says how to leave", /Ctrl-D to leave/.test(composerRows(s, 80, true)[0].text));
}
{
  const sent = keys(s0(), [{ kind: "char", text: "hi" }, { kind: "enter", shift: false }]).state;
  const stored = applyPublishResult(sent, { outcome: "stored", messageId: "m9" });
  check("stored clears the submitted draft", stored.draft === "" && stored.pending === undefined);
  const typedOn = applyPublishResult({ ...sent, draft: "hi and more" }, { outcome: "stored", messageId: "m9" });
  check("stored keeps text typed after submit", typedOn.draft === "hi and more");
  const denied = applyPublishResult(sent, { outcome: "refused", code: "PERMISSION_DENIED", message: "no" });
  check("refused keeps the draft and never resends", denied.draft === "hi" && denied.pending === undefined);
  const unk = applyPublishResult(sent, { outcome: "unknown", message: "timeout" });
  check("unknown keeps the draft and warns not to resend blindly", unk.draft === "hi" && unk.transcript.some((e) => e.kind === "notice" && /not resent/.test(e.text)));
  const toBob = (status: "offline" | "idle") => applyPublishResult(sent, { outcome: "stored", messageId: "m9", seq: 4, recipient: { id: "BOBID", name: "bob" }, recipientStatusAtSend: status });
  check(
    "a DM stored for an offline recipient adds a notice that bob gets it when he reconnects",
    toBob("offline").transcript.some((e) => e.kind === "notice" && e.tone === "waiting" && e.text === "bob is offline. The message is stored and delivered when bob reconnects; a new agent spawned as bob does not receive it."),
  );
  check("...and a DM to a live recipient adds no such notice", !toBob("idle").transcript.some((e) => e.kind === "notice" && /is offline/.test(e.text)));
}
{
  let s = s0();
  for (let i = 0; i < MAX_TRANSCRIPT + 3; i++) s = addNotice(s, "hint", `n${i}`);
  check("the transcript is bounded and counts what it dropped", s.transcript.length === MAX_TRANSCRIPT && s.dropped === 3);
  check("...and shows a visible marker for the dropped entries", /3 earlier entries/.test(transcriptRows(s, 80)[0].text));
}

// ---- 5. slash parsing -------------------------------------------------------------------------------
console.log("5. parseSlash: closed set with bounded arguments");
const sl = (l: string) => parseSlash(l);
check("/history defaults to 50", sl("/history").ok && (sl("/history") as { command: { limit: number } }).command.limit === 50);
check("/history 0, 1001, 2.5 and abc are refused", ["/history 0", "/history 1001", "/history 2.5", "/history abc"].every((l) => !sl(l).ok));
check("/inbox --peek peeks; /inbox x is refused", (sl("/inbox --peek") as { command: { peek: boolean } }).command.peek === true && !sl("/inbox x").ok);
check("/who takes no arguments", !sl("/who x").ok);
check("/join needs exactly one channel", !sl("/join").ok && !sl("/join a b").ok && sl("/join a").ok);
check("/status keeps a multi-word activity", (sl("/status working on it") as { command: { activity?: string } }).command.activity === "on it");
{
  const r = sl("/bogus\u001b[2J");
  check("an unknown command is refused with its name escaped", !r.ok && (r as { error: string }).error.includes("\\u001b") && !(r as { error: string }).error.includes("\u001b"));
}

// ---- 6. rendering -----------------------------------------------------------------------------------
console.log("6. rendering: untrusted text is escaped; open mode claims routing only");
{
  const s = applyEvent(s0(), { type: "message", message: msg({ text: "first\nsecond", from: { id: "o.bob", name: "bob\u001b[31m" } }) });
  const rows = transcriptRows(s, 80);
  check("a body's own newline becomes an indented continuation row, not a forged entry", rows.length === 2 && rows[1].text.startsWith("        second"), rows);
  check("control characters in a sender name are escaped", rows[0].text.includes("\\u001b") && !rows.some((r) => r.text.includes("\u001b")));
}
{
  const s = applyEvent(s0(), { type: "message", message: msg({ text: "a\u2028b\u202eevil" }) });
  check("line separators and bidi controls are escaped", transcriptRows(s, 80).every((r) => !/[\u2028\u202e]/.test(r.text)));
}
check("open-mode header claims routing only", /routing only/.test(headerRows(s0())[0].text));
check("the header names the resolved operating mesh", headerRows(s0()).some((row) => row.text === "Mesh: selected-space"));
check("the header never prints a credential-like field", !/creds|jwt|token|seed/i.test(headerRows(s0()).map((r) => r.text).join(" ")));
{
  const close: CloseReport = { retirement: "not-applicable", connectionClosed: "confirmed", message: "" };
  const text = closeSummary(identity, close);
  check("open-mode close says there is no lifecycle to retire", /no lifecycle to retire/.test(text));
  check("the close summary never claims messages were erased", !/erase|delet|wiped/i.test(text) && /retention policy/.test(text));
  const st: SessionIdentity = { ...identity, mode: "static" };
  const until = Date.UTC(2026, 9, 20, 13, 0, 0);
  check("static close with an unconfirmed connection names the credential's validity", new RegExp(new Date(until).toISOString()).test(closeSummary(st, { retirement: "requested", connectionClosed: "not-confirmed", credentialValidUntil: until, message: "" })));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
