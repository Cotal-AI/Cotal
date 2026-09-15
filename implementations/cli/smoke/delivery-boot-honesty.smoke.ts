/**
 * BOOT-PATH RESPONDER HONESTY SMOKE (#1576) — the `ensureDelivery` / `cotal up` half.
 *
 * THE DEFECT, IN ONE LINE OF THE OLD CODE. `ensureDelivery` waited for the daemon's readiness lease,
 * and when that wait elapsed it printed one info line promising that "boot durable joins will
 * reconcile when it is" and then `return { running: true }`. Its caller therefore could not tell a
 * bound responder from an unbound one, so `cotal up` printed its success banner over a control plane
 * that could not spawn, retire, or accept a join. A reporter's 30-agent fleet ran 22 hours that way.
 *
 * WHY THIS FILE EXISTS SEPARATELY FROM THE STATUS CELL. A mutation that made `ensureDelivery` return
 * `responderBound: true` unconditionally SURVIVED the status cells: they read the lease through the
 * status surface, not through the boot path's own answer. Two different surfaces, two different
 * lines, and only one of them was pinned. This cell pins the other.
 *
 * THE FIXTURE HOLDS THE SINGLE-FLIGHT SLOT WITHOUT BINDING. A holder CAS-creates the shard-0 lease
 * `ready:false` and keeps it, which is exactly the state a daemon is in before `startPlane3` binds
 * `ctl.delivery` — so `ensureDelivery` ADOPTS a live recorded daemon whose responder is not bound,
 * the reported condition, and must say so.
 *
 * Run: pnpm smoke:delivery-boot-honesty
 */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createSpaceAuth, deliveryBucket, mintCreds, newIdentity, serverConfig, setupSpaceStreams } from "@cotal-ai/core";
import { connect, credsAuthenticator } from "@nats-io/transport-node";
import { Kvm } from "@nats-io/kv";
import { canonicalLocalProcessPath, MANAGER_DELIVERY_AWARE_MARKER, MANAGER_PIDFILE, saveSpaceAuth } from "@cotal-ai/workspace";
import { emitSentinel, killAndAwaitExit, teardownOnSignal } from "@cotal-ai/smoke-kit";

let pass = 0, fail = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ FAIL: ${name}`, extra ?? ""); }
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const SPACE = "boot-honesty";
const root = mkdtempSync(join(tmpdir(), "cotal-boot-honesty-root-"));
const home = mkdtempSync(join(tmpdir(), "cotal-boot-honesty-home-"));
mkdirSync(join(root, ".cotal"), { recursive: true });
for (const k of Object.keys(process.env)) if (k.startsWith("COTAL_")) delete process.env[k];
process.env.COTAL_HOME = home;
process.env.COTAL_SKIP_CONNECTOR_SEED = "1";

async function freePort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const addr = s.address();
  assert.ok(addr && typeof addr === "object");
  await new Promise<void>((r) => s.close(() => r()));
  return addr.port;
}
async function portOpen(port: number): Promise<boolean> {
  return new Promise((res) => {
    const sock = createConnection({ host: "127.0.0.1", port });
    const done = (v: boolean) => { sock.destroy(); res(v); };
    sock.once("connect", () => done(true));
    sock.once("error", () => done(false));
    sock.setTimeout(250, () => done(false));
  });
}
const port = await freePort();
const server = `nats://127.0.0.1:${port}`;
const auth = await createSpaceAuth(SPACE);
// An AUTH mesh, because `ensureDelivery` is auth-mode-only: in open mode it returns early and the
// question this cell asks does not arise.
saveSpaceAuth(join(root, ".cotal", "auth"), auth);
writeFileSync(join(root, "server.conf"), serverConfig(auth, [auth], { transport: { kind: "plaintext" }, port, storeDir: join(root, "js") }));

const WT_ROOT = resolve(import.meta.dirname, "..", "..", "..");
const TSX = join(WT_ROOT, "node_modules", ".bin", "tsx");
const WRAPPER = join(import.meta.dirname, "signal-ownership-wrapper.fixture.ts");

let broker: ChildProcess | undefined, holder: ChildProcess | undefined;
let releaseBroker: () => void = () => {};
let releaseHolder: () => void = () => {};
// `undefined` until the kill cell adopts the wrapper, so the cell below grades the adoption itself
// rather than trusting it. A no-op default would make an unadopted wrapper indistinguishable.
let releaseWrapper: (() => void) | undefined;
const origCwd = process.cwd();
try {
  broker = spawn("nats-server", ["-c", join(root, "server.conf")], { stdio: "ignore" });
  // OWN the broker rather than only unwinding it. The `finally` at the foot of this file is correct
  // and still runs on the normal path, but it never runs when THIS process is SIGNALLED, and the
  // broker then reparents to init holding a port and a JetStream store. That is defect 2 in
  // `broker-teardown.ts`, and it is the one a tool timeout produces. `root` is the owned path
  // because the store dir is `root/js`, so the signal path removes the same tree the normal one does.
  releaseBroker = teardownOnSignal(broker, root);
  for (let i = 0; i < 120 && !(await portOpen(port)); i++) await sleep(50);
  check("fixture auth broker started", await portOpen(port));
  await setupSpaceStreams({ servers: server, space: SPACE, creds: await mintCreds(auth, newIdentity(), "provisioner") });

  // A live delivery process whose responder is NOT bound: the lease exists, ready:false. On an auth
  // mesh the holder needs its own `delivery` credential, which is also what makes this fixture honest
  // — it connects the way the real daemon does.
  const holderCreds = join(root, "holder.creds");
  writeFileSync(holderCreds, await mintCreds(auth, newIdentity(), "delivery"), { mode: 0o600 });
  holder = spawn(process.execPath, [join(import.meta.dirname, "delivery-responder-holder.mjs"), server, SPACE, "claim", holderCreds], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
  // The holder is a child of this process too, and it outlives a killed wrapper for the same reason.
  // No store dir is passed: the holder owns no tree of its own, and `root` is already owned above.
  releaseHolder = teardownOnSignal(holder);
  holder.stderr?.on("data", (c) => process.stderr.write(`holder: ${c}`));
  await new Promise<void>((res, rej) => {
    const t = setTimeout(() => rej(new Error("holder never reported its pid")), 20_000);
    holder!.stdout?.once("data", () => { clearTimeout(t); res(); });
  });
  writeFileSync(join(root, ".cotal", "delivery.pid"), String(holder.pid));

  process.chdir(root);
  const { ensureDelivery } = await import("../src/lib/delivery-proc.js");
  const lines: string[] = [];
  const origErr = console.error;
  console.error = (...a: unknown[]) => { lines.push(a.join(" ")); };
  let result: { running: boolean; responderBound?: boolean };
  try {
    result = await ensureDelivery({ space: SPACE, server });
  } finally {
    console.error = origErr;
  }
  const out = lines.join("\n").replace(/\x1b\[[0-9;]*m/g, "");

  // THE CELL. The old code returned `{ running: true }` with no second fact; a caller could not
  // distinguish this state from a healthy boot, which is precisely why `cotal up` was silent.
  check("ensureDelivery reports the daemon as RUNNING (a process is there)", result.running === true, result);
  check("CELL: ensureDelivery reports responderBound FALSE over an unbound responder",
    result.responderBound === false, result);
  check("CELL: its message names the CONSEQUENCE, not just a pending reconcile",
    /no spawn, no retirement, no join until it binds/.test(out), out);
  check("CELL: its message no longer promises only that joins 'will reconcile when it is'",
    !/boot durable joins will reconcile when it is/.test(out), out);
  check("CELL: it says the wait is open-ended rather than implying it is handled",
    /does not time out on its own/.test(out), out);
  check("CELL: it tells the operator agents do NOT need respawning",
    /WITHOUT being respawned/.test(out), out);

  // ---------- THE PROPAGATION, which is a SECOND line and needs its own assertion ----------
  // `ensureDelivery` knowing the answer is useless if the function `cotal up` actually calls throws it
  // away. `ensureControlPlane` used to `await ensureDelivery(...)` for its side effects and return only
  // the manager's result, so the boot command had nothing to report even once the daemon path was
  // honest. A mutant that restored that discard SURVIVED a cell that only checked `ensureDelivery`,
  // which is exactly the "fixed one surface, left the other" shape this whole issue is about.
  //
  // THE MANAGER HALF IS SATISFIED BY A LIVE RECORD, NEVER BY A SPAWN (#1629). This composition used
  // to reach `startManagerDetached`, whose argv comes from `selfArgv()` = `[node, ...execArgv,
  // process.argv[1]]`. Under tsx `process.argv[1]` is THIS FILE, so the detached "manager" was this
  // suite, which ran to this line and spawned the next generation: 970 of them in 4.7 hours on a
  // persistent host, each with its own nats-server and holder, before the chain was killed by pid.
  // The suite's `finally` and `teardownOnSignal` cannot reach that child, which is unref'd by design.
  //
  // So the fixture presents a manager that is ALREADY RUNNING, which is a real `cotal up` path (a
  // second `up` on a live root) and the one that reaches the propagation with no re-exec at all. The
  // stand-in is a sleeper whose argv carries `supervise`, because that is the whole of what
  // `commandIsCotalSupervisor` attributes a record with.
  const supervisor = spawn(process.execPath, ["-e", "setInterval(() => {}, 1 << 30)", "supervise"], { cwd: root, stdio: "ignore" });
  const releaseSupervisor = teardownOnSignal(supervisor);
  const { managerLiveness, managerLogPath } = await import("../src/lib/manager-proc.js");
  const managerPid = canonicalLocalProcessPath(MANAGER_PIDFILE, { root, space: SPACE });
  const managerAware = canonicalLocalProcessPath(MANAGER_DELIVERY_AWARE_MARKER, { root, space: SPACE });
  const managerLog = managerLogPath(SPACE, root);
  try {
    // Both records a real start writes: the pid, and the delivery-aware marker beside it. Without
    // the marker the composition's own cutover preflight reads this as a pre-daemon hosting manager
    // and stops it, and the run reaches the spawn after all.
    writeFileSync(managerPid, String(supervisor.pid));
    writeFileSync(managerAware, String(supervisor.pid));
    // The stand-in is graded before it is relied on: a fixture that failed to look alive would send
    // the propagation cell below through the spawn path this issue exists to close.
    check("FIXTURE: the recorded manager reads ALIVE, so the composition needs no spawn",
      managerLiveness(undefined, undefined, SPACE) === "alive",
      { pid: supervisor.pid, state: managerLiveness(undefined, undefined, SPACE) });

    const { ensureControlPlane } = await import("../src/lib/delivery-proc.js");
    const planeLines: string[] = [];
    const origErr2 = console.error;
    console.error = (...a: unknown[]) => { planeLines.push(a.join(" ")); };
    let plane: { running: boolean; responderBound?: boolean } | undefined;
    let planeThrew: string | undefined;
    try {
      plane = await ensureControlPlane({ space: SPACE, server });
    } catch (e) {
      planeThrew = (e as Error).message;
    } finally {
      console.error = origErr2;
    }
    if (plane) {
      check("CELL: ensureControlPlane PROPAGATES responderBound=false to its caller (`cotal up`)",
        plane.responderBound === false, plane);
    } else {
      check("ensureControlPlane threw before it could answer (manager half, not the delivery answer)",
        false, planeThrew);
    }
    // THE AFTERMATH CELL, and it is the one that reds if the guard ever comes off. The detached
    // starter opens `manager.<key>.log` BEFORE it spawns, so the log's existence is the cheapest
    // deterministic evidence that a child was launched into this fixture root. Counting processes
    // afterwards would race the spawn; this cannot.
    check("CELL: the composition launched NOTHING into the fixture root (no detached manager log)",
      !existsSync(managerLog), managerLog);

    // AND THE GUARD ITSELF, reached through the function `cotal up` calls rather than through
    // `selfArgv` directly: with no live record, `ensureManager` goes to the spawn, and the spawn
    // refuses because this file is not the `cotal` entry. A fixture that removes the record and
    // still gets a child is exactly the reported defect.
    rmSync(managerPid, { force: true });
    rmSync(managerAware, { force: true });
    const { ensureManager } = await import("../src/lib/manager-proc.js");
    let spawnRefusal: string | undefined;
    try { ensureManager({ space: SPACE, server }); } catch (e) { spawnRefusal = (e as Error).message; }
    check("CELL: with no manager recorded, the spawn REFUSES rather than re-execing this suite",
      spawnRefusal !== undefined, spawnRefusal);
    check("CELL: and the refusal names this suite as the entry it will not re-exec",
      spawnRefusal?.includes("delivery-boot-honesty.smoke.ts") === true, spawnRefusal);
    // The refusal is computed BEFORE the log is opened, so a refused start leaves the root exactly
    // as it found it. A guard that ran after the side effects would still fork nothing and still
    // litter every fixture root with a manager log and a leaked fd.
    check("CELL: the refused spawn left no manager log behind either", !existsSync(managerLog), managerLog);
  } finally {
    await killAndAwaitExit(supervisor);
    releaseSupervisor();
  }

  // ---------- THE STALE-READY PATH (#837 inside #1576) ----------
  // THE ASSUMPTION THE WHOLE HOLDER CHECK RESTS ON, verified against the real broker rather than
  // asserted in a comment: that a daemon's lease `holder` IS `idFromCreds` of the credential file it
  // was given. If that were false, the check would call healthy meshes stale, which is the mirror of
  // the bug it removes and worse than leaving it alone. The holder fixture connected with
  // `holderCreds`, so the record now in the bucket is real evidence either way.
  //
  // This path was found by asking what path no cell walks. Every other leg here holds the holder
  // fixed and varies `ready`, so nothing graded a ready record belonging to a daemon that is GONE —
  // and measured on a real broker, a killed holder's `ready:true` survives for the rest of the bucket
  // TTL, over which bare status printed `responder bound`.
  const { deliveryResponderFromLease } = await import("../src/lib/delivery-responder.js");
  const { idFromCreds, principalKey, DEV_OWNER } = await import("@cotal-ai/core");
  const credsId = idFromCreds(readFileSync(holderCreds, "utf8"));
  // THE SHAPE, stated as the code states it. This cell caught a real defect: the first version
  // compared against the BARE creds id, but the endpoint rewrites `card.id` to the principal
  // dot-form `<owner>.<actor>` before the lease is written, so that comparison would have marked
  // EVERY healthy daemon stale — the exact mirror of the bug being fixed.
  const holderId = principalKey(DEV_OWNER, credsId).key;
  // Read with the holder's OWN credential and its `_INBOX_<id>` prefix: a delivery cred's `sub.allow`
  // only permits that prefix, which is the same constraint `waitForDeliveryLease` works under.
  const nc = await connect({
    servers: server,
    authenticator: credsAuthenticator(new TextEncoder().encode(readFileSync(holderCreds, "utf8"))),
    inboxPrefix: `_INBOX_${credsId}`,
  });
  let recordedHolder: string | undefined;
  try {
    const kv = await new Kvm(nc).open(deliveryBucket(SPACE));
    const entry = await kv.get("lease.0");
    recordedHolder = entry && entry.operation !== "DEL" && entry.operation !== "PURGE"
      ? (entry.json() as { holder: string }).holder
      : undefined;
  } finally {
    await nc.drain().catch(() => {});
  }
  check("STALE PATH: the lease holder a real daemon writes IS the principal dot-form of its creds id",
    recordedHolder === holderId, { recordedHolder, holderId });
  // The negative half, so a future refactor that silently reverts to the bare id REDDENS here rather
  // than shipping a check that marks every healthy mesh stale.
  check("STALE PATH: the holder is NOT the bare creds id (the mistake this cell caught)",
    recordedHolder !== credsId, { recordedHolder, credsId });
  // Given that, the two directions of the check, on the REAL id rather than a made-up one.
  check("STALE PATH: a ready record from a DIFFERENT daemon is stale, not bound",
    deliveryResponderFromLease({ holder: "local.someOtherDaemon", since: Date.now(), ready: true }, holderId) === "stale");
  check("STALE PATH: a ready record from THAT daemon is still bound (no false staleness)",
    deliveryResponderFromLease({ holder: holderId, since: Date.now(), ready: true }, holderId) === "bound");

  // ---------- SIGNAL OWNERSHIP: A KILLED WRAPPER MUST NOT REPARENT ITS CHILDREN ----------
  // THIS IS THE ONLY CELL HERE THAT GRADES THE SIGNAL PATH, and it has to be a separate process: the
  // defect is what happens when this suite is killed, and a suite cannot assert about its own
  // aftermath. So a wrapper is spawned, its grandchild's pid is read off stdout, the WRAPPER is
  // killed, and survivors are counted from here. A happy-path assertion proves nothing about this:
  // the `finally` below is correct and is exactly what a signal skips.
  const wrapper = spawn(TSX, [WRAPPER], { cwd: WT_ROOT, stdio: ["ignore", "pipe", "pipe"] });
  // ADOPT THE WRAPPER. Until this line the one spawn in this file that was NOT owned by the signal
  // path was the wrapper inside the cell that grades the signal path: a SIGTERM here leaked a tsx
  // process, its nats server and its holder to init. That is not hypothetical -- a reviewer's timeout
  // kill during verification reparented exactly this tree. Owning `wrapper` is sufficient for the
  // whole subtree precisely because of the property this cell grades: killing the wrapper takes its
  // children with it. Released only AFTER the survivor count below, so the window in which the tree
  // is unowned is empty rather than merely short.
  releaseWrapper = teardownOnSignal(wrapper);
  let wrapperErr = "";
  wrapper.stderr?.on("data", (c) => { wrapperErr += String(c); });
  const grandchildPid = await new Promise<number>((res, rej) => {
    const t = setTimeout(() => rej(new Error(`wrapper never reported a child pid: ${wrapperErr}`)), 30_000);
    let buf = "";
    wrapper.stdout?.on("data", (c) => {
      buf += String(c);
      const m = /CHILD_PID (\d+)/.exec(buf);
      if (m) { clearTimeout(t); res(Number(m[1])); }
    });
  });
  const alive = (pid: number): boolean => {
    try { process.kill(pid, 0); return true; }
    catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; }
  };
  // POSITIVE CONTROL, so a survivor count of zero cannot be earned by a child that never started.
  check("SIGNAL OWNERSHIP: the wrapper's child is alive BEFORE the wrapper is killed",
    alive(grandchildPid), { grandchildPid });
  const wrapperExited = new Promise<void>((res) => wrapper.once("exit", () => res()));
  wrapper.kill("SIGTERM");
  await Promise.race([wrapperExited, sleep(15_000)]);
  for (let i = 0; i < 60 && alive(grandchildPid); i++) await sleep(50);
  const survivors = alive(grandchildPid) ? 1 : 0;
  if (survivors > 0) { try { process.kill(grandchildPid, "SIGKILL"); } catch { /* raced */ } }
  check("CELL: killing the wrapper leaves ZERO surviving children (survivor count, not a happy path)",
    survivors === 0, { grandchildPid, survivors, wrapperErr });
  // Grades the ADOPTION, not the signal delivery: `teardownOnSignal` installs process-local handlers,
  // so a suite cannot raise a real signal at itself and still report. What is checkable in-process is
  // that the wrapper tree was owned for the whole span in which it existed -- registration before the
  // kill, still registered when the count is taken. Removing the `teardownOnSignal(wrapper)` line
  // leaves this `undefined` and REDDENS here instead of failing silently only on a signal nobody sent.
  check("SIGNAL OWNERSHIP: the wrapper itself was adopted by the signal path (it is the one spawn this cell is about)",
    releaseWrapper !== undefined, { adopted: releaseWrapper !== undefined });
  // Release LAST: the tree stays owned until its survivors have actually been counted.
  releaseWrapper?.();
  releaseWrapper = undefined;

  console.log(fail === 0 ? `\nDELIVERY-BOOT-HONESTY SMOKE OK ✅  (${pass} passed, ${fail} failed)` : `\nDELIVERY-BOOT-HONESTY SMOKE FAILED ❌  (${pass} passed, ${fail} failed)`);
  // Canonical sentinel: the shard runner refuses a suite that exits 0 having run zero cells, and
  // the banner above only parses through a legacy compatibility branch.
  emitSentinel({ passed: pass, failed: fail });
  process.exitCode = fail === 0 ? 0 : 1;
} finally {
  process.chdir(origCwd);
  // Tear down first, then RELEASE: the helper must keep owning each child until it is actually gone,
  // so a signal arriving mid-teardown still reaps. `killAndAwaitExit` does not return until the
  // process has exited, which is what keeps the `rmSync` below from racing a still-writing broker.
  // If the kill cell threw before its own release, the wrapper is still owned; drop it here so a dead
  // entry cannot outlive the run in the helper's `owned` set.
  releaseWrapper?.();
  if (holder) await killAndAwaitExit(holder);
  releaseHolder();
  if (broker) await killAndAwaitExit(broker);
  releaseBroker();
  rmSync(root, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
}
