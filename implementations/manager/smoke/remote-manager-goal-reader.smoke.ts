/*
 * Companion acceptance fixture: Hosted remote manager producer & multi-owner routing.
 *
 * Covers:
 *  Cell 1: Two concurrent different-owner remote supervisors in ONE account using
 *          actual auth prepare/activate and scoped goal-writer.
 *  Cell 2: Each caller selects its owner's remote manager, submits a deliberately failed
 *          spawn, and reads its canonical terminal through the real goal-result command.
 *  Cell 3: A known foreign goal is hidden and the foreign instance rail is denied.
 *
 * This proves remote routing and goal production/readback, not successful remote enrollment.
 *
 * All state is disposable and isolated. Requires Linux, nats-server, openssl.
 */

if (process.platform !== "linux")
  throw new Error("hosted remote manager producer acceptance requires Linux");
if (process.env.COTAL_OWNER_NATIVE_ACCEPTANCE !== "1")
  throw new Error("hosted remote manager producer acceptance is owner-only; set COTAL_OWNER_NATIVE_ACCEPTANCE=1");

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

// Respect TMPDIR job scratch without falling back to /tmp when TMPDIR is set
const baseTmp = tmpdir();
const cleanEnv = (): NodeJS.ProcessEnv => Object.fromEntries(
  ["PATH", "HOME", "TMPDIR", "USER", "LOGNAME", "LANG", "LC_ALL", "TERM"].map((key) => [key, process.env[key]]),
);

if (!process.env.COTAL_PRODUCER_HTTPS_CA) {
  const pki = mkdtempSync(join(baseTmp, "ca-"));
  const openssl = (args: string[]): void => {
    const r = spawnSync("openssl", args, { stdio: "pipe", encoding: "utf8", env: cleanEnv() });
    if (r.status !== 0) throw new Error(`openssl failed: ${r.stderr || r.stdout}`);
  };
  let status = 1;
  try {
    openssl(["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", join(pki, "ca.key"),
      "-out", join(pki, "ca.pem"), "-days", "2", "-subj", "/CN=cotal-producer-ca",
      "-addext", "basicConstraints=critical,CA:TRUE"]);
    openssl(["req", "-newkey", "rsa:2048", "-nodes", "-keyout", join(pki, "leaf.key"),
      "-out", join(pki, "leaf.csr"), "-subj", "/CN=localhost"]);
    writeFileSync(join(pki, "leaf.ext"), "subjectAltName=DNS:localhost,IP:127.0.0.1\nbasicConstraints=CA:FALSE\n");
    openssl(["x509", "-req", "-in", join(pki, "leaf.csr"), "-CA", join(pki, "ca.pem"),
      "-CAkey", join(pki, "ca.key"), "-CAcreateserial", "-out", join(pki, "leaf.pem"),
      "-days", "2", "-extfile", join(pki, "leaf.ext")]);

    const env = cleanEnv();
    Object.assign(env, {
      COTAL_OWNER_NATIVE_ACCEPTANCE: "1",
      COTAL_PRODUCER_HTTPS_CA: join(pki, "ca.pem"),
      COTAL_PRODUCER_HTTPS_CERT: join(pki, "leaf.pem"),
      COTAL_PRODUCER_HTTPS_KEY: join(pki, "leaf.key"),
      NODE_EXTRA_CA_CERTS: join(pki, "ca.pem"),
    });
    const child = spawnSync(process.execPath, [...process.execArgv, process.argv[1]!, ...process.argv.slice(2)], {
      stdio: "inherit",
      env,
    });
    status = child.status ?? 1;
  } finally {
    rmSync(pki, { recursive: true, force: true });
  }
  process.exit(status);
}

// Main acceptance suite starts here (under initialized PKI and NODE_EXTRA_CA_CERTS)
import { createHash, randomBytes } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer as createHttpServer, request as httpRequest } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { createServer as createNetServer, type AddressInfo } from "node:net";
import { connect, PermissionViolationError, type NatsConnection } from "@nats-io/transport-node";
import { Kvm } from "@nats-io/kv";

const betterAuthRoot = new URL("../../auth/node_modules/better-auth/", import.meta.url);
const { betterAuth } = await import(new URL("dist/index.mjs", betterAuthRoot).href);
const { memoryAdapter } = await import(new URL("dist/adapters/memory-adapter/index.mjs", betterAuthRoot).href);
const { jwt } = await import(new URL("dist/plugins/jwt/index.mjs", betterAuthRoot).href);
const { deviceAuthorization } = await import(new URL("dist/plugins/device-authorization/index.mjs", betterAuthRoot).href);
const { bearer: betterAuthBearer } = await import(new URL("dist/plugins/bearer/index.mjs", betterAuthRoot).href);
const { toNodeHandler } = await import(new URL("dist/integrations/node.mjs", betterAuthRoot).href);

import {
  createSpaceAuth,
  epAuthBucket,
  epgateKey,
  meetsBrokerFloor,
  mintConnectionEvictorCreds,
  mintCreds,
  mintLifecycleUid,
  mintMembershipObserverCreds,
  newIdentity,
  parseServiceSpec,
  recordSpecKey,
  RECORD_KINDS,
  recordsBucket,
  remoteManagerActors,
  serverConfig,
  setupSpaceStreams,
  standaloneConnectOpts,
  waitForDeliveryLease,
  epRequestSubject,
  parseGoalResultFact,
  type GoalResultFact,
  resolveService,
  invokeCommand,
  type EpCaller,
} from "@cotal-ai/core";

import {
  assertUserAuthInfo,
  authDir,
  connectionEvictorCredsKey,
  deliveryCredsKey,
  findMesh,
  hasUserAuthState,
  membershipObserverCredsKey,
  membershipRwCredsKey,
  recordMesh,
  userAuthStateDir,
  workspaceSecretStore,
} from "@cotal-ai/workspace";

import {
  cotalAuthProvider,
  establishIdpSession,
  grantActor,
  loadAuthServiceInfo,
  loadCalloutAuth,
} from "@cotal-ai/auth";

import { persistRemoteUserEntry } from "../../cli/src/commands/meshes-add.js";
import { SMOKE_BROKER_TOKEN, emitSentinel, teardownOnSignal } from "@cotal-ai/smoke-kit";
import { loadOrCreateRemoteManagerIdentity } from "../src/remote-authority.js";
import { MANAGER_ENDPOINT } from "../src/manager-service-contract.js";

const repoRoot = resolve(import.meta.dirname, "..", "..", "..");
const cli = join(repoRoot, "bin", "cotal.ts");

const pickFreePort = (): Promise<number> =>
  new Promise((res, rej) => {
    const s = createNetServer();
    s.on("error", rej);
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as AddressInfo).port;
      s.close(() => res(p));
    });
  });

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
let fail = 0;
const check = (name: string, condition: boolean, extra?: unknown): void => {
  if (condition) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ FAIL: ${name}`, extra !== undefined ? extra : "");
  }
};

// Isolated scratch root under baseTmp
const scratchRoot = mkdtempSync(join(baseTmp, "pr-"));
const home = join(scratchRoot, "h");
mkdirSync(home, { recursive: true });
const homeA = join(scratchRoot, "ha");
mkdirSync(homeA, { recursive: true });
const homeB = join(scratchRoot, "hb");
mkdirSync(homeB, { recursive: true });
const hostRoot = join(scratchRoot, `${SMOKE_BROKER_TOKEN}s`);
mkdirSync(hostRoot, { recursive: true });
const partRootA = join(scratchRoot, "pa");
mkdirSync(partRootA, { recursive: true });
const partRootB = join(scratchRoot, "pb");
mkdirSync(partRootB, { recursive: true });
const xdg = join(scratchRoot, "x");
mkdirSync(xdg, { recursive: true });

process.env.COTAL_HOME = home;

// Tracked processes for clean exit before store removal
type OwnedProc = { label: string; pid: number; startTime: string; cgroupSha256: string };
const ownedProcs = new Map<ChildProcess, OwnedProc>();

const procIdentity = (pid: number): Omit<OwnedProc, "label"> | undefined => {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const close = stat.lastIndexOf(")");
    if (close < 0) return undefined;
    const fields = stat.slice(close + 2).trim().split(/\s+/);
    const startTime = fields[19];
    if (!startTime) return undefined;
    const cgroup = readFileSync(`/proc/${pid}/cgroup`, "utf8");
    return { pid, startTime, cgroupSha256: createHash("sha256").update(cgroup).digest("hex") };
  } catch {
    return undefined;
  }
};

const track = (label: string, child: ChildProcess): ChildProcess => {
  if (child.pid === undefined) throw new Error(`${label} process has no pid`);
  const ident = procIdentity(child.pid);
  if (!ident) throw new Error(`${label} process identity could not be read`);
  ownedProcs.set(child, { label, ...ident });
  return child;
};

const awaitExit = (child: ChildProcess, timeoutMs = 5000): Promise<boolean> => {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const done = () => { clearTimeout(timer); resolve(true); };
    const timer = setTimeout(() => { child.off("exit", done); resolve(false); }, timeoutMs);
    child.once("exit", done);
  });
};

const stopProcess = async (child: ChildProcess | undefined): Promise<boolean> => {
  if (!child) return true;
  if (child.exitCode !== null || child.signalCode !== null) return true;
  const expected = ownedProcs.get(child);
  if (!expected) return awaitExit(child, 1000);
  const current = procIdentity(expected.pid);
  if (!current || current.startTime !== expected.startTime || current.cgroupSha256 !== expected.cgroupSha256)
    return awaitExit(child, 1000);
  child.kill("SIGTERM");
  if (await awaitExit(child, 5000)) return true;
  const beforeKill = procIdentity(expected.pid);
  if (!beforeKill || beforeKill.startTime !== expected.startTime || beforeKill.cgroupSha256 !== expected.cgroupSha256)
    return awaitExit(child, 5000);
  child.kill("SIGKILL");
  return awaitExit(child, 5000);
};

import { pathToFileURL } from "node:url";

const coreDistUrl = pathToFileURL(join(repoRoot, "packages/core/dist/index.js")).href;
const deliveryDistUrl = pathToFileURL(join(repoRoot, "implementations/delivery/dist/index.js")).href;
const workspaceDistUrl = pathToFileURL(join(repoRoot, "packages/workspace/dist/index.js")).href;

// A connector declaration lets a genuine spawn pass admission, but cannot launch a child.
// No manager, auth-provider, broker permission, or host ledger behavior is replaced.
const extensions = join(xdg, "cotal", "extensions");
const extensionDir = join(extensions, "node_modules", "remote-reader-test");
mkdirSync(extensionDir, { recursive: true });
writeFileSync(join(extensionDir, "package.json"), JSON.stringify({ name: "remote-reader-test", version: "1.0.0", type: "module", main: "index.js", peerDependencies: { "@cotal-ai/core": "*" } }));
writeFileSync(join(extensionDir, "index.js"), `import { registry } from ${JSON.stringify(coreDistUrl)};
registry.register({ kind: "connector", name: "remote-reader-test", buildLaunch() { throw new Error("fixture refuses child launch"); } });\n`);
writeFileSync(join(extensions, "extensions.json"), JSON.stringify({ extensions: [{ pkg: "remote-reader-test", version: "1.0.0", spec: "file:remote-reader-test", provides: [{ kind: "connector", name: "remote-reader-test" }], commands: [], connectors: [{ name: "remote-reader-test", requires: [] }] }] }));
for (const [index, root] of [partRootA, partRootB].entries()) {
  const dir = join(root, ".cotal", "agents");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `worker_${index}.md`), `---\nname: worker_${index}\nrole: worker\nagent: remote-reader-test\nevents: false\n---\nReader fixture.\n`);
}

// Delivery runner script
const deliveryScript = join(scratchRoot, "delivery-runner.mjs");
writeFileSync(deliveryScript, [
  `import { runDelivery } from '${deliveryDistUrl}';`,
  `import { workspaceSecretStore } from '${workspaceDistUrl}';`,
  "await runDelivery({",
  "  values: { space: process.env.COTAL_SPACE, server: process.env.COTAL_SERVERS },",
  "  positionals: [],",
  "  raw: [],",
  "}, workspaceSecretStore(process.env.COTAL_HOST_ROOT));",
].join("\n"));

const space = `prod-${Math.random().toString(36).slice(2, 10)}`;
const brokerPort = await pickFreePort();
const server = `nats://127.0.0.1:${brokerPort}`;
const hostDir = userAuthStateDir(hostRoot, space);
const hostStore = workspaceSecretStore(hostRoot);

let broker: ChildProcess | undefined;
let delivery: ChildProcess | undefined;
let authService: ChildProcess | undefined;
let supervisorA: ChildProcess | undefined;
let supervisorB: ChildProcess | undefined;
let idpServer: ReturnType<typeof createHttpServer> | undefined;
let exchangeProxy: ReturnType<typeof createHttpsServer> | undefined;
let adminNc: NatsConnection | undefined;
let ncA: NatsConnection | undefined;
let ncB: NatsConnection | undefined;
let storeDir: string | undefined;

const childEnv = (values: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => {
  return { ...cleanEnv(), ...values };
};

let supervisorAOutput = "";
let supervisorBOutput = "";
let deliveryOutput = "";
let authOutput = "";

const appendOut = (current: string, chunk: Buffer | string): string =>
  `${current}${chunk.toString()}`.slice(-32768);

try {
  mkdirSync(join(hostRoot, ".cotal"), { recursive: true });
  mkdirSync(join(partRootA, ".cotal"), { recursive: true });
  mkdirSync(join(partRootB, ".cotal"), { recursive: true });

  const auth = await createSpaceAuth(space);
  const { saveSpaceAuth } = await import("@cotal-ai/workspace");
  saveSpaceAuth(authDir(hostRoot), auth);

  // 1. IdP Setup
  let idpHandler: ReturnType<typeof toNodeHandler> | undefined;
  idpServer = createHttpServer((req, res) => idpHandler!(req, res));
  await new Promise<void>((r) => idpServer!.listen(0, "127.0.0.1", r));
  const idpPort = (idpServer.address() as AddressInfo).port;
  const origin = `http://127.0.0.1:${idpPort}`;
  const idpUrl = `${origin}/api/auth`;
  const idp = betterAuth({
    baseURL: origin,
    secret: "smoke-idp-secret-0123456789abcdef",
    database: memoryAdapter({ user: [], session: [], account: [], verification: [], jwks: [], deviceCode: [] }),
    emailAndPassword: { enabled: true },
    plugins: [
      jwt({ jwt: { issuer: origin, audience: origin } }),
      deviceAuthorization({ expiresIn: "2m", interval: "1s", validateClient: () => true }),
      betterAuthBearer(),
    ],
  });
  idpHandler = toNodeHandler(idp);

  const prepared = await cotalAuthProvider.prepareServer({
    space,
    operatorSeed: auth.operator.seed,
    account: { pub: auth.account.pub, signingSeed: auth.account.signingSeed },
    store: hostStore,
    dir: hostDir,
    idpUrl,
  });

  // 2. Broker Setup
  storeDir = mkdtempSync(join(baseTmp, "js-"));
  writeFileSync(join(hostRoot, "server.conf"), serverConfig(auth, [auth], {
    transport: { kind: "plaintext" },
    port: brokerPort,
    storeDir,
    extraAccounts: prepared.extraAccounts,
  }));

  broker = track("broker", spawn("nats-server", ["-c", join(hostRoot, "server.conf")], { stdio: "ignore", env: cleanEnv() }));
  teardownOnSignal(broker);

  let brokerReady = false;
  let brokerVer = "";
  for (let tries = 0; tries < 60 && broker.exitCode === null; tries++) {
    try {
      const nc = await connect({
        servers: server,
        ...standaloneConnectOpts({ creds: await mintCreds(auth, newIdentity(), "provisioner"), tls: false }),
        maxReconnectAttempts: 0,
        timeout: 300,
      });
      brokerVer = nc.info?.version ?? "";
      await nc.close();
      brokerReady = true;
      break;
    } catch {
      await wait(100);
    }
  }
  if (!brokerReady) throw new Error("broker did not become ready");
  check("connected broker INFO names a version at or above the product floor", brokerVer !== "" && meetsBrokerFloor(brokerVer), brokerVer);

  await setupSpaceStreams({ servers: server, space, creds: await mintCreds(auth, newIdentity(), "provisioner") });

  // 3. Delivery Setup
  const hosted = { injected: true } as const;
  await hostStore.put(deliveryCredsKey(space, hosted), await mintCreds(auth, newIdentity(), "delivery"));
  await hostStore.put(membershipRwCredsKey(space, hosted), await mintCreds(auth, newIdentity(), "membership-rw"));
  await hostStore.put(membershipObserverCredsKey(space, hosted), await mintMembershipObserverCreds(auth, newIdentity()));
  await hostStore.put(connectionEvictorCredsKey(space, hosted), await mintConnectionEvictorCreds(auth, newIdentity()));

  delivery = track("delivery", spawn(process.execPath, [...process.execArgv, deliveryScript], {
    cwd: hostRoot,
    env: childEnv({
      COTAL_HOST_ROOT: hostRoot,
      COTAL_SPACE: space,
      COTAL_SERVERS: server,
    }),
    stdio: ["ignore", "pipe", "pipe"],
  }));
  delivery.stdout?.on("data", (c) => { deliveryOutput = appendOut(deliveryOutput, c); });
  delivery.stderr?.on("data", (c) => { deliveryOutput = appendOut(deliveryOutput, c); });

  const delProbe = newIdentity();
  const leaseOk = await waitForDeliveryLease({
    servers: server, space, creds: await mintCreds(auth, delProbe, "delivery"),
    id: delProbe.id, holder: undefined, timeoutMs: 30_000,
  });
  if (!leaseOk) throw new Error(`delivery did not become ready: ${deliveryOutput}`);
  check("delivery daemon became ready and acquired lease", leaseOk);

  // 4. Auth Service Setup
  authService = track("auth-service", spawn(process.execPath, [...process.execArgv, cli, "auth-service", "--space", space, "--server", server, "--exchange-public-port", "0"], {
    cwd: hostRoot,
    env: childEnv({
      COTAL_HOME: home,
      COTAL_SKIP_CONNECTOR_SEED: "1",
      XDG_CONFIG_HOME: xdg,
    }),
    stdio: ["ignore", "pipe", "pipe"],
  }));
  authService.stdout?.on("data", (c) => { authOutput = appendOut(authOutput, c); });
  authService.stderr?.on("data", (c) => { authOutput = appendOut(authOutput, c); });

  let authInfo: ReturnType<typeof loadAuthServiceInfo>;
  for (let tries = 0; tries < 600; tries++) {
    authInfo = loadAuthServiceInfo(hostDir);
    if (authInfo) {
      try {
        if ((await fetch(`${authInfo.url}/health`, { signal: AbortSignal.timeout(500) })).ok) break;
      } catch { /* wait */ }
    }
    if (authService.exitCode !== null || authService.signalCode !== null)
      throw new Error(`auth service exited unexpectedly: ${authOutput}`);
    await wait(100);
  }
  if (!authInfo?.publicUrl) throw new Error(`auth service did not expose public URL: ${authOutput}`);
  check("auth service is ready and exposed public URL", typeof authInfo.publicUrl === "string");

  // 5. HTTPS Reverse Proxy Setup
  exchangeProxy = createHttpsServer({
    cert: readFileSync(process.env.COTAL_PRODUCER_HTTPS_CERT!),
    key: readFileSync(process.env.COTAL_PRODUCER_HTTPS_KEY!),
  }, (req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      const upstreamUrl = new URL(authInfo!.publicUrl!);
      const upstreamPath = req.url?.startsWith("/register/") ? "/register" : req.url;
      const upstream = httpRequest({
        host: upstreamUrl.hostname,
        port: Number(upstreamUrl.port),
        path: upstreamPath,
        method: req.method,
        headers: { ...req.headers, host: upstreamUrl.host },
      }, (response) => {
        res.writeHead(response.statusCode ?? 502, response.headers);
        response.pipe(res);
      });
      upstream.on("error", (e) => { res.statusCode = 502; res.end(e.message); });
      upstream.end(body);
    });
  });
  await new Promise<void>((r) => exchangeProxy!.listen(0, "127.0.0.1", r));
  const proxyPort = (exchangeProxy.address() as AddressInfo).port;
  const secureExchangeUrl = `https://127.0.0.1:${proxyPort}`;
  check("HTTPS proxy bound and listening", proxyPort > 0);

  // 6. Sign up two distinct owners in their own home directories
  // Owner A in homeA
  process.env.COTAL_HOME = homeA;
  const signupA = await idp.api.signUpEmail({
    body: { email: "owner_a@example.test", password: "password-for-owner-a-1234", name: "Owner A" },
    returnHeaders: true,
  });
  const cookieA = signupA.headers.get("set-cookie")!.split(";")[0]!;
  const approveA = async (userCode: string) => {
    await fetch(`${idpUrl}/device?user_code=${encodeURIComponent(userCode)}`, { headers: { cookie: cookieA, origin } });
    await fetch(`${idpUrl}/device/approve`, {
      method: "POST", headers: { "content-type": "application/json", cookie: cookieA, origin },
      body: JSON.stringify({ userCode }),
    });
  };
  await establishIdpSession({ dir: homeA, idpUrl, clientId: "cli-a", onPrompt: (p) => void approveA(p.userCode) });
  const ownerA = await cotalAuthProvider.ownerForLogin({ store: hostStore, dir: hostDir, space });

  // Owner B in homeB
  process.env.COTAL_HOME = homeB;
  const signupB = await idp.api.signUpEmail({
    body: { email: "owner_b@example.test", password: "password-for-owner-b-1234", name: "Owner B" },
    returnHeaders: true,
  });
  const cookieB = signupB.headers.get("set-cookie")!.split(";")[0]!;
  const approveB = async (userCode: string) => {
    await fetch(`${idpUrl}/device?user_code=${encodeURIComponent(userCode)}`, { headers: { cookie: cookieB, origin } });
    await fetch(`${idpUrl}/device/approve`, {
      method: "POST", headers: { "content-type": "application/json", cookie: cookieB, origin },
      body: JSON.stringify({ userCode }),
    });
  };
  await establishIdpSession({ dir: homeB, idpUrl, clientId: "cli-b", onPrompt: (p) => void approveB(p.userCode) });
  const ownerB = await cotalAuthProvider.ownerForLogin({ store: hostStore, dir: hostDir, space });

  check("two distinct owners established via IdP (ownerA !== ownerB)", typeof ownerA === "string" && typeof ownerB === "string" && ownerA !== ownerB, { ownerA, ownerB });

  // Grant actors for both owners on the host
  grantActor(hostDir, { owner: ownerA, actor: "cli", scope: ["spawn", "role:default", "supervise"], allowSubscribe: [], allowPublish: [] });
  grantActor(hostDir, { owner: ownerA, actor: "operator", scope: ["spawn", "role:worker"], allowSubscribe: [], allowPublish: [] });

  grantActor(hostDir, { owner: ownerB, actor: "cli", scope: ["spawn", "role:default", "supervise"], allowSubscribe: [], allowPublish: [] });
  grantActor(hostDir, { owner: ownerB, actor: "operator", scope: ["spawn", "role:worker"], allowSubscribe: [], allowPublish: [] });

  const callout = await loadCalloutAuth(hostStore, space);
  if (!callout) throw new Error("host callout material is missing");

  // Configure participant roots with policyCheckedAt in future so supervise doesn't re-query policy
  process.env.COTAL_HOME = homeA;
  persistRemoteUserEntry(space, server, partRootA, {
    space, server, tlsRequired: false,
    userAuth: assertUserAuthInfo({
      provider: "cotal", idp: { url: idpUrl, issuer: origin, audience: origin }, endpoints: { url: secureExchangeUrl },
    }),
    sentinelCreds: callout.sentinelCreds,
  }, false, false);
  const entryA = findMesh(space);
  if (!entryA) throw new Error("mesh entry A vanished after persistence");
  recordMesh({ ...entryA, policyCheckedAt: new Date(Date.now() + 60 * 60 * 1000).toISOString() });

  process.env.COTAL_HOME = homeB;
  persistRemoteUserEntry(space, server, partRootB, {
    space, server, tlsRequired: false,
    userAuth: assertUserAuthInfo({
      provider: "cotal", idp: { url: idpUrl, issuer: origin, audience: origin }, endpoints: { url: secureExchangeUrl },
    }),
    sentinelCreds: callout.sentinelCreds,
  }, false, false);
  const entryB = findMesh(space);
  if (!entryB) throw new Error("mesh entry B vanished after persistence");
  recordMesh({ ...entryB, policyCheckedAt: new Date(Date.now() + 60 * 60 * 1000).toISOString() });

  check("both participant meshes configured and persisted in registry",
    hasUserAuthState(partRootA, space) === false && hasUserAuthState(partRootB, space) === false);

  const supervisorEnvA = {
    PATH: process.env.PATH,
    COTAL_HOME: homeA,
    HOME: homeA,
    TMPDIR: baseTmp,
    COTAL_SKIP_CONNECTOR_SEED: "1",
    XDG_CONFIG_HOME: xdg,
    NODE_EXTRA_CA_CERTS: process.env.NODE_EXTRA_CA_CERTS,
  };

  const supervisorEnvB = {
    PATH: process.env.PATH,
    COTAL_HOME: homeB,
    HOME: homeB,
    TMPDIR: baseTmp,
    COTAL_SKIP_CONNECTOR_SEED: "1",
    XDG_CONFIG_HOME: xdg,
    NODE_EXTRA_CA_CERTS: process.env.NODE_EXTRA_CA_CERTS,
  };

  // ==========================================
  // Cell 1: Two concurrent different-owner remote supervisors in ONE account
  // ==========================================
  supervisorA = track("supervisor-a", spawn(process.execPath, [...process.execArgv, cli, "supervise", "--space", space, "--server", server, "--runtime", "pty"], {
    cwd: partRootA, env: supervisorEnvA, stdio: ["ignore", "pipe", "pipe"],
  }));
  supervisorA.stdout?.on("data", (c) => { supervisorAOutput = appendOut(supervisorAOutput, c); });
  supervisorA.stderr?.on("data", (c) => { supervisorAOutput = appendOut(supervisorAOutput, c); });

  supervisorB = track("supervisor-b", spawn(process.execPath, [...process.execArgv, cli, "supervise", "--space", space, "--server", server, "--runtime", "pty"], {
    cwd: partRootB, env: supervisorEnvB, stdio: ["ignore", "pipe", "pipe"],
  }));
  supervisorB.stdout?.on("data", (c) => { supervisorBOutput = appendOut(supervisorBOutput, c); });
  supervisorB.stderr?.on("data", (c) => { supervisorBOutput = appendOut(supervisorBOutput, c); });

  for (let tries = 0; tries < 600 && (!supervisorAOutput.includes("manager up") || !supervisorBOutput.includes("manager up")); tries++) {
    if (supervisorA.exitCode !== null || supervisorB.exitCode !== null) break;
    await wait(100);
  }

  check("Cell 1: Supervisor A reached manager up through remote prepare and activate",
    supervisorAOutput.includes("manager up") && supervisorA.exitCode === null,
    { exitCode: supervisorA.exitCode, output: supervisorAOutput.slice(-500) });

  check("Cell 1: Supervisor B reached manager up through remote prepare and activate",
    supervisorBOutput.includes("manager up") && supervisorB.exitCode === null,
    { exitCode: supervisorB.exitCode, output: supervisorBOutput.slice(-500) });

  check("Cell 1: Two supervisors are running concurrently in the same space",
    supervisorA.exitCode === null && supervisorB.exitCode === null);

  const stateA = loadOrCreateRemoteManagerIdentity(partRootA, space);
  const stateB = loadOrCreateRemoteManagerIdentity(partRootB, space);
  check("Cell 1: Both managers registered distinct logical instance IDs (iidA !== iidB)",
    stateA.instanceId !== stateB.instanceId, { iidA: stateA.instanceId, iidB: stateB.instanceId });

  // Verify KV records for both instances in records bucket
  adminNc = await connect({
    servers: server,
    ...standaloneConnectOpts({ creds: await mintCreds(auth, newIdentity(), "provisioner"), tls: false }),
  });
  const kvm = new Kvm(adminNc);
  const recordsKv = await kvm.open(recordsBucket(space));

  const specRawA = await recordsKv.get(recordSpecKey(RECORD_KINDS.svc, ["manager", stateA.instanceId]));
  const specRawB = await recordsKv.get(recordSpecKey(RECORD_KINDS.svc, ["manager", stateB.instanceId]));
  const specA = specRawA ? parseServiceSpec(JSON.parse(new TextDecoder().decode(specRawA.value)), { endpoint: "manager" }) : undefined;
  const specB = specRawB ? parseServiceSpec(JSON.parse(new TextDecoder().decode(specRawB.value)), { endpoint: "manager" }) : undefined;

  check("Cell 1: Both instances registered in records KV with respective owners",
    specA?.owner === ownerA && specB?.owner === ownerB, { specAOwner: specA?.owner, specBOwner: specB?.owner });

  const observeGate = async (instanceId: string) => {
    const observerId = newIdentity();
    const observer = await connect({
      servers: server,
      ...standaloneConnectOpts({
        creds: await mintCreds(auth, observerId, "endpoint-serve-executor", {
          endpointServeExecutor: { endpoint: "manager", instanceId },
        }),
        tls: false,
      }),
      maxReconnectAttempts: 0,
    });
    try {
      const authKv = await new Kvm(observer).open(epAuthBucket(space));
      const gate = await authKv.get(epgateKey("manager", instanceId));
      return gate ? JSON.parse(new TextDecoder().decode(gate.value)) as { state: string; processEpoch: number; principal: string } : null;
    } finally {
      await observer.drain().catch(() => observer.close());
    }
  };

  const gateObsA = await observeGate(stateA.instanceId);
  const gateObsB = await observeGate(stateB.instanceId);

  check("Cell 1: Both instances have open issuance gates with respective server-derived principals",
    gateObsA?.state === "open" && gateObsA.principal === `${ownerA}.${remoteManagerActors(stateA.instanceId).serve}` &&
    gateObsB?.state === "open" && gateObsB.principal === `${ownerB}.${remoteManagerActors(stateB.instanceId).serve}`);

  const partStoreA = workspaceSecretStore(partRootA);
  const partDirA = userAuthStateDir(partRootA, space);
  const partStoreB = workspaceSecretStore(partRootB);
  const partDirB = userAuthStateDir(partRootB, space);

  const callers: { nc: NatsConnection; caller: EpCaller; service: Awaited<ReturnType<typeof resolveService>>; instanceId: string; goalId: string }[] = [];
  for (const [label, participantHome, store, dir, instanceId] of [
    ["A", homeA, partStoreA, partDirA, stateA.instanceId],
    ["B", homeB, partStoreB, partDirB, stateB.instanceId],
  ] as const) {
    process.env.COTAL_HOME = participantHome;
    let credentials;
    try {
      credentials = await cotalAuthProvider.userCredentials({ store, dir, space, actor: "operator", view: "manager-caller" });
    } catch (error) {
      check(`owner ${label} selects its own live remote manager`, false);
      throw error;
    }
    check(`owner ${label} selects its own live remote manager`, credentials.managerInstanceId === instanceId);
    const payload = JSON.parse(Buffer.from(credentials.bearer.split(".")[1]!, "base64url").toString("utf8"));
    const caller: EpCaller = { owner: payload.sub, actor: payload.act.actor, uid: payload.act.lifecycleUid };
    const nc = await connect({ servers: server, ...standaloneConnectOpts({ bearer: credentials.bearer, sentinelCreds: credentials.sentinelCreds, tls: false }), maxReconnectAttempts: 0 });
    if (label === "A") ncA = nc; else ncB = nc;
    const service = await resolveService(nc, space, "manager", caller, { instanceId, deadlineMs: 5000 });
    check(`owner ${label} resolves the actual remote manager`, service !== undefined);
    callers.push({ nc, caller, service, instanceId, goalId: mintLifecycleUid() });
  }

  for (const [index, entry] of callers.entries()) {
    // Real acceptance and terminal production, without a successful child launch.
    // Stock remote enrollment currently refuses missing host auth material. The declared
    // test connector also refuses launch, so this proof cannot create an untracked child.
    const accepted = await invokeCommand(entry.nc, space, entry.service, "spawn", { name: `worker_${index}`, role: "worker", agent: "remote-reader-test", events: false }, { id: entry.goalId, deadlineMs: 5000 });
    const acceptance = accepted.reply.ok ? accepted.reply.data as { goalId?: string; fingerprint?: string } : undefined;
    check(`owner ${index} receives a real accepted goal`, acceptance?.goalId === entry.goalId && typeof acceptance.fingerprint === "string");
    if (!acceptance?.fingerprint) throw new Error(`spawn did not reach actual goal acceptance: ${JSON.stringify(accepted.reply)}`);
    let fact: GoalResultFact | undefined;
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      const reply = await invokeCommand(entry.nc, space, entry.service, "goal-result", { goalId: entry.goalId }, { deadlineMs: 2000 });
      if (!reply.reply.ok) throw new Error("actual remote goal-result command refused");
      const data = reply.reply.data as { goalId: string; result?: GoalResultFact };
      if (data.goalId !== entry.goalId) throw new Error("goal-result outer identity mismatch");
      if (data.result) {
        fact = parseGoalResultFact(data.result, "remote goal-result", { endpoint: "manager", caller: entry.caller, goalId: entry.goalId });
        break;
      }
      await wait(25);
    }
    check(`owner ${index} reads a canonical failed terminal over actual goal-result`, fact?.state === "failed");
    check(`owner ${index} terminal fingerprint binds to its acceptance`, fact?.fingerprint === acceptance.fingerprint);
    check(`owner ${index} terminal identifies its remote manager`, fact?.committer?.instanceId === entry.instanceId);
  }

  if (callers.length !== 2) throw new Error("both real callers required");
  for (const [a, b] of [[callers[0]!, callers[1]!], [callers[1]!, callers[0]!]]) {
    const foreignResult = await invokeCommand(a.nc, space, a.service, "goal-result", { goalId: b.goalId }, { deadlineMs: 2000 });
    check("known foreign goal is absent from the querying caller's mediated view", foreignResult.reply.ok === true && (foreignResult.reply.data as { result?: unknown }).result === undefined);

    const foreignSubject = epRequestSubject(space, { route: { mode: "inst", instanceId: b.instanceId }, endpoint: "manager", command: "describe", caller: a.caller, nonce: randomBytes(24).toString("base64url") });
    let denied = false;
    try {
      await a.nc.request(foreignSubject, new TextEncoder().encode("{}"), { timeout: 2000 });
    } catch (error) {
      const cause = error instanceof PermissionViolationError ? error : (error as Error).cause;
      denied = cause instanceof PermissionViolationError && cause.operation === "publish" && cause.subject === foreignSubject;
      if (!denied) throw error;
    }
    check("native broker denies exact foreign-instance publication", denied);
  }
  await adminNc.close();

} catch (e) {
  fail++;
  console.log("  ✗ FAIL: Acceptance test threw uncaught error", e);
} finally {
  await adminNc?.close();
  await ncA?.drain().catch(() => ncA?.close());
  await ncB?.drain().catch(() => ncB?.close());

  const supAStopped = await stopProcess(supervisorA);
  const supBStopped = await stopProcess(supervisorB);
  const authStopped = await stopProcess(authService);
  const delStopped = await stopProcess(delivery);
  const brokerStopped = await stopProcess(broker);

  exchangeProxy?.closeAllConnections();
  await new Promise<void>((r) => exchangeProxy ? exchangeProxy.close(() => r()) : r());

  idpServer?.closeAllConnections();
  await new Promise<void>((r) => idpServer ? idpServer.close(() => r()) : r());

  const allExited = supAStopped && supBStopped && authStopped && delStopped && brokerStopped;
  check("Teardown stops every owned process before deleting scratch state", allExited);

  if (allExited) {
    if (storeDir) rmSync(storeDir, { recursive: true, force: true });
    rmSync(scratchRoot, { recursive: true, force: true });
  } else {
    console.error("teardown: some processes did not exit; preserving scratch directory for inspection");
  }
}

const EXPECTED_CHECKS = 30;
check("all acceptance checks passed", pass === EXPECTED_CHECKS - 1 && fail === 0, { pass, fail, expected: EXPECTED_CHECKS });
emitSentinel({ passed: pass, failed: fail, cells: pass + fail });
console.log(`\n${fail === 0 ? "PASS" : "FAIL"} — ${pass} passed, ${fail} failed`);
console.log("REMOTE-MANAGER-GOAL-READER COMPLETE");

if (fail > 0 || pass !== EXPECTED_CHECKS) {
  process.exit(1);
}
