// Stock full-resolver account hibernation and wake against a real nats-server 2.15.1.
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { jetstream, jetstreamManager, StorageType } from "@nats-io/jetstream";
import { decode, encodeAccount, encodeUser, type Account } from "@nats-io/jwt";
import { createUser, fromPublic, fromSeed } from "@nats-io/nkeys";
import { connect, credsAuthenticator, type NatsConnection } from "@nats-io/transport-node";
import {
  createBrokerAuth,
  createSpaceAccountAuth,
  credsFromJwt,
  hibernateAccountClaim,
  isReachable,
  newIdentity,
  pushAccountClaim,
  retireAccountClaim,
  serverConfig,
  wakeAccountClaim,
} from "../src/index.js";
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
const dir = await mkdtemp(join(tmpdir(), SMOKE_BROKER_TOKEN + "claim-hibernation-"));
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
  const broker = await createBrokerAuth("claim-hibernation-fixture");
  const space = await createSpaceAccountAuth(broker, "claim-hibernation");
  const storeDir = join(dir, "js"), resolverDir = join(dir, "account-jwts"), configFile = join(dir, "server.conf");
  const port = await freePort(), servers = `nats://127.0.0.1:${port}`;
  await writeFile(configFile, serverConfig(broker, [space], {
    transport: { kind: "plaintext" },
    storeDir,
    maxFileStore: 64 * 1024 * 1024,
    port,
    accountResolver: { kind: "full", directory: resolverDir, limit: 100, intervalMs: 120_000 },
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
  const userCreds = async () => {
    const identity = newIdentity();
    const jwt = await encodeUser("claim-hibernation-user", fromPublic(identity.id), fromPublic(space.account.pub),
      { pub: { allow: ["probe.>", "$JS.API.>"] }, sub: { allow: ["probe.>", `_INBOX_${identity.id}.>`] } },
      { exp: nowSeconds() + 600, signer: fromSeed(enc(space.account.signingSeed)) });
    return { creds: credsFromJwt(jwt, identity), id: identity.id };
  };
  const systemCreds = async () => {
    const identity = newIdentity();
    const jwt = await encodeUser("claim-hibernation-system", fromPublic(identity.id), fromPublic(broker.sys.pub), {
      pub: { allow: [
        `$SYS.REQ.ACCOUNT.${space.account.pub}.CLAIMS.UPDATE`,
        `$SYS.REQ.ACCOUNT.${space.account.pub}.JSZ`,
      ] },
      sub: { allow: [`_INBOX_${identity.id}.>`] },
    }, { exp: nowSeconds() + 600, signer: fromSeed(enc(broker.sys.signingSeed!)) });
    return { creds: credsFromJwt(jwt, identity), id: identity.id };
  };
  const dial = async (user: { creds: string; id: string }) => {
    const nc = await connect({ servers, authenticator: credsAuthenticator(enc(user.creds)), inboxPrefix: `_INBOX_${user.id}`, reconnect: false, timeout: 3000 });
    clients.push(nc); await nc.flush(); return nc;
  };

  const accountUser = await userCreds(), systemUser = await systemCreds();
  let running = await start();
  let accountNc = await dial(accountUser), systemNc = await dial(systemUser);
  let serverId = systemNc.info!.server_id;
  const push = (jwt: string) => pushAccountClaim(systemNc, { accountJwt: jwt, expectedServerIds: [serverId], maxWaitMs: 3000 });
  const refusedDial = async () => {
    const error = await dial(accountUser).then(() => undefined, (reason: unknown) => reason);
    assert.ok(error !== undefined, "a hibernated account user connected");
  };
  const jszError = async () => {
    const response = await systemNc.request(`$SYS.REQ.ACCOUNT.${space.account.pub}.JSZ`, enc("{}"), { timeout: 3000 });
    const answer = JSON.parse(response.string()) as { error?: { description?: unknown } };
    return String(answer.error?.description ?? "");
  };
  const jsm = await jetstreamManager(accountNc);
  await jsm.streams.add({ name: "HIBERNATION_PROBE", subjects: ["probe.>"], storage: StorageType.File });
  const ack = await jetstream(accountNc).publish("probe.value", enc("kept-on-disk"));
  assert.equal(ack.seq, 1);

  const revokedUser = createUser().getPublicKey();
  const activeClaims = decode<Account>(space.account.jwt);
  const operator = fromSeed(enc(broker.operator.seed));
  const account = fromPublic(space.account.pub);
  const activeTemplate = await encodeAccount(activeClaims.name, account, {
    ...activeClaims.nats,
    revocations: { [revokedUser]: nowSeconds() - 10 },
  }, { signer: operator });
  account.clear(); operator.clear();

  await nextSecond();
  const hibernated = await hibernateAccountClaim(broker, activeTemplate, nowSeconds());
  await cell("hibernate claim preserves identity, signing keys and per-user revocations while removing JetStream and wildcard retirement", async () => {
    const before = decode<Account>(activeTemplate), after = decode<Account>(hibernated);
    assert.equal(after.sub, before.sub);
    assert.equal(after.iss, before.iss);
    assert.equal(after.name, before.name);
    assert.deepEqual(after.nats.signing_keys, before.nats.signing_keys);
    assert.deepEqual(after.nats.revocations, { [revokedUser]: before.nats.revocations![revokedUser] });
    const hibernatedLimits = after.nats.limits as Record<string, unknown>;
    assert.equal("mem_storage" in hibernatedLimits, false);
    assert.equal("disk_storage" in hibernatedLimits, false);
    assert.equal("tiered_limits" in hibernatedLimits, false);
    assert.deepEqual(hibernatedLimits, { conn: 0, leaf: 0 });
    assert.equal(after.nats.revocations?.["*"], undefined);
  });
  await cell("pushing the hibernated claim unloads the live JetStream account without deleting its file stream", async () => {
    await push(hibernated);
    await Promise.race([accountNc.closed(), new Promise((_, reject) => setTimeout(() => reject(new Error("the hibernated account connection stayed open")), 3000).unref())]);
    await refusedDial();
    assert.match(await jszError(), /account.*not jetstream enabled/i);
    const streamDir = join(storeDir, "jetstream", space.account.pub, "streams", "HIBERNATION_PROBE");
    assert.equal((await readFile(join(streamDir, "meta.inf"))).byteLength > 0, true);
  });

  await stop(running); running = await start();
  systemNc = await dial(systemUser); serverId = systemNc.info!.server_id;
  await cell("a cold restart keeps the hibernated account unloaded and its on-disk stream intact", async () => {
    await refusedDial();
    assert.match(await jszError(), /account.*not jetstream enabled/i);
    assert.equal((await readFile(join(storeDir, "jetstream", space.account.pub, "streams", "HIBERNATION_PROBE", "meta.inf"))).byteLength > 0, true);
  });

  await nextSecond();
  const woken = await wakeAccountClaim(broker, activeTemplate, nowSeconds());
  await cell("wake preserves the active template identity, limits, signing keys and per-user revocations", async () => {
    const before = decode<Account>(activeTemplate), after = decode<Account>(woken);
    assert.equal(after.sub, before.sub);
    assert.equal(after.iss, before.iss);
    assert.equal(after.name, before.name);
    assert.deepEqual(after.nats.limits, before.nats.limits);
    assert.deepEqual(after.nats.signing_keys, before.nats.signing_keys);
    assert.deepEqual(after.nats.revocations, before.nats.revocations);
  });
  await cell("pushing the wake claim reloads the stored stream and message", async () => {
    await push(woken);
    accountNc = await dial(accountUser);
    const restored = await (await jetstreamManager(accountNc)).streams.getMessage("HIBERNATION_PROBE", { seq: 1 });
    assert.ok(restored);
    assert.equal(restored.string(), "kept-on-disk");
  });

  const fenceAccount = fromPublic(space.account.pub), fenceOperator = fromSeed(enc(broker.operator.seed));
  const recentFence = nowSeconds() - 60, expiredFence = nowSeconds() - 86_411;
  const recentFenceTemplate = await encodeAccount(activeClaims.name, fenceAccount, {
    ...activeClaims.nats,
    revocations: { [revokedUser]: nowSeconds() - 10, "*": recentFence },
  }, { signer: fenceOperator });
  const expiredFenceTemplate = await encodeAccount(activeClaims.name, fenceAccount, {
    ...activeClaims.nats,
    revocations: { [revokedUser]: nowSeconds() - 10, "*": expiredFence },
  }, { signer: fenceOperator });
  fenceAccount.clear(); fenceOperator.clear();
  await nextSecond();
  await cell("wake retains a live wildcard fence, expires an old fence, and keeps per-user revocations in both", async () => {
    const iat = nowSeconds();
    const recent = decode<Account>(await wakeAccountClaim(broker, recentFenceTemplate, iat));
    const expired = decode<Account>(await wakeAccountClaim(broker, expiredFenceTemplate, iat));
    assert.equal(recent.nats.revocations?.["*"], recentFence);
    assert.equal(recent.nats.revocations?.[revokedUser], decode<Account>(recentFenceTemplate).nats.revocations?.[revokedUser]);
    assert.equal(expired.nats.revocations?.["*"], undefined);
    assert.equal(expired.nats.revocations?.[revokedUser], decode<Account>(expiredFenceTemplate).nats.revocations?.[revokedUser]);
  });

  await nextSecond();
  const retired = await retireAccountClaim(broker, activeTemplate, nowSeconds());
  await nextSecond();
  await cell("wake refuses retired and hibernated templates", async () => {
    const iat = nowSeconds();
    await assert.rejects(wakeAccountClaim(broker, retired, iat), /not an active data or auth-callout account claim/);
    await assert.rejects(wakeAccountClaim(broker, hibernated, iat), /not an active data or auth-callout account claim/);
  });
  await cell("both helpers refuse malformed, foreign, stale-iat and unsupported non-JetStream templates", async () => {
    const iat = nowSeconds();
    const foreign = await createSpaceAccountAuth(await createBrokerAuth("foreign-claim-hibernation"), "foreign");
    for (const helper of [hibernateAccountClaim, wakeAccountClaim]) {
      await assert.rejects(helper(broker, "not-a-jwt", iat), /invalid jwt/);
      await assert.rejects(helper(broker, foreign.account.jwt, iat), /not signed by this broker's operator/);
      await assert.rejects(helper(broker, activeTemplate, decode<Account>(activeTemplate).iat), /must be newer than/);
    }
    const plainAccount = fromPublic(space.account.pub), plainOperator = fromSeed(enc(broker.operator.seed));
    const noJetStream = await encodeAccount("claim-hibernation", plainAccount, {
      signing_keys: activeClaims.nats.signing_keys,
      limits: { conn: -1, leaf: -1 },
    }, { signer: plainOperator });
    plainAccount.clear(); plainOperator.clear();
    await nextSecond();
    const validIat = nowSeconds();
    await assert.rejects(hibernateAccountClaim(broker, noJetStream, validIat), /not an active data or auth-callout account claim/);
    await assert.rejects(wakeAccountClaim(broker, noJetStream, validIat), /not an active data or auth-callout account claim/);
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
