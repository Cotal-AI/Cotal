/**
 * The artifacts endpoint, live: a delivery context asked to serve `artifacts` binds it only on the
 * signer holder's proof, and `list` answers a real scoped agent through the normal digest-verified
 * describe-then-invoke path, while a peer outside the channel is refused at the read gate.
 *
 * Against a real nats-server with real minted credentials (plan section 2 and the checkpoint-1 cells):
 *  - asked to serve, the endpoint starts unbound and serveState says so;
 *  - bootstrapDaemonEndpoint registers, mints, adopts and writes `ready`, and the svc status row read
 *    back from the records KV is `ready` at the bound epoch;
 *  - serveState names the credential just minted, by fingerprint, and the adoption op id it was sent;
 *  - a seeded non-empty channel pages under a real agent credential (limit + after);
 *  - a peer whose read ACL lacks the channel is refused, outcome not-executed, with no rows;
 *  - a candidate with an extra row is refused by claims equality and the last-good keeps answering;
 *  - nativeConnections lists artifacts-serve, artifact-data and artifact-sweeper beside the rest.
 *
 * The caller's `artifacts list` row is minted explicitly here (endpointCapabilities), because how an
 * agent gets it by default is the open caller-grant decision; the cell exercises the served path.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, credsAuthenticator, type NatsConnection } from "@nats-io/transport-node";
import { jetstreamManager } from "@nats-io/jetstream";
import { Kvm } from "@nats-io/kv";
import {
  ARTIFACTS_ENDPOINT, ARTIFACTS_LIST_COMMAND, CotalEndpoint, DEV_OWNER, RECORD_KINDS, SERVICE_READY,
  artifactAttachBucket, composeSpaceAuth, createBrokerAuth, createSpaceAccountAuth, credsFingerprint, idFromCreds, provisionAgentDurables,
  isReachable, mintCreds, mintLifecycleUid, mintMembershipObserverCreds, newIdentity, readSvcRecordLeader, recordStatusKey,
  serverConfig, setupSpaceStreams, type SecretStore,
} from "@cotal-ai/core";
import {
  DAEMON_ENDPOINT_BOOTSTRAPS, DAEMON_ENDPOINT_SERVE_CREDS_KIND, bootstrapDaemonEndpoint, daemonEndpointKey,
  deliveryCredsKey, membershipObserverCredsKey, membershipRwCredsKey, readDaemonEndpointInstanceId,
} from "@cotal-ai/workspace";
import { SMOKE_BROKER_TOKEN, createSuite, teardownOnSignal } from "@cotal-ai/smoke-kit";
import { startDeliveryService, type DeliveryServiceHandle } from "../src/index.js";
import { pickFreePort } from "./_free-port.js";

const EXPECTED_CELLS = 12;
const { check, finish, passed, failed } = createSuite();

class MemoryStore implements SecretStore {
  readonly values = new Map<string, string>();
  constructor(readonly identity: { kind: "injected"; coordinate: string }) {}
  async get(k: string) { return this.values.get(k); }
  async put(k: string, v: string) { this.values.set(k, v); }
  async create(k: string, v: string) { if (this.values.has(k)) return false; this.values.set(k, v); return true; }
  async delete(k: string) { this.values.delete(k); }
}
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const digestOf = (text: string) => `sha256:${createHash("sha256").update(text).digest("hex")}`;
/** A raw connection on a scoped credential: its inbox must be `_INBOX_<nkey>`, the only one it reads. */
const dial = async (servers: string, creds: string): Promise<NatsConnection> =>
  connect({ servers, authenticator: credsAuthenticator(new TextEncoder().encode(creds)), inboxPrefix: `_INBOX_${idFromCreds(creds)}`, reconnect: false });

const port = await pickFreePort();
const servers = `nats://127.0.0.1:${port}`;
const broker = await createBrokerAuth("artifacts-endpoint");
const space = `artifacts-${Date.now()}`;
const account = await createSpaceAccountAuth(broker, space);
const auth = composeSpaceAuth(broker, account);
const brokerDir = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
writeFileSync(join(brokerDir, "server.conf"), serverConfig(broker, [account], { transport: { kind: "plaintext" }, port, storeDir: join(brokerDir, "js") }));
const nats = spawn("nats-server", ["-c", join(brokerDir, "server.conf")], { stdio: "ignore" });
const release = teardownOnSignal(nats, brokerDir);
const composition = { injected: true as const };
let handle: DeliveryServiceHandle | undefined;
const endpoints: CotalEndpoint[] = [];
const conns: NatsConnection[] = [];

try {
  let up = false;
  for (let i = 0; i < 50 && !up; i++) { up = await isReachable(servers); if (!up) await wait(200); }
  if (!up) throw new Error(`nats-server did not come up on ${port}`);
  const provisionerId = newIdentity();
  const provisioner = await mintCreds(auth, provisionerId, "provisioner");
  await setupSpaceStreams({ servers, space, creds: provisioner });
  const provisionerEp = new CotalEndpoint({ space, servers, creds: provisioner, channels: [], consume: false, registerPresence: false, watchPresence: false,
    card: { id: provisionerId.id, name: "provisioner", role: "provisioner", kind: "agent" } });
  provisionerEp.on("error", () => {});
  endpoints.push(provisionerEp);
  await provisionerEp.start();
  const store = new MemoryStore({ kind: "injected", coordinate: `memory:${space}` });
  await store.put(deliveryCredsKey(space, composition), await mintCreds(auth, newIdentity(), "delivery"));
  await store.put(membershipObserverCredsKey(space, composition), await mintMembershipObserverCreds(auth, newIdentity()));
  await store.put(membershipRwCredsKey(space, composition), await mintCreds(auth, newIdentity(), "membership-rw"));

  handle = await startDeliveryService({
    context: { accountPublicKey: account.account.pub, lifecycleUid: "artifacts-ctx" },
    space, servers, store, storeIdentity: store.identity, stateDir: join(brokerDir, "state"), endpoints: [ARTIFACTS_ENDPOINT],
  });

  // ---- asked to serve: unbound until the signer holder's proof ----
  const adminId = newIdentity();
  const admin = new CotalEndpoint({ space, servers, creds: await mintCreds(auth, adminId, "endpoint-evictor", { expiresInSeconds: 600 }),
    card: { id: adminId.id, name: "admin", kind: "endpoint" }, channels: [], consume: false, watchChannels: false, watchPresence: false, registerPresence: false });
  admin.on("error", () => {});
  endpoints.push(admin);
  await admin.start();
  const before = await admin.requestDeliveryAdmin("serveState", { endpoint: ARTIFACTS_ENDPOINT }, 10_000);
  check("asked to serve, artifacts starts unbound and serveState says so",
    before.ok && (before.data as { bound?: boolean }).bound === false, before);

  // ---- bootstrap: register, mint, adopt, ready on proof ----
  const log: string[] = [];
  const bound = await bootstrapDaemonEndpoint({ auth, servers, space, store, log: (l) => log.push(l) }, DAEMON_ENDPOINT_BOOTSTRAPS[ARTIFACTS_ENDPOINT]!());
  const instanceId = await readDaemonEndpointInstanceId(store, space, ARTIFACTS_ENDPOINT);
  const after = await admin.requestDeliveryAdmin("serveState", { endpoint: ARTIFACTS_ENDPOINT }, 10_000);
  const state = (after.data as { state?: { epoch: number; credentialFingerprint: string; instanceId: string; adoptionOpId: string } }).state;
  const minted = await store.get(daemonEndpointKey(space, ARTIFACTS_ENDPOINT, DAEMON_ENDPOINT_SERVE_CREDS_KIND));
  check("serveState names the serve credential just minted, by its JWT fingerprint, at the bound epoch",
    state !== undefined && minted !== undefined && state.credentialFingerprint === credsFingerprint(minted) && state.epoch === bound.epoch && state.instanceId === instanceId, { state, bound });
  check("serveState carries the adoption op id the bootstrap sent", typeof state?.adoptionOpId === "string" && state.adoptionOpId.length > 0);

  // A fresh delivery-profile connection: it holds the leader-served records read the status row needs.
  const reader = await dial(servers, await mintCreds(auth, newIdentity(), "delivery"));
  conns.push(reader);
  const status = await readSvcRecordLeader(await jetstreamManager(reader), space, recordStatusKey(RECORD_KINDS.svc, [ARTIFACTS_ENDPOINT, instanceId!]));
  const statusValue = status && !("deleted" in status) ? status.value as { state?: string; epoch?: number } : undefined;
  check("the svc status row read back from the records KV is ready at the bound epoch",
    statusValue?.state === SERVICE_READY && statusValue.epoch === bound.epoch, statusValue);

  // ---- seed a non-empty channel, then page it under a real scoped agent ----
  const channel = "work.artifacts";
  const now = Date.now();
  const digests = ["one", "two", "three"].map(digestOf).sort();
  const sweeperNc = await dial(servers, await mintCreds(auth, newIdentity(), "artifact-sweeper"));
  conns.push(sweeperNc);
  const attach = await new Kvm(sweeperNc).open(artifactAttachBucket(space));
  for (const [i, d] of digests.entries())
    await attach.put(`${channel}.${d.slice(7)}`, JSON.stringify({ state: "attached", confirmerLifecycleUid: "x", name: `f${i}.txt`, mediaType: "text/plain", size: 10 + i, createdAt: now, expiresAt: now + 86_400_000, pinned: false }));
  // A deeper channel's row and an index row must never appear in this channel's list.
  await attach.put(`${channel}.deeper.${digests[0]!.slice(7)}`, JSON.stringify({ state: "attached", confirmerLifecycleUid: "x", name: "no", mediaType: "text/plain", size: 1, createdAt: now, expiresAt: now + 1, pinned: false }));
  await attach.put(`=d.${digests[0]!.slice(7)}.${channel}`, JSON.stringify({}));

  const agentOf = async (actor: string, allowSubscribe: string[]) => {
    const uid = mintLifecycleUid();
    const principal = { owner: DEV_OWNER, actor };
    // The real provisioning path: durables, and the read ACL row written beside the mint.
    await provisionAgentDurables(provisionerEp, { ...principal, lifecycleUid: uid }, { subscribe: [], allowSubscribe });
    const id = newIdentity();
    const creds = await mintCreds(auth, id, "agent", { principal, lifecycleUid: uid, allowSubscribe, allowPublish: [],
      endpointCapabilities: [{ endpoint: ARTIFACTS_ENDPOINT, command: ARTIFACTS_LIST_COMMAND }] });
    const ep = new CotalEndpoint({ space, servers, creds, lifecycleUid: uid, channels: [], allowSubscribe, watchChannels: false, watchPresence: false, registerPresence: false,
      card: { id: id.id, owner: DEV_OWNER, actor, name: actor, kind: "agent" } });
    ep.on("error", () => {});
    endpoints.push(ep);
    await ep.start();
    return ep;
  };
  const member = await agentOf("reader", [channel]);
  const page1 = (await member.invokeService(ARTIFACTS_ENDPOINT, ARTIFACTS_LIST_COMMAND, { channel, limit: 2 })).reply;
  const p1 = page1.ok ? page1.data as { rows: { digest: string; name: string }[]; next?: string } : undefined;
  check("a scoped agent that may read the channel gets the first page through describe then invoke",
    p1 !== undefined && p1.rows.length === 2 && p1.rows[0]!.digest === digests[0] && p1.rows[1]!.digest === digests[1] && p1.next === digests[1], page1);
  const page2 = (await member.invokeService(ARTIFACTS_ENDPOINT, ARTIFACTS_LIST_COMMAND, { channel, limit: 2, after: p1?.next })).reply;
  const p2 = page2.ok ? page2.data as { rows: { digest: string }[]; next?: string } : undefined;
  check("after pages to the remaining row and the last page carries no next",
    p2 !== undefined && p2.rows.length === 1 && p2.rows[0]!.digest === digests[2] && p2.next === undefined, page2);
  check("the list names neither the deeper channel's row nor the digest-index row",
    [...(p1?.rows ?? []), ...(p2?.rows ?? [])].every((r) => !("name" in r) || (r as { name: string }).name !== "no"));

  // ---- a peer outside the channel is refused at the read gate ----
  const peer = await agentOf("outsider", ["other"]);
  const refused = (await peer.invokeService(ARTIFACTS_ENDPOINT, ARTIFACTS_LIST_COMMAND, { channel })).reply;
  check("a peer whose read ACL lacks the channel is refused with exactly the collapsed tuple and no data",
    !refused.ok && JSON.stringify(refused.error) === JSON.stringify({ code: "permission-denied", message: "list: not authorized for that channel", outcome: "not-executed" })
      && !("data" in refused), refused);
  const unknownChannel = (await peer.invokeService(ARTIFACTS_ENDPOINT, ARTIFACTS_LIST_COMMAND, { channel: "nothing.here" })).reply;
  check("an empty channel the peer also cannot read gets the same refusal, byte for byte",
    JSON.stringify(unknownChannel.ok ? unknownChannel : unknownChannel.error) === JSON.stringify(refused.ok ? refused : refused.error), unknownChannel);

  // ---- a candidate with an extra row never binds; last-good keeps answering ----
  const good = minted!;
  // A real credential that is not the persisted serve nkey's: claims equality refuses it before it dials.
  await store.put(daemonEndpointKey(space, ARTIFACTS_ENDPOINT, DAEMON_ENDPOINT_SERVE_CREDS_KIND), await mintCreds(auth, newIdentity(), "artifact-data"));
  const badAdopt = await admin.requestDeliveryAdmin("adoptEndpointCreds", { endpoint: ARTIFACTS_ENDPOINT, adoptionOpId: mintLifecycleUid() }, 20_000);
  const stillGood = await admin.requestDeliveryAdmin("serveState", { endpoint: ARTIFACTS_ENDPOINT }, 10_000);
  check("a candidate that is not the persisted serve nkey's credential is refused and nothing new binds",
    !badAdopt.ok && (stillGood.data as { state?: { credentialFingerprint?: string } }).state?.credentialFingerprint === credsFingerprint(good), { badAdopt, stillGood });
  const again = (await member.invokeService(ARTIFACTS_ENDPOINT, ARTIFACTS_LIST_COMMAND, { channel, limit: 1 })).reply;
  check("the last-good serve connection still answers list after the refused candidate", again.ok, again);

  // ---- native inventory ----
  let labels = "";
  for (let i = 0; i < 100; i++) {
    try { labels = handle.nativeConnections().map((r) => r.label).sort().join(","); break; } catch { await wait(50); }
  }
  check("nativeConnections lists artifacts-serve, artifact-data and artifact-sweeper beside the daemon's own",
    labels === "artifact-data,artifact-sweeper,artifacts-serve,endpoint,membership-rw,timer-writer", labels);
} catch (e) {
  check("the cell ran to completion", false, (e as Error).stack ?? String(e));
} finally {
  for (const ep of endpoints) await ep.stop().catch(() => {});
  for (const nc of conns) await nc.close().catch(() => {});
  await handle?.close().catch(() => {});
  await release();
}
finish();
if (passed() + failed() !== EXPECTED_CELLS) {
  console.error(`expected ${EXPECTED_CELLS} cells, ran ${passed() + failed()}`);
  process.exitCode = 1;
}
