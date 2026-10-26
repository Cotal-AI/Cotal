/**
 * One run's program identity from native `run-status`, against the real manager and the real
 * runtime host on an owned static-auth broker.
 *
 * Three seatless runs each log the `programHash` their own `run()` reports. The status hash of each
 * must equal that value and its full `run-ps` row. Then one run's program record is deleted and
 * another's is garbled, each through that run's own `run-driver` row. The missing record yields no
 * hash in the list or the status. The garbled one breaks the full list, which parses every run's
 * program, while the status of an unrelated run still answers with its unchanged hash, and the
 * garbled run's own status reports `programUnreadable` with its journal intact.
 *
 * Lives under bin/smoke because it composes the manager AND the runtime.
 * Needs nats-server on PATH. Run: pnpm smoke:run-status-program-identity
 */
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "@nats-io/transport-node";
import { SMOKE_BROKER_TOKEN, awaitBrokerReady, freePort, killAndAwaitExit, teardownOnSignal } from "@cotal-ai/smoke-kit";

const home = mkdtempSync(join(tmpdir(), "cotal-run-identity-home-"));
for (const key of Object.keys(process.env)) if (key.startsWith("COTAL_")) delete process.env[key];
process.env.COTAL_HOME = home;
process.env.COTAL_SKIP_CONNECTOR_SEED = "1";

const core = await import("@cotal-ai/core");
const workspace = await import("@cotal-ai/workspace");
const { Manager } = await import("@cotal-ai/manager");
// Importing the runtime is what registers the `cotal-lang` run host the manager resolves.
await import("@cotal-ai/runtime");
const { bootDeliveryDaemon } = await import("../../implementations/manager/smoke/_boot-delivery.js");
type RunStatusView = import("@cotal-ai/core").RunStatusView;
type RunListRow = import("@cotal-ai/core").RunListRow;
type EpCaller = import("@cotal-ai/core").EpCaller;
type EndpointReply = import("@cotal-ai/core").EndpointReply;

let failed = 0;
const c = (name: string, ok: boolean, extra?: unknown) => {
  if (ok) console.log(`  ✓ ${name}`);
  else { failed++; console.log(`  ✗ FAIL: ${name}`, extra !== undefined ? JSON.stringify(extra) : ""); }
};

// The manager writes each hosted log line to stderr as `run <id>: log <text>`.
const reported = new Map<string, string>();
const realError = console.error;
console.error = (...a: unknown[]) => {
  const line = a.map(String).join(" ");
  const m = /^run (\S+): log program (\S+)$/.exec(line);
  if (m) reported.set(m[1]!, m[2]!);
  realError(...a);
};

const program = (tag: string) => `const r = run();\nlog("program", r.programHash);\nlog("tag", "${tag}");\n`;
const SOURCES = { a: program("a"), b: program("b"), c: program("c") };

const space = `runidentity${core.mintLifecycleUid().slice(0, 8)}`;
const auth = await core.createSpaceAuth(space);
const root = mkdtempSync(join(tmpdir(), "cotal-run-identity-project-"));
mkdirSync(join(root, ".cotal"));
workspace.saveSpaceAuth(workspace.authDir(root), auth);
const port = await freePort();
const servers = `nats://127.0.0.1:${port}`;
const store = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
writeFileSync(join(store, "server.conf"), core.serverConfig(auth, [auth], {
  transport: { kind: "plaintext" }, host: "127.0.0.1", port, storeDir: join(store, "js"),
}), { mode: 0o600 });
const broker = spawn("nats-server", ["-c", join(store, "server.conf")], { stdio: "ignore" });
const releaseBroker = teardownOnSignal(broker);
let manager: InstanceType<typeof Manager> | undefined;
let delivery: Awaited<ReturnType<typeof bootDeliveryDaemon>> | undefined;
let nc: Awaited<ReturnType<typeof connect>> | undefined;
try {
  await awaitBrokerReady(() => core.isReachable(servers), { servers, attempts: 50, delayMs: 100 });
  await core.setupSpaceStreams({ servers, space, creds: await core.mintCreds(auth, core.newIdentity(), "provisioner") });
  workspace.recordMesh({ space, server: servers, root, mode: "auth", ts: new Date().toISOString() });
  delivery = await bootDeliveryDaemon({ space, servers, auth, reloadStoreIdentity: workspace.workspaceSecretStore(root).identity });
  manager = new Manager({ space, servers, runtime: "pty", workspaceRoot: root });
  await manager.start();

  const identity = core.newIdentity();
  const uid = core.mintLifecycleUid();
  const issued = { generation: core.mintGeneration(), acceptedToken: core.mintAcceptedToken() };
  const caller = { owner: core.DEV_OWNER, actor: identity.id, uid, generation: issued.generation } as EpCaller;
  const creds = await core.withIssuerSession({ servers, space, auth, tls: false }, (session) => core.mintCreds(auth, identity, "agent", {
    lifecycleUid: uid, capabilities: ["run"], expiresInSeconds: 600, issued,
    issuance: { mode: "issue", store: session.store, accepted: session.accepted, sources: [] },
  }));
  nc = await connect({ servers, ...core.standaloneConnectOpts({ creds, tls: false }), maxReconnectAttempts: 0 });
  const service = await core.resolveService(nc, space, "manager", caller, { deadlineMs: 10_000 });
  const call = async (command: string, args: Record<string, unknown>): Promise<EndpointReply> =>
    (await core.invokeCommand(nc!, space, service, command, args, { deadlineMs: 30_000, currentEpoch: async () => 0 })).reply;
  const status = async (runId: string, extra: Record<string, unknown> = {}): Promise<RunStatusView> => {
    const r = await call("run-status", { runId, ...extra });
    if (!r.ok) throw new Error(`run-status ${runId}: ${JSON.stringify(r.error)}`);
    return r.data as RunStatusView;
  };
  const list = async (): Promise<Map<string, RunListRow>> => {
    const r = await call("run-ps", {});
    if (!r.ok) throw new Error(`run-ps: ${JSON.stringify(r.error)}`);
    return new Map((r.data as RunListRow[]).map((row) => [row.runId, row]));
  };

  console.log("1. three seatless runs complete, each logging the programHash its run() reports");
  const runs: Record<keyof typeof SOURCES, string> = { a: "", b: "", c: "" };
  for (const [name, source] of Object.entries(SOURCES) as [keyof typeof SOURCES, string][]) {
    const started = await call("run-start", { source, file: `${name}.cotal.js` });
    if (!started.ok) throw new Error(`run-start ${name}: ${JSON.stringify(started.error)}`);
    runs[name] = (started.data as { runId: string }).runId;
  }
  const done = async (runId: string): Promise<RunStatusView> => {
    for (let i = 0; i < 100; i++) {
      const view = await status(runId);
      if (view.status?.state === "completed" && reported.has(runId)) return view;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`run ${runId} did not complete with a logged programHash`);
  };
  const before = { a: await done(runs.a), b: await done(runs.b), c: await done(runs.c) };
  c("every run completed and its program reported a distinct programHash",
    new Set(Object.values(runs).map((id) => reported.get(id))).size === 3, Object.fromEntries(reported));

  console.log("2. the status hash is the hash the program reports and the one its full run-ps row carries");
  const rows = await list();
  for (const name of ["a", "b", "c"] as const) {
    const id = runs[name];
    c(`run ${name}: run-status programHash === run() programHash === run-ps programHash`,
      before[name].programHash !== undefined && before[name].programHash === reported.get(id) && before[name].programHash === rows.get(id)?.programHash
        && before[name].programUnreadable === undefined,
      { status: before[name].programHash, reported: reported.get(id), row: rows.get(id)?.programHash });
  }
  const paged = await status(runs.a, { journal: { offset: 0 } });
  c("a journal page carries the same programHash beside journalTotal",
    paged.programHash === before.a.programHash && paged.journalTotal === before.a.journal.length, { programHash: paged.programHash, journalTotal: paged.journalTotal });

  // Each record is rewritten through that run's own driver row, the narrowest credential that can
  // write it; the manager's instance id pins it as it pins a real drive.
  const asDriver = async <T>(runId: string, view: RunStatusView, fn: (kv: Awaited<ReturnType<typeof core.openRecordsBucket>>, key: string) => Promise<T>): Promise<T> => {
    const driver = core.newIdentity();
    const driverCreds = await core.mintCreds(auth, driver, "run-driver", {
      runDriver: { endpoint: "manager", runId, takeoverId: core.newTakeoverId(), instanceId: service.responder.instanceId, epoch: view.status?.epoch ?? 0 },
    });
    const dnc = await connect({ servers, ...core.standaloneConnectOpts({ creds: driverCreds, tls: false }), maxReconnectAttempts: 0 });
    try {
      return await fn(await core.openRecordsBucket(dnc, space), core.recordAtomicKey(core.RECORD_KINDS.program!, ["manager", runId]));
    } finally { await dnc.close(); }
  };

  console.log("3. a run whose program record is gone has no programHash, in the list or the status");
  await asDriver(runs.c, before.c, (kv, key) => kv.delete(key));
  const missing = await status(runs.c);
  const rowsAfterDelete = await list();
  c("run c: status has neither programHash nor programUnreadable, and its run-ps row has no programHash",
    !("programHash" in missing) && !("programUnreadable" in missing) && rowsAfterDelete.has(runs.c) && !("programHash" in rowsAfterDelete.get(runs.c)!),
    { status: missing.programHash, unreadable: missing.programUnreadable, row: rowsAfterDelete.get(runs.c) });
  c("run c: the rest of its view is unchanged", JSON.stringify({ ...missing }) === JSON.stringify((({ programHash: _h, ...rest }) => rest)(before.c)), { missing, before: before.c });

  console.log("4. a garbled program record breaks the full list, but no other run's status reads it");
  await asDriver(runs.b, before.b, (kv, key) => kv.put(key, new TextEncoder().encode(JSON.stringify({ v: 1, run: runs.b, source: SOURCES.b, at: 1, extra: true }))));
  const ps = await call("run-ps", {});
  c("run-ps, which parses every run's program, now refuses internal on run b's record",
    ps.ok === false && ps.error?.code === "internal" && String(ps.error?.message).includes("unknown field"), ps.ok ? "ok" : ps.error);
  const unrelated = await status(runs.a);
  c("run a: status still answers with the same programHash and the same view, so it read nothing of run b",
    JSON.stringify(unrelated) === JSON.stringify(before.a), { after: unrelated.programHash, before: before.a.programHash });
  const garbled = await status(runs.b);
  c("run b: status reports programUnreadable with the parse refusal and no programHash",
    !("programHash" in garbled) && typeof garbled.programUnreadable === "string" && garbled.programUnreadable.includes("unknown field"), garbled.programUnreadable);
  c("run b: endpoint, spec, status, revocation and journal are unchanged",
    garbled.endpoint === "manager" && JSON.stringify(garbled.spec) === JSON.stringify(before.b.spec) && JSON.stringify(garbled.status) === JSON.stringify(before.b.status)
      && garbled.revoked === undefined && garbled.revocationUnreadable === undefined && JSON.stringify(garbled.journal) === JSON.stringify(before.b.journal));
} catch (e) {
  failed++;
  console.log("  ✗ FAIL: the suite threw", (e as Error).stack ?? String(e));
} finally {
  console.error = realError;
  const cleanupErrors: unknown[] = [];
  for (const stop of [() => nc?.close(), () => manager?.stop({ withAgents: true }), () => delivery?.stop(), () => killAndAwaitExit(broker)]) {
    try { await stop(); } catch (error) { cleanupErrors.push(error); }
  }
  releaseBroker();
  // The scratch is this suite's own, and nothing runs in it once the broker and manager are down.
  if (cleanupErrors.length === 0) for (const dir of [home, root, store]) rmSync(dir, { recursive: true, force: true });
  if (cleanupErrors.length) { failed++; console.log("  ✗ FAIL: owned fixture cleanup", cleanupErrors.map(String)); }
  console.log(JSON.stringify({ cleanup: cleanupErrors.length === 0 ? "complete" : "failed", brokerExitCode: broker.exitCode, brokerSignal: broker.signalCode, retainedScratch: cleanupErrors.length === 0 ? [] : [home, root, store] }));
}
console.log(failed === 0 ? "\nrun-status program identity: all cells passed" : `\nrun-status program identity: ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
