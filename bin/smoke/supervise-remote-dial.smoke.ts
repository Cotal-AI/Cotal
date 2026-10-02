/**
 * `cotal supervise` against a REGISTERED REMOTE mesh selects its transport from the recorded
 * broker URL, and never reads the cwd root's local signing trust (#1944).
 *
 * A registry entry for a user-auth mesh may hold a `ws://`/`wss://` server, because a remote broker
 * is published through an HTTPS edge. The supervisor's first dial is the remote manager-authority
 * registration, and the raw node transport refuses such a URL outright with the refusal that names
 * `wsconnect` — so supervision stopped before the manager was ever constructed.
 *
 * One authenticated nats-server exposes the same account over both listeners. The websocket cells
 * discriminate on that pre-fix refusal; the TCP cells are negative controls proving the transport
 * selection did not regress ordinary NATS dials. The registered server is read back through
 * `superviseTarget`, so the URL under test is the one the shipped command actually hands to the
 * registration, not one the suite chose.
 *
 * The trust cells (F/F2/G/I/H) additionally stand up the host half of the remote user-auth mesh (a
 * dev Better-Auth IdP, the real `cotal auth-service` with its public exchange, and a signed-in
 * participant home) and run the SHIPPED `cotal supervise` as a child from a participant root that
 * also hosts an unrelated tenant's trust beside the sign-in:
 *   F: an unrelated tenant's legacy monolith — the manager comes UP.
 *   F2: an unrelated tenant's SPLIT records (own account record + the shared per-root broker
 *       record) — the manager comes UP; the broker record names no tenant.
 *   G: the remote space's OWN split records — refused with the combination message.
 *   I: an unreadable auth/auth.json — refused on the store's parse message before any exchange.
 *   H: no trust text may name auth/auth.json in F's output.
 *
 * Prove: pnpm mutation-proof --config bin/smoke/mutations/supervise-remote-dial.json
 */
import { spawn as spawnProc, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { SMOKE_BROKER_TOKEN, teardownOnSignal, teardownPathOnSignal } from "@cotal-ai/smoke-kit";
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createNetServer, type AddressInfo } from "node:net";
import { createServer as createHttpServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const server = createNetServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      server.close(() => resolve(port));
    });
  });
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const awaitExit = (child: ChildProcess, ms = 5_000): Promise<void> =>
  new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    child.once("exit", () => resolve());
    setTimeout(resolve, ms).unref?.();
  });

let pass = 0;
let fail = 0;
const ok = (name: string, condition: boolean, extra?: unknown): void => {
  if (condition) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ FAIL: ${name}${extra === undefined ? "" : ` - ${JSON.stringify(extra)}`}`);
  }
};
const must = (name: string, condition: boolean, extra?: unknown): void => {
  if (!condition) throw new Error(`FAIL (rig): ${name}${extra === undefined ? "" : ` - ${JSON.stringify(extra)}`}`);
  pass++;
  console.log(`  ✓ ${name}`);
};

for (const key of Object.keys(process.env)) if (key.startsWith("COTAL_")) delete process.env[key];
const fixtureId = randomUUID().replaceAll("-", "");
const home = mkdtempSync(join(tmpdir(), `cotal-supervise-dial-home-${fixtureId}-`));
const releaseHome = teardownPathOnSignal(home);
process.env.COTAL_HOME = home;
const xdg = join(home, "xdg");
mkdirSync(xdg);
process.env.XDG_CONFIG_HOME = xdg;
const root = mkdtempSync(join(tmpdir(), `${SMOKE_BROKER_TOKEN}supervise-dial-root-${fixtureId}-`));
const releaseRoot = teardownPathOnSignal(root);
// The JetStream store gets its own tokened dir rather than living under `root`, because the reaper
// claims a lost broker by that prefix.
const brokerStore = mkdtempSync(join(tmpdir(), `${SMOKE_BROKER_TOKEN}supervise-dial-js-${fixtureId}-`));
const releaseBrokerStore = teardownPathOnSignal(brokerStore);
const tcpPort = await freePort();
const wsPort = await freePort();
const tcpServer = `nats://127.0.0.1:${tcpPort}`;
const wsServer = `ws://127.0.0.1:${wsPort}`;
const space = "supervisedial";
const kids: ChildProcess[] = [];

const { createSpaceAuth, mintCreds, mintLifecycleUid, newIdentity, probeConnect, remoteManagerActors, serverConfig, setupSpaceStreams } =
  await import("@cotal-ai/core");
const { authDir, putSpaceAuth, recordMesh, saveSpaceAuth, userAuthStateDir, workspaceSecretStore } = await import("@cotal-ai/workspace");
const { MANAGER_ENDPOINT } = await import("../../implementations/manager/src/manager-service-contract.js");
const { makeManagerEndpointEvictor } = await import("../../implementations/manager/src/endpoint-evict.js");
const { registerRemoteManagerAuthority } = await import("../../implementations/manager/src/remote-register.js");
const { superviseTarget } = await import("../../implementations/manager/src/commands.js");
const { runWorkflow } = await import("../../implementations/runtime/src/run-command.js");
const { Manager } = await import("../../implementations/manager/src/manager.js");

const auth = await createSpaceAuth(space);
saveSpaceAuth(authDir(root), auth);
const conf = join(root, "server.conf");
writeFileSync(
  conf,
  serverConfig(auth, [auth], {
    transport: { kind: "plaintext" },
    port: tcpPort,
    host: "127.0.0.1",
    wsPort,
    wsHost: "127.0.0.1",
    storeDir: brokerStore,
  }),
);

/** Run the registration half the supervisor runs, over the target it resolved, as one line. */
const drive = async (target: { server: string; tlsRequired: boolean }): Promise<string> => {
  const instanceId = mintLifecycleUid();
  const prepareCreds = await mintCreds(auth, newIdentity(), "endpoint-serve-executor", {
    endpointServeExecutor: { endpoint: MANAGER_ENDPOINT, instanceId },
  });
  try {
    const registered = await registerRemoteManagerAuthority({
      space,
      server: target.server,
      owner: "local",
      instanceId,
      serveActor: remoteManagerActors(instanceId).serve,
      prepareCreds,
      tlsRequired: target.tlsRequired,
      evict: makeManagerEndpointEvictor({ space, servers: target.server, auth, log: () => {} }),
    });
    return `registered epoch=${registered.processEpoch} revision=${registered.registrationRevision}`;
  } catch (error) {
    return `refused: ${(error as Error).message}`;
  }
};
const registered = (line: string): boolean => line.startsWith("registered ") && !/wsconnect|websocket/i.test(line);

/** `cotal run ps --local` over the resolved mesh, as the one line the shipped verb printed — or as
 *  its refusal. The verb opens its own planes on the registry-resolved server, so this drives the
 *  same registry URL through a second command's dial. */
const runPs = async (): Promise<string> => {
  const printed: string[] = [];
  const log = console.log;
  console.log = (...parts: unknown[]): void => void printed.push(parts.map(String).join(" "));
  try {
    await runWorkflow({ values: { local: true }, positionals: ["ps"], raw: ["run", "ps", "--local"] });
    return printed.join("\n");
  } catch (error) {
    return `refused: ${(error as Error).message}`;
  } finally {
    console.log = log;
  }
};

let releaseBroker: (() => void) | undefined;
let releaseTrustBroker: (() => void) | undefined;
let releaseBrokerStoreTrust: (() => void) | undefined;
let idpServer: ReturnType<typeof createHttpServer> | undefined;
let authServiceKid: ChildProcess | undefined;
const releaseRoots: string[] = [];
/** Kill the broker and remove every artifact this suite made. Idempotent: cell D asserts on it
 *  where the banner can still count the verdict, and the `finally` repeats it for the paths that
 *  never reach the cell. */
let tornDown = false;
const teardown = async (): Promise<void> => {
  if (tornDown) return;
  tornDown = true;
  process.chdir(tmpdir());
  await Promise.all(kids.map(async (child) => { if (child.exitCode === null) child.kill("SIGKILL"); await awaitExit(child); }));
  rmSync(brokerStore, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
  // The trust cells' scratch (participant roots, sign-in home copies, host root, IdP state).
  idpServer?.closeAllConnections();
  await new Promise<void>((resolveClose) => {
    if (!idpServer) { resolveClose(); return; }
    idpServer.close(() => resolveClose());
  });
  for (const path of releaseRoots) rmSync(path, { recursive: true, force: true });
};
try {
  const broker = spawnProc("nats-server", ["-c", conf], { stdio: "ignore" });
  releaseBroker = teardownOnSignal(broker, brokerStore);
  kids.push(broker);
  let serving = false;
  for (let i = 0; i < 80; i++) {
    const probe = await probeConnect(tcpServer, { timeoutMs: 400 });
    if (probe.ok || ("reason" in probe && probe.reason === "auth-required")) { serving = true; break; }
    await sleep(100);
  }
  must("the authenticated broker is serving its TCP listener", serving, tcpServer);
  // `setupSpaceStreams` also runs `createEndpointStreams`, so the records + endpoint-auth buckets and
  // the contract store the registration writes into exist before either cell dials.
  await setupSpaceStreams({ servers: tcpServer, space, creds: await mintCreds(auth, newIdentity(), "provisioner") });

  // A registered remote user-auth mesh whose broker is published over websocket. `root` holds no
  // user-auth marker, so this machine is a PARTICIPANT: exactly the case supervise routes through
  // the remote manager-authority registration.
  const userAuth = {
    provider: "cotal",
    idp: { url: "https://idp.invalid", issuer: "https://idp.invalid", audience: "cotal" },
    endpoints: { url: "https://exchange.invalid" },
    remote: true as const,
  };
  process.chdir(root);
  recordMesh({ space, server: wsServer, root, mode: "user", userAuth, ts: new Date().toISOString() });

  const wsTarget = superviseTarget({});
  must("the supervisor resolves the registered websocket broker as a remote-user target", wsTarget.remoteUser === true && wsTarget.server === wsServer, wsTarget);

  const wsLine = await drive(wsTarget);
  ok("A: the remote manager-authority registration completes over the recorded ws:// broker", registered(wsLine), wsLine);

  recordMesh({ space, server: tcpServer, root, mode: "user", userAuth, ts: new Date().toISOString() });
  const tcpTarget = superviseTarget({});
  must("the supervisor resolves the registered TCP broker as a remote-user target", tcpTarget.remoteUser === true && tcpTarget.server === tcpServer, tcpTarget);
  const tcpLine = await drive(tcpTarget);
  ok("B: the same registration still completes over a nats:// broker", registered(tcpLine), tcpLine);

  // The record is the only authority on whether the broker requires TLS. Re-record the SAME
  // plaintext broker as TLS-required: the registration must now demand TLS and be turned away by a
  // server that offers none. A dial that hardcodes `tls: false` connects anyway and sends the
  // prepare credential in the clear, which is what this cell exists to catch.
  recordMesh({ space, server: tcpServer, root, mode: "user", userAuth, tlsRequired: true, ts: new Date().toISOString() });
  const tlsTarget = superviseTarget({});
  must("the supervisor carries tlsRequired from the mesh record", tlsTarget.tlsRequired === true, tlsTarget);
  const tlsLine = await drive(tlsTarget);
  ok("C: a TLS-required record makes the registration demand TLS of the broker", /refused: .*tls/i.test(tlsLine), tlsLine);

  // The supervisor is not the only command handed a registry server URL: `cotal run --local` opens
  // its planes on the same resolved server, so a ws:// record reaches that dial too and the raw
  // node transport refuses it there for the same reason. A run's credentials are minted by the
  // space signer, which a client of a user-auth mesh does not hold, so this leg records the same
  // websocket broker as a STATIC mesh - the mode `cotal run` is reachable on at all.
  recordMesh({ space, server: wsServer, root, mode: "auth", ts: new Date().toISOString() });
  const runLine = await runPs();
  ok("E: `cotal run ps --local` opens its run planes over the recorded ws:// broker", runLine === `no workflow runs recorded in space ${space}`, runLine);

  // A remote-authority manager never reads local signing trust (#1944). These cells run the
  // SHIPPED command — `tsx bin/cotal.ts supervise --space <space>` as a child, cwd = a per-cell
  // participant root holding the registered remote-user mesh record and the sign-in home —
  // against a full host rig (dev Better-Auth IdP, real `cotal auth-service` with its public
  // exchange, granted `supervise` scope), the same composition the issue's machine had. Every
  // assertion is on the exact lines the live reproduction recorded:
  //   F: the manager comes UP ("✓ manager up") with an unrelated tenant's legacy monolith in the
  //      root, and neither trust text appears.
  //   G: split records for the remote space itself refuse with the combination message, never the
  //      corrupt one.
  //   H: the wrong-space monolith is never read — no line names auth/auth.json as trust.
  // The supervise child STAYS UP on success, so each cell kills it once the assertion text
  // arrives (or the cell fails on the cap).
  //
  // HOST RIG: the user-auth mesh needs the provider callout account in the broker's resolver map,
  // which this suite's transport broker was not configured with — so the rig stands up its own
  // authenticated nats-server for the trust cells, prepared exactly as `cotal up --user-auth`
  // would prepare a host (IdP first, then provider prepare, then the broker with extraAccounts).
  const repoRoot = resolve(import.meta.dirname, "..", "..");
  const cliBin = join(repoRoot, "bin", "cotal.ts");
  const tsxBin = join(repoRoot, "node_modules", ".bin", "tsx");
  const childHomeEnv = (cellHome: string): NodeJS.ProcessEnv => {
    const env: NodeJS.ProcessEnv = {};
    for (const [key, value] of Object.entries(process.env)) if (!key.startsWith("COTAL_")) env[key] = value;
    env.COTAL_HOME = cellHome;
    env.XDG_CONFIG_HOME = join(cellHome, "xdg");
    env.COTAL_SKIP_CONNECTOR_SEED = "1";
    return env;
  };
  const trustHome = mkdtempSync(join(tmpdir(), `${SMOKE_BROKER_TOKEN}supervise-signin-${fixtureId}-`));
  releaseRoots.push(trustHome);
  const hostRoot = mkdtempSync(join(tmpdir(), `${SMOKE_BROKER_TOKEN}supervise-hostroot-${fixtureId}-`));
  releaseRoots.push(hostRoot);
  const trustJsStore = mkdtempSync(join(tmpdir(), `${SMOKE_BROKER_TOKEN}supervise-trustjs-${fixtureId}-`));
  releaseBrokerStoreTrust = teardownPathOnSignal(trustJsStore);
  const hostDir = userAuthStateDir(hostRoot, space);
  const hostStore = workspaceSecretStore(hostRoot);
  mkdirSync(join(hostRoot, ".cotal"), { recursive: true });
  saveSpaceAuth(authDir(hostRoot), auth);
  // Dev Better-Auth IdP (in-parent: the supervise child only talks to it through the auth service).
  const betterAuthRoot = new URL("../../implementations/auth/node_modules/better-auth/", import.meta.url);
  const { betterAuth } = await import(new URL("dist/index.mjs", betterAuthRoot).href);
  const { memoryAdapter } = await import(new URL("dist/adapters/memory-adapter/index.mjs", betterAuthRoot).href);
  const { jwt } = await import(new URL("dist/plugins/jwt/index.mjs", betterAuthRoot).href);
  const { deviceAuthorization } = await import(new URL("dist/plugins/device-authorization/index.mjs", betterAuthRoot).href);
  const { bearer: betterAuthBearer } = await import(new URL("dist/plugins/bearer/index.mjs", betterAuthRoot).href);
  const { toNodeHandler } = await import(new URL("dist/integrations/node.mjs", betterAuthRoot).href);
  let idpHandler: ReturnType<typeof toNodeHandler> | undefined;
  idpServer = createHttpServer((request, response) => idpHandler!(request, response));
  await new Promise<void>((resolveListen) => idpServer!.listen(0, "127.0.0.1", resolveListen));
  const idpAddress = idpServer!.address() as AddressInfo;
  const idpOrigin = `http://127.0.0.1:${idpAddress.port}`;
  const idpUrl = `${idpOrigin}/api/auth`;
  const idpClientId = "supervise-dial-smoke";
  const idp = betterAuth({
    baseURL: idpOrigin,
    secret: "supervise-dial-smoke-secret-0123456789",
    database: memoryAdapter({ user: [], session: [], account: [], verification: [], jwks: [], deviceCode: [] }),
    emailAndPassword: { enabled: true },
    plugins: [
      jwt({ jwt: { issuer: idpOrigin, audience: idpOrigin } }),
      deviceAuthorization({ expiresIn: "2m", interval: "1s", validateClient: (id: string) => id === idpClientId }),
      betterAuthBearer(),
    ],
  });
  idpHandler = toNodeHandler(idp);
  const { cotalAuthProvider, establishIdpSession, grantActor, loadAuthServiceInfo, loadCalloutAuth } = await import("@cotal-ai/auth");
  const preparedHost = await cotalAuthProvider.prepareServer({
    space,
    operatorSeed: auth.operator.seed,
    account: { pub: auth.account.pub, signingSeed: auth.account.signingSeed },
    store: hostStore,
    dir: hostDir,
    idpUrl,
  });
  must("the trust rig prepared user-auth host state against the dev IdP", Boolean(preparedHost), preparedHost);
  const trustPort = await freePort();
  const trustServer = `nats://127.0.0.1:${trustPort}`;
  writeFileSync(join(hostRoot, "trust-server.conf"), serverConfig(auth, [auth], {
    transport: { kind: "plaintext" },
    port: trustPort,
    storeDir: trustJsStore,
    extraAccounts: preparedHost.extraAccounts,
  }));
  const trustBroker = spawnProc("nats-server", ["-c", join(hostRoot, "trust-server.conf")], { stdio: "ignore" });
  kids.push(trustBroker);
  releaseTrustBroker = teardownOnSignal(trustBroker, trustJsStore);
  let trustServing = false;
  for (let i = 0; i < 80; i++) {
    const probe = await probeConnect(trustServer, { timeoutMs: 400 });
    if (probe.ok || ("reason" in probe && probe.reason === "auth-required")) { trustServing = true; break; }
    await sleep(100);
  }
  must("the trust rig broker is serving", trustServing, trustServer);
  await setupSpaceStreams({ servers: trustServer, space, creds: await mintCreds(auth, newIdentity(), "provisioner") });
  // The host's auth service with a PUBLIC exchange (the participant's pinned endpoint).
  authServiceKid = spawnProc(tsxBin, [cliBin, "auth-service", "--space", space, "--server", trustServer, "--exchange-public-port", "0"], {
    cwd: hostRoot,
    env: childHomeEnv(trustHome),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let authServiceOut = "";
  authServiceKid.stdout?.on("data", (chunk: Buffer) => { authServiceOut += chunk.toString(); });
  authServiceKid.stderr?.on("data", (chunk: Buffer) => { authServiceOut += chunk.toString(); });
  kids.push(authServiceKid);
  let publicExchangeUrl: string | undefined;
  for (let i = 0; i < 300 && authServiceKid.exitCode === null; i++) {
    const info = loadAuthServiceInfo(hostDir);
    if (info) {
      try {
        process.kill(info.pid, 0);
        if ((await fetch(`${info.url}/health`, { signal: AbortSignal.timeout(500) })).ok) { publicExchangeUrl = info.publicUrl; break; }
      } catch { /* booting */ }
    }
    await sleep(200);
  }
  must("the trust rig auth service exposes its public exchange", typeof publicExchangeUrl === "string",
    typeof publicExchangeUrl === "string" ? publicExchangeUrl : authServiceOut.slice(-600));
  // Sign the participant in (the IdP session lands in trustHome, copied into each cell home).
  process.env.COTAL_HOME = trustHome;
  const signup = await idp.api.signUpEmail({
    body: { email: "participant@example.test", password: "correct-horse-battery", name: "Participant" },
    returnHeaders: true,
  });
  const cookie = signup.headers.get("set-cookie")!.split(";")[0]!;
  const approve = async (userCode: string): Promise<void> => {
    await fetch(`${idpUrl}/device?user_code=${encodeURIComponent(userCode)}`, { headers: { cookie, origin: idpOrigin } });
    const response = await fetch(`${idpUrl}/device/approve`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie, origin: idpOrigin },
      body: JSON.stringify({ userCode }),
    });
    if (!response.ok) throw new Error(`device approval failed: HTTP ${response.status}`);
  };
  await establishIdpSession({ dir: trustHome, idpUrl, clientId: idpClientId, onPrompt: (prompt: { userCode: string }) => void approve(prompt.userCode) });
  const owner = await cotalAuthProvider.ownerForLogin({ store: hostStore, dir: hostDir, space });
  grantActor(hostDir, { owner, actor: "cli", scope: ["spawn", "supervise"], allowSubscribe: ["general"], allowPublish: ["general"] });
  const callout = await loadCalloutAuth(hostStore, space);
  must("the trust rig holds callout material for the sentinel", Boolean(callout));
  // The REMOTE entry the cells' roots register: manual/user/remote with a pinned policy (a manual
  // entry with a policy never dials its exchange for a refresh, keeping the cells on trust
  // resolution rather than discovery-document drift).
  const trustUserAuth = {
    provider: "cotal",
    idp: { url: idpUrl, issuer: idpOrigin, audience: idpOrigin },
    endpoints: { url: publicExchangeUrl! },
    remote: true as const,
  };

  const trustOutcomes = new Map<string, string>();
  const trustCell = async (label: string, prepare: (cellRoot: string) => Promise<void>): Promise<void> => {
    const cellRoot = mkdtempSync(join(tmpdir(), `${SMOKE_BROKER_TOKEN}supervise-trust-${fixtureId}-`));
    releaseRoots.push(cellRoot);
    const cellHome = mkdtempSync(join(tmpdir(), `${SMOKE_BROKER_TOKEN}supervise-home-${fixtureId}-`));
    releaseRoots.push(cellHome);
    mkdirSync(join(cellRoot, ".cotal", "auth"), { recursive: true });
    await prepare(cellRoot);
    recordMesh({ space, server: trustServer, root: cellRoot, mode: "user", userAuth: trustUserAuth, policy: { events: "required" }, origin: "manual", ts: new Date().toISOString() });
    const cellTarget = superviseTarget({ space });
    must(`${label}: the cell root resolves the same registered remote-user target`, cellTarget.remoteUser === true && cellTarget.server === trustServer, cellTarget);
    // The sign-in (IdP session + catalog) lives in COTAL_HOME; copy the logged-in home.
    cpSync(trustHome, cellHome, { recursive: true });
    const child = spawnProc(tsxBin, [cliBin, "supervise", "--space", space], {
      cwd: cellRoot,
      env: { ...childHomeEnv(cellHome), COTAL_SKIP_CONNECTOR_SEED: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    kids.push(child);
    let output = "";
    const append = (chunk: Buffer | string): void => { output += chunk.toString(); };
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);
    const done = new Promise<void>((resolve) => {
      const timer = setInterval(() => {
        if (/cannot be combined|corrupt or mislabeled|not valid JSON|✓ manager up/.test(output) || child.exitCode !== null) { clearInterval(timer); resolve(); }
      }, 100);
      setTimeout(() => { clearInterval(timer); resolve(); }, 120_000).unref?.();
    });
    await done;
    try { child.kill("SIGKILL"); } catch { /* already gone */ }
    await awaitExit(child);
    trustOutcomes.set(label, output);
  };

  // F: an UNRELATED static tenant's legacy monolith in the root must be invisible — the shipped
  // supervise reaches "✓ manager up" over the remote authority, and neither trust text appears.
  await trustCell("F", async (cellRoot) => {
    const other = await createSpaceAuth("supervisedial-other-tenant");
    writeFileSync(join(cellRoot, ".cotal", "auth", "auth.json"), JSON.stringify(other, null, 2), { mode: 0o600 });
  });
  const fLine = trustOutcomes.get("F")!;
  ok("F: a remote supervise with an unrelated legacy monolith in the root reaches manager up",
    /✓ manager up/.test(fLine), fLine.slice(-600));

  // F2: an unrelated static tenant in the SPLIT layout (its own account record beside the shared
  // per-root broker record) is equally not this space's trust: the broker record is one per root
  // and names no tenant, so the manager must come up here too (#1944 round two).
  await trustCell("F2", async (cellRoot) => {
    const other = await createSpaceAuth("supervisedial-split-tenant");
    await putSpaceAuth(workspaceSecretStore(cellRoot), other);
  });
  const f2Line = trustOutcomes.get("F2")!;
  ok("F2: a remote supervise with an unrelated tenant's split records (shared broker record included) reaches manager up",
    /✓ manager up/.test(f2Line), f2Line.slice(-600));

  // G: split records for the REMOTE space itself beside the sign-in is the real conflict of
  // authorities: the same command refuses with the combination message, never the corrupt one,
  // and never reaches manager up.
  await trustCell("G", async (cellRoot) => {
    await putSpaceAuth(workspaceSecretStore(cellRoot), auth);
  });
  const gLine = trustOutcomes.get("G")!;
  ok("G: a remote supervise with split records for the remote space refuses the authority combination",
    /cannot be combined with local space signing trust/.test(gLine) && !/corrupt or mislabeled|✓ manager up/.test(gLine), gLine.slice(-600));

  // I: an UNREADABLE bundle on the one legacy key the check reads refuses loud with the store's
  // own parse message, before any authority exchange output (round two: the first cut swallowed
  // the parse failure and proceeded).
  await trustCell("I", async (cellRoot) => {
    writeFileSync(join(cellRoot, ".cotal", "auth", "auth.json"), "{not json", { mode: 0o600 });
  });
  const iLine = trustOutcomes.get("I")!;
  ok("I: an unreadable auth/auth.json under the sign-in refuses on the store's parse message before any exchange output",
    /the space trust bundle \(auth\/auth\.json\) is not valid JSON - repair or replace the store value/.test(iLine)
      && !/✓ manager up|remote manager service endpoint activated/.test(iLine), iLine.slice(-600));

  // H: the wrong-space monolith is never USED as this space's trust. F pins the positive outcome;
  // H pins the negative: no line of F's output names auth/auth.json as trust — a read that
  // validated it as this space's would print one of the trust texts. Assert on the MESSAGE.
  ok("H: the wrong-space monolith is never used as this space's trust (no trust text names auth/auth.json)",
    !/corrupt or mislabeled|cannot be combined|space trust bundle \(auth\/auth\.json\)/.test(fLine), fLine.slice(-600));

  await teardown();
  const remainingArtifacts = [brokerStore, root, home, xdg, ...releaseRoots].filter((path) => existsSync(path)).length;
  ok("D: broker store, project root, COTAL_HOME, and XDG artifacts remaining after teardown = 0", remainingArtifacts === 0, remainingArtifacts);
  console.log(`\nsupervise remote dial: ${pass} passed, ${fail} failed`);
  // The trust cells' supervise children hold runtime handles past their kills; the suite exits
  // DETERMINISTICALLY here, after the teardown cell has verified the disk.
  process.exit(fail ? 1 : 0);
} finally {
  await teardown();
  releaseHome?.();
  releaseRoot?.();
  releaseBrokerStore();
  releaseBrokerStoreTrust?.();
  releaseBroker?.(); // last: ownership is held until this teardown has actually finished
  releaseTrustBroker?.();
}
