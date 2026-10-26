/**
 * Idle seats on a user-auth mesh open no connections (SPEC 14.3 turn notices).
 *
 * Real broker with the real auth service's callout, the real `agent-bearer` exchange, a real
 * user-mode Manager, and N real MeshAgent seats the manager spawns through a fixture runtime. Each
 * seat reaches the broker through a loopback hop that holds every new connection for 2 s before
 * it reaches the broker, so a seat that dials per pull pays a slow connect. The suite counts what
 * the seats open while idle: TCP accepts at the hop, manager-call bearer exchanges (a wrapper
 * around the manager-issued bearer command logs each one), and the broker's own
 * `total_connections`. The seats get no turn here; a local user mesh hosts no runs, so turn
 * delivery is proven on the static auth mesh in `smoke:turn-notice`.
 *
 * `IDLE_SEATS` (default 10) and `IDLE_MS` (default 40000) size the run. `SEAT_AGENT_DIST` points
 * the seats at another built `connector-core/dist/agent.js`.
 * Run: pnpm smoke:idle-seat-connects   (needs nats-server and openssl on PATH)
 */
import assert from "node:assert/strict";
import { execFile, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createServer as createHttpServer, request as httpRequest } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { connect as netConnect, createServer as createNetServer, type Socket } from "node:net";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { SMOKE_BROKER_TOKEN, emitSentinel, killAndAwaitExit, teardownOnSignal } from "@cotal-ai/smoke-kit";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const authIndex = pathToFileURL(join(repoRoot, "implementations/auth/src/index.js")).href;
const workspaceIndex = pathToFileURL(join(repoRoot, "packages/workspace/src/index.js")).href;
const managerContractIndex = pathToFileURL(join(repoRoot, "implementations/manager/src/manager-service-contract.js")).href;
const agentIndex = pathToFileURL(join(repoRoot, "extensions/connector-core/src/agent.js")).href;

// Self-reexec: the smoke drives real registered auth-service and agent-bearer commands.
const SUBCOMMAND = process.argv[2] ?? "";
if (SUBCOMMAND === "auth-service" || SUBCOMMAND === "agent-bearer") {
  await import(authIndex);
  const { registry } = await import("@cotal-ai/core");
  type Command = import("@cotal-ai/core").Command;
  const rest = process.argv.slice(3);
  const values: Record<string, string | boolean | undefined> = {};
  const positionals: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (!arg.startsWith("--")) { positionals.push(arg); continue; }
    const key = arg.slice(2), next = rest[i + 1];
    if (next !== undefined && !next.startsWith("--")) { values[key] = next; i++; }
    else values[key] = true;
  }
  const command = registry.all<Command>("command").find((c) => c.name === SUBCOMMAND);
  if (!command) throw new Error(`self-dispatch: command ${SUBCOMMAND} is not registered`);
  await command.run({ values, positionals, raw: rest });
  process.exit(0);
}

const {
  CotalEndpoint,
  authorizeServeGrant,
  contractArtifactCanonicalBytes,
  contractStoreContext,
  createEndpointStreams,
  createSpaceAuth,
  deriveReplySubject,
  dlvDurableConfig,
  dlvStream,
  dmDurableConfig,
  dmStream,
  epAuthBucket,
  eventChannel,
  isReachable,
  mintCreds,
  mintLifecycleUid,
  newIdentity,
  parseEpSubject,
  publishContractArtifact,
  recordsBucket,
  recordSpecKey,
  recordStatusKey,
  RECORD_KINDS,
  registry,
  remoteManagerActors,
  serverConfig,
  serveIssuanceGateKv,
  setupSpaceStreams,
  standaloneConnectOpts,
  taskDurableConfig,
  taskStream,
} = await import("@cotal-ai/core");

type AgentHandle = import("@cotal-ai/core").AgentHandle;
type AttachSession = import("@cotal-ai/core").AttachSession;
type Connector = import("@cotal-ai/core").Connector;
type LaunchOpts = import("@cotal-ai/core").LaunchOpts;
type LaunchSpec = import("@cotal-ai/core").LaunchSpec;
type Runtime = import("@cotal-ai/core").Runtime;
type RuntimeProvider = import("@cotal-ai/core").RuntimeProvider;

const coreRequire = createRequire(join(repoRoot, "packages/core/package.json"));
const authRequire = createRequire(join(repoRoot, "implementations/auth/package.json"));

const { Kvm } = await import(pathToFileURL(coreRequire.resolve("@nats-io/kv")).href);
type NatsConnection = import("@nats-io/transport-node").NatsConnection;
const { connect, AuthorizationError, NoRespondersError, PermissionViolationError } = await import(pathToFileURL(coreRequire.resolve("@nats-io/transport-node")).href);
const { jetstreamManager } = await import(pathToFileURL(coreRequire.resolve("@nats-io/jetstream")).href);
const { authDir, recordMesh, assertUserAuthInfo, createManagerInstanceIdentity, saveSpaceAuth, userAuthStateDir, workspaceSecretStore } = await import(workspaceIndex);
const { cotalAuthProvider, grantActor, grantManagedActor, loadCalloutAuth, newActorToken } = await import(authIndex);
const { managerAuthorityContractSource, managerClusterArtifacts } = await import(managerContractIndex);
const { Manager } = await import("@cotal-ai/manager");
const { MeshAgent } = await import(agentIndex);
const { generateKeyPair, exportJWK } = await import(pathToFileURL(authRequire.resolve("jose")).href);
const { pickFreePort } = await import("./_free-port.js");

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
function check(label: string, cond: boolean, extra?: unknown): void {
  console.log(`${cond ? "✓" : "✗"} ${label}${cond ? "" : ` — ${extra ?? ""}`}`);
  if (cond) pass++;
  else fail++;
}

// Restoration state is not a child-process environment.
const savedEnv = new Map(Object.entries(process.env));
const envAllowlist = new Set(["PATH", "USER", "LOGNAME", "LANG", "LC_ALL", "TERM", "HOME", "TMPDIR"]);
for (const key of Object.keys(process.env)) if (!envAllowlist.has(key)) delete process.env[key];

// Short scratch directory under tmpdir to avoid AF_UNIX length limits
const scratchBase = mkdtempSync(join(tmpdir(), "c-umt-"));

const home = mkdtempSync(join(scratchBase, "h-"));
process.env.COTAL_HOME = home;
const serverRoot = mkdtempSync(join(scratchBase, `${SMOKE_BROKER_TOKEN}s-`));
const clientRoot = mkdtempSync(join(scratchBase, "c-"));
const jsDir = mkdtempSync(join(scratchBase, "j-"));
const pki = join(scratchBase, "p");
mkdirSync(pki, { recursive: true });

const openssl = (args: string[]) => {
  const r = spawnSync("openssl", args, { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`openssl failed: ${r.stderr}`);
};

openssl(["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", join(pki, "ca.key"),
  "-out", join(pki, "ca.pem"), "-days", "1", "-subj", "/CN=Cotal Test CA"]);
openssl(["req", "-newkey", "rsa:2048", "-nodes", "-keyout", join(pki, "leaf.key"),
  "-out", join(pki, "leaf.csr"), "-subj", "/CN=127.0.0.1"]);
const extFile = join(pki, "ext.cnf");
writeFileSync(extFile, "subjectAltName=IP:127.0.0.1\nbasicConstraints=CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\n");
openssl(["x509", "-req", "-in", join(pki, "leaf.csr"), "-CA", join(pki, "ca.pem"),
  "-CAkey", join(pki, "ca.key"), "-CAcreateserial", "-out", join(pki, "leaf.pem"),
  "-days", "1", "-extfile", extFile]);

const cleanEnv: NodeJS.ProcessEnv = Object.fromEntries(
  ["PATH", "USER", "LOGNAME", "LANG", "LC_ALL", "TERM"].flatMap((key) =>
    process.env[key] === undefined ? [] : [[key, process.env[key]]]),
);
cleanEnv.HOME = home;
cleanEnv.COTAL_HOME = home;
cleanEnv.TMPDIR = scratchBase;
cleanEnv.NODE_EXTRA_CA_CERTS = join(pki, "ca.pem");
process.env.NODE_EXTRA_CA_CERTS = join(pki, "ca.pem");

// Scrub all COTAL_* and XDG_* environment variables to avoid machine state leak
for (const k of Object.keys(cleanEnv)) {
  if (k.startsWith("COTAL_") && k !== "COTAL_HOME") delete cleanEnv[k];
  if (k.startsWith("XDG_")) delete cleanEnv[k];
}

const tsxUrl = pathToFileURL(createRequire(join(repoRoot, "package.json")).resolve("tsx")).href;
for (let i = 0; i < process.execArgv.length; i++) {
  if (process.execArgv[i] === "tsx") process.execArgv[i] = tsxUrl;
}
const cleanExecArgv = process.execArgv
  .filter((a, i, arr) => a !== "-e" && a !== "--eval" && arr[i - 1] !== "-e" && arr[i - 1] !== "--eval");

const PORT = await pickFreePort();
const SERVER = `nats://127.0.0.1:${PORT}`;
const SPACE = `umt-${Math.floor(Math.random() * 1e6)}`;
const OWNER_A = `u_${"a".repeat(26)}`;
const OWNER_B = `u_${"b".repeat(26)}`;
const AGENT_ACTOR = "worker";
const SELF = fileURLToPath(import.meta.url);

const serverDir = userAuthStateDir(serverRoot, SPACE);
const clientDir = userAuthStateDir(clientRoot, SPACE);
const tokenPath = join(clientDir, "agent-secret.token");
const sentinelPath = join(clientDir, "sentinel.creds");
const healthPath = join(clientDir, "health.json");

let broker: ChildProcess | undefined;
let authService: ChildProcess | undefined;
let idp: ReturnType<typeof createHttpServer> | undefined;
let proxy: ReturnType<typeof createHttpsServer> | undefined;
let responderNc: NatsConnection | undefined;
let provNc: NatsConnection | undefined;
let realManager: InstanceType<typeof Manager> | undefined;
let agent: InstanceType<typeof MeshAgent> | undefined;
let realAgent: InstanceType<typeof MeshAgent> | undefined;

const actualChildProcs: ChildProcess[] = [];
const setupConnections: NatsConnection[] = [];
const childHandles: AgentHandle[] = [];

// Harmless fixture connector & runtime to run real manager spawn and model recording
const SEATS = Number(savedEnv.get("IDLE_SEATS") ?? 10);
const IDLE_MS = Number(savedEnv.get("IDLE_MS") ?? 40_000);
const SEAT_AGENT_DIST = savedEnv.get("SEAT_AGENT_DIST") ?? join(repoRoot, "extensions/connector-core/dist/agent.js");
const HOP_DELAY_MS = 2_000;
const MONITOR_PORT = await pickFreePort();

// The seats' broker hop: every accepted connection waits HOP_DELAY_MS before it is joined to the
// broker, so the client's connect completes no sooner. The accept count is what the seats opened.
let hopAccepts = 0;
const hopAcceptTimes: number[] = [];
const hopSockets = new Set<Socket>();
const hop = createNetServer((client) => {
  hopAccepts++;
  hopAcceptTimes.push(Date.now());
  hopSockets.add(client);
  client.on("error", () => {});
  const t = setTimeout(() => {
    const up = netConnect(PORT, "127.0.0.1");
    hopSockets.add(up);
    up.on("error", () => client.destroy());
    up.on("close", () => { hopSockets.delete(up); client.destroy(); });
    client.on("close", () => up.destroy());
    client.pipe(up);
    up.pipe(client);
  }, HOP_DELAY_MS);
  client.on("close", () => { clearTimeout(t); hopSockets.delete(client); });
});
const HOP_PORT = await pickFreePort();
await new Promise<void>((r) => hop.listen(HOP_PORT, "127.0.0.1", r));
const HOP = `nats://127.0.0.1:${HOP_PORT}`;

// Each seat: a real MeshAgent pinned to its launching manager, as the connector runs it.
const SEAT_SCRIPT = join(scratchBase, "seat.mjs");
writeFileSync(SEAT_SCRIPT, [
  "import { readFileSync } from 'node:fs';",
  "const { MeshAgent } = await import(process.env.SEAT_AGENT_URL);",
  "const env = process.env;",
  "const agent = new MeshAgent({ space: env.COTAL_SPACE, name: env.COTAL_NAME, servers: env.COTAL_SERVERS, tls: false, kind: 'agent',",
  "  lifecycleUid: env.COTAL_LIFECYCLE_UID, managerInstanceId: env.COTAL_MANAGER_INSTANCE,",
  "  userAuth: { owner: env.COTAL_OWNER, actor: env.COTAL_ACTOR, sentinelCreds: readFileSync(env.COTAL_SENTINEL_CREDS, 'utf8'), bearerCmd: JSON.parse(env.COTAL_BEARER_CMD) },",
  "  subscribe: [], allowSubscribe: [], allowPublish: [] }, env);",
  "process.on('SIGTERM', () => { agent.stop().finally(() => process.exit(0)); });",
  "await agent.start();",
  "await agent.whenConnected();",
  "console.log(JSON.stringify({ armed: env.COTAL_NAME, at: Date.now() }));",
  "setInterval(() => {}, 1 << 30);",
].join("\n"));
// Logs one line per bearer exchange, then runs the manager-issued bearer command unchanged.
const BEARER_LOG = join(scratchBase, "bearer.log");
const BEARER_WRAP = join(scratchBase, "bearer-wrap.mjs");
writeFileSync(BEARER_WRAP, [
  "import { appendFileSync } from 'node:fs';",
  "import { spawnSync } from 'node:child_process';",
  "const [log, cmd, ...rest] = process.argv.slice(2);",
  "const r = spawnSync(cmd, rest, { stdio: ['inherit', 'pipe', 'inherit'] });",
  "const out = r.stdout ? r.stdout.toString() : '';",
  "let ttlSec;",
  "try { const p = JSON.parse(Buffer.from(out.trim().split('.')[1], 'base64url').toString()); ttlSec = p.exp - Math.floor(Date.now() / 1000); } catch {}",
  "appendFileSync(log, JSON.stringify({ at: Date.now(), seat: process.env.COTAL_NAME, managerCall: rest.includes('--manager-call'), ttlSec }) + '\\n');",
  "process.stdout.write(out);",
  "process.exit(r.status ?? 1);",
].join("\n"));
const bearerLines = (): { at: number; seat?: string; managerCall: boolean; ttlSec?: number }[] =>
  existsSync(BEARER_LOG) ? readFileSync(BEARER_LOG, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
const armed = new Map<string, number>();
const seatLogs = new Map<string, string[]>();
class ChildHandle implements AgentHandle {
  readonly kind = "fixture";
  private exited = false;
  private code: number | null = null;
  private readonly exits = new Set<() => void>();
  private readonly closed: Promise<void>;
  constructor(readonly name: string, private readonly child: ChildProcess) {
    this.closed = new Promise((resolve) => child.once("close", (code) => {
      this.exited = true;
      this.code = code;
      for (const listener of this.exits) listener();
      resolve();
    }));
  }
  get pid(): number | undefined { return this.child.pid; }
  status(): "running" | "exited" { return this.exited ? "exited" : "running"; }
  stop(): void { if (!this.exited) this.child.kill("SIGTERM"); }
  waitForExit(): Promise<void> { return this.closed; }
  interrupt(): void { if (!this.exited) this.child.kill("SIGINT"); }
  exitInfo(): { code?: number; signal?: number } | undefined {
    return this.exited ? { code: this.code ?? 0 } : undefined;
  }
  attach(): AttachSession {
    return {
      cols: 80, rows: 24,
      backlog: () => Buffer.alloc(0),
      onData: () => () => {},
      onExit: (listener) => { this.exits.add(listener); return () => this.exits.delete(listener); },
      write: () => Promise.resolve(0), resize: () => {},
    };
  }
}

const childRuntime: Runtime = {
  kind: "fixture",
  spawn(name: string, spec: LaunchSpec, cwd: string): AgentHandle {
    const child = spawn(spec.command, spec.args, {
      cwd, env: spec.env, stdio: ["ignore", "pipe", "pipe"],
    });
    actualChildProcs.push(child);
    const lines: string[] = [];
    seatLogs.set(name, lines);
    let buf = "";
    child.stdout?.on("data", (d: Buffer) => {
      buf += d.toString();
      for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        try { const j = JSON.parse(line) as { armed?: string; at?: number }; if (j.armed) armed.set(j.armed, j.at ?? Date.now()); } catch { lines.push(line); }
      }
    });
    child.stderr?.on("data", (d: Buffer) => { lines.push(...d.toString().split("\n").filter(Boolean).map((l) => `${new Date().toISOString()} ${l}`)); });
    teardownOnSignal(child);
    const handle = new ChildHandle(name, child);
    childHandles.push(handle);
    return handle;
  },
};

const runtimeProvider: RuntimeProvider = {
  kind: "runtime",
  name: "fixture",
  available: () => true,
  create: () => childRuntime,
};

const fixtureCon: Connector = {
  kind: "connector",
  name: "fixture",
  eventChannel,
  readinessTimeoutMs: 30_000,
  buildLaunch: (opts: LaunchOpts): LaunchSpec => ({
    command: process.execPath,
    args: [SEAT_SCRIPT],
    env: {
      ...cleanEnv,
      SEAT_AGENT_URL: pathToFileURL(SEAT_AGENT_DIST).href,
      COTAL_SPACE: opts.space,
      COTAL_SERVERS: HOP,
      COTAL_NAME: opts.name,
      COTAL_OWNER: opts.userAuth!.owner,
      COTAL_ACTOR: opts.userAuth!.actor,
      COTAL_SENTINEL_CREDS: opts.userAuth!.sentinelCredsPath,
      COTAL_BEARER_CMD: JSON.stringify([process.execPath, BEARER_WRAP, BEARER_LOG, ...opts.userAuth!.bearerCmd]),
      COTAL_LIFECYCLE_UID: opts.lifecycleUid ?? mintLifecycleUid(),
    },
  }),
};

registry.register(runtimeProvider);
registry.register(fixtureCon);

let teardownDone = false;
const doTeardown = async () => {
  if (teardownDone) return;
  teardownDone = true;

  if (agent) {
    try { await agent.stop(); } catch { /* ignore */ }
    agent = undefined;
  }
  if (realAgent) {
    try { await realAgent.stop(); } catch { /* ignore */ }
    realAgent = undefined;
  }
  if (realManager) {
    try { await realManager.stop(); } catch { /* ignore */ }
    realManager = undefined;
  }
  for (const child of actualChildProcs) {
    try { await killAndAwaitExit(child, "SIGTERM", 5_000); } catch { /* ignore */ }
  }
  for (const nc of setupConnections) await nc.close();
  if (responderNc) {
    try { await responderNc.close(); } catch { /* ignore */ }
    responderNc = undefined;
  }
  if (provNc) {
    try { await provNc.close(); } catch { /* ignore */ }
    provNc = undefined;
  }
  for (const s of hopSockets) s.destroy();
  await new Promise<void>((r) => hop.close(() => r()));
  if (proxy) {
    try { await new Promise<void>((r) => proxy!.close(() => r())); } catch { /* ignore */ }
    proxy = undefined;
  }
  if (idp) {
    try { await new Promise<void>((r) => idp!.close(() => r())); } catch { /* ignore */ }
    idp = undefined;
  }
  if (authService) {
    try { await killAndAwaitExit(authService, "SIGTERM", 5_000); } catch { /* ignore */ }
  }
  if (broker) {
    try { await killAndAwaitExit(broker, "SIGTERM", 5_000); } catch { /* ignore */ }
  }

  // Only delete temporary store when all tracked processes are proven to have exited
  const allProcsExited = [
    ...actualChildProcs,
    ...(authService ? [authService] : []),
    ...(broker ? [broker] : []),
  ].every((p) => p.exitCode !== null || p.signalCode !== null);

  if (allProcsExited) {
    try { rmSync(scratchBase, { recursive: true, force: true }); } catch { /* ignore */ }
  } else {
    throw new Error("smoke teardown: some processes did not exit; preserving scratch directory for inspection");
  }
};

process.on("exit", () => {
  for (const child of actualChildProcs) {
    if (child.exitCode === null && child.signalCode === null) {
      try { child.kill("SIGKILL"); } catch { /* ignore */ }
    }
  }
  if (authService && authService.exitCode === null && authService.signalCode === null) {
    try { authService.kill("SIGKILL"); } catch { /* ignore */ }
  }
  if (broker && broker.exitCode === null && broker.signalCode === null) {
    try { broker.kill("SIGKILL"); } catch { /* ignore */ }
  }
  // Exit hook may signal lingering processes but MUST NOT synchronously delete the store
});

try {
  // ---------- Setup ----------
  const auth = await createSpaceAuth(SPACE);
  saveSpaceAuth(authDir(serverRoot), auth);

  const idpKey = await generateKeyPair("EdDSA", { extractable: true });
  const idpPublic = await exportJWK(idpKey.publicKey);
  idp = createHttpServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/.well-known/openid-configuration") {
      const p = (idp!.address() as AddressInfo).port;
      res.end(JSON.stringify({ issuer: `http://127.0.0.1:${p}`, jwks_uri: `http://127.0.0.1:${p}/jwks` }));
      return;
    }
    if (req.url === "/jwks") {
      res.end(JSON.stringify({ keys: [{ ...idpPublic, kid: "k1", use: "sig", alg: "EdDSA" }] }));
      return;
    }
    res.statusCode = 404; res.end();
  });
  const idpPort = await pickFreePort();
  await new Promise<void>((r) => idp!.listen(idpPort, "127.0.0.1", r));

  const store = workspaceSecretStore(serverRoot);
  const prepared = await cotalAuthProvider.prepareServer({
    space: SPACE,
    operatorSeed: auth.operator.seed,
    account: { pub: auth.account.pub, signingSeed: auth.account.signingSeed },
    store,
    dir: serverDir,
    idpUrl: `http://127.0.0.1:${idpPort}`,
  });

  const callout = await loadCalloutAuth(store, SPACE);
  if (!callout) throw new Error("callout material missing");

  writeFileSync(join(serverRoot, "server.conf"), serverConfig(auth, [auth], {
    transport: { kind: "plaintext" },
    port: PORT,
    storeDir: jsDir,
    extraAccounts: prepared.extraAccounts,
  }) + `\nhttp: 127.0.0.1:${MONITOR_PORT}\n`);
  broker = spawn("nats-server", ["-c", join(serverRoot, "server.conf")], { stdio: "ignore", env: cleanEnv });
  teardownOnSignal(broker);

  let up = false;
  for (let i = 0; i < 50; i++) {
    if (await isReachable(SERVER)) { up = true; break; }
    await wait(100);
  }
  if (!up) throw new Error("nats-server did not become reachable");
  check("nats-server reachable", true);

  await setupSpaceStreams({ servers: SERVER, space: SPACE, creds: await mintCreds(auth, newIdentity(), "provisioner") });
  provNc = await connect({ servers: SERVER, ...standaloneConnectOpts({ creds: await mintCreds(auth, newIdentity(), "provisioner"), tls: false }) });
  const provJsm = await jetstreamManager(provNc);
  const provKvm = new Kvm(provNc);
  await createEndpointStreams(provJsm, provKvm, SPACE);

  // Pre-provision Owner A's DM, DLV and role consumers so MeshAgent can bind
  const ownerAUid = mintLifecycleUid();
  await provJsm.consumers.add(dmStream(SPACE), dmDurableConfig(SPACE, OWNER_A, AGENT_ACTOR, ownerAUid));
  await provJsm.consumers.add(dlvStream(SPACE), dlvDurableConfig(SPACE, OWNER_A, AGENT_ACTOR, ownerAUid));
  await provJsm.consumers.add(taskStream(SPACE), taskDurableConfig(SPACE, "worker"));

  // 1. Platform-Local Manager identity (registered in KV to test routing between local and remote)
  const localManagerInstanceId = mintLifecycleUid();
  const localServe = newIdentity();
  createManagerInstanceIdentity(serverRoot, SPACE, { instanceId: localManagerInstanceId, serveIdentity: localServe });

  // Publish manager service contract schema to EPC stream using endpoint-serve-executor
  const execCreds = await mintCreds(auth, newIdentity(), "endpoint-serve-executor", {
    endpointServeExecutor: { endpoint: "manager", instanceId: localManagerInstanceId },
  });
  const execNc = await connect({ servers: SERVER, ...standaloneConnectOpts({ creds: execCreds, tls: false }), maxReconnectAttempts: 0 });
  setupConnections.push(execNc);
  const contractStore = await contractStoreContext(execNc, SPACE);
  const artifacts = managerClusterArtifacts();
  const allArtifacts = [...managerAuthorityContractSource().artifacts, artifacts.document, artifacts.manifest];
  for (const art of allArtifacts) {
    await publishContractArtifact(contractStore, contractArtifactCanonicalBytes(art));
  }
  await execNc.drain();

  // Helper to publish manager service registration and gate
  const putManager = async (args: { instanceId: string; principal: string; owner: string; epoch?: number; state?: "open" | "frozen" | "retired"; registered?: boolean }) => {
    const id = newIdentity();
    const nc = await connect({ servers: SERVER, ...standaloneConnectOpts({ creds: await mintCreds(auth, id, "endpoint-serve-executor", { endpointServeExecutor: { endpoint: "manager", instanceId: args.instanceId } }), tls: false }) });
    try {
      const kvm = new Kvm(nc);
      const records = await kvm.open(recordsBucket(SPACE));
      const authKv = await kvm.open(epAuthBucket(SPACE));
      let revision = 1;
      if (args.registered !== false) {
        revision = await records.put(recordSpecKey(RECORD_KINDS.svc, ["manager", args.instanceId]), new TextEncoder().encode(JSON.stringify({ endpoint: "manager", owner: args.owner, clusterDigests: [artifacts.closureDigest], protocol: { v: 1 } })));
        await records.put(recordStatusKey(RECORD_KINDS.svc, ["manager", args.instanceId]), new TextEncoder().encode(JSON.stringify({ epoch: args.epoch ?? 1, state: "ready", observedSpecRevision: revision })));
      }
      const state = args.state ?? "open";
      await authKv.put(`epgate.manager.${args.instanceId}`, new TextEncoder().encode(JSON.stringify({ state, generation: 1, processEpoch: args.epoch ?? 1, registrationRevision: revision, nameAuthorityRevision: 0, principal: args.principal, ...(state === "open" ? {} : { op: { opId: mintLifecycleUid(), kind: state === "retired" ? "retirement" : "takeover" } }) })));
    } finally {
      await nc.drain();
    }
  };

  // Register Platform-Local Manager in catalog
  await putManager({ instanceId: localManagerInstanceId, principal: `local.${localServe.id}`, owner: "local" });

  // Grants for Owner A
  grantActor(serverDir, { owner: OWNER_A, actor: "cli", scope: ["spawn", "role:worker", "role:reviewer"], allowSubscribe: [">"], allowPublish: [">"], lifecycleUid: ownerAUid });
  const ownerASecret = newActorToken();
  grantManagedActor(serverDir, { custody: { kind: "foreground" }, owner: OWNER_A, actor: AGENT_ACTOR, scope: ["spawn", "role:worker", "role:reviewer"], allowSubscribe: [">"],
    allowPublish: [">"], parent: `${OWNER_A}.cli`, tokenHash: ownerASecret.tokenHash, lifecycleUid: ownerAUid });
  mkdirSync(clientDir, { recursive: true });
  writeFileSync(tokenPath, ownerASecret.actorToken, { mode: 0o600 });
  writeFileSync(sentinelPath, callout.sentinelCreds, { mode: 0o600 });

  // Start Auth Service
  const publicPort = await pickFreePort();
  const proxyPort = await pickFreePort();
  const exchangeBase = `https://127.0.0.1:${proxyPort}`;

  authService = spawn(process.execPath, [...cleanExecArgv, SELF, "auth-service", "--space", SPACE, "--server", SERVER,
    "--exchange-public-port", String(publicPort), "--exchange-public-url", exchangeBase],
  { cwd: serverRoot, env: cleanEnv, stdio: ["ignore", "pipe", "pipe"] });
  teardownOnSignal(authService);

  await prepared.service.ready({ dir: serverDir, timeoutMs: 15_000 });
  check("auth service is ready with discovery written", true);

  // HTTPS Proxy terminating TLS and proxying HTTP upstream to auth service
  proxy = createHttpsServer({ cert: readFileSync(join(pki, "leaf.pem")), key: readFileSync(join(pki, "leaf.key")) }, (req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (d: Buffer) => chunks.push(d));
    req.on("end", () => {
      const raw = Buffer.concat(chunks);
      const upstream = httpRequest({
        host: "127.0.0.1",
        port: publicPort,
        path: req.url,
        method: req.method,
        headers: { ...req.headers, host: `127.0.0.1:${publicPort}` },
      }, (up) => {
        res.writeHead(up.statusCode ?? 502, up.headers);
        up.pipe(res);
      });
      upstream.on("error", (e) => {
        console.error("PROXY UPSTREAM ERROR:", e);
        res.statusCode = 502;
        res.end(String(e));
      });
      upstream.end(raw);
    });
  });
  await new Promise<void>((r) => proxy!.listen(proxyPort, "127.0.0.1", r));
  check("public exchange TLS proxy listening", true);

  const bearerArgv = (args: string[] = []) => [
    process.execPath, ...cleanExecArgv, SELF, "agent-bearer",
    "--exchange-url", exchangeBase, "--space", SPACE, "--owner", OWNER_A, "--actor", AGENT_ACTOR,
    "--token-file", tokenPath, "--health-file", healthPath,
    ...args,
  ];

  const execBearer = (argv: string[]): Promise<{ code: number; stdout: string; stderr: string }> => {
    return new Promise((resolve) => {
      execFile(argv[0], argv.slice(1), { env: cleanEnv }, (err, stdout, stderr) => {
        resolve({ code: err ? 1 : 0, stdout: stdout.toString(), stderr: stderr.toString() });
      });
    });
  };

  // ---------- Idle seats ----------
  recordMesh({
    space: SPACE, server: SERVER, root: serverRoot, mode: "user", policy: { events: "required" },
    userAuth: assertUserAuthInfo(prepared.publicAuth), ts: new Date().toISOString(),
  });
  const agentsDir = join(serverRoot, ".cotal", "agents");
  mkdirSync(agentsDir, { recursive: true });
  const names = Array.from({ length: SEATS }, (_, i) => `idle_seat_${i + 1}`);
  for (const name of names)
    writeFileSync(join(agentsDir, `${name}.md`), ["---", `name: ${name}`, "role: worker", "agent: fixture", "subscribe: []", "---", "Idle seat."].join("\n"));

  realManager = new Manager({ space: SPACE, servers: SERVER, runtime: "fixture", workspaceRoot: serverRoot, eventsRequired: false });
  await realManager.start();
  const managerInstanceId = (realManager as unknown as { managerInstanceId: string }).managerInstanceId;
  realAgent = new MeshAgent({
    space: SPACE, name: "idle-operator", servers: SERVER, tls: false, lifecycleUid: ownerAUid,
    userAuth: { owner: OWNER_A, actor: AGENT_ACTOR, sentinelCreds: callout.sentinelCreds, bearerCmd: [process.execPath, BEARER_WRAP, BEARER_LOG, ...bearerArgv()] },
    managerInstanceId, subscribe: [], allowSubscribe: [], allowPublish: [],
  }, cleanEnv);
  await realAgent.start();
  await realAgent.whenConnected();
  delete process.env.NODE_EXTRA_CA_CERTS;

  const spawnStart = Date.now();
  let spawned = 0;
  for (const name of names) {
    const r = await realAgent.spawn(name, "worker");
    if (r.ok === true) spawned++;
    else console.log(`  spawn ${name}: ${JSON.stringify(r).slice(0, 400)}`);
  }
  check(`the manager spawned all ${SEATS} seats`, spawned === SEATS, spawned);
  for (let i = 0; i < 1200 && armed.size < SEATS; i++) await wait(100);
  check(`all ${SEATS} seats connected through the 2 s hop and armed their turn relay`, armed.size === SEATS, [...armed.keys()]);
  // Let each seat's first pull, and anything else startup does, finish before the window opens.
  await wait(20_000);
  const varz = async () => (await (await fetch(`http://127.0.0.1:${MONITOR_PORT}/varz`)).json()) as { total_connections: number; connections: number };
  const windowStart = Date.now();
  const before = { hop: hopAccepts, bearer: bearerLines().filter((l) => l.managerCall).length, residentBearer: bearerLines().filter((l) => !l.managerCall).length, broker: (await varz()).total_connections };
  console.log(`  startup (${Math.round((Date.now() - spawnStart) / 1000)} s): ${JSON.stringify(before)}`);
  console.log(`  idle window: ${IDLE_MS} ms`);
  await wait(IDLE_MS);
  const v = await varz();
  const after = { hop: hopAccepts, bearer: bearerLines().filter((l) => l.managerCall).length, residentBearer: bearerLines().filter((l) => !l.managerCall).length, broker: v.total_connections };
  const delta = { hop: after.hop - before.hop, bearer: after.bearer - before.bearer, residentBearer: after.residentBearer - before.residentBearer, broker: after.broker - before.broker, liveBrokerConnections: v.connections };
  console.log(`  idle delta: ${JSON.stringify(delta)}`);
  // The window's timeline, so any connection it holds can be attributed to a cause.
  for (const l of bearerLines().filter((b) => b.at >= windowStart)) console.log(`  window exchange +${Math.round((l.at - windowStart) / 1000)}s ${l.seat} ${l.managerCall ? "manager-call" : "resident"}`);
  for (const t of hopAcceptTimes.filter((t) => t >= windowStart)) console.log(`  window hop accept +${Math.round((t - windowStart) / 1000)}s`);
  for (const [name, lines] of seatLogs) for (const l of lines) if (/run-turn|turn notice|reconnect|renew|disconnect|expir|predates/i.test(l)) console.log(`  ${name}: ${l.slice(0, 400)}`);
  // A hosted agent bearer lives at most 300 s, so a seat renews its resident connection inside a
  // long window. That reconnect is the renewal's own and is counted apart: every other connection
  // an idle seat opened would be a pull.
  const seatRenewals = bearerLines().filter((l) => l.at >= windowStart && l.seat !== undefined && !l.managerCall).length;
  console.log(`  idle seat renewals: ${seatRenewals}; broker connections not from a seat: ${delta.broker - delta.hop}`);
  check("idle seats ran no manager-call bearer exchange", delta.bearer === 0, delta);
  check("every connection an idle seat opened was its own resident credential renewal", delta.hop === seatRenewals, { delta, seatRenewals });

  check(`all ${SEATS} seats are still running`, childHandles.filter((h) => h.status() === "running").length === SEATS, childHandles.map((h) => h.status()));

  // One session's manager calls share one manager-call bearer for its lifetime; each call still
  // opens its own control connection, which the broker authorizes afresh.
  const operatorExchanges = () => bearerLines().filter((l) => l.seat === undefined && l.managerCall).length;
  const reuse0 = { exchanges: operatorExchanges(), broker: (await varz()).total_connections };
  const reads = [];
  for (let i = 0; i < 3; i++) reads.push(await realAgent.inspectModel("idle_seat_1"));
  const reuse1 = { exchanges: operatorExchanges(), broker: (await varz()).total_connections };
  console.log(`  three manager reads: ${JSON.stringify({ before: reuse0, after: reuse1 })}`);
  const ttls = [...new Set(bearerLines().filter((l) => l.managerCall).map((l) => l.ttlSec))];
  console.log(`  manager-call bearer lifetimes issued (s): ${JSON.stringify(ttls)}; reuse margin 120 s`);
  check("three manager reads by one session succeed on at most one manager-call exchange",
    reads.every((r) => r.ok === true) && reuse1.exchanges - reuse0.exchanges <= 1, { reads, reuse0, reuse1 });
  check("each of the three reads opened its own control connection", reuse1.broker - reuse0.broker === 3, { reuse0, reuse1 });

  await realAgent.stop();
  realAgent = undefined;
  await realManager.stop({ withAgents: true });
  realManager = undefined;
} finally {
  try { await doTeardown(); } finally {
    for (const key of Object.keys(process.env)) if (!savedEnv.has(key)) delete process.env[key];
    for (const [key, value] of savedEnv) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
}

const EXPECTED = 10;
emitSentinel({ passed: pass, failed: fail, cells: pass + fail });
console.log(`\n${fail === 0 && pass === EXPECTED ? "PASS" : "FAIL"} — ${pass} passed, ${fail} failed of ${EXPECTED}`);
if (fail > 0 || pass !== EXPECTED) process.exit(1);
