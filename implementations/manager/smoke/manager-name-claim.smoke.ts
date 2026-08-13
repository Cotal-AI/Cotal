/**
 * CROSS-MANAGER hard-pinned-name CLAIM smoke (control-surface P2 item 3, 3b/3c: the concurrent
 * claim-before-mint the roster fast-path can NOT close).
 *
 * Item 2's M6 hard-pinned refuse (`nameInUse`: agents ∪ reserved ∪ retiring ∪ roster-live) is a
 * STEADY-STATE fast-path — an eventually-consistent SNAPSHOT, not an atomic reservation. The concurrent
 * cross-manager race stays open: manager X reads the roster (name free) → manager Y mints + joins the
 * same hard-pinned name → X mints its sibling in the read→reserve→mint window → collision. The REAL
 * guard is a durable CLAIM-BEFORE-MINT: the Unit B slot row is (owner, alias)-keyed and written via a
 * CAS create (`createRecordEntry`, previousSeq:0) BEFORE the name-bearing credential is minted, and it
 * lives in the SHARED records KV — so it is cross-instance. Two managers minting the SAME hard-pinned
 * name both target `mgrslot.<owner>.<alias>`; exactly one create wins, the other loses the CAS and its
 * spawn refuses at accept (the manager's provisioning catch), BEFORE any name-bearing mint. Never both.
 *
 * This exercises the exact claim the manager runs (`activateStaticLifecycle`, whose FIRST durable write
 * is the slot-intent CAS) from TWO independent executor connections concurrently, proving exactly one
 * wins and the loser leaves no footprint.
 *
 * Run: pnpm smoke:manager-name-claim   (needs nats-server on PATH; boots its own JWT-auth broker)
 */
import { randomUUID } from "node:crypto";
import { connect } from "@nats-io/transport-node";
import { Kvm } from "@nats-io/kv";
import {
  createSpaceAuth, mintCreds, newIdentity, setupSpaceStreams, standaloneConnectOpts,
  DEV_OWNER, mintLifecycleUid, recordsBucket, epAuthBucket, principalKey,
} from "@cotal-ai/core";
import { staticLifecycleTransport, readStaticSlot, activateStaticLifecycle } from "../src/static-lifecycle.js";
import { bootBroker } from "./_boot-broker.js";

let pass = 0, fail = 0;
const check = (name: string, cond: boolean, extra?: unknown): void => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ FAIL: ${name}`, extra !== undefined ? JSON.stringify(extra) : ""); }
};

const space = `name-claim-${randomUUID().slice(0, 8)}`;
const auth = await createSpaceAuth(space);
const broker = await bootBroker(auth);
const SERVERS = broker.servers;
const ALIAS = "pinned"; // the hard-pinned name both managers race to claim

// One manager instance's claim attempt: a fresh nkey identity + uid (its own incarnation) writing the
// (owner, ALIAS) slot intent through its OWN executor connection — the exact activateStaticLifecycle the
// manager's spawn accept-path runs before any name-bearing mint.
const claim = async (ownerInstanceId: string): Promise<{ actor: string; uid: string }> => {
  const id = newIdentity();
  const uid = mintLifecycleUid();
  const creds = await mintCreds(auth, newIdentity(), "lifecycle-executor", { lifecycleExecutor: { owner: DEV_OWNER, actor: id.id, lifecycleUid: uid, alias: ALIAS } });
  const nc = await connect({ servers: SERVERS, ...standaloneConnectOpts({ creds, tls: false }), maxReconnectAttempts: 0 });
  try {
    const kvm = new Kvm(nc);
    const t = staticLifecycleTransport(await kvm.open(recordsBucket(space)), await kvm.open(epAuthBucket(space)));
    await activateStaticLifecycle(t, { owner: DEV_OWNER, alias: ALIAS, actor: id.id, lifecycleUid: uid, managerInstance: "smoke", ownerInstanceId });
    return { actor: id.id, uid };
  } finally {
    await nc.drain().catch(() => nc.close());
  }
};

const readSlot = async (): Promise<{ actor: string; uid: string; phase: string } | undefined> => {
  const creds = await mintCreds(auth, newIdentity(), "provisioner");
  const nc = await connect({ servers: SERVERS, ...standaloneConnectOpts({ creds, tls: false }), maxReconnectAttempts: 0 });
  try {
    const kvm = new Kvm(nc);
    const t = staticLifecycleTransport(await kvm.open(recordsBucket(space)), await kvm.open(epAuthBucket(space)));
    const s = await readStaticSlot(t, DEV_OWNER, ALIAS);
    return s ? { actor: s.row.actor, uid: s.row.lifecycleUid, phase: s.row.phase } : undefined;
  } finally {
    await nc.drain().catch(() => nc.close());
  }
};

try {
  await setupSpaceStreams({ servers: SERVERS, space, creds: await mintCreds(auth, newIdentity(), "provisioner") });

  const INST_X = mintLifecycleUid(), INST_Y = mintLifecycleUid();
  // TWO managers mint the SAME hard-pinned name CONCURRENTLY (both pass their own roster fast-path).
  const results = await Promise.allSettled([claim(INST_X), claim(INST_Y)]);
  const won = results.filter((r) => r.status === "fulfilled") as PromiseFulfilledResult<{ actor: string; uid: string }>[];
  const lost = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];

  check("EXACTLY ONE claim wins (never both mint the hard-pinned name)", won.length === 1 && lost.length === 1, { won: won.length, lost: lost.length });
  check("the LOSER refuses on the (owner, alias) CAS claim, not a name-bearing mint (the loser's slot create lost the fence)",
    lost.length === 1 && /lost its CAS|already exists|provisioning|may only replace a RETIRED/i.test(String((lost[0] as PromiseRejectedResult)?.reason?.message ?? (lost[0] as PromiseRejectedResult)?.reason)),
    lost[0] && String((lost[0] as PromiseRejectedResult).reason?.message ?? (lost[0] as PromiseRejectedResult).reason));

  const slot = await readSlot();
  const winner = won[0]?.value;
  check("the durable slot is held by the WINNER's incarnation (the loser never overwrote it)",
    winner !== undefined && slot !== undefined && slot.uid === winner.uid && slot.actor === winner.actor, { slot, winner });
  check("the winner's principal is the ONE addressable claimant of the name",
    winner !== undefined && slot !== undefined && principalKey(DEV_OWNER, slot.actor).key === principalKey(DEV_OWNER, winner.actor).key);
} finally {
  await broker.stop().catch(() => {});
}

console.log(`\n${fail === 0 ? "NAME-CLAIM SMOKE OK ✅" : "NAME-CLAIM SMOKE FAILED"}  (${pass} passed, ${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);
