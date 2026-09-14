/**
 * DELIVERY RESPONDER VISIBILITY SMOKE (#1576).
 *
 * THE REPORTED INCIDENT, AS A TEST. A 30-agent deployment cold-booted, the delivery daemon never
 * bound its `ctl.delivery` responder, and for 22 hours every operator-facing surface said the mesh
 * was fine: `systemctl is-active` reported active (the PARENT `cotal up` was alive), `cotal ps`
 * listed the agents, and bare `cotal status` printed `delivery  running (pid N)` — the identical line
 * it prints when delivery is fully healthy. Spawn, retirement and join were all failing throughout.
 *
 * THE FIXTURE IS A REAL LEASE, NOT A FAKED REPLY. A holder process acquires the shard-0 delivery
 * lease through core's own `acquireDeliveryLease` against a real JetStream broker, and in the
 * `ready` leg also calls `markDeliveryLeaseReady` — the same two calls, in the same order, that the
 * daemon makes around `startPlane3`. So the difference between the legs is exactly the difference
 * this fix is about: the single-flight slot is claimed in both, the responder is bound in one.
 *
 * THREE CELLS, EACH OF WHICH REDS WITHOUT THE FIX:
 *   CELL 1  bare `cotal status` NAMES the unbound responder and its consequence.
 *           Before: the row read `delivery  running (pid N)` with nothing else.
 *   CELL 2  bare `cotal status` DISTINGUISHES unbound from bound.
 *           Before: the two rows were character-identical apart from the pid, which is the whole
 *           defect — and a cell that only asserted cell 1 would pass on a build that printed the
 *           warning unconditionally, so the bound leg is the REFUSE CONTROL for it.
 *   CELL 3  `--components` keeps its own verdict and names the consequence in its facts.
 *
 * Run: pnpm smoke:delivery-responder-visibility
 */
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { emitSentinel, killAndAwaitExit, teardownOnSignal } from "@cotal-ai/smoke-kit";
import { deliveryResponderFromLease, deliveryResponderState, deliveryRowSuffix } from "../src/lib/delivery-responder.js";

const WT = resolve(import.meta.dirname, "..", "..", "..");
const CLI = join(WT, "bin", "cotal.ts");
const TSX = join(WT, "node_modules", ".bin", "tsx");
const HOLDER = join(import.meta.dirname, "delivery-responder-holder.mjs");
const SPACE = "responder-visibility";
const root = mkdtempSync(join(tmpdir(), "cotal-responder-root-"));
const home = mkdtempSync(join(tmpdir(), "cotal-responder-home-"));
mkdirSync(join(root, ".cotal"), { recursive: true });

let pass = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  assert.ok(cond, `${name}${extra === undefined ? "" : ` — ${JSON.stringify(extra)}`}`);
  pass++;
  console.log(`  ✓ ${name}`);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

const env = { ...process.env };
for (const k of Object.keys(env)) if (k.startsWith("COTAL_")) delete env[k];
env.COTAL_HOME = home;
env.XDG_CONFIG_HOME = join(home, "xdg");
env.COTAL_SKIP_CONNECTOR_SEED = "1";

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
function cli(...args: string[]): { status: number | null; text: string } {
  const r = spawnSync(TSX, [CLI, ...args], { cwd: root, env, encoding: "utf8", timeout: 60_000 });
  return { status: r.status, text: strip(`${r.stdout ?? ""}${r.stderr ?? ""}`) };
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
/** The bare-status delivery row, pid-normalized: the CLAIM the row makes, not its instance values. */
function deliveryRow(text: string): string | undefined {
  return text.split("\n").map((l) => strip(l).trimEnd()).find((l) => /^\s{2}delivery\s/.test(l))?.trim().replace(/\(pid \d+\)/, "(pid N)");
}
function componentRow(text: string): string | undefined {
  return text.split("\n").map((l) => l.trim()).find((l) => /^delivery\s+(serving|not-serving|absent|refused|stopped)/.test(l));
}
async function startHolder(mode: "claim" | "ready", server: string): Promise<ChildProcess> {
  const child = spawn(process.execPath, [HOLDER, server, SPACE, mode], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
  // OWN every holder. `startHolder` is called more than once and the previous holder is stopped on
  // the normal path, so no release handle is threaded back: an entry for an already-dead child is
  // inert (`killOwnedChild` swallows the kill) and owns no path, while an UNOWNED holder outlives a
  // signalled suite. Erring toward an extra dead entry is the cheap direction.
  teardownOnSignal(child);
  child.stderr?.on("data", (c) => process.stderr.write(`holder(${mode}): ${c}`));
  await new Promise<void>((res, rej) => {
    const t = setTimeout(() => rej(new Error(`holder(${mode}) never reported its pid`)), 20_000);
    child.stdout?.once("data", () => { clearTimeout(t); res(); });
  });
  assert.ok(child.pid, "holder received a pid");
  writeFileSync(join(root, ".cotal", "delivery.pid"), String(child.pid));
  return child;
}

const port = await freePort();
const server = `nats://127.0.0.1:${port}`;
let broker: ChildProcess | undefined, holder: ChildProcess | undefined;
let releaseBroker: () => void = () => {};
try {
  broker = spawn("nats-server", ["-a", "127.0.0.1", "-p", String(port), "-js", "-sd", join(root, "jetstream")], { stdio: "ignore" });
  // OWN the broker, do not just unwind it. The `finally` below is correct on the normal path and is
  // exactly what does NOT run when this process is SIGNALLED — defect 2 in `broker-teardown.ts` —
  // leaving a reparented nats-server holding a port and a JetStream store. `root` is the owned path
  // because the store dir is `root/jetstream`, so the signal path removes the tree the normal one does.
  releaseBroker = teardownOnSignal(broker, root);
  for (let i = 0; i < 120 && !(await portOpen(port)); i++) await sleep(50);
  check("fixture broker started", await portOpen(port));
  const add = cli("meshes", "add", SPACE, "--server", server, "--root", root, "--mode", "open");
  check("fixture mesh registered", add.status === 0, add.text);

  // ---------- the reported state: lease claimed, responder NOT bound ----------
  holder = await startHolder("claim", server);
  const unboundBare = cli("status", "--space", SPACE, "--server", server);
  const unboundRow = deliveryRow(unboundBare.text);
  check("CELL 1: bare `status` names the UNBOUND responder on the delivery row",
    /RESPONDER NOT BOUND/.test(unboundRow ?? ""), unboundRow);
  check("CELL 1: it names the CONSEQUENCE rather than only the state",
    /no spawn, no retirement, no join until it binds/.test(unboundRow ?? ""), unboundRow);
  check("CELL 1: the mesh section states it too, with the command that starts it",
    /delivery responder\s+NOT BOUND/.test(strip(unboundBare.text)) && /cotal deliver --space|cotal up/.test(strip(unboundBare.text)),
    strip(unboundBare.text).split("\n").filter((l) => /responder/i.test(l)));
  // Bare status stays a recovery-oriented, zero-exit diagnostic: naming the axis must not turn it
  // into a monitor. `--components` owns the exit disposition.
  check("CELL 1: bare status still exits 0 (it reports, it does not gate)", unboundBare.status === 0, unboundBare.status);

  const unboundComponents = cli("status", "--components", "--space", SPACE, "--server", server);
  const unboundComponentRow = componentRow(unboundComponents.text);
  check("CELL 3: --components says not-serving and names the consequence in its facts",
    /^delivery\s+not-serving/.test(unboundComponentRow ?? "") &&
      (unboundComponentRow ?? "").includes("starting (lease not ready)") &&
      (unboundComponentRow ?? "").includes("no spawn, no retirement, no join until it binds"),
    unboundComponentRow);
  check("CELL 3: --components keeps its present-but-not-serving exit (2)", unboundComponents.status === 2, unboundComponents.text);

  // ---------- REFUSE CONTROL: the same fixture, responder BOUND ----------
  await stop(holder);
  holder = undefined;
  rmSync(join(root, ".cotal", "delivery.pid"), { force: true });
  // The lease bucket has a 10s TTL; a fresh holder must CAS-create, so wait for the claim to expire
  // rather than racing it. Without this wait the `ready` leg would silently measure the old record.
  await sleep(11_000);
  holder = await startHolder("ready", server);

  const boundBare = cli("status", "--space", SPACE, "--server", server);
  const boundRow = deliveryRow(boundBare.text);
  check("REFUSE CONTROL: with the responder BOUND, bare status does NOT cry unbound",
    !/RESPONDER NOT BOUND/.test(boundRow ?? ""), boundRow);
  check("REFUSE CONTROL: it positively says the responder is bound",
    /responder bound/.test(boundRow ?? ""), boundRow);
  check("CELL 2: the two delivery rows DIFFER (this is the 22-hour defect)",
    boundRow !== unboundRow, { unboundRow, boundRow });

  const boundComponents = cli("status", "--components", "--space", SPACE, "--server", server);
  const boundComponentRow = componentRow(boundComponents.text);
  check("REFUSE CONTROL: --components reads serving on a bound responder",
    /^delivery\s+serving/.test(boundComponentRow ?? "") && !(boundComponentRow ?? "").includes("no spawn, no retirement"),
    boundComponentRow);

  // ---------- CELL 4: a LIVE delivery pid with NO lease at all ----------
  // The daemon creates its lease BEFORE it binds, so "a live process and no lease" means nothing has
  // even claimed the slot — an unbound responder, not an unknown state. A first version of this smoke
  // did not cover it, and a mutant that returned `bound` for an absent lease survived: the fleet-wide
  // silent case would have come back through the one branch no cell was reading.
  await stop(holder);
  holder = undefined;
  await sleep(11_000); // let the ready lease TTL out so the bucket genuinely has no record
  const bystander = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  teardownOnSignal(bystander);
  assert.ok(bystander.pid, "bystander fixture received a pid");
  writeFileSync(join(root, ".cotal", "delivery.pid"), String(bystander.pid));
  try {
    const noLease = cli("status", "--space", SPACE, "--server", server);
    const noLeaseRow = deliveryRow(noLease.text);
    check("CELL 4: a live delivery pid with NO lease reads as an unbound responder, not as running",
      /RESPONDER NOT BOUND/.test(noLeaseRow ?? ""), noLeaseRow);
    const noLeaseComponents = cli("status", "--components", "--space", SPACE, "--server", server);
    check("CELL 4: --components calls the same state not-serving with the lease named absent",
      /^delivery\s+not-serving/.test(componentRow(noLeaseComponents.text) ?? "") &&
        (componentRow(noLeaseComponents.text) ?? "").includes("ready lease absent"),
      componentRow(noLeaseComponents.text));
  } finally {
    try { bystander.kill("SIGTERM"); } catch { /* already gone */ }
    rmSync(join(root, ".cotal", "delivery.pid"), { force: true });
  }

  // ---------- CELL 5: the READER ITSELF, unit-level ----------
  // `deliveryResponderFromLease` is the one classifier both surfaces reduce through, so its three
  // inputs are pinned directly rather than only through rendered output. This is what kills a mutant
  // that changes the classifier in a direction the CLI legs above happen not to exercise.
  check("CELL 5: a ready lease classifies as bound",
    deliveryResponderFromLease({ holder: "local.x", since: Date.now(), ready: true }) === "bound");
  check("CELL 5: a claimed-but-not-ready lease classifies as UNBOUND (the 22-hour state)",
    deliveryResponderFromLease({ holder: "local.x", since: Date.now(), ready: false }) === "unbound");
  check("CELL 5: an ABSENT lease classifies as unbound, never bound",
    deliveryResponderFromLease(undefined) === "unbound");
  // A FAILED read is `unknown` and must never collapse to either health state: reporting a denied or
  // timed-out probe as healthy is the original defect wearing a different hat.
  check("CELL 5: a THROWING lease read is `unknown`, not bound and not unbound",
    (await deliveryResponderState(async () => { throw new Error("denied"); })) === "unknown");
  check("CELL 5: a successful read still classifies normally through the async reader",
    (await deliveryResponderState(async () => ({ holder: "local.x", since: Date.now(), ready: false }))) === "unbound");

  // ---------- CELL 6: THE STALE-READY PATH (#837 inside #1576) ----------
  // THIS CELL EXISTS BECAUSE THE FIRST VERSION OF THIS FIX WAS WRONG AND NO CELL SAID SO. Asking
  // "what path does no cell walk" found it: every leg above holds the HOLDER fixed and varies
  // `ready`, so nothing graded a ready record belonging to a daemon that is GONE. Measured against a
  // real broker, a SIGKILLed holder's `ready:true` record survives in the bucket for the rest of the
  // TTL, and bare status printed `responder bound` over it — the reported incident, reintroduced by
  // the fix for the reported incident. Core already knew (`waitForDeliveryLease` demands a holder,
  // #837); this classifier did not ask.
  //
  // The realistic trigger is a RESTART, not a kill: daemon A dies, `cotal up` starts B, and until the
  // TTL expires A's record sits in front of B's live pid.
  const nowLease = (holderId: string) => ({ holder: holderId, since: Date.now(), ready: true });
  check("CELL 6: a ready lease held by ANOTHER daemon is STALE, not bound",
    deliveryResponderFromLease(nowLease("local.deadDaemon"), "local.liveDaemon") === "stale");
  check("CELL 6: a ready lease held by the EXPECTED daemon is still bound (no false staleness)",
    deliveryResponderFromLease(nowLease("local.liveDaemon"), "local.liveDaemon") === "bound");
  // The concession is deliberate and must stay: an ADOPTED daemon's id is genuinely unknowable from
  // here, and refusing to answer would be worse than the pre-fix behaviour rather than better.
  check("CELL 6: with no expected holder known, a ready lease is bound (the adopted-daemon concession)",
    deliveryResponderFromLease(nowLease("local.someDaemon"), undefined) === "bound");
  check("CELL 6: staleness never overrides NOT-READY - an unready lease is unbound whoever holds it",
    deliveryResponderFromLease({ holder: "local.other", since: Date.now(), ready: false }, "local.mine") === "unbound");
  check("CELL 6: the async reader threads the expected holder through too",
    (await deliveryResponderState(async () => nowLease("local.dead"), "local.live")) === "stale");
  // The row must SAY the record belongs to a dead daemon: "not bound" alone sends an operator looking
  // for a daemon that is starting, when the actual next move is to let the corpse's lease expire.
  const staleSuffix = deliveryRowSuffix(true, "stale", "cotal status --components");
  check("CELL 6: the stale row names both NOT BOUND and the dead holder's record",
    /RESPONDER NOT BOUND/.test(staleSuffix) && /DEAD daemon/.test(staleSuffix), staleSuffix);
  check("CELL 6: the stale row still names the consequence",
    staleSuffix.includes("no spawn, no retirement, no join until it binds"), staleSuffix);

  console.log(`\nDELIVERY RESPONDER VISIBILITY SMOKE OK ✅ (${pass} checks)`);
  // Canonical sentinel, not just the banner: the shard runner refuses a suite that exits 0 having
  // run zero cells, and the legacy banner parsers are a compatibility shim for suites that predate
  // the contract. A new suite states its own count in the form the runner reads first.
  emitSentinel({ passed: pass, failed: 0 });
} finally {
  // Tear down, THEN release: the helper keeps owning each child until it is actually gone, so a
  // signal arriving mid-teardown still reaps. `killAndAwaitExit` returns only after exit, which is
  // what keeps the `rmSync` below from racing a broker still flushing JetStream state.
  if (holder) await killAndAwaitExit(holder);
  if (broker) await killAndAwaitExit(broker);
  releaseBroker();
  rmSync(root, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
}