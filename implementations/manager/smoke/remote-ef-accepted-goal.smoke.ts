/**
 * E/F accepted-goal composition on a REAL user-auth mesh (partial, labelled fixture).
 *
 * Real pieces: a dev Better-Auth IdP, `cotal up --user-auth`-equivalent host preparation, the
 * shipped `cotal auth-service` daemon (callout + public exchange), a signed-in participant home,
 * the shipped `cotal supervise` (signerless remote manager) and the shipped `cotal ps`/`cotal spawn`.
 *
 * LABELLED TRUSTED FIXTURE HOST: a proxy in front of the daemon's public face. It forwards every
 * route unchanged EXCEPT managed-agent enrollment, which stock deliberately refuses (403, host
 * platform interception required). For that one kind it authenticates the caller's IdP token,
 * asks the daemon's REAL loopback verify-enrollment door, writes the managed ledger row for the
 * token DIGEST and returns the closed material. It never gives the manager a signing key, never
 * answers without the door's decision, and is not a production SandboxProvider.
 *
 * Run: pnpm exec tsx implementations/manager/smoke/remote-ef-accepted-goal.smoke.ts
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { CotalEndpoint, createSpaceAuth, mintCreds, provisionAgentDurables, mintLifecycleUid, newIdentity, probeConnect, serverConfig, setupSpaceStreams } from "@cotal-ai/core";
import { SMOKE_BROKER_TOKEN, killAndAwaitExit, teardownOnSignal } from "@cotal-ai/smoke-kit";
import { authDir, saveSpaceAuth, userAuthStateDir, workspaceSecretStore } from "@cotal-ai/workspace";
import {
  cotalAuthProvider, deriveOwnerForIdpSubject, establishIdpSession, grantActor, grantManagedActor,
  loadAuthServiceInfo, loadCalloutAuth, loadOwnerSecret, VERIFY_ENROLLMENT_PATH,
} from "../../auth/src/index.js";
import { pickFreePort } from "./_free-port.js";
import { persistRemoteUserEntry } from "../../cli/src/commands/meshes-add.js";

// LABELLED SCRIPTED SDK FIXTURE CHILD (stands in for a model worker; not a production provider):
// joins the mesh with the stock endpoint using ONLY the enrolled bearer command + sentinel path.
if (process.argv[2] === "agent-child") {
  try {
    const { CotalEndpoint } = await import("@cotal-ai/core");
    const { readFileSync } = await import("node:fs");
    const { execFile } = await import("node:child_process");
    const cmd = JSON.parse(process.env.COTAL_BEARER_CMD!) as string[];
    const bearer = () => new Promise<string>((res, rej) => execFile(cmd[0]!, cmd.slice(1), (e, out, err) => e ? rej(new Error(err.trim() || e.message)) : res(out.trim())));
    const ep = new CotalEndpoint({
      space: process.env.COTAL_SPACE!, servers: process.env.COTAL_SERVERS!, bearer,
      sentinelCreds: readFileSync(process.env.COTAL_SENTINEL_CREDS!, "utf8"),
      lifecycleUid: process.env.COTAL_LIFECYCLE_UID!, channels: [], consume: false,
      card: { owner: process.env.COTAL_OWNER!, actor: process.env.COTAL_ACTOR!, name: process.env.COTAL_NAME!, kind: "agent" },
    });
    ep.on("error", () => {});
    await ep.start();
    await new Promise(() => {});
  } catch (e) {
    console.error(`ef-sdk-fixture child failed: ${(e instanceof Error ? e.message : String(e)).replace(/eyJ[\w-]+\.[\w-]+\.[\w-]+/g, "[jwt]").replace(/-----BEGIN[\s\S]*?-----END[^-]*-----/g, "[creds]").slice(0, 400)}`);
    process.exit(1);
  }
}

const authRequire = createRequire(new URL("../../auth/package.json", import.meta.url));
const { jwtVerify, createRemoteJWKSet } = authRequire("jose") as { jwtVerify: any; createRemoteJWKSet: any };
const baRoot = new URL("../../auth/node_modules/better-auth/", import.meta.url);

let pass = 0, fail = 0;
const ok = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ FAIL: ${name}${extra === undefined ? "" : ` - ${String(typeof extra === "string" ? extra : JSON.stringify(extra)).slice(0, 500)}`}`); }
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

for (const k of Object.keys(process.env)) if (k.startsWith("COTAL_")) delete process.env[k];
const space = `efgoal${Math.random().toString(36).slice(2, 8)}`;
const kids: ChildProcess[] = [];
const repoRoot = resolve(import.meta.dirname, "..", "..", "..");
const cliBin = join(repoRoot, "bin", "cotal.ts");
const tsxLoader = import.meta.resolve("tsx");
const childEnv = (home: string): NodeJS.ProcessEnv => ({
  PATH: process.env.PATH ?? "", TMPDIR: tmpdir(), LANG: "C.UTF-8", HOME: home, COTAL_HOME: home,
  XDG_CONFIG_HOME: join(home, "xdg"), COTAL_SKIP_CONNECTOR_SEED: "1",
});
const cli = (argv: string[], cwd: string, home: string, ms = 90_000) => new Promise<{ code: number | null; out: string }>((res) => {
  const p = spawn(process.execPath, ["--import", tsxLoader, cliBin, ...argv], { cwd, env: childEnv(home), stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  p.stdout?.on("data", (d) => { out += d.toString(); });
  p.stderr?.on("data", (d) => { out += d.toString(); });
  const t = setTimeout(() => p.kill("SIGTERM"), ms);
  p.on("exit", (code) => { clearTimeout(t); res({ code, out }); });
});

const auth = await createSpaceAuth(space);
const hostRoot = mkdtempSync(join(tmpdir(), `${SMOKE_BROKER_TOKEN}efgoal-host-`));
const hostHome = mkdtempSync(join(tmpdir(), "efgoal-hosthome-"));
const partRoot = mkdtempSync(join(tmpdir(), "efgoal-part-"));
// A seat socket path lives under HOME/.cotal/seats and must fit the 108-byte Unix limit; an
// explicit short root (EF_SHORT_HOME_ROOT) keeps it within the lane scratch.
// EF_SHORT_ROOT: an existing short directory. Each run claims a fresh one-letter home in it (mkdir
// fails if taken) and removes it at teardown, so repeated runs never share state.
const partHome = (() => {
  // The root itself is the one-letter slot: EF_SHORT_ROOT names a PARENT, and the home is
  // <parent>/<letter>, claimed by an exclusive mkdir. Keep the parent path short (a seat socket
  // path must stay within the 108-byte Unix limit).
  const base = process.env.EF_SHORT_ROOT ?? tmpdir();
  for (const c of "abcdefghijklmnopqrstuvwxyz") {
    const home = `${base}${c}`;
    try { mkdirSync(home); return home; } catch { /* taken */ }
  }
  throw new Error(`no free one-letter home at ${base}?`);
})();
const jsStore = mkdtempSync(join(tmpdir(), `${SMOKE_BROKER_TOKEN}efgoal-js-`));
mkdirSync(join(hostRoot, ".cotal"), { recursive: true });
saveSpaceAuth(authDir(hostRoot), auth);
const hostDir = userAuthStateDir(hostRoot, space);
const hostStore = workspaceSecretStore(hostRoot);

let idpServer: ReturnType<typeof createServer> | undefined;
let proxy: ReturnType<typeof createServer> | undefined;
let releaseBroker: (() => void) | undefined;
let broker: ChildProcess | undefined;
const intercepted: Array<{ status: number; actor?: string; owner?: string; reason?: string }> = [];
try {
  // ---- dev IdP ----
  const { betterAuth } = await import(new URL("dist/index.mjs", baRoot).href);
  const { memoryAdapter } = await import(new URL("dist/adapters/memory-adapter/index.mjs", baRoot).href);
  const { jwt } = await import(new URL("dist/plugins/jwt/index.mjs", baRoot).href);
  const { deviceAuthorization } = await import(new URL("dist/plugins/device-authorization/index.mjs", baRoot).href);
  const { bearer } = await import(new URL("dist/plugins/bearer/index.mjs", baRoot).href);
  const { toNodeHandler } = await import(new URL("dist/integrations/node.mjs", baRoot).href);
  let idpHandler: any;
  idpServer = createServer((q, s) => idpHandler(q, s));
  await new Promise<void>((r) => idpServer!.listen(0, "127.0.0.1", r));
  const idpOrigin = `http://127.0.0.1:${(idpServer.address() as AddressInfo).port}`;
  const idpUrl = `${idpOrigin}/api/auth`;
  const clientId = "efgoal-smoke";
  const idp = betterAuth({
    baseURL: idpOrigin, secret: "efgoal-smoke-secret-0123456789abcdef",
    database: memoryAdapter({ user: [], session: [], account: [], verification: [], jwks: [], deviceCode: [] }),
    emailAndPassword: { enabled: true },
    plugins: [jwt({ jwt: { issuer: idpOrigin, audience: idpOrigin } }), deviceAuthorization({ expiresIn: "2m", interval: "1s", validateClient: (id: string) => id === clientId }), bearer()],
  });
  idpHandler = toNodeHandler(idp);

  // ---- host preparation + broker + real auth-service daemon ----
  const prepared = await cotalAuthProvider.prepareServer({
    space, operatorSeed: auth.operator.seed, account: { pub: auth.account.pub, signingSeed: auth.account.signingSeed },
    store: hostStore, dir: hostDir, idpUrl,
  });
  const port = await pickFreePort();
  const servers = `nats://127.0.0.1:${port}`;
  writeFileSync(join(hostRoot, "server.conf"), serverConfig(auth, [auth], { transport: { kind: "plaintext" }, port, storeDir: jsStore, extraAccounts: prepared.extraAccounts }));
  broker = spawn("nats-server", ["-c", join(hostRoot, "server.conf")], { stdio: "ignore" });
  releaseBroker = teardownOnSignal(broker, jsStore);
  for (let i = 0; i < 80; i++) {
    const p = await probeConnect(servers, { timeoutMs: 400 });
    if (p.ok || ("reason" in p && p.reason === "auth-required")) break;
    await sleep(100);
  }
  await setupSpaceStreams({ servers, space, creds: await mintCreds(auth, newIdentity(), "provisioner") });
  const daemon = spawn(process.execPath, ["--import", tsxLoader, cliBin, "auth-service", "--space", space, "--server", servers, "--exchange-public-port", "0"],
    { cwd: hostRoot, env: childEnv(hostHome), stdio: ["ignore", "pipe", "pipe"] });
  kids.push(daemon);
  let info: ReturnType<typeof loadAuthServiceInfo>;
  for (let i = 0; i < 300 && daemon.exitCode === null; i++) {
    info = loadAuthServiceInfo(hostDir);
    if (info?.publicUrl) { try { if ((await fetch(`${info.url}/health`)).ok) break; } catch { /* booting */ } }
    await sleep(200);
  }
  ok("real auth-service daemon is up with a public exchange face", typeof info!?.publicUrl === "string");
  const publicUrl = info!.publicUrl!.replace(/\/$/, "");
  const loopbackUrl = info!.url;
  const cap = info!.cap;

  // ---- labelled trusted fixture host proxy ----
  const ownerSecret = await loadOwnerSecret(hostStore, space);
  const callout = await loadCalloutAuth(hostStore, space);
  const jwks = createRemoteJWKSet(new URL(`${idpUrl}/jwks`));
  let proxyUrl = "";
  const readBody = async (q: IncomingMessage) => { let b = ""; for await (const c of q) b += c; return b; };
  const forward = async (q: IncomingMessage, s: ServerResponse, body: string) => {
    const headers: Record<string, string> = {};
    for (const h of ["content-type", "authorization"]) if (typeof q.headers[h] === "string") headers[h] = q.headers[h] as string;
    const r = await fetch(`${publicUrl}${q.url}`, { method: q.method, headers, ...(q.method === "GET" || q.method === "HEAD" ? {} : { body }) });
    s.writeHead(r.status, { "content-type": r.headers.get("content-type") ?? "application/json" });
    s.end(Buffer.from(await r.arrayBuffer()));
  };
  proxy = createServer(async (q, s) => {
    const body = q.method === "POST" ? await readBody(q) : "";
    let parsed: any;
    try { parsed = body ? JSON.parse(body) : undefined; } catch { /* forward as is */ }
    if (q.url === "/.well-known/cotal-mesh") {
      // The platform edge publishes ITS OWN URL as the exchange pin (it is what participants dial);
      // every other pin is the daemon's generated bundle unchanged.
      const r = await fetch(`${publicUrl}${q.url}`);
      const bundle = await r.json() as any;
      bundle.userAuth.endpoints = { ...bundle.userAuth.endpoints, url: proxyUrl };
      s.writeHead(r.status, { "content-type": "application/json" });
      return void s.end(JSON.stringify(bundle));
    }
    if (q.url !== "/manager-service-authority" || parsed?.request?.kind !== "manager-managed-agent-enrollment") return void forward(q, s, body);
    const send = (code: number, v: unknown) => { s.writeHead(code, { "content-type": "application/json" }); s.end(JSON.stringify(v)); };
    try {
      const { payload } = await jwtVerify(parsed.idpToken, jwks, { issuer: idpOrigin, audience: idpOrigin });
      const owner = deriveOwnerForIdpSubject(ownerSecret!, idpOrigin, payload.sub);
      const door = await fetch(`${loopbackUrl}${VERIFY_ENROLLMENT_PATH}`, {
        method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${cap}` },
        body: JSON.stringify({ owner, request: parsed.request }),
      });
      const verdict = await door.json() as any;
      if (!door.ok || verdict.authorized !== true) {
        intercepted.push({ status: door.status, reason: String(verdict.error ?? "").slice(0, 200) });
        return send(door.status === 200 ? 403 : door.status, { error: verdict.error ?? "refused" });
      }
      const r = parsed.request;
      const t = r.target;
      const lifecycleUid = mintLifecycleUid();
      grantManagedActor(hostDir, {
        owner, actor: t.actor, scope: t.capabilities ?? [], allowSubscribe: t.allowSubscribe ?? [], allowPublish: t.allowPublish ?? [],
        ...(t.role !== undefined ? { role: t.role } : {}), parent: `${owner}.${r.actor}`, lifecycleUid, tokenHash: t.tokenHash,
      } as never);
      // Host-owned broker footprint for the enrolled lifecycle (the host holds the provisioner;
      // the participant manager holds no writer).
      const provisioner = new CotalEndpoint({
        space, servers, creds: await mintCreds(auth, newIdentity(), "provisioner"), channels: [],
        consume: false, registerPresence: false, watchPresence: false, watchChannels: false,
        card: { name: "ef-fixture-host-provisioner", kind: "endpoint" },
      });
      await provisioner.start();
      try { await provisionAgentDurables(provisioner, { owner, actor: t.actor, lifecycleUid }, { subscribe: t.subscribe ?? [], allowSubscribe: t.allowSubscribe ?? [] }); }
      finally { await provisioner.stop(); }
      intercepted.push({ status: 200, actor: t.actor, owner });
      return send(200, {
        v: 1, kind: "manager-managed-agent-enrollment", space: r.space, owner, actor: r.actor, instanceId: r.instanceId,
        managerLifecycleUid: r.managerLifecycleUid, requestId: r.requestId, registrationProof: r.registrationProof, serveEpoch: r.serveEpoch,
        material: {
          owner, actor: t.actor, lifecycleUid, sentinelCreds: callout!.sentinelCreds, subscribe: t.subscribe ?? [],
          allowSubscribe: t.allowSubscribe ?? [], allowPublish: t.allowPublish ?? [], agentBearerExchangeUrl: proxyUrl,
        },
      });
    } catch (e) {
      intercepted.push({ status: 403, reason: (e as Error).message.slice(0, 200) });
      return send(403, { error: (e as Error).message });
    }
  });
  await new Promise<void>((r) => proxy!.listen(0, "127.0.0.1", r));
  proxyUrl = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;

  // ---- participant sign-in (real device flow) + interactive row for its cli actor ----
  process.env.COTAL_HOME = partHome;
  const signup = await idp.api.signUpEmail({ body: { email: "p@example.test", password: "correct-horse-battery", name: "P" }, returnHeaders: true });
  const cookie = signup.headers.get("set-cookie")!.split(";")[0]!;
  const approve = async (userCode: string) => {
    await fetch(`${idpUrl}/device?user_code=${encodeURIComponent(userCode)}`, { headers: { cookie, origin: idpOrigin } });
    await fetch(`${idpUrl}/device/approve`, { method: "POST", headers: { "content-type": "application/json", cookie, origin: idpOrigin }, body: JSON.stringify({ userCode }) });
  };
  await establishIdpSession({ dir: partHome, idpUrl, clientId, onPrompt: (p: { userCode: string }) => void approve(p.userCode) });
  const owner = deriveOwnerForIdpSubject(ownerSecret!, idpOrigin, (await idp.api.getSession({ headers: new Headers({ cookie }) }))!.user.id);
  // FIXTURE operator grant: events-required mesh arms the event plane on spawn, which is admin tier.
  grantActor(hostDir, { owner, actor: "cli", scope: ["spawn", "supervise", "admin"], allowSubscribe: ["general"], allowPublish: ["general"] });
  ok("participant owner is a derived user owner (not 'local')", /^u_[a-z2-7]{26}$/.test(owner), owner);
  mkdirSync(join(partRoot, ".cotal", "auth"), { recursive: true });
  // The shipped registration write `cotal meshes add --from` performs (sentinel lands 0600 under
  // the participant root; the registry records only its path). Pinned exchange = fixture host.
  persistRemoteUserEntry(space, servers, partRoot, {
    space, server: servers, tlsRequired: false, policy: { events: "required" }, sentinelCreds: callout!.sentinelCreds,
    userAuth: { provider: "cotal", idp: { url: idpUrl, issuer: idpOrigin, audience: idpOrigin }, endpoints: { url: proxyUrl } } as never,
  }, false, false);
  mkdirSync(join(partHome, "xdg"), { recursive: true });
  // Labelled fixture connector extension + persona (operator-installed, like `cotal ext add`).
  const extRoot = join(partHome, "xdg", "cotal", "extensions");
  const extDir = join(extRoot, "node_modules", "ef-sdk-fixture-extension");
  mkdirSync(extDir, { recursive: true });
  writeFileSync(join(extDir, "package.json"), JSON.stringify({ name: "ef-sdk-fixture-extension", version: "1.0.0", type: "module", main: "index.js", peerDependencies: { "@cotal-ai/core": "*" } }));
  writeFileSync(join(extDir, "index.js"), `
import { registry, eventChannel } from "@cotal-ai/core";
registry.register({
  kind: "connector", name: "ef-sdk-fixture", readinessTimeoutMs: 30000,
  // The events-required mesh policy needs a connector that declares its event channel.
  eventChannel: (principal) => eventChannel(principal),
  buildLaunch(opts) {
    if (!opts.userAuth || !opts.lifecycleUid) throw new Error("ef-sdk-fixture requires enrolled user authority");
    return {
      command: process.execPath,
      args: [...JSON.parse(process.env.COTAL_EF_EXECARGV), process.env.COTAL_EF_FIXTURE, "agent-child"],
      env: {
        COTAL_SPACE: opts.space, COTAL_SERVERS: opts.servers, COTAL_NAME: opts.name,
        COTAL_OWNER: opts.userAuth.owner, COTAL_ACTOR: opts.userAuth.actor,
        COTAL_SENTINEL_CREDS: opts.userAuth.sentinelCredsPath,
        COTAL_BEARER_CMD: JSON.stringify(opts.userAuth.bearerCmd), COTAL_LIFECYCLE_UID: opts.lifecycleUid,
        XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, COTAL_SKIP_CONNECTOR_SEED: process.env.COTAL_SKIP_CONNECTOR_SEED,
      },
    };
  },
});
`);
  writeFileSync(join(extRoot, "extensions.json"), JSON.stringify({ extensions: [{
    pkg: "ef-sdk-fixture-extension", version: "1.0.0", spec: "file:ef-sdk-fixture-extension",
    provides: [{ kind: "connector", name: "ef-sdk-fixture" }], commands: [], connectors: [{ name: "ef-sdk-fixture", requires: [] }],
  }] }));
  mkdirSync(join(partRoot, ".cotal", "agents"), { recursive: true });
  writeFileSync(join(partRoot, ".cotal", "agents", "sdkfixture.md"), "---\nname: sdkfixture\nagent: ef-sdk-fixture\n---\nlabelled scripted SDK fixture\n");

  // ---- shipped `cotal supervise` as the signerless participant manager ----
  const sup = spawn(process.execPath, ["--import", tsxLoader, cliBin, "supervise", "--space", space], {
    cwd: partRoot, stdio: ["ignore", "pipe", "pipe"],
    env: { ...childEnv(partHome), COTAL_EF_EXECARGV: JSON.stringify(["--import", tsxLoader]), COTAL_EF_FIXTURE: import.meta.filename },
  });
  kids.push(sup);
  let supOut = "";
  sup.stdout?.on("data", (d) => { supOut += d.toString(); });
  sup.stderr?.on("data", (d) => { supOut += d.toString(); });
  for (let i = 0; i < 600 && sup.exitCode === null && !/✓ manager up/.test(supOut); i++) await sleep(200);
  ok("shipped `cotal supervise` brings the signerless remote manager up for the user-bearer participant", /✓ manager up/.test(supOut), supOut.slice(-600));

  // ---- the topology correction: a user-bearer caller reaches the manager's host-authorized reads ----
  const ps = await cli(["ps", "--space", space], partRoot, partHome);
  console.log(`    evidence: user-bearer cotal ps exit=${ps.code} out=${ps.out.replace(/\s+/g, " ").slice(0, 300)}`);
  ok("user-bearer `cotal ps` is answered (the static 'local' owner refusal does not apply)", ps.code === 0 && !/invalid derived owner token/.test(ps.out), ps.out.slice(-400));

  // ---- accepted goal: shipped `cotal spawn --detach` ----
  const before = intercepted.length;
  const sp = await cli(["spawn", "sdkfixture", "--detach", "--space", space], partRoot, partHome, 120_000);
  console.log(`    evidence: cotal spawn exit=${sp.code} intercepted=${JSON.stringify(intercepted.slice(before))} out=${sp.out.replace(/\s+/g, " ").slice(0, 600)}`);
  ok("accepted spawn goal: enrollment intercepted by the fixture host with the stock door's authorization", intercepted.slice(before).some((x) => x.status === 200 && x.actor === "sdkfixture" && x.owner === owner), intercepted.slice(before));
  ok("accepted spawn goal reaches a terminal success (scripted SDK child joined)", sp.code === 0, sp.out.slice(-500));
  const ps2 = await cli(["ps", "--space", space], partRoot, partHome);
  console.log(`    evidence: ps after spawn exit=${ps2.code} out=${ps2.out.replace(/\s+/g, " ").slice(0, 300)}`);
  ok("manager lists the enrolled SDK fixture agent", ps2.code === 0 && /sdkfixture/.test(ps2.out), ps2.out.slice(-300));

  // Wrong-caller refusal: an enrollment from an IdP user whose derived owner has NO interactive
  // ledger row for the manager actor is refused by the stock door, and nothing is granted.
  const other = await idp.api.signUpEmail({ body: { email: "o@example.test", password: "correct-horse-battery", name: "O" }, returnHeaders: true });
  const otherCookie = other.headers.get("set-cookie")!.split(";")[0]!;
  const otherJwt = (await (await fetch(`${idpUrl}/token`, { headers: { cookie: otherCookie } })).json() as any).token as string;
  const wrongBefore = intercepted.length;
  const wrong = await fetch(`${proxyUrl}/manager-service-authority`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ idpToken: otherJwt, request: { v: 1, kind: "manager-managed-agent-enrollment", space, actor: "cli", instanceId: "x".repeat(31), managerLifecycleUid: mintLifecycleUid(), requestId: `enroll${mintLifecycleUid()}`, registrationProof: `sha256:${"0".repeat(64)}`, serveEpoch: 0, target: { actor: "intruder", tokenHash: "0".repeat(64), allowSubscribe: [] }, identities: {} } }),
  });
  const wrongBody = await wrong.json() as any;
  console.log(`    evidence: wrong-caller enrollment status=${wrong.status} error=${String(wrongBody.error).slice(0, 160)} recorded=${JSON.stringify(intercepted.slice(wrongBefore))}`);
  ok("wrong-caller enrollment (IdP user with no ledger row) is refused and grants nothing", wrong.status >= 400 && !intercepted.slice(wrongBefore).some((x) => x.status === 200), { status: wrong.status });
  console.log("  ? LABEL: this is the ORDINARY signerless participant (cotal supervise, local launch); the pooled non-custodial runtime and SDK-owned result/successor fencing remain OPEN");
} finally {
  for (const k of kids) await killAndAwaitExit(k).catch(() => {});
  proxy?.close();
  idpServer?.closeAllConnections();
  idpServer?.close();
  if (broker) await killAndAwaitExit(broker).catch(() => {});
  releaseBroker?.();
  rmSync(partHome, { recursive: true, force: true });
}
console.log(`\nremote-ef-accepted-goal: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
