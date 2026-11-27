import * as core from "../../../packages/core/dist/index.js";
import * as auth from "../../auth/dist/index.js";
// A person's manager-caller view on their own Manager, minted by the real auth service and
// enforced by the broker. The spawn reads (status, models, resolve-cwd, list-dir, harness-commands) answer for a
// spawn-scoped view and are refused for a run-only or no-scope view. `ps` answers on every view of
// a person's own row whatever its scope, bounded by the Manager to the caller's owner (SPEC 13.21).
// No view gains slots by them.
// Every cell runs and is counted, so a refused read shows as a FAIL line rather than an abort.
const assert: typeof import("node:assert/strict") = (await import("node:assert/strict")).default;
const { createServer } = await import("node:http");
const { createRequire } = await import("node:module");
const { mkdirSync, writeFileSync, realpathSync, symlinkSync, chmodSync, rmSync } = await import("node:fs");
const { join } = await import("node:path");
const { hostname, homedir } = await import("node:os");
const { SignJWT, generateKeyPair, exportJWK, decodeJwt } = createRequire(new URL("../../auth/package.json", import.meta.url))("jose") as any;
const { mintLifecycleUid, mintCreds, newIdentity, setupSpaceStreams, registry, standaloneConnectOpts, issuedUserCaller, resolveService, invokeCommand, permissionsFor } = core;
const { connect } = await import("@nats-io/transport-node");
const { startAuthService, grantActor, loadOwnerSecret, deriveOwnerForIdpSubject } = auth;
const { startHostedAuthFixture } = await import("../../auth/smoke/_hosted-auth-fixture.js");
const { bootDeliveryDaemon } = await import("./_boot-delivery.js");
const { nativeRemoteManager } = await import("./_native-remote-manager.js");
const { remoteManagerClient } = await import("../dist/index.js");
const { emitSentinel } = await import("@cotal-ai/smoke-kit");
const { trustProject } = await import("@cotal-ai/workspace");
// A Manager runs as the `cotal` binary: a spawn that passes admission re-runs this process's entry
// for the seat's bearer (`bearerEntryArgv`), and this suite must never be that entry.
process.argv[1] = new URL("../../../bin/cotal.ts", import.meta.url).pathname;

let passed = 0, failed = 0;
const cell = (name: string, ok: boolean, seen?: unknown) => {
  if (ok) { passed++; console.log(`PASS ${name}`); return; }
  failed++; console.log(`FAIL ${name}${seen === undefined ? "" : ` - ${JSON.stringify(seen)}`}`);
};
const SPAWN_READS = ["status", "models", "resolve-cwd", "list-dir", "harness-commands", "ps"];
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
writeFileSync(join(root, ".cotal", "agents", "probe.md"), "---\nname: probe\nagent: launch-probe\n---\nA probe that is never launched.\n");
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
// The commands it lists echo the directory they were asked for, and one carries a target the
// connector does not declare, so the reply shows the Manager's own normalization.
const probeCommands = { targets: ["command"] as const, list: async ({ cwd }: { cwd: string }) => ({ supported: true as const, commands: [
  { name: "probe-cmd", target: "command" as const, description: `listed for ${cwd}`, inputHint: "<topic>" },
  { name: "has space", target: "command" as const },
] }) };
registry.register({ kind: "connector", name: "launch-probe", requires: ["node"], listModels: () => ({ models: [{ id: "probe-model" }] }), commands: probeCommands, supportsPrompt: true,
  buildLaunch: () => { throw new Error("launch-reads: nothing is launched"); } } as import("@cotal-ai/core").Connector);
// A connector whose seats run no commands: it declares no `commands`.
registry.register({ kind: "connector", name: "launch-plain", requires: ["node"],
  buildLaunch: () => { throw new Error("launch-reads: nothing is launched"); } } as import("@cotal-ai/core").Connector);
let runtimeSpawnCalls = 0;
const neverSpawn = (): never => { runtimeSpawnCalls++; throw new Error("launch-reads: nothing is launched"); };
const delegatedRuntime: import("@cotal-ai/core").RuntimeProvider = { kind: "runtime", name: "launch-delegated", available: () => true,
  create: () => ({ kind: "launch-delegated", streamsTerminal: false, spawn: neverSpawn, spawnDelegated: neverSpawn }) };
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
  const spawnReads = spawnRows.filter((r) => SPAWN_READS.includes(r.command!));
  cell("mint: a spawn view carries status, models, resolve-cwd and ps",
    SPAWN_READS.every((c) => spawnReads.some((r) => r.command === c)), spawnReads);
  cell("mint: each spawn read row is on the pinned instance and no class or scatter route",
    spawnReads.length > 0 && spawnReads.every((r) => r.route === "inst" && r.instanceId === iid), spawnReads);
  cell("mint: a spawn view carries no slots row",
    !spawnRows.some((r) => r.command === "slots"), spawnRows.map((r) => r.command));
  for (const scope of [["run"], [], ["supervise"]])
    cell(`mint: a ${JSON.stringify(scope)} view carries no spawn read and no slots`,
      !minted("manager-caller", scope).some((r) => SPAWN_READS.includes(r.command!) || r.command === "slots"));
  cell("mint: a standing spawn-capable agent credential gains no spawn read",
    !minted("agent", ["spawn", "run"]).some((r) => SPAWN_READS.includes(r.command!)));

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
    "list-dir": await call(c, "list-dir", { path: root }),
    "harness-commands": await call(c, "harness-commands", { agent: "launch-probe", cwd: root }),
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
    cell(`${actor}: list-dir answers`, s["list-dir"].kind === "answered", s["list-dir"]);
    cell(`${actor}: resolve-cwd answers`, s["resolve-cwd"].kind === "answered", s["resolve-cwd"]);
    cell(`${actor}: harness-commands answers`, s["harness-commands"].kind === "answered", s["harness-commands"]);
    cell(`${actor}: list-personas answers`, s["list-personas"].kind === "answered", s["list-personas"]);
    cell(`${actor}: ps answers`, s.ps.kind === "answered", s.ps);
    cell(`${actor}: slots stays broker-refused`, s.slots.kind === "broker-refused", kind(s.slots));
  }
  const l = seen.launcher!;
  cell("launcher: status names this Manager and its available connector",
    l.status.kind === "answered" && l.status.data.instanceId === iid && l.status.data.execution === "runtime"
      && l.status.data.connectors.some((c: any) => c.agent === "launch-probe" && c.state === "available"), l.status);
  cell("launcher: models returns the connector's catalog",
    l.models.kind === "answered" && l.models.data.catalogs.some((c: any) => c.agent === "launch-probe" && c.supported && c.models.some((m: any) => m.id === "probe-model")), l.models);
  cell("launcher: resolve-cwd returns the canonical directory on this host",
    l["resolve-cwd"].kind === "answered" && l["resolve-cwd"].data.cwd === cwd && l["resolve-cwd"].data.host === hostname(), l["resolve-cwd"]);
  cell("launcher: harness-commands lists what the connector offers in the canonical directory, without names a command cannot take",
    l["harness-commands"].kind === "answered" && JSON.stringify(l["harness-commands"].data) === JSON.stringify({
      agent: "launch-probe", cwd, supported: true, commands: [{ name: "probe-cmd", target: "command", description: `listed for ${cwd}`, inputHint: "<topic>" }],
    }), l["harness-commands"]);
  const r = seen.runner!;
  cell("runner: status, models, resolve-cwd, list-dir, harness-commands and slots stay broker-refused",
    [r.status, r.models, r["resolve-cwd"], r["list-dir"], r["harness-commands"], r.slots].every((o) => o.kind === "broker-refused"), [r.status, r.models, r["resolve-cwd"], r["list-dir"], r["harness-commands"], r.slots].map(kind));
  cell("runner: list-personas answers", r["list-personas"].kind === "answered", r["list-personas"]);
  const d = seen.reader!;
  cell("reader: every read but ps stays broker-refused",
    Object.entries(d).every(([command, o]) => command === "ps" || o.kind === "broker-refused"), Object.values(d).map(kind));
  for (const actor of ["runner", "reader"]) {
    const ps = seen[actor]!.ps;
    cell(`${actor}: ps answers, as on every view of a person's own row`, ps.kind === "answered" && Array.isArray(ps.data), ps);
  }
  const o = seen.operator!;
  cell("operator: status, models, resolve-cwd, harness-commands, list-personas and ps answer",
    [o.status, o.models, o["resolve-cwd"], o["list-dir"], o["harness-commands"], o["list-personas"], o.ps].every((x) => x.kind === "answered"), [o.status, o.models, o["resolve-cwd"], o["list-dir"], o["harness-commands"], o["list-personas"], o.ps].map(kind));
  cell("operator: slots reaches the Manager, which owns no slot rows in user mode",
    o.slots.kind === "manager-refused" && o.slots.code === "failed-precondition", o.slots);

  const launcher = opened.launcher!;
  const listingRoot = join(fx.dir, "listing");
  mkdirSync(listingRoot);
  for (const name of ["zebra", "alpha", ".hidden"]) mkdirSync(join(listingRoot, name));
  writeFileSync(join(listingRoot, "file.txt"), "not returned");
  symlinkSync(join(listingRoot, "alpha"), join(listingRoot, "alias"));
  symlinkSync(join(listingRoot, "file.txt"), join(listingRoot, "file-alias"));
  symlinkSync(join(listingRoot, "missing"), join(listingRoot, "broken"));
  const listing = await call(launcher, "list-dir", { path: listingRoot });
  cell("listing: sorted directories only, symlink explicitly marked, hidden omitted",
    listing.kind === "answered" && JSON.stringify(listing.data.directories) === JSON.stringify([
      { name: "alias", symlink: true }, { name: "alpha", symlink: false }, { name: "zebra", symlink: false },
    ]) && !listing.data.truncated && listing.data.path === realpathSync(listingRoot), listing);
  const bounded = await call(launcher, "list-dir", { path: listingRoot, limit: 1 });
  cell("listing: limit bounds sorted result with truncation marker", bounded.kind === "answered" && bounded.data.directories.length === 1 && bounded.data.directories[0].name === "alias" && bounded.data.truncated, bounded);
  const hidden = await call(launcher, "list-dir", { path: listingRoot, includeHidden: true });
  cell("listing: hidden directories are opt-in", hidden.kind === "answered" && hidden.data.directories[0].name === ".hidden", hidden);
  const aliasListing = await call(launcher, "list-dir", { path: join(listingRoot, "alias") });
  cell("listing: navigating a symlink reports canonical target", aliasListing.kind === "answered" && aliasListing.data.path === realpathSync(join(listingRoot, "alpha")), aliasListing);
  const homeListing = await call(launcher, "list-dir", {});
  cell("listing: absent path uses Manager home", homeListing.kind === "answered" && homeListing.data.path === realpathSync(homedir()), homeListing);
  const rootListing = await call(launcher, "list-dir", { path: "/" });
  cell("listing: filesystem root has no parent", rootListing.kind === "answered" && rootListing.data.parent === null && rootListing.data.roots.includes("/"), rootListing);
  for (const path of ["relative", join(listingRoot, "file.txt"), join(listingRoot, "missing")]) {
    const result = await call(launcher, "list-dir", { path });
    cell(`listing: invalid directory ${path} refused`, result.kind === "manager-refused" && result.code === "failed-precondition", result);
  }
  const denied = join(listingRoot, "denied"); mkdirSync(denied); chmodSync(denied, 0);
  try {
    const result = await call(launcher, "list-dir", { path: denied });
    cell("listing: permission denied is a filesystem refusal", result.kind === "manager-refused" && result.code === "failed-precondition" && /EACCES/.test(JSON.stringify(result.error)), result);
  } finally { chmodSync(denied, 0o700); }

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
  const listingRefusals: Outcome[] = [];
  for (const path of [undefined, outside, missing, alias]) {
    const result = await call(delegatedCaller, "list-dir", path === undefined ? {} : { path });
    listingRefusals.push(result);
    cell("delegated listing: refuses before host lookup", result.kind === "manager-refused" && result.code === "failed-precondition" && /starts seats outside this host/.test(JSON.stringify(result.error)), result);
  }
  cell("delegated listing: all paths get identical execution refusal", new Set(listingRefusals.map((r) => JSON.stringify(r))).size === 1, listingRefusals);
  const delegatedCommands = await call(delegatedCaller, "harness-commands", { agent: "launch-probe", cwd: outside });
  cell("delegated harness-commands: refused before host lookup, because the harness runs on the runtime's own host",
    delegatedCommands.kind === "manager-refused" && delegatedCommands.code === "failed-precondition" && /starts seats outside this host/.test(JSON.stringify(delegatedCommands.error)), delegatedCommands);
  const relative = await call(launcher, "harness-commands", { agent: "launch-probe", cwd: "relative/dir" });
  cell("harness-commands: a relative cwd is refused as a spawn's cwd is", relative.kind === "manager-refused" && relative.code === "failed-precondition" && /absolute path/.test(JSON.stringify(relative.error)), relative);
  const unknownAgent = await call(launcher, "harness-commands", { agent: "no-such-harness", cwd: root });
  cell("harness-commands: an unknown harness is not-found", unknownAgent.kind === "manager-refused" && unknownAgent.code === "not-found", unknownAgent);
  const plain = await call(launcher, "harness-commands", { agent: "launch-plain", cwd: root });
  cell("harness-commands: a harness whose seats run no commands answers supported: false with the reason",
    plain.kind === "answered" && JSON.stringify(plain.data) === JSON.stringify({ agent: "launch-plain", cwd, supported: false, reason: "launch-plain seats run no commands or skills" }), plain);
  const projectConfig = join(root, ".cotal", "config.json");
  const operatorConfig = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = join(fx.dir, "launch-reads-operator-config");
  try {
    writeFileSync(projectConfig, JSON.stringify({ spawn: { env: ["COTAL_LAUNCH_READS_PROBE"] } }));
    const args = { agent: "launch-probe", cwd: root };
    const refused = await call(launcher, "harness-commands", args);
    cell("harness-commands: untrusted project config is failed-precondition and not-executed",
      refused.kind === "manager-refused" && refused.code === "failed-precondition"
      && (refused.error as { outcome?: string })?.outcome === "not-executed" && /cotal trust/.test(JSON.stringify(refused.error)), refused);
    trustProject(root);
    const accepted = await call(launcher, "harness-commands", args);
    cell("harness-commands: the same admitted caller receives the catalog after project trust", accepted.kind === "answered" && accepted.data.supported, accepted);
  } finally {
    if (operatorConfig === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = operatorConfig;
    rmSync(projectConfig, { force: true });
  }

  // A spawn's first command is checked against the harness before anything is provisioned.
  const refusedSpawn = async (label: string, args: Record<string, unknown>, reason: RegExp) => {
    const result = await call(launcher, "spawn", { name: "probe", events: false, ...args });
    cell(`first command: ${label}`, result.kind === "manager-refused" && result.code === "failed-precondition" && (result.error as { outcome?: string })?.outcome === "not-executed" && reason.test(JSON.stringify(result.error)), result);
  };
  await refusedSpawn("a target the harness's seats do not run is refused", { firstCommand: { target: "skill", name: "probe-cmd" } }, /launch-probe seats run no skills/);
  await refusedSpawn("a harness whose seats run no commands is refused", { agent: "launch-plain", firstCommand: { target: "command", name: "x" } }, /launch-plain seats run no commands/);
  await refusedSpawn("a spawn that also names a prompt is refused", { prompt: "hello", firstCommand: { target: "command", name: "probe-cmd" } }, /prompt or its first command, not both/);
  const badName = await call(launcher, "spawn", { name: "probe", events: false, firstCommand: { target: "command", name: "has space" } });
  cell("first command: a name the command input cannot carry is refused by the contract", badName.kind === "error" || (badName.kind === "manager-refused" && badName.code === "bad-request"), badName);

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
