/**
 * INT-2 REVOKE-HOLD smoke — a failed user-mode ledger revoke must NOT free the name (a copied actor
 * token could still mint while the standing-authority row lives). POSIX-only (chmod fault injection).
 * Run: pnpm smoke:int2-revoke:live   (pnpm build first — Manager + the agent child load dist; needs
 * nats-server + node on PATH). Provenance: reuses the freeslot user-mode E2E scaffolding.
 *
 * Reuses the freeslot user-mode E2E scaffolding (real Manager + auth service + IdP + spawn/despawn/
 * exchange). C: chmod the managed-actors dir read-only so revokeAgent's rmSync throws EACCES, despawn
 * -> assert the name stays HELD (not "free for reuse"), the hold carries standingAuthorityLive + the
 * revoke-failure operator copy, and a same-name respawn is refused with the operator face. D: clear
 * the fault, re-drive the teardown -> the revoke succeeds, the row is deleted, the name frees.
 * FINDING: on the current tree the copied token's exchange is blocked by the DEEPER auth-plane gate
 * retirement (terminally-retired issuance gate), so the ledger-hold is a defense-in-depth belt over
 * the surviving row; "copied token mints" only reproduces if the RAIL retirement also fails.
 * GREEN on the current tree (fix present); pristine f6115a6 would free the name (RED). READ+RUN only.
 *
 * PHASES: A/B spawn a user-mode agent and capture a copied actor token; C chmod the managed-actor
 * ledger dir read-only so revokeAgent's rmSync throws EACCES, despawn, and assert the name stays HELD
 * with standingAuthorityLive + the revoke-failure operator copy, a same-name spawn refused with no
 * successor + the SAME hold, and the copied token blocked by the retired gate while its row still
 * lives; D clear the fault and recover through the DOCUMENTED public same-name spawn nudge (latched on
 * row-deleted + hold-cleared), then the alias is reusable. Reuses the freeslot user-mode scaffolding.
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

// POSIX-only: the revoke-failure is injected by chmod-ing the managed-actor ledger dir read-only so
// `revokeAgent`'s `rmSync` throws EACCES. Windows does not honor a directory's POSIX mode bits for the
// owner, so the fault would not arm; the INT-2 behavior under test is platform-independent and proven
// on POSIX, so a non-POSIX host skips rather than false-fails.
if (process.platform === "win32") {
  console.log("INT-2 REVOKE-HOLD SMOKE — SKIP on Windows (chmod-based revoke-fault injection is POSIX-only)");
  process.exit(0);
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

  // ================================================================================================
  // INT-2 — SWALLOWED revokeAgent: a failed user-mode ledger revoke must NOT free the name.
  // ================================================================================================
  const { chmodSync } = await import("node:fs");
  const mAny = manager as unknown as {
    opStop: (a: Record<string, unknown>, c: string, admin: boolean) => Promise<ControlReply>;
    deprovision: (a: { id: string; name: string; lifecycleUid: string; userOwner?: string }) => Promise<void>;
    ep: { ref: () => { id: string } };
    retiring: Map<string, { agentId: string; lifecycleUid: string; userOwner?: string; standingAuthorityLive?: boolean; lastError?: string }>;
  };
  const listNames = (): string[] => manager!.list().map((a: { name: string }) => a.name);

  // Capture the manager's despawn/terminal logs (console.error) so we can read the RED vs GREEN
  // terminal face directly ("name stays held" = GREEN; "free for reuse" = RED/pristine).
  const logs: string[] = [];
  const origErr = console.error.bind(console);
  console.error = ((...a: unknown[]) => { logs.push(a.map(String).join(" ")); origErr(...a); }) as typeof console.error;
  const waitLog = async (re: RegExp, ms: number): Promise<string | undefined> => {
    const end = Date.now() + ms;
    while (Date.now() < end) { const hit = logs.find((l) => re.test(l)); if (hit) return hit; await wait(100); }
    return logs.find((l) => re.test(l));
  };

  // ---------- C. inject a revokeAgent FAILURE, then despawn ----------
  console.log("C) capture the actor token; make the ledger revoke FAIL; despawn");
  // A copied actor token: while the standing-mint-authority row lives, it exchanges->mints a bearer.
  const predActorToken = readFileSync(join(credsDir, `${AGENT}.actor-token`), "utf8").trim();
  check("predecessor actor token captured (models a copied token)", predActorToken.length > 0);
  const exBefore = await agentExchange(AGENT, predActorToken, OWNER);
  check("baseline: the captured actor token exchanges->mints a bearer while the agent is live (200)",
    exBefore.status === 200 && typeof exBefore.body.token === "string", { status: exBefore.status, error: exBefore.body.error });

  // THE FAULT: revokeAgent -> revokeManagedActor -> rmSync(rowPath). A read-only managed-actors dir
  // makes that unlink EACCES, so revokeAgent THROWS and the standing-authority row is NOT deleted.
  const ledgerRowDir = managedActorLedgerDir(dir);
  chmodSync(ledgerRowDir, 0o500);
  check("fault armed: managed-actor ledger dir is read-only (revokeAgent's rmSync will throw EACCES)",
    existsSync(managedRowPath(OWNER)));

  const stopReply = await mAny.opStop({ name: AGENT, graceful: false }, mAny.ep.ref().id, true);
  check("despawn reply ok", stopReply.ok === true, stopReply);

  // Wait for the detached deprovision: revoke (throws) -> standingAuthorityLive stays true -> rail
  // retirement completes -> the terminal log tells us HELD vs FREED.
  const terminal = await waitLog(/not yet revoked|name stays held|free for reuse/i, 25000);
  console.log(`   manager terminal face: ${terminal ?? "(none within 25s)"}`);

  // GREEN 1: the standing-authority row SURVIVED the failed revoke.
  check("GREEN: the standing-mint-authority ledger row SURVIVED the failed revoke (still live)",
    existsSync(managedRowPath(OWNER)));
  // GREEN 2: the manager HELD the name (terminal face is 'stays held', NOT 'free for reuse').
  const heldFace = terminal !== undefined && /not yet revoked|name stays held/i.test(terminal);
  const freedFace = terminal !== undefined && /free for reuse/i.test(terminal);
  check("GREEN: after the rail retirement, the manager HELD the name (NOT 'free for reuse' = the RED/pristine face)",
    heldFace && !freedFace, { terminal });
  // GREEN 3: the hold carries standingAuthorityLive + the revoke-failure operator copy.
  const hold = mAny.retiring.get(AGENT);
  check("GREEN: the retiring hold keeps standingAuthorityLive=true with the revoke-failure operator copy",
    hold?.standingAuthorityLive === true && /standing mint authority could not be revoked/i.test(hold?.lastError ?? ""),
    hold ? { standingAuthorityLive: hold.standingAuthorityLive, lastError: hold.lastError } : "(no hold)");

  // GREEN 4: a same-name respawn is REFUSED with the operator face (and re-drives the teardown). The
  // hold must be UNCHANGED (same lifecycleUid) and NO successor managed record may appear under the
  // alias — a refusal that quietly kept a replacement, or an ABA hold swap, would both read as ok here
  // without these checks.
  const heldUidBeforeRespawn = mAny.retiring.get(AGENT)?.lifecycleUid;
  const respawn = await manager.startAgent({ name: AGENT, agent: "e2e", owner: OWNER });
  check("GREEN: a same-name spawn is REFUSED while the mint authority stands (alias not reassigned)",
    respawn.ok === false, respawn);
  check("GREEN: no successor managed record took the alias (the manager lists no live agent under the held name)",
    !manager.list().some((a: { name: string }) => a.name === AGENT), listNames());
  check("GREEN: the SAME hold is still in place after the refused respawn (unchanged lifecycleUid, no ABA swap)",
    mAny.retiring.get(AGENT)?.lifecycleUid === heldUidBeforeRespawn && heldUidBeforeRespawn !== undefined,
    { before: heldUidBeforeRespawn, after: mAny.retiring.get(AGENT)?.lifecycleUid });
  check("GREEN: the refusal reads as the operator face (reserved pending retirement + standing-authority revoke + retry NEXT)",
    /reserved pending retirement/i.test(respawn.error ?? "") && /standing-authority revoke/i.test(respawn.error ?? "") && /retry/i.test(respawn.error ?? ""),
    respawn.error);

  // THE STANDING AUTHORITY: after the failed revoke the ledger row is STILL LIVE (the residual the
  // hold narrows). FINDING: on the current tree the copied token's exchange is nonetheless REFUSED
  // — but by the DEEPER auth-plane truth (the rail retirement terminalized the issuance gate), NOT
  // by the ledger-row revoke. So the ledger-hold is a defense-in-depth BELT over the surviving row;
  // the mint is blocked by the retired gate. (The "copied token mints" RED only reproduces if the
  // RAIL retirement ALSO fails to retire the gate — a compounded fault, not the ledger-revoke-only case.)
  const exAfter = await agentExchange(AGENT, predActorToken, OWNER);
  check("the auth-plane gate (deeper truth) REFUSES the copied token's exchange (terminally retired issuance gate)",
    exAfter.status !== 200 && /terminally retired issuance gate|retired/i.test(exAfter.body.error ?? ""), { status: exAfter.status, error: exAfter.body.error });
  check("…and the standing-mint-authority ledger row is STILL LIVE (the residual the INT-2 hold narrows)",
    existsSync(managedRowPath(OWNER)));

  // ---------- D. clear the fault; the PUBLIC same-name-spawn nudge re-drives the revoke and frees ----------
  console.log("D) clear the fault; the DOCUMENTED same-name spawn nudge re-drives the teardown; the revoke succeeds and the name frees");
  chmodSync(ledgerRowDir, 0o700); // clear the fault: the revoke's rmSync can now succeed
  logs.length = 0;
  // The DOCUMENTED operator recovery path (NOT a private call): a same-name `cotal spawn` re-drives the
  // FULL teardown (deprovision -> revoke, now succeeding). It is REFUSED while the hold stands, but its
  // nudge clears the hold once the revoke lands. LATCH on the observable outcome (row deleted + hold
  // cleared), re-nudging via the public spawn each round, instead of a fixed sleep: the first rounds may
  // JOIN the stale in-flight teardown (revoke still failing under the just-cleared fault); once that
  // settles a FRESH nudge re-drives and succeeds. Deterministic, no magic wait.
  // Latch on the HOLD clearing — the reliable "predecessor teardown completed" signal. (The row path
  // is name-keyed, so a successor that takes the freed alias immediately re-mints a row at the same
  // path; row-absence is therefore NOT a stable signal — the predecessor's revoke is proven by the
  // hold clearing + the free-for-reuse log + the predecessor uid leaving the row, asserted below.)
  let nudges = 0;
  const cleared = await (async (ms = 25000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      await manager!.startAgent({ name: AGENT, agent: "e2e", owner: OWNER }); // public nudge (refused while held)
      nudges++;
      if (mAny.retiring.get(AGENT) === undefined) return true;
      await wait(500);
    }
    return mAny.retiring.get(AGENT) === undefined;
  })();
  check("GREEN: the public same-name-spawn nudge re-drove the revoke and CLEARED the hold (the alias is reusable)",
    cleared && mAny.retiring.get(AGENT) === undefined, { nudges });
  // The PREDECESSOR's standing-authority row was revoked: its uid no longer backs the alias (the row is
  // either absent, or already replaced by a successor's FRESH uid — the predecessor's is gone either way).
  const rowAfter = existsSync(managedRowPath(OWNER)) ? readFileSync(managedRowPath(OWNER), "utf8") : "";
  check("GREEN: the predecessor's standing-authority row was REVOKED (its uid no longer backs the alias)",
    heldUidBeforeRespawn !== undefined && !rowAfter.includes(heldUidBeforeRespawn), { rowPresent: rowAfter.length > 0, predUid: heldUidBeforeRespawn });
  check("GREEN: the manager logged the name FREE after the successful re-driven revoke ('free for reuse')",
    logs.some((l) => /free for reuse/i.test(l)), logs.slice(-4));
  // And the alias is genuinely reusable now: a same-name spawn takes the EXACT alias. A recovery-loop
  // nudge may already have spawned `worker` once the hold cleared; if not, do it here. Assert the EXACT
  // alias is live -- a suffixed sibling (worker-2) or an unrelated failure would BOTH leave the exact
  // alias absent from the roster, so this rejects both.
  if (!manager!.list().some((a: { name: string }) => a.name === AGENT))
    await manager!.startAgent({ name: AGENT, agent: "e2e", owner: OWNER });
  check("GREEN: a same-name spawn takes the EXACT alias after recovery (no suffix, no lingering reservation)",
    manager!.list().some((a: { name: string }) => a.name === AGENT), { live: listNames() });

  console.error = origErr;
  console.log(`\nINT-2 SWALLOWED-REVOKE ${fail === 0 ? "GREEN ✅ (fix present: failed revoke holds the name; retry re-drives)" : "RED ❌"}  (${pass} passed, ${fail} failed)`);
  if (fail) process.exitCode = 1;
} catch (e) {
  console.error("  ✗ scenario threw:", (e as Error).stack ?? (e as Error).message);
  process.exitCode = 1;
} finally {
  try { chmodSync(managedActorLedgerDir(dir), 0o700); } catch { /* best-effort restore before rm */ }
  try { await manager?.stop(); } catch { /* already stopped */ }
  try { await delivery?.stop(); } catch { /* already stopped */ }
  if (authChild?.pid) { try { process.kill(authChild.pid, "SIGKILL"); } catch { /* gone */ } }
  if (broker?.pid) { try { process.kill(broker.pid, "SIGKILL"); } catch { /* gone */ } }
  await wait(300);
  for (const d of [home, root, jsDir]) if (d) rmSync(d, { recursive: true, force: true });
  process.exit(process.exitCode ?? 0);
}
