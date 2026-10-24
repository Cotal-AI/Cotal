import * as core from "../../../packages/core/dist/index.js";
import * as auth from "../../auth/dist/index.js";
// A person's manager-caller view on their own Manager, minted by the real auth service and
// enforced by the broker. The launch reads (status, models, resolve-cwd) answer for a spawn-scoped
// view and are refused for a run-only or no-scope view, and no view gains ps or slots by them.
// Every cell runs and is counted, so a refused read shows as a FAIL line rather than an abort.
const assert: typeof import("node:assert/strict") = (await import("node:assert/strict")).default;
const { createServer } = await import("node:http");
const { createRequire } = await import("node:module");
const { mkdirSync, writeFileSync, realpathSync, symlinkSync } = await import("node:fs");
const { join } = await import("node:path");
const { hostname } = await import("node:os");
const { SignJWT, generateKeyPair, exportJWK, decodeJwt } = createRequire(new URL("../../auth/package.json", import.meta.url))("jose") as any;
const { mintLifecycleUid, mintCreds, newIdentity, setupSpaceStreams, registry, standaloneConnectOpts, issuedUserCaller, resolveService, invokeCommand, permissionsFor } = core;
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
const LAUNCH_READS = ["status", "models", "resolve-cwd"];
/** The manager command each publish row names, with its route and pinned instance. */
const managerRows = (rows: string[]) => rows.flatMap((row) => {
  const m = /\.ep\.(one|all|inst)\.manager\.(.+)$/.exec(row);
  if (!m) return [];
  const rest = m[2]!.split(".");
  return [m[1] === "inst" ? { route: "inst", instanceId: rest[0], command: rest[1] } : { route: m[1], instanceId: undefined, command: rest[0] }];
});

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

  // The mint: the shipped permission builder, for the scopes above, on one pinned instance.
  const minted = (profile: "manager-caller" | "agent", scope: readonly string[]) => {
    const uid = mintLifecycleUid();
    const perms = permissionsFor(profile, a.space, { owner, actor: "census", connId: "launchreadsconn0000", lifecycleUid: uid } as never,
      (profile === "manager-caller" ? { capabilities: [...scope], lifecycleUid: uid, managerInstanceId: iid } : { capabilities: [...scope], lifecycleUid: uid }) as never) as { pub?: { allow?: string[] } };
    return managerRows(perms.pub?.allow ?? []);
  };
  const spawnRows = minted("manager-caller", ["spawn"]);
  const spawnLaunch = spawnRows.filter((r) => LAUNCH_READS.includes(r.command!));
  cell("mint: a spawn view carries status, models and resolve-cwd",
    LAUNCH_READS.every((c) => spawnLaunch.some((r) => r.command === c)), spawnLaunch);
  cell("mint: each launch read row is on the pinned instance and no class or scatter route",
    spawnLaunch.length > 0 && spawnLaunch.every((r) => r.route === "inst" && r.instanceId === iid), spawnLaunch);
  cell("mint: a spawn view carries no ps or slots row",
    !spawnRows.some((r) => r.command === "ps" || r.command === "slots"), spawnRows.map((r) => r.command));
  for (const scope of [["run"], [], ["supervise"]])
    cell(`mint: a ${JSON.stringify(scope)} view carries no launch read`,
      !minted("manager-caller", scope).some((r) => LAUNCH_READS.includes(r.command!) || r.command === "ps" || r.command === "slots"));
  cell("mint: a standing spawn-capable agent credential gains no launch read",
    !minted("agent", ["spawn", "run"]).some((r) => LAUNCH_READS.includes(r.command!)));

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
  const cwd = realpathSync(root);
  const reads = async (c: Awaited<ReturnType<typeof open>>) => ({
    status: await call(c, "status"),
    models: await call(c, "models", {}),
    "resolve-cwd": await call(c, "resolve-cwd", { cwd: root }),
    "list-personas": await call(c, "list-personas"),
    ps: await call(c, "ps"),
    slots: await call(c, "slots"),
  });
  const seen: Record<string, Awaited<ReturnType<typeof reads>>> = {};
  const opened: Record<string, Awaited<ReturnType<typeof open>>> = {};
  for (const actor of Object.keys(actors)) seen[actor] = await reads(opened[actor] = await open(actor));
  const kind = (o: Outcome) => o.kind;

  for (const actor of ["launcher", "member"]) {
    const s = seen[actor]!;
    cell(`${actor}: status answers`, s.status.kind === "answered", s.status);
    cell(`${actor}: models answers`, s.models.kind === "answered", s.models);
    cell(`${actor}: resolve-cwd answers`, s["resolve-cwd"].kind === "answered", s["resolve-cwd"]);
    cell(`${actor}: list-personas answers`, s["list-personas"].kind === "answered", s["list-personas"]);
    cell(`${actor}: ps and slots stay broker-refused`, s.ps.kind === "broker-refused" && s.slots.kind === "broker-refused", [kind(s.ps), kind(s.slots)]);
  }
  const l = seen.launcher!;
  cell("launcher: status names this Manager and its available connector",
    l.status.kind === "answered" && l.status.data.instanceId === iid && l.status.data.execution === "runtime"
      && l.status.data.connectors.some((c: any) => c.agent === "launch-probe" && c.state === "available"), l.status);
  cell("launcher: models returns the connector's catalog",
    l.models.kind === "answered" && l.models.data.catalogs.some((c: any) => c.agent === "launch-probe" && c.supported && c.models.some((m: any) => m.id === "probe-model")), l.models);
  cell("launcher: resolve-cwd returns the canonical directory on this host",
    l["resolve-cwd"].kind === "answered" && l["resolve-cwd"].data.cwd === cwd && l["resolve-cwd"].data.host === hostname(), l["resolve-cwd"]);
  const r = seen.runner!;
  cell("runner: status, models, resolve-cwd, ps and slots stay broker-refused",
    [r.status, r.models, r["resolve-cwd"], r.ps, r.slots].every((o) => o.kind === "broker-refused"), [r.status, r.models, r["resolve-cwd"], r.ps, r.slots].map(kind));
  cell("runner: list-personas answers", r["list-personas"].kind === "answered", r["list-personas"]);
  const d = seen.reader!;
  cell("reader: every read stays broker-refused", Object.values(d).every((o) => o.kind === "broker-refused"), Object.values(d).map(kind));
  const o = seen.operator!;
  cell("operator: status, models, resolve-cwd, list-personas and ps answer",
    [o.status, o.models, o["resolve-cwd"], o["list-personas"], o.ps].every((x) => x.kind === "answered"), [o.status, o.models, o["resolve-cwd"], o["list-personas"], o.ps].map(kind));
  cell("operator: slots reaches the Manager, which owns no slot rows in user mode",
    o.slots.kind === "manager-refused" && o.slots.code === "failed-precondition", o.slots);

  const launcher = opened.launcher!;
  const elsewhere = await resolveService(launcher.nc, a.space, "manager", launcher.issued, { instanceId: control.state.instanceId, deadlineMs: 2000 })
    .then(() => "resolved", (e: Error) => /REFUSED BY THE BROKER/.test(e.message) ? "broker-refused" : e.message);
  cell("launcher: the view is broker-refused on another Manager instance", elsewhere === "broker-refused", elsewhere);
  const foreign = await exchange(otherToken, "launcher", iid);
  cell("another owner's spawn-scoped actor cannot obtain a view of this Manager", foreign.status !== 200 && foreign.body.token === undefined, foreign);

  // The control host's filesystem is not the resource where a delegated launcher may execute.
  // These owned paths are outside either participant's workspace. All calls use a real exchanged
  // spawn-only view, registered contract, broker and Manager handler, never a private method.
  const outside = join(fx.dir, "outside-workspaces"), alias = join(fx.dir, "outside-alias"), missing = join(fx.dir, "missing-outside");
  mkdirSync(outside); symlinkSync(outside, alias);
  const delegatedCaller = await open("launcher", delegated.state.instanceId, otherToken, otherOwner);
  const delegatedStatus = await call(delegatedCaller, "status");
  cell("delegated launcher: status identifies the delegated runtime",
    delegatedStatus.kind === "answered" && delegatedStatus.data.runtime === "launch-delegated" && delegatedStatus.data.execution === "runtime", delegatedStatus);
  const refusals: Outcome[] = [];
  for (const [label, cwd] of [["existing", outside], ["missing", missing], ["symlink", alias]]) {
    const result = await call(delegatedCaller, "resolve-cwd", { cwd });
    refusals.push(result);
    cell(`delegated launcher: ${label} host path is refused by execution mode`,
      result.kind === "manager-refused" && result.code === "failed-precondition" && /starts seats outside this host/.test(JSON.stringify(result.error)), result);
  }
  cell("delegated launcher: existing, missing and symlink host paths have identical refusals",
    refusals.every((r) => r.kind === "manager-refused") && new Set(refusals.map((r) => JSON.stringify(r))).size === 1, refusals);
  cell("delegated launcher: neither runtime spawn entry was called", runtimeSpawnCalls === 0, runtimeSpawnCalls);
} catch (error) {
  failed++; console.log(`FAIL fixture: ${(error as Error).message}`);
} finally {
  for (const nc of callers) await nc.close().catch(() => {});
  await participant?.manager.stop({ withAgents: true }); await control?.manager.stop();
  await delegated?.manager.stop({ withAgents: true });
  try { await service?.close(); } finally { await delivery?.stop(); await fx.close(); await new Promise<void>((r) => idp.close(() => r())); }
}
console.log(`launch reads: ${passed} passed, ${failed} failed`);
emitSentinel({ passed, failed });
if (failed) process.exitCode = 1;
