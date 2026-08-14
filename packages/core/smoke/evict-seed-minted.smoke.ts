/**
 * THE EVICTION LEG — does broker-side live eviction (the D5 lever) reach a **seed-minted**
 * credential the way it reaches a **bearer-exchanged** one?
 *
 * WHY THIS EXISTS. A separate measurement established that `revokeActor` (the actor-grant ledger)
 * does NOT bite a seed-minted credential: `revokeActor` deletes an on-disk JSON row and gates the
 * bearer-MINT and bearer-CONNECT boundaries, while `mintCreds` performs no authorize call at all
 * and RECORDS NO LEDGER ROW WHATEVER for this profile — only `endpoint-serve` enters durable
 * finalization (`provision.ts:819`), so there is no row for a revoke to delete. (An earlier version
 * of this comment said the mint "records into a different store (a JetStream KV)". That was FALSE
 * and is corrected here rather than left standing.) That left ONE open question: live eviction is
 * documented as "the D5 lever, not the ledger's" — but whether that lever can *target* a
 * seed-minted credential was never measured. This suite measures it by DRIVING it.
 *
 * WHAT HANGS ON IT, STATED AT ITS TRUE WIDTH. Not "whether a seed-minted send credential is
 * revocable AT ALL" — that framing is too strong and was corrected in review. TTL expiry and loaded
 * data-signing-key rotation (`provision.ts:367-390`) ARE deny-new boundaries; rotation is
 * coarse/account-wide. What this suite bears on is narrower and is the whole question: whether there
 * is an IMMEDIATE, PER-CREDENTIAL deny-new for a STILL-UNEXPIRED raw `operator` credential.
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
 * MUTATION PROOF — PREDICTED CELLS REGISTERED BEFORE THE MUTATION ATTEMPTS (named, never a count).
 * "Attempts" rather than "ran" is deliberate and literal: only ONE of the two ever executed.
 * The re-derivation of this suite is green, but green alone does not show the cells DEPEND on the
 * behaviour they name. TWO MUTATIONS WERE ATTEMPTED AND THEIR DISPOSITIONS DIFFER — one is a valid
 * killed mutation, the other never ran and proved nothing. They are NOT a matched pair and must not
 * be read as one:
 *   M1 — VALID AND KILLED. Non-equivalent by an observable change (`kicked` >=1 -> 0).
 *   M2 — INVALID / NOT PERFORMED. Never loaded, and its registered outcome was unobtainable in
 *        every case. Non-equivalence was never established because the mutation never executed.
 *   M1 — `evict.ts` target filter neutered (`first.conns.filter(() => false)`), so the CONNZ scan
 *        attributes nothing. Non-equivalent: `kicked` goes >=1 -> 0 and the connections stay live.
 *        PREDICTED RED: A2 (its `kicked >= 1` clause), A3 (no kick lands, so the cid is UNCHANGED
 *        and its `cidAfterA !== cidBeforeA` fails), and B1. PREDICTED STILL GREEN: A0, B0, A4, B2
 *        — and, the point of the exercise, **A1 STAYS GREEN**, because a scan that matches nothing
 *        returns exactly A1's shape (`kicked:0, scanComplete:true`, connection survives). A1 alone
 *        therefore cannot distinguish a working probe from a blind one; A2's `kicked >= 1` and A3's
 *        cid comparison are the clauses carrying that weight, and M1 is what proves it.
 *   M2 — `ledgerAuthorizeConnect` forced to allow. **INVALID / NOT PERFORMED. It proved NOTHING and
 *        must not be read as having validated the inverse control.** It failed twice over:
 *        (a) IT NEVER RAN. In the M2 artifact worktree (`/home/david/Cotal-wt-wc-smoke`),
 *            `node_modules/@cotal-ai/auth` resolves to `/home/david/Cotal/implementations/auth` —
 *            the SHARED checkout — so both the mutation and its unconditional-throw positive
 *            control were unloaded; the throw left the suite green, which is how the deadness was
 *            caught. THIS IS NOT A PROPERTY OF WORKTREES IN GENERAL, and saying so was this file's
 *            own over-claim: measured on the same box at the same time, the review worktree
 *            `/home/david/Cotal-wt-wc-rev-evict` resolves the SAME package LOCALLY, to
 *            `/home/david/Cotal-wt-wc-rev-evict/implementations/auth`. Two worktrees, one box,
 *            opposite resolutions.
 *            THE REMEDY FOLLOWS FROM THAT, and it is the portable part: you cannot infer this from
 *            "am I in a worktree". Before grading ANY cross-package mutation, RESOLVE THE MODULE
 *            PATH AND PLANT A POSITIVE CONTROL — or rebuild and prove the changed artifact.
 *        (b) EVEN LOADED IT COULD NOT HAVE REDDENED B2. `calloutPermissions` performs a SECOND
 *            fresh `resolveAcl(t)` read (`implementations/auth/src/permissions.ts:55-64`) which
 *            independently refuses the deleted row. So the registered prediction "B2 reddens" was
 *            unobtainable in every outcome — a single-outcome arm, which is not a control.
 *        The prediction is kept FALSIFIED rather than rewritten. **The executed negative control for
 *        the bearer arm is B3 (see its cell below), not M2.**
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
// A SECOND bearer actor that is granted and NEVER revoked. It exists only to make B2 falsifiable
// (see cell B3): B2 claims the bearer is refused a fresh connection BECAUSE the ledger's deny-new
// boundary read its revocation. The mutation that would have proven that (forcing
// `ledgerAuthorizeConnect` to allow) is UNRUNNABLE from a worktree — the edited file is never
// loaded, proven by a positive control in which an unconditional `throw` at the top of that
// function still left the suite green. So the same question is asked by varying the INPUT instead
// of the code, which needs no mutation and touches no shared checkout.
const keepRow = grantActor(ledgerDir, { owner: ownerU, actor: "keeparm", scope: [], ...ACL });

const issuer = createUserTokenIssuer({ issuer: ISS, key: await generateSigningKey() });
const bearerB = await issuer.issue({ owner: ownerU, space, actor: "bearerarm", scope: [], lifecycleUid: bearerRow.lifecycleUid, ttlSec: 300 });
const bearerKeep = await issuer.issue({ owner: ownerU, space, actor: "keeparm", scope: [], lifecycleUid: keepRow.lifecycleUid, ttlSec: 300 });

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

  // ---------- B3 — IS B2 A MEASUREMENT, OR A CONSTANT? ----------
  // B2 asserts a revoked bearer is REFUSED a fresh connection. On its own that is compatible with a
  // duller explanation: that NO bearer can reconnect here — a stale issuer, a dead callout after the
  // earlier evictions, an inbox-prefix collision — in which case B2 would be true for a reason that
  // has nothing to do with revocation, and the whole "the ledger's deny-new boundary bites, and it
  // has no seed-mode arm" contrast would be an artefact.
  //
  // So a SECOND bearer, granted and NEVER revoked, is driven through the SAME eviction path and
  // asked to reconnect. This is the input-varying twin of the mutation that could not run.
  //
  // THE LIMIT OF THIS CELL, drawn in review and recorded here so it is not over-claimed later: B3
  // validates the ACTOR-LEDGER SYSTEM BOUNDARY — that the refusal is revocation-caused rather than a
  // constant bearer-reconnect failure. It is NOT mutation proof of `ledgerAuthorizeConnect`
  // specifically, and it does not identify WHICH boundary refuses (authorize, the second
  // `resolveAcl`, or both). That indifference is exactly why it survives M2's defect (b), and it is
  // also exactly what it cannot tell you.
  //
  // PREDICTION REGISTERED BEFORE THE RUN: B3 GREEN — the never-revoked bearer reconnects.
  // WHAT WOULD REFUTE ME: B3 RED. That would mean bearers cannot reconnect here for reasons
  // unrelated to revocation, B2 would be a constant rather than a measurement, and the inverse
  // control would carry NO information — report a broken control, never a finding.
  const nonceK = `ibx${randomUUID().replace(/-/g, "")}`;
  const ncK = await connect({
    servers: SERVERS,
    authenticator: [credsAuthenticator(enc(callout.sentinelCreds)), tokenAuthenticator(bearerKeep)],
    maxReconnectAttempts: 0, timeout: 4000, name: nonceK, inboxPrefix: `_INBOX_${nonceK}`,
  });
  const principalK = principalKey(ownerU, "keeparm").key;
  const evictedK = await evictDeniedPrincipal(observerNc, evictorNc, auth.account.pub, principalK, EVICT_OPTS);
  try { await ncK.close(); } catch { /* closing */ }

  let keepReconnected = false;
  let keepReconnectErr = "";
  let ncK2: NatsConnection | undefined;
  try {
    const nonceK2 = `ibx${randomUUID().replace(/-/g, "")}`;
    ncK2 = await connect({
      servers: SERVERS,
      authenticator: [credsAuthenticator(enc(callout.sentinelCreds)), tokenAuthenticator(bearerKeep)],
      maxReconnectAttempts: 0, timeout: 4000, name: nonceK2, inboxPrefix: `_INBOX_${nonceK2}`,
    });
    keepReconnected = !ncK2.isClosed();
  } catch (e) { keepReconnectErr = (e as Error)?.message ?? String(e); }
  if (ncK2) await ncK2.close();

  check(
    "B3 control: a granted, NEVER-REVOKED bearer evicted through the SAME path DOES reconnect — so B2's refusal is caused by the REVOCATION and is a measurement, not a constant",
    keepReconnected === true && evictedK.kicked >= 1,
    { keepReconnected, keepReconnectErr, evictedK },
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
