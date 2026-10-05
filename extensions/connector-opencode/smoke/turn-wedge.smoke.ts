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
 *   5a. a focus @mention wake is re-armed after its turn fails, and NOT re-driven after a user
 *       interrupt of that wake's turn (#715);
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
import { mkdtempSync, rmSync } from "node:fs";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CotalEndpoint, seedChannelRegistry, isReachable, unicastSubject, parsePrincipalKey } from "@cotal-ai/core";
import { configFromEnv, cotalToolSpecs } from "@cotal-ai/connector-core";
import { connect as rawConnect } from "@nats-io/transport-node";
import { bootPlugin, bootPlugin2, fakeOpenCode2Context, disposeInProcess } from "./_boot-plugin.js";
import { SMOKE_BROKER_TOKEN, awaitBrokerReady, freePort, teardownOnSignal } from "@cotal-ai/smoke-kit";

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

  // A focus @mention wake is re-armed when the turn fails after the submission landed (#715).
  // The wake body is acked-and-dropped at ingest, so nothing but the driven nudge itself carries
  // it; a landed submission that then fails must re-park that nudge or the seat is never retried.
  const statusExecute = (hooks.tool as Record<string, { execute: (...args: any[]) => Promise<string> }>).cotal_status!.execute;
  await statusExecute({ attention: "focus" }, {});
  await pub.multicast("@Otto look at this", { channel: "team", mentions: ["Otto"] });
  await waitForPrompts(5);
  check(
    "a focus @mention wake is re-armed when the turn fails after the submission landed (#715)",
    prompts.length === 5 && promptText(prompts[4]).includes("You were mentioned by"),
    prompts[4],
  );
  await fire(hooks, { type: "session.error", properties: { sessionID: SID } });
  await sleep(2_500);
  check(
    "…and the retry after the backoff carries the nudge again",
    prompts.length === 6 && promptText(prompts[5]).includes("You were mentioned by"),
    prompts.slice(4),
  );
  await fire(hooks, { type: "session.idle", properties: { sessionID: SID } });

  // A user interrupt after a wake does NOT re-drive it: an explicit Stop is a turn someone ENDED,
  // not one that failed, so the nudge is dismissed the same way the surfaced batch is (ackSurfaced),
  // never re-armed the way a genuine failure re-arms it above.
  await pub.multicast("@Otto second look", { channel: "team", mentions: ["Otto"] });
  await waitForPrompts(7);
  check("a second focus mention drives its own turn", prompts.length === 7 && promptText(prompts[6]).includes("You were mentioned by"), prompts[6]);
  await fire(hooks, {
    type: "session.error",
    properties: { sessionID: SID, error: { name: "MessageAbortedError", data: { message: "The operation was aborted" } } },
  });
  await sleep(2_500);
  check("a user interrupt after a wake does not re-drive it", prompts.length === 7, prompts);
  await fire(hooks, { type: "session.idle", properties: { sessionID: SID } });
  await statusExecute({ attention: "open" }, {});

  // A HUMAN turn with no Cotal batch still must clear busy (the original wedge trigger).
  await fire(hooks, { type: "session.status", properties: { sessionID: SID, status: { type: "busy" } } });
  await fire(hooks, { type: "session.idle", properties: { sessionID: SID } });

  // (6) a second channel message MUST still drive a turn. Pre-fix: `busy` is stuck true, so the
  //     incoming message is buffered and this never fires.
  await pub.multicast("still there?", { channel: "team" });
  await waitForPrompts(8);
  check("a channel message STILL drives after a human turn (no busy wedge)", prompts.length === 8, prompts);

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
  check("explicit user interrupt does not retry-drive cancelled peer traffic", prompts.length === 8, prompts);
  await pub.multicast("after cancel", { channel: "team" });
  await waitForPrompts(9);
  check(
    "new peer traffic still drives after interrupt without replaying the cancelled batch",
    prompts.length === 9 && promptText(prompts[8]).includes("after cancel") && !promptText(prompts[8]).includes("still there?"),
    prompts,
  );

  // (8) Sustained failure: the error-retry backoff itself. Close the interrupt block's turn first
  //     so the delay starts at its initial value (`session.idle` -> completeTurn -> clearErrorRetry(true)).
  await fire(hooks, { type: "session.idle", properties: { sessionID: SID } });

  // Drive: a directed DM auto-drives prompt_async #7.
  const dmAt = Date.now();
  await pub.unicast(ottoId, "backoff dm");
  await waitForPrompts(10);
  check("the backoff DM auto-drives prompt_async", prompts.length === 10 && promptText(prompts[9]).includes("backoff dm"), prompts);

  // Failure 1: a failed turn (session.error, no `error` field) retries after the initial 1s delay.
  const errorOnce = async () => {
    await fire(hooks!, { type: "session.status", properties: { sessionID: SID, status: { type: "busy" } } });
    await fire(hooks!, { type: "session.error", properties: { sessionID: SID } });
  };
  let t0 = Date.now();
  await errorOnce();
  await waitForPrompts(11, 1_000 + 15_000);
  check(
    "retry:the delay doubles — failure 1 retries after >= 900ms (initial 1s)",
    prompts.length === 11 && prompts[10]!.at - t0 >= 900 && prompts[10]!.at - t0 <= 1_000 + 10_000,
    { delta: prompts[10]?.at !== undefined ? prompts[10]!.at - t0 : undefined },
  );

  // Failures 2 and 3: the delay doubles to >= 1800ms, then >= 3600ms.
  t0 = Date.now();
  await errorOnce();
  await waitForPrompts(12, 2_000 + 15_000);
  check(
    "retry:the delay doubles — failure 2 retries after >= 1800ms",
    prompts.length === 12 && prompts[11]!.at - t0 >= 1_800 && prompts[11]!.at - t0 <= 2_000 + 10_000,
    { delta: prompts[11]?.at !== undefined ? prompts[11]!.at - t0 : undefined },
  );
  t0 = Date.now();
  await errorOnce();
  await waitForPrompts(13, 4_000 + 15_000);
  check(
    "retry:the delay doubles — failure 3 retries after >= 3600ms",
    prompts.length === 13 && prompts[12]!.at - t0 >= 3_600 && prompts[12]!.at - t0 <= 4_000 + 10_000,
    { delta: prompts[12]?.at !== undefined ? prompts[12]!.at - t0 : undefined },
  );

  // One timer: firing the busy/error pair twice within one window arms exactly one timer, so
  // exactly one retry lands (at the next doubled delay, >= 7200ms), not two.
  t0 = Date.now();
  await errorOnce();
  await sleep(200);
  await errorOnce();
  await waitForPrompts(14, 8_000 + 15_000);
  check(
    "retry:one timer per window — exactly one retry lands after the doubled-again delay (>= 7200ms)",
    prompts.length === 14 && prompts[13]!.at - t0 >= 7_200 && prompts[13]!.at - t0 <= 8_000 + 10_000,
    { delta: prompts[13]?.at !== undefined ? prompts[13]!.at - t0 : undefined },
  );
  await sleep(2_500);
  check("retry:one timer per window — no extra retry lands 2.5s after the single retry", prompts.length === 14, prompts);

  // Failure 5: the delay keeps doubling (>= 14400ms, 16s).
  t0 = Date.now();
  await errorOnce();
  await waitForPrompts(15, 16_000 + 15_000);
  check(
    "retry:the delay keeps doubling — failure 5 retries after >= 14400ms (16s)",
    prompts.length === 15 && prompts[14]!.at - t0 >= 14_400 && prompts[14]!.at - t0 <= 16_000 + 10_000,
    { delta: prompts[14]?.at !== undefined ? prompts[14]!.at - t0 : undefined },
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
  await waitForPrompts(16, 30_000 + 15_000);
  check(
    "retry:the ceiling holds — failure 6 retries after >= 27000ms and <= 45000ms (30s)",
    prompts.length === 16 && prompts[15]!.at - t0 >= 27_000 && prompts[15]!.at - t0 <= 45_000,
    { delta: prompts[15]?.at !== undefined ? prompts[15]!.at - t0 : undefined, sinceDm: prompts[15]?.at !== undefined ? prompts[15]!.at - dmAt : undefined },
  );
  await holdUntil(130_000);
  t0 = Date.now();
  await errorOnce();
  await waitForPrompts(17, 30_000 + 15_000);
  check(
    "retry:the ceiling holds — failure 7 retries after >= 27000ms and <= 45000ms (still 30s; unbounded doubling would land at 64s)",
    prompts.length === 17 && prompts[16]!.at - t0 >= 27_000 && prompts[16]!.at - t0 <= 45_000,
    { delta: prompts[16]?.at !== undefined ? prompts[16]!.at - t0 : undefined, sinceDm: prompts[16]?.at !== undefined ? prompts[16]!.at - dmAt : undefined },
  );

  // Reset: the retried turn completes (session.idle -> completeTurn resets the delay). A fresh
  // directed DM then a single failure retries fast again (>= 900ms and < 8000ms; a delay still at
  // the ceiling would land after ~27s). Completing the turn also acks the chain's DM, so no
  // further redelivery of it can land.
  await fire(hooks, { type: "session.idle", properties: { sessionID: SID } });
  await pub.unicast(ottoId, "reset dm");
  await waitForPrompts(18);
  check("retry:recovery resets the delay — the reset DM auto-drives prompt_async #15", prompts.length === 18 && promptText(prompts[17]).includes("reset dm"), prompts);
  t0 = Date.now();
  await errorOnce();
  await waitForPrompts(19, 1_000 + 15_000);
  check(
    "retry:recovery resets the delay — post-recovery retry lands after >= 900ms and < 8000ms",
    prompts.length === 19 && prompts[18]!.at - t0 >= 900 && prompts[18]!.at - t0 < 8_000,
    { delta: prompts[18]?.at !== undefined ? prompts[18]!.at - t0 : undefined },
  );

  // (9) #674: two raw DMs with EMPTY wire ids, pending at one human prompt boundary, ride ONE
  // frame and commit with it. The first-party APIs mint an id per message, so an empty id can
  // only come off the wire from a raw client — the foreign shape `empty-id-ingest` drives at the
  // MeshAgent layer; here it meets the ADAPTER seam. `injectIntoPrompt` peeks the whole automatic
  // inbox and prefixes one text part, so both texts must land in that one prefix, and the
  // boundary ack addresses each id-less delivery by its RECEIVE key — under the ledger-keyed-by-id
  // mutation the ack drains "" instead, nothing commits, and the very next drive re-carries both.
  const enc = new TextEncoder();
  const rawNc = await rawConnect({ servers, maxReconnectAttempts: 0 });
  try {
    const ottoId = pub.getRoster().find((p) => p.card.name === "Otto")?.card.id;
    if (!ottoId) throw new Error("turn-wedge: Otto not in roster for the empty-id step");
    const parsed = parsePrincipalKey(ottoId) as { owner: string; actor: string };
    const emptyIdDm = (text: string): void =>
      rawNc.publish(
        unicastSubject(space, parsed.owner, parsed.actor, "local", "rawpub"),
        enc.encode(
          JSON.stringify({
            id: "",
            ts: Date.now(),
            space,
            from: { id: "local.rawpub", name: "RawPub", kind: "agent" },
            to: ottoId,
            parts: [{ kind: "text", text }],
          }),
        ),
      );
    // Settle the retry chain's leftover open turn first (its idle acks the recovery DM's batch
    // with nothing pending, so no drive fires), then hold `busy` across the publish window: the
    // incoming handler buffers while busy, so the pair cannot drive its own prompt_async. The
    // human prompt that follows is the one frame that carries both — `injectIntoPrompt` is gated
    // on driving/awaitingTurnEnd, not on busy.
    await fire(hooks, { type: "session.idle", properties: { sessionID: SID } });
    await sleep(300);
    await fire(hooks, { type: "session.status", properties: { sessionID: SID, status: { type: "busy" } } });
    emptyIdDm("oc-empty-a");
    emptyIdDm("oc-empty-b");
    await rawNc.flush();
    await sleep(700); // ingest + the busy window (busy buffers; nothing drives while it holds)
    const emptyPrompt = { parts: [{ type: "text", text: "human empty-id frame" }] };
    await chatMessage(hooks)({ sessionID: SID }, emptyPrompt);
    check(
      "two empty-id DMs in one frame both commit (#674)",
      emptyPrompt.parts[0]?.text.includes("oc-empty-a") === true &&
        emptyPrompt.parts[0]?.text.includes("oc-empty-b") === true,
      emptyPrompt,
    );
    // The completed human turn is the ack boundary: fire it and prove nothing re-carries. A
    // mutant's ack addressed "" (twice), so the next drive re-injects both texts.
    await fire(hooks, { type: "session.idle", properties: { sessionID: SID } });
    await sleep(700); // let a mutant's un-acked re-drive land; a healthy host stays idle
    const afterEmpty = prompts.slice(-3).map((p) => promptText(p));
    check(
      "the empty-id frame was committed at its boundary (neither text returns)",
      afterEmpty.every((t) => !t.includes("oc-empty-a") && !t.includes("oc-empty-b")),
      afterEmpty,
    );
    // And the drive() ledger at the same seam: one raw empty-id DM against the now-idle plugin
    // drives its own prompt_async (ids = items.map((i) => i.recvKey) in drive), and its turn
    // boundary acks by receive key — under the drive-ledger mutation the ack drains "" and the
    // completion pump re-drives the message in a hot loop of identical prompts.
    const driveBefore = prompts.length;
    emptyIdDm("oc-empty-drive");
    await rawNc.flush();
    for (let i = 0; i < 50 && prompts.length === driveBefore; i++) await sleep(100);
    check("an empty-id DM drives prompt_async", prompts.length === driveBefore + 1 && promptText(prompts.at(-1)).includes("oc-empty-drive"), prompts.length);
    await fire(hooks, { type: "session.idle", properties: { sessionID: SID } });
    await sleep(700); // let a mutant's un-acked re-drive loop land; a healthy plugin stays idle
    check(
      "the driven empty-id DM committed at its boundary (exactly one prompt carries it)",
      prompts.filter((p) => promptText(p).includes("oc-empty-drive")).length === 1,
      prompts.filter((p) => promptText(p).includes("oc-empty-drive")).length,
    );
  } finally {
    await rawNc.close();
  }

  // Stop: a retry is now pending (delay back at 2s after this failure). A cooperative stop landing
  // while it is pending must cancel the timer and submit nothing — two guards hold this: the timer
  // clear in dispose's teardown (line 624) and the `stopping` refusal in `drive` (line 900), so no
  // single-site mutant reds this cell; it is asserted here rather than proved by mutation.
  await errorOnce();
  const beforeStop = prompts.length;
  await disposeInProcess(hooks);
  hooks = undefined;
  await sleep(4_000);
  check("retry:a stop submits nothing — a pending retry does not submit after dispose()", prompts.length === beforeStop, prompts);
} finally {
  await disposeInProcess(hooks);
  await pub.stop();
  srv.kill("SIGKILL");
  oc.close();
  await sleep(150);
  rmSync(dir, { recursive: true, force: true });
  releaseBroker(); // last: ownership is held until this teardown has actually finished
}

// ── 2.x adapter: setupCotal driven with a fake OpenCode 2.x context, against a fake server on the
//    `/api` routes plugin2.ts actually calls (`{data:...}`-wrapped, no `prompt_async`). No real
//    `opencode` binary, no `@opencode/plugin` package — the fake context IS the whole 2.x host
//    surface this adapter reads (opencode2-types.ts).
{
  const PORT2 = await freePort();
  const servers2 = `nats://127.0.0.1:${PORT2}`;
  const space2 = "ocwedge2";
  const SID2 = "ses_test2";
  const dir2 = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
  const srv2 = spawn("nats-server", ["-js", "-p", String(PORT2), "-sd", join(dir2, "js")], { stdio: "ignore" });
  const releaseBroker2 = teardownOnSignal(srv2, dir2);
  const auth2 = `Basic ${Buffer.from("opencode:test-secret-2").toString("base64")}`;
  const prompts2: { body: { text?: string } }[] = [];
  let modelListing: Array<{ providerID: string; modelID: string }> = [];
  let modelReads = 0;

  const oc2 = createHttpServer((req, res) => {
    if (req.headers.authorization !== auth2) {
      res.writeHead(401).end();
      return;
    }
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", (d) => (raw += d));
    req.on("end", () => {
      if (req.method === "POST" && req.url === "/api/session") {
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data: { id: SID2 } }));
        return;
      }
      if (req.method === "GET" && req.url === "/api/model") {
        modelReads++;
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data: modelListing }));
        return;
      }
      if (req.method === "POST" && req.url === `/api/session/${SID2}/prompt`) {
        prompts2.push({ body: raw ? JSON.parse(raw) : {} });
        res.writeHead(204).end();
        return;
      }
      res.writeHead(404).end();
    });
  });
  oc2.listen(0, "127.0.0.1");
  await once(oc2, "listening");
  const ocPort2 = (oc2.address() as { port: number }).port;

  for (const k of Object.keys(process.env)) if (k.startsWith("COTAL_")) delete process.env[k];
  Object.assign(process.env, {
    COTAL_NAME: "Otto2",
    COTAL_ID: "otto2",
    COTAL_SPACE: space2,
    COTAL_SERVERS: servers2,
    COTAL_SUBSCRIBE: "team,quiet",
    COTAL_QUIET: "quiet",
    COTAL_ROLE: "generalist",
    COTAL_OPENCODE_SERVER_URL: `http://127.0.0.1:${ocPort2}`,
    OPENCODE_SERVER_USERNAME: "opencode",
    OPENCODE_SERVER_PASSWORD: "test-secret-2",
  });
  delete (globalThis as { __cotalOpencodeSetup?: boolean }).__cotalOpencodeSetup;

  const pub2 = new CotalEndpoint({ space: space2, servers: servers2, card: { name: "Pubby2", kind: "agent", id: "pubby2" }, channels: ["team", "quiet"] });
  pub2.on("error", () => {});
  let originalStderrWrite2: typeof process.stderr.write | undefined;
  let sessionLine = "";
  let dispose2: (() => Promise<void>) | void = undefined;
  try {
    await awaitBrokerReady(() => isReachable(servers2), { servers: servers2, attempts: 50, delayMs: 200 });
    await seedChannelRegistry({ servers: servers2, space: space2, file: { defaults: { replay: false }, channels: { team: { replay: false }, quiet: { replay: false } } } });
    await pub2.start();

    // 2.x model check: `GET /api/model` (not 1.x's `/provider`) must refuse before join when the
    // configured model is not in the server's list — parity with 1.x's catalog/server mismatch
    // cell. The listing below names the provider but not the model, so the check must throw
    // before any session is created without waiting on the settle loop.
    modelListing = [{ providerID: "prov", modelID: "other" }];
    process.env.COTAL_MODEL = "prov/absent-model";
    process.env.COTAL_NAME = "ModelReadiness2";
    process.env.COTAL_ID = "modelreadiness2";
    let modelRefusal2 = "";
    let exitCode2: number | undefined;
    const originalExit2 = process.exit;
    const originalStderrWriteMR = process.stderr.write;
    process.exit = ((code?: number) => {
      exitCode2 = code;
    }) as typeof process.exit;
    process.stderr.write = ((chunk: string | Uint8Array, ...args: unknown[]) => {
      const line = String(chunk);
      if (line.includes("prov/absent-model")) modelRefusal2 = line;
      return originalStderrWriteMR.call(process.stderr, chunk, ...(args as [BufferEncoding, (error?: Error | null) => void]));
    }) as typeof process.stderr.write;
    delete (globalThis as { __cotalOpencodeSetup?: boolean }).__cotalOpencodeSetup;
    const ctxMR = fakeOpenCode2Context();
    const disposeMR = await bootPlugin2(ctxMR);
    for (let i = 0; i < 30 && exitCode2 === undefined; i++) await sleep(100);
    process.exit = originalExit2;
    process.stderr.write = originalStderrWriteMR;
    check(
      "2.x: an unlisted model refuses before join (GET /api/model, empty list)",
      exitCode2 === 1 &&
        !pub2.getRoster().some((p) => p.card.name === "ModelReadiness2") &&
        modelRefusal2.includes("prov/absent-model") &&
        modelRefusal2.includes("GET /api/model does not list it"),
      { exitCode2, modelRefusal2 },
    );
    await disposeMR?.();
    delete process.env.COTAL_MODEL;

    // 2.x model check: the server's listing is empty for a while after boot (measured race,
    // fx105/brief-g.md), so an empty listing is waited on rather than refused immediately.
    modelReads = 0;
    modelListing = [];
    process.env.COTAL_MODEL = "prov/m";
    process.env.COTAL_NAME = "ModelWait2";
    process.env.COTAL_ID = "modelwait2";
    let refusalLineWait = "";
    let exitCodeWait: number | undefined;
    const originalExitWait = process.exit;
    const originalStderrWriteWait = process.stderr.write;
    process.exit = ((code?: number) => {
      exitCodeWait = code;
    }) as typeof process.exit;
    process.stderr.write = ((chunk: string | Uint8Array, ...args: unknown[]) => {
      const line = String(chunk);
      if (line.includes("Refusing before join")) refusalLineWait = line;
      return originalStderrWriteWait.call(process.stderr, chunk, ...(args as [BufferEncoding, (error?: Error | null) => void]));
    }) as typeof process.stderr.write;
    delete (globalThis as { __cotalOpencodeSetup?: boolean }).__cotalOpencodeSetup;
    const ctxWait = fakeOpenCode2Context();
    const disposeWait = await bootPlugin2(ctxWait);
    setTimeout(() => {
      modelListing = [{ providerID: "prov", modelID: "m" }];
    }, 500);
    let waitOnline = false;
    for (let i = 0; i < 100; i++) {
      if (pub2.getRoster().some((p) => p.card.name === "ModelWait2")) {
        waitOnline = true;
        break;
      }
      await sleep(100);
    }
    process.exit = originalExitWait;
    process.stderr.write = originalStderrWriteWait;
    check(
      "2.x: an empty listing is waited on, and the model check passes once the server lists it",
      waitOnline && modelReads >= 2 && exitCodeWait === undefined && !refusalLineWait.includes("Refusing before join"),
      { waitOnline, modelReads, exitCodeWait, refusalLineWait },
    );
    await disposeWait?.();
    delete process.env.COTAL_MODEL;

    // 2.x model check: a listing still empty at the settle deadline is a real refusal, not a hang.
    modelListing = [];
    process.env.COTAL_MODEL = "prov/m";
    process.env.COTAL_MODEL_LIST_SETTLE_MS = "700";
    process.env.COTAL_NAME = "ModelDeadline2";
    process.env.COTAL_ID = "modeldeadline2";
    let modelRefusalDeadline = "";
    let exitCodeDeadline: number | undefined;
    const originalExitDeadline = process.exit;
    const originalStderrWriteDeadline = process.stderr.write;
    process.exit = ((code?: number) => {
      exitCodeDeadline = code;
    }) as typeof process.exit;
    process.stderr.write = ((chunk: string | Uint8Array, ...args: unknown[]) => {
      const line = String(chunk);
      if (line.includes("prov/")) modelRefusalDeadline = line;
      return originalStderrWriteDeadline.call(process.stderr, chunk, ...(args as [BufferEncoding, (error?: Error | null) => void]));
    }) as typeof process.stderr.write;
    delete (globalThis as { __cotalOpencodeSetup?: boolean }).__cotalOpencodeSetup;
    const ctxDeadline = fakeOpenCode2Context();
    const disposeDeadline = await bootPlugin2(ctxDeadline);
    for (let i = 0; i < 30 && exitCodeDeadline === undefined; i++) await sleep(100);
    process.exit = originalExitDeadline;
    process.stderr.write = originalStderrWriteDeadline;
    check(
      "2.x: a listing still empty at the deadline refuses, naming the wait",
      exitCodeDeadline === 1 &&
        modelRefusalDeadline.includes("prov/") &&
        modelRefusalDeadline.includes("listed no provider within"),
      { exitCodeDeadline, modelRefusalDeadline },
    );
    await disposeDeadline?.();
    delete process.env.COTAL_MODEL;
    delete process.env.COTAL_MODEL_LIST_SETTLE_MS;

    modelListing = [{ providerID: "dead", modelID: "m" }];
    process.env.COTAL_NAME = "Otto2";
    process.env.COTAL_ID = "otto2";
    delete (globalThis as { __cotalOpencodeSetup?: boolean }).__cotalOpencodeSetup;

    const ctx2 = fakeOpenCode2Context();
    originalStderrWrite2 = process.stderr.write;
    process.stderr.write = ((chunk: string | Uint8Array, ...args: unknown[]) => {
      const line = String(chunk);
      if (line.includes("[cotal-session]")) sessionLine = line;
      return originalStderrWrite2!.call(process.stderr, chunk, ...(args as [BufferEncoding, (error?: Error | null) => void]));
    }) as typeof process.stderr.write;
    dispose2 = await bootPlugin2(ctx2);

    for (let i = 0; i < 50; i++) {
      if (sessionLine) break;
      await sleep(100);
    }
    check("2.x: the session id is printed as [cotal-session]", sessionLine.includes(SID2), sessionLine);

    for (let i = 0; i < 50; i++) {
      if (pub2.getRoster().some((p) => p.card.name === "Otto2")) break;
      await sleep(100);
    }
    const otto2Id = pub2.getRoster().find((p) => p.card.name === "Otto2")?.card.id;
    check("2.x: the adapter came online (Otto2 live in the publisher roster)", !!otto2Id, otto2Id);

    await pub2.unicast(otto2Id!, "hello via 2.x");
    for (let i = 0; i < 50 && prompts2.length < 1; i++) await sleep(100);
    check("2.x: one DM drives exactly one prompt POST with text", prompts2.length === 1 && prompts2[0]?.body.text?.includes("hello via 2.x") === true, prompts2);

    ctx2.feed({ type: "session.execution.succeeded", data: { sessionID: SID2 } });
    await sleep(300);
    await pub2.unicast(otto2Id!, "second turn via 2.x");
    for (let i = 0; i < 50 && prompts2.length < 2; i++) await sleep(100);
    check(
      "2.x: session.execution.succeeded ends the turn (a later DM drives a second prompt)",
      prompts2.length === 2 && prompts2[1]?.body.text?.includes("second turn via 2.x") === true,
      prompts2,
    );

    const names1x = cotalToolSpecs(configFromEnv(), "opencode").map((s) => s.name).sort();
    const names2x = ctx2.addedTools.map((t) => t.name).sort();
    check("2.x: the registered tool set equals the 1.x tool names", JSON.stringify(names1x) === JSON.stringify(names2x), { names1x, names2x });

    const statusTool = ctx2.addedTools.find((t) => t.name === "cotal_status");
    const out2 = statusTool ? String((await statusTool.execute({ text: "x", owner: "u_attacker" })).content) : "threw: no cotal_status tool";
    check("2.x: a {text, owner} call to a registered tool's execute is refused by name", out2.startsWith("⚠") && out2.includes("owner"), out2);
  } finally {
    if (originalStderrWrite2) process.stderr.write = originalStderrWrite2;
    await dispose2?.();
    await pub2.stop();
    srv2.kill("SIGKILL");
    oc2.close();
    await sleep(150);
    rmSync(dir2, { recursive: true, force: true });
    releaseBroker2();
  }
}

console.log(`\nOPENCODE TURN-WEDGE TEST PASSED ✅  (${pass} checks)`);
process.exit(0);
