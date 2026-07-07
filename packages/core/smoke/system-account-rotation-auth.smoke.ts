/**
 * System-account rotation smoke (D5 observer-death slice): in the current local `MEMORY` resolver shape,
 * persisted system-account `membership-observer` creds die by rewriting broker config with a fresh SYSTEM
 * account, reminting the observer during the in-memory seed window, and restarting the broker.
 *
 * Run: pnpm smoke:system-account-rotation
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

function systemAccount(jwt: string): string | undefined {
  const claims = JSON.parse(Buffer.from(jwt.split(".")[1]!, "base64url").toString("utf8")) as { nats?: { system_account?: string } };
  return claims.nats?.system_account;
}

const space = `sys-rot-${randomUUID().slice(0, 8)}`;
const auth = await createSpaceAuth(space);
const dir = mkdtempSync(join(tmpdir(), "cotal-sysrot-"));
const conf = join(dir, "server.conf");
writeFileSync(conf, serverConfig(auth, { port: PORT, storeDir: join(dir, "js") }));
let srv = spawn("nats-server", ["-c", conf], { stdio: "ignore" });

try {
  await waitReachable();
  const dataUser = newIdentity();
  const dataCreds = await mintCreds(auth, dataUser, "probe", { expiresInSeconds: 60 });
  check("data-account user connects before system rotation", await tryConnect(dataCreds, dataUser.id) === "ok");

  const oldObserver = newIdentity();
  const oldObserverCreds = await mintMembershipObserverCreds(auth, oldObserver);
  check("old membership-observer connects before system rotation", await tryConnect(oldObserverCreds, oldObserver.id) === "ok");

  const rotated = await rotateSystemAccount(auth);
  check("rotation creates a new system account", rotated.sys.pub !== auth.sys.pub);
  check("rotated operator JWT points at the new system account", systemAccount(rotated.operator.jwt) === rotated.sys.pub, systemAccount(rotated.operator.jwt));
  check("rotated operator JWT no longer points at the old system account", systemAccount(rotated.operator.jwt) !== auth.sys.pub, systemAccount(rotated.operator.jwt));

  const freshObserver = newIdentity();
  const freshObserverCreds = await mintMembershipObserverCreds(rotated, freshObserver);

  srv.kill();
  await awaitExit(srv);
  writeFileSync(conf, serverConfig(rotated, { port: PORT, storeDir: join(dir, "js") }));
  srv = spawn("nats-server", ["-c", conf], { stdio: "ignore" });
  await waitReachable();

  check("pre-rotation membership-observer cred is denied after broker loads rotated system account", await tryConnect(oldObserverCreds, oldObserver.id) === "rejected");

  const staleObserver = newIdentity();
  const staleObserverCreds = await mintMembershipObserverCreds(auth, staleObserver);
  check("old system-account seed can still mint locally but broker rejects it", await tryConnect(staleObserverCreds, staleObserver.id) === "rejected");

  check("fresh reminted membership-observer connects", await tryConnect(freshObserverCreds, freshObserver.id) === "ok");
  check("data-account user survives system-account rotation", await tryConnect(dataCreds, dataUser.id) === "ok");
} finally {
  srv.kill();
  await awaitExit(srv);
  rmSync(dir, { recursive: true, force: true });
}

if (fail) {
  console.error(`\nSYSTEM ACCOUNT ROTATION TEST FAILED (${fail} failed, ${pass} passed)`);
  process.exit(1);
}
console.log(`\nSYSTEM ACCOUNT ROTATION TEST PASSED ✅  (${pass} checks)`);
