/**
 * A supervised seat outlives its manager's crash as one restart of its own policy (#4094).
 *
 * Live: a JWT-auth scratch broker, the real Manager in a child process, the real pty runtime and a
 * stub seat that joins presence. The first manager spawns `worker` with supervise { restarts: 1 }
 * and accepts a turn for it, then is SIGKILLed. On macOS the seat dies with it; on Linux its
 * custodian keeps it and the successor reaps it by reference. The successor must restart the seat
 * under the same principal and lifecycle uid, and the restarted incarnation must pull and yield the
 * turn the dead manager accepted. A second crash past the budget retires the seat instead.
 *
 * Run: pnpm smoke:manager-supervise-crash   (needs nats-server + node on PATH)
 */
import { randomUUID } from "node:crypto";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { connect } from "@nats-io/transport-node";
import {
  CotalEndpoint, DEV_OWNER, createSpaceAuth, epCall, invokeCommand, isReachable,
  mintConnectionEvictorCreds, mintCreds, mintLifecycleUid, mintMembershipObserverCreds, newIdentity,
  principalKey, readAcceptedRow, resolveService, serverConfig, setupSpaceStreams, standaloneConnectOpts,
  type EpCaller, type IssuedCaller,
} from "@cotal-ai/core";
import { agentLifecycleSecretFilePaths, authDir, saveSpaceAuth, workspaceSecretStore } from "@cotal-ai/workspace";
import { SMOKE_BROKER_TOKEN, emitSentinel, freePort, teardownOnSignal } from "@cotal-ai/smoke-kit";
import { MANAGER_CONTRACTS, MANAGER_ENDPOINT } from "../src/manager-service-contract.js";
import { readSeatRecord } from "../src/resume.js";
import { bootDeliveryDaemon, type DeliveryDaemon } from "./_boot-delivery.js";

// Every cell, in order. A cell an earlier failure left unreachable is graded failed, so the suite
// always reaches its completion line.
const CELLS = [
  "the first manager starts a supervised seat and records it with no restart counted",
  "a turn is accepted against the supervised seat",
  "the successor is the same logical manager instance",
  "the successor restarts the supervised seat as one restart of its policy",
  "the restarted seat heartbeats under the same principal and lifecycle uid after the crash",
  "the restarted incarnation pulls the turn the dead manager accepted",
  "the restarted incarnation yields that turn",
  "the record counts the manager crash against the policy",
  "a crash past the budget retires the seat instead of restarting it",
  "the spent record is removed",
];
let pass = 0, fail = 0;
const graded = new Set<string>();
const check = (name: string, condition: boolean, extra?: unknown) => {
  if (!CELLS.includes(name)) throw new Error(`unlisted cell: ${name}`);
  graded.add(name);
  if (condition) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ FAIL: ${name}`, extra ?? ""); }
};
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (read: () => boolean | Promise<boolean>, timeoutMs: number): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { if (await read()) return true; await wait(200); }
  return read();
};
const asValue = (e: unknown) => ({ code: (e as { code?: string }).code, message: String((e as Error).message).slice(0, 240) });
const stopGroup = (pid?: number) => { if (!pid) return; try { process.kill(-pid, "SIGKILL"); } catch { try { process.kill(pid, "SIGKILL"); } catch {} } };
const here = dirname(fileURLToPath(import.meta.url)); const repo = resolve(here, "../../.."); const host = join(here, "_supervise-crash-host.ts"); const tsx = join(repo, "node_modules", ".bin", "tsx");
const ambientEnv: NodeJS.ProcessEnv = { ...process.env };
for (const key of Object.keys(ambientEnv)) if (key.startsWith("COTAL_")) delete ambientEnv[key];

const port = await freePort(); const servers = `nats://127.0.0.1:${port}`; const space = `supcrash-${randomUUID().slice(0, 8)}`;
const auth = await createSpaceAuth(space); const observerCreds = await mintMembershipObserverCreds(auth, newIdentity()); const evictorCreds = await mintConnectionEvictorCreds(auth, newIdentity());
const dir = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN)); const root = join(dir, "ws");
mkdirSync(join(root, ".cotal", "agents"), { recursive: true }); saveSpaceAuth(authDir(root), auth);
writeFileSync(join(root, ".cotal", "agents", "worker.md"), "---\nname: worker\nrole: worker\nsubscribe: []\nallowSubscribe: []\nallowPublish: []\n---\n");
writeFileSync(join(dir, "server.conf"), serverConfig(auth, [auth], { transport: { kind: "plaintext" }, port, storeDir: join(dir, "js") }));
const broker = spawn("nats-server", ["-c", join(dir, "server.conf")], { stdio: "ignore" }); const releaseBroker = teardownOnSignal(broker, dir);
let daemon: DeliveryDaemon | undefined; const managers: ChildProcess[] = [];
let runnerNc: Awaited<ReturnType<typeof connect>> | undefined;

type Host = { child: ChildProcess; manager: { managerPid: number; managerInstanceId: string }; stderr: () => string };
/** Start one manager process. A successor started while the dead one's lease still stands exits on
 *  the lease refusal, so that one exit is retried until the lease lapses. */
async function startHost(): Promise<Host> {
  const deadline = Date.now() + 120_000;
  for (;;) {
    const child = spawn(tsx, [host], { cwd: repo, env: { ...ambientEnv, REPRO_ROOT: root, REPRO_SPACE: space, REPRO_SERVERS: servers, REPRO_OBSERVER_CREDS: observerCreds, REPRO_EVICTOR_CREDS: evictorCreds, REPRO_ACCOUNT_ID: auth.account.pub, COTAL_SERVER: "", COTAL_SERVERS: "", COTAL_CREDS: "", NATS_URL: "" }, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    managers.push(child);
    let out = "", err = "";
    child.stdout?.on("data", (b) => out += String(b)); child.stderr?.on("data", (b) => err += String(b));
    const line = (tag: string) => out.split("\n").find((x) => x.startsWith(`${tag} `))?.slice(tag.length + 1);
    while (Date.now() < deadline) {
      const managerLine = line("REPRO_MANAGER");
      if (managerLine) return { child, manager: JSON.parse(managerLine), stderr: () => err };
      if (child.exitCode !== null) break;
      await wait(100);
    }
    if (child.exitCode === null) throw new Error(`manager readiness timeout: ${err}`);
    if (!/already serves space/.test(err) || Date.now() >= deadline) throw new Error(`manager exited ${child.exitCode}: ${err}`);
    await wait(2_000);
  }
}
async function crash(h: Host): Promise<void> {
  const exited = new Promise((r) => h.child.once("exit", r));
  process.kill(h.manager.managerPid, "SIGKILL");
  await exited;
}

try {
  for (let i = 0; i < 100 && !(await isReachable(servers)); i++) await wait(50);
  await setupSpaceStreams({ servers, space, creds: await mintCreds(auth, newIdentity(), "provisioner") });
  // The shipped daemon's eviction rails: a successor's re-registration evicts the dead manager's
  // serve family through them.
  daemon = await bootDeliveryDaemon({ space, servers, auth, reloadStoreIdentity: workspaceSecretStore(root).identity });

  const first = await startHost();
  const runnerId = newIdentity();
  const runner: EpCaller = { owner: DEV_OWNER, actor: runnerId.id, uid: mintLifecycleUid() };
  runnerNc = await connect({ servers, ...standaloneConnectOpts({ creds: await mintCreds(auth, runnerId, "control-caller-admin", { lifecycleUid: runner.uid }), tls: false }), maxReconnectAttempts: 0 });
  const call = (command: string, args: Record<string, unknown>, opts: { id: string; target?: { actor: string; lifecycleUid: string } }) =>
    epCall(runnerNc!, space, { mode: "one" }, {
      endpoint: MANAGER_ENDPOINT, command, contract: MANAGER_CONTRACTS[command], caller: runner, id: opts.id, args,
      ...(opts.target ? { target: { mode: "owner" as const, owner: DEV_OWNER, actor: opts.target.actor, lifecycleUid: opts.target.lifecycleUid } } : {}),
    }, { deadlineMs: 20_000, currentEpoch: async () => 0 }).then((r) => r.reply, asValue);
  const spawned = await call("spawn", { name: "worker", agent: "supervise-crash-stub", cwd: repo, events: false, supervise: { restarts: 1, windowMs: 600_000 } }, { id: "spawn-worker".padEnd(43, "s") });
  // The record is written once the seat is ready and armed, so it is the readiness signal here.
  let before: ReturnType<typeof readSeatRecord>;
  await until(() => (before = readSeatRecord(root, space, "worker")) !== undefined, 60_000);
  const identity = before?.agent.identity;
  check("the first manager starts a supervised seat and records it with no restart counted",
    (spawned as { ok?: boolean }).ok === true && identity?.mode === "static" && before!.crashes.length === 0 && before!.supervise?.restarts === 1,
    { spawned, before, stderr: first.stderr().slice(-2000) });
  const actor = identity?.mode === "static" ? identity.id : "";
  const uid = identity?.lifecycleUid ?? "";
  const acceptedToken = identity?.mode === "static" ? identity.issued?.acceptedToken ?? "" : "";
  const principal = principalKey(DEV_OWNER, actor).key;

  const goalId = "crash-turn".padEnd(43, "c");
  const accepted = await call("turn", { payload: JSON.stringify({ run: "r1", step: "turn:worker", context: "do the thing" }), deadlineMs: 600_000 }, { id: goalId, target: { actor, lifecycleUid: uid } });
  check("a turn is accepted against the supervised seat", (accepted as { ok?: boolean }).ok === true, accepted);

  const crashedAt = Date.now();
  await crash(first);
  const successor = await startHost();
  check("the successor is the same logical manager instance", successor.manager.managerInstanceId === first.manager.managerInstanceId, { first: first.manager, successor: successor.manager });
  const restarted = await until(() => successor.stderr().includes("worker: restarted under the same lifecycle after its manager stopped (1/1)"), 90_000);
  check("the successor restarts the supervised seat as one restart of its policy", restarted, successor.stderr().slice(-3000));

  const watcherId = newIdentity();
  const watcher = new CotalEndpoint({ space, servers, creds: await mintCreds(auth, watcherId, "observer"), card: { id: watcherId.id, name: "watcher", role: "observer", kind: "endpoint" }, channels: [], consume: false, registerPresence: false, watchPresence: true, watchChannels: false });
  watcher.on("error", () => {});
  await watcher.start();
  let row: { lifecycleUid?: string; ts?: number } | undefined;
  const heartbeat = await until(() => {
    row = watcher.getRoster().find((p) => p.card.id === principal && p.lifecycleUid === uid);
    return (row?.ts ?? 0) > crashedAt;
  }, 30_000);
  await watcher.stop().catch(() => {});
  check("the restarted seat heartbeats under the same principal and lifecycle uid after the crash", heartbeat, row);

  const seatCreds = readFileSync(agentLifecycleSecretFilePaths(root, space, "worker", uid).creds, "utf8");
  const seatNc = await connect({ servers, ...standaloneConnectOpts({ creds: seatCreds, tls: false }), maxReconnectAttempts: 0 });
  try {
    const seatRef = await readAcceptedRow(seatNc, space, acceptedToken);
    const seatTriple: EpCaller = { owner: DEV_OWNER, actor, uid, generation: seatRef.generation } as IssuedCaller;
    let pulled: unknown;
    const pulledTurn = await until(async () => {
      const service = await resolveService(seatNc, space, MANAGER_ENDPOINT, seatTriple).catch(() => undefined);
      if (!service) return false;
      pulled = await invokeCommand(seatNc, space, service, "turn-pending", undefined, { target: { mode: "self" }, deadlineMs: 10_000 }).then((r) => r.reply, asValue);
      const turns = (pulled as { data?: { turns?: Array<{ goalId?: string }> } }).data?.turns ?? [];
      return (pulled as { ok?: boolean }).ok === true && turns.length === 1 && turns[0]?.goalId === goalId;
    }, 30_000);
    check("the restarted incarnation pulls the turn the dead manager accepted", pulledTurn, pulled);
    const service = await resolveService(seatNc, space, MANAGER_ENDPOINT, seatTriple);
    const y = await invokeCommand(seatNc, space, service, "turn-yield", { goalId, status: "done", note: "after the manager crash" }, { target: { mode: "self" }, deadlineMs: 10_000 }).then((r) => r.reply, asValue);
    check("the restarted incarnation yields that turn", (y as { ok?: boolean }).ok === true && (y as { data?: { state?: string } }).data?.state === "succeeded", y);
  } finally {
    await seatNc.drain().catch(() => seatNc.close());
  }
  const after = readSeatRecord(root, space, "worker");
  check("the record counts the manager crash against the policy", after?.agent.identity.lifecycleUid === uid && after.crashes.length === 1, after);

  await crash(successor);
  const third = await startHost();
  const retired = await until(() => /worker: the supervised seat its previous manager left was not restarted \(its supervise restart budget is spent/.test(third.stderr()), 90_000);
  check("a crash past the budget retires the seat instead of restarting it", retired, third.stderr().slice(-3000));
  const removed = await until(() => !existsSync(join(root, ".cotal", "seat-records", space, "worker.json")), 30_000);
  check("the spent record is removed", removed);

} catch (error) {
  for (const name of CELLS) if (!graded.has(name)) check(name, false, `not reached: ${(error as Error).message}`);
} finally {
  await runnerNc?.drain().catch(() => runnerNc?.close());
  const managerExits = managers.map((child) => child.exitCode === null ? new Promise<void>((r) => child.once("exit", () => r())) : Promise.resolve());
  for (const child of managers) if (child.exitCode === null) stopGroup(child.pid);
  await Promise.all(managerExits);
  // A Linux custodian keeps a seat past its manager: end every seat this suite started.
  const seats = spawnSync("pgrep", ["-f", `e2e-stub.mjs ${space}`], { encoding: "utf8" }).stdout.split("\n").map(Number).filter((pid) => pid > 0);
  for (const pid of seats) stopGroup(pid);
  await daemon?.stop().catch(() => {});
  broker.kill("SIGKILL");
  await wait(300);
  rmSync(dir, { recursive: true, force: true });
  releaseBroker();
}

if (pass + fail !== CELLS.length) throw new Error(`expected ${CELLS.length} cells, ran ${pass + fail}; a cell was graded twice or skipped`);
console.log(`\nSUPERVISE MANAGER CRASH SMOKE ${fail === 0 ? "OK ✅" : "FAILED ❌"} (${pass} passed, ${fail} failed)`);
emitSentinel({ passed: pass, failed: fail });
if (fail) process.exitCode = 1;
