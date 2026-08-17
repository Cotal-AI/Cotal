/**
 * Data-account signing-key rotation smoke (D5 slice 2): in the current local `MEMORY` resolver shape,
 * data signer death is proven by rewriting broker config with a rotated data-account JWT and restarting
 * the broker. This deliberately does NOT kill system-account `membership-observer` creds; that is a later
 * standing-host renewal/rotation slice.
 *
 * Run: pnpm smoke:signing-key-rotation
 */
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, credsAuthenticator } from "@nats-io/transport-node";
import {
  createSpaceAuth,
  isReachable,
  mintCreds,
  mintMembershipObserverCreds,
  newIdentity,
  rotateDataAccountSigningKey,
  serverConfig,
  stripSpaceAuth,
} from "../src/index.js";
import { pickFreePort } from "./_free-port.js";
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

async function waitReachable(): Promise<void> {
  for (let i = 0; i < 50; i++) {
    if (await isReachable(SERVERS)) return;
    await wait(200);
  }
  throw new Error(`auth nats-server did not come up on ${PORT}`);
}

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

function signingKeys(jwt: string): string[] {
  const claims = JSON.parse(Buffer.from(jwt.split(".")[1]!, "base64url").toString("utf8")) as { nats?: { signing_keys?: string[] } };
  return claims.nats?.signing_keys ?? [];
}

const space = `signing-rot-${randomUUID().slice(0, 8)}`;
const auth = await createSpaceAuth(space);
const oldSigner = stripSpaceAuth(auth);
const dir = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
const conf = join(dir, "server.conf");
writeFileSync(conf, serverConfig(auth, [auth], { transport: { kind: "plaintext" }, port: PORT, storeDir: join(dir, "js") }));
let srv = spawn("nats-server", ["-c", conf], { stdio: "ignore" });
// Re-owned on every restart. Owning only the FIRST child would leave the LIVE broker unowned
// after a respawn while the suite still read as migrated: ownership held on a dead pid.
let releaseBroker = teardownOnSignal(srv, dir);

try {
  await waitReachable();
  const oldUser = newIdentity();
  const oldCreds = await mintCreds(auth, oldUser, "probe", { expiresInSeconds: 60 });
  check("old signer user connects before rotation", await tryConnect(oldCreds, oldUser.id) === "ok");
  const observer = newIdentity();
  const observerCreds = await mintMembershipObserverCreds(auth, observer);
  check("system-account membership-observer connects before data signer rotation", await tryConnect(observerCreds, observer.id) === "ok");

  const rotated = await rotateDataAccountSigningKey(auth);
  check("rotation creates a new data-account signing key", rotated.account.signingPub !== auth.account.signingPub);
  const trusted = signingKeys(rotated.account.jwt);
  check("rotated account JWT trusts the new signer", trusted.includes(rotated.account.signingPub), trusted);
  check("rotated account JWT no longer trusts the old signer", !trusted.includes(auth.account.signingPub), trusted);

  srv.kill();
  await awaitExit(srv);
  writeFileSync(conf, serverConfig(rotated, [rotated], { transport: { kind: "plaintext" }, port: PORT, storeDir: join(dir, "js") }));
  releaseBroker();
  srv = spawn("nats-server", ["-c", conf], { stdio: "ignore" });
  releaseBroker = teardownOnSignal(srv, dir);
  await waitReachable();

  check("pre-rotation copied data-account user cred is denied after broker loads rotated account JWT", await tryConnect(oldCreds, oldUser.id) === "rejected");

  const staleMint = newIdentity();
  const staleMintCreds = await mintCreds(oldSigner, staleMint, "probe", { expiresInSeconds: 60 });
  check("old stripped signer can still mint locally but broker rejects it", await tryConnect(staleMintCreds, staleMint.id) === "rejected");

  const fresh = newIdentity();
  const freshCreds = await mintCreds(rotated, fresh, "probe", { expiresInSeconds: 60 });
  check("fresh rotated signer cred connects", await tryConnect(freshCreds, fresh.id) === "ok");
  check("system-account membership-observer remains valid; not covered by data-account rotation", await tryConnect(observerCreds, observer.id) === "ok");
} finally {
  srv.kill();
  await awaitExit(srv);
  rmSync(dir, { recursive: true, force: true });
  releaseBroker(); // last: ownership is held until this teardown has actually finished
}

if (fail) {
  console.error(`\nSIGNING KEY ROTATION TEST FAILED (${fail} failed, ${pass} passed)`);
  process.exit(1);
}
console.log(`\nSIGNING KEY ROTATION TEST PASSED ✅  (${pass} checks)`);
