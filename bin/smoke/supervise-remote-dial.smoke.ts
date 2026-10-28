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
 *      `stop` and `attach` naming an agent that one manager runs act there and ask nothing; a name
 *      no answering manager runs is asked about among the managers that did not answer only, and
 *      `--json` refuses with the command again on each of them instead of asking.
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
const { authDir, findCotalRoot, loadManagerInstanceIdentity, putSpaceAuth, recordMesh, saveSpaceAuth, userAuthStateDir, workspaceSecretStore } = await import("@cotal-ai/workspace");
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
  let j1Root = "", j1Home = "", j2Root = "", j2Home = "";
  for (const label of ["J1", "J2"]) {
    const cellRoot = scratch("two-root"), cellHome = scratch("two-home");
    if (label === "J1") [j1Root, j1Home] = [cellRoot, cellHome];
    else [j2Root, j2Home] = [cellRoot, cellHome];
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

  // A command that names one agent finds the manager that runs it before it asks anything. Two idle
  // processes run on J2 only, through a connector installed in J2's own extension prefix as
  // `cotal ext add` would; they never join, and J2 keeps them running. The earlier cells'
  // registrations are counted live and do not answer.
  const idlerExt = join(j2Home, "xdg", "cotal", "extensions");
  const idlerPkg = join(idlerExt, "node_modules", "@fixture", "idler-connector");
  mkdirSync(idlerPkg, { recursive: true });
  writeFileSync(join(idlerPkg, "package.json"), JSON.stringify({ name: "@fixture/idler-connector", version: "1.0.0", type: "module", main: "index.js", peerDependencies: { "@cotal-ai/core": "*" } }));
  writeFileSync(join(idlerPkg, "index.js"), 'import { eventChannel, registry } from "@cotal-ai/core";\nregistry.register({ kind: "connector", name: "idler", requires: ["node"], eventChannel, readinessTimeoutMs: 1500, buildLaunch: () => ({ command: "node", args: ["-e", "setInterval(() => {}, 1 << 30)"], env: { PATH: process.env.PATH ?? "" } }) });\n');
  writeFileSync(join(idlerExt, "extensions.json"), JSON.stringify({ extensions: [{ pkg: "@fixture/idler-connector", version: "1.0.0", spec: ".", provides: [{ kind: "connector", name: "idler" }], commands: [], connectors: [{ name: "idler", requires: ["node"] }] }] }));
  mkdirSync(join(j2Root, ".cotal", "agents"), { recursive: true });
  for (const seat of ["held", "held2"]) {
    writeFileSync(join(j2Root, ".cotal", "agents", `${seat}.md`), `---\nname: ${seat}\nagent: idler\n---\nAn idle process.\n`);
    const launched = await caller("spawn", seat, "-d", "--space", space, "--on", twoIds[1]!);
    must(`J: ${seat} runs on J2 only`, launched.code === 0, { code: launched.code, err: launched.err.slice(-600) });
  }
  const envelope = (out: string): { target?: { managerInstanceId?: string }; error?: { code?: string; message?: string; remedy?: string } } | undefined => { try { return JSON.parse(out); } catch { return undefined; } };
  const heldAttach = await inTerminal(["attach", "held", "--space", space], /attached to held|Which one should run this/, "\x1d");
  ok("J: on a terminal, attach <name> held by one manager attaches there and asks nothing",
    /attached to held/.test(heldAttach.out) && !/Which one should run this/.test(heldAttach.out) && heldAttach.code === 0, heldAttach.out.slice(-900));
  const ghostAsked = await inTerminal(["stop", "ghost", "--space", space], /Which manager that did not answer should run this|Which one should run this/, "\x03");
  ok("J: on a terminal, stop <name> that no answering manager holds asks only among the managers that did not answer, saying so",
    /"ghost" was not found on the 2 managers that answered\. Which manager that did not answer should run this\?/.test(ghostAsked.out)
      && others.every((id) => ghostAsked.out.includes(id)) && !twoIds.some((id) => ghostAsked.out.includes(id)) && !ghostAsked.out.includes("j-one"), ghostAsked.out.slice(-1500));
  ok("J: cancelling it stops nothing and exits 0", ghostAsked.code === 0 && ghostAsked.out.includes("nothing was done - no manager was chosen"), ghostAsked.out.slice(-600));
  const ghostAttach = await inTerminal(["attach", "ghost", "--space", space], /Which manager that did not answer should run this|Which one should run this/, "\x03");
  ok("J: attach <name> asks the same question among the same managers",
    /"ghost" was not found on the 2 managers that answered/.test(ghostAttach.out) && others.every((id) => ghostAttach.out.includes(id)) && !twoIds.some((id) => ghostAttach.out.includes(id)) && ghostAttach.code === 0, ghostAttach.out.slice(-1200));
  const ghostJson = await inTerminal(["stop", "ghost", "--space", space, "--json"], undefined, undefined);
  const ghostDoc = envelope(ghostJson.out.slice(ghostJson.out.indexOf("{")));
  ok("J: stop <name> --json on a terminal asks nothing and refuses TARGET_UNAVAILABLE, exit 2, with a Next that pins --on each manager that did not answer",
    ghostJson.code === 2 && ghostDoc?.error?.code === "TARGET_UNAVAILABLE" && !/Which/.test(ghostJson.out)
      && others.every((id) => ghostDoc.error?.remedy?.includes(`--on ${id}`)) && !twoIds.some((id) => ghostDoc.error?.remedy?.includes(id)) && !ghostDoc.error?.remedy?.includes("j-one"), ghostJson.out.slice(-1200));
  const heldStop = await inTerminal(["stop", "held", "--space", space], /Agent stop acknowledged|Which one should run this|Code:/, undefined);
  ok("J: on a terminal, stop <name> held by one manager stops it there, asks nothing, and its receipt names that manager",
    heldStop.code === 0 && /Agent stop acknowledged/.test(heldStop.out) && new RegExp(`Manager:\\s+${twoIds[1]}`).test(heldStop.out) && !/Which one should run this|Manager chosen/.test(heldStop.out), heldStop.out.slice(-1200));
  const held2Json = await caller("stop", "held2", "--space", space, "--json");
  ok("J: stop <name> --json stops it on the manager that holds it, with that manager in target.managerInstanceId",
    held2Json.code === 0 && envelope(held2Json.out)?.target?.managerInstanceId === twoIds[1], { code: held2Json.code, out: held2Json.out.slice(-900), err: held2Json.err.slice(-600) });
  const heldGone = await caller("ps", "--space", space, "--on", twoIds[1]!);
  ok("J: both stops acted: J2 runs neither agent any more", heldGone.code === 0 && !/\bheld2?\b/.test(heldGone.out), heldGone.out.slice(-900));

  // L: with the space selected by `cotal use`, a bare `cotal supervise` from a folder that neither
  // hosts nor registers it starts a manager for that space on the pty runtime, in the root the space
  // is registered at, and prints the deprecation line that names `cotal manager start`. Its own ps
  // answers. The folder sits inside one that holds a space this home never registered, as a `cotal up`
  // in a parent such as the temp dir leaves it, and that space does not take the bare run.
  const selected = await caller("use", space);
  must("L: the caller selects the space", selected.code === 0, selected);
  // Every path under a folder, sorted, so two listings compare as one string.
  const listing = (dir: string): string => JSON.stringify(readdirSync(dir, { recursive: true }).map(String).sort());
  const hostingParent = scratch("hosting-parent");
  saveSpaceAuth(authDir(hostingParent), await createSpaceAuth("otherspace"));
  const elsewhere = join(hostingParent, "bare-cwd");
  mkdirSync(elsewhere);
  const parentBefore = listing(join(hostingParent, ".cotal"));
  const bare = spawnProc(tsxBin, [cliBin, "supervise"], { cwd: elsewhere, env: childHomeEnv(callerHome), stdio: ["ignore", "pipe", "pipe"] });
  kids.push(bare);
  twoManagers.push(bare);
  let bareOut = "";
  bare.stdout?.on("data", (chunk: Buffer) => { bareOut += chunk.toString(); });
  bare.stderr?.on("data", (chunk: Buffer) => { bareOut += chunk.toString(); });
  for (let i = 0; i < 1_200 && !/✓ manager up/.test(bareOut) && bare.exitCode === null; i++) await sleep(100);
  ok("L: a bare supervise on the selected hosted space starts a manager there on the pty runtime, and its deprecation line names cotal manager start",
    new RegExp(`✓ manager up \\(space ${space} · [^)]*pty\\)`).test(bareOut) && /! `cotal supervise` is deprecated[^\n]*Use `cotal manager start`/.test(bareOut), bareOut.slice(0, 900));
  const bareId = /✓ manager up/.test(bareOut) ? loadOrCreateRemoteManagerIdentity(callerRoot, space).instanceId : undefined;
  const bareFolder = readdirSync(elsewhere);
  const parentAfter = listing(join(hostingParent, ".cotal"));
  ok("L: it keeps its records in the space's registered root, not the folder it was started from or its parent's .cotal",
    bareId !== undefined && bareFolder.length === 0 && parentAfter === parentBefore, { bareId, bareFolder, parentBefore, parentAfter });
  const barePs = bareId === undefined ? undefined : await caller("ps", "--space", space, "--on", bareId);
  ok("L: ps --on that manager is answered", barePs?.code === 0 && /No managed agents/.test(barePs.out), barePs);

  // A command run from `cwd` under the Cotal home `home`. A manager stays up, so it is stopped once it
  // says so, and deregisters before the next start.
  const homeCli = (home: string, cwd: string, ...args: string[]) => new Promise<{ code: number | null; out: string }>((resolveRun) => {
    const child = spawnProc(tsxBin, [cliBin, ...args], { cwd, env: childHomeEnv(home), stdio: ["ignore", "pipe", "pipe"] });
    kids.push(child);
    let out = "";
    child.stdout?.on("data", (chunk: Buffer) => { out += chunk.toString(); });
    child.stderr?.on("data", (chunk: Buffer) => { out += chunk.toString(); });
    const stop = (): void => { child.kill("SIGTERM"); setTimeout(() => child.kill("SIGKILL"), 15_000).unref(); };
    const up = setInterval(() => { if (/✓ manager up/.test(out)) { clearInterval(up); stop(); } }, 100);
    const cap = setTimeout(stop, 120_000);
    child.on("close", (code) => { clearInterval(up); clearTimeout(cap); resolveRun({ code, out }); });
  });

  // N: with nothing selected, a bare `cotal supervise` in a folder that holds a prepared space is
  // refused for that space as not started, with the `cotal up` that starts it, as `--space` is. It
  // names no space nobody made and prints no log line.
  const preparedHome = scratch("prepared-home"), preparedRoot = scratch("prepared-root");
  const preparedSpace = "preparedsp";
  const prepared = await homeCli(preparedHome, preparedRoot, "space", "create", preparedSpace, "--root", preparedRoot);
  const noSelection = await homeCli(preparedHome, preparedRoot, "use");
  must("N: the folder prepares a space, and nothing is selected", prepared.code === 0 && /no space is selected/.test(noSelection.out), { prepared, noSelection });
  const unselected = await homeCli(preparedHome, preparedRoot, "supervise");
  ok("N: a bare supervise there is refused as not started for the folder's prepared space, with the cotal up that starts it",
    unselected.code === 2 && unselected.out.includes(`"${preparedSpace}" is prepared but not started, so no manager started`) && /Code:\s+TARGET_UNAVAILABLE/.test(unselected.out)
      && unselected.out.includes(`start it with \`cotal up\` in ${preparedRoot}`) && !/'main'|"main"|\d{4}-\d\d-\d\dT\d\d:\d\d/.test(unselected.out), unselected.out.slice(-900));

  // M: a space this home hosts locally, selected by `cotal use`: its root holds the signer and the TCP
  // broker trusts it. A bare `cotal supervise` from an empty folder, and from an empty folder under a
  // parent whose `.cotal` holds an unrelated space, starts the manager in the hosting root with that
  // root's instance, as `cotal manager start` does. Neither folder nor the parent's `.cotal` changes.
  // Each run hosts the space from its own root, so each start is its instance's first registration: a
  // second start of one instance re-registers it, which needs a delivery daemon this rig does not run.
  const localRun = async (cwd: string): Promise<{ out: string; hostedId: string | undefined }> => {
    const localRoot = scratch("local-root"), localHome = scratch("local-home");
    saveSpaceAuth(authDir(localRoot), auth);
    const suiteHome = process.env.COTAL_HOME;
    process.env.COTAL_HOME = localHome;
    try { recordMesh({ space, server: tcpServer, root: localRoot, mode: "auth", ts: new Date().toISOString() }); }
    finally { process.env.COTAL_HOME = suiteHome; }
    const localSelected = await homeCli(localHome, localRoot, "use", space);
    must("M: the local home selects the space", localSelected.code === 0, localSelected);
    const { out } = await homeCli(localHome, cwd, "supervise");
    return { out, hostedId: loadManagerInstanceIdentity(localRoot, space)?.instanceId };
  };
  const localEmpty = scratch("local-empty");
  const localParent = scratch("local-parent");
  saveSpaceAuth(authDir(localParent), await createSpaceAuth("otherspace"));
  const localNested = join(localParent, "bare-cwd");
  mkdirSync(localNested);
  const localBefore = [listing(localEmpty), listing(localNested), listing(join(localParent, ".cotal"))];
  const emptyRun = await localRun(localEmpty);
  const nestedRun = await localRun(localNested);
  const localAfter = [listing(localEmpty), listing(localNested), listing(join(localParent, ".cotal"))];
  const servedId = (out: string): string | undefined => /manager service endpoint registered: manager\/(\S+)/.exec(out)?.[1];
  const upHere = new RegExp(`✓ manager up \\(space ${space} · [^)]*pty\\)`);
  ok("M: a bare supervise from an empty folder starts the manager of the hosted space", upHere.test(emptyRun.out), emptyRun.out.slice(-900));
  ok("M: and from an empty folder under a parent that holds an unrelated space", upHere.test(nestedRun.out), nestedRun.out.slice(-900));
  ok("M: each serves the instance its hosting root records",
    [emptyRun, nestedRun].every((run) => run.hostedId !== undefined && servedId(run.out) === run.hostedId),
    [emptyRun, nestedRun].map((run) => ({ hosted: run.hostedId, served: servedId(run.out) })));
  ok("M: neither folder nor the parent's .cotal changed", JSON.stringify(localAfter) === JSON.stringify(localBefore), { localBefore, localAfter });

  // O: `cotal supervise --space` runs in this folder, so for a space this home hosts in another root
  // it is refused before it connects from an empty folder, and from an empty folder under a parent
  // whose `.cotal` holds an unrelated space, because neither holds a signer for it. The refusal names
  // the root that hosts the space. Neither folder, the parent's `.cotal` nor the hosting root changes.
  const namedRoot = scratch("named-root"), namedHome = scratch("named-home");
  saveSpaceAuth(authDir(namedRoot), auth);
  const previousHome = process.env.COTAL_HOME;
  process.env.COTAL_HOME = namedHome;
  try { recordMesh({ space, server: tcpServer, root: namedRoot, mode: "auth", ts: new Date().toISOString() }); }
  finally { process.env.COTAL_HOME = previousHome; }
  const namedEmpty = scratch("named-empty");
  const namedParent = scratch("named-parent");
  saveSpaceAuth(authDir(namedParent), await createSpaceAuth("otherspace"));
  const namedNested = join(namedParent, "bare-cwd");
  mkdirSync(namedNested);
  const namedListings = (): string[] => [listing(namedEmpty), listing(namedNested), listing(join(namedParent, ".cotal")), listing(join(namedRoot, ".cotal"))];
  const namedBefore = namedListings();
  const namedRuns = [
    { shape: "an empty folder", root: namedEmpty, run: await homeCli(namedHome, namedEmpty, "supervise", "--space", space) },
    { shape: "an empty folder under an unrelated parent", root: namedParent, run: await homeCli(namedHome, namedNested, "supervise", "--space", space) },
  ];
  const namedAfter = namedListings();
  for (const { shape, root: folderRoot, run } of namedRuns)
    ok(`O: supervise --space from ${shape} is refused PERMISSION_DENIED before it connects, naming the root that hosts the space`,
      run.code === 2 && /Code:\s+PERMISSION_DENIED/.test(run.out) && run.out.includes(`this folder holds no signer for space "${space}" (${folderRoot}), so no manager started`)
        && run.out.includes(`\`cd ${namedRoot} && cotal manager start\``) && !/manager up|Native detail/.test(run.out), run.out.slice(-900));
  ok("O: neither folder, the parent's .cotal nor the hosting root changed", JSON.stringify(namedAfter) === JSON.stringify(namedBefore), { namedBefore, namedAfter });

  // P: in an empty folder with nothing selected and no `.cotal` above it, a bare `cotal supervise` is
  // refused because the folder holds no space, with the commands that name a space hosted elsewhere or
  // host one here. It names no `main` and prints no log line. `supervise` takes no `--json`, so that run
  // is refused as an unknown option. Neither run writes anything in the folder.
  const nothingHome = scratch("nothing-home"), nothingCwd = scratch("nothing-cwd");
  const nothingSelected = await homeCli(nothingHome, nothingCwd, "use");
  must("P: nothing is selected, and no folder above the empty one holds a .cotal",
    /no space is selected/.test(nothingSelected.out) && findCotalRoot(nothingCwd) === resolve(nothingCwd), { use: nothingSelected.out, root: findCotalRoot(nothingCwd) });
  const nothingBefore = listing(nothingCwd);
  const nothing = await homeCli(nothingHome, nothingCwd, "supervise");
  ok("P: a bare supervise there is refused TARGET_NOT_FOUND, exit 2, saying the folder holds no space, with the commands that name or host one",
    nothing.code === 2 && /Code:\s+TARGET_NOT_FOUND/.test(nothing.out) && nothing.out.includes("this folder holds no space and none is selected, so no manager started")
      && nothing.out.includes("for a space hosted elsewhere, run `cotal supervise --space <name>` or select it with `cotal use <name>`; to host one here, run `cotal up`")
      && !/'main'|"main"|\d{4}-\d\d-\d\dT\d\d:\d\d/.test(nothing.out), nothing.out.slice(-900));
  const nothingJson = await homeCli(nothingHome, nothingCwd, "supervise", "--json");
  ok("P: supervise takes no --json, so that run is refused as an unknown option, exit 1",
    nothingJson.code === 1 && nothingJson.out.includes("Unknown option '--json'") && !/manager up|neither hosting/.test(nothingJson.out), nothingJson.out.slice(-900));
  ok("P: neither run wrote anything in the folder", listing(nothingCwd) === nothingBefore && nothingBefore === "[]", { nothingBefore, after: listing(nothingCwd) });

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
    none.code === 0 && /No manager answered/.test(none.out) && none.out.includes("cotal manager start") && !/PERMISSION_DENIED|Authorization Violation|timeout/i.test(none.out + none.err), none);

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
