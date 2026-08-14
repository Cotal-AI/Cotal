/**
 * THE EVICTION LEG — does broker-side live eviction (the D5 lever) reach a **seed-minted**
 * credential the way it reaches a **bearer-exchanged** one?
 *
 * WHY THIS EXISTS. A separate measurement established that `revokeActor` (the actor-grant ledger)
 * does NOT bite a seed-minted credential: `revokeActor` deletes an on-disk JSON row and gates the
 * bearer-MINT and bearer-CONNECT boundaries, while `mintCreds` performs no authorize call at all
 * and records into a different store (a JetStream KV). That left ONE open question, and the whole
 * question of whether a seed-minted send credential is revocable AT ALL hangs on it: live eviction
 * is documented as "the D5 lever, not the ledger's" — but whether that lever can *target* a
 * seed-minted credential was never measured. This suite measures it by DRIVING it.
 *
 * WHAT WOULD REFUTE THE PROBE (stated before the run, not after):
 *   - If cell A1 fails — the seed connection dies when a DIFFERENT principal is evicted — the probe
 *     is over-broad, its arms cannot differ, and NOTHING below means anything. Report a broken
 *     probe, never a finding.
 *   - If cell B1 fails — the bearer connection survives the same eviction path — the path itself is
 *     broken, and a null result on the seed arm would be an artefact, not a property.
 *   Only with A1 and B1 both holding do A2/A3/A4 carry information: A1 proves the probe can observe
 *   SURVIVAL, B1 proves it can observe DEATH. An arm that can only ever report one outcome is not a
 *   control.
 *
 * THE TWO ARMS, through the SAME `evictDeniedPrincipal` path, on the SAME broker:
 *   ARM A (subject)         — `mintCreds(auth, newIdentity(), "operator")`: the exact shape a
 *                             seed-mode send surface would use. No actor-ledger row exists for it.
 *   ARM B (inverse control) — callout-minted (sentinel + bearer): the known-good shape, whose
 *                             eviction is already proven elsewhere and is re-derived here so the
 *                             two arms are compared in one process against one broker.
 *
 * AND THE LEG THAT DECIDES WHETHER EVICTION IS A REVOCATION LEVER AT ALL (A4 vs B2): a KICK ends a
 * live connection; it does not invalidate a credential. So each arm is asked to RECONNECT afterwards
 * with the same material. If the seed credential simply reconnects, eviction is a disconnect button
 * and not a revocation lever, and that distinction is the ruling.
 *
 * MUTATION PROOF — PREDICTED CELLS REGISTERED BEFORE THE MUTATIONS RAN (named, never a count).
 * The re-derivation of this suite is green, but green alone does not show the cells DEPEND on the
 * behaviour they name. Two mutations, each proven non-equivalent by an observable change:
 *   M1 — `evict.ts` target filter neutered (`first.conns.filter(() => false)`), so the CONNZ scan
 *        attributes nothing. Non-equivalent: `kicked` goes >=1 -> 0 and the connections stay live.
 *        PREDICTED RED: A2 (its `kicked >= 1` clause), A3 (no kick lands, so the cid is UNCHANGED
 *        and its `cidAfterA !== cidBeforeA` fails), and B1. PREDICTED STILL GREEN: A0, B0, A4, B2
 *        — and, the point of the exercise, **A1 STAYS GREEN**, because a scan that matches nothing
 *        returns exactly A1's shape (`kicked:0, scanComplete:true`, connection survives). A1 alone
 *        therefore cannot distinguish a working probe from a blind one; A2's `kicked >= 1` and A3's
 *        cid comparison are the clauses carrying that weight, and M1 is what proves it.
 *   M2 — `ledgerAuthorizeConnect` forced to allow. Non-equivalent: the revoked bearer connects.
 *        PREDICTED RED: B2 only. Everything else green. This proves the inverse control's arms can
 *        genuinely differ, so B2's refusal is a measurement and not a constant.
 * Note the asymmetry that makes A3 informative in BOTH directions: it reddens under M1 (the kick
 * never landed) and it would also redden if a deny-new boundary for seed-minted credentials ever
 * landed (the holder would stay gone). Green here means precisely "kicked, and already back".
 *
 * COTAL_HOME-free; ephemeral broker from a scratch dir; kills only the nats-server it starts, by
 * exact PID, and awaits its exit before deleting the scratch. Asserts its broker URL is not the live
 * host as its FIRST action.
 * Run: npx tsx packages/core/smoke/evict-seed-minted.smoke.ts   (needs nats-server on PATH)
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
  principalKey, DEV_OWNER, MEMBERSHIP_INBOX_PREFIX,
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

// FIRST ACTION, before any broker work: this suite must never touch the live host.
//
// Two separate things are enforced here, and conflating them would be a mistake. (1) The URL this
// suite actually DIALS must not be the live host — that is the real guarantee, and it is asserted
// on `SERVERS`, the only value passed to `connect()`. (2) A manager-hosted seat exports
// `COTAL_SERVERS=nats://broker.cotal.ai:4222` into every child process it spawns, so the inherited
// environment points at the live broker even though this suite never reads it. Refusing to run on
// account of (2) would be over-broad — the variable is unused here. Instead the inherited
// connection environment is DELETED, so no code path reachable from this process (a library
// default, a helper added later) can quietly pick the live host up. Nothing has connected yet at
// this point, so deleting is safe.
const LIVE_HOST = "broker.cotal.ai";
if (SERVERS.includes(LIVE_HOST))
  throw new Error(`refusing to run against the live broker (${LIVE_HOST}): this suite is ephemeral-only`);
for (const k of ["COTAL_SERVERS", "COTAL_CREDS", "COTAL_SPACE", "COTAL_ID", "COTAL_LIFECYCLE_UID"]) delete process.env[k];
if (process.env.COTAL_SERVERS !== undefined)
  throw new Error("inherited COTAL_SERVERS survived deletion; refusing to run with a live-broker default in scope");

const enc = (s: string) => new TextEncoder().encode(s);
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (cond: () => boolean, ms = 2500): Promise<boolean> => {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await wait(25);
  return cond();
};
const EVICT_OPTS = { maxWaitMs: 1500, settleMs: 200, maxVerifyRounds: 3 } as const;

let pass = 0, fail = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ FAIL: ${name}`, extra ?? ""); }
};

const space = `evictseed-${randomUUID().slice(0, 8)}`;
const auth = await createSpaceAuth(space);
// The two scoped $SYS creds are mintable ONLY while the in-memory $SYS signing seed is alive.
const observerId = newIdentity(), evictorId = newIdentity();
const observerCreds = await mintMembershipObserverCreds(auth, observerId);
const evictorCreds = await mintConnectionEvictorCreds(auth, evictorId);

const callout = await createCalloutAuth({ space, operatorSeed: auth.operator.seed, accountPub: auth.account.pub });
const dir = mkdtempSync(join(tmpdir(), "cotal-evictseed-"));
writeFileSync(
  join(dir, "server.conf"),
  serverConfig(auth, [auth], { transport: { kind: "plaintext" }, port: PORT, storeDir: join(dir, "js"), extraAccounts: [{ pub: callout.account.pub, jwt: callout.account.jwt }] }),
);
const srv = spawn("nats-server", ["-c", join(dir, "server.conf")], { stdio: "ignore" });
const awaitExit = (proc: ReturnType<typeof spawn>, timeoutMs = 3000): Promise<void> =>
  new Promise((resolve) => {
    if (proc.exitCode !== null || proc.signalCode !== null) return resolve();
    proc.once("exit", () => resolve());
    setTimeout(resolve, timeoutMs);
  });

// The actor ledger + the one owner the BEARER arm belongs to.
const SECRET = "s".repeat(32);
const ISS = "https://auth.cotal.test";
const ledgerDir = mkdtempSync(join(tmpdir(), "cotal-evictseed-ledger-"));
const ownerU = deriveOwnerToken(SECRET, "idp-subject-bearer-arm");
const ACL = { allowSubscribe: ["general"], allowPublish: ["general"] };
const bearerRow = grantActor(ledgerDir, { owner: ownerU, actor: "bearerarm", scope: [], ...ACL });

const issuer = createUserTokenIssuer({ issuer: ISS, key: await generateSigningKey() });
const bearerB = await issuer.issue({ owner: ownerU, space, actor: "bearerarm", scope: [], lifecycleUid: bearerRow.lifecycleUid, ttlSec: 300 });

let calloutNc: NatsConnection | undefined, observerNc: NatsConnection | undefined,
  evictorNc: NatsConnection | undefined, ncA: NatsConnection | undefined, ncB: NatsConnection | undefined;
try {
  let up = false;
  for (let i = 0; i < 50; i++) { if (await isReachable(SERVERS)) { up = true; break; } await wait(200); }
  if (!up) throw new Error(`nats-server did not come up on ${PORT}`);

  await setupSpaceStreams({ servers: SERVERS, space, creds: await mintCreds(auth, newIdentity(), "provisioner") });

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

  observerNc = await connect({
    servers: SERVERS, authenticator: credsAuthenticator(enc(observerCreds)),
    inboxPrefix: MEMBERSHIP_INBOX_PREFIX, maxReconnectAttempts: 0,
  });
  evictorNc = await connect({
    servers: SERVERS, authenticator: credsAuthenticator(enc(evictorCreds)), maxReconnectAttempts: 0,
  });

  // ---------- ARM A: the SEED-MINTED credential (the send-surface shape) ----------
  // `mintCreds` derives the principal as { owner: DEV_OWNER, actor: identity.id } (provision.ts
  // principalOf), so the principal dot-form is computed the same way the mint computes it rather
  // than copied from a document.
  const idA = newIdentity();
  const seedCreds = await mintCreds(auth, idA, "operator");
  const principalA = principalKey(DEV_OWNER, idA.id).key;
  ncA = await connect({
    servers: SERVERS, authenticator: credsAuthenticator(enc(seedCreds)),
    maxReconnectAttempts: 0, timeout: 4000,
  });
  let aClosed = false;
  ncA.closed().then(() => { aClosed = true; }, () => { aClosed = true; });
  const cidBeforeA = (ncA.info as { client_id?: number } | undefined)?.client_id;
  check("A0: a seed-minted `operator` credential connects live at the broker", !ncA.isClosed(), { principalA, cidBeforeA });

  // ---------- ARM B: the BEARER-EXCHANGED connection (inverse control) ----------
  const nonceB = `ibx${randomUUID().replace(/-/g, "")}`;
  ncB = await connect({
    servers: SERVERS,
    authenticator: [credsAuthenticator(enc(callout.sentinelCreds)), tokenAuthenticator(bearerB)],
    maxReconnectAttempts: 0, timeout: 4000, name: nonceB, inboxPrefix: `_INBOX_${nonceB}`,
  });
  let bClosed = false;
  ncB.closed().then(() => { bClosed = true; }, () => { bClosed = true; });
  const principalB = principalKey(ownerU, "bearerarm").key;
  check("B0: a bearer-exchanged connection connects live through the callout", !ncB.isClosed(), { principalB });

  // ---------- A1 — THE CONTROL THAT LETS THE ARMS DIFFER ----------
  // Evict an unrelated, not-live principal with the REAL observer. If the seed connection survives
  // this, the probe demonstrably CAN report survival; if it dies here, every later "gone" is an
  // artefact of an over-broad scan and this suite proves nothing.
  const ghost = principalKey(DEV_OWNER, newIdentity().id).key;
  const noop = await evictDeniedPrincipal(observerNc, evictorNc, auth.account.pub, ghost, EVICT_OPTS);
  check(
    "A1 control: evicting a DIFFERENT principal is a clean no-op (kicked:0, scanComplete:true) and the seed connection SURVIVES — the probe can observe survival",
    noop.kicked === 0 && noop.scanComplete === true && !ncA.isClosed() && !aClosed,
    { noop, aClosed },
  );

  // ---------- A2 — is a seed-minted principal even ATTRIBUTABLE to the eviction scan? ----------
  // Note what is deliberately NOT done here: no `revokeActor`. A seed-minted credential HAS no
  // actor-ledger row to revoke — that is the whole finding this leg follows from. If eviction still
  // reaches it, the lever exists and is simply not the ledger's.
  const evictedA = await evictDeniedPrincipal(observerNc, evictorNc, auth.account.pub, principalA, EVICT_OPTS);
  check(
    "A2: the seed-minted principal is ATTRIBUTABLE and verified gone by re-scan (verifiedGone:true, kicked>=1, scanComplete:true)",
    evictedA.verifiedGone === true && evictedA.kicked >= 1 && evictedA.scanComplete === true && evictedA.remaining === 0,
    evictedA,
  );
  const droppedA = await until(() => aClosed || ncA!.isClosed(), 2500);
  let aPubThrew = false;
  try { ncA.publish("evict.probe", enc("still-alive?")); await ncA.flush(); } catch { aPubThrew = true; }
  // The cid is the discriminator between "never kicked" and "kicked and already back". A KICK ends
  // one TCP connection; the client then dials again on its own and the broker issues a NEW cid. So
  // a LIVE connection carrying a DIFFERENT cid than before the eviction is proof of a completed
  // kick+reconnect round trip, while an unchanged cid would mean the KICK never landed on it (and
  // would make A2's kicked>=1 the thing to distrust).
  const cidAfterA = (ncA.info as { client_id?: number } | undefined)?.client_id;
  // REGISTERED PREDICTION A3 WAS "the connection actually dropped and STAYS dropped". It was
  // FALSIFIED, and the falsification is the finding rather than a probe fault: the connection did
  // drop (the cid changed, so the KICK landed) and was ALREADY BACK before the check ran. The cell
  // below therefore asserts what was measured, not what was predicted.
  //
  // THIS CELL CHARACTERIZES A DEFECT AND IS GREEN WHILE THE DEFECT EXISTS. If a deny-new boundary
  // for seed-minted credentials ever lands, this cell goes RED — that is intended, and whoever sees
  // it red should read this header and the design note rather than "fix" the cell.
  check(
    "A3: the seed-minted connection does NOT stay gone — it is live again under a NEW cid, so eviction's `verifiedGone:true` described a GAP, not a departure (registered prediction A3 'stays dropped' FALSIFIED)",
    !ncA.isClosed() && typeof cidAfterA === "number" && typeof cidBeforeA === "number" && cidAfterA !== cidBeforeA,
    { closed: ncA.isClosed(), droppedA, aPubThrew, cidBeforeA, cidAfterA },
  );

  // ---------- B1 — the inverse control through the SAME path ----------
  const deniedB = revokeActor(ledgerDir, ownerU, "bearerarm");
  const evictedB = await evictDeniedPrincipal(observerNc, evictorNc, auth.account.pub, principalB, EVICT_OPTS);
  const droppedB = await until(() => bClosed || ncB!.isClosed(), 2500);
  check(
    "B1 control: the bearer-exchanged connection is verified gone AND actually dropped through the same eviction path",
    deniedB === true && evictedB.verifiedGone === true && evictedB.kicked >= 1 && (droppedB || bClosed),
    { deniedB, evictedB, droppedB },
  );

  // ---------- A4 vs B2 — DISCONNECT BUTTON, OR REVOCATION LEVER? ----------
  // A KICK ends a connection; it does not invalidate credential material. The question that decides
  // whether eviction is a usable revocation lever is whether the evicted holder can simply come
  // back with the same material it already holds.
  let seedReconnected = false;
  let seedReconnectErr = "";
  let ncA2: NatsConnection | undefined;
  try {
    ncA2 = await connect({
      servers: SERVERS, authenticator: credsAuthenticator(enc(seedCreds)),
      maxReconnectAttempts: 0, timeout: 4000,
    });
    seedReconnected = !ncA2.isClosed();
  } catch (e) { seedReconnectErr = (e as Error)?.message ?? String(e); }
  if (ncA2) await ncA2.close();

  let bearerReconnected = false;
  let bearerReconnectErr = "";
  let ncB2: NatsConnection | undefined;
  try {
    const nonceB2 = `ibx${randomUUID().replace(/-/g, "")}`;
    ncB2 = await connect({
      servers: SERVERS,
      authenticator: [credsAuthenticator(enc(callout.sentinelCreds)), tokenAuthenticator(bearerB)],
      maxReconnectAttempts: 0, timeout: 4000, name: nonceB2, inboxPrefix: `_INBOX_${nonceB2}`,
    });
    bearerReconnected = !ncB2.isClosed();
  } catch (e) { bearerReconnectErr = (e as Error)?.message ?? String(e); }
  if (ncB2) await ncB2.close();

  check(
    "B2 control: after revoke + evict, the BEARER credential is refused a fresh connection (the ledger's deny-new boundary bites)",
    bearerReconnected === false, { bearerReconnected, bearerReconnectErr },
  );
  check(
    "A4: after eviction, the SEED-MINTED credential RECONNECTS with the same material — eviction ends a connection, it does not revoke the credential",
    seedReconnected === true, { seedReconnected, seedReconnectErr },
  );

  console.log(`\n  principal A (seed-minted): ${principalA}`);
  console.log(`  principal B (bearer):      ${principalB}`);
} finally {
  for (const nc of [ncA, ncB, observerNc, evictorNc, calloutNc]) { try { await nc?.close(); } catch { /* closing */ } }
  try { srv.kill("SIGTERM"); } catch { /* already gone */ }
  await awaitExit(srv);
  rmSync(dir, { recursive: true, force: true });
  rmSync(ledgerDir, { recursive: true, force: true });
}

console.log(`\n${fail === 0 ? "PASS" : "FAIL"} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
