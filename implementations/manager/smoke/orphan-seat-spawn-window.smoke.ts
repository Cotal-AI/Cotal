/**
 * A manager that dies INSIDE the spawn window leaves an addressable seat. The window is between
 * the launch (the seat's custodian and child now exist, and its custody record is on disk) and the
 * slot activation CAS, and it is the one case the sibling `orphan-seat-reap` suite cannot see:
 * that suite's manager completes its spawn, so its activation records the custody reference on the
 * way past.
 *
 * Before the reservation the reference was minted inside `runtime.spawn`, so nothing durable named
 * the seat until the CAS. A manager killed in between left a slot at `phase=provisioning` with no
 * runtime field, the successor's terminal had nothing to reap, and it retired the lifecycle and
 * freed the alias over a running process. The reference is now reserved before the launch and
 * rides the slot's first durable row, so the successor can still address the seat.
 *
 * Split from `orphan-seat-reap` rather than added to it: both scenarios wait out a manager
 * liveness lease, and one command carrying both crossed `mutation-proof`'s 15-minute timeout,
 * which reports a SIGKILL with no exit status and refuses to grade rather than failing loudly.
 *
 * Run: pnpm smoke:orphan-seat-spawn-window
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
  console.log(`ORPHAN-SEAT SPAWN WINDOW COMPLETE on ${process.platform}: custody transport unsupported (no skip-as-pass)`);
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

const port = await freePort(); const servers = `nats://127.0.0.1:${port}`; const space = `spawnwin-${randomUUID().slice(0, 8)}`; const auth = await createSpaceAuth(space); const observerCreds = await mintMembershipObserverCreds(auth, newIdentity()); const evictorCreds = await mintConnectionEvictorCreds(auth, newIdentity());
const dir = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN)); const root = join(dir, "ws"); const seatRoot = join(dir, "seats"); mkdirSync(join(root, ".cotal", "agents"), { recursive: true }); saveSpaceAuth(authDir(root), auth); writeFileSync(join(root, ".cotal", "agents", "hangworker.md"), "---\nname: hangworker\nrole: worker\nsubscribe: []\nallowSubscribe: []\nallowPublish: []\n---\n"); writeFileSync(join(dir, "server.conf"), serverConfig(auth, [auth], { transport: { kind: "plaintext" }, port, storeDir: join(dir, "js") }));
const broker = spawn("nats-server", ["-c", join(dir, "server.conf")], { stdio: "ignore" }); const releaseBroker = teardownOnSignal(broker, dir); let daemon: CotalEndpoint | undefined; const managers: ChildProcess[] = []; const pids: number[] = [];
type Ready = { managerPid: number; managerInstanceId: string; seatPid: number; reference: { kind: string; id: string }; actor: string; lifecycleUid: string };
async function startManager(tag: string, spawnSeat: boolean, opts: { hangMarker?: string } = {}): Promise<{ child: ChildProcess; ready?: Ready; stdout: () => string; stderr: () => string }> {
  const child = spawn(tsx, [host], { cwd: repo, env: { ...ambientEnv, REPRO_ROOT: root, REPRO_SPACE: space, REPRO_SERVERS: servers, REPRO_OBSERVER_CREDS: observerCreds, REPRO_EVICTOR_CREDS: evictorCreds, REPRO_ACCOUNT_ID: auth.account.pub, REPRO_SPAWN: spawnSeat ? "1" : "0", REPRO_ALIAS: "hangworker", ...(opts.hangMarker ? { REPRO_HANG_AFTER_SPAWN: "1", REPRO_MARKER: opts.hangMarker } : {}), COTAL_SEAT_ROOT: seatRoot, COTAL_SERVER: "", COTAL_SERVERS: "", COTAL_CREDS: "", NATS_URL: "" }, detached: true, stdio: ["ignore", "pipe", "pipe"] }); managers.push(child); let out = "", err = ""; child.stdout?.on("data", (b) => out += String(b)); child.stderr?.on("data", (b) => err += String(b)); const deadline = Date.now() + 120_000;
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
  const did = newIdentity(); daemon = new CotalEndpoint({ space, servers, creds: await mintCreds(auth, did, "delivery"), card: { id: did.id, name: "delivery", role: "delivery", kind: "endpoint" }, channels: [], consume: false, registerPresence: false, watchPresence: false, watchChannels: false }); daemon.on("error", () => {}); await daemon.start(); await daemon.startPlane3(async () => undefined, { evictPrincipal: async (principal) => evictDeniedPrincipalWithCreds({ servers, observerCreds, evictorCreds, accountId: auth.account.pub, principal, options: { maxVerifyRounds: 12 } }), reloadStoreIdentity: () => ({ kind: "fs", root: resolve(root) }) });
  const marker = join(dir, "hang.json");
  const hung = await startManager("hang-window", true, { hangMarker: marker });
  const spawned = JSON.parse(readFileSync(marker, "utf8")) as { managerPid: number; seatPid: number; reference: { kind: string; id: string } };
  const hungRecord = readRecord(recordPath(seatRoot, spawned.reference.id));
  pids.push(spawned.seatPid, hungRecord.custodianPid);
  check("instrument: the frozen manager launched a real seat and never activated its slot", live(hungRecord.childPid) && live(hungRecord.custodianPid) && !hung.stdout().includes("REPRO_READY "), { spawned, state: { child: state(hungRecord.childPid), custodian: state(hungRecord.custodianPid) } });
  process.kill(spawned.managerPid, "SIGKILL"); await new Promise((resolve) => hung.child.once("exit", resolve));
  await wait(1_000);
  check("instrument: killing it there leaves the seat live with no activated slot", live(hungRecord.childPid) && live(hungRecord.custodianPid), { child: state(hungRecord.childPid), custodian: state(hungRecord.custodianPid) });
  await wait(20_000);
  const third = await startManager("hang-successor", false);
  const sawProvisioning = await until(() => /static reconcile terminal alias=hangworker phase=provisioning/.test(third.stderr()), 60_000);
  check("the successor terminalizes that slot from phase=provisioning", sawProvisioning, third.stderr().split("\n").filter((l) => l.includes("static reconcile terminal")).join("\n"));
  const hangReaped = await until(() => /static retirement hangworker: orphan seat process custodian \d+ (signalled|gone), child \d+ (signalled|gone)/.test(third.stderr()), 60_000);
  check("a seat whose spawn never reached the slot activation is still reaped by its reserved reference", hangReaped && !live(hungRecord.childPid) && !live(hungRecord.custodianPid), { stderr: third.stderr().split("\n").filter((l) => l.includes("static retirement hangworker")).join("\n"), custodian: state(hungRecord.custodianPid), child: state(hungRecord.childPid) });
  check("that lifecycle retires only after its process is proved gone", await until(() => /static reconcile completed: \d+ attempted, \d+ succeeded, 0 failed/.test(third.stderr()), 30_000), third.stderr().split("\n").filter((l) => /static reconcile completed/.test(l)).join("\n"));

  const EXPECTED = 5;
  if (pass + fail !== EXPECTED) throw new Error(`expected ${EXPECTED} cells, ran ${pass + fail}; a cell was added or silently skipped`);
  console.log(`\nORPHAN-SEAT SPAWN WINDOW SMOKE ${fail === 0 ? "OK ✅" : "FAILED ❌"} (${pass} passed, ${fail} failed)`);
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
