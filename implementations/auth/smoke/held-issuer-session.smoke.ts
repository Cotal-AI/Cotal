/**
 * The auth plane's held issuer session (SPEC 13.15), through the hosted entrypoint
 * `startAuthService`: two real accounts on one broker, each context with its own registered remote
 * manager, and an interactive user's issued `manager-caller` connects through the auth callout.
 *
 *  1. Concurrent callers in one context share one issuer connection, each with its own generation;
 *     a reconnect under the same nonce keeps its generation, and a revoked grant is refused.
 *  2. Each account context holds its own issuer connection in its own account.
 *  3. A short-lived issuer credential is replaced before it expires: issuances across several
 *     lifetimes all succeed on successive connections, and the broker closes none for expiry.
 *  4. A lost issuer connection fails only what it was running, and the next issuance dials anew.
 *  5. A fence and a shutdown during a burst of issuances close the issuer connection. No connect
 *     succeeds without its accepted row, nothing is written after them, and the other context keeps
 *     its connection.
 *
 * Run: pnpm smoke:held-issuer-session   (needs nats-server on PATH)
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { connect, credsAuthenticator, tokenAuthenticator, type NatsConnection } from "@nats-io/transport-node";
import { jetstreamManager } from "@nats-io/jetstream";
import { Kvm } from "@nats-io/kv";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import {
  acceptedBucket, acceptedReadGrant, connectionAcceptedToken, connzRequestSubject, issuedBucket, issuedUserCaller, MEMBERSHIP_INBOX_PREFIX,
  mintConnectionEvictorCreds, mintCreds, mintLifecycleUid, mintMembershipObserverCreds, newIdentity, registry, serverKickSubject, setupSpaceStreams,
  type AgentHandle, type Connector, type RemoteManagerAuthorityMaterial, type RemoteRunAdmissionResult, type RemoteRunAttemptResult, type RuntimeProvider,
} from "@cotal-ai/core";
import { emitSentinel } from "@cotal-ai/smoke-kit";
import { deriveOwnerForIdpSubject, ensurePinnedIdp, grantActor, loadOwnerSecret, revokeActor, startAuthService, type AuthServiceHandle } from "../src/index.js";
import { openAuthorityClient, remoteManagerRegistrationProof, type AuthorityClient } from "../src/authority-client.js";
import { scannerDeathCopy } from "../src/plane-claim.js";
import { Manager, managerClusterArtifacts, registerRemoteManagerAuthority } from "../../manager/src/index.js";
import * as remote from "../../manager/src/remote-authority.js";
import { startHostedAuthFixture, type HostedAuthAccount } from "./_hosted-auth-fixture.js";
import "../../runtime/src/index.js";

let count = 0;
const ok = (cond: boolean, name: string, observed?: unknown) => {
  assert.ok(cond, `${name}${observed === undefined ? "" : ` (observed ${JSON.stringify(observed)})`}`);
  count++;
};
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const enc = (s: string) => new TextEncoder().encode(s);
const quiet = () => {};
const SCOPE = ["admin", "spawn", "run", "supervise"];

const fx = await startHostedAuthFixture("held-issuer", 2);
const conns: NatsConnection[] = [];
const clients: AuthorityClient[] = [];
const managers: Manager[] = [];
const handles: AuthServiceHandle[] = [];

// One IdP for both contexts: JWKS only, and one signed proof per context's exchange.
const { publicKey, privateKey } = await generateKeyPair("EdDSA");
const jwk = { ...await exportJWK(publicKey), kid: "held-idp", alg: "EdDSA" };
const idp = createServer((_req, res) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ keys: [jwk] })); });
await new Promise<void>((resolve) => idp.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${(idp.address() as import("node:net").AddressInfo).port}`;
const idpToken = await new SignJWT({}).setProtectedHeader({ alg: "EdDSA", kid: "held-idp" }).setSubject("held-human").setIssuer(origin).setAudience(origin).setIssuedAt().setExpirationTime("10m").sign(privateKey);

const connector: Connector = { kind: "connector", name: "held-fixture", requires: [], buildLaunch: () => ({ command: "fixture", args: [] }) };
const runtime: RuntimeProvider = { kind: "runtime", name: "held-fixture", available: () => true, create: () => ({
  kind: "held-fixture", streamsTerminal: false, spawn: (): AgentHandle => { throw new Error("this suite spawns no agent"); },
}) };
registry.register(connector, runtime);

interface Ctx { acct: HostedAuthAccount; service: AuthServiceHandle; owner: string; uid: string; instanceId: string; issuerName: string }

async function post<T>(ctx: Pick<Ctx, "service">, path: string, body: unknown): Promise<T> {
  const response = await fetch(`${ctx.service.url}${path}`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${ctx.service.cap}` }, body: JSON.stringify(body) });
  const result = (await response.json()) as T & { error?: string };
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${result.error ?? "refused"}`);
  return result;
}

/** Start one hosted context and register and start its remote manager, so the context's
 *  manager gate is a candidate for its owner's `manager-caller` connects. */
async function startContext(acct: HostedAuthAccount, i: number, issuerSessionTtlSeconds?: number): Promise<Ctx> {
  await setupSpaceStreams({ servers: fx.servers, space: acct.space, creds: await mintCreds(acct.auth, newIdentity(), "provisioner") });
  rmSync(join(acct.stateDir, "idp.json"));
  ensurePinnedIdp(acct.stateDir, `${origin}/api/auth`);
  const owner = deriveOwnerForIdpSubject((await loadOwnerSecret(acct.store, acct.space))!, origin, "held-human");
  const cli = grantActor(acct.stateDir, { owner, actor: "cli", scope: SCOPE, allowSubscribe: [">"], allowPublish: [">"] });
  const service = await startAuthService({
    context: { accountPublicKey: acct.accountPublicKey, lifecycleUid: `held-${i}` },
    space: acct.space, servers: fx.servers, stateDir: acct.stateDir, store: acct.store, storeIdentity: acct.store.identity,
    publicFace: { port: 0, trustedProxy: false },
    ...(issuerSessionTtlSeconds !== undefined ? { issuerSessionTtlSeconds } : {}),
  });
  handles.push(service);
  const call = (request: unknown) => post<never>({ service }, "/manager-service-authority", { idpToken, request });
  const authority = (request: import("@cotal-ai/core").RemoteManagerAuthorityRequest) => call(request) as Promise<RemoteManagerAuthorityMaterial>;
  const state = remote.loadOrCreateRemoteManagerIdentity(join(fx.dir, `mgr-${i}`), acct.space);
  const prepared = await authority(remote.remoteManagerAuthorityRequest(state, "cli", "prepare"));
  const registered = await registerRemoteManagerAuthority({ space: acct.space, server: fx.servers, owner, instanceId: state.instanceId, serveActor: prepared.actors.serve, prepareCreds: remote.materialCredential(prepared, "executor", state.identities.executor), tlsRequired: false, evict: async () => [] });
  const cluster = managerClusterArtifacts();
  const contractArtifacts = [cluster.document, cluster.manifest];
  const activated = await authority(remote.remoteManagerAuthorityRequest(state, "cli", "activate", { registrationProof: remoteManagerRegistrationProof(owner, state, contractArtifacts), contractArtifacts }));
  const proof = remote.currentRegistrationProof(activated);
  const supervisorCreds = remote.materialCredential(prepared, "supervisor", state.identities.supervisor);
  const standing = remote.remoteStandingBundleRenewal({ state, owner, registrationProof: proof, supervisorCreds, call: authority });
  const managerRoot = join(fx.dir, `manager-root-${i}`);
  mkdirSync(join(managerRoot, ".cotal", "agents"), { recursive: true });
  const manager = new Manager({ space: acct.space, servers: fx.servers, workspaceRoot: managerRoot, runtime: "held-fixture", remoteAuthority: {
    ...standing, owner, actors: prepared.actors, instanceId: state.instanceId, lifecycleUid: state.lifecycleUid,
    identities: state.identities, supervisorCreds,
    executorCreds: remote.materialCredential(prepared, "executor", state.identities.executor),
    renewExecutor: async () => remote.materialCredential(await authority(remote.remoteManagerAuthorityRequest(state, "cli", "renew", { registrationProof: proof })), "executor", state.identities.executor),
    serveCreds: remote.materialCredential(activated, "serve", state.identities.serve),
    goalWriterCreds: remote.materialCredential(activated, "goalWriter", state.identities.goalWriter),
    sessionLedgerCreds: remote.materialCredential(activated, "sessionLedger", state.identities.sessionLedger),
    serveGrant: registered.serveGrant,
    mintSessionServing: async () => { throw new Error("no terminal session"); },
    mintRetirementRequester: async () => { throw new Error("no retirement"); },
    prepareAgentRetirement: async () => { throw new Error("no retirement"); },
    validateRetainedAgent: async () => { throw new Error("no retained seat"); },
    scanGoalIndex: async () => {
      const request = remote.remoteManagerGoalIndexScanRequest(state, "cli", proof, registered.processEpoch);
      return remote.remoteManagerGoalIndexEntries(await call(request), request, owner);
    },
    authorizeAdmin: async (caller) => {
      const request = remote.remoteManagerAdminAuthorizationRequest(state, "cli", proof, registered.processEpoch, caller);
      return remote.remoteManagerAdminAuthorized(await call(request), request, owner);
    },
    agentBearerExchangeUrl: service.publicUrl!,
    enrollManagedAgent: async () => { throw new Error("this suite spawns no agent"); },
    runHosting: remote.remoteRunHosting({ state, owner, registrationProof: proof, accountPublicKey: acct.accountPublicKey, processEpoch: registered.processEpoch,
      requestRunAdmission: (request) => call(request) as Promise<RemoteRunAdmissionResult>,
      requestRunAttempt: (request) => call(request) as Promise<RemoteRunAttemptResult>, call: authority }),
  } });
  managers.push(manager);
  await manager.start();
  return { acct, service, owner, uid: cli.lifecycleUid!, instanceId: state.instanceId, issuerName: `cotal:auth-issuer:${acct.space}` };
}

/** One `manager-caller` exchange for the human, as the CLI makes it. */
const exchange = async (ctx: Ctx, actor = "cli") =>
  (await post<{ token: string }>(ctx, "/exchange", { actor, view: "manager-caller", managerInstanceId: ctx.instanceId, idpToken })).token;
/** Connect under `nonce`: the callout issues this connection's view and accepted row. */
async function dial(ctx: Ctx, token: string, nonce: string): Promise<NatsConnection> {
  const nc = await connect({ servers: fx.servers, authenticator: [credsAuthenticator(enc(ctx.acct.sentinelCreds)), tokenAuthenticator(token)], name: nonce, inboxPrefix: `_INBOX_${nonce}`, maxReconnectAttempts: 0, timeout: 5000 });
  conns.push(nc);
  return nc;
}
/** Exchanges for one actor take its gate in turn, so a burst exchanges first and connects at once. */
async function tokens(ctx: Ctx, n: number): Promise<string[]> {
  const out: string[] = [];
  for (let i = 0; i < n; i++) out.push(await exchange(ctx));
  return out;
}
/** Connect, read the generation the issuer accepted for this connection, and close. */
async function issueOnce(ctx: Ctx, nonce = mintLifecycleUid(), token?: string): Promise<string> {
  const nc = await dial(ctx, token ?? await exchange(ctx), nonce);
  try { return (await issuedUserCaller(nc, ctx.acct.space, nonce, { owner: ctx.owner, actor: "cli", uid: ctx.uid })).generation; }
  finally { await nc.close(); }
}

type Conn = { cid: number; name?: string; reason?: string; authorized_user?: string };
const observers = new Map<string, { observer: NatsConnection; evictor: NatsConnection }>();
async function sys(acct: HostedAuthAccount) {
  let s = observers.get(acct.space);
  if (!s) {
    s = {
      observer: await connect({ servers: fx.servers, authenticator: credsAuthenticator(enc(await mintMembershipObserverCreds(acct.auth, newIdentity()))), inboxPrefix: MEMBERSHIP_INBOX_PREFIX, maxReconnectAttempts: 0 }),
      evictor: await connect({ servers: fx.servers, authenticator: credsAuthenticator(enc(await mintConnectionEvictorCreds(acct.auth, newIdentity()))), maxReconnectAttempts: 0 }),
    };
    conns.push(s.observer, s.evictor);
    observers.set(acct.space, s);
  }
  return s;
}
/** The account's connections named `name`, open or closed, from the broker's own CONNZ. */
async function named(acct: HostedAuthAccount, name: string, state: "open" | "closed" = "open"): Promise<{ serverId: string; conns: Conn[] }> {
  const { observer } = await sys(acct);
  const inbox = `${MEMBERSHIP_INBOX_PREFIX}.held.${mintLifecycleUid()}`;
  const sub = observer.subscribe(inbox, { max: 1 });
  observer.publish(connzRequestSubject(acct.auth.account.pub), enc(JSON.stringify({ subscriptions: false, auth: true, limit: 4096, state: state === "open" ? 0 : 1 })), { reply: inbox });
  for await (const m of sub) {
    const r = m.json<{ server?: { id?: string }; data?: { server_id?: string; connections?: Conn[] } }>();
    return { serverId: r.data?.server_id ?? r.server!.id!, conns: (r.data?.connections ?? []).filter((c) => c.name === name) };
  }
  throw new Error("no CONNZ answer");
}
async function kick(acct: HostedAuthAccount, name: string): Promise<number> {
  const { evictor } = await sys(acct);
  const { serverId, conns: found } = await named(acct, name);
  for (const c of found) await evictor.request(serverKickSubject(serverId), enc(JSON.stringify({ cid: c.cid })), { timeout: 2000 });
  return found.length;
}
async function until(cond: () => Promise<boolean>, ms = 5000): Promise<boolean> {
  for (const end = Date.now() + ms; Date.now() < end; await wait(50)) if (await cond()) return true;
  return cond();
}

/** A harness connection of the account that reads the issued and accepted stores and watches the
 *  issued store's evidence writes. */
const harnesses = new Map<string, AuthorityClient>();
async function harness(acct: HostedAuthAccount): Promise<AuthorityClient> {
  let c = harnesses.get(acct.space);
  if (!c) {
    c = await openAuthorityClient({ server: fx.servers, space: acct.space, dataAccount: { pub: acct.auth.account.pub, signingSeed: acct.auth.account.signingSeed! }, label: `harness:${acct.space}`, grants: () => ({ publish: [">"], subscribe: [">"] }), log: quiet });
    clients.push(c);
    harnesses.set(acct.space, c);
  }
  return c;
}
async function hasAcceptedRow(acct: HostedAuthAccount, nonce: string): Promise<boolean> {
  const m = await (await harness(acct)).nc.request(acceptedReadGrant(acct.space, connectionAcceptedToken(nonce)), new Uint8Array(0), { timeout: 3000 });
  const code = m.headers?.code ?? 0;
  if (code === 404) return false;
  if (code >= 400) throw new Error(`accepted-row read failed (${code})`);
  return true;
}
async function storeCounts(acct: HostedAuthAccount): Promise<string> {
  const jsm = await jetstreamManager((await harness(acct)).nc);
  const issued = (await jsm.streams.info(`KV_${issuedBucket(acct.space)}`)).state.messages;
  const accepted = (await jsm.streams.info(`KV_${acceptedBucket(acct.space)}`)).state.messages;
  return `${issued}/${accepted}`;
}

/** The issued store's evidence keys and the accepted store's keys. */
async function storeKeys(acct: HostedAuthAccount): Promise<{ evidence: Set<string>; accepted: Set<string> }> {
  const kvm = new Kvm((await harness(acct)).nc);
  const keys = async (bucket: string) => {
    const out = new Set<string>();
    for await (const k of await (await kvm.open(bucket)).keys()) out.add(k);
    return out;
  };
  return { evidence: new Set([...await keys(issuedBucket(acct.space))].filter((k) => k.startsWith("v1."))), accepted: await keys(acceptedBucket(acct.space)) };
}

/** `n` concurrent connects. `cut` runs once, on the first evidence row the burst writes, so it lands
 *  while the burst's issuances are between their writes. Counts the connects admitted with their
 *  accepted row, denied with or without one, and admitted without one, and the evidence and
 *  accepted rows the burst added. */
async function burst(ctx: Ctx, n: number, cut: () => Promise<unknown>) {
  const all = await tokens(ctx, n);
  const before = await storeKeys(ctx.acct);
  const h = await harness(ctx.acct);
  let cutting: Promise<unknown> | undefined;
  const sub = h.nc.subscribe(`$KV.${issuedBucket(ctx.acct.space)}.v1.>`, { max: 1, callback: () => { cutting = cut(); } });
  await h.nc.flush();
  const results = await Promise.all(all.map(async (token) => {
    const nonce = mintLifecycleUid();
    try {
      await (await dial(ctx, token, nonce)).close();
      return { nonce, admitted: true };
    } catch {
      return { nonce, admitted: false };
    }
  }));
  sub.unsubscribe();
  await cutting;
  const rows = await Promise.all(results.map((r) => hasAcceptedRow(ctx.acct, r.nonce)));
  const after = await storeKeys(ctx.acct);
  const counts = {
    cut: cutting !== undefined, admitted: 0, deniedAfterWrite: 0, deniedBeforeWrite: 0, admittedWithoutRow: 0,
    staged: [...after.evidence].filter((k) => !before.evidence.has(k)).length,
    accepted: [...after.accepted].filter((k) => !before.accepted.has(k)).length,
  };
  results.forEach((r, i) => {
    if (r.admitted) { if (rows[i]) counts.admitted++; else counts.admittedWithoutRow++; }
    else if (rows[i]) counts.deniedAfterWrite++;
    else counts.deniedBeforeWrite++;
  });
  return counts;
}
/** The burst's issuances never wrote twice, and none was admitted without its accepted row. */
const clean = (r: Awaited<ReturnType<typeof burst>>, n: number) => r.cut && r.admittedWithoutRow === 0 && r.staged <= n && r.accepted <= r.staged;

try {
  const [a, b] = await Promise.all([startContext(fx.accounts[0]!, 0, 6), startContext(fx.accounts[1]!, 1)]);

  // ---- 1. concurrent callers share one held connection ----
  ok((await named(b.acct, b.issuerName)).conns.length === 0, "B dials no issuer connection before its first issuance");
  const first = await Promise.all((await tokens(b, 16)).map((t) => issueOnce(b, mintLifecycleUid(), t)));
  ok(new Set(first).size === 16, "16 concurrent issued connects each get their own generation");
  const heldB = (await named(b.acct, b.issuerName)).conns;
  ok(heldB.length === 1, "B holds one issuer connection after 16 concurrent issuances", heldB.length);
  const second = await Promise.all((await tokens(b, 16)).map((t) => issueOnce(b, mintLifecycleUid(), t)));
  ok(new Set([...first, ...second]).size === 32, "16 more concurrent issued connects each get a fresh generation");
  const heldB2 = (await named(b.acct, b.issuerName)).conns;
  ok(heldB2.length === 1 && heldB2[0]!.cid === heldB[0]!.cid, "B issued all 32 on the same held connection", heldB2.map((c) => c.cid));
  const nonce = mintLifecycleUid();
  const generation = await issueOnce(b, nonce);
  ok(await issueOnce(b, nonce) === generation, "a reconnect under the same nonce keeps the generation its accepted row names");
  grantActor(b.acct.stateDir, { owner: b.owner, actor: "cli2", scope: SCOPE, allowSubscribe: [">"], allowPublish: [">"] });
  const revokedToken = await exchange(b, "cli2");
  revokeActor(b.acct.stateDir, b.owner, "cli2");
  await assert.rejects(dial(b, revokedToken, mintLifecycleUid()), /Authorization Violation|Authentication/i);
  count++;
  ok((await named(b.acct, b.issuerName)).conns[0]?.cid === heldB[0]!.cid, "a grant revoked after its exchange is refused while B's issuer connection stays held");

  // ---- 2. each account context holds its own connection ----
  await issueOnce(a);
  const heldA = (await named(a.acct, a.issuerName)).conns;
  ok(heldA.length === 1, "A holds one issuer connection of its own", heldA.length);
  ok(heldA[0]!.authorized_user !== heldB[0]!.authorized_user, "A's and B's issuer connections authenticate as different users");
  ok((await named(a.acct, b.issuerName)).conns.length === 0 && (await named(b.acct, a.issuerName)).conns.length === 0, "neither account carries the other context's issuer connection");

  // ---- 3. a 6 s issuer credential is replaced before it expires ----
  const seen = new Set<number>();
  let most = 0, issued = 0, refused = 0;
  for (const end = Date.now() + 15_000; Date.now() < end;) {
    try { await issueOnce(a); issued++; } catch { refused++; }
    const open = (await named(a.acct, a.issuerName)).conns;
    for (const c of open) seen.add(c.cid);
    most = Math.max(most, open.length);
    await wait(300);
  }
  ok(refused === 0 && issued > 20, "every issuance across 15 s of 6 s issuer credentials succeeded", { issued, refused });
  ok(seen.size >= 3, "A replaced its issuer connection at least twice in 15 s", [...seen]);
  ok(most <= 2, "A never held more than the current connection and one draining predecessor", most);
  const closedA = (await named(a.acct, a.issuerName, "closed")).conns;
  ok(closedA.length >= 2 && closedA.every((c) => c.reason === "Client Closed"), "every replaced issuer connection was drained by A; the broker expired none", closedA.map((c) => c.reason));

  // ---- 4. a lost connection is dialed again ----
  const before = (await named(a.acct, a.issuerName)).conns.map((c) => c.cid);
  ok(await kick(a.acct, a.issuerName) >= 1, "A's held issuer connection was kicked");
  await until(async () => (await named(a.acct, a.issuerName)).conns.every((c) => !before.includes(c.cid)));
  await issueOnce(a);
  const after = (await named(a.acct, a.issuerName)).conns;
  ok(after.length === 1 && !before.includes(after[0]!.cid), "the next issuance after the loss dialed a new connection", { before, after: after.map((c) => c.cid) });
  const lost = await burst(a, 24, () => kick(a.acct, a.issuerName));
  ok(clean(lost, 24), "a loss during 24 concurrent issuances admitted no connect without its accepted row and wrote nothing twice", lost);
  ok(lost.deniedBeforeWrite + lost.deniedAfterWrite > 0, "the loss failed the issuances it was running", lost);
  await issueOnce(a);
  ok((await named(a.acct, a.issuerName)).conns.length === 1, "A issues again on a new connection after a loss mid-burst");
  console.log(`  loss mid-burst: ${JSON.stringify(lost)}`);

  // ---- 5a. a fence mid-burst ----
  const lateToken = await exchange(a);
  const closedBeforeFence = new Set((await named(a.acct, a.issuerName, "closed")).conns.map((c) => c.cid));
  const fence = await burst(a, 48, () => kick(a.acct, `cotal:auth-scan:${a.acct.space}`));
  let state = await a.service.readiness();
  for (let i = 0; i < 50 && state.state !== "unavailable"; i++) { await wait(100); state = await a.service.readiness(); }
  ok(state.state === "unavailable" && state.cause === scannerDeathCopy(a.acct.space, "auth-ledger"), "A is fenced by its scanner's death", state);
  ok(await until(async () => (await named(a.acct, a.issuerName)).conns.length === 0), "the fence closed A's issuer connection");
  const fenceClosed = (await named(a.acct, a.issuerName, "closed")).conns.filter((c) => !closedBeforeFence.has(c.cid));
  ok(fenceClosed.length >= 1 && fenceClosed.every((c) => c.reason === "Client Closed"), "A drained its issuer connection on the fence", fenceClosed.map((c) => c.reason));
  ok(clean(fence, 48), "the fence admitted no connect without its accepted row and wrote nothing twice", fence);
  ok(fence.staged > fence.accepted || fence.deniedAfterWrite > 0, "the fence landed while issuances were in flight: one staged and was stopped, or finished and was refused", fence);
  const fencedCounts = await storeCounts(a.acct);
  await wait(1500);
  ok(await storeCounts(a.acct) === fencedCounts, "nothing reached A's issued or accepted store after the fence", fencedCounts);
  await assert.rejects(issueOnce(a, mintLifecycleUid(), lateToken));
  count++;
  const heldB3 = (await named(b.acct, b.issuerName)).conns;
  await issueOnce(b);
  ok(heldB3.length === 1 && heldB3[0]!.cid === heldB[0]!.cid && (await named(b.acct, b.issuerName)).conns[0]?.cid === heldB[0]!.cid, "B keeps issuing on its same connection after A's fence");
  console.log(`  fence mid-burst: ${JSON.stringify(fence)}`);

  // ---- 5b. a shutdown mid-burst ----
  const shutdown = await burst(b, 48, () => b.service.close());
  ok(await until(async () => (await named(b.acct, b.issuerName)).conns.length === 0), "B's close closed its issuer connection");
  ok((await named(b.acct, b.issuerName, "closed")).conns.every((c) => c.reason === "Client Closed"), "B drained its issuer connection on close; the broker expired none");
  ok(clean(shutdown, 48), "the close admitted no connect without its accepted row and wrote nothing twice", shutdown);
  ok(shutdown.staged > shutdown.accepted || shutdown.deniedAfterWrite > 0, "the close landed while issuances were in flight: one staged and was stopped, or finished and was refused", shutdown);
  const closedCounts = await storeCounts(b.acct);
  await wait(1500);
  ok(await storeCounts(b.acct) === closedCounts, "nothing reached B's issued or accepted store after its close", closedCounts);
  console.log(`  shutdown mid-burst: ${JSON.stringify(shutdown)}`);

  console.log(`held issuer session: ${count} assertions passed`);
  emitSentinel({ passed: count, failed: 0 });
} finally {
  for (const m of managers) await m.stop().catch(() => {});
  for (const h of handles) await h.close().catch(() => {});
  for (const c of clients) await c.close().catch(() => {});
  for (const c of conns) await c.close().catch(() => {});
  await new Promise<void>((r) => idp.close(() => r()));
  await fx.close();
}
