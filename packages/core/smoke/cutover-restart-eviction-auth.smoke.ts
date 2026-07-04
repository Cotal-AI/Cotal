/**
 * Local cutover restart smoke (D5 live-eviction proof): the current `MEMORY` resolver deployment applies
 * trust-root changes by rewriting config and restarting the broker. That restart must close already-live
 * stale connections; reconnect then fails because the rotated broker no longer trusts their JWTs/signers.
 *
 * Run: pnpm smoke:cutover-restart-eviction
 */
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, credsAuthenticator, type NatsConnection } from "@nats-io/transport-node";
import {
  createSpaceAuth,
  isReachable,
  mintCreds,
  mintMembershipObserverCreds,
  newIdentity,
  rotateDataAccountSigningKey,
  rotateSystemAccount,
  serverConfig,
} from "../src/index.js";

const PORT = 12000 + Math.floor(Math.random() * 8000);
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

async function liveConnect(creds: string, id: string): Promise<NatsConnection> {
  return connect({
    servers: SERVERS,
    authenticator: credsAuthenticator(enc(creds)),
    inboxPrefix: `_INBOX_${id}`,
    maxReconnectAttempts: 5,
    reconnectTimeWait: 100,
  });
}

async function closes(nc: NatsConnection, timeoutMs = 20_000): Promise<boolean> {
  const closed = await Promise.race([nc.closed().then(() => true), wait(timeoutMs).then(() => false)]);
  return closed;
}

const space = `cutover-evict-${randomUUID().slice(0, 8)}`;
const auth = await createSpaceAuth(space);
const dir = mkdtempSync(join(tmpdir(), "cotal-cutover-evict-"));
const conf = join(dir, "server.conf");
writeFileSync(conf, serverConfig(auth, { port: PORT, storeDir: join(dir, "js") }));
let srv = spawn("nats-server", ["-c", conf], { stdio: "ignore" });

try {
  await waitReachable();

  const oldData = newIdentity();
  const oldDataCreds = await mintCreds(auth, oldData, "probe", { expiresInSeconds: 300 });
  const oldDataNc = await liveConnect(oldDataCreds, oldData.id);
  check("old data-account cred is live before cutover", !oldDataNc.isClosed());

  const oldObserver = newIdentity();
  const oldObserverCreds = await mintMembershipObserverCreds(auth, oldObserver);
  const oldObserverNc = await liveConnect(oldObserverCreds, oldObserver.id);
  check("old membership-observer cred is live before cutover", !oldObserverNc.isClosed());

  const rotatedData = await rotateDataAccountSigningKey(auth);
  const rotated = await rotateSystemAccount(rotatedData);
  const freshData = newIdentity();
  const freshDataCreds = await mintCreds(rotated, freshData, "probe", { expiresInSeconds: 300 });
  const freshObserver = newIdentity();
  const freshObserverCreds = await mintMembershipObserverCreds(rotated, freshObserver);

  srv.kill("SIGKILL");
  await awaitExit(srv);
  writeFileSync(conf, serverConfig(rotated, { port: PORT, storeDir: join(dir, "js") }));
  srv = spawn("nats-server", ["-c", conf], { stdio: "ignore" });
  await waitReachable();

  check("already-live stale data-account connection is closed by local cutover restart", await closes(oldDataNc));
  check("already-live stale membership-observer connection is closed by local cutover restart", await closes(oldObserverNc));
  check("old data-account cred is broker-denied after restart", await tryConnect(oldDataCreds, oldData.id) === "rejected");
  check("old membership-observer cred is broker-denied after restart", await tryConnect(oldObserverCreds, oldObserver.id) === "rejected");
  check("fresh rotated data-account cred connects", await tryConnect(freshDataCreds, freshData.id) === "ok");
  check("fresh reminted membership-observer cred connects", await tryConnect(freshObserverCreds, freshObserver.id) === "ok");
} finally {
  srv.kill();
  await awaitExit(srv);
  rmSync(dir, { recursive: true, force: true });
}

if (fail) {
  console.error(`\nCUTOVER RESTART EVICTION TEST FAILED (${fail} failed, ${pass} passed)`);
  process.exit(1);
}
console.log(`\nCUTOVER RESTART EVICTION TEST PASSED ✅  (${pass} checks)`);
