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
import { evictDeniedPrincipal } from "../src/evict.js";
import {
  createCalloutAuth, startAuthCallout, calloutPermissions,
  createUserTokenIssuer, generateSigningKey,
  deriveOwnerToken, grantActor, revokeActor, ledgerAclResolver, ledgerAuthorizeConnect,
} from "@cotal-ai/auth";
import { pickFreePort } from "./_free-port.js";

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
const dir = mkdtempSync(join(tmpdir(), "cotal-evictlive-"));
writeFileSync(
  join(dir, "server.conf"),
  serverConfig(auth, { port: PORT, storeDir: join(dir, "js"), extraAccounts: [{ pub: callout.account.pub, jwt: callout.account.jwt }] }),
);
const srv = spawn("nats-server", ["-c", join(dir, "server.conf")], { stdio: "ignore" });
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
grantActor(ledgerDir, { owner: ownerU, actor: "victim", scope: [], ...ACL });

const issuer = createUserTokenIssuer({ issuer: ISS, key: await generateSigningKey() });
const bearerP = await issuer.issue({ owner: ownerU, space, actor: "victim", scope: [], ttlSec: 300 });

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
  rmSync(ledgerDir, { recursive: true, force: true });
}
process.exit(process.exitCode ?? 0);
