/**
 * A supervised seat restarted after a manager crash stays supervised when it joins late (#4144).
 *
 * Live, the shape of supervise-manager-crash.smoke.ts: a JWT-auth scratch broker, the real Manager in
 * a child process, the real pty runtime and a stub seat that joins presence. The first manager spawns
 * `worker` with supervise { restarts: 2 } and is SIGKILLed. The successor restarts the seat. Its stub
 * connector has a 3 s readiness timeout, and in the late cases the restarted seat waits 8 s before it
 * joins, so the restart's readiness ends uncertain.
 *
 * - control: the restarted seat joins at once. The record counts the manager crash, and killing the
 *   seat restarts it in place.
 * - late: the restarted seat joins after the readiness timeout. It must end up the same as the
 *   control: the record counts the crash, so a later successor does not grant an extra restart, and
 *   killing the seat restarts it in place instead of retiring it.
 * - early exit: the restarted seat is killed before it joins. A seat that never joined is never armed,
 *   so it is retired, not restarted in place. (By then the dead seat's presence row has left the
 *   roster, so this case does not exercise the join bound that keeps such a row from counting.)
 *
 * Run: pnpm smoke:supervise-crash-late-join   (needs nats-server + node on PATH)
 */
import { randomUUID } from "node:crypto";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { connect } from "@nats-io/transport-node";
import {
  CotalEndpoint, DEV_OWNER, createSpaceAuth, epCall, isReachable, mintConnectionEvictorCreds, mintCreds,
  mintMembershipObserverCreds, newIdentity, principalKey, serverConfig, setupSpaceStreams, standaloneConnectOpts,
} from "@cotal-ai/core";
import { authDir, mintControlInstrument, saveSpaceAuth, workspaceSecretStore } from "@cotal-ai/workspace";
import { SMOKE_BROKER_TOKEN, emitSentinel, freePort, teardownOnSignal } from "@cotal-ai/smoke-kit";
import { MANAGER_CONTRACTS, MANAGER_ENDPOINT } from "../src/manager-service-contract.js";
import { readSeatRecord } from "../src/resume.js";
import { bootDeliveryDaemon } from "./_boot-delivery.js";

const READINESS_MS = 3_000;
const JOIN_DELAY_MS = 8_000;

const CELLS = [
  "control: the successor restarts the seat and it joins within the readiness timeout",
  "control: the record counts the manager crash",
  "control: killing the joined seat restarts it in place",
  "late: the successor's restart ends with uncertain readiness",
  "late: the restarted seat joins after the readiness timeout",
  "late: the record counts the manager crash",
  "late: killing the joined seat restarts it in place",
  "early exit: the successor's restart ends with uncertain readiness",
  "early exit: a restarted seat killed before it joins is retired, not restarted in place",
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

type Host = { child: ChildProcess; manager: { managerPid: number; managerInstanceId: string }; stderr: () => string };

/** One case on its own broker, space and workspace root. */
async function runCase(tag: "control" | "late" | "early exit"): Promise<void> {
  const port = await freePort(); const servers = `nats://127.0.0.1:${port}`; const space = `suplate-${randomUUID().slice(0, 8)}`;
  const auth = await createSpaceAuth(space); const observerCreds = await mintMembershipObserverCreds(auth, newIdentity()); const evictorCreds = await mintConnectionEvictorCreds(auth, newIdentity());
  const seatPids = () => {
    const result = spawnSync("pgrep", ["-f", `e2e-stub.mjs ${space}`], { encoding: "utf8" });
    if (result.error) throw result.error;
    if (result.status !== 0 && result.status !== 1) throw new Error(`seat process census exited ${result.status}: ${result.stderr}`);
    return result.stdout.split("\n").map(Number).filter((pid) => pid > 0);
  };
  const dir = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN)); const root = join(dir, "ws");
  mkdirSync(join(root, ".cotal", "agents"), { recursive: true }); saveSpaceAuth(authDir(root), auth);
  writeFileSync(join(root, ".cotal", "agents", "worker.md"), "---\nname: worker\nrole: worker\nsubscribe: []\nallowSubscribe: []\nallowPublish: []\n---\n");
  writeFileSync(join(dir, "server.conf"), serverConfig(auth, [auth], { transport: { kind: "plaintext" }, port, storeDir: join(dir, "js") }));
  const broker = spawn("nats-server", ["-c", join(dir, "server.conf")], { stdio: "ignore" }); const releaseBroker = teardownOnSignal(broker, dir);
  const managers: ChildProcess[] = [];
  let daemon: Awaited<ReturnType<typeof bootDeliveryDaemon>> | undefined;
  let runnerNc: Awaited<ReturnType<typeof connect>> | undefined;
  let watcher: CotalEndpoint | undefined;

  /** Start one manager process. A successor started while the dead one's lease still stands exits on
   *  the lease refusal, so that one exit is retried until the lease lapses. */
  const startHost = async (extraEnv: Record<string, string> = {}): Promise<Host> => {
    const deadline = Date.now() + 120_000;
    for (;;) {
      const child = spawn(tsx, [host], { cwd: repo, env: { ...ambientEnv, REPRO_ROOT: root, REPRO_SPACE: space, REPRO_SERVERS: servers, REPRO_OBSERVER_CREDS: observerCreds, REPRO_EVICTOR_CREDS: evictorCreds, REPRO_ACCOUNT_ID: auth.account.pub, REPRO_READINESS_MS: String(READINESS_MS), ...extraEnv, COTAL_SERVER: "", COTAL_SERVERS: "", COTAL_CREDS: "", NATS_URL: "" }, detached: true, stdio: ["ignore", "pipe", "pipe"] });
      managers.push(child);
      let out = "", err = "";
      child.stdout?.on("data", (b) => out += String(b)); child.stderr?.on("data", (b) => err += String(b));
      const line = (t: string) => out.split("\n").find((x) => x.startsWith(`${t} `))?.slice(t.length + 1);
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
  };
  const crash = async (h: Host): Promise<void> => {
    const exited = new Promise((r) => h.child.once("exit", r));
    process.kill(h.manager.managerPid, "SIGKILL");
    await exited;
  };

  console.log(`${tag}:`);
  try {
    for (let i = 0; i < 100 && !(await isReachable(servers)); i++) await wait(50);
    await setupSpaceStreams({ servers, space, creds: await mintCreds(auth, newIdentity(), "provisioner") });
    daemon = await bootDeliveryDaemon({ space, servers, auth, reloadStoreIdentity: workspaceSecretStore(root).identity });

    const first = await startHost();
    // The spawner: the operator's admin instrument, issued as the CLI mints it, so the static spawn
    // bound reads its evidence and it hands on the worker's role (SPEC 13.15).
    const { creds: runnerCreds, epCaller: runner } = await mintControlInstrument({ server: servers, space, tlsRequired: false, auth }, "admin");
    runnerNc = await connect({ servers, ...standaloneConnectOpts({ creds: runnerCreds, tls: false }), maxReconnectAttempts: 0 });
    const spawned = await epCall(runnerNc, space, { mode: "one" }, {
      endpoint: MANAGER_ENDPOINT, command: "spawn", contract: MANAGER_CONTRACTS.spawn, caller: runner, id: "spawn-worker".padEnd(43, "s"),
      args: { name: "worker", agent: "supervise-crash-stub", cwd: repo, events: false, supervise: { restarts: 2, windowMs: 600_000 } },
    }, { deadlineMs: 20_000, currentEpoch: async () => 0 }).then((r) => r.reply, asValue);
    // The record is written once the seat is ready and armed, so it is the readiness signal here.
    let before: ReturnType<typeof readSeatRecord>;
    await until(() => (before = readSeatRecord(root, space, "worker")) !== undefined, 60_000);
    const identity = before?.agent.identity;
    if ((spawned as { ok?: boolean }).ok !== true || identity?.mode !== "static" || before!.crashes.length !== 0)
      throw new Error(`the first manager did not start a supervised seat: ${JSON.stringify({ spawned, before })} ${first.stderr().slice(-2000)}`);
    const principal = principalKey(DEV_OWNER, identity.id).key;
    const uid = identity.lifecycleUid;
    const beforePids = seatPids();

    const watcherId = newIdentity();
    watcher = new CotalEndpoint({ space, servers, creds: await mintCreds(auth, watcherId, "observer"), card: { id: watcherId.id, name: "watcher", role: "observer", kind: "endpoint" }, channels: [], consume: false, registerPresence: false, watchPresence: true, watchChannels: false });
    watcher.on("error", () => {});
    await watcher.start();
    const joinedSince = (t: number) => (watcher!.getRoster().find((p) => p.card.id === principal && p.lifecycleUid === uid)?.ts ?? 0) > t;

    const crashedAt = Date.now();
    await crash(first);
    const delayed = tag !== "control";
    const successor = await startHost(delayed ? { REPRO_JOIN_DELAY_ONCE: join(dir, "join-delay-taken"), REPRO_JOIN_DELAY_MS: String(JOIN_DELAY_MS) } : {});
    const newSeat = async (): Promise<number | undefined> => {
      let pid: number | undefined;
      await until(() => { const now = seatPids().filter((p) => !beforePids.includes(p)); pid = now.length === 1 ? now[0] : undefined; return pid !== undefined; }, 10_000);
      return pid;
    };

    if (tag === "control") {
      const restarted = await until(() => successor.stderr().includes("worker: restarted under the same lifecycle after its manager stopped (1/2)"), 90_000);
      const joined = await until(() => joinedSince(crashedAt), 30_000);
      check("control: the successor restarts the seat and it joins within the readiness timeout", restarted && joined, successor.stderr().slice(-3000));
    } else {
      const uncertain = await until(() => successor.stderr().includes("worker: restarted after its manager stopped, but readiness is uncertain"), 90_000);
      check(`${tag}: the successor's restart ends with uncertain readiness`, uncertain, successor.stderr().slice(-3000));
    }

    if (tag === "early exit") {
      const seat = await newSeat();
      if (seat !== undefined) process.kill(seat, "SIGKILL");
      // An in-place restart relaunches at once (the delay is spent), so a few seconds is enough to see one.
      await wait(6_000);
      const restartedInPlace = successor.stderr().includes("worker: restarted under the same lifecycle after crash");
      const gone = await until(() => seatPids().length === 0, 10_000);
      check("early exit: a restarted seat killed before it joins is retired, not restarted in place",
        seat !== undefined && !restartedInPlace && gone && !joinedSince(crashedAt), { seat, restartedInPlace, gone, stderr: successor.stderr().slice(-3000) });
      return;
    }

    if (tag === "late") {
      const joined = await until(() => joinedSince(crashedAt), JOIN_DELAY_MS + 30_000);
      check("late: the restarted seat joins after the readiness timeout", joined, successor.stderr().slice(-2000));
    }
    let after: ReturnType<typeof readSeatRecord>;
    const counted = await until(() => (after = readSeatRecord(root, space, "worker"))?.crashes.length === 1, 10_000);
    check(`${tag}: the record counts the manager crash`, counted && after?.agent.identity.lifecycleUid === uid, after);

    const seat = await newSeat();
    if (seat !== undefined) process.kill(seat, "SIGKILL");
    const inPlace = await until(() => successor.stderr().includes("worker: restarted under the same lifecycle after crash (2/2)"), 30_000);
    check(`${tag}: killing the joined seat restarts it in place`, seat !== undefined && inPlace, { seat, stderr: successor.stderr().slice(-3000) });
  } catch (error) {
    for (const name of CELLS) if (name.startsWith(`${tag}:`) && !graded.has(name)) check(name, false, `not reached: ${(error as Error).message}`);
  } finally {
    await watcher?.stop().catch(() => {});
    await runnerNc?.drain().catch(() => runnerNc?.close());
    const managerExits = managers.map((child) => child.exitCode === null ? new Promise<void>((r) => child.once("exit", () => r())) : Promise.resolve());
    for (const child of managers) if (child.exitCode === null) stopGroup(child.pid);
    await Promise.all(managerExits);
    for (const pid of seatPids()) stopGroup(pid);
    await daemon?.stop().catch(() => {});
    broker.kill("SIGKILL");
    await wait(300);
    rmSync(dir, { recursive: true, force: true });
    releaseBroker();
  }
}

for (const tag of ["control", "late", "early exit"] as const) await runCase(tag);

if (pass + fail !== CELLS.length) throw new Error(`expected ${CELLS.length} cells, ran ${pass + fail}; a cell was graded twice or skipped`);
console.log(`\nSUPERVISE CRASH LATE JOIN SMOKE ${fail === 0 ? "OK ✅" : "FAILED ❌"} (${pass} passed, ${fail} failed)`);
emitSentinel({ passed: pass, failed: fail });
if (fail) process.exitCode = 1;
