/**
 * DELIVERY PIDFILE OWNERSHIP SMOKE (#1528) — the daemon owns its own liveness record.
 *
 * THE DEFECT. `delivery.<space>.pid` was written ONLY by the CLI launcher (`startDeliveryDetached`).
 * A daemon started by any other route — a container entrypoint, systemd, an operator typing
 * `cotal deliver --space …` — left whatever was on disk untouched, and every reader believed it.
 * On the reporting mesh the record named a pid four days dead while the daemon ran under a new one.
 *
 * WHY THAT IS NOT MERELY AN UNDER-REPORT. `cotal down` decides what to stop from that record, and
 * `mayBeRunning` is documented as the guard that must fail CLOSED so `cotal down nats` cannot pull
 * the broker out from under a live dependant. A record naming a dead pid SATISFIES that guard: it
 * supplies the proof-of-death the guard requires, so a live delivery daemon reads as clear.
 *
 * THE SUITE RUNS THE REAL DAEMON ON THE NON-LAUNCHER PATH, which is the whole subject: `cotal
 * deliver` is spawned directly against a real auth broker, exactly as a container entrypoint would,
 * and `startDeliveryDetached` is never called. Everything is then asked through the SHIPPED readers
 * (`deliveryLiveness`, `mayBeRunning`) rather than a re-implementation, because the readers are half
 * of what the issue measured.
 *
 * Run: pnpm smoke:delivery-pidfile-ownership   (needs `nats-server` on PATH; auth/JetStream, local-only)
 */
import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createSpaceAuth, isReachable, mintCreds, mintMembershipObserverCreds, newIdentity, serverConfig, setupSpaceStreams } from "@cotal-ai/core";
import {
  canonicalLocalProcessPath, DELIVERY_PIDFILE, identityPinPath, parsePid, probeLiveness,
  readProcessCommand, spaceMaterialDir, type LocalProcess,
} from "@cotal-ai/workspace";
import { SMOKE_BROKER_TOKEN, teardownOnSignal } from "@cotal-ai/smoke-kit";

let pass = 0, fail = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ FAIL: ${name}`, extra !== undefined ? JSON.stringify(extra) : ""); }
};
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const alive = (pid: number): boolean => probeLiveness(pid) === "alive";

async function freePort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const addr = s.address();
  if (!addr || typeof addr !== "object") throw new Error("no port");
  await new Promise<void>((r) => s.close(() => r()));
  return addr.port;
}

const repoRoot = resolve(import.meta.dirname, "..", "..", "..");
const SPACE = `dlv-own-${randomUUID().slice(0, 8)}`;
const PORT = await freePort();
const SERVERS = `nats://127.0.0.1:${PORT}`;
const auth = await createSpaceAuth(SPACE);
const dir = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
writeFileSync(join(dir, "server.conf"), serverConfig(auth, [auth], { transport: { kind: "plaintext" }, port: PORT, storeDir: join(dir, "js") }));
const srv = spawn("nats-server", ["-c", join(dir, "server.conf")], { stdio: "ignore" });
const releaseBroker = teardownOnSignal(srv, dir);

// The workstation root the daemon will resolve by walking up from its cwd. Its own `.cotal`, so the
// walk stops here rather than climbing into whatever real workspace sits above the repo.
const wsRoot = join(dir, "ws");
mkdirSync(join(wsRoot, ".cotal"), { recursive: true });
const PID_PATH = canonicalLocalProcessPath(DELIVERY_PIDFILE, { root: wsRoot, space: SPACE });
/** The registered `delivery` lifecycle row, as `implementations/cli/src/index.ts` declares it — the
 *  descriptor `cotal down`'s own guards are asked about. */
const DELIVERY_ROW: LocalProcess = {
  kind: "local-process", name: "delivery", label: "delivery daemon", order: 20,
  pidFile: DELIVERY_PIDFILE, artifacts: ["delivery.creds"],
};
const ctx = { root: wsRoot, space: SPACE };

let daemon: ChildProcess | undefined;
let daemonExited = false;
let daemonLog = "";
const strays: ChildProcess[] = [];
const prevCwd = process.cwd();
try {
  let up = false;
  for (let i = 0; i < 60; i++) { if (await isReachable(SERVERS)) { up = true; break; } await wait(200); }
  check("FIXTURE: the auth broker is up", up);
  await setupSpaceStreams({ servers: SERVERS, space: SPACE, creds: await mintCreds(auth, newIdentity(), "provisioner") });
  const credsPath = join(dir, "delivery.creds");
  writeFileSync(credsPath, await mintCreds(auth, newIdentity(), "delivery"), { mode: 0o600 });
  mkdirSync(spaceMaterialDir(wsRoot, SPACE), { recursive: true });
  writeFileSync(
    join(spaceMaterialDir(wsRoot, SPACE), "membership-observer.creds"),
    await mintMembershipObserverCreds(auth, newIdentity()),
    { mode: 0o600 },
  );

  // THE CONTROL THAT MUST STAY GREEN however this suite is graded: before any daemon runs, the
  // record is absent and the fail-closed guard is clear. It is also the baseline the cells below
  // are a change FROM, so a suite that died early could not have produced it.
  const { mayBeRunning } = await import("../src/commands/down.js");
  const { deliveryLiveness } = await import("../src/lib/delivery-proc.js");
  process.chdir(wsRoot); // the shipped readers resolve their root by walking up from cwd
  check("CONTROL: with no daemon and no record, the record is absent and the down guard is clear",
    !existsSync(PID_PATH) && deliveryLiveness(undefined, SPACE) === "absent" && mayBeRunning(DELIVERY_ROW, ctx) === false);

  // ---- THE SUBJECT: a daemon started on the NON-LAUNCHER path, as a container entrypoint would ----
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith("COTAL_")) delete env[k];
  env.XDG_CONFIG_HOME = join(dir, "xdg");
  env.COTAL_HOME = join(dir, "cotal-home");
  env.COTAL_SKIP_CONNECTOR_SEED = "1";
  daemon = spawn(
    join(repoRoot, "node_modules", ".bin", "tsx"),
    [join(repoRoot, "bin", "cotal.ts"), "deliver", "--space", SPACE, "--server", SERVERS, "--creds", credsPath],
    { cwd: wsRoot, stdio: ["ignore", "pipe", "pipe"], env },
  );
  const sink = (b: Buffer) => { daemonLog += b.toString(); };
  daemon.stdout?.on("data", sink);
  daemon.stderr?.on("data", sink);
  daemon.on("exit", () => { daemonExited = true; });

  // Wait for the daemon to ANNOUNCE itself up. That line is printed after the lease acquire and the
  // Plane-3 bind, so it is the point by which a daemon that owns its record has written one.
  let ready = false;
  for (let i = 0; i < 120; i++) {
    if (/delivery daemon up/.test(daemonLog)) { ready = true; break; }
    if (daemonExited) break;
    await wait(250);
  }
  check("FIXTURE: the daemon started OUTSIDE the launcher comes up and announces itself", ready && !daemonExited, daemonLog.slice(-800));

  check("CELL: a daemon started outside the launcher WRITES its own liveness record",
    existsSync(PID_PATH), { PID_PATH, daemonLog: daemonLog.slice(-400) });
  // WHAT THE RECORD MUST NAME. Not `daemon.pid`: the launch goes through `tsx`, which re-execs, so
  // the process that IS the daemon is not the one this suite spawned — and the record is supposed to
  // name the daemon, which is precisely the point. So it is graded the way a reader grades it: the
  // recorded pid must be ALIVE and its own argv must name `cotal deliver`. A record naming a corpse
  // (the reported state) fails the first half; a record naming some unrelated survivor fails the
  // second.
  const recordedPid = existsSync(PID_PATH) ? parsePid(readFileSync(PID_PATH, "utf8")) : undefined;
  const recordedCmd = recordedPid === undefined ? undefined : readProcessCommand(recordedPid);
  check("CELL: and that record names a LIVE process, not a corpse",
    recordedPid !== undefined && alive(recordedPid), { recordedPid });
  check("CELL: and the live process it names is the delivery daemon itself",
    // Spelled out here rather than imported: this suite must assert BEHAVIOUR, and importing a
    // predicate the fix ADDS would make the suite fail to import once the fix is reverted, which
    // proves nothing about the defect.
    recordedCmd?.kind === "command" && /(^|\s)deliver(\s|$)/.test(recordedCmd.command) && /--space\s+\S/.test(recordedCmd.command),
    recordedCmd);
  check("CELL: the #969 identity pin is written beside the record and pairs with the SAME pid",
    existsSync(identityPinPath(PID_PATH))
      && readFileSync(identityPinPath(PID_PATH), "utf8").trim().split(/\s+/)[0] === String(recordedPid),
    existsSync(identityPinPath(PID_PATH)) ? readFileSync(identityPinPath(PID_PATH), "utf8").trim() : null);
  check("CELL: the shipped reader reports the live daemon as ALIVE rather than absent",
    deliveryLiveness(undefined, SPACE) === "alive", deliveryLiveness(undefined, SPACE));
  // THE GUARD THE ISSUE IS ABOUT. `mayBeRunning` must block a `cotal down nats` while this daemon
  // is live; over an absent or stale record it returns false and the broker goes out from under it.
  check("CELL: the fail-closed down guard sees the live daemon (mayBeRunning is TRUE)",
    mayBeRunning(DELIVERY_ROW, ctx) === true, mayBeRunning(DELIVERY_ROW, ctx));

  // ---- THE READER HALF: a live pid alone is not proof the process is a delivery daemon ----
  // A record that outlived its daemon is eventually re-pointed at an unrelated process by pid reuse.
  // The record is moved aside first so the daemon's own file is restored intact afterwards.
  const daemonRecord = readFileSync(PID_PATH, "utf8");
  const stranger = spawn(process.execPath, ["-e", "setInterval(() => {}, 1 << 30)"], { stdio: "ignore" });
  strays.push(stranger);
  teardownOnSignal(stranger);
  await wait(300); // let it exec, so the argv read sees its final command line
  writeFileSync(PID_PATH, String(stranger.pid));
  check("CELL: a live pid that is provably NOT a delivery daemon reads FOREIGN, not as a healthy daemon",
    deliveryLiveness(undefined, SPACE) === "foreign", { got: deliveryLiveness(undefined, SPACE), strangerPid: stranger.pid });
  writeFileSync(PID_PATH, daemonRecord);
  stranger.kill("SIGKILL");

  // ---- CLEAN EXIT: the record's lifetime is the daemon's ----
  const recordWasThere = existsSync(PID_PATH);
  daemon.kill("SIGTERM");
  for (let i = 0; i < 60 && !daemonExited; i++) await wait(250);
  check("FIXTURE: the daemon exits on SIGTERM", daemonExited, daemonLog.slice(-400));
  // Stated as a CHANGE (it was there, then it was gone), so a build that never wrote a record at all
  // cannot satisfy this by having nothing to remove.
  check("CELL: the daemon REMOVES the record it wrote when it exits cleanly",
    recordWasThere && !existsSync(PID_PATH), { recordWasThere, stillThere: existsSync(PID_PATH) });
  check("CELL: and the identity pin goes with it",
    recordWasThere && !existsSync(identityPinPath(PID_PATH)), existsSync(identityPinPath(PID_PATH)));
  check("CONTROL: with the daemon gone the down guard is clear again",
    mayBeRunning(DELIVERY_ROW, ctx) === false && deliveryLiveness(undefined, SPACE) === "absent");

  console.log(`\nDELIVERY-PIDFILE-OWNERSHIP SMOKE ${fail === 0 ? "OK ✅" : "FAILED ❌"}  (${pass} passed, ${fail} failed)`);
  if (fail) process.exitCode = 1;
} catch (e) {
  fail++;
  console.error("  ✗ scenario threw:", (e as Error).message);
  process.exitCode = 1;
} finally {
  process.chdir(prevCwd);
  for (const s of strays) { try { s.kill("SIGKILL"); } catch { /* gone */ } }
  try { if (daemon && !daemonExited) daemon.kill("SIGKILL"); } catch { /* gone */ }
  try { srv.kill("SIGKILL"); } catch { /* gone */ }
  rmSync(dir, { recursive: true, force: true });
  releaseBroker();
}
