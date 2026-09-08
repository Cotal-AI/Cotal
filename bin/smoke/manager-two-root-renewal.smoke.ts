/**
 * The #773 two-root renewal refusal, reproduced through the SHIPPED renewal owner - a REAL
 * `Manager` (its initial class-2 renewal pass in `start()`), a REAL delivery daemon
 * (`tsx bin/cotal.ts deliver`), a REAL authed broker. No live stack, no shared state.
 *
 * THE DEFECT (#773, UNFIXED): the manager re-signs the daemon creds through ITS OWN store (the FS
 * store over its `workspaceRoot`), then hands the daemon per-component expected fingerprints over
 * the delivery-admin rail - but the daemon re-reads its OWN store (resolved from its own root). In
 * a composition where the two roots differ (cross-host stock deployment), the manager writes
 * filesystem A, the daemon re-reads filesystem B, and EVERY adoption is refused with the exact
 * generation-mismatch error. Nothing refuses the divergent composition at startup.
 *
 * The "#773 unfixed:" cells below ENCODE THAT DEFECTIVE BEHAVIOR AS THE EXPECTATION, explicitly
 * labeled: they are green on today's tree and go red when #773 is fixed (either startup refuses
 * the divergence loudly, or adoption succeeds through one shared authority) - the fix PR must
 * flip them to the fixed expectations.
 *
 * Both roots are load-bearing, and the refusal is produced end to end by shipped code only:
 *   - root A is the Manager's actual `workspaceRoot`: `remintDaemonCreds` reads the space signer
 *     from A's store and writes the re-signs into A (asserted: A's bytes CHANGE);
 *   - root B is the daemon's actual read path: its `--creds` source and its membership feed's
 *     store both resolve B (asserted: B's bytes DO NOT change, yet the refusal names them).
 * The suite never hand-sends a fingerprint; `Manager.start()` drives the whole pass.
 *
 * The CONTROL phase runs the IDENTICAL path over a UNIFIED root (manager and daemon share one
 * root, the stock single-host composition): adoption succeeds, proving the phase-1 refusal is
 * caused by the divergence and not by the rig. Each phase gets its own space AND its own broker:
 * the per-space artifact store reserves 4 GiB of JetStream capacity, so two spaces on one broker
 * overrun a small CI disk - and a virgin broker per phase also rules out cross-phase carryover.
 *
 * COTAL_HOME is sandboxed and ambient COTAL_* is scrubbed; kills ONLY the PIDs it spawns.
 * Run: pnpm smoke:manager-two-root-renewal   (needs `nats-server` on PATH; auth mode; ~60s)
 */
import { spawn as spawnProc, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
const TSX = join(import.meta.dirname, "..", "..", "node_modules", ".bin", "tsx");

// Sandbox BEFORE any cotal import: whatever runs this suite may itself be a managed seat, and its
// COTAL_* environment names a LIVE mesh. The in-process Manager and every child must see only the
// rig this suite builds. (Child env is additionally scrubbed via `cleanEnv` below, the tree-wide
// `smoke:suite-ambient-env` convention.)
const home = mkdtempSync(join(tmpdir(), "cotal-773-home-"));
for (const k of Object.keys(process.env)) if (k.startsWith("COTAL_")) delete process.env[k];
process.env.COTAL_HOME = home;

const { SMOKE_BROKER_TOKEN, killAndAwaitExit, teardownOnSignal } = await import("@cotal-ai/smoke-kit");
const {
  createSpaceAuth,
  mintConnectionEvictorCreds,
  mintCreds,
  mintMembershipObserverCreds,
  newIdentity,
  probeConnect,
  serverConfig,
  setupSpaceStreams,
} = await import("@cotal-ai/core");
const { DELIVERY_CREDS_KIND, MEMBERSHIP_RW_CREDS_KIND, authDir, readRenewalRecord, saveSpaceAuth, spaceSegment } = await import("@cotal-ai/workspace");
const { Manager } = await import("@cotal-ai/manager");
type SpaceAuth = Awaited<ReturnType<typeof createSpaceAuth>>;

const freePort = (): Promise<number> =>
  new Promise((res, rej) => {
    const s = createServer();
    s.on("error", rej);
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as AddressInfo).port;
      s.close(() => res(p));
    });
  });
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (cond: () => boolean, timeoutMs: number, stepMs = 200): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  while (!cond() && Date.now() < deadline) await wait(stepMs);
  return cond();
};

let pass = 0;
let fail = 0;
/** A graded cell: RECORDS rather than throws, so every cell runs and the banner always prints. */
const ok = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); return; }
  fail++;
  console.log(`  ✗ FAIL: ${name}${extra !== undefined ? ` - ${JSON.stringify(extra)}` : ""}`);
};
/** A cell about the RIG: throws, because everything after it measures the wrong thing once false. */
const must = (name: string, cond: boolean, extra?: unknown) => {
  if (!cond) throw new Error(`FAIL (rig): ${name}${extra !== undefined ? ` - ${JSON.stringify(extra)}` : ""}`);
  pass++;
  console.log(`  ✓ ${name}`);
};
/** Every cell above is enumerated: a run that silently skipped cells must not read as green. */
const EXPECTED_CELLS = 21;

const cleanEnv: NodeJS.ProcessEnv = { ...process.env };
for (const k of Object.keys(cleanEnv)) if (k.startsWith("COTAL_")) delete cleanEnv[k];

const BIN = join(import.meta.dirname, "..", "cotal.ts");
const rand = Math.random().toString(36).slice(2, 8);
const SPACE_DIVERGED = `dlv773a-${rand}`;
const SPACE_UNIFIED = `dlv773c-${rand}`;

/** One throwaway authed broker for one phase: its own operator chain, port, and store dir. */
const startBroker = (auth: SpaceAuth, port: number): { srv: ChildProcess; dir: string; release: () => void } => {
  const dir = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
  writeFileSync(join(dir, "server.conf"), serverConfig(auth, [auth], { transport: { kind: "plaintext" }, port, storeDir: join(dir, "js") }));
  const srv = spawnProc("nats-server", ["-c", join(dir, "server.conf")], { stdio: "ignore" });
  return { srv, dir, release: teardownOnSignal(srv, dir) };
};
const brokerServing = async (servers: string): Promise<boolean> => {
  for (let i = 0; i < 80; i++) {
    const p = await probeConnect(servers, { timeoutMs: 400 });
    if (p.ok || p.reason === "auth-required") return true;
    await wait(100);
  }
  return false;
};

/** Stage a root's `.cotal` with daemon material at its CANONICAL per-space segmented location
 *  (`.cotal/space.<hex>/<kind>`), the layout the renewal owner addresses directly. */
const stageDaemonRoot = (root: string, space: string, files: Record<string, string>): string => {
  const seg = join(root, ".cotal", spaceSegment(space));
  mkdirSync(seg, { recursive: true });
  for (const [kind, bytes] of Object.entries(files)) writeFileSync(join(seg, kind), bytes, { mode: 0o600 });
  return seg;
};

/** Spawn the REAL delivery daemon rooted at `root` (its cwd - the store its re-reads resolve). */
const spawnDaemon = (root: string, space: string, servers: string, credsPath: string, sink: { out: string; exited: boolean }): ChildProcess => {
  const d = spawnProc(TSX, [BIN, "deliver", "--space", space, "--server", servers, "--creds", credsPath], {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
    // Direct daemon run (not via `up`): the first-real-command connector seed would run installs
    // and delay readiness; the daemon needs no connectors, so opt out.
    env: { ...cleanEnv, COTAL_HOME: home, XDG_CONFIG_HOME: join(home, "xdg"), COTAL_SKIP_CONNECTOR_SEED: "1" },
  });
  d.stdout!.on("data", (b: Buffer) => { sink.out += b.toString(); });
  d.stderr!.on("data", (b: Buffer) => { sink.out += b.toString(); });
  d.on("exit", () => { sink.exited = true; });
  return d;
};

const rootA = mkdtempSync(join(tmpdir(), "cotal-773-mgr-root-")); // the manager's workspace root
const rootB = mkdtempSync(join(tmpdir(), "cotal-773-daemon-root-")); // the daemon's DIVERGENT root
const rootC = mkdtempSync(join(tmpdir(), "cotal-773-unified-root-")); // control: one shared root

let daemonB: ChildProcess | undefined;
let daemonC: ChildProcess | undefined;
const sinkB = { out: "", exited: false };
const sinkC = { out: "", exited: false };
let mgrA: InstanceType<typeof Manager> | undefined;
let mgrC: InstanceType<typeof Manager> | undefined;
let broker1: ReturnType<typeof startBroker> | undefined;
let broker2: ReturnType<typeof startBroker> | undefined;
try {
  // ---- phase 1 (#773): manager rooted at A, daemon rooted at B - SAME space, DIVERGENT stores --
  const auth1 = await createSpaceAuth(SPACE_DIVERGED);
  const obs1 = await mintMembershipObserverCreds(auth1, newIdentity()); // while the $SYS seed is in memory
  const evict1 = await mintConnectionEvictorCreds(auth1, newIdentity());
  const port1 = await freePort();
  const servers1 = `nats://127.0.0.1:${port1}`;
  broker1 = startBroker(auth1, port1);
  must("the divergent phase's authed broker is serving", await brokerServing(servers1), { server: servers1 });
  await setupSpaceStreams({ servers: servers1, space: SPACE_DIVERGED, creds: await mintCreds(auth1, newIdentity(), "provisioner") });

  // One generation of daemon creds, staged BYTE-IDENTICAL into both roots (the cross-host stock
  // deployment: each host holds its own copy of the same material until the first renewal pass).
  const dlvId1 = newIdentity();
  const rwId1 = newIdentity();
  const dlvGen1 = await mintCreds(auth1, dlvId1, "delivery");
  const rwGen1 = await mintCreds(auth1, rwId1, "membership-rw");
  saveSpaceAuth(authDir(rootA), auth1); // the manager's signer lives in ITS root's store
  const segA = stageDaemonRoot(rootA, SPACE_DIVERGED, { [DELIVERY_CREDS_KIND]: dlvGen1, [MEMBERSHIP_RW_CREDS_KIND]: rwGen1 });
  const segB = stageDaemonRoot(rootB, SPACE_DIVERGED, {
    [DELIVERY_CREDS_KIND]: dlvGen1,
    [MEMBERSHIP_RW_CREDS_KIND]: rwGen1,
    "membership-observer.creds": obs1,
    "connection-evictor.creds": evict1,
    "membership.json": JSON.stringify({ accountId: auth1.account.pub }),
  });

  daemonB = spawnDaemon(rootB, SPACE_DIVERGED, servers1, join(segB, DELIVERY_CREDS_KIND), sinkB);
  must("daemon B boots from its own root", await until(() => sinkB.out.includes("delivery daemon up"), 60_000), sinkB.out.slice(-500));
  must("daemon B's membership feed is up (the membership component is a real adopter here)", await until(() => sinkB.out.includes("membership feed up"), 15_000), sinkB.out.slice(-500));

  // The renewal owner is the REAL Manager: `start()` runs the initial class-2 renewal pass inline
  // (re-sign through ITS store, request `reloadCreds {expected}`, persist `renewal.json`).
  mgrA = new Manager({ space: SPACE_DIVERGED, servers: servers1, runtime: "pty", workspaceRoot: rootA });
  let startRefusal: string | undefined;
  try {
    await mgrA.start();
  } catch (e) {
    startRefusal = (e as Error).message;
  }
  ok(
    "#773 unfixed: the divergent manager-store/daemon-store composition starts WITHOUT any refusal naming the two roots",
    startRefusal === undefined,
    { startRefusal },
  );

  const rec = readRenewalRecord(rootA);
  ok(
    "#773 unfixed: the manager's pass re-signed BOTH daemon creds in ITS OWN root's store",
    rec !== undefined && rec.owner === "manager" &&
      rec.results.some((r) => r.file === DELIVERY_CREDS_KIND && r.ok) &&
      rec.results.some((r) => r.file === MEMBERSHIP_RW_CREDS_KIND && r.ok),
    rec?.results,
  );
  ok("#773 unfixed: the daemon's adoption of that pass is REFUSED (renewal.json records adoption.ok:false)", rec?.adoption?.ok === false, rec?.adoption);
  const detail = (rec?.adoption?.detail ?? {}) as { delivery?: { ok?: boolean; error?: string }; membership?: { ok?: boolean; error?: string } };
  ok(
    "#773 unfixed: the DELIVERY component refusal is the exact generation mismatch (manager wrote A, daemon re-read B)",
    detail.delivery?.ok === false && /did not match the expected re-signed generation/.test(detail.delivery?.error ?? ""),
    detail.delivery,
  );
  ok(
    "#773 unfixed: the MEMBERSHIP component refusal is the same generation mismatch (both components are refused, not just delivery)",
    detail.membership?.ok === false && /did not match the expected re-signed generation/.test(detail.membership?.error ?? ""),
    detail.membership,
  );
  // The physical divergence, asserted on the FILES so neither root can be scenery: the manager's
  // write landed in A (A's bytes changed) and never reached the root the daemon reads (B's bytes
  // are the untouched original generation the refusal is about).
  ok("#773 unfixed: root A's delivery cred now holds the NEW generation (the manager re-signed its own store)", readFileSync(join(segA, DELIVERY_CREDS_KIND), "utf8") !== dlvGen1);
  ok("#773 unfixed: root B's delivery cred still holds the OLD generation (the daemon's store was never written)", readFileSync(join(segB, DELIVERY_CREDS_KIND), "utf8") === dlvGen1);
  ok("#773 unfixed: root B's membership rw cred still holds the OLD generation", readFileSync(join(segB, MEMBERSHIP_RW_CREDS_KIND), "utf8") === rwGen1);
  ok("daemon B outlives the refused pass (refusal is a structured reply, not a daemon death)", !sinkB.exited);

  await mgrA.stop();
  mgrA = undefined;
  if (daemonB && !sinkB.exited) daemonB.kill("SIGKILL");
  await killAndAwaitExit(broker1.srv, "SIGKILL");

  // ---- control: the IDENTICAL shipped path over ONE shared root adopts cleanly ------------------
  // Same code, fresh single-space rig; the only structural difference is the composition (manager
  // and daemon share root C). This pins the phase-1 refusal on the divergence, not on the harness.
  const auth2 = await createSpaceAuth(SPACE_UNIFIED);
  const obs2 = await mintMembershipObserverCreds(auth2, newIdentity());
  const evict2 = await mintConnectionEvictorCreds(auth2, newIdentity());
  const port2 = await freePort();
  const servers2 = `nats://127.0.0.1:${port2}`;
  broker2 = startBroker(auth2, port2);
  must("the control phase's fresh broker is serving", await brokerServing(servers2), { server: servers2 });
  await setupSpaceStreams({ servers: servers2, space: SPACE_UNIFIED, creds: await mintCreds(auth2, newIdentity(), "provisioner") });

  const dlvId2 = newIdentity();
  const rwId2 = newIdentity();
  const dlvGen2 = await mintCreds(auth2, dlvId2, "delivery");
  const rwGen2 = await mintCreds(auth2, rwId2, "membership-rw");
  saveSpaceAuth(authDir(rootC), auth2);
  const segC = stageDaemonRoot(rootC, SPACE_UNIFIED, {
    [DELIVERY_CREDS_KIND]: dlvGen2,
    [MEMBERSHIP_RW_CREDS_KIND]: rwGen2,
    "membership-observer.creds": obs2,
    "connection-evictor.creds": evict2,
    "membership.json": JSON.stringify({ accountId: auth2.account.pub }),
  });

  daemonC = spawnDaemon(rootC, SPACE_UNIFIED, servers2, join(segC, DELIVERY_CREDS_KIND), sinkC);
  must("daemon C boots from the shared root", await until(() => sinkC.out.includes("delivery daemon up"), 60_000), sinkC.out.slice(-500));
  must("daemon C's membership feed is up", await until(() => sinkC.out.includes("membership feed up"), 15_000), sinkC.out.slice(-500));

  mgrC = new Manager({ space: SPACE_UNIFIED, servers: servers2, runtime: "pty", workspaceRoot: rootC });
  await mgrC.start();

  const recC = readRenewalRecord(rootC);
  ok("control: the SAME Manager renewal path over a UNIFIED root ADOPTS (adoption.ok:true)", recC?.adoption?.ok === true, recC?.adoption);
  const detailC = (recC?.adoption?.detail ?? {}) as {
    delivery?: { ok?: boolean; brokerAccepted?: { identity?: string } };
    membership?: { ok?: boolean; brokerAccepted?: { identity?: string } };
  };
  ok("control: the delivery adoption is broker-accepted and pinned to the daemon's own nkey", detailC.delivery?.ok === true && detailC.delivery?.brokerAccepted?.identity === dlvId2.id, detailC.delivery);
  ok("control: the membership adoption is broker-accepted and pinned to its own nkey", detailC.membership?.ok === true && detailC.membership?.brokerAccepted?.identity === rwId2.id, detailC.membership);
  ok("control: the shared root's delivery cred holds the re-signed generation both sides now agree on", readFileSync(join(segC, DELIVERY_CREDS_KIND), "utf8") !== dlvGen2);
  ok("daemon C outlives the adopted pass", !sinkC.exited);

  ok("every cell ran (silently skipped cells must not read as green)", pass + fail === EXPECTED_CELLS - 1);

  console.log(`\nMANAGER-TWO-ROOT-RENEWAL SMOKE ${fail === 0 ? "OK ✅" : "FAILED ❌"}  (${pass} passed, ${fail} failed)`);
  if (fail) process.exitCode = 1;
} catch (e) {
  fail++;
  console.error("  ✗ scenario threw:", (e as Error).message);
  console.error("  -- daemon B tail:\n", sinkB.out.slice(-1500));
  console.error("  -- daemon C tail:\n", sinkC.out.slice(-1500));
  process.exitCode = 1;
} finally {
  try { await mgrA?.stop(); } catch { /* already stopped or never started */ }
  try { await mgrC?.stop(); } catch { /* already stopped or never started */ }
  try { if (daemonB && !sinkB.exited) daemonB.kill("SIGKILL"); } catch { /* gone */ }
  try { if (daemonC && !sinkC.exited) daemonC.kill("SIGKILL"); } catch { /* gone */ }
  if (broker1) await killAndAwaitExit(broker1.srv, "SIGKILL");
  if (broker2) await killAndAwaitExit(broker2.srv, "SIGKILL");
  for (const d of [broker1?.dir, broker2?.dir, rootA, rootB, rootC, home]) if (d) rmSync(d, { recursive: true, force: true });
  broker1?.release();
  broker2?.release();
}
