/**
 * R1 DESCENDANT deny-new live smoke (SPEC 13.1) — the panel's Q2 resolution pinned live: for a
 * NON-root bearer the connect arm checks only the LEAF `cred.` row (a descendant's sourceChain
 * carries no root credid to compare with the head), and the descendant-denial guarantee rides the
 * BARRIER CASCADE — a completed family revoke / handle-source revoke leaves every descendant row
 * revoked, so the leaf check denies every reconnect:
 *
 *  - a handle-derived descendant bearer CONNECTS while its leaf row is active (and is exempt
 *    from the root head-equality check);
 *  - after a COMPLETED lifecycle-family containment (freeze-first, enumerate `cred.<uid>.>`,
 *    revoke all, verified-evict), the descendant AND the root can no longer reconnect;
 *  - after a COMPLETED handle-source revocation (freeze the source gate, walk `bysrc.`, revoke,
 *    verified-evict), the handle's descendant is denied while the UNTOUCHED root still connects.
 *
 * Run: pnpm smoke:descendant-deny:auth   (needs nats-server on PATH; local-only)
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
import { openLifecycleRegistry } from "../src/lifecycle-registry.js";
import { makeLedgerScannerOverConnection } from "../src/ledger-scanner.js";
import {
  containLifecycleFamily, createSourceGateOpen, finalizeAgentMint, revokeHandleSource, stageAgentMint,
  type EvictPrincipal,
} from "../src/credential-ledger.js";
import { openAuthorityClient } from "../src/authority-client.js";
import { ROOT_CREDENTIAL_TTL_MS } from "../src/root-credential.js";

const PORT = 20000 + Math.floor(Math.random() * 40000);
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

const space = `descdeny-${randomUUID().slice(0, 8)}`;
const auth = await createSpaceAuth(space);
const callout = await createCalloutAuth({ space, operatorSeed: auth.operator.seed, accountPub: auth.account.pub });
const tmp = mkdtempSync(join(tmpdir(), "cotal-descdeny-"));
const dir = join(tmp, "state");
writeFileSync(join(tmp, "server.conf"), serverConfig(auth, { port: PORT, storeDir: join(tmp, "js"), extraAccounts: [{ pub: callout.account.pub, jwt: callout.account.jwt }] }));
const srv = spawn("nats-server", ["-c", join(tmp, "server.conf")], { stdio: "ignore" });

const ISS = "https://auth.cotal.test";
const OWNER = deriveOwnerToken("s".repeat(32), "better-auth|human-1");
const dataAccount = { pub: auth.account.pub, signingSeed: auth.account.signingSeed };
const quiet = () => {};
// The smoke's verified evictor (the production rail is the R2 slice): no bearer under test holds
// a LIVE connection when its barrier runs, so a complete scan finding zero is the honest result.
const evictor: EvictPrincipal = async (principal) => ({ principal, kicked: 0, remaining: 0, verifiedGone: true, scanComplete: true });

async function tryConnect(bearer: string): Promise<"connected" | "denied"> {
  try {
    const nc = await connect({ servers: SERVERS, reconnect: false, ...(standaloneConnectOpts({ bearer, sentinelCreds: callout.sentinelCreds }) as Partial<ConnectionOptions>) });
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
let writer: Awaited<ReturnType<typeof openAuthorityClient>> | undefined;
try {
  let up = false;
  for (let i = 0; i < 50; i++) { if (await isReachable(SERVERS)) { up = true; break; } await wait(200); }
  if (!up) throw new Error(`nats-server did not come up on ${PORT}`);

  plane = await openAuthAuthorityPlane({ server: SERVERS, space, dir, dataAccount, log: quiet });
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

  // The smoke's PRIVILEGED barrier rail (handle provisioning + family/handle revokes need source
  // gates, stage intents, and enumeration consumers — deliberately NOT in the production mint
  // writer's grant, which stays under test-by-confinement elsewhere).
  writer = await openAuthorityClient({ server: SERVERS, space, dataAccount, label: `cotal:smoke-writer:${space}`, grants: (id) => ({ publish: [">"], subscribe: [`_INBOX_${id}.>`] }), log: quiet });
  const reg = await openLifecycleRegistry(writer.nc, space, makeLedgerScannerOverConnection(writer.nc, space));

  /** Grant + activate an alias through the production ensure, then mint one HANDLE-derived
   *  descendant under its open gate. Returns both bearers. */
  async function seedAlias(actor: string, handleId: string): Promise<{ root: string; desc: string; uid: string }> {
    const uid = mintLifecycleUid();
    grantManagedActor(dir, { owner: OWNER, actor, scope: [], allowSubscribe: ["general"], allowPublish: ["general"], tokenHash: newActorToken().tokenHash, lifecycleUid: uid });
    const rootCredid = await plane!.mintConnectCredential({ owner: OWNER, actor, lifecycleUid: uid });
    await createSourceGateOpen(reg, { issuerKeyId: "smokekey", id: handleId });
    const descCredid = mintLifecycleUid();
    await finalizeAgentMint(reg, await stageAgentMint(reg, {
      lifecycleUid: uid, credentialId: descCredid, holderPrincipal: `${OWNER}.${actor}`,
      sourceChain: [`handle.smokekey.${handleId}`], exp: Date.now() + ROOT_CREDENTIAL_TTL_MS,
    }));
    return {
      root: await issuer.issue({ owner: OWNER, space, actor, scope: [], lifecycleUid: uid, credentialId: rootCredid }),
      desc: await issuer.issue({ owner: OWNER, space, actor, scope: [], lifecycleUid: uid, credentialId: descCredid }),
      uid,
    };
  }

  // ---- case A: the LIFECYCLE-FAMILY revoke kills every descendant reconnect ----
  const alpha = await seedAlias("alpha", "h1");
  check("a handle-derived DESCENDANT bearer connects on its live leaf row (no head equality for non-root)", (await tryConnect(alpha.desc)) === "connected");
  check("control: alpha's root bearer connects", (await tryConnect(alpha.root)) === "connected");
  const contained = await containLifecycleFamily(reg, { owner: OWNER, actor: "alpha", lifecycleUid: alpha.uid, barrier: "retirement" }, { evictPrincipal: evictor });
  check("the family containment revoked the whole cred.<uid>.> family", contained.revokedRows >= 2, contained);
  check("FAMILY REVOKE: the pre-existing descendant bearer can NOT reconnect", (await tryConnect(alpha.desc)) === "denied");
  check("FAMILY REVOKE: the root bearer can NOT reconnect either", (await tryConnect(alpha.root)) === "denied");

  // ---- case B: the HANDLE-SOURCE revoke kills the handle's descendants, and ONLY those ----
  const beta = await seedAlias("beta", "h2");
  check("beta's descendant connects before the handle revoke", (await tryConnect(beta.desc)) === "connected");
  const revoked = await revokeHandleSource(reg, { issuerKeyId: "smokekey", id: "h2" }, { evictPrincipal: evictor });
  check("the handle revocation walked bysrc. and revoked the descendant row", revoked.revokedRows === 1, revoked);
  check("HANDLE REVOKE: the pre-existing descendant bearer can NOT reconnect", (await tryConnect(beta.desc)) === "denied");
  check("HANDLE REVOKE: beta's UNTOUCHED root still connects (the revoke is scoped to the source's lineage)", (await tryConnect(beta.root)) === "connected");

  console.log(`\nDESCENDANT-DENY SMOKE ${fail === 0 ? "OK ✅" : "FAILED ❌"}  (${pass} passed, ${fail} failed)`);
  if (fail) process.exitCode = 1;
} catch (e) {
  fail++;
  console.error("  ✗ smoke crashed:", e instanceof Error ? (e.stack ?? e.message) : e);
  process.exitCode = 1;
} finally {
  await plane?.close().catch(() => {});
  await writer?.close().catch(() => {});
  await calloutNc?.close().catch(() => {});
  srv.kill();
  await awaitExit(srv);
  rmSync(tmp, { recursive: true, force: true });
}
