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
const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } = await import("node:fs");
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
  setupSpaceStreams, principalKey, registry,
} = await import("@cotal-ai/core");
const { authDir, userAuthStateDir, saveSpaceAuth, recordMesh, assertUserAuthInfo } = await import("@cotal-ai/workspace");
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
const PORT = 20000 + Math.floor(Math.random() * 40000);
const SERVER = `nats://127.0.0.1:${PORT}`;
const SPACE = `uspawn-${Math.floor(Math.random() * 1e6)}`;
const CLIENT_ID = "cotal-cli";
const dir = userAuthStateDir(root, SPACE); // the provider's space-scoped state dir
const credsDir = join(authDir(root), "creds");
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
  "const ep=new m.CotalEndpoint({space:process.env.COTAL_SPACE,servers:process.env.COTAL_SERVERS,bearer:bearer,sentinelCreds:sentinel,channels:[],consume:false,registerPresence:true,watchPresence:false,card:{name:process.env.COTAL_NAME,owner:process.env.COTAL_OWNER,actor:process.env.COTAL_ACTOR,kind:'agent'}});",
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
    },
  }),
};
registry.register(e2eCon);

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
    stdio: "ignore",
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
  "--token-file", join(credsDir, `${actor}.actor-token`),
  "--health-file", join(credsDir, `${actor}.auth-health.json`),
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
    dir,
    idpUrl: base,
  });
  const jsDir = mkdtempSync(join(tmpdir(), "cotal-uspawn-js-"));
  writeFileSync(join(root, "server.conf"), serverConfig(auth, { port: PORT, storeDir: jsDir, extraAccounts: prepared.extraAccounts }));
  broker = spawn("nats-server", ["-c", join(root, "server.conf")], { stdio: "ignore" });
  let up = false;
  for (let i = 0; i < 50 && !up; i++) { up = await isReachable(SERVER); if (!up) await wait(200); }
  check("user-auth broker is reachable", up);
  await setupSpaceStreams({ servers: SERVER, space: SPACE, creds: await mintCreds(auth, newIdentity(), "provisioner") });
  // Record the mesh mode "user" — Manager.start() cross-checks the registry against the on-disk marker.
  recordMesh({ space: SPACE, server: SERVER, root, mode: "user", userAuth: assertUserAuthInfo(prepared.publicAuth), ts: new Date().toISOString() });
  // Personas (identity + file ACL) for the two spawns.
  mkdirSync(join(root, ".cotal", "agents"), { recursive: true });
  for (const n of ["alpha", "beta"])
    writeFileSync(join(root, ".cotal", "agents", `${n}.md`), `---\nname: ${n}\nrole: worker\nsubscribe: [general]\nallowPublish: [general]\n---\n${n} persona.\n`);

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
  const OWNER = await cotalAuthProvider.ownerForLogin({ dir, space: SPACE });
  const idpPin = loadPinnedIdp(dir)!;
  check(
    "ownerForLogin (cache round-trip) == exchange-time derivation",
    OWNER === deriveOwnerForIdpSubject(loadOwnerSecret(dir)!, idpPin.issuer, sub),
    { OWNER },
  );
  grantActor(dir, { owner: OWNER, actor: "cli", scope: ["spawn"], allowSubscribe: ["general"], allowPublish: ["general"], label: "smoke operator" });
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
  const alphaToken = readFileSync(join(credsDir, "alpha.actor-token"), "utf8").trim(); // capture for D + F
  // Witness the presence join on the OPERATOR's OWN user bearer (login → exchange → connect), watching the roster.
  const opCreds = await cotalAuthProvider.userCredentials({ dir, space: SPACE, actor: "cli" });
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
  try { await cotalAuthProvider.userCredentials({ dir, space: SPACE, actor: "cli" }); }
  catch (e) { credThrew = (e as Error).message; }
  writeFileSync(cliRowPath, cliRowOrig); // restore the honest row
  check("a token-hash forged into the interactive cli row fails closed (readRow denies)", /interactive grant|token hash/i.test(credThrew), credThrew);

  // ---------- D. agent exchange + live-expiry proof ----------
  console.log("D) direct agent exchange (ttlSec:10) → a live connection that dies at the bearer's exp");
  const shortEx = await agentExchange("alpha", alphaToken, OWNER, 10);
  check("direct agent exchange { owner, actorToken, ttlSec:10 } mints a bearer (200)", shortEx.status === 200 && typeof shortEx.body.token === "string", shortEx.status);
  const callout = loadCalloutAuth(dir)!;
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
  try { deadHealth = JSON.parse(readFileSync(join(credsDir, "alpha.auth-health.json"), "utf8")); } catch { /* */ }
  check("the health file records state=failed with the restart copy", deadHealth.state === "failed" && /restart it with `cotal up`/.test(deadHealth.reason ?? ""), deadHealth);
  check("manager ps reports authHealth = auth-renewal-failed", manager.list().find((a) => a.name === "alpha")?.authHealth === "auth-renewal-failed", manager.list().find((a) => a.name === "alpha"));

  console.log("G) spawning with the auth service down is refused at preflight (row rolled back)");
  const gReply = await manager.startAgent({ name: "beta", agent: "e2e", owner: OWNER });
  check("spawn with a dead auth service is refused at preflight (names `cotal up`)", !gReply.ok && /preflight/.test(gReply.error ?? "") && /restart it with `cotal up`/.test(gReply.error ?? ""), gReply.error);
  check("the refused spawn leaves NO managed row behind (rollback proven)", !existsSync(rowFile("managed", OWNER, "beta")), rowFile("managed", OWNER, "beta"));

  // ---------- E (part 2): heal ----------
  console.log("E) restart the auth service → the bearer command heals and `ps` is auth-clean again");
  authChild = spawnAuthService();
  await waitAuthReady();
  const healRun = await execBearer(alphaBearerArgv);
  check("the agent bearer command succeeds after the auth service heals", healRun.ok && healRun.stdout.trim().split(".").length === 3, { ok: healRun.ok, err: healRun.stderr.slice(0, 120) });
  check("manager ps is auth-clean again (no authHealth flag)", manager.list().find((a) => a.name === "alpha")?.authHealth === undefined, manager.list().find((a) => a.name === "alpha"));

  // ---------- F. revocation ----------
  console.log("F) manager teardown revokes the managed row + shreds files; the old token is uniformly denied");
  await manager.stop(); // teardown deprovisions alpha: user-mode revoke (row delete) + token/sentinel/health shred
  managerStopped = true;
  const rowGone = !existsSync(managedRowPath);
  const filesGone = ["alpha.actor-token", "alpha.sentinel.creds", "alpha.auth-health.json"].every((f) => !existsSync(join(credsDir, f)));
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
  if (manager && !managerStopped) await manager.stop().catch(() => {});
  await killPid(authChild?.pid);
  broker?.kill("SIGKILL");
  idpSrv.close();
  rmSync(home, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
}
process.exit(process.exitCode ?? 0);
