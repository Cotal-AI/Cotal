/** Trusted-host interactive default selection over a real broker, exchange and empty Manager. */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:http";
import { connect as tcpConnect, type AddressInfo } from "node:net";
import { chmodSync, existsSync, mkdtempSync, readFileSync, readlinkSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPair, exportJWK, SignJWT, decodeJwt } from "jose";
import { connect } from "@nats-io/transport-node";
import { Kvm } from "@nats-io/kv";
import { createSpaceAuth, epAuthBucket, isReachable, mintCreds, mintLifecycleUid, newIdentity,
  permissionsFor, recordSpecKey, recordStatusKey, recordsBucket, RECORD_KINDS, remoteManagerActors,
  serverConfig, setupSpaceStreams, standaloneConnectOpts } from "@cotal-ai/core";
import { authDir, assertUserAuthInfo, loadManagerInstanceIdentity, recordMesh, resolveControlTarget, saveSpaceAuth, spaceSegment,
  userAuthStateDir, workspaceSecretStore } from "@cotal-ai/workspace";
import { cotalAuthProvider, deriveOwnerForIdpSubject, grantActor, grantManagedActor, loadAuthServiceInfo,
  loadOwnerSecret, newActorToken, runAuthService, saveIdpSession } from "@cotal-ai/auth";
import { Manager } from "@cotal-ai/manager";
import { formatSentinel, killAndAwaitExit, SMOKE_BROKER_TOKEN, teardownOnSignal } from "@cotal-ai/smoke-kit";
import { askManager } from "../../cli/src/lib/control.js";
import { pickFreePort } from "./_free-port.js";

if (process.argv[2] === "auth-service") {
  const primary = process.argv[3] === "primary";
  await runAuthService({ values: { space: process.env.FIXTURE_SPACE!, server: process.env.FIXTURE_SERVER!, port: "0" }, positionals: [], raw: [] }, undefined,
    primary ? { interactiveManagerSelection: "local-primary" } : {});
  process.exit(0);
}

// Manager diagnostics are not the oracle and may contain process activity. Emit only named checks.
console.log = () => {};
console.error = () => {};
const root = mkdtempSync(join(tmpdir(), `${SMOKE_BROKER_TOKEN}interactive-primary-`));
const home = join(root, "home");
process.env.COTAL_HOME = home;
const space = `primary-${mintLifecycleUid()}`, port = await pickFreePort(), server = `nats://127.0.0.1:${port}`;
const dir = userAuthStateDir(root, space), store = workspaceSecretStore(root);
const checks: { name: string; ok: boolean }[] = [];
const check = (name: string, ok: boolean) => { checks.push({ name, ok }); process.stdout.write(`${ok ? "PASS" : "FAIL"} ${name}\n`); };
const pause = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
const identity = (pid: number) => ({ pid, cwd: readlinkSync(`/proc/${pid}/cwd`), start: readFileSync(`/proc/${pid}/stat`, "utf8").split(") ").pop()!.split(" ")[19] });
let broker: ChildProcess | undefined, child: ChildProcess | undefined, manager: Manager | undefined;
let managerClosed = true;
let issuerPort = 0, exchangePort = 0, stage = "fixture";
const children: ReturnType<typeof identity>[] = [];
let releaseBroker: (() => void) | undefined;
const { publicKey, privateKey } = await generateKeyPair("EdDSA");
const jwk = { ...await exportJWK(publicKey), kid: "fixture" };
let humanProof = "";
const idp = createServer((req, res) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify(req.url === "/api/auth/jwks" ? { keys: [jwk] } : { token: humanProof })); });
let info: NonNullable<ReturnType<typeof loadAuthServiceInfo>>;
const start = async (mode: "legacy" | "primary") => {
  if (child) await killAndAwaitExit(child);
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith("COTAL_")) delete env[k];
  Object.assign(env, { COTAL_HOME: home, FIXTURE_SPACE: space, FIXTURE_SERVER: server });
  child = spawn(process.execPath, ["--import", import.meta.resolve("tsx"), import.meta.filename, "auth-service", mode], { cwd: root, env, stdio: "ignore" });
  children.push(identity(child.pid!));
  for (let i = 0; i < 150; i++) {
    const found = loadAuthServiceInfo(dir);
    if (found) { try { if ((await fetch(found.url + "/health")).ok) { info = found; exchangePort = Number(new URL(info.url).port); return; } } catch { /* not bound */ } }
    if (child.exitCode !== null || child.signalCode !== null) throw new Error("auth child exited");
    await pause(100);
  }
  throw new Error("auth child readiness deadline");
};
const gone = async (p: number) => await new Promise<boolean>(done => {
  const s = tcpConnect({ host: "127.0.0.1", port: p }).once("connect", () => { s.destroy(); done(false); }).once("error", () => done(true));
  s.setTimeout(500, () => { s.destroy(); done(false); });
});
try {
  await new Promise<void>(r => idp.listen(0, "127.0.0.1", r));
  issuerPort = (idp.address() as AddressInfo).port;
  const origin = `http://127.0.0.1:${issuerPort}`;
  const auth = await createSpaceAuth(space); saveSpaceAuth(authDir(root), auth);
  const prepared = await cotalAuthProvider.prepareServer({ store, space, operatorSeed: auth.operator.seed,
    account: { pub: auth.account.pub, signingSeed: auth.account.signingSeed }, dir, idpUrl: origin + "/api/auth" });
  writeFileSync(join(root, "server.conf"), serverConfig(auth, [auth], { transport: { kind: "plaintext" }, port,
    storeDir: join(root, "js"), extraAccounts: prepared.extraAccounts }), { mode: 0o600 });
  broker = spawn("nats-server", ["-c", join(root, "server.conf")], { cwd: root, stdio: "ignore" });
  children.push(identity(broker.pid!)); releaseBroker = teardownOnSignal(broker);
  for (let i = 0; i < 100 && !(await isReachable(server)); i++) await pause(100);
  await setupSpaceStreams({ servers: server, space, creds: await mintCreds(auth, newIdentity(), "provisioner") });
  recordMesh({ space, server, root, mode: "user", userAuth: assertUserAuthInfo(prepared.publicAuth), ts: new Date().toISOString() });
  await start("legacy");
  stage = "real-manager";
  manager = new Manager({ space, servers: server, workspaceRoot: root, runtime: "pty" });
  await manager.start();
  const local = loadManagerInstanceIdentity(root, space)!;
  check("native Manager has persisted local identity", !!local?.instanceId);
  const owner = deriveOwnerForIdpSubject((await loadOwnerSecret(store, space))!, origin, "fixture-human");
  const scope = ["admin", "spawn", "run", "supervise"];
  grantActor(dir, { owner, actor: "cli", scope, allowSubscribe: [], allowPublish: [], label: "fixture" });
  grantActor(dir, { owner, actor: "reader", scope: ["spawn", "run"], allowSubscribe: [], allowPublish: [], label: "fixture reader" });
  const secret = newActorToken();
  // This managed-secret specimen has no Manager custody.
  grantManagedActor(dir, { custody: { kind: "foreground" }, owner, actor: "child", scope: ["spawn", "run"], allowSubscribe: [], allowPublish: [],
    parent: `${owner}.cli`, tokenHash: secret.tokenHash, lifecycleUid: mintLifecycleUid() });
  const token = await new SignJWT({}).setProtectedHeader({ alg: "EdDSA", kid: "fixture" }).setIssuer(origin).setAudience(origin)
    .setSubject("fixture-human").setIssuedAt().setExpirationTime("10m").sign(privateKey);
  humanProof = token;
  saveIdpSession(home, origin + "/api/auth", { token: "private-fixture-session", expiresAt: Math.floor(Date.now() / 1000) + 600, sub: "fixture-human" });
  const exchange = async (pin?: string, agent = false, actor = "cli") => {
    const res = await fetch(info.url + "/exchange", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${info.cap}` },
      body: JSON.stringify({ ...(agent ? { owner, actor: "child", actorToken: secret.actorToken } : { actor, idpToken: token }), view: "manager-caller", ...(pin !== undefined ? { managerInstanceId: pin } : {}) }) });
    return { status: res.status, body: await res.json() as { token?: string; managerInstanceId?: string; error?: string } };
  };
  const put = async (instance: string, gateOwner: string, state: "open" | "frozen" = "open", registered = true, stale = false) => {
    const nc = await connect({ servers: server, ...standaloneConnectOpts({ creds: await mintCreds(auth, newIdentity(), "endpoint-serve-executor", { endpointServeExecutor: { endpoint: "manager", instanceId: instance } }), tls: false }) });
    try {
      const kvm = new Kvm(nc), records = await kvm.open(recordsBucket(space)), gates = await kvm.open(epAuthBucket(space));
      let revision = 1;
      if (registered) {
        revision = await records.put(recordSpecKey(RECORD_KINDS.svc, ["manager", instance]), JSON.stringify({ endpoint: "manager", owner: gateOwner, clusterDigests: [`sha256:${"a".repeat(64)}`], protocol: { v: 1 } }));
        await records.put(recordStatusKey(RECORD_KINDS.svc, ["manager", instance]), JSON.stringify({ epoch: stale ? 2 : 1, state: "ready", observedSpecRevision: revision }));
      }
      await gates.put(`epgate.manager.${instance}`, JSON.stringify({ state, generation: 1, processEpoch: 1, registrationRevision: revision,
        nameAuthorityRevision: 0, principal: `${gateOwner}.${remoteManagerActors(instance).serve}`,
        ...(state === "open" ? {} : { op: { opId: mintLifecycleUid(), kind: "takeover" } }) }));
    } finally { await nc.drain(); }
  };
  const dead = mintLifecycleUid(); await put(dead, owner, "open", false);
  stage = "baseline";
  const legacy = await exchange();
  check("absent option preserves dead-remote refusal", legacy.status === 401 && /none live/.test(legacy.body.error ?? ""));
  const pinned = await exchange(local.instanceId);
  check("explicit genuine local pin still succeeds", pinned.status === 200 && pinned.body.managerInstanceId === local.instanceId);
  const nativePs = async (bearer: string) => {
    const claims = decodeJwt(bearer) as { sub: string; act: { actor: string; lifecycleUid: string; managerInstanceId: string } };
    const callout = await import("@cotal-ai/auth").then(m => m.loadCalloutAuth(store, space));
    return askManager(space, server, "ps", undefined, { bearer, sentinelCreds: callout!.sentinelCreds,
      epCaller: { owner: claims.sub, actor: claims.act.actor, uid: claims.act.lifecycleUid }, managerInstanceId: claims.act.managerInstanceId }, "owner");
  };
  const oldPs = await nativePs(pinned.body.token!);
  check("baseline explicit pin returns real native empty managed ps", oldPs.ok === true && Array.isArray(oldPs.data) && oldPs.data.length === 0);
  await start("primary"); stage = "primary";
  const primary = await exchange();
  check("opted-in interactive local primary ignores dead remote history", primary.status === 200 && primary.body.managerInstanceId === local.instanceId);
  if (primary.status !== 200) throw new Error("primary correctness assertion failed");
  const primaryPs = await nativePs(primary.body.token!);
  check("primary selection returns real native empty managed ps", primaryPs.ok === true && Array.isArray(primaryPs.data) && primaryPs.data.length === 0);
  const liveRemote = mintLifecycleUid(); await put(liveRemote, owner);
  check("interactive policy remains local even with a live owned remote", (await exchange()).body.managerInstanceId === local.instanceId);
  for (const profile of ["control-caller-privileged", "control-caller-admin"] as const) {
    const resolved = await resolveControlTarget({ space }, profile, undefined, { onRefusal: "throw" });
    check(`${profile} interactive control consumers share local-primary routing`, resolved.auth.managerInstanceId === local.instanceId);
  }
  process.env.COTAL_MANAGER_INSTANCE = liveRemote; process.env.COTAL_SPACE = space;
  try {
    const launched = await resolveControlTarget({ space }, "control-caller-privileged", undefined, { onRefusal: "throw" });
    check("native launching-manager binding wins over human primary policy", launched.auth.managerInstanceId === liveRemote);
    const explicit = await resolveControlTarget({ space }, "control-caller-admin", local.instanceId, { onRefusal: "throw" });
    check("explicit client pin still wins over launching-manager binding", explicit.auth.managerInstanceId === local.instanceId);
  } finally { delete process.env.COTAL_MANAGER_INSTANCE; delete process.env.COTAL_SPACE; }
  check("explicit valid owned remote wins over local primary", (await exchange(liveRemote)).body.managerInstanceId === liveRemote);
  check("managed secret default selection stays remote", (await exchange(undefined, true)).body.managerInstanceId === liveRemote);
  const bound = await exchange(liveRemote, true);
  check("managed launch-bound explicit selection stays remote", bound.status === 200 && decodeJwt(bound.body.token!).act !== undefined && bound.body.managerInstanceId === liveRemote);
  for (const [name, id, gateOwner, state, stale] of [
    ["foreign", mintLifecycleUid(), `u_${"f".repeat(26)}`, "open", false],
    ["closed", mintLifecycleUid(), owner, "frozen", false],
    ["stale", mintLifecycleUid(), owner, "open", true],
  ] as const) {
    await put(id, gateOwner, state, true, stale);
    check(`explicit ${name} pin refuses without local substitution`, (await exchange(id)).status === 401);
  }
  check("explicit missing pin refuses without local substitution", (await exchange(mintLifecycleUid())).status === 401);
  const reader = await exchange(undefined, false, "reader");
  const readerClaims = decodeJwt(reader.body.token!) as { act: { scope: string[]; lifecycleUid: string } };
  check("local primary does not add admin to spawn/run scope", reader.status === 200 && JSON.stringify(readerClaims.act.scope) === JSON.stringify(["spawn", "run"]));
  const perms = permissionsFor("manager-caller", space, { owner, actor: "reader", connId: newIdentity().id, lifecycleUid: readerClaims.act.lifecycleUid },
    { capabilities: ["spawn", "run"], managerInstanceId: local.instanceId, lifecycleUid: readerClaims.act.lifecycleUid }) as { pub: { allow: string[] } };
  check("shipped policy still grants no ps or slots to spawn/run", !perms.pub.allow.some(row => /\.(ps|slots)\./.test(row)));
  stage = "local-refusal";
  const identityPath = join(root, ".cotal", spaceSegment(space), "manager-instance.json");
  renameSync(identityPath, identityPath + ".held");
  try { check("absent local identity refuses despite live owned remote", (await exchange()).status === 401); }
  finally { renameSync(identityPath + ".held", identityPath); }
  chmodSync(identityPath, 0o000);
  try { check("unreadable local identity refuses despite live owned remote", (await exchange()).status === 401); }
  finally { chmodSync(identityPath, 0o600); }
  // Fixture-only state transitions exercise native gate checks, never code mutations.
  const nc = await connect({ servers: server, ...standaloneConnectOpts({ creds: await mintCreds(auth, newIdentity(), "endpoint-serve-executor", { endpointServeExecutor: { endpoint: "manager", instanceId: local.instanceId } }), tls: false }) });
  try {
    const kvm = new Kvm(nc), gates = await kvm.open(epAuthBucket(space)), records = await kvm.open(recordsBucket(space));
    const key = `epgate.manager.${local.instanceId}`, original = (await gates.get(key))!;
    const row = JSON.parse(new TextDecoder().decode(original.value));
    for (const [name, changed] of [["closed", { ...row, state: "frozen", op: { opId: mintLifecycleUid(), kind: "takeover" } }],
      ["stale", { ...row, processEpoch: row.processEpoch + 1 }]] as const) {
      await gates.put(key, JSON.stringify(changed));
      check(`${name} local refuses despite live owned remote`, (await exchange()).status === 401);
      await gates.put(key, original.value);
    }
    const spec = await records.get(recordSpecKey(RECORD_KINDS.svc, ["manager", local.instanceId]));
    check("selected local gate is attributed to persisted serve principal", row.principal === `local.${local.serveIdentity.id}`);
    check("selected local gate/status epoch and spec revision agree", !!spec && JSON.parse(new TextDecoder().decode((await records.get(recordStatusKey(RECORD_KINDS.svc, ["manager", local.instanceId])))!.value)).epoch === row.processEpoch && spec.revision === row.registrationRevision);
  } finally { await nc.drain(); }
} catch (error) {
  check(`fixture completed stage ${stage} (${error instanceof Error ? error.name : "unknown"})`, false);
} finally {
  if (manager) await manager.stop({ withAgents: true }).catch(() => { managerClosed = false; check("native Manager teardown", false); });
  if (child) await killAndAwaitExit(child);
  if (broker) { await killAndAwaitExit(broker); releaseBroker?.(); }
  await new Promise<void>(r => idp.close(() => r()));
  check("owned child PID/start/cwd generations exited", children.every(x => { try { const now = identity(x.pid); return now.start !== x.start || now.cwd !== x.cwd; } catch (error) { return ["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code ?? ""); } }));
  check("owned broker and listener ports closed", (await Promise.all([port, issuerPort, exchangePort].filter(Boolean).map(gone))).every(Boolean));
  if (checks.every(x => x.ok)) assert.equal(checks.length, 28, "all named selection, scope and cleanup cells ran");
  if (managerClosed && checks.slice(-2).every(x => x.ok) && existsSync(root)) rmSync(root, { recursive: true });
  const failed = checks.filter(x => !x.ok).length;
  process.stdout.write(JSON.stringify({ checks: checks.length, passed: checks.length - failed, failed }) + "\n");
  process.stdout.write(formatSentinel({ passed: checks.length - failed, failed }) + "\n");
  if (failed) process.exitCode = 1;
}
