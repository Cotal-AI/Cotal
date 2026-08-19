/**
 * AN EMPTY MESSAGE ID IS NEVER A DEDUP KEY (Cotal #624).
 *
 * THE DEFECT: MeshAgent.ingest coalesces by message id on three read sites (already-handled,
 * protected disposition, still-pending). An id of "" satisfies every one of them as a key, so two
 * DISTINCT messages that each carry an empty id read as duplicates of each other: the first is
 * buffered, the second is silently dropped, and once the first is drained the id lands in
 * handledIds and every later empty-id message is dropped on arrival. Silent message loss, measured
 * live on a broker below.
 *
 * WHY A RAW PUBLISHER: the first-party publish APIs mint a fresh id per message, so an empty id can
 * only arrive from a foreign client on the wire. The receiver side is where the collapse lives, so
 * the repro publishes real bytes on the real chat subject with a conformant payload (from.id equals
 * the subject sender) and lets the real endpoint subscription and the real ingest deliver them.
 *
 * THE CHOICE THIS FIX MAKES, so a later reader can check it rather than trust it: an empty id is
 * treated as NO id (never a dedup key, in either direction), not as a refusal at ingest. Refusing
 * would trade the loss for a different one, since the bars of this fix are that two distinct
 * empty-id messages must BOTH be delivered. The cost is stated, not hidden: with no id there is no
 * coalescing either, so a redelivered copy of an empty-id message can surface twice. That is the
 * wire contract's at-least-once stance (handlers are idempotent), and it is the same stance every
 * conformant message already has on the transport below this layer.
 *
 * WHAT WOULD MAKE THIS THE WRONG EXPERIMENT:
 *
 *   - If the cells only counted inbox entries, a fix that double-buffered one message would pass.
 *     Every count cell is paired with a content cell: the drained texts are asserted by value.
 *   - If no cell exercised the post-drain path, a fix that only guarded the pending lookup would
 *     pass while handledIds kept collapsing every empty-id message after the first drain. Cell 2
 *     drains FIRST, then publishes a third empty-id message and asserts it arrives.
 *   - If no cell exercised real ids, a fix that disabled id dedup entirely would pass. Cells 3 and
 *     4 hold the other side: the same real id twice still collapses to one entry, and two distinct
 *     real ids are both delivered.
 *
 * Run: pnpm smoke:empty-id-ingest   (spins its own nats-server)
 */
import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "@nats-io/transport-node";
import { chatSubject, isReachable, mintLifecycleUid, seedChannelRegistry } from "@cotal-ai/core";
import { MeshAgent } from "../src/agent.js";
import type { AgentConfig } from "../src/config.js";
import type { InboxItem } from "../src/agent.js";
import { pickFreePort } from "./_free-port.js";
import { SMOKE_BROKER_TOKEN, teardownOnSignal } from "@cotal-ai/smoke-kit";

const PORT = await pickFreePort();
const servers = `nats://127.0.0.1:${PORT}`;
const space = "emptyidsmoke";
const enc = new TextEncoder();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const awaitExit = (proc: ReturnType<typeof spawn>, timeoutMs = 3000): Promise<void> =>
  new Promise((resolve) => {
    if (proc.exitCode !== null || proc.signalCode !== null) return resolve();
    proc.once("exit", () => resolve());
    setTimeout(resolve, timeoutMs);
  });
/** Poll until pred holds, or fail with what the inbox actually held (the observation, not just "red"). */
const waitFor = async (pred: () => boolean, what: string, ms = 6000): Promise<void> => {
  for (let i = 0; i < ms / 100; i++) {
    if (pred()) return;
    await sleep(100);
  }
  const observed = {
    inbox: agent.inboxCount(),
    bufferedTexts: (agent as unknown as { inbox: { item: InboxItem }[] }).inbox.map((p) => p.item.text),
    incomingFired: incoming.length,
  };
  assert.ok(pred(), `timed out waiting for ${what}: observed ${JSON.stringify(observed)}`);
};

const dir = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
const srv = spawn("nats-server", ["-js", "-p", String(PORT), "-sd", join(dir, "js")], { stdio: "ignore" });
const releaseBroker = teardownOnSignal(srv, dir);
let pass = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  assert.ok(cond, `${name}${extra !== undefined ? `: ${JSON.stringify(extra)}` : ""}`);
  pass++;
  console.log(`  ✓ ${name}`);
};

const cfg: AgentConfig = {
  space,
  name: "Otto",
  role: "generalist",
  servers,
  subscribe: ["ch"],
  allowSubscribe: ["ch"],
  allowPublish: ["ch"],
  kind: "agent",
  tls: false,
  id: "otto_agent",
  lifecycleUid: mintLifecycleUid(),
};

const agent = new MeshAgent(cfg);
agent.on("error", () => {});
const incoming: InboxItem[] = [];
agent.on("incoming", (i: InboxItem) => incoming.push(i));

// The foreign publisher: a raw client with no Cotal layer, exactly the shape an empty id can only
// come from. Its principal rides the subject (local.rawpub), and from.id matches it, so the
// receiver's authenticity guard passes and the message reaches ingest like any conformant one.
const PUB_OWNER = "local", PUB_ACTOR = "rawpub";
const subject = chatSubject(space, PUB_OWNER, PUB_ACTOR, "ch");
const rawMsg = (id: string, text: string) =>
  JSON.stringify({
    id,
    ts: Date.now(),
    space,
    from: { id: `${PUB_OWNER}.${PUB_ACTOR}`, name: "RawPub", kind: "agent" },
    channel: "ch",
    parts: [{ kind: "text", text }],
  });

// The raw connection and the agent are closed in the FINALLY, not on the success path: a red run
// throws at its first assertion, and an open socket or an unstopped endpoint each keep the process
// alive long after the FAILED line, which hangs whatever invoked the suite.
let nc: Awaited<ReturnType<typeof connect>> | undefined;
try {
  for (let i = 0; i < 50; i++) { if (await isReachable(servers)) break; await sleep(200); }
  await seedChannelRegistry({ servers, space, file: { defaults: { replay: false }, channels: {} } });

  agent.start();
  for (let i = 0; i < 50; i++) { if (agent.connected) break; await sleep(200); }
  check("agent connected", agent.connected === true);
  await sleep(300);

  nc = await connect({ servers, maxReconnectAttempts: 0 });
  const publish = async (id: string, text: string) => {
    nc.publish(subject, enc.encode(rawMsg(id, text)));
    await nc.flush();
  };
  const drainedTexts = (): string[] => agent.drainInbox().map((i) => i.text);

  // ---- Cell 1: THE REPRO: two distinct messages, each with an EMPTY id ----
  await publish("", "empty-a");
  await publish("", "empty-b");
  await waitFor(() => agent.inboxCount() === 2, "both empty-id messages to buffer");
  check("two distinct messages with EMPTY ids are both delivered (both buffered)", agent.inboxCount() === 2, { inbox: agent.inboxCount() });
  const c1 = drainedTexts();
  check("two distinct messages with EMPTY ids are both delivered (both surfaced, by text)", c1.includes("empty-a") && c1.includes("empty-b") && c1.length === 2, c1);

  // ---- Cell 2: post-drain: a third empty-id message must not hit the handled-id wall ----
  await publish("", "empty-c");
  await waitFor(() => agent.inboxCount() === 1, "the third empty-id message to buffer");
  const c2 = drainedTexts();
  check("a third empty-id message still delivers after the first two were handled", c2.length === 1 && c2[0] === "empty-c", c2);

  // ---- Cell 3: dedup for REAL ids is not weakened: same id twice collapses to one ----
  await publish("dup-real", "dup-1");
  await publish("dup-real", "dup-2");
  await waitFor(() => agent.inboxCount() >= 1, "the duplicated real id to buffer");
  await sleep(400); // let any (wrong) second copy land before asserting the count
  check("the same REAL id twice still collapses to one entry", agent.inboxCount() === 1, { inbox: agent.inboxCount() });
  const c3 = drainedTexts();
  check("the collapsed REAL-id entry is the first copy", c3.length === 1 && c3[0] === "dup-1", c3);

  // ---- Cell 4: two distinct REAL ids are both delivered ----
  await publish("real-a", "ra");
  await publish("real-b", "rb");
  await waitFor(() => agent.inboxCount() === 2, "both distinct real-id messages to buffer");
  const c4 = drainedTexts();
  check("two distinct REAL ids are both delivered", c4.includes("ra") && c4.includes("rb") && c4.length === 2, c4);

  console.log(`\nEMPTY-ID INGEST SMOKE OK ✅  (${pass} checks)`);
} catch (e) {
  console.error(`\nEMPTY-ID INGEST SMOKE FAILED ❌  ${(e as Error).message}`);
  process.exitCode = 1;
} finally {
  try { await agent.stop(); } catch { /* already down or never up */ }
  try { if (nc) await nc.drain(); } catch { /* broker already gone */ }
  releaseBroker();
  srv.kill("SIGKILL");
  await awaitExit(srv);
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
}
