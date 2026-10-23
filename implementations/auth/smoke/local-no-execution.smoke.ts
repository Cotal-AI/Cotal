/** Genuine local nonexecution through public Manager/CLI composition and native auth/control. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:http";
import { connect as tcpConnect, type AddressInfo } from "node:net";
import { chmodSync, existsSync, mkdtempSync, readFileSync, readlinkSync, renameSync, rmSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { jetstreamManager } from "@nats-io/jetstream";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { generateKeyPair, exportJWK, SignJWT, decodeJwt } from "jose";
import { connect } from "@nats-io/transport-node";
import { Kvm } from "@nats-io/kv";
import { createSpaceAuth, epAuthBucket, isReachable, mintCreds, mintLifecycleUid, newIdentity,
  permissionsFor, recordSpecKey, recordStatusKey, recordsBucket, RECORD_KINDS, remoteManagerActors,
  serverConfig, setupSpaceStreams, standaloneConnectOpts, registry, resolveService, issuedUserCaller, invokeCommand,
  recordsKvStreamName, admissionBucket, EP_TARGET_UNMAPPED, LEASE_TTL_MS, EpEnvelopeError, type Connector, type RuntimeProvider, type EpVerbTarget } from "@cotal-ai/core";
import { authDir, assertUserAuthInfo, loadManagerInstanceIdentity, recordMesh, resolveControlTarget, saveSpaceAuth, spaceSegment,
  userAuthStateDir, workspaceSecretStore, extensionsManifestPath, saveExtensionsManifest } from "@cotal-ai/workspace";
import { cotalAuthProvider, deriveOwnerForIdpSubject, grantActor, grantManagedActor, loadAuthServiceInfo,
  loadOwnerSecret, newActorToken, runAuthService, saveIdpSession } from "@cotal-ai/auth";
import { Manager, type ManagerStatus } from "@cotal-ai/manager";
import { formatSentinel, killAndAwaitExit, SMOKE_BROKER_TOKEN, teardownOnSignal } from "@cotal-ai/smoke-kit";
import { askManager } from "../../cli/src/lib/control.js";
import { writeStamp } from "../../cli/src/seed/authority.js";
import { pickFreePort } from "./_free-port.js";
import { bootDeliveryDaemon } from "../../manager/smoke/_boot-delivery.js";

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
// The CLI children inherit this environment, so they must see only the suite's own COTAL_ keys.
for (const key of Object.keys(process.env)) if (key.startsWith("COTAL_")) delete process.env[key];
process.env.COTAL_HOME = home;
const configHome = join(root, "config");
mkdirSync(configHome);
process.env.XDG_CONFIG_HOME = configHome;
const configState = () => JSON.stringify(readdirSync(configHome, { recursive: true, withFileTypes: true })
  .map(entry => { const path = join(entry.parentPath, entry.name); return [path.slice(configHome.length), entry.isDirectory() ? "dir" : createHash("sha256").update(readFileSync(path)).digest("hex")]; })
  .sort((a, b) => String(a[0]).localeCompare(String(b[0]))));
const space = `primary-${mintLifecycleUid()}`, port = await pickFreePort(), server = `nats://127.0.0.1:${port}`;
const dir = userAuthStateDir(root, space), store = workspaceSecretStore(root);
const checks: { name: string; ok: boolean }[] = [];
const check = (name: string, ok: boolean) => { checks.push({ name, ok }); process.stdout.write(`${ok ? "PASS" : "FAIL"} ${name}\n`); };
const pause = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
const identity = (pid: number) => ({ pid, cwd: readlinkSync(`/proc/${pid}/cwd`), start: readFileSync(`/proc/${pid}/stat`, "utf8").split(") ").pop()!.split(" ")[19] });
let broker: ChildProcess | undefined, child: ChildProcess | undefined, cli: ChildProcess | undefined, manager: Manager | undefined;
let connectorBuilds = 0, runtimeResolutions = 0, harnessReads = 0, modelReads = 0, modelCalls = 0;
const buildLaunch = () => { connectorBuilds++; return { command: process.execPath, args: ["-e", "process.exit(0)"], env: {} }; };
const connector: Connector = { kind: "connector", name: "local-none-witness", get requires() { harnessReads++; return ["node"]; },
  get listModels() { modelReads++; return async () => { modelCalls++; return { models: [] }; }; }, buildLaunch };
const runtime: RuntimeProvider = { kind: "runtime", name: "local-none-witness", available: () => { runtimeResolutions++; return true; }, create: () => { runtimeResolutions++; throw new Error("inert runtime witness must never be resolved"); } };
registry.register(connector); registry.register(runtime);
const ports: number[] = [];
let managerClosed = true;
let delivery: Awaited<ReturnType<typeof bootDeliveryDaemon>> | undefined;
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
    if (found) { try { if ((await fetch(found.url + "/health")).ok) { info = found; exchangePort = Number(new URL(info.url).port); ports.push(exchangePort); return; } } catch { /* not bound */ } }
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
  assert.ok(store.identity);
  delivery = await bootDeliveryDaemon({ space, servers: server, auth, reloadStoreIdentity: store.identity });
  check("fresh real auth fixture answers before Manager construction", !!loadAuthServiceInfo(dir)?.url);
  stage = "expected-correct-local-none";
  let refusal = "";
  try { manager = new Manager({ space, servers: server, workspaceRoot: root, execution: "none" }); }
  catch (error) { if (error instanceof Error && error.message.startsWith("execution: none")) refusal = error.message; }
  check("expected-correct genuine auth-local NONE constructs without a Runtime", !!manager && manager.execution === "none" && manager.runtimeKind === "none" && !Object.hasOwn(manager, "runtime"));
  if (!manager) { process.stdout.write(JSON.stringify({ observedRefusal: refusal }) + "\n"); throw new Error("expected-correct genuine local NONE construction refused"); }
  await manager.start();
  ports.push(Number(new URL(manager.consoleUrl).port));
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
    const body = await res.json() as { token?: string; error?: string };
    return { status: res.status, body, instance: body.token === undefined ? undefined : (decodeJwt(body.token).act as { managerInstanceId?: string }).managerInstanceId };
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
  check("explicit genuine local pin still succeeds", pinned.status === 200 && pinned.instance === local.instanceId);
  const nativePs = async (bearer: string, op = "ps") => {
    const claims = decodeJwt(bearer) as { sub: string; act: { actor: string; lifecycleUid: string; managerInstanceId: string } };
    const callout = await import("@cotal-ai/auth").then(m => m.loadCalloutAuth(store, space));
    return askManager(space, server, op, undefined, { bearer, sentinelCreds: callout!.sentinelCreds,
      epCaller: { owner: claims.sub, actor: claims.act.actor, uid: claims.act.lifecycleUid }, managerInstanceId: claims.act.managerInstanceId }, "owner");
  };
  const oldPs = await nativePs(pinned.body.token!);
  check("baseline explicit pin returns real native empty managed ps", oldPs.ok === true && Array.isArray(oldPs.data) && oldPs.data.length === 0);
  await start("primary"); stage = "primary";
  const primary = await exchange();
  check("opted-in interactive local primary ignores dead remote history", primary.status === 200 && primary.instance === local.instanceId);
  if (primary.status !== 200) throw new Error("primary correctness assertion failed");
  const primaryPs = await nativePs(primary.body.token!);
  check("primary selection returns real native empty managed ps", primaryPs.ok === true && Array.isArray(primaryPs.data) && primaryPs.data.length === 0);
  stage = "native-nonexecution";
  const callout = await import("@cotal-ai/auth").then(m => m.loadCalloutAuth(store, space));
  const connectOptions = standaloneConnectOpts({ bearer: primary.body.token!, sentinelCreds: callout!.sentinelCreds, tls: false });
  const callerNc = await connect({ servers: server, ...connectOptions });
  const witnessNc = await connect({ servers: server, ...standaloneConnectOpts({ creds: await mintCreds(auth, newIdentity(), "provisioner"), tls: false }) });
  try {
    const claims = decodeJwt(primary.body.token!) as { sub: string; act: { actor: string; lifecycleUid: string } };
    const caller = await issuedUserCaller(callerNc, space, String(connectOptions.name), { owner: claims.sub, actor: claims.act.actor, uid: claims.act.lifecycleUid });
    const selected = await resolveService(callerNc, space, "manager", caller, { instanceId: local.instanceId });
    const invoke = async (command: string, args?: Record<string, unknown>, target?: EpVerbTarget) => (await invokeCommand(callerNc, space, selected, command, args, { ...(target ? { target } : {}) })).reply;
    const status = await invoke("status");
    assert.ok(status.ok);
    const data = status.data as ManagerStatus;
    check("native local NONE status reports no runtime custody run terminal or class spawn", data.instanceId === local.instanceId && data.execution === "none" && data.runtime === "none" && data.custody === "none" && !data.runHosting && !data.terminalSessions && !data.classSpawn && data.agentCount === 0 && data.connectors.length === 0);
    mkdirSync(join(root, ".cotal", "agents"), { recursive: true });
    writeFileSync(join(root, ".cotal", "agents", "witness.md"), "---\nname: witness\nagent: local-none-witness\n---\n", { mode: 0o600 });
    const files = () => JSON.stringify(readdirSync(join(root, ".cotal"), { recursive: true, withFileTypes: true })
      .map(entry => { const path = join(entry.parentPath, entry.name); return [path, entry.isDirectory() ? "dir" : createHash("sha256").update(readFileSync(path)).digest("hex")]; })
      .sort((a, b) => String(a[0]).localeCompare(String(b[0]))));
    const jsm = await jetstreamManager(witnessNc);
    const resources = async () => JSON.stringify(await Promise.all([recordsKvStreamName(space), `KV_${admissionBucket(space)}`].map(async name => { const row = await jsm.streams.info(name); return { name, messages: row.state.messages, consumers: row.state.consumer_count }; })));
    const beforeFiles = files(), beforeResources = await resources();
    const target: EpVerbTarget = { mode: "owner", owner: caller.owner, actor: caller.actor, lifecycleUid: caller.uid };
    const requests: Array<[string, Record<string, unknown> | undefined, EpVerbTarget?]> = [
      ["spawn", { name: "witness", agent: "local-none-witness" }],
      ["launch", { runId: "owned", name: "witness", spec: { apiVersion: "cotal-launch/v1", space, runId: "owned", agents: [{ name: "witness", agent: "local-none-witness", subscribe: [], allowSubscribe: [], allowPublish: [], hash: "owned" }] } }],
      ["resolve-cwd", { cwd: root }], ["resolve-agent", { name: "witness" }],
      ["run-start", { source: "log(1);" }], ["run-resume", { runId: "owned" }],
      ["run-answer", { runId: "owned", stepKey: "pause", value: "owned" }, { mode: "self" }],
      ["run-answer", { runId: "owned", stepKey: "pause", value: "owned", amend: true }, { mode: "self" }],
      ["attach", undefined, target], ["input", { text: "owned", enter: false }, target],
      ["turn", { payload: "owned", deadlineMs: 1000 }, target],
    ];
    for (const [command, args, target] of requests) {
      const reply = await invoke(command, args, target);
      if (target && "owner" in target) {
        // NONE owns no managed-seat mapping. This proves native target-currency refusal, not
        // execution admission with an invented valid child. The execution cells above are untargeted.
        check(`native ${command} without a managed mapping refuses before handler effects`, !reply.ok && reply.error?.code === "expired" && !!reply.error.details?.some(detail => typeof detail === "object" && detail !== null && "kind" in detail && detail.kind === EP_TARGET_UNMAPPED));
      } else {
        check(`valid native ${command}${args?.amend ? " amendment" : ""} refuses at NONE before execution`, !reply.ok && reply.error?.code === "unimplemented" && /execution: none/.test(reply.error.message));
      }
    }
    const emptyInventory = { version: "cotal-manager-resume/v2", space, createdAt: new Date().toISOString(), agents: [] };
    const writes: Array<[string, Record<string, unknown>, EpVerbTarget?]> = [
      ["models", { agent: "local-none-witness", refresh: true }], ["models", {}],
      ["define-persona", { name: "owned_persona", persona: "Owned inert persona", agent: "local-none-witness" }],
      ["purge", { includeDms: false }],
      ["transcript-receive", { sha256: "a".repeat(64), size: 1, source: "owned", sourceHost: "owned" }],
      ["resume-preserved", { attemptId: "owned", inventory: emptyInventory }],
      ["commit-resume", { attemptId: "owned" }], ["finalize-resume", { attemptId: "owned", durableCommitToken: "owned" }],
      ["prepare-preservation", { attemptId: "owned" }], ["commit-preservation", { attemptId: "owned" }], ["abort-preservation", { attemptId: "owned" }],
      ["cancel", { goalId: "owned" }], ["turn-yield", { goalId: "owned", status: "done" }, { mode: "self" }],
      ["stop", { graceful: true }, { mode: "self" }],
    ];
    for (const [command, args, target] of writes) {
      stage = `native-${command}`;
      if (command === "cancel") {
        // The human manager-caller has no cancel grant. This is broker admission, not NONE-handler proof.
        let refused = false;
        try { await invoke(command, args, target); }
        catch (error) {
          if (!(error instanceof EpEnvelopeError) || error.code !== "permission-denied" || error.outcome !== "not-executed" || !error.message.includes("REFUSED BY THE BROKER")) throw error;
          refused = true;
        }
        check("human cancel is broker-refused outside its manager-caller grant, not a NONE-handler cell", refused);
        continue;
      }
      const reply = await invoke(command, args, target);
      check(`native ${command}${command === "models" && args.agent ? " named" : ""} refuses before caller-driven effects`, !reply.ok && reply.error?.code === "unimplemented" && /execution: none/.test(reply.error.message));
    }
    stage = "native-nonexecution";
    check("NONE constructs no transcript receiver or model adapter", Reflect.get(manager, "transcripts") === undefined && harnessReads === 0 && modelReads === 0 && modelCalls === 0);
    for (const [label, call] of [["prepare", () => manager!.preparePreservation("owned")], ["commit", () => manager!.commitPreservation("owned")], ["abort", () => manager!.abortPreservation("owned")]] as const) {
      let refused = false;
      try { await call(); } catch (error) { refused = error instanceof Error && /execution: none/.test(error.message); }
      check(`public preservation ${label} refuses before control-state changes`, refused);
    }
    const emptyResume = await manager.resumePreserved({ ...emptyInventory, version: "cotal-manager-resume/v2" });
    check("public empty resume refuses before control-state changes", !emptyResume.ok && /execution: none/.test(emptyResume.error ?? ""));
    for (const [label, invoke] of [["public startAgent", () => manager!.startAgent({ name: "witness" })], ["public startByName", () => manager!.startByName("witness")]] as const) {
      const reply = await invoke(); check(`${label} refuses before connector or persona effects`, !reply.ok && /execution: none/.test(reply.error!));
    }
    let adoptionRefused = false;
    try { manager.adoptRuntimeHandle({ kind: "pty", id: "owned" }); } catch (error) { adoptionRefused = error instanceof Error && /execution: none/.test(error.message); }
    check("public runtime adoption refuses without resolution", adoptionRefused);
    const inventory: Parameters<Manager["resumePreserved"]>[0] = { version: "cotal-manager-resume/v2", space, createdAt: new Date().toISOString(), agents: [{} as never] };
    const resumed = await manager.resumePreserved(inventory);
    check("public retained workload inventory refuses before recovery", !resumed.ok && /execution: none/.test(resumed.error!));
    check("native and public denials write no launch files goals admissions or consumers", files() === beforeFiles && await resources() === beforeResources && connectorBuilds === 0 && runtimeResolutions === 0);
    let mixedRefused = false;
    try { new Manager({ space, workspaceRoot: root, execution: "none", runtime: "local-none-witness" }); } catch (error) { mixedRefused = error instanceof Error && /no runtime option/.test(error.message); }
    check("NONE plus a valid registered Runtime refuses before resolving it", mixedRefused && runtimeResolutions === 0);
    buildLaunch(); runtime.available(); void connector.requires; await connector.listModels!({ refresh: true });
    check("owned inert connector model and Runtime counters have positive controls", connectorBuilds === 1 && runtimeResolutions === 1 && harnessReads === 1 && modelReads === 1 && modelCalls === 1);
    const beforeEpoch = selected.responder.epoch;
    await manager.stop(); manager = undefined;
    stage = "public-cli-none";
    const consolePort = await pickFreePort(); ports.push(consolePort);
    const beforeConfig = configState();
    const cliEnv: NodeJS.ProcessEnv = { ...process.env, COTAL_ROOT: root };
    delete cliEnv.COTAL_SKIP_CONNECTOR_SEED;
    cli = spawn(process.execPath, [fileURLToPath(new URL("../../../bin/dist/cotal.js", import.meta.url)), "supervise", "--execution", "none", "--space", space, "--server", server, "--console-port", String(consolePort)], { cwd: root, env: cliEnv, stdio: ["ignore", "pipe", "pipe"] });
    let cliDiagnostic = "", cliReady = false;
    cli.stdout!.on("data", (value: Buffer) => { if (value.toString().includes("manager")) cliReady = true; });
    cli.stderr!.on("data", (value: Buffer) => { const text = value.toString().replace(/\x1b\[[0-9;]*m/g, ""); const line = text.split("\n").find(line => line.includes("✗")); if (line) cliDiagnostic = line.replace(/[A-Za-z0-9_-]{20,}/g, "<id>").slice(0, 300); });
    children.push(identity(cli.pid!));
    let successor = false, observedEpoch: number | undefined;
    let cliStatus: Awaited<ReturnType<typeof nativePs>> | undefined, cliPs: Awaited<ReturnType<typeof nativePs>> | undefined;
    const records = await new Kvm(witnessNc).open(recordsBucket(space));
    const cliDeadline = Date.now() + 3 * LEASE_TTL_MS;
    while (Date.now() < cliDeadline) {
      if (cli.exitCode !== null || cli.signalCode !== null) break;
      try {
        const row = await records.get(recordStatusKey(RECORD_KINDS.svc, ["manager", local.instanceId]));
        observedEpoch = row ? (JSON.parse(new TextDecoder().decode(row.value)) as { epoch: number }).epoch : undefined;
        if (observedEpoch !== undefined && observedEpoch > beforeEpoch) {
          const fresh = await exchange(local.instanceId);
          if (fresh.status === 200) {
            cliStatus = await nativePs(fresh.body.token!, "managerStatus"); cliPs = await nativePs(fresh.body.token!);
            if (cliStatus.ok && cliPs.ok) { successor = true; break; }
          }
        }
      } catch { /* successor not bound */ }
      await pause(100);
    }
    check("real public supervise NONE starts without connector seeding or remote authority", successor && configState() === beforeConfig && !existsSync(extensionsManifestPath()) && !existsSync(join(configHome, "cotal", "seed")));
    if (!successor) { process.stdout.write(JSON.stringify({ diagnostic: "public-cli-none", exit: cli.exitCode, signal: cli.signalCode, readyOutput: cliReady, beforeEpoch, observedEpoch, reason: cliDiagnostic }) + "\n"); throw new Error("public supervise NONE did not bind"); }
    check("public CLI restart retains genuine instance advances epoch and reports NONE", cliStatus!.ok && (cliStatus!.data as ManagerStatus).execution === "none" && workspaceIdentityMatches());
    check("real public CLI NONE serves native empty ps", cliPs!.ok && Array.isArray(cliPs!.data) && cliPs!.data.length === 0);
    await killAndAwaitExit(cli); cli = undefined;
    const beforeWriters = configState();
    saveExtensionsManifest({ extensions: [] });
    check("real manifest writer changes the whole config witness at its native path", configState() !== beforeWriters && existsSync(join(configHome, "cotal", "extensions", "extensions.json")));
    const beforeStamp = configState();
    writeStamp("owned-positive-control", "owned-smoke");
    check("real seed stamp writer changes the whole config witness at its native path", configState() !== beforeStamp && existsSync(join(configHome, "cotal", "seed", "stamp.json")));
    // These direct writer controls are not an ordinary completed connector seed operation.
    function workspaceIdentityMatches() { return loadManagerInstanceIdentity(root, space)?.instanceId === local.instanceId; }
    manager = new Manager({ space, servers: server, workspaceRoot: root, execution: "none" });
    await manager.start(); ports.push(Number(new URL(manager.consoleUrl).port));
  } finally { await callerNc.close(); await witnessNc.close(); }
  const liveRemote = mintLifecycleUid(); await put(liveRemote, owner);
  check("interactive policy remains local despite owned remote candidate metadata", (await exchange()).instance === local.instanceId);
  for (const profile of ["control-caller-privileged", "control-caller-admin"] as const) {
    const resolved = await resolveControlTarget({ space }, profile, undefined, { onRefusal: "throw" });
    check(`${profile} interactive control consumers share local-primary routing`, resolved.auth.managerInstanceId === local.instanceId);
  }
  process.env.COTAL_MANAGER_INSTANCE = liveRemote; process.env.COTAL_SPACE = space;
  try {
    const launched = await resolveControlTarget({ space }, "control-caller-privileged", undefined, { onRefusal: "throw" });
    check("supplied launching-binding input wins over human primary policy", launched.auth.managerInstanceId === liveRemote);
    const explicit = await resolveControlTarget({ space }, "control-caller-admin", local.instanceId, { onRefusal: "throw" });
    check("explicit client pin still wins over launching-manager binding", explicit.auth.managerInstanceId === local.instanceId);
  } finally { delete process.env.COTAL_MANAGER_INSTANCE; delete process.env.COTAL_SPACE; }
  check("explicit owned remote candidate metadata wins over local primary", (await exchange(liveRemote)).instance === liveRemote);
  check("managed secret default selection stays remote", (await exchange(undefined, true)).instance === liveRemote);
  const bound = await exchange(liveRemote, true);
  check("managed-secret explicit binding selects remote candidate metadata", bound.status === 200 && bound.instance === liveRemote);
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
  if (error instanceof EpEnvelopeError) process.stdout.write(JSON.stringify({ diagnostic: "native-boundary", stage, code: error.code, outcome: error.outcome, brokerRefusal: error.message.includes("REFUSED BY THE BROKER"), executionNone: error.message.includes("execution: none") }) + "\n");
  check(`fixture completed stage ${stage} (${error instanceof Error ? error.name : "unknown"})`, false);
} finally {
  if (manager) await manager.stop({ withAgents: true }).catch(() => { managerClosed = false; check("native Manager teardown", false); });
  if (cli) await killAndAwaitExit(cli);
  await delivery?.stop();
  if (child) await killAndAwaitExit(child);
  if (broker) { await killAndAwaitExit(broker); releaseBroker?.(); }
  await new Promise<void>(r => idp.close(() => r()));
  check("owned child PID/start/cwd generations exited", children.every(x => { try { const now = identity(x.pid); return now.start !== x.start || now.cwd !== x.cwd; } catch (error) { return ["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code ?? ""); } }));
  check("owned broker and listener ports closed", (await Promise.all([port, issuerPort, exchangePort, ...ports].filter(Boolean).map(gone))).every(Boolean));
  if (checks.every(x => x.ok)) assert.equal(checks.length, 73, "all named NONE, CLI, selection, scope and cleanup cells ran");
  if (process.env.FIXTURE_OUT) writeFileSync(join(process.env.FIXTURE_OUT, `local-none-custody.${process.pid}.json`), JSON.stringify({ root, fixture: identity(process.pid), children, ports: [port, issuerPort, exchangePort, ...ports].filter(Boolean), managerClosed, stage, checks }, null, 2) + "\n", { mode: 0o600 });
  if (managerClosed && checks.every(x => x.ok) && existsSync(root)) rmSync(root, { recursive: true });
  const failed = checks.filter(x => !x.ok).length;
  process.stdout.write(JSON.stringify({ checks: checks.length, passed: checks.length - failed, failed }) + "\n");
  process.stdout.write(formatSentinel({ passed: checks.length - failed, failed }) + "\n");
  if (failed) process.exitCode = 1;
}
