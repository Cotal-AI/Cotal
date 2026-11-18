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
 * second sandbox root and stop it before the open-mesh cells continue. They also check that the
 * preset refuses a posting setup with one of its two flags, that a start names the remove and add
 * that change a saved definition it refuses, and that a --read-only start of a posting definition
 * is refused before it saves.
 *
 * Run: pnpm smoke:component-health
 */
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
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
import { DELIVERY_PIDFILE, MANAGER_PIDFILE, WEB_PIDFILE, WEB_SERVICE_ADAPTER, WEB_SESSION_FILE, canonicalLocalProcessPath, renewalRecordPath, spaceKey, writeRenewalRecord } from "@cotal-ai/workspace";
import { SMOKE_BROKER_TOKEN, assertSmokeSandboxDown, freePort, recordSmokeSandbox, teardownOnSignal } from "@cotal-ai/smoke-kit";

const WT = resolve(import.meta.dirname, "..", "..", "..");
const CLI = join(WT, "bin", "cotal.ts");
const TSX = join(WT, "node_modules", ".bin", "tsx");
// Children this suite holds and signals run under Node itself with the tsx loader, so each
// ChildProcess is the real CLI or holder. `.bin/tsx` would add a wrapper that relays only SIGINT
// and SIGTERM, and a SIGKILL would end only that wrapper.
const TSX_LOADER = import.meta.resolve("tsx");
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
const controllerRoot = mkdtempSync(join(tmpdir(), `${SMOKE_BROKER_TOKEN}component-health-controller-root-`));
const credsDir = mkdtempSync(join(tmpdir(), "cotal-component-health-creds-"));
// `cotal up` and `cotal service start` below leave the stack and the dashboard in `webRoot` but
// outside the runner's process group, and a killed run never reaches `finally`, so the watchdog that
// recording starts is what stops them. `cliIn` guards each `down` with the anchor of the root it runs in.
const sandboxes = new Map([
  [root, recordSmokeSandbox({ root, cotalHome: home, xdgConfigHome })],
  [webRoot, recordSmokeSandbox({ root: webRoot, cotalHome: home, xdgConfigHome })],
  [controllerRoot, recordSmokeSandbox({ root: controllerRoot, cotalHome: home, xdgConfigHome })],
]);

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
  assertSmokeSandboxDown(sandboxes.get(cwd), args, { cwd, env });
  return spawnSync(TSX, [CLI, ...args], { cwd, env, encoding: "utf8", timeout });
}

async function cliAsync(...args: string[]): Promise<{ status: number | null; stdout: string; stderr: string }> {
  const child = spawn(process.execPath, ["--import", TSX_LOADER, CLI, ...args], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
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
      // Nothing renews these rows, so by now the bucket TTL may have expired them and a release refused.
      await health.releaseDeliveryLease(0, deliveryLeaseRevision).catch(() => {});
      await health.releaseManagerLease(SERVED_INSTANCE, managerLeaseRevision).catch(() => {});
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
let controllerStack = false;
const replacements: ChildProcess[] = [];
try {
  broker = spawn("nats-server", ["-a", "127.0.0.1", "-p", String(port), "-js", "-sd", store], { stdio: "ignore" });
  teardownOnSignal(broker);
  for (let i = 0; i < 100 && !(await portOpen(port)); i++) await sleep(50);
  check("fixture broker started", await portOpen(port));

  // Register an explicit OPEN target so the status command operates on this exact isolated root.
  const add = cli("meshes", "add", SPACE, "--server", server, "--root", root, "--mode", "open");
  check("fixture mesh registered", add.status === 0, `${add.stdout}${add.stderr}`);

  const ready = join(root, "holder.json");
  holder = spawn(process.execPath, ["--import", TSX_LOADER, HOLDER, server, SPACE, INSTANCE], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
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
  check("manager row names not-serving and its PID, and blames no manager build that never answered",
    /manager\s+not-serving/.test(presentText) && presentText.includes(`pid ${held.pid}`) && !presentText.includes("static reconciliation not reported by this manager build"), presentText);
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

  // A missing PID record does not contradict a live lease holder.
  rmSync(managerRecord);
  const leaseOnly = cli("status", "--components", "--space", SPACE, "--server", server);
  const leaseOnlyText = `${leaseOnly.stdout}${leaseOnly.stderr}`;
  check("a manager lease without a local PID record still reads not-serving (2)",
    leaseOnly.status === 2 && /manager\s+not-serving · lease holder /.test(leaseOnlyText), leaseOnlyText);
  writeFileSync(managerRecord, String(held.pid));

  // #6053: leave the stale PID record and real lease behind, as a crashed manager does.
  const holderExited = new Promise<void>((resolve) => holder!.once("exit", () => resolve()));
  holder.kill("SIGKILL");
  await holderExited;
  holder = undefined;
  const killed = cli("status", "--components", "--space", SPACE, "--server", server);
  const killedText = `${killed.stdout}${killed.stderr}`;
  check("a killed manager is absent (1) before its lease expires (#6053)",
    killed.status === 1 &&
      killedText.includes(`manager          absent · pid ${held.pid} · stale pidfile · lease holder `) &&
      killedText.includes(`lease pid ${held.pid} · serve no answer`), killedText);

  // The same stale record must stay absent after the manager lease's 10s TTL.
  await sleep(10_500);
  const expired = cli("status", "--components", "--space", SPACE, "--server", server);
  const expiredText = `${expired.stdout}${expired.stderr}`;
  check("a killed manager stays absent (1) after its lease expires (#6053)",
    expired.status === 1 && expiredText.includes(`manager          absent · pid ${held.pid} · stale pidfile · lease absent · serve no answer`), expiredText);
  rmSync(managerRecord);

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
  // The web extension is not installed yet, so the optional dashboard does not add its own failure.
  check("an uninstalled optional dashboard reads not-installed", /web\s+not-installed · optional/.test(absentText), absentText);

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
  await stop(foreignWeb);
  const deadWeb = cli("status", "--components", "--space", SPACE, "--server", server);
  const deadWebText = `${deadWeb.stdout}${deadWeb.stderr}`;
  check("a dead dashboard with a stale pidfile remains absent (1), not optional not-started",
    deadWeb.status === 1 && /web\s+absent.*stale pidfile/.test(deadWebText), deadWebText);
  rmSync(join(root, ".cotal", "web.pid"), { force: true });

  // The shipped dashboard, installed and started as an owned service as an operator does, so these
  // cells grade the probe against the dashboard's own session record and auth gate rather than a copy
  // of either. The `web` preset serves only a static-auth target with a protected credential file, so
  // it runs on its own stack in `webRoot`, which these cells stop before the open-mesh cells below.
  const extAdd = cli("ext", "add", join(WT, "implementations", "web"));
  check("the web extension installs into this isolated config", extAdd.status === 0, `${extAdd.stdout}${extAdd.stderr}`);
  const webUp = cliIn(webRoot, ["up", "--detach", "--space", WEB_SPACE, "--server", `nats://127.0.0.1:${await freePort()}`], 120_000);
  webStack = webUp.status === 0;
  check("the dashboard's static-auth stack starts", webStack, `${webUp.stdout}${webUp.stderr}`);
  const notStarted = cliIn(webRoot, ["status", "--components", "--space", WEB_SPACE]);
  const notStartedText = `${notStarted.stdout}${notStarted.stderr}`;
  check("a healthy default stack exits 0 with the installed dashboard not-started",
    notStarted.status === 0 && /web\s+not-started · optional/.test(notStartedText) &&
      ["manager", "delivery", "broker"].every(name => new RegExp(`${name}\\s+serving`).test(notStartedText)), notStartedText);
  const creds = join(credsDir, "dashboard.creds");
  // The admin profile is the one the dashboard connected with before it became a service.
  const minted = cliIn(webRoot, ["auth", "mint", "dashboard", "--profile", "admin", "--out", creds, "--space", WEB_SPACE]);
  check("the dashboard's protected credential file is minted", minted.status === 0 && existsSync(creds), `${minted.stdout}${minted.stderr}`);
  const webPort = await freePort();
  const added = cliIn(webRoot, ["service", "add", "web", "--preset", "web", "--space", WEB_SPACE, "--root", webRoot, "--creds", creds, "--read-only", "--port", String(webPort)]);
  webService = added.status === 0;
  check("service add saves the web preset for this stack", webService, `${added.stdout}${added.stderr}`);
  const webPid = canonicalLocalProcessPath(WEB_PIDFILE, { root: webRoot, space: WEB_SPACE });
  // #7632: A dashboard start that fails before publishing its session record (e.g., port already bound)
  // releases web.pid, and a stale web.pid whose PID was reused by a live process with another start
  // token is cleared on the next start without signaling that process.
  const portBlocker = await new Promise<import("node:net").Server>((resolveServer, rejectServer) => {
    const srv = import("node:net").then(({ createServer }) => {
      const s = createServer();
      s.once("error", rejectServer);
      s.listen(webPort, "127.0.0.1", () => resolveServer(s));
    });
    void srv;
  });
  try {
    const failedStart = cliIn(webRoot, ["service", "start", "web", "--space", WEB_SPACE, "--json"], 60_000);
    check("a failed dashboard start releases web.pid and its identity pin",
      failedStart.status !== 0 && !existsSync(webPid) && !existsSync(`${webPid}.identity`), `${failedStart.stdout}${failedStart.stderr}`);
  } finally {
    await new Promise<void>((resolveClose) => portBlocker.close(() => resolveClose()));
  }
  writeFileSync(webPid, `${process.pid}\n`, { mode: 0o600 });
  writeFileSync(`${webPid}.identity`, `${process.pid} stale-start-token\n`, { mode: 0o600 });
  const webStart = cliIn(webRoot, ["service", "start", "web", "--space", WEB_SPACE, "--json"], 120_000);
  const instance = webStart.status === 0 ? (JSON.parse(webStart.stdout) as { result?: { instanceId?: string; pid?: number } }).result : undefined;
  const web = existsSync(webPid) ? Number(readFileSync(webPid, "utf8").trim()) || undefined : undefined;
  check("the dashboard starts as a service whose process holds web.pid after clearing a reused-PID slot",
    webStart.status === 0 && web !== undefined && instance?.pid === web, `${webStart.stdout}${webStart.stderr}`);
  const anonymousMeta = await fetch(`http://127.0.0.1:${webPort}/api/meta`);
  check("the dashboard refuses an anonymous /api/meta", anonymousMeta.status === 401, anonymousMeta.status);
  // `--wide` prints the Dashboard row, which the compact report shows only when its record cannot be read.
  const webServing = cliIn(webRoot, ["status", "--components", "--wide", "--space", WEB_SPACE]);
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

  process.kill(web!, "SIGTERM");
  for (let i = 0; i < 100 && existsSync(webPid); i++) await sleep(50);
  const exitedWeb = cliIn(webRoot, ["status", "--components", "--space", WEB_SPACE]);
  check("an owned dashboard that removes its pidfile without a confirmed stop is absent (1)",
    exitedWeb.status === 1 && /web\s+absent.*service instance/.test(exitedWeb.stdout) && !existsSync(webPid), `${exitedWeb.stdout}${exitedWeb.stderr}`);

  // The service's own stop and removal, then the stack's, checked here so a passing run leaves
  // nothing behind. `finally` repeats them only when a failure skipped them.
  const webStop = cliIn(webRoot, ["service", "stop", "web", "--space", WEB_SPACE, "--yes"], 60_000);
  check("service stop stops the dashboard and its close releases web.pid", webStop.status === 0 && !existsSync(webPid), `${webStop.stdout}${webStop.stderr}`);
  const stoppedWeb = cliIn(webRoot, ["status", "--components", "--space", WEB_SPACE]);
  check("an intentionally stopped optional dashboard returns to not-started with exit 0",
    stoppedWeb.status === 0 && /web\s+not-started · optional/.test(`${stoppedWeb.stdout}${stoppedWeb.stderr}`), `${stoppedWeb.stdout}${stoppedWeb.stderr}`);
  for (const route of ["child-signal", "service-stop"] as const) {
    const foreground = spawn(process.execPath, ["--import", TSX_LOADER, CLI, "service", "start", "web", "--space", WEB_SPACE, "--foreground"], { cwd: webRoot, env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    foreground.stdout!.on("data", (chunk) => { output += chunk; });
    foreground.stderr!.on("data", (chunk) => { output += chunk; });
    const finished = new Promise<number | null>((resolve, reject) => {
      foreground.once("error", reject);
      foreground.once("close", resolve);
    });
    const timer = setTimeout(() => foreground.kill("SIGKILL"), 120_000);
    try {
      const deadline = Date.now() + 90_000;
      while (!output.includes("Readiness observation: adapter-process-running") && !/Readiness observation:\s+adapter-process-running/.test(output) && Date.now() < deadline && foreground.exitCode === null) await sleep(100);
      check(`foreground dashboard reaches adapter readiness before ${route}`, /Readiness observation:\s+adapter-process-running/.test(output), output);
      const pid = Number(/PID:\s+(\d+)/.exec(output)?.[1]);
      check(`foreground dashboard reports its child for ${route}`, Number.isSafeInteger(pid) && pid > 0, output);
      if (route === "child-signal") process.kill(pid, "SIGINT");
      else {
        const stopped = cliIn(webRoot, ["service", "stop", "web", "--space", WEB_SPACE, "--yes"], 60_000);
        check("external service stop confirms the foreground dashboard exit", stopped.status === 0, `${stopped.stdout}${stopped.stderr}`);
      }
      const code = await finished;
      check(`foreground ${route} exits cleanly without a schema refusal`, code === 0 && !output.includes("SCHEMA_INVALID"), { code, output });
      const status = cliIn(webRoot, ["service", "status", "web", "--space", WEB_SPACE, "--json"]);
      const row = JSON.parse(status.stdout).result;
      check(`foreground ${route} records stopped readiness and observed exit`, row.recordedState === "stopped" && row.readinessObservation === "not-checked" && row.exit?.code === 0, status.stdout);
    } finally {
      clearTimeout(timer);
      if (foreground.exitCode === null && foreground.signalCode === null) { foreground.kill("SIGTERM"); await finished; }
    }
  }
  const webRemove = cliIn(webRoot, ["service", "remove", "web", "--space", WEB_SPACE, "--yes"]);
  webService = webRemove.status !== 0;
  check("service remove forgets the stopped dashboard", webRemove.status === 0, `${webRemove.stdout}${webRemove.stderr}`);

  // The dashboard posts only with --no-read-only and a separate --posting-creds file, so saving one of
  // the two flags alone is refused and saves nothing. A wildcard host is refused when it starts, and the
  // refusal names the remove and add that change a saved definition.
  const webDefinition = ["service", "add", "web", "--preset", "web", "--space", WEB_SPACE, "--root", webRoot, "--creds", creds, "--port", String(webPort)];
  const envelope = (run: { stdout: string }) => { try { return JSON.parse(run.stdout) as { error?: { code?: string; message?: string; remedy?: string } }; } catch { return undefined; } };
  for (const [given, needs] of [[["--posting-creds", creds], "--no-read-only"], [["--no-read-only"], "--posting-creds <file>"]] as const) {
    const lone = cliIn(webRoot, [...webDefinition, ...given, "--json"]);
    const shown = cliIn(webRoot, ["service", "show", "web", "--space", WEB_SPACE]);
    const error = envelope(lone)?.error;
    check(`service add web with ${given[0]} alone refuses USAGE_INVALID naming ${needs}, and saves nothing`,
      lone.status === 1 && error?.code === "USAGE_INVALID" && error.message?.startsWith(`${given[0]} requires ${needs}:`) === true && error.remedy === "cotal service add web --preset web --no-read-only --posting-creds <file>" && shown.status !== 0,
      { add: `${lone.stdout}${lone.stderr}`, show: `${shown.stdout}${shown.stderr}` });
  }
  const wildcard = cliIn(webRoot, [...webDefinition, "--read-only", "--host", "0.0.0.0"]);
  webService = wildcard.status === 0;
  const wildStart = cliIn(webRoot, ["service", "start", "web", "--space", WEB_SPACE, "--json"], 60_000);
  const wildError = envelope(wildStart)?.error;
  check("a saved wildcard --host is refused at start CONFLICT, exit 2, naming the remove and add that change it",
    wildcard.status === 0 && wildStart.status === 2 && wildError?.code === "CONFLICT" && wildError.message?.includes("--host is a wildcard") === true &&
      wildError.remedy === `remove it with \`cotal service remove web --space ${WEB_SPACE} --yes\`, then run \`cotal service add web --preset web --space ${WEB_SPACE} --host <address>\``,
    { add: `${wildcard.stdout}${wildcard.stderr}`, start: `${wildStart.stdout}${wildStart.stderr}` });
  const wildRemove = cliIn(webRoot, ["service", "remove", "web", "--space", WEB_SPACE, "--yes"]);
  webService = wildRemove.status !== 0;
  check("...and the refused definition is removed as the remedy says", wildRemove.status === 0, `${wildRemove.stdout}${wildRemove.stderr}`);
  // A definition file is checked against the adapter's schema only, so it can still save the pair apart.
  const pairFile = join(credsDir, "web-read-only-posting.json");
  writeFileSync(pairFile, JSON.stringify({ schemaVersion: 1, space: WEB_SPACE, launch: { type: "adapter", adapter: WEB_SERVICE_ADAPTER, options: { root: webRoot, creds, "read-only": true, "posting-creds": creds, port: webPort } }, readiness: { type: "adapter", timeoutMs: 40000 } }), { mode: 0o600 });
  const pairAdd = cliIn(webRoot, ["service", "add", "web", "--file", pairFile, "--space", WEB_SPACE]);
  webService = pairAdd.status === 0;
  const pairStart = cliIn(webRoot, ["service", "start", "web", "--space", WEB_SPACE, "--json"], 60_000);
  const pairError = envelope(pairStart)?.error;
  check("a saved read-only definition with --posting-creds is refused at start CONFLICT, naming that condition and the re-add with --no-read-only",
    pairAdd.status === 0 && pairStart.status === 2 && pairError?.code === "CONFLICT" && pairError.message?.includes("has --posting-creds but is read-only") === true &&
      pairError.remedy?.endsWith(`then run \`cotal service add web --preset web --space ${WEB_SPACE} --no-read-only --posting-creds <file>\``) === true,
    { add: `${pairAdd.stdout}${pairAdd.stderr}`, start: `${pairStart.stdout}${pairStart.stderr}` });
  const pairRemove = cliIn(webRoot, ["service", "remove", "web", "--space", WEB_SPACE, "--yes"]);
  webService = pairRemove.status !== 0;
  // A start's options are saved over a stopped definition's, so --read-only on a posting dashboard
  // would keep its --posting-creds. That start is refused before it saves anything (#7589).
  const posting = cliIn(webRoot, [...webDefinition, "--no-read-only", "--posting-creds", creds]);
  webService = posting.status === 0;
  const revision = () => envelope(cliIn(webRoot, ["service", "show", "web", "--space", WEB_SPACE, "--json"])) as { result?: { revision?: unknown } } | undefined;
  const before = revision()?.result?.revision;
  const offStart = cliIn(webRoot, ["service", "start", "web", "--space", WEB_SPACE, "--read-only", "--json"], 60_000);
  const offError = envelope(offStart)?.error;
  const after = revision()?.result?.revision;
  check("a --read-only start of a stopped posting definition is refused CONFLICT, saves nothing, and names the remove and read-only add",
    posting.status === 0 && offStart.status === 2 && offError?.code === "CONFLICT" && offError.message?.startsWith("--read-only would keep the saved web definition's --posting-creds") === true &&
      before !== undefined && after === before &&
      offError.remedy === `remove it with \`cotal service remove web --space ${WEB_SPACE} --yes\`, then run \`cotal service add web --preset web --space ${WEB_SPACE} --read-only\``,
    { add: `${posting.stdout}${posting.stderr}`, start: `${offStart.stdout}${offStart.stderr}`, before, after });
  const postingRemove = cliIn(webRoot, ["service", "remove", "web", "--space", WEB_SPACE, "--yes"]);
  webService = postingRemove.status !== 0;
  const webDown = cliIn(webRoot, ["down", "--yes"], 120_000);
  webStack = webDown.status !== 0;
  check("cotal down stops the dashboard's static-auth stack", webDown.status === 0, `${webDown.stdout}${webDown.stderr}`);
  const clearForStopped = cliIn(webRoot, ["use", "--clear"]);
  check("clear the unrelated open-space selection before checking the stopped local stack", clearForStopped.status === 0, `${clearForStopped.stdout}${clearForStopped.stderr}`);
  const stoppedLegacy = cliIn(webRoot, ["status", "--components"]);
  check("a cleanly stopped legacy stack is absent and exits 1",
    stoppedLegacy.status === 1 && /(?:target|manager)\s+absent/.test(stoppedLegacy.stdout), `${stoppedLegacy.stdout}${stoppedLegacy.stderr}`);

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
  check("a recorded renewal refusal wins the verdict while independent delivery readiness stays visible",
    deliveryNotReady.status === 3 && /delivery\s+refused/.test(deliveryNotReadyText) && deliveryNotReadyText.includes("starting (lease not ready)") && deliveryNotReadyText.includes("renewal adoption refused: fixture broker refusal"), deliveryNotReadyText);
  await stop(delivery);
  delivery = undefined;
  rmSync(join(root, ".cotal", "delivery.pid"), { force: true });
  rmSync(renewalRecordPath(root, SPACE), { force: true });
  await sleep(10_500);

  servingManager = await serveManagerWithForeignRefusal();
  const benignRefusal = await cliAsync("status", "--components", "--space", SPACE, "--server", server);
  const benignRefusalText = `${benignRefusal.stdout}${benignRefusal.stderr}`;
  // No dashboard was started on this open mesh. Its installed extension is optional, so it must
  // not fail an otherwise serving stack.
  check("benign foreign-owned reconciliation stays serving with exact failure facts",
    benignRefusal.status === 0 &&
      /web\s+not-started · optional/.test(benignRefusalText) &&
      /delivery\s+serving/.test(benignRefusalText) &&
      /broker\s+serving/.test(benignRefusalText) &&
      /manager\s+serving/.test(benignRefusalText) &&
      !/manager\s+not-serving/.test(benignRefusalText) &&
      benignRefusalText.includes("static reconciliation failed") &&
      benignRefusalText.includes(FOREIGN_FAILURE_FACT) &&
      benignRefusalText.includes("serve reachable"),
    benignRefusalText);

  // Real launcher lifecycles, including the two selection outcomes of a clean down.
  const controllerSpace = "component-health-controller";
  const prepare = cliIn(controllerRoot, ["space", "create", controllerSpace]);
  check("prepare the controller health stack", prepare.status === 0, `${prepare.stdout}${prepare.stderr}`);
  const controllerUp = cliIn(controllerRoot, ["up", "--no-manager", "--server", `nats://127.0.0.1:${await freePort()}`], 120_000);
  controllerStack = controllerUp.status === 0;
  check("start the controller without a manager", controllerStack, `${controllerUp.stdout}${controllerUp.stderr}`);
  const omittedController = cliIn(controllerRoot, ["status", "--components", "--space", controllerSpace]);
  check("an intentionally omitted controller manager is not-started and exits 0",
    omittedController.status === 0 && /manager\s+not-started.*--no-manager/.test(omittedController.stdout), `${omittedController.stdout}${omittedController.stderr}`);
  const selectController = cliIn(controllerRoot, ["use", controllerSpace]);
  check("select the controller stack", selectController.status === 0, `${selectController.stdout}${selectController.stderr}`);
  const controllerDown = cliIn(controllerRoot, ["down", "--yes"], 120_000);
  controllerStack = controllerDown.status !== 0;
  check("stop the controller stack cleanly", !controllerStack, `${controllerDown.stdout}${controllerDown.stderr}`);
  const stoppedController = cliIn(controllerRoot, ["status", "--components"]);
  check("a cleanly stopped controller target is absent (1), not refused",
    stoppedController.status === 1 && /target\s+absent.*not-started/.test(stoppedController.stdout), `${stoppedController.stdout}${stoppedController.stderr}`);
  const selectedStopped = cliIn(webRoot, ["status", "--components"]);
  const selectedHealth = selectedStopped.stdout.split("Component Health")[1] ?? "";
  check("component health preserves the header's stopped selection instead of probing the folder's space",
    selectedStopped.status === 1 && selectedStopped.stdout.includes(`Mesh: ${controllerSpace}`) && selectedHealth.includes(`"${controllerSpace}" is stopped`) && !selectedHealth.includes(WEB_SPACE), `${selectedStopped.stdout}${selectedStopped.stderr}`);

  const legacyUp = cliIn(webRoot, ["up", "--no-manager", "--space", WEB_SPACE], 120_000);
  webStack = legacyUp.status === 0;
  check("restart a legacy stack without its manager", webStack, `${legacyUp.stdout}${legacyUp.stderr}`);
  const omittedLegacy = cliIn(webRoot, ["status", "--components", "--space", WEB_SPACE]);
  check("an intentionally omitted legacy manager is not-started and exits 0",
    omittedLegacy.status === 0 && /manager\s+not-started.*--no-manager/.test(omittedLegacy.stdout), `${omittedLegacy.stdout}${omittedLegacy.stderr}`);
  const fullLegacy = cliIn(webRoot, ["up", "--space", WEB_SPACE], 120_000);
  check("bare up adds the legacy manager", fullLegacy.status === 0, `${fullLegacy.stdout}${fullLegacy.stderr}`);

  const reusePid = async (cwd: string, space: string, template: string, definition?: string) => {
    const path = canonicalLocalProcessPath(template, { root: cwd, space });
    const old = Number(readFileSync(path, "utf8"));
    const token = readFileSync(`${path}.identity`, "utf8").trim().split(/\s+/)[1];
    process.kill(old, "SIGKILL");
    await sleep(100);
    const replacement = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    replacements.push(replacement);
    assert.ok(replacement.pid);
    writeFileSync(path, `${replacement.pid}\n`);
    writeFileSync(`${path}.identity`, `${replacement.pid} ${token}\n`);
    if (definition) {
      // Simulate PID reuse in both durable records, retaining the dead daemon's creation token.
      const directory = join(home, "services", spaceKey(space), "instances");
      const saved = readdirSync(directory).filter((name) => name.endsWith(".json")).map((name) => join(directory, name))
        .find((path) => { const value = JSON.parse(readFileSync(path, "utf8")).value; return value?.definition === definition && value.process?.pid === old; })!;
      const record = JSON.parse(readFileSync(saved, "utf8"));
      record.value.process.pid = replacement.pid;
      if (record.value.adapterReadiness) record.value.adapterReadiness.process.pid = replacement.pid;
      writeFileSync(saved, `${JSON.stringify(record)}\n`);
    }
  };
  await reusePid(webRoot, WEB_SPACE, DELIVERY_PIDFILE);
  const reusedDelivery = cliIn(webRoot, ["status", "--components", "--space", WEB_SPACE]);
  check("a reused legacy delivery PID is absent even while its ready lease survives",
    reusedDelivery.status === 1 && /delivery\s+absent.*stale pidfile/.test(reusedDelivery.stdout) && !/Delivery responder:\s+● bound/.test(reusedDelivery.stdout), `${reusedDelivery.stdout}${reusedDelivery.stderr}`);
  await reusePid(webRoot, WEB_SPACE, MANAGER_PIDFILE);
  await reusePid(webRoot, WEB_SPACE, "nats.pid");
  const reusedLegacy = cliIn(webRoot, ["status", "--components", "--space", WEB_SPACE]);
  check("all reused legacy PIDs read absent, never running or serving",
    reusedLegacy.status === 1 && ["manager", "delivery", "broker"].every((name) => new RegExp(`${name}\\s+absent`).test(reusedLegacy.stdout)) && !/\b(?:Manager|Delivery|Broker)\s+running/.test(reusedLegacy.stdout), `${reusedLegacy.stdout}${reusedLegacy.stderr}`);
  const clearedDown = cliIn(webRoot, ["down", "--yes"], 120_000);
  check("down clears reused legacy records and their pins without stopping unrelated processes",
    clearedDown.status === 0 && (clearedDown.stderr.match(/was reused by another process/g)?.length ?? 0) === 3 &&
    [MANAGER_PIDFILE, DELIVERY_PIDFILE, "nats.pid"].every((kind) => {
      const path = canonicalLocalProcessPath(kind, { root: webRoot, space: WEB_SPACE });
      return !existsSync(path) && !existsSync(`${path}.identity`);
    }) && replacements.every((child) => child.exitCode === null && child.signalCode === null), `${clearedDown.stdout}${clearedDown.stderr}`);
  for (const child of replacements) await stop(child);
  const legacyDown = cliIn(webRoot, ["down", "--yes"], 120_000);
  webStack = legacyDown.status !== 0;
  check("down is still successful after the replacement processes exit", !webStack, `${legacyDown.stdout}${legacyDown.stderr}`);
  const restartController = cliIn(controllerRoot, ["up"], 120_000);
  controllerStack = restartController.status === 0;
  check("restart the controller with all components", controllerStack, `${restartController.stdout}${restartController.stderr}`);
  await reusePid(controllerRoot, controllerSpace, DELIVERY_PIDFILE, "stack-delivery");
  await reusePid(controllerRoot, controllerSpace, MANAGER_PIDFILE, "stack-manager");
  const reusedController = cliIn(controllerRoot, ["status", "--components", "--space", controllerSpace]);
  check("foreign controller PIDs cannot serve from stale leases and retain the up recovery action",
    reusedController.status === 1 && /manager\s+absent/.test(reusedController.stdout) && /delivery\s+absent/.test(reusedController.stdout) && reusedController.stdout.includes("foreign pid") && reusedController.stdout.includes(`up --root ${controllerRoot}`) && !/Delivery responder:\s+● bound/.test(reusedController.stdout), `${reusedController.stdout}${reusedController.stderr}`);

  console.log(`\nCOMPONENT HEALTH SMOKE OK ✅ (${pass} checks)`);
} finally {
  if (controllerStack) cliIn(controllerRoot, ["down", "--yes"], 120_000);
  for (const child of replacements) await stop(child);
  await servingManager?.close();
  await stop(delivery);
  if (webService) {
    cliIn(webRoot, ["service", "stop", "web", "--space", WEB_SPACE, "--yes"], 60_000);
    cliIn(webRoot, ["service", "remove", "web", "--space", WEB_SPACE, "--yes"]);
  }
  if (webStack) cliIn(webRoot, ["down", "--yes"], 120_000);
  await stop(holder);
  await stop(broker);
  rmSync(home, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
  rmSync(webRoot, { recursive: true, force: true });
  rmSync(credsDir, { recursive: true, force: true });
  rmSync(controllerRoot, { recursive: true, force: true });
}
