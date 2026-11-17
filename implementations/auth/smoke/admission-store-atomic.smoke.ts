/** A live first-use admission store must be hardened by its CREATE, without UPDATE authority. */
import { connect, headers, type NatsConnection } from "@nats-io/transport-node";
import { jetstream, jetstreamManager, JetStreamApiError } from "@nats-io/jetstream";
import { Kvm } from "@nats-io/kv";
import { encodeUser } from "@nats-io/jwt";
import { fromPublic, fromSeed } from "@nats-io/nkeys";
import { createSuite } from "@cotal-ai/smoke-kit";
import { admissionBucket, assertAdmissionStoreConfig, credsFromJwt, ensureAdmissionStore, isPermissionDenied,
  newIdentity, standaloneConnectOpts } from "@cotal-ai/core";
import { startHostedAuthFixture } from "./_hosted-auth-fixture.js";

const { check, finish, passed, failed } = createSuite();
const fx = await startHostedAuthFixture("atomic-admission", 1);
const account = fx.accounts[0]!, space = account.space;
const bucket = admissionBucket(space), stream = `KV_${bucket}`;
const connections: NatsConnection[] = [];
const open = async (publish: string[], subscribe?: string[]) => {
  const id = newIdentity();
  const jwt = await encodeUser("atomic-admission-fixture", fromPublic(id.id), fromPublic(account.auth.account.pub), {
    pub: { allow: publish }, sub: { allow: subscribe ?? [`_INBOX_${id.id}.>`] },
  }, { signer: fromSeed(new TextEncoder().encode(account.auth.account.signingSeed)), exp: Math.floor(Date.now() / 1000) + 60 });
  const nc = await connect({ servers: fx.servers, ...standaloneConnectOpts({ creds: credsFromJwt(jwt, id), tls: false }), reconnect: false });
  connections.push(nc);
  return nc;
};
try {
  const creator = await open(["$JS.API.INFO", `$JS.API.STREAM.INFO.${stream}`, `$JS.API.STREAM.CREATE.${stream}`]);
  const jsm = await jetstreamManager(creator), kvm = new Kvm(creator);
  let creationError: unknown;
  try { await ensureAdmissionStore(jsm, kvm, space); } catch (error) { creationError = error; }
  check("first-use creation succeeds with CREATE and INFO but no UPDATE grant", creationError === undefined,
    creationError instanceof Error ? creationError.message : undefined);
  const config = (await jsm.streams.info(stream)).config;
  let canonical = true;
  try { assertAdmissionStoreConfig(config, space); } catch { canonical = false; }
  check("the first created store already carries its immutable authority policy", canonical);
  const updateDenied = await jsm.streams.update(stream, config).then(() => false, error => { if (!isPermissionDenied(error)) throw error; return true; });
  check("the creation principal really has no UPDATE authority", updateDenied);
  const stable = (await jsm.streams.info(stream)).created;
  const repeated = await ensureAdmissionStore(jsm, kvm, space).then(() => true, () => false);
  check("a repeated ensure verifies the same native incarnation", repeated && (await jsm.streams.info(stream)).created === stable);

  const key = "admission.v1.manager.fixture";
  const writer = await open(["$JS.API.INFO", `$KV.${bucket}.${key}`]);
  const kv = await new Kvm(writer).open(bucket, { allow_direct: false });
  const first = await kv.put(key, "original authority bytes");
  check("an authorized first admission write succeeds", first > 0);
  const replaced = await kv.put(key, "replacement").then(() => undefined, error => { if (!(error instanceof JetStreamApiError)) throw error; return error; });
  check("the broker refuses replacement at its per-subject limit", replaced?.code === 10077, replaced?.code);
  const rollup = headers(); rollup.set("Nats-Rollup", "all");
  const rolled = await jetstream(writer).publish(`$KV.${bucket}.${key}`, new Uint8Array(), { headers: rollup })
    .then(() => undefined, error => { if (!(error instanceof JetStreamApiError)) throw error; return error; });
  check("the broker refuses a rollup that would erase authority", rolled !== undefined && /rollup/i.test(rolled.message), rolled?.code);
  const observer = await open(["$JS.API.INFO", `$JS.API.STREAM.MSG.GET.${stream}`]);
  const original = await (await new Kvm(observer).open(bucket, { allow_direct: false })).get(key);
  check("a separate leader read still returns the original authority bytes", original?.string() === "original authority bytes");
  const foreign = await jsm.streams.add({ name: "foreign", subjects: ["foreign.>"] }).then(() => true, error => { if (!isPermissionDenied(error)) throw error; return false; });
  check("the initializer cannot create a foreign stream", !foreign);
} catch (error) {
  check(`harness: ${error instanceof Error ? error.message : "unknown failure"}`, false);
} finally {
  for (const nc of connections) await nc.close();
  await fx.close();
  if (passed() + failed() !== 9) check(`cell count: ran ${passed() + failed()}, expected 9`, false);
  finish();
}
process.exit(process.exitCode ?? 0);
