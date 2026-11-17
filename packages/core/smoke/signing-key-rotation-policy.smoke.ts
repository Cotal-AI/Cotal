// What a data-account signing-key rotation keeps, against a real full-resolver nats-server: the
// claim's limits, revocations and identity are read back from the broker and exercised with real
// client and leaf connections before and after the rotation.
//
// Run: pnpm smoke:signing-key-rotation   (add --keep-fixture to leave the broker's files in place)
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decode, encodeAccount, encodeUser, type Account, type ClaimsData } from "@nats-io/jwt";
import { createAccount, createUser, fromPublic, fromSeed } from "@nats-io/nkeys";
import { connect, credsAuthenticator, type NatsConnection } from "@nats-io/transport-node";
import {
  composeSpaceAuth,
  createBrokerAuth,
  createSpaceAccountAuth,
  credsFromJwt,
  hibernateAccountClaim,
  isReachable,
  mintCreds,
  newIdentity,
  pushAccountClaim,
  retireAccountClaim,
  rotateDataAccountSigningKey,
  serverConfig,
  stripSpaceAuth,
  type SpaceAuth,
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
const CONN_LIMIT = 6;
const keepFixture = process.argv.includes("--keep-fixture");
const dir = await mkdtemp(join(tmpdir(), SMOKE_BROKER_TOKEN + "rotation-policy-"));
const releasePath = teardownPathOnSignal(dir);
const clients: NatsConnection[] = [], children: ChildProcess[] = [], releases: Array<() => void> = [];
const enc = (value: string) => new TextEncoder().encode(value);
const nowSeconds = () => Math.floor(Date.now() / 1000);
const nextSecond = async () => {
  const start = nowSeconds();
  while (nowSeconds() === start) await new Promise((resolve) => setTimeout(resolve, 20));
  return nowSeconds();
};
const until = async (what: string, ready: () => boolean | Promise<boolean>, ms = 8000) => {
  for (const end = Date.now() + ms; Date.now() < end;) {
    if (await ready()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail(`${what} did not happen within ${ms} ms`);
};
let passed = 0, failed = 0, asserted = 0;
const ok = (value: unknown, message: string) => { asserted++; assert.ok(value, message); };
const eq = (actual: unknown, expected: unknown, message: string) => { asserted++; assert.deepEqual(actual, expected, message); };
const refuses = async (run: Promise<unknown>, pattern: RegExp) => { asserted++; await assert.rejects(run, pattern); };
const cell = async (name: string, run: () => Promise<void>) => {
  try { await run(); passed++; console.log(`  ✓ ${name}`); }
  catch (error) { failed++; console.error(`  ✗ ${name}: ${error instanceof Error ? error.message : String(error)}`); }
};
type Claim = ClaimsData<Account>;

try {
  const broker = await createBrokerAuth("rotation-policy-fixture");
  const spaceAccount = await createSpaceAccountAuth(broker, "rotation-policy");
  const controlAccount = await createSpaceAccountAuth(broker, "rotation-policy-control");
  const stock: SpaceAuth = composeSpaceAuth(broker, spaceAccount);
  const account = stock.account.pub;
  const port = await freePort(), leafPort = await freePort(), servers = `nats://127.0.0.1:${port}`;
  const configFile = join(dir, "server.conf");
  await writeFile(configFile, serverConfig(broker, [spaceAccount, controlAccount], {
    transport: { kind: "plaintext" },
    storeDir: join(dir, "js"),
    port,
    accountResolver: { kind: "full", directory: join(dir, "account-jwts"), limit: 100, intervalMs: 120_000 },
  }) + `\nleafnodes { host: "127.0.0.1", port: ${leafPort} }\n`, { mode: 0o600 });
  let hubLog = "";
  const hub = spawn(NATS_SERVER, ["-c", configFile], { stdio: ["ignore", "ignore", "pipe"] });
  children.push(hub); releases.push(teardownOnSignal(hub)); assert.ok(hub.pid);
  hub.stderr!.on("data", (chunk) => { hubLog += String(chunk); });
  await awaitBrokerReady(() => isReachable(servers), { servers, attempts: 50, delayMs: 100, output: () => hubLog.slice(-4000) });

  // The claim under test: stock's data-account claim with a connection limit, no leaf nodes, an
  // expiry and one revoked user. The revocation is dated ahead, so a credential issued for that
  // user after the rotation is still one it covers.
  const revoked = newIdentity();
  const expiry = nowSeconds() + 3600, revokedAt = nowSeconds() + 1800;
  const stockClaim = decode<Account>(stock.account.jwt);
  const operator = fromSeed(enc(broker.operator.seed));
  const issue = (nats: Partial<Account>, opts: { exp?: number } = {}) =>
    encodeAccount(stockClaim.name, fromPublic(account), nats, { signer: operator, ...opts });
  const policyNats: Partial<Account> = {
    ...stockClaim.nats,
    limits: { ...stockClaim.nats.limits, conn: CONN_LIMIT, leaf: 0 },
    revocations: { [revoked.id]: revokedAt },
  };
  const before: SpaceAuth = { ...stock, account: { ...stock.account, jwt: await issue(policyNats, { exp: expiry }) } };
  const beforeSnapshot = JSON.stringify(before);

  const systemUser = newIdentity();
  const systemJwt = await encodeUser("rotation-policy-system", fromPublic(systemUser.id), fromPublic(broker.sys.pub), {
    pub: { allow: [`$SYS.REQ.ACCOUNT.${account}.CLAIMS.UPDATE`, `$SYS.REQ.ACCOUNT.${account}.CLAIMS.LOOKUP`, "$SYS.REQ.SERVER.*.LEAFZ"] },
    sub: { allow: [`_INBOX_${systemUser.id}.>`] },
  }, { exp: nowSeconds() + 600, signer: fromSeed(enc(broker.sys.signingSeed!)) });
  const systemNc = await connect({ servers, authenticator: credsAuthenticator(enc(credsFromJwt(systemJwt, systemUser))), inboxPrefix: `_INBOX_${systemUser.id}`, reconnect: false, timeout: 3000 });
  clients.push(systemNc);
  const serverId = systemNc.info!.server_id;
  const push = (jwt: string) => pushAccountClaim(systemNc, { accountJwt: jwt, expectedServerIds: [serverId], maxWaitMs: 3000 });
  const stored = async () => (await systemNc.request(`$SYS.REQ.ACCOUNT.${account}.CLAIMS.LOOKUP`, "", { timeout: 3000 })).string();
  const leafCount = async (of: string) => {
    const answer = (await systemNc.request(`$SYS.REQ.SERVER.${serverId}.LEAFZ`, "{}", { timeout: 3000 })).json<{ data?: { leafs?: Array<{ account?: string }> } }>();
    return (answer.data?.leafs ?? []).filter((leaf) => leaf.account === of).length;
  };

  const dial = async (creds: string): Promise<NatsConnection | undefined> => {
    try {
      const nc = await connect({ servers, authenticator: credsAuthenticator(enc(creds)), reconnect: false, timeout: 3000 });
      await nc.flush();
      clients.push(nc);
      return nc;
    } catch { return undefined; }
  };
  const admitted = async (creds: string) => {
    const nc = await dial(creds);
    if (nc) await nc.close();
    return nc !== undefined;
  };
  /** How many more connections the account admits, opening them one by one until one is refused. */
  const headroom = async (creds: string) => {
    const held: NatsConnection[] = [];
    for (let i = 0; i < CONN_LIMIT + 4; i++) {
      const nc = await dial(creds);
      if (!nc) break;
      held.push(nc);
    }
    for (const nc of held) await nc.close();
    return held.length;
  };
  const userOf = (auth: SpaceAuth, identity = newIdentity()) => mintCreds(auth, identity, "probe", { expiresInSeconds: 600 });
  /** A second nats-server dialing the hub as a leaf node of `of`, with a user `signingSeed` signed.
   *  Resolves once the hub has either listed the leaf or logged its refusal. */
  let leafRuns = 0;
  const leafJoins = async (of: string, signingSeed: string): Promise<boolean> => {
    const identity = newIdentity(), leafDir = join(dir, `leaf-${++leafRuns}`);
    const jwt = await encodeUser("rotation-policy-leaf", fromPublic(identity.id), fromPublic(of), {}, { exp: nowSeconds() + 600, signer: fromSeed(enc(signingSeed)) });
    await mkdir(leafDir, { mode: 0o700 });
    await writeFile(join(leafDir, "leaf.creds"), credsFromJwt(jwt, identity), { mode: 0o600 });
    await writeFile(join(leafDir, "leaf.conf"), `port: ${await freePort()}\nhost: "127.0.0.1"\nleafnodes { remotes [ { url: "nats-leaf://127.0.0.1:${leafPort}", credentials: ${JSON.stringify(join(leafDir, "leaf.creds"))} } ] }\n`, { mode: 0o600 });
    const refusedBefore = hubLog.split("Leafnode connection closed: Maximum Account Connections Exceeded").length;
    const leaf = spawn(NATS_SERVER, ["-c", join(leafDir, "leaf.conf")], { stdio: "ignore" });
    children.push(leaf); releases.push(teardownOnSignal(leaf));
    let joined = false;
    try {
      await until("the hub answering the leaf node", async () => {
        joined = (await leafCount(of)) > 0;
        return joined || hubLog.split("Leafnode connection closed: Maximum Account Connections Exceeded").length > refusedBefore;
      });
    } finally { await killAndAwaitExit(leaf, "SIGKILL"); }
    await until("the hub dropping the leaf node", async () => (await leafCount(of)) === 0);
    return joined;
  };

  const oldUser = await userOf(before);
  let oldLive: NatsConnection | undefined;
  await cell("before the rotation the broker enforces the claim's limit, leaf refusal and revocation", async () => {
    await push(before.account.jwt);
    eq(await stored(), before.account.jwt, "the broker did not store the claim under test");
    oldLive = await dial(oldUser);
    ok(oldLive, "a user of the current signer was refused");
    ok(!(await admitted(await userOf(before, revoked))), "the revoked user connected");
    eq(await headroom(oldUser), CONN_LIMIT - 1, "the connection limit was not enforced");
    ok(await leafJoins(controlAccount.account.pub, controlAccount.account.signingSeed), "control: a leaf node of an account that allows them did not join");
    ok(!(await leafJoins(account, before.account.signingSeed!)), "a leaf node joined an account whose leaf limit is 0");
  });

  await nextSecond();
  const after = await rotateDataAccountSigningKey(before);
  await cell("the rotation replaces the signing keys and keeps every other claim", async () => {
    const was = decode<Account>(before.account.jwt) as Claim, now = decode<Account>(after.account.jwt) as Claim;
    eq([now.sub, now.iss, now.name, now.aud, now.exp], [was.sub, was.iss, was.name, was.aud, expiry], "the claim's identity or expiry changed");
    eq(JSON.stringify(now.nats.limits), JSON.stringify(was.nats.limits), "the limits changed");
    eq(JSON.stringify(now.nats.revocations), JSON.stringify(was.nats.revocations), "the revocations changed");
    eq(now.nats.signing_keys, [after.account.signingPub], "the signing keys are not the one new key");
    ok(after.account.signingPub !== before.account.signingPub, "the signing key did not change");
    eq({ ...now.nats, signing_keys: undefined }, { ...was.nats, signing_keys: undefined }, "an account field outside the signing keys changed");
    eq(fromSeed(enc(after.account.signingSeed!)).getPublicKey(), after.account.signingPub, "the returned seed is not the new signing key's");
    eq({ ...after, account: { ...after.account, jwt: "", signingSeed: "", signingPub: "" } },
      { ...before, account: { ...before.account, jwt: "", signingSeed: "", signingPub: "" } }, "the returned auth changed outside the claim and its signing key");
    eq(JSON.stringify(before), beforeSnapshot, "the rotation changed the auth it was given");
  });

  await cell("the broker stores the rotated claim, ends the old signer and admits the new one", async () => {
    await push(after.account.jwt);
    eq(await stored(), after.account.jwt, "the broker did not store the rotated claim");
    await until("the old signer's open connection closing", () => oldLive!.isClosed());
    ok(!(await admitted(oldUser)), "a credential the old signer issued before the rotation connected");
    ok(!(await admitted(await userOf(before))), "a credential the old signer issued after the rotation connected");
    ok(await admitted(await userOf(after)), "a user of the new signer was refused");
  });

  await cell("after the rotation the broker still enforces the limit, the leaf refusal and the revocation", async () => {
    const newUser = await userOf(after);
    eq(await headroom(newUser), CONN_LIMIT, "the connection limit was not enforced after the rotation");
    ok(!(await leafJoins(account, after.account.signingSeed!)), "a leaf node joined after the rotation");
    ok(!(await admitted(await userOf(after, revoked))), "the revoked user connected with a credential from the new signer");
    ok(await admitted(newUser), "control: another user of the new signer was refused");
  });

  await cell("a hibernated and a retired claim stay as they are through a rotation", async () => {
    const asleep = await hibernateAccountClaim(broker, before.account.jwt, await nextSecond());
    const rotatedAsleep = decode<Account>((await rotateDataAccountSigningKey({ ...before, account: { ...before.account, jwt: asleep } })).account.jwt);
    eq(rotatedAsleep.nats.limits, decode<Account>(asleep).nats.limits, "a hibernated claim's limits changed");
    eq(rotatedAsleep.nats.revocations, decode<Account>(asleep).nats.revocations, "a hibernated claim's revocations changed");
    const retired = await retireAccountClaim(broker, before.account.jwt, nowSeconds());
    const rotatedRetired = decode<Account>((await rotateDataAccountSigningKey({ ...before, account: { ...before.account, jwt: retired } })).account.jwt);
    eq(rotatedRetired.nats.limits, decode<Account>(retired).nats.limits, "a retired claim's limits changed");
    eq(rotatedRetired.nats.revocations, decode<Account>(retired).nats.revocations, "a retired claim's revocations changed");
  });

  await cell("a claim that cannot be re-issued whole refuses and leaves the auth as it was", async () => {
    const withJwt = (jwt: string): SpaceAuth => ({ ...before, account: { ...before.account, jwt } });
    const foreignBroker = await createBrokerAuth("rotation-policy-foreign");
    const foreign = await createSpaceAccountAuth(foreignBroker, "rotation-policy");
    const foreignOperator = fromSeed(enc(foreignBroker.operator.seed));
    const [head, body, signature] = before.account.jwt.split(".") as [string, string, string];
    const handSigned = (claims: Record<string, unknown>) => {
      const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
      return `${head}.${payload}.${Buffer.from(operator.sign(enc(`${head}.${payload}`))).toString("base64url")}`;
    };
    const claims = JSON.parse(Buffer.from(body, "base64url").toString()) as Record<string, unknown>;
    eq((await rotateDataAccountSigningKey(withJwt(handSigned(claims)))).account.pub, account, "control: a hand-signed copy of the claim did not rotate");

    await refuses(rotateDataAccountSigningKey(withJwt("not-a-jwt")), /rotateDataAccountSigningKey: invalid jwt/);
    await refuses(rotateDataAccountSigningKey(withJwt(`${head}.${body}.${signature.slice(0, -4)}AAAA`)), /sig verification failed/);
    await refuses(rotateDataAccountSigningKey(withJwt(foreign.account.jwt)), /not signed by this broker's operator/);
    await refuses(rotateDataAccountSigningKey(withJwt(await encodeAccount(stockClaim.name, fromPublic(account), policyNats, { signer: foreignOperator }))),
      /not signed by this broker's operator/);
    await refuses(rotateDataAccountSigningKey(withJwt(controlAccount.account.jwt)), /not for the account whose seed this auth holds/);
    await refuses(rotateDataAccountSigningKey({ ...before, account: { ...before.account, pub: controlAccount.account.pub } }), /not for the account whose seed this auth holds/);
    await refuses(rotateDataAccountSigningKey(withJwt(handSigned({ ...claims, exp: nowSeconds() - 5 }))), /not currently valid/);
    await refuses(rotateDataAccountSigningKey(withJwt(handSigned({ ...claims, nbf: nowSeconds() + 600 }))), /not currently valid/);
    await refuses(rotateDataAccountSigningKey(withJwt(await issue({ ...policyNats, revocations: { "not-a-user-key": revokedAt } }))), /invalid revocation map/);
    await refuses(rotateDataAccountSigningKey(withJwt(await issue({ ...policyNats, revocations: { [createUser().getPublicKey()]: 0 } }))), /invalid revocation map/);
    await refuses(rotateDataAccountSigningKey(withJwt(handSigned({ ...claims, tenant: "kept-nowhere" }))), /top-level fields a re-issue cannot carry: tenant/);
    await refuses(rotateDataAccountSigningKey(withJwt(await issue({
      ...policyNats,
      signing_keys: [before.account.signingPub, { kind: "user_scope", key: createAccount().getPublicKey(), role: "reader", template: {} }],
    } as Partial<Account>))), /scoped signing key/);
    await refuses(rotateDataAccountSigningKey(stripSpaceAuth(before)), /full operator\/account seed material is required/);
    await refuses(rotateDataAccountSigningKey({ ...before, operator: { ...before.operator, seed: before.account.seed } }), /not signed by this broker's operator/);
    eq(JSON.stringify(before), beforeSnapshot, "a refused rotation changed the auth it was given");
    eq(await stored(), after.account.jwt, "a refused rotation reached the broker");
  });
  operator.clear();
} finally {
  for (const client of clients.reverse()) await client.close();
  for (const child of children) {
    await killAndAwaitExit(child, "SIGTERM");
    assert.ok(child.exitCode !== null || child.signalCode !== null, "owned broker remains live");
  }
  for (const release of releases) release();
  if (keepFixture) console.log(`fixture kept: ${dir}`);
  else await rm(dir, { recursive: true, force: true });
  releasePath();
}
console.log(`${passed} of ${passed + failed} cells, ${asserted} assertions`);
emitSentinel({ passed, failed });
if (failed) process.exitCode = 1;
