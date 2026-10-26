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
 *   J: with two of the owner's managers up, one started with `--name`, an unpinned `ps` asks
 *      nothing and lists each one under its own header with its host; an unpinned detached spawn
 *      lists each one by name with its host and gives the command again with `--on` for each, by
 *      name where the name picks it; `ps --on <name>` is answered and `who --all` shows the name.
 *      With no manager answering, `ps` lists presence.
 *      On a terminal a bare `spawn` asks where the agent runs, this terminal first, and a launch
 *      pinned to a manager whose presence reports this host asks no folder.
 *   K: a managed spawn the host refuses at enrollment, for a role outside the caller's grant, is
 *      refused as PERMISSION_DENIED with the host's reason, and no secret staged for the agent
 *      remains under the manager's root.
 *
 * Prove: pnpm mutation-proof --config bin/smoke/mutations/supervise-remote-dial.json
 */
import { spawn as spawnProc, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { SMOKE_BROKER_TOKEN, freePort, teardownOnSignal, teardownPathOnSignal } from "@cotal-ai/smoke-kit";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { createServer as createHttpServer } from "node:http";
import { hostname, tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { clean, cotalPty } from "../../implementations/cli/smoke/_console-pty.js";

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
const { makeManagerEndpointHolderEvictor } = await import("../../implementations/manager/src/endpoint-evict.js");
const { registerRemoteManagerAuthority } = await import("../../implementations/manager/src/remote-register.js");
const { superviseTarget } = await import("../../implementations/manager/src/commands.js");
const { runWorkflow } = await import("../../implementations/runtime/src/run-command.js");
const { Manager } = await import("../../implementations/manager/src/manager.js");
const { loadOrCreateRemoteManagerIdentity } = await import("../../implementations/manager/src/remote-authority.js");

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
      evict: makeManagerEndpointHolderEvictor({ space, servers: target.server, auth, log: () => {} }),
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
  ok("E: `cotal run ps --local` opens its run planes over the recorded ws:// broker", new RegExp(`Workflow runs\\n\\s+Space:\\s+${space}\\n\\s+No workflow runs in this authorized record view\\.`).test(runLine), runLine);

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
    // SIGTERM, which tsx passes on, so a manager that came up stops and deregisters. A SIGKILL ends
    // tsx alone and leaves that manager running and answering for the cells after this one.
    try { child.kill("SIGTERM"); } catch { /* already gone */ }
    await awaitExit(child, 15_000);
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

  // J: two of the owner's managers live at once. `ps` reads each of them, and a verb that needs one
  // manager refuses with each one and the host its presence reports, and the caller's own command
  // again with `--on` for each. The caller registered the space as `cotal meshes add --from` does,
  // with the sentinel under its own user-auth state dir. `ps` needs the admin scope. The earlier
  // cells leave registrations without a manager that the exchange still counts as live, so the cell
  // finds its own two managers among the rows by their instance ids.
  const jGrant = grantActor(hostDir, { owner, actor: "cli", scope: ["spawn", "supervise", "admin"], allowSubscribe: ["general"], allowPublish: ["general"] });
  const scratch = (label: string): string => {
    const path = mkdtempSync(join(tmpdir(), `${SMOKE_BROKER_TOKEN}supervise-${label}-${fixtureId}-`));
    releaseRoots.push(path);
    return path;
  };
  const twoManagers: ChildProcess[] = [];
  const twoIds: string[] = [];
  let j1Root = "", j1Home = "";
  for (const label of ["J1", "J2"]) {
    const cellRoot = scratch("two-root"), cellHome = scratch("two-home");
    if (label === "J1") [j1Root, j1Home] = [cellRoot, cellHome];
    mkdirSync(join(cellRoot, ".cotal"), { recursive: true });
    recordMesh({ space, server: trustServer, root: cellRoot, mode: "user", userAuth: trustUserAuth, policy: { events: "required" }, origin: "manual", ts: new Date().toISOString() });
    cpSync(trustHome, cellHome, { recursive: true });
    const child = spawnProc(tsxBin, [cliBin, "supervise", "--space", space, ...(label === "J1" ? ["--name", "j-one"] : [])], { cwd: cellRoot, env: childHomeEnv(cellHome), stdio: ["ignore", "pipe", "pipe"] });
    kids.push(child);
    twoManagers.push(child);
    let output = "";
    child.stdout?.on("data", (chunk: Buffer) => { output += chunk.toString(); });
    child.stderr?.on("data", (chunk: Buffer) => { output += chunk.toString(); });
    for (let i = 0; i < 1_200 && !/✓ manager up/.test(output) && child.exitCode === null; i++) await sleep(100);
    must(`J: manager ${label} is up`, /✓ manager up/.test(output), output.slice(-600));
    twoIds.push(loadOrCreateRemoteManagerIdentity(cellRoot, space).instanceId);
  }
  const callerRoot = scratch("caller-root"), callerHome = scratch("caller-home");
  mkdirSync(join(callerRoot, ".cotal"), { recursive: true });
  const callerDir = userAuthStateDir(callerRoot, space);
  mkdirSync(callerDir, { recursive: true, mode: 0o700 });
  const sentinelCredsPath = join(callerDir, "sentinel.creds");
  writeFileSync(sentinelCredsPath, callout!.sentinelCreds, { mode: 0o600 });
  recordMesh({ space, server: trustServer, root: callerRoot, mode: "user", userAuth: { ...trustUserAuth, sentinelCredsPath }, policy: { events: "required" }, origin: "manual", ts: new Date().toISOString() });
  cpSync(trustHome, callerHome, { recursive: true });
  const caller = (...args: string[]) => new Promise<{ code: number | null; out: string; err: string }>((resolveRun) => {
    const child = spawnProc(tsxBin, [cliBin, ...args], { cwd: callerRoot, env: childHomeEnv(callerHome), stdio: ["ignore", "pipe", "pipe"] });
    kids.push(child);
    let out = "", err = "";
    child.stdout?.on("data", (chunk: Buffer) => { out += chunk.toString(); });
    child.stderr?.on("data", (chunk: Buffer) => { err += chunk.toString(); });
    child.on("close", (code) => resolveRun({ code, out, err }));
  });
  // A command run on a terminal, with `keys` typed once `until` shows, or with nothing typed.
  const inTerminal = async (args: string[], until: RegExp | undefined, keys: string | undefined, extra: Record<string, string> = {}) => {
    const env = Object.fromEntries(Object.entries({ ...childHomeEnv(callerHome), TERM: "xterm-256color", ...extra }).filter((entry): entry is [string, string] => entry[1] !== undefined));
    const pty = cotalPty(args, { cwd: callerRoot, env });
    let raw = "", code: number | undefined;
    pty.onData((data) => { raw += data; });
    pty.onExit((e) => { code = e.exitCode; });
    for (let i = 0; i < 600 && code === undefined && until !== undefined && !until.test(clean(raw)); i++) await sleep(100);
    if (keys !== undefined && code === undefined) pty.write(keys);
    for (let i = 0; i < 600 && code === undefined; i++) await sleep(100);
    if (code === undefined) pty.kill();
    return { code, out: clean(raw) };
  };
  // An unpinned ps asks nothing. It reads each live manager the exchange names, each through its own
  // one-instance view, and lists each under its own header with the host its presence reports. The
  // earlier cells' registrations do not answer, so they are listed as silent and only they make the
  // read partial.
  const psJson = await caller("ps", "--space", space, "--json");
  let psDoc: { target?: { scope?: string }; result?: { managers?: { instanceId: string; state: string; reportedHost?: string }[] } } | undefined;
  try { psDoc = JSON.parse(psJson.out); } catch { /* the cell below reports the output */ }
  const answers = new Map((psDoc?.result?.managers ?? []).map((m) => [m.instanceId, m]));
  const others = [...answers.keys()].filter((id) => !twoIds.includes(id));
  ok("J: an unpinned ps --json with several live managers reads each of them, with the host its presence reports",
    twoIds.length === 2 && twoIds.every((id) => answers.get(id)?.state === "answered" && answers.get(id)?.reportedHost === hostname()) && psDoc?.target?.scope === "your-managers", { twoIds, code: psJson.code, out: psJson.out.slice(-1500), err: psJson.err.slice(-900) });
  ok("J: a registration that does not answer is listed as silent, and only that makes the read partial",
    others.every((id) => answers.get(id)?.state === "silent") && psJson.code === (others.length ? 4 : 0), { code: psJson.code, others: others.map((id) => answers.get(id)) });
  const ps = await caller("ps", "--space", space);
  ok("J: the human ps lists each manager under its own header, and no refusal",
    ps.code === psJson.code && twoIds.every((id) => ps.out.includes(`manager ${id} · reports host ${hostname()}`)) && !/PERMISSION_DENIED|Which one/.test(ps.out + ps.err), { code: ps.code, out: ps.out.slice(-1500), err: ps.err.slice(-900) });
  const psTerminal = await inTerminal(["ps", "--space", space], undefined, undefined);
  ok("J: on a terminal an unpinned ps asks nothing and lists each manager",
    psTerminal.code === psJson.code && !/Which one should run this/.test(psTerminal.out) && twoIds.every((id) => psTerminal.out.includes(`manager ${id}`)), psTerminal.out.slice(-1500));
  const pinned = await caller("ps", "--space", space, "--on", "j-one");
  ok("J: ps --on <name> is answered by the manager started with that name", pinned.code === 0, pinned);
  const who = await caller("who", "--all", "--space", space);
  ok("J: who --all shows that manager by its name, partial only for a registration that does not answer",
    who.code === (others.length ? 4 : 0) && who.out.includes("manager j-one"), { code: who.code, out: who.out.slice(-900), err: who.err.slice(-600) });

  // The Next names each of your managers that did not answer by instance id, in ps and in who, so the
  // registration a manager left behind can be told apart from the managers that answer.
  const remedyOf = (out: string): string => { try { return (JSON.parse(out) as { error?: { remedy?: string } }).error?.remedy ?? ""; } catch { return ""; } };
  ok("J: ps names each manager that did not answer in its Next", others.length > 0 && others.every((id) => remedyOf(psJson.out).includes(id)) && !twoIds.some((id) => remedyOf(psJson.out).includes(id)), remedyOf(psJson.out));
  const whoJson = await caller("who", "--all", "--space", space, "--json");
  ok("J: who names them in its Next too", whoJson.code === 4 && others.every((id) => remedyOf(whoJson.out).includes(id)), remedyOf(whoJson.out));

  // A launch needs one manager, so a detached spawn with no `--on` refuses among several live ones.
  // The refusal lists each by name with the host its presence reports, and its Next runs the caller's
  // own command again with `--on` for each. On a terminal it asks instead, most recent first.
  const launch = await caller("spawn", "idle", "-d", "--space", space);
  ok("J: an unpinned detached spawn with several live managers refuses as PERMISSION_DENIED, exit 2",
    launch.code === 2 && /Code:\s+PERMISSION_DENIED/.test(launch.err) && /\d+ of your managers are live/.test(launch.err), launch);
  const rows = new Map([...(launch.err.split("Live managers")[1] ?? "").matchAll(/^\s+(\S+)\s+([a-z0-9]{26,32})\s+(\S+)\s/gm)].map((m) => [m[2]!, { name: m[1]!, host: m[3]! }]));
  ok("J: the refusal lists each of its live managers on its own row, by name, with the host its presence reports",
    twoIds.every((id) => rows.get(id)?.host === hostname()) && rows.get(twoIds[0]!)?.name === "j-one" && rows.get(twoIds[1]!)?.name === `${hostname()}/pty`, { twoIds, err: launch.err.slice(-900) });
  ok("J: its Next reruns the caller's own spawn on each of them, by the name or <host>/<runtime> that picks it, otherwise by instance id",
    launch.err.includes(`spawn idle -d --space ${space} --on j-one`) && [`${hostname()}/pty`, twoIds[1]].some((selector) => launch.err.includes(`spawn idle -d --space ${space} --on ${selector}`)), launch.err.slice(-600));
  const scripted = await inTerminal(["spawn", "idle", "-d", "--space", space], undefined, undefined, { COTAL_NO_PROMPT: "1" });
  ok("J: with COTAL_NO_PROMPT=1 the terminal is not asked and the refusal stands",
    scripted.code === 2 && /of your managers are live, and this command needs exactly one of them/.test(scripted.out) && !/Which one should run this/.test(scripted.out), scripted.out.slice(-900));

  // On a terminal the same launch asks which manager, and Enter takes the most recently started.
  const picked = await inTerminal(["spawn", "idle", "-d", "--space", space], /Which one should run this/, "\r");
  ok("J: on a terminal, an unpinned detached spawn asks which of the live managers should run it, marking the most recent",
    /\d+ of your managers are live\. Which one should run this\?/.test(picked.out) && picked.out.includes("most recent"), picked.out.slice(-1200));
  ok("J: Enter runs it on the most recently started manager, and a receipt names that manager",
    new RegExp(`Manager chosen[\\s\\S]*Instance:\\s+${twoIds[1]}`).test(picked.out), picked);
  // A bare spawn on a terminal asks where the agent runs, with this terminal first and the default,
  // and Ctrl-C does nothing. A launch pinned to a manager whose presence reports this host asks no
  // folder; it is refused for the persona its catalog lacks, so nothing is launched.
  const place = await inTerminal(["spawn", "--space", space], /Where should the agent run/, "\x03");
  ok("J: on a terminal, a bare spawn asks where the agent runs, with this terminal first and the managers after it",
    /\d+ of your managers are live\. Where should the agent run\?/.test(place.out) && /This terminal[\s\S]*j-one/.test(place.out), place.out.slice(-1200));
  ok("J: cancelling that question does nothing and exits 0", place.code === 0 && place.out.includes("nothing was done - no place was chosen"), place);
  const local = await inTerminal(["spawn", "-d", "--space", space, "--on", "j-one"], /Request refused|Which folder/, undefined);
  ok("J: a launch pinned to a manager whose presence reports this host asks no folder",
    local.code === 2 && /Managed launch/.test(local.out) && !/Which folder/.test(local.out), local.out.slice(-900));

  // L: with the space selected by `cotal use`, a bare `cotal supervise` from a folder that neither
  // hosts nor registers it starts a manager for that space on the pty runtime, in the root the space
  // is registered at, and prints no deprecation line. Its own ps answers.
  const selected = await caller("use", space);
  must("L: the caller selects the space", selected.code === 0, selected);
  const elsewhere = scratch("bare-cwd");
  const bare = spawnProc(tsxBin, [cliBin, "supervise"], { cwd: elsewhere, env: childHomeEnv(callerHome), stdio: ["ignore", "pipe", "pipe"] });
  kids.push(bare);
  twoManagers.push(bare);
  let bareOut = "";
  bare.stdout?.on("data", (chunk: Buffer) => { bareOut += chunk.toString(); });
  bare.stderr?.on("data", (chunk: Buffer) => { bareOut += chunk.toString(); });
  for (let i = 0; i < 1_200 && !/✓ manager up/.test(bareOut) && bare.exitCode === null; i++) await sleep(100);
  ok("L: a bare supervise on the selected hosted space starts a manager there on the pty runtime, with no deprecation line",
    new RegExp(`✓ manager up \\(space ${space} · [^)]*pty\\)`).test(bareOut) && !/deprecated/.test(bareOut), bareOut.slice(-900));
  const bareId = /✓ manager up/.test(bareOut) ? loadOrCreateRemoteManagerIdentity(callerRoot, space).instanceId : undefined;
  const bareFolder = readdirSync(elsewhere);
  ok("L: it keeps its records in the space's registered root, not the folder it was started from", bareId !== undefined && bareFolder.length === 0, { bareId, bareFolder });
  const barePs = bareId === undefined ? undefined : await caller("ps", "--space", space, "--on", bareId);
  ok("L: ps --on that manager is answered", barePs?.code === 0 && /No managed agents/.test(barePs.out), barePs);

  // K: a managed spawn the host refuses at enrollment is refused, not unknown. The caller's grant no
  // longer carries admin, so the envelope walk applies, and the persona's role is not in its scope.
  // The narrowed grant keeps the row's lifecycle, which the live managers and the caller run under.
  // The fixture connector is installed into J1's own extension prefix, as `cotal ext add` would;
  // the manager imports it at the spawn, and it is never launched.
  grantActor(hostDir, { owner, actor: "cli", lifecycleUid: jGrant.lifecycleUid, scope: ["spawn", "supervise"], allowSubscribe: ["general"], allowPublish: ["general"] });
  const probeExt = join(j1Home, "xdg", "cotal", "extensions");
  const probePkg = join(probeExt, "node_modules", "@fixture", "probe-connector");
  mkdirSync(probePkg, { recursive: true });
  writeFileSync(join(probePkg, "package.json"), JSON.stringify({ name: "@fixture/probe-connector", version: "1.0.0", type: "module", main: "index.js", peerDependencies: { "@cotal-ai/core": "*" } }));
  writeFileSync(join(probePkg, "index.js"), 'import { eventChannel, registry } from "@cotal-ai/core";\nregistry.register({ kind: "connector", name: "probe", requires: ["node"], eventChannel, buildLaunch: () => { throw new Error("the probe connector is never launched"); } });\n');
  writeFileSync(join(probeExt, "extensions.json"), JSON.stringify({ extensions: [{ pkg: "@fixture/probe-connector", version: "1.0.0", spec: ".", provides: [{ kind: "connector", name: "probe" }], commands: [], connectors: [{ name: "probe", requires: ["node"] }] }] }));
  mkdirSync(join(j1Root, ".cotal", "agents"), { recursive: true });
  writeFileSync(join(j1Root, ".cotal", "agents", "roled.md"), "---\nname: roled\nagent: probe\nrole: secretrole\n---\nNever launched: its role is outside the grant.\n");
  const refused = await caller("spawn", "roled", "--detach", "--space", space, "--on", "j-one");
  ok("K: a spawn whose enrollment the host refuses is refused as PERMISSION_DENIED, exit 2, with the host's reason",
    refused.code === 2 && /Outcome:\s+refused/.test(refused.err) && /Code:\s+PERMISSION_DENIED/.test(refused.err) && /would exceed its spawner's grant/.test(refused.err), refused.err.slice(-900));
  const staged = readdirSync(join(j1Root, ".cotal"), { recursive: true }).map(String).filter((path) => basename(path).startsWith("roled.") && path !== join("agents", "roled.md"));
  ok("K: and no secret staged for that agent remains under the manager's root", staged.length === 0, staged);
  for (const child of twoManagers) child.kill("SIGTERM");
  await Promise.all(twoManagers.map((child) => awaitExit(child, 15_000)));
  // With none of the owner's managers answering, ps lists the agents presence reports, read-only, and
  // exits 0. The registrations the exchange still counts do not answer.
  const none = await caller("ps", "--space", space);
  ok("J: with no manager answering, ps lists the agents presence shows, says so, and exits 0",
    none.code === 0 && /No manager answered/.test(none.out) && none.out.includes("cotal supervise") && !/PERMISSION_DENIED|Authorization Violation|timeout/i.test(none.out + none.err), none);

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
