/**
 * Native-key issuance evidence through the SHIPPED hosted composition (SPEC 13.1 `natkey.`): the
 * stock auth service (startAuthService), the stock delivery service (its delivery-admin eviction
 * rail), and a stock Manager registered through the real manager-service authority door, on an
 * isolated broker with generated TEST identities only:
 *  - C1: a product-issued manager-caller connection persists one row with the bearer's exact
 *    view/owner/actor/lifecycle/credential and the minted JWT's exp (iat bracketed by the connect);
 *  - R1: an interactive predecessor connects (row), a sibling connects (row); the loopback
 *    retirement door runs the real barrier over the delivery-admin rail, the predecessor socket is
 *    evicted, its row stays attributable, its bearer is refused with no new row; a same-name
 *    successor connects with a new uid, credential, key and row while the sibling still works.
 * A full-grant TEST-account reader only reads the auth bucket; every write is the services' own.
 *
 * Run: tsx implementations/auth/smoke/native-issuance-composed.smoke.ts (needs nats-server on PATH)
 */
// The manager's agent auth preflight runs its own entry file (process.argv[1]) as `agent-bearer`.
if (process.argv[2] === "agent-bearer") {
  await import("../src/index.js");
  const { registry } = await import("@cotal-ai/core");
  const raw = process.argv.slice(3);
  const values: Record<string, string | boolean> = {};
  for (let i = 0; i < raw.length; i++) {
    const flag = raw[i]!;
    if (!flag.startsWith("--")) throw new Error("agent-bearer fixture takes flags only");
    const next = raw[i + 1];
    if (next !== undefined && !next.startsWith("--")) { values[flag.slice(2)] = next; i++; }
    else values[flag.slice(2)] = true;
  }
  await registry.resolve<import("@cotal-ai/core").Command>("command", "agent-bearer").run({ values, positionals: [], raw });
  process.exit(0);
}

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { join } from "node:path";
import { mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { connect, credsAuthenticator, tokenAuthenticator, type NatsConnection } from "@nats-io/transport-node";
import { Kvm } from "@nats-io/kv";
import { jetstreamManager } from "@nats-io/jetstream";
import { decodeJwt, exportJWK, generateKeyPair, SignJWT } from "jose";
import {
  issuedUserCaller, mintCreds, mintLifecycleUid, newIdentity,
  setupSpaceStreams, standaloneConnectOpts, withIssuerSession, CotalEndpoint, epRequestSubject, readRunAdmission,
  createRunSpec, credsClaims, newTakeoverId, openRecordsBucket, writeRunStatus, type RunAdmission,
  registry, type Connector, type LaunchOpts, type RuntimeProvider, type AgentHandle,
  type IssuedCaller, type RemoteManagerAuthorityMaterial, type RemoteRunAdmissionResult,
} from "@cotal-ai/core";
import { emitSentinel } from "@cotal-ai/smoke-kit";
import { epAuthBucket, mintConnectionEvictorCreds, mintMembershipObserverCreds } from "@cotal-ai/core";
import { connectionEvictorCredsKey, deliveryCredsKey, membershipObserverCredsKey, membershipRwCredsKey, type HostedServiceHandle } from "@cotal-ai/workspace";
import { startDeliveryService } from "../../delivery/src/index.js";
import { openAuthorityClient } from "../src/authority-client.js";
import { readNativeIssuance } from "../src/native-issuance.js";
import { INTERACTIVE_RETIRE_PATH } from "../src/service.js";
import {
  deriveOwnerForIdpSubject, ensurePinnedIdp, grantActor, loadOwnerSecret, startAuthService,
  findManagedActor, ledgerActorSourceIsLive, type AuthServiceHandle,
} from "../src/index.js";
import { remoteManagerRegistrationProof } from "../src/authority-client.js";
import { Manager, managerClusterArtifacts, registerRemoteManagerAuthority } from "../../manager/src/index.js";
import * as remote from "../../manager/src/remote-authority.js";
import { startHostedAuthFixture } from "./_hosted-auth-fixture.js";
import "../../runtime/src/index.js";
import { agentLifecycleSecretFilePaths } from "@cotal-ai/workspace";

let pass = 0, fail = 0;

async function cell(name: string, fn: (obs: Record<string, unknown>) => Promise<void>) {
  const obs: Record<string, unknown> = {};
  try {
    await fn(obs);
    pass++;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    fail++;
    console.error(`  ✗ FAIL: ${name}`);
    console.error(`    ${error instanceof Error ? error.message : String(error)}`);
    console.error(`    observed: ${JSON.stringify(obs)}`);
  }
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const mintRunId = () => `run-${randomBytes(16).toString("hex")}`;

const fx = await startHostedAuthFixture("natcomp", 1);
const a = fx.accounts[0]!;
const { publicKey, privateKey } = await generateKeyPair("EdDSA");
const jwk = { ...await exportJWK(publicKey), kid: "expiry-idp", alg: "EdDSA" };
const idp = createServer((_req, res) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ keys: [jwk] })); });
await new Promise<void>((resolve) => idp.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${(idp.address() as import("node:net").AddressInfo).port}`;
rmSync(join(a.stateDir, "idp.json"));
ensurePinnedIdp(a.stateDir, `${origin}/api/auth`);
const owner = deriveOwnerForIdpSubject((await loadOwnerSecret(a.store, a.space))!, origin, "expiry-human");
grantActor(a.stateDir, { owner, actor: "cli", scope: ["admin", "spawn", "run", "supervise"], allowSubscribe: [">"], allowPublish: [">"] });
const idpToken = await new SignJWT({}).setProtectedHeader({ alg: "EdDSA", kid: "expiry-idp" }).setSubject("expiry-human").setIssuer(origin).setAudience(origin).setIssuedAt().setExpirationTime("10m").sign(privateKey);

let service: AuthServiceHandle | undefined;
let manager: Manager | undefined;
let delivery: HostedServiceHandle | undefined;
let reader: Awaited<ReturnType<typeof openAuthorityClient>> | undefined;
const conns: NatsConnection[] = [];
const check = (name: string, ok: boolean, extra?: unknown) => { if (ok) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.error(`  ✗ FAIL: ${name}`, extra === undefined ? "" : JSON.stringify(extra)); } };
const endpoints: CotalEndpoint[] = [];
const launches = new Map<string, LaunchOpts>();
const connector: Connector = {
  kind: "connector",
  name: "expiry-fixture",
  requires: [],
  buildLaunch: (opts) => { launches.set(opts.name, opts); return { command: "fixture", args: [] }; },
};
const runtime: RuntimeProvider = {
  kind: "runtime",
  name: "expiry-fixture",
  available: () => true,
  create: () => ({
    kind: "expiry-fixture",
    spawn: (name): AgentHandle => {
      const opts = launches.get(name)!;
      const closed = { value: false };
      void (async () => {
        assert.ok(opts.userAuth && opts.lifecycleUid);
        const files = agentLifecycleSecretFilePaths(opts.workspaceRoot!, a.space, name, opts.lifecycleUid);
        const actorToken = readFileSync(files.actorToken, "utf8").trim();
        const exchange = await post<{ token: string }>("/exchange", { owner, actor: name, actorToken });
        const ep = new CotalEndpoint({
          space: a.space,
          servers: fx.servers,
          bearer: exchange.token,
          sentinelCreds: a.sentinelCreds,
          lifecycleUid: opts.lifecycleUid,
          card: { owner, actor: name, name, kind: "agent" },
          channels: [],
          consume: false,
          watchChannels: false,
        });
        endpoints.push(ep);
        ep.on("error", () => {});
        await ep.start();
      })().catch((error) => {
        console.error("managed endpoint fixture refused:", error instanceof Error ? error.message : "unknown");
        closed.value = true;
      });
      return {
        name,
        kind: "expiry-fixture",
        status: () => (closed.value ? "exited" : "running"),
        stop: () => { closed.value = true; },
        release: () => {},
        interrupt: () => {},
        attach: () => { throw new Error("no terminal in fixture"); },
      };
    },
  }),
};
registry.register(connector, runtime);

const state = remote.loadOrCreateRemoteManagerIdentity(join(fx.dir, "mgr"), a.space);

async function post<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(`${service!.url}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${service!.cap}` },
    body: JSON.stringify(body),
  });
  const result = (await response.json()) as T & { error?: string };
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${result.error ?? "refused"}`);
  return result;
}

const authority = (request: import("@cotal-ai/core").RemoteManagerAuthorityRequest) =>
  post<RemoteManagerAuthorityMaterial>("/manager-service-authority", { idpToken, request });

try {
  const provCreds = await mintCreds(a.auth, newIdentity(), "provisioner");
  await setupSpaceStreams({ servers: fx.servers, space: a.space, creds: provCreds });

  const composition = { injected: true as const };
  await a.store.put(deliveryCredsKey(a.space, composition), await mintCreds(a.auth, newIdentity(), "delivery"));
  await a.store.put(membershipRwCredsKey(a.space, composition), await mintCreds(a.auth, newIdentity(), "membership-rw"));
  await a.store.put(membershipObserverCredsKey(a.space, composition), await mintMembershipObserverCreds(a.auth, newIdentity()));
  await a.store.put(connectionEvictorCredsKey(a.space, composition), await mintConnectionEvictorCreds(a.auth, newIdentity()));
  service = await startAuthService({
    context: { accountPublicKey: a.accountPublicKey, lifecycleUid: mintLifecycleUid() },
    space: a.space,
    servers: fx.servers,
    stateDir: a.stateDir,
    store: a.store,
    storeIdentity: a.store.identity,
    publicFace: { port: 0, trustedProxy: false },
  });

  delivery = await startDeliveryService({ context: { accountPublicKey: a.accountPublicKey, lifecycleUid: mintLifecycleUid() }, space: a.space, servers: fx.servers, stateDir: a.stateDir, store: a.store, storeIdentity: a.store.identity });
  for (let i = 0; i < 50 && (await delivery.readiness()).state !== "ready"; i++) await wait(200);
  check("D0 the stock delivery service is ready (the delivery-admin rail is served)", (await delivery.readiness()).state === "ready");
  reader = await openAuthorityClient({ server: fx.servers, space: a.space, dataAccount: { pub: a.auth.account.pub, signingSeed: a.auth.account.signingSeed! }, label: `natcomp-reader:${a.space}`, grants: (id) => ({ publish: [">"], subscribe: [`_INBOX_${id}.>`] }), log: () => {} });
  const kv = await new Kvm(reader.nc).open(epAuthBucket(a.space));
  const natkeys = async () => { const out: string[] = []; for await (const k of await kv.keys("natkey.>")) out.push(k.slice("natkey.".length)); return out.sort(); };
  const fresh = (before: string[], after: string[]) => after.filter((k) => !before.includes(k));
  const dial = async (token: string): Promise<NatsConnection | "denied"> => {
    try { const nc = await connect({ servers: fx.servers, ...standaloneConnectOpts({ bearer: token, sentinelCreds: a.sentinelCreds, tls: false }), maxReconnectAttempts: 0 }); conns.push(nc); return nc; }
    catch (e) { if (/authorization|authentication/i.test((e as Error)?.message ?? "")) return "denied"; throw e; }
  };
  const actOf = (token: string) => (decodeJwt(token) as { act: { lifecycleUid: string; credentialId: string; view?: string } }).act;
  const prepared = await authority(remote.remoteManagerAuthorityRequest(state, "cli", "prepare"));
  const registered = await registerRemoteManagerAuthority({
    space: a.space,
    server: fx.servers,
    owner,
    instanceId: state.instanceId,
    serveActor: prepared.actors.serve,
    prepareCreds: remote.materialCredential(prepared, "executor", state.identities.executor),
    tlsRequired: false,
    evict: async () => [],
  });
  const cluster = managerClusterArtifacts();
  const contractArtifacts = [cluster.document, cluster.manifest];
  const activated = await authority(
    remote.remoteManagerAuthorityRequest(state, "cli", "activate", {
      registrationProof: remoteManagerRegistrationProof(owner, state, contractArtifacts),
      contractArtifacts,
    }),
  );
  const proof = remote.currentRegistrationProof(activated);
  const supervisorCreds = remote.materialCredential(prepared, "supervisor", state.identities.supervisor);
  const standing = remote.remoteStandingBundleRenewal({ state, owner, registrationProof: proof, supervisorCreds, call: authority });
  const managerRoot = join(fx.dir, "manager-root");
  mkdirSync(join(managerRoot, ".cotal", "agents"), { recursive: true });
  manager = new Manager({
    space: a.space,
    servers: fx.servers,
    workspaceRoot: managerRoot,
    runtime: "expiry-fixture",
    remoteAuthority: {
      ...standing,
      owner,
      actors: prepared.actors,
      instanceId: state.instanceId,
      lifecycleUid: state.lifecycleUid,
      identities: state.identities,
      supervisorCreds,
      executorCreds: remote.materialCredential(prepared, "executor", state.identities.executor),
      renewExecutor: async () =>
        remote.materialCredential(
          await authority(remote.remoteManagerAuthorityRequest(state, "cli", "renew", { registrationProof: proof })),
          "executor",
          state.identities.executor,
        ),
      serveCreds: remote.materialCredential(activated, "serve", state.identities.serve),
      goalWriterCreds: remote.materialCredential(activated, "goalWriter", state.identities.goalWriter),
      sessionLedgerCreds: remote.materialCredential(activated, "sessionLedger", state.identities.sessionLedger),
      serveGrant: registered.serveGrant,
      mintSessionServing: async () => { throw new Error("unused"); },
      mintRetirementRequester: async () => { throw new Error("unused"); },
      prepareAgentRetirement: async () => { throw new Error("unused"); },
      validateRetainedAgent: async () => { throw new Error("unused"); },
      scanGoalIndex: async () => {
        const request = remote.remoteManagerGoalIndexScanRequest(state, "cli", proof, registered.processEpoch);
        return remote.remoteManagerGoalIndexEntries(await post("/manager-service-authority", { idpToken, request }), request, owner);
      },
      authorizeAdmin: async (caller) => {
        const request = remote.remoteManagerAdminAuthorizationRequest(state, "cli", proof, registered.processEpoch, caller);
        return remote.remoteManagerAdminAuthorized(await post("/manager-service-authority", { idpToken, request }), request, owner);
      },
      agentBearerExchangeUrl: service.publicUrl!,
      enrollManagedAgent: async ({ target }) => {
        const request = remote.remoteManagedAgentEnrollmentRequest(state, "cli", proof, registered.processEpoch, target);
        return remote.remoteManagedAgentEnrollmentMaterial(await post("/manager-service-authority", { idpToken, request }), request);
      },
    },
  });
  await manager.start();

  writeFileSync(join(managerRoot, ".cotal", "agents", "runner.md"), "---\nname: runner\nagent: expiry-fixture\ncapabilities: [spawn, run]\n---\n");
  const startedRunner = await manager.startAgent({ name: "runner", events: false }, `${owner}.cli`);
  assert.ok(startedRunner.ok, startedRunner.error);
  const runnerRow = findManagedActor(a.stateDir, owner, "runner")!;
  const uid = runnerRow.lifecycleUid!;
  const secretPaths = agentLifecycleSecretFilePaths(managerRoot, a.space, "runner", uid);
  const actorToken = readFileSync(secretPaths.actorToken, "utf8").trim();


  // ---- C1: manager-caller row contents ----
  {
    const k0 = await natkeys();
    const t0 = Math.floor(Date.now() / 1000);
    const ex = await post<{ token: string; exp: number }>("/exchange", { owner, actor: "runner", actorToken, view: "manager-caller", managerInstanceId: state.instanceId });
    const nc = await dial(ex.token);
    const t1 = Math.floor(Date.now() / 1000);
    const keys = fresh(k0, await natkeys());
    const row = keys[0] ? await readNativeIssuance(kv, keys[0]) : undefined;
    const act = actOf(ex.token);
    check("C1 the manager-caller connect succeeds and leaves exactly one new row", nc !== "denied" && keys.length === 1, { keys: keys.length });
    check("C1 the row binds view manager-caller, the owner, actor runner and the bearer's own lifecycle and credential",
      row?.view === "manager-caller" && row.owner === owner && row.actor === "runner" && row.lifecycleUid === uid && row.lifecycleUid === act.lifecycleUid && row.credentialId === act.credentialId && row.space === a.space,
      row && { view: row.view, actor: row.actor, uidOk: row.lifecycleUid === uid, credOk: row.credentialId === act.credentialId });
    check("C1 the row's exp is the minted JWT's (bound to the bearer's exp) and its iat falls inside the connect", row?.exp === ex.exp && row.iat >= t0 - 1 && row.iat <= t1 + 1, row && { exp: row.exp, bearerExp: ex.exp, iat: row.iat, t0, t1 });
  }

  // ---- R1: real retirement over the delivery-admin rail, then a same-name successor ----
  {
    const grantSeat = () => grantActor(a.stateDir, { owner, actor: "seat", scope: ["spawn"], allowSubscribe: [">"], allowPublish: [">"], lifecycleUid: mintLifecycleUid() });
    grantSeat();
    const k0 = await natkeys();
    const pred = await post<{ token: string; exp: number }>("/exchange", { idpToken, actor: "seat" });
    const predAct = actOf(pred.token);
    const predNc = await dial(pred.token);
    const predKeys = fresh(k0, await natkeys());
    check("R1 the predecessor connects with one row under its own lifecycle", predNc !== "denied" && predKeys.length === 1 && (await readNativeIssuance(kv, predKeys[0]!))?.lifecycleUid === predAct.lifecycleUid);
    const sib = await post<{ token: string; exp: number }>("/exchange", { idpToken, actor: "cli" });
    const sibNc = await dial(sib.token);
    check("R1 a sibling connects", sibNc !== "denied");
    const predClosed = predNc !== "denied" ? predNc.closed() : Promise.resolve(undefined);
    const res = await fetch(`${service!.url}${INTERACTIVE_RETIRE_PATH}`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${service!.cap}` }, body: JSON.stringify({ owner, actor: "seat", lifecycleUid: predAct.lifecycleUid }) });
    const body = await res.json() as { retired?: boolean; error?: string };
    check("R1 the loopback retirement door runs the real barrier to completion", res.status === 200 && body.retired === true, { status: res.status, body });
    const evicted = await Promise.race([predClosed.then(() => true), wait(10_000).then(() => false)]);
    check("R1 the predecessor's live socket was evicted", evicted && predNc !== "denied" && predNc.isClosed());
    const predRow = await readNativeIssuance(kv, predKeys[0]!);
    check("R1 the predecessor row stays attributable after retirement", predRow?.lifecycleUid === predAct.lifecycleUid && predRow.credentialId === predAct.credentialId && predRow.actor === "seat");
    const k1 = await natkeys();
    check("R1 the stale predecessor bearer is refused and creates no row", (await dial(pred.token)) === "denied" && (await natkeys()).length === k1.length);
    grantSeat();
    const succ = await post<{ token: string; exp: number }>("/exchange", { idpToken, actor: "seat" }).catch((e: Error) => ({ token: "", exp: 0, error: e.message }));
    const succAct = succ.token ? actOf(succ.token) : undefined;
    const succNc = succ.token ? await dial(succ.token) : "denied";
    const succKeys = fresh(k1, await natkeys());
    const succRow = succKeys[0] ? await readNativeIssuance(kv, succKeys[0]) : undefined;
    check("R1 the same-name successor connects with a NEW uid, credential, key and row",
      succNc !== "denied" && succKeys.length === 1 && !predKeys.includes(succKeys[0]!) && succAct !== undefined && succAct.lifecycleUid !== predAct.lifecycleUid && succAct.credentialId !== predAct.credentialId && succRow?.lifecycleUid === succAct.lifecycleUid && succRow.credentialId === succAct.credentialId,
      { succ: "error" in succ ? succ.error : "ok", rows: succKeys.length });
    let sibOk = false;
    try { if (sibNc !== "denied") { await sibNc.flush(); sibOk = !sibNc.isClosed(); } } catch { sibOk = false; }
    check("R1 the sibling still works after the retirement and the successor", sibOk);
  }
} finally {
  for (const nc of conns) await nc.close().catch(() => {});
  for (const ep of endpoints) await ep.stop().catch(() => {});
  await manager?.stop().catch(() => {});
  await reader?.close().catch(() => {});
  await delivery?.close().catch(() => {});
  await service?.close().catch(() => {});
  idp.closeAllConnections();
  await new Promise<void>((resolve) => idp.close(() => resolve()));
  await fx.close();
}

console.log(`\nnative-issuance-composed smoke: ${pass} passed, ${fail} failed`);
emitSentinel({ passed: pass, failed: fail });
process.exit(fail === 0 ? 0 : 1);
