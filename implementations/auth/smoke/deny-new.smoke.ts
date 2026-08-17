/**
 * R1 connect-arm DENY-NEW live smoke (SPEC 13.1) — proves the PRODUCTION composition end-to-end:
 * the auth service's authority plane ({@link openAuthAuthorityPlane}, exactly what the daemon
 * runs) boots on a VIRGIN space (store ensure + registry + supervised reader), the exchange arm
 * mints the incarnation's root credential RELEASE-LAST and stamps `act.credentialId`, and the
 * connect arm requires the LIVE `cred.` row through the leader-served, shape-proved reader:
 *
 *  - happy path: an exchanged-shape bearer (uid + stamped credid) CONNECTS; the ensure is
 *    idempotent (same credid on re-exchange);
 *  - claimless bearer (no `act.credentialId`) → DENIED (the hard cut; no grace, no skip);
 *  - never-issued credid → DENIED (absent row is deny, not a fallback);
 *  - minted-but-unstamped credid (the crash-pin window: row durable, head CAS never ran) →
 *    DENIED (root head equality is the belt over release-last);
 *  - REVOKED row → the NEXT connect is DENIED and the exchange arm REFUSES to re-mint
 *    (rotation is the barrier's job, never a re-mint);
 *  - same-alias re-grant at a NEW uid while the predecessor incarnation is live → the EXCHANGE
 *    refuses loudly naming the takeover gap (the R1 residual; no barrier-less head flip);
 *  - plane closed (reader down) → connects DENY (fail-closed, no file-only fallback).
 *
 * Run: pnpm smoke:deny-new:auth   (needs nats-server on PATH; local-only)
 */
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, credsAuthenticator, type NatsConnection, type ConnectionOptions } from "@nats-io/transport-node";
import { createSpaceAuth, isReachable, serverConfig, standaloneConnectOpts, mintLifecycleUid } from "@cotal-ai/core";
import {
  calloutPermissions, createCalloutAuth, createUserTokenIssuer, deriveOwnerToken, generateSigningKey,
  grantManagedActor, ledgerAclResolver, newActorToken, openAuthAuthorityPlane, startAuthCallout,
} from "../src/index.js";
import { openLifecycleRegistry, registryStores } from "../src/lifecycle-registry.js";
import { credRowKey, finalizeAgentMint, markLedgerRowRevoked, stageAgentMint } from "../src/credential-ledger.js";
import { authorityWriterGrants, openAuthorityClient } from "../src/authority-client.js";
import { ROOT_CREDENTIAL_TTL_MS } from "../src/root-credential.js";
import { pickFreePort } from "../../../packages/core/smoke/_free-port.js";
import { SMOKE_BROKER_TOKEN, teardownOnSignal } from "@cotal-ai/smoke-kit";

const PORT = await pickFreePort();
const SERVERS = `nats://127.0.0.1:${PORT}`;
const enc = (s: string) => new TextEncoder().encode(s);
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const awaitExit = (proc: ReturnType<typeof spawn>, timeoutMs = 3000): Promise<void> =>
  new Promise((resolve) => {
    if (proc.exitCode !== null || proc.signalCode !== null) return resolve();
    proc.once("exit", () => resolve());
    setTimeout(resolve, timeoutMs);
  });
let pass = 0, fail = 0;
const check = (name: string, cond: boolean, extra?: unknown) => { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ FAIL: ${name}`, extra ?? ""); } };
async function rejects(name: string, fn: () => Promise<unknown>, needle?: string) {
  try { await fn(); check(`${name} (expected rejection)`, false); }
  catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    check(needle && !msg.includes(needle) ? `${name} (wrong reason: ${msg})` : name, !needle || msg.includes(needle));
  }
}

const space = `denynew-${randomUUID().slice(0, 8)}`;
const auth = await createSpaceAuth(space);
const callout = await createCalloutAuth({ space, operatorSeed: auth.operator.seed, accountPub: auth.account.pub });
const tmp = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
const dir = join(tmp, "state");
writeFileSync(join(tmp, "server.conf"), serverConfig(auth, [auth], { transport: { kind: "plaintext" }, port: PORT, storeDir: join(tmp, "js"), extraAccounts: [{ pub: callout.account.pub, jwt: callout.account.jwt }] }));
const srv = spawn("nats-server", ["-c", join(tmp, "server.conf")], { stdio: "ignore" });
const releaseBroker = teardownOnSignal(srv, tmp);

const ISS = "https://auth.cotal.test";
const OWNER = deriveOwnerToken("s".repeat(32), "better-auth|human-1");
const dataAccount = { pub: auth.account.pub, signingSeed: auth.account.signingSeed };
const quiet = () => {};

/** A user-mode connect attempt through the callout — the enforcement boundary under test. */
async function tryConnect(bearer: string): Promise<"connected" | "denied"> {
  try {
    const nc = await connect({ servers: SERVERS, reconnect: false, ...(standaloneConnectOpts({ bearer, sentinelCreds: callout.sentinelCreds, tls: false }) as Partial<ConnectionOptions>) });
    await nc.close();
    return "connected";
  } catch (e) {
    const msg = (e as Error)?.message ?? String(e);
    if (/authorization|authentication/i.test(msg)) return "denied";
    throw e;
  }
}

let plane: Awaited<ReturnType<typeof openAuthAuthorityPlane>> | undefined;
let calloutNc: NatsConnection | undefined;
let smokeWriter: Awaited<ReturnType<typeof openAuthorityClient>> | undefined;
try {
  let up = false;
  for (let i = 0; i < 50; i++) { if (await isReachable(SERVERS)) { up = true; break; } await wait(200); }
  if (!up) throw new Error(`nats-server did not come up on ${PORT}`);

  // ---- the authority plane boots on a VIRGIN space (ensure + registry + proved reader) ----
  plane = await openAuthAuthorityPlane({ server: SERVERS, space, dir, dataAccount, log: quiet });
  check("the authority plane boots on a virgin space (stores ensured, reader shape-proved)", true);
  // SEQUENTIAL re-boot (close first): a CONCURRENT second plane now correctly REFUSES under the
  // §13.13 plane claim (plane-claim.smoke.ts proves that face); what this asserts is that a
  // RESTART verifies the existing stores instead of failing the re-create, over the released row.
  await plane.close();
  plane = await openAuthAuthorityPlane({ server: SERVERS, space, dir, dataAccount, log: quiet });
  check("a re-boot verifies the existing stores instead of failing the re-create (create-or-verify), over the released plane claim", true);

  // ---- the file grant + the exchange arm's root-credential ensure ----
  const uid1 = mintLifecycleUid();
  grantManagedActor(dir, { owner: OWNER, actor: "worker", scope: [], allowSubscribe: ["general"], allowPublish: ["general"], tokenHash: newActorToken().tokenHash, lifecycleUid: uid1 });
  const credid1 = await plane.mintConnectCredential({ owner: OWNER, actor: "worker", lifecycleUid: uid1 });
  check("first exchange mints the incarnation's root credential", typeof credid1 === "string" && credid1.length > 0, credid1);
  check("the ensure is idempotent (a re-exchange stamps the SAME credential)", (await plane.mintConnectCredential({ owner: OWNER, actor: "worker", lifecycleUid: uid1 })) === credid1);

  // ---- the callout, composed EXACTLY as the daemon composes it ----
  const key = await generateSigningKey();
  const issuer = createUserTokenIssuer({ issuer: ISS, key });
  calloutNc = await connect({ servers: SERVERS, authenticator: credsAuthenticator(enc(callout.calloutCreds)) });
  startAuthCallout(calloutNc as never, {
    xkeySeed: callout.xkey.seed,
    authAccount: { pub: callout.account.pub, signingSeed: callout.account.signingSeed },
    dataAccount,
    space,
    token: { key: issuer.localKeySet(), issuer: ISS },
    authorizeActor: plane.authorizeConnect,
    permissionsFor: calloutPermissions(ledgerAclResolver(dir)),
    log: quiet,
  });
  await calloutNc.flush();

  const bearer1 = await issuer.issue({ owner: OWNER, space, actor: "worker", scope: [], lifecycleUid: uid1, credentialId: credid1 });
  check("HAPPY: a bearer carrying the stamped credential CONNECTS", (await tryConnect(bearer1)) === "connected");

  // POST-SUCCESSFUL-HEAD crash re-export (incarnation-wide root, ratified): after the head's
  // current-root CAS succeeded (and the bearer bytes possibly released), a crash + re-exchange
  // re-stamps the SAME id and it connects — that id IS the incarnation's live root, nothing loose
  // to revoke. This is the ratified model, distinct from a per-exchange fresh-id design.
  const reExchanged = await plane.mintConnectCredential({ owner: OWNER, actor: "worker", lifecycleUid: uid1 });
  check("POST-HEAD CRASH: re-exchange re-stamps the SAME incarnation root id", reExchanged === credid1, reExchanged);
  check("POST-HEAD CRASH: a bearer minted from the re-stamped id CONNECTS (re-export is by design)",
    (await tryConnect(await issuer.issue({ owner: OWNER, space, actor: "worker", scope: [], lifecycleUid: uid1, credentialId: reExchanged }))) === "connected");

  const claimless = await issuer.issue({ owner: OWNER, space, actor: "worker", scope: [], lifecycleUid: uid1 });
  check("CLAIMLESS: a bearer without act.credentialId is DENIED (the hard cut)", (await tryConnect(claimless)) === "denied");

  const ghost = await issuer.issue({ owner: OWNER, space, actor: "worker", scope: [], lifecycleUid: uid1, credentialId: "0".repeat(26) });
  check("ABSENT ROW: a never-issued credential id is DENIED", (await tryConnect(ghost)) === "denied");

  // ---- the crash-pin window: a minted-but-unstamped root credid (row durable, no head CAS) ----
  smokeWriter = await openAuthorityClient({ server: SERVERS, space, dataAccount, label: `cotal:smoke-writer:${space}`, grants: (id) => authorityWriterGrants(space, id), log: quiet });
  const reg = await openLifecycleRegistry(smokeWriter.nc, space);
  const credid2 = mintLifecycleUid();
  await finalizeAgentMint(reg, await stageAgentMint(reg, { lifecycleUid: uid1, credentialId: credid2, holderPrincipal: `${OWNER}.worker`, sourceChain: ["root"], exp: Date.now() + ROOT_CREDENTIAL_TTL_MS }));
  const unstamped = await issuer.issue({ owner: OWNER, space, actor: "worker", scope: [], lifecycleUid: uid1, credentialId: credid2 });
  check("UNSTAMPED/SUPERSEDED ROOT: an active row the head never stamped is DENIED (head equality)", (await tryConnect(unstamped)) === "denied");

  // ---- revocation bites the NEXT connect, and the exchange refuses to re-mint ----
  await markLedgerRowRevoked(registryStores(reg).authKv, credRowKey(uid1, credid1));
  check("REVOKED: the same previously-connecting bearer is DENIED on its next connect", (await tryConnect(bearer1)) === "denied");
  await rejects("a revoked root refuses the exchange (rotation is the barrier's job, never a re-mint)",
    () => plane!.mintConnectCredential({ owner: OWNER, actor: "worker", lifecycleUid: uid1 }), "barrier");

  // ---- the R1 takeover gap: a same-alias re-grant at a NEW uid refuses the exchange loudly ----
  const uid2 = mintLifecycleUid();
  grantManagedActor(dir, { owner: OWNER, actor: "worker", scope: [], allowSubscribe: ["general"], allowPublish: ["general"], tokenHash: newActorToken().tokenHash, lifecycleUid: uid2 });
  await rejects("UID TRANSITION: re-granting a live alias refuses the exchange naming the takeover barrier",
    () => plane!.mintConnectCredential({ owner: OWNER, actor: "worker", lifecycleUid: uid2 }), "takeover");

  // ---- reader down => deny (fail-closed; no file-only fallback) ----
  const uidB = mintLifecycleUid();
  grantManagedActor(dir, { owner: OWNER, actor: "backup", scope: [], allowSubscribe: ["general"], allowPublish: ["general"], tokenHash: newActorToken().tokenHash, lifecycleUid: uidB });
  const credidB = await plane.mintConnectCredential({ owner: OWNER, actor: "backup", lifecycleUid: uidB });
  const bearerB = await issuer.issue({ owner: OWNER, space, actor: "backup", scope: [], lifecycleUid: uidB, credentialId: credidB });
  check("control: the fresh actor's bearer CONNECTS while the plane is up", (await tryConnect(bearerB)) === "connected");
  await plane.close();
  check("READER DOWN: the same valid bearer is DENIED once the plane is closed (fail-closed)", (await tryConnect(bearerB)) === "denied");
  plane = undefined;

  console.log(`\nDENY-NEW SMOKE ${fail === 0 ? "OK ✅" : "FAILED ❌"}  (${pass} passed, ${fail} failed)`);
  if (fail) process.exitCode = 1;
} catch (e) {
  fail++;
  console.error("  ✗ smoke crashed:", e instanceof Error ? (e.stack ?? e.message) : e);
  process.exitCode = 1;
} finally {
  await plane?.close().catch(() => {});
  await smokeWriter?.close().catch(() => {});
  await calloutNc?.close().catch(() => {});
  srv.kill();
  await awaitExit(srv);
  rmSync(tmp, { recursive: true, force: true });
  releaseBroker(); // last: ownership is held until this teardown has actually finished
}
