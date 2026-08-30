/**
 * The connector activation lost-wake races, end-to-end over a real broker (no test runner, no
 * `claude`).
 *
 * The #226 defect: a session spawned with a peer message ALREADY pending in its durable
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
 * come from the connector's own activation machinery.
 *
 * Activation reconciles one buffered wake immediately. The message remains buffered and unacked,
 * because a nudge is only a wake signal and the later hook drain is still the delivery authority.
 *
 * The #917 defect is the same activation window with a focus @mention. That body is ack-dropped at
 * ingest, so it has no durable redelivery path: the inactive nudge must stay silent, then the
 * false-to-true activation must re-fire the remembered mention exactly once. The active-channel
 * rejection retry remains covered by `smoke:claude-wake`.
 *
 * The durable redelivery guard remains in `smoke:cross-path-dedup` and `smoke:claude-wake`. This is
 * the activation half: a real broker, a real durable consumer, and the connector's real boot order.
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
/** Long enough that activation checks cannot be satisfied by JetStream redelivery. */
const ACK_WAIT_MS = 6_000;
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

    // ---- #226: activation reconciles one buffered wake without waiting for redelivery ------------
    wake.setChannelActive(true);
    await sleep(ACTIVATION_SETTLE_MS);
    check(
      "the claude/channel handshake reconciles a buffered wake that was already pending",
      nudges.length === 1 && nudges[0].includes("Cotal message"),
      nudges,
    );
    check("the buffered activation reconcile emits exactly one notice", nudges.length === 1, nudges);
    check("and it was a WAKE, not a delivery: the DM is still un-acked for the turn to drain", stillPending("boot-dm"));

    check("the first scenario's boot DM can be committed before the mention scenario", agent.drainInbox().some((item) => item.text.includes("boot-dm")));
    check("the second scenario starts with no buffered wake", agent.pendingWake() === 0);

    // ---- #917: a focus mention lands after policy install but before channel activation ---------
    // The mention is remembered, but its nudge no-ops while inactive. Focus ingest then acks and
    // drops the body, so pendingWake and the local inbox are both zero: activation is the only
    // remaining recovery point.
    wake.setChannelActive(false);
    await agent.setAttention("focus");
    const mentionNudgesBefore = nudges.length;
    await pub.multicast("@Wanda pre-activation focus mention", { channel: "team", mentions: ["Wanda"] });
    await sleep(ACTIVATION_SETTLE_MS);
    check("the pre-activation focus mention is ack-dropped with no buffered wake", agent.pendingWake() === 0, {
      pendingWake: agent.pendingWake(),
      inbox: agent.peekInbox("all").map((item) => item.text),
    });
    check("the pre-activation focus mention is absent from the local inbox", !stillPending("pre-activation focus mention"));
    check("the inactive mention nudge emits no claude/channel notice", nudges.length === mentionNudgesBefore, nudges);

    wake.setChannelActive(true);
    await sleep(ACTIVATION_SETTLE_MS);
    check(
      "activating claude/channel re-fires the ack-dropped focus mention",
      nudges.length === mentionNudgesBefore + 1 && nudges.at(-1)?.includes("pull it with cotal_inbox"),
      nudges,
    );
    wake.setChannelActive(true);
    await sleep(ACTIVATION_SETTLE_MS);
    check("repeated active state does not duplicate the mention notice", nudges.length === mentionNudgesBefore + 1, nudges);
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
