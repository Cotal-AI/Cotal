/**
 * Consented background recipient smoke, against a real JetStream broker (open mesh: these cells are
 * about delivery semantics; the credential surface is checked as rows in cell 9).
 *
 *  1. CONSENT FRONTIER: DM and DLV messages published before consent never reach the recipient;
 *     every one published after does. CONTROL: the lifecycle's own UI durable, delivering from the
 *     start, does see the pre-consent messages, so their absence is not an empty-stream artifact.
 *  2. INDEPENDENT READERS: the UI durable ACKs everything first; the recipient still gets every copy.
 *  3. CRASH BETWEEN PERSIST AND ACK: a persisted, unACKed delivery is redelivered with the same
 *     sourceId and a higher delivery count, and the idempotent store keeps one row.
 *  4. FAILED PERSIST: `commitThenAck` NAKs and reports `retry`; the delivery comes back and the store
 *     holds it only after a persist succeeds.
 *  5. COMMITTED: a confirmed ACK is not redelivered.
 *  6. CATEGORY INTEGRITY: a DM-stream delivery is `dm`; an unframed DLV delivery is `unknown`.
 *  7. NEIGHBOUR: messages to another actor of the same owner and to another owner never arrive.
 *  8. REVOCATION: deprovisioning deletes both durables, a later bind refuses, and a repeat finds both
 *     already absent.
 *  9. GRANT ROWS: the recipient's rows are exactly info/fetch/ACK of its own two durables: no create,
 *     delete, stream or UI-durable row.
 *
 * Run: pnpm smoke:delivery-recipient   (needs `nats-server` on PATH; local-only)
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "@nats-io/transport-node";
import { jetstream, jetstreamManager } from "@nats-io/jetstream";
import {
  isReachable, setupSpaceStreams, mintLifecycleUid, dlvSubject, unicastSubject, dlvDurableConfig, dmDurable, dlvDurable,
  recipientDurableConfigs, recipientBindGrants, captureRecipientFrontier, provisionRecipientDurables, deprovisionRecipientDurables,
  nextRecipientDelivery, commitThenAck, isConsumerNotFound, dlvStream, type RecipientDelivery, type PreCreatedDurable,
} from "../src/index.js";
import { pickFreePort } from "./_free-port.js";
import { SMOKE_BROKER_TOKEN, teardownOnSignal } from "@cotal-ai/smoke-kit";

const PORT = await pickFreePort();
const SERVERS = `nats://127.0.0.1:${PORT}`;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ FAIL: ${name}`, extra ?? ""); }
};

const space = `rcp${Date.now().toString(36)}`;
const owner = `u_${"a".repeat(26)}`, actor = "web", neighbourOwner = `u_${"b".repeat(26)}`;
const lifecycleUid = mintLifecycleUid(), grantId = mintLifecycleUid();
const dir = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
const srv = spawn("nats-server", ["-js", "-a", "127.0.0.1", "-p", String(PORT), "-sd", join(dir, "js")], { stdio: "ignore" });
const releaseBroker = teardownOnSignal(srv, dir);
const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);

try {
  let up = false;
  for (let i = 0; i < 50; i++) { if (await isReachable(SERVERS)) { up = true; break; } await wait(200); }
  if (!up) throw new Error(`nats-server did not come up on ${PORT}`);
  await setupSpaceStreams({ servers: SERVERS, space });
  const nc = await connect({ servers: SERVERS });
  const js = jetstream(nc), jsm = await jetstreamManager(nc);
  const dm = (text: string, to = owner, toActor = actor) => js.publish(unicastSubject(space, to, toActor, neighbourOwner, "sender"), enc(text));
  const dlv = (text: string, uid = lifecycleUid, to = owner, toActor = actor) => js.publish(dlvSubject(space, to, toActor, uid), enc(text));

  // The lifecycle's own UI durable (DLV, from the stream start) exists before consent.
  const ui = dlvDurableConfig(space, owner, actor, lifecycleUid);
  await jsm.consumers.add(dlvStream(space), ui);
  await dm("pre-1"); await dm("pre-2"); await dlv("pre-1"); await dlv("pre-2");

  // ---- consent: capture the frontier, pre-create the recipient's durables ----
  const frontier = await captureRecipientFrontier(jsm, space);
  const durables = recipientDurableConfigs({ space, owner, actor, lifecycleUid, grantId }, frontier, { ackWaitMs: 1_000 });
  await provisionRecipientDurables(jsm, durables);
  for (const n of [1, 2, 3]) { await dm(`post-${n}`); await dlv(`post-${n}`); }
  await dm("neighbour-actor", owner, "cli"); await dlv("neighbour-owner", mintLifecycleUid(), neighbourOwner, actor);

  // ---- 2. the UI reader ACKs everything first ----
  const uiConsumer = await js.consumers.get(dlvStream(space), ui.durable_name!);
  const uiSeen: string[] = [];
  for (;;) { const m = await uiConsumer.next({ expires: 1_000 }); if (!m) break; uiSeen.push(dec(m.data)); m.ack(); }
  check("CONTROL: the UI durable delivers the pre-consent DLV messages, so they exist", uiSeen.includes("pre-1") && uiSeen.includes("pre-2"), uiSeen);

  // ---- drain the recipient with an idempotent store ----
  const store = new Map<string, RecipientDelivery>();
  const persist = async (d: RecipientDelivery) => { store.set(d.sourceId, d); };
  const drain = async (d: PreCreatedDurable) => {
    const texts: string[] = [];
    for (;;) {
      const p = await nextRecipientDelivery(js, d, { expiresMs: 1_500 });
      if (!p) return texts;
      texts.push(dec(p.delivery.data));
      await commitThenAck(p, persist);
    }
  };
  const [dmDurable_, dlvDurable_] = durables;

  // 3. crash between persist and ACK: persist the first DLV delivery, never ACK it.
  const first = (await nextRecipientDelivery(js, dlvDurable_, { expiresMs: 1_500 }))!;
  await persist(first.delivery);
  await wait(1_500); // past ack_wait: the broker redelivers
  const again = (await nextRecipientDelivery(js, dlvDurable_, { expiresMs: 1_500 }))!;
  check("a persisted but unACKed delivery is redelivered with the same sourceId", again.delivery.sourceId === first.delivery.sourceId && again.delivery.deliveryCount > first.delivery.deliveryCount, { first: first.delivery, again: again.delivery });
  check("committing the redelivery confirms the ACK", (await commitThenAck(again, persist)) === "committed");

  // 4. a failed persist NAKs and comes back.
  const failing = (await nextRecipientDelivery(js, dlvDurable_, { expiresMs: 1_500 }))!;
  const outcome = await commitThenAck(failing, async () => { throw new Error("disk full"); }, { retryDelayMs: 200 });
  const failedId = failing.delivery.sourceId;
  check("a failed persist reports retry and is not stored", outcome === "retry" && !store.has(failedId), outcome);

  const dlvTexts = await drain(dlvDurable_);
  check("the failed delivery came back and is stored after a successful persist", store.has(failedId), dlvTexts);
  const dmTexts = await drain(dmDurable_);

  // ---- 1. consent frontier and 2. independence ----
  const stored = [...store.values()].map((d) => `${d.stream.startsWith("DM_") ? "dm" : "dlv"}:${dec(d.data)}`).sort();
  check("no pre-consent DM or DLV message was captured", !stored.some((s) => s.includes(":pre-")), stored);
  check("every post-consent message was captured exactly once despite the UI reader's ACKs (3 DM + 3 DLV)", JSON.stringify(stored) === JSON.stringify(["dlv:post-1", "dlv:post-2", "dlv:post-3", "dm:post-1", "dm:post-2", "dm:post-3"]), stored);
  check("the redelivered and retried rows did not duplicate the store (6 rows)", store.size === 6, store.size);

  // 5. committed deliveries are not redelivered.
  await wait(1_500);
  check("committed deliveries are not redelivered", (await nextRecipientDelivery(js, dlvDurable_, { expiresMs: 1_000 })) === null && (await nextRecipientDelivery(js, dmDurable_, { expiresMs: 1_000 })) === null);

  // 6. category integrity.
  check("DM-stream deliveries are dm and unframed DLV deliveries are unknown", [...store.values()].every((d) => d.category === (d.stream.startsWith("DM_") ? "dm" : "unknown")));

  // 7. neighbours.
  check("no message to another actor or another owner arrived", !dmTexts.includes("neighbour-actor") && !dlvTexts.includes("neighbour-owner"), { dmTexts, dlvTexts });

  // 9. grant rows (before revocation, on the live configs).
  const rows = recipientBindGrants(durables);
  check("the recipient's rows are info/fetch/ACK of its own two durables only (6)",
    rows.length === 6 && rows.every((r) => /^\$JS\.(API\.CONSUMER\.(INFO|MSG\.NEXT)|ACK)\./.test(r) && (r.includes(dmDurable_.config.durable_name!) || r.includes(dlvDurable_.config.durable_name!))), rows);
  check("no row names the UI durables, a create, a delete or a stream",
    !rows.some((r) => r.includes(`.${dmDurable(owner, actor, lifecycleUid)}`) || r.includes(`.${dlvDurable(owner, actor, lifecycleUid)}`) || /CREATE|DELETE|STREAM/.test(r)), rows);
  check("a negative consent frontier refuses", (() => { try { recipientDurableConfigs({ space, owner, actor, lifecycleUid, grantId }, { dm: -1, dlv: 0 }); return false; } catch { return true; } })());

  // ---- 8. revocation ----
  const removed = await deprovisionRecipientDurables(jsm, durables);
  check("deprovisioning deletes both recipient durables", removed.deleted === 2 && removed.absent === 0, removed);
  let bindRefused = false;
  try { await nextRecipientDelivery(js, dlvDurable_, { expiresMs: 500 }); } catch (e) { bindRefused = isConsumerNotFound(e); }
  check("a bind after revocation refuses as consumer not found", bindRefused);
  const repeat = await deprovisionRecipientDurables(jsm, durables);
  check("a repeated deprovision finds both already absent", repeat.deleted === 0 && repeat.absent === 2, repeat);
  check("the UI durable survives the recipient's revocation", (await jsm.consumers.info(dlvStream(space), ui.durable_name!)).name === ui.durable_name);
  await nc.close();
} finally {
  releaseBroker();
  srv.kill("SIGKILL");
  rmSync(dir, { recursive: true, force: true });
}

const EXPECTED = 18;
console.log(`\ndelivery-recipient smoke: ${pass} passed, ${fail} failed`);
if (pass + fail !== EXPECTED) {
  console.log(`  ✗ FAIL: expected ${EXPECTED} cells, ran ${pass + fail} - a cell was added or silently skipped`);
  process.exit(1);
}
process.exit(fail === 0 ? 0 : 1);
