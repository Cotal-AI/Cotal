/**
 * Issue #10805: a hosted Manager that loses its connection to its space. The machine daemon's live
 * status feed (`status-watch`, what the desktop app reads) must report the loss by itself, without
 * anyone asking for a full status, and must report the Manager answering again once the network is
 * back. Only this computer's paths to the space (broker TCP, exchange, IdP) are cut; the broker and
 * its services stay up, as they do when a laptop goes offline. Three kinds of loss: short drops the
 * Manager re-dials at once (no report), a reset link that stays down, and a silent drop where nothing
 * is reset and nothing answers (a laptop whose Wi-Fi went away). The last phase runs a Manager built
 * before the connection question, which must not be read as failing its health check.
 * The first cells drive the shipped lookup that tells "no internet" from "the space is not answering".
 */
import assert from "node:assert/strict";
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import { type AddressInfo } from "node:net";
import { createHash } from "node:crypto";
import { createConnection, createServer as createTcpServer, type Socket } from "node:net";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  SERVICE_AUTHORITY_MAX_BYTES, composeSpaceAuth, createBrokerAuth, createSpaceAccountAuth,
  isReachable, mintCreds, mintLifecycleUid, mkSecretDir, newIdentity, serverConfig,
  setupSpaceStreams, writeSecretFileAtomic, mintMembershipObserverCreds, mintConnectionEvictorCreds,
  type SecretStore,
} from "@cotal-ai/core";
import {
  deriveOwnerForIdpSubject, ensureCalloutAuth, ensureIssuer, ensureOwnerSecret, ensurePinnedIdp,
  grantActor, loadOwnerSecret, saveIdpSession, saveServiceKeys, startAuthService,
  mintServiceCallerPayloadObserverCreds, type AuthServiceHandle,
} from "@cotal-ai/auth";
import {
  connectionEvictorCredsKey, deliveryCredsKey, membershipObserverCredsKey, membershipRwCredsKey,
  findMesh, recordMesh, userAuthStateDir, type MeshEntry,
} from "@cotal-ai/workspace";
import { startDeliveryService } from "@cotal-ai/delivery";
import { freePort, killAndAwaitExit, skipSuite, teardownOnSignal, SMOKE_BROKER_TOKEN } from "@cotal-ai/smoke-kit";
import { daemonPaths } from "../daemon/endpoint.js";
import { unitReceiptFile } from "../daemon/install.js";
import { managerViaDaemon, queryDaemon } from "../daemon/client.js";
import { emitSentinel } from "./sentinel.mjs";
import { lostConnection } from "../daemon/lost-connection.js";
import type { HostedManager } from "../daemon/protocol.js";

if (process.platform !== "linux") skipSuite(`daemon-lost-connection smoke: Linux only; skipped on ${process.platform}`);
for (const key of Object.keys(process.env)) if (key.startsWith("COTAL_")) delete process.env[key];

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..", "..");
const targetVersion = (JSON.parse(readFileSync(join(repo, "bin/package.json"), "utf8")) as { version: string }).version;

const authRequire = createRequire(join(repo, "implementations", "auth", "package.json"));
type Jose = {
  generateKeyPair(alg: string): Promise<{ publicKey: CryptoKey; privateKey: CryptoKey }>;
  exportJWK(key: CryptoKey): Promise<Record<string, unknown>>;
  SignJWT: new (payload: Record<string, unknown>) => {
    setProtectedHeader(h: Record<string, unknown>): any; setIssuer(v: string): any; setAudience(v: string): any; setSubject(v: string): any;
    setIssuedAt(v: number): any; setExpirationTime(v: number): any; sign(k: CryptoKey): Promise<string>;
  };
};
const { SignJWT, exportJWK, generateKeyPair } = await import(pathToFileURL(authRequire.resolve("jose")).href) as Jose;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const daemonLog: string[] = [];
// The daemon's loss and recovery lines, kept whole: its log file is bounded, so how often it writes them matters.
const connectionLines: { at: number; line: string }[] = [];
let pass = 0, fail = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ FAIL: ${name}`, JSON.stringify(extra ?? "")?.slice(0, 600)); }
};

function readCliStatus(entry: string, cwd: string, env: NodeJS.ProcessEnv, ...args: string[]) {
  const argv = [entry, "--no-color", "daemon", "status", ...args];
  const start = performance.now();
  return new Promise<{ code: number | string | null; ms: number; stdout: string; stderr: string }>((resolve) => {
    execFile(process.execPath, argv, { cwd, env, timeout: 55_000 }, (error, stdout, stderr) => {
      const result = { code: error ? error.code ?? error.signal ?? null : 0, ms: Math.round(performance.now() - start), stdout, stderr };
      resolve(result);
    });
  });
}

// The shipped lookup, with the system resolver replaced so each answer is chosen.
{
  let calls = 0;
  const counted = (answer: () => Promise<unknown>) => (_host: string) => { calls++; return answer(); };
  const failure = (code: string) => () => Promise.reject(Object.assign(new Error(code), { code }));
  const ip = await lostConnection("nats://127.0.0.1:4222", counted(failure("ENOTFOUND")));
  const ip6 = await lostConnection("nats://[::1]:4222", counted(failure("ENOTFOUND")));
  check("U1 a broker at an address needs no lookup: the space is not answering", calls === 0 && ip.state === "unreachable" && ip.reason === "127.0.0.1 is not answering" && ip6.state === "unreachable" && ip6.reason === "::1 is not answering", { calls, ip, ip6 });
  const notFound = await lostConnection("wss://cloud.example.test/nats", counted(failure("ENOTFOUND")));
  const again = await lostConnection("nats://dns-again.example.test:4222", counted(failure("EAI_AGAIN")));
  check("U2 a failed lookup means no internet connection, naming the host and the code", notFound.state === "offline" && notFound.reason === "this computer cannot look up cloud.example.test (ENOTFOUND)" && again.state === "offline" && again.reason.endsWith("(EAI_AGAIN)"), { notFound, again });
  const found = await lostConnection("tls://up.example.test:4222", counted(() => Promise.resolve({ address: "192.0.2.1", family: 4 })));
  check("U3 a working lookup means the space is not answering", found.state === "unreachable" && found.reason === "up.example.test is not answering", found);
  calls = 0;
  const stalled = counted(() => new Promise(() => {}));
  const t = Date.now();
  const [first, second] = await Promise.all([lostConnection("nats://stalled.example.test:4222", stalled), lostConnection("nats://stalled.example.test:4222", stalled)]);
  const third = await lostConnection("nats://stalled.example.test:4222", stalled);
  check("U4 a lookup that does not finish means no internet connection, and a host keeps one lookup in flight", first.state === "offline" && first.reason.endsWith("(ETIMEOUT)") && second.state === "offline" && third.state === "offline" && calls === 1 && Date.now() - t < 10_000, { first, calls, ms: Date.now() - t });
  calls = 0;
  const byHost = (answers: Record<string, () => Promise<unknown>>) => (host: string) => { calls++; return answers[host]!(); };
  const listUp = await lostConnection("nats://down.example.test:4222, nats://up2.example.test:4222", byHost({ "down.example.test": failure("ENOTFOUND"), "up2.example.test": () => Promise.resolve({ address: "192.0.2.2", family: 4 }) }));
  const listDown = await lostConnection("nats://a.example.test:4222,nats://b.example.test:4222", byHost({ "a.example.test": failure("ENOTFOUND"), "b.example.test": failure("EAI_AGAIN") }));
  const listAddress = await lostConnection("nats://c.example.test:4222,nats://192.0.2.7:4222", byHost({}));
  check("U5 a server list: one host that looks up means not answering, every lookup failing means no internet, an address needs no lookup", listUp.state === "unreachable" && listUp.reason === "up2.example.test is not answering" && listDown.state === "offline" && listDown.reason === "this computer cannot look up a.example.test (ENOTFOUND)" && listAddress.state === "unreachable" && listAddress.reason === "192.0.2.7 is not answering" && calls === 4, { listUp, listDown, listAddress, calls });
}

class MemoryStore implements SecretStore {
  readonly values = new Map<string, string>();
  constructor(readonly identity: { kind: "injected"; coordinate: string }) {}
  async get(k: string) { return this.values.get(k); }
  async put(k: string, v: string) { this.values.set(k, v); }
  async create(k: string, v: string) { if (this.values.has(k)) return false; this.values.set(k, v); return true; }
  async delete(k: string) { this.values.delete(k); }
}

const root = mkdtempSync(join(tmpdir(), "dlc-"));
chmodSync(root, 0o700);
const privateCliDir = join(root, "cli");
mkdirSync(privateCliDir, { recursive: true, mode: 0o700 });
cpSync(join(repo, "bin", "package.json"), join(privateCliDir, "package.json"));
cpSync(join(repo, "bin", "dist"), join(privateCliDir, "dist"), { recursive: true });
// The CLI's packages, with the Manager package behind its own link so the last phase can swap in an
// older Manager.
const repoModules = join(repo, "bin", "node_modules");
const cliModules = join(privateCliDir, "node_modules");
mkdirSync(join(cliModules, "@cotal-ai"), { recursive: true, mode: 0o700 });
for (const entry of readdirSync(repoModules)) if (entry !== "@cotal-ai") symlinkSync(join(repoModules, entry), join(cliModules, entry));
for (const entry of readdirSync(join(repoModules, "@cotal-ai"))) if (entry !== "manager") symlinkSync(join(repoModules, "@cotal-ai", entry), join(cliModules, "@cotal-ai", entry));
const managerLink = join(cliModules, "@cotal-ai", "manager");
symlinkSync(join(repo, "implementations", "manager"), managerLink);
const cliEntry = join(privateCliDir, "dist", "cotal.js");
const home = join(root, "home");
const participant = join(root, "participant");
const rtDir = join(root, "rt");
const configDir = join(root, "config");
const jsDir = mkdtempSync(join(tmpdir(), `${SMOKE_BROKER_TOKEN}dlc-js-`));
for (const d of [home, participant, rtDir, configDir]) mkdirSync(d, { recursive: true, mode: 0o700 });

process.env.HOME = home;
process.env.COTAL_HOME = home;
process.env.XDG_CONFIG_HOME = configDir;
process.env.XDG_RUNTIME_DIR = rtDir;
process.env.XDG_DATA_HOME = join(root, "data");
process.env.XDG_CACHE_HOME = join(root, "cache");

const paths = daemonPaths({ XDG_RUNTIME_DIR: rtDir });

const key = await generateKeyPair("EdDSA");
const jwk = { ...await exportJWK(key.publicKey), kid: "dlc-idp" };
const SESSION = "dlc-session-handle-not-a-secret";
let idpOrigin = "";

const idp = createHttpServer(async (req: IncomingMessage, res: ServerResponse) => {
  if (offline) { req.socket.destroy(); return; }
  if (silent) { hung.add(req.socket); return; }
  res.setHeader("content-type", "application/json");
  if (req.url?.startsWith("/api/cli/machines/") || req.url?.startsWith("/api/machines/")) {
    res.writeHead(404); res.end("{}"); return;
  }
  if (req.url === "/api/auth/jwks") {
    res.end(JSON.stringify({ keys: [jwk] })); return;
  }
  if (req.url === "/api/auth/token" && (req.headers.authorization ?? "") === `Bearer ${SESSION}`) {
    const now = Math.floor(Date.now() / 1000);
    const token = await new SignJWT({ email: "operator@example.test" })
      .setProtectedHeader({ alg: "EdDSA", kid: jwk.kid })
      .setIssuer(idpOrigin).setAudience(idpOrigin).setSubject("machine-owner")
      .setIssuedAt(now).setExpirationTime(now + 300).sign(key.privateKey);
    res.end(JSON.stringify({ token })); return;
  }
  res.writeHead(401); res.end("{}");
});
await new Promise<void>((r) => idp.listen(0, "127.0.0.1", () => r()));
idpOrigin = `http://127.0.0.1:${(idp.address() as AddressInfo).port}`;
const idpUrl = `${idpOrigin}/api/auth`;

// This computer's network. The broker and its services stay up; only the participant's paths to
// them (broker TCP, exchange, IdP) drop. `offline` resets every link and refuses new ones. `silent`
// resets nothing and delivers nothing, so only the client's own pings can notice it. A link that
// lost bytes while silent is reset when the network comes back, since its stream is no longer whole.
// `facesDown` drops only the HTTP faces (exchange, IdP), as when the broker link comes back first.
let offline = false, silent = false, facesDown = false;
const tcpLinks = new Set<Socket>();
const hung = new Set<Socket>();
const reconnectNetwork = () => { offline = false; silent = false; facesDown = false; for (const s of hung) s.destroy(); hung.clear(); };
const tcpRelays: ReturnType<typeof createTcpServer>[] = [];
async function createTcpRelay(target: number): Promise<number> {
  const server = createTcpServer((client) => {
    if (offline) { client.destroy(); return; }
    const upstream = createConnection(target, "127.0.0.1");
    for (const s of [client, upstream]) { tcpLinks.add(s); s.on("close", () => { tcpLinks.delete(s); hung.delete(s); }); s.on("error", () => {}); }
    client.on("data", (b: Buffer) => { if (silent) hung.add(client); else upstream.write(b); });
    upstream.on("data", (b: Buffer) => { if (silent) hung.add(client); else client.write(b); });
    client.on("close", () => upstream.destroy()); upstream.on("close", () => client.destroy());
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  tcpRelays.push(server);
  return (server.address() as AddressInfo).port;
}
const relays: ReturnType<typeof createHttpServer>[] = [];
// When each request reached a face that was down while the broker link was up.
const faceRefusals: number[] = [];
async function createRelay(targetUrl: string): Promise<string> {
  const server = createHttpServer(async (req: IncomingMessage, res: ServerResponse) => {
    if (facesDown && !offline) faceRefusals.push(Date.now());
    if (offline || facesDown) { req.socket.destroy(); return; }
    if (silent) { hung.add(req.socket); return; }
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(Buffer.from(c));
    const rawBody = Buffer.concat(chunks);
    const up = await fetch(`${targetUrl}${req.url}`, {
      method: req.method,
      headers: { "content-type": req.headers["content-type"] ?? "application/json" },
      body: rawBody.length ? rawBody : undefined,
      redirect: "manual",
    });
    const respBytes = Buffer.from(await up.arrayBuffer());
    const headers: Record<string, string> = {};
    up.headers.forEach((v, k) => {
      if (k !== "content-length" && k !== "transfer-encoding") headers[k] = v;
    });
    res.writeHead(up.status, headers);
    res.end(respBytes);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  relays.push(server);
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

const broker = await createBrokerAuth("dlc-broker");
const stamp = Date.now();
const spaces = [`dlc-${stamp}`] as const;
const [SPACE] = spaces;
const accounts = await Promise.all(spaces.map((s) => createSpaceAccountAuth(broker, s)));
const handles: AuthServiceHandle[] = [];
const deliveries: Awaited<ReturnType<typeof startDeliveryService>>[] = [];
let nats: ChildProcess | undefined;
let releaseNats: (() => void) | undefined;
let daemonChild: ChildProcess | undefined;
let relayPort = 0;

try {
  const ctx = await Promise.all(spaces.map(async (space, i) => {
    const auth = composeSpaceAuth(broker, accounts[i]!);
    const store = new MemoryStore({ kind: "injected", coordinate: `memory:${space}` });
    const callout = await ensureCalloutAuth(store, { space, operatorSeed: broker.operator.seed!, accountPub: auth.account.pub });
    await ensureIssuer(store, space);
    await ensureOwnerSecret(store, space);
    await saveServiceKeys(store, space, { dataAccount: { pub: auth.account.pub, signingSeed: auth.account.signingSeed! } });
    const stateDir = join(root, `state-${i}`);
    mkdirSync(stateDir, { mode: 0o700 });
    ensurePinnedIdp(stateDir, idpUrl);
    return { space, auth, store, stateDir, callout };
  }));

  const port = await freePort();
  const servers = `nats://127.0.0.1:${port}`;
  writeFileSync(
    join(jsDir, "server.conf"),
    serverConfig(broker, accounts, {
      transport: { kind: "plaintext" },
      port,
      storeDir: jsDir,
      maxPayload: SERVICE_AUTHORITY_MAX_BYTES + 1024,
      extraAccounts: ctx.map((c) => ({ pub: c.callout.account.pub, jwt: c.callout.account.jwt })),
    }),
  );
  nats = spawn(process.env.NATS_SERVER_BIN || "nats-server", ["-c", join(jsDir, "server.conf")], { stdio: "ignore" });
  releaseNats = teardownOnSignal(nats, jsDir);
  for (let i = 0; i < 50 && !(await isReachable(servers)); i++) await sleep(200);
  for (const c of ctx) {
    await setupSpaceStreams({ servers, space: c.space, creds: await mintCreds(c.auth, newIdentity(), "provisioner") });
    const owner = deriveOwnerForIdpSubject((await loadOwnerSecret(c.store, c.space))!, idpOrigin, "machine-owner");
    grantActor(c.stateDir, { owner, actor: "cli", scope: ["supervise", "spawn", "run", "role:default"], allowSubscribe: [">"], allowPublish: [">"] });
  }

  for (const c of ctx) {
    const svc = await startAuthService({
      context: { accountPublicKey: c.auth.account.pub, lifecycleUid: mintLifecycleUid() },
      space: c.space,
      servers,
      store: c.store,
      storeIdentity: c.store.identity,
      stateDir: c.stateDir,
      publicFace: { port: 0, trustedProxy: false },
      serviceEndpoints: {
        startup: { kind: "normal" as const },
        callerPayload: { observerCreds: () => mintServiceCallerPayloadObserverCreds({ pub: c.auth.sys.pub, signingSeed: c.auth.sys.signingSeed! }) },
      },
    });
    handles.push(svc);

    const deliveryStore = new MemoryStore({ kind: "injected", coordinate: `memory:delivery:${c.space}` });
    const composition = { injected: true } as const;
    await deliveryStore.put(deliveryCredsKey(c.space, composition), await mintCreds(c.auth, newIdentity(), "delivery"));
    await deliveryStore.put(membershipRwCredsKey(c.space, composition), await mintCreds(c.auth, newIdentity(), "membership-rw"));
    await deliveryStore.put(membershipObserverCredsKey(c.space, composition), await mintMembershipObserverCreds(c.auth, newIdentity()));
    await deliveryStore.put(connectionEvictorCredsKey(c.space, composition), await mintConnectionEvictorCreds(c.auth, newIdentity()));
    const deliv = await startDeliveryService({
      context: { accountPublicKey: c.auth.account.pub, lifecycleUid: mintLifecycleUid() },
      space: c.space,
      servers,
      store: deliveryStore,
      storeIdentity: deliveryStore.identity,
      stateDir: join(root, `delivery-${c.space}`),
    });
    deliveries.push(deliv);
  }

  for (const [i, c] of ctx.entries()) {
    const face = await createRelay(handles[i]!.publicUrl!.replace(/\/$/, ""));
    const bundle = await (await fetch(`${handles[i]!.publicUrl!.replace(/\/$/, "")}/.well-known/cotal-mesh`)).json() as { server: string; userAuth: MeshEntry["userAuth"]; sentinelCreds: string };
    const dir = userAuthStateDir(participant, c.space);
    mkSecretDir(dir);
    const sentinelCredsPath = join(dir, "sentinel.creds");
    writeSecretFileAtomic(sentinelCredsPath, bundle.sentinelCreds);
    relayPort = await createTcpRelay(port);
    recordMesh({
      space: c.space,
      server: `nats://127.0.0.1:${relayPort}`,
      root: participant,
      mode: "user",
      origin: "manual",
      tlsRequired: false,
      policyCheckedAt: new Date(Date.now() + 3600_000).toISOString(),
      userAuth: {
        ...bundle.userAuth!,
        endpoints: { ...bundle.userAuth!.endpoints, url: face },
        remote: true,
        sentinelCredsPath,
      },
      ts: new Date().toISOString(),
    });
  }
  saveIdpSession(home, idpUrl, { token: SESSION, expiresAt: Math.floor(Date.now() / 1000) + 3600, sub: "machine-owner" });

  const extPrefix = join(configDir, "cotal", "extensions");
  const pkg = join(extPrefix, "node_modules", "daemon-smoke-connector");
  mkdirSync(pkg, { recursive: true, mode: 0o700 });
  const coreUrl = pathToFileURL(join(repo, "packages/core/dist/index.js")).href;
  writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "daemon-smoke-connector", version: "1.0.0", type: "module", main: "index.js", peerDependencies: { "@cotal-ai/core": ">=0.1.0" } }));
  writeFileSync(join(pkg, "index.js"), `import {registry} from ${JSON.stringify(coreUrl)}; registry.register({kind:"connector",name:"daemon-smoke",requires:["node"],buildLaunch:()=>({command:process.execPath,args:["-e","setInterval(()=>{},1000)"]})});\n`);
  writeFileSync(join(extPrefix, "extensions.json"), JSON.stringify({ extensions: [{ pkg: "daemon-smoke-connector", version: "1.0.0", spec: "daemon-smoke-connector@1.0.0", provides: [{ kind: "connector", name: "daemon-smoke" }], commands: [], connectors: [{ name: "daemon-smoke", requires: ["node"], eventPlane: false }] }] }));

  const seedDir = join(configDir, "cotal", "seed");
  mkdirSync(seedDir, { recursive: true, mode: 0o700 });
  for (const file of ["authority.json", "authority.bak.json"]) {
    writeFileSync(join(seedDir, file), JSON.stringify({ everSeeded: ["claude", "opencode", "codex", "hermes", "jcode", "pi", "web"] }));
  }
  writeFileSync(join(seedDir, "witness.json"), JSON.stringify({ initialized: true, firstGeneration: targetVersion }));
  writeFileSync(join(seedDir, "stamp.json"), JSON.stringify({ generation: targetVersion }));

  // The daemon's system resolver, replaced only where the loss is described: `lookup(host)` from
  // node:dns/promises with no options. The broker client resolves through node:dns callbacks with
  // options, and the Manager child never sees the control path, so both keep the real resolver.
  // While the control file says "flap", lookups by turns fail at once (ENOTFOUND) and outlast the
  // shipped lookup budget (reported as ETIMEOUT), as a resolver does through a long outage.
  const lookupControl = join(root, "lookup-mode");
  const lookupPreload = join(root, "lookup-preload.mjs");
  writeFileSync(lookupPreload, `import { createRequire, syncBuiltinESMExports } from "node:module";
import { readFileSync } from "node:fs";
const control = process.env.DLC_LOOKUP_CONTROL;
if (control) {
  delete process.env.DLC_LOOKUP_CONTROL;
  const dns = createRequire(import.meta.url)("node:dns/promises");
  const real = dns.lookup;
  let n = 0;
  const failure = (code) => Object.assign(new Error("lookup failed: " + code), { code });
  dns.lookup = (host, ...rest) => {
    let mode = "";
    try { mode = readFileSync(control, "utf8").trim(); } catch {}
    if (mode !== "flap" || rest.length > 0) return real(host, ...rest);
    n++;
    return n % 2 ? Promise.reject(failure("ENOTFOUND")) : new Promise((_, reject) => setTimeout(() => reject(failure("EAI_AGAIN")), 3500));
  };
  syncBuiltinESMExports();
}
`, { mode: 0o600 });

  const nativeBin = join(root, "native-bin");
  mkdirSync(nativeBin, { recursive: true, mode: 0o700 });
  const cleanPath = `${nativeBin}:${(process.env.PATH ?? "").split(":").filter((p) => p.startsWith("/")).join(":")}`;
  process.env.PATH = cleanPath;

  const unit = "cotal-daemon.service";
  const unitPath = join(configDir, "systemd", "user", unit);
  mkdirSync(join(configDir, "systemd", "user"), { recursive: true, mode: 0o700 });
  const unitBytes = `[Unit]\nDescription=Cotal machine daemon\n\n[Service]\nType=simple\nExecStart="${process.execPath}" "${cliEntry}" daemon serve\nEnvironment=COTAL_DAEMON_NATIVE_SERVICE=1\nRestart=always\n\n[Install]\nWantedBy=default.target\n`;
  writeFileSync(unitPath, unitBytes, { mode: 0o600 });
  mkdirSync(paths.state, { recursive: true, mode: 0o700 });
  writeFileSync(unitReceiptFile(paths), `${JSON.stringify({ v: 1, unit, unitPath, unitSha256: createHash("sha256").update(unitBytes).digest("hex"), installedAt: new Date().toISOString() })}\n`, { mode: 0o600 });

  const childEnv: NodeJS.ProcessEnv = {
    USER: "smoke",
    LOGNAME: "smoke",
    PATH: cleanPath,
    HOME: home,
    COTAL_HOME: home,
    XDG_CONFIG_HOME: configDir,
    XDG_DATA_HOME: join(root, "data"),
    XDG_CACHE_HOME: join(root, "cache"),
    XDG_RUNTIME_DIR: rtDir,
    TMPDIR: root,
    COTAL_SKIP_CONNECTOR_SEED: "1",
    COTAL_ALLOW_CHECKOUT_SEED: "1",
    DO_NOT_TRACK: "1",
    COTAL_TELEMETRY: "off",
    NO_COLOR: "1",
  };

  const startDaemonProcess = async (): Promise<ChildProcess> => {
    const child = spawn(process.execPath, [cliEntry, "daemon", "serve"], {
      cwd: participant,
      env: { ...childEnv, COTAL_DAEMON_NATIVE_SERVICE: "1", NODE_OPTIONS: `--import=${pathToFileURL(lookupPreload).href}`, DLC_LOOKUP_CONTROL: lookupControl },
      stdio: ["ignore", "pipe", "pipe"],
    });
    // Read the daemon's output: writes to a full pipe block a Node process on Linux, which froze
    // the daemon (and its feed) once the reconnect phases had logged enough.
    for (const stream of [child.stdout!, child.stderr!]) stream.on("data", (b) => {
      const lines = String(b).split("\n").filter(Boolean);
      for (const line of lines) if (/hosted Manager for .* (lost its connection|is connected again)/.test(line)) connectionLines.push({ at: Date.now(), line });
      daemonLog.push(...lines);
      if (daemonLog.length > 300) daemonLog.splice(0, daemonLog.length - 300);
    });
    for (let i = 0; i < 100; i++) {
      try {
        const r = await queryDaemon({ paths });
        if (r.ok) return child;
      } catch {}
      await sleep(100);
    }
    // The finally below stops only a daemon that started; this one must not outlive the run.
    await killAndAwaitExit(child, "SIGTERM").catch(() => {});
    throw new Error(`daemon did not start:\n${daemonLog.slice(-60).join("\n")}`);
  };

  writeFileSync(join(nativeBin, "systemctl"), `#!${process.execPath}\nif (process.argv.slice(2).join(" ") === "--user show-environment") console.log(${JSON.stringify(`XDG_CONFIG_HOME=${configDir}`)});\nelse process.exit(99);\n`, { mode: 0o700 });

  daemonChild = await startDaemonProcess();

  for (const space of [SPACE]) {
    const setupProc = spawn(process.execPath, [cliEntry, "daemon", "setup", "--space", space, "--json"], {
      cwd: participant,
      env: childEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "", err = "";
    setupProc.stdout.on("data", (b) => { out += String(b); });
    setupProc.stderr.on("data", (b) => { err += String(b); });
    const code = await new Promise<number | null>((r) => setupProc.once("exit", r));
    assert.equal(code, 0, `setup for ${space} failed (${code}): ${err || out}`);
  }

  // Watch the way the desktop app does: one status-watch connection, frames pushed by the daemon.
  type Frame = { at: number; state?: string; reason?: string; pid?: number; restarts?: number; connection?: HostedManager["connection"] };
  const frames: Frame[] = [];
  let watch: Socket | undefined;
  const openWatch = () => {
    let buffered = "";
    watch = createConnection(paths.socket!);
    watch.on("data", (chunk) => {
      buffered += String(chunk);
      for (let i = buffered.indexOf("\n"); i >= 0; i = buffered.indexOf("\n")) {
        const line = buffered.slice(0, i);
        buffered = buffered.slice(i + 1);
        const frame = JSON.parse(line) as { event?: string; result?: { managers?: HostedManager[] } };
        if (frame.event !== "status") continue;
        const m = frame.result?.managers?.find((row) => row.space === SPACE);
        frames.push({ at: Date.now(), state: m?.state, reason: m?.reason, pid: m?.pid, restarts: m?.restarts, connection: m?.connection });
      }
    });
    watch.on("error", () => {});
    watch.write(`${JSON.stringify({ v: 1, id: "dlc-watch", op: "status-watch" })}\n`);
  };
  openWatch();
  const until = async (ms: number, done: () => boolean) => { for (const end = Date.now() + ms; Date.now() < end && !done(); ) await sleep(250); return done(); };
  const answering = () => { const last = frames.at(-1); return last?.state === "answering" && last.connection === undefined; };
  check("C0 the hosted Manager answers before the network is cut", await until(30_000, answering), frames.at(-1));
  const managerPid = frames.at(-1)?.pid;
  const restarts = frames.at(-1)?.restarts;
  const readStatusCli = (...args: string[]) => readCliStatus(cliEntry, participant, childEnv, ...args);
  const reportsAnswering = (stdout: string) =>
    /Last observed state:\s+answering\b/.test(stdout) &&
    [...stdout.matchAll(/\bPID:\s+(\d+)/g)].map(([, pid]) => Number(pid)).join(",") === `${daemonChild?.pid},${managerPid}` &&
    Number(stdout.match(/\bRestarts:\s+(\d+)/)?.[1]) === restarts &&
    !/Last refusal:|ep\.v1|deadline-exceeded/.test(stdout);

  // Short drops the Manager re-dials within seconds are not a lost connection; the app must not flicker.
  const flickerFrom = Date.now();
  for (let i = 0; i < 4; i++) {
    offline = true;
    for (const link of tcpLinks) link.destroy();
    await sleep(1500);
    reconnectNetwork();
    await sleep(6000);
  }
  const flicker = frames.filter((f) => f.at >= flickerFrom && f.connection !== undefined);
  check("F1 four short drops the Manager re-dials at once never show a lost connection", flicker.length === 0 && await until(15_000, answering), { flicker: flicker.slice(0, 2), last: frames.at(-1) });

  offline = true;
  for (const link of tcpLinks) link.destroy();
  const cutAt = Date.now();
  const lost = await until(15_000, () => frames.some((f) => f.at >= cutAt && f.connection !== undefined));
  const lostFrame = frames.find((f) => f.at >= cutAt && f.connection !== undefined);
  check(`C1 within 15 s of a reset link, as desktop/README.md says, the live feed reports the lost connection without any status request (after ${lostFrame ? Math.round((lostFrame.at - cutAt) / 1000) : "-"} s)`, lost && lostFrame?.connection?.state === "unreachable" && lostFrame.connection.reason === "127.0.0.1 is not answering", { frames: frames.length, seconds: lostFrame ? Math.round((lostFrame.at - cutAt) / 1000) : undefined, lostFrame });
  check("C2 the lost connection is reported beside the Manager's own state, which stays answering", lostFrame?.state === "answering", lostFrame);

  // Status reads the same Manager observation without sending a mesh probe.
  const asked = await queryDaemon({ paths });
  const askedRow = asked.ok ? asked.result.managers?.find((row) => row.space === SPACE) : undefined;
  check("C3 a full status read reports the lost connection and the same Manager still answering", askedRow?.connection?.state === "unreachable" && askedRow.state === "answering" && askedRow.pid === managerPid && askedRow.restarts === restarts, askedRow);
  const statusCli = spawn(process.execPath, [cliEntry, "daemon", "service-status", "--space", SPACE, "--json"], { cwd: participant, env: childEnv, stdio: ["ignore", "pipe", "pipe"] });
  let statusOut = "";
  statusCli.stdout.on("data", (b) => { statusOut += String(b); });
  const statusCode = await new Promise<number | null>((r) => statusCli.once("exit", r));
  const statusDoc = (() => { try { return JSON.parse(statusOut) as { error?: { cause?: { code?: string }; message?: string } }; } catch { return undefined; } })();
  check("C6 `cotal daemon service-status` refuses and names the lost connection as its code", statusCode !== 0 && statusDoc?.error?.cause?.code === "SPACE_UNREACHABLE" && /connection unreachable: 127\.0\.0\.1 is not answering/.test(statusDoc.error.message ?? ""), { statusCode, error: statusDoc?.error ?? statusOut.slice(0, 400) });

  reconnectNetwork();
  const backAt = Date.now();
  const back = await until(60_000, () => answering() && frames.at(-1)!.at >= backAt);
  check(`C5 once the network is back, the live feed reports the Manager answering with no lost connection (after ${back ? Math.round((frames.at(-1)!.at - backAt) / 1000) : "-"} s)`, back, { last: frames.at(-1), seconds: Math.round((Date.now() - backAt) / 1000) });

  // A silent drop: no link is reset and nothing answers. Only the Manager's own pings can notice it.
  silent = true;
  const silentAt = Date.now();
  const heard = await until(45_000, () => frames.some((f) => f.at >= silentAt && f.connection !== undefined));
  const silentFrame = frames.find((f) => f.at >= silentAt && f.connection !== undefined);
  check(`S1 within 45 s of a silent drop, as desktop/README.md says, the live feed reports the lost connection (after ${silentFrame ? Math.round((silentFrame.at - silentAt) / 1000) : "-"} s)`, heard && silentFrame?.connection?.state === "unreachable" && silentFrame.state === "answering", { seconds: Math.round(((silentFrame?.at ?? Date.now()) - silentAt) / 1000), silentFrame, last: frames.at(-1) });
  const [allDuring, oneDuring] = await Promise.all([readStatusCli(), readStatusCli("--space", SPACE)]);
  for (const [label, result] of [["all spaces", allDuring], ["one space", oneDuring]] as const) {
    check(`S3 CLI status for ${label} answers in ${result.ms}ms during the cut with the same Manager and a connection loss`,
      result.code === 0 && result.ms < 6000 && reportsAnswering(result.stdout) && /Connection:\s+unreachable: 127\.0\.0\.1 is not answering/.test(result.stdout),
      { ...result, stdout: result.stdout.split(`Manager: ${SPACE}`).at(-1) });
  }
  reconnectNetwork();
  const quietBackAt = Date.now();
  const justBack = await readStatusCli();
  check(`S4 CLI status answers in ${justBack.ms}ms just after the link returns without calling the same Manager starting`,
    justBack.code === 0 && justBack.ms < 6000 && reportsAnswering(justBack.stdout), { ...justBack, stdout: justBack.stdout.split(`Manager: ${SPACE}`).at(-1) });
  const quietBack = await until(60_000, () => answering() && frames.at(-1)!.at >= quietBackAt);
  check(`S2 once a silent drop ends, the live feed reports the Manager answering with no lost connection (after ${quietBack ? Math.round((frames.at(-1)!.at - quietBackAt) / 1000) : "-"} s)`, quietBack, { last: frames.at(-1), seconds: Math.round((Date.now() - quietBackAt) / 1000) });

  // The broker link comes back before the HTTP faces do. A service-status read can confirm the
  // same Manager has reconnected even though the daemon cannot open a fresh caller session.
  offline = true;
  for (const link of tcpLinks) link.destroy();
  const facesCutAt = Date.now();
  check("R1 a second cut is reported", await until(20_000, () => frames.some((f) => f.at >= facesCutAt && f.connection !== undefined)), frames.at(-1));
  offline = false; facesDown = true;
  const linkBackAt = Date.now();
  const cleared = await until(30_000, () => answering() && frames.at(-1)!.at >= linkBackAt);
  const recoveredService = await new Promise<{ code: number | string | null; stdout: string; stderr: string }>((resolve) => {
    execFile(process.execPath, [cliEntry, "daemon", "service-status", "--space", SPACE, "--json"], { cwd: participant, env: childEnv, timeout: 6000 }, (error, stdout, stderr) => {
      resolve({ code: error ? error.code ?? error.signal ?? null : 0, stdout, stderr });
    });
  });
  const recoveredManager = recoveredService.stdout ? (JSON.parse(recoveredService.stdout) as { result?: { manager?: HostedManager } }).result?.manager : undefined;
  check("R2 service-status reports the same answering Manager when its broker link comes back before its HTTP paths",
    cleared && recoveredService.code === 0 && recoveredManager?.pid === managerPid && recoveredManager?.restarts === restarts && recoveredManager?.state === "answering" && recoveredManager?.connection === undefined, recoveredService);

  // An explicit pinned Manager probe still exercises endpoint readiness. If it fails, watch-only
  // recovery retries in the background without flooding the exchange.
  offline = true;
  for (const link of tcpLinks) link.destroy();
  const failedRow = await managerViaDaemon({ paths }, { op: "manager-status", space: SPACE }) as HostedManager;
  offline = false;
  const retryFrom = Date.now();
  // Each re-read dials the space's faces. While they stay down the re-reads must space out.
  await sleep(60_000);
  const dials = faceRefusals.filter((at) => at >= retryFrom).filter((at, i, all) => i === 0 || at - all[i - 1]! > 2000);
  const gaps = dials.slice(1).map((at, i) => Math.round((at - dials[i]!) / 1000));
  check(`R3 while the faces stay down for 60 s, the re-reads space out (${dials.length} dials, ${gaps.join(" s, ")} s apart)`, dials.length >= 2 && dials.length <= 5 && gaps.at(-1)! >= 15, { dials: dials.map((at) => Math.round((at - retryFrom) / 1000)), gaps });
  reconnectNetwork();
  const facesBackAt = Date.now();
  const recovered = await until(45_000, () => answering() && frames.at(-1)!.at >= facesBackAt);
  check(`R4 a failed pinned Manager probe does not hold the feed on starting: answering ${recovered ? Math.round((frames.at(-1)!.at - facesBackAt) / 1000) : "-"} s after the faces answer, with no status request`, failedRow.state === "starting" && recovered, { failedState: failedRow.state, last: frames.at(-1) });

  // A long outage with a space named by its host, whose lookups fail by turns at once and after the
  // budget. The feed follows the latest reason. The daemon's log is bounded (64 KiB), so it records
  // the loss once, not once per lookup error, or a long outage fills it and "connected again" is lost.
  const record = findMesh(SPACE)!;
  recordMesh({ ...record, server: `nats://localhost:${relayPort}` });
  writeFileSync(lookupControl, "flap", { mode: 0o600 });
  offline = true;
  for (const link of tcpLinks) link.destroy();
  const flapAt = Date.now();
  const flapLost = await until(20_000, () => frames.some((f) => f.at >= flapAt && f.connection?.state === "offline"));
  await sleep(40_000);
  const flapFrames = frames.filter((f) => f.at >= flapAt && f.connection !== undefined);
  const reasons = flapFrames.map((f) => f.connection!.reason).filter((reason, i, all) => i === 0 || reason !== all[i - 1]);
  const lossLines = connectionLines.filter((l) => l.at >= flapAt && l.line.includes("lost its connection"));
  check(`L1 an outage whose lookup error keeps changing logs the loss once (${reasons.length} reasons in turn on the feed, ${lossLines.length} log lines)`, flapLost && flapFrames.every((f) => f.connection!.state === "offline") && reasons.length >= 3 && lossLines.length === 1, { reasons, lossLines: lossLines.map((l) => l.line) });
  recordMesh(record);
  rmSync(lookupControl, { force: true });
  reconnectNetwork();
  const flapBackAt = Date.now();
  const flapBack = await until(60_000, () => answering() && frames.at(-1)!.at >= flapBackAt);
  const againLines = connectionLines.filter((l) => l.at >= flapBackAt && l.line.includes("is connected again"));
  check(`L2 once that outage ends, the feed reports the Manager answering and the log says it is connected again, once (after ${flapBack ? Math.round((frames.at(-1)!.at - flapBackAt) / 1000) : "-"} s)`, flapBack && againLines.length === 1, { last: frames.at(-1), againLines: againLines.map((l) => l.line) });
  watch?.destroy();

  // A Manager built before the connection question ignores it, as every released Manager does. The
  // daemon must not count that silence as a failed health check (which relaunches the Manager), and
  // must not report a connection it cannot see.
  const olderManager = join(root, "older-manager");
  mkdirSync(olderManager, { mode: 0o700 });
  cpSync(join(repo, "implementations", "manager", "package.json"), join(olderManager, "package.json"));
  cpSync(join(repo, "implementations", "manager", "dist"), join(olderManager, "dist"), { recursive: true });
  symlinkSync(join(repo, "implementations", "manager", "node_modules"), join(olderManager, "node_modules"));
  const commandsJs = join(olderManager, "dist", "commands.js");
  const shipped = readFileSync(commandsJs, "utf8");
  const answers = shipped.match(/if \(answerConnectionQuestion\(frame, mgr\)\)\s*return;/g) ?? [];
  assert.equal(answers.length, 1, "the built Manager answers the connection question in exactly one place");
  writeFileSync(commandsJs, shipped.replace(answers[0]!, ""));
  await killAndAwaitExit(daemonChild!, "SIGTERM");
  daemonChild = undefined;
  rmSync(managerLink);
  symlinkSync(olderManager, managerLink);
  daemonChild = await startDaemonProcess();
  frames.length = 0;
  openWatch();
  check("O1 the daemon hosts the older Manager and it answers", await until(60_000, answering), frames.at(-1));
  const olderPid = frames.at(-1)?.pid;
  const olderRestarts = frames.at(-1)?.restarts;
  offline = true;
  for (const link of tcpLinks) link.destroy();
  const olderCutAt = Date.now();
  await sleep(20_000);
  const during = frames.filter((f) => f.at >= olderCutAt);
  // Frames come only on change, so a daemon that stopped sending would pass the line above. A new
  // watch is answered at once with the daemon's current view, which proves it is alive and what it holds.
  watch?.destroy();
  const askedAt = Date.now();
  openWatch();
  const fresh = await until(5_000, () => frames.some((f) => f.at >= askedAt));
  const now = frames.find((f) => f.at >= askedAt);
  check("O2 cut for 20 s, the older Manager is never reported starting, relaunched, or with a connection the daemon cannot see, and a new watch still reads it answering", during.every((f) => f.state === "answering" && f.connection === undefined && f.pid === olderPid && f.restarts === olderRestarts) && fresh && now?.state === "answering" && now.connection === undefined && now.pid === olderPid && now.restarts === olderRestarts, { olderPid, olderRestarts, now, odd: during.filter((f) => f.state !== "answering" || f.connection !== undefined || f.pid !== olderPid).slice(0, 2) });
  reconnectNetwork();
  watch?.destroy();
} finally {
  if (daemonChild) await killAndAwaitExit(daemonChild, "SIGTERM").catch(() => {});
  for (const d of deliveries) await d.close().catch(() => {});
  for (const h of handles) await h.close().catch(() => {});
  for (const r of relays) r.close();
  for (const r of tcpRelays) r.close();
  for (const link of tcpLinks) link.destroy();
  idp.close();
  if (nats) await killAndAwaitExit(nats, "SIGTERM").catch(() => {});
  releaseNats?.();
  rmSync(jsDir, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
}

if (fail > 0) console.log(`\n--- last daemon output ---\n${daemonLog.slice(-60).join("\n")}`);
console.log(`\n=== daemon-lost-connection smoke: ${pass} passed, ${fail} failed ===`);
emitSentinel({ passed: pass, failed: fail });
if (fail > 0 || pass !== 25) process.exit(1);
process.exit(0);
