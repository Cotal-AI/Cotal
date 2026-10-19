// Public-door containment of explicit persona config paths on delegated execution.
import * as core from "../../../packages/core/dist/index.js";
import * as auth from "../../auth/dist/index.js";
// Issued spawn-only views exercise every public persona-config door through a real broker.
// Observers delegate filesystem calls unchanged and count only the caller-selected paths.
const assert: typeof import("node:assert/strict") = (await import("node:assert/strict")).default;
const { createServer } = await import("node:http");
const { createRequire } = await import("node:module");
const { mkdirSync, writeFileSync, symlinkSync } = await import("node:fs");
const { join } = await import("node:path");
const { SignJWT, generateKeyPair, exportJWK, decodeJwt } = createRequire(new URL("../../auth/package.json", import.meta.url))("jose") as any;
const { mintLifecycleUid, mintCreds, newIdentity, setupSpaceStreams, registry, standaloneConnectOpts, issuedUserCaller, resolveService, invokeCommand } = core;
const { connect } = await import("@nats-io/transport-node");
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
const jwk = { ...await exportJWK(pair.publicKey), kid: "launch-idp", alg: "EdDSA", use: "sig" };
const idp = createServer((q, s) => { if (q.url !== "/api/auth/jwks") { s.writeHead(404); s.end(); return; } s.setHeader("content-type", "application/json"); s.end(JSON.stringify({ keys: [jwk] })); });
await new Promise<void>((r) => idp.listen(0, "127.0.0.1", r));
const origin = `http://127.0.0.1:${(idp.address() as import("node:net").AddressInfo).port}`;
const jwt = (sub: string) => new SignJWT({}).setProtectedHeader({ alg: "EdDSA", kid: jwk.kid }).setIssuer(origin).setAudience(origin).setSubject(sub).setIssuedAt().setExpirationTime("10m").sign(pair.privateKey);
const fx = await startHostedAuthFixture("launch-probe", 1); const a = fx.accounts[0]!;
writeFileSync(join(a.stateDir, "idp.json"), JSON.stringify({ ver: 1, url: `${origin}/api/auth`, issuer: origin, audience: origin, jwksUri: `${origin}/api/auth/jwks` }), { mode: 0o600 });
const root = join(fx.dir, "participant"), controlRoot = join(fx.dir, "control"), delegatedRoot = join(fx.dir, "delegated");
mkdirSync(join(root, ".cotal", "agents"), { recursive: true }); mkdirSync(controlRoot);
mkdirSync(delegatedRoot);
const controlState = remoteManagerClient.loadOrCreateRemoteManagerIdentity(controlRoot, a.space);
const assignment = { v: 1 as const, space: a.space, accountPublicKey: a.accountPublicKey, instanceId: controlState.instanceId, lifecycleUid: controlState.lifecycleUid, assignmentRevision: 1, state: "assigned" as const };
const ownerSecret = (await loadOwnerSecret(a.store, a.space))!;
const owner = deriveOwnerForIdpSubject(ownerSecret, origin, "owner"), otherOwner = deriveOwnerForIdpSubject(ownerSecret, origin, "other");
// "cli" holds the Manager. Each other actor is one scope shape a person's row can carry; "member"
// is the hosted participant row and "operator" the same row for a space owner.
const actors = {
  launcher: ["spawn"], member: ["spawn", "role:default", "run"], runner: ["run"], reader: [], operator: ["spawn", "role:default", "run", "admin"],
} as const;
grantActor(a.stateDir, { owner, actor: "cli", lifecycleUid: mintLifecycleUid(), scope: ["supervise"], allowSubscribe: [], allowPublish: [] });
for (const [actor, scope] of Object.entries(actors)) grantActor(a.stateDir, { owner, actor, lifecycleUid: mintLifecycleUid(), scope: [...scope], allowSubscribe: [], allowPublish: [] });
grantActor(a.stateDir, { owner: otherOwner, actor: "launcher", lifecycleUid: mintLifecycleUid(), scope: ["spawn"], allowSubscribe: [], allowPublish: [] });
grantActor(a.stateDir, { owner: otherOwner, actor: "cli", lifecycleUid: mintLifecycleUid(), scope: ["supervise"], allowSubscribe: [], allowPublish: [] });
const token = await jwt("owner"), otherToken = await jwt("other");
// A connector that reports a catalog and is never launched.
registry.register({ kind: "connector", name: "launch-probe", requires: ["node"], listModels: () => ({ models: [{ id: "probe-model" }] }),
  buildLaunch: () => { throw new Error("launch-reads: nothing is launched"); } } as import("@cotal-ai/core").Connector);
let runtimeSpawnCalls = 0;
const neverSpawn = (): never => { runtimeSpawnCalls++; throw new Error("launch-reads: nothing is launched"); };
const delegatedRuntime: import("@cotal-ai/core").RuntimeProvider = { kind: "runtime", name: "launch-delegated", available: () => true,
  create: () => ({ kind: "launch-delegated", spawn: neverSpawn, spawnDelegated: neverSpawn }) };
registry.register(delegatedRuntime);
let service: Awaited<ReturnType<typeof startAuthService>> | undefined;
let delivery: Awaited<ReturnType<typeof bootDeliveryDaemon>> | undefined;
let participant: Awaited<ReturnType<typeof nativeRemoteManager>> | undefined;
let control: Awaited<ReturnType<typeof nativeRemoteManager>> | undefined;
let delegated: Awaited<ReturnType<typeof nativeRemoteManager>> | undefined;
const callers: Awaited<ReturnType<typeof connect>>[] = [];
try {
  await setupSpaceStreams({ space: a.space, servers: fx.servers, creds: await mintCreds(a.auth, newIdentity(), "provisioner") });
  delivery = await bootDeliveryDaemon({ space: a.space, servers: fx.servers, auth: a.auth, reloadStoreIdentity: a.store.identity });
  service = await startAuthService({ context: { accountPublicKey: a.accountPublicKey, lifecycleUid: mintLifecycleUid() }, space: a.space, servers: fx.servers, stateDir: a.stateDir, store: a.store, storeIdentity: a.store.identity, publicFace: { port: 0, trustedProxy: false }, platformControl: { observeAssignment: async () => assignment } });
  const humanCall = (idpToken: string) => async (request: any) => { const response = await fetch(`${service!.publicUrl}/manager-service-authority`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ idpToken, request }) }); const body = await response.json() as any; if (!response.ok) throw new Error(`authority refused ${request.kind}: ${body.error}`); return body; };
  const controlCall = (request: any) => service!.platformControlAuthority!({ v: 1, kind: "platform-control-authority", space: a.space, accountPublicKey: a.accountPublicKey, assignmentRevision: 1, request });
  control = await nativeRemoteManager({ space: a.space, servers: fx.servers, root: controlRoot, exchangeUrl: service.publicUrl!, execution: "none", call: controlCall });
  participant = await nativeRemoteManager({ space: a.space, servers: fx.servers, root, exchangeUrl: service.publicUrl!, execution: "runtime", call: humanCall(token) });
  delegated = await nativeRemoteManager({ space: a.space, servers: fx.servers, root: delegatedRoot, exchangeUrl: service.publicUrl!, execution: "runtime", runtime: "launch-delegated", call: humanCall(otherToken) });
  assert.equal(participant.owner, owner);
  assert.equal(delegated.owner, otherOwner);
  const iid = participant.state.instanceId;

  // The wire: each actor exchanges its own manager-caller view and calls its own Manager.
  const exchange = async (idpToken: string, actor: string, instanceId: string) => {
    const response = await fetch(`${service!.publicUrl}/exchange`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ idpToken, actor, view: "manager-caller", managerInstanceId: instanceId }) });
    return { status: response.status, body: await response.json() as any };
  };
  const open = async (actor: string, instanceId = iid, idpToken = token, callerOwner = owner) => {
    const ex = await exchange(idpToken, actor, instanceId);
    assert.equal(ex.status, 200, `exchange ${actor}: ${ex.body.error}`);
    const options = standaloneConnectOpts({ bearer: ex.body.token, sentinelCreds: a.sentinelCreds, tls: false });
    const nc = await connect({ servers: fx.servers, ...options }); callers.push(nc);
    const issued = await issuedUserCaller(nc, a.space, String(options.name), { owner: callerOwner, actor, uid: (decodeJwt(ex.body.token) as any).act.lifecycleUid });
    return { nc, issued, instanceId, service: await resolveService(nc, a.space, "manager", issued, { instanceId }) };
  };
  type Outcome = { kind: "answered"; data: any } | { kind: "manager-refused"; code: string; error: unknown } | { kind: "broker-refused" } | { kind: "error"; message: string };
  const call = async (c: Awaited<ReturnType<typeof open>>, command: string, args?: Record<string, unknown>): Promise<Outcome> => {
    try {
      const r = await invokeCommand(c.nc, a.space, c.service, command, args, { deadlineMs: 15000 });
      assert.equal(r.responder.instanceId, c.instanceId);
      return r.reply.ok ? { kind: "answered", data: r.reply.data } : { kind: "manager-refused", code: String(r.reply.error?.code), error: r.reply.error };
    } catch (error) {
      const message = (error as Error).message;
      return /REFUSED BY THE BROKER/.test(message) ? { kind: "broker-refused" } : { kind: "error", message };
    }
  };
  const fs = (await import("node:fs")).default;
  const { syncBuiltinESMExports } = await import("node:module");
  const { resolve, relative } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const outside = join(fx.dir, "outside"), alias = join(fx.dir, "outside-alias"), missing = join(fx.dir, "missing");
  mkdirSync(outside); symlinkSync(outside, alias);
  const file = join(outside, "probe.md"), fileAlias = join(fx.dir, "persona-alias.md");
  const personaText = "---\nname: probe\nagent: launch-probe\nsubscribe: []\nallowSubscribe: []\nallowPublish: []\ncapabilities: []\n---\n";
  writeFileSync(file, personaText); symlinkSync(file, fileAlias);
  mkdirSync(join(delegatedRoot, ".cotal", "agents"), { recursive: true });
  writeFileSync(join(delegatedRoot, ".cotal", "agents", "probe.md"), personaText);
  const watched = [outside, alias, missing, file, fileAlias, join(delegatedRoot, ".cotal", "agents", "probe.md")];
  const fsOperations: string[] = [];
  let observing = false;
  const restorers: Array<() => void> = [];
  // Observe the real filesystem primitives imported by shipped code, without changing their answers.
  // Only caller-selected persona paths count. Ledger/registration reads are not persona path reads.
  for (const method of ["existsSync", "readFileSync", "statSync", "lstatSync", "realpathSync", "openSync", "accessSync", "readdirSync", "readlinkSync"] as const) {
    const original = fs[method];
    const replacement = (...args: unknown[]) => {
      const raw = args[0] instanceof URL ? fileURLToPath(args[0]) : args[0];
      const path = typeof raw === "string" || Buffer.isBuffer(raw) ? resolve(String(raw)) : undefined;
      if (observing && path !== undefined && watched.some((p) => path === p || path.startsWith(p + "/"))) fsOperations.push(method);
      return Reflect.apply(original, fs, args);
    };
    Object.assign(replacement, original);
    Object.assign(fs, { [method]: replacement });
    restorers.push(() => Object.assign(fs, { [method]: original }));
  }
  syncBuiltinESMExports();
  const observed = async <T>(fn: () => Promise<T>) => {
    fsOperations.length = 0; observing = true;
    try { return { result: await fn(), reads: fsOperations.length }; }
    finally { observing = false; }
  };
  try {
    const delegatedCaller = await open("launcher", delegated.state.instanceId, otherToken, otherOwner);
    const localCaller = await open("launcher");
    const expectedMessage = "delegated execution cannot use a manager-host persona config path; select a named persona";
    const refused = (o: Outcome) => o.kind === "manager-refused" && o.code === "failed-precondition"
      && (o.error as { message?: unknown }).message === expectedMessage;
    // A census over the shipped schema source prevents an added config door escaping this matrix.
    const { managerBrowserContractSource } = await import("../dist/index.js");
    const source = managerBrowserContractSource();
    const configDoors = source.document.commands.filter((command) => {
      const root = source.roots.find((root) => core.singleDocumentClosure(root).closureDigest === command.inputDigest) as { properties?: Record<string, unknown> } | undefined;
      return root?.properties?.config !== undefined;
    }).map((c) => c.name).sort();
    cell("census: every public config door is covered", JSON.stringify(configDoors) === JSON.stringify(["resolve-agent", "spawn"]), configDoors);
    const results: Outcome[] = [];
    for (const command of configDoors) {
      const paths = [["existing", outside], ["missing", missing], ["symlink", alias], ["file", file], ["file-symlink", fileAlias], ["relative", relative(delegatedRoot, outside)], ["named-config", "probe"], ["workspace-relative", ".cotal/agents/probe.md"]];
      for (const [label, config] of paths) {
        // cwd is an independent, later admission refusal on the old code, so even a valid config
        // cannot reach enrollment or a launch while the missing config guard is reproduced.
        const { result, reads } = await observed(() => call(delegatedCaller, command, { name: "probe", config, ...(command === "spawn" ? { events: false, cwd: outside } : {}) }));
        results.push(result);
        cell(`${command}: ${label} config gets the fixed refusal`, refused(result), result);
        cell(`${command}: ${label} config causes zero persona-path filesystem operations`, reads === 0, reads);
      }
    }
    cell("all public config doors and path classes return identical errors", results.every(refused) && new Set(results.map((r) => JSON.stringify(r))).size === 1);
    for (const [label, config] of [["existing", outside], ["missing", missing], ["symlink", alias]]) {
      const { result, reads } = await observed(() => delegated!.manager.startAgent({ name: "probe", config, events: false }));
      cell(`library startAgent: ${label} config gets the same refusal`, !result.ok && result.error === expectedMessage, result.error);
      cell(`library startAgent: ${label} config causes zero persona-path filesystem operations`, reads === 0, reads);
    }
    for (const config of [file, fileAlias]) {
      const { result, reads } = await observed(() => call(localCaller, "resolve-agent", { name: "probe", config }));
      cell("local Manager: explicit persona file still resolves the harness", result.kind === "answered" && result.data.agent === "launch-probe", result);
      cell("observer positive control: local file resolution reads the selected path", reads > 0, reads);
    }
    const localMissing = await call(localCaller, "resolve-agent", { name: "probe", config: missing });
    cell("local Manager: missing config retains its named diagnostic", localMissing.kind === "manager-refused" && /agent file not found/.test(JSON.stringify(localMissing.error)), localMissing);
    const named = await call(delegatedCaller, "resolve-agent", { name: "probe" });
    cell("delegated Manager: named catalog persona still resolves", named.kind === "answered" && named.data.agent === "launch-probe", named);
    // The host's validated manifest profile is a separate authority, not a wire config override.
    // A later unsupported cwd refusal keeps this positive control from enrollment or execution.
    const resolved = { name: "probe", agent: "launch-probe", hash: "probe", subscribe: [], allowSubscribe: [], allowPublish: [] };
    const manifest = await observed(() => delegated!.manager.startAgent({ name: "probe", agent: "launch-probe", config: file, resolved, events: false, cwd: outside }));
    cell("trusted resolved manifest retains its resource path instead of the config-override refusal",
      !manifest.result.ok && manifest.result.error !== expectedMessage && /user-mode registry record|cannot run in a directory on this host/.test(manifest.result.error ?? "") && manifest.reads > 0, manifest.result.error);
    for (const command of configDoors) {
      const result = await observed(() => call(delegatedCaller, command, { name: "probe", config: file, resolved: { name: "probe" } }));
      cell(`${command}: wire cannot inject resolved-manifest authority`, result.result.kind === "error" && result.reads === 0, result.result);
    }
    for (const command of ["list-personas", "show-persona"]) {
      const { result, reads } = await observed(() => call(delegatedCaller, command, { name: "probe", config: file }));
      cell(`${command}: closed input has no config path door`, result.kind === "error" && reads === 0, result.kind);
    }
    for (const [command, args] of [["define-persona", { name: "probe", persona: "probe", config: file }], ["launch", { runId: "probe", name: "probe", config: file }]] as const) {
      const { result, reads } = await observed(() => call(delegatedCaller, command, args));
      cell(`${command}: closed input has no config path door`, result.kind === "error" && reads === 0, result.kind);
    }
    cell("neither runtime launch entry was called", runtimeSpawnCalls === 0, runtimeSpawnCalls);
  } finally {
    for (const restore of restorers.reverse()) restore();
    syncBuiltinESMExports();
  }
} catch (error) {
  failed++; console.log(`FAIL fixture: ${(error as Error).message}`);
} finally {
  for (const nc of callers) await nc.close().catch(() => {});
  await participant?.manager.stop({ withAgents: true }); await control?.manager.stop();
  await delegated?.manager.stop({ withAgents: true });
  try { await service?.close(); } finally { await delivery?.stop(); await fx.close(); await new Promise<void>((r) => idp.close(() => r())); }
}
console.log(`delegated config: ${passed} passed, ${failed} failed`);
emitSentinel({ passed, failed });
if (failed) process.exitCode = 1;
