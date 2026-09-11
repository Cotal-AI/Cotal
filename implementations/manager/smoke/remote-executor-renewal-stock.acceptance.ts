/*
 * Stock `cotal supervise` remote authority renewal boundary.
 *
 * Starts the real CLI supervisor from a registry-only participant root. The host authority is served
 * through an owned HTTPS proxy. The `early` arm stops before the first executor expires. The `expired`
 * arm records that first real five-minute expiry separately, waits through it plus five seconds, and
 * requires the supervisor to have adopted a complete host-issued renewal family before clean stop.
 *
 * All state is disposable. Requires Linux, nats-server, and openssl.
 */

const subcommand = process.argv[2] ?? "";
if (subcommand === "" && process.env.COTAL_OWNER_NATIVE_ACCEPTANCE !== "1")
  throw new Error("stock remote authority renewal acceptance is owner-only; set COTAL_OWNER_NATIVE_ACCEPTANCE=1 on the isolated native host");
const acceptanceArm = process.env.COTAL_REMOTE_EXECUTOR_ARM ?? "expired";
if (subcommand === "" && acceptanceArm !== "early" && acceptanceArm !== "expired")
  throw new Error("COTAL_REMOTE_EXECUTOR_ARM must be early or expired");
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
      COTAL_REMOTE_EXECUTOR_ARM: acceptanceArm,
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
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  meetsBrokerFloor,
  mintConnectionEvictorCreds,
  mintCreds,
  mintLifecycleUid,
  mintMembershipObserverCreds,
  newIdentity,
  recordSpecKey,
  RECORD_KINDS,
  recordsBucket,
  serverConfig,
  setupSpaceStreams,
  standaloneConnectOpts,
  waitForDeliveryLease,
} from "@cotal-ai/core";
import {
  assertUserAuthInfo,
  authDir,
  connectionEvictorCredsKey,
  deliveryCredsKey,
  hasUserAuthState,
  membershipObserverCredsKey,
  membershipRwCredsKey,
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
import { pickFreePort } from "../../auth/smoke/_free-port.js";

if (process.platform !== "linux") throw new Error("stock remote authority renewal acceptance requires Linux");

const repo = resolve(import.meta.dirname, "..", "..", "..");
const cli = join(repo, "bin", "cotal.ts");
const tsx = join(repo, "node_modules", ".bin", "tsx");
const self = process.argv[1]!;
const home = mkdtempSync(join(tmpdir(), "cotal-stock-supervise-home-"));
const hostRoot = mkdtempSync(join(tmpdir(), "cotal-stock-supervise-host-"));
const participantRoot = mkdtempSync(join(tmpdir(), "cotal-stock-supervise-participant-"));
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
let storeDir: string | undefined;
let supervisorOutput = "";
let authOutput = "";
let deliveryOutput = "";
let prepareRequests = 0;
let activateRequests = 0;
let renewRequests = 0;
let initialExecutorExpiresAt = 0;
let renewedExecutorExpiresAt = 0;
let renewalAllFive = false;
let renewalCurrentProof = false;
let firstRenewObservedAt = 0;
let managerInstanceId = "";

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
      if (req.url?.endsWith("/manager-service-authority")) {
        try {
          const parsed = JSON.parse(body.toString("utf8")) as { request?: { operation?: string; instanceId?: string } };
          if (parsed.request?.operation === "prepare") prepareRequests++;
          else if (parsed.request?.operation === "activate") activateRequests++;
          else if (parsed.request?.operation === "renew") renewRequests++;
          if (typeof parsed.request?.instanceId === "string") managerInstanceId = parsed.request.instanceId;
        } catch { /* the upstream owns malformed-request reporting */ }
      }
      const upstreamUrl = new URL(service!.publicUrl!);
      const upstream = httpRequest({
        host: upstreamUrl.hostname, port: Number(upstreamUrl.port), path: req.url,
        method: req.method, headers: { ...req.headers, host: upstreamUrl.host },
      }, (response) => {
        const responseChunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => responseChunks.push(chunk));
        response.on("end", () => {
          const responseBody = Buffer.concat(responseChunks);
          if (req.url?.endsWith("/manager-service-authority")) {
            try {
              const material = JSON.parse(responseBody.toString("utf8")) as {
                operation?: string;
                registrationProof?: string;
                nextRegistrationProof?: string;
                credentials?: Partial<Record<"supervisor" | "executor" | "serve" | "goalWriter" | "sessionLedger", { exp?: number }>>;
              };
              if (material.operation === "prepare" && typeof material.credentials?.executor?.exp === "number")
                initialExecutorExpiresAt = material.credentials.executor.exp;
              if (material.operation === "renew" && typeof material.credentials?.executor?.exp === "number") {
                renewedExecutorExpiresAt = material.credentials.executor.exp;
                const names = ["supervisor", "executor", "serve", "goalWriter", "sessionLedger"] as const;
                renewalAllFive = names.every((name) => typeof material.credentials?.[name]?.exp === "number");
                renewalCurrentProof = typeof material.registrationProof === "string" && material.registrationProof === material.nextRegistrationProof;
                if (renewalAllFive && renewalCurrentProof && firstRenewObservedAt === 0) firstRenewObservedAt = Date.now();
              }
            } catch { /* the public caller reports malformed authority material */ }
          }
          res.writeHead(response.statusCode ?? 502, response.headers);
          res.end(responseBody);
        });
      });
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
  grantActor(hostDir, { owner, actor: "cli", scope: ["supervise"], allowSubscribe: [], allowPublish: [] });
  const callout = await loadCalloutAuth(hostStore, space);
  if (!callout) throw new Error("host callout material is missing");
  persistRemoteUserEntry(space, server, participantRoot, {
    space, server, tlsRequired: false,
    userAuth: assertUserAuthInfo({
      provider: "cotal", idp: { url: idpUrl, issuer: origin, audience: origin }, endpoints: { url: secureExchangeUrl },
    }),
    sentinelCreds: callout.sentinelCreds,
  }, false, false);
  check("participant registry is remote user mode with no hosting marker",
    existsSync(participantDir) && hasUserAuthState(participantRoot, space) === false);

  const xdg = join(home, "xdg");
  const supervisorEnv: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) if (!key.startsWith("COTAL_")) supervisorEnv[key] = value;
  supervisorEnv.COTAL_HOME = home;
  supervisorEnv.COTAL_SKIP_CONNECTOR_SEED = "1";
  supervisorEnv.XDG_CONFIG_HOME = xdg;
  supervisorEnv.NODE_EXTRA_CA_CERTS = process.env.COTAL_STOCK_HTTPS_CA!;
  supervisor = track("supervisor", spawn(tsx, [cli, "supervise", "--space", space, "--server", server, "--runtime", "pty"], {
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
    { ready: supervisorOutput.includes("manager up"), exitCode: supervisor.exitCode, prepareRequests, activateRequests, renewRequests, output: supervisorOutput.slice(-1200) });
  if (!supervisorOutput.includes("manager up")) throw new Error("stock supervisor did not become ready");
  const nowSec = Math.floor(Date.now() / 1000);
  check("host returned the real five-minute initial executor for the stock supervisor",
    initialExecutorExpiresAt > nowSec && initialExecutorExpiresAt - nowSec <= 305,
    { nowSec, initialExecutorExpiresAt, managerInstanceId });
  check("startup crossed no admin, resume, retirement, or renew operation",
    prepareRequests === 1 && activateRequests === 1 && renewRequests === 0,
    { prepareRequests, activateRequests, renewRequests });

  const stopAt = acceptanceArm === "expired" ? initialExecutorExpiresAt * 1000 + 5_000 : Date.now() + 5_000;
  const stopWaitMs = Math.max(0, stopAt - Date.now());
  if (stopWaitMs > 330_000) throw new Error(`executor stop wait ${stopWaitMs}ms exceeds the real five-minute bound`);
  await wait(stopWaitMs);
  check(`stock supervisor remains live through the ${acceptanceArm} stop point`,
    supervisor.exitCode === null && supervisor.signalCode === null,
    { acceptanceArm, initialExecutorExpiresAt, now: Math.floor(Date.now() / 1000), output: supervisorOutput.slice(-1200) });
  check(acceptanceArm === "expired"
      ? "a successful typed renew crossed HTTPS before the first executor expiry"
      : "early control stops before any typed renew",
    acceptanceArm === "expired" ? renewRequests >= 1 : renewRequests === 0,
    { prepareRequests, activateRequests, renewRequests });
  check(acceptanceArm === "expired"
      ? "the renewal response carried all five members and preserved the current host proof"
      : "early control did not observe a renewal response",
    acceptanceArm === "expired"
      ? renewalAllFive && renewalCurrentProof && renewedExecutorExpiresAt > initialExecutorExpiresAt &&
        firstRenewObservedAt > 0 && firstRenewObservedAt < initialExecutorExpiresAt * 1000
      : !renewalAllFive && !renewalCurrentProof && renewedExecutorExpiresAt === 0 && firstRenewObservedAt === 0,
    { renewalAllFive, renewalCurrentProof, firstRenewObservedAt, initialExecutorExpiresAt, renewedExecutorExpiresAt });

  const supervisorIdentity = owned.get(supervisor);
  if (!supervisorIdentity) throw new Error("supervisor process identity disappeared before public stop");
  const beforeSignal = processIdentity(supervisorIdentity.pid);
  if (beforeSignal?.startTime !== supervisorIdentity.startTime || beforeSignal.cgroupSha256 !== supervisorIdentity.cgroupSha256)
    throw new Error(`refusing to signal supervisor PID ${supervisorIdentity.pid}: owned PID/start/cgroup identity no longer matches`);
  check("public stop targets the same owned PID/start/cgroup identity", true);
  supervisor.kill("SIGTERM");
  const supervisorStopped = await awaitClose(supervisor, 30_000);
  check("stock supervisor exits through its public signal handler", supervisorStopped,
    { exitCode: supervisor.exitCode, signalCode: supervisor.signalCode, output: supervisorOutput.slice(-1600) });
  const loudExpiryRefusal = /could not deregister manager instance/.test(supervisorOutput) && /deregister-instance --instance/.test(supervisorOutput);
  check("stock supervisor cleanly deregisters without the expiry remedy",
    !loudExpiryRefusal,
    supervisorOutput.slice(-2000));

  const observer = await connect({
    servers: server,
    ...standaloneConnectOpts({ creds: await mintCreds(auth, newIdentity(), "provisioner"), tls: false }),
    maxReconnectAttempts: 0,
  });
  try {
    const records = await new Kvm(observer).open(recordsBucket(space));
    const registrationKey = recordSpecKey(RECORD_KINDS.svc, ["manager", managerInstanceId]);
    const registration = await records.get(registrationKey);
    check("stock stop removes the exact manager registration row",
      registration === null || registration.operation !== "PUT",
      { registrationKey, operation: registration?.operation ?? "absent" });
  } finally {
    await observer.drain().catch(() => observer.close());
  }
} catch (error) {
  fail++;
  console.log("  ✗ FAIL: harness threw", error instanceof Error ? redact(error.stack ?? error.message) : String(error));
} finally {
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
  const survivingOwned = [...owned.values()].filter((expected) => {
    const current = processIdentity(expected.pid);
    return current?.startTime === expected.startTime && current.cgroupSha256 === expected.cgroupSha256;
  });
  check("no exact owned PID/start/cgroup identity survives teardown", survivingOwned.length === 0,
    survivingOwned.map(({ label, pid, startTime, cgroupSha256 }) => ({
      label, pid, startTimeSha256: createHash("sha256").update(startTime).digest("hex"), cgroupSha256,
    })));
  console.log("  owned process identity summary", [...owned.values()].map(({ label, startTime, cgroupSha256 }) => ({
    label,
    startTimeSha256: createHash("sha256").update(startTime).digest("hex"),
    cgroupSha256,
  })));
  if (supervisorStopped && authStopped && deliveryStopped && brokerStopped) {
    rmSync(home, { recursive: true, force: true });
    rmSync(hostRoot, { recursive: true, force: true });
    rmSync(participantRoot, { recursive: true, force: true });
    if (storeDir) rmSync(storeDir, { recursive: true, force: true });
  }
  check("owned COTAL_HOME, roots, and broker store are absent after teardown",
    !existsSync(home) && !existsSync(hostRoot) && !existsSync(participantRoot) && (storeDir === undefined || !existsSync(storeDir)), {
      home: existsSync(home), hostRoot: existsSync(hostRoot), participantRoot: existsSync(participantRoot),
      storeDir: storeDir === undefined ? false : existsSync(storeDir),
    });
  const remainingRoots = [home, hostRoot, participantRoot, ...(storeDir ? [storeDir] : [])].filter(existsSync);
  check("scratch roots remaining after successful owned cleanup = 0",
    supervisorStopped && authStopped && deliveryStopped && brokerStopped ? remainingRoots.length === 0 : true,
    remainingRoots.length);
  if (previousHome === undefined) delete process.env.COTAL_HOME;
  else process.env.COTAL_HOME = previousHome;
}

console.log(`\nREMOTE AUTHORITY RENEWAL ${acceptanceArm.toUpperCase()} STOCK SUPERVISE ACCEPTANCE ${fail === 0 ? "GREEN" : "FAILED"} (${pass} passed, ${fail} failed; credentials logged: no)`);
process.exitCode = fail === 0 ? 0 : 1;
