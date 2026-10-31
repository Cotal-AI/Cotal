/**
 * A once seat's task across its manager's crash.
 *
 * Live: a JWT-auth scratch broker, the real Manager in a child process, the real pty runtime and
 * stub seats that join presence. The first manager spawns two once seats, one with no deadline and
 * one with a deadline, then is SIGKILLed. A built-in pty seat records no custody reference and
 * dies with its manager, so the successor's static reconcile cannot adopt either seat. Its exit is
 * then proved, and each task must be cancelled `seat-exited` at once rather than wait for a
 * deadline, or forever when there is none. Retrying the original spawn after the restart must
 * start no second seat and no second task. A manager that then dies between a task's goal and its
 * deadline hold has launched no seat, and the next manager must cancel that task. One that dies
 * after a seat joined but before its spawn's succeeded terminal never served that seat its task, and
 * the next manager must cancel the task as never served.
 *
 * Run: pnpm smoke:spawn-once-restart   (needs nats-server + node on PATH)
 */
import { randomUUID } from "node:crypto";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { connect } from "@nats-io/transport-node";
import { Kvm } from "@nats-io/kv";
import {
  DEV_OWNER, createSpaceAuth, digestIdToken, epCall, isReachable, listGoalIndex, mintConnectionEvictorCreds, mintCreds,
  mintLifecycleUid, mintMembershipObserverCreds, newIdentity, recordsBucket, serverConfig, setupSpaceStreams,
  standaloneConnectOpts, type EpCaller,
} from "@cotal-ai/core";
import { authDir, saveSpaceAuth, workspaceSecretStore } from "@cotal-ai/workspace";
import { SMOKE_BROKER_TOKEN, emitSentinel, freePort, teardownOnSignal } from "@cotal-ai/smoke-kit";
import { MANAGER_CONTRACTS, MANAGER_ENDPOINT } from "../src/manager-service-contract.js";
import { bootDeliveryDaemon, type DeliveryDaemon } from "./_boot-delivery.js";

// Every cell, in order. A cell an earlier failure left unreachable is graded failed, so the suite
// always reaches its completion line.
const CELLS = [
  "the first manager starts two once seats, one with no deadline and one with a deadline",
  "both seats die with the crashed manager",
  "the successor is the same logical manager instance",
  "the successor cancels the task with no deadline `seat-exited` once its reconcile rules the seat out",
  "...and the task with a deadline the same way, without waiting for that deadline",
  "...and drops both tasks' index entries",
  "...after the successor asked the connector the task names to prove each seat's launch gone, and discarded each proof after its clear",
  "the original spawn retried after the restart starts no second seat and no second task",
  "a manager that dies between a task's goal and its deadline hold has launched no seat",
  "the next manager cancels that task `launch-failed` and drops its index entry",
  "a manager that dies after a seat joined and before its spawn's succeeded terminal leaves the task recorded",
  "the next manager cancels that task as never served, and drops its index entry once the seat is ruled out",
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
  while (Date.now() < deadline) { if (await read()) return true; await wait(250); }
  return read();
};
const asValue = (e: unknown) => ({ ok: false, code: (e as { code?: string }).code, message: String((e as Error).message).slice(0, 240) });
const stopGroup = (pid?: number) => { if (!pid) return; try { process.kill(-pid, "SIGKILL"); } catch { try { process.kill(pid, "SIGKILL"); } catch {} } };
const here = dirname(fileURLToPath(import.meta.url)); const repo = resolve(here, "../../.."); const host = join(here, "_once-crash-host.ts"); const tsx = join(repo, "node_modules", ".bin", "tsx");
const ambientEnv: NodeJS.ProcessEnv = { ...process.env };
for (const key of Object.keys(ambientEnv)) if (key.startsWith("COTAL_")) delete ambientEnv[key];

const port = await freePort(); const servers = `nats://127.0.0.1:${port}`; const space = `oncecrash-${randomUUID().slice(0, 8)}`;
const auth = await createSpaceAuth(space); const observerCreds = await mintMembershipObserverCreds(auth, newIdentity()); const evictorCreds = await mintConnectionEvictorCreds(auth, newIdentity());
const seatPids = (name: string) => {
  const result = spawnSync("pgrep", ["-f", `e2e-stub.mjs ${space} ${name}$`], { encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0 && result.status !== 1) throw new Error(`seat process census exited ${result.status}: ${result.stderr}`);
  return result.stdout.split("\n").map(Number).filter((pid) => pid > 0);
};
const dir = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN)); const root = join(dir, "ws");
mkdirSync(join(root, ".cotal", "agents"), { recursive: true }); saveSpaceAuth(authDir(root), auth);
for (const name of ["open", "timed", "held", "early"]) writeFileSync(join(root, ".cotal", "agents", `${name}.md`), `---\nname: ${name}\nrole: worker\nsubscribe: []\nallowSubscribe: []\nallowPublish: []\n---\n`);
writeFileSync(join(dir, "server.conf"), serverConfig(auth, [auth], { transport: { kind: "plaintext" }, port, storeDir: join(dir, "js") }));
const broker = spawn("nats-server", ["-c", join(dir, "server.conf")], { stdio: "ignore" }); const releaseBroker = teardownOnSignal(broker, dir);
let daemon: DeliveryDaemon | undefined; const managers: ChildProcess[] = [];
let runnerNc: Awaited<ReturnType<typeof connect>> | undefined;
let indexNc: Awaited<ReturnType<typeof connect>> | undefined;

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
  daemon = await bootDeliveryDaemon({ space, servers, auth, reloadStoreIdentity: workspaceSecretStore(root).identity });

  const first = await startHost();
  const runnerId = newIdentity();
  const runner: EpCaller = { owner: DEV_OWNER, actor: runnerId.id, uid: mintLifecycleUid() };
  runnerNc = await connect({ servers, ...standaloneConnectOpts({ creds: await mintCreds(auth, runnerId, "control-caller-admin", { lifecycleUid: runner.uid }), tls: false }), maxReconnectAttempts: 0 });
  // The manager's serve epoch: each restart registers the next one.
  let epoch = 0;
  const call = (command: string, args: Record<string, unknown>, id?: string) =>
    epCall(runnerNc!, space, { mode: "one" }, { endpoint: MANAGER_ENDPOINT, command, contract: MANAGER_CONTRACTS[command], caller: runner, ...(id !== undefined ? { id } : {}), args }, { deadlineMs: 20_000, currentEpoch: async () => epoch })
      .then((r) => r.reply as { ok?: boolean; data?: Record<string, unknown> }, asValue);
  const resultOf = async (goalId: string): Promise<{ state?: string; data?: { reason?: string } } | undefined> =>
    ((await call("goal-result", { goalId })) as { data?: { result?: { state?: string; data?: { reason?: string } } } }).data?.result;
  // The goal index, read with the provisioner credential a successor's own boot sweep reads it with.
  indexNc = await connect({ servers, ...standaloneConnectOpts({ creds: await mintCreds(auth, newIdentity(), "provisioner"), tls: false }), maxReconnectAttempts: 0 });
  const indexed = async (goalId: string) => (await listGoalIndex(await new Kvm(indexNc!).open(recordsBucket(space)), MANAGER_ENDPOINT)).some((e) => e.ref.goalId === goalId);

  const spawnIds = { open: "spawn-open".padEnd(43, "o"), timed: "spawn-timed".padEnd(43, "t") };
  const spawnArgs = (name: "open" | "timed") => ({ name, agent: "once-crash-stub", cwd: repo, events: false, prompt: `the ${name} task`, once: { deadlineMs: name === "open" ? -1 : 600_000 } });
  const spawned = [await call("spawn", spawnArgs("open"), spawnIds.open), await call("spawn", spawnArgs("timed"), spawnIds.timed)];
  const ready = await until(async () => (await resultOf(spawnIds.open))?.state === "succeeded" && (await resultOf(spawnIds.timed))?.state === "succeeded", 60_000);
  const tasks = { open: digestIdToken(`${spawnIds.open}:once`), timed: digestIdToken(`${spawnIds.timed}:once`) };
  const pidsBefore = [...seatPids("open"), ...seatPids("timed")];
  check("the first manager starts two once seats, one with no deadline and one with a deadline",
    spawned.every((r) => r.ok === true) && ready && pidsBefore.length === 2 && await indexed(tasks.open) && await indexed(tasks.timed),
    { spawned, ready, pidsBefore, stderr: first.stderr().slice(-2000) });

  await crash(first);
  check("both seats die with the crashed manager", await until(() => seatPids("open").length === 0 && seatPids("timed").length === 0, 15_000), [...seatPids("open"), ...seatPids("timed")]);
  const successor = await startHost();
  epoch = 1;
  check("the successor is the same logical manager instance", successor.manager.managerInstanceId === first.manager.managerInstanceId, { first: first.manager, successor: successor.manager });

  let open: Awaited<ReturnType<typeof resultOf>>, timed: Awaited<ReturnType<typeof resultOf>>;
  const openSettled = await until(async () => (open = await resultOf(tasks.open)) !== undefined, 90_000);
  check("the successor cancels the task with no deadline `seat-exited` once its reconcile rules the seat out",
    openSettled && open?.state === "cancelled" && open.data?.reason === "seat-exited", { open, stderr: successor.stderr().slice(-3000) });
  await until(async () => (timed = await resultOf(tasks.timed)) !== undefined, 30_000);
  check("...and the task with a deadline the same way, without waiting for that deadline", timed?.state === "cancelled" && timed.data?.reason === "seat-exited", timed);
  check("...and drops both tasks' index entries", await until(async () => !(await indexed(tasks.open)) && !(await indexed(tasks.timed)), 30_000));
  const uids = await Promise.all(Object.values(spawnIds).map(async (id) => ((await resultOf(id))?.data as { lifecycleUid?: string } | undefined)?.lifecycleUid));
  const retireLog = () => { try { return readFileSync(join(root, "retire.log"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as { retire?: string; discard?: string; name?: string; manager: number }); } catch { return []; } };
  const log = retireLog();
  check("...after the successor asked the connector the task names to prove each seat's launch gone, and discarded each proof after its clear",
    uids.every((uid) => uid !== undefined
      && log.some((e) => e.retire === uid && e.manager === successor.manager.managerPid)
      && log.findIndex((e) => e.discard === uid) > log.findIndex((e) => e.retire === uid))
      && log.every((e) => e.manager === successor.manager.managerPid),
    { uids, log });

  const retried = await call("spawn", spawnArgs("open"), spawnIds.open);
  await wait(3_000);
  check("the original spawn retried after the restart starts no second seat and no second task",
    seatPids("open").length === 0 && !(await indexed(tasks.open)) && (await resultOf(tasks.open))?.state === "cancelled", { retried, pids: seatPids("open") });

  // The successor dies at the hold write of the next once spawn: the task's goal and index entry
  // exist, its hold does not, and its seat was never launched.
  const heldId = "spawn-held".padEnd(43, "h");
  const heldTask = digestIdToken(`${heldId}:once`);
  const successorExit = successor.child.exitCode === null ? new Promise<void>((r) => successor.child.once("exit", () => r())) : Promise.resolve();
  writeFileSync(join(root, "crash-at-hold"), "");
  void call("spawn", { name: "held", agent: "once-crash-stub", cwd: repo, events: false, prompt: "the held task", once: { deadlineMs: 600_000 } }, heldId);
  const died = await Promise.race([successorExit.then(() => true), wait(30_000).then(() => false)]);
  check("a manager that dies between a task's goal and its deadline hold has launched no seat",
    died && seatPids("held").length === 0 && await indexed(heldTask), { died, pids: seatPids("held"), stderr: successor.stderr().slice(-1500) });
  const third = await startHost();
  epoch = 2;
  let held: Awaited<ReturnType<typeof resultOf>>;
  await until(async () => (held = await resultOf(heldTask)) !== undefined, 60_000);
  check("the next manager cancels that task `launch-failed` and drops its index entry",
    held?.state === "cancelled" && held.data?.reason === "launch-failed" && await until(async () => !(await indexed(heldTask)), 30_000), { held, stderr: third.stderr().slice(-2000) });

  // The third manager dies at the step before a once spawn's succeeded terminal: the seat joined,
  // delivery never opened, and the seat dies with its manager.
  const earlyId = "spawn-early".padEnd(43, "e");
  const earlyTask = digestIdToken(`${earlyId}:once`);
  const thirdExit = third.child.exitCode === null ? new Promise<void>((r) => third.child.once("exit", () => r())) : Promise.resolve();
  writeFileSync(join(root, "crash-at-success"), "");
  void call("spawn", { name: "early", agent: "once-crash-stub", cwd: repo, events: false, prompt: "the early task", once: { deadlineMs: 600_000 } }, earlyId);
  const diedEarly = await Promise.race([thirdExit.then(() => true), wait(60_000).then(() => false)]);
  check("a manager that dies after a seat joined and before its spawn's succeeded terminal leaves the task recorded",
    diedEarly && await indexed(earlyTask) && await until(() => seatPids("early").length === 0, 15_000), { diedEarly, pids: seatPids("early"), stderr: third.stderr().slice(-1500) });
  const fourth = await startHost();
  epoch = 3;
  let early: Awaited<ReturnType<typeof resultOf>>;
  await until(async () => (early = await resultOf(earlyTask)) !== undefined, 60_000);
  const earlySpawn = await resultOf(earlyId);
  check("the next manager cancels that task as never served, and drops its index entry once the seat is ruled out",
    early?.state === "cancelled" && early.data?.reason === "never served: the manager restarted before the spawn's readiness verdict"
      && earlySpawn?.state !== "succeeded" && await until(async () => !(await indexed(earlyTask)), 30_000), { early, earlySpawn, stderr: fourth.stderr().slice(-2000) });
} catch (error) {
  for (const name of CELLS) if (!graded.has(name)) check(name, false, `not reached: ${(error as Error).message}`);
} finally {
  await runnerNc?.drain().catch(() => runnerNc?.close());
  await indexNc?.drain().catch(() => indexNc?.close());
  const managerExits = managers.map((child) => child.exitCode === null ? new Promise<void>((r) => child.once("exit", () => r())) : Promise.resolve());
  for (const child of managers) if (child.exitCode === null) stopGroup(child.pid);
  await Promise.all(managerExits);
  // End every seat this suite started, by its own command line.
  for (const pid of [...seatPids("open"), ...seatPids("timed"), ...seatPids("held"), ...seatPids("early")]) stopGroup(pid);
  await daemon?.stop().catch(() => {});
  broker.kill("SIGKILL");
  await wait(300);
  rmSync(dir, { recursive: true, force: true });
  releaseBroker();
}

if (pass + fail !== CELLS.length) throw new Error(`expected ${CELLS.length} cells, ran ${pass + fail}; a cell was graded twice or skipped`);
console.log(`\nSPAWN ONCE RESTART SMOKE ${fail === 0 ? "OK ✅" : "FAILED ❌"} (${pass} passed, ${fail} failed)`);
emitSentinel({ passed: pass, failed: fail });
if (fail) process.exitCode = 1;
