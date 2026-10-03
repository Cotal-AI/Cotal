/**
 * The shared `bootDeliveryDaemon` fixture holds its delivery lease the way the shipped daemon does,
 * and lets it go cleanly. Every cell drives the fixture itself against a real JWT broker; the lease
 * row is read back from the bucket, never inferred from the fixture's own bookkeeping.
 *
 *   1. It renews: the row's revision advances and stays owned across more than one renew interval.
 *   2. A renew that fails stops renewing and does not throw: the row moves to another writer, the
 *      fixture's next renew CAS is refused, and the fixture never writes the row again.
 *   3. `stop()` during an in-flight renew waits for that renew, then releases the row by CAS.
 *   4. `stop()` does not release a row it no longer owns.
 *
 * Run: pnpm smoke:boot-delivery-lease
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createSpaceAuth, mintCreds, newIdentity, openDeliveryRegistry, leaseKey, setupSpaceStreams, standaloneConnectOpts } from "@cotal-ai/core";
import { connect } from "@nats-io/transport-node";
import { bootBroker } from "./_boot-broker.js";
import { bootDeliveryDaemon } from "./_boot-delivery.js";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const c = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ FAIL: ${name}`, extra !== undefined ? JSON.stringify(extra) : ""); }
};

const space = `bootdlv-${Math.random().toString(36).slice(2, 8)}`;
const auth = await createSpaceAuth(space);
const broker = await bootBroker(auth);
const ws = mkdtempSync(join(tmpdir(), "cotal-bootdlv-"));
const RENEW_MS = 300;
let reader: Awaited<ReturnType<typeof connect>> | undefined;
const daemons: Array<{ stop: () => Promise<void> }> = [];

try {
  await setupSpaceStreams({ servers: broker.servers, space, creds: await mintCreds(auth, newIdentity(), "provisioner") });
  // A separate `delivery` principal reads and, in cells 2 and 4, takes over the row. It is the
  // same credential class the fixture holds, so the bucket grants are the real ones.
  const otherId = newIdentity();
  reader = await connect({ servers: broker.servers, ...standaloneConnectOpts({ creds: await mintCreds(auth, otherId, "delivery"), tls: false }), inboxPrefix: `_INBOX_${otherId.id}`, maxReconnectAttempts: 0 });
  const kv = await openDeliveryRegistry(reader, space);
  const row = async () => {
    const e = await kv.get(leaseKey(0));
    return !e || e.operation === "DEL" || e.operation === "PURGE" ? undefined : { info: e.json<{ holder: string; incarnation?: string; ready: boolean }>(), revision: e.revision };
  };
  const boot = async () => {
    const d = await bootDeliveryDaemon({ space, servers: broker.servers, auth, reloadStoreIdentity: { kind: "fs", root: resolve(ws) }, renewIntervalMs: RENEW_MS });
    daemons.push(d);
    return d;
  };

  console.log("1. the fixture renews its lease");
  {
    const d = await boot();
    const first = await row();
    c("after boot the row is the fixture's and ready", first !== undefined && d.ep.ownsDeliveryLease(first.info as never) && first.info.ready === true, first);
    await wait(RENEW_MS * 4);
    const later = await row();
    c("several renew intervals later the revision has advanced and the row is still the fixture's",
      later !== undefined && first !== undefined && later.revision > first.revision && d.ep.ownsDeliveryLease(later.info as never), { first: first?.revision, later: later?.revision });

    console.log("3. stop() during an in-flight renew waits for it, then releases by CAS");
    // Hold the fixture's next renew open. The fixture calls `ep.renewDeliveryLease` on the endpoint
    // it returned, so gating that method holds the fixture's own renew in flight; the real renew
    // still runs once released, so the CAS release that follows is argued against its revision.
    const realRenew = d.ep.renewDeliveryLease.bind(d.ep);
    let entered!: () => void;
    const renewEntered = new Promise<void>((r) => { entered = r; });
    let releaseRenew!: () => void;
    const held = new Promise<void>((r) => { releaseRenew = r; });
    d.ep.renewDeliveryLease = async (shard: number, revision: number) => { entered(); await held; return realRenew(shard, revision); };
    await renewEntered;
    let stopped = false;
    const stopping = d.stop().then(() => { stopped = true; });
    await wait(RENEW_MS);
    c("stop() does not return while the fixture's renew is still in flight", stopped === false);
    releaseRenew();
    await stopping;
    const after = await row();
    c("once the renew lands, stop() releases the row by CAS: the row is gone", after === undefined, after);
    await wait(RENEW_MS * 3);
    c("and no renew resurrects it after stop()", (await row()) === undefined);
  }

  console.log("2. a renew that fails stops renewing, without throwing");
  {
    const d = await boot();
    const own = await row();
    // Another writer takes the row at its current revision, as a successor daemon would. The
    // fixture's next renew CAS is then against a revision that has moved, and is refused.
    const foreign = new TextEncoder().encode(JSON.stringify({ holder: "someone-else", incarnation: "other", since: Date.now(), ready: true }));
    const takenAt = await kv.update(leaseKey(0), foreign, own!.revision);
    await wait(RENEW_MS * 4);
    const now = await row();
    c("the fixture never wrote the row again after its renew was refused",
      now !== undefined && now.revision === takenAt && now.info.holder === "someone-else", { takenAt, now: now?.revision, holder: now?.info.holder });

    console.log("4. stop() does not release a row it no longer owns");
    await d.stop();
    const kept = await row();
    c("the other writer's row survives the fixture's stop()", kept !== undefined && kept.info.holder === "someone-else" && kept.revision === takenAt, kept);
    await kv.delete(leaseKey(0));
  }
} catch (e) {
  fail++;
  console.log("  ✗ FAIL: threw", (e as Error).stack ?? String(e));
}

for (const d of daemons) await d.stop().catch(() => {});
await reader?.drain().catch(() => reader?.close());
await broker.stop().catch(() => undefined);
rmSync(ws, { recursive: true, force: true });

const EXPECTED_CELLS = 7;
if (pass + fail !== EXPECTED_CELLS) {
  console.log(`SUITE INCOMPLETE — ran ${pass + fail} of ${EXPECTED_CELLS} cells; a partial run is not a pass`);
  fail += 1;
}
console.log(`boot-delivery-lease.smoke: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
