/**
 * A `once` task on Jcode, end to end: a real JWT broker, the real Manager on the pty runtime, the
 * real Jcode connector and host, and the fake Jcode harness in its daemon mode, where the bridge
 * starts a server in a session of its own that outlives the host.
 *
 * The task reaches the harness once. A turn that ends yields it and the seat is stopped. A send the
 * harness never acknowledges fails the task `delivery-unconfirmed` and is not sent again. A host
 * killed without its teardown leaves its Jcode tree running, and the task is not cancelled, nor the
 * seat's debt cleared, until the connector proves that tree gone by the identities the host
 * recorded under the seat's uid.
 *
 * Run: pnpm smoke:jcode-once   (needs nats-server + node on PATH; Linux)
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform !== "linux") throw new Error("jcode-once proves process identity through /proc and runs on Linux only");
const repoRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const scratch = mkdtempSync(join(tmpdir(), "cotal-jcode-once-"));
// The operator's own config and Jcode home stay out of this run.
process.env.HOME = join(scratch, "home");
process.env.XDG_CONFIG_HOME = join(scratch, "home", ".config");
mkdirSync(process.env.XDG_CONFIG_HOME, { recursive: true });
for (const key of Object.keys(process.env)) if (key.startsWith("COTAL_") || key.startsWith("FAKE_JCODE_")) delete process.env[key];
// `jcode` on PATH is the fake harness.
const bin = join(scratch, "bin");
mkdirSync(bin);
const fake = join(repoRoot, "extensions/connector-jcode/smoke/fake-jcode.mjs");
writeFileSync(join(bin, "jcode"), `#!/bin/sh\nexec "${process.execPath}" "${fake}" "$@"\n`, { mode: 0o755 });
process.env.PATH = `${bin}:${process.env.PATH ?? ""}`;

const { connect } = await import("@nats-io/transport-node");
const {
  createSpaceAuth, mintCreds, newIdentity, mintLifecycleUid, standaloneConnectOpts, setupSpaceStreams,
  DEV_OWNER, digestIdToken, epCall, readGoalResult, readGoalIndex,
} = await import("@cotal-ai/core");
type EpCaller = import("@cotal-ai/core").EpCaller;
const { authDir, saveSpaceAuth, workspaceSecretStore } = await import("@cotal-ai/workspace");
await import("@cotal-ai/connector-jcode");
const { Manager } = await import("@cotal-ai/manager");
const { MANAGER_ENDPOINT, MANAGER_CONTRACTS } = await import("../../implementations/manager/src/manager-service-contract.js");
const { bootBroker } = await import("../../implementations/manager/smoke/_boot-broker.js");
const { bootDeliveryDaemon } = await import("../../implementations/manager/smoke/_boot-delivery.js");
const { hostTimerWriter } = await import("../../implementations/manager/smoke/_timer-writer.js");

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (name: string, cond: boolean, extra?: unknown): void => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ FAIL: ${name}`, extra === undefined ? "" : JSON.stringify(extra).slice(0, 1500)); }
};
const until = async (cond: () => boolean | Promise<boolean>, ms: number): Promise<boolean> => {
  for (const end = Date.now() + ms; ;) {
    if (await cond()) return true;
    if (Date.now() >= end) return false;
    await wait(250);
  }
};
type Reply = { ok?: boolean; data?: Record<string, unknown>; error?: { message?: string } };

/** Every live process carrying one of `identities` as its launch identity. */
const carriers = (identities: readonly string[]): number[] => {
  const wanted = new Set(identities.map((v) => `JCODE_COTAL_LAUNCH_IDENTITY=${v}`));
  const found: number[] = [];
  for (const pid of readdirSync("/proc").map(Number).filter((n) => n > 1)) {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      if (stat.slice(stat.lastIndexOf(") ") + 2).startsWith("Z ")) continue;
      if (readFileSync(`/proc/${pid}/environ`, "utf8").split("\0").some((v) => wanted.has(v))) found.push(pid);
    } catch { /* gone, or not ours */ }
  }
  return found;
};

const space = `jonce-${randomUUID().slice(0, 8)}`;
const auth = await createSpaceAuth(space);
const broker = await bootBroker(auth);
const workspaceRoot = join(scratch, "ws");
mkdirSync(join(workspaceRoot, ".cotal", "agents"), { recursive: true });
saveSpaceAuth(authDir(workspaceRoot), auth);
writeFileSync(join(workspaceRoot, ".cotal", "agents", "helper.md"), "---\nname: helper\nrole: worker\n---\n");
// The fake reads its knobs from its environment, which a launch passes through only by name.
writeFileSync(join(workspaceRoot, ".cotal", "config.json"), JSON.stringify({
  spawn: { env: ["FAKE_JCODE_LOG", "FAKE_JCODE_DAEMON", "FAKE_JCODE_RUN_WITHOUT_ACCEPT_ON_CONTENT", "FAKE_JCODE_RUN_WITHOUT_ACCEPT_HOLD_FILE", "FAKE_JCODE_HOLD_TURN_ON_CONTENT", "FAKE_JCODE_HOLD_TURN_RELEASE_FILE"] },
}));
process.env.FAKE_JCODE_DAEMON = "1";

let manager: InstanceType<typeof Manager> | undefined;
let delivery: Awaited<ReturnType<typeof bootDeliveryDaemon>> | undefined;
let writer: Awaited<ReturnType<typeof hostTimerWriter>> | undefined;
const conns: Array<Awaited<ReturnType<typeof connect>>> = [];
const leftovers = new Set<string>();
try {
  await setupSpaceStreams({ servers: broker.servers, space, creds: await mintCreds(auth, newIdentity(), "provisioner") });
  delivery = await bootDeliveryDaemon({ space, servers: broker.servers, auth, reloadStoreIdentity: workspaceSecretStore(workspaceRoot).identity });
  const writerNc = await connect({ servers: broker.servers, ...standaloneConnectOpts({ creds: await mintCreds(auth, newIdentity(), "delivery"), tls: false }), maxReconnectAttempts: 0 });
  conns.push(writerNc);
  writer = await hostTimerWriter(writerNc, space, { pollMs: 1_000 });
  manager = new Manager({ space, servers: broker.servers, runtime: "pty", workspaceRoot });
  await manager.start();
  type Seat = { lifecycleUid: string; handle: { pid?: number; status(): string } };
  const M = manager as unknown as { agents: Map<string, Seat>; goalWriter: { ctx: Parameters<typeof readGoalResult>[0] } };

  const runnerId = newIdentity();
  const runner: EpCaller = { owner: DEV_OWNER, actor: runnerId.id, uid: mintLifecycleUid() };
  const runnerNc = await connect({ servers: broker.servers, ...standaloneConnectOpts({ creds: await mintCreds(auth, runnerId, "control-caller-admin", { lifecycleUid: runner.uid }), tls: false }), maxReconnectAttempts: 0 });
  conns.push(runnerNc);
  const call = (command: string, args: Record<string, unknown>, id: string) =>
    epCall(runnerNc, space, { mode: "one" }, { endpoint: MANAGER_ENDPOINT, command, contract: MANAGER_CONTRACTS[command], caller: runner, id, args }, { deadlineMs: 20_000, currentEpoch: async () => 0 })
      .then((r) => r.reply as Reply, (e: Error) => ({ ok: false, error: { message: e.message } }) as Reply);
  const refOf = (goalId: string) => ({ endpoint: MANAGER_ENDPOINT, caller: runner, goalId });
  const resultOf = async (goalId: string, ms: number) => {
    let fact: Awaited<ReturnType<typeof readGoalResult>>;
    await until(async () => (fact = await readGoalResult(M.goalWriter.ctx, refOf(goalId))) !== undefined, ms);
    return fact;
  };
  let seq = 0;
  /** One once spawn on Jcode, with its own fake log, followed to its readiness terminal. */
  const spawnOnce = async (marker: string) => {
    const log = join(scratch, `${marker}.jsonl`);
    process.env.FAKE_JCODE_LOG = log;
    const id = `jonce-${seq++}`.padEnd(43, "j");
    const accepted = await call("spawn", { name: "helper", agent: "jcode", cwd: workspaceRoot, events: false, prompt: `do the ${marker} task`, once: {} }, id);
    const name = accepted.data?.name as string | undefined;
    const seat = name !== undefined && await until(() => M.agents.has(name), 20_000) ? M.agents.get(name) : undefined;
    const terminal = await resultOf(id, 240_000);
    const readyAt = Date.now();
    const task = digestIdToken(`${id}:once`);
    const entries = () => { try { return readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l) as { ev: string; content?: string; pid?: number }); } catch { return []; } };
    const runsOf = () => entries().filter((e) => e.ev === "turn_run" && e.content?.includes(marker)).length;
    // The identities this seat's host recorded under its uid, read while the record is live.
    const identities = () => {
      if (!name || !seat) return [];
      const dir = join(workspaceRoot, ".cotal", "jcode");
      for (const home of readdirSync(dir)) {
        try {
          const r = JSON.parse(readFileSync(join(dir, home, `cotal-once-${seat.lifecycleUid}.json`), "utf8")) as { launches?: string[] };
          if (r.launches) { r.launches.forEach((l) => leftovers.add(l)); return r.launches; }
        } catch { /* not this home */ }
      }
      return [];
    };
    return { id, name, seat, terminal, readyAt, task, runsOf, identities };
  };
  const goneSeat = (name: string, seat: Seat) => until(() => seat.handle.status() === "exited" && M.agents.get(name) !== seat, 30_000);
  const debtCleared = (task: string) => until(async () => (await readGoalIndex(M.goalWriter.ctx, refOf(task))) === undefined, 60_000);

  console.log("1. the task reaches the harness once, its turn ends, and the seat and its tree are gone");
  // The turn is held open until the launch is checked, or a fast harness ends it, and the seat's tree
  // with it, before the check can see that tree.
  const happyRelease = join(scratch, "happy-released");
  process.env.FAKE_JCODE_HOLD_TURN_ON_CONTENT = "ONCE-HAPPY";
  process.env.FAKE_JCODE_HOLD_TURN_RELEASE_FILE = happyRelease;
  const a = await spawnOnce("ONCE-HAPPY");
  delete process.env.FAKE_JCODE_HOLD_TURN_ON_CONTENT;
  delete process.env.FAKE_JCODE_HOLD_TURN_RELEASE_FILE;
  check("the once spawn on Jcode succeeds", a.terminal?.state === "succeeded" && a.seat !== undefined, a.terminal);
  const heldA = await until(() => a.runsOf() >= 1, 30_000);
  const idsA = a.identities();
  check("the host recorded its launch under the seat's uid before launching", heldA && idsA.length >= 1 && carriers(idsA).length >= 2, { idsA, carriers: carriers(idsA) });
  writeFileSync(happyRelease, "released");
  const ra = await resultOf(a.task, 60_000);
  check("the turn's end yields the task: it succeeds", ra?.state === "succeeded", ra);
  check("the harness runs the task once", a.runsOf() === 1, a.runsOf());
  check("the seat is stopped", await goneSeat(a.name!, a.seat!));
  check("its debt clears, and nothing carrying its launch identities is left", await debtCleared(a.task) && carriers(idsA).length === 0, carriers(idsA));

  console.log("\n2. a send the harness never acknowledges fails the task and is not sent again");
  process.env.FAKE_JCODE_RUN_WITHOUT_ACCEPT_ON_CONTENT = "ONCE-NOACK";
  process.env.FAKE_JCODE_RUN_WITHOUT_ACCEPT_HOLD_FILE = join(scratch, "never-released");
  const b = await spawnOnce("ONCE-NOACK");
  delete process.env.FAKE_JCODE_RUN_WITHOUT_ACCEPT_ON_CONTENT;
  delete process.env.FAKE_JCODE_RUN_WITHOUT_ACCEPT_HOLD_FILE;
  const idsB = b.identities();
  const rb = await resultOf(b.task, 90_000);
  check("the task fails `delivery-unconfirmed`", rb?.state === "failed" && (rb.data as { reason?: string }).reason === "delivery-unconfirmed", rb);
  // The host reports when the acceptance window lapses (10s), well before the 60s handoff bound
  // that would otherwise seal the claim.
  check("...reported when the acceptance window lapses, not at the handoff bound", ((rb?.data as { at?: number } | undefined)?.at ?? Infinity) - b.readyAt < 40_000, { at: (rb?.data as { at?: number } | undefined)?.at, readyAt: b.readyAt });
  check("...the seat is stopped, and its tree with it", await goneSeat(b.name!, b.seat!) && await debtCleared(b.task) && carriers(idsB).length === 0, carriers(idsB));
  check("...and the harness was handed the task once", b.runsOf() === 1, b.runsOf());

  console.log("\n3. a host killed without its teardown: the task waits for the connector's proof that the tree is gone");
  process.env.FAKE_JCODE_HOLD_TURN_ON_CONTENT = "ONCE-HOLD";
  process.env.FAKE_JCODE_HOLD_TURN_RELEASE_FILE = join(scratch, "never-released");
  const c = await spawnOnce("ONCE-HOLD");
  delete process.env.FAKE_JCODE_HOLD_TURN_ON_CONTENT;
  delete process.env.FAKE_JCODE_HOLD_TURN_RELEASE_FILE;
  await until(() => c.runsOf() >= 1, 30_000);
  const idsC = c.identities();
  process.kill(c.seat!.handle.pid!, "SIGKILL");
  const rc = await resultOf(c.task, 90_000);
  check("the task is cancelled `seat-exited`", rc?.state === "cancelled" && (rc.data as { reason?: string }).reason === "seat-exited", rc);
  check("...only after the tree the host left running is gone, by its recorded identities", idsC.length >= 1 && carriers(idsC).length === 0, { idsC, left: carriers(idsC) });
  check("...and the debt clears", await debtCleared(c.task));
} finally {
  for (const nc of conns) await nc.drain().catch(() => nc.close());
  await manager?.stop({ withAgents: true }).catch(() => {});
  await writer?.stop().catch(() => {});
  await delivery?.stop().catch(() => {});
  await broker.stop().catch(() => {});
  // Anything still carrying an identity this run recorded is this run's own process.
  for (const pid of carriers([...leftovers])) { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } }
  rmSync(scratch, { recursive: true, force: true });
}

const EXPECTED_CELLS = 13;
console.log(`\n${fail === 0 && pass === EXPECTED_CELLS ? "JCODE ONCE SMOKE OK ✅" : "JCODE ONCE SMOKE FAILED"}  (${pass} passed, ${fail} failed)`);
console.log(`COTAL_SMOKE_SENTINEL cells=${pass + fail} passed=${pass} failed=${fail}`);
process.exit(fail === 0 && pass === EXPECTED_CELLS ? 0 : 1);
