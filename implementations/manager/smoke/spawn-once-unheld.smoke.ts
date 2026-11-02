/**
 * A once seat its manager does not hold after a restart.
 *
 * On an open mesh a manager adopts no seats, so a successor can neither reach a seat its
 * predecessor started nor prove it gone. It never serves that seat its task. It ends the task at its
 * deadline or, with none, settles it `uncertain` after one readiness window, and the outcome says
 * the manager does not hold the seat. The task's index entry, the seat's debt, stays recorded, and
 * every pull from that seat is answered `stop` for as long as it does: an answer lost on the way is
 * asked for again and given again, and a restarted manager rebuilds it from the debt. The notice
 * that makes an idle seat pull repeats until a pull has carried the stop.
 *
 * Live: a scratch open-mesh broker, the real Manager in a child process on the pty runtime, and
 * seats that join presence and outlive their manager's SIGKILL. The suite pulls as each seat, under
 * that seat's own triple.
 *
 * Run: pnpm smoke:spawn-once-unheld   (needs nats-server + node on PATH)
 */
import { randomUUID } from "node:crypto";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SMOKE_BROKER_TOKEN, emitSentinel, freePort, teardownOnSignal } from "@cotal-ai/smoke-kit";

const dir = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN)); const root = join(dir, "ws"); const home = join(dir, "home");
// The mesh registry is read from COTAL_HOME, so it is set before the workspace module loads.
process.env.COTAL_HOME = home;
const { connect } = await import("@nats-io/transport-node");
const { Kvm } = await import("@nats-io/kv");
const { DEV_OWNER, epCall, invokeCommand, isReachable, listGoalIndex, mintLifecycleUid, newIdentity, recordsBucket, resolveService, turnNoticeFilter, digestIdToken } = await import("@cotal-ai/core");
const { recordMesh } = await import("@cotal-ai/workspace");
const { MANAGER_CONTRACTS, MANAGER_ENDPOINT } = await import("../src/manager-service-contract.js");
const { hostTimerWriter } = await import("./_timer-writer.js");
type EpCaller = import("@cotal-ai/core").EpCaller;

// Every cell, in order. A cell an earlier failure left unreachable is graded failed, so the suite
// always reaches its completion line.
const CELLS = [
  "the first manager starts two once seats, one with no deadline and one with a deadline, and serves each its task",
  "both seats outlive the crashed manager",
  "the successor serves neither task to a seat it does not hold, and tells neither seat to stop while its task is open",
  "the task with no deadline is settled `uncertain` after one readiness window, saying the manager does not hold the seat",
  "the seat's notice repeats while no pull has carried the stop",
  "its pull is answered `stop` with no turn, and a pull repeated after a lost answer is answered `stop` again",
  "the notice stops repeating once a pull has carried the stop",
  "the task with a deadline fails `turn-deadline` at it, saying the manager does not hold the seat, and its seat is told to stop",
  "both seats' debts stay recorded, since nothing proved either seat gone",
  "a manager restarted again rebuilds the stop from the debt: its notice repeats and the seat's pull is answered `stop`",
];
let pass = 0, fail = 0;
const graded = new Set<string>();
const check = (name: string, condition: boolean, extra?: unknown) => {
  if (!CELLS.includes(name)) throw new Error(`unlisted cell: ${name}`);
  graded.add(name);
  if (condition) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ FAIL: ${name}`, extra ?? ""); }
};
const UNHELD = "the manager does not hold the seat; it may still be running";
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (read: () => boolean | Promise<boolean>, timeoutMs: number): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { if (await read()) return true; await wait(250); }
  return read();
};
const asValue = (e: unknown) => ({ ok: false, code: (e as { code?: string }).code, message: String((e as Error).message).slice(0, 240) });
const here = dirname(fileURLToPath(import.meta.url)); const repo = resolve(here, "../../.."); const host = join(here, "_once-unheld-host.ts"); const tsx = join(repo, "node_modules", ".bin", "tsx");
const ambientEnv: NodeJS.ProcessEnv = { ...process.env };
for (const key of Object.keys(ambientEnv)) if (key.startsWith("COTAL_")) delete ambientEnv[key];

const port = await freePort(); const servers = `nats://127.0.0.1:${port}`; const space = `onceunheld-${randomUUID().slice(0, 8)}`;
const seatPids = (name: string) => {
  const result = spawnSync("pgrep", ["-f", `_once-unheld-seat.cjs ${space} ${name}$`], { encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0 && result.status !== 1) throw new Error(`seat process census exited ${result.status}: ${result.stderr}`);
  return result.stdout.split("\n").map(Number).filter((pid) => pid > 0);
};
mkdirSync(join(root, ".cotal", "agents"), { recursive: true });
for (const name of ["open", "timed"]) writeFileSync(join(root, ".cotal", "agents", `${name}.md`), `---\nname: ${name}\nrole: worker\n---\n`);
recordMesh({ space, server: servers, root, mode: "open", ts: new Date().toISOString() });
const broker = spawn("nats-server", ["-a", "127.0.0.1", "-p", String(port), "-js", "-sd", join(dir, "js")], { stdio: "ignore" }); const releaseBroker = teardownOnSignal(broker, dir);
const managers: ChildProcess[] = [];
const conns: Awaited<ReturnType<typeof connect>>[] = [];
let writer: Awaited<ReturnType<typeof hostTimerWriter>> | undefined;

type Host = { child: ChildProcess; manager: { managerPid: number; managerInstanceId: string }; stderr: () => string };
/** Start one manager process. A successor started while the dead one's lease still stands exits on
 *  the lease refusal, so that one exit is retried until the lease lapses. */
async function startHost(): Promise<Host> {
  const deadline = Date.now() + 120_000;
  for (;;) {
    const child = spawn(tsx, [host], { cwd: repo, env: { ...ambientEnv, COTAL_HOME: home, REPRO_ROOT: root, REPRO_SPACE: space, REPRO_SERVERS: servers, REPRO_READINESS_MS: "5000", NATS_URL: "" }, detached: true, stdio: ["ignore", "pipe", "pipe"] });
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
  const first = await startHost();
  const nc = await connect({ servers, maxReconnectAttempts: 0 }); conns.push(nc);
  writer = await hostTimerWriter(await connect({ servers, maxReconnectAttempts: 0 }).then((c) => { conns.push(c); return c; }), space, { pollMs: 1_000 });
  const runner: EpCaller = { owner: DEV_OWNER, actor: newIdentity().id, uid: mintLifecycleUid() };
  // The manager's serve epoch: each restart registers the next one.
  let epoch = 0;
  const call = (command: string, args: Record<string, unknown>, id?: string) =>
    epCall(nc, space, { mode: "one" }, { endpoint: MANAGER_ENDPOINT, command, contract: MANAGER_CONTRACTS[command], caller: runner, ...(id !== undefined ? { id } : {}), args }, { deadlineMs: 20_000, currentEpoch: async () => epoch })
      .then((r) => r.reply as { ok?: boolean; data?: Record<string, unknown> }, asValue);
  type Result = { state?: string; data?: { reason?: string; seat?: string; id?: string; lifecycleUid?: string } };
  const resultOf = async (goalId: string): Promise<Result | undefined> =>
    ((await call("goal-result", { goalId })) as { data?: { result?: Result } }).data?.result;
  const index = await new Kvm(nc).open(recordsBucket(space));
  const indexed = async (goalId: string) => (await listGoalIndex(index, MANAGER_ENDPOINT)).some((e) => e.ref.goalId === goalId);
  /** The seat's pull, made under the seat's own triple as its connector makes it. */
  const pull = async (seat: EpCaller) => {
    try {
      const service = await resolveService(nc, space, MANAGER_ENDPOINT, seat);
      const reply = (await invokeCommand(nc, space, service, "turn-pending", undefined, { target: { mode: "self" }, deadlineMs: 10_000 })).reply as { ok?: boolean; data?: { turns?: unknown[]; stop?: true } };
      return reply.ok === true ? reply.data : undefined;
    } catch { return undefined; }
  };

  const spawnIds = { open: "unheld-open".padEnd(43, "o"), timed: "unheld-timed".padEnd(43, "t") };
  const tasks = { open: digestIdToken(`${spawnIds.open}:once`), timed: digestIdToken(`${spawnIds.timed}:once`) };
  // The deadline falls after the restart and the open task's settle, and before the second restart.
  const spawned = [
    await call("spawn", { name: "open", agent: "once-unheld-stub", cwd: repo, events: false, prompt: "the open task", once: { deadlineMs: -1 } }, spawnIds.open),
    await call("spawn", { name: "timed", agent: "once-unheld-stub", cwd: repo, events: false, prompt: "the timed task", once: { deadlineMs: 45_000 } }, spawnIds.timed),
  ];
  let openSpawn: Result | undefined, timedSpawn: Result | undefined;
  const ready = await until(async () => (openSpawn = await resultOf(spawnIds.open))?.state === "succeeded" && (timedSpawn = await resultOf(spawnIds.timed))?.state === "succeeded", 60_000);
  const seatOf = (r: Result | undefined): EpCaller => ({ owner: DEV_OWNER, actor: String(r?.data?.id), uid: String(r?.data?.lifecycleUid) });
  const seats = { open: seatOf(openSpawn), timed: seatOf(timedSpawn) };
  const served = [await pull(seats.open), await pull(seats.timed)];
  check("the first manager starts two once seats, one with no deadline and one with a deadline, and serves each its task",
    spawned.every((r) => r.ok === true) && ready && served.every((s) => s?.turns?.length === 1 && s.stop === undefined) && seatPids("open").length === 1 && seatPids("timed").length === 1,
    { spawned, ready, served, stderr: first.stderr().slice(-2000) });

  // Every notice each seat is sent, from any epoch of this manager instance.
  const notices = { open: 0, timed: 0 };
  for (const name of ["open", "timed"] as const) nc.subscribe(turnNoticeFilter(space, first.manager.managerInstanceId, seats[name]), { callback: () => { notices[name]++; } });

  await crash(first);
  await wait(1_000);
  check("both seats outlive the crashed manager", seatPids("open").length === 1 && seatPids("timed").length === 1, [...seatPids("open"), ...seatPids("timed")]);
  const successor = await startHost();
  epoch = 1;
  let early: Awaited<ReturnType<typeof pull>>[] = [];
  await until(async () => (early = [await pull(seats.open), await pull(seats.timed)]).every((p) => p !== undefined), 30_000);
  check("the successor serves neither task to a seat it does not hold, and tells neither seat to stop while its task is open",
    early.every((p) => p?.turns?.length === 0 && p.stop === undefined) && await resultOf(tasks.open) === undefined, { early, stderr: successor.stderr().slice(-2000) });

  let open: Result | undefined;
  await until(async () => (open = await resultOf(tasks.open)) !== undefined, 30_000);
  check("the task with no deadline is settled `uncertain` after one readiness window, saying the manager does not hold the seat",
    open?.state === "uncertain" && String(open.data?.reason).includes(UNHELD), open);
  const noticedAtSettle = notices.open;
  await wait(11_000);
  check("the seat's notice repeats while no pull has carried the stop", notices.open - noticedAtSettle >= 2, { before: noticedAtSettle, after: notices.open });
  const stops = [await pull(seats.open), await pull(seats.open)];
  check("its pull is answered `stop` with no turn, and a pull repeated after a lost answer is answered `stop` again",
    stops.every((p) => p?.stop === true && p.turns?.length === 0), stops);
  await wait(1_000); // a notice already in flight when the pull landed
  const noticedAtStop = notices.open;
  await wait(11_000);
  check("the notice stops repeating once a pull has carried the stop", notices.open === noticedAtStop, { atStop: noticedAtStop, after: notices.open });

  let timed: Result | undefined;
  await until(async () => (timed = await resultOf(tasks.timed)) !== undefined, 60_000);
  let timedStop: Awaited<ReturnType<typeof pull>>;
  await until(async () => (timedStop = await pull(seats.timed))?.stop === true, 15_000);
  check("the task with a deadline fails `turn-deadline` at it, saying the manager does not hold the seat, and its seat is told to stop",
    timed?.state === "failed" && timed.data?.reason === "turn-deadline" && timed.data.seat === UNHELD && timedStop?.stop === true, { timed, timedStop });
  check("both seats' debts stay recorded, since nothing proved either seat gone", await indexed(tasks.open) && await indexed(tasks.timed));

  await crash(successor);
  const third = await startHost();
  epoch = 2;
  const noticedAtRestart = notices.open;
  let rebuilt: Awaited<ReturnType<typeof pull>>;
  const noticedAgain = await until(() => notices.open - noticedAtRestart >= 2, 30_000);
  await until(async () => (rebuilt = await pull(seats.open))?.stop === true, 15_000);
  check("a manager restarted again rebuilds the stop from the debt: its notice repeats and the seat's pull is answered `stop`",
    noticedAgain && rebuilt?.stop === true && rebuilt.turns?.length === 0, { noticedAgain, notices: notices.open - noticedAtRestart, rebuilt, stderr: third.stderr().slice(-2000) });
} catch (error) {
  for (const name of CELLS) if (!graded.has(name)) check(name, false, `not reached: ${(error as Error).message}`);
} finally {
  await writer?.stop().catch(() => {});
  for (const c of conns) await c.drain().catch(() => c.close());
  const managerExits = managers.map((child) => child.exitCode === null ? new Promise<void>((r) => child.once("exit", () => r())) : Promise.resolve());
  for (const child of managers) if (child.exitCode === null) { try { process.kill(-child.pid!, "SIGKILL"); } catch { /* already gone */ } }
  await Promise.all(managerExits);
  // End every seat this suite started, by its own command line and exact pid.
  for (const pid of [...seatPids("open"), ...seatPids("timed")]) { try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ } }
  broker.kill("SIGKILL");
  await wait(300);
  rmSync(dir, { recursive: true, force: true });
  releaseBroker();
}

if (pass + fail !== CELLS.length) throw new Error(`expected ${CELLS.length} cells, ran ${pass + fail}; a cell was graded twice or skipped`);
console.log(`\nSPAWN ONCE UNHELD SMOKE ${fail === 0 ? "OK ✅" : "FAILED ❌"} (${pass} passed, ${fail} failed)`);
emitSentinel({ passed: pass, failed: fail });
if (fail) process.exitCode = 1;
