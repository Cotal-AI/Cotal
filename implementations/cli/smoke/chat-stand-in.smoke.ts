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
 *     itself with that reason, and the close exits 5.
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
import { NativeChatSession } from "../src/chat/native-session.js";
import { parseRecipient } from "../src/chat/picker.js";
import { runPlain } from "../src/chat/plain.js";
import type { AdmittedChatSession, CloseReport, SessionEvent, SessionIdentity } from "../src/chat/session.js";
import { dispatch, parseRequestLine } from "../src/chat/stdio.js";
import { closeSummary } from "../src/chat/view.js";
import { closeExitCode } from "../src/commands/chat.js";
import { stdoutError } from "../src/lib/stdout-owner.js";

const identity: SessionIdentity = { mode: "open", space: "front-end-space", principal: "local.k3j2", lifecycleUid: "01HZZZABCDEF", label: "me", allowSubscribe: [">"], allowPublish: [">"] };

/** A stand-in that records its closes. With `chatter`, it reports a channel message every 10 ms
 *  until it is closed, so a front end keeps writing. */
function standIn(close: CloseReport, chatter = false): { session: AdmittedChatSession; closes: () => number } {
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
    identity: () => identity,
    subscribe: (l: (e: SessionEvent) => void) => { listeners.add(l); return () => { listeners.delete(l); }; },
    surfaced: () => {},
    close: async () => { closes++; clearInterval(timer); return close; },
  } as unknown as AdmittedChatSession;
  return { session, closes: () => closes };
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
    });
    const none = session([], []);
    const sent = await none.send("hi", "review", []);
    const joined = await none.join("review");
    const moded = await none.setChannelMode("review", "quiet");
    check("a session opened on no channel refuses a send, a join and a channel mode as permission denials",
      [sent, joined, moded].every((r) => r.outcome === "refused" && r.code === "PERMISSION_DENIED"), [sent, joined, moded]);
    check("...says it was opened on no channel", sent.outcome === "refused" && /opened on no channel/.test(sent.message), sent);
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
    const session = new NativeChatSession({ endpoint, identity, retire: async () => ({ retirement: "retired", connectionClosed: "confirmed", message: "" }) });
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
      const session = new NativeChatSession({ endpoint, identity: { ...identity, mode: "static" }, retire: async () => ({ retirement: "retired", connectionClosed: "confirmed", message: "retired" }) });
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

  finish();
}
