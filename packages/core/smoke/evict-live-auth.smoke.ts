/**
 * D5 slice 4 — LIVE CONNECTION EVICTION live smoke. Proves the kill-live primitive end-to-end against a
 * REAL user-auth broker + REAL auth callout: a live callout-minted connection is force-disconnected by
 * KICK after its grant is revoked (deny-new), verified gone by a fresh CONNZ re-scan — plus the two
 * boundary cases the primitive must state, never infer: the idempotent not-live no-op and the fail-closed
 * partial scan.
 *
 * WHAT IS UNDER TEST (`packages/core/src/evict.ts`):
 *   evictDeniedPrincipal(observerConn, evictorConn, accountId, principal) — scan account CONNZ (auth:true)
 *   projected to {cid, serverId, principal}, KICK each matching cid on its own server, re-scan to verify.
 *   Success is ONLY `verifiedGone:true` (a COMPLETE re-scan found zero live cids); a partial/denied scan is
 *   `verifiedGone:false, scanComplete:false`; a not-live principal is an idempotent success no-op.
 * Plus the two scoped SYSTEM-account creds it holds: `mintMembershipObserverCreds` (CONNZ-read) and
 * `mintConnectionEvictorCreds` (`$SYS.REQ.SERVER.*.KICK` only) — mintable ONLY at the `up` that provisions
 * the account (in-memory `$SYS` signing seed), so they are minted right after createSpaceAuth here.
 *
 * The user connection P is CALLOUT-MINTED (sentinel + bearer) — the real user-mode shape, which a static
 * cred would NOT model. This smoke is exactly what disproved the design's premise: a callout connection
 * does NOT carry a `principal:` tag in CONNZ; nats-server surfaces its JWT name-form as `authorized_user`
 * instead. So eviction attributes via `principalFromConnz` (tag for static mints, authorized_user name-form
 * for callout), NOT tags-only. Deny-new is a real ledger `revokeActor` (the mandatory precondition the
 * module's name carries), committed before the KICK.
 *
 * COTAL_HOME-free; kills only the nats-server it starts, by exact PID (never pkill).
 * Run: npx tsx packages/core/smoke/evict-live-auth.smoke.ts   (needs nats-server on PATH)
 */
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, credsAuthenticator, tokenAuthenticator, type NatsConnection } from "@nats-io/transport-node";
import {
  createSpaceAuth, isReachable, mintCreds, newIdentity, serverConfig, setupSpaceStreams,
  mintMembershipObserverCreds, mintConnectionEvictorCreds,
  principalKey, MEMBERSHIP_INBOX_PREFIX,
} from "../src/index.js";
import { evictDeniedPrincipal, observePlaneLiveness, type PlaneConnTuple } from "../src/evict.js";
import {
  createCalloutAuth, startAuthCallout, calloutPermissions,
  createUserTokenIssuer, generateSigningKey,
  deriveOwnerToken, grantActor, revokeActor, ledgerAclResolver, ledgerAuthorizeConnect,
} from "@cotal-ai/auth";
import { pickFreePort } from "./_free-port.js";
import { SMOKE_BROKER_TOKEN, teardownOnSignal } from "@cotal-ai/smoke-kit";

const PORT = await pickFreePort();
const SERVERS = `nats://127.0.0.1:${PORT}`;
const enc = (s: string) => new TextEncoder().encode(s);
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (cond: () => boolean, ms = 2500): Promise<boolean> => {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await wait(25);
  return cond();
};
// Tighter scan windows than the module defaults keep every eviction round snappy (total < 40s).
const EVICT_OPTS = { maxWaitMs: 1500, settleMs: 200, maxVerifyRounds: 3 } as const;

let pass = 0, fail = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ FAIL: ${name}`, extra ?? ""); }
};

// ---------- a real operator-mode broker with the callout account preloaded ----------
const space = `evictlive-${randomUUID().slice(0, 8)}`;
const auth = await createSpaceAuth(space);
// Mint the two SYSTEM-account creds NOW, from the fresh auth — the in-memory `$SYS` signing seed is the
// only window in which they can be minted (mintMembershipObserverCreds/mintConnectionEvictorCreds throw
// once it is discarded). Non-empty strings prove the mint (checked live-connect below).
const observerId = newIdentity(), evictorId = newIdentity();
const observerCreds = await mintMembershipObserverCreds(auth, observerId);
const evictorCreds = await mintConnectionEvictorCreds(auth, evictorId);

const callout = await createCalloutAuth({ space, operatorSeed: auth.operator.seed, accountPub: auth.account.pub });
const dir = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
writeFileSync(
  join(dir, "server.conf"),
  serverConfig(auth, [auth], { transport: { kind: "plaintext" }, port: PORT, storeDir: join(dir, "js"), extraAccounts: [{ pub: callout.account.pub, jwt: callout.account.jwt }] }),
);
const srv = spawn("nats-server", ["-c", join(dir, "server.conf")], { stdio: "ignore" });
const releaseBroker = teardownOnSignal(srv, dir);
const awaitExit = (proc: ReturnType<typeof spawn>, timeoutMs = 3000): Promise<void> =>
  new Promise((resolve) => {
    if (proc.exitCode !== null || proc.signalCode !== null) return resolve();
    proc.once("exit", () => resolve());
    setTimeout(resolve, timeoutMs);
  });

// ---------- the actor ledger + the one owner P belongs to (derived owner grammar) ----------
const SECRET = "s".repeat(32);
const ISS = "https://auth.cotal.test";
const ledgerDir = mkdtempSync(join(tmpdir(), "cotal-evictlive-ledger-"));
const ownerU = deriveOwnerToken(SECRET, "idp-subject-victim");
const ACL = { allowSubscribe: ["general"], allowPublish: ["general"] };
const victimRow = grantActor(ledgerDir, { owner: ownerU, actor: "victim", scope: [], ...ACL });

const issuer = createUserTokenIssuer({ issuer: ISS, key: await generateSigningKey() });
// Lifecycle-bind the bearer to the row's uid (SPEC 13.1): a bearer minted directly (bypassing the
// service exchange) must still carry the row's lifecycleUid, or the callout's connect equality check
// refuses it as a stale/pre-cut bearer.
const bearerP = await issuer.issue({ owner: ownerU, space, actor: "victim", scope: [], lifecycleUid: victimRow.lifecycleUid, ttlSec: 300 });

let calloutNc: NatsConnection | undefined, observerNc: NatsConnection | undefined,
  evictorNc: NatsConnection | undefined, ncP: NatsConnection | undefined;
try {
  let up = false;
  for (let i = 0; i < 50; i++) { if (await isReachable(SERVERS)) { up = true; break; } await wait(200); }
  if (!up) throw new Error(`auth nats-server did not come up on ${PORT}`);

  // Space streams (realistic broker state; the user cred references them). Provisioner cred, one-shot.
  await setupSpaceStreams({ servers: SERVERS, space, creds: await mintCreds(auth, newIdentity(), "provisioner") });

  // ---------- the auth callout, wired to the real ledger (connect boundary + channel ACL) ----------
  calloutNc = await connect({ servers: SERVERS, authenticator: credsAuthenticator(enc(callout.calloutCreds)) });
  await wait(300);
  startAuthCallout(calloutNc as never, {
    xkeySeed: callout.xkey.seed,
    authAccount: { pub: callout.account.pub, signingSeed: callout.account.signingSeed },
    dataAccount: { pub: auth.account.pub, signingSeed: auth.account.signingSeed },
    space,
    token: { key: issuer.localKeySet(), issuer: ISS },
    authorizeActor: ledgerAuthorizeConnect(ledgerDir),
    permissionsFor: calloutPermissions(ledgerAclResolver(ledgerDir)),
    log: () => {},
  });

  // ---------- the two scoped SYSTEM-account connections (discovery vs. kill, never one broad user) ----------
  // Observer connects under MEMBERSHIP_INBOX_PREFIX (the prefix its cred grants sub over), matching the
  // membership feed — the same conn A shape the eviction scan reuses.
  observerNc = await connect({
    servers: SERVERS, authenticator: credsAuthenticator(enc(observerCreds)),
    inboxPrefix: MEMBERSHIP_INBOX_PREFIX, maxReconnectAttempts: 0,
  });
  evictorNc = await connect({
    servers: SERVERS, authenticator: credsAuthenticator(enc(evictorCreds)), maxReconnectAttempts: 0,
  });
  check(
    "membership-observer + connection-evictor sys creds mint and both connect (authorized)",
    observerCreds.length > 0 && evictorCreds.length > 0 && !observerNc.isClosed() && !evictorNc.isClosed(),
    { obs: observerCreds.length, ev: evictorCreds.length, obsClosed: observerNc.isClosed(), evClosed: evictorNc.isClosed() },
  );

  // ---------- connect P USER-MODE (sentinel + bearer → the callout mints its scoped grant + principal tag) ----------
  const nonceP = `ibx${randomUUID().replace(/-/g, "")}`;
  ncP = await connect({
    servers: SERVERS,
    authenticator: [credsAuthenticator(enc(callout.sentinelCreds)), tokenAuthenticator(bearerP)],
    maxReconnectAttempts: 0, timeout: 4000, name: nonceP, inboxPrefix: `_INBOX_${nonceP}`,
  });
  let pClosed = false;
  ncP.closed().then(() => { pClosed = true; }, () => { pClosed = true; }); // resolves when the KICK drops it (no reconnect)
  const principalP = principalKey(ownerU, "victim").key;
  check("user principal P connects live through the callout (valid bearer + granted actor)", !ncP.isClosed(), { principalP });

  // ---------- IDEMPOTENT NO-OP: a principal that is NOT live ----------
  // Uses the REAL observer, so its scanComplete:true ALSO proves the observer's CONNZ scan works (the
  // contrast that makes the fail-closed case below meaningful) — while P stays live and untouched.
  const ghost = principalKey(ownerU, "ghost").key;
  const noop = await evictDeniedPrincipal(observerNc, evictorNc, auth.account.pub, ghost, EVICT_OPTS);
  check(
    "idempotent no-op: evicting a not-live principal succeeds with no kick (kicked:0, verifiedGone:true, scanComplete:true)",
    noop.kicked === 0 && noop.remaining === 0 && noop.verifiedGone === true && noop.scanComplete === true,
    noop,
  );
  check("P is still live after the no-op (the scan targeted a different principal)", !ncP.isClosed() && !pClosed);

  // ---------- LIVE EVICTION: commit deny-new (ledger revoke), then KICK + verify ----------
  const denied = revokeActor(ledgerDir, ownerU, "victim"); // the mandatory precondition — a kicked client
  check("deny-new committed: P's ledger row is revoked (a reconnect would now be callout-denied)", denied === true);
  const evicted = await evictDeniedPrincipal(observerNc, evictorNc, auth.account.pub, principalP, EVICT_OPTS);
  check(
    "live eviction: P is verified gone by re-scan (verifiedGone:true, kicked>=1, scanComplete:true)",
    evicted.verifiedGone === true && evicted.kicked >= 1 && evicted.scanComplete === true && evicted.remaining === 0,
    evicted,
  );

  // ---------- THE REAL PROOF: the live connection P actually dropped ----------
  const dropped = await until(() => pClosed || ncP!.isClosed(), 2500);
  let pubThrew = false;
  try { ncP.publish("evict.probe", enc("still-alive?")); await ncP.flush(); } catch { pubThrew = true; }
  check("the live connection P is actually disconnected (closed / publish now throws) — not just reported gone", dropped || pubThrew, { dropped, pubThrew });

  // ---------- KICK routing / the evictor cred's $SYS.REQ.SERVER.*.KICK grant works ----------
  // Single-server here, so the scan's server_id is this broker and a successful KICK proves the grant
  // (a mis-scoped evictor would have thrown inside kick(), leaving kicked:0 and a note).
  check("evictor cred's $SYS.REQ.SERVER.*.KICK grant works (kicked>=1 on the scanned server, no refusal note)", evicted.kicked >= 1 && !evicted.note, { kicked: evicted.kicked, note: evicted.note });

  // ---------- FAIL-CLOSED partial scan: an observer that CANNOT read CONNZ ----------
  // Pass the evictorConn (kick-only, no CONNZ pub grant) as the observer → the scan request is broker-denied,
  // zero replies come back → a partial read is reported UNKNOWN, never a silent success.
  const blind = await evictDeniedPrincipal(evictorNc, evictorNc, auth.account.pub, principalP, EVICT_OPTS);
  check(
    "fail-closed: a CONNZ scan that under-reports is verifiedGone:false, scanComplete:false, note flags UNKNOWN (never silent success)",
    blind.verifiedGone === false && blind.scanComplete === false && /under-report|unknown/i.test(blind.note ?? ""),
    blind,
  );

  // ---------- MALFORMED CONNZ projection fails closed (mock — a real broker never sends these) ----------
  // A CONNZ reply that names an ATTRIBUTABLE principal but omits the route (server_id) or the cid can't
  // be KICKed — the scan must report UNKNOWN, never collapse the unkickable-but-live target into the
  // healthy not-live no-op. A real nats-server always sends both, so this is pinned with a tiny mock
  // connection that injects one synthetic reply into the scan's reply inbox.
  const mockObserver = (reply: unknown): NatsConnection => {
    const subs = new Map<string, (err: unknown, msg: { json: () => unknown }) => void>();
    return {
      subscribe: (subject: string, o: { callback: (err: unknown, msg: { json: () => unknown }) => void }) => {
        subs.set(subject, o.callback);
        return { unsubscribe() { subs.delete(subject); } };
      },
      publish: (_subject: string, _payload: unknown, o?: { reply?: string }) => {
        const cb = o?.reply ? subs.get(o.reply) : undefined;
        if (cb) cb(null, { json: () => reply });
      },
    } as unknown as NatsConnection;
  };
  const attributableName = `${principalP.split(".")[0]}-${principalP.split(".")[1]}`; // name-form authorized_user
  // (a) principal present, NO server_id → unroutable
  const noServer = await evictDeniedPrincipal(
    mockObserver({ data: { total: 1, connections: [{ cid: 7, authorized_user: attributableName }] } }),
    evictorNc, auth.account.pub, principalP, EVICT_OPTS,
  );
  check(
    "malformed fail-closed: an attributable connection with NO server_id → verifiedGone:false, scanComplete:false",
    noServer.verifiedGone === false && noServer.scanComplete === false,
    noServer,
  );
  // (b) principal present + server_id, but NO numeric cid → unroutable
  const noCid = await evictDeniedPrincipal(
    mockObserver({ data: { server_id: "SERVER1", total: 1, connections: [{ authorized_user: attributableName }] } }),
    evictorNc, auth.account.pub, principalP, EVICT_OPTS,
  );
  check(
    "malformed fail-closed: an attributable connection with NO numeric cid → verifiedGone:false, scanComplete:false",
    noCid.verifiedGone === false && noCid.scanComplete === false,
    noCid,
  );

  // ---------- PLANE-LIVENESS ORACLE (#29 HIGH 3, SPEC 13.13): the read-only CONNZ twin, LIVE ----------
  // The reclaim adjudicator the auth plane consults over the delivery-admin rail: two claimed
  // scanner tuples in, two bound verdicts + sweep completeness out. Proven against the SAME real
  // broker + real $SYS observer: a live static-JWT connection (CONNZ `authorized_user` = its user
  // nkey, exactly the plane-candidate shape) reads `live`; a fabricated cid reads `gone` under the
  // complete sweep; a RESTARTED-broker tuple (a server_id no current server carries) reads `gone`,
  // never a permanent UNKNOWN wedge; a closed connection reads `gone`; a blind observer (no CONNZ
  // grant) reads UNKNOWN with sweepComplete:false, never a silent absence.
  {
    const wId = newIdentity();
    const wCreds = await mintCreds(auth, wId, "provisioner");
    const w = await connect({ servers: SERVERS, authenticator: credsAuthenticator(enc(wCreds)), name: `cotal:auth-scan:${space}`, maxReconnectAttempts: 0 });
    const wInfo = w.info as { server_id?: string; client_id?: number } | undefined;
    const wTuple: PlaneConnTuple = { serverId: wInfo?.server_id ?? "", cid: wInfo?.client_id ?? 0, userNkey: wId.id };
    check("a plane-candidate-shaped connection exposes its (server_id, client_id) via INFO", wTuple.serverId.length > 0 && wTuple.cid > 0, wInfo);
    const deadTuple: PlaneConnTuple = { serverId: wTuple.serverId, cid: 999999901, userNkey: `U${"C".repeat(55)}` };
    const r1 = await observePlaneLiveness(observerNc!, auth.account.pub, { ledger: wTuple, records: deadTuple }, EVICT_OPTS);
    check("oracle: a live claimed connection reads LIVE; an absent cid reads GONE under the complete sweep",
      r1.ledger.state === "live" && r1.records.state === "gone" && r1.sweepComplete === true, r1);
    check("oracle: the reply echoes the queried tuples (bound, never a foreign description)",
      r1.ledger.tuple.userNkey === wTuple.userNkey && r1.records.tuple.cid === deadTuple.cid);
    // The whole-stack-crash rule: a claimed server_id from a PRIOR broker run never replies again,
    // and a connection dies with its server — complete sweep + nkey nowhere = conclusively gone.
    const restarted: PlaneConnTuple = { serverId: "NRESTARTEDBROKERRUN", cid: 7, userNkey: `U${"D".repeat(55)}` };
    const r2 = await observePlaneLiveness(observerNc!, auth.account.pub, { ledger: restarted, records: restarted }, EVICT_OPTS);
    check("oracle: a restarted-broker tuple reads GONE under a complete sweep (no permanent reclaim wedge)",
      r2.ledger.state === "gone" && r2.records.state === "gone" && r2.sweepComplete === true, r2);
    await w.close();
    const r3 = await observePlaneLiveness(observerNc!, auth.account.pub, { ledger: wTuple, records: wTuple }, EVICT_OPTS);
    check("oracle: a CLOSED claimed connection reads GONE (crash reclaim unblocks)",
      r3.ledger.state === "gone" && r3.records.state === "gone" && r3.sweepComplete === true, r3);
    const r4 = await observePlaneLiveness(evictorNc!, auth.account.pub, { ledger: wTuple, records: wTuple }, EVICT_OPTS);
    check("oracle fail-closed: a blind observer (no CONNZ grant) reads UNKNOWN with sweepComplete:false (never silent absence)",
      r4.ledger.state === "unknown" && r4.records.state === "unknown" && r4.sweepComplete === false, r4);
  }

  // ---------- RC-1 (SPEC 13.13): the reclaim verdict's SINGLE-SERVER PROOF ----------
  // CONNZ absence alone cannot distinguish a RESTARTED claimed server from a PARTITIONED one, so
  // `gone` is sound only when every responder DECLARES standalone topology (`server.cluster`
  // absent) and exactly one server replied. Deterministic edges over a scripted connection first
  // (the fact repro + its variants), then the declaration fact proven against a REAL 2-node
  // cluster (note the standalone half of the fact is ALREADY live-pinned above: r2/r3 read `gone`
  // only because the real standalone broker's envelope omits `cluster`).
  {
    const claimedB: PlaneConnTuple = { serverId: "SERVER_B_OLD_RUN", cid: 42, userNkey: `U${"E".repeat(55)}` };
    const scripted = (replies: unknown[], replyInboxes?: string[]) => {
      let cb: ((err: unknown, msg: { json: () => unknown }) => void) | undefined;
      return {
        subscribe: (_subject: string, o: { callback: (err: unknown, msg: { json: () => unknown }) => void }) => {
          cb = o.callback;
          return { unsubscribe: () => {} };
        },
        publish: (_subject: string, _payload: Uint8Array, o?: { reply?: string }) => {
          if (o?.reply !== undefined) replyInboxes?.push(o.reply);
          setTimeout(() => { for (const r of replies) cb?.(null, { json: () => r }); }, 0);
        },
      } as unknown as NatsConnection;
    };
    const empty = (server: Record<string, unknown> | undefined, server_id: string) =>
      ({ ...(server ? { server } : {}), data: { server_id, total: 0, connections: [] } });
    const q = { ledger: claimedB, records: claimedB };
    const r5 = await observePlaneLiveness(scripted([empty({ id: "SERVER_A" }, "SERVER_A")]), "ACC", q, EVICT_OPTS);
    check("discriminator: ONE standalone-declared responder + claimed server absent = GONE (restart reclaim, no wedge)",
      r5.ledger.state === "gone" && r5.records.state === "gone" && r5.sweepComplete === true, r5);
    const r6 = await observePlaneLiveness(scripted([empty({ id: "SERVER_A", cluster: "c1" }, "SERVER_A")]), "ACC", q, EVICT_OPTS);
    check("discriminator: a responder DECLARING cluster membership = UNKNOWN (the partition-steal is closed)",
      r6.ledger.state === "unknown" && r6.records.state === "unknown" && r6.sweepComplete === true && /cluster/i.test(r6.note ?? ""), r6);
    const r7 = await observePlaneLiveness(scripted([empty({ id: "SERVER_A" }, "SERVER_A"), empty({ id: "SERVER_C" }, "SERVER_C")]), "ACC", q, EVICT_OPTS);
    check("discriminator: multiple repliers (even standalone-shaped) = UNKNOWN (single-server unproven)",
      r7.ledger.state === "unknown" && r7.records.state === "unknown" && /distinct servers/i.test(r7.note ?? ""), r7);
    const r8 = await observePlaneLiveness(scripted([empty(undefined, "SERVER_A")]), "ACC", q, EVICT_OPTS);
    check("discriminator: a reply WITHOUT the server envelope = malformed (UNKNOWN, sweep incomplete)",
      r8.ledger.state === "unknown" && r8.records.state === "unknown" && r8.sweepComplete === false, r8);
    const r9 = await observePlaneLiveness(
      scripted([{ server: { id: "SERVER_A", cluster: "c1" }, data: { server_id: "SERVER_A", total: 1, connections: [{ cid: 42, authorized_user: claimedB.userNkey }] } }]), "ACC", q, EVICT_OPTS);
    check("discriminator: a live claimed nkey reads LIVE even under an unproven topology (fail-safe direction)",
      r9.ledger.state === "live" && r9.records.state === "live", r9);
    // FAIL-CLOSED reply validation (fact HIGH regressions): an API error, a non-string cluster
    // declaration, and an envelope/data server-id mismatch must each poison the sweep — never be
    // read as an empty standalone page that authorizes `gone`.
    const r10 = await observePlaneLiveness(
      scripted([{ server: { id: "SERVER_A" }, data: { server_id: "SERVER_A", total: 0, connections: [] }, error: { code: 500, description: "internal" } }]), "ACC", q, EVICT_OPTS);
    check("validation: a reply carrying an API `error` = malformed (UNKNOWN, sweep incomplete)",
      r10.ledger.state === "unknown" && r10.records.state === "unknown" && r10.sweepComplete === false, r10);
    const r11 = await observePlaneLiveness(
      scripted([{ server: { id: "SERVER_A", cluster: 42 }, data: { server_id: "SERVER_A", total: 0, connections: [] } }]), "ACC", q, EVICT_OPTS);
    check("validation: a NON-STRING cluster declaration = malformed, never read as standalone",
      r11.ledger.state === "unknown" && r11.records.state === "unknown" && r11.sweepComplete === false, r11);
    const r12 = await observePlaneLiveness(
      scripted([{ server: { id: "ENVELOPE" }, data: { server_id: "DATA", total: 0, connections: [] } }]), "ACC", q, EVICT_OPTS);
    check("validation: an envelope/data server-id MISMATCH = malformed (an unattributable page)",
      r12.ledger.state === "unknown" && r12.records.state === "unknown" && r12.sweepComplete === false, r12);
    // Concurrent-sweep isolation (fact HIGH): every sweep subscribes a per-call nonce inbox, so one
    // sweep's page reply can never satisfy or falsely complete another's round.
    const subsA: string[] = [], subsB: string[] = [];
    await observePlaneLiveness(scripted([empty({ id: "SERVER_A" }, "SERVER_A")], subsA), "ACC", q, EVICT_OPTS);
    await observePlaneLiveness(scripted([empty({ id: "SERVER_A" }, "SERVER_A")], subsB), "ACC", q, EVICT_OPTS);
    check("isolation: two sweeps use DISJOINT nonce reply inboxes (no cross-sweep cross-talk)",
      subsA.length > 0 && subsB.length > 0 && subsA.every((s) => !subsB.includes(s)), { subsA, subsB });
  }

  // The declaration FACT proven live: a REAL 2-node cluster's `$SYS` replies carry `server.cluster`
  // (nats-server sets it whenever clustering is configured), so the oracle refuses reclaim there.
  // If nats-server ever stopped declaring it, this check — not production — is what breaks.
  {
    // OS-assigned and distinct. The old draw (21000 + random 20000, four consecutive, unchecked)
    // overlapped the Linux ephemeral range 32768-60999 on 41% of picks, so a transient outbound
    // socket could hold a cluster port with no other suite involved; the ten-second wait then
    // reported the broker ("cluster node A did not come up"), not the taken port.
    const picked = new Set<number>();
    while (picked.size < 4) picked.add(await pickFreePort());
    const [pA, pB, cA, cB] = [...picked];
    const cdir = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
    const conf = (name: string, port: number, cport: number, routes: string) => [
      `port: ${port}`, `server_name: ${name}`,
      `cluster { name: livetest, listen: 127.0.0.1:${cport} ${routes} }`,
      `accounts { SYS: { users: [ { user: sys, password: sysp } ] }, APP: { users: [ { user: app, password: appp } ] } }`,
      `system_account: SYS`,
    ].join("\n");
    writeFileSync(join(cdir, "a.conf"), conf("evclA", pA, cA, ""));
    writeFileSync(join(cdir, "b.conf"), conf("evclB", pB, cB, `, routes: [ "nats-route://127.0.0.1:${cA}" ]`));
    const srvA = spawn("nats-server", ["-c", join(cdir, "a.conf")], { stdio: "ignore" });
    const srvB = spawn("nats-server", ["-c", join(cdir, "b.conf")], { stdio: "ignore" });
    // BOTH cluster nodes are owned, with their shared cluster dir. Owning one of two would leave
    // the other holding its port after a signal, while the run read as cleaned up.
    const releaseA = teardownOnSignal(srvA, cdir);
    const releaseB = teardownOnSignal(srvB, cdir);
    let sysNc: NatsConnection | undefined;
    try {
      let upA = false;
      for (let i = 0; i < 50; i++) { if (await isReachable(`nats://127.0.0.1:${pA}`)) { upA = true; break; } await wait(200); }
      if (!upA) throw new Error(`cluster node A did not come up on ${pA}`);
      sysNc = await connect({ servers: `nats://127.0.0.1:${pA}`, user: "sys", pass: "sysp", maxReconnectAttempts: 0 });
      const claimed: PlaneConnTuple = { serverId: "NDEADRUN", cid: 5, userNkey: `U${"F".repeat(55)}` };
      const rc = await observePlaneLiveness(sysNc, "APP", { ledger: claimed, records: claimed }, EVICT_OPTS);
      check("LIVE cluster: a real clustered broker DECLARES `server.cluster`, so reclaim reads UNKNOWN never GONE",
        rc.ledger.state === "unknown" && rc.records.state === "unknown" && /cluster/i.test(rc.note ?? ""), rc);
    } finally {
      try { await sysNc?.close(); } catch { /* draining */ }
      srvA.kill("SIGKILL"); // exact PIDs — never pkill nats-server
      srvB.kill("SIGKILL");
      await awaitExit(srvA);
      await awaitExit(srvB);
      rmSync(cdir, { recursive: true, force: true });
      releaseA();
      releaseB(); // last for the nested cluster
    }
  }

  console.log(`\nEVICT-LIVE SMOKE ${fail === 0 ? "OK ✅" : "FAILED ❌"}  (${pass} passed, ${fail} failed)`);
  if (fail) process.exitCode = 1;
} catch (e) {
  fail++;
  console.error("  ✗ scenario threw:", (e as Error).stack ?? (e as Error).message);
  process.exitCode = 1;
} finally {
  for (const nc of [ncP, observerNc, evictorNc, calloutNc]) { try { await nc?.close(); } catch { /* */ } }
  srv.kill("SIGKILL"); // exact PID — never pkill nats-server
  await awaitExit(srv);
  rmSync(dir, { recursive: true, force: true });
  releaseBroker(); // last: ownership is held until this teardown has actually finished
  rmSync(ledgerDir, { recursive: true, force: true });
}
process.exit(process.exitCode ?? 0);
