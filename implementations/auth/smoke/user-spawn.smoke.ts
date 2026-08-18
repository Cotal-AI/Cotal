/**
 * USER-MODE SPAWN live smoke (gate-1, the managed-agent end-to-end) — the whole "a logged-in
 * operator spawns a detached agent on a user-auth mesh" story, driven against a REAL broker (callout
 * account preloaded), the REAL auth-service daemon (a killable subprocess), a REAL Better Auth IdP,
 * and the REAL {@link Manager} class IN-PROCESS (so the in-process `e2e` connector + the auth provider
 * share one registry; the spawned "agent" is a genuine long-lived node child through the real pty
 * runtime, connecting user-mode with a bearer SOURCE that execs its refresh command).
 *
 *  A. Setup: user-auth broker + streams + the auth-service daemon; a device login; the interactive
 *     `cli` actor granted (scope [spawn]).
 *  B. Detached user-mode spawn: Manager.startAgent grants a MANAGED-actor row (tokenHash), provisions
 *     the sentinel/token/health files + bearer command, preflights it, launches — and the child JOINS
 *     presence as the `owner.actor` principal (witnessed via an observer on the operator's own user bearer).
 *  C. Exchange-mode confinement: an IdP proof for the managed name is refused ("managed agent"), the
 *     interactive grant path refuses to shadow it, and a token-hash forged into the interactive row
 *     fails closed.
 *  D. Agent exchange + live-expiry: a direct `{ owner, actorToken, ttlSec:10 }` exchange mints a bearer;
 *     a raw endpoint opened with it connects and then DIES at the bearer-bound JWT expiry (~10s).
 *  E/G. Health + heal + preflight refusal: kill the auth service — the agent's own bearer command fails
 *     with the `cotal up` recovery (health file → failed; `ps` → auth-renewal-failed) and a fresh spawn
 *     is refused at preflight with the row rolled back; restart it — the bearer command heals and `ps`
 *     is auth-clean again.
 *  F. Revocation: manager teardown deletes the managed row + shreds the token/sentinel/health files, and
 *     the OLD captured actor token is thereafter uniformly denied (401).
 *
 * COTAL_HOME + the workspace root are sandboxed to temp dirs; kills ONLY the pids it starts (NEVER
 * pkill nats-server). Needs nats-server on PATH. Run: pnpm smoke:user-spawn:live  (pnpm build first —
 * the pty-launched agent child imports @cotal-ai/core from dist).
 */

// ---------- SELF-DISPATCH (must be the FIRST thing that runs) ----------
// The manager builds the agent's bearer argv from `process.argv[1]` — which, in this in-process smoke,
// is THIS file. So when the manager (or the spawned agent) execs the bearer command, it re-execs this
// smoke with "agent-bearer" as argv[2]; the smoke ITSELF also re-execs itself to run the long-lived
// "auth-service" daemon. Intercept both here, resolve the real command from the core registry, run it
// with a minimally-parsed ParsedArgs, and exit — before the heavy harness below ever loads.
const SUBCOMMAND = process.argv[2] ?? "";
if (SUBCOMMAND === "agent-bearer" || SUBCOMMAND === "auth-service") {
  await import("@cotal-ai/auth"); // self-registers `agent-bearer` / `auth-service` (+ the provider) into the registry
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
    await cmd.run({ values, positionals, raw: rest }); // agent-bearer prints its bearer + returns; auth-service never returns
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

const { spawn, execFile } = await import("node:child_process");
const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } = await import("node:fs");
const { tmpdir } = await import("node:os");
const { join } = await import("node:path");

const home = mkdtempSync(join(tmpdir(), "cotal-uspawn-home-"));
process.env.COTAL_HOME = home;
const root = mkdtempSync(join(tmpdir(), "cotal-uspawn-root-"));

const { betterAuth } = await import("better-auth");
const { memoryAdapter } = await import("better-auth/adapters/memory");
const { jwt } = await import("better-auth/plugins/jwt");
const { deviceAuthorization } = await import("better-auth/plugins/device-authorization");
const { bearer: baBearer } = await import("better-auth/plugins/bearer");
const { toNodeHandler } = await import("better-auth/node");
const { createServer } = await import("node:http");
type AddressInfo = import("node:net").AddressInfo;

const {
  CotalEndpoint, createSpaceAuth, isReachable, mintCreds, newIdentity, serverConfig,
  setupSpaceStreams, principalKey, registry, spaceWildcard, clearChannel, mintLifecycleUid, eventChannel,
  resolveService, invokeCommand, standaloneConnectOpts, EpEnvelopeError,
  mintMembershipObserverCreds, observePlaneLivenessWithCreds,
} = await import("@cotal-ai/core");
const { connect: rawConnect } = await import("@nats-io/transport-node");
const { decodeJwt } = await import("jose");
const { authDir, userAuthStateDir, saveSpaceAuth, recordMesh, assertUserAuthInfo, workspaceSecretStore, agentLifecycleSecretFilePaths } = await import("@cotal-ai/workspace");
const {
  cotalAuthProvider, establishIdpSession, fetchIdpJwt, grantActor, loadCalloutAuth, loadAuthServiceInfo,
  actorLedgerDir, managedActorLedgerDir, ledgerRowFilename, deriveOwnerForIdpSubject, loadOwnerSecret, loadPinnedIdp,
} = await import("@cotal-ai/auth");
// @cotal-ai/manager + @cotal-ai/connector-core are not deps of @cotal-ai/auth. Drive the REAL Manager
// from its built dist by relative path (shares the one @cotal-ai/core registry instance — dist — so the
// in-process `e2e` connector + the auth provider are visible to it); inline the tiny launch-env mapping
// @cotal-ai/connector-core's userAuthEnv would otherwise supply.
const { Manager } = await import("../../manager/dist/index.js");
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
/** OS env the child (and its tsx-loaded agent-bearer re-exec) needs (connector-core's launchEnv, trimmed). */
function launchEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of ["PATH", "HOME", "TMPDIR", "TMP", "TEMP", "XDG_CACHE_HOME", "LANG", "TERM"]) {
    const v = process.env[k];
    if (v) out[k] = v;
  }
  return out;
}
type DeviceLoginPrompt = import("@cotal-ai/auth").DeviceLoginPrompt;

const withTimeout = <T,>(p: Promise<T>, ms: number, msg: string): Promise<T> =>
  Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error(msg)), ms))]);
let pass = 0, fail = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ FAIL: ${name}`, extra ?? ""); }
};
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (cond: () => boolean, ms = 8000): Promise<boolean> => {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await wait(100);
  return cond();
};

const SELF = process.argv[1]; // this smoke file — the bearer/auth-service re-exec target (matches the manager's argv[1])
const { pickFreePort } = await import("./_free-port.js");
const PORT = await pickFreePort();
const SERVER = `nats://127.0.0.1:${PORT}`;
const SPACE = `uspawn-${Math.floor(Math.random() * 1e6)}`;
const CLIENT_ID = "cotal-cli";
const dir = userAuthStateDir(root, SPACE); // the provider's space-scoped state dir (ledger, pin, discovery)
const store = workspaceSecretStore(root); // the secret kinds ride the seam, keyed auth/<space>/…
const credsDir = join(authDir(root), "creds");
// The manager files each incarnation's user secrets lifecycle-keyed (`<name>.<uid>.<kind>`).
// Recover the uid from the token/sentinel already on disk, then derive the whole family (so a
// not-yet-written health file still resolves to the right path); `noIncFiles` asserts a name has NO
// incarnation secrets left (for rollback/teardown "gone" checks, uid-agnostic).
const incUid = (name: string): string => {
  const re = new RegExp(`^${name}\\.([a-z0-9]{26,32})\\.(actor-token|sentinel\\.creds)$`);
  for (const f of readdirSync(credsDir)) { const m = re.exec(f); if (m) return m[1]; }
  throw new Error(`no incarnation secret on disk for ${name} in ${credsDir}`);
};
const incFiles = (name: string) => agentLifecycleSecretFilePaths(root, name, incUid(name));
const noIncFiles = (name: string): boolean => {
  const re = new RegExp(`^${name}\\.[a-z0-9]{26,32}\\.`);
  return !readdirSync(credsDir).some((f) => re.test(f));
};
const coreDist = join(import.meta.dirname, "..", "..", "..", "packages", "core", "dist", "index.js");

// The agent CHILD: a REAL long-lived node process through the REAL pty runtime, connecting USER-MODE
// with a bearer SOURCE (execs COTAL_BEARER_CMD for each token) + the sentinel creds — the exact wire
// contract configFromEnv/agent.ts parse from the four COTAL_* vars the manager forwards.
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
      ...launchEnv(),        // OS allow-list (PATH/HOME/TMPDIR/…) — the agent-bearer re-exec runs under tsx
      ...userAuthEnv(o),     // COTAL_OWNER / COTAL_ACTOR / COTAL_SENTINEL_CREDS / COTAL_BEARER_CMD (all-or-nothing)
      CORE_DIST: coreDist,
      COTAL_SPACE: o.space,
      COTAL_NAME: o.name,
      COTAL_SERVERS: o.servers ?? "",
      // The manager mints one lifecycle uid per spawn; the register-only agent child binds by it
      // (an authed presence-registering agent proves its lifecycle before presence, SPEC 13.1).
      ...(o.lifecycleUid ? { COTAL_LIFECYCLE_UID: o.lifecycleUid } : {}),
    },
  }),
};
registry.register(e2eCon);

// A connector whose buildLaunch THROWS after the manager has already provisioned the user grant —
// exercises the post-provision failure window the freelance found leaking the managed row + files.
const e2eFailCon: Connector = {
  kind: "connector",
  name: "e2e-fail",
  requires: ["node"],
  buildLaunch: (): LaunchSpec => { throw new Error("e2e-fail: buildLaunch deliberately rejects this launch"); },
};
registry.register(e2eFailCon);

// ---------- the real Better Auth IdP (device-code, auto-approved) ----------
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
const userId = signup.response.user.id;
async function approve(userCode: string): Promise<void> {
  const claim = await fetch(`${base}/device?user_code=${encodeURIComponent(userCode)}`, { headers: { cookie, origin } });
  if (!claim.ok) throw new Error(`device claim failed: HTTP ${claim.status}`);
  const res = await fetch(`${base}/device/approve`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie, origin },
    body: JSON.stringify({ userCode }),
  });
  if (!res.ok) throw new Error(`device/approve failed: HTTP ${res.status}`);
}

// ---------- helpers over the auth-service daemon (a killable subprocess) ----------
function spawnAuthService(): ChildProcess {
  // Re-exec THIS file (tsx) → the self-dispatch runs the real `auth-service` command. cwd=root so the
  // daemon's findCotalRoot() resolves the space-scoped state dir; ephemeral port (it writes its bound
  // url+pid+cap into the discovery file).
  return spawn(process.execPath, [...process.execArgv, SELF, "auth-service", "--space", SPACE, "--server", SERVER], {
    cwd: root,
    env: { ...process.env, COTAL_HOME: home },
    stdio: process.env.SMOKE_AUTH_SERVICE_DEBUG ? ["ignore", "inherit", "inherit"] : "ignore",
  });
}
async function waitAuthReady(ms = 15000): Promise<{ url: string; pid: number; cap: string }> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const info = loadAuthServiceInfo(dir);
    if (info) {
      let alive = false;
      try { process.kill(info.pid, 0); alive = true; } catch { /* not up yet */ }
      if (alive) { try { const r = await fetch(`${info.url}/health`); if (r.ok) return info; } catch { /* not bound yet */ } }
    }
    await wait(150);
  }
  throw new Error(`auth service did not become ready under ${dir} in ${ms}ms`);
}
async function killPid(pid: number | undefined): Promise<void> {
  if (!pid) return;
  try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
  await until(() => { try { process.kill(pid, 0); return false; } catch { return true; } }, 5000);
}
function execBearer(argv: string[]): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return new Promise((res) => {
    execFile(argv[0], argv.slice(1), { timeout: 30_000, maxBuffer: 1 << 20 }, (err, stdout, stderr) =>
      res({ ok: !err, stdout: stdout.toString(), stderr: stderr.toString() }));
  });
}
// The manager composes the agent's bearer argv exactly like this (execPath + tsx loader flags + this
// file + agent-bearer + the four grant coordinates); recompose it to drive the agent's OWN refresh.
const bearerArgvFor = (actor: string) => [
  process.execPath, ...process.execArgv, SELF, "agent-bearer",
  "--dir", dir, "--space", SPACE, "--owner", "", "--actor", actor,
  "--token-file", incFiles(actor).actorToken,
  "--health-file", incFiles(actor).health,
];
const rowFile = (space: "interactive" | "managed", owner: string, actor: string) =>
  join(space === "interactive" ? actorLedgerDir(dir) : managedActorLedgerDir(dir), ledgerRowFilename(owner, actor));
async function agentExchange(actor: string, actorToken: string, owner: string, ttlSec?: number): Promise<{ status: number; body: { token?: string; error?: string } }> {
  const info = loadAuthServiceInfo(dir)!;
  const res = await fetch(`${info.url}/exchange`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${info.cap}` },
    body: JSON.stringify({ owner, actor, actorToken, ...(ttlSec !== undefined ? { ttlSec } : {}) }),
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as { token?: string; error?: string } };
}

let manager: InstanceType<typeof Manager> | undefined;
let broker: ChildProcess | undefined;
let authChild: ChildProcess | undefined;
let managerStopped = false;
let observer: InstanceType<typeof CotalEndpoint> | undefined;
let shortEp: InstanceType<typeof CotalEndpoint> | undefined;
const ctlEps: Array<InstanceType<typeof CotalEndpoint>> = []; // section O control callers, closed in finally
try {
  // ---------- A. setup ----------
  console.log("A) user-auth broker + streams + auth service + login + grant");
  const auth = await createSpaceAuth(SPACE);
  saveSpaceAuth(authDir(root), auth); // the pre-flip manager still needs the space trust bundle
  // Provision all user-auth material (callout/issuer/owner-secret/idp/service-keys) + get the callout
  // account the broker must preload.
  const prepared = await cotalAuthProvider.prepareServer({
    space: SPACE,
    operatorSeed: auth.operator.seed,
    account: { pub: auth.account.pub, signingSeed: auth.account.signingSeed },
    store,
    dir,
    idpUrl: base,
  });
  const jsDir = mkdtempSync(join(tmpdir(), "cotal-uspawn-js-"));
  writeFileSync(join(root, "server.conf"), serverConfig(auth, [auth], { transport: { kind: "plaintext" }, port: PORT, storeDir: jsDir, extraAccounts: prepared.extraAccounts }));
  broker = spawn("nats-server", ["-c", join(root, "server.conf")], { stdio: "ignore" });
  let up = false;
  for (let i = 0; i < 50 && !up; i++) { up = await isReachable(SERVER); if (!up) await wait(200); }
  check("user-auth broker is reachable", up);
  await setupSpaceStreams({ servers: SERVER, space: SPACE, creds: await mintCreds(auth, newIdentity(), "provisioner") });
  // Record the mesh mode "user" — Manager.start() cross-checks the registry against the on-disk marker.
  recordMesh({ space: SPACE, server: SERVER, root, mode: "user", userAuth: assertUserAuthInfo(prepared.publicAuth), ts: new Date().toISOString() });
  // Personas (identity + file ACL) for the two spawns.
  mkdirSync(join(root, ".cotal", "agents"), { recursive: true });
  for (const n of ["alpha", "beta", "delta"])
    writeFileSync(join(root, ".cotal", "agents", `${n}.md`), `---\nname: ${n}\nrole: worker\nsubscribe: [general]\nallowPublish: [general]\n---\n${n} persona.\n`);
  // `epsilon` and `zeta` carry NO role on purpose: section E asks what a peer may delegate on the EVENT
  // PLANE, and a role is itself a delegated capability, so a `role: worker` persona would be
  // refused for the role before the channel was ever weighed and the cell would read as a pass.
  for (const n of ["epsilon", "zeta"])
    writeFileSync(join(root, ".cotal", "agents", `${n}.md`), `---\nname: ${n}\nsubscribe: [general]\nallowPublish: [general]\n---\n${n} persona.\n`);

  authChild = spawnAuthService();
  await waitAuthReady();
  check("auth service is up (discovery file + /health)", !!loadAuthServiceInfo(dir));

  const { sub } = await establishIdpSession({
    dir: home, idpUrl: base, clientId: CLIENT_ID,
    onPrompt: (p: DeviceLoginPrompt) => void approve(p.userCode),
  });
  check("device login established (sub = the signed-up user)", sub === userId, { sub, userId });
  // The REAL spawn-path owner resolution — ownerForLogin reads `sub` back OUT OF THE CACHE FILE
  // (the cross-process path both spawn entry points ride; this smoke found the save/load path
  // dropping `sub`, which broke it in production while every in-process test passed). Cross-check
  // it against the direct derivation the server uses at exchange time — they must be the same bytes.
  const OWNER = await cotalAuthProvider.ownerForLogin({ store, dir, space: SPACE });
  const idpPin = loadPinnedIdp(dir)!;
  check(
    "ownerForLogin (cache round-trip) == exchange-time derivation",
    OWNER === deriveOwnerForIdpSubject((await loadOwnerSecret(store, SPACE))!, idpPin.issuer, sub),
    { OWNER },
  );
  // The cli alias keeps ONE lifecycle for the whole run: every later scope change upserts with
  // this same uid — a bare upsert would rotate it, and the issuance takeover barrier (R1)
  // refuses minting under a rotated grant while the predecessor lifecycle is active.
  const cliRow0 = grantActor(dir, { owner: OWNER, actor: "cli", scope: ["spawn"], allowSubscribe: ["general"], allowPublish: ["general"], label: "smoke operator" });
  check("interactive cli actor granted (scope [spawn])", existsSync(rowFile("interactive", OWNER, "cli")));

  // ---------- B. detached user-mode spawn ----------
  console.log("B) Manager.startAgent (user mode) → managed grant + presence join as the principal");
  manager = new Manager({ space: SPACE, servers: SERVER, runtime: "pty", workspaceRoot: root });
  await manager.start();
  const alphaPrincipal = principalKey(OWNER, "alpha").key;
  const spawnReply: ControlReply = await manager.startAgent({ name: "alpha", agent: "e2e", owner: OWNER });
  check("detached user-mode spawn reply ok (joined the mesh as the principal id)", spawnReply.ok === true, spawnReply);
  // The managed-actor row exists, in ITS OWN row space, carrying the sha256 secret hash.
  let managedRow: { tokenHash?: string } = {};
  const managedRowPath = rowFile("managed", OWNER, "alpha");
  try { managedRow = JSON.parse(readFileSync(managedRowPath, "utf8")); } catch { /* missing */ }
  check("a managed-actors row exists with a 64-hex tokenHash", typeof managedRow.tokenHash === "string" && /^[0-9a-f]{64}$/.test(managedRow.tokenHash), managedRow.tokenHash);
  const alphaToken = readFileSync(incFiles("alpha").actorToken, "utf8").trim(); // capture for D + F
  // Witness the presence join on the OPERATOR's OWN user bearer (login → exchange → connect), watching the roster.
  const opCreds = await cotalAuthProvider.userCredentials({ store, dir, space: SPACE, actor: "cli" });
  observer = new CotalEndpoint({
    space: SPACE, servers: SERVER, bearer: opCreds.bearer, sentinelCreds: opCreds.sentinelCreds,
    channels: [], consume: false, registerPresence: false, watchPresence: true,
    card: { name: "observer", kind: "endpoint" },
  });
  observer.on("error", () => {});
  await observer.start();
  const seen = await until(() => observer!.getRoster().some((p) => p.card.id === alphaPrincipal && p.card.name === "alpha"));
  check("observer (operator user bearer) sees alpha join as the owner.actor principal", seen, observer.getRoster().map((p) => p.card.id));
  const listed = manager.list().find((a) => a.name === "alpha");
  check("manager ps lists alpha under its principal id, mesh live", listed?.id === alphaPrincipal && listed?.mesh !== "absent", listed);

  // ---------- B1e. the v0.4 ep rails under a USER bearer (1c.2c) ----------
  // The manager REGISTERS its service on this user mesh (the mode-neutral 1c.2c flip), the cli
  // actor's callout-minted rows carry the spawn set + baseline, and the bearer's ledger lifecycle
  // claim is the caller triple's uid - the whole user-mode generic-invoke chain, live.
  console.log("B1e) the user bearer rides the manager's v0.4 service (registered on this USER mesh)");
  {
    const bearerClaims = JSON.parse(Buffer.from(opCreds.bearer.split(".")[1], "base64url").toString("utf8")) as { sub: string; act: { actor: string; lifecycleUid: string } };
    const epCaller = { owner: bearerClaims.sub, actor: bearerClaims.act.actor, uid: bearerClaims.act.lifecycleUid };
    // `tls: false` is REQUIRED, not decorative: this file is outside every tsconfig, so the guard
    // in `standaloneConnectOpts` is the only thing that reaches it, and it throws rather than
    // defaulting. SERVER is a plaintext local broker, the same value its two sibling auth smokes
    // pass. Without it this line threw and took every cell below it with it.
    const epNc = await rawConnect({ servers: SERVER, ...standaloneConnectOpts({ bearer: opCreds.bearer, sentinelCreds: opCreds.sentinelCreds, tls: false }), maxReconnectAttempts: 0 });
    try {
      const svc = await resolveService(epNc, SPACE, "manager", epCaller, { deadlineMs: 10_000 });
      check("user bearer resolves the manager generically (describe + store fetch + digest-verified recompile, all over the bearer)",
        svc.commands.size === 18 && svc.responder.instanceId.length > 0, { size: svc.commands.size, responder: svc.responder });
      const ri = await invokeCommand(epNc, SPACE, svc, "inspect", { name: "alpha" }, {});
      check("user bearer invokes `inspect` over ep (a spawn-set row; describe-bound currency, no epoch stub)",
        ri.reply.ok === true && (ri.reply.data as { name: string }).name === "alpha", ri.reply);
      let refused: string | undefined;
      try {
        const rp = await invokeCommand(epNc, SPACE, svc, "ps", undefined, { deadlineMs: 2500 });
        refused = rp.reply.ok === false ? rp.reply.error?.code : "SERVED-OK";
      } catch (e) {
        refused = e instanceof EpEnvelopeError ? e.code : String(e);
      }
      check("a spawn-scope bearer's `ps` is broker-dropped (manager.read is not in the spawn set - the ep tier boundary holds on a user mesh)",
        refused === "deadline-exceeded" || refused === "unavailable", refused);
    } finally {
      await epNc.drain().catch(() => epNc.close());
    }
  }

  // ---------- B2. delegation attenuation (the ENVELOPE rule, end to end) ----------
  console.log("B2) a spawner-attributed spawn is attenuated to the spawner's own grant");
  // The cli grant is [general] + scope [spawn]: an imperative over-ask (`spawn --allow-subscribe`
  // beyond the spawner's own read ACL — the exact escalation vector) must be refused at the grant
  // write, name the operator's widening re-grant, and leave no row behind.
  const overReply: ControlReply = await manager.startAgent(
    { name: "delta", agent: "e2e", allowSubscribe: ["general", "ops.secret"] }, `${OWNER}.cli`);
  check("an over-envelope spawn is refused (read beyond the spawner's [general])",
    overReply.ok === false && /delegation only narrows/.test(overReply.error ?? ""), overReply);
  check("…the refusal names the exact widening re-grant", /cotal actor grant cli --owner/.test(overReply.error ?? ""), overReply.error);
  check("…and left no managed row", !existsSync(rowFile("managed", OWNER, "delta")));
  // The delta persona carries `role: worker` — a ROLE is receive reach on the shared task queue,
  // so it too is delegated: refused until the spawner's scope carries `role:worker`.
  const roleReply: ControlReply = await manager.startAgent(
    { name: "delta", agent: "e2e", allowSubscribe: ["general"] }, `${OWNER}.cli`);
  check("a persona ROLE outside the spawner's scope is refused (role = delegated capability)",
    roleReply.ok === false && /role "worker" beyond scope/.test(roleReply.error ?? ""), roleReply);
  grantActor(dir, { owner: OWNER, actor: "cli", scope: ["spawn", "role:worker"], allowSubscribe: ["general"], allowPublish: ["general"], label: "smoke operator", lifecycleUid: cliRow0.lifecycleUid });
  const withinReply: ControlReply = await manager.startAgent(
    { name: "delta", agent: "e2e", allowSubscribe: ["general"] }, `${OWNER}.cli`);
  check("the same spawn within the envelope (read + role delegated) succeeds", withinReply.ok === true, withinReply);
  const deltaRow = JSON.parse(readFileSync(rowFile("managed", OWNER, "delta"), "utf8")) as { parent?: string };
  check("the delegated row records the spawner as parent", deltaRow.parent === `${OWNER}.cli`, deltaRow);

  // ---------- C. exchange-mode confinement ----------
  console.log("C) a managed agent is NOT IdP-exchangeable, cannot be shadowed, and fails closed on tamper");
  const idpJwt = await fetchIdpJwt(base, (await establishIdpSession({ dir: home, idpUrl: base, clientId: CLIENT_ID, onPrompt: (p) => void approve(p.userCode) })).session.token);
  const info0 = loadAuthServiceInfo(dir)!;
  const humanEx = await fetch(`${info0.url}/exchange`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${info0.cap}` },
    body: JSON.stringify({ idpToken: idpJwt, actor: "alpha" }),
  });
  const humanExBody = (await humanEx.json().catch(() => ({}))) as { error?: string };
  check("an IdP proof for the MANAGED actor name is refused 401 (names 'managed agent')", humanEx.status === 401 && /managed agent/.test(humanExBody.error ?? ""), { status: humanEx.status, error: humanExBody.error });
  let grantThrew = "";
  try { grantActor(dir, { owner: OWNER, actor: "alpha", scope: [], allowSubscribe: ["general"], allowPublish: ["general"] }); }
  catch (e) { grantThrew = (e as Error).message; }
  check("grantActor refuses to shadow the managed agent (names 'managed')", /managed/.test(grantThrew), grantThrew);
  const cliRowPath = rowFile("interactive", OWNER, "cli");
  const cliRowOrig = readFileSync(cliRowPath, "utf8");
  const tampered = JSON.parse(cliRowOrig) as Record<string, unknown>;
  tampered.tokenHash = "0".repeat(64); // forge a managed-shape field into an interactive row
  writeFileSync(cliRowPath, JSON.stringify(tampered, null, 2));
  let credThrew = "";
  try { await cotalAuthProvider.userCredentials({ store, dir, space: SPACE, actor: "cli" }); }
  catch (e) { credThrew = (e as Error).message; }
  writeFileSync(cliRowPath, cliRowOrig); // restore the honest row
  check("a token-hash forged into the interactive cli row fails closed (readRow denies)", /interactive grant|token hash/i.test(credThrew), credThrew);

  // ---------- D. agent exchange + live-expiry proof ----------
  console.log("D) direct agent exchange (ttlSec:10) → a live connection that dies at the bearer's exp");
  const shortEx = await agentExchange("alpha", alphaToken, OWNER, 10);
  check("direct agent exchange { owner, actorToken, ttlSec:10 } mints a bearer (200)", shortEx.status === 200 && typeof shortEx.body.token === "string", shortEx.status);
  const callout = (await loadCalloutAuth(store, SPACE))!;
  let connected = false;
  shortEp = new CotalEndpoint({
    space: SPACE, servers: SERVER, bearer: shortEx.body.token!, sentinelCreds: callout.sentinelCreds,
    channels: [], consume: false, registerPresence: false, watchPresence: false,
    card: { name: "shortlived", owner: OWNER, actor: "alpha", kind: "agent" },
  });
  shortEp.on("error", () => {});
  shortEp.on("connection", (s: { connected: boolean }) => { connected = s.connected; });
  await shortEp.start();
  check("a raw endpoint opened with the 10s bearer connects", connected === true);
  const dropped = await until(() => connected === false, 20000); // NATS closes the conn at the JWT exp (~10s)
  check("the live connection dies at its bearer-bound JWT expiry (~10s)", dropped, { connected });
  await shortEp.stop().catch(() => {});
  shortEp = undefined;

  // ---------- E (part 1) + G: dead auth service ----------
  console.log("E) kill the auth service → the agent's bearer command fails + `ps` surfaces it");
  await killPid(authChild.pid); // SIGKILL leaves the discovery file (stale pid) — the exact dead-daemon shape
  authChild = undefined;
  const alphaBearerArgv = bearerArgvFor("alpha");
  alphaBearerArgv[alphaBearerArgv.indexOf("--owner") + 1] = OWNER;
  const deadRun = await execBearer(alphaBearerArgv);
  check("the agent bearer command fails when the auth service is down (names the `cotal up` recovery)", !deadRun.ok && /restart it with `cotal up`/.test(deadRun.stderr), deadRun.stderr.slice(0, 160));
  let deadHealth: { state?: string; reason?: string } = {};
  try { deadHealth = JSON.parse(readFileSync(incFiles("alpha").health, "utf8")); } catch { /* */ }
  check("the health file records state=failed with the restart copy", deadHealth.state === "failed" && /restart it with `cotal up`/.test(deadHealth.reason ?? ""), deadHealth);
  check("manager ps reports authHealth = auth-renewal-failed", manager.list().find((a) => a.name === "alpha")?.authHealth === "auth-renewal-failed", manager.list().find((a) => a.name === "alpha"));

  console.log("G) spawning with the auth service down is refused at preflight (row rolled back)");
  const gReply = await manager.startAgent({ name: "beta", agent: "e2e", owner: OWNER });
  check("spawn with a dead auth service is refused at preflight (names `cotal up`)", !gReply.ok && /preflight/.test(gReply.error ?? "") && /restart it with `cotal up`/.test(gReply.error ?? ""), gReply.error);
  check("the refused spawn leaves NO managed row behind (rollback proven)", !existsSync(rowFile("managed", OWNER, "beta")), rowFile("managed", OWNER, "beta"));

  // ---------- E (part 2): heal ----------
  console.log("E) restart the auth service → the bearer command heals and `ps` is auth-clean again");
  // The restarted service must adjudicate the SIGKILLed predecessor's plane claim through the
  // delivery daemon's liveness oracle before it serves (the W6 fail-safe: UNKNOWN never
  // reclaims — without the oracle this restart refuses forever and /health never comes up).
  // Boot the REAL oracle for the adjudication window — a delivery endpoint serving
  // `ctl.delivery-admin` with the $SYS-CONNZ-backed hook, exactly what `cotal up` provisions —
  // then stop it so the rest of the run keeps the no-daemon regime. On this single-server
  // broker CONNZ is complete, so the predecessor's two dead connections read GONE and the
  // claim reclaims (a cluster would read UNKNOWN and hold, by design).
  const oracleObserverCreds = await mintMembershipObserverCreds(auth, newIdentity());
  const oracleId = newIdentity();
  const oracle = new CotalEndpoint({
    space: SPACE, servers: SERVER, creds: await mintCreds(auth, oracleId, "delivery"),
    card: { id: oracleId.id, name: "dlv-oracle", role: "delivery", kind: "endpoint" },
    channels: [], consume: false, registerPresence: false, watchPresence: false,
  });
  oracle.on("error", () => {});
  await oracle.start();
  await oracle.startPlane3(() => undefined, {
    planeConnLiveness: (query) => observePlaneLivenessWithCreds({
      servers: SERVER, observerCreds: oracleObserverCreds, accountId: auth.account.pub,
      query: query as import("@cotal-ai/core").PlaneLivenessQuery,
    }),
  });
  authChild = spawnAuthService();
  await waitAuthReady();
  await oracle.stop();
  const healRun = await execBearer(alphaBearerArgv);
  check("the agent bearer command succeeds after the auth service heals", healRun.ok && healRun.stdout.trim().split(".").length === 3, { ok: healRun.ok, err: healRun.stderr.slice(0, 120) });
  check("manager ps is auth-clean again (no authHealth flag)", manager.list().find((a) => a.name === "alpha")?.authHealth === undefined, manager.list().find((a) => a.name === "alpha"));

  // ---------- H. post-provision failure window (freelance blocker 1) ----------
  console.log("H) a spawn that provisions then FAILS at buildLaunch leaves no managed grant behind");
  const hReply = await manager.startAgent({ name: "gamma", agent: "e2e-fail", owner: OWNER });
  check("a spawn failing after provisioning is reported not-ok", hReply.ok === false, hReply);
  // The orphan-rollback must run the USER-MODE teardown (revoke + shred), not just static durables —
  // so the managed row AND all three secret files are gone, and the grant can't mint a bearer.
  const gammaRowGone = !existsSync(rowFile("managed", OWNER, "gamma"));
  const gammaFilesGone = noIncFiles("gamma");
  check("the failed spawn left NO managed row and NO secret files (orphan rollback ran the user-mode teardown)", gammaRowGone && gammaFilesGone, { gammaRowGone, gammaFilesGone });

  // ---------- O. own-agent control (owner-domain attach/stop on the SPAWN tier) ----------
  // The live half of the own-agent-control matrix (the pure policy is pinned broker-free in
  // implementations/manager/smoke/own-agent-control.smoke.ts): REAL wire requests on the
  // PRIVILEGED ctl subject, admitted by the callout-minted scope grants and decided by the
  // manager's owner-domain authorization.
  console.log("O) own-agent control: owner-domain attach/stop on the spawn tier");
  const ctlCaller = async (actor: string, owner: string, scope: string[], acl?: { allowSubscribe?: string[]; allowPublish?: string[] }) => {
    // The row's lifecycleUid ALSO rides the endpoint options: invokeService's caller triple is
    // (owner, actor, uid) and refuses without it (SPEC 13.1 — no alias-keyed fallback).
    const uid = mintLifecycleUid();
    const g = await cotalAuthProvider.grantAgent({ store, dir, space: SPACE, owner, actor, scope, allowSubscribe: acl?.allowSubscribe ?? [], allowPublish: acl?.allowPublish ?? [], lifecycleUid: uid });
    const ex = await agentExchange(actor, g.actorToken, owner);
    if (ex.status !== 200 || !ex.body.token) throw new Error(`ctlCaller ${owner}.${actor}: exchange HTTP ${ex.status} ${ex.body.error ?? ""}`);
    const ep = new CotalEndpoint({
      space: SPACE, servers: SERVER, bearer: ex.body.token, sentinelCreds: g.sentinelCreds,
      channels: [], consume: false, registerPresence: false, watchPresence: false, lifecycleUid: uid,
      card: { name: actor, owner, actor, kind: "endpoint" },
    });
    ep.on("error", () => {});
    await ep.start();
    ctlEps.push(ep);
    return ep;
  };
  // 1d: the manager `ctl` rail is deleted — an operator drives it over the v0.4 ep rails, EXACTLY
  // as the CLI does (askManagerEp): resolve the alias to its principal triple via `inspect`, then
  // invoke the mapped command. Target mode is DERIVED from the resolved owner: own-domain rides
  // `owner` mode, a cross-owner target rides `any` mode — which the broker admits only for a caller
  // holding the admin instrument rows (a bearer whose ledger `admin` scope the callout minted), so
  // a spawn-only cross-owner op is broker-DENIED at publish while an admin operator's is admitted
  // and the manager's fresh ledger read governs.
  type EpReply = { ok: boolean; data?: unknown; error?: string };
  const epTargeted = async (ep: CotalEndpoint, op: "attach" | "stop" | "input", name: string, forceMode?: "owner" | "any"): Promise<EpReply> => {
    let info;
    try { info = await ep.invokeService("manager", "inspect", { name }); }
    catch (e) { return { ok: false, error: e instanceof EpEnvelopeError ? `${e.code}: ${e.message}` : (e as Error).message }; }
    if (info.reply.ok !== true) return { ok: false, error: info.reply.error?.message ?? info.reply.error?.code ?? "inspect failed" };
    const rowInfo = info.reply.data as { id: string; lifecycleUid: string };
    const dot = rowInfo.id.indexOf(".");
    const [tOwner, tActor] = dot > 0 ? [rowInfo.id.slice(0, dot), rowInfo.id.slice(dot + 1)] : [ep.principal.owner, rowInfo.id];
    // Derived from the owners, EXCEPT when a caller forces it. The derivation is right for every
    // ordinary call, and wrong for one question: a same-owner target always derives `owner`, so a
    // cell that wants to prove the ANY-mode subject is also closed can never reach it by asking
    // nicely. `forceMode` exists for exactly that cell and for nothing else.
    const mode = forceMode ?? (tOwner !== ep.principal.owner ? "any" : "owner");
    const command = op === "stop" ? "despawn" : op;
    // `input` is the one op here that carries a body. Everything else about the call is identical,
    // which is the point: the same resolve, the same derived mode, the same rails.
    const body = op === "input" ? { text: "/compact", enter: false } : undefined;
    try {
      const r = await ep.invokeService("manager", command, body, { target: { mode, owner: tOwner, actor: tActor, lifecycleUid: rowInfo.lifecycleUid } });
      return r.reply.ok === true ? { ok: true, ...(r.reply.data !== undefined ? { data: r.reply.data } : {}) } : { ok: false, error: r.reply.error?.message ?? r.reply.error?.code };
    } catch (e) { return { ok: false, error: e instanceof EpEnvelopeError ? `${e.code}: ${e.message}` : (e as Error).message }; }
  };
  const epPs = async (ep: CotalEndpoint): Promise<EpReply> => {
    try {
      const r = await ep.invokeService("manager", "ps");
      return r.reply.ok === true ? { ok: true, data: r.reply.data } : { ok: false, error: r.reply.error?.message ?? r.reply.error?.code };
    } catch (e) { return { ok: false, error: e instanceof EpEnvelopeError ? `${e.code}: ${e.message}` : (e as Error).message }; }
  };
  // The target: `delta`, already live from the envelope section (spawned WITH spawner `u_….cli`),
  // so a DIFFERENT actor under the same owner is a true sibling — not the spawner, not the manager.
  check("precondition: delta is live under the operator's owner", manager.list().some((a) => a.name === "delta"), manager.list().map((a) => a.name));
  const opsmate = await ctlCaller("opsmate", OWNER, ["spawn"]);
  const sibAttach = await epTargeted(opsmate, "attach", "delta");
  check("owner-domain: a spawn-scoped SIBLING actor attaches an agent under its owner (ep owner mode)", sibAttach.ok === true && typeof (sibAttach.data as { grant?: { sessionId?: string } })?.grant?.sessionId === "string", sibAttach);
  const sibStop = await epTargeted(opsmate, "stop", "delta");
  check("owner-domain: the same sibling actor stops it (stop travels with attach)", sibStop.ok === true, sibStop);
  check("delta is gone from the manager after the sibling stop", !manager.list().some((a) => a.name === "delta"), manager.list().map((a) => a.name));
  // THE SIBLING-WRITE VECTOR, executed on a real user mesh rather than argued from the mint table.
  // The two cells above are the reason it exists: on a user mesh the own-domain arm admits any seat
  // under the caller's owner, so `opsmate` attaches and stops an agent it never spawned. That is the
  // policy working as designed, because both are denial. Seat INPUT is not denial, it is control of
  // whatever the peer is running, so it must NOT ride the same spawn scope. It does not: a spawn
  // bearer is minted no `input` row in either mode, so the publish is broker-denied before the
  // manager sees it. `alpha` rather than `delta` because the sibling stop above took delta.
  // The refusal is asserted BY SHAPE, not just by `ok === false`, because an absence assertion is
  // the kind that passes for the wrong reason. A broker drop surfaces as `unavailable` or
  // `deadline-exceeded`: the publish never reached a manager, so nothing answered. Restoring the
  // grant would not merely change that string, it would make the owner-mode call SUCCEED, since the
  // own-domain arm admits the sibling. A `permission-denied` would mean the publish was ADMITTED
  // and the handler refused, which is a weaker property than the one these cells are for.
  const brokerDropped = (r: EpReply): boolean =>
    r.ok === false && /unavailable|deadline-exceeded/.test(r.error ?? "");
  // BOTH modes, and the second one has to be forced. The helper derives `owner` for a same-owner
  // target, so without the override the any-mode subject is never published and a claim about it
  // would be untested text sitting next to a green cell.
  const sibInput = await epTargeted(opsmate, "input", "alpha", "owner");
  check("owner-domain: the SAME sibling actor that could attach and stop is REFUSED owner-mode seat input, dropped at the BROKER",
    brokerDropped(sibInput), sibInput);
  const sibInputAny = await epTargeted(opsmate, "input", "alpha", "any");
  check("...and the any-mode subject is closed to it too, so the refusal is the missing grant and not the mode derivation",
    brokerDropped(sibInputAny), sibInputAny);
  // Named for what it proves and no more. `input` never removes a seat, so this rules out a wild
  // despawn rather than a successful write; the load-bearing half is the pair above.
  check("the refused input did not take alpha with it (it never should; this is the belt, not the braces)",
    manager.list().some((a) => a.name === "alpha"), manager.list().map((a) => a.name));
  // A CROSS-OWNER caller with only spawn scope: the ep any-mode row it would need is broker-DENIED
  // at publish (a spawn bearer holds owner-mode rows only), so the op fails before the manager.
  const OWNER_B = "u_" + "b".repeat(26);
  const intruder = await ctlCaller("intruder", OWNER_B, ["spawn"]);
  const crossAttach = await epTargeted(intruder, "attach", "alpha");
  check("cross-owner attach is refused fail-closed (any-mode broker-denied for a spawn bearer)", crossAttach.ok === false, crossAttach);
  const crossStop = await epTargeted(intruder, "stop", "alpha");
  check("cross-owner stop is refused the same way", crossStop.ok === false, crossStop);
  check("alpha survived the refused cross-owner stop", manager.list().some((a) => a.name === "alpha"), manager.list().map((a) => a.name));
  // A cross-owner caller whose LEDGER row carries admin: the callout minted it the any-mode admin
  // instrument rows, so the broker admits the any-mode publish and the manager's fresh ledger read → allowed.
  const auditor = await ctlCaller("auditor", OWNER_B, ["spawn", "admin"]);
  const adminAttach = await epTargeted(auditor, "attach", "alpha");
  check("cross-owner attach with ledger admin passes (any-mode admin rows + fresh ledger read)", adminAttach.ok === true, adminAttach);
  // And the same ledger row reaches seat input, which is the whole point of putting `input` on the
  // operator instrument instead of on `spawn`: the authority that already crosses owners carries it,
  // and nothing weaker does. This is also the live proof that the any-mode `input` row the admin
  // mint emits is REACHABLE, not merely present in a decoded JWT.
  const adminInput = await epTargeted(auditor, "input", "alpha");
  check("cross-owner seat input with ledger admin passes, and reports the bytes it wrote",
    adminInput.ok === true && (adminInput.data as { bytes?: number })?.bytes === 8, adminInput);
  // Narrow the auditor back to [spawn] (upsert) — its NEXT exchange mints owner-mode-only rows, so a
  // cross-owner op loses the any-mode reach (the callout re-reads the ledger per exchange).
  await cotalAuthProvider.grantAgent({ store, dir, space: SPACE, owner: OWNER_B, actor: "auditor", scope: ["spawn"], allowSubscribe: [], allowPublish: [], lifecycleUid: mintLifecycleUid() });
  const narrowedAttach = await epTargeted(auditor, "attach", "alpha");
  check("narrowing the auditor's scope bites its cross-owner reach on the next exchange", narrowedAttach.ok === false, narrowedAttach);

  // ---------- E. the event plane, at the real door, under BOTH rules ----------
  // Two rules meet here and the ORDER is the finding. The delegation envelope says a peer may hand
  // down a subset of what it holds and no more. The OWN-CHANNEL rule says the agent being created
  // may hold its OWN event plane and no other, whatever the spawner holds, because that plane
  // carries the session's tool inputs and outputs verbatim. The own-channel rule runs FIRST and is
  // NOT envelope-dependent, so widening the peer's own grant does not admit the request: a reader
  // of somebody else's plane is granted out of band, never through a spawn.
  //
  // WHY THESE CELLS WERE REWRITTEN RATHER THAN REPAIRED. Before the rule existed the door ACCEPTED
  // the over-ask (spawn is an action: the door replies the instant the identity is minted) and the
  // ledger refused it afterwards, so these cells asserted acceptance plus the absence of a row.
  // The rule moved the refusal AHEAD of the mint. Keeping the old assertion would be asserting the
  // defect, so what is asserted now is the refusal itself, at the door, over a real bearer.
  //
  // The stated limit is asserted too, from the other side, because a limit nobody tests is a
  // sentence: the CONCRETE form is refused whatever the envelope says, and the WILDCARD form is
  // left to the envelope exactly as every other channel is.
  console.log("E) the own-channel rule at the real door, and the envelope's remaining half");
  const VICTIM = eventChannel({ owner: OWNER_B, actor: "auditor" });
  const VICTIM_WILDCARD = `events.${OWNER_B}.>`;
  type Accepted = { ok: boolean; name?: string; error?: string };
  const epSpawnAccept = async (ep: CotalEndpoint, args: Record<string, unknown>): Promise<Accepted> => {
    try {
      const r = await ep.invokeService("manager", "spawn", args, { deadlineMs: 15_000 });
      if (r.reply.ok !== true) return { ok: false, error: r.reply.error?.message ?? r.reply.error?.code };
      return { ok: true, name: (r.reply.data as { name?: string }).name };
    } catch (e) { return { ok: false, error: e instanceof EpEnvelopeError ? `${e.code}: ${e.message}` : (e as Error).message }; }
  };
  const settle = async (ms: number) => { await new Promise((r) => setTimeout(r, ms)); };
  const ownChannelRefusal = (r: Accepted): boolean =>
    r.ok === false && /another agent's event channel/.test(r.error ?? "") && (r.error ?? "").includes(VICTIM);
  const evtpeer = await ctlCaller("evtpeer", OWNER, ["spawn"], { allowSubscribe: ["general"], allowPublish: ["general"] });
  const readOverAsk = await epSpawnAccept(evtpeer, { name: "epsilon", agent: "e2e", allowSubscribe: ["general", VICTIM], allowPublish: ["general"] });
  check("a peer's ep spawn asking a FOREIGN event channel as its child's READ set is refused AT THE DOOR, naming the channel",
    ownChannelRefusal(readOverAsk), readOverAsk);
  await settle(1500);
  check("...and no managed row for the child", !existsSync(rowFile("managed", OWNER, "epsilon")));
  check("...and no live agent by that name", !manager.list().some((a) => a.name === "epsilon"), manager.list().map((a) => a.name));
  const writeOverAsk = await epSpawnAccept(evtpeer, { name: "epsilon", agent: "e2e", allowSubscribe: ["general"], allowPublish: ["general", VICTIM] });
  check("the same over-ask on the child's WRITE set is refused at the door too: publishing INTO another agent's plane is forgery, not eavesdropping",
    ownChannelRefusal(writeOverAsk), writeOverAsk);
  await settle(1500);
  check("...and leaves no row either", !existsSync(rowFile("managed", OWNER, "epsilon")));
  // THE HALF THE ENVELOPE NO LONGER DECIDES. An operator widening the peer's own grant used to
  // admit this exact request, and that was the whole "containment rather than ban" story. The
  // own-channel rule takes the CONCRETE form out of the envelope's hands: the answer is the same
  // refusal, from a spawner that demonstrably holds the channel.
  const widened = await ctlCaller("evtpeer2", OWNER, ["spawn"], { allowSubscribe: ["general", VICTIM], allowPublish: ["general"] });
  const admitted = await epSpawnAccept(widened, { name: "epsilon", agent: "e2e", allowSubscribe: ["general", VICTIM], allowPublish: ["general"] });
  check("with the peer's OWN grant widened by the operator, the identical spawn is STILL refused: the concrete form is not the envelope's to hand down",
    ownChannelRefusal(admitted), admitted);
  await settle(2500);
  check("...and still writes no row", !existsSync(rowFile("managed", OWNER, "epsilon")), admitted);
  // THE STATED LIMIT, ASSERTED. `eventChannelPrincipal` decodes exactly two principal tokens, so a
  // WILDCARD is not an event channel to the rule and passes it untouched, governed by the envelope
  // alone. That is deliberate: the wildcard is the form an operator writes on purpose for an
  // observer, and this cell is what stops the limit being a comment nobody tests.
  const wildpeer = await ctlCaller("evtpeer3", OWNER, ["spawn"], { allowSubscribe: ["general", VICTIM_WILDCARD], allowPublish: ["general"] });
  const wildAdmitted = await epSpawnAccept(wildpeer, { name: "epsilon", agent: "e2e", allowSubscribe: ["general", VICTIM_WILDCARD], allowPublish: ["general"] });
  check("the WILDCARD form is left to the delegation envelope: a peer whose own grant covers it CAN hand it down", wildAdmitted.ok === true, wildAdmitted);
  await settle(2500);
  const wildRow = existsSync(rowFile("managed", OWNER, "epsilon"))
    ? (JSON.parse(readFileSync(rowFile("managed", OWNER, "epsilon"), "utf8")) as { allowSubscribe?: string[]; parent?: string })
    : undefined;
  check("...and a row IS written, carrying exactly the pattern it asked for", wildRow?.allowSubscribe?.includes(VICTIM_WILDCARD) === true, wildRow);
  check("...recording the peer that delegated it as parent", wildRow?.parent === `${OWNER}.evtpeer3`, wildRow);
  // THE TWO REFUSALS, SIDE BY SIDE, through the op core with the same spawner principal, so the
  // TEXT of each is on the record. Without the second one the first proves only that something
  // refused: the envelope is still the authority for every channel that is not a concrete event
  // channel, and a rule that had swallowed it would look identical from one cell.
  const overText: ControlReply = await manager.startAgent(
    { name: "zeta", agent: "e2e", allowSubscribe: ["general", VICTIM], allowPublish: ["general"] }, `${OWNER}.evtpeer`);
  check("the refusal for a concrete event channel is the OWN-CHANNEL rule, and it names the channel",
    overText.ok === false && /another agent's event channel/.test(overText.error ?? "") && (overText.error ?? "").includes(VICTIM), overText);
  // THE REMEDY THAT REFUSAL PRINTS, PARSED AND RUN. A confinement refusal lends its own authority
  // to whatever command it prints, and BOTH halves of this one were once wider than the sentence
  // around them: the static half named a profile that ignores `--allow-subscribe`, and this half
  // named a bare `cotal actor grant`. A bare grant is not a narrow one. `runActor` fills every
  // omitted flag from `csv(values.x, dflt)` with the WIDE default (`>` read, `>` post,
  // `spawn,role:default` scope), and it says so in its own comment, so an operator following this
  // refusal to the letter in order to grant a READER would have written a row that reads and posts
  // everywhere and can spawn. That is a worse outcome than the spawn the refusal blocked, and it
  // arrives carrying the manager's authority.
  //
  // Two cells, because the text and the effect are different claims. The first is that the command
  // spells every field out, which is what stops a default applying at all. The second RUNS the
  // values it printed through the real ledger writer and grades the row that lands.
  const grantCmd = /cotal actor grant [^`]+/.exec(overText.error ?? "")?.[0] ?? "";
  const flag = (name: string): string | undefined => new RegExp(`--${name} '([^']*)'`).exec(grantCmd)?.[1];
  const ownerFlag = /--owner (\S+)/.exec(grantCmd)?.[1];
  check("the user-mesh refusal prints an actor grant that spells out EVERY field, so no wide default applies",
    grantCmd.length > 0 && flag("allow-subscribe") === VICTIM && flag("allow-publish") === "" && flag("scope") === "" && ownerFlag === OWNER,
    { grantCmd, sub: flag("allow-subscribe"), pub: flag("allow-publish"), scope: flag("scope"), owner: ownerFlag });
  const READER = "evtreader";
  grantActor(dir, {
    owner: ownerFlag ?? "",
    actor: READER,
    scope: (flag("scope") ?? ">").split(",").filter(Boolean),
    allowSubscribe: (flag("allow-subscribe") ?? ">").split(",").filter(Boolean),
    allowPublish: (flag("allow-publish") ?? ">").split(",").filter(Boolean),
  });
  const readerRow = existsSync(rowFile("interactive", OWNER, READER))
    ? (JSON.parse(readFileSync(rowFile("interactive", OWNER, READER), "utf8")) as { allowSubscribe: string[]; allowPublish: string[]; scope: string[] })
    : undefined;
  check("running exactly what it printed writes a row that reads that ONE channel, posts nowhere, and cannot spawn",
    JSON.stringify(readerRow?.allowSubscribe) === JSON.stringify([VICTIM]) && readerRow?.allowPublish.length === 0 && readerRow?.scope.length === 0,
    readerRow);

  const envelopeText: ControlReply = await manager.startAgent(
    { name: "zeta", agent: "e2e", allowSubscribe: ["general", "not-mine"], allowPublish: ["general"] }, `${OWNER}.evtpeer`);
  check("and an ORDINARY channel the peer does not hold is still refused by the delegation envelope, which the rule did not replace",
    envelopeText.ok === false && /delegation only narrows/.test(envelopeText.error ?? "") && (envelopeText.error ?? "").includes("not-mine"), envelopeText);
  // AND THE WILDCARD FORM IS ATTENUATED LIKE ANY OTHER PATTERN. The rule leaves it alone; that is
  // not the same as nothing governing it. A peer that does NOT hold the pattern cannot hand it
  // down, on either side, and these are the cells that would notice an author exempting the
  // `events.` prefix from the containment walk to make arming "just work".
  const wildOverText: ControlReply = await manager.startAgent(
    { name: "zeta", agent: "e2e", allowSubscribe: ["general", VICTIM_WILDCARD], allowPublish: ["general"] }, `${OWNER}.evtpeer`);
  check("a WILDCARD the peer does NOT hold is refused by the envelope on the READ side",
    wildOverText.ok === false && /delegation only narrows/.test(wildOverText.error ?? "") && (wildOverText.error ?? "").includes(VICTIM_WILDCARD), wildOverText);
  const wildPubText: ControlReply = await manager.startAgent(
    { name: "zeta", agent: "e2e", allowSubscribe: ["general"], allowPublish: ["general", VICTIM_WILDCARD] }, `${OWNER}.evtpeer`);
  check("and on the WRITE side: a peer cannot hand down a wildcard write over another owner's planes",
    wildPubText.ok === false && /delegation only narrows/.test(wildPubText.error ?? "") && (wildPubText.error ?? "").includes(VICTIM_WILDCARD), wildPubText);

  // ---------- V. elevated views (exchange-gated per-connection profiles), live ----------
  // The live half of the views design (unit layers: smoke:views). Real wire: refused under-scoped
  // exchange, managed-path rejection, a standing god-view tap over a bearer SOURCE that survives
  // its ≤20s tokens (fresh ledger check per re-mint), a channel-purger purge, the deployer view on
  // the privileged tier, and the ps owner-domain filter.
  console.log("V) elevated views: ledger-gated god view / purge / deploy over the real wire");
  const svc = loadAuthServiceInfo(dir)!;
  const freshIdpJwt = async () =>
    fetchIdpJwt(base, (await establishIdpSession({ dir: home, idpUrl: base, clientId: CLIENT_ID, onPrompt: (p) => void approve(p.userCode) })).session.token);
  const humanViewEx = async (view: string, ttlSec?: number) => {
    const res = await fetch(`${svc.url}/exchange`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${svc.cap}` },
      body: JSON.stringify({ idpToken: await freshIdpJwt(), actor: "cli", view, ...(ttlSec ? { ttlSec } : {}) }),
    });
    return { status: res.status, body: (await res.json().catch(() => ({}))) as { token?: string; error?: string } };
  };
  // cli's scope is still [spawn] here — every admin-gated view must refuse naming the gate.
  const deniedView = await humanViewEx("admin");
  check('an admin-view exchange under scope [spawn] refuses 401 naming scope "admin"', deniedView.status === 401 && /needs scope "admin"/.test(deniedView.body.error ?? ""), deniedView);
  // The managed (agent-secret) path never mints views — even for a row that CARRIES admin.
  const vg = await cotalAuthProvider.grantAgent({ store, dir, space: SPACE, owner: OWNER, actor: "viewbot", scope: ["spawn", "admin"], allowSubscribe: [], allowPublish: [], lifecycleUid: mintLifecycleUid() });
  const mgdViewRes = await fetch(`${svc.url}/exchange`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${svc.cap}` },
    body: JSON.stringify({ owner: OWNER, actor: "viewbot", actorToken: vg.actorToken, view: "admin" }),
  });
  const mgdViewBody = (await mgdViewRes.json().catch(() => ({}))) as { error?: string };
  check("the managed exchange rejects views outright (400, even with admin on the row)", mgdViewRes.status === 400 && /never mints elevated views/.test(mgdViewBody.error ?? ""), { status: mgdViewRes.status, error: mgdViewBody.error });
  // ADD admin to the cli grant (the upsert replaces the list — spawn kept deliberately), on the
  // alias's ONE lifecycle (see cliRow0).
  const cliUid = cliRow0.lifecycleUid;
  grantActor(dir, { owner: OWNER, actor: "cli", scope: ["spawn", "admin"], allowSubscribe: ["general"], allowPublish: ["general"], label: "smoke operator", lifecycleUid: cliUid });
  let viewMints = 0;
  const mintAdminView = async (): Promise<string> => {
    viewMints++;
    const r = await humanViewEx("admin", 20);
    if (r.status !== 200 || !r.body.token) throw new Error(`admin-view exchange failed: HTTP ${r.status} ${r.body.error ?? ""}`);
    return r.body.token;
  };
  const firstView = await mintAdminView();
  check("with admin ADDED, the admin-view exchange mints act.view", (decodeJwt(firstView).act as { view?: string }).view === "admin");
  // The standing god-view tap: a bearer SOURCE over ≤20s tokens (the endpoint refreshes ahead of
  // each expiry and reconnects across the bearer-bound JWT's death), pinned principal up front.
  const sentinel = (await loadCalloutAuth(store, SPACE))!.sentinelCreds;
  const godEye = new CotalEndpoint({
    space: SPACE, servers: SERVER, bearer: mintAdminView, sentinelCreds: sentinel,
    channels: [], consume: false, registerPresence: false, watchPresence: false,
    card: { owner: OWNER, actor: "cli", name: "web", kind: "endpoint" },
  });
  godEye.on("error", () => {});
  await godEye.start();
  ctlEps.push(godEye);
  const tapped: string[] = [];
  // The admin view's sub is the ENUMERATED messaging plane (chat/inst/svc — never the space-wide
  // `>`, which would plain-subscribe every v0.4 endpoint rail), so the tap pins the DM subtree it
  // asserts on; a space-wide tap would be a silent sub violation and see nothing.
  godEye.tap((subject: string) => { tapped.push(subject); }, { subject: `cotal.${SPACE}.inst.>` });
  await wait(300); // let the tap subscription settle
  // A written `<owner>.<actor>` literal, so it is a valid recipient by construction rather than
  // by anything checking it here. Any future change to the principal grammar has to visit this
  // line: it builds a recipient instead of borrowing one from a card, and this suite is not in
  // the CI chain, so nothing would fail if it stopped being well formed.
  await opsmate.unicast(`${OWNER}.alpha`, "psst — a DM between two other principals");
  let sawDm = false;
  for (let i = 0; i < 20 && !sawDm; i++) { await wait(100); sawDm = tapped.some((s) => s.includes(".inst.")); }
  check("the admin-view tap sees a DM between two OTHER principals (the god view)", sawDm, tapped.slice(-3));
  // channel-purger view: publish two chat messages on a scratch channel, purge them via clearChannel
  // over a one-shot purger-view bearer (the standalone user-mode connect path).
  const wg = await cotalAuthProvider.grantAgent({ store, dir, space: SPACE, owner: OWNER, actor: "writer", scope: [], allowSubscribe: ["viewtest"], allowPublish: ["viewtest"], lifecycleUid: mintLifecycleUid() });
  const wx = await agentExchange("writer", wg.actorToken, OWNER);
  const writer = new CotalEndpoint({
    space: SPACE, servers: SERVER, bearer: wx.body.token!, sentinelCreds: wg.sentinelCreds,
    channels: [], consume: false, registerPresence: false, watchPresence: false,
    card: { name: "writer", owner: OWNER, actor: "writer", kind: "endpoint" },
  });
  writer.on("error", () => {});
  await writer.start();
  ctlEps.push(writer);
  await writer.multicast("purge me", { channel: "viewtest" });
  await writer.multicast("me too", { channel: "viewtest" });
  const purgeView = await humanViewEx("channel-purger");
  check("the channel-purger view mints under scope admin", purgeView.status === 200 && !!purgeView.body.token, purgeView);
  const purged = await clearChannel({ servers: SERVER, space: SPACE, channel: "viewtest", bearer: purgeView.body.token!, sentinelCreds: sentinel });
  check("clearChannel purges over the purger-view bearer (standalone user-mode connect)", purged.purged >= 2, purged);
  // deployer view: spawn-gated (no admin needed — but cli has both), control rides the ep manager endpoint (owner mode).
  const depView = await humanViewEx("deployer");
  check("the deployer view mints (spawn-gated)", depView.status === 200 && !!depView.body.token, depView);
  const deployer = new CotalEndpoint({
    space: SPACE, servers: SERVER, bearer: depView.body.token!, sentinelCreds: sentinel,
    channels: [], consume: false, registerPresence: false, watchPresence: false, lifecycleUid: cliUid,
    card: { owner: OWNER, actor: "cli", name: "spawn-f", kind: "endpoint" },
  });
  deployer.on("error", () => {});
  await deployer.start();
  ctlEps.push(deployer);
  const depPs = await epPs(deployer);
  check("the deployer view drives ps on the ep manager endpoint", depPs.ok === true, depPs);
  // Enumeration is INSTRUMENT-gated in v0.4 (`ps` is a manager.read row minted only into
  // operator instruments and views, never a raw spawn bearer): both the foreign owner's and the
  // own-owner sibling's direct `ps` are broker-denied outright — stricter than the ctl era's
  // owner-filtered reply (nothing to filter when you cannot even ask). The read DOORS beside
  // this pin the filter semantics: the deployer view lists (own-owner) and the admin-scoped
  // overseer below sees across owners. (Both raw callers are live from section O.)
  const psB = await epPs(intruder);
  check("a raw spawn bearer cannot ps at all (broker-denied; enumeration is instrument-gated)", psB.ok === false, psB);
  const psA = await epPs(opsmate);
  check("...same for an own-owner spawn bearer (the deployer VIEW is the read door)", psA.ok === false, psA);
  // A fresh ledger `admin` scope (not just any-mode reach) sees ALL owners — the SAME authority that
  // lets stop/attach reach cross-owner (section O). Without this, ps/status disagreed with control:
  // an admin could cross-owner STOP an agent it could not LIST. An owner-B admin sees owner-A's alpha.
  const overseer = await ctlCaller("overseer", OWNER_B, ["spawn", "admin"]);
  const psAdmin = await epPs(overseer);
  check(
    "an admin-SCOPED ep ps sees across owners (owner-B admin lists owner-A's alpha)",
    psAdmin.ok === true && Array.isArray(psAdmin.data) && (psAdmin.data as Array<{ name: string }>).some((a) => a.name === "alpha"),
    psAdmin.data,
  );
  // The refresh proof: past the first 20s bearer's death the endpoint has re-minted (fresh ledger
  // checks) and reconnected — a live wire round-trip still answers.
  await wait(25_000);
  const channelsAfter = await godEye.listChannels();
  check("the god-view endpoint outlives its first ≤20s bearer (source re-mint + reconnect)", Array.isArray(channelsAfter), channelsAfter?.length);
  check("the bearer source re-minted at least once (fresh ledger check per refresh)", viewMints >= 2, { viewMints });

  // ---------- P. stale-bearer lifecycle crossover (D15 Track A #9) ----------
  console.log("P) a predecessor lifecycle's still-unexpired bearer is DENIED after a same-alias re-grant");
  {
    // Lifecycle A: grant + exchange -> a valid bearer BOUND to A's row uid.
    const gA = await cotalAuthProvider.grantAgent({ store, dir, space: SPACE, owner: OWNER, actor: "phoenix", scope: [], allowSubscribe: ["general"], allowPublish: [], lifecycleUid: mintLifecycleUid() });
    const exA = await agentExchange("phoenix", gA.actorToken, OWNER);
    check("P: lifecycle A's exchange mints a bearer", exA.status === 200 && typeof exA.body.token === "string", exA);
    // Same-alias RE-GRANT rotates the row to lifecycle B (fresh uid + fresh secret) - the respawn shape.
    const gB = await cotalAuthProvider.grantAgent({ store, dir, space: SPACE, owner: OWNER, actor: "phoenix", scope: [], allowSubscribe: ["general"], allowPublish: [], lifecycleUid: mintLifecycleUid() });
    // A's captured actorToken is dead (tokenHash rotated) - the OLD guarantee, still holding:
    const exStale = await agentExchange("phoenix", gA.actorToken, OWNER);
    check("P: lifecycle A's captured actorToken is denied at exchange after the re-grant", exStale.status === 401, exStale.status);
    // THE CROSSOVER GATE: A's still-unexpired BEARER must be refused at CONNECT - without the
    // lifecycle claim + equality check, the callout would mint it B's exact broker authority.
    const staleEp = new CotalEndpoint({
      space: SPACE, servers: SERVER, bearer: exA.body.token!, sentinelCreds: gA.sentinelCreds,
      channels: [], consume: false, registerPresence: false, watchPresence: false,
      card: { name: "phoenix", owner: OWNER, actor: "phoenix", kind: "endpoint" },
    });
    staleEp.on("error", () => {});
    let staleDenied = false;
    try {
      await withTimeout(staleEp.start(), 8000, "stale-bearer connect neither authed nor refused in 8s");
    } catch { staleDenied = true; }
    try { await staleEp.stop(); } catch { /* never started */ }
    check("P: lifecycle A's still-unexpired BEARER is refused at connect (never minted B's authority)", staleDenied);
    // The respawn shape's ISSUANCE half is now the R1 takeover barrier: rotation alone does not
    // transfer mintability. While lifecycle A is still ACTIVE (its exchange activated it), B's
    // exchange refuses naming the active uid — retiring a live predecessor is the spawn path's
    // job (despawn/retire), never issuance's (SPEC 13.1).
    const exB = await agentExchange("phoenix", gB.actorToken, OWNER);
    check("P: lifecycle B's exchange is refused while A is still active (R1 takeover barrier)", exB.status === 401 && /active at uid/.test(exB.body.error ?? ""), { status: exB.status, error: exB.body.error });
    // A CLEAN alias beside the blocked rotation proves the equality gate blocks only stale
    // incarnations: a fresh lifecycle's chain works end-to-end (secret -> bearer -> connect).
    const gC = await cotalAuthProvider.grantAgent({ store, dir, space: SPACE, owner: OWNER, actor: "phoenix2", scope: [], allowSubscribe: ["general"], allowPublish: [], lifecycleUid: mintLifecycleUid() });
    const exC = await agentExchange("phoenix2", gC.actorToken, OWNER);
    check("P: a fresh alias's exchange mints (the barrier pins the ALIAS's active lifecycle, not the owner)", exC.status === 200 && typeof exC.body.token === "string", exC);
    const liveEp = new CotalEndpoint({
      space: SPACE, servers: SERVER, bearer: exC.body.token!, sentinelCreds: gC.sentinelCreds,
      channels: [], consume: false, registerPresence: false, watchPresence: false,
      card: { name: "phoenix2", owner: OWNER, actor: "phoenix2", kind: "endpoint" },
    });
    liveEp.on("error", () => {});
    let liveOk = true;
    try { await withTimeout(liveEp.start(), 8000, "current-bearer connect did not settle in 8s"); }
    catch { liveOk = false; }
    check("P: the CURRENT (fresh-lifecycle) bearer connects (the equality gate blocks only stale incarnations)", liveOk);
    try { await liveEp.stop(); } catch { /* already down */ }
    await cotalAuthProvider.revokeAgent({ dir, owner: OWNER, actor: "phoenix" }).catch(() => {});
    await cotalAuthProvider.revokeAgent({ dir, owner: OWNER, actor: "phoenix2" }).catch(() => {});
  }

  // ---------- F. revocation ----------
  console.log("F) manager teardown revokes the managed row + shreds files; the old token is uniformly denied");
  const alphaFamily = incFiles("alpha"); // resolve the incarnation paths BEFORE teardown shreds them
  await manager.stop(); // teardown deprovisions alpha: user-mode revoke (row delete) + token/sentinel/health shred
  managerStopped = true;
  const rowGone = !existsSync(managedRowPath);
  const filesGone = [alphaFamily.actorToken, alphaFamily.sentinelCreds, alphaFamily.health].every((f) => !existsSync(f)) && noIncFiles("alpha");
  check("manager teardown deleted the managed row and shredded the token/sentinel/health files", rowGone && filesGone, { rowGone, filesGone });
  const revokedEx = await agentExchange("alpha", alphaToken, OWNER); // the OLD captured secret
  check("the old captured actor token is uniformly denied (401) after revocation", revokedEx.status === 401, { status: revokedEx.status, error: revokedEx.body.error });

  console.log(`\nUSER-SPAWN SMOKE ${fail === 0 ? "OK ✅" : "FAILED ❌"}  (${pass} passed, ${fail} failed)`);
  if (fail) process.exitCode = 1;
} catch (e) {
  fail++;
  console.error("  ✗ scenario threw:", (e as Error).stack ?? (e as Error).message);
  process.exitCode = 1;
} finally {
  try { await observer?.stop(); } catch { /* */ }
  try { await shortEp?.stop(); } catch { /* */ }
  for (const e of ctlEps) { try { await e.stop(); } catch { /* */ } }
  if (manager && !managerStopped) await manager.stop().catch(() => {});
  await killPid(authChild?.pid);
  broker?.kill("SIGKILL");
  idpSrv.close();
  rmSync(home, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
}
process.exit(process.exitCode ?? 0);
