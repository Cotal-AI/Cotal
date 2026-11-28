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
 *  - renewal re-mints at the same epoch and the daemon binds the new credential on proof;
 *  - a gate frozen, or a registration revision moved, at an unchanged epoch refuses the bind and the
 *    re-mint, while last-good keeps answering;
 *  - a re-registration of the same instance is a takeover through the real verify-evict, the epoch
 *    advances, and list answers at the new epoch; a genuine serve credential for the superseded
 *    epoch is then refused by claims equality;
 *  - nativeConnections lists artifacts-serve, artifact-data and artifact-sweeper beside the rest.
 *
 * The caller's `artifacts list` row comes from the `artifacts` capability token (option A): the
 * member and the peer are minted with it, and a third agent without it is refused by the broker.
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
  ARTIFACTS_CAPABILITY, ARTIFACTS_ENDPOINT, ARTIFACTS_LIST_COMMAND, CotalEndpoint, DEV_OWNER, RECORD_KINDS, SERVICE_READY,
  artifactAttachBucket, composeSpaceAuth, createBrokerAuth, createSpaceAccountAuth, credsFingerprint, idFromCreds, provisionAgentDurables,
  isReachable, mintConnectionEvictorCreds, mintCreds, mintLifecycleUid, mintMembershipObserverCreds, newIdentity, readSvcRecordLeader, recordStatusKey,
  serverConfig, setupSpaceStreams, epAuthBucket, epgateKey, EpEnvelopeError, endpointRegistrationBarrier, artifactsClusterArtifacts, principalKey, type SecretStore,
} from "@cotal-ai/core";
import {
  DAEMON_ENDPOINT_BOOTSTRAPS, DAEMON_ENDPOINT_SERVE_CREDS_KIND, ARTIFACT_SWEEPER_CREDS_KIND, bootstrapDaemonEndpoint, daemonEndpointKey,
  deliveryCredsKey, membershipObserverCredsKey, membershipRwCredsKey, connectionEvictorCredsKey, readDaemonEndpointInstanceId, readDaemonEndpointServeId, renewDaemonEndpoint,
} from "@cotal-ai/workspace";
import { SMOKE_BROKER_TOKEN, createSuite, teardownOnSignal } from "@cotal-ai/smoke-kit";
import { startDeliveryService, type DeliveryServiceHandle } from "../src/index.js";
import { deriveDaemonServeGrant, DaemonEndpointBinder } from "../src/endpoint-bind.js";
import { artifactsServedEndpoint } from "../src/artifacts-endpoint.js";
import { pickFreePort } from "./_free-port.js";

const EXPECTED_CELLS = 36;
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
  // The connection evictor `cotal up` provisions: a restart takeover verify-evicts the superseded serve
  // family through it, and eviction is never skipped.
  await store.put(connectionEvictorCredsKey(space, composition), await mintConnectionEvictorCreds(auth, newIdentity()));

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
  // A deeper channel's row and an index row, both LIVE and well-formed (E16), must never appear in this
  // channel's list. The deeper row is a real attachment of `work.artifacts.deeper`, listed there.
  await attach.put(`${channel}.deeper.${digests[0]!.slice(7)}`, JSON.stringify({ state: "attached", confirmerLifecycleUid: "x", name: "deeper-only.txt", mediaType: "text/plain", size: 1, createdAt: now, expiresAt: now + 86_400_000, pinned: false }));
  await attach.put(`=d.${digests[0]!.slice(7)}.${channel}`, JSON.stringify({ channel }));
  // E14: an unpinned row past its expiry, not yet swept, and a pinned row whose expiry is also past.
  const expiredDigest = digestOf("expired"), pinnedDigest = digestOf("pinned");
  const expiryChannel = "work.expiry";
  await attach.put(`${expiryChannel}.${expiredDigest.slice(7)}`, JSON.stringify({ state: "attached", confirmerLifecycleUid: "x", name: "stale.txt", mediaType: "text/plain", size: 1, createdAt: now - 10, expiresAt: now - 1, pinned: false }));
  await attach.put(`${expiryChannel}.${pinnedDigest.slice(7)}`, JSON.stringify({ state: "attached", confirmerLifecycleUid: "x", name: "kept.txt", mediaType: "text/plain", size: 1, createdAt: now - 10, expiresAt: now - 1, pinned: true }));

  const agentOf = async (actor: string, allowSubscribe: string[], token = true) => {
    const uid = mintLifecycleUid();
    const principal = { owner: DEV_OWNER, actor };
    // The real provisioning path: durables, and the read ACL row written beside the mint.
    await provisionAgentDurables(provisionerEp, { ...principal, lifecycleUid: uid }, { subscribe: [], allowSubscribe });
    const id = newIdentity();
    // The caller's rows come from the `artifacts` capability token (option A), never the baseline.
    const creds = await mintCreds(auth, id, "agent", { principal, lifecycleUid: uid, allowSubscribe, allowPublish: [],
      ...(token ? { capabilities: [ARTIFACTS_CAPABILITY] } : {}) });
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
  check("the list holds exactly this channel's three rows: no deeper-channel row, no digest-index row",
    JSON.stringify([...(p1?.rows ?? []), ...(p2?.rows ?? [])].map((r) => r.digest)) === JSON.stringify(digests)
      && [...(p1?.rows ?? []), ...(p2?.rows ?? [])].every((r) => (r as { name?: string }).name !== "deeper-only.txt"));
  const deeperMember = await agentOf("deeper", [`${channel}.deeper`]);
  const deeperList = (await deeperMember.invokeService(ARTIFACTS_ENDPOINT, ARTIFACTS_LIST_COMMAND, { channel: `${channel}.deeper` })).reply;
  check("the deeper row is live and listed on its own channel, so its absence above is not vacuous",
    deeperList.ok && JSON.stringify((deeperList.data as { rows: { name: string }[] }).rows.map((r) => r.name)) === JSON.stringify(["deeper-only.txt"]), deeperList);
  const expiryMember = await agentOf("expiry", [expiryChannel]);
  const expiryList = (await expiryMember.invokeService(ARTIFACTS_ENDPOINT, ARTIFACTS_LIST_COMMAND, { channel: expiryChannel })).reply;
  check("an unpinned row past its expiry is not listed before any sweep, and a pinned row past its expiry still is",
    expiryList.ok && JSON.stringify((expiryList.data as { rows: { digest: string }[] }).rows.map((r) => r.digest)) === JSON.stringify([pinnedDigest]), expiryList);

  // ---- a peer outside the channel is refused at the read gate ----
  const peer = await agentOf("outsider", ["other"]);
  const refused = (await peer.invokeService(ARTIFACTS_ENDPOINT, ARTIFACTS_LIST_COMMAND, { channel })).reply;
  check("a peer whose read ACL lacks the channel is refused with exactly the collapsed tuple and no data",
    !refused.ok && JSON.stringify(refused.error) === JSON.stringify({ code: "permission-denied", message: "list: not authorized for that channel", outcome: "not-executed" })
      && !("data" in refused), refused);
  const unknownChannel = (await peer.invokeService(ARTIFACTS_ENDPOINT, ARTIFACTS_LIST_COMMAND, { channel: "nothing.here" })).reply;
  check("an empty channel the peer also cannot read gets the same refusal, byte for byte",
    JSON.stringify(unknownChannel.ok ? unknownChannel : unknownChannel.error) === JSON.stringify(refused.ok ? refused : refused.error), unknownChannel);

  // ---- an agent with no `artifacts` token cannot even send the request: the broker refuses it ----
  // E16: pinned to the broker's refusal, not any permission-shaped text. The reply the client builds for
  // a broker publish denial is `permission-denied` with outcome `not-executed`, and no responder is
  // attributed because the request never reached one.
  const untokened = await agentOf("untokened", [channel], false);
  let tokenless: { code?: string; outcome?: string; responder?: unknown; thrown?: string } = {};
  try {
    const attributed = await untokened.invokeService(ARTIFACTS_ENDPOINT, ARTIFACTS_LIST_COMMAND, { channel });
    tokenless = { ...(attributed.reply.ok ? {} : { code: attributed.reply.error?.code, outcome: attributed.reply.error?.outcome }), responder: attributed.responder };
  } catch (e) {
    tokenless = e instanceof EpEnvelopeError ? { code: e.code, outcome: e.outcome, thrown: e.message } : { thrown: (e as Error).message };
  }
  check("an agent that may read the channel but holds no artifacts token is refused by the broker, not-executed, with no responder",
    tokenless.code === "permission-denied" && tokenless.outcome === "not-executed" && tokenless.responder === undefined, tokenless);

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
  await store.put(daemonEndpointKey(space, ARTIFACTS_ENDPOINT, DAEMON_ENDPOINT_SERVE_CREDS_KIND), good);

  // ---- E12: an under-granted STORE candidate refuses the bind, and last-good keeps BOTH its serve and
  //      its store connections: an agent's list still answers afterwards. ----
  const goodSweeper = (await store.get(daemonEndpointKey(space, ARTIFACTS_ENDPOINT, ARTIFACT_SWEEPER_CREDS_KIND)))!;
  const servedBeforeStore = (await admin.requestDeliveryAdmin("serveState", { endpoint: ARTIFACTS_ENDPOINT }, 10_000)).data as { state?: { credentialFingerprint: string } };
  // An observer credential dials and authenticates but reads none of the index streams.
  await store.put(daemonEndpointKey(space, ARTIFACTS_ENDPOINT, ARTIFACT_SWEEPER_CREDS_KIND), await mintCreds(auth, newIdentity(), "observer"));
  const storeAdopt = await admin.requestDeliveryAdmin("adoptEndpointCreds", { endpoint: ARTIFACTS_ENDPOINT, adoptionOpId: mintLifecycleUid() }, 20_000);
  const servedAfterStore = (await admin.requestDeliveryAdmin("serveState", { endpoint: ARTIFACTS_ENDPOINT }, 10_000)).data as { state?: { credentialFingerprint: string } };
  check("a store candidate that cannot read the index streams refuses the bind, naming the store proof, and serveState is unchanged",
    !storeAdopt.ok && /store credentials do not prove|cannot read stream/.test(storeAdopt.error ?? "")
      && servedAfterStore.state?.credentialFingerprint === servedBeforeStore.state?.credentialFingerprint, storeAdopt);
  const afterStoreRefusal = (await member.invokeService(ARTIFACTS_ENDPOINT, ARTIFACTS_LIST_COMMAND, { channel, limit: 1 })).reply;
  check("after the refused store candidate an agent's list still answers on the last-good store connection",
    afterStoreRefusal.ok && (afterStoreRefusal.data as { rows: unknown[] }).rows.length === 1, afterStoreRefusal);
  await store.put(daemonEndpointKey(space, ARTIFACTS_ENDPOINT, ARTIFACT_SWEEPER_CREDS_KIND), goodSweeper);

  // ---- renewal: the same registration, the same epoch, a new credential, adopted on proof ----
  const target = { auth, servers, space, store, log: (l: string) => log.push(l) };
  // The serve identity persists and the grant is unchanged, and a JWT's `iat` is whole seconds: a
  // re-mint in the same second as the first mint is byte-identical to it. Cross a second boundary so
  // "a new credential, not last-good" is decidable rather than timing-dependent.
  await new Promise((r) => setTimeout(r, 1_050 - (Date.now() % 1_000)));
  const renewed = await renewDaemonEndpoint(target, DAEMON_ENDPOINT_BOOTSTRAPS[ARTIFACTS_ENDPOINT]!());
  const afterRenew = (await admin.requestDeliveryAdmin("serveState", { endpoint: ARTIFACTS_ENDPOINT }, 10_000)).data as { state?: { epoch: number; credentialFingerprint: string } };
  const renewedCreds = await store.get(daemonEndpointKey(space, ARTIFACTS_ENDPOINT, DAEMON_ENDPOINT_SERVE_CREDS_KIND));
  check("renewal re-mints at the same epoch and the daemon binds the new credential, not last-good",
    renewed.epoch === bound.epoch && afterRenew.state?.epoch === bound.epoch && renewedCreds !== undefined
      && afterRenew.state.credentialFingerprint === credsFingerprint(renewedCreds) && renewedCreds !== good,
    { renewed, afterRenew, storedFp: renewedCreds && credsFingerprint(renewedCreds), goodFp: credsFingerprint(good), sameAsGood: renewedCreds === good });
  const afterRenewList = (await member.invokeService(ARTIFACTS_ENDPOINT, ARTIFACTS_LIST_COMMAND, { channel, limit: 1 })).reply;
  check("list answers on the renewed serve connection", afterRenewList.ok, afterRenewList);

  // ---- a gate frozen at an unchanged epoch: nothing binds, last-good keeps answering ----
  // The scoped executor for this one instance holds the auth-store write a registration barrier uses;
  // the cell freezes the gate with it exactly as a barrier would, without advancing the epoch.
  const executorCreds = await mintCreds(auth, newIdentity(), "endpoint-serve-executor", { endpointServeExecutor: { endpoint: ARTIFACTS_ENDPOINT, instanceId: instanceId! } });
  const execNc = await dial(servers, executorCreds);
  conns.push(execNc);
  const authKv = await new Kvm(execNc).open(epAuthBucket(space));
  const gateKey = epgateKey(ARTIFACTS_ENDPOINT, instanceId!);
  const openEntry = (await authKv.get(gateKey))!;
  const openRow = JSON.parse(new TextDecoder().decode(openEntry.value)) as Record<string, unknown>;
  const frozenRev = await authKv.update(gateKey, JSON.stringify({ ...openRow, state: "frozen", op: { opId: mintLifecycleUid(), kind: "registration" } }), openEntry.revision);
  const servingBefore = (await admin.requestDeliveryAdmin("serveState", { endpoint: ARTIFACTS_ENDPOINT }, 10_000)).data as { state?: { credentialFingerprint: string } };
  const frozenAdopt = await admin.requestDeliveryAdmin("adoptEndpointCreds", { endpoint: ARTIFACTS_ENDPOINT, adoptionOpId: mintLifecycleUid() }, 20_000);
  const servingAfter = (await admin.requestDeliveryAdmin("serveState", { endpoint: ARTIFACTS_ENDPOINT }, 10_000)).data as { state?: { credentialFingerprint: string } };
  check("a gate frozen at an unchanged epoch refuses the bind, naming the frozen gate, and keeps last-good",
    !frozenAdopt.ok && /frozen|not open/.test(frozenAdopt.error ?? "") && servingAfter.state?.credentialFingerprint === servingBefore.state?.credentialFingerprint, { frozenAdopt });
  const duringFreeze = (await member.invokeService(ARTIFACTS_ENDPOINT, ARTIFACTS_LIST_COMMAND, { channel, limit: 1 })).reply;
  check("last-good still answers list while the gate is frozen", duringFreeze.ok, duringFreeze);
  let remintRefused: string | undefined;
  try { await renewDaemonEndpoint(target, DAEMON_ENDPOINT_BOOTSTRAPS[ARTIFACTS_ENDPOINT]!()); } catch (e) { remintRefused = (e as Error).message; }
  check("renewal against a frozen gate re-mints nothing and says why", remintRefused !== undefined && /frozen/.test(remintRefused), remintRefused);

  // ---- a registration revision moved at an unchanged epoch: the whole-tuple re-read refuses ----
  await authKv.update(gateKey, JSON.stringify({ ...openRow, registrationRevision: (openRow.registrationRevision as number) + 1 }), frozenRev);
  const revAdopt = await admin.requestDeliveryAdmin("adoptEndpointCreds", { endpoint: ARTIFACTS_ENDPOINT, adoptionOpId: mintLifecycleUid() }, 20_000);
  check("a gate whose registration revision moved at an unchanged epoch refuses the bind",
    !revAdopt.ok && /revision|changed/.test(revAdopt.error ?? ""), revAdopt);
  // Put the gate back exactly as it was, so the restart below starts from a real registration.
  const cur = (await authKv.get(gateKey))!;
  await authKv.update(gateKey, JSON.stringify(openRow), cur.revision);

  // ---- E16: an ordered write between the two gate reads of one derive ----
  // The derive reads the gate, then the spec, then the gate again. A wrapper lands a real gate write
  // (generation + 1, still open) after the FIRST gate read returns and before the second one is sent,
  // so the change is ordered between them, not raced. A clean derive at the same point is the control.
  const servePrincipal = principalKey(DEV_OWNER, (await readDaemonEndpointServeId(store, space, ARTIFACTS_ENDPOINT))!).key;
  const served = { endpoint: ARTIFACTS_ENDPOINT, cluster: artifactsClusterArtifacts(), defs: () => [] };
  const readerJsm = await jetstreamManager(reader);
  const gateSubject = `$KV.${epAuthBucket(space)}.${gateKey}`;
  const control = await deriveDaemonServeGrant(readerJsm, { space, endpoint: served, instanceId: instanceId!, servePrincipal }).then(() => "derived", (e: Error) => e.message);
  let gateReads = 0;
  const interleaved = new Proxy(readerJsm, { get: (target, prop) => prop !== "streams" ? Reflect.get(target, prop) : new Proxy(target.streams, {
    get: (streams, sp) => sp !== "getMessage" ? Reflect.get(streams, sp) : async (stream: string, q: { last_by_subj?: string }) => {
      const m = await streams.getMessage(stream, q as never);
      if (q?.last_by_subj === gateSubject && ++gateReads === 1) {
        const now = (await authKv.get(gateKey))!;
        const row = JSON.parse(new TextDecoder().decode(now.value)) as Record<string, unknown>;
        await authKv.update(gateKey, JSON.stringify({ ...row, generation: (row.generation as number) + 1 }), now.revision);
      }
      return m;
    },
  }) });
  const raced = await deriveDaemonServeGrant(interleaved, { space, endpoint: served, instanceId: instanceId!, servePrincipal }).then(() => "derived", (e: Error) => e.message);
  check("a gate write ordered between the derive's two gate reads refuses the grant; the same derive without it succeeds",
    control === "derived" && gateReads === 2 && /changed between its two reads/.test(raced), { control, gateReads, raced });
  const moved = (await authKv.get(gateKey))!;
  await authKv.update(gateKey, JSON.stringify(openRow), moved.revision);

  // ---- E19: the store set, the sweep scope and the bound generation move as one transition ----
  // A binder of its own over the REAL artifacts endpoint, the real gate and the minted serve credential,
  // with ordered holds inside its bind. Nothing here touches the daemon's own binder.
  let nextHold: ((point: "bound" | "retiring") => Promise<void>) | undefined;
  const own = new DaemonEndpointBinder({
    space, servers, tls: false, log: () => {},
    endpoint: artifactsServedEndpoint({ space, servers, tls: false, store, delivery: { aclForAlias: async () => undefined }, deliveryJsm: () => readerJsm, log: () => {} }),
    hold: async (point) => { const h = nextHold; if (h) await h(point); },
  });
  const ownAdopt = async () => own.adopt({ creds: (await store.get(daemonEndpointKey(space, ARTIFACTS_ENDPOINT, DAEMON_ENDPOINT_SERVE_CREDS_KIND)))!, instanceId: instanceId!,
    serveId: (await readDaemonEndpointServeId(store, space, ARTIFACTS_ENDPOINT))!, adoptionOpId: mintLifecycleUid(), jsm: readerJsm });
  const firstOwn = await ownAdopt().then((st) => st.credentialFingerprint, (e: Error) => `!${e.message}`);
  const sweepAfterFirst = own.sweepCurrent();
  nextHold = async (point) => { if (point === "bound") throw new EpEnvelopeError("unavailable", "readiness refused after the handlers were built"); };
  const refusedOwn = await ownAdopt().then(() => "bound", (e: Error) => e.message);
  nextHold = undefined;
  const afterRefusal = own.serveState();
  check("a candidate refused after its handlers were built leaves last-good serving AND its sweep running under last-good's generation",
    !firstOwn.startsWith("!") && sweepAfterFirst === true && /readiness refused/.test(refusedOwn)
      && afterRefusal.bound && afterRefusal.state.credentialFingerprint === firstOwn && own.sweepCurrent() === true, { firstOwn, refusedOwn, sweepAfterFirst, sweepNow: own.sweepCurrent() });
  nextHold = async (point) => { if (point === "retiring") await own.quiesce("lost the lease while the bind retired its predecessor"); };
  const quiescedOwn = await ownAdopt().then(() => "bound", (e: Error) => e.message);
  nextHold = undefined;
  const afterQuiesce = own.serveState();
  check("a lease lost while a bind retires its predecessor ends that bind: it reports the refusal, serveState is unbound, and the sweep is fenced",
    /stopped serving its shard while the bind retired/.test(quiescedOwn) && !afterQuiesce.bound && /lost the lease/.test(afterQuiesce.cause) && own.sweepCurrent() === undefined, { quiescedOwn, afterQuiesce });
  own.leaseRegained();
  const reboundOwn = await ownAdopt().then(() => own.sweepCurrent(), (e: Error) => `!${e.message}`);
  check("after the lease is regained the next adoption binds, and its sweep runs under the new generation", reboundOwn === true, reboundOwn);
  await own.close();

  // ---- restart takeover: the same instance re-registers, the epoch advances, the old family goes ----
  const oldServeId = (await readDaemonEndpointServeId(store, space, ARTIFACTS_ENDPOINT))!;
  const restarted = await bootstrapDaemonEndpoint(target, DAEMON_ENDPOINT_BOOTSTRAPS[ARTIFACTS_ENDPOINT]!());
  const afterRestart = (await admin.requestDeliveryAdmin("serveState", { endpoint: ARTIFACTS_ENDPOINT }, 10_000)).data as { state?: { epoch: number; instanceId: string } };
  check("a re-registration of the same instance is a takeover: the epoch advances and the daemon binds it",
    restarted.epoch > bound.epoch && restarted.instanceId === instanceId && afterRestart.state?.epoch === restarted.epoch, { restarted, afterRestart });
  check("the takeover keeps the persisted serve identity, so the gate's principal holds",
    (await readDaemonEndpointServeId(store, space, ARTIFACTS_ENDPOINT)) === oldServeId);
  const afterTakeover = (await member.invokeService(ARTIFACTS_ENDPOINT, ARTIFACTS_LIST_COMMAND, { channel, limit: 1 })).reply;
  check("list answers at the new epoch after the takeover", afterTakeover.ok, afterTakeover);

  // ---- a genuine serve credential for the superseded epoch: claims equality refuses it ----
  // `renewedCreds` was minted behind the fence at the old epoch. Its reply and egress rows name that
  // epoch, so against the grant the daemon now derives (the new epoch) the rows differ, and it never
  // dials. The serving connection stays the one at the new epoch.
  const servingNow = (await admin.requestDeliveryAdmin("serveState", { endpoint: ARTIFACTS_ENDPOINT }, 10_000)).data as { state?: { credentialFingerprint: string; epoch: number } };
  await store.put(daemonEndpointKey(space, ARTIFACTS_ENDPOINT, DAEMON_ENDPOINT_SERVE_CREDS_KIND), renewedCreds!);
  const staleAdopt = await admin.requestDeliveryAdmin("adoptEndpointCreds", { endpoint: ARTIFACTS_ENDPOINT, adoptionOpId: mintLifecycleUid() }, 20_000);
  const servingStill = (await admin.requestDeliveryAdmin("serveState", { endpoint: ARTIFACTS_ENDPOINT }, 10_000)).data as { state?: { credentialFingerprint: string; epoch: number } };
  check("a real serve credential pinned to the superseded epoch is refused by claims equality, naming the row mismatch",
    !staleAdopt.ok && /exactly the rows|missing|extra/.test(staleAdopt.error ?? "")
      && servingStill.state?.credentialFingerprint === servingNow.state?.credentialFingerprint && servingStill.state?.epoch === restarted.epoch, { staleAdopt });

  // ---- native inventory ----
  let labels = "";
  for (let i = 0; i < 100; i++) {
    try { labels = handle.nativeConnections().map((r) => r.label).sort().join(","); break; } catch { await wait(50); }
  }
  check("nativeConnections lists artifacts-serve, artifact-data and artifact-sweeper beside the daemon's own",
    labels === "artifact-data,artifact-sweeper,artifacts-serve,endpoint,membership-rw,timer-writer", labels);

  // ---- E10: a registration that died holding its freeze, and a replacement daemon ----
  // The real barrier freezes the gate under its own op id, as a registration's first step does, and
  // that op then never runs again: nothing reopens the gate but the reconciler.
  const deadOpId = mintLifecycleUid();
  const liveGate = (await authKv.get(gateKey))!;
  const deadFreeze = await endpointRegistrationBarrier(authKv, space, { endpoint: ARTIFACTS_ENDPOINT, instanceId: instanceId!, opId: deadOpId }).freeze(liveGate.revision);
  const frozenByDead = JSON.parse(new TextDecoder().decode((await authKv.get(gateKey))!.value)) as { state: string; op?: { opId: string; kind: string } };
  check("the interrupted registration left the gate frozen under its own op id",
    deadFreeze !== null && frozenByDead.state === "frozen" && frozenByDead.op?.opId === deadOpId && frozenByDead.op.kind === "registration", frozenByDead);
  // While this daemon still serves, the freeze-holder (the serve principal) is connected: the
  // bootstrap must refuse loudly and leave the gate and last-good untouched.
  const servingBeforeHeal = (await admin.requestDeliveryAdmin("serveState", { endpoint: ARTIFACTS_ENDPOINT }, 10_000)).data as { state?: { credentialFingerprint: string } };
  let liveHolderRefusal: string | undefined;
  try { await bootstrapDaemonEndpoint(target, DAEMON_ENDPOINT_BOOTSTRAPS[ARTIFACTS_ENDPOINT]!()); } catch (e) { liveHolderRefusal = (e as Error).message; }
  const stillFrozen = JSON.parse(new TextDecoder().decode((await authKv.get(gateKey))!.value)) as { state: string; op?: { opId: string } };
  const servingAfterRefusal = (await admin.requestDeliveryAdmin("serveState", { endpoint: ARTIFACTS_ENDPOINT }, 10_000)).data as { state?: { credentialFingerprint: string } };
  check("with the freeze-holder still connected the bootstrap refuses, naming the live holder, and the dead op's freeze and last-good stand",
    liveHolderRefusal !== undefined && /frozen by an earlier registration/.test(liveHolderRefusal) && /ALIVE/.test(liveHolderRefusal)
      && stillFrozen.state === "frozen" && stillFrozen.op?.opId === deadOpId
      && servingAfterRefusal.state?.credentialFingerprint === servingBeforeHeal.state?.credentialFingerprint, liveHolderRefusal);
  // The daemon goes away (its serve connection with it) and a replacement starts on the same store.
  const epochBeforeHeal = restarted.epoch;
  await handle.close();
  handle = await startDeliveryService({
    context: { accountPublicKey: account.account.pub, lifecycleUid: "artifacts-ctx" },
    space, servers, store, storeIdentity: store.identity, stateDir: join(brokerDir, "state"), endpoints: [ARTIFACTS_ENDPOINT],
  });
  const healed = await bootstrapDaemonEndpoint(target, DAEMON_ENDPOINT_BOOTSTRAPS[ARTIFACTS_ENDPOINT]!());
  const healedGate = JSON.parse(new TextDecoder().decode((await authKv.get(gateKey))!.value)) as { state: string; processEpoch: number };
  check("the replacement daemon's bootstrap completes the dead op, re-registers past it, and binds at a later epoch",
    healed.epoch > epochBeforeHeal && healedGate.state === "open" && healedGate.processEpoch === healed.epoch
      && log.some((l) => /a frozen registration was completed/.test(l)), { healed, healedGate });
  const afterHeal = (await member.invokeService(ARTIFACTS_ENDPOINT, ARTIFACTS_LIST_COMMAND, { channel, limit: 1 })).reply;
  check("list answers on the replacement daemon after the recovery", afterHeal.ok, afterHeal);

  // ---- E18a: a lease lost AFTER a handler returned and BEFORE its reply is published ----
  // The daemon goes away, and a binder of the cell's own takes the same registration: the real
  // endpoint, the real gate, the minted serve credential, so it is the only server. Its `list` handler
  // is the real one, wrapped so that once it has resolved (its own last fence check passed) the binder
  // is quiesced from a reaction queued behind that resolution, ahead of the serve loop's publish. What
  // reaches the agent's wire is decided by the binder's reply gate at the publish.
  await handle.close();
  handle = undefined;
  let afterReturn: (() => void) | undefined;
  // The ACL reads ride a delivery-profile endpoint, as they do on the daemon's own connection.
  const aclId = newIdentity();
  const aclReader = new CotalEndpoint({ space, servers, creds: await mintCreds(auth, aclId, "delivery"), channels: [], consume: false, watchChannels: false, watchPresence: false, registerPresence: false,
    card: { id: aclId.id, name: "acl-reader", kind: "endpoint" } });
  aclReader.on("error", () => {});
  endpoints.push(aclReader);
  await aclReader.start();
  const realEndpoint = artifactsServedEndpoint({ space, servers, tls: false, store, delivery: { aclForAlias: (p) => aclReader.aclForAlias(p) }, deliveryJsm: () => readerJsm, log: () => {} });
  const gated = new DaemonEndpointBinder({
    space, servers, tls: false, log: () => {},
    endpoint: { ...realEndpoint, defs: (scope) => realEndpoint.defs(scope).map((def) => def.command !== ARTIFACTS_LIST_COMMAND ? def : {
      ...def, handler: (ctx) => {
        const result = Promise.resolve(def.handler(ctx));
        void result.then(() => { const lose = afterReturn; afterReturn = undefined; lose?.(); }, () => { /* the serve loop reports a refusal */ });
        return result;
      },
    }) },
  });
  const gatedBound = await gated.adopt({ creds: (await store.get(daemonEndpointKey(space, ARTIFACTS_ENDPOINT, DAEMON_ENDPOINT_SERVE_CREDS_KIND)))!, instanceId: instanceId!,
    serveId: (await readDaemonEndpointServeId(store, space, ARTIFACTS_ENDPOINT))!, adoptionOpId: mintLifecycleUid(), jsm: readerJsm }).then(() => "bound", (e: Error) => e.message);
  const gatedControl = (await member.invokeService(ARTIFACTS_ENDPOINT, ARTIFACTS_LIST_COMMAND, { channel, limit: 1 })).reply;
  afterReturn = () => { void gated.quiesce("lost the lease after the handler returned"); };
  const gatedLate = (await member.invokeService(ARTIFACTS_ENDPOINT, ARTIFACTS_LIST_COMMAND, { channel, limit: 1 })).reply;
  check("a lease lost after a handler returned and before its reply was published sends the gate's unavailable/unknown, not the rows; the same call before the loss lists",
    gatedBound === "bound" && gatedControl.ok && !gatedLate.ok && gatedLate.error?.code === "unavailable" && gatedLate.error?.outcome === "unknown"
      && /ended before the reply was sent/.test(gatedLate.error?.message ?? "") && !("data" in gatedLate), { gatedBound, gatedControl, gatedLate });
  await gated.close();
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
