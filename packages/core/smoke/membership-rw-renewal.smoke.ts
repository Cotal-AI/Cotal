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
 *     bound, including the single-flight queue wait (case 5 / mirrors the endpoint's reload-deadline-queue);
 *   - a startup that REJECTS after conn A is open leaves no observer connection behind (#1557);
 *   - the missed-remint refusal compares GENERATIONS, so a reformatted envelope carrying the same JWT is
 *     still refused and still does not churn (#1563).
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
  setupSpaceStreams, startMembershipFeed, credsFingerprint, credsClaims, idFromCreds, membershipBucket,
  MEMBERSHIP_FEED_KEY, type MembershipFeedHandle,
} from "../src/index.js";
import { pickFreePort } from "./_free-port.js";
import { SMOKE_BROKER_TOKEN, teardownOnSignal } from "@cotal-ai/smoke-kit";

const enc = (s: string) => new TextEncoder().encode(s);
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (cond: () => boolean | Promise<boolean>, budgetMs: number, stepMs: number): Promise<boolean> => {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) { if (await cond()) return true; await wait(stepMs); }
  return await cond();
};
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
const dir = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
writeFileSync(join(dir, "server.conf"), serverConfig(auth, [auth], { transport: { kind: "plaintext" }, port: PORT, storeDir: join(dir, "js") }));
// Ownership lives INSIDE the factory, so every restart is covered by construction rather than by
// each call site remembering. Owning only the first child would leave the LIVE broker unowned
// after a restart while the suite still read as migrated: ownership held on a dead pid.
let releaseBroker = (): void => {};
// `-D` and piped output: scenario 7 grades what conn B presents to the BROKER after its own wire
// expires, and the auth decision is only visible in the server's debug log.
let brokerLog = "";
const startBroker = (): ChildProcess => {
  releaseBroker();
  const p = spawn("nats-server", ["-D", "-c", join(dir, "server.conf")], { stdio: ["ignore", "pipe", "pipe"] });
  p.stdout?.on("data", (d: Buffer) => { brokerLog += d.toString(); });
  p.stderr?.on("data", (d: Buffer) => { brokerLog += d.toString(); });
  releaseBroker = teardownOnSignal(p, dir);
  return p;
};
let srv = startBroker();

const observerCreds = await mintMembershipObserverCreds(auth, newIdentity());
const accountId = auth.account.pub;
// Conn A lives in the SYSTEM account, and the observer cred can only ask for the DATA account's CONNZ
// (`membershipObserverPermissions` scopes it to exactly that one subject) - so counting conn A needs a
// probe that can ask the SERVER for every connection. Minted from the same in-memory $SYS signing seed
// the observer itself is minted from, with `$SYS.REQ.SERVER.PING.CONNZ` and nothing else.
const probeId = newIdentity();
const probeJwt = await encodeUser(
  "membership-connz-probe",
  fromPublic(probeId.id),
  fromPublic(auth.sys.pub),
  { pub: { allow: ["$SYS.REQ.SERVER.PING.CONNZ"] }, sub: { allow: [`_INBOX_${probeId.id}.>`] } },
  { signer: fromSeed(enc(auth.sys.signingSeed as string)) },
);
const probeCreds = `-----BEGIN NATS USER JWT-----\n${probeJwt}\n------END NATS USER JWT------\n\n-----BEGIN USER NKEY SEED-----\n${probeId.seed}\n------END USER NKEY SEED------\n`;
// The broker's own connection table. Scenarios 8 and 10 grade a leak by what the BROKER still holds,
// not by anything the feed reports about itself. Keyed by the connection NAME the feed sets, so each
// half of the startup record can be counted on its own: conn A alone would pass scenario 10 whether
// or not conn B was drained.
const countConnsNamed = async (name: string): Promise<number> => {
  const probe = await connect({
    servers: SERVERS,
    authenticator: credsAuthenticator(enc(probeCreds)),
    name: "smoke-connz-probe",
    inboxPrefix: `_INBOX_${probeId.id}`,
  });
  try {
    const reply = await probe.request(
      "$SYS.REQ.SERVER.PING.CONNZ",
      enc(JSON.stringify({ auth: true, offset: 0, limit: 1024 })),
      { timeout: 3_000 },
    );
    const body = reply.json<{ data?: { connections?: Array<{ name?: string }> } }>();
    return (body.data?.connections ?? []).filter((c) => c.name === name).length;
  } finally {
    await probe.drain();
  }
};
const countObserverConns = (): Promise<number> => countConnsNamed("cotal-membership-observer");
const countRwConns = (): Promise<number> => countConnsNamed("cotal-membership-rw");
// Re-sign a creds file with its `exp` claim removed and EVERY other claim carried over verbatim.
// Scenario 10 needs a cred the broker still accepts and still permissions identically, differing from
// a working one in exactly the claim the renewal-window computation reads. Building one by hand
// instead drops the permission block, which moves the failure to an earlier step under a cell name
// that says otherwise.
const stripExpClaim = async (creds: string, id: ReturnType<typeof newIdentity>): Promise<string> => {
  const c = credsClaims(creds);
  const { exp: _dropped, ...kept } = c as Record<string, unknown> & { exp?: number };
  void _dropped;
  const jwt = await encodeUser(
    (kept.name as string) ?? "membership-rw",
    fromPublic(id.id),
    fromPublic(auth.account.pub),
    (c.nats ?? {}) as Parameters<typeof encodeUser>[3],
    { signer: fromSeed(enc(auth.account.signingSeed)) },
  );
  return `-----BEGIN NATS USER JWT-----\n${jwt}\n------END NATS USER JWT------\n\n-----BEGIN USER NKEY SEED-----\n${id.seed}\n------END USER NKEY SEED------\n`;
};
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

  // ---- Scenario 7: an expired rw cred is never presented, even by the client's own redial ----
  // "Proven when adopted" and "unexpired now" are different properties. `currentRwCreds` only advances
  // through a preflight-proven adoption, so it cannot hold an UNPROVEN generation - but the clock alone
  // expires a proven one. With renewal failing (manager down, store unreachable), the broker closes conn B
  // at `exp` and the client redials; before the checkpoint that redial presented the dead credential, which
  // cost an auth round trip and reported the broker's words rather than the local, actionable cause.
  const expiringId = newIdentity();
  let expiringReads = 0;
  const expiringLog: string[] = [];
  const expiringFeed = await startMembershipFeed({
    servers: SERVERS, space, accountId, observerCreds, intervalMs: 60_000,
    log: (m) => { expiringLog.push(m); },
    rwCreds: async () => {
      expiringReads++;
      if (expiringReads === 1) return mintCreds(auth, expiringId, "membership-rw", { expiresInSeconds: 3 });
      throw new Error("fixture renewal source offline"); // renewal keeps failing, as in the report
    },
  });
  feed = expiringFeed;
  const expiryWindowStart = brokerLog.length; // grade only what this scenario's wire does
  // Past `exp`, plus the broker's expiry-close and the client's redial attempt.
  await until(() => /rw creds have expired/.test(expiringLog.join("\n")), 12_000, 100);
  // Every broker-side connection that carried this feed's nkey into an expiry decision. The original wire
  // is one; a redial that presented the dead cred would be a second cid on the same nkey.
  const expiredCids = new Set(
    brokerLog.slice(expiryWindowStart).split("\n")
      .filter((l) => l.includes(`nkey:${expiringId.id}`) && /Authentication Expired/.test(l))
      .map((l) => /cid:(\d+)/.exec(l)?.[1] ?? "?"),
  );
  check(
    "the refusal is loud and names the failing renewal path",
    expiringLog.some((m) => /rw creds have expired.*renewal is failing/.test(m)),
    expiringLog,
  );
  check(
    "conn B's own wire expires ONCE and no redial presents the dead cred to the broker",
    expiredCids.size === 1,
    { cids: [...expiredCids], reads: expiringReads },
  );
  await expiringFeed.stop();
  feed = undefined;

  // ---- Scenario 8: a startup that rejects after conn A leaves no observer connection behind (#1557) ----
  // Conn A opens first and the rw source is read next, so a source that throws rejects the function with
  // conn A already open. The only `drain()` lives in the handle's `stop()`, which a caller never receives
  // on a reject - so the observer connection stayed open for the life of the process. Graded on the
  // BROKER's own connection table, not on anything the feed reports about itself.
  // ACCEPT CONTROL first: a probe that cannot see a LIVE observer would make the leak assertion below
  // vacuous — "zero before, zero after" passes whether or not the connection was drained.
  const controlFeed = await startMembershipFeed({
    servers: SERVERS, space, accountId, observerCreds, intervalMs: 60_000,
    rwCreds: await mintCreds(auth, newIdentity(), "membership-rw", { expiresInSeconds: 600 }),
  });
  feed = controlFeed;
  const observersWithFeed = await countObserverConns();
  check("the CONNZ probe sees a LIVE observer connection (accept control)", observersWithFeed >= 1, { observersWithFeed });
  await controlFeed.stop();
  feed = undefined;

  const observersBefore = await countObserverConns();
  const startupFailure = await startMembershipFeed({
    servers: SERVERS, space, accountId, observerCreds, intervalMs: 60_000,
    rwCreds: async () => { throw new Error("fixture rw source offline at startup"); },
  }).then(() => ({ ok: true, e: "" }), (e: Error) => ({ ok: false, e: e.message }));
  check(
    "startup rejects when the rw source throws between the two connects",
    !startupFailure.ok && /fixture rw source offline at startup/.test(startupFailure.e),
    startupFailure,
  );
  // The drain is awaited before the rejection propagates, but the broker deregisters asynchronously.
  let observersAfter = observersBefore;
  const drained = await until(async () => {
    observersAfter = await countObserverConns();
    return observersAfter === observersBefore;
  }, 5_000, 100);
  check(
    "conn A is drained when startup rejects - no orphaned observer connection on the broker",
    drained,
    { observersBefore, observersAfter },
  );

  // ---- Scenario 9: the missed-remint refusal is by GENERATION, not by envelope bytes (#1563) ----
  // Scenario 5 serves one exact string, so it cannot tell "same generation" from "same bytes". The source
  // is caller-supplied and opaque - a SecretStore adapter, an editor, a filesystem round trip - and any of
  // them can hand back the SAME JWT in a differently formatted envelope. The envelope also carries the
  // nkey seed, which `credsFingerprint` documents as a reason not to hash it. Compared by bytes, such a
  // read looks like a NEW generation: it is adopted past its own renewal point, `delay <= 0` floors the
  // next tick to 1s, and the feed re-reads the store every second - the churn scenario 5 exists to stop.
  //
  // Same JWT, same seed, different bytes: extra newlines at EOF, the shape a store or an editor adds on
  // a round trip. `jwtFromCreds` trims them away; `===` does not. Deliberately a difference the BROKER
  // still accepts - a CRLF envelope also differs in bytes, but the broker refuses it, and the preflight
  // would then mask the defect by refusing the adoption for an unrelated reason.
  //
  // EVERY read is byte-distinct, keyed on the read counter, and that is load-bearing for the grading:
  // serving one fixed reformatted string lets the byte-comparing mutant ARREST ITSELF. It adopts the
  // second read, and the 1s tick that follows compares the third read against the adopted second - equal
  // bytes - so it refuses, restores the 60s backoff, and the read count lands inside the same bound the
  // fixed code produces. The cell then passes under the mutation and grades nothing.
  const reformatEnvelope = (creds: string, read: number): string => creds + "\n".repeat(read);
  const reformatTtl = 20;
  const reformatCred = await mintCreds(auth, feedId, "membership-rw", { expiresInSeconds: reformatTtl });
  let reformatReads = 0;
  const reformatLog: string[] = [];
  const reformatSource = async (): Promise<string> => {
    reformatReads++;
    return reformatReads === 1 ? reformatCred : reformatEnvelope(reformatCred, reformatReads);
  };
  const feed6 = await startMembershipFeed({
    servers: SERVERS, space, accountId, observerCreds, rwCreds: reformatSource, intervalMs: 60_000,
    log: (m) => { reformatLog.push(m); },
  });
  feed = feed6;
  check("reformat feed starts (source read once)", reformatReads === 1, reformatReads);
  // Both halves of the control: consecutive reads differ from the first AND from each other (or the
  // mutant self-arrests), and all of them carry the same generation (or the refusal proves nothing).
  const [reform2, reform3] = [reformatEnvelope(reformatCred, 2), reformatEnvelope(reformatCred, 3)];
  check(
    "the reformatted envelope really is the same generation (accept control)",
    reform2 !== reformatCred && reform3 !== reform2
      && credsFingerprint(reform2) === credsFingerprint(reformatCred)
      && credsFingerprint(reform3) === credsFingerprint(reformatCred),
    { differsFromFirst: reform2 !== reformatCred, differsFromPrevious: reform3 !== reform2 },
  );
  await wait(14_500);  // just past 75% (15s) minus setup slack — the timer has not fired yet
  const reformatBaseline = reformatReads;
  const reformatRefused = await until(
    () => reformatLog.some((m) => /still holds the previous generation past its renewal point/.test(m)),
    5_000, 100);
  // The refusal itself: compared by bytes this read is a NEW generation and is adopted instead.
  check("a reformatted envelope of the SAME generation is REFUSED as a missed remint (#1563)", reformatRefused, reformatLog);
  // And the consequence the refusal exists for: adopting it floors the next tick to 1s, so the source is
  // re-read within the second rather than after the 60s renewal backoff.
  await wait(2_500);
  check(
    "the refusal keeps the 60s backoff — no 1s re-read of the source (#1563)",
    reformatReads - reformatBaseline <= 1,
    { reformatReads, reformatBaseline },
  );
  await feed6.stop();
  feed = undefined;

  // ---- Scenario 10: the rollback covers conn B too, not just conn A (#1573) ----
  // Scenario 8 rejects at the rw SOURCE, which is awaited BEFORE conn B is recorded, so at the
  // moment it rejects `opened` holds conn A alone. That makes it structurally unable to grade the
  // conn B arm: deleting the conn B record changes nothing it can observe, so a mutation on that
  // line does not go red, it goes SILENT. Measured, not argued: with only scenario 8 present, a
  // mutant dropping `opened.push(connB)` SURVIVED while a mutant emptying the drain was KILLED in
  // the same run, so the suite provably reached the file and still could not see the conn B gap.
  //
  // This scenario rejects LATER, with BOTH connections already recorded. The site is the first
  // renewal-timer arm: `credsRenewalDelayMs` is fail-loud on a cred with no numeric `exp`, and its
  // argument is evaluated before `armRwRefresh` runs, so the throw lands after conn B is open and
  // recorded but before any timer exists. The cred is broker-ACCEPTED (it dials fine) so the
  // rejection is the renewal-window computation and not an auth failure, and it is SOURCE-fed
  // because a literal string skips the arm entirely.
  //
  // Graded on the BROKER's connection table, like scenario 8, and on conn B's OWN name, because
  // the conn A count alone passes whether or not conn B was drained.
  const bothBeforeA = await countObserverConns();
  const bothBeforeB = await countRwConns();
  // ACCEPT CONTROL: the counters must be able to SEE a live conn B, or "back to baseline" below is
  // vacuous - zero before and zero after passes whether or not anything was drained.
  const liveFeed = await startMembershipFeed({
    servers: SERVERS, space, accountId, observerCreds, intervalMs: 60_000,
    rwCreds: await mintCreds(auth, newIdentity(), "membership-rw", { expiresInSeconds: 600 }),
  });
  feed = liveFeed;
  const liveA = await countObserverConns();
  const liveB = await countRwConns();
  check("the CONNZ probe sees BOTH feed connections live (accept control)", liveA > bothBeforeA && liveB > bothBeforeB, { liveA, bothBeforeA, liveB, bothBeforeB });
  await liveFeed.stop();
  feed = undefined;

  // Broker-ACCEPTED and FULLY PERMISSIONED, with the `exp` claim and nothing else removed.
  //
  // My first attempt hand-rolled this cred with `pub: { deny: [">"] }`, which would have rejected at
  // THE WRONG SITE and still printed a passing-looking cell. Measured on the AST rather than assumed:
  // TWO steps sit between the conn B record (:223) and the arm (:320), the feed KV open (:227) and
  // the members registry open (:228), and a KV open is a JetStream API REQUEST, so a deny-all publish
  // grant fails there FIRST. The cell would then have graded a KV failure while its name claimed the
  // renewal arm, and the drain assertion under it would have passed for a reason the cell misnames.
  //
  // So the cred is minted by the SAME `mintCreds(..., "membership-rw")` path as the live one above,
  // and only its `exp` is stripped, re-signed on the same nkey. That makes the renewal-window
  // computation the first thing that can fail, which is what the cell claims.
  const noExpId = newIdentity();
  const boundedRw = await mintCreds(auth, noExpId, "membership-rw", { expiresInSeconds: 600 });
  const noExpCred = await stripExpClaim(boundedRw, noExpId);
  // ASSERT THE INPUT, both directions, before anything is graded on it: the bounded cred must carry a
  // numeric `exp` and the stripped one must not, or this scenario proves nothing about the arm.
  check("the bounded rw cred carries a numeric exp (accept control on the stripper's input)", typeof credsClaims(boundedRw).exp === "number", credsClaims(boundedRw).exp);
  check("stripping removed the exp and kept the same subject (the only difference is the claim)", credsClaims(noExpCred).exp === undefined && credsClaims(noExpCred).sub === credsClaims(boundedRw).sub, { exp: credsClaims(noExpCred).exp, sameSub: credsClaims(noExpCred).sub === credsClaims(boundedRw).sub });
  // And the PERMISSIONS survived the re-sign, so a failure below is about the missing exp rather than
  // about a grant this rewrite dropped.
  check("the stripped cred keeps the membership-rw permission block", JSON.stringify(credsClaims(noExpCred).nats?.pub) === JSON.stringify(credsClaims(boundedRw).nats?.pub) && JSON.stringify(credsClaims(noExpCred).nats?.sub) === JSON.stringify(credsClaims(boundedRw).nats?.sub), true);

  const lateBeforeA = await countObserverConns();
  const lateBeforeB = await countRwConns();
  const lateFailure = await startMembershipFeed({
    servers: SERVERS, space, accountId, observerCreds, intervalMs: 60_000,
    rwCreds: async () => noExpCred,
  }).then(() => ({ ok: true, e: "" }), (e: Error) => ({ ok: false, e: e.message }));
  check(
    "startup rejects at the renewal-timer arm, AFTER both connections are recorded",
    !lateFailure.ok && /without a numeric exp/.test(lateFailure.e),
    lateFailure,
  );
  // ORDERING MATTERS HERE AND I GOT IT WRONG FIRST. The drain check below must run IMMEDIATELY after
  // the rejecting startup, before anything else opens a connection. My first draft ran the refuse
  // control in between, which opens a feed (two connections) and stops it; its drain and the drain
  // under test would then have been racing into the SAME counters, and a count that failed to return
  // to baseline could not be attributed to either one. A confounded counter is not a measurement.
  let lateAfterA = lateBeforeA, lateAfterB = lateBeforeB;
  const bothDrained = await until(async () => {
    lateAfterA = await countObserverConns();
    lateAfterB = await countRwConns();
    return lateAfterA === lateBeforeA && lateAfterB === lateBeforeB;
  }, 5_000, 100);
  check(
    "conn B is drained too when startup rejects after it was recorded - no orphaned rw connection on the broker",
    bothDrained,
    { lateBeforeA, lateAfterA, lateBeforeB, lateAfterB },
  );

  // REFUSE CONTROL, run LAST so it cannot perturb the counters above: the same bytes as a STATIC
  // string skip the arm (`rwIsSource` is false), so that startup must NOT reject. Without it,
  // "rejects" above could be any unrelated failure of this cred rather than the renewal window.
  const staticOk = await startMembershipFeed({
    servers: SERVERS, space, accountId, observerCreds, intervalMs: 60_000, rwCreds: noExpCred,
  }).then((h) => ({ ok: true, h }), () => ({ ok: false, h: undefined }));
  check("the SAME cred as a static string does NOT reject (refuse control: the arm is the site)", staticOk.ok, staticOk.ok);
  if (staticOk.h) await staticOk.h.stop();

  console.log(`\n${fail ? "✗" : "✓"} MEMBERSHIP-RW RENEWAL ${pass}/${pass + fail}`);
  process.exitCode = fail ? 1 : 0;
} finally {
  try { await feed?.stop(); } catch { /* draining */ }
  srv.kill("SIGKILL");
  rmSync(dir, { recursive: true, force: true });
  releaseBroker(); // last: ownership is held until this teardown has actually finished
  await wait(200);
}
process.exit(fail ? 1 : 0);
