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
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSpaceAuth, mintCreds, newIdentity, serverConfig, setupSpaceStreams } from "@cotal-ai/core";
import { saveSpaceAuth } from "@cotal-ai/workspace";
import { emitSentinel } from "@cotal-ai/smoke-kit";

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
async function stop(child: ChildProcess | undefined): Promise<void> {
  if (!child?.pid) return;
  try { child.kill("SIGTERM"); } catch { /* gone */ }
  for (let i = 0; i < 40; i++) {
    try { process.kill(child.pid, 0); } catch { return; }
    await sleep(50);
  }
  try { child.kill("SIGKILL"); } catch { /* gone */ }
}

const port = await freePort();
const server = `nats://127.0.0.1:${port}`;
const auth = await createSpaceAuth(SPACE);
// An AUTH mesh, because `ensureDelivery` is auth-mode-only: in open mode it returns early and the
// question this cell asks does not arise.
saveSpaceAuth(join(root, ".cotal", "auth"), auth);
writeFileSync(join(root, "server.conf"), serverConfig(auth, [auth], { transport: { kind: "plaintext" }, port, storeDir: join(root, "js") }));

let broker: ChildProcess | undefined, holder: ChildProcess | undefined;
const origCwd = process.cwd();
try {
  broker = spawn("nats-server", ["-c", join(root, "server.conf")], { stdio: "ignore" });
  for (let i = 0; i < 120 && !(await portOpen(port)); i++) await sleep(50);
  check("fixture auth broker started", await portOpen(port));
  await setupSpaceStreams({ servers: server, space: SPACE, creds: await mintCreds(auth, newIdentity(), "provisioner") });

  // A live delivery process whose responder is NOT bound: the lease exists, ready:false. On an auth
  // mesh the holder needs its own `delivery` credential, which is also what makes this fixture honest
  // — it connects the way the real daemon does.
  const holderCreds = join(root, "holder.creds");
  writeFileSync(holderCreds, await mintCreds(auth, newIdentity(), "delivery"), { mode: 0o600 });
  holder = spawn(process.execPath, [join(import.meta.dirname, "delivery-responder-holder.mjs"), server, SPACE, "claim", holderCreds], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
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
  // The manager is NOT started here and is not what is under test: `ensureManager` may well fail in a
  // bare fixture root, and what matters is that the delivery answer SURVIVES the composition. So the
  // call is allowed to throw, and the assertion is on the value when it returns.
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
    // A throw is a legitimate outcome for the manager half in this fixture, but it must not be the
    // reason this cell passes — say so out loud rather than counting a skip as a check.
    check("ensureControlPlane threw before it could answer (manager half, not the delivery answer)",
      false, planeThrew);
  }

  console.log(fail === 0 ? `\nDELIVERY-BOOT-HONESTY SMOKE OK ✅  (${pass} passed, ${fail} failed)` : `\nDELIVERY-BOOT-HONESTY SMOKE FAILED ❌  (${pass} passed, ${fail} failed)`);
  // Canonical sentinel: the shard runner refuses a suite that exits 0 having run zero cells, and
  // the banner above only parses through a legacy compatibility branch.
  emitSentinel({ passed: pass, failed: fail });
  process.exitCode = fail === 0 ? 0 : 1;
} finally {
  process.chdir(origCwd);
  await stop(holder);
  await stop(broker);
  rmSync(root, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
}
