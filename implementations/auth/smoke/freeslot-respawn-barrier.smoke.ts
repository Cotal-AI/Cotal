/**
 * FREESLOT RESPAWN BARRIER smoke (control-surface P1 gate). It proves by EXECUTION the
 * despawn/respawn contract that had previously only been established by code-read.
 *
 * THE RACE IT WAS WRITTEN AGAINST, described in the PAST tense because this tree no longer has it:
 *
 *   `freeSlot` freed the agent's name synchronously, then fired `deprovision` DETACHED. Its BROKER
 *   half (`deprovisionBroker`: the dm_/dlv_ durables and the read-ACL row, all keyed by (owner,
 *   actor-name)) ran after the first await, across a cred mint plus a fresh broker connection plus
 *   JS-API deletes. A same-name respawn that provisioned inside that window handed the
 *   REPLACEMENT's freshly minted broker footprint to the stale teardown, which deleted its durables
 *   and ACL row while the manager kept listing it as live.
 *
 * WHAT THIS TREE DOES INSTEAD, which is what the cells below execute. The name is NOT freed while
 * any teardown phase is in flight: the hold clears only after the standing-authority revoke and the
 * lifecycle retirement both confirm. The broker deletes are lifecycle-uid-pinned, so a stale or
 * replayed teardown for a retired incarnation is broker-denied against a same-name successor, whose
 * resource names embed a different uid (`Manager.deprovisionBroker`, SPEC 13.1). The three barrier
 * contracts below are what say so, by running.
 *
 * The BARRIER CONTRACT is the spec/plan acceptance timeline for terminal despawn (retire before
 * alias release; cleanup pinned to the retired lifecycle; detached cleanup = idempotent
 * reconciliation that can never resolve through the current alias occupant):
 *
 *   1. RESERVATION — while the predecessor's cleanup is pending, a same-name spawn must not
 *      yield a new live agent under the exact alias. Holds on this tree: the spawn is refused
 *      with the reserved-pending-retirement operator face (GREEN).
 *   2. LIFECYCLE KEYING — after retirement, the same-alias replacement's broker resources must
 *      be DISTINCT names from the predecessor's. Holds on this tree (GREEN).
 *   3. REPLAY SAFETY — re-delivering the predecessor's captured broker cleanup (the
 *      at-least-once world: crash recovery, redelivery, reconciliation retry) must leave the
 *      live replacement's footprint untouched. Holds on this tree (GREEN).
 *
 * MEASURED on this tree: 24 passed, 0 failed. All three barrier contracts above hold, so the P2
 * slice this suite was written to wait for has landed. It had been reading RED for a reason of its
 * own: phase D retried the respawn 20 times at 250ms, a ~5s budget, while the alias frees in two
 * stages that together take ~8s. Timed from the awaited teardown, the first ~1.0s is refused
 * RESERVED; from ~1.3s to ~7.0s the reservation has released but the predecessor's ADVISORY presence
 * row is still live, so uniqueName numbers the successor `worker-2` and the auth plane refuses that
 * name-form because `-` is the reserved principal name-form separator; the exact alias is taken at
 * ~8.0s. That second stage is bounded by the presence record's TTL plus one sweep tick (endpoint.ts:
 * ttlMs 6000, sweep every ttlMs/3), so the repair is a deadline budgeted past that ceiling, not a
 * product change. The numbered-name refusal inside the window is real and is tracked as #693 and
 * #667: for those few seconds the manager mints a name its own auth plane rejects, rather than the
 * reserved-pending-retirement face it gives in the first second. This suite no longer waits on it.
 * At this branch's merge-base the suite threw before its first cell, so its cells are newly VISIBLE
 * rather than newly caused. The suite is now GATED: it is in bin/smoke/ci-suites.txt, so a CI shard
 * runs it on every push. It was ungated for the month it could not start, which is how the retry
 * budget and the presence TTL drifted past each other with nothing to report it.
 *
 * All three are green under the landed P2 slice (alias reservation + lifecycle-keyed resources +
 * `(principal, lifecycleUid)`-pinned cleanup). The CONTRACT asserts need no edits for that; only
 * a mechanical rename is expected if P2 restructures the private `deprovisionBroker` seam this
 * harness wraps. The teardown's LOCAL half (creds/secret shred + ledger revoke) is asserted GREEN
 * throughout. NOT because it is synchronous: the ledger revoke is AWAITED and production says so
 * itself (`deprovisionBroker`'s doc: "the revoke is awaited and can be deliberately slow, so it is
 * not merely a synchronous prefix"). What holds it is the ORDER of the single-flighted chain, the
 * local half completing before the broker phase begins, plus `standingAuthorityLive`, which is set
 * before the revoke is attempted and RETAINED when it fails so the hold can never free the name
 * (`manager.ts` around the revoke; INT-2 runs that EACCES path). The replay is broker-only.
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
  type Command = import("@cotal-ai/core").Command;
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
  // The real contract, rather than a hand-written shape: `all` constrains its type argument to
  // Extension, which the inline shape did not satisfy because it omitted `kind`, and ParsedArgs is
  // exactly the values/positionals/raw triple this dispatcher already passes.
  const cmd = registry.all<Command>("command").find((c) => c.name === SUBCOMMAND);
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
const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } = await import("node:fs");

/** `Manager.list` is PRIVATE; the cells below read one field off the row `cotal ps` renders, so the
 *  reach goes through one named view rather than a cast per call site, and the view names that field
 *  and no other. Widening the method to public would be a shipped-source change made for a test's
 *  convenience, which is not this change's business. */
type PsRow = { name: string };
const psList = (m: object, ownerFilter?: string): PsRow[] =>
  (m as unknown as { list: (o?: string) => PsRow[] }).list(ownerFilter);
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
const { authDir, userAuthStateDir, saveSpaceAuth, recordMesh, assertUserAuthInfo, agentLifecycleSecretFilePaths, workspaceSecretStore } = await import("@cotal-ai/workspace");
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
const { pickFreePort } = await import("../../../packages/core/smoke/_free-port.js");
const PORT = await pickFreePort();
const SERVER = `nats://127.0.0.1:${PORT}`;
const SPACE = `fsb-${Math.floor(Math.random() * 1e6)}`;
const CLIENT_ID = "cotal-cli";
const AGENT = "worker";
const dir = userAuthStateDir(root, SPACE);
// The provider's SECRET seam. `prepareServer` and `ownerForLogin` both REQUIRE it (callout account,
// issuer keys, owner secret, service key projection all ride it); the calls below used to omit it,
// so the provider was reached with `store` undefined. Same workspace-rooted store the CLI composes.
const store = workspaceSecretStore(root);
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
    store,
    space: SPACE,
    operatorSeed: auth.operator.seed,
    account: { pub: auth.account.pub, signingSeed: auth.account.signingSeed },
    dir,
    idpUrl: base,
  });
  jsDir = mkdtempSync(join(tmpdir(), "cotal-fsb-js-"));
  writeFileSync(join(root, "server.conf"), serverConfig(auth, [auth], { transport: { kind: "plaintext" }, port: PORT, storeDir: jsDir, extraAccounts: prepared.extraAccounts }));
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
  const OWNER = await cotalAuthProvider.ownerForLogin({ store, dir, space: SPACE });
  grantActor(dir, { owner: OWNER, actor: "cli", scope: ["spawn", "role:worker"], allowSubscribe: ["general"], allowPublish: ["general"], label: "smoke operator" });

  // Broker-footprint inspectors. The checks ENUMERATE by principal PREFIX rather than binding one
  // exact resource name. The lifecycle-keyed rename has LANDED on this tree, so the names they
  // match already carry the uid (`dm_<owner>-<actor>-<lifecycleUid>`, built by `lifecycleNameKey`
  // in `subjects.ts`, SPEC 13.1); the prefix form is what let these asserts survive that rename
  // without being edited, and it is what keeps them standing through the next one.
  // Enumeration (`$JS.API.CONSUMER.LIST`) is deliberately grantable by NO
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
  // Hold the predecessor's broker teardown on a gate, deprovisionBroker ONLY, so the local half of
  // the teardown (creds/secret shred + the AWAITED ledger revoke) runs untouched at despawn time
  // exactly as in production, and only the phase that follows it is held. Instance-level wrap of the private method (runtime-visible; the repo's
  // smokes already reach into manager privates): the FIRST broker teardown for this agent name
  // parks until released; everything else passes through and is recorded so every deleter in play
  // stays attributable. The gated call's ARG is captured — section E replays it, modeling the
  // at-least-once redelivery of a retired lifecycle's cleanup that the lifecycle pinning makes
  // harmless.
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
  const listNames = (): string[] => psList(manager!).map((a) => a.name);

  const stopReply = await mAny.opStop({ name: AGENT, graceful: false }, mAny.ep.ref().id, true);
  check("despawn reply ok", stopReply.ok === true, stopReply);
  // The broker phase engages after freeSlot, with the creds/secret shred and the AWAITED ledger
  // revoke ahead of it in the same chain, so the delay is a real await and not a microtask hop.
  // Poll for the gate to be taken.
  for (let i = 0; i < 100 && !gatedRun; i++) await wait(20);
  check("the detached teardown reached its broker cleanup and is held on the gate",
    gatedRun !== undefined && predArg !== undefined);
  // The teardown's LOCAL half has already completed here, exactly as in production, because the
  // ledger revoke is AWAITED ahead of the broker phase rather than racing it. Asserting it keeps the
  // probe honest: the gate must not have deferred anything the real chain finishes first. An earlier
  // version of this comment and of the cell name below called that a "synchronous prefix", which is
  // the wrong mechanism and contradicted production's own note; a review caught it.
  check("predecessor row already revoked before the broker phase (gate held nothing local)",
    !existsSync(managedRowPath(OWNER)));

  // BARRIER 1 — while the predecessor's cleanup is pending, the alias must stay RESERVED: a
  // same-name spawn must not yield a NEW live agent under the exact alias (refusing loudly or
  // auto-numbering both satisfy it). Holds on this tree: the spawn is refused, and the companion
  // cell below pins that refusal to the reserved-pending-retirement operator face rather than to
  // the incidental numbered-name refusal that follows once the reservation releases.
  rmSync(join(root, "child-connected"), { force: true });
  const namesBeforeProbe = listNames();
  const probe: ControlReply = await manager.startAgent({ name: AGENT, agent: "e2e", owner: OWNER });
  const probeDelta = listNames().filter((n) => !namesBeforeProbe.includes(n));
  check("BARRIER: the alias is not reassignable while the predecessor's cleanup is pending",
    !probeDelta.includes(AGENT), { probeReply: probe, probeDelta });
  // ux follow-through 1: the refusal is the OPERATOR face, not a bare failure — it names the
  // reserved-pending-retirement state, bridges despawn→retirement, and gives the retry NEXT.
  check("BARRIER: the refusal reads as the operator face (reserved pending retirement + despawn→retirement bridge + retry NEXT)",
    probe.ok === false && /reserved pending retirement/i.test(probe.error ?? "")
    && /despawn started/i.test(probe.error ?? "") && /retry/i.test(probe.error ?? ""), probe);
  // Clear whatever the probe created and let its own cleanup fully settle so it cannot confound
  // section E. On this tree the probe is refused outright and creates nothing, so probeDelta is
  // empty and this loop is a no-op; it stays as a guard, because a tree that DID hand out a live
  // agent or an auto-numbered sibling here would otherwise carry it into section E.
  for (const n of probeDelta) await mAny.opStop({ name: n, graceful: false }, mAny.ep.ref().id, true);
  await Promise.allSettled(brokerCalls.filter((c) => !c.gated).map((c) => c.done.catch(() => {})));

  // Release: let the predecessor's retirement complete, which is what the manager does before it
  // frees the alias.
  releaseGate();
  await gatedRun!.catch(() => {});
  // Witness (leak direction): the predecessor's broker footprint must be fully retired before the
  // alias is handed to a replacement, the retire-before-free half of the contract. The deletes are
  // lifecycle-uid-pinned rather than name-keyed, so this asserts the PREDECESSOR's own footprint is
  // gone, not that a name sweep took everything under the alias.
  const fpRetired = await footprint();
  check("witness: the predecessor's broker footprint is fully retired before the alias frees",
    fpRetired.dm.length === 0 && fpRetired.dlv.length === 0 && fpRetired.acl.length === 0, fpRetired);

  // ---------- D. the replacement: same-alias respawn AFTER retirement completed ----------
  console.log("D) same-alias respawn after the predecessor retired");
  rmSync(join(root, "child-connected"), { force: true });
  // Retry to a DEADLINE rather than for a fixed number of tries: the alias frees in two stages and
  // the second stage is a timer. Timed from the awaited teardown on this tree, the first ~1.0s is
  // refused RESERVED (the reservation still holds the name); from ~1.3s to ~7.0s the reservation has
  // released but the predecessor's ADVISORY presence row is still live, so uniqueName numbers the
  // successor and the auth plane refuses that name-form; the exact alias is taken at ~8.0s. That
  // second stage is bounded by the presence record's TTL plus one sweep tick (endpoint.ts: ttlMs
  // 6000, sweep every ttlMs/3), so the old 20-try/250ms budget of ~5s expired inside it and read as
  // a failure. Budget past that ceiling with room for a loaded runner. An auto-numbered stand-in is
  // never accepted, because the contract is about THE alias, so a stray sibling is stopped and the
  // spawn retried.
  const respawnDeadline = Date.now() + 30_000;
  let r2: ControlReply | undefined;
  do {
    const before = listNames();
    r2 = await manager.startAgent({ name: AGENT, agent: "e2e", owner: OWNER });
    const delta = listNames().filter((n) => !before.includes(n));
    if (r2.ok === true && delta.includes(AGENT)) break;
    for (const n of delta) await mAny.opStop({ name: n, graceful: false }, mAny.ep.ref().id, true);
    await wait(250);
  } while (Date.now() < respawnDeadline);
  check("same-alias respawn ok after the predecessor retired", r2?.ok === true && listNames().includes(AGENT), r2);
  // ux follow-through 1: the clean respawn reads as a FRESH spawn of THE alias — never an
  // auto-numbered stand-in, never a lingering refusal string.
  check("the respawn took the EXACT alias (a fresh spawn, not a suffixed sibling or a leftover refusal)",
    listNames().includes(AGENT) && r2?.ok === true && !/reserved pending retirement/i.test(JSON.stringify(r2 ?? {})), r2);
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
  // The manager files the actor token lifecycle-keyed (`<name>.<uid>.actor-token`); recover the
  // successor's uid from disk (the retired predecessor's file is already gone) to read its token.
  const succUid = (() => {
    const re = new RegExp(`^${AGENT}\\.([a-z0-9]{26,32})\\.actor-token$`);
    for (const f of readdirSync(credsDir)) { const m = re.exec(f); if (m) return m[1]; }
    throw new Error(`no incarnation actor-token on disk for ${AGENT} in ${credsDir}`);
  })();
  const replacementToken = readFileSync(agentLifecycleSecretFilePaths(root, AGENT, succUid).actorToken, "utf8").trim();
  // BARRIER 2 — lifecycle keying: the replacement's broker resources must be DISTINCT names from
  // the predecessor's, or any stale/replayed cleanup for the retired lifecycle can resolve to the
  // replacement's rows. Holds on this tree: the successor's resources are lifecycle-keyed and
  // disjoint from the predecessor's.
  const distinct = (pre: string[], succ: string[]): boolean => succ.length > 0 && succ.every((n) => !pre.includes(n));
  check("BARRIER: the replacement's broker resources are lifecycle-distinct from the predecessor's",
    distinct(fp1.dm, fpS.dm) && distinct(fp1.dlv, fpS.dlv) && distinct(fp1.acl, fpS.acl),
    { predecessor: { dm: fp1.dm, dlv: fp1.dlv, acl: fp1.acl }, successor: { dm: fpS.dm, dlv: fpS.dlv, acl: fpS.acl } });
  const callsBeforeReplay = brokerCalls.length;

  // ---------- E. THE REPLAY ----------
  // Deliver the predecessor's captured broker cleanup AGAIN, now that the replacement is live —
  // the at-least-once world this has to survive: detached cleanup is idempotent reconciliation
  // against the RETIRED lifecycle and can never resolve through the current alias occupant.
  // Holds on this tree: the cleanup is pinned to the retired lifecycle, so the replay leaves the
  // live replacement's footprint intact. Proven non-vacuous rather than assumed: repointing the
  // replayed cleanup at the SUCCESSOR's lifecycle uid deletes its resources and reds exactly the
  // three named BARRIER cells (dm durable, dlv durable, read-ACL), so these cells are not green
  // merely because an unobserved no-op ran.
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
  // Witnesses: the replay is broker-only. It never touches the ledger or the secret files, so the
  // replacement's mint authority stays intact and its child stays connected either way. That is
  // what makes the barrier cells above the whole story, and it is why their failure mode would be
  // SILENT split-brain rather than a visible outage: a tree whose replay reached the successor
  // would leave the manager listing a live, authenticated agent that could no longer be delivered
  // to (durables gone) and whose reads were no longer authorized (ACL row gone), with nothing
  // failing loudly. On this tree the replay is lifecycle-pinned and those cells pass.
  check("witness: replacement ledger row survives the replay (broker cleanup owns no local state)", fpPost.row, fpPost);
  check("witness: replacement row still carries the replacement's tokenHash", rowHash(OWNER) === hash2, { want: hash2, got: rowHash(OWNER) });
  const ex = await agentExchange(AGENT, replacementToken, OWNER);
  check("witness: replacement actor token still mints a bearer (exchange 200)", ex.status === 200 && typeof ex.body.token === "string", { status: ex.status, error: ex.body.error });
  check("witness: the manager still lists the replacement, child alive (the damage is silent)",
    psList(manager).some((a) => a.name === AGENT) && newHandle?.status() === "running",
    { listed: listNames(), child: childDiag() });

  console.log(`\nFREESLOT RESPAWN BARRIER ${fail === 0 ? "OK ✅" : "RED ❌"}  (${pass} passed, ${fail} failed)`);
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
