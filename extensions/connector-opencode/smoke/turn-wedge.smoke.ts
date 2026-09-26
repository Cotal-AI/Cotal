/**
 * OpenCode turn-state regression test (no test runner) — spins up its OWN nats-server and drives the
 * plugin's turn state machine with a fake OpenCode HTTP server + real opencode bus events. It guards the
 * wedge fixed in plugin.ts: `busy` is set true by `session.status: busy` for ANY turn (incl. a human
 * typing into the attached TUI), but used to be cleared only on a connector-DRIVEN turn's end — so the
 * first human turn left `busy` stuck true and every later channel/DM push was buffered forever.
 *
 * Flow (no model, no `opencode` binary — just the plugin closure + a real mesh):
 *   1. a live channel message drives a turn (prompt_async #1)  — baseline push works;
 *   2. that turn completes (session.idle);
 *   3. quiet channel traffic remains pull-only across native prompts and is consumed by cotal_inbox;
 *   4. repeated cotal_inbox pulls do not repeat the quiet item;
 *   5. a directed DM that auto-drives and errors is retried after a bounded delay;
 *   6. a HUMAN turn still clears busy, then a second normal channel message MUST drive a turn
 *      (prompt_async #2) — the original wedge fix still holds;
 *   7. a user interrupt consumes the surfaced peer batch instead of redriving it;
 *   8. sustained failure exercises the error-retry backoff itself: the delay doubles, one timer
 *      exists at a time, a 30s ceiling holds, recovery resets the delay, and a stop landing while
 *      a retry is pending submits nothing.
 * Run: pnpm smoke:opencode
 */
import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { createServer as createHttpServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CotalEndpoint, seedChannelRegistry, isReachable } from "@cotal-ai/core";
import { bootPlugin } from "./_boot-plugin.js";
import { SMOKE_BROKER_TOKEN, awaitBrokerReady, teardownOnSignal } from "@cotal-ai/smoke-kit";

async function freePort(): Promise<number> {
  const srv = createNetServer();
  srv.listen(0, "127.0.0.1");
  await once(srv, "listening");
  const port = (srv.address() as { port: number }).port;
  await new Promise<void>((r) => srv.close(() => r()));
  return port;
}

const PORT = await freePort();
const servers = `nats://127.0.0.1:${PORT}`;
const space = "ocwedge";
const SID = "ses_test";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const dir = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
const srv = spawn("nats-server", ["-js", "-p", String(PORT), "-sd", join(dir, "js")], { stdio: "ignore" });
const releaseBroker = teardownOnSignal(srv, dir);
const auth = `Basic ${Buffer.from("opencode:test-secret").toString("base64")}`;
let pass = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  assert.ok(cond, `${name}${extra !== undefined ? ` — ${JSON.stringify(extra)}` : ""}`);
  pass++;
  console.log(`  ✓ ${name}`);
};

// A fake OpenCode HTTP server: hand the plugin a session id and record every turn it drives.
const prompts: { id: string; body: unknown; at: number }[] = [];
const oc = createHttpServer((req, res) => {
  if (req.headers.authorization !== auth) {
    res.writeHead(401).end();
    return;
  }
  let raw = "";
  req.setEncoding("utf8");
  req.on("data", (d) => (raw += d));
  req.on("end", () => {
    if (req.method === "POST" && req.url === "/session") {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ id: SID }));
      return;
    }
    if (req.method === "POST" && req.url === `/session/${SID}/prompt_async`) {
      prompts.push({ id: SID, body: raw ? JSON.parse(raw) : undefined, at: Date.now() });
      res.writeHead(204).end();
      return;
    }
    res.writeHead(404).end();
  });
});
oc.listen(0, "127.0.0.1");
await once(oc, "listening");
const ocPort = (oc.address() as { port: number }).port;

// The plugin reads its identity from COTAL_* env (it runs inside the opencode process). Scrub any
// managed-agent env inherited by this smoke itself; stale creds/links would point at the wrong broker.
for (const k of Object.keys(process.env)) if (k.startsWith("COTAL_")) delete process.env[k];
Object.assign(process.env, {
  COTAL_NAME: "Otto",
  COTAL_ID: "otto",
  COTAL_SPACE: space,
  COTAL_SERVERS: servers,
  COTAL_SUBSCRIBE: "team,quiet",
  COTAL_QUIET: "quiet",
  COTAL_ROLE: "generalist",
  COTAL_OPENCODE_SERVER_URL: `http://127.0.0.1:${ocPort}`,
  OPENCODE_SERVER_USERNAME: "opencode",
  OPENCODE_SERVER_PASSWORD: "test-secret",
});

// Fire one opencode bus event at the plugin's `event` hook.
type Hooks = Awaited<ReturnType<typeof bootPlugin>>;
const fire = (hooks: Hooks, event: unknown) => hooks.event!({ event } as never);
const chatMessage = (hooks: Hooks) =>
  (hooks as Hooks & {
    "chat.message"?: (input: { sessionID?: string; model?: { providerID: string; modelID: string }; variant?: string }, output: { parts?: { type: string; text?: string }[] }) => Promise<void>;
  })["chat.message"]!;

// A plain peer that posts ambient channel traffic at the agent.
const pub = new CotalEndpoint({ space, servers, card: { name: "Pubby", kind: "agent", id: "pubby" }, channels: ["team", "quiet"] });
pub.on("error", () => {});

// Poll until the plugin has driven `n` turns (push is event-driven + async).
const waitForPrompts = async (n: number, ms = 5000): Promise<void> => {
  for (let i = 0; i < ms / 100 && prompts.length < n; i++) await sleep(100);
};

function promptText(prompt: { body: unknown } | undefined): string {
  const body = prompt?.body as { parts?: { text?: string }[] } | undefined;
  return body?.parts?.map((p) => p.text ?? "").join("\n") ?? "";
}

let hooks: Hooks | undefined;
try {
  await awaitBrokerReady(() => isReachable(servers), { servers, attempts: 50, delayMs: 200 });
  await seedChannelRegistry({ servers, space, file: { defaults: { replay: false }, channels: { team: { replay: false }, quiet: { replay: false } } } });
  await pub.start();

  // Boot the plugin (it connects its mesh agent in the background and creates session SID).
  hooks = await bootPlugin();
  for (let i = 0; i < 50; i++) {
    if (pub.getRoster().some((p) => p.card.name === "Otto")) break;
    await sleep(100);
  }
  check("the opencode plugin came online (Otto live in the publisher roster)", pub.getRoster().some((p) => p.card.name === "Otto"));
  const otto = () => pub.getRoster().find((p) => p.card.name === "Otto");
  check("model is not invented before the first OpenCode prompt", otto()?.card.meta?.model === undefined, otto()?.card.meta);

  // (1) a live channel message drives a turn — baseline push works.
  await pub.multicast("hello team", { channel: "team" });
  await waitForPrompts(1);
  check("a channel message drives a turn (push works)", prompts.length === 1, prompts);

  // (2) complete the connector's turn (acks it, returns the session to idle).
  await fire(hooks, { type: "session.idle", properties: { sessionID: SID } });

  // (3) quiet channel traffic is buffered while idle. It neither drives prompt_async nor hitchhikes
  //     on a native human prompt.
  await pub.multicast("quiet buffered", { channel: "quiet" });
  await sleep(500);
  check("quiet channel traffic does not drive prompt_async", prompts.length === 1, prompts);
  const nativePrompt = { parts: [{ type: "text", text: "human native prompt" }] };
  await chatMessage(hooks)({
    sessionID: SID,
    model: { providerID: "openai", modelID: "gpt-5" },
    variant: "high",
  }, nativePrompt);
  check("quiet traffic does not inject into the next native prompt", nativePrompt.parts[0]?.text === "human native prompt", nativePrompt);
  for (let i = 0; i < 50 && otto()?.card.meta?.model !== "openai/gpt-5"; i++) await sleep(100);
  check("chat.message publishes OpenCode's observed provider/model", otto()?.card.meta?.model === "openai/gpt-5", otto()?.card.meta);
  check("chat.message publishes OpenCode's observed variant", otto()?.card.meta?.variant === "high", otto()?.card.meta);

  // A native/model failure still must not turn quiet traffic into an automatic retry payload.
  await fire(hooks, { type: "session.status", properties: { sessionID: SID, status: { type: "busy" } } });
  await fire(hooks, { type: "session.error", properties: { sessionID: SID } });
  check("failed native turn does not retry-drive prompt_async immediately", prompts.length === 1, prompts);
  const retryPrompt = { parts: [{ type: "text", text: "retry native prompt" }] };
  await chatMessage(hooks)({ sessionID: SID }, retryPrompt);
  check("quiet traffic does not hitchhike on a retry prompt", retryPrompt.parts[0]?.text === "retry native prompt", retryPrompt);

  // (5) finish the retried native turn; the injected batch is acked on this successful boundary.
  await fire(hooks, { type: "session.status", properties: { sessionID: SID, status: { type: "busy" } } });
  await fire(hooks, { type: "session.idle", properties: { sessionID: SID } });

  // (4) cotal_inbox is the explicit destructive pull for quiet ambient. Automatic traffic remains
  //     connector-owned, and a second pull does not repeat the cleared quiet item.
  const inboxExecute = (hooks.tool as Record<string, { execute: (...args: any[]) => Promise<string> }>).cotal_inbox!.execute;
  const pulled = await inboxExecute({}, {});
  check("cotal_inbox surfaces and clears quiet traffic", pulled.includes("quiet buffered"), pulled);
  const pulledAgain = await inboxExecute({}, {});
  check("a repeated cotal_inbox pull does not repeat cleared quiet traffic", !pulledAgain.includes("quiet buffered"), pulledAgain);

  // Receive-time automatic classification survives a later normal→quiet toggle while the item is
  // held behind a busy turn. The idle boundary must still drive it.
  const modeExecute = (hooks.tool as Record<string, { execute: (...args: any[]) => Promise<string> }>).cotal_channel_mode!.execute;
  await modeExecute({ channel: "quiet", mode: "normal" }, {});
  await fire(hooks, { type: "session.status", properties: { sessionID: SID, status: { type: "busy" } } });
  await pub.multicast("automatic before quiet toggle", { channel: "quiet" });
  await sleep(200);
  await modeExecute({ channel: "quiet", mode: "quiet" }, {});
  await fire(hooks, { type: "session.idle", properties: { sessionID: SID } });
  await waitForPrompts(2);
  check("normal→quiet does not strand an already-automatic item", prompts.length === 2 && promptText(prompts[1]).includes("automatic before quiet toggle"), prompts);
  await fire(hooks, { type: "session.idle", properties: { sessionID: SID } });

  // A directed DM auto-drives an unattended prompt_async. If that turn errors, the pending inbox id
  // is deduped and would not emit another `incoming`; the connector must schedule a delayed retry.
  // Address the peer by its principal (card.id = `<owner>.<actor>`), resolved from the roster the way
  // a real client does — the owner+actor flip made `unicast` reject a bare, non-principal recipient.
  const ottoId = pub.getRoster().find((p) => p.card.name === "Otto")?.card.id;
  if (!ottoId) throw new Error("turn-wedge: Otto not in roster for the directed-DM step");
  await pub.unicast(ottoId, "retry dm");
  await waitForPrompts(3);
  check("a directed DM auto-drives prompt_async", prompts.length === 3 && promptText(prompts[2]).includes("retry dm"), prompts);
  await fire(hooks, { type: "session.error", properties: { sessionID: SID } });
  await sleep(200);
  check("directed error retry is not immediate", prompts.length === 3, prompts);
  await waitForPrompts(4);
  check("directed DM retries after session.error", prompts.length === 4 && promptText(prompts[3]).includes("retry dm"), prompts);
  await fire(hooks, { type: "session.idle", properties: { sessionID: SID } });

  // A HUMAN turn with no Cotal batch still must clear busy (the original wedge trigger).
  await fire(hooks, { type: "session.status", properties: { sessionID: SID, status: { type: "busy" } } });
  await fire(hooks, { type: "session.idle", properties: { sessionID: SID } });

  // (6) a second channel message MUST still drive a turn. Pre-fix: `busy` is stuck true, so the
  //     incoming message is buffered and this never fires.
  await pub.multicast("still there?", { channel: "team" });
  await waitForPrompts(5);
  check("a channel message STILL drives after a human turn (no busy wedge)", prompts.length === 5, prompts);

  // (7) Explicit user Stop/Cancel is not a model/provider failure. Real OpenCode aborts can arrive as
  //     MessageAbortedError without a preceding TUI command event, so that error itself must dismiss/ack
  //     the surfaced Cotal batch instead of replaying it.
  await fire(hooks, {
    type: "session.error",
    properties: {
      sessionID: SID,
      error: { name: "MessageAbortedError", data: { message: "The operation was aborted" } },
    },
  });
  await sleep(1_200);
  check("explicit user interrupt does not retry-drive cancelled peer traffic", prompts.length === 5, prompts);
  await pub.multicast("after cancel", { channel: "team" });
  await waitForPrompts(6);
  check(
    "new peer traffic still drives after interrupt without replaying the cancelled batch",
    prompts.length === 6 && promptText(prompts[5]).includes("after cancel") && !promptText(prompts[5]).includes("still there?"),
    prompts,
  );

  // (8) Sustained failure: the error-retry backoff itself. Close the interrupt block's turn first
  //     so the delay starts at its initial value (`session.idle` -> completeTurn -> clearErrorRetry(true)).
  await fire(hooks, { type: "session.idle", properties: { sessionID: SID } });

  // Drive: a directed DM auto-drives prompt_async #7.
  const dmAt = Date.now();
  await pub.unicast(ottoId, "backoff dm");
  await waitForPrompts(7);
  check("the backoff DM auto-drives prompt_async", prompts.length === 7 && promptText(prompts[6]).includes("backoff dm"), prompts);

  // Failure 1: a failed turn (session.error, no `error` field) retries after the initial 1s delay.
  const errorOnce = async () => {
    await fire(hooks!, { type: "session.status", properties: { sessionID: SID, status: { type: "busy" } } });
    await fire(hooks!, { type: "session.error", properties: { sessionID: SID } });
  };
  let t0 = Date.now();
  await errorOnce();
  await waitForPrompts(8, 1_000 + 15_000);
  check(
    "retry:the delay doubles — failure 1 retries after >= 900ms (initial 1s)",
    prompts.length === 8 && prompts[7]!.at - t0 >= 900 && prompts[7]!.at - t0 <= 1_000 + 10_000,
    { delta: prompts[7]?.at !== undefined ? prompts[7]!.at - t0 : undefined },
  );

  // Failures 2 and 3: the delay doubles to >= 1800ms, then >= 3600ms.
  t0 = Date.now();
  await errorOnce();
  await waitForPrompts(9, 2_000 + 15_000);
  check(
    "retry:the delay doubles — failure 2 retries after >= 1800ms",
    prompts.length === 9 && prompts[8]!.at - t0 >= 1_800 && prompts[8]!.at - t0 <= 2_000 + 10_000,
    { delta: prompts[8]?.at !== undefined ? prompts[8]!.at - t0 : undefined },
  );
  t0 = Date.now();
  await errorOnce();
  await waitForPrompts(10, 4_000 + 15_000);
  check(
    "retry:the delay doubles — failure 3 retries after >= 3600ms",
    prompts.length === 10 && prompts[9]!.at - t0 >= 3_600 && prompts[9]!.at - t0 <= 4_000 + 10_000,
    { delta: prompts[9]?.at !== undefined ? prompts[9]!.at - t0 : undefined },
  );

  // One timer: firing the busy/error pair twice within one window arms exactly one timer, so
  // exactly one retry lands (at the next doubled delay, >= 7200ms), not two.
  t0 = Date.now();
  await errorOnce();
  await sleep(200);
  await errorOnce();
  await waitForPrompts(11, 8_000 + 15_000);
  check(
    "retry:one timer per window — exactly one retry lands after the doubled-again delay (>= 7200ms)",
    prompts.length === 11 && prompts[10]!.at - t0 >= 7_200 && prompts[10]!.at - t0 <= 8_000 + 10_000,
    { delta: prompts[10]?.at !== undefined ? prompts[10]!.at - t0 : undefined },
  );
  await sleep(2_500);
  check("retry:one timer per window — no extra retry lands 2.5s after the single retry", prompts.length === 11, prompts);

  // Failure 5: the delay keeps doubling (>= 14400ms, 16s).
  t0 = Date.now();
  await errorOnce();
  await waitForPrompts(12, 16_000 + 15_000);
  check(
    "retry:the delay keeps doubling — failure 5 retries after >= 14400ms (16s)",
    prompts.length === 12 && prompts[11]!.at - t0 >= 14_400 && prompts[11]!.at - t0 <= 16_000 + 10_000,
    { delta: prompts[11]?.at !== undefined ? prompts[11]!.at - t0 : undefined },
  );

  // Ceiling: failures 6 and 7 both retry after 30s (>= 27000 and <= 45000ms), so the delay stops
  // doubling; the upper bound is loose for a loaded host, so the first capped delay (30s against an
  // uncapped 32s) is not what separates them, the second is (30s against 64s, past the wait).
  // EACH OF THESE FAILURES IS FIRED ONLY AFTER A 60s MARK HAS PASSED BEHIND A RUNNING TURN, and
  // the reason is the inbox rather than the timer: this whole chain rides ONE directed DM that
  // stays un-acked until a turn completes, and the durable consumer redelivers an un-acked message
  // after its 60s ack wait. Fired at 31s, failure 6's window contained that redelivery: the prompt
  // in it arrived 60,004ms after the DM was sent, driven by the redelivered DM (correct behaviour)
  // and not by the timer, so a cell there read the inbox and called it the ceiling. A redelivery
  // that lands while a turn is running is buffered and drives nothing, so the turn is held open
  // across each 60s mark (with 10s of slack for a late pull) before the failure is fired; after it
  // the timer is the only thing that can submit the next prompt. `sinceDm` in the payload says
  // which one did.
  const holdUntil = async (sinceDmMs: number): Promise<void> => {
    const left = dmAt + sinceDmMs - Date.now();
    if (left > 0) await sleep(left);
  };
  await holdUntil(70_000);
  t0 = Date.now();
  await errorOnce();
  await waitForPrompts(13, 30_000 + 15_000);
  check(
    "retry:the ceiling holds — failure 6 retries after >= 27000ms and <= 45000ms (30s)",
    prompts.length === 13 && prompts[12]!.at - t0 >= 27_000 && prompts[12]!.at - t0 <= 45_000,
    { delta: prompts[12]?.at !== undefined ? prompts[12]!.at - t0 : undefined, sinceDm: prompts[12]?.at !== undefined ? prompts[12]!.at - dmAt : undefined },
  );
  await holdUntil(130_000);
  t0 = Date.now();
  await errorOnce();
  await waitForPrompts(14, 30_000 + 15_000);
  check(
    "retry:the ceiling holds — failure 7 retries after >= 27000ms and <= 45000ms (still 30s; unbounded doubling would land at 64s)",
    prompts.length === 14 && prompts[13]!.at - t0 >= 27_000 && prompts[13]!.at - t0 <= 45_000,
    { delta: prompts[13]?.at !== undefined ? prompts[13]!.at - t0 : undefined, sinceDm: prompts[13]?.at !== undefined ? prompts[13]!.at - dmAt : undefined },
  );

  // Reset: the retried turn completes (session.idle -> completeTurn resets the delay). A fresh
  // directed DM then a single failure retries fast again (>= 900ms and < 8000ms; a delay still at
  // the ceiling would land after ~27s). Completing the turn also acks the chain's DM, so no
  // further redelivery of it can land.
  await fire(hooks, { type: "session.idle", properties: { sessionID: SID } });
  await pub.unicast(ottoId, "reset dm");
  await waitForPrompts(15);
  check("retry:recovery resets the delay — the reset DM auto-drives prompt_async #15", prompts.length === 15 && promptText(prompts[14]).includes("reset dm"), prompts);
  t0 = Date.now();
  await errorOnce();
  await waitForPrompts(16, 1_000 + 15_000);
  check(
    "retry:recovery resets the delay — post-recovery retry lands after >= 900ms and < 8000ms",
    prompts.length === 16 && prompts[15]!.at - t0 >= 900 && prompts[15]!.at - t0 < 8_000,
    { delta: prompts[15]?.at !== undefined ? prompts[15]!.at - t0 : undefined },
  );

  // Stop: a retry is now pending (delay back at 2s after this failure). A cooperative stop landing
  // while it is pending must cancel the timer and submit nothing — two guards hold this: the timer
  // clear in dispose's teardown (line 624) and the `stopping` refusal in `drive` (line 900), so no
  // single-site mutant reds this cell; it is asserted here rather than proved by mutation.
  await errorOnce();
  const beforeStop = prompts.length;
  await hooks.dispose();
  hooks = undefined;
  await sleep(4_000);
  check("retry:a stop submits nothing — a pending retry does not submit after dispose()", prompts.length === beforeStop, prompts);

  console.log(`\nOPENCODE TURN-WEDGE TEST PASSED ✅  (${pass} checks)`);
} finally {
  await hooks?.dispose?.();
  await pub.stop();
  srv.kill("SIGKILL");
  oc.close();
  await sleep(150);
  rmSync(dir, { recursive: true, force: true });
  releaseBroker(); // last: ownership is held until this teardown has actually finished
}
process.exit(0);
