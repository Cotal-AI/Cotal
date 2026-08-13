/**
 * Control-server reply test (no test runner, no broker) — the server must answer an authenticated
 * client whether or not anyone is watching delivery.
 *
 * The regression this pins: the reply write lived inside an optional call's argument list
 * (`opts.onReply?.(ev, await writeReply(...))`). Optional chaining short-circuits the WHOLE call
 * expression when the callback is absent, arguments included, so every caller that does not pass
 * `onReply` — opencode, hermes, pi, codex — got no reply at all. The handler still ran and still saw
 * the event, so the failure is invisible from the server side: only the client sees the silence.
 *
 * Answering is the server's job; `onReply` only observes it. Each opts shape below is a real caller.
 * Run: pnpm smoke:control-reply
 */
import { strict as assert } from "node:assert";
import { connect } from "node:net";
import { startControlServer, HANDOFF_RECEIPT, type ControlServerOpts } from "../src/control.js";
import { controlEndpoint } from "../src/runtime.js";
import type { MeshAgent } from "../src/agent.js";

const stubAgent = {} as MeshAgent;
let pass = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  assert.ok(cond, `${name}${extra !== undefined ? ` — ${JSON.stringify(extra)}` : ""}`);
  pass++;
  console.log(`  ✓ ${name}`);
};

const listening = (server: ReturnType<typeof startControlServer>): Promise<void> =>
  new Promise((resolve) => (server.listening ? resolve() : server.once("listening", () => resolve())));

/** Send one frame and read whatever comes back. `handoff` clients answer the reply with a receipt,
 *  which is what lets the server half of that path settle. */
function sendFrame(path: string, frame: unknown, receipt = false): Promise<string> {
  return new Promise((resolve) => {
    const sock = connect(path);
    let reply = "";
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      try {
        sock.destroy();
      } catch {
        /* ignore */
      }
      resolve(reply);
    };
    sock.setEncoding("utf8");
    sock.on("connect", () => sock.write(JSON.stringify(frame) + "\n"));
    sock.on("data", (d) => {
      reply += d;
      if (receipt && reply.includes("\n")) sock.write(HANDOFF_RECEIPT);
    });
    sock.on("end", finish);
    sock.on("close", finish);
    sock.on("error", finish);
    setTimeout(finish, 2000);
  });
}

/** One server per case: the endpoint path is token-derived, so cases never collide. */
async function replyFor(label: string, opts: ControlServerOpts | undefined, handoff = false): Promise<string> {
  const ep = controlEndpoint("ctlreply", label);
  let sawEvent = false;
  const server =
    opts === undefined
      ? startControlServer(stubAgent, ep, async () => ((sawEvent = true), { handled: true }))
      : startControlServer(stubAgent, ep, async () => ((sawEvent = true), { handled: true }), opts);
  try {
    await listening(server);
    const r = await sendFrame(ep.path, { token: ep.token, event: { hook_event_name: "SessionStart" }, ...(handoff ? { handoff: true } : {}) }, handoff);
    // The handler running is NOT the property under test — it ran even while the reply was lost.
    check(`${label}: the handler ran`, sawEvent);
    return r.trim();
  } finally {
    server.close();
  }
}

const WANT = JSON.stringify({ handled: true });

// The four production opts shapes. Only claude-code passes `onReply`; it is the one caller the
// short-circuit spared, which is exactly why nothing gated caught this.
check("no opts argument at all → reply returned", (await replyFor("noargs", undefined)) === WANT);
check("empty opts → reply returned", (await replyFor("empty", {})) === WANT);
check(
  "onShutdown but no onReply (opencode, hermes, pi, codex) → reply returned",
  (await replyFor("noonreply", { fatalBind: false, onShutdown: () => {} })) === WANT,
);

let observed: boolean | undefined;
check(
  "onReply present (claude-code) → reply returned",
  (await replyFor("onreply", { onReply: (_ev, delivered) => (observed = delivered) })) === WANT,
);
check("onReply still observes the delivery it no longer performs", observed === true);

check("handoff client with no onReply → reply returned", (await replyFor("handoff", {}, true)) === WANT);

console.log(`\nCONTROL-REPLY TESTS PASSED ✅  (${pass} checks)`);
process.exit(0);
