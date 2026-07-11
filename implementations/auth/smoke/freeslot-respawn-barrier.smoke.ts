/**
 * FREESLOT RESPAWN BARRIER smoke (control-surface P1 gate; EXPECTED RED until the
 * lifecycle-keyed deprovision lands) — proves by EXECUTION the despawn/respawn race that has so
 * far only been established by code-read:
 *
 *   `freeSlot` frees the agent's name synchronously, then fires `deprovision` DETACHED. Every
 *   delete inside that teardown is keyed by (owner, actor-name): the managed ledger row
 *   (`revokeAgent`), the dm_/dlv_ durables and the read-ACL row (`deprovisionAgent`, targetId =
 *   `principalKey(owner, name)`). A same-name respawn that provisions while the teardown is still
 *   in flight therefore hands the REPLACEMENT's freshly minted footprint to the stale teardown:
 *   its ledger row dies (next exchange refused, next connect denied), its durables and ACL row
 *   are deleted, and the manager keeps listing it as live.
 *
 * The BARRIER CONTRACT this smoke asserts: a replacement spawned after a despawn reply keeps its
 * entire footprint no matter when the predecessor's teardown executes. Current code FAILS these
 * asserts; the v0.4 lifecycle-keyed resources + `(principal, lifecycleUid)`-pinned deprovisioner
 * turn them green without touching the smoke.
 *
 * DETERMINISM: the predecessor's `deprovision` is held on a gate (instance-level wrap of the
 * private method) until the replacement is provisioned AND its child has connected on its own
 * credentials (a connect marker; presence can't serve, see below), then released. That
 * derandomizes a real window (the teardown spans a cred mint + a fresh broker connection +
 * JS-API deletes, and via the exit-reap path `freeSlot` fires at ARBITRARY times relative to an
 * in-flight respawn); it does not create a new path.
 *
 * Two further name-keying consequences surfaced while building this probe:
 *   - Stale-presence readiness: a respawn's "started" verdict can ride the SIGKILLed
 *     predecessor's lingering presence entry (same principal, no clean leave), before the
 *     replacement child has read its secret files. Readiness cannot tell the two lifecycles
 *     apart, so the smoke uses its own connect marker.
 *   - Boot-race kill: when the teardown's name-keyed secret-file shred lands mid-boot (real via
 *     the exit-reap path), the replacement child dies at startup (ENOENT on its sentinel), the
 *     exit reap then deprovisions the corpse, and the manager reports nothing amiss.
 *
 * Run: pnpm smoke:freeslot-barrier:live   (pnpm build first — Manager + the agent child load
 * dist; needs nats-server + node on PATH)
 */

// ---------- SELF-DISPATCH (must be the FIRST thing that runs) ----------
// The manager builds the agent's bearer argv from `process.argv[1]`, which in this in-process
// smoke is THIS file; the smoke also re-execs itself to run the auth-service daemon. Intercept
// both before the heavy harness loads (same shape as user-spawn.smoke.ts).
const SUBCOMMAND = process.argv[2] ?? "";
if (SUBCOMMAND === "agent-bearer" || SUBCOMMAND === "auth-service") {
  await import("@cotal-ai/auth");
  const { registry } = await import("@cotal-ai/core");
  const rest = process.argv.slice(3);
  const values: Record<string, string | boolean | undefined> = {};
  const positionals: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = rest[i + 1];
      if (next !== undefined && !next.startsWith("--")) { values[key] = next; i++; }
      else values[key] = true;
    } else positionals.push(a);
  }
  const cmd = registry
    .all<{ name: string; run: (a: { values: typeof values; positionals: string[]; raw: readonly string[] }) => Promise<void> }>("command")
    .find((c) => c.name === SUBCOMMAND);
  if (!cmd) { console.error(`self-dispatch: command "${SUBCOMMAND}" is not registered`); process.exit(1); }
  try {
    await cmd.run({ values, positionals, raw: rest });
    process.exit(0);
  } catch (e) {
    console.error(e instanceof Error ? (e.stack ?? e.message) : String(e));
    process.exit(1);
  }
}

// ---------- MAIN HARNESS ----------
type ChildProcess = import("node:child_process").ChildProcess;
type Connector = import("@cotal-ai/core").Connector;
type LaunchOpts = import("@cotal-ai/core").LaunchOpts;
type LaunchSpec = import("@cotal-ai/core").LaunchSpec;
type ControlReply = import("@cotal-ai/core").ControlReply;

const { spawn } = await import("node:child_process");
const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } = await import("node:fs");
const { tmpdir } = await import("node:os");
const { join } = await import("node:path");

const home = mkdtempSync(join(tmpdir(), "cotal-fsb-home-"));
process.env.COTAL_HOME = home;
const root = mkdtempSync(join(tmpdir(), "cotal-fsb-root-"));

const { betterAuth } = await import("better-auth");
const { memoryAdapter } = await import("better-auth/adapters/memory");
const { jwt } = await import("better-auth/plugins/jwt");
const { deviceAuthorization } = await import("better-auth/plugins/device-authorization");
const { bearer: baBearer } = await import("better-auth/plugins/bearer");
const { toNodeHandler } = await import("better-auth/node");
const { createServer } = await import("node:http");
type AddressInfo = import("node:net").AddressInfo;

const {
  createSpaceAuth, isReachable, mintCreds, newIdentity, serverConfig, setupSpaceStreams,
  principalKey, registry, dmStream, dlvStream, dmDurable, dlvDurable, openAclRegistry, readAcl,
} = await import("@cotal-ai/core");
const { connect, credsAuthenticator } = await import("@nats-io/transport-node");
const { jetstreamManager } = await import("@nats-io/jetstream");
const { authDir, userAuthStateDir, saveSpaceAuth, recordMesh, assertUserAuthInfo } = await import("@cotal-ai/workspace");
const {
  cotalAuthProvider, establishIdpSession, grantActor, loadAuthServiceInfo,
  managedActorLedgerDir, ledgerRowFilename,
} = await import("@cotal-ai/auth");
// @cotal-ai/manager is not a dep of @cotal-ai/auth — drive the REAL Manager from its built dist by
// relative path (shares the one @cotal-ai/core dist registry with the in-process connector).
const { Manager } = await import("../../manager/dist/index.js");
type DeviceLoginPrompt = import("@cotal-ai/auth").DeviceLoginPrompt;

/** The four COTAL_* vars configFromEnv parses for a user-mode launch (connector-core's userAuthEnv). */
function userAuthEnv(o: LaunchOpts): Record<string, string> {
  if (!o.userAuth) return {};
  return {
    COTAL_OWNER: o.userAuth.owner,
    COTAL_ACTOR: o.userAuth.actor,
    COTAL_SENTINEL_CREDS: o.userAuth.sentinelCredsPath,
    COTAL_BEARER_CMD: JSON.stringify(o.userAuth.bearerCmd),
  };
}
function launchEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of ["PATH", "HOME", "TMPDIR", "TMP", "TEMP", "XDG_CACHE_HOME", "LANG", "TERM"]) {
    const v = process.env[k];
    if (v) out[k] = v;
  }
  return out;
}

let pass = 0, fail = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ FAIL: ${name}`, extra ?? ""); }
};
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

const SELF = process.argv[1];
const PORT = 20000 + Math.floor(Math.random() * 40000);
const SERVER = `nats://127.0.0.1:${PORT}`;
const SPACE = `fsb-${Math.floor(Math.random() * 1e6)}`;
const CLIENT_ID = "cotal-cli";
const AGENT = "worker";
const dir = userAuthStateDir(root, SPACE);
const credsDir = join(authDir(root), "creds");
const coreDist = join(import.meta.dirname, "..", "..", "..", "packages", "core", "dist", "index.js");

// The agent CHILD: a real long-lived node process through the real pty runtime, connecting
// user-mode with a bearer SOURCE (execs COTAL_BEARER_CMD) + the sentinel creds.
const CHILD = [
  "const cp=require('node:child_process');",
  "const fs=require('node:fs');",
  "const {pathToFileURL}=require('node:url');",
  "const argv=JSON.parse(process.env.COTAL_BEARER_CMD);",
  "const sentinel=fs.readFileSync(process.env.COTAL_SENTINEL_CREDS,'utf8');",
  "function bearer(){return new Promise((res,rej)=>{cp.execFile(argv[0],argv.slice(1),{maxBuffer:1<<20,timeout:30000},(e,so,se)=>{if(e)return rej(new Error(((se||'').toString().trim())||e.message));const t=(so||'').toString().trim();t?res(t):rej(new Error('empty bearer'));});});}",
  "import(pathToFileURL(process.env.CORE_DIST).href).then(async(m)=>{",
  "const ep=new m.CotalEndpoint({space:process.env.COTAL_SPACE,servers:process.env.COTAL_SERVERS,bearer:bearer,sentinelCreds:sentinel,channels:[],consume:false,registerPresence:true,watchPresence:false,card:{name:process.env.COTAL_NAME,owner:process.env.COTAL_OWNER,actor:process.env.COTAL_ACTOR,kind:'agent'}});",
  "ep.on('error',()=>{});await ep.start();",
  "if(process.env.FSB_READY)fs.writeFileSync(process.env.FSB_READY,'1');",
  "setInterval(()=>{},1000);",
  "}).catch((e)=>{console.error(e&&e.message||String(e));process.exit(1);});",
].join("\n");
const e2eCon: Connector = {
  kind: "connector",
  name: "e2e",
  requires: ["node"],
  buildLaunch: (o: LaunchOpts): LaunchSpec => ({
    command: process.execPath,
    args: ["-e", CHILD],
    env: {
      ...launchEnv(),
      ...userAuthEnv(o),
      CORE_DIST: coreDist,
      COTAL_SPACE: o.space,
      COTAL_NAME: o.name,
      COTAL_SERVERS: o.servers ?? "",
      FSB_READY: join(root, "child-connected"),
    },
  }),
};
registry.register(e2eCon);

function spawnAuthService(): ChildProcess {
  return spawn(process.execPath, [...process.execArgv, SELF, "auth-service", "--space", SPACE, "--server", SERVER], {
    cwd: root,
    env: { ...process.env, COTAL_HOME: home },
    stdio: "ignore",
  });
}
async function waitAuthReady(ms = 15000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const info = loadAuthServiceInfo(dir);
    if (info) {
      let alive = false;
      try { process.kill(info.pid, 0); alive = true; } catch { /* not up yet */ }
      if (alive) { try { const r = await fetch(`${info.url}/health`); if (r.ok) return; } catch { /* not bound yet */ } }
    }
    await wait(150);
  }
  throw new Error(`auth service did not become ready under ${dir} in ${ms}ms`);
}
async function agentExchange(actor: string, actorToken: string, owner: string): Promise<{ status: number; body: { token?: string; error?: string } }> {
  const info = loadAuthServiceInfo(dir)!;
  const res = await fetch(`${info.url}/exchange`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${info.cap}` },
    body: JSON.stringify({ owner, actor, actorToken }),
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as { token?: string; error?: string } };
}
const managedRowPath = (owner: string) => join(managedActorLedgerDir(dir), ledgerRowFilename(owner, AGENT));
const rowHash = (owner: string): string | undefined => {
  try { return (JSON.parse(readFileSync(managedRowPath(owner), "utf8")) as { tokenHash?: string }).tokenHash; }
  catch { return undefined; }
};

let manager: InstanceType<typeof Manager> | undefined;
let broker: ChildProcess | undefined;
let authChild: ChildProcess | undefined;
let jsDir: string | undefined;
try {
  // ---------- A. setup: user-auth broker + streams + auth service + login + grant ----------
  console.log("A) user-auth broker + auth service + device login");
  const auth = await createSpaceAuth(SPACE);
  saveSpaceAuth(authDir(root), auth);

  // The real Better Auth IdP (device-code, auto-approved) — up first, prepareServer pins its url.
  let handler: ReturnType<typeof toNodeHandler> | undefined;
  const idpSrv = createServer((req, res) => handler!(req, res));
  await new Promise<void>((r) => idpSrv.listen(0, "127.0.0.1", r));
  const origin = `http://127.0.0.1:${(idpSrv.address() as AddressInfo).port}`;
  const base = `${origin}/api/auth`;
  const ba = betterAuth({
    baseURL: origin,
    secret: "smoke-only-better-auth-secret-0123456789",
    database: memoryAdapter({ user: [], session: [], account: [], verification: [], jwks: [], deviceCode: [] }),
    emailAndPassword: { enabled: true },
    plugins: [
      jwt({ jwt: { issuer: origin, audience: origin } }),
      deviceAuthorization({ expiresIn: "2m", interval: "1s", validateClient: (id) => id === CLIENT_ID }),
      baBearer(),
    ],
  });
  handler = toNodeHandler(ba);
  const signup = await ba.api.signUpEmail({
    body: { email: "human@example.test", password: "correct-horse-battery", name: "Human 42" },
    returnHeaders: true,
  });
  const cookie = signup.headers.get("set-cookie")!.split(";")[0];
  const approve = async (userCode: string): Promise<void> => {
    const claim = await fetch(`${base}/device?user_code=${encodeURIComponent(userCode)}`, { headers: { cookie, origin } });
    if (!claim.ok) throw new Error(`device claim failed: HTTP ${claim.status}`);
    const res = await fetch(`${base}/device/approve`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie, origin },
      body: JSON.stringify({ userCode }),
    });
    if (!res.ok) throw new Error(`device/approve failed: HTTP ${res.status}`);
  };

  const prepared = await cotalAuthProvider.prepareServer({
    space: SPACE,
    operatorSeed: auth.operator.seed,
    account: { pub: auth.account.pub, signingSeed: auth.account.signingSeed },
    dir,
    idpUrl: base,
  });
  jsDir = mkdtempSync(join(tmpdir(), "cotal-fsb-js-"));
  writeFileSync(join(root, "server.conf"), serverConfig(auth, { port: PORT, storeDir: jsDir, extraAccounts: prepared.extraAccounts }));
  broker = spawn("nats-server", ["-c", join(root, "server.conf")], { stdio: "ignore" });
  let up = false;
  for (let i = 0; i < 50 && !up; i++) { up = await isReachable(SERVER); if (!up) await wait(200); }
  check("user-auth broker is reachable", up);
  const provId = newIdentity();
  const provCreds = await mintCreds(auth, provId, "provisioner");
  await setupSpaceStreams({ servers: SERVER, space: SPACE, creds: provCreds });
  recordMesh({ space: SPACE, server: SERVER, root, mode: "user", userAuth: assertUserAuthInfo(prepared.publicAuth), ts: new Date().toISOString() });
  mkdirSync(join(root, ".cotal", "agents"), { recursive: true });
  writeFileSync(join(root, ".cotal", "agents", `${AGENT}.md`), `---\nname: ${AGENT}\nrole: worker\nsubscribe: [general]\nallowPublish: [general]\n---\n${AGENT} persona.\n`);

  authChild = spawnAuthService();
  await waitAuthReady();
  await establishIdpSession({
    dir: home, idpUrl: base, clientId: CLIENT_ID,
    onPrompt: (p: DeviceLoginPrompt) => void approve(p.userCode),
  });
  const OWNER = await cotalAuthProvider.ownerForLogin({ dir, space: SPACE });
  grantActor(dir, { owner: OWNER, actor: "cli", scope: ["spawn", "role:worker"], allowSubscribe: ["general"], allowPublish: ["general"], label: "smoke operator" });

  // Broker-footprint inspectors on the provisioner cred (same shape as lifecycle-e2e).
  const inspect = async <T,>(fn: (jsm: Awaited<ReturnType<typeof jetstreamManager>>, nc: import("@nats-io/transport-node").NatsConnection) => Promise<T>): Promise<T> => {
    const nc = await connect({ servers: SERVER, authenticator: credsAuthenticator(new TextEncoder().encode(provCreds)), inboxPrefix: `_INBOX_${provId.id}`, maxReconnectAttempts: 0 });
    try { return await fn(await jetstreamManager(nc), nc); } finally { await nc.drain().catch(() => {}); }
  };
  const consumerExists = (stream: string, name: string) =>
    inspect(async (jsm) => { try { await jsm.consumers.info(stream, name); return true; } catch { return false; } });
  const aclPresent = () => inspect(async (_j, nc) => (await readAcl(await openAclRegistry(nc, SPACE), principalKey(OWNER, AGENT).key)) !== undefined);
  const footprint = async () => ({
    row: existsSync(managedRowPath(OWNER)),
    dm: await consumerExists(dmStream(SPACE), dmDurable(OWNER, AGENT)),
    dlv: await consumerExists(dlvStream(SPACE), dlvDurable(OWNER, AGENT)),
    acl: await aclPresent(),
  });

  // ---------- B. first spawn: the predecessor, with its full footprint ----------
  console.log("B) user-mode spawn of the predecessor");
  manager = new Manager({ space: SPACE, servers: SERVER, runtime: "pty", workspaceRoot: root });
  await manager.start();
  const r1: ControlReply = await manager.startAgent({ name: AGENT, agent: "e2e", owner: OWNER });
  check("predecessor spawn ok", r1.ok === true, r1);
  const fp1 = await footprint();
  check("predecessor footprint exists (row + dm + dlv + acl)", fp1.row && fp1.dm && fp1.dlv && fp1.acl, fp1);
  const hash1 = rowHash(OWNER);

  // ---------- C. the barrier probe: despawn (teardown gated) then same-name respawn ----------
  console.log("C) despawn with the detached teardown held, respawn the same name, release");
  // Hold the predecessor's detached deprovision on a gate. Instance-level wrap of the private
  // method (runtime-visible; the repo's smokes already reach into manager privates): the FIRST
  // deprovision for this agent name parks until released, everything else passes through.
  type DeprovArg = { id: string; name: string; userOwner?: string };
  type Deprov = (a: DeprovArg) => Promise<void>;
  type Handle = import("@cotal-ai/core").AgentHandle;
  const mAny = manager as unknown as { deprovision: Deprov; ep: { ref: () => { id: string } }; opStop: (a: Record<string, unknown>, c: string, admin: boolean) => Promise<ControlReply>; agents: Map<string, { handle: Handle }> };
  const origDeprov: Deprov = mAny.deprovision.bind(manager);
  let releaseGate!: () => void;
  const gate = new Promise<void>((r) => { releaseGate = r; });
  let gatedRun: Promise<void> | undefined;
  // Every deprovision invocation, in order, so the deleter is ATTRIBUTABLE: the barrier asserts
  // below are only meaningful if the predecessor's gated teardown is the sole deleter in play.
  const deprovCalls: Array<{ name: string; gated: boolean }> = [];
  mAny.deprovision = (a: DeprovArg): Promise<void> => {
    if (a.name === AGENT && !gatedRun) {
      deprovCalls.push({ name: a.name, gated: true });
      gatedRun = (async () => { await gate; await origDeprov(a); })();
      return gatedRun;
    }
    deprovCalls.push({ name: a.name, gated: false });
    return origDeprov(a);
  };

  const stopReply = await mAny.opStop({ name: AGENT, graceful: false }, mAny.ep.ref().id, true);
  check("despawn reply ok", stopReply.ok === true, stopReply);
  check("the name is freed immediately (slot reusable before the teardown ran)", !manager.list().some((a: { name: string }) => a.name === AGENT), manager.list().map((a: { name: string }) => a.name));
  check("the detached teardown fired and is in flight (held on the gate)", gatedRun !== undefined);

  // Clear the predecessor's connect marker: the reappearing marker is the REPLACEMENT child's own
  // connect witness. Readiness alone cannot serve here: the respawn's "started" verdict can ride
  // the SIGKILLed predecessor's lingering presence entry (same principal, no clean leave), before
  // the replacement child has even read its secret files.
  rmSync(join(root, "child-connected"), { force: true });
  const r2: ControlReply = await manager.startAgent({ name: AGENT, agent: "e2e", owner: OWNER });
  check("same-name respawn ok while the predecessor teardown is in flight", r2.ok === true, r2);
  // Diagnostics on the REPLACEMENT child so a post-release death is explainable: terminal output +
  // exit timing relative to the gate release.
  const newHandle = mAny.agents.get(AGENT)?.handle;
  const childOut: Buffer[] = [];
  let childExitedAtMs = 0;
  let releasedAtMs = 0;
  try {
    const sess = newHandle!.attach();
    sess.onData((c) => childOut.push(c));
    sess.onExit(() => { childExitedAtMs = Date.now(); });
  } catch { /* no attach on this backend */ }
  const childDiag = () => ({
    pid: newHandle?.pid,
    status: newHandle?.status(),
    exitedMsAfterRelease: childExitedAtMs ? childExitedAtMs - releasedAtMs : "alive",
    output: Buffer.concat(childOut).toString("utf8").slice(-500),
  });
  const fp2 = await footprint();
  const hash2 = rowHash(OWNER);
  check("replacement footprint exists after respawn (row + dm + dlv + acl)", fp2.row && fp2.dm && fp2.dlv && fp2.acl, fp2);
  check("replacement holds a ROTATED ledger secret (its own mint authority, not the predecessor's)", typeof hash2 === "string" && hash2 !== hash1, { hash1, hash2 });
  const replacementToken = readFileSync(join(credsDir, `${AGENT}.actor-token`), "utf8").trim();

  // Pin the interleaving fully: release only after the replacement child has read its secret
  // files and CONNECTED (its own marker, not the predecessor's). This is the benign-looking
  // ordering: despawn replied, respawn replied, replacement live on the mesh, and only THEN does
  // the predecessor's detached teardown execute.
  const connected = await (async (ms = 15000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (existsSync(join(root, "child-connected"))) return true; await wait(100); }
    return existsSync(join(root, "child-connected"));
  })();
  check("replacement child connected on its own credentials (its connect marker reappeared)", connected);

  // Attribution preconditions: at this point the ONLY deprovision in play must be the gated
  // predecessor teardown, and the replacement must still be a live managed slot. If either fails,
  // a second deleter (e.g. a runtime exit-reap hitting the replacement) is confounding the probe.
  check("pre-release: exactly one deprovision fired (the gated predecessor teardown)",
    deprovCalls.length === 1 && deprovCalls[0].gated, deprovCalls);
  check("pre-release: the replacement is still a live managed slot",
    manager.list().some((a: { name: string }) => a.name === AGENT),
    { listed: manager.list().map((a: { name: string }) => a.name), handleStatus: mAny.agents.get(AGENT)?.handle.status() });

  // Release the predecessor's teardown and let it fully settle.
  releasedAtMs = Date.now();
  releaseGate();
  await gatedRun!.catch(() => {});
  mAny.deprovision = origDeprov;

  // ---------- D. THE BARRIER CONTRACT (red on current code) ----------
  // A replacement spawned after the despawn reply keeps its entire footprint no matter when the
  // predecessor's teardown executes. Today the name-keyed teardown deletes all of it.
  console.log("D) barrier contract: the replacement's footprint survives the predecessor's teardown");
  const fp3 = await footprint();
  check("BARRIER: replacement ledger row survives", fp3.row, fp3);
  check("BARRIER: replacement row still carries the replacement's tokenHash", rowHash(OWNER) === hash2, { want: hash2, got: rowHash(OWNER) });
  check("BARRIER: replacement dm_ durable survives", fp3.dm, fp3);
  check("BARRIER: replacement dlv_ durable survives", fp3.dlv, fp3);
  check("BARRIER: replacement read-ACL row survives", fp3.acl, fp3);
  const ex = await agentExchange(AGENT, replacementToken, OWNER);
  check("BARRIER: replacement actor token still mints a bearer (exchange 200)", ex.status === 200 && typeof ex.body.token === "string", { status: ex.status, error: ex.body.error });
  // Severity witness (true today AND under the fix): the manager still lists the replacement as a
  // live managed agent, so any footprint damage above is silent split-brain, not a reported death.
  // Severity witness (expected to hold today AND under the fix, since the replacement is already
  // connected when the teardown runs): the manager still lists the replacement as live while (on
  // current code) its mint authority and broker footprint are gone. The damage is SILENT
  // split-brain: nothing reported, the agent just can't renew, re-connect, or be delivered to.
  check("the manager still lists the replacement (so on current code the damage is silent)",
    manager.list().some((a: { name: string }) => a.name === AGENT),
    { listed: manager.list().map((a: { name: string }) => a.name), deprovCalls, child: childDiag() });

  console.log(`\nFREESLOT RESPAWN BARRIER ${fail === 0 ? "OK ✅" : "RED ❌ (expected until the lifecycle-keyed deprovision lands)"}  (${pass} passed, ${fail} failed)`);
  if (fail) process.exitCode = 1;
} catch (e) {
  console.error("  ✗ scenario threw:", (e as Error).stack ?? (e as Error).message);
  process.exitCode = 1;
} finally {
  try { await manager?.stop(); } catch { /* already stopped */ }
  if (authChild?.pid) { try { process.kill(authChild.pid, "SIGKILL"); } catch { /* gone */ } }
  if (broker?.pid) { try { process.kill(broker.pid, "SIGKILL"); } catch { /* gone */ } }
  await wait(300);
  for (const d of [home, root, jsDir]) if (d) rmSync(d, { recursive: true, force: true });
  process.exit(process.exitCode ?? 0);
}
