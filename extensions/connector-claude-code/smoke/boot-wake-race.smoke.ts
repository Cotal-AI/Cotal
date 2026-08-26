/**
 * The #226 boot lost-wake race, end-to-end over a real broker (no test runner, no `claude`).
 *
 * The reported defect: a session spawned with a peer message ALREADY pending in its durable
 * consumer went permanently deaf. The message arrived (and emitted its one `incoming`) within ms of
 * the durable bind — before the MCP handshake flipped `channelActive`, and in `mcp.ts` even before
 * `createWakePolicy` registers the `incoming` listener at all — so the wake was dropped on the
 * floor. Nothing else fires at an idle session, so the DM sat buffered and unacked forever.
 *
 * This drives the SHIPPED wake policy (`createWakePolicy`) against a SHIPPED `MeshAgent` bound to a
 * real nats-server, in `mcp.ts`'s own order:
 *
 *   agent.start()  →  peer DM lands and buffers  →  createWakePolicy()  →  setChannelActive(true)
 *
 * and then does NOTHING: no hook, no turn, no further traffic. Whatever wakes the session has to
 * come from the connector's own machinery.
 *
 * IT PINS BOTH HALVES, because a single "did it wake" check conflates them and would stay green
 * for the wrong reason:
 *   A. the race window is REAL — activation itself reconciles nothing. The connector has no
 *      post-handshake `pendingWake()` check and no idle reconciler, and its nudge retry is
 *      unreachable here (armed only from a rejected push, which cannot happen while `nudge` returns
 *      early on an inactive channel). Asserted, so that a future reconcile added on this side is a
 *      deliberate change rather than a silent one.
 *   B. so the recovery comes from ingest re-announcing the still-pending item when JetStream
 *      redelivers it — the one line this cell exists to hold down. Delete it and the session is
 *      deaf with the message buffered and un-acked, which is the original report verbatim.
 *
 * The ingest half of that guard is `smoke:cross-path-dedup`, which drives the dedup branch with
 * hand-built deliveries. This is the end-to-end half: a real broker, a real durable consumer, and
 * the connector's real boot ordering.
 *
 * Run: pnpm smoke:claude-boot-wake
 * Graded: node scripts/mutation-proof.mjs --config extensions/connector-claude-code/smoke/mutations/boot-wake-race.json
 */
import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { createServer as createNetServer } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CotalEndpoint, seedChannelRegistry, isReachable } from "@cotal-ai/core";
import { MeshAgent, type InboxItem } from "@cotal-ai/connector-core";
import { createWakePolicy } from "../src/hooks.js";
import { SMOKE_BROKER_TOKEN, teardownOnSignal } from "@cotal-ai/smoke-kit";

async function freePort(): Promise<number> {
  const srv = createNetServer();
  srv.listen(0, "127.0.0.1");
  await once(srv, "listening");
  const port = (srv.address() as { port: number }).port;
  await new Promise<void>((r) => srv.close(() => r()));
  return port;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const PORT = await freePort();
const servers = `nats://127.0.0.1:${PORT}`;
const space = "ccboot";
/** Short so a redelivery-driven recovery is observable in seconds rather than a minute. */
const ACK_WAIT_MS = 6_000;
/**
 * How long we sit still after activation before calling the session deaf. Generous relative to
 * ACK_WAIT_MS so a recovery that exists cannot be missed by an unlucky consumer tick — a false
 * "deaf" here would be a false bug report.
 */
const DEAF_VERDICT_MS = ACK_WAIT_MS * 3;
/** A settle window after `setChannelActive(true)`: long enough that a synchronous or
 *  next-tick reconcile at activation would have shown up, far too short for any redelivery. */
const ACTIVATION_SETTLE_MS = 500;

const dir = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
const srv = spawn("nats-server", ["-js", "-p", String(PORT), "-sd", join(dir, "js")], { stdio: "ignore" });
const releaseBroker = teardownOnSignal(srv, dir);

let pass = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  assert.ok(cond, `${name}${extra !== undefined ? ` — ${JSON.stringify(extra)}` : ""}`);
  pass++;
  console.log(`  ✓ ${name}`);
};

// ---- the session under test, and a peer to wake it -------------------------------------------
const agent = new MeshAgent({
  space,
  name: "Wanda",
  id: "wanda",
  kind: "agent",
  role: "generalist",
  servers,
  subscribe: ["team"],
  allowSubscribe: ["team"],
  allowPublish: ["team"],
  tls: false,
  ackWaitMs: ACK_WAIT_MS,
});
agent.on("error", () => {});

const pub = new CotalEndpoint({ space, servers, card: { name: "Pubby", kind: "agent", id: "pubby" }, channels: ["team"] });
pub.on("error", () => {});

const waitFor = async (what: string, cond: () => boolean, ms = 8_000): Promise<void> => {
  for (let i = 0; i < ms / 100 && !cond(); i++) await sleep(100);
  if (!cond()) throw new Error(`timed out waiting for ${what}`);
};
const stillPending = (text: string): boolean => agent.peekInbox("all").some((i: InboxItem) => i.text.includes(text));

try {
  for (let i = 0; i < 50; i++) { if (await isReachable(servers)) break; await sleep(200); }
  await seedChannelRegistry({ servers, space, file: { defaults: { replay: false }, channels: { team: { replay: false } } } });
  await pub.start();
  agent.start();
  await waitFor("Wanda to join the roster", () => pub.getRoster().some((p) => p.card.name === "Wanda"));
  const wandaId = pub.getRoster().find((p) => p.card.name === "Wanda")!.card.id;

  // ---- the boot window: a DM lands before the connector has a wake path at all -----------------
  // `mcp.ts` calls `agent.start()` long before `createWakePolicy`, so the boot `incoming` for this
  // DM has no listener whatsoever — strictly worse than a nudge that no-ops on an inactive channel,
  // and exactly what a spawn-with-a-message-already-queued produces.
  await pub.unicast(wandaId, "boot-dm: sent before the channel was up");
  await waitFor("the boot DM to buffer", () => stillPending("boot-dm"));
  check("the boot DM is buffered and un-acked, with no wake path yet", agent.pendingWake() === 1, {
    pendingWake: agent.pendingWake(),
  });

  const nudges: string[] = [];
  const wake = createWakePolicy(agent, async (params) => {
    nudges.push(params.content);
  }, () => {});
  try {
    check("registering the wake policy after the fact recovers nothing on its own", nudges.length === 0, nudges);

    // ---- A. the race window is real: activation performs no reconcile ---------------------------
    wake.setChannelActive(true);
    await sleep(ACTIVATION_SETTLE_MS);
    check(
      "the claude/channel handshake does NOT itself reconcile a wake that was already pending",
      nudges.length === 0,
      nudges,
    );
    check("and the message is still sitting there, wake-pending", agent.pendingWake() === 1);

    // ---- B. deaf forever, or self-healing? ------------------------------------------------------
    // From here on: no hook, no turn, no new traffic. Anything that arrives is the connector
    // recovering on its own.
    const waitedFrom = Date.now();
    let recovered = true;
    try {
      await waitFor("the connector to re-fire the lost boot wake unprompted", () => nudges.length > 0, DEAF_VERDICT_MS);
    } catch {
      recovered = false;
    }
    // Printed either way: the latency is the diagnostic that says WHICH mechanism recovered it. One
    // ack_wait means the redelivery did; anything much shorter would mean something else woke the
    // session and this cell is no longer measuring what it claims to.
    console.log(
      recovered
        ? `\n  → recovered unprompted after ${Date.now() - waitedFrom}ms (ack_wait ${ACK_WAIT_MS}ms), ${nudges.length} nudge(s): ${JSON.stringify(nudges)}`
        : `\n  → DEAF: no wake in ${DEAF_VERDICT_MS}ms — the session never recovered, with the DM still pending`,
    );
    check(
      "a wake lost in the boot window is re-fired without a human turn (JetStream redelivery re-announces the still-pending item)",
      recovered,
      { nudges, pendingWake: agent.pendingWake() },
    );
    check("the recovering nudge names the DM that was waiting", nudges.some((n) => n.includes("New dm")), nudges);
    check("and it was a WAKE, not a delivery: the DM is still un-acked for the turn to drain", stillPending("boot-dm"));
  } finally {
    wake.stop();
  }

  console.log(`\nCLAUDE BOOT-WAKE RACE TEST PASSED ✅  (${pass} checks)`);
} finally {
  await agent.stop().catch(() => {});
  await pub.stop().catch(() => {});
  srv.kill("SIGKILL");
  await sleep(200);
  rmSync(dir, { recursive: true, force: true });
  releaseBroker(); // last: ownership is held until this teardown has actually finished
}
process.exit(0);
