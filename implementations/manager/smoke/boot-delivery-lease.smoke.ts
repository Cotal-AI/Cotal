/**
 * The shared `bootDeliveryDaemon` fixture holds its delivery lease the way the shipped daemon does,
 * and lets it go cleanly. Lease cells drive the fixture against a real JWT broker and read the row
 * back from the bucket. The separate admin-wait controls use held and refused attempts to check the
 * shipped wait helper's cadence and deadline; they are not broker-reconnect reproductions.
 *
 *   1. It renews: the row's revision advances and stays owned across more than one renew interval.
 *   2. A renew that fails stops renewing and does not throw: the row moves to another writer, the
 *      fixture's next renew CAS is refused, and the fixture never writes the row again.
 *   3. `stop()` during an in-flight renew waits for that renew, then releases the row by CAS.
 *   4. `stop()` does not release a row it no longer owns.
 *   5. Real manager startup rejects answered malformed challenges and accepts a no-responder with no lease.
 *   6. Incompatible answers refuse with scoped recovery guidance; a matching daemon permits startup.
 *   7. The admin wait retries promptly, preserves refusals and sends nothing after its deadline.
 *
 * Run: pnpm smoke:boot-delivery-lease
 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONTROL_DELIVERY_ADMIN, controlServiceSubject, createSpaceAuth, mintCreds, newIdentity, openDeliveryRegistry, leaseKey, setupSpaceStreams, standaloneConnectOpts, type ControlRequest } from "@cotal-ai/core";
import { connect, TimeoutError } from "@nats-io/transport-node";
import { untilDeliveryAdminAnswers } from "../src/endpoint-evict.js";
import { bootBroker } from "./_boot-broker.js";
import { bootDeliveryDaemon } from "./_boot-delivery.js";
import { authDir, saveSpaceAuth, workspaceSecretStore } from "@cotal-ai/workspace";
import { Manager } from "../src/manager.js";

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
const previousHome = process.env.COTAL_HOME;
process.env.COTAL_HOME = join(ws, "home");
mkdirSync(process.env.COTAL_HOME);
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
    const d = await bootDeliveryDaemon({ space, servers: broker.servers, auth, reloadStoreIdentity: workspaceSecretStore(ws).identity, renewIntervalMs: RENEW_MS });
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
    // Bounded: a fixture that never renews must fail here, not hang the suite.
    const reached = await Promise.race([renewEntered.then(() => true), wait(RENEW_MS * 10).then(() => false)]);
    if (!reached) throw new Error("the fixture's renew was never called within ten renew intervals");
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

  console.log("5. a manager distinguishes an answered malformed store challenge from no responder");
  for (const [index, payload] of [undefined, "x 503 y", "x no responders y", "x timeout y"].entries()) {
    const workspaceRoot = join(ws, `manager-${index}`);
    mkdirSync(workspaceRoot);
    saveSpaceAuth(authDir(workspaceRoot), auth);
    let answered = 0;
    let unexpected = 0;
    const responder = payload === undefined ? undefined : reader.subscribe(
      controlServiceSubject(space, CONTROL_DELIVERY_ADMIN, "*", "*"),
      { queue: CONTROL_DELIVERY_ADMIN, callback: (error, message) => {
        if (error) { unexpected++; return; }
        if (message.json<ControlRequest>().op !== "reloadStoreIdentity") { unexpected++; return; }
        answered++;
        message.respond(new TextEncoder().encode(payload));
      } },
    );
    await reader.flush();
    const manager = new Manager({ space, servers: broker.servers, runtime: "pty", workspaceRoot });
    let started = false;
    let failure: unknown;
    try {
      c(`store challenge ${index} starts without a delivery lease holder`, (await row()) === undefined);
      try { await manager.start(); started = true; } catch (error) { failure = error; }
      if (payload === undefined) {
        c("a real no-responder with no lease row still permits manager startup", started && failure === undefined,
          failure instanceof Error ? failure.message : failure);
      } else {
        c(`malformed store reply ${index} was actually answered`, answered > 0 && unexpected === 0, { answered, unexpected });
        c(`answered malformed store reply ${index} refuses instead of settling absent`,
          !started && failure instanceof Error && failure.message.includes("could not challenge the delivery daemon's SecretStore"),
          failure instanceof Error ? failure.message : { started });
      }
    } finally {
      responder?.unsubscribe();
      await reader.flush();
      await manager.stop({ withAgents: true });
    }
  }

  console.log("6. incompatible store answers name version recovery without guessing the daemon's age");
  for (const [index, data] of [
    { identity: { kind: "fs", root: ws }, responder: "older-delivery", holdsDeliveryLease: true },
    { kind: "fs", root: ws },
  ].entries()) {
    const workspaceRoot = join(ws, `older-manager-${index}`);
    mkdirSync(workspaceRoot);
    saveSpaceAuth(authDir(workspaceRoot), auth);
    let answered = 0;
    const responder = reader.subscribe(controlServiceSubject(space, CONTROL_DELIVERY_ADMIN, "*", "*"), {
      queue: CONTROL_DELIVERY_ADMIN,
      callback: (error, message) => {
        if (error) return;
        if (message.json<ControlRequest>().op !== "reloadStoreIdentity") return;
        answered++;
        message.respond(new TextEncoder().encode(JSON.stringify({ ok: true, data })));
      },
    });
    await reader.flush();
    const manager = new Manager({ space, servers: broker.servers, runtime: "pty", workspaceRoot });
    let started = false;
    let failure: unknown;
    try {
      try { await manager.start(); started = true; } catch (error) { failure = error; }
      c(`incompatible store answer ${index} reaches the real challenge`, answered > 0);
      c(`incompatible store answer ${index} still refuses manager startup`,
        !started && failure instanceof Error && failure.message.includes("unreadable SecretStore"),
        failure instanceof Error ? failure.message : { started });
      c(`incompatible store answer ${index} names scoped recovery without guessing its version`,
        failure instanceof Error && !failure.message.includes("older than #1694") &&
        failure.message.includes("same Cotal version") && failure.message.includes("supervisor") &&
        failure.message.includes(`cotal down delivery --space ${space}`) &&
        failure.message.includes(`cotal up --space ${space}`),
        failure instanceof Error ? failure.message : failure);
    } finally {
      responder.unsubscribe();
      await reader.flush();
      await manager.stop({ withAgents: true });
    }
  }
  {
    saveSpaceAuth(authDir(ws), auth);
    const delivery = await boot();
    const manager = new Manager({ space, servers: broker.servers, runtime: "pty", workspaceRoot: ws });
    try {
      await manager.start();
      c("a manager still starts beside a daemon with the matching store answer", true);
    } finally {
      await manager.stop({ withAgents: true });
      await delivery.stop();
    }
  }

  console.log("7. an unanswered admin rail is retried promptly without weakening the deadline");
  {
    let attempts = 0;
    const delays: number[] = [];
    const result = await untilDeliveryAdminAnswers(10_000, async (requestMs) => {
      requestMs(15_000);
      if (++attempts < 3) throw new TimeoutError();
      return "answered";
    }, (_reason, delayMs) => { delays.push(delayMs); });
    c("the first retry is immediate and the next uses one second, without backoff",
      result === "answered" && attempts === 3 && delays.length === 2 && delays[0] === 0 && delays[1] === 1_000, { attempts, delays });
  }
  {
    const refused = new Error("permission denied");
    let attempts = 0, retries = 0;
    let error: unknown;
    try {
      await untilDeliveryAdminAnswers(10_000, async () => { attempts++; throw refused; }, () => { retries++; });
    } catch (e) { error = e; }
    c("a non-retryable error is rethrown unchanged after one attempt, with no retry", error === refused && attempts === 1 && retries === 0);
  }
  {
    let attempts = 0, retries = 0;
    let cap = 0;
    let error: unknown;
    try {
      await untilDeliveryAdminAnswers(0, async (requestMs) => { attempts++; cap = requestMs(15_000); throw new TimeoutError(); }, () => { retries++; });
    } catch (e) { error = e; }
    c("a zero wait remains one attempt at the supplied request cap", error instanceof TimeoutError && attempts === 1 && retries === 0 && cap === 15_000);
  }
  {
    let lateRequests = 0;
    let lateBudgetChecked = false;
    let error: unknown;
    try {
      await untilDeliveryAdminAnswers(60, async (requestMs) => {
        await wait(120);
        lateBudgetChecked = true;
        requestMs(15_000);
        lateRequests++;
      }, () => {});
    } catch (e) { error = e; }
    await wait(100);
    c("the wait expires during a held attempt and its late request cannot be sent", error instanceof TimeoutError && lateBudgetChecked && lateRequests === 0);
  }
} catch (e) {
  fail++;
  console.log("  ✗ FAIL: threw", (e as Error).stack ?? String(e));
}

for (const d of daemons) await d.stop().catch(() => {});
await reader?.drain().catch(() => reader?.close());
await broker.stop().catch(() => undefined);
rmSync(ws, { recursive: true, force: true });
if (previousHome === undefined) delete process.env.COTAL_HOME;
else process.env.COTAL_HOME = previousHome;

const EXPECTED_CELLS = 29;
if (pass + fail !== EXPECTED_CELLS) {
  console.log(`SUITE INCOMPLETE — ran ${pass + fail} of ${EXPECTED_CELLS} cells; a partial run is not a pass`);
  fail += 1;
}
console.log(`boot-delivery-lease.smoke: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
