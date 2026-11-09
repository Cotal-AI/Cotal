/**
 * Chat composer rules pure smoke (no broker, no session).
 *
 * SCOPE, stated honestly: this checks the pure rules in `chat/compose.ts` that every human chat
 * front end shares: slash parsing, typed recipients, the reply recipient, the publish routing, the
 * publish outcome and the close summary.
 * The CLI's own suites cover how `cotal chat` folds the Enter, publish and slash rules into its
 * state. Nothing here opens a session or proves any native behavior.
 *
 * Run: pnpm smoke:chat-compose
 */
import { createSuite } from "@cotal-ai/smoke-kit";
import { closeSummary, parseRecipient, parseSlash, publish, recipientLabel, replyRecipient, runsOffline, settlePublish, submitDraft, type AdmittedChatSession, type CloseReport, type PublishResult, type Recipient, type SessionIdentity, type SessionMessage } from "../src/chat/index.js";

const { check, finish } = createSuite();

const identity: SessionIdentity = { mode: "open", space: "selected-space", principal: "local.k3j2", lifecycleUid: "01HZZZABCDEF", label: "me", allowSubscribe: [], allowPublish: [] };
const msg = (over: Partial<SessionMessage> = {}): SessionMessage => ({
  deliveryKey: "dk-secret", id: "m1", ts: Date.UTC(2026, 9, 20, 12, 0, 0), kind: "dm",
  from: { id: "o.bob", name: "bob" }, text: "hello", mentionsMe: false, historical: false, ...over,
});

console.log("1. parseSlash: closed set with bounded arguments");
const sl = (l: string) => parseSlash(l);
check("/exit is /quit", parseSlash("/exit").ok && (parseSlash("/exit") as { command: { name: string } }).command.name === "quit");
check("/history defaults to 50", sl("/history").ok && (sl("/history") as { command: { limit: number } }).command.limit === 50);
check("/history 0, 1001, 2.5 and abc are refused", ["/history 0", "/history 1001", "/history 2.5", "/history abc"].every((l) => !sl(l).ok));
check("/inbox --peek peeks; /inbox x is refused", (sl("/inbox --peek") as { command: { peek: boolean } }).command.peek === true && !sl("/inbox x").ok);
check("/who takes no arguments", !sl("/who x").ok);
check("/join needs exactly one channel", !sl("/join").ok && !sl("/join a b").ok && sl("/join a").ok);
{
  // The view prints a channel as #name, so a channel slash command reads it with or without the #.
  const channelOf = (l: string) => (sl(l) as { command?: { channel?: string } }).command?.channel;
  check("a channel slash command strips one leading #", ["/join #bad", "/leave #bad", "/info #bad", "/quiet #bad", "/mute #bad", "/normal #bad"].every((l) => channelOf(l) === "bad"));
  check("a bare # names no channel", !sl("/join #").ok && !sl("/quiet #").ok);
}
check("/status keeps a multi-word activity", (sl("/status working on it") as { command: { activity?: string } }).command.activity === "on it");
check("/help is a command, takes no arguments and runs while disconnected",
  (sl("/help") as { command: { name: string } }).command?.name === "help" && !sl("/help x").ok && runsOffline({ name: "help" }));
{
  const r = sl("/bogus\u001b[2J");
  check("an unknown command is refused with its name escaped", !r.ok && (r as { error: string }).error.includes("\\u001b") && !(r as { error: string }).error.includes("\u001b"));
}
check("/reply takes no arguments", sl("/reply").ok && !sl("/reply x").ok);
{
  const refused = sl("/reply pong back");
  check("/reply with a message names the usage", !refused.ok && refused.error === "/reply takes no arguments; it answers the latest direct message or role task, and the message is typed after it", refused);
  const at = { recipient: { kind: "channel" as const, channel: "general" }, connection: "connected" as const, sending: false, pick: "Tab" };
  const held = submitDraft("/reply pong back", at);
  check("a refused slash command clears its line", held.kind === "hold" && held.clear === true && held.tone === "failed", held);
  const kept = submitDraft("/who", { ...at, connection: "disconnected" });
  check("a command the connection cannot run keeps its line", kept.kind === "hold" && kept.clear === undefined, kept);
  const unknown = submitDraft("/nope", at);
  check("an unknown command clears its line too", unknown.kind === "hold" && unknown.clear === true, unknown);
}

console.log("2. closeSummary: open mode claims routing only");
{
  const close: CloseReport = { retirement: "not-applicable", connectionClosed: "confirmed", message: "" };
  const text = closeSummary(identity, close);
  check("open-mode close says there is no lifecycle to retire", /no lifecycle to retire/.test(text));
  check("the close summary never claims messages were erased", !/erase|delet|wiped/i.test(text) && /retention policy/.test(text));
  const st: SessionIdentity = { ...identity, mode: "static" };
  const until = Date.UTC(2026, 9, 20, 13, 0, 0);
  check("static close with an unconfirmed connection names the credential's validity", new RegExp(new Date(until).toISOString()).test(closeSummary(st, { retirement: "requested", connectionClosed: "not-confirmed", credentialValidUntil: until, message: "" })));
}

console.log("3. a reply goes where the message came from, quoting its id");
{
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  const self = identity.principal;
  const task = msg({ id: "t1", kind: "anycast", service: "reviewer", from: { id: "u_a.alice", name: "alice" } });
  const r = replyRecipient(task, self);
  check("a reply to a role task addresses its sender's principal and quotes the task id",
    same(r, { kind: "peer", principal: "u_a.alice", name: "alice", replyTo: "t1" }), r);
  const dm = replyRecipient(msg({ id: "d1", from: { id: "u_b.alice", name: "alice" } }), self);
  check("a reply to a DM addresses its sender's principal", same(dm, { kind: "peer", principal: "u_b.alice", name: "alice", replyTo: "d1" }), dm);
  const post = replyRecipient(msg({ id: "c1", kind: "channel", channel: "review" }), self);
  check("a reply to a channel message is answered on its channel, quoting its id", same(post, { kind: "channel", channel: "review", replyTo: "c1" }), post);
  const ownPost = replyRecipient(msg({ id: "c2", kind: "channel", channel: "review", from: { id: self, name: "me" } }), self);
  check("your own channel message can be answered on its channel", same(ownPost, { kind: "channel", channel: "review", replyTo: "c2" }), ownPost);
  const ownDm = replyRecipient(msg({ id: "d2", from: { id: self, name: "me" } }), self);
  const ownTask = replyRecipient(msg({ id: "t2", kind: "anycast", from: { id: self, name: "me" } }), self);
  check("a reply to your own DM or role task refuses", same(ownDm, { refused: "that is your own message" }) && same(ownTask, ownDm), { ownDm, ownTask });
  check("a channel reply reads as a reply", recipientLabel({ kind: "channel", channel: "review", replyTo: "c1" }, "Tab") === "#review (reply)");
}

console.log("4. publish: the routing a draft takes through the session");
{
  const calls: unknown[][] = [];
  const stored: PublishResult = { outcome: "stored", messageId: "x", channel: "general", registered: true };
  const recording = {
    send: async (...a: unknown[]) => { calls.push(["send", ...a]); return stored; },
    dm: async (...a: unknown[]) => { calls.push(["dm", ...a]); return stored; },
    anycast: async (...a: unknown[]) => { calls.push(["anycast", ...a]); return stored; },
  } as unknown as AdmittedChatSession;
  await publish(recording, { kind: "channel", channel: "general" }, "hi @planner and @coder-2 now");
  check("a channel post carries the @names its text holds as mentions", JSON.stringify(calls.pop()) === JSON.stringify(["send", "hi @planner and @coder-2 now", "general", ["planner", "coder-2"], null]));
  await publish(recording, { kind: "channel", channel: "general", replyTo: "c1" }, "agreed");
  check("a channel reply carries its replyTo to the session", JSON.stringify(calls.pop()) === JSON.stringify(["send", "agreed", "general", [], "c1"]));
  await publish(recording, { kind: "peer", principal: "u_a.alice", name: "alice", replyTo: "d1" }, "hi @planner");
  check("a peer reply goes by principal with its replyTo", JSON.stringify(calls.pop()) === JSON.stringify(["dm", { principal: "u_a.alice" }, "hi @planner", "d1"]));
}

console.log("5. settlePublish: a stored reply is answered once");
{
  const stored: PublishResult = { outcome: "stored", messageId: "x", channel: "review", registered: true };
  const reply: Recipient = { kind: "channel", channel: "review", replyTo: "c1" };
  const after = settlePublish({ to: reply, draft: "ok" }, stored, { recipient: reply, draft: "ok" });
  check("a stored channel reply drops its replyTo and stays on the channel", JSON.stringify(after.recipient) === JSON.stringify({ kind: "channel", channel: "review" }) && after.draft === "", after);
  const peer: Recipient = { kind: "peer", principal: "u_a.alice", name: "alice", replyTo: "d1" };
  const dmAfter = settlePublish({ to: peer, draft: "ok" }, { outcome: "stored", messageId: "y", recipient: { id: "u_a.alice", name: "alice" }, recipientStatusAtSend: "idle" }, { recipient: peer, draft: "ok" });
  check("a stored peer reply drops its replyTo", JSON.stringify(dmAfter.recipient) === JSON.stringify({ kind: "peer", principal: "u_a.alice", name: "alice" }), dmAfter);
  const other: Recipient = { kind: "channel", channel: "general" };
  const changed = settlePublish({ to: reply, draft: "ok" }, stored, { recipient: other, draft: "next" });
  check("a recipient changed during the send is kept, and so is a changed draft", changed.recipient === other && changed.draft === "next", changed);
  const refused = settlePublish({ to: reply, draft: "ok" }, { outcome: "refused", code: "PERMISSION_DENIED", message: "no" }, { recipient: reply, draft: "ok" });
  check("a refused reply keeps its replyTo and its draft", refused.recipient === reply && refused.draft === "ok", refused);
}

console.log("6. parseRecipient: a typed recipient");
{
  const typed = (text: string) => { const parsed = parseRecipient(text, "pick a number"); return parsed.ok ? undefined : parsed.error; };
  check("a typed channel holding * or > gets the sentence cotal send -c gives",
    ["#gen*", "#team.*", "#team.>"].every((text) => typed(text) === "name one concrete channel, without wildcards"));
  check("a typed channel outside the grammar gets the rule it breaks, naming the segment",
    typed("#gen eral")?.startsWith('invalid channel "gen eral": segment "gen eral" must be a NATS-safe token') === true, typed("#gen eral"));
  const bare = parseRecipient("alice", "press Tab");
  check("a bare word is not guessed, and the refusal ends with the front end's own way to choose",
    !bare.ok && bare.error === "type #channel, @name or role:<role>, or press Tab", bare);
  const general = parseRecipient("#general", "pick a number");
  check("a typed concrete channel is chosen", general.ok && general.recipient.kind === "channel" && general.recipient.channel === "general", general);
}

finish();
