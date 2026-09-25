import assert from "node:assert/strict";
import { execFile, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createServer as createHttpServer, request as httpRequest } from "node:http";
import { createServer as createHttpsServer } from "node:https";
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
const { authDir, recordMesh, assertUserAuthInfo, saveManagerInstanceIdentity, saveSpaceAuth, userAuthStateDir, workspaceSecretStore } = await import(workspaceIndex);
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
const coreDist = join(repoRoot, "packages/core/dist/index.js");

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
  readinessTimeoutMs: 15_000,
  buildLaunch: (opts: LaunchOpts): LaunchSpec => ({
    command: process.execPath,
    args: ["-e", CHILD],
    env: {
      ...cleanEnv,
      COTAL_SPACE: opts.space,
      COTAL_SERVERS: opts.servers ?? "",
      COTAL_NAME: opts.name,
      COTAL_OWNER: opts.userAuth?.owner ?? OWNER_A,
      COTAL_ACTOR: opts.userAuth?.actor ?? opts.name,
      COTAL_SENTINEL_CREDS: opts.userAuth?.sentinelCredsPath ?? sentinelPath,
      COTAL_BEARER_CMD: JSON.stringify(opts.userAuth?.bearerCmd ?? []),
      COTAL_LIFECYCLE_UID: opts.lifecycleUid ?? mintLifecycleUid(),
      CORE_DIST: coreDist,
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
  }));
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
  saveManagerInstanceIdentity(serverRoot, SPACE, { instanceId: localManagerInstanceId, serveIdentity: localServe });

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

  // 2. Owner A Own Remote Manager
  const ownerARemoteInstanceId = mintLifecycleUid();
  const ownerAActors = remoteManagerActors(ownerARemoteInstanceId);
  await putManager({ instanceId: ownerARemoteInstanceId, principal: `${OWNER_A}.${ownerAActors.serve}`, owner: OWNER_A });

  // 3. Owner B Foreign Remote Manager
  const ownerBRemoteInstanceId = mintLifecycleUid();
  const ownerBActors = remoteManagerActors(ownerBRemoteInstanceId);
  await putManager({ instanceId: ownerBRemoteInstanceId, principal: `${OWNER_B}.${ownerBActors.serve}`, owner: OWNER_B });

  // Grants for Owner A
  grantActor(serverDir, { owner: OWNER_A, actor: "cli", scope: ["spawn", "role:worker", "role:reviewer"], allowSubscribe: [">"], allowPublish: [">"], lifecycleUid: ownerAUid });
  const ownerASecret = newActorToken();
  grantManagedActor(serverDir, { owner: OWNER_A, actor: AGENT_ACTOR, scope: ["spawn", "role:worker", "role:reviewer"], allowSubscribe: [">"],
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

  // Wire responder for Owner A's remote manager on NATS with endpoint-serve credentials
  const ownerAExecCreds = await mintCreds(auth, newIdentity(), "endpoint-serve-executor", {
    endpointServeExecutor: { endpoint: "manager", instanceId: ownerARemoteInstanceId },
  });
  const ownerAExecNc = await connect({ servers: SERVER, ...standaloneConnectOpts({ creds: ownerAExecCreds, tls: false }), maxReconnectAttempts: 0 });
  setupConnections.push(ownerAExecNc);
  const ownerAKvm = new Kvm(ownerAExecNc);
  const recordsKv = await ownerAKvm.open(recordsBucket(SPACE));
  const authKv = await ownerAKvm.open(epAuthBucket(SPACE));
  const serveGrant = await authorizeServeGrant(recordsKv, {
    space: SPACE,
    endpoint: "manager",
    instanceId: ownerARemoteInstanceId,
    epoch: 1,
    holder: { owner: OWNER_A },
    authority: { authorize: () => ({ authorized: true, revision: 0 }) },
    readProcessEpoch: () => 1,
    readClusterArtifact: (digest) => {
      if (digest === artifacts.closureDigest) return artifacts.manifest;
      return artifacts.document;
    },
  });
  const gate = serveIssuanceGateKv(authKv, SPACE, { endpoint: "manager", instanceId: ownerARemoteInstanceId });
  const responderId = newIdentity();
  const serveCreds = await mintCreds(auth, responderId, "endpoint-serve", {
    principal: { owner: OWNER_A, actor: ownerAActors.serve },
    endpointServe: serveGrant,
    serveIssuance: gate,
  });
  await ownerAExecNc.drain();

  responderNc = await connect({ servers: SERVER, ...standaloneConnectOpts({ creds: serveCreds, tls: false }), maxReconnectAttempts: 0 });

  const recordedCalls: { command: string; args?: unknown }[] = [];
  const registeredPersonas = [
    { name: "reviewer", role: "reviewer", model: "sonnet", description: "Code reviewer" },
  ];

  const sendReply = (msg: { subject: string; data: Uint8Array }, data: unknown, ok = true, error?: { code: string; message: string }) => {
    const p = parseEpSubject(msg.subject);
    if (!p || p.plane !== "request") return;
    let id = "1";
    if (msg.data && msg.data.length > 0) {
      try {
        const body = JSON.parse(new TextDecoder().decode(msg.data)) as { id?: string };
        if (body && body.id) id = body.id;
      } catch { /* ignore */ }
    }
    const replySubject = deriveReplySubject(SPACE, p, { instanceId: ownerARemoteInstanceId, epoch: 1 });
    const replyEnv = {
      v: 1,
      id,
      ok,
      ...(ok ? { data } : {}),
      ...(!ok && error ? { error } : {}),
    };
    responderNc!.publish(replySubject, new TextEncoder().encode(JSON.stringify(replyEnv)));
  };

  const instPrefix = `cotal.${SPACE}.ep.inst.manager.${ownerARemoteInstanceId}`;
  responderNc.subscribe(`${instPrefix}.describe.>`, {
    callback: (err, msg) => {
      if (err || !msg) return;
      sendReply(msg, {
        public: false,
        descriptor: {
          endpoint: "manager",
          owner: OWNER_A,
          clusters: [
            {
              digest: artifacts.closureDigest,
              commands: [
                "status", "ps", "inspect", "models", "resolve-cwd",
                "spawn", "despawn", "attach", "input", "turn",
                "turn-pending", "turn-yield", "stop", "define-persona",
                "list-personas", "show-persona", "purge", "launch",
              ],
            },
          ],
        },
      });
    },
  });

  responderNc.subscribe(`${instPrefix}.list-personas.>`, {
    callback: (err, msg) => {
      if (err || !msg) return;
      recordedCalls.push({ command: "list-personas" });
      sendReply(msg, { personas: registeredPersonas });
    },
  });

  responderNc.subscribe(`${instPrefix}.show-persona.>`, {
    callback: (err, msg) => {
      if (err || !msg) return;
      const body = JSON.parse(new TextDecoder().decode(msg.data)) as { id: string; args?: { name?: string } };
      recordedCalls.push({ command: "show-persona", args: body.args });
      const p = registeredPersonas.find((x) => x.name === body.args?.name);
      if (p) {
        sendReply(msg, { ...p, persona: `System prompt for ${p.name}` });
      } else {
        sendReply(msg, undefined, false, { code: "not-found", message: "persona not found" });
      }
    },
  });

  responderNc.subscribe(`${instPrefix}.define-persona.>`, {
    callback: (err, msg) => {
      if (err || !msg) return;
      const body = JSON.parse(new TextDecoder().decode(msg.data)) as { id: string; args?: { name?: string } };
      recordedCalls.push({ command: "define-persona", args: body.args });
      sendReply(msg, { name: body.args?.name ?? "custom", path: `/mock/.cotal/agents/${body.args?.name}.md` });
    },
  });

  responderNc.subscribe(`${instPrefix}.inspect.>`, {
    callback: (err, msg) => {
      if (err || !msg) return;
      const body = JSON.parse(new TextDecoder().decode(msg.data)) as { id: string; args?: { name?: string } };
      recordedCalls.push({ command: "inspect", args: body.args });
      const name = body.args?.name ?? "reviewer-child";
      sendReply(msg, {
        name,
        id: "mock-nkey",
        agent: "fixture",
        space: SPACE,
        mode: "pty",
        status: "idle",
        uptimeMs: 1000,
        mesh: "online",
        lifecycleUid: ownerAUid,
        model: "sonnet",
      });
    },
  });

  await responderNc.flush();

  // ==========================================
  // Test 1: Real MeshAgent user mode unpinned (legacy session with NO env pin)
  // ==========================================
  console.log("\n--- Scenario 1: Real MeshAgent User-Mode Unpinned (Own-Remote Precedence) ---");
  agent = new MeshAgent({
    space: SPACE,
    name: "agent-a",
    servers: SERVER,
    tls: false,
    lifecycleUid: ownerAUid,
    userAuth: {
      owner: OWNER_A,
      actor: AGENT_ACTOR,
      sentinelCreds: callout.sentinelCreds,
      bearerCmd: bearerArgv(),
    },
    managerInstanceId: undefined, // Legacy unpinned session!
    subscribe: [],
    allowSubscribe: [],
    allowPublish: [],
  });
  await agent.start();
  check("MeshAgent started on user-auth standing connection", true);

  // 1A. listPersonas over real wire
  const personas = await agent.listPersonas();
  check("MeshAgent.listPersonas() succeeded over real wire", personas.ok === true, personas);
  check("listPersonas routed to Owner A remote manager (own-remote precedence)",
    recordedCalls.some((c) => c.command === "list-personas"));
  const returnedList = (personas.data as { personas?: Array<{ name: string }> })?.personas;
  check("listPersonas returned registered personas", returnedList?.some((p) => p.name === "reviewer") === true, returnedList);

  // 1B. showPersona over real wire
  const show = await agent.showPersona("reviewer");
  check("MeshAgent.showPersona() succeeded over real wire", show.ok === true, show);
  check("showPersona forwarded persona details", (show.data as { model?: string })?.model === "sonnet");

  // 1C. definePersona over real wire
  const define = await agent.definePersona({ name: "critic", prompt: "You are a critic" });
  check("MeshAgent.definePersona() succeeded over real wire", define.ok === true, define);
  check("definePersona recorded on Owner A manager instance",
    recordedCalls.some((c) => c.command === "define-persona" && (c.args as { name?: string })?.name === "critic"));

  // 1D. inspectModel over real wire
  const recorded = await agent.inspectModel("reviewer-child");
  check("agent.inspectModel() succeeded over real wire", recorded.ok === true, recorded);
  check("inspected model matches recorded pin", (recorded as { model?: string }).model === "sonnet");

  // Spawn/model/goal checks below use the real Manager, never a synthetic success reply.
  await agent.stop();
  agent = undefined;
  await responderNc.drain();
  responderNc = undefined;
  check("MeshAgent stopped cleanly", true);

  // ==========================================
  // Test 2: Native Broker Grants (No Wildcard/Class, Instance-Only)
  // ==========================================
  console.log("\n--- Scenario 2: Native Broker Grants Least-Privilege Verification ---");
  const bearerResult = await execBearer(bearerArgv(["--manager-call"]));
  assert.equal(bearerResult.code, 0, bearerResult.stderr);
  const ownerABearer = bearerResult.stdout.trim();

  const ownerAPayload = JSON.parse(Buffer.from(ownerABearer.split(".")[1]!, "base64url").toString("utf8"));
  check("token has view 'manager-caller'", ownerAPayload.act?.view === "manager-caller");
  check("token is bound to Owner A remote instance (own-remote precedence)", ownerAPayload.act?.managerInstanceId === ownerARemoteInstanceId);

  const probeBearer = async (bearer: string, subject: string): Promise<"allowed" | "denied"> => {
    // The synthetic responder has been drained. A native 503 proves an authorized
    // publication reached the broker; only an exact publish denial proves refusal.
    const nc = await connect({
      servers: SERVER,
      ...standaloneConnectOpts({ bearer, sentinelCreds: callout.sentinelCreds, tls: false }),
      maxReconnectAttempts: 0,
    });
    try {
      await nc.request(subject, new TextEncoder().encode("{}"), { timeout: 2000 });
      throw new Error("unexpected responder during permission probe");
    } catch (error) {
      const cause = error instanceof NoRespondersError || error instanceof PermissionViolationError
        ? error : (error as Error).cause;
      if (cause instanceof NoRespondersError && cause.subject === subject) return "allowed";
      if (cause instanceof PermissionViolationError && cause.operation === "publish" && cause.subject === subject) return "denied";
      throw error;
    } finally {
      await nc.close();
    }
  };

  const validNonce = "A".repeat(22);

  const allowedInstSubject = `cotal.${SPACE}.ep.inst.manager.${ownerARemoteInstanceId}.describe.${OWNER_A}.${AGENT_ACTOR}.${ownerAUid}.${validNonce}`;
  check("instance-pinned describe on Owner A manager is ALLOWED by broker",
    (await probeBearer(ownerABearer, allowedInstSubject)) === "allowed");

  const deniedClassOne = `cotal.${SPACE}.ep.one.manager.describe.${OWNER_A}.${AGENT_ACTOR}.${ownerAUid}.${validNonce}`;
  check("class 'one' describe route is DENIED by broker",
    (await probeBearer(ownerABearer, deniedClassOne)) === "denied");

  const deniedClassAll = `cotal.${SPACE}.ep.all.manager.ps.${OWNER_A}.${AGENT_ACTOR}.${ownerAUid}.${validNonce}`;
  check("class 'all' scatter route is DENIED by broker",
    (await probeBearer(ownerABearer, deniedClassAll)) === "denied");

  const deniedForeignInst = `cotal.${SPACE}.ep.inst.manager.${ownerBRemoteInstanceId}.describe.${OWNER_A}.${AGENT_ACTOR}.${ownerAUid}.${validNonce}`;
  check("foreign instance route (Owner B) is DENIED by broker",
    (await probeBearer(ownerABearer, deniedForeignInst)) === "denied");

  const deniedLocalInst = `cotal.${SPACE}.ep.inst.manager.${localManagerInstanceId}.describe.${OWNER_A}.${AGENT_ACTOR}.${ownerAUid}.${validNonce}`;
  check("local manager instance route is DENIED by broker when Owner A remote is selected",
    (await probeBearer(ownerABearer, deniedLocalInst)) === "denied");

  const deniedChat = `cotal.${SPACE}.chat.${OWNER_A}.${AGENT_ACTOR}.general`;
  check("chat publish is DENIED by broker for manager-caller profile",
    (await probeBearer(ownerABearer, deniedChat)) === "denied");

  // ==========================================
  // Test 3: Explicit Local Selection
  // ==========================================
  console.log("\n--- Scenario 3: Explicit Local Selection ---");
  const localResult = await execBearer(bearerArgv(["--manager-call", "--manager-instance", localManagerInstanceId]));
  assert.equal(localResult.code, 0, localResult.stderr);
  const localBearer = localResult.stdout.trim();
  const localPayload = JSON.parse(Buffer.from(localBearer.split(".")[1]!, "base64url").toString("utf8"));
  check("explicit selector binds platform-local manager", localPayload.act?.managerInstanceId === localManagerInstanceId);

  check("local manager publish is ALLOWED under explicit local bearer",
    (await probeBearer(localBearer, `cotal.${SPACE}.ep.inst.manager.${localManagerInstanceId}.describe.${OWNER_A}.${AGENT_ACTOR}.${ownerAUid}.${validNonce}`)) === "allowed");
  check("Owner A remote manager publish is DENIED under local bearer",
    (await probeBearer(localBearer, `cotal.${SPACE}.ep.inst.manager.${ownerARemoteInstanceId}.describe.${OWNER_A}.${AGENT_ACTOR}.${ownerAUid}.${validNonce}`)) === "denied");

  // ==========================================
  // Test 4: Explicit Foreign Selection (Owner B) Refused
  // ==========================================
  console.log("\n--- Scenario 4: Explicit Foreign Selection (Owner B) Refusal ---");
  const foreignResult = await execBearer(bearerArgv(["--manager-call", "--manager-instance", ownerBRemoteInstanceId]));
  check("explicit foreign selector (Owner B) is REFUSED by exchange", foreignResult.code !== 0);
  check("refusal error indicates instance is not this owner's",
    foreignResult.stderr.includes("not this owner's"), foreignResult.stderr);

  // ==========================================
  // Test 5: Multiple Own Remote Managers Refusal
  // ==========================================
  console.log("\n--- Scenario 5: Multiple Own Remote Managers Ambiguity Refusal ---");
  const ownerARemoteInstanceId2 = mintLifecycleUid();
  const ownerAActors2 = remoteManagerActors(ownerARemoteInstanceId2);
  await putManager({ instanceId: ownerARemoteInstanceId2, principal: `${OWNER_A}.${ownerAActors2.serve}`, owner: OWNER_A });

  const ambiguousResult = await execBearer(bearerArgv(["--manager-call"]));
  check("unpinned exchange with multiple own remote managers is REFUSED as ambiguous", ambiguousResult.code !== 0);
  check("refusal indicates multiple candidate managers",
    ambiguousResult.stderr.includes("candidates") && ambiguousResult.stderr.includes("exactly one is required"), ambiguousResult.stderr);

  const explicitSecondResult = await execBearer(bearerArgv(["--manager-call", "--manager-instance", ownerARemoteInstanceId2]));
  check("explicit selection of second manager succeeds", explicitSecondResult.code === 0, explicitSecondResult.stderr);
  const secondBearer = explicitSecondResult.stdout.trim();
  const secondPayload = JSON.parse(Buffer.from(secondBearer.split(".")[1]!, "base64url").toString("utf8"));
  check("explicit bearer binds second remote manager", secondPayload.act?.managerInstanceId === ownerARemoteInstanceId2);

  // ==========================================
  // Test 6: Outage / Non-Fallback & Frozen Gate
  // ==========================================
  console.log("\n--- Scenario 6: Outage Non-Fallback & Frozen Gate Connection Rejection ---");
  await putManager({ instanceId: ownerARemoteInstanceId, principal: `${OWNER_A}.${ownerAActors.serve}`, owner: OWNER_A, state: "frozen" });
  await putManager({ instanceId: ownerARemoteInstanceId2, principal: `${OWNER_A}.${ownerAActors2.serve}`, owner: OWNER_A, state: "frozen" });

  const outageResult = await execBearer(bearerArgv(["--manager-call"]));
  check("frozen candidate managers refuse exchange without falling back to local", outageResult.code !== 0);
  check("refusal does NOT fall back to local manager",
    !outageResult.stdout.includes(localManagerInstanceId));

  // The earlier ownerABearer was minted for ownerARemoteInstanceId, which is now frozen
  let frozenConnectFailed = false;
  try {
    const frozenNc = await connect({
      servers: SERVER,
      ...standaloneConnectOpts({ bearer: ownerABearer, sentinelCreds: callout.sentinelCreds, tls: false }),
      maxReconnectAttempts: 0,
      timeout: 2000,
    });
    await frozenNc.close();
  } catch (error) {
    if (!(error instanceof AuthorizationError)) throw error;
    frozenConnectFailed = true;
  }
  check("connection with token for frozen manager instance is rejected by broker", frozenConnectFailed);

  // ==========================================
  // Test 7: Producer Case — Actual MeshAgent over Real Wire to Real Manager
  // ==========================================
  console.log("\n--- Scenario 7: Producer Case (Real Wire MeshAgent.spawn & Model Pin Recording) ---");
  recordMesh({
    space: SPACE,
    server: SERVER,
    root: serverRoot,
    mode: "user",
    policy: { events: "required" },
    userAuth: assertUserAuthInfo(prepared.publicAuth),
    ts: new Date().toISOString(),
  });

  const agentsDir = join(serverRoot, ".cotal", "agents");
  mkdirSync(agentsDir, { recursive: true });
  writeFileSync(join(agentsDir, "producer_worker_1.md"), [
    "---",
    "name: producer_worker_1",
    "role: worker",
    "agent: fixture",
    "subscribe: [general]",
    "allowPublish: [general]",
    "---",
    "Producer worker 1 persona prompt.",
  ].join("\n"));

  writeFileSync(join(agentsDir, "producer_worker_2.md"), [
    "---",
    "name: producer_worker_2",
    "role: worker",
    "agent: fixture",
    "subscribe: [general]",
    "allowPublish: [general]",
    "---",
    "Producer worker 2 persona prompt.",
  ].join("\n"));

  realManager = new Manager({
    space: SPACE,
    servers: SERVER,
    runtime: "fixture",
    workspaceRoot: serverRoot,
    eventsRequired: false,
  });
  await realManager.start();
  check("Real user-mode Manager started in serverRoot", true);

  // Actual MeshAgent with fresh manager-caller issuer path pinned to real Manager instance
  realAgent = new MeshAgent({
    space: SPACE,
    name: "producer-operator",
    servers: SERVER,
    tls: false,
    lifecycleUid: ownerAUid,
    userAuth: {
      owner: OWNER_A,
      actor: AGENT_ACTOR,
      sentinelCreds: callout.sentinelCreds,
      bearerCmd: bearerArgv(),
    },
    managerInstanceId: realManager.managerInstanceId,
    subscribe: [],
    allowSubscribe: [],
    allowPublish: [],
  });
  await realAgent.start();
  check("actual MeshAgent connected with manager-caller path pinned to real Manager", true);

  // 7A. First spawn over wire to real Manager with model pin "sonnet"
  const p1Reply = await realAgent.spawn("producer_worker_1", "worker", { model: "sonnet" });
  check("actual MeshAgent.spawn over real wire to real Manager succeeded", p1Reply.ok === true, p1Reply);
  check("first real spawn model pin matched requested 'sonnet'", (p1Reply.data as { model?: string })?.model === "sonnet", p1Reply);
  check("first real spawn followed canonical goal to terminal", (p1Reply.data as { mode?: string })?.mode === "fixture" && typeof (p1Reply.data as { lifecycleUid?: string })?.lifecycleUid === "string", p1Reply);

  // 7B. Second spawn over wire to real Manager with distinct model pin "opus"
  const p2Reply = await realAgent.spawn("producer_worker_2", "worker", { model: "opus" });
  check("second MeshAgent.spawn over real wire to real Manager succeeded", p2Reply.ok === true, p2Reply);
  check("second real spawn model pin matched requested 'opus' (distinct dynamic pin)", (p2Reply.data as { model?: string })?.model === "opus", p2Reply);
  check("second real spawn followed canonical goal to terminal", (p2Reply.data as { mode?: string })?.mode === "fixture" && typeof (p2Reply.data as { lifecycleUid?: string })?.lifecycleUid === "string", p2Reply);

  // 7C. Verify real Manager inspect reflects both distinct model pins
  const ins1 = await realAgent.inspectModel("producer_worker_1");
  check("inspectModel for worker 1 reflects real manager pin 'sonnet'", ins1.ok === true && ins1.model === "sonnet", ins1);

  const ins2 = await realAgent.inspectModel("producer_worker_2");
  check("inspectModel for worker 2 reflects real manager pin 'opus'", ins2.ok === true && ins2.model === "opus", ins2);

  // 7D. Actual child stop over real wire
  const despawn1 = await realAgent.despawn("producer_worker_1", { graceful: false });
  check("actual child stop over wire succeeded for worker 1", despawn1.ok === true, despawn1);

  const despawn2 = await realAgent.despawn("producer_worker_2", { graceful: false });
  check("actual child stop over wire succeeded for worker 2", despawn2.ok === true, despawn2);

  await realAgent.stop();
  realAgent = undefined;
  await realManager.stop();
  realManager = undefined;
  check("Real user-mode Manager and producer agent stopped cleanly", true);

} finally {
  try { await doTeardown(); } finally {
    for (const key of Object.keys(process.env)) if (!savedEnv.has(key)) delete process.env[key];
    for (const [key, value] of savedEnv) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
}

const EXPECTED_CHECKS = 47;
check("all smoke checks passed", pass + fail === EXPECTED_CHECKS, { pass, fail, expected: EXPECTED_CHECKS });

const ACTUAL_COUNT_GUARD = 48;
emitSentinel({ passed: pass, failed: fail, cells: pass + fail });
console.log(`\n${fail === 0 ? "PASS" : "FAIL"} — ${pass} passed, ${fail} failed`);
console.log("USER-MANAGER-TRANSPORT SMOKE COMPLETE");

if (fail > 0) process.exit(1);
if (pass !== ACTUAL_COUNT_GUARD) {
  console.error(`assertion count guard failed: expected exactly ${ACTUAL_COUNT_GUARD} passed checks, got ${pass}`);
  process.exit(1);
}
