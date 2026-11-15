/**
 * Issue #6854: a manual `cotal update` closing wait polls `daemon status` every 250 ms for up to
 * 120 s while hosted Managers restore. Each live hosted Manager retains one instance-pinned control
 * session across status refreshes (coalescing concurrent refreshes and backing off for 5 s after a
 * failed exchange), so a slow restore does not spend the owner's 60/minute CLI connect budget. A
 * `RATE_LIMITED` refusal of the daemon's own status question is not an observation: an already
 * observed Manager record stays as it was (`state`, `instanceId`, `observedAt`), and a child with
 * no earlier observation stays `starting` naming the limit with retry-status guidance rather than
 * `cotal daemon setup`.
 */
import assert from "node:assert/strict";
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import { type AddressInfo } from "node:net";
import { createHash } from "node:crypto";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
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
  recordMesh, userAuthStateDir, type MeshEntry,
} from "@cotal-ai/workspace";
import { startDeliveryService } from "@cotal-ai/delivery";
import { freePort, killAndAwaitExit, skipSuite, teardownOnSignal, SMOKE_BROKER_TOKEN } from "@cotal-ai/smoke-kit";
import { daemonPaths } from "../daemon/endpoint.js";
import { unitReceiptFile } from "../daemon/install.js";
import { managerViaDaemon, queryDaemon } from "../daemon/client.js";
import type { HostedManager } from "../daemon/protocol.js";

if (process.platform !== "linux") skipSuite(`daemon-update-connect-rate smoke: Linux only; skipped on ${process.platform}`);
for (const key of Object.keys(process.env)) if (key.startsWith("COTAL_")) delete process.env[key];

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..", "..");
const targetVersion = (JSON.parse(readFileSync(join(repo, "bin/package.json"), "utf8")) as { version: string }).version;
const sourceVersion = "0.164.10";

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
let pass = 0, fail = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ FAIL: ${name}`, JSON.stringify(extra ?? "")?.slice(0, 600)); }
};

class MemoryStore implements SecretStore {
  readonly values = new Map<string, string>();
  constructor(readonly identity: { kind: "injected"; coordinate: string }) {}
  async get(k: string) { return this.values.get(k); }
  async put(k: string, v: string) { this.values.set(k, v); }
  async create(k: string, v: string) { if (this.values.has(k)) return false; this.values.set(k, v); return true; }
  async delete(k: string) { this.values.delete(k); }
}

const root = mkdtempSync(join(tmpdir(), "ducr-"));
chmodSync(root, 0o700);
const privateCliDir = join(root, "cli");
mkdirSync(privateCliDir, { recursive: true, mode: 0o700 });
cpSync(join(repo, "bin", "package.json"), join(privateCliDir, "package.json"));
cpSync(join(repo, "bin", "dist"), join(privateCliDir, "dist"), { recursive: true });
symlinkSync(join(repo, "bin", "node_modules"), join(privateCliDir, "node_modules"));
const cliEntry = join(privateCliDir, "dist", "cotal.js");
const home = join(root, "home");
const participant = join(root, "participant");
const rtDir = join(root, "rt");
const configDir = join(root, "config");
const jsDir = mkdtempSync(join(tmpdir(), `${SMOKE_BROKER_TOKEN}ducr-js-`));
for (const d of [home, participant, rtDir, configDir]) mkdirSync(d, { recursive: true, mode: 0o700 });

process.env.HOME = home;
process.env.COTAL_HOME = home;
process.env.XDG_CONFIG_HOME = configDir;
process.env.XDG_RUNTIME_DIR = rtDir;
process.env.XDG_DATA_HOME = join(root, "data");
process.env.XDG_CACHE_HOME = join(root, "cache");

const paths = daemonPaths({ XDG_RUNTIME_DIR: rtDir });

const key = await generateKeyPair("EdDSA");
const jwk = { ...await exportJWK(key.publicKey), kid: "ducr-idp" };
const SESSION = "ducr-session-handle-not-a-secret";
let idpOrigin = "";

const idp = createHttpServer(async (req: IncomingMessage, res: ServerResponse) => {
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

interface ExchangeEvent {
  at: number;
  space: string;
  actor: string;
  view: string | null;
  status: number;
  code: string | null;
}

const exchangeEvents: ExchangeEvent[] = [];
let slowRestoreSpace: string | null = null;
let slowRestoreMs = 0;
let slowRestoreTriggered = false;
const forceRateLimitSpaces = new Set<string>();
const forceUnavailableSpaces = new Set<string>();
const shortTtlSpaces = new Set<string>();

const relays: ReturnType<typeof createHttpServer>[] = [];
async function createRelay(space: string, targetUrl: string): Promise<string> {
  const server = createHttpServer(async (req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(Buffer.from(c));
    let rawBody = Buffer.concat(chunks);
    const pathname = new URL(req.url!, "http://x").pathname;

    if (slowRestoreSpace === space && !slowRestoreTriggered && req.method === "POST" && pathname === "/manager-service-authority") {
      const parsed = JSON.parse(rawBody.toString("utf8")) as { request?: { kind?: string } };
      if (parsed.request?.kind === "manager-goal-index-scan") {
        slowRestoreTriggered = true;
        await sleep(slowRestoreMs);
      }
    }

    if (pathname === "/exchange" && shortTtlSpaces.has(space) && !forceRateLimitSpaces.has(space)) {
      try {
        const parsed = JSON.parse(rawBody.toString("utf8")) as Record<string, unknown>;
        parsed.ttlSec = 10;
        rawBody = Buffer.from(JSON.stringify(parsed));
      } catch {}
    }

    if (pathname === "/exchange" && forceUnavailableSpaces.has(space)) {
      let reqJson: { actor?: string; view?: string } = {};
      try { reqJson = JSON.parse(rawBody.toString("utf8")); } catch {}
      exchangeEvents.push({
        at: Date.now(),
        space,
        actor: reqJson.actor ?? "cli",
        view: reqJson.view ?? null,
        status: 503,
        code: "UNAVAILABLE",
      });
      res.writeHead(503, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "synthetic exchange outage" }));
      return;
    }

    if (pathname === "/exchange" && forceRateLimitSpaces.has(space)) {
      let reqJson: { actor?: string; view?: string } = {};
      try { reqJson = JSON.parse(rawBody.toString("utf8")); } catch {}
      exchangeEvents.push({
        at: Date.now(),
        space,
        actor: reqJson.actor ?? "cli",
        view: reqJson.view ?? null,
        status: 429,
        code: "RATE_LIMITED",
      });
      res.writeHead(429, { "content-type": "application/json", "retry-after": "2" });
      res.end(JSON.stringify({
        code: "RATE_LIMITED",
        retryAfterSeconds: 2,
        limit: "actor",
        error: `actor cli of owner u_smoke is over its limit of 60 connects a minute - retry in 2s`,
      }));
      return;
    }

    const up = await fetch(`${targetUrl}${req.url}`, {
      method: req.method,
      headers: { "content-type": req.headers["content-type"] ?? "application/json" },
      body: rawBody.length ? rawBody : undefined,
      redirect: "manual",
    });
    const respBytes = Buffer.from(await up.arrayBuffer());
    if (pathname === "/exchange") {
      let reqJson: { actor?: string; view?: string } = {};
      let respJson: { code?: string } = {};
      try { reqJson = JSON.parse(rawBody.toString("utf8")); } catch {}
      try { respJson = JSON.parse(respBytes.toString("utf8")); } catch {}
      exchangeEvents.push({
        at: Date.now(),
        space,
        actor: reqJson.actor ?? "cli",
        view: reqJson.view ?? null,
        status: up.status,
        code: respJson.code ?? null,
      });
    }
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

const broker = await createBrokerAuth("ducr-broker");
const stamp = Date.now();
const spaces = [`ducr-on-${stamp}`, `ducr-off-${stamp}`] as const;
const [ON, OFF] = spaces;
const accounts = await Promise.all(spaces.map((s) => createSpaceAccountAuth(broker, s)));
const handles: AuthServiceHandle[] = [];
const deliveries: Awaited<ReturnType<typeof startDeliveryService>>[] = [];
let nats: ChildProcess | undefined;
let releaseNats: (() => void) | undefined;
let daemonChild: ChildProcess | undefined;
let upgradeControl: ReturnType<typeof createHttpServer> | undefined;

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
    const face = await createRelay(c.space, handles[i]!.publicUrl!.replace(/\/$/, ""));
    const bundle = await (await fetch(`${handles[i]!.publicUrl!.replace(/\/$/, "")}/.well-known/cotal-mesh`)).json() as { server: string; userAuth: MeshEntry["userAuth"]; sentinelCreds: string };
    const dir = userAuthStateDir(participant, c.space);
    mkSecretDir(dir);
    const sentinelCredsPath = join(dir, "sentinel.creds");
    writeSecretFileAtomic(sentinelCredsPath, bundle.sentinelCreds);
    recordMesh({
      space: c.space,
      server: bundle.server,
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
  writeFileSync(join(seedDir, "witness.json"), JSON.stringify({ initialized: true, firstGeneration: sourceVersion }));
  writeFileSync(join(seedDir, "stamp.json"), JSON.stringify({ generation: targetVersion }));

  const nativeBin = join(root, "native-bin");
  mkdirSync(nativeBin, { recursive: true, mode: 0o700 });
  const cleanPath = `${nativeBin}:${(process.env.PATH ?? "").split(":").filter((p) => p.startsWith("/")).join(":")}`;
  process.env.PATH = cleanPath;

  const beforeRestartMarker = join(root, "before-restart");
  const versionHook = join(root, "version-override.cjs");
  writeFileSync(
    versionHook,
    `const fs = require('node:fs'); const net = require('node:net'); const origWrite = net.Socket.prototype.write; net.Socket.prototype.write = function(chunk, ...a) { if (typeof chunk === 'string' && fs.existsSync(${JSON.stringify(beforeRestartMarker)}) && chunk.includes('"version":' + ${JSON.stringify(JSON.stringify(targetVersion))})) { chunk = chunk.replace('"version":' + ${JSON.stringify(JSON.stringify(targetVersion))}, '"version":' + ${JSON.stringify(JSON.stringify(sourceVersion))}); } return origWrite.call(this, chunk, ...a); };\n`,
  );

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
    NODE_OPTIONS: `--require=${versionHook}`,
    COTAL_SKIP_CONNECTOR_SEED: "1",
    COTAL_ALLOW_CHECKOUT_SEED: "1",
    DO_NOT_TRACK: "1",
    COTAL_TELEMETRY: "off",
    NO_COLOR: "1",
  };

  const startDaemonProcess = async (): Promise<ChildProcess> => {
    const child = spawn(process.execPath, [cliEntry, "daemon", "serve"], {
      cwd: participant,
      env: { ...childEnv, COTAL_DAEMON_NATIVE_SERVICE: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    for (let i = 0; i < 100; i++) {
      try {
        const r = await queryDaemon({ paths });
        if (r.ok) return child;
      } catch {}
      await sleep(100);
    }
    throw new Error("daemon did not start");
  };

  upgradeControl = createHttpServer(async (req: IncomingMessage, res: ServerResponse) => {
    if (req.url === "/stop") {
      rmSync(beforeRestartMarker, { force: true });
      writeFileSync(join(seedDir, "stamp.json"), JSON.stringify({ generation: targetVersion }));
      if (daemonChild) await killAndAwaitExit(daemonChild, "SIGTERM");
      daemonChild = undefined;
    } else if (req.url === "/start") {
      daemonChild = await startDaemonProcess();
    } else {
      res.writeHead(404).end();
      return;
    }
    res.end("done");
  });
  await new Promise<void>((r) => upgradeControl!.listen(0, "127.0.0.1", () => r()));
  const controlPort = (upgradeControl.address() as AddressInfo).port;

  writeFileSync(
    join(nativeBin, "systemctl"),
    `#!${process.execPath}
(async () => {
  const args = process.argv.slice(2).join(" ");
  if (args === "--user show-environment") {
    console.log(${JSON.stringify(`XDG_CONFIG_HOME=${configDir}`)});
    process.exit(0);
  }
  if (!["--user --no-ask-password --no-pager stop cotal-daemon.service", "--user --no-ask-password --no-pager start cotal-daemon.service"].includes(args)) {
    process.exit(99);
  }
  const op = args.includes(" stop ") ? "stop" : "start";
  const r = await fetch("http://127.0.0.1:${controlPort}/" + op);
  if (!r.ok) process.exit(99);
})();
`,
    { mode: 0o700 },
  );

  daemonChild = await startDaemonProcess();

  for (const space of [ON, OFF]) {
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

  writeFileSync(beforeRestartMarker, "1");
  writeFileSync(join(seedDir, "stamp.json"), JSON.stringify({ generation: sourceVersion }));

  exchangeEvents.length = 0;
  slowRestoreSpace = OFF;
  slowRestoreMs = 25_000;
  slowRestoreTriggered = false;

  const updater = spawn(process.execPath, [cliEntry, "update"], {
    cwd: participant,
    env: childEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });

  // Observe status during the closing wait to verify ON never drops from `answering` once restored.
  let onReachedAnswering = false;
  let onDroppedFromAnswering = false;
  let onDropSample: HostedManager | undefined;
  let sampling = true;
  const sampler = (async () => {
    while (sampling) {
      try {
        const snap = await queryDaemon({ paths });
        if (snap.ok && snap.result.version === targetVersion && !slowRestoreTriggered) {
          // Wait until the restarted daemon is serving
        } else if (snap.ok && snap.result.version === targetVersion && slowRestoreTriggered) {
          const onRow = snap.result.managers?.find((m) => m.space === ON);
          if (onRow?.state === "answering") onReachedAnswering = true;
          else if (onReachedAnswering && onRow) {
            onDroppedFromAnswering = true;
            onDropSample = onRow;
          }
        }
      } catch {}
      await sleep(400);
    }
  })();

  const killTimer = setTimeout(() => updater.kill("SIGTERM"), 45_000);
  const updateExit = await new Promise<number | null>((r) => updater.once("exit", r));
  clearTimeout(killTimer);
  sampling = false;
  await sampler;

  const totalExchanges = exchangeEvents.length;
  const rateLimited = exchangeEvents.filter((e) => e.status === 429 && e.code === "RATE_LIMITED");
  check("C1 manual update with a 25s slow hosted Manager restore exits 0", updateExit === 0, { updateExit });
  check("C2 closing wait reuses the retained Manager control session (<= 16 exchanges across 25s wait)", totalExchanges <= 16, { totalExchanges });
  check("C3 closing wait triggers zero 429 RATE_LIMITED refusals", rateLimited.length === 0, { rateLimitedCount: rateLimited.length, first: rateLimited[0] });
  check("C4 already-answering hosted Manager is never rewritten to starting during the wait", onReachedAnswering && !onDroppedFromAnswering, { onReachedAnswering, onDroppedFromAnswering, onDropSample });

  // C5: single-flight refresh coalesces concurrent status questions without opening a new session.
  const beforeConcurrent = exchangeEvents.length;
  const [s1, s2, s3] = await Promise.all([
    managerViaDaemon({ paths }, { op: "manager-status", space: ON }) as Promise<HostedManager>,
    managerViaDaemon({ paths }, { op: "manager-status", space: ON }) as Promise<HostedManager>,
    queryDaemon({ paths }),
  ]);
  check("C5 concurrent refreshes reuse retained session with zero new exchanges", exchangeEvents.length === beforeConcurrent && s1.state === "answering" && s2.state === "answering" && s3.ok, { delta: exchangeEvents.length - beforeConcurrent });

  // C6: a RATE_LIMITED refusal of the daemon's own question is not an observation:
  // when an earlier observation exists (answering), the record stays as it was (state, instanceId, observedAt),
  // and after a failed exchange the daemon backs off for 5s before exchanging again for that space.
  // To force a new exchange on ON, kill ON's Manager child, let it restart, and gate its exchange with RATE_LIMITED
  // before any observation of the new child, then test RATE_LIMITED after an answering observation.
  const beforeOn = await managerViaDaemon({ paths }, { op: "manager-status", space: ON }) as HostedManager;
  assert.equal(beforeOn.state, "answering");

  // Force a new child on OFF with forceRateLimitSpaces active before its first probe:
  // with no earlier observation of that child, state stays starting, reason names the limit, and next says to ask again (never setup).
  forceRateLimitSpaces.add(OFF);
  const offBeforeKill = await managerViaDaemon({ paths }, { op: "manager-status", space: OFF }) as HostedManager;
  process.kill(offBeforeKill.pid!, "SIGKILL");
  let offUnobservedLimited: HostedManager | undefined;
  for (let i = 0; i < 40; i++) {
    await sleep(250);
    const snap = await queryDaemon({ paths });
    const row = snap.ok ? snap.result.managers?.find((m) => m.space === OFF) : undefined;
    if (row && row.pid !== undefined && row.pid !== offBeforeKill.pid && row.reason?.includes("over its limit of 60 connects a minute")) {
      offUnobservedLimited = row;
      break;
    }
  }
  check(
    "C6a with no earlier observation of a child, RATE_LIMITED keeps state starting, names the limit, and gives status-retry advice (never setup)",
    offUnobservedLimited?.state === "starting"
      && Boolean(offUnobservedLimited.reason?.includes("over its limit of 60 connects a minute"))
      && Boolean(offUnobservedLimited.next?.includes(`cotal daemon status --space ${OFF}`))
      && !offUnobservedLimited.next?.includes("setup"),
    offUnobservedLimited,
  );

  // Verify the 5s exchange failure backoff on OFF while forceRateLimitSpaces is set:
  const exchangesAtBackoffStart = exchangeEvents.filter((e) => e.space === OFF).length;
  await sleep(1200);
  const exchangesAfter1s = exchangeEvents.filter((e) => e.space === OFF).length;
  check("C6b after a failed exchange, the daemon does not exchange again within 5s for that space", exchangesAfter1s === exchangesAtBackoffStart, { exchangesAtBackoffStart, exchangesAfter1s });

  forceRateLimitSpaces.delete(OFF);
  shortTtlSpaces.add(OFF);
  let offRecovered: HostedManager | undefined;
  for (let i = 0; i < 60; i++) {
    await sleep(250);
    const snap = await queryDaemon({ paths });
    const row = snap.ok ? snap.result.managers?.find((m) => m.space === OFF) : undefined;
    if (row?.state === "answering") { offRecovered = row; break; }
  }
  shortTtlSpaces.delete(OFF);
  check("C6c once the rate limit clears and the 5s backoff elapses, the child reaches answering", offRecovered?.state === "answering", offRecovered);

  // C6d: OFF now has an answering observation whose bearer has ttlSec=10 (near expiry, < 30s remaining).
  // The next refresh must re-exchange; when that exchange is refused with RATE_LIMITED, the record stays
  // as it was (state, instanceId, observedAt).
  forceRateLimitSpaces.add(OFF);
  const offAfterRateLimit = await managerViaDaemon({ paths }, { op: "manager-status", space: OFF }) as HostedManager;
  forceRateLimitSpaces.delete(OFF);
  check(
    "C6d with an earlier answering observation, RATE_LIMITED leaves state, instanceId, and observedAt unchanged",
    offAfterRateLimit.state === "answering"
      && offAfterRateLimit.instanceId === offRecovered?.instanceId
      && offAfterRateLimit.observedAt === offRecovered?.observedAt
      && offAfterRateLimit.reason === undefined,
    { before: offRecovered, after: offAfterRateLimit },
  );
} finally {
  if (daemonChild) await killAndAwaitExit(daemonChild, "SIGTERM").catch(() => {});
  for (const d of deliveries) await d.close().catch(() => {});
  for (const h of handles) await h.close().catch(() => {});
  for (const r of relays) r.close();
  if (upgradeControl) upgradeControl.close();
  idp.close();
  if (nats) await killAndAwaitExit(nats, "SIGTERM").catch(() => {});
  releaseNats?.();
  rmSync(jsDir, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
}

console.log(`\n=== daemon-update-connect-rate smoke: ${pass} passed, ${fail} failed ===`);
if (fail > 0) process.exit(1);
process.exit(0);
