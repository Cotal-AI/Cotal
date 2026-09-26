/*
 * Stock `cotal supervise` hosted-retirement boundary.
 *
 * Starts the real CLI supervisor from a registry-only participant root. The host authority is served
 * through an owned HTTPS proxy. A retained managed actor is resumed through the public manager service,
 * then despawned. Stock supervision intentionally has no hosted release composition, so teardown must
 * fail closed before it asks the host for a retirement requester or reaches the terminal rail.
 *
 * All state is disposable. Requires Linux, nats-server, and openssl.
 */

const subcommand = process.argv[2] ?? "";
if (subcommand === "" && process.env.COTAL_OWNER_NATIVE_ACCEPTANCE !== "1")
  throw new Error("stock hosted-retirement supervise acceptance is owner-only; set COTAL_OWNER_NATIVE_ACCEPTANCE=1 on the isolated native host");
if (subcommand === "" && !process.env.COTAL_STOCK_HTTPS_CA) {
  const { mkdtempSync, rmSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { spawnSync } = await import("node:child_process");
  const pki = mkdtempSync(join(tmpdir(), "cotal-stock-supervise-ca-"));
  const openssl = (args: string[]): void => {
    const result = spawnSync("openssl", args, { stdio: "pipe", encoding: "utf8" });
    if (result.status !== 0) throw new Error(`openssl fixture setup failed: ${result.stderr || result.stdout}`);
  };
  let status = 1;
  try {
    openssl(["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", join(pki, "ca.key"),
      "-out", join(pki, "ca.pem"), "-days", "2", "-subj", "/CN=cotal-stock-supervise-ca",
      "-addext", "basicConstraints=critical,CA:TRUE"]);
    openssl(["req", "-newkey", "rsa:2048", "-nodes", "-keyout", join(pki, "leaf.key"),
      "-out", join(pki, "leaf.csr"), "-subj", "/CN=localhost"]);
    writeFileSync(join(pki, "leaf.ext"), "subjectAltName=DNS:localhost,IP:127.0.0.1\nbasicConstraints=CA:FALSE\n");
    openssl(["x509", "-req", "-in", join(pki, "leaf.csr"), "-CA", join(pki, "ca.pem"),
      "-CAkey", join(pki, "ca.key"), "-CAcreateserial", "-out", join(pki, "leaf.pem"),
      "-days", "2", "-extfile", join(pki, "leaf.ext")]);
    const env: NodeJS.ProcessEnv = {};
    for (const [key, value] of Object.entries(process.env)) if (!key.startsWith("COTAL_")) env[key] = value;
    Object.assign(env, {
      COTAL_OWNER_NATIVE_ACCEPTANCE: "1",
      COTAL_STOCK_HTTPS_CA: join(pki, "ca.pem"),
      COTAL_STOCK_HTTPS_CERT: join(pki, "leaf.pem"),
      COTAL_STOCK_HTTPS_KEY: join(pki, "leaf.key"),
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
if (subcommand === "agent-child") {
  try {
    const { CotalEndpoint } = await import("@cotal-ai/core");
    const { readFileSync } = await import("node:fs");
    const { execFile } = await import("node:child_process");
    const bearerCommand = JSON.parse(process.env.COTAL_BEARER_CMD!) as string[];
    const bearer = () => new Promise<string>((resolve, reject) => execFile(bearerCommand[0]!, bearerCommand.slice(1), (error, stdout, stderr) => {
      if (error) reject(new Error(stderr.trim() || error.message));
      else resolve(stdout.trim());
    }));
    const endpoint = new CotalEndpoint({
      space: process.env.COTAL_SPACE!, servers: process.env.COTAL_SERVERS!, bearer,
      sentinelCreds: readFileSync(process.env.COTAL_SENTINEL_CREDS!, "utf8"),
      lifecycleUid: process.env.COTAL_LIFECYCLE_UID!, channels: [], consume: false,
      card: { owner: process.env.COTAL_OWNER!, actor: process.env.COTAL_ACTOR!, name: process.env.COTAL_NAME!, kind: "agent" },
    });
    endpoint.on("error", () => {});
    await endpoint.start();
    await new Promise(() => {});
  } catch (error) {
    // The manager deliberately reports only the final bounded PTY line. An uncaught Node stack ends
    // with `Node.js v…`, hiding the real child-launch cause. Emit one redacted final diagnostic so an
    // owner-native failure is actionable without publishing argv, credentials, or raw scrollback.
    const detail = (error instanceof Error ? error.message : String(error))
      .replace(/-----BEGIN [^-]+-----[\s\S]*?-----END [^-]+-----/g, "[redacted credential block]")
      .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[redacted jwt]")
      .replace(/[\r\n]+/g, " ")
      .slice(0, 500);
    console.error(`stock-agent-child failed: ${detail}`);
    process.exit(1);
  }
}
if (subcommand === "delivery") {
  const { runDelivery } = await import("@cotal-ai/delivery");
  const { workspaceSecretStore } = await import("@cotal-ai/workspace");
  await runDelivery({
    values: { space: process.env.COTAL_SPACE!, server: process.env.COTAL_SERVERS! }, positionals: [], raw: [],
  }, workspaceSecretStore(process.env.COTAL_STOCK_HOST_ROOT!));
  process.exit(0);
}
if (subcommand === "auth-service" || subcommand === "agent-bearer") {
  await import("@cotal-ai/auth");
  const { registry } = await import("@cotal-ai/core");
  type Command = import("@cotal-ai/core").Command;
  const rest = process.argv.slice(3);
  const values: Record<string, string | boolean | undefined> = {};
  const positionals: string[] = [];
  for (let index = 0; index < rest.length; index++) {
    const value = rest[index]!;
    if (!value.startsWith("--")) { positionals.push(value); continue; }
    const key = value.slice(2);
    const next = rest[index + 1];
    if (next !== undefined && !next.startsWith("--")) { values[key] = next; index++; }
    else values[key] = true;
  }
  const command = registry.all<Command>("command").find((candidate) => candidate.name === subcommand);
  if (!command) throw new Error(`${subcommand} command was not registered`);
  await command.run({ values, positionals, raw: rest });
  process.exit(0);
}

import { createHash } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { request as httpRequest } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { connect } from "@nats-io/transport-node";
import { Kvm } from "@nats-io/kv";
const betterAuthRoot = new URL("../../auth/node_modules/better-auth/", import.meta.url);
const { betterAuth } = await import(new URL("dist/index.mjs", betterAuthRoot).href);
const { memoryAdapter } = await import(new URL("dist/adapters/memory-adapter/index.mjs", betterAuthRoot).href);
const { jwt } = await import(new URL("dist/plugins/jwt/index.mjs", betterAuthRoot).href);
const { deviceAuthorization } = await import(new URL("dist/plugins/device-authorization/index.mjs", betterAuthRoot).href);
const { bearer: betterAuthBearer } = await import(new URL("dist/plugins/bearer/index.mjs", betterAuthRoot).href);
const { toNodeHandler } = await import(new URL("dist/integrations/node.mjs", betterAuthRoot).href);
import {
  CotalEndpoint,
  BROKER_FLOOR,
  createSpaceAuth,
  contractRefToHex,
  contractStoreContext,
  endpointRegistrationBarrier,
  epAuthBucket,
  epgateKey,
  fetchContractArtifact,
  meetsBrokerFloor,
  mintConnectionEvictorCreds,
  mintCreds,
  mintLifecycleUid,
  mintMembershipObserverCreds,
  newIdentity,
  recordSpecKey,
  RECORD_KINDS,
  recordsBucket,
  registerServiceInstance,
  remoteManagerActors,
  eprepairKey,
  provisionAgentDurables,
  serverConfig,
  setupSpaceStreams,
  standaloneConnectOpts,
  waitForDeliveryLease,
} from "@cotal-ai/core";
import type { ManagerResumeInventory } from "@cotal-ai/manager";
import {
  agentLifecycleSecretFilePaths,
  agentSecretKeyForFile,
  assertUserAuthInfo,
  authDir,
  connectionEvictorCredsKey,
  deliveryCredsKey,
  hasUserAuthState,
  materializeSecretToFile,
  canonicalLocalProcessPath,
  MANAGER_DELIVERY_AWARE_MARKER,
  MANAGER_PIDFILE,
  membershipObserverCredsKey,
  membershipRwCredsKey,
  userAuthStateDir,
  workspaceSecretStore,
} from "@cotal-ai/workspace";
import {
  cotalAuthProvider,
  establishIdpSession,
  findManagedActor,
  grantActor,
  revokeActor,
  loadAuthServiceInfo,
  loadCalloutAuth,
} from "@cotal-ai/auth";
import { makeDeliveryAdminPrincipalOracle } from "../../auth/src/plane-claim.js";
import { persistRemoteUserEntry } from "../../cli/src/commands/meshes-add.js";
import { pickFreePort } from "../../auth/smoke/_free-port.js";
import { SMOKE_BROKER_TOKEN, teardownOnSignal } from "@cotal-ai/smoke-kit";
import { loadOrCreateRemoteManagerIdentity, remoteManagerMaintenanceRequest } from "../src/remote-authority.js";
import { MANAGER_ENDPOINT, managerClusterArtifacts } from "../src/manager-service-contract.js";

if (process.platform !== "linux") throw new Error("stock hosted-retirement supervise acceptance requires Linux");

const repo = resolve(import.meta.dirname, "..", "..", "..");
const cli = join(repo, "bin", "cotal.ts");
const self = process.argv[1]!;
const home = mkdtempSync(join(tmpdir(), "cotal-stock-supervise-home-"));
const hostRoot = mkdtempSync(join(tmpdir(), `${SMOKE_BROKER_TOKEN}stock-supervise-host-`));
const participantRoot = realpathSync(mkdtempSync(join(tmpdir(), "cotal-stock-supervise-participant-")));
const previousHome = process.env.COTAL_HOME;
process.env.COTAL_HOME = home;

let pass = 0;
let fail = 0;
const check = (name: string, condition: boolean, extra?: unknown): void => {
  if (condition) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ FAIL: ${name}`, extra ?? ""); }
};
const wait = (ms: number) => new Promise((resolveWait) => setTimeout(resolveWait, ms));
const childEnv = (values: NodeJS.ProcessEnv): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) if (!key.startsWith("COTAL_")) env[key] = value;
  return { ...env, ...values };
};
const cap = 32 * 1024;
const redact = (value: string) => value
  .replace(/-----BEGIN [^-]+-----[\s\S]*?-----END [^-]+-----/g, "[redacted credential block]")
  .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[redacted jwt]");
const append = (current: string, chunk: Buffer | string): string => redact(`${current}${chunk.toString()}`).slice(-cap);
const closed = new WeakSet<ChildProcess>();
const exited = new WeakSet<ChildProcess>();
type OwnedProcess = { label: string; pid: number; startTime: string; cgroupSha256: string };
const owned = new Map<ChildProcess, OwnedProcess>();
const identityFile = join(home, "owned-processes.json");
const processIdentity = (pid: number): Omit<OwnedProcess, "label"> | undefined => {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const close = stat.lastIndexOf(")");
    if (close < 0) return undefined;
    const fields = stat.slice(close + 2).trim().split(/\s+/);
    const startTime = fields[19];
    if (!startTime) return undefined;
    const cgroup = readFileSync(`/proc/${pid}/cgroup`, "utf8");
    return { pid, startTime, cgroupSha256: createHash("sha256").update(cgroup).digest("hex") };
  } catch { return undefined; }
};
const persistOwned = (): void => {
  writeFileSync(identityFile, `${JSON.stringify([...owned.values()], null, 2)}\n`, { mode: 0o600 });
};
const track = (label: string, child: ChildProcess): ChildProcess => {
  if (child.pid === undefined) throw new Error(`owned ${label} process has no pid`);
  const identity = processIdentity(child.pid);
  if (!identity) throw new Error(`owned ${label} process identity could not be read`);
  owned.set(child, { label, ...identity });
  persistOwned();
  child.once("exit", () => exited.add(child));
  child.once("close", () => closed.add(child));
  return child;
};
const awaitClose = (child: ChildProcess, timeoutMs: number): Promise<boolean> => {
  if (closed.has(child)) return Promise.resolve(true);
  return new Promise((resolveClose) => {
    const done = () => { clearTimeout(timer); resolveClose(true); };
    const timer = setTimeout(() => { child.off("close", done); resolveClose(false); }, timeoutMs);
    child.once("close", done);
  });
};
const stop = async (child: ChildProcess | undefined): Promise<boolean> => {
  if (!child || closed.has(child)) return true;
  const expected = owned.get(child);
  if (!expected) return false;
  const current = processIdentity(expected.pid);
  if (!current) return awaitClose(child, 1_000);
  if (current.startTime !== expected.startTime || current.cgroupSha256 !== expected.cgroupSha256) return false;
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
  if (await awaitClose(child, 5_000)) return true;
  const beforeKill = processIdentity(expected.pid);
  if (!beforeKill) return awaitClose(child, 1_000);
  if (beforeKill.startTime !== expected.startTime || beforeKill.cgroupSha256 !== expected.cgroupSha256) return false;
  child.kill("SIGKILL");
  return awaitClose(child, 5_000);
};
const killUnclean = async (child: ChildProcess): Promise<boolean> => {
  const expected = owned.get(child);
  if (!expected) return false;
  const current = processIdentity(expected.pid);
  if (!current) return awaitClose(child, 1_000);
  if (current.startTime !== expected.startTime || current.cgroupSha256 !== expected.cgroupSha256) return false;
  child.kill("SIGKILL");
  if (exited.has(child) || child.exitCode !== null || child.signalCode !== null) return true;
  return new Promise((resolveExit) => {
    const done = () => { clearTimeout(timer); resolveExit(true); };
    const timer = setTimeout(() => { child.off("exit", done); resolveExit(false); }, 5_000);
    child.once("exit", done);
  });
};

const space = `stock-retirement-${Math.random().toString(36).slice(2, 10)}`;
const brokerPort = await pickFreePort();
const server = `nats://127.0.0.1:${brokerPort}`;
const clientId = "stock-retirement-supervise";
const hostDir = userAuthStateDir(hostRoot, space);
const participantDir = userAuthStateDir(participantRoot, space);
const hostStore = workspaceSecretStore(hostRoot);
const participantStore = workspaceSecretStore(participantRoot);
let broker: ChildProcess | undefined;
let delivery: ChildProcess | undefined;
let authService: ChildProcess | undefined;
let supervisor: ChildProcess | undefined;
let idpServer: ReturnType<typeof createServer> | undefined;
let exchangeProxy: ReturnType<typeof createHttpsServer> | undefined;
let endpoint: CotalEndpoint | undefined;
let storeDir: string | undefined;
let secondHome: string | undefined;
let secondRoot: string | undefined;
let supervisorOutput = "";
let authOutput = "";
let deliveryOutput = "";
let prepareRequests = 0;
let activateRequests = 0;
let renewRequests = 0;
let validationRequests = 0;
let adminAuthorizationRequests = 0;
let retirementRequests = 0;
let prepareRetirementRequests = 0;
let maintenanceRequests = 0;

try {
  mkdirSync(join(hostRoot, ".cotal"), { recursive: true });
  mkdirSync(join(participantRoot, ".cotal"), { recursive: true });
  const auth = await createSpaceAuth(space);
  const { saveSpaceAuth } = await import("@cotal-ai/workspace");
  saveSpaceAuth(authDir(hostRoot), auth);

  let handler: ReturnType<typeof toNodeHandler> | undefined;
  idpServer = createServer((request, response) => handler!(request, response));
  await new Promise<void>((resolveListen) => idpServer!.listen(0, "127.0.0.1", resolveListen));
  const idpAddress = idpServer.address();
  if (!idpAddress || typeof idpAddress === "string") throw new Error("IdP did not bind");
  const origin = `http://127.0.0.1:${idpAddress.port}`;
  const idpUrl = `${origin}/api/auth`;
  const idp = betterAuth({
    baseURL: origin,
    secret: "stock-retirement-supervise-secret-0123456789",
    database: memoryAdapter({ user: [], session: [], account: [], verification: [], jwks: [], deviceCode: [] }),
    emailAndPassword: { enabled: true },
    plugins: [
      jwt({ jwt: { issuer: origin, audience: origin } }),
      deviceAuthorization({ expiresIn: "2m", interval: "1s", validateClient: (id: string) => id === clientId }),
      betterAuthBearer(),
    ],
  });
  handler = toNodeHandler(idp);
  const prepared = await cotalAuthProvider.prepareServer({
    space, operatorSeed: auth.operator.seed,
    account: { pub: auth.account.pub, signingSeed: auth.account.signingSeed },
    store: hostStore, dir: hostDir, idpUrl,
  });

  storeDir = mkdtempSync(join(tmpdir(), "cotal-stock-supervise-js-"));
  writeFileSync(join(hostRoot, "server.conf"), serverConfig(auth, [auth], {
    transport: { kind: "plaintext" }, port: brokerPort, storeDir, extraAccounts: prepared.extraAccounts,
  }));
  broker = track("broker", spawn("nats-server", ["-c", join(hostRoot, "server.conf")], { stdio: "ignore" }));
  teardownOnSignal(broker);
  let brokerReady = false;
  let connectedBrokerVersion = "";
  for (let tries = 0; tries < 60 && broker.exitCode === null; tries++) {
    try {
      const nc = await connect({
        servers: server,
        ...standaloneConnectOpts({ creds: await mintCreds(auth, newIdentity(), "provisioner"), tls: false }),
        maxReconnectAttempts: 0, timeout: 300,
      });
      connectedBrokerVersion = nc.info?.version ?? "";
      await nc.close();
      brokerReady = true;
      break;
    } catch { await wait(100); }
  }
  if (!brokerReady) throw new Error("owned broker did not become ready");
  check(
    "connected broker INFO names a version at or above the product floor",
    connectedBrokerVersion !== "" && meetsBrokerFloor(connectedBrokerVersion),
    {
      version: connectedBrokerVersion,
      requiredMajor: BROKER_FLOOR.major,
      requiredMinor: BROKER_FLOOR.minor,
    },
  );
  await setupSpaceStreams({ servers: server, space, creds: await mintCreds(auth, newIdentity(), "provisioner") });

  const hosted = { injected: true } as const;
  await hostStore.put(deliveryCredsKey(space, hosted), await mintCreds(auth, newIdentity(), "delivery"));
  await hostStore.put(membershipRwCredsKey(space, hosted), await mintCreds(auth, newIdentity(), "membership-rw"));
  await hostStore.put(membershipObserverCredsKey(space, hosted), await mintMembershipObserverCreds(auth, newIdentity()));
  await hostStore.put(connectionEvictorCredsKey(space, hosted), await mintConnectionEvictorCreds(auth, newIdentity()));
  delivery = track("delivery", spawn(process.execPath, [...process.execArgv, self, "delivery"], {
    cwd: hostRoot,
    env: childEnv({ COTAL_STOCK_HOST_ROOT: hostRoot, COTAL_SPACE: space, COTAL_SERVERS: server }),
    stdio: ["ignore", "pipe", "pipe"],
  }));
  delivery.stdout?.on("data", (chunk) => { deliveryOutput = append(deliveryOutput, chunk); });
  delivery.stderr?.on("data", (chunk) => { deliveryOutput = append(deliveryOutput, chunk); });
  const deliveryProbe = newIdentity();
  if (!await waitForDeliveryLease({
    servers: server, space, creds: await mintCreds(auth, deliveryProbe, "delivery"),
    id: deliveryProbe.id, holder: undefined, timeoutMs: 30_000,
  })) throw new Error(`delivery did not become ready: ${deliveryOutput}`);

  authService = track("auth-service", spawn(process.execPath, [...process.execArgv, self, "auth-service", "--space", space, "--server", server, "--exchange-public-port", "0"], {
    cwd: hostRoot, env: childEnv({ COTAL_HOME: home }), stdio: ["ignore", "pipe", "pipe"],
  }));
  authService.stdout?.on("data", (chunk) => { authOutput = append(authOutput, chunk); });
  authService.stderr?.on("data", (chunk) => { authOutput = append(authOutput, chunk); });
  let service: ReturnType<typeof loadAuthServiceInfo>;
  for (let tries = 0; tries < 600; tries++) {
    service = loadAuthServiceInfo(hostDir);
    if (service) {
      try { if ((await fetch(`${service.url}/health`, { signal: AbortSignal.timeout(500) })).ok) break; } catch { /* booting */ }
    }
    if (authService.exitCode !== null || authService.signalCode !== null) throw new Error(`auth service exited: ${authOutput}`);
    await wait(100);
  }
  if (!service?.publicUrl) throw new Error(`auth service did not expose public URL: ${authOutput}`);

  exchangeProxy = createHttpsServer({
    cert: readFileSync(process.env.COTAL_STOCK_HTTPS_CERT!),
    key: readFileSync(process.env.COTAL_STOCK_HTTPS_KEY!),
  }, (req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      let rejectScheduledRenewal = false;
      if (req.url?.endsWith("/manager-service-authority")) {
        try {
          const parsed = JSON.parse(body.toString("utf8")) as { request?: { kind?: string; operation?: string } };
          if (parsed.request?.kind === "manager-retained-agent-validation") validationRequests++;
          else if (parsed.request?.kind === "manager-managed-agent-prepare-retirement") prepareRetirementRequests++;
          else if (parsed.request?.kind === "manager-admin-authorization") adminAuthorizationRequests++;
          else if (parsed.request?.kind === "manager-service-maintenance") maintenanceRequests++;
          else if (parsed.request?.operation === "prepare") prepareRequests++;
          else if (parsed.request?.operation === "activate") activateRequests++;
          else if (parsed.request?.operation === "renew") {
            renewRequests++;
            rejectScheduledRenewal = renewRequests <= 2;
          }
          else if (parsed.request?.operation === "retire") retirementRequests++;
        } catch { /* the upstream owns malformed-request reporting */ }
      }
      if (rejectScheduledRenewal) {
        res.writeHead(503, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "fixture refuses scheduled executor renewal so clean stop must refresh it" }));
        return;
      }
      const upstreamUrl = new URL(service!.publicUrl!);
      const upstreamPath = req.url?.startsWith("/register/") ? "/register" : req.url;
      const upstream = httpRequest({
        host: upstreamUrl.hostname, port: Number(upstreamUrl.port), path: upstreamPath,
        method: req.method, headers: { ...req.headers, host: upstreamUrl.host },
      }, (response) => { res.writeHead(response.statusCode ?? 502, response.headers); response.pipe(res); });
      upstream.on("error", (error) => { res.statusCode = 502; res.end(error.message); });
      upstream.end(body);
    });
  });
  await new Promise<void>((resolveListen) => exchangeProxy!.listen(0, "127.0.0.1", resolveListen));
  const proxyAddress = exchangeProxy.address();
  if (!proxyAddress || typeof proxyAddress === "string") throw new Error("HTTPS proxy did not bind");
  const secureExchangeUrl = `https://127.0.0.1:${proxyAddress.port}`;

  const signup = await idp.api.signUpEmail({
    body: { email: "participant@example.test", password: "correct-horse-battery", name: "Participant" },
    returnHeaders: true,
  });
  const cookie = signup.headers.get("set-cookie")!.split(";")[0]!;
  const approve = async (userCode: string): Promise<void> => {
    await fetch(`${idpUrl}/device?user_code=${encodeURIComponent(userCode)}`, { headers: { cookie, origin } });
    const response = await fetch(`${idpUrl}/device/approve`, {
      method: "POST", headers: { "content-type": "application/json", cookie, origin }, body: JSON.stringify({ userCode }),
    });
    if (!response.ok) throw new Error(`device approval failed: HTTP ${response.status}`);
  };
  await establishIdpSession({ dir: home, idpUrl, clientId, onPrompt: (prompt: { userCode: string }) => void approve(prompt.userCode) });
  const owner = await cotalAuthProvider.ownerForLogin({ store: hostStore, dir: hostDir, space });
  grantActor(hostDir, { owner, actor: "cli", scope: ["spawn", "supervise", "admin"], allowSubscribe: [], allowPublish: [] });
  grantActor(hostDir, { owner, actor: "admin_requester", scope: ["admin"], allowSubscribe: [], allowPublish: [] });
  const callout = await loadCalloutAuth(hostStore, space);
  if (!callout) throw new Error("host callout material is missing");
  persistRemoteUserEntry(space, server, participantRoot, {
    space, server, tlsRequired: false,
    userAuth: assertUserAuthInfo({
      provider: "cotal", idp: { url: idpUrl, issuer: origin, audience: origin }, endpoints: { url: secureExchangeUrl },
    }),
    sentinelCreds: callout.sentinelCreds,
  }, false, false);
  const { findMesh, recordMesh } = await import("@cotal-ai/workspace");
  const participantEntry = findMesh(space);
  if (!participantEntry) throw new Error("participant registry entry vanished after persistence");
  recordMesh({ ...participantEntry, policyCheckedAt: new Date(Date.now() + 60 * 60 * 1000).toISOString() });
  check("participant registry is remote user mode with no hosting marker",
    existsSync(participantDir) && hasUserAuthState(participantRoot, space) === false);

  const actor = "stock_retained";
  const lifecycleUid = mintLifecycleUid();
  const grant = await cotalAuthProvider.grantAgent({
    store: hostStore, dir: hostDir, space, owner, actor, scope: [], allowSubscribe: [], allowPublish: [],
    parent: `${owner}.cli`, lifecycleUid,
  });
  const provisioner = new CotalEndpoint({
    space, servers: server, creds: await mintCreds(auth, newIdentity(), "provisioner"), channels: [],
    consume: false, registerPresence: false, watchPresence: false, watchChannels: false,
    card: { name: "stock-provisioner", kind: "endpoint" },
  });
  await provisioner.start();
  try { await provisionAgentDurables(provisioner, { owner, actor, lifecycleUid }, { subscribe: [], allowSubscribe: [] }); }
  finally { await provisioner.stop(); }
  const files = agentLifecycleSecretFilePaths(participantRoot, space, actor, lifecycleUid);
  await participantStore.put(agentSecretKeyForFile(files.actorToken, space), grant.actorToken);
  await participantStore.put(agentSecretKeyForFile(files.sentinelCreds, space), grant.sentinelCreds);
  await materializeSecretToFile(participantStore, agentSecretKeyForFile(files.actorToken, space), files.actorToken);
  await materializeSecretToFile(participantStore, agentSecretKeyForFile(files.sentinelCreds, space), files.sentinelCreds);
  const personaDir = join(participantRoot, ".cotal", "agents");
  mkdirSync(personaDir, { recursive: true });
  const personaPath = join(personaDir, "stock-retained.md");
  writeFileSync(personaPath, "---\nname: stock-retained\nagent: stock-acceptance\n---\nstock retained child\n");
  const digest = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
  const inventory: ManagerResumeInventory = {
    version: "cotal-manager-resume/v1", space, createdAt: new Date().toISOString(),
    agents: [{
      space, name: actor,
      identity: {
        mode: "user", owner, actor, lifecycleUid,
        actorToken: { kind: "file", path: files.actorToken, sha256: digest(files.actorToken) },
        sentinelCredential: { kind: "file", path: files.sentinelCreds, sha256: digest(files.sentinelCreds) },
        health: { kind: "file", path: files.health },
      },
      launch: {
        connector: "stock-acceptance", runtime: "pty", cwd: participantRoot,
        source: { kind: "persona", ref: "stock-retained", configPath: personaPath, configSha256: digest(personaPath) },
        allowSubscribe: [], allowPublish: [], capabilities: [], events: false,
      },
      dependencies: [personaPath], spawner: `${owner}.cli`, authorityParent: `${owner}.cli`, startedAt: new Date().toISOString(),
    }],
  };

  const xdg = join(home, "xdg");
  const extensionRoot = join(xdg, "cotal", "extensions");
  const extensionDir = join(extensionRoot, "node_modules", "stock-acceptance-extension");
  mkdirSync(extensionDir, { recursive: true });
  writeFileSync(join(extensionDir, "package.json"), JSON.stringify({
    name: "stock-acceptance-extension", version: "1.0.0", type: "module", main: "index.js",
    peerDependencies: { "@cotal-ai/core": "*" },
  }, null, 2));
  writeFileSync(join(extensionDir, "index.js"), `
import { registry } from "@cotal-ai/core";
registry.register({
  kind: "connector", name: "stock-acceptance", readinessTimeoutMs: 20000,
  buildLaunch(opts) {
    if (!opts.userAuth || !opts.lifecycleUid) throw new Error("stock acceptance requires retained user authority");
    return {
      command: process.execPath,
      args: [...JSON.parse(process.env.COTAL_STOCK_EXECARGV), process.env.COTAL_STOCK_FIXTURE, "agent-child"],
      env: {
        COTAL_SPACE: opts.space, COTAL_SERVERS: opts.servers, COTAL_NAME: opts.name,
        COTAL_OWNER: opts.userAuth.owner, COTAL_ACTOR: opts.userAuth.actor,
        COTAL_SENTINEL_CREDS: opts.userAuth.sentinelCredsPath,
        COTAL_BEARER_CMD: JSON.stringify(opts.userAuth.bearerCmd), COTAL_LIFECYCLE_UID: opts.lifecycleUid,
        // The runtime intentionally passes only connector-declared environment. This fixture's
        // retained child execs agent-bearer against the owned private-PKI HTTPS proxy, so declare the
        // same public CA path the supervisor was launched with. No key or credential crosses here.
        NODE_EXTRA_CA_CERTS: process.env.NODE_EXTRA_CA_CERTS,
        // agent-bearer re-enters the development CLI. Keep that subprocess on the fixture-owned
        // connector store and preserve the supervisor's explicit no-seed policy. COTAL_HOME does not
        // relocate this store, and weakening the checkout guard would risk the operator's real store.
        XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
        COTAL_SKIP_CONNECTOR_SEED: process.env.COTAL_SKIP_CONNECTOR_SEED,
      },
    };
  },
});
`);
  mkdirSync(extensionRoot, { recursive: true });
  writeFileSync(join(extensionRoot, "extensions.json"), JSON.stringify({ extensions: [{
    pkg: "stock-acceptance-extension", version: "1.0.0", spec: "file:stock-acceptance-extension",
    provides: [{ kind: "connector", name: "stock-acceptance" }], commands: [],
    connectors: [{ name: "stock-acceptance", requires: [] }],
  }] }, null, 2));

  const supervisorEnv: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) if (!key.startsWith("COTAL_")) supervisorEnv[key] = value;
  supervisorEnv.COTAL_HOME = home;
  supervisorEnv.COTAL_SKIP_CONNECTOR_SEED = "1";
  supervisorEnv.XDG_CONFIG_HOME = xdg;
  supervisorEnv.NODE_EXTRA_CA_CERTS = process.env.COTAL_STOCK_HTTPS_CA!;
  supervisorEnv.COTAL_STOCK_FIXTURE = self;
  supervisorEnv.COTAL_STOCK_EXECARGV = JSON.stringify(process.execArgv);
  supervisor = track("supervisor", spawn(process.execPath, [...process.execArgv, cli, "supervise", "--space", space, "--server", server, "--runtime", "pty", "--resume-attempt", "stock_restore"], {
    cwd: participantRoot, env: supervisorEnv, stdio: ["ignore", "pipe", "pipe"],
  }));
  supervisor.stdout?.on("data", (chunk) => { supervisorOutput = append(supervisorOutput, chunk); });
  supervisor.stderr?.on("data", (chunk) => { supervisorOutput = append(supervisorOutput, chunk); });
  for (let tries = 0; tries < 600 && !supervisorOutput.includes("manager up"); tries++) {
    if (supervisor.exitCode !== null || supervisor.signalCode !== null) break;
    await wait(100);
  }
  check("stock cotal supervise reaches manager ready through remote prepare and activate",
    supervisorOutput.includes("manager up") && supervisor.exitCode === null && prepareRequests === 1 && activateRequests === 1,
    { ready: supervisorOutput.includes("manager up"), exitCode: supervisor.exitCode, prepareRequests, activateRequests, output: supervisorOutput.slice(-1200) });
  if (!supervisorOutput.includes("manager up")) throw new Error("stock supervisor did not become ready");

  const operatorMaterial = await cotalAuthProvider.userCredentials({ store: participantStore, dir: participantDir, space, actor: "admin_requester" });
  const operatorPayload = JSON.parse(Buffer.from(operatorMaterial.bearer.split(".")[1]!, "base64url").toString("utf8")) as {
    sub: string; act: { actor: string; lifecycleUid: string };
  };
  endpoint = new CotalEndpoint({
    space, servers: server,
    bearer: () => cotalAuthProvider.userCredentials({ store: participantStore, dir: participantDir, space, actor: "admin_requester" }).then((value) => value.bearer),
    sentinelCreds: operatorMaterial.sentinelCreds, lifecycleUid: operatorPayload.act.lifecycleUid,
    channels: [], consume: false, watchChannels: false,
    card: { owner: operatorPayload.sub, actor: operatorPayload.act.actor, name: "stock-operator", kind: "endpoint" },
  });
  endpoint.on("error", () => {});
  await endpoint.start();

  const resumed = await endpoint.invokeService("manager", "resume-preserved", { attemptId: "stock_restore", inventory });
  check("stock manager resumes the exact retained actor after two registry-pinned HTTPS validations",
    resumed.reply.ok === true && validationRequests === 2 && adminAuthorizationRequests === 1,
    { ok: resumed.reply.ok, error: resumed.reply.error?.message, validationRequests, adminAuthorizationRequests });
  if (!resumed.reply.ok) throw new Error("stock retained resume failed");
  const committed = await endpoint.invokeService("manager", "commit-resume", { attemptId: "stock_restore" });
  const commitData = committed.reply.data as { durableCommitToken?: string } | undefined;
  check("stock resume commit fresh-validates retained authority through registry-pinned HTTPS",
    committed.reply.ok === true && validationRequests === 3 && adminAuthorizationRequests === 2 && typeof commitData?.durableCommitToken === "string",
    { ok: committed.reply.ok, error: committed.reply.error?.message, validationRequests, adminAuthorizationRequests, hasToken: typeof commitData?.durableCommitToken === "string" });
  if (!committed.reply.ok || !commitData?.durableCommitToken) throw new Error("stock retained commit failed");
  const finalized = await endpoint.invokeService("manager", "finalize-resume", {
    attemptId: "stock_restore", durableCommitToken: commitData.durableCommitToken,
  });
  check("stock resumed actor reaches active service state", finalized.reply.ok === true, finalized.reply.error?.message);
  check("all three admin lifecycle operations fresh-authorize through the host and never a participant ledger",
    adminAuthorizationRequests === 3 && hasUserAuthState(participantRoot, space) === false,
    { adminAuthorizationRequests, participantHostingMarker: hasUserAuthState(participantRoot, space) });

  const validationsBeforeDenials = validationRequests;
  grantActor(hostDir, { owner, actor: "admin_requester", lifecycleUid: operatorPayload.act.lifecycleUid, scope: [], allowSubscribe: [], allowPublish: [] });
  const narrowed = await endpoint.invokeService("manager", "commit-resume", { attemptId: "must_not_run" });
  check("narrowed host admin scope refuses before the manager operation runs",
    narrowed.reply.ok === false && narrowed.reply.error?.code === "permission-denied" && validationRequests === validationsBeforeDenials,
    { ok: narrowed.reply.ok, code: narrowed.reply.error?.code, validationRequests, adminAuthorizationRequests });

  grantActor(hostDir, { owner, actor: "admin_requester", scope: ["admin"], allowSubscribe: [], allowPublish: [] });
  const lifecycleDrift = await endpoint.invokeService("manager", "commit-resume", { attemptId: "must_not_run" });
  check("stale caller lifecycle refuses without a reason oracle or manager operation",
    lifecycleDrift.reply.ok === false && lifecycleDrift.reply.error?.code === "permission-denied" && validationRequests === validationsBeforeDenials,
    { ok: lifecycleDrift.reply.ok, code: lifecycleDrift.reply.error?.code, validationRequests, adminAuthorizationRequests });

  revokeActor(hostDir, owner, "admin_requester");
  const revoked = await endpoint.invokeService("manager", "commit-resume", { attemptId: "must_not_run" });
  check("revoked host row refuses before the manager operation runs",
    revoked.reply.ok === false && revoked.reply.error?.code === "permission-denied" && validationRequests === validationsBeforeDenials,
    { ok: revoked.reply.ok, code: revoked.reply.error?.code, validationRequests, adminAuthorizationRequests });
  grantActor(hostDir, { owner, actor: "admin_requester", lifecycleUid: operatorPayload.act.lifecycleUid, scope: ["admin"], allowSubscribe: [], allowPublish: [] });

  const beforeRetirementRequests = retirementRequests;
  const stopped = await endpoint.invokeService("manager", "despawn", { graceful: false }, {
    // admin_requester carries the admin capability, whose broker grant is the operator any-mode
    // despawn row. Owner mode belongs to the spawn capability and is intentionally absent here.
    target: { mode: "any", owner, actor, lifecycleUid }, deadlineMs: 10_000,
  });
  check("stock targeted despawn accepts the retained lifecycle", stopped.reply.ok === true, stopped.reply.error?.message);
  // #1972: stock supervision now HAS a prepare-retirement client, so the deprovision prerequisite
  // reaches host dispatch instead of throwing locally. Stock dispatch answers `unimplemented` (the
  // managed-agent lifecycle needs a hosted storage composition), and the manager must surface that
  // refusal and stop there: no retirement requester, alias still held, supervisor still serving.
  const hostRefusal = "signed in, but managed agent retirement preparation was refused: " +
    "managed agent enrollment and retirement preparation must be handled by host platform interception";
  for (let tries = 0; tries < 200 && !supervisorOutput.includes(hostRefusal); tries++) await wait(100);
  const aliasHold = findManagedActor(hostDir, owner, actor);
  check("stock hosted deprovision fails closed at the host's unimplemented release refusal",
    supervisorOutput.includes(hostRefusal) && prepareRetirementRequests >= 1 &&
      retirementRequests === beforeRetirementRequests && aliasHold?.lifecycleUid === lifecycleUid,
    {
      refusalObserved: supervisorOutput.includes(hostRefusal),
      prepareRetirementRequests,
      retirementRequestsBefore: beforeRetirementRequests,
      retirementRequestsAfter: retirementRequests,
      aliasHeld: aliasHold !== undefined,
      aliasLifecycleUid: aliasHold?.lifecycleUid,
      output: supervisorOutput.slice(-1200),
    });
  check("the retained findManagedActor(owner, alias) row keeps the exact alias held",
    aliasHold?.lifecycleUid === lifecycleUid,
    { aliasHeld: aliasHold !== undefined, aliasLifecycleUid: aliasHold?.lifecycleUid });
  check("stock refusal issues zero retirement requester and leaves the supervisor running",
    retirementRequests === 0 && supervisor.exitCode === null,
    { retirementRequests, supervisorExitCode: supervisor.exitCode });

  const firstState = loadOrCreateRemoteManagerIdentity(participantRoot, space);
  const firstSpecKey = recordSpecKey(RECORD_KINDS.svc, ["manager", firstState.instanceId]);
  const observeRegistration = async () => {
    const observerId = newIdentity();
    const observer = await connect({
      servers: server,
      ...standaloneConnectOpts({
        creds: await mintCreds(auth, observerId, "endpoint-serve-executor", {
          endpointServeExecutor: { endpoint: "manager", instanceId: firstState.instanceId },
        }),
        tls: false,
      }),
      maxReconnectAttempts: 0,
    });
    try {
      return await (await new Kvm(observer).open(recordsBucket(space))).get(firstSpecKey);
    } finally {
      await observer.drain().catch(() => observer.close());
    }
  };
  const observeGateRepair = async () => {
    const observerId = newIdentity();
    const observer = await connect({
      servers: server,
      ...standaloneConnectOpts({
        creds: await mintCreds(auth, observerId, "endpoint-serve-executor", {
          endpointServeExecutor: { endpoint: "manager", instanceId: firstState.instanceId },
        }),
        tls: false,
      }),
      maxReconnectAttempts: 0,
    });
    try {
      const authKv = await new Kvm(observer).open(epAuthBucket(space));
      return {
        gate: await authKv.get(epgateKey("manager", firstState.instanceId)),
        repair: await authKv.get(eprepairKey("manager", firstState.instanceId)),
      };
    } finally {
      await observer.drain().catch(() => observer.close());
    }
  };

  console.log("  waiting for the stock five-minute executor credential to expire");
  await wait(310_000);
  const beforeMaintenance = maintenanceRequests;
  const cleanStopped = await stop(supervisor);
  supervisor = undefined;
  const cleanRegistration = await observeRegistration();
  const cleanDeregistered = cleanRegistration === null || cleanRegistration.operation === "DEL";
  check("stock clean stop refreshes the executor and deregisters after its retained credential expires",
    cleanStopped && cleanDeregistered && renewRequests === 3 && supervisorOutput.includes("✓ deregistered manager instance"),
    {
      stopped: cleanStopped,
      registrationOperation: cleanRegistration?.operation ?? null,
      renewRequests,
      maintenanceRequestsBefore: beforeMaintenance,
      maintenanceRequestsAfter: maintenanceRequests,
      output: supervisorOutput.slice(-1200),
    });
  console.log("RM2_POSTFIX_STEP1", JSON.stringify({
    stopped: cleanStopped,
    serviceRegistrationOperation: cleanRegistration?.operation ?? null,
    maintenanceRequestsBefore: beforeMaintenance,
    maintenanceRequestsAfter: maintenanceRequests,
    renewRequests,
    deregistered: supervisorOutput.includes("✓ deregistered manager instance"),
  }));

  let restartOutput = "";
  supervisor = track("same-instance-restart", spawn(process.execPath, [...process.execArgv, cli, "supervise", "--space", space, "--server", server, "--runtime", "pty"], {
    cwd: participantRoot, env: supervisorEnv, stdio: ["ignore", "pipe", "pipe"],
  }));
  supervisor.stdout?.on("data", (chunk) => { restartOutput = append(restartOutput, chunk); });
  supervisor.stderr?.on("data", (chunk) => { restartOutput = append(restartOutput, chunk); });
  for (let tries = 0; tries < 600 && !restartOutput.includes("manager up"); tries++) {
    if (supervisor.exitCode !== null || supervisor.signalCode !== null) break;
    await wait(100);
  }
  const restartedState = loadOrCreateRemoteManagerIdentity(participantRoot, space);
  const restartedRegistration = await observeRegistration();
  const restartedGate = await observeGateRepair();
  const restartedGateRow = restartedGate.gate?.operation === "PUT"
    ? JSON.parse(new TextDecoder().decode(restartedGate.gate.value)) as { processEpoch?: number }
    : undefined;
  const sameInstanceReady = restartOutput.includes("manager up") && supervisor.exitCode === null &&
    restartedState.instanceId === firstState.instanceId && restartedRegistration?.operation === "PUT" &&
    restartedGateRow?.processEpoch === 1 &&
    (restartedGate.repair === null || restartedGate.repair.operation === "DEL");
  check("same remote manager instance restarts after clean expired-executor deregistration",
    sameInstanceReady,
    {
      ready: restartOutput.includes("manager up"),
      exitCode: supervisor.exitCode,
      sameInstance: restartedState.instanceId === firstState.instanceId,
      registrationOperation: restartedRegistration?.operation ?? null,
      processEpoch: restartedGateRow?.processEpoch ?? null,
      repairCursorOperation: restartedGate.repair?.operation ?? null,
      output: restartOutput.slice(-1200),
    });
  console.log("RM2_POSTFIX_STEP2", JSON.stringify({
    ready: restartOutput.includes("manager up"),
    exitCode: supervisor.exitCode,
    firstInstanceId: firstState.instanceId,
    restartedInstanceId: restartedState.instanceId,
    serviceRegistrationOperation: restartedRegistration?.operation ?? null,
    processEpoch: restartedGateRow?.processEpoch ?? null,
    repairCursorOperation: restartedGate.repair?.operation ?? null,
  }));
  if (!sameInstanceReady) throw new Error("same-instance remote manager restart failed");

  secondHome = mkdtempSync(join(tmpdir(), "cotal-stock-supervise-second-home-"));
  secondRoot = realpathSync(mkdtempSync(join(tmpdir(), "cotal-stock-supervise-second-root-")));
  mkdirSync(join(secondRoot, ".cotal"), { recursive: true });
  const secondSignup = await idp.api.signUpEmail({
    body: { email: "second@example.test", password: "correct-horse-battery-2", name: "Second" },
    returnHeaders: true,
  });
  const secondCookie = secondSignup.headers.get("set-cookie")?.split(";")[0];
  if (!secondCookie) throw new Error("second fixture login returned no session cookie");
  await establishIdpSession({
    dir: secondHome,
    idpUrl,
    clientId,
    onPrompt: async (prompt) => {
      await fetch(`${idpUrl}/device?user_code=${encodeURIComponent(prompt.userCode)}`, {
        headers: { cookie: secondCookie, origin },
      });
      const response = await fetch(`${idpUrl}/device/approve`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie: secondCookie, origin },
        body: JSON.stringify({ userCode: prompt.userCode }),
      });
      if (!response.ok) throw new Error(`second device approval failed: HTTP ${response.status}`);
    },
  });
  const savedHome = process.env.COTAL_HOME;
  process.env.COTAL_HOME = secondHome;
  const secondOwner = await cotalAuthProvider.ownerForLogin({ store: hostStore, dir: hostDir, space });
  grantActor(hostDir, { owner: secondOwner, actor: "cli", scope: ["supervise"], allowSubscribe: [], allowPublish: [] });
  persistRemoteUserEntry(space, server, secondRoot, {
    space,
    server,
    tlsRequired: false,
    userAuth: assertUserAuthInfo({
      provider: "cotal",
      idp: { url: idpUrl, issuer: origin, audience: origin },
      endpoints: { url: secureExchangeUrl },
    }),
    sentinelCreds: callout.sentinelCreds,
  }, false, false);
  const foreignEntry = findMesh(space);
  if (!foreignEntry) throw new Error("foreign participant registry entry vanished after persistence");
  recordMesh({ ...foreignEntry, policyCheckedAt: new Date(Date.now() + 60 * 60 * 1000).toISOString() });
  process.env.COTAL_HOME = savedHome;

  const secondXdg = join(secondHome, "xdg");
  mkdirSync(secondXdg, { recursive: true });
  const foreignEnv = { ...supervisorEnv, COTAL_HOME: secondHome, XDG_CONFIG_HOME: secondXdg };

  const freezeId = newIdentity();
  const freezeNc = await connect({
    servers: server,
    ...standaloneConnectOpts({
      creds: await mintCreds(auth, freezeId, "endpoint-serve-executor", {
        endpointServeExecutor: { endpoint: "manager", instanceId: firstState.instanceId },
      }),
      tls: false,
    }),
    maxReconnectAttempts: 0,
  });
  try {
    const freezeKv = await new Kvm(freezeNc).open(epAuthBucket(space));
    const freezeRecords = await new Kvm(freezeNc).open(recordsBucket(space));
    const barrier = endpointRegistrationBarrier(freezeKv, space, {
      endpoint: "manager", instanceId: firstState.instanceId, opId: firstState.instanceId,
    });
    const artifacts = managerClusterArtifacts();
    const store = await contractStoreContext(freezeNc, space);
    let freezeRefusal = "";
    try {
      await registerServiceInstance(freezeRecords, {
        space,
        spec: { endpoint: MANAGER_ENDPOINT, owner, clusterDigests: [artifacts.closureDigest], protocol: { v: 1 } },
        instanceId: firstState.instanceId,
        registrant: { owner },
        authority: { authorize: (endpoint, candidateOwner) => ({ authorized: endpoint === MANAGER_ENDPOINT && candidateOwner === owner, revision: 0 }) },
        barrier,
        readClusterArtifact: async (digest) => {
          const bytes = await fetchContractArtifact(store, contractRefToHex(digest));
          return bytes ? JSON.parse(new TextDecoder().decode(bytes)) : undefined;
        },
      });
    } catch (error) {
      freezeRefusal = (error as Error).message;
    }
    const frozen = await barrier.observe();
    if (!freezeRefusal.includes("re-registration could not revoke + verify-evict") || frozen?.state !== "frozen")
      throw new Error(`fixture could not leave the live manager registration frozen at Phase 2: ${freezeRefusal || "registration unexpectedly completed"}`);
  } finally {
    await freezeNc.drain().catch(() => freezeNc.close());
  }

  const foreignState = loadOrCreateRemoteManagerIdentity(secondRoot, space);
  const liveRequest = remoteManagerMaintenanceRequest(foreignState, "cli", "reconcile-registration", firstState.instanceId);
  let liveRefusal = "";
  process.env.COTAL_HOME = secondHome;
  try {
    await cotalAuthProvider.maintainRemoteManager!({
      store: workspaceSecretStore(secondRoot),
      dir: userAuthStateDir(secondRoot, space),
      request: liveRequest,
    });
  } catch (error) {
    liveRefusal = (error as Error).message;
  } finally {
    process.env.COTAL_HOME = savedHome;
  }
  check("a foreign manager gets in only after the holder is proven gone",
    /ALIVE|holder-alive|still running/.test(liveRefusal) && supervisor.exitCode === null,
    { refusal: liveRefusal, holderExitCode: supervisor.exitCode });

  const uncleanStopped = await killUnclean(supervisor);
  supervisor = undefined;
  const processContext = { root: participantRoot, space };
  rmSync(canonicalLocalProcessPath(MANAGER_PIDFILE, processContext), { force: true });
  rmSync(canonicalLocalProcessPath(MANAGER_DELIVERY_AWARE_MARKER, processContext), { force: true });
  const abandonedRegistration = await observeRegistration();
  const abandonedPrincipal = `${owner}.${remoteManagerActors(firstState.instanceId).serve}`;
  const principalOracle = makeDeliveryAdminPrincipalOracle({ space, server, dataAccount: auth.account, log: () => {} });
  let abandonedLiveness = await principalOracle(abandonedPrincipal);
  for (let tries = 0; tries < 50 && (abandonedLiveness.state !== "gone" || abandonedLiveness.sweepComplete !== true); tries++) {
    await wait(200);
    abandonedLiveness = await principalOracle(abandonedPrincipal);
  }
  check("unclean same-instance stop leaves the registration for guarded foreign recovery",
    uncleanStopped && abandonedRegistration?.operation === "PUT" && abandonedLiveness.state === "gone" && abandonedLiveness.sweepComplete === true,
    { uncleanStopped, registrationOperation: abandonedRegistration?.operation ?? null, liveness: abandonedLiveness });

  let foreignOutput = "";
  const beforeForeignMaintenance = maintenanceRequests;
  supervisor = track("foreign-instance", spawn(process.execPath, [...process.execArgv, cli, "supervise", "--space", space, "--server", server, "--runtime", "pty"], {
    cwd: secondRoot, env: foreignEnv, stdio: ["ignore", "pipe", "pipe"],
  }));
  supervisor.stdout?.on("data", (chunk) => { foreignOutput = append(foreignOutput, chunk); });
  supervisor.stderr?.on("data", (chunk) => { foreignOutput = append(foreignOutput, chunk); });
  for (let tries = 0; tries < 900 && !foreignOutput.includes("manager up"); tries++) {
    if (supervisor.exitCode !== null || supervisor.signalCode !== null) break;
    await wait(100);
  }
  const foreignRecovered = foreignOutput.includes("manager up") && supervisor.exitCode === null &&
    secondOwner !== owner && foreignState.instanceId !== firstState.instanceId && maintenanceRequests > beforeForeignMaintenance;
  check("a different remote owner recovers an abandoned manager registration through guarded reconciliation",
    foreignRecovered,
    {
      ready: foreignOutput.includes("manager up"),
      exitCode: supervisor.exitCode,
      differentOwner: secondOwner !== owner,
      differentInstance: foreignState.instanceId !== firstState.instanceId,
      maintenanceRequestsBefore: beforeForeignMaintenance,
      maintenanceRequestsAfter: maintenanceRequests,
      output: foreignOutput.slice(-1600),
    });
  console.log("RM2_POSTFIX_STEP3", JSON.stringify({
    ready: foreignOutput.includes("manager up"),
    exitCode: supervisor.exitCode,
    firstInstanceId: firstState.instanceId,
    foreignInstanceId: foreignState.instanceId,
    differentOwner: secondOwner !== owner,
    maintenanceRequestsBefore: beforeForeignMaintenance,
    maintenanceRequestsAfter: maintenanceRequests,
  }));
} catch (error) {
  fail++;
  console.log("  ✗ FAIL: harness threw", error instanceof Error ? redact(error.stack ?? error.message) : String(error));
} finally {
  await endpoint?.stop().catch(() => {});
  const supervisorStopped = await stop(supervisor);
  exchangeProxy?.closeAllConnections();
  await new Promise<void>((resolveClose) => exchangeProxy ? exchangeProxy.close(() => resolveClose()) : resolveClose());
  const authStopped = await stop(authService);
  const deliveryStopped = await stop(delivery);
  const brokerStopped = await stop(broker);
  idpServer?.closeAllConnections();
  await new Promise<void>((resolveClose) => idpServer ? idpServer.close(() => resolveClose()) : resolveClose());
  check("teardown stops every owned process before deleting scratch state",
    supervisorStopped && authStopped && deliveryStopped && brokerStopped,
    { supervisorStopped, authStopped, deliveryStopped, brokerStopped });
  console.log("  owned process identity summary", [...owned.values()].map(({ label, startTime, cgroupSha256 }) => ({
    label,
    startTimeSha256: createHash("sha256").update(startTime).digest("hex"),
    cgroupSha256,
  })));
  if (supervisorStopped && authStopped && deliveryStopped && brokerStopped) {
    rmSync(home, { recursive: true, force: true });
    rmSync(hostRoot, { recursive: true, force: true });
    rmSync(participantRoot, { recursive: true, force: true });
    if (secondHome) rmSync(secondHome, { recursive: true, force: true });
    if (secondRoot) rmSync(secondRoot, { recursive: true, force: true });
    if (storeDir) rmSync(storeDir, { recursive: true, force: true });
  }
  if (previousHome === undefined) delete process.env.COTAL_HOME;
  else process.env.COTAL_HOME = previousHome;
}

console.log(`\nHOSTED RETIREMENT STOCK SUPERVISE ACCEPTANCE ${fail === 0 ? "GREEN" : "FAILED"} (${pass} passed, ${fail} failed; credentials logged: no)`);
process.exitCode = fail === 0 ? 0 : 1;
