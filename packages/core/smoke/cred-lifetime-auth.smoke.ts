/**
 * Credential lifetime smoke (D5 slice 1): user JWT `exp` is stamped from the profile matrix and enforced
 * by a real auth broker. This does NOT claim full credential death yet: signer rotation, live eviction,
 * and standing renewal are later D5 slices.
 *
 * Run: pnpm smoke:cred-lifetime
 */
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseCreds } from "@nats-io/jwt";
import { connect, credsAuthenticator } from "@nats-io/transport-node";
import {
  createSpaceAuth,
  credentialLifetime,
  chatSubject,
  isReachable,
  mintConnectionEvictorCreds,
  mintMembershipObserverCreds,
  mintCreds,
  newIdentity,
  serverConfig,
  DEV_OWNER,
  ROTATION_RENEWED_TTL_SEC,
} from "../src/index.js";

const PORT = 12000 + Math.floor(Math.random() * 8000);
const SERVERS = `nats://127.0.0.1:${PORT}`;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const enc = (s: string) => new TextEncoder().encode(s);
const awaitExit = (proc: ReturnType<typeof spawn>, timeoutMs = 3000): Promise<void> =>
  new Promise((resolve) => {
    if (proc.exitCode !== null || proc.signalCode !== null) return resolve();
    proc.once("exit", () => resolve());
    setTimeout(resolve, timeoutMs);
  });

let pass = 0;
let fail = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ FAIL: ${name}`, extra ?? "");
  }
};

async function tryConnect(creds: string, id: string): Promise<"ok" | "rejected"> {
  try {
    const nc = await connect({
      servers: SERVERS,
      authenticator: credsAuthenticator(enc(creds)),
      inboxPrefix: `_INBOX_${id}`,
      maxReconnectAttempts: 0,
    });
    await nc.close();
    return "ok";
  } catch {
    return "rejected";
  }
}

const space = `cred-life-${randomUUID().slice(0, 8)}`;
const auth = await createSpaceAuth(space);
const dir = mkdtempSync(join(tmpdir(), "cotal-credlife-"));
writeFileSync(join(dir, "server.conf"), serverConfig(auth, { port: PORT, storeDir: join(dir, "js") }));
const srv = spawn("nats-server", ["-c", join(dir, "server.conf")], { stdio: "ignore" });

try {
  let up = false;
  for (let i = 0; i < 50; i++) {
    if (await isReachable(SERVERS)) { up = true; break; }
    await wait(200);
  }
  if (!up) throw new Error(`auth nats-server did not come up on ${PORT}`);

  const now = Math.floor(Date.now() / 1000);
  const prov = newIdentity();
  const provCreds = await mintCreds(auth, prov, "provisioner");
  const provClaims = await parseCreds(enc(provCreds));
  const provTtl = credentialLifetime("provisioner").defaultTtlSeconds;
  check("provisioner profile has a default max age", provTtl === 300, provTtl);
  check("provisioner creds include exp", typeof provClaims.uc.exp === "number", provClaims.uc);
  check("provisioner exp is near the matrix TTL", Boolean(provClaims.uc.exp && provClaims.uc.exp - now <= 305 && provClaims.uc.exp - now > 0), provClaims.uc.exp);

  const sup = newIdentity();
  const supCreds = await mintCreds(auth, sup, "supervisor");
  const supClaims = await parseCreds(enc(supCreds));
  check("standing supervisor is classified for renewal but has no default exp yet", credentialLifetime("supervisor").class === "standing-renewable" && supClaims.uc.exp === undefined, supClaims.uc);
  check("agent is mixed until managed/unmanaged paths split", credentialLifetime("agent").class === "mixed" && credentialLifetime("agent").renewalOwner === undefined, credentialLifetime("agent"));

  const obs = newIdentity();
  const obsCreds = await mintMembershipObserverCreds(auth, obs);
  const obsClaims = await parseCreds(enc(obsCreds));
  check("membership-observer is rotation-renewed (bounded exp, no online renewal)", credentialLifetime("membership-observer").class === "rotation-renewed", credentialLifetime("membership-observer"));
  check("membership-observer creds carry the rotation-renewed exp", Boolean(obsClaims.uc.exp && obsClaims.uc.exp - now <= ROTATION_RENEWED_TTL_SEC + 5 && obsClaims.uc.exp - now > ROTATION_RENEWED_TTL_SEC - 60), obsClaims.uc.exp);
  const evi = newIdentity();
  const eviCreds = await mintConnectionEvictorCreds(auth, evi);
  const eviClaims = await parseCreds(enc(eviCreds));
  check("connection-evictor is rotation-renewed (bounded exp, no online renewal)", credentialLifetime("connection-evictor").class === "rotation-renewed", credentialLifetime("connection-evictor"));
  check("connection-evictor creds carry the rotation-renewed exp", Boolean(eviClaims.uc.exp && eviClaims.uc.exp - now <= ROTATION_RENEWED_TTL_SEC + 5 && eviClaims.uc.exp - now > ROTATION_RENEWED_TTL_SEC - 60), eviClaims.uc.exp);
  check("deployer is classified but not default-expired before near-expiry guards", credentialLifetime("deployer").defaultTtlSeconds === undefined, credentialLifetime("deployer"));
  check("teardown is classified but not default-expired before near-expiry guards", credentialLifetime("teardown").defaultTtlSeconds === undefined, credentialLifetime("teardown"));

  const expired = newIdentity();
  const expiredCreds = await mintCreds(auth, expired, "probe", { expiresAt: now - 1 });
  check("expired copied cred is broker-denied on connect", await tryConnect(expiredCreds, expired.id) === "rejected");

  const fresh = newIdentity();
  const freshCreds = await mintCreds(auth, fresh, "probe", { expiresInSeconds: 60 });
  check("fresh bounded cred connects", await tryConnect(freshCreds, fresh.id) === "ok");

  const live = newIdentity();
  const liveCreds = await mintCreds(auth, live, "operator", { expiresInSeconds: 1 });
  const nc = await connect({
    servers: SERVERS,
    authenticator: credsAuthenticator(enc(liveCreds)),
    inboxPrefix: `_INBOX_${live.id}`,
    maxReconnectAttempts: 0,
  });
  await wait(1600);
  let liveAfterExp: "allowed" | "closed" = "allowed";
  try {
    nc.publish(chatSubject(space, DEV_OWNER, live.id, "general"), enc("after-exp"));
    await nc.flush();
  } catch {
    liveAfterExp = "closed";
  } finally {
    await nc.close().catch(() => {});
  }
  check("live connection behavior after exp is empirically pinned (nats-server closes/rejects after expiry)", liveAfterExp === "closed", liveAfterExp);
} finally {
  srv.kill();
  await awaitExit(srv);
  rmSync(dir, { recursive: true, force: true });
}

if (fail) {
  console.error(`\nCREDENTIAL LIFETIME TEST FAILED (${fail} failed, ${pass} passed)`);
  process.exit(1);
}
console.log(`\nCREDENTIAL LIFETIME TEST PASSED ✅  (${pass} checks)`);
