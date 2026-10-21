/**
 * Chat client pure-unit smoke (no NATS, no session, no test runner).
 *
 * SCOPE, stated honestly: this exercises only pure exports of the unregistered chat client:
 *   - LineFramer (stdio-io.ts): NDJSON line framing, CRLF, UTF-8 split across chunks, oversize discard;
 *   - parseRequestLine / serializeRecord / messageRecord (stdio.ts): strict request validation and
 *     single-line output records;
 *   - the view reducers and renderers (view.ts): paste-as-data, Enter/Shift+Enter, draft bound,
 *     leave/discard/quit, disconnect and ended handling, publish results, slash parsing, escaping;
 *   - replies and shared names (view.ts, picker.ts): the reply recipient, `/reply`, and the principal
 *     shown beside a display name another principal carries;
 *   - resolveDmTarget (native-session.ts) over plain roster data and a real ParticipantEngine, with
 *     senders heard on a DM and on a channel;
 *   - grantRefusal (native-session.ts): the pre-effect refusal for a channel outside the grant;
 *   - transcript times, shown in local time as `history` shows them.
 * It constructs plain data values (SessionIdentity, SessionMessage, PublishResult, CloseReport,
 * Presence) and NEVER an AdmittedChatSession: no fake session, no factory, no authority claim.
 * runStdio (EPIPE, backpressure), StdioParticipant and the controller's publish routing need an
 * admitted session and are deliberately NOT covered here. Nothing here proves admission,
 * confinement, delivery or any native behavior.
 */
import { LineFramer } from "../src/chat/stdio-io.js";
import { MAX_REQUEST_ID, MAX_REQUEST_LINE, MAX_MESSAGE_ID, INVOKE_DEFAULT_TIMEOUT_MS, INVOKE_MAX_TIMEOUT_MS, messageRecord, parseRequestLine, serializeRecord } from "../src/chat/stdio.js";
import {
  MAX_DRAFT, MAX_TRANSCRIPT, addNotice, applyEvent, applyKey, applyPublishResult, closeSummary, composerRows, headerRows,
  initialState, parseSlash, replyTo, replyToLatest, transcriptRows, type ChatState,
} from "../src/chat/view.js";
import { listChoices } from "../src/chat/picker.js";
import { ParticipantEngine } from "../src/chat/engine.js";
import { grantRefusal, resolveDmTarget } from "../src/chat/native-session.js";
import type { Presence } from "@cotal-ai/core";
import type { CloseReport, RosterView, SessionIdentity, SessionMessage } from "../src/chat/session.js";

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
check("open-mode header claims routing only", /routing only/.test(headerRows(s0())[1].text));
check("the header opens with the resolved operating mesh", headerRows(s0())[0]?.text === "Mesh: selected-space", headerRows(s0()));
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

// ---- 7. replies and shared names --------------------------------------------------------------------
console.log("7. a reply addresses the sender's principal, and a shared display name shows its principal");
const presence = (id: string, name: string, status: Presence["status"] = "idle"): Presence => ({ card: { id, name, kind: "agent" }, status, ts: 0 });
/** An engine that received one DM from each sender, so it knows each as a heard sender. */
const heard = (...senders: readonly (readonly [string, string])[]): ParticipantEngine => {
  const engine = new ParticipantEngine(identity.principal);
  senders.forEach(([id, name], i) =>
    engine.accept({ id: `h${i}`, ts: 0, space: "selected-space", from: { id, name }, to: identity.principal, parts: [{ kind: "text", text: "hi" }] },
      { ack() {}, nak() {}, durable: false }, { historical: false, kind: "dm" }, false));
  return engine;
};
const task = msg({ id: "t1", kind: "anycast", service: "reviewer", from: { id: "u_a.alice", name: "alice" } });
{
  const r = replyTo(s0(), task);
  check("a reply to a role task addresses its sender's principal and quotes the task id",
    JSON.stringify(r.recipient) === JSON.stringify({ kind: "peer", principal: "u_a.alice", name: "alice", replyTo: "t1" }), r.recipient);
  const dm = replyTo(s0(), msg({ id: "d1", from: { id: "u_b.alice", name: "alice" } }));
  check("a reply to a DM addresses its sender's principal", dm.recipient?.kind === "peer" && dm.recipient.principal === "u_b.alice" && dm.recipient.replyTo === "d1", dm.recipient);
  check("a channel message leaves the recipient alone", replyTo(s0(), msg({ kind: "channel", channel: "review" })).recipient === dmBob);
}
{
  check("/reply takes no arguments", sl("/reply").ok && !sl("/reply x").ok);
  const none = replyToLatest(s0());
  check("/reply with no DM or role task keeps the recipient and says so",
    none.recipient === dmBob && none.transcript.some((e) => e.kind === "notice" && /nothing to reply to/.test(e.text)));
  let s = applyEvent(s0(), { type: "message", message: msg({ id: "d1", from: { id: "u_b.alice", name: "alice" } }) });
  s = applyEvent(s, { type: "message", message: task });
  s = applyEvent(s, { type: "message", message: msg({ id: "c1", kind: "channel", channel: "review", from: { id: "o.carol", name: "carol" } }) });
  const r = replyToLatest(s);
  check("/reply answers the latest DM or role task and skips channel messages",
    r.recipient?.kind === "peer" && r.recipient.principal === "u_a.alice" && r.recipient.replyTo === "t1", r.recipient);
  check("the header names the principal a reply goes to", headerRows(r).some((row) => row.text.includes("to DM alice (u_a.alice) (reply)")), headerRows(r));
  const offline = keys(applyEvent(s, { type: "connection", state: "disconnected" }), [{ kind: "char", text: "/reply" }, { kind: "enter", shift: false }]);
  check("/reply runs while disconnected, since it only picks a recipient", offline.intent?.kind === "slash");
  const sent = keys(r, [{ kind: "char", text: "on it" }, { kind: "enter", shift: false }]);
  check("the answer is published to that principal with the task id", sent.intent?.kind === "publish" && sent.intent.to === r.recipient);
  const stored = applyPublishResult(sent.state, { outcome: "stored", messageId: "m10" });
  check("after a stored reply the recipient stays that principal without the quoted id",
    JSON.stringify(stored.recipient) === JSON.stringify({ kind: "peer", principal: "u_a.alice", name: "alice" }), stored.recipient);
}
{
  let s = applyEvent(s0(), { type: "message", message: msg({ id: "a1", from: { id: "u_a.alice", name: "alice" } }) });
  check("a name one principal carries shows alone", transcriptRows(s, 200)[0].text.includes(" DM alice: "), transcriptRows(s, 200));
  s = applyEvent(s, { type: "message", message: msg({ id: "a2", from: { id: "u_b.alice", name: "ALICE" } }) });
  const rows = transcriptRows(s, 200).map((row) => row.text);
  check("two principals sharing a name, compared case-insensitively, each show their principal",
    rows[0].includes(" DM alice (u_a.alice): ") && rows[1].includes(" DM ALICE (u_b.alice): "), rows);
  const roster: RosterView = { view: "current", rows: [{ id: "u_c.alice", name: "alice", kind: "agent", status: "idle" }, { id: "o.bob", name: "bob", kind: "agent", status: "idle" }] };
  const choices = listChoices(undefined, roster, identity.principal, [{ id: "u_a.alice", name: "alice" }]);
  check("the picker shows a present peer's principal when a heard sender shares its name",
    choices.some((c) => c.label === "DM alice (u_c.alice)") && choices.some((c) => c.label === "DM bob"), choices);
  check("without such a sender the picker shows the name alone", listChoices(undefined, roster, identity.principal).some((c) => c.label === "DM alice"));
}
{
  const roster = [presence("u_c.alice", "alice"), presence("o.bob", "bob")];
  const engine = heard(["u_a.alice", "alice"]);
  const both = resolveDmTarget("alice", roster, "current", engine, identity.principal);
  check("a name a present peer and a heard sender both carry refuses and lists both principals",
    "outcome" in both && both.code === "TARGET_AMBIGUOUS" && both.message.includes("u_c.alice") && both.message.includes("u_a.alice"), both);
  const exact = resolveDmTarget("u_a.alice", roster, "current", engine, identity.principal);
  check("a heard sender's principal resolves to that sender", !("outcome" in exact) && exact.id === "u_a.alice" && exact.name === "alice", exact);
  const named = resolveDmTarget("u_a.alice", [...roster, presence("u_d.mallory", "u_a.alice")], "current", engine, identity.principal);
  check("a present peer whose display name is a heard principal does not capture that principal", !("outcome" in named) && named.id === "u_a.alice", named);
  const bob = resolveDmTarget("bob", roster, "current", engine, identity.principal);
  check("a name one principal carries still resolves", !("outcome" in bob) && bob.id === "o.bob", bob);
  const went = resolveDmTarget("alice", [presence("u_c.alice", "alice"), presence("u_a.alice", "alice", "offline")], "current", engine, identity.principal);
  check("a heard sender now offline still makes its name ambiguous beside a live peer", "outcome" in went && went.code === "TARGET_AMBIGUOUS", went);
  const reply = resolveDmTarget({ principal: "u_a.alice" }, roster, "current", engine, identity.principal);
  check("an exact principal is sent as is and keeps the name this session heard", !("outcome" in reply) && reply.id === "u_a.alice" && reply.name === "alice", reply);
  const absent = resolveDmTarget({ principal: "u_z.zed" }, [], "stale", heard(), identity.principal);
  check("an exact principal needs neither the roster nor a current view", !("outcome" in absent) && absent.id === "u_z.zed", absent);
  const bad = resolveDmTarget({ principal: "not a principal" }, roster, "current", engine, identity.principal);
  check("an exact target that is not <owner>.<actor> refuses as usage", "outcome" in bad && bad.code === "USAGE_INVALID", bad);
  const self = resolveDmTarget({ principal: identity.principal }, roster, "current", engine, identity.principal);
  check("an exact target that is this session refuses as usage", "outcome" in self && self.code === "USAGE_INVALID", self);
  const unknown = resolveDmTarget("zed", roster, "stale", engine, identity.principal);
  check("an unknown name on a stale roster is unavailable, never absent", "outcome" in unknown && unknown.code === "TARGET_UNAVAILABLE", unknown);
}
/** An engine that received one message on #review from each sender. A channel's subject names its
 *  sender as a DM's does, so each is a heard sender. */
const heardOnChannel = (...senders: readonly (readonly [string, string])[]): ParticipantEngine => {
  const engine = new ParticipantEngine(identity.principal);
  senders.forEach(([id, name], i) =>
    engine.accept({ id: `c${i}`, ts: 0, space: "selected-space", from: { id, name }, channel: "review", parts: [{ kind: "text", text: "hi" }] },
      { ack() {}, nak() {}, durable: false }, { historical: false, kind: "channel" }, false));
  return engine;
};
{
  const engine = heardOnChannel(["u_a.alice", "alice"]);
  const only = resolveDmTarget("alice", [presence("o.bob", "bob")], "current", engine, identity.principal);
  check("a name only a channel sender carries resolves to that sender's principal", !("outcome" in only) && only.id === "u_a.alice" && only.name === "alice", only);
  const offline = resolveDmTarget("alice", [presence("u_c.alice", "alice")], "current", engine, identity.principal);
  check("a channel sender no longer present still makes its name ambiguous beside a live peer",
    "outcome" in offline && offline.code === "TARGET_AMBIGUOUS", offline);
  check("...and the refusal lists both principals", "outcome" in offline && offline.message.includes("u_c.alice") && offline.message.includes("u_a.alice"), offline);
  const live = resolveDmTarget("alice", [presence("u_c.alice", "alice"), presence("u_a.alice", "alice")], "current", engine, identity.principal);
  check("a name a live peer and a live channel sender both carry refuses", "outcome" in live && live.code === "TARGET_AMBIGUOUS", live);
  const blind = new ParticipantEngine(identity.principal);
  blind.accept({ id: "n1", ts: 0, space: "selected-space", from: { id: "u_a.alice", name: "alice" }, channel: "review", parts: [{ kind: "text", text: "hi" }] },
    { ack() {}, nak() {}, durable: false }, undefined, false);
  check("a message that came with no delivery meta leaves no heard sender", blind.senderName("u_a.alice") === undefined);
}

// ---- 8. a channel outside the grant --------------------------------------------------------------
console.log("8. a channel outside the session's grant refuses before any effect");
{
  const none = grantRefusal([], "review", "post");
  check("a session opened on no channel refuses a post as a permission denial",
    none?.outcome === "refused" && none.code === "PERMISSION_DENIED", none);
  check("...says so and names the command that opens a session on the channel",
    /opened on no channel/.test(none?.message ?? "") && (none?.message ?? "").includes("cotal chat review"), none);
  const read = grantRefusal(["general"], "other", "read");
  check("a channel outside a read grant refuses as a permission denial", read?.code === "PERMISSION_DENIED" && read.message === "#other is outside this session's read grant", read);
  check("no refusal shows a broker subject or calls the session an agent",
    [none, read].every((r) => !/cotal\.|subject|agent/i.test(r?.message ?? "")), [none, read]);
  check("a granted channel, a matching wildcard and an open grant pass",
    grantRefusal(["general"], "general", "post") === undefined && grantRefusal(["team.>"], "team.a", "read") === undefined && grantRefusal([">"], "review", "post") === undefined);
}

// ---- 9. times -------------------------------------------------------------------------------------
console.log("9. transcript times are local, as history shows them");
{
  const saved = process.env.TZ;
  process.env.TZ = "Asia/Kolkata";
  try {
    const ts = Date.UTC(2026, 0, 2, 8, 33, 43);
    const row = transcriptRows(applyEvent(s0(), { type: "message", message: msg({ ts }) }), 200)[0]?.text ?? "";
    const at = new Date(ts);
    check("a message shows its local time and date, not the UTC time of day",
      row.startsWith(`${at.toLocaleDateString()} ${at.toLocaleTimeString()} `) && !row.includes("08:33:43"), row);
  } finally {
    if (saved === undefined) delete process.env.TZ;
    else process.env.TZ = saved;
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
