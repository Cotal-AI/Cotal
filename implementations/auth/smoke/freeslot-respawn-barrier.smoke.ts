/**
 * FREESLOT RESPAWN BARRIER smoke (control-surface P1 gate; EXPECTED RED until the P2 alias
 * reservation + lifecycle-keyed cleanup land) — proves by EXECUTION the despawn/respawn race that
 * had previously only been established by code-read:
 *
 *   `freeSlot` frees the agent's name synchronously, then fires `deprovision` DETACHED. The
 *   teardown's LOCAL half (creds/secret shred + ledger revoke) completes in the detached call's
 *   synchronous prefix — on the same event-loop tick as `freeSlot` — so no same-name respawn can
 *   ever observe it mid-flight. Its BROKER half (`deprovisionBroker`: the dm_/dlv_ durables and
 *   the read-ACL row, all keyed by (owner, actor-name)) runs after the first await, across a cred
 *   mint plus a fresh broker connection plus JS-API deletes. A same-name respawn that provisions
 *   inside that window hands the REPLACEMENT's freshly minted broker footprint to the stale
 *   teardown: its durables and ACL row are deleted while the manager keeps listing it as live.
 *
 * The BARRIER CONTRACT is the spec/plan acceptance timeline for terminal despawn (retire before
 * alias release; cleanup pinned to the retired lifecycle; detached cleanup = idempotent
 * reconciliation that can never resolve through the current alias occupant):
 *
 *   1. RESERVATION — while the predecessor's cleanup is pending, a same-name spawn must not
 *      yield a new live agent under the exact alias. Today the alias frees instantly (RED).
 *   2. LIFECYCLE KEYING — after retirement, the same-alias replacement's broker resources must
 *      be DISTINCT names from the predecessor's. Today the names collide exactly (RED).
 *   3. REPLAY SAFETY — re-delivering the predecessor's captured broker cleanup (the
 *      at-least-once world: crash recovery, redelivery, reconciliation retry) must leave the
 *      live replacement's footprint untouched. Today it silently destroys it (RED).
 *
 * All three flip green under the full P2 slice (alias reservation + lifecycle-keyed resources +
 * `(principal, lifecycleUid)`-pinned cleanup). The CONTRACT asserts need no edits for that; only
 * a mechanical rename is expected if P2 restructures the private `deprovisionBroker` seam this
 * harness wraps. The teardown's LOCAL half (creds/secret shred + ledger revoke) is asserted GREEN
 * throughout: its synchronous prefix protects it, and the replay is broker-only.
 *
 * The footprint checks ENUMERATE by principal prefix (via a harness-only inspector cred — no
 * production profile grants CONSUMER.LIST) and attribute predecessor/successor sets by TIMELINE:
 * the successor snapshot is taken only after the predecessor's retirement completed, so the
 * exists-under-prefix ambiguity (a wrong-target delete or no-op cleanup false-greening) cannot
 * arise. The replacement's connectedness is witnessed by its own connect-marker file; readiness
 * alone can ride the SIGKILLed predecessor's lingering presence entry (same principal, no clean
 * leave).
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
  principalKey, registry, dmStream, dlvStream, openAclRegistry,
  CotalEndpoint, mintMembershipObserverCreds, mintConnectionEvictorCreds, evictDeniedPrincipalWithCreds,
  createEndpointStreams,
} = await import("@cotal-ai/core");
const { connect, credsAuthenticator } = await import("@nats-io/transport-node");
const { jetstreamManager } = await import("@nats-io/jetstream");
const { Kvm } = await import("@nats-io/kv");
const { encodeUser, fmtCreds } = await import("@nats-io/jwt");
const { fromPublic, fromSeed } = await import("@nats-io/nkeys");
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
  "const ep=new m.CotalEndpoint({space:process.env.COTAL_SPACE,servers:process.env.COTAL_SERVERS,bearer:bearer,sentinelCreds:sentinel,lifecycleUid:process.env.COTAL_LIFECYCLE_UID,channels:[],consume:false,registerPresence:true,watchPresence:false,card:{name:process.env.COTAL_NAME,owner:process.env.COTAL_OWNER,actor:process.env.COTAL_ACTOR,kind:'agent'}});",
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
      // The manager mints one lifecycle uid per spawn and provisions the agent's dm_/dlv_ under
      // it; the child endpoint binds by the SAME uid (an authed presence-registering agent proves
      // its lifecycle against its dm_ durable before presence, SPEC 13.1 fail-before-presence).
      ...(o.lifecycleUid ? { COTAL_LIFECYCLE_UID: o.lifecycleUid } : {}),
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
let delivery: InstanceType<typeof CotalEndpoint> | undefined;
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
  // The endpoint lifecycle-data streams (EPF/EPW/EPE/records): production space setup creates them,
  // and the retirement barrier's FRONTIER step reads their last_seq to close the lifecycle interval.
  {
    // The endpoint lifecycle-data streams are created by the space's setup authority (broader than
    // the scoped provisioner); a harness god cred (account-signed, allow-all) stands in for it.
    const setupId = newIdentity();
    const setupCreds = fmtCreds(
      await encodeUser("fsb-setup", fromPublic(setupId.id), fromPublic(auth.account.pub), { pub: { allow: [">"] }, sub: { allow: [">"] } }, { signer: fromSeed(new TextEncoder().encode(auth.account.signingSeed)) }),
      fromSeed(new TextEncoder().encode(setupId.seed)),
    );
    const snc = await connect({ servers: SERVER, authenticator: credsAuthenticator(setupCreds), maxReconnectAttempts: 0 });
    try { await createEndpointStreams(await jetstreamManager(snc), new Kvm(snc), SPACE); }
    finally { await snc.drain().catch(() => {}); }
  }

  // The DELIVERY DAEMON (the eviction rail the retirement barrier needs): production `cotal up`
  // runs auth AND delivery, and a terminal retirement's VERIFIED eviction rides the delivery-admin
  // rail. This harness hosts Plane-3 inline with a REAL evictPrincipal (the $SYS observer + KICK
  // evictor minted here, the only window their in-memory seed exists), so despawn -> retirement can
  // reach its terminal exactly as it does under a full stack. Without it the barrier fail-closes at
  // eviction and the alias stays reserved (the pre-delivery composition, proven earlier).
  const dlvObserverCreds = await mintMembershipObserverCreds(auth, newIdentity());
  const dlvEvictorCreds = await mintConnectionEvictorCreds(auth, newIdentity());
  const dlvId = newIdentity();
  delivery = new CotalEndpoint({
    space: SPACE, servers: SERVER, creds: await mintCreds(auth, dlvId, "delivery"),
    card: { id: dlvId.id, name: "delivery", role: "delivery", kind: "endpoint" },
    channels: [], consume: false, watchChannels: false, watchPresence: false, registerPresence: false,
  });
  delivery.on("error", () => {});
  await delivery.start();
  await delivery.startPlane3((owner: string, lifecycleUid: string) => delivery!.aclForOwner(owner, lifecycleUid), {
    evictPrincipal: (principal: string) => evictDeniedPrincipalWithCreds({
      servers: SERVER, observerCreds: dlvObserverCreds, evictorCreds: dlvEvictorCreds, accountId: auth.account.pub, principal,
    }),
  });
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

  // Broker-footprint inspectors. The checks ENUMERATE by principal PREFIX rather than binding
  // today's exact resource names, so the same asserts stay compilable and flip green under the
  // lifecycle-keyed rename (dm_<principal> becomes dm_<principal>-<lifecycleUid> etc.) without
  // editing the smoke. Enumeration (`$JS.API.CONSUMER.LIST`) is deliberately grantable by NO
  // production profile, so the inspector rides a HARNESS-ONLY god cred signed with the account
  // key the smoke already owns — observability of the harness, never a surface of the code under test.
  const principal = principalKey(OWNER, AGENT);
  const inspCreds = await (async () => {
    const inspId = newIdentity();
    const signer = fromSeed(new TextEncoder().encode(auth.account.signingSeed));
    const userJwt = await encodeUser("fsb-inspector", fromPublic(inspId.id), fromPublic(auth.account.pub),
      { pub: { allow: [">"] }, sub: { allow: [">"] } }, { signer });
    return fmtCreds(userJwt, fromSeed(new TextEncoder().encode(inspId.seed)));
  })();
  const inspect = async <T,>(fn: (jsm: Awaited<ReturnType<typeof jetstreamManager>>, nc: import("@nats-io/transport-node").NatsConnection) => Promise<T>): Promise<T> => {
    const nc = await connect({ servers: SERVER, authenticator: credsAuthenticator(inspCreds), maxReconnectAttempts: 0 });
    try { return await fn(await jetstreamManager(nc), nc); } finally { await nc.drain().catch(() => {}); }
  };
  const consumersFor = (stream: string, prefix: string) =>
    inspect(async (jsm) => {
      const names: string[] = [];
      for await (const ci of jsm.consumers.list(stream)) if (ci.name.startsWith(prefix)) names.push(ci.name);
      return names;
    });
  const aclRowsFor = (prefix: string) =>
    inspect(async (_j, nc) => {
      const kv = await openAclRegistry(nc, SPACE);
      const keys: string[] = [];
      for await (const k of await kv.keys()) if (k.startsWith(prefix)) keys.push(k);
      return keys;
    });
  const footprint = async () => ({
    row: existsSync(managedRowPath(OWNER)),
    dm: await consumersFor(dmStream(SPACE), `dm_${principal.name}`),
    dlv: await consumersFor(dlvStream(SPACE), `dlv_${principal.name}`),
    acl: await aclRowsFor(principal.key),
  });

  // ---------- B. first spawn: the predecessor, with its full footprint ----------
  console.log("B) user-mode spawn of the predecessor");
  manager = new Manager({ space: SPACE, servers: SERVER, runtime: "pty", workspaceRoot: root });
  await manager.start();
  const r1: ControlReply = await manager.startAgent({ name: AGENT, agent: "e2e", owner: OWNER });
  check("predecessor spawn ok", r1.ok === true, r1);
  const fp1 = await footprint();
  check("predecessor footprint exists (row + dm + dlv + acl)",
    fp1.row && fp1.dm.length > 0 && fp1.dlv.length > 0 && fp1.acl.length > 0, fp1);
  const hash1 = rowHash(OWNER);

  // ---------- C. retirement barrier: despawn with the broker cleanup held, probe the alias ----------
  console.log("C) despawn with the broker cleanup held; the alias must not be reassignable");
  // Hold the predecessor's broker teardown on a gate — deprovisionBroker ONLY, so the teardown's
  // synchronous prefix (creds/secret shred + ledger revoke) runs untouched at despawn time exactly
  // as in production. Instance-level wrap of the private method (runtime-visible; the repo's
  // smokes already reach into manager privates): the FIRST broker teardown for this agent name
  // parks until released; everything else passes through and is recorded so every deleter in play
  // stays attributable. The gated call's ARG is captured — section E replays it, modeling the
  // at-least-once redelivery of a retired lifecycle's cleanup that the fix must make harmless.
  type DeprovArg = { id: string; name: string };
  type DeprovBroker = (a: DeprovArg) => Promise<void>;
  type Handle = import("@cotal-ai/core").AgentHandle;
  const mAny = manager as unknown as { deprovisionBroker: DeprovBroker; ep: { ref: () => { id: string } }; opStop: (a: Record<string, unknown>, c: string, admin: boolean) => Promise<ControlReply>; agents: Map<string, { handle: Handle }> };
  const origBroker: DeprovBroker = mAny.deprovisionBroker.bind(manager);
  let releaseGate!: () => void;
  const gate = new Promise<void>((r) => { releaseGate = r; });
  let gatedRun: Promise<void> | undefined;
  let predArg: DeprovArg | undefined;
  const brokerCalls: Array<{ name: string; gated: boolean; done: Promise<void> }> = [];
  mAny.deprovisionBroker = (a: DeprovArg): Promise<void> => {
    if (a.name === AGENT && !gatedRun) {
      predArg = a;
      gatedRun = (async () => { await gate; await origBroker(a); })();
      brokerCalls.push({ name: a.name, gated: true, done: gatedRun });
      return gatedRun;
    }
    const done = origBroker(a);
    brokerCalls.push({ name: a.name, gated: false, done });
    return done;
  };
  const listNames = (): string[] => manager!.list().map((a: { name: string }) => a.name);

  const stopReply = await mAny.opStop({ name: AGENT, graceful: false }, mAny.ep.ref().id, true);
  check("despawn reply ok", stopReply.ok === true, stopReply);
  // The broker phase engages a few microtasks after freeSlot (the teardown's synchronous prefix +
  // the ledger-revoke await sit before it) — poll briefly for the gate to be taken.
  for (let i = 0; i < 100 && !gatedRun; i++) await wait(20);
  check("the detached teardown reached its broker cleanup and is held on the gate",
    gatedRun !== undefined && predArg !== undefined);
  // The teardown's LOCAL half already ran in its synchronous prefix, exactly as in production: the
  // predecessor's ledger row is gone at this point. Asserting it keeps the probe honest — the gate
  // must not have deferred anything the real code does synchronously.
  check("predecessor row already revoked by the synchronous prefix (gate held nothing local)",
    !existsSync(managedRowPath(OWNER)));

  // BARRIER 1 — while the predecessor's cleanup is pending, the alias must stay RESERVED: a
  // same-name spawn must not yield a NEW live agent under the exact alias (refusing loudly or
  // auto-numbering both satisfy it). Today the name frees the instant the slot empties, so this
  // spawn succeeds as the exact alias — the enabling condition of the whole race.
  rmSync(join(root, "child-connected"), { force: true });
  const namesBeforeProbe = listNames();
  const probe: ControlReply = await manager.startAgent({ name: AGENT, agent: "e2e", owner: OWNER });
  const probeDelta = listNames().filter((n) => !namesBeforeProbe.includes(n));
  check("BARRIER: the alias is not reassignable while the predecessor's cleanup is pending",
    !probeDelta.includes(AGENT), { probeReply: probe, probeDelta });
  // Clear whatever the probe created (today: a live exact-alias agent; under the fix: possibly an
  // auto-numbered sibling) and let its own cleanup fully settle so it cannot confound section E.
  for (const n of probeDelta) await mAny.opStop({ name: n, graceful: false }, mAny.ep.ref().id, true);
  await Promise.allSettled(brokerCalls.filter((c) => !c.gated).map((c) => c.done.catch(() => {})));

  // Release: let the predecessor's retirement complete, as the fix does before freeing the alias.
  releaseGate();
  await gatedRun!.catch(() => {});
  // Witness (leak direction): the predecessor's broker footprint must be fully retired before the
  // alias is handed to a replacement — true today (the name-keyed deletes take everything) and
  // required under the fix (retire-before-free).
  const fpRetired = await footprint();
  check("witness: the predecessor's broker footprint is fully retired before the alias frees",
    fpRetired.dm.length === 0 && fpRetired.dlv.length === 0 && fpRetired.acl.length === 0, fpRetired);

  // ---------- D. the replacement: same-alias respawn AFTER retirement completed ----------
  console.log("D) same-alias respawn after the predecessor retired");
  rmSync(join(root, "child-connected"), { force: true });
  // Retry loop: today the alias is free immediately; under the fix the reservation may release a
  // beat after the awaited teardown settles. Never accept an auto-numbered stand-in — the
  // contract is about THE alias — so any stray sibling is stopped and the spawn retried.
  let r2: ControlReply | undefined;
  for (let i = 0; i < 20; i++) {
    const before = listNames();
    r2 = await manager.startAgent({ name: AGENT, agent: "e2e", owner: OWNER });
    const delta = listNames().filter((n) => !before.includes(n));
    if (r2.ok === true && delta.includes(AGENT)) break;
    for (const n of delta) await mAny.opStop({ name: n, graceful: false }, mAny.ep.ref().id, true);
    await wait(250);
  }
  check("same-alias respawn ok after the predecessor retired", r2?.ok === true && listNames().includes(AGENT), r2);
  // Diagnostics on the REPLACEMENT child so a post-replay death is explainable: terminal output +
  // exit timing relative to the replay.
  const newHandle = mAny.agents.get(AGENT)?.handle;
  const childOut: Buffer[] = [];
  let childExitedAtMs = 0;
  let replayAtMs = 0;
  try {
    const sess = newHandle!.attach();
    sess.onData((c) => childOut.push(c));
    sess.onExit(() => { childExitedAtMs = Date.now(); });
  } catch { /* no attach on this backend */ }
  const childDiag = () => ({
    pid: newHandle?.pid,
    status: newHandle?.status(),
    exitedMsAfterReplay: childExitedAtMs ? childExitedAtMs - replayAtMs : "alive",
    output: Buffer.concat(childOut).toString("utf8").slice(-500),
  });
  // Wait for the replacement child to read its secret files and CONNECT (its own marker; readiness
  // alone can ride the SIGKILLed predecessor's lingering presence entry — same principal, no clean
  // leave — before the child has even read its files).
  const connected = await (async (ms = 15000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (existsSync(join(root, "child-connected"))) return true; await wait(100); }
    return existsSync(join(root, "child-connected"));
  })();
  check("replacement child connected on its own credentials (its connect marker reappeared)", connected);
  // The predecessor is retired, so everything now under the principal prefix IS the successor's
  // set — attribution by timeline, no set arithmetic against a coexisting predecessor needed.
  const fpS = await footprint();
  const hash2 = rowHash(OWNER);
  check("replacement footprint exists after respawn (row + dm + dlv + acl)",
    fpS.row && fpS.dm.length > 0 && fpS.dlv.length > 0 && fpS.acl.length > 0, fpS);
  check("replacement holds a ROTATED ledger secret (its own mint authority, not the predecessor's)", typeof hash2 === "string" && hash2 !== hash1, { hash1, hash2 });
  const replacementToken = readFileSync(join(credsDir, `${AGENT}.actor-token`), "utf8").trim();
  // BARRIER 2 — lifecycle keying: the replacement's broker resources must be DISTINCT names from
  // the predecessor's, or any stale/replayed cleanup for the retired lifecycle can resolve to the
  // replacement's rows. Today the names collide exactly.
  const distinct = (pre: string[], succ: string[]): boolean => succ.length > 0 && succ.every((n) => !pre.includes(n));
  check("BARRIER: the replacement's broker resources are lifecycle-distinct from the predecessor's",
    distinct(fp1.dm, fpS.dm) && distinct(fp1.dlv, fpS.dlv) && distinct(fp1.acl, fpS.acl),
    { predecessor: { dm: fp1.dm, dlv: fp1.dlv, acl: fp1.acl }, successor: { dm: fpS.dm, dlv: fpS.dlv, acl: fpS.acl } });
  const callsBeforeReplay = brokerCalls.length;

  // ---------- E. THE REPLAY (red on current code) ----------
  // Deliver the predecessor's captured broker cleanup AGAIN, now that the replacement is live —
  // the at-least-once world the fix must survive: detached cleanup is idempotent reconciliation
  // against the RETIRED lifecycle and can never resolve through the current alias occupant.
  // Today the cleanup is keyed by (owner, actor-name) alone, so the replay lands on the
  // replacement's freshly minted footprint and silently destroys it.
  console.log("E) replay the retired predecessor's broker cleanup against the live replacement");
  replayAtMs = Date.now();
  await origBroker(predArg!).catch(() => { /* a conforming retired-lifecycle no-op may also throw */ });
  mAny.deprovisionBroker = origBroker;

  const fpPost = await footprint();
  const survives = (succ: string[], post: string[]): boolean => succ.length > 0 && succ.every((n) => post.includes(n));
  check("BARRIER: the replacement's dm_ durables survive the replayed cleanup", survives(fpS.dm, fpPost.dm),
    { successor: fpS.dm, post: fpPost.dm });
  check("BARRIER: the replacement's dlv_ durables survive the replayed cleanup", survives(fpS.dlv, fpPost.dlv),
    { successor: fpS.dlv, post: fpPost.dlv });
  check("BARRIER: the replacement's read-ACL rows survive the replayed cleanup", survives(fpS.acl, fpPost.acl),
    { successor: fpS.acl, post: fpPost.acl });
  // No retired-lifecycle resource may REAPPEAR either (a resurrecting cleanup would be its own
  // bug): any predecessor-only name present after the replay is a leak.
  const noResurrect = (pre: string[], succ: string[], post: string[]): boolean =>
    pre.every((n) => succ.includes(n) || !post.includes(n));
  check("witness: no retired predecessor resource reappeared after the replay",
    noResurrect(fp1.dm, fpS.dm, fpPost.dm) && noResurrect(fp1.dlv, fpS.dlv, fpPost.dlv) && noResurrect(fp1.acl, fpS.acl, fpPost.acl),
    { fp1, fpPost });
  check("witness: no manager-driven broker cleanup fired between respawn and replay (single deleter)",
    brokerCalls.length === callsBeforeReplay,
    brokerCalls.map(({ name, gated }) => ({ name, gated })));
  // Witnesses (green today AND under the fix): the replay is broker-only — it never touches the
  // ledger or the secret files, so the replacement's mint authority stays intact and its child
  // stays connected. The damage above is therefore SILENT split-brain: the manager lists a live,
  // authenticated agent that can no longer be delivered to (durables gone) and whose reads are no
  // longer authorized (ACL row gone).
  check("witness: replacement ledger row survives the replay (broker cleanup owns no local state)", fpPost.row, fpPost);
  check("witness: replacement row still carries the replacement's tokenHash", rowHash(OWNER) === hash2, { want: hash2, got: rowHash(OWNER) });
  const ex = await agentExchange(AGENT, replacementToken, OWNER);
  check("witness: replacement actor token still mints a bearer (exchange 200)", ex.status === 200 && typeof ex.body.token === "string", { status: ex.status, error: ex.body.error });
  check("witness: the manager still lists the replacement, child alive (the damage is silent)",
    manager.list().some((a: { name: string }) => a.name === AGENT) && newHandle?.status() === "running",
    { listed: listNames(), child: childDiag() });

  console.log(`\nFREESLOT RESPAWN BARRIER ${fail === 0 ? "OK ✅" : "RED ❌ (expected until the P2 alias reservation + lifecycle-keyed cleanup land)"}  (${pass} passed, ${fail} failed)`);
  if (fail) process.exitCode = 1;
} catch (e) {
  console.error("  ✗ scenario threw:", (e as Error).stack ?? (e as Error).message);
  process.exitCode = 1;
} finally {
  try { await manager?.stop(); } catch { /* already stopped */ }
  try { await delivery?.stop(); } catch { /* already stopped */ }
  if (authChild?.pid) { try { process.kill(authChild.pid, "SIGKILL"); } catch { /* gone */ } }
  if (broker?.pid) { try { process.kill(broker.pid, "SIGKILL"); } catch { /* gone */ } }
  await wait(300);
  for (const d of [home, root, jsDir]) if (d) rmSync(d, { recursive: true, force: true });
  process.exit(process.exitCode ?? 0);
}
