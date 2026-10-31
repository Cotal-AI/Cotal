/**
 * chat over stand-ins (no broker, no admission, no endpoint).
 *
 * SCOPE, stated honestly: sections 1 and 2 drive the `--plain` and `--stdio` front ends over a
 * recording stand-in typed as an admitted session, which answers `identity`, `subscribe`,
 * `surfaced` and `close` and nothing else. Section 3 builds the real native session over a
 * recording stand-in endpoint, and section 4 sends a DM through it from the views' `@` target and
 * from a `--stdio` `dm` request. Neither stand-in is an admitted session or a native endpoint, and
 * this suite never claims to test the native endpoint: it proves only what the front ends and the
 * session's own checks do with what a stand-in reports. It pins:
 *   - `--plain` prints the close summary once, after `/quit` and after end of input;
 *   - with the binary's `stdoutError` listener registered, as bin/run.ts registers it, a reader that
 *     closes `--plain` or `--stdio` output ends input, the session is closed once, and the process
 *     exits with that close's status (`requested` is 4), not the closed-pipe exit 0. This part runs
 *     this file again as a child process and closes its stdout pipe for real;
 *   - the native session refuses a send, join or channel mode outside its grant without calling the
 *     endpoint, and still reaches the endpoint for a granted channel;
 *   - a typed DM target that parses as a principal is sent to that principal, absent and unheard,
 *     and the present peer whose display name spells it receives nothing;
 *   - a disconnected native session whose endpoint warns that the session's consumer is gone ends
 *     itself with that reason, and the close exits 5;
 *   - what the native session reports before its first subscriber, such as its own presence
 *     `joined`, reaches that subscriber once;
 *   - a full inbox reports its drops as one `inbox` gap with their total: a replay's when the front
 *     end subscribes, later ones a second later or when `--stdio` input ends, and it leaves the
 *     direct messages it lets go unacked.
 * Admission, retirement, delivery and every broker behavior are NOT covered here.
 *
 * Run: pnpm smoke:chat-stand-in
 */
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { JetStreamApiError } from "@nats-io/jetstream";
import { fileURLToPath } from "node:url";
import { createSuite } from "@cotal-ai/smoke-kit";
import type { CotalEndpoint } from "@cotal-ai/core";
import { publish } from "../src/chat/controller.js";
import { loadChatFrontEnd } from "../src/chat/frontend.js";
import { MAX_BUFFER } from "../src/chat/engine.js";
import { NativeChatSession } from "../src/chat/native-session.js";
import { parseRecipient } from "../src/chat/picker.js";
import { runPlain } from "../src/chat/plain.js";
import type { AdmittedChatSession, CloseReport, SessionEvent, SessionIdentity } from "../src/chat/session.js";
import { StdioParticipant, dispatch, parseRequestLine } from "../src/chat/stdio.js";
import { ENDING_NOTICE_MS, closeSummary } from "../src/chat/view.js";
import { shownTime } from "../src/lib/shown-time.js";
import { closeExitCode } from "../src/commands/chat.js";
import { stdoutError } from "../src/lib/stdout-owner.js";

const identity: SessionIdentity = { mode: "open", space: "front-end-space", principal: "local.k3j2", lifecycleUid: "01HZZZABCDEF", label: "me", allowSubscribe: [">"], allowPublish: [">"] };

/** A stand-in that records its closes. With `chatter`, it reports a channel message every 10 ms
 *  until it is closed, so a front end keeps writing. `emit` reports one event to the front end. */
function standIn(close: CloseReport, chatter = false, as: SessionIdentity = identity): { session: AdmittedChatSession; closes: () => number; emit: (e: SessionEvent) => void } {
  const listeners = new Set<(e: SessionEvent) => void>();
  let closes = 0;
  let n = 0;
  const timer = chatter
    ? setInterval(() => {
      n++;
      const event: SessionEvent = { type: "message", message: { deliveryKey: `k${n}`, id: `m${n}`, ts: Date.now(), kind: "channel", from: { id: "u_a.bob", name: "bob" }, channel: "general", text: `hello ${n}`, mentionsMe: false, historical: false } };
      for (const l of listeners) l(event);
    }, 10)
    : undefined;
  const session = {
    identity: () => as,
    subscribe: (l: (e: SessionEvent) => void) => { listeners.add(l); return () => { listeners.delete(l); }; },
    surfaced: () => {},
    close: async () => { closes++; clearInterval(timer); return close; },
  } as unknown as AdmittedChatSession;
  return { session, closes: () => closes, emit: (e) => { for (const l of listeners) l(e); } };
}

const mode = process.argv[2];
if (mode === "plain" || mode === "stdio") {
  process.stdout.on("error", stdoutError);
  const { session, closes } = standIn({ retirement: "requested", connectionClosed: "confirmed", message: "" }, true);
  const start = await loadChatFrontEnd(mode);
  const close = await start({ session });
  process.stderr.write(`closes ${closes()}\n`);
  // What `cotal chat` does with the report a front end returns.
  process.exitCode ??= closeExitCode(close);
} else {
  const { check, finish } = createSuite();

  console.log("1. --plain prints its close summary once");
  {
    const close: CloseReport = { retirement: "retired", connectionClosed: "confirmed", message: "" };
    const summary = closeSummary(identity, close);
    for (const [how, lines] of [["/quit", ["/quit"]], ["end of input", []]] as const) {
      const { session, closes } = standIn(close);
      const input = new PassThrough();
      const output = new PassThrough();
      let printed = "";
      output.setEncoding("utf8").on("data", (d: string) => { printed += d; });
      const run = runPlain({ session, input, output, width: Number.POSITIVE_INFINITY });
      for (const line of lines) input.write(`${line}\n`);
      input.end();
      const state = await run;
      const shown = printed.split("\n").filter((l) => l.includes(summary)).length;
      check(`after ${how}, the session closes once and its summary prints once`, closes() === 1 && state.ended === close && shown === 1, { closes: closes(), shown, printed });
    }
  }

  console.log("1b. --plain writes the rows' punctuation in ASCII");
  {
    const { session } = standIn({ retirement: "retired", connectionClosed: "confirmed", message: "" }, true);
    const input = new PassThrough();
    const output = new PassThrough();
    let printed = "";
    output.setEncoding("utf8").on("data", (d: string) => { printed += d; });
    const run = runPlain({ session, input, output, width: Number.POSITIVE_INFINITY });
    await new Promise((r) => setTimeout(r, 50));
    input.end();
    await run;
    check("--plain prints the header and messages with no non-ASCII punctuation", !/[^\x00-\x7F]/.test(printed) && /^me - local\.k3j2 - session \.\.\.[A-Z0-9]+ - /m.test(printed) && /hello 1/.test(printed), printed.slice(0, 600));
  }

  console.log("1c. --plain drafts: a slash command at the question runs, and a replaced or unfinished draft is named");
  {
    const transcript = async (lines: readonly string[], initialRecipient?: { kind: "channel"; channel: string }): Promise<string> => {
      const { session } = standIn({ retirement: "retired", connectionClosed: "confirmed", message: "" });
      const input = new PassThrough();
      const output = new PassThrough();
      let printed = "";
      output.setEncoding("utf8").on("data", (d: string) => { printed += d; });
      const run = runPlain({ session, input, output, width: Number.POSITIVE_INFINITY, ...(initialRecipient ? { initialRecipient } : {}) });
      for (const line of lines) input.write(`${line}\n`);
      input.end();
      await run;
      return printed;
    };
    // /help at the question used to be the answer that kept the draft, so it never ran.
    const drafts = await transcript(["draft line one", "/help", "n", "second draft", "n", ":multi", "multi a", "multi b"], { kind: "channel", channel: "general" });
    const asks = drafts.split("\n").filter((l) => l.startsWith("send to #general?")).length;
    check("a slash command at the question runs and the question is asked again", drafts.includes("commands: /who") && asks === 3, drafts);
    check("a new draft that replaces a kept one says so, with the kept one's length", drafts.includes("this replaces the kept draft (14 characters)"), drafts);
    check("an unfinished :multi at end of input is reported with its size",
      drafts.includes("unfinished multi-line draft discarded at end of input (2 lines, 15 characters; content not repeated)") && drafts.includes("unsent draft discarded at end of input (12 characters"), drafts);
    const none = await transcript([]);
    check("with no recipient, line mode names :to, not the Tab key", none.includes("to no recipient (:to)") && !none.includes("(Tab)"), none);
  }

  console.log("2. a reader that closes the output still closes the session");
  /** Run one front end as a child and close its stdout pipe at once. Its stdin stays open. */
  const run = (frontEnd: "plain" | "stdio"): Promise<{ code: number | null; stderr: string }> =>
    new Promise((resolve) => {
      const child = spawn(process.execPath, [...process.execArgv, fileURLToPath(import.meta.url), frontEnd], { stdio: ["pipe", "pipe", "pipe"] });
      let stderr = "";
      child.stderr.setEncoding("utf8").on("data", (d: string) => { stderr += d; });
      const timer = setTimeout(() => child.kill("SIGKILL"), 20_000);
      child.on("close", (code) => { clearTimeout(timer); child.stdin.destroy(); resolve({ code, stderr }); });
      child.stdout.destroy();
    });
  for (const frontEnd of ["plain", "stdio"] as const) {
    const r = await run(frontEnd);
    check(`--${frontEnd}: the session closed once and the exit status is the close's (4), not the closed-pipe 0`, r.code === 4 && /^closes 1$/m.test(r.stderr), r);
  }
  {
    const r = await run("stdio");
    check("--stdio says on stderr that the reader closed stdout", r.stderr.includes("stdout closed by the reader; ending the session"), r);
  }

  console.log("3. the native session refuses a channel outside its grant before the endpoint");
  {
    const calls: string[] = [];
    const endpoint = {
      on: () => {}, off: () => {},
      getChannelConfig: () => { calls.push("getChannelConfig"); return undefined; },
      multicast: async () => { calls.push("multicast"); return { id: "m1" }; },
      joinChannel: async () => { calls.push("joinChannel"); return { joined: true, backfilled: 0, durable: false }; },
      setChannelModes: async () => { calls.push("setChannelModes"); },
    } as unknown as CotalEndpoint;
    const session = (read: string[], post: string[]) => new NativeChatSession({
      endpoint, identity: { ...identity, mode: "static", allowSubscribe: read, allowPublish: post },
      retire: async () => ({ retirement: "retired", connectionClosed: "confirmed", message: "" }),
      reopen: (channel) => `cotal chat ${channel} --stdio`,
    });
    const none = session([], []);
    const sent = await none.send("hi", "review", []);
    const joined = await none.join("review");
    const moded = await none.setChannelMode("review", "quiet");
    check("a session opened on no channel refuses a send, a join and a channel mode as permission denials",
      [sent, joined, moded].every((r) => r.outcome === "refused" && r.code === "PERMISSION_DENIED"), [sent, joined, moded]);
    check("...says it was opened on no channel and names the session's reopen command", sent.outcome === "refused" && /opened on no channel/.test(sent.message) && sent.message.includes("run `cotal chat review --stdio` to open"), sent);
    check("...and never called the endpoint", calls.length === 0, calls);
    const general = session(["general"], ["general"]);
    const other = await general.join("other");
    check("a join outside the read grant refuses before the endpoint", other.outcome === "refused" && other.code === "PERMISSION_DENIED" && calls.length === 0, { other, calls });
    const ok = await general.join("general");
    const stored = await general.send("hi", "general", []);
    check("a granted join and send reach the endpoint", ok.outcome === "ok" && stored.outcome === "stored" && calls.join() === "joinChannel,getChannelConfig,multicast", { ok, stored, calls });
  }

  console.log("4. a typed principal reaches that principal, never a peer whose display name spells it");
  {
    // u_z.alice is not on the roster and this session never heard from it. The present peer
    // u_d.mallory carries it as its display name.
    const sent: string[] = [];
    const endpoint = {
      on: () => {}, off: () => {},
      getRoster: () => [{ card: { id: "u_d.mallory", name: "u_z.alice", kind: "agent" }, status: "idle", ts: 0 }],
      presenceView: () => ({ state: "current" }),
      unicastAttributed: async (to: string) => { sent.push(to); return { msg: { id: `d${sent.length}` }, ack: { seq: sent.length, duplicate: false } }; },
    } as unknown as CotalEndpoint;
    const session = new NativeChatSession({ endpoint, identity, retire: async () => ({ retirement: "retired", connectionClosed: "confirmed", message: "" }), reopen: (channel) => `cotal chat ${channel}` });
    const typed = parseRecipient("@u_z.alice");
    const viaView = typed.ok ? await publish(session, typed.recipient, "for alice") : undefined;
    check("an @ target that parses as a principal is sent to that principal, absent and unheard",
      viaView?.outcome === "stored" && viaView.recipient?.id === "u_z.alice" && sent.join() === "u_z.alice", { typed, viaView, sent });
    const line = parseRequestLine(JSON.stringify({ schemaVersion: 1, type: "dm", id: "d1", to: "u_z.alice", text: "for alice" }));
    const viaStdio = line.ok ? (await dispatch(session, line.request)).record : undefined;
    const stdioRecipient = (viaStdio?.result as { recipient?: { id?: string } } | undefined)?.recipient;
    check("a --stdio dm whose to parses as a principal is sent to that principal, absent and unheard",
      viaStdio?.outcome === "stored" && stdioRecipient?.id === "u_z.alice" && sent.join() === "u_z.alice,u_z.alice", { line, viaStdio, sent });
    check("the peer whose display name spells the principal received nothing", !sent.includes("u_d.mallory"), sent);
  }

  console.log("5. a reconnect that finds the session's inbox gone ends the session with that reason");
  {
    const consumerGone = new JetStreamApiError({ code: 404, err_code: 10014, description: "consumer not found" });
    const lostSession = () => {
      const endpoint = Object.assign(new EventEmitter(), { stop: async () => {} }) as unknown as CotalEndpoint;
      const session = new NativeChatSession({ endpoint, identity: { ...identity, mode: "static" }, retire: async () => ({ retirement: "retired", connectionClosed: "confirmed", message: "retired" }), reopen: (channel) => `cotal chat ${channel}` });
      const events: SessionEvent[] = [];
      session.subscribe((e) => events.push(e));
      return { endpoint: endpoint as unknown as EventEmitter, session, events };
    };
    const connected = lostSession();
    connected.endpoint.emit("warning", consumerGone);
    const other = lostSession();
    other.endpoint.emit("connection", { connected: false });
    other.endpoint.emit("warning", new Error("connection refused"));
    await new Promise((resolve) => setImmediate(resolve));
    check("a connected session, or a disconnected one with another warning, keeps running",
      [connected, other].every((s) => !s.events.some((e) => e.type === "connection" && e.state === "ended")), [connected.events, other.events]);
    const lost = lostSession();
    lost.endpoint.emit("connection", { connected: false });
    lost.endpoint.emit("warning", consumerGone);
    const report = await lost.session.close();
    const ended = lost.events.find((e) => e.type === "connection" && e.state === "ended");
    check("a disconnected session told its inbox is gone ends itself with the reason, and its close carries it",
      ended?.type === "connection" && /inbox is gone/.test(ended.reason ?? "") && report.lost === ended.reason, { ended, report });
    check("...and that close exits 5", closeExitCode(report) === 5, report);
  }

  console.log("6. --plain says when a session ends, warns before it, and /quit leaves one that ended");
  {
    const close: CloseReport = { retirement: "retired", connectionClosed: "confirmed", message: "" };
    // Due in 300 ms: the end is a minute and 300 ms away.
    const expiresAt = Date.now() + ENDING_NOTICE_MS + 300;
    const { session, closes, emit } = standIn(close, false, { ...identity, mode: "static", expiresAt });
    const input = new PassThrough();
    const output = new PassThrough();
    let printed = "";
    output.setEncoding("utf8").on("data", (d: string) => { printed += d; });
    const run = runPlain({ session, input, output, width: Number.POSITIVE_INFINITY });
    const at = shownTime(expiresAt);
    check("the banner says when the session ends", printed.includes(`static session (ends at ${at}; credential valid until then)`), printed);
    await new Promise((resolve) => setTimeout(resolve, 600));
    check("a minute before its end, the session says when it ends", printed.includes(`this session ends at ${at}; open a new session to keep chatting after that`), printed);
    emit({ type: "connection", state: "ended", reason: "the session reached its expiry" });
    input.write("hello\n");
    input.write("/quit\n");
    // Input stays open: only /quit can end this run.
    const state = await Promise.race([run, new Promise<undefined>((resolve) => setTimeout(resolve, 5_000))]);
    check("after the session ended, /quit leaves while input is still open, and the session closes once", state?.ended === close && closes() === 1, { closes: closes(), printed });
    check("...and a line before it is told /quit leaves", printed.includes("session ended; type /quit or end input (Ctrl-D) to leave"), printed);
    input.end();
    await run;
  }

  console.log("7. /quit leaves --plain from the recipient list");
  {
    const close: CloseReport = { retirement: "retired", connectionClosed: "confirmed", message: "" };
    const { session, closes } = standIn(close);
    // The list reads the session's connection and roster; neither is needed to list nothing.
    Object.assign(session, { connection: async () => ({ outcome: "failed", message: "not read" }), roster: async () => ({ outcome: "failed", message: "not read" }) });
    const input = new PassThrough();
    const output = new PassThrough();
    let printed = "";
    output.setEncoding("utf8").on("data", (d: string) => { printed += d; });
    const run = runPlain({ session, input, output, width: Number.POSITIVE_INFINITY });
    // A target without `@` is refused, and the numbered list opens.
    input.write(":to manager\n");
    input.write("/quit\n");
    const state = await Promise.race([run, new Promise<undefined>((resolve) => setTimeout(resolve, 5_000))]);
    check("/quit in the recipient list leaves while input is still open, and the session closes once", state?.ended === close && closes() === 1, { closes: closes(), printed });
    check("...and the list says /quit leaves", printed.includes("empty line cancels, /quit leaves"), printed);
    input.end();
    await run;
  }

  console.log("8. a typed @name that reaches no one is refused at :to, and the numbered list opens");
  {
    const close: CloseReport = { retirement: "retired", connectionClosed: "confirmed", message: "" };
    const { session } = standIn(close);
    const asked: unknown[] = [];
    Object.assign(session, {
      connection: async () => ({ outcome: "failed", message: "not read" }),
      roster: async () => ({ outcome: "ok", value: { view: "current", rows: [{ id: "u_a.bob", name: "bob", kind: "agent", status: "idle" }] } }),
      resolveDm: async (to: unknown) => {
        asked.push(to);
        return to === "bob" ? { outcome: "ok", value: { id: "u_a.bob", name: "bob" } } : { outcome: "refused", code: "TARGET_NOT_FOUND", message: `no peer "${String(to)}" in this space` };
      },
    });
    const input = new PassThrough();
    const output = new PassThrough();
    let printed = "";
    output.setEncoding("utf8").on("data", (d: string) => { printed += d; });
    const run = runPlain({ session, input, output, width: Number.POSITIVE_INFINITY });
    input.write(":to @niemand\n");
    input.write("\n");
    input.write(":to @bob\n");
    input.write("/quit\n");
    await Promise.race([run, new Promise<undefined>((resolve) => setTimeout(resolve, 5_000))]);
    check("`:to @niemand` is refused with the reason a send to it would get, and is never the recipient", printed.includes('no peer "niemand" in this space') && !printed.includes("[to DM niemand]"), printed);
    check("...and the numbered list opens with the roster", printed.includes("1. DM bob"), printed);
    check("a name that resolves is chosen, and each choice was resolved once", printed.includes("[to DM bob]") && JSON.stringify(asked) === JSON.stringify(["niemand", "bob"]), { asked, printed });
    input.end();
    await run;
  }

  console.log("9. /history on an open mesh reads the channel itself; the other modes ask the delivery daemon");
  {
    const reads: string[] = [];
    const page = { items: [], complete: true };
    const endpoint = Object.assign(new EventEmitter(), {
      channelHistoryPage: async () => { reads.push("channelHistoryPage"); return page; },
      readHistory: async () => { reads.push("readHistory"); return page; },
    }) as unknown as CotalEndpoint;
    const retire = async (): Promise<CloseReport> => ({ retirement: "retired", connectionClosed: "confirmed", message: "" });
    const open = await new NativeChatSession({ endpoint, identity: { ...identity, mode: "open" }, retire, reopen: (channel) => `cotal chat ${channel}` }).history("general", 50);
    check("an open session's /history reads the channel's stream, which needs no delivery daemon", open.outcome === "ok" && reads.join() === "channelHistoryPage", { open, reads });
    reads.length = 0;
    const admitted = await new NativeChatSession({ endpoint, identity: { ...identity, mode: "static" }, retire, reopen: (channel) => `cotal chat ${channel}` }).history("general", 50);
    check("a static session's /history still reads through the delivery daemon", admitted.outcome === "ok" && reads.join() === "readHistory", { admitted, reads });
  }

  console.log("10. what the session reports before a front end subscribes reaches that front end");
  {
    // The endpoint's start reports presence, the session's own row included, before the front end
    // has subscribed to the session.
    const endpoint = new EventEmitter();
    const session = new NativeChatSession({ endpoint: endpoint as unknown as CotalEndpoint, identity, retire: async () => ({ retirement: "retired", connectionClosed: "confirmed", message: "" }), reopen: (channel) => `cotal chat ${channel}` });
    const presence = (name: string) => ({ card: { id: `local.${name}`, name, kind: "endpoint" }, status: "idle", ts: 0 });
    endpoint.emit("presence", { type: "join", presence: presence("me") });
    const first: SessionEvent[] = [], second: SessionEvent[] = [];
    session.subscribe((e) => first.push(e));
    endpoint.emit("presence", { type: "join", presence: presence("peer") });
    session.subscribe((e) => second.push(e));
    const joined = (events: SessionEvent[]) => events.map((e) => e.type === "presence" ? `${e.change} ${e.row.name}` : e.type);
    check("the first subscriber gets the session's own joined from before it subscribed, then what follows", JSON.stringify(joined(first)) === JSON.stringify(["joined me", "joined peer"]), joined(first));
    check("...and a later subscriber gets only what follows it", second.length === 0, joined(second));
  }

  console.log("11. a full inbox reports its drops as one gap with their total");
  {
    const opened = () => {
      const endpoint = Object.assign(new EventEmitter(), { stop: async () => {} });
      const session = new NativeChatSession({ endpoint: endpoint as unknown as CotalEndpoint, identity, retire: async () => ({ retirement: "retired", connectionClosed: "confirmed", message: "" }), reopen: (channel) => `cotal chat ${channel}` });
      let acks = 0;
      const deliver = (n: number, kind: "channel" | "dm") => {
        for (let i = 1; i <= n; i++)
          endpoint.emit("message", { id: `${kind}${i}`, ts: i, space: "front-end-space", from: { id: "u_a.alice", name: "alice" }, ...(kind === "channel" ? { channel: "general" } : {}), parts: [{ kind: "text", text: `msg-${i}` }] },
            { ack: () => acks++, nak() {}, durable: true }, { historical: kind === "channel", kind });
      };
      return { session, deliver, acks: () => acks };
    };
    const gaps = (events: SessionEvent[]) => events.flatMap((e) => e.type === "gap" ? [`${e.scope}: ${e.reason}`] : []);
    // A replay past the bound before the front end subscribes.
    const replay = opened();
    replay.deliver(MAX_BUFFER + 100, "channel");
    const seen: SessionEvent[] = [];
    const unsubscribe = replay.session.subscribe((e) => seen.push(e));
    const atSubscribe = gaps(seen);
    unsubscribe();
    check(`a replay of ${MAX_BUFFER + 100} is one gap when the front end subscribes, counting the 100 dropped and naming no direct messages`,
      JSON.stringify(atSubscribe) === JSON.stringify(["inbox: buffer full: 100 channel message(s) dropped"]) && gaps(seen).length === 1, { atSubscribe, all: gaps(seen) });
    check("...and the dropped channel copies were acked", replay.acks() === 100, replay.acks());
    // Direct messages past the bound while subscribed: the gap waits a second for more.
    const live = opened();
    const heard: SessionEvent[] = [];
    live.session.subscribe((e) => heard.push(e));
    live.deliver(MAX_BUFFER + 3, "dm");
    const before = gaps(heard).length;
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    await live.session.close();
    check("direct messages past the bound are one gap a second later, left for broker redelivery",
      before === 0 && JSON.stringify(gaps(heard)) === JSON.stringify(["inbox: buffer full: 3 direct message(s) left for broker redelivery"]), { before, gaps: gaps(heard) });
    check("...and none of them was acked", live.acks() === 0, live.acks());
    // Drops just before --stdio input ends are reported before the end record.
    const ending = opened();
    const records: string[] = [];
    const participant = new StdioParticipant(ending.session, (line) => records.push(line));
    ending.deliver(MAX_BUFFER + 5, "channel");
    await participant.endOfInput();
    const types = records.map((line) => (JSON.parse(line) as { type: string; reason?: string }));
    check("--stdio writes the drops' gap before its end record when input ends within the second",
      JSON.stringify(types.map((r) => r.type === "gap" ? r.reason : r.type)) === JSON.stringify(["buffer full: 5 channel message(s) dropped", "end"]), types);
  }

  finish();
}
