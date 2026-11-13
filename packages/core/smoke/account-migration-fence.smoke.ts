/** A migration fence must still exclude supported non-expiring credentials after a long sleep. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mock } from "node:test";
import { pathToFileURL } from "node:url";
import { decode, encodeAccount, encodeUser, type Account } from "@nats-io/jwt";
import { fromPublic, fromSeed } from "@nats-io/nkeys";
import { connect, credsAuthenticator, type NatsConnection } from "@nats-io/transport-node";
import { createSuite, awaitBrokerReady, freePort, killAndAwaitExit, SMOKE_BROKER_TOKEN, teardownOnSignal } from "@cotal-ai/smoke-kit";
const coreEntry = process.env.MIGRATION_FENCE_CORE_ENTRY;
const {
  composeSpaceAuth, createBrokerAuth, createSpaceAccountAuth, credsClaims, credsFromJwt, isReachable,
  mintCreds, newIdentity, pushAccountClaim, serverConfig, wakeAccountClaim,
} = await import(coreEntry ? pathToFileURL(coreEntry).href : new URL("../src/index.ts", import.meta.url).href) as typeof import("../src/index.js");

const { check, finish, passed, failed } = createSuite();
const keepFixture = process.argv.includes("--keep-fixture");
const dir = await mkdtemp(join(tmpdir(), `${SMOKE_BROKER_TOKEN}migration-fence-`));
const clients: NatsConnection[] = [];
let child: ReturnType<typeof spawn> | undefined, release: (() => void) | undefined;
const now = () => Math.floor(Date.now() / 1000);
const nextSecond = async () => {
  const before = now();
  while (now() <= before) await new Promise(resolve => setTimeout(resolve, 20));
};
try {
  const broker = await createBrokerAuth("migration-fence"), space = await createSpaceAccountAuth(broker, "migration-fence");
  const auth = composeSpaceAuth(broker, space), oldIdentity = newIdentity();
  const fence = now() - 86_411;
  let oldCreds: string;
  // Only mint this historical fixture credential under the past clock. Broker execution and all
  // account-transition helpers below use the real current clock, without waiting a day in a test.
  mock.timers.enable({ apis: ["Date"], now: (fence - 60) * 1000 });
  try { oldCreds = await mintCreds(auth, oldIdentity, "observer"); }
  finally { mock.timers.reset(); }
  const old = credsClaims(oldCreds);
  check("stock observer credentials can predate the fence without an expiry", old.iat! < fence && old.exp === undefined);
  const port = await freePort(), servers = `nats://127.0.0.1:${port}`;
  const config = join(dir, "server.conf");
  await writeFile(config, serverConfig(broker, [space], { transport: { kind: "plaintext" }, port,
    storeDir: join(dir, "js"), accountResolver: { kind: "full", directory: join(dir, "resolver"), limit: 10, intervalMs: 120_000 },
  }), { mode: 0o600 });
  child = spawn("nats-server", ["-c", config], { stdio: "ignore" });
  release = teardownOnSignal(child, keepFixture ? undefined : dir);
  await awaitBrokerReady(() => isReachable(servers), { servers, attempts: 50, delayMs: 100 });
  const dial = async (creds: string, id: string) => {
    const nc = await connect({ servers, authenticator: credsAuthenticator(new TextEncoder().encode(creds)), inboxPrefix: `_INBOX_${id}`, reconnect: false, timeout: 2_000 });
    clients.push(nc); await nc.flush(); return nc;
  };
  const prior = await dial(oldCreds, oldIdentity.id);
  check("the real broker accepts that supported credential before the fence", !prior.isClosed());
  await prior.close();
  const id = newIdentity();
  const systemJwt = await encodeUser("owned-migration-fence-system", fromPublic(id.id), fromPublic(broker.sys.pub), {
    pub: { allow: [`$SYS.REQ.ACCOUNT.${space.account.pub}.CLAIMS.UPDATE`] }, sub: { allow: [`_INBOX_${id.id}.>`] },
  }, { signer: fromSeed(new TextEncoder().encode(broker.sys.signingSeed!)), exp: now() + 120 });
  const system = await dial(credsFromJwt(systemJwt, id), id.id), serverId = system.info!.server_id;
  const push = (accountJwt: string) => pushAccountClaim(system, { accountJwt, expectedServerIds: [serverId], maxWaitMs: 3_000 });
  await nextSecond();
  const original = decode<Account>(space.account.jwt);
  const signer = fromSeed(new TextEncoder().encode(broker.operator.seed));
  let fenced: string;
  try { fenced = await encodeAccount(original.name, fromPublic(space.account.pub), { ...original.nats, revocations: { "*": fence } }, { signer }); }
  finally { signer.clear(); }
  await push(fenced);
  const beforeWake = await dial(oldCreds, oldIdentity.id).then(nc => nc.close().then(() => false), error => {
    assert.match(String(error), /authorization|authentication|revok/i); return true;
  });
  check("the aged native wildcard still refuses the old credential", beforeWake);
  await nextSecond();
  const woken = await wakeAccountClaim(broker, fenced, now());
  await push(woken);
  const afterWake = await dial(oldCreds, oldIdentity.id).then(nc => nc.close().then(() => false), error => {
    assert.match(String(error), /authorization|authentication|revok/i); return true;
  });
  check("wake does not revive a non-expiring pre-fence credential", afterWake);
  check("wake preserves the original wildcard cutoff", decode<Account>(woken).nats.revocations?.["*"] === fence);
  const freshIdentity = newIdentity(), fresh = await mintCreds(auth, freshIdentity, "observer");
  const current = await dial(fresh, freshIdentity.id);
  check("post-fence credential remains a native positive control", !current.isClosed());
} catch (error) {
  check(`harness: ${error instanceof Error ? error.stack : String(error)}`, false);
} finally {
  mock.timers.reset();
  for (const nc of clients.reverse()) await nc.close();
  if (child) await killAndAwaitExit(child, "SIGTERM");
  release?.();
  if (keepFixture) console.log(`retained owned fixture: ${dir}`);
  else await rm(dir, { recursive: true, force: true });
  if (passed() + failed() !== 6) check(`cell count: ran ${passed() + failed()}, expected 6`, false);
  finish();
}
process.exit(process.exitCode ?? 0);
