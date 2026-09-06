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
 * Run: pnpm smoke:component-health
 */
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
import { webProbeTarget } from "../src/commands/status.js";

const WT = resolve(import.meta.dirname, "..", "..", "..");
const CLI = join(WT, "bin", "cotal.ts");
const TSX = join(WT, "node_modules", ".bin", "tsx");
const HOLDER = join(import.meta.dirname, "component-health-holder.mjs");
const SPACE = "component-health";
const INSTANCE = "h".repeat(26);
const root = mkdtempSync(join(tmpdir(), "cotal-component-health-root-"));
const home = mkdtempSync(join(tmpdir(), "cotal-component-health-home-"));
const store = join(root, "jetstream");
mkdirSync(join(root, ".cotal"), { recursive: true });

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
env.XDG_CONFIG_HOME = join(home, "xdg");
env.COTAL_SKIP_CONNECTOR_SEED = "1";

const remoteProbe = webProbeTarget("node cotal web --host 192.0.2.10 --port 8123 --no-open");
check("the CLI status probe uses the explicit dashboard host and port",
  !("refused" in remoteProbe) && remoteProbe.url.href === "http://192.0.2.10:8123/api/meta", remoteProbe);
const defaultProbe = webProbeTarget("node cotal web --no-open");
check("the CLI status probe preserves loopback defaults when --host and --port are absent",
  !("refused" in defaultProbe) && defaultProbe.url.href === "http://127.0.0.1:7799/api/meta", defaultProbe);
const wildcardProbe = webProbeTarget("node cotal web --host 0.0.0.0");
check("the CLI status probe refuses a wildcard process host rather than probing a guessed address",
  "refused" in wildcardProbe && wildcardProbe.refused.includes("invalid process host"), wildcardProbe);
const wildcardAliasProbe = webProbeTarget("node cotal web --host 0");
check("the CLI status probe refuses a canonical wildcard alias",
  "refused" in wildcardAliasProbe && wildcardAliasProbe.refused.includes("invalid process host"), wildcardAliasProbe);

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  assert.ok(addr && typeof addr === "object");
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return addr.port;
}

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
  return spawnSync(TSX, [CLI, ...args], { cwd: root, env, encoding: "utf8", timeout: 30_000 });
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

async function stop(child: ChildProcess | undefined): Promise<void> {
  if (!child?.pid) return;
  try { child.kill("SIGTERM"); } catch { /* already gone */ }
  for (let i = 0; i < 30; i++) {
    try { process.kill(child.pid, 0); } catch { return; }
    await sleep(50);
  }
  try { child.kill("SIGKILL"); } catch { /* already gone */ }
}

async function writeWebHarness(port: number): Promise<ChildProcess> {
  const script = join(root, "web-harness.mjs");
  writeFileSync(script, [
    'import { createServer } from "node:http";',
    `const server = createServer((req, res) => { if (req.url === "/api/meta") { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ pid: process.pid })); return; } res.statusCode = 404; res.end(); });`,
    `server.listen(${port}, "127.0.0.1");`,
  ].join("\n"));
  const child = spawn(process.execPath, [script, "web", "--port", String(port)], { cwd: root, stdio: "ignore" });
  assert.ok(child.pid, "web harness received a pid");
  writeFileSync(join(root, ".cotal", "web.pid"), String(child.pid));
  for (let i = 0; i < 50 && !(await portOpen(port)); i++) await sleep(50);
  assert.ok(await portOpen(port), "web harness never bound its port");
  return child;
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
  const deliveryLeaseRevision = await health.acquireDeliveryLease(0);
  await health.markDeliveryLeaseReady(0, deliveryLeaseRevision);
  writeFileSync(join(root, ".cotal", "manager.pid"), String(process.pid));
  writeFileSync(join(root, ".cotal", "delivery.pid"), String(process.pid));
  writeFileSync(join(root, ".cotal", "renewal.json"), JSON.stringify({
    ts: "2026-09-06T00:00:00.000Z", owner: "fixture", results: [], adoption: { ok: true },
  }));

  return {
    close: async () => {
      await service.stop();
      await health.releaseDeliveryLease(0);
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
let web: ChildProcess | undefined;
let delivery: ChildProcess | undefined;
let servingManager: { close(): Promise<void> } | undefined;
try {
  broker = spawn("nats-server", ["-a", "127.0.0.1", "-p", String(port), "-js", "-sd", store], { stdio: "ignore" });
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
  writeFileSync(join(root, ".cotal", "manager.pid"), String(held.pid));

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

  await stop(holder);
  holder = undefined;
  rmSync(join(root, ".cotal", "manager.pid"), { force: true });
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

  // A live PID record whose process is not the dashboard must not be transformed into a green web
  // probe by a default-port guess.  The component has a record, but its own HTTP control surface
  // cannot be attributed, so this is the named refusal exit (3), not absent or serving.
  const foreignWeb = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  assert.ok(foreignWeb.pid, "foreign web fixture received a pid");
  writeFileSync(join(root, ".cotal", "web.pid"), String(foreignWeb.pid));
  const webRefused = cli("status", "--components", "--space", SPACE, "--server", server);
  const webRefusedText = `${webRefused.stdout}${webRefused.stderr}`;
  check("a live non-web pidfile is a probe refusal (3), never a healthy default-port guess",
    webRefused.status === 3 && /web\s+refused/.test(webRefusedText) && webRefusedText.includes("recorded PID is not a web command"), webRefusedText);
  try { foreignWeb.kill("SIGTERM"); } catch { /* fixture is already gone */ }
  rmSync(join(root, ".cotal", "web.pid"), { force: true });

  web = await writeWebHarness(await freePort());
  const webServing = cli("status", "--components", "--space", SPACE, "--server", server);
  const webServingText = `${webServing.stdout}${webServing.stderr}`;
  check("a dashboard-owned HTTP meta face proves web serving",
    /web\s+serving/.test(webServingText) && /port \d+/.test(webServingText) && webServingText.includes("http reachable"), webServingText);
  await stop(web);
  web = undefined;
  rmSync(join(root, ".cotal", "web.pid"), { force: true });

  // The delivery daemon owns its ready lease and records its last adoption proof in renewal.json.
  // Put a holder in the pre-ready state, then flip the record to a refused adoption: neither must
  // be rendered as absence, and the latter must survive even though its PID is alive.
  delivery = await writeDeliveryHolder();
  writeFileSync(join(root, ".cotal", "renewal.json"), JSON.stringify({
    ts: "2026-08-21T00:00:00.000Z", owner: "fixture", results: [],
    adoption: { ok: false, error: "fixture broker refusal" },
  }));
  const deliveryNotReady = cli("status", "--components", "--space", SPACE, "--server", server);
  const deliveryNotReadyText = `${deliveryNotReady.stdout}${deliveryNotReady.stderr}`;
  check("delivery ready lease and renewal adoption report independently from its own surfaces",
    deliveryNotReady.status === 2 && /delivery\s+not-serving/.test(deliveryNotReadyText) && deliveryNotReadyText.includes("starting (lease not ready)") && deliveryNotReadyText.includes("renewal adoption refused: fixture broker refusal"), deliveryNotReadyText);
  await stop(delivery);
  delivery = undefined;
  rmSync(join(root, ".cotal", "delivery.pid"), { force: true });
  rmSync(join(root, ".cotal", "renewal.json"), { force: true });
  await sleep(10_500);

  web = await writeWebHarness(await freePort());
  servingManager = await serveManagerWithForeignRefusal();
  const benignRefusal = await cliAsync("status", "--components", "--space", SPACE, "--server", server);
  const benignRefusalText = `${benignRefusal.stdout}${benignRefusal.stderr}`;
  check("benign foreign-owned reconciliation stays serving with exact failure facts",
    benignRefusal.status === 0 &&
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
  await stop(web);
  await stop(holder);
  await stop(broker);
  rmSync(home, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
}
