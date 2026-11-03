/**
 * Chat composer rules pure smoke (no broker, no session).
 *
 * SCOPE, stated honestly: this checks the pure rules in `chat/compose.ts` that every human chat
 * front end shares: slash parsing, typed recipients, the reply recipient and the close summary.
 * The CLI's own suites cover how `cotal chat` folds the Enter, publish and slash rules into its
 * state. Nothing here opens a session or proves any native behavior.
 *
 * Run: pnpm smoke:chat-compose
 */
import { createSuite } from "@cotal-ai/smoke-kit";
import { closeSummary, parseRecipient, parseSlash, replyRecipient, runsOffline, type CloseReport, type SessionIdentity, type SessionMessage } from "../src/chat/index.js";

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

console.log("3. a reply addresses the sender's principal");
{
  const task = msg({ id: "t1", kind: "anycast", service: "reviewer", from: { id: "u_a.alice", name: "alice" } });
  const r = replyRecipient(task);
  check("a reply to a role task addresses its sender's principal and quotes the task id",
    JSON.stringify(r) === JSON.stringify({ kind: "peer", principal: "u_a.alice", name: "alice", replyTo: "t1" }), r);
  const dm = replyRecipient(msg({ id: "d1", from: { id: "u_b.alice", name: "alice" } }));
  check("a reply to a DM addresses its sender's principal", dm?.kind === "peer" && dm.principal === "u_b.alice" && dm.replyTo === "d1", dm);
  check("a channel message has no reply recipient, so the current one stays", replyRecipient(msg({ kind: "channel", channel: "review" })) === undefined);
}

console.log("4. parseRecipient: a typed recipient");
{
  const typed = (text: string) => { const parsed = parseRecipient(text); return parsed.ok ? undefined : parsed.error; };
  check("a typed channel holding * or > gets the sentence cotal send -c gives",
    ["#gen*", "#team.*", "#team.>"].every((text) => typed(text) === "name one concrete channel, without wildcards"));
  check("a typed channel outside the grammar gets the rule it breaks, naming the segment",
    typed("#gen eral")?.startsWith('invalid channel "gen eral": segment "gen eral" must be a NATS-safe token') === true, typed("#gen eral"));
  const general = parseRecipient("#general");
  check("a typed concrete channel is chosen", general.ok && general.recipient.kind === "channel" && general.recipient.channel === "general", general);
}

finish();
