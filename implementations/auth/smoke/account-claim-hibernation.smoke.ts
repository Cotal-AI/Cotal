// Stock dedicated auth-callout account hibernation and wake against a real nats-server 2.15.1.
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decode, encodeUser, type Account } from "@nats-io/jwt";
import { fromPublic, fromSeed } from "@nats-io/nkeys";
import { connect, credsAuthenticator, type NatsConnection } from "@nats-io/transport-node";
import {
  createBrokerAuth,
  createSpaceAccountAuth,
  credsFromJwt,
  hibernateAccountClaim,
  isReachable,
  newIdentity,
  pushAccountClaim,
  serverConfig,
  wakeAccountClaim,
} from "@cotal-ai/core";
import { createCalloutAuth } from "../src/callout.js";
import {
  awaitBrokerReady,
  emitSentinel,
  freePort,
  killAndAwaitExit,
  SMOKE_BROKER_TOKEN,
  teardownOnSignal,
  teardownPathOnSignal,
} from "@cotal-ai/smoke-kit";

const NATS_SERVER = process.env.NATS_SERVER_BIN ?? "nats-server";
const dir = await mkdtemp(join(tmpdir(), SMOKE_BROKER_TOKEN + "callout-claim-hibernation-"));
const releasePath = teardownPathOnSignal(dir);
const clients: NatsConnection[] = [], children: ChildProcess[] = [], releases: Array<() => void> = [];
const enc = (value: string) => new TextEncoder().encode(value);
const nowSeconds = () => Math.floor(Date.now() / 1000);
const nextSecond = async () => {
  const start = nowSeconds();
  while (nowSeconds() === start) await new Promise((resolve) => setTimeout(resolve, 20));
  return nowSeconds();
};
let passed = 0, failed = 0;
const cell = async (name: string, run: () => Promise<void>) => {
  try { await run(); passed++; console.log(`  ✓ ${name}`); }
  catch (error) { failed++; console.error(`  ✗ ${name}: ${error instanceof Error ? error.message : String(error)}`); }
};

try {
  const broker = await createBrokerAuth("callout-claim-hibernation-fixture");
  const space = await createSpaceAccountAuth(broker, "callout-claim-hibernation");
  const callout = await createCalloutAuth({ space: space.space, operatorSeed: broker.operator.seed, accountPub: space.account.pub });
  const storeDir = join(dir, "js"), resolverDir = join(dir, "account-jwts"), configFile = join(dir, "server.conf");
  const port = await freePort(), servers = `nats://127.0.0.1:${port}`;
  await writeFile(configFile, serverConfig(broker, [space], {
    transport: { kind: "plaintext" },
    storeDir,
    maxFileStore: 64 * 1024 * 1024,
    port,
    accountResolver: { kind: "full", directory: resolverDir, limit: 100, intervalMs: 120_000 },
    extraAccounts: [{ pub: callout.account.pub, jwt: callout.account.jwt }],
  }), { mode: 0o600 });

  let log = "";
  const start = async () => {
    const child = spawn(NATS_SERVER, ["-c", configFile], { stdio: ["ignore", "ignore", "pipe"] });
    children.push(child); releases.push(teardownOnSignal(child)); assert.ok(child.pid);
    child.stderr!.on("data", (chunk) => { log = (log + String(chunk)).slice(-20_000); });
    await awaitBrokerReady(() => isReachable(servers), { servers, attempts: 50, delayMs: 100, output: () => log });
    return child;
  };
  const closeClients = async () => {
    for (const client of clients.splice(0).reverse()) await client.close();
  };
  const stop = async (child: ChildProcess) => {
    await closeClients();
    await killAndAwaitExit(child, "SIGTERM");
    assert.ok(child.exitCode !== null || child.signalCode !== null, "owned broker remains live");
  };
  const systemCreds = async () => {
    const identity = newIdentity();
    const jwt = await encodeUser("callout-claim-hibernation-system", fromPublic(identity.id), fromPublic(broker.sys.pub), {
      pub: { allow: [`$SYS.REQ.ACCOUNT.${callout.account.pub}.CLAIMS.UPDATE`] },
      sub: { allow: [`_INBOX_${identity.id}.>`] },
    }, { exp: nowSeconds() + 600, signer: fromSeed(enc(broker.sys.signingSeed!)) });
    return { creds: credsFromJwt(jwt, identity), id: identity.id };
  };
  const dialSystem = async (user: { creds: string; id: string }) => {
    const nc = await connect({ servers, authenticator: credsAuthenticator(enc(user.creds)), inboxPrefix: `_INBOX_${user.id}`, reconnect: false, timeout: 3000 });
    clients.push(nc); await nc.flush(); return nc;
  };
  const dialCallout = async () => {
    const nc = await connect({ servers, authenticator: credsAuthenticator(enc(callout.calloutCreds)), reconnect: false, timeout: 3000 });
    clients.push(nc); await nc.flush(); return nc;
  };

  const systemUser = await systemCreds();
  const running = await start();
  const systemNc = await dialSystem(systemUser), serverId = systemNc.info!.server_id;
  let calloutNc = await dialCallout();
  const push = (jwt: string) => pushAccountClaim(systemNc, { accountJwt: jwt, expectedServerIds: [serverId], maxWaitMs: 3000 });

  await nextSecond();
  const sleeping = await hibernateAccountClaim(broker, callout.account.jwt, nowSeconds());
  await cell("hibernate preserves the dedicated auth-callout account authority, keys and identity", async () => {
    const before = decode<Account>(callout.account.jwt), after = decode<Account>(sleeping);
    assert.equal(after.sub, before.sub);
    assert.equal(after.iss, before.iss);
    assert.equal(after.name, before.name);
    assert.deepEqual(after.nats.signing_keys, before.nats.signing_keys);
    assert.deepEqual(after.nats.authorization, before.nats.authorization);
    assert.deepEqual(after.nats.default_permissions, before.nats.default_permissions);
    assert.deepEqual(after.nats.limits, { conn: 0, leaf: 0 });
  });
  await cell("pushing hibernation fences the dedicated auth-callout account's live and later connections", async () => {
    await push(sleeping);
    await Promise.race([calloutNc.closed(), new Promise((_, reject) => setTimeout(() => reject(new Error("the hibernated callout connection stayed open")), 3000).unref())]);
    const refusal = await dialCallout().then(() => undefined, (error: unknown) => error);
    assert.ok(refusal !== undefined, "a hibernated callout credential connected");
  });

  await nextSecond();
  const woken = await wakeAccountClaim(broker, callout.account.jwt, nowSeconds());
  await cell("wake reopens the dedicated auth-callout account with its stock credential and authority intact", async () => {
    await push(woken);
    calloutNc = await dialCallout();
    assert.equal(calloutNc.isClosed(), false);
    const before = decode<Account>(callout.account.jwt), after = decode<Account>(woken);
    assert.deepEqual(after.nats.authorization, before.nats.authorization);
    assert.deepEqual(after.nats.signing_keys, before.nats.signing_keys);
  });

  await stop(running);
} finally {
  for (const client of clients.reverse()) await client.close();
  for (const child of children) {
    await killAndAwaitExit(child, "SIGTERM");
    assert.ok(child.exitCode !== null || child.signalCode !== null, "owned broker remains live");
  }
  for (const release of releases) release();
  await rm(dir, { recursive: true, force: true }); releasePath();
}
emitSentinel({ passed, failed });
if (failed) process.exitCode = 1;
