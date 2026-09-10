/**
 * A crashed manager's custodied seat is reaped by its successor. Real manager processes on the
 * production custodial pty runtime, a real custodian + child pair, an ephemeral auth broker.
 *
 * Before this the successor verify-evicted the orphan's broker rails and retired the lifecycle
 * while the OS process kept running outside every manager: on a long-lived box that was dozens of
 * connector hosts and gigabytes nobody could see in `cotal ps`. Now the slot row records the seat's
 * custody reference, and the successor's terminal reaps by that reference, verified by process
 * start identity, before the lifecycle retires. Linux only, like the custodian.
 *
 * Scenario 2 covers the narrower window the first one cannot see: a manager that dies AFTER the
 * seat processes exist and BEFORE the slot activation CAS records anything. The reference is
 * reserved before the launch and rides the provisioning row, so the successor can still address
 * the seat. Without the reservation that row carries no reference, the terminal has nothing to
 * reap, and it retires the alias over a running process.
 *
 * Run: pnpm smoke:orphan-seat-reap
 */
import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CotalEndpoint, createSpaceAuth, evictDeniedPrincipalWithCreds, isReachable, mintConnectionEvictorCreds, mintCreds, mintMembershipObserverCreds, newIdentity, serverConfig, setupSpaceStreams } from "@cotal-ai/core";
import { readRecord, recordPath } from "@cotal-ai/seat";
import { authDir, saveSpaceAuth } from "@cotal-ai/workspace";
import { SMOKE_BROKER_TOKEN, teardownOnSignal } from "@cotal-ai/smoke-kit";

if (process.platform !== "linux") {
  console.log(`ORPHAN-SEAT REAP COMPLETE on ${process.platform}: custody transport unsupported (no skip-as-pass)`);
  process.exit(0);
}

let pass = 0, fail = 0;
const check = (name: string, condition: boolean, extra?: unknown) => {
  if (condition) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ FAIL: ${name}`, extra ?? ""); }
};
const freePort = (): Promise<number> => new Promise((res, rej) => { const s = createServer(); s.on("error", rej); s.listen(0, "127.0.0.1", () => { const p = (s.address() as AddressInfo).port; s.close(() => res(p)); }); });
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (read: () => boolean, timeoutMs: number): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { if (read()) return true; await wait(100); }
  return read();
};
const state = (pid: number): string => {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(") ") + 2).split(" ")[0] ?? "unknown";
  } catch { return "gone"; }
};
const live = (pid: number): boolean => state(pid) !== "gone" && state(pid) !== "Z";
const stopGroup = (pid?: number) => { if (!pid) return; try { process.kill(-pid, "SIGKILL"); } catch { try { process.kill(pid, "SIGKILL"); } catch {} } };
const here = dirname(fileURLToPath(import.meta.url)); const repo = resolve(here, "../../.."); const host = join(here, "_orphan-reap-host.ts"); const tsx = join(repo, "node_modules", ".bin", "tsx");
const ambientEnv: NodeJS.ProcessEnv = { ...process.env };
for (const key of Object.keys(ambientEnv)) if (key.startsWith("COTAL_")) delete ambientEnv[key];

const port = await freePort(); const servers = `nats://127.0.0.1:${port}`; const space = `reap1100-${randomUUID().slice(0, 8)}`; const auth = await createSpaceAuth(space); const observerCreds = await mintMembershipObserverCreds(auth, newIdentity()); const evictorCreds = await mintConnectionEvictorCreds(auth, newIdentity());
const dir = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN)); const root = join(dir, "ws"); const seatRoot = join(dir, "seats"); mkdirSync(join(root, ".cotal", "agents"), { recursive: true }); saveSpaceAuth(authDir(root), auth); for (const alias of ["worker", "hangworker"]) writeFileSync(join(root, ".cotal", "agents", `${alias}.md`), `---\nname: ${alias}\nrole: worker\nsubscribe: []\nallowSubscribe: []\nallowPublish: []\n---\n`); writeFileSync(join(dir, "server.conf"), serverConfig(auth, [auth], { transport: { kind: "plaintext" }, port, storeDir: join(dir, "js") }));
const broker = spawn("nats-server", ["-c", join(dir, "server.conf")], { stdio: "ignore" }); const releaseBroker = teardownOnSignal(broker, dir); let daemon: CotalEndpoint | undefined; const managers: ChildProcess[] = []; const pids: number[] = [];
type Ready = { managerPid: number; managerInstanceId: string; seatPid: number; reference: { kind: string; id: string }; actor: string; lifecycleUid: string };
async function startManager(tag: string, spawnSeat: boolean, opts: { alias?: string; hangMarker?: string } = {}): Promise<{ child: ChildProcess; ready?: Ready; stdout: () => string; stderr: () => string }> {
  const child = spawn(tsx, [host], { cwd: repo, env: { ...ambientEnv, REPRO_ROOT: root, REPRO_SPACE: space, REPRO_SERVERS: servers, REPRO_OBSERVER_CREDS: observerCreds, REPRO_EVICTOR_CREDS: evictorCreds, REPRO_ACCOUNT_ID: auth.account.pub, REPRO_SPAWN: spawnSeat ? "1" : "0", REPRO_ALIAS: opts.alias ?? "worker", ...(opts.hangMarker ? { REPRO_HANG_AFTER_SPAWN: "1", REPRO_MARKER: opts.hangMarker } : {}), COTAL_SEAT_ROOT: seatRoot, COTAL_SERVER: "", COTAL_SERVERS: "", COTAL_CREDS: "", NATS_URL: "" }, detached: true, stdio: ["ignore", "pipe", "pipe"] }); managers.push(child); let out = "", err = ""; child.stdout?.on("data", (b) => out += String(b)); child.stderr?.on("data", (b) => err += String(b)); const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    // The hang-window host never reaches REPRO_READY: it freezes inside spawn, so the marker it
    // wrote from there is this manager's readiness.
    if (opts.hangMarker && existsSync(opts.hangMarker)) return { child, stdout: () => out, stderr: () => err };
    const readyLine = out.split("\n").find((x) => x.startsWith("REPRO_READY "));
    if (readyLine) { const ready = JSON.parse(readyLine.slice("REPRO_READY ".length)) as Ready; pids.push(ready.seatPid); return { child, ready, stdout: () => out, stderr: () => err }; }
    const spawnLine = out.split("\n").find((x) => x.startsWith("REPRO_SPAWN "));
    if (spawnLine) throw new Error(`${tag} spawn refused: ${spawnLine}\n${err}`);
    if (!spawnSeat && out.includes("REPRO_MANAGER ")) return { child, stdout: () => out, stderr: () => err };
    if (child.exitCode !== null) throw new Error(`${tag} manager exited ${child.exitCode}: ${err}`);
    await wait(100);
  }
  throw new Error(`${tag} manager readiness timeout: ${err}`);
}
try {
  for (let i = 0; i < 100 && !(await isReachable(servers)); i++) await wait(50); await setupSpaceStreams({ servers, space, creds: await mintCreds(auth, newIdentity(), "provisioner") });
  const did = newIdentity(); daemon = new CotalEndpoint({ space, servers, creds: await mintCreds(auth, did, "delivery"), card: { id: did.id, name: "delivery", role: "delivery", kind: "endpoint" }, channels: [], consume: false, registerPresence: false, watchPresence: false, watchChannels: false }); daemon.on("error", () => {}); await daemon.start(); await daemon.startPlane3(async () => undefined, { evictPrincipal: async (principal) => evictDeniedPrincipalWithCreds({ servers, observerCreds, evictorCreds, accountId: auth.account.pub, principal, options: { maxVerifyRounds: 12 } }) });
  const first = await startManager("first", true);
  const ready = first.ready!;
  const record = readRecord(recordPath(seatRoot, ready.reference.id));
  pids.push(record.custodianPid);
  check("instrument: the seat is a real custodian + child pair with pinned start identities", ready.reference.kind === "pty" && record.childPid === ready.seatPid && typeof record.custodianStart === "string" && typeof record.childStart === "string", { ready, record });
  process.kill(ready.managerPid, "SIGKILL"); await new Promise((resolve) => first.child.once("exit", resolve));
  await wait(1_000);
  check("instrument: manager SIGKILL leaves the custodian and the seat child live", live(record.custodianPid) && live(record.childPid), { custodian: state(record.custodianPid), child: state(record.childPid) });
  // The dead manager's liveness lease must lapse before the same logical instance can start again.
  await wait(20_000);
  const second = await startManager("successor", false);
  const reaped = await until(() => /static retirement worker: orphan seat process custodian \d+ (signalled|gone), child \d+ (signalled|gone)/.test(second.stderr()), 60_000);
  check("successor reaps the orphan seat process before retiring the lifecycle", reaped && !live(record.childPid) && !live(record.custodianPid), { stderr: second.stderr().split("\n").filter((l) => l.includes("static retirement")).join("\n"), custodian: state(record.custodianPid), child: state(record.childPid) });
  check("the custody record is forgotten with the process", await until(() => !existsSync(join(seatRoot, ready.reference.id)), 10_000), ready.reference);
  const evictedFirst = second.stderr().indexOf(`verified orphan seat principal gone: local.${ready.actor}`);
  const reapedAt = second.stderr().search(/orphan seat process custodian/);
  check("broker eviction and process reap are separate, ordered evidence (rails verified gone, then the process)", evictedFirst >= 0 && reapedAt > evictedFirst, { evictedFirst, reapedAt });
  const retired = await until(() => /static reconcile completed: 1 attempted, 1 succeeded, 0 failed/.test(second.stderr()), 30_000);
  check("the lifecycle retires once the process is proved gone", retired && !/static retirement worker \(/.test(second.stderr()), second.stderr().split("\n").filter((l) => /static (reconcile|retirement)/.test(l)).join("\n"));
  // ---- scenario 2: the manager dies inside the spawn window, before the slot activation CAS ----
  // Every manager here derives the same instance id from the shared workspace root, so scenario 1's
  // successor must be gone and its liveness lease lapsed before the next one may serve the space.
  stopGroup(second.child.pid); await new Promise((resolve) => second.child.once("exit", resolve));
  await wait(20_000);
  const marker = join(dir, "hang.json");
  const hung = await startManager("hang-window", true, { alias: "hangworker", hangMarker: marker });
  const spawned = JSON.parse(readFileSync(marker, "utf8")) as { managerPid: number; seatPid: number; reference: { kind: string; id: string } };
  const hungRecord = readRecord(recordPath(seatRoot, spawned.reference.id));
  pids.push(spawned.seatPid, hungRecord.custodianPid);
  check("instrument: the frozen manager launched a real seat and never activated its slot", live(hungRecord.childPid) && live(hungRecord.custodianPid) && !hung.stdout().includes("REPRO_READY "), { spawned, state: { child: state(hungRecord.childPid), custodian: state(hungRecord.custodianPid) } });
  process.kill(spawned.managerPid, "SIGKILL"); await new Promise((resolve) => hung.child.once("exit", resolve));
  await wait(1_000);
  check("instrument: killing it there leaves the seat live with no activated slot", live(hungRecord.childPid) && live(hungRecord.custodianPid), { child: state(hungRecord.childPid), custodian: state(hungRecord.custodianPid) });
  await wait(20_000);
  const third = await startManager("hang-successor", false, { alias: "hangworker" });
  const sawProvisioning = await until(() => /static reconcile terminal alias=hangworker phase=provisioning/.test(third.stderr()), 60_000);
  check("the successor terminalizes that slot from phase=provisioning", sawProvisioning, third.stderr().split("\n").filter((l) => l.includes("static reconcile terminal")).join("\n"));
  const hangReaped = await until(() => /static retirement hangworker: orphan seat process custodian \d+ (signalled|gone), child \d+ (signalled|gone)/.test(third.stderr()), 60_000);
  check("a seat whose spawn never reached the slot activation is still reaped by its reserved reference", hangReaped && !live(hungRecord.childPid) && !live(hungRecord.custodianPid), { stderr: third.stderr().split("\n").filter((l) => l.includes("static retirement hangworker")).join("\n"), custodian: state(hungRecord.custodianPid), child: state(hungRecord.childPid) });
  check("that lifecycle retires only after its process is proved gone", await until(() => /static reconcile completed: \d+ attempted, \d+ succeeded, 0 failed/.test(third.stderr()), 30_000), third.stderr().split("\n").filter((l) => /static reconcile completed/.test(l)).join("\n"));

  const EXPECTED = 11;
  if (pass + fail !== EXPECTED) throw new Error(`expected ${EXPECTED} cells, ran ${pass + fail}; a cell was added or silently skipped`);
  console.log(`\nORPHAN-SEAT REAP SMOKE ${fail === 0 ? "OK ✅" : "FAILED ❌"} (${pass} passed, ${fail} failed)`);
  if (fail) process.exitCode = 1;
} finally {
  const managerExits = managers.map((child) => child.exitCode === null ? new Promise<void>((resolve) => child.once("exit", () => resolve())) : Promise.resolve());
  for (const child of managers) if (child.exitCode === null) stopGroup(child.pid);
  await Promise.all(managerExits);
  for (const pid of pids) stopGroup(pid);
  await daemon?.stop().catch(() => {});
  broker.kill("SIGKILL");
  await wait(300);
  rmSync(dir, { recursive: true, force: true });
  releaseBroker();
}
