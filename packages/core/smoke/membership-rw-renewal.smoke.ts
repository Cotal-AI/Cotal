/**
 * MEMBERSHIP-RW STANDING RENEWAL (W3 3b): conn B of the broker-sourced graph feed adopts a re-signed rw
 * cred through the SecretStore seam, the SAME way the endpoint's delivery.creds does — a preflight-proven
 * adoption plus a 75% renewal timer, replacing the old per-reconnect source re-read that presented UNPROVEN
 * bytes. This is the acceptance matrix (plan §"Acceptance matrix"), executed on a real broker:
 *
 *   - explicit reload of a validly re-signed cred is ADOPTED (window returned; feed keeps working);
 *   - the expected-generation fingerprint rejects a DIFFERENT candidate BEFORE the preflight (case 3);
 *   - a broker-REFUSED candidate whose fingerprint MATCHES is refused by the preflight, and conn B stays
 *     live on the last-proven cred — nothing is quarantined (case 7, the membership half of the D5 blocker);
 *   - an nkey SWAP is refused (identity pin);
 *   - an INCIDENTAL reconnect (broker restart) re-presents the last-PROVEN cred, never a fresh un-preflighted
 *     source read — the authenticator never re-reads the source (case 6 / blocker 2 core);
 *   - the 75% timer SELF-HEALS across the initial cred's renewal point and stop() clears it (case 1);
 *   - the whole prove-then-adopt transaction is bounded by an ABSOLUTE deadline < the manager's request
 *     bound, including the single-flight queue wait (case 5 / mirrors the endpoint's reload-deadline-queue).
 *
 * Run: pnpm smoke:membership-rw-renewal   (needs `nats-server` on PATH; auth/JetStream, local-only; ~20s)
 */
import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, credsAuthenticator } from "@nats-io/transport-node";
import { Kvm } from "@nats-io/kv";
import { encodeUser } from "@nats-io/jwt";
import { fromPublic, fromSeed } from "@nats-io/nkeys";
import {
  isReachable, createSpaceAuth, mintCreds, mintMembershipObserverCreds, newIdentity, serverConfig,
  setupSpaceStreams, startMembershipFeed, credsFingerprint, idFromCreds, membershipBucket,
  MEMBERSHIP_FEED_KEY, type MembershipFeedHandle,
} from "../src/index.js";
import { pickFreePort } from "./_free-port.js";

const enc = (s: string) => new TextEncoder().encode(s);
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const MANAGER_BOUND_MS = 15_000; // manager's requestDeliveryAdmin("reloadCreds") timeout
let pass = 0, fail = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ FAIL: ${name}`, extra ?? ""); }
};

const PORT = await pickFreePort();
const SERVERS = `nats://127.0.0.1:${PORT}`;
const space = `member-rw-${randomUUID().slice(0, 8)}`;
const auth = await createSpaceAuth(space);
const rogue = await createSpaceAuth(space); // a DIFFERENT operator, absent from server.conf → the broker refuses its signatures
const dir = mkdtempSync(join(tmpdir(), "cotal-member-rw-"));
writeFileSync(join(dir, "server.conf"), serverConfig(auth, { port: PORT, storeDir: join(dir, "js") }));
const startBroker = (): ChildProcess => spawn("nats-server", ["-c", join(dir, "server.conf")], { stdio: "ignore" });
let srv = startBroker();

const observerCreds = await mintMembershipObserverCreds(auth, newIdentity());
const accountId = auth.account.pub;
const feedId = newIdentity(); // conn B's stable nkey — every rw cred below re-signs THIS id
let feed: MembershipFeedHandle | undefined;

async function waitReachable(tries = 75): Promise<void> {
  for (let i = 0; i < tries; i++) { if (await isReachable(SERVERS)) return; await wait(200); }
  throw new Error(`nats-server did not come up on ${PORT}`);
}

// Read the feed's freshness heartbeat (re-stamped by conn B on EVERY successful poll) with a throwaway
// reader on a valid rw cred — a real broker round-trip, so it advances iff conn B is genuinely live.
async function heartbeatAt(readerCred: string): Promise<number> {
  const nc = await connect({ servers: SERVERS, authenticator: credsAuthenticator(enc(readerCred)), inboxPrefix: `_INBOX_${feedId.id}`, maxReconnectAttempts: 0 });
  try {
    const kv = await new Kvm(nc).open(membershipBucket(space));
    const e = await kv.get(MEMBERSHIP_FEED_KEY);
    return e ? (e.json<{ observedAt?: number }>().observedAt ?? 0) : 0;
  } finally { await nc.close(); }
}
// Prove conn B is live: poll, then confirm the heartbeat advanced past `baseline` (bounded retry rides
// out a reconnect in flight). Returns the observed heartbeat so the caller can chain the next baseline.
async function provesLive(f: MembershipFeedHandle, readerCred: string, baseline: number): Promise<number> {
  for (let i = 0; i < 20; i++) {
    await f.poll();
    const at = await heartbeatAt(readerCred);
    if (at > baseline) return at;
    await wait(250);
  }
  return baseline; // never advanced → the check that compares against baseline will fail
}

try {
  await waitReachable();
  await setupSpaceStreams({ servers: SERVERS, space, creds: await mintCreds(auth, newIdentity(), "provisioner") });

  // ---- Scenario 1: explicit reload — adopt / expected-mismatch / broker-refuse / nkey-swap ----
  // A LONG-TTL initial cred: the 75% timer won't fire during this scenario (its own timing is scenario 3),
  // so every adoption here is the EXPLICIT reload path only.
  const initial = await mintCreds(auth, feedId, "membership-rw", { expiresInSeconds: 3600 });
  let served = initial;      // what the source returns on the next read
  let reads = 0;             // times the source was read (0 after the initial connect's read)
  const source = async (): Promise<string> => { reads++; return served; };

  feed = await startMembershipFeed({ servers: SERVERS, space, accountId, observerCreds, rwCreds: source, intervalMs: 60_000 });
  let hb = await provesLive(feed, initial, 0);
  check("feed starts on the initial proven cred (source read exactly once)", reads === 1, reads);
  check("conn B is live (heartbeat stamped via a real broker round-trip)", hb > 0, hb);

  // A VALID re-sign by the trusted signer, distinct bytes (a different TTL guarantees a different JWT, since
  // a same-second same-TTL re-sign is byte-identical). The preflight accepts it → adopted.
  const renewed = await mintCreds(auth, feedId, "membership-rw", { expiresInSeconds: 4200 });
  check("a valid re-sign has a DIFFERENT fingerprint (distinct generation)", credsFingerprint(renewed) !== credsFingerprint(initial));
  served = renewed;
  const adopt = await feed.reloadRwCreds(credsFingerprint(renewed)).then((w) => ({ ok: true, w }), (e: Error) => ({ ok: false, e: e.message }));
  check("explicit reload ADOPTS a validly re-signed cred (broker-accepted window returned)", adopt.ok && (adopt as { w: { identity: string } }).w.identity === feedId.id, adopt);
  const afterAdopt = await provesLive(feed, renewed, hb);
  check("conn B works on the ADOPTED cred (heartbeat advanced, read back with the new generation)", afterAdopt > hb, { afterAdopt, hb });
  hb = afterAdopt;

  // Case 3: the expected-generation fingerprint rejects a DIFFERENT candidate BEFORE the preflight. Source
  // returns `initial` but we assert the `renewed` generation → mismatch, nothing adopted, conn B untouched.
  served = initial;
  const preReads = reads;
  const mism = await feed.reloadRwCreds(credsFingerprint(renewed)).then(() => ({ ok: true, e: "" }), (e: Error) => ({ ok: false, e: e.message }));
  check("expected-fingerprint MISMATCH is rejected (case 3)", !mism.ok && /did not match the expected re-signed generation/i.test(mism.e), mism);
  check("the mismatch message carries NO digest (non-material)", !mism.ok && !/[0-9a-f]{16,}/i.test(mism.e), mism.e);
  check("mismatch still read the source once (fetch precedes compare)", reads === preReads + 1, reads);
  const afterMism = await provesLive(feed, renewed, hb);
  check("conn B untouched after a rejected mismatch (heartbeat still advancing)", afterMism > hb, { afterMism, hb });
  hb = afterMism;

  // Case 7: a broker-REFUSED candidate whose fingerprint MATCHES the expectation (a rogue/untrusted signer,
  // same nkey). The preflight is the proof: it refuses, the reload throws, and conn B stays live on the
  // last-proven cred — the membership half of the D5 blocker.
  const rogueCred = await mintCreds(rogue, feedId, "membership-rw", { expiresInSeconds: 3600 });
  served = rogueCred;
  const refused = await feed.reloadRwCreds(credsFingerprint(rogueCred)).then(() => ({ ok: true, e: "" }), (e: Error) => ({ ok: false, e: e.message }));
  check("broker-REFUSED candidate (fingerprint matches) is refused by the preflight (case 7)", !refused.ok && /broker did not accept/i.test(refused.e), refused);
  const afterRefuse = await provesLive(feed, renewed, hb);
  check("conn B stays LIVE + functional after a refused candidate (nothing quarantined, case 7)", afterRefuse > hb, { afterRefuse, hb });
  hb = afterRefuse;

  // nkey swap: a cred for a DIFFERENT identity is refused by the pin, nothing adopted.
  const otherId = newIdentity();
  served = await mintCreds(auth, otherId, "membership-rw", { expiresInSeconds: 3600 });
  const swap = await feed.reloadRwCreds().then(() => ({ ok: true, e: "" }), (e: Error) => ({ ok: false, e: e.message }));
  check("an nkey SWAP is refused (identity pin)", !swap.ok && /may not swap the feed's nkey/i.test(swap.e), swap);

  // ---- Scenario 2: incidental reconnect presents the PROVEN cache, never a fresh source read (case 6) ----
  // Flip the source to a broker-REFUSED cred, then restart the broker to force conn B to reconnect. If the
  // authenticator re-read the source (the OLD behavior) it would present the rogue cred and strand conn B;
  // instead it presents the last-PROVEN `currentRwCreds`, so the feed recovers and the source is NOT re-read.
  served = rogueCred; // a cred the broker would refuse, if the reconnect ever re-read the source
  const readsBeforeRestart = reads;
  srv.kill("SIGKILL");
  await wait(500);
  srv = startBroker();
  await waitReachable();
  // conn B reconnects (maxReconnectAttempts:-1) + JetStream recovers from the persisted store; a REAL
  // heartbeat advance past `hb` proves conn B did KV work again — not just that poll() swallowed an error.
  const afterRestart = await provesLive(feed, renewed, hb);
  check("feed RECOVERS after a broker restart (incidental reconnect used the proven cache)", afterRestart > hb, { afterRestart, hb });
  check("the incidental reconnect did NOT re-read the source (authenticator reads the proven cache only)", reads === readsBeforeRestart, `${reads} vs ${readsBeforeRestart}`);

  await feed.stop();
  feed = undefined;

  // ---- Scenario 3: 75% timer self-heal + stop() clears it (case 1) ----
  // A SHORT-TTL initial cred so the 75% timer fires inside the test window; the source hands back a valid
  // long-TTL re-sign. The timer must PROVE + adopt it (source re-read), keep conn B alive across the short
  // cred's renewal point, and stop() must clear the timer (no further source reads).
  const shortTtl = 6;
  const shortInitial = await mintCreds(auth, feedId, "membership-rw", { expiresInSeconds: shortTtl });
  const longRenew = await mintCreds(auth, feedId, "membership-rw", { expiresInSeconds: 3600 });
  let tReads = 0;
  const tSource = async (): Promise<string> => { tReads++; return tReads === 1 ? shortInitial : longRenew; };
  const feed2 = await startMembershipFeed({ servers: SERVERS, space, accountId, observerCreds, rwCreds: tSource, intervalMs: 60_000 });
  feed = feed2;
  const hb2 = await provesLive(feed2, shortInitial, 0);
  check("timer feed starts (source read once)", tReads === 1, tReads);
  check("timer feed's conn B is live at start", hb2 > 0, hb2);
  // 75% of 6s ≈ 4.5s; wait past it for the timer to fire, prove, adopt, and reconnect.
  await wait(6_500);
  check("the 75% timer fired and re-read the source (self-heal, case 1)", tReads >= 2, tReads);
  // The short cred (6s) is now past its own expiry; a live heartbeat proves conn B adopted the long re-sign.
  const healed = await provesLive(feed2, longRenew, hb2);
  check("feed keeps working across the short cred's renewal point (adopted the long re-sign)", healed > hb2, { healed, hb2 });
  const readsAtStop = tReads;
  await feed2.stop();
  feed = undefined;
  await wait(2_000); // a live timer would have fired again by now (75% of 6s)
  check("stop() cleared the renewal timer (no further source reads)", tReads === readsAtStop, `${tReads} vs ${readsAtStop}`);

  // ---- Scenario 4: absolute deadline bounds the whole txn incl. the queue wait (case 5) ----
  // A source whose RENEWAL reads hang forever. Two explicit reloads in one tick: A enters the single-flight
  // and hangs to its deadline; B queues behind A. B must finish within the manager's 15s bound (bounded by
  // the deadline captured at ENTRY, incl. the queue wait), not get a fresh budget at ~24s.
  const hangInitial = await mintCreds(auth, feedId, "membership-rw", { expiresInSeconds: 3600 });
  let hReads = 0;
  const hSource = (): Promise<string> => {
    hReads++;
    if (hReads === 1) return Promise.resolve(hangInitial);
    return new Promise<string>((resolve) => { setTimeout(() => resolve(""), 30_000).unref?.(); });
  };
  const feed3 = await startMembershipFeed({ servers: SERVERS, space, accountId, observerCreds, rwCreds: hSource, intervalMs: 60_000 });
  feed = feed3;
  const t0 = Date.now();
  const rA = feed3.reloadRwCreds().then(() => ({ ok: true, ms: Date.now() - t0, e: "" }), (e: Error) => ({ ok: false, ms: Date.now() - t0, e: e.message }));
  const rB = feed3.reloadRwCreds().then(() => ({ ok: true, ms: Date.now() - t0, e: "" }), (e: Error) => ({ ok: false, ms: Date.now() - t0, e: e.message }));
  const [raRes, rbRes] = await Promise.all([rA, rB]);
  check("A (first in the single-flight) fails at its source deadline, nothing adopted", !raRes.ok && /did not return before the daemon deadline/i.test(raRes.e), raRes);
  check("B (queued behind A) also fails structured, nothing adopted", !rbRes.ok && /elapsed while queued|did not return before the daemon deadline/i.test(rbRes.e), rbRes);
  check("B finished within the manager's 15s bound (no fresh budget after the queue wait, case 5)", rbRes.ms < MANAGER_BOUND_MS, `${rbRes.ms}ms`);
  check("B really was queued behind A (waited past the deadline, not instant)", rbRes.ms >= 10_000, `${rbRes.ms}ms`);
  await feed3.stop();
  feed = undefined;

  // ---- Scenario 5: an UNCHANGED source past 75% must NOT 1s-churn (freelance HIGH 1) ----
  // The 75% timer fires; if the renewal owner has not re-signed yet, the source returns the SAME cred. It
  // is still broker-valid, so a naive adopt recommits it, `credsRenewalDelayMs` is <=0 (past the renewal
  // point), `armRwRefresh` floors the next tick to 1s, and `renewRwOnTimer` reconnects EVERY second for
  // the rest of the JWT's life. The fix treats an unchanged generation past its renewal point as a MISSED
  // remint: a 60s retry with NO resident reconnect. Discriminator: renewal reads in the churn window.
  const churnTtl = 12;
  const churnCred = await mintCreds(auth, feedId, "membership-rw", { expiresInSeconds: churnTtl });
  let churnReads = 0;
  const churnSource = async (): Promise<string> => { churnReads++; return churnCred; }; // NEVER changes
  const feed4 = await startMembershipFeed({ servers: SERVERS, space, accountId, observerCreds, rwCreds: churnSource, intervalMs: 60_000 });
  feed = feed4;
  check("churn feed starts (source read once)", churnReads === 1, churnReads);
  await wait(8_500);              // just past 75% (9s) minus setup slack — the timer has not fired yet
  const churnBaseline = churnReads;
  await wait(2_800);             // ~11.3s: the buggy 1s loop would have ticked ~3x in the 9-12s window
  check("an unchanged source past 75% did NOT busy-loop (<=1 renewal read in the churn window, H1)", churnReads - churnBaseline <= 1, { churnReads, churnBaseline });
  await feed4.stop();
  feed = undefined;

  // ---- Scenario 6: a post-preflight validation failure must NOT poison the cache (freelance HIGH 2) ----
  // A same-nkey cred the broker ACCEPTS but that lacks a numeric `exp` (unbounded, minted with EMPTY perms
  // so an adopted-by-mistake reconnect is observably broken). `credsRenewalDelayMs` rejects it AFTER the
  // preflight; the bug committed `currentRwCreds` BEFORE that check, so `reloadRwCreds` reported failure
  // while conn B's cache had already flipped, and the next reconnect presented the "rejected" unbounded
  // cred. The fix validates the bounded window BEFORE the cache assignment.
  const boundedInit = await mintCreds(auth, feedId, "membership-rw", { expiresInSeconds: 3600 });
  // NO exp (credsRenewalDelayMs rejects), but ENOUGH perms to pass the disposable preflight connect (the
  // inbox sub) and NO KV perms — so if the bug adopts it, an incidental reconnect onto it is observably
  // broken (heartbeat KV writes denied). credsRenewalDelayMs must therefore reject it AFTER the preflight.
  const unboundedJwt = await encodeUser("mrw-unbounded", fromPublic(feedId.id), fromPublic(auth.account.pub), { pub: { deny: [">"] }, sub: { allow: [`_INBOX_${feedId.id}.>`] } }, { signer: fromSeed(enc(auth.account.signingSeed)) });
  const unboundedCred = `-----BEGIN NATS USER JWT-----\n${unboundedJwt}\n------END NATS USER JWT------\n\n-----BEGIN USER NKEY SEED-----\n${feedId.seed}\n------END USER NKEY SEED------\n`;
  let h2Served = boundedInit;
  const feed5 = await startMembershipFeed({ servers: SERVERS, space, accountId, observerCreds, rwCreds: async () => h2Served, intervalMs: 60_000 });
  feed = feed5;
  const h2hb = await provesLive(feed5, boundedInit, 0);
  check("H2 feed live on the bounded cred", h2hb > 0, h2hb);
  h2Served = unboundedCred;
  const h2 = await feed5.reloadRwCreds().then(() => ({ ok: true, e: "" }), (e: Error) => ({ ok: false, e: e.message }));
  check("reload of an unbounded (no-exp) cred FAILS", !h2.ok && /numeric exp|nothing adopted/i.test(h2.e), h2);
  // Force conn B to reconnect (broker restart) so it presents whatever `currentRwCreds` now holds. With the
  // fix it is still the bounded cred (full perms → KV works → heartbeat advances). With the bug it is the
  // unbounded EMPTY-perms cred (KV denied → heartbeat frozen).
  srv.kill("SIGKILL");
  await wait(500);
  srv = startBroker();
  await waitReachable();
  const h2after = await provesLive(feed5, boundedInit, h2hb);
  check("post-validation-failure the cache is UNCHANGED — bounded cred still presented after reconnect (H2)", h2after > h2hb, { h2after, h2hb });
  await feed5.stop();
  feed = undefined;

  console.log(`\n${fail ? "✗" : "✓"} MEMBERSHIP-RW RENEWAL ${pass}/${pass + fail}`);
  process.exitCode = fail ? 1 : 0;
} finally {
  try { await feed?.stop(); } catch { /* draining */ }
  srv.kill("SIGKILL");
  rmSync(dir, { recursive: true, force: true });
  await wait(200);
}
process.exit(fail ? 1 : 0);
