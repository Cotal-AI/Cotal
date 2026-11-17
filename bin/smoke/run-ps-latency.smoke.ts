/**
 * The full `run-ps` list on a manager that reaches its broker over a slow link (#5672), against the
 * real manager and the real runtime host on an owned static-auth broker.
 *
 * The manager dials the broker through a local proxy that holds every chunk for a fixed delay in
 * each direction, as a manager on another host does. Seatless runs complete with no delay, then the
 * delay is switched on and `run-ps` is asked once with the CLI's 25 s budget. Every list read is a
 * broker round trip, so a list that reads one run at a time spends rows × reads × round trip and
 * misses that budget long before the store is large. The caller and the delivery daemon dial the
 * broker directly, so only the manager's reads pay the delay.
 *
 * Lives under bin/smoke because it composes the manager AND the runtime.
 * Needs nats-server on PATH. Run: pnpm smoke:run-ps-latency
 */
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, connect as dial, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "@nats-io/transport-node";
import { SMOKE_BROKER_TOKEN, awaitBrokerReady, freePort, killAndAwaitExit, teardownOnSignal } from "@cotal-ai/smoke-kit";

const home = mkdtempSync(join(tmpdir(), "cotal-run-ps-latency-home-"));
for (const key of Object.keys(process.env)) if (key.startsWith("COTAL_")) delete process.env[key];
process.env.COTAL_HOME = home;
process.env.COTAL_SKIP_CONNECTOR_SEED = "1";

const core = await import("@cotal-ai/core");
const workspace = await import("@cotal-ai/workspace");
const { Manager } = await import("@cotal-ai/manager");
// Importing the runtime is what registers the `cotal-lang` run host the manager resolves.
await import("@cotal-ai/runtime");
const { bootDeliveryDaemon } = await import("../../implementations/manager/smoke/_boot-delivery.js");
type RunListRow = import("@cotal-ai/core").RunListRow;
type RunStatusView = import("@cotal-ai/core").RunStatusView;
type EpCaller = import("@cotal-ai/core").EpCaller;
type EndpointReply = import("@cotal-ai/core").EndpointReply;

/** Runs on the endpoint: about the store the issue was measured on. */
const RUNS = 90;
/** One-way delay per chunk, so a round trip costs about 60 ms. The issue's manager measured about
 *  50 ms per read; at that, a one-at-a-time list of 90 runs took 24.8 s here, just inside the budget. */
const DELAY_MS = 30;
/** The budget `cotal run` gives the manager (SPEC 13.5). */
const BUDGET_MS = 25_000;

let failed = 0;
const c = (name: string, ok: boolean, extra?: unknown) => {
  if (ok) console.log(`  ✓ ${name}`);
  else { failed++; console.log(`  ✗ FAIL: ${name}`, extra !== undefined ? JSON.stringify(extra) : ""); }
};

// A TCP relay that forwards every chunk after `delay` ms in each direction. Equal timeouts fire in
// the order they were set, so each direction stays in order.
let delay = 0;
const sockets = new Set<Socket>();
const relay = (from: Socket, to: Socket) => {
  from.on("data", (chunk) => {
    if (delay === 0) to.write(chunk);
    else setTimeout(() => { if (!to.destroyed) to.write(chunk); }, delay);
  });
  from.on("close", () => setTimeout(() => to.destroy(), delay));
  from.on("error", () => to.destroy());
};

const space = `runpslatency${core.mintLifecycleUid().slice(0, 8)}`;
const auth = await core.createSpaceAuth(space);
const root = mkdtempSync(join(tmpdir(), "cotal-run-ps-latency-project-"));
mkdirSync(join(root, ".cotal"));
workspace.saveSpaceAuth(workspace.authDir(root), auth);
const port = await freePort();
const proxyPort = await freePort();
const servers = `nats://127.0.0.1:${port}`;
const proxied = `nats://127.0.0.1:${proxyPort}`;
const store = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
writeFileSync(join(store, "server.conf"), core.serverConfig(auth, [auth], {
  transport: { kind: "plaintext" }, host: "127.0.0.1", port, storeDir: join(store, "js"),
}), { mode: 0o600 });
const broker = spawn("nats-server", ["-c", join(store, "server.conf")], { stdio: "ignore" });
const releaseBroker = teardownOnSignal(broker);
const proxy = createServer((client) => {
  const upstream = dial(port, "127.0.0.1");
  for (const s of [client, upstream]) { sockets.add(s); s.on("close", () => sockets.delete(s)); }
  relay(client, upstream);
  relay(upstream, client);
});
await new Promise<void>((resolve) => proxy.listen(proxyPort, "127.0.0.1", resolve));
let manager: InstanceType<typeof Manager> | undefined;
let delivery: Awaited<ReturnType<typeof bootDeliveryDaemon>> | undefined;
let nc: Awaited<ReturnType<typeof connect>> | undefined;
try {
  await awaitBrokerReady(() => core.isReachable(servers), { servers, attempts: 50, delayMs: 100 });
  await core.setupSpaceStreams({ servers, space, creds: await core.mintCreds(auth, core.newIdentity(), "provisioner") });
  workspace.recordMesh({ space, server: proxied, root, mode: "auth", ts: new Date().toISOString() });
  delivery = await bootDeliveryDaemon({ space, servers, auth, reloadStoreIdentity: workspace.workspaceSecretStore(root).identity });
  manager = new Manager({ space, servers: proxied, runtime: "pty", workspaceRoot: root });
  await manager.start();

  const identity = core.newIdentity();
  const uid = core.mintLifecycleUid();
  const issued = { generation: core.mintGeneration(Math.floor(Date.now() / 1000) + 172_800), acceptedToken: core.mintAcceptedToken() };
  const caller = { owner: core.DEV_OWNER, actor: identity.id, uid, generation: issued.generation } as EpCaller;
  const creds = await core.withIssuerSession({ servers, space, auth, tls: false }, (session) => core.mintCreds(auth, identity, "agent", {
    lifecycleUid: uid, capabilities: ["run"], expiresInSeconds: 1800, issued,
    issuance: { mode: "issue", store: session.store, accepted: session.accepted, sources: [] },
  }));
  nc = await connect({ servers, ...core.standaloneConnectOpts({ creds, tls: false }), maxReconnectAttempts: 0 });
  const service = await core.resolveService(nc, space, "manager", caller, { deadlineMs: 10_000 });
  const call = async (command: string, args: Record<string, unknown>, deadlineMs = 30_000): Promise<EndpointReply> =>
    (await core.invokeCommand(nc!, space, service, command, args, { deadlineMs, currentEpoch: async () => 0 })).reply;

  console.log(`1. ${RUNS} seatless runs complete with no delay on the manager's link`);
  const runIds: string[] = [];
  for (let i = 0; i < RUNS; i++) {
    const started = await call("run-start", { source: `log("n", ${i});\n`, file: `run-${i}.cotal.js` });
    if (!started.ok) throw new Error(`run-start ${i}: ${JSON.stringify(started.error)}`);
    runIds.push((started.data as { runId: string }).runId);
  }
  for (const runId of runIds) {
    for (let attempt = 0; ; attempt++) {
      const view = await call("run-status", { runId });
      if (view.ok && (view.data as RunStatusView).status?.state === "completed") break;
      if (attempt === 100) throw new Error(`run ${runId} did not complete`);
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  const unhurried = await call("run-ps", {});
  c(`with no delay the full list names all ${RUNS} runs`,
    unhurried.ok && new Set((unhurried.data as RunListRow[]).map((row) => row.runId)).size === RUNS && runIds.every((id) => (unhurried.data as RunListRow[]).some((row) => row.runId === id)),
    unhurried.ok ? (unhurried.data as RunListRow[]).length : unhurried.error);

  console.log(`2. with ${DELAY_MS} ms each way on the manager's link, run-ps answers inside the ${BUDGET_MS} ms budget`);
  delay = DELAY_MS;
  const started = performance.now();
  const slow = await call("run-ps", {}, BUDGET_MS).catch((e: Error) => e);
  const elapsed = Math.round(performance.now() - started);
  delay = 0;
  console.log(`  run-ps took ${elapsed} ms over the delayed link`);
  const rows = slow instanceof Error || !slow.ok ? undefined : slow.data as RunListRow[];
  c(`the delayed list answers ok with all ${RUNS} runs`,
    rows?.length === RUNS, slow instanceof Error ? slow.message : slow.ok ? rows?.length : slow.error);
  c("the delayed list carries the same rows as the undelayed one",
    rows !== undefined && unhurried.ok && JSON.stringify(rows) === JSON.stringify(unhurried.data));
} catch (e) {
  failed++;
  console.log("  ✗ FAIL: the suite threw", (e as Error).stack ?? String(e));
} finally {
  delay = 0;
  const cleanupErrors: unknown[] = [];
  for (const stop of [() => nc?.close(), () => manager?.stop({ withAgents: true }), () => delivery?.stop(), () => killAndAwaitExit(broker)]) {
    try { await stop(); } catch (error) { cleanupErrors.push(error); }
  }
  for (const s of sockets) s.destroy();
  await new Promise<void>((resolve) => proxy.close(() => resolve()));
  releaseBroker();
  // The scratch is this suite's own, and nothing runs in it once the broker and manager are down.
  if (cleanupErrors.length === 0) for (const dir of [home, root, store]) rmSync(dir, { recursive: true, force: true });
  if (cleanupErrors.length) { failed++; console.log("  ✗ FAIL: owned fixture cleanup", cleanupErrors.map(String)); }
  console.log(JSON.stringify({ cleanup: cleanupErrors.length === 0 ? "complete" : "failed", brokerExitCode: broker.exitCode, brokerSignal: broker.signalCode, retainedScratch: cleanupErrors.length === 0 ? [] : [home, root, store] }));
}
console.log(failed === 0 ? "\nrun-ps latency: all cells passed" : `\nrun-ps latency: ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
