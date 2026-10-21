/**
 * LIVE COMPONENT-HEALTH SMOKE (#758).
 *
 * Reproduction first: an endpoint holds and continuously renews a manager lease, writes the local
 * manager PID record, but never registers or serves the manager service.  The existing `cotal ps`
 * cannot distinguish that fixture from a broker with no manager-service registry: both fail with
 * the same service-registry / no-manager answer.  The new `cotal status --components` must instead
 * preserve the local component record and say `manager not-serving` with a non-zero exit distinct
 * from a truly absent manager.
 *
 * This is intentionally an OPEN mesh: it removes minting from the experiment so the only changed
 * variable is the component's own manager control surface.  The holder renews its real manager
 * lease against a real JetStream broker; it is not a hand-written fake of a status reply.  The
 * verdict regression cell separately registers a real status endpoint and serves a manager-shaped
 * foreign-owner reconciliation payload; the manager suite owns reconciliation-state generation.
 *
 * The dashboard cells are the exception. The shipped `web` service preset serves only a static-auth
 * target with a protected credential file, so those cells run on their own static-auth stack in a
 * second sandbox root and stop it before the open-mesh cells continue.
 *
 * Run: pnpm smoke:component-health
 */
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { jetstreamManager } from "@nats-io/jetstream";
import { Kvm } from "@nats-io/kv";
import { connect } from "@nats-io/transport-node";
import {
  CotalEndpoint,
  SERVICE_READY,
  VOID_SCHEMA,
  authorizeServeGrant,
  compileContract,
  contractArtifactCanonicalBytes,
  contractDigest,
  contractStoreContext,
  createEndpointStreams,
  deliveryBucket,
  endpointRegistrationBarrier,
  epAuthBucket,
  openRecordsBucket,
  provisionEndpointGateOpen,
  publishContractArtifact,
  registerServiceInstance,
  serveEndpoint,
  serveIssuanceGateKv,
  writeServiceStatus,
} from "@cotal-ai/core";
import { MANAGER_PIDFILE, WEB_PIDFILE, WEB_SESSION_FILE, canonicalLocalProcessPath, renewalRecordPath, writeRenewalRecord } from "@cotal-ai/workspace";
import { SMOKE_BROKER_TOKEN, freePort, recordSmokeSandbox, teardownOnSignal } from "@cotal-ai/smoke-kit";

const WT = resolve(import.meta.dirname, "..", "..", "..");
const CLI = join(WT, "bin", "cotal.ts");
const TSX = join(WT, "node_modules", ".bin", "tsx");
const HOLDER = join(import.meta.dirname, "component-health-holder.mjs");
const SPACE = "component-health";
const INSTANCE = "h".repeat(26);
const root = mkdtempSync(join(tmpdir(), `${SMOKE_BROKER_TOKEN}component-health-root-`));
const home = mkdtempSync(join(tmpdir(), "cotal-component-health-home-"));
const xdgConfigHome = join(home, "xdg");
const store = join(root, "jetstream");
// The dashboard's static-auth stack and its credential file. The credential stays outside both
// managed `.cotal` directories and COTAL_HOME, where an explicit credential export is refused.
const WEB_SPACE = "component-health-web";
const webRoot = mkdtempSync(join(tmpdir(), `${SMOKE_BROKER_TOKEN}component-health-web-root-`));
const credsDir = mkdtempSync(join(tmpdir(), "cotal-component-health-creds-"));
// `cotal up` and `cotal service start` below leave the stack and the dashboard in `webRoot` but
// outside the runner's process group, and a killed run never reaches `finally`, so the watchdog that
// recording starts is what stops them.
recordSmokeSandbox({ root, cotalHome: home, xdgConfigHome });
recordSmokeSandbox({ root: webRoot, cotalHome: home, xdgConfigHome });

let pass = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  assert.ok(cond, `${name}${extra === undefined ? "" : ` — ${JSON.stringify(extra)}`}`);
  pass++;
  console.log(`  ✓ ${name}`);
};
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const env = { ...process.env };
for (const key of Object.keys(env)) if (key.startsWith("COTAL_")) delete env[key];
env.COTAL_HOME = home;
env.XDG_CONFIG_HOME = xdgConfigHome;
env.COTAL_SKIP_CONNECTOR_SEED = "1";

async function portOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    const done = (open: boolean) => { socket.destroy(); resolve(open); };
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
    socket.setTimeout(250, () => done(false));
  });
}

function cli(...args: string[]) {
  return cliIn(root, args);
}

function cliIn(cwd: string, args: string[], timeout = 30_000) {
  return spawnSync(TSX, [CLI, ...args], { cwd, env, encoding: "utf8", timeout });
}

async function cliAsync(...args: string[]): Promise<{ status: number | null; stdout: string; stderr: string }> {
  const child = spawn(TSX, [CLI, ...args], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk) => { stdout += chunk; });
  child.stderr?.on("data", (chunk) => { stderr += chunk; });
  const status = await new Promise<number | null>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`CLI timed out: ${args.join(" ")}`));
    }, 30_000);
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("exit", (code) => { clearTimeout(timer); resolve(code); });
  });
  return { status, stdout, stderr };
}

/** The old-surface fact under comparison, excluding unrelated process-wide advisories whose
 * presence depends on whether this particular subprocess crossed an approximate CPU threshold. */
function oldManagerAnswer(text: string): string | undefined {
  return text
    .replace(/\x1b\[[0-9;]*m/g, "")
    .split("\n")
    .map((line) => line.trim())
    .find((line) => /failed-precondition: the service registry for "manager"|no manager reachable/i.test(line));
}

async function waitForFile(path: string): Promise<void> {
  for (let i = 0; i < 100 && !existsSync(path); i++) await sleep(50);
  assert.ok(existsSync(path), `fixture never wrote ${path}`);
}

async function stop(target: ChildProcess | undefined): Promise<void> {
  const pid = target?.pid;
  if (!pid) return;
  try { process.kill(pid, "SIGTERM"); } catch { /* already gone */ }
  for (let i = 0; i < 30; i++) {
    try { process.kill(pid, 0); } catch { return; }
    await sleep(50);
  }
  try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
}

async function writeDeliveryHolder(): Promise<ChildProcess> {
  const script = join(WT, "implementations", "cli", "smoke", "component-health-delivery-holder.mjs");
  const child = spawn(process.execPath, [script, server, SPACE], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
  child.stderr?.on("data", (chunk) => process.stderr.write(`delivery fixture: ${chunk}`));
  assert.ok(child.pid, "delivery holder received a pid");
  writeFileSync(join(root, ".cotal", "delivery.pid"), String(child.pid));
  await sleep(300);
  return child;
}

const SERVED_INSTANCE = "s".repeat(26);
const FOREIGN_INSTANCE = "f".repeat(26);
const FOREIGN_REMEDY = "the owning manager must reconcile or an operator must perform an explicit CAS takeover";
const FOREIGN_FAILURE_FACT = `static alias=foreign-owned phase=active disposition=refused remedy=${FOREIGN_REMEDY}`;

async function serveManagerWithForeignRefusal(): Promise<{ close(): Promise<void> }> {
  const nc = await connect({ servers: server });
  const kvm = new Kvm(nc);
  await createEndpointStreams(await jetstreamManager(nc), kvm, SPACE);
  await kvm.create(deliveryBucket(SPACE), { ttl: 10_000 }).catch(async () => { await kvm.open(deliveryBucket(SPACE)); });

  const input = compileContract({ root: VOID_SCHEMA });
  const outputSchema = { type: "object" } as const;
  const output = compileContract({ root: outputSchema });
  const document = {
    urn: "ai.cotal.test.component-health-manager",
    revision: 1,
    attributes: [],
    events: [],
    commands: [{
      name: "status",
      class: "ephemeral" as const,
      targeted: false,
      capability: "manager.read",
      inputDigest: input.closureDigest,
      outputDigest: output.closureDigest,
    }],
  };
  const documentManifest = { v: 1 as const, root: contractDigest(document), members: [] as string[] };
  const artifacts = [
    VOID_SCHEMA,
    { v: 1 as const, root: contractDigest(VOID_SCHEMA), members: [] as string[] },
    outputSchema,
    { v: 1 as const, root: contractDigest(outputSchema), members: [] as string[] },
    document,
    documentManifest,
  ];
  const artifactIndex = new Map(artifacts.map((value) => [contractDigest(value), value]));
  const contractStore = await contractStoreContext(nc, SPACE);
  for (const value of artifactIndex.values())
    await publishContractArtifact(contractStore, contractArtifactCanonicalBytes(value));

  const recordsKv = await openRecordsBucket(nc, SPACE);
  const authKv = await kvm.open(epAuthBucket(SPACE));
  const authority = {
    authorize: (endpoint: string, owner: string) => ({ authorized: endpoint === "manager" && owner === "local", revision: 0 }),
  };
  await provisionEndpointGateOpen(authKv, {
    endpoint: "manager",
    instanceId: SERVED_INSTANCE,
    principal: "local.mgr",
  });
  const barrier = endpointRegistrationBarrier(authKv, SPACE, {
    endpoint: "manager",
    instanceId: SERVED_INSTANCE,
    opId: "r".repeat(26),
  });
  const { registrationRevision } = await registerServiceInstance(recordsKv, {
    space: SPACE,
    spec: { endpoint: "manager", owner: "local", clusterDigests: [contractDigest(documentManifest)], protocol: { v: 1 } },
    instanceId: SERVED_INSTANCE,
    registrant: { owner: "local" },
    authority,
    barrier,
    readClusterArtifact: (digest) => artifactIndex.get(digest),
  });
  const fence = serveIssuanceGateKv(authKv, SPACE, { endpoint: "manager", instanceId: SERVED_INSTANCE });
  const observed = await fence.observe();
  assert.ok(observed, "manager service issuance gate exists after registration");
  const grant = await authorizeServeGrant(recordsKv, {
    space: SPACE,
    endpoint: "manager",
    instanceId: SERVED_INSTANCE,
    epoch: observed.processEpoch,
    holder: { owner: "local" },
    authority,
    readProcessEpoch: () => observed.processEpoch,
    readClusterArtifact: (digest) => artifactIndex.get(digest),
  });
  await writeServiceStatus(recordsKv, {
    endpoint: "manager",
    instanceId: SERVED_INSTANCE,
    epoch: observed.processEpoch,
    status: { state: SERVICE_READY, epoch: observed.processEpoch, observedSpecRevision: registrationRevision },
    readProcessEpoch: () => observed.processEpoch,
  });
  const service = serveEndpoint(nc, SPACE, grant, [{
    command: "status",
    contract: { input, output },
    handler: () => ({
      instanceId: SERVED_INSTANCE,
      runtime: "pty",
      custody: "legacy",
      agentCount: 0,
      uptimeMs: 1,
      connectors: [],
      classSpawn: true,
      staticReconciliation: {
        state: "failed",
        failures: [{
          alias: "foreign-owned",
          actor: "a".repeat(26),
          lifecycleUid: "u".repeat(26),
          phase: "active",
          attempts: 1,
          maxAttempts: 3,
          disposition: "refused",
          lastError: `the durable slot belongs to manager instance ${FOREIGN_INSTANCE}, not ${SERVED_INSTANCE}`,
          remedy: FOREIGN_REMEDY,
        }],
      },
    }),
  }], { public: true });
  await nc.flush();

  const health = new CotalEndpoint({
    space: SPACE,
    servers: server,
    channels: [],
    consume: false,
    registerPresence: false,
    watchPresence: false,
    watchChannels: false,
    card: { name: "component-health-serving-manager", kind: "endpoint" },
  });
  health.on("error", (error) => console.error(`serving fixture endpoint error: ${error.message}`));
  await health.start();
  const managerLease = {
    holder: health.ref().id,
    instanceId: SERVED_INSTANCE,
    runtime: "pty",
    root,
    pid: process.pid,
  };
  const managerLeaseRevision = await health.acquireManagerLease(managerLease);
  // The READY flip moves the revision, and release is a compare-and-swap against the revision this
  // endpoint last owned, so carry the one markReady returned, not the one acquire did.
  const deliveryLeaseRevision = await health.markDeliveryLeaseReady(0, await health.acquireDeliveryLease(0));
  writeFileSync(join(root, ".cotal", "manager.pid"), String(process.pid));
  writeFileSync(join(root, ".cotal", "delivery.pid"), String(process.pid));
  // The per-space renewal record, through the workspace seam (#1850): the root-only spelling
  // this fixture used to write is a pre-per-space leftover that `status` deliberately does not read.
  writeRenewalRecord(root, SPACE, {
    ts: "2026-09-06T00:00:00.000Z", owner: "fixture", results: [], adoption: { ok: true },
  });

  return {
    close: async () => {
      await service.stop();
      await health.releaseDeliveryLease(0, deliveryLeaseRevision);
      await health.releaseManagerLease(SERVED_INSTANCE, managerLeaseRevision);
      await health.stop().catch(() => {});
      await nc.drain().catch(() => nc.close());
    },
  };
}

const port = await freePort();
const server = `nats://127.0.0.1:${port}`;
let broker: ChildProcess | undefined;
let holder: ChildProcess | undefined;
let webStack = false;
let webService = false;
let delivery: ChildProcess | undefined;
let servingManager: { close(): Promise<void> } | undefined;
try {
  broker = spawn("nats-server", ["-a", "127.0.0.1", "-p", String(port), "-js", "-sd", store], { stdio: "ignore" });
  teardownOnSignal(broker);
  for (let i = 0; i < 100 && !(await portOpen(port)); i++) await sleep(50);
  check("fixture broker started", await portOpen(port));

  // Register an explicit OPEN target so the status command operates on this exact isolated root.
  const add = cli("meshes", "add", SPACE, "--server", server, "--root", root, "--mode", "open");
  check("fixture mesh registered", add.status === 0, `${add.stdout}${add.stderr}`);

  const ready = join(root, "holder.json");
  holder = spawn(TSX, [HOLDER, server, SPACE, INSTANCE], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
  holder.stdout?.on("data", (chunk) => {
    if (!existsSync(ready)) writeFileSync(ready, chunk.toString("utf8"));
  });
  await waitForFile(ready);
  const held = JSON.parse(readFileSync(ready, "utf8")) as { pid: number };
  // The space-keyed record a current start writes, so the folder's process scope is this space.
  const managerRecord = canonicalLocalProcessPath(MANAGER_PIDFILE, { root, space: SPACE });
  writeFileSync(managerRecord, String(held.pid));

  // RED FIRST — the old surface has no component distinction. It only sees the absent manager
  // service registry, the same answer it will give when no manager process/lease exists at all.
  const oldPresent = cli("ps", "--space", SPACE, "--server", server);
  const oldPresentText = `${oldPresent.stdout}${oldPresent.stderr}`;
  check("REPRO: existing ps cannot identify the live lease-holder as a component",
    oldPresent.status !== 0 && /service registry.*stream not found|no manager reachable/i.test(oldPresentText), oldPresentText);

  const present = cli("status", "--components", "--space", SPACE, "--server", server);
  const presentText = `${present.stdout}${present.stderr}`;
  check("live lease-holder that never serves exits present-not-serving (2)", present.status === 2, presentText);
  check("manager row names not-serving, its PID, and its unreported static reconciliation",
    /manager\s+not-serving/.test(presentText) && presentText.includes(`pid ${held.pid}`) && presentText.includes("static reconciliation not reported by this manager build"), presentText);
  check("manager row names the lease holder rather than substituting service success",
    /lease holder local\./.test(presentText) && presentText.includes("serve no answer"), presentText);

  // #2073, bare status (no `--components`). Still the OPEN mesh from the file header: it removes
  // minting from the experiment so the only changed variable is the component's own control
  // surface. Bare status now probes a live manager pid's service endpoint once before printing the
  // row, so the same holder fixture (a real renewed lease, a real pidfile, no served endpoint) must
  // read `not serving` here too, not just behind `--components`. The static-mesh `--components`
  // refusal this issue also fixes (`componentEp`'s lifecycleUid mint) has no credential to mint on
  // this open mesh, so it is NOT graded here; the hand test's step 2 is its check. Do not "simplify"
  // this block into `--components` later: the open-mesh cells above already cover that surface, and
  // the whole point of this block is the BARE path's own probe.
  const bare = cli("status", "--space", SPACE, "--server", server);
  const bareText = `${bare.stdout}${bare.stderr}`.replace(/\x1b\[[0-9;]*m/g, "");
  check("bare status says not serving for a live pid whose rail does not answer (#2073)",
    /Manager\s+not serving \(pid \d+\)/.test(bareText) && bareText.includes("service endpoint not answering") && !/Manager\s+running \(pid/.test(bareText), bareText);
  check("bare status keeps exit 0 when the manager is not serving (#2073)", bare.status === 0, bareText);

  await stop(holder);
  holder = undefined;
  rmSync(managerRecord, { force: true });
  // The manager lease has a 10s TTL. The absent control must wait for its real expiry: deleting
  // the PID record alone would still be a present lease-holder case, not an absent component.
  await sleep(10_500);

  const oldAbsent = cli("ps", "--space", SPACE, "--server", server);
  const oldAbsentText = `${oldAbsent.stdout}${oldAbsent.stderr}`;
  check("REPRO control: existing ps gives the same manager-service answer when absent",
    oldAbsent.status !== 0 && /service registry.*stream not found|no manager reachable/i.test(oldAbsentText), oldAbsentText);
  const oldPresentAnswer = oldManagerAnswer(oldPresentText);
  const oldAbsentAnswer = oldManagerAnswer(oldAbsentText);
  check(
    "REPRO is indistinguishable on the old surface",
    oldPresent.status === oldAbsent.status &&
      oldPresentAnswer !== undefined &&
      oldPresentAnswer === oldAbsentAnswer,
    { oldPresentAnswer, oldAbsentAnswer, oldPresentText, oldAbsentText },
  );

  const absent = cli("status", "--components", "--space", SPACE, "--server", server);
  const absentText = `${absent.stdout}${absent.stderr}`;
  check("no manager process exits component-absent (1)", absent.status === 1, absentText);
  check("manager absence remains distinct from present-not-serving",
    /manager\s+absent/.test(absentText) && !/manager\s+not-serving/.test(absentText), absentText);

  // A live PID record with no recorded bound address must not be transformed into a green web
  // probe by a default-port guess.  The component has a record, but its own HTTP control surface
  // cannot be attributed, so this is the named refusal exit (3), not absent or serving.
  const foreignWeb = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  assert.ok(foreignWeb.pid, "foreign web fixture received a pid");
  writeFileSync(join(root, ".cotal", "web.pid"), String(foreignWeb.pid));
  const webRefused = cli("status", "--components", "--space", SPACE, "--server", server);
  const webRefusedText = `${webRefused.stdout}${webRefused.stderr}`;
  check("a live pidfile with no recorded bound address is a probe refusal (3), never a healthy default-port guess",
    webRefused.status === 3 && /web\s+refused/.test(webRefusedText) && webRefusedText.includes("no bound address recorded"), webRefusedText);
  try { foreignWeb.kill("SIGTERM"); } catch { /* fixture is already gone */ }
  rmSync(join(root, ".cotal", "web.pid"), { force: true });

  // The shipped dashboard, installed and started as an owned service as an operator does, so these
  // cells grade the probe against the dashboard's own session record and auth gate rather than a copy
  // of either. The `web` preset serves only a static-auth target with a protected credential file, so
  // it runs on its own stack in `webRoot`, which these cells stop before the open-mesh cells below.
  const extAdd = cli("ext", "add", join(WT, "implementations", "web"));
  check("the web extension installs into this isolated config", extAdd.status === 0, `${extAdd.stdout}${extAdd.stderr}`);
  const webUp = cliIn(webRoot, ["up", "--detach", "--no-manager", "--space", WEB_SPACE, "--server", `nats://127.0.0.1:${await freePort()}`], 120_000);
  webStack = webUp.status === 0;
  check("the dashboard's static-auth stack starts", webStack, `${webUp.stdout}${webUp.stderr}`);
  const creds = join(credsDir, "dashboard.creds");
  // The admin profile is the one the dashboard connected with before it became a service.
  const minted = cliIn(webRoot, ["auth", "mint", "dashboard", "--profile", "admin", "--out", creds, "--space", WEB_SPACE]);
  check("the dashboard's protected credential file is minted", minted.status === 0 && existsSync(creds), `${minted.stdout}${minted.stderr}`);
  const webPort = await freePort();
  const added = cliIn(webRoot, ["service", "add", "web", "--preset", "web", "--space", WEB_SPACE, "--root", webRoot, "--creds", creds, "--read-only", "--port", String(webPort)]);
  webService = added.status === 0;
  check("service add saves the web preset for this stack", webService, `${added.stdout}${added.stderr}`);
  const webStart = cliIn(webRoot, ["service", "start", "web", "--space", WEB_SPACE, "--json"], 120_000);
  const instance = webStart.status === 0 ? (JSON.parse(webStart.stdout) as { result?: { instanceId?: string; pid?: number } }).result : undefined;
  const webPid = canonicalLocalProcessPath(WEB_PIDFILE, { root: webRoot, space: WEB_SPACE });
  const web = existsSync(webPid) ? Number(readFileSync(webPid, "utf8").trim()) || undefined : undefined;
  check("the dashboard starts as a service whose process holds web.pid",
    webStart.status === 0 && web !== undefined && instance?.pid === web, `${webStart.stdout}${webStart.stderr}`);
  const anonymousMeta = await fetch(`http://127.0.0.1:${webPort}/api/meta`);
  check("the dashboard refuses an anonymous /api/meta", anonymousMeta.status === 401, anonymousMeta.status);
  const webServing = cliIn(webRoot, ["status", "--components", "--space", WEB_SPACE]);
  const webServingText = `${webServing.stdout}${webServing.stderr}`;
  check("the live dashboard at its recorded address grades web serving",
    /web\s+serving/.test(webServingText) && webServingText.includes(`pid ${web}`) && webServingText.includes(`port ${webPort}`) && webServingText.includes("http reachable"), webServingText);
  check("a service-run dashboard is graded from its own instance's session record",
    instance?.instanceId !== undefined && webServingText.includes(`service instance ${instance.instanceId}`), webServingText);
  check("status reports the dashboard extension that provides the web preset as installed",
    /Dashboard:\s+(?:● )?installed\b/.test(webServingText), webServingText);
  // The pidfile's holder picks the session record. A stale `web.session` beside a service-held
  // web.pid names a port nothing listens on, so reading it would grade the live dashboard not-serving.
  const legacySession = canonicalLocalProcessPath(WEB_SESSION_FILE, { root: webRoot, space: WEB_SPACE });
  writeFileSync(legacySession, JSON.stringify({ launchUrl: "http://127.0.0.1:1/", readiness: "stale", host: "127.0.0.1", port: await freePort() }), { mode: 0o600 });
  const staleLegacy = cliIn(webRoot, ["status", "--components", "--space", WEB_SPACE]);
  const staleLegacyText = `${staleLegacy.stdout}${staleLegacy.stderr}`;
  rmSync(legacySession, { force: true });
  check("a stale web.session beside a service-held web.pid is not read",
    /web\s+serving/.test(staleLegacyText) && staleLegacyText.includes(`port ${webPort}`), staleLegacyText);

  // The service's own stop and removal, then the stack's, checked here so a passing run leaves
  // nothing behind. `finally` repeats them only when a failure skipped them.
  const webStop = cliIn(webRoot, ["service", "stop", "web", "--space", WEB_SPACE, "--yes"], 60_000);
  check("service stop stops the dashboard and its close releases web.pid", webStop.status === 0 && !existsSync(webPid), `${webStop.stdout}${webStop.stderr}`);
  const webRemove = cliIn(webRoot, ["service", "remove", "web", "--space", WEB_SPACE, "--yes"]);
  webService = webRemove.status !== 0;
  check("service remove forgets the stopped dashboard", webRemove.status === 0, `${webRemove.stdout}${webRemove.stderr}`);
  const webDown = cliIn(webRoot, ["down"], 120_000);
  webStack = webDown.status !== 0;
  check("cotal down stops the dashboard's static-auth stack", webDown.status === 0, `${webDown.stdout}${webDown.stderr}`);

  // The delivery daemon owns its ready lease and records its last adoption proof in its renewal
  // record. Put a holder in the pre-ready state, then flip the record to a refused adoption: neither
  // must be rendered as absence, and the latter must survive even though its PID is alive. Written
  // through the workspace seam (#1850) so the cell grades what `status` actually reads.
  delivery = await writeDeliveryHolder();
  writeRenewalRecord(root, SPACE, {
    ts: "2026-08-21T00:00:00.000Z", owner: "fixture", results: [],
    adoption: { ok: false, error: "fixture broker refusal" },
  });
  const deliveryNotReady = cli("status", "--components", "--space", SPACE, "--server", server);
  const deliveryNotReadyText = `${deliveryNotReady.stdout}${deliveryNotReady.stderr}`;
  check("delivery ready lease and renewal adoption report independently from its own surfaces",
    deliveryNotReady.status === 2 && /delivery\s+not-serving/.test(deliveryNotReadyText) && deliveryNotReadyText.includes("starting (lease not ready)") && deliveryNotReadyText.includes("renewal adoption refused: fixture broker refusal"), deliveryNotReadyText);
  await stop(delivery);
  delivery = undefined;
  rmSync(join(root, ".cotal", "delivery.pid"), { force: true });
  rmSync(renewalRecordPath(root, SPACE), { force: true });
  await sleep(10_500);

  servingManager = await serveManagerWithForeignRefusal();
  const benignRefusal = await cliAsync("status", "--components", "--space", SPACE, "--server", server);
  const benignRefusalText = `${benignRefusal.stdout}${benignRefusal.stderr}`;
  // No dashboard can run on this open mesh, because the `web` preset refuses an open target, so the
  // web row is `absent` and sets exit 1. Every other component must still be serving.
  check("benign foreign-owned reconciliation stays serving with exact failure facts",
    benignRefusal.status === 1 &&
      /web\s+absent/.test(benignRefusalText) &&
      /delivery\s+serving/.test(benignRefusalText) &&
      /broker\s+serving/.test(benignRefusalText) &&
      /manager\s+serving/.test(benignRefusalText) &&
      !/manager\s+not-serving/.test(benignRefusalText) &&
      benignRefusalText.includes("static reconciliation failed") &&
      benignRefusalText.includes(FOREIGN_FAILURE_FACT) &&
      benignRefusalText.includes("serve reachable"),
    benignRefusalText);

  console.log(`\nCOMPONENT HEALTH SMOKE OK ✅ (${pass} checks)`);
} finally {
  await servingManager?.close();
  await stop(delivery);
  if (webService) {
    cliIn(webRoot, ["service", "stop", "web", "--space", WEB_SPACE, "--yes"], 60_000);
    cliIn(webRoot, ["service", "remove", "web", "--space", WEB_SPACE, "--yes"]);
  }
  if (webStack) cliIn(webRoot, ["down"], 120_000);
  await stop(holder);
  await stop(broker);
  rmSync(home, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
  rmSync(webRoot, { recursive: true, force: true });
  rmSync(credsDir, { recursive: true, force: true });
}
