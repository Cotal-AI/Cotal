import * as core from "../../../packages/core/dist/index.js";
import * as auth from "../../auth/dist/index.js";
// Verified exact-instance status via the public browser caller and host-generated contracts.
const assert: typeof import("node:assert/strict") = (await import("node:assert/strict")).default;
const { createServer } = await import("node:http");
const { createRequire } = await import("node:module");
const { mkdirSync, writeFileSync, readFileSync, cpSync, symlinkSync } = await import("node:fs");
const { join } = await import("node:path");
const { hostname } = await import("node:os");
const { pathToFileURL } = await import("node:url");
const { SignJWT, generateKeyPair, exportJWK, decodeJwt } = createRequire(new URL("../../auth/package.json", import.meta.url))("jose") as any;
const { mintLifecycleUid, mintCreds, newIdentity, setupSpaceStreams, registry } = core;
const { startAuthService, grantActor, loadOwnerSecret, deriveOwnerForIdpSubject } = auth;
const { startHostedAuthFixture } = await import("../../auth/smoke/_hosted-auth-fixture.js");
const { bootDeliveryDaemon } = await import("./_boot-delivery.js");
const { nativeRemoteManager } = await import("./_native-remote-manager.js");
const { remoteManagerClient } = await import("../dist/index.js");
const { emitSentinel } = await import("@cotal-ai/smoke-kit");

let passed = 0, failed = 0;
const cell = (name: string, ok: boolean, seen?: unknown) => {
  if (ok) { passed++; console.log(`PASS ${name}`); return; }
  failed++; console.log(`FAIL ${name}${seen === undefined ? "" : ` - ${JSON.stringify(seen)}`}`);
};
const pair = await generateKeyPair("EdDSA", { extractable: true });
const jwk = { ...await exportJWK(pair.publicKey), kid: "status-idp", alg: "EdDSA", use: "sig" };
const idp = createServer((q, s) => { if (q.url !== "/api/auth/jwks") { s.writeHead(404); s.end(); return; } s.setHeader("content-type", "application/json"); s.end(JSON.stringify({ keys: [jwk] })); });
await new Promise<void>((r) => idp.listen(0, "127.0.0.1", r));
const origin = `http://127.0.0.1:${(idp.address() as import("node:net").AddressInfo).port}`;
const jwt = (sub: string) => new SignJWT({}).setProtectedHeader({ alg: "EdDSA", kid: jwk.kid }).setIssuer(origin).setAudience(origin).setSubject(sub).setIssuedAt().setExpirationTime("10m").sign(pair.privateKey);
const fx = await startHostedAuthFixture("status-meta", 1, { websocket: true }); const a = fx.accounts[0]!;
writeFileSync(join(a.stateDir, "idp.json"), JSON.stringify({ ver: 1, url: `${origin}/api/auth`, issuer: origin, audience: origin, jwksUri: `${origin}/api/auth/jwks` }), { mode: 0o600 });
const root = join(fx.dir, "participant"), controlRoot = join(fx.dir, "control"), peerRoot = join(fx.dir, "peer");
mkdirSync(join(root, ".cotal", "agents"), { recursive: true }); mkdirSync(controlRoot);
mkdirSync(peerRoot);
const controlState = remoteManagerClient.loadOrCreateRemoteManagerIdentity(controlRoot, a.space);
const assignment = { v: 1 as const, space: a.space, accountPublicKey: a.accountPublicKey, instanceId: controlState.instanceId, lifecycleUid: controlState.lifecycleUid, assignmentRevision: 1, state: "assigned" as const };
const ownerSecret = (await loadOwnerSecret(a.store, a.space))!;
const owner = deriveOwnerForIdpSubject(ownerSecret, origin, "owner"), otherOwner = deriveOwnerForIdpSubject(ownerSecret, origin, "other");
// Each owner holds its own Manager and a browser actor authorized for its participant instance.
for (const callerOwner of [owner, otherOwner]) {
  grantActor(a.stateDir, { owner: callerOwner, actor: "launcher", lifecycleUid: mintLifecycleUid(), scope: ["spawn"], allowSubscribe: [], allowPublish: [] });
}
grantActor(a.stateDir, { owner, actor: "cli", lifecycleUid: mintLifecycleUid(), scope: ["supervise"], allowSubscribe: [], allowPublish: [] });
grantActor(a.stateDir, { owner: otherOwner, actor: "cli", lifecycleUid: mintLifecycleUid(), scope: ["supervise"], allowSubscribe: [], allowPublish: [] });
const token = await jwt("owner"), otherToken = await jwt("other");
// A connector that reports a catalog and is never launched.
registry.register({ kind: "connector", name: "status-probe", requires: ["node"], listModels: () => ({ models: [{ id: "probe-model" }] }),
  buildLaunch: () => { throw new Error("status-metadata: nothing is launched"); } } as import("@cotal-ai/core").Connector);
let service: Awaited<ReturnType<typeof startAuthService>> | undefined;
let delivery: Awaited<ReturnType<typeof bootDeliveryDaemon>> | undefined;
let participant: Awaited<ReturnType<typeof nativeRemoteManager>> | undefined;
let control: Awaited<ReturnType<typeof nativeRemoteManager>> | undefined;
let peer: Awaited<ReturnType<typeof nativeRemoteManager>> | undefined;
const browserCallers: Array<{ close(): Promise<void> }> = [];
const copyRoot = join(fx.dir, "peer-package");
try {
  await setupSpaceStreams({ space: a.space, servers: fx.servers, creds: await mintCreds(a.auth, newIdentity(), "provisioner") });
  delivery = await bootDeliveryDaemon({ space: a.space, servers: fx.servers, auth: a.auth, reloadStoreIdentity: a.store.identity });
  service = await startAuthService({ context: { accountPublicKey: a.accountPublicKey, lifecycleUid: mintLifecycleUid() }, space: a.space, servers: fx.servers, stateDir: a.stateDir, store: a.store, storeIdentity: a.store.identity, publicFace: { port: 0, trustedProxy: false }, platformControl: { observeAssignment: async () => assignment } });
  const humanCall = (idpToken: string) => async (request: any) => { const response = await fetch(`${service!.publicUrl}/manager-service-authority`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ idpToken, request }) }); const body = await response.json() as any; if (!response.ok) throw new Error(`authority refused ${request.kind}: ${body.error}`); return body; };
  const controlCall = (request: any) => service!.platformControlAuthority!({ v: 1, kind: "platform-control-authority", space: a.space, accountPublicKey: a.accountPublicKey, assignmentRevision: 1, request });
  control = await nativeRemoteManager({ space: a.space, servers: fx.servers, root: controlRoot, exchangeUrl: service.publicUrl!, execution: "none", call: controlCall });
  participant = await nativeRemoteManager({ space: a.space, servers: fx.servers, root, exchangeUrl: service.publicUrl!, execution: "runtime", call: humanCall(token) });
  // Unmodified shipped JS in a separate package root proves the version comes from the
  // answering package, not this test's client dependency. No Manager implementation is restated.
  cpSync(new URL("../dist/", import.meta.url), join(copyRoot, "dist"), { recursive: true });
  const stockPackage = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const peerVersion = "0.0.0-status-peer";
  writeFileSync(join(copyRoot, "package.json"), JSON.stringify({ ...stockPackage, version: peerVersion }));
  symlinkSync(new URL("../node_modules", import.meta.url), join(copyRoot, "node_modules"), "dir");
  const { Manager: PeerManager } = await import(pathToFileURL(join(copyRoot, "dist", "manager.js")).href);
  peer = await nativeRemoteManager({ space: a.space, servers: fx.servers, root: peerRoot, exchangeUrl: service.publicUrl!, execution: "runtime", call: humanCall(otherToken), ManagerClass: PeerManager });
  // Package replacement after loading cannot change the version of the running implementation.
  writeFileSync(join(copyRoot, "package.json"), JSON.stringify({ ...stockPackage, version: "0.0.0-replaced-on-disk" }));
  assert.equal(participant.owner, owner);
  assert.equal(peer.owner, otherOwner);
  const iid = participant.state.instanceId;

  // The wire: each actor exchanges its own manager-caller view and calls its own Manager.
  const exchange = async (idpToken: string, actor: string, instanceId: string) => {
    const response = await fetch(`${service!.publicUrl}/exchange`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ idpToken, actor, view: "manager-caller", managerInstanceId: instanceId }) });
    return { status: response.status, body: await response.json() as any };
  };
  const { generateBrowserContracts } = await import("@cotal-ai/core/browser-validators-build");
  const { managerBrowserContractSource } = await import("../dist/index.js");
  const source = managerBrowserContractSource();
  const generated = generateBrowserContracts([source]);
  const generatedFile = join(fx.dir, "contracts.mjs");
  symlinkSync(new URL("../../../packages/core/node_modules", import.meta.url), join(fx.dir, "node_modules"), "dir");
  writeFileSync(generatedFile, generated.text);
  const { contracts } = await import(pathToFileURL(generatedFile).href);
  const { openBrowserManagerCaller } = await import("@cotal-ai/core/browser-control");
  const browserOpen = async (instanceId: string, idpToken: string, callerOwner: string) => {
    const ex = await exchange(idpToken, "launcher", instanceId);
    assert.equal(ex.status, 200);
    const claims = decodeJwt(ex.body.token) as any;
    const c = await openBrowserManagerCaller({ servers: fx.wsServers!, space: a.space, owner: callerOwner, actor: "launcher", lifecycleUid: claims.act.lifecycleUid,
      instanceId, contracts, acquire: async () => ({ bearer: ex.body.token, sentinelCreds: a.sentinelCreds }), deadlineMs: 15000 });
    browserCallers.push(c); return c;
  };
  cell("public contract revision includes status metadata", source.document.revision >= 28, source.document.revision);
  const A = await browserOpen(iid, token, owner), B = await browserOpen(peer.state.instanceId, otherToken, otherOwner);
  const aStatus = await A.invoke("status"), bStatus = await B.invoke("status");
  const aData = aStatus.reply.data as Record<string, unknown>, bData = bStatus.reply.data as Record<string, unknown>;
  cell("browser caller A receives exact selected instance", aStatus.reply.ok && aStatus.responder.instanceId === iid && aData.instanceId === iid);
  cell("browser caller B receives its distinct selected instance", bStatus.reply.ok && bStatus.responder.instanceId === peer.state.instanceId && bData.instanceId === peer.state.instanceId && peer.state.instanceId !== iid);
  cell("status A reports the answering host", aData.host === hostname(), aData.host);
  cell("status B reports the answering host", bData.host === hostname(), bData.host);
  cell("status A reports its own stock package version", aData.version === stockPackage.version, aData.version);
  cell("status B reports its own running package version, not caller or replaced disk", bData.version === peerVersion && bData.version !== aData.version, bData.version);
  const outputDigest = source.document.commands.find((c) => c.name === "status")!.outputDigest;
  const validate = contracts.validators[outputDigest];
  cell("host-generated browser validator accepts complete status", validate(aData) && validate(bData));
  const { host: _host, version: _version, ...withoutMetadata } = aData;
  cell("absent metadata compatibility: output validator accepts omission", validate(withoutMetadata));
  cell("absent metadata compatibility: no values are synthesized", !Object.hasOwn(withoutMetadata, "host") && !Object.hasOwn(withoutMetadata, "version"));
  cell("absent metadata compatibility: version alone validates", validate({ ...withoutMetadata, version: bData.version }));
  cell("absent metadata compatibility: host alone validates", validate({ ...withoutMetadata, host: bData.host }));
  // Compile-time package-root public type also permits older payloads.
  const typedOlder: Omit<import("@cotal-ai/manager").ManagerStatus, "instanceId"> = {
    execution: "none", runtime: "none", custody: "none", runHosting: false, terminalSessions: false,
    agentCount: 0, uptimeMs: 0, connectors: [], classSpawn: false, staticReconciliation: { state: "idle", failures: [] },
  };
  cell("public ManagerStatus type permits absent display metadata", validate({ ...typedOlder, instanceId: iid }));
  cell("metadata type contract rejects non-string host", !validate({ ...aData, host: 42 }));
  cell("metadata type contract rejects non-string version", !validate({ ...aData, version: 42 }));
  const swapped = await exchange(token, "launcher", iid);
  const badPin = await openBrowserManagerCaller({ servers: fx.wsServers!, space: a.space, owner, actor: "launcher", lifecycleUid: (decodeJwt(swapped.body.token) as any).act.lifecycleUid,
    instanceId: peer.state.instanceId, contracts, acquire: async () => ({ bearer: swapped.body.token, sentinelCreds: a.sentinelCreds }) }).then(async (c) => { await c.close(); return false; }, () => true);
  cell("advisory metadata does not widen exact-instance bearer authority", badPin);
} catch (error) {
  failed++; console.log(`FAIL fixture: ${(error as Error).message}`);
} finally {
  for (const c of browserCallers) await c.close().catch(() => {});
  await participant?.manager.stop({ withAgents: true }); await control?.manager.stop();
  await peer?.manager.stop({ withAgents: true });
  try { await service?.close(); } finally { await delivery?.stop(); await fx.close(); await new Promise<void>((r) => idp.close(() => r())); }
}
console.log(`status metadata: ${passed} passed, ${failed} failed`);
emitSentinel({ passed, failed });
if (failed) process.exitCode = 1;
