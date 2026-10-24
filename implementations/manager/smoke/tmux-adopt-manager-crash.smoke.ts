/**
 * A tmux seat that outlives its manager's crash is adopted by the next manager (#4095).
 *
 * Live: a JWT-auth scratch broker, the real Manager in a child process on the real tmux runtime
 * (its own tmux server under a private TMUX_TMPDIR), and stub seats that join presence. The first
 * manager spawns `keeper` and `lost` and accepts a turn for `keeper`, then is SIGKILLed; both panes
 * keep running. While no manager runs, `lost`'s process is killed and its dead pane is kept. The
 * successor must adopt `keeper`'s live pane without closing or relaunching it, serve it the turn the
 * dead manager accepted, and drive it afterwards (a despawn closes its window). `lost` is retired,
 * not adopted.
 *
 * Run: pnpm smoke:manager-tmux-adopt   (needs nats-server, tmux and node on PATH)
 */
import { randomUUID } from "node:crypto";
import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { connect } from "@nats-io/transport-node";
import {
  DEV_OWNER, createSpaceAuth, epCall, invokeCommand, isReachable, mintConnectionEvictorCreds, mintCreds,
  mintLifecycleUid, mintMembershipObserverCreds, newIdentity, readAcceptedRow, resolveService, serverConfig,
  setupSpaceStreams, standaloneConnectOpts, type EpCaller, type IssuedCaller,
} from "@cotal-ai/core";
import { agentLifecycleSecretFilePaths, authDir, saveSpaceAuth, workspaceSecretStore } from "@cotal-ai/workspace";
import { SMOKE_BROKER_TOKEN, emitSentinel, freePort, skipSuite, teardownOnSignal } from "@cotal-ai/smoke-kit";
import { MANAGER_CONTRACTS, MANAGER_ENDPOINT } from "../src/manager-service-contract.js";
import { readSeatRecord, seatRecordPath } from "../src/resume.js";
import { bootDeliveryDaemon, type DeliveryDaemon } from "./_boot-delivery.js";

if (spawnSync("tmux", ["-V"]).status !== 0) skipSuite("tmux is not installed");

// Every cell, in order. A cell an earlier failure left unreachable is graded failed, so the suite
// always reaches its completion line.
const CELLS = [
  "the first manager spawns two tmux seats and records both",
  "a turn is accepted against the seat that will survive",
  "both panes outlive the manager's SIGKILL",
  "the successor is the same logical manager instance",
  "the successor adopts the surviving seat",
  "the adopted seat is the same pane process, neither closed nor relaunched",
  "the adopted seat pulls the turn the dead manager accepted",
  "the adopted seat yields that turn",
  "a seat whose process died while no manager ran is retired, not adopted",
  "a despawn through the successor closes the adopted seat's window",
  "the adopted seat's record is removed at its despawn",
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
const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };
const stopGroup = (pid?: number) => { if (!pid) return; try { process.kill(-pid, "SIGKILL"); } catch { try { process.kill(pid, "SIGKILL"); } catch {} } };
const here = dirname(fileURLToPath(import.meta.url)); const repo = resolve(here, "../../.."); const host = join(here, "_tmux-adopt-host.ts"); const tsx = join(repo, "node_modules", ".bin", "tsx");
const ambientEnv: NodeJS.ProcessEnv = { ...process.env };
for (const key of Object.keys(ambientEnv)) if (key.startsWith("COTAL_") || key === "TMUX" || key === "TMUX_PANE") delete ambientEnv[key];
// A private tmux server, so the suite never touches the operator's. The socket path must stay short.
const tmuxDir = mkdtempSync("/tmp/ctmx-");
ambientEnv.TMUX_TMPDIR = tmuxDir;
const tmux = (...args: string[]) => execFileSync("tmux", args, { env: ambientEnv, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
/** pane id -> { window, pid, dead } for every pane on the private server. */
const panes = (): Map<string, { window: string; pid: number; dead: boolean }> => {
  let out = "";
  try { out = tmux("list-panes", "-a", "-F", "#{pane_id} #{window_id} #{pane_pid} #{pane_dead}"); } catch { /* no server */ }
  return new Map(out.split("\n").filter(Boolean).map((l) => { const [pane, window, pid, dead] = l.split(" "); return [pane, { window, pid: Number(pid), dead: dead === "1" }]; }));
};

const port = await freePort(); const servers = `nats://127.0.0.1:${port}`; const space = `tadopt-${randomUUID().slice(0, 8)}`;
const auth = await createSpaceAuth(space); const observerCreds = await mintMembershipObserverCreds(auth, newIdentity()); const evictorCreds = await mintConnectionEvictorCreds(auth, newIdentity());
const dir = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN)); const root = join(dir, "ws");
mkdirSync(join(root, ".cotal", "agents"), { recursive: true }); saveSpaceAuth(authDir(root), auth);
for (const name of ["keeper", "lost"]) writeFileSync(join(root, ".cotal", "agents", `${name}.md`), `---\nname: ${name}\nrole: worker\nsubscribe: []\nallowSubscribe: []\nallowPublish: []\n---\n`);
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
    while (Date.now() < deadline) {
      const managerLine = out.split("\n").find((x) => x.startsWith("REPRO_MANAGER "))?.slice("REPRO_MANAGER ".length);
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
  // The successor registers the same manager instance at the next epoch.
  let epoch = 0;
  const call = (command: string, args: Record<string, unknown>, opts: { id?: string; target?: { actor: string; lifecycleUid: string } }) =>
    epCall(runnerNc!, space, { mode: "one" }, {
      endpoint: MANAGER_ENDPOINT, command, contract: MANAGER_CONTRACTS[command], caller: runner, args,
      ...(opts.id !== undefined ? { id: opts.id } : {}),
      ...(opts.target ? { target: { mode: "any" as const, owner: DEV_OWNER, actor: opts.target.actor, lifecycleUid: opts.target.lifecycleUid } } : {}),
    }, { deadlineMs: 20_000, currentEpoch: async () => epoch }).then((r) => r.reply, asValue);
  const seats: Record<string, { actor: string; uid: string; acceptedToken: string }> = {};
  const spawned: unknown[] = [];
  for (const name of ["keeper", "lost"]) {
    spawned.push(await call("spawn", { name, agent: "tmux-adopt-stub", cwd: repo, events: false }, { id: `spawn-${name}`.padEnd(43, "s") }));
    // The record is written once the seat is ready, so it is the readiness signal here.
    let record: ReturnType<typeof readSeatRecord>;
    await until(() => (record = readSeatRecord(root, space, name)) !== undefined, 60_000);
    const identity = record?.agent.identity;
    if (identity?.mode === "static") seats[name] = { actor: identity.id, uid: identity.lifecycleUid, acceptedToken: identity.issued?.acceptedToken ?? "" };
  }
  check("the first manager spawns two tmux seats and records both",
    spawned.every((r) => (r as { ok?: boolean }).ok === true) && !!seats.keeper && !!seats.lost && readSeatRecord(root, space, "keeper")?.supervise === undefined,
    { spawned, seats, stderr: first.stderr().slice(-2000) });
  const keeper = seats.keeper!; const lost = seats.lost!;

  const goalId = "adopt-turn".padEnd(43, "a");
  const accepted = await call("turn", { payload: JSON.stringify({ run: "r1", step: "turn:keeper", context: "do the thing" }), deadlineMs: 600_000 }, { id: goalId, target: { actor: keeper.actor, lifecycleUid: keeper.uid } });
  check("a turn is accepted against the seat that will survive", (accepted as { ok?: boolean }).ok === true, accepted);

  const before = panes();
  const windows = tmux("list-windows", "-t", `cotal-${space}`, "-F", "#{window_name} #{window_id}").split("\n").filter(Boolean).map((l) => l.split(" "));
  const windowOf = (name: string) => windows.find(([n]) => n === name)?.[1];
  const paneOf = (window: string | undefined) => [...before.entries()].find(([, p]) => p.window === window)?.[0];
  const keeperPane = paneOf(windowOf("keeper")); const lostPane = paneOf(windowOf("lost"));
  const keeperPid = keeperPane ? before.get(keeperPane)!.pid : 0; const lostPid = lostPane ? before.get(lostPane)!.pid : 0;
  await crash(first);
  check("both panes outlive the manager's SIGKILL", keeperPid > 0 && lostPid > 0 && alive(keeperPid) && alive(lostPid), { keeperPane, lostPane, windows });
  // The other seat ends while no manager runs. remain-on-exit keeps its dead pane in its window,
  // so the successor finds the recorded window and pane and must refuse on the pane's state.
  tmux("set-option", "-w", "-t", windowOf("lost")!, "remain-on-exit", "on");
  stopGroup(lostPid);
  await until(() => panes().get(lostPane ?? "")?.dead === true, 10_000);

  const successor = await startHost();
  epoch = 1;
  check("the successor is the same logical manager instance", successor.manager.managerInstanceId === first.manager.managerInstanceId, { first: first.manager, successor: successor.manager });
  const adopted = await until(() => successor.stderr().includes("keeper: adopted the seat its previous manager left"), 90_000);
  check("the successor adopts the surviving seat", adopted, successor.stderr().slice(-3000));
  const after = panes().get(keeperPane ?? "");
  check("the adopted seat is the same pane process, neither closed nor relaunched", after !== undefined && after.pid === keeperPid && !after.dead && alive(keeperPid), { after, keeperPid });

  const seatNc = await connect({ servers, ...standaloneConnectOpts({ creds: readFileSync(agentLifecycleSecretFilePaths(root, space, "keeper", keeper.uid).creds, "utf8"), tls: false }), maxReconnectAttempts: 0 });
  try {
    const seatRef = await readAcceptedRow(seatNc, space, keeper.acceptedToken);
    const seatTriple: EpCaller = { owner: DEV_OWNER, actor: keeper.actor, uid: keeper.uid, generation: seatRef.generation } as IssuedCaller;
    let pulled: unknown;
    const pulledTurn = await until(async () => {
      const service = await resolveService(seatNc, space, MANAGER_ENDPOINT, seatTriple).catch(() => undefined);
      if (!service) return false;
      pulled = await invokeCommand(seatNc, space, service, "turn-pending", undefined, { target: { mode: "self" }, deadlineMs: 10_000 }).then((r) => r.reply, asValue);
      const turns = (pulled as { data?: { turns?: Array<{ goalId?: string }> } }).data?.turns ?? [];
      return (pulled as { ok?: boolean }).ok === true && turns.length === 1 && turns[0]?.goalId === goalId;
    }, 30_000);
    check("the adopted seat pulls the turn the dead manager accepted", pulledTurn, pulled);
    const service = await resolveService(seatNc, space, MANAGER_ENDPOINT, seatTriple);
    const y = await invokeCommand(seatNc, space, service, "turn-yield", { goalId, status: "done", note: "after the manager crash" }, { target: { mode: "self" }, deadlineMs: 10_000 }).then((r) => r.reply, asValue);
    check("the adopted seat yields that turn", (y as { ok?: boolean }).ok === true && (y as { data?: { state?: string } }).data?.state === "succeeded", y);
  } finally {
    await seatNc.drain().catch(() => seatNc.close());
  }
  const retired = await until(() => /lost: the seat its previous manager left was not adopted/.test(successor.stderr()) && successor.stderr().includes("✓ static reconcile completed: 1 attempted, 1 succeeded, 0 failed"), 60_000);
  check("a seat whose process died while no manager ran is retired, not adopted", retired && !existsSync(seatRecordPath(root, space, "lost")), successor.stderr().slice(-3000));

  const despawned = await call("despawn", { graceful: false }, { target: { actor: keeper.actor, lifecycleUid: keeper.uid } });
  const closed = await until(() => !panes().has(keeperPane ?? "") && !alive(keeperPid), 30_000);
  check("a despawn through the successor closes the adopted seat's window", (despawned as { ok?: boolean }).ok === true && closed, { despawned, panes: [...panes().entries()] });
  check("the adopted seat's record is removed at its despawn", await until(() => !existsSync(seatRecordPath(root, space, "keeper")), 30_000));
} catch (error) {
  for (const name of CELLS) if (!graded.has(name)) check(name, false, `not reached: ${(error as Error).message}`);
} finally {
  await runnerNc?.drain().catch(() => runnerNc?.close());
  const managerExits = managers.map((child) => child.exitCode === null ? new Promise<void>((r) => child.once("exit", () => r())) : Promise.resolve());
  for (const child of managers) if (child.exitCode === null) stopGroup(child.pid);
  await Promise.all(managerExits);
  try { tmux("kill-server"); } catch { /* already gone */ }
  rmSync(tmuxDir, { recursive: true, force: true });
  await daemon?.stop().catch(() => {});
  broker.kill("SIGKILL");
  await wait(300);
  rmSync(dir, { recursive: true, force: true });
  releaseBroker();
}

if (pass + fail !== CELLS.length) throw new Error(`expected ${CELLS.length} cells, ran ${pass + fail}; a cell was graded twice or skipped`);
console.log(`\nTMUX ADOPT MANAGER CRASH SMOKE ${fail === 0 ? "OK ✅" : "FAILED ❌"} (${pass} passed, ${fail} failed)`);
emitSentinel({ passed: pass, failed: fail });
if (fail) process.exitCode = 1;
