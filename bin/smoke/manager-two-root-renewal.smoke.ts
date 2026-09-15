/**
 * Many managers per space, on the same device or different ones, exercised through the SHIPPED
 * renewal owner - a REAL `Manager` (its initial class-2 renewal pass in `start()`), a REAL delivery
 * daemon (`tsx bin/cotal.ts deliver`), a REAL authed broker. No live stack, no shared state.
 *
 * #773 was a manager writing a re-signed generation into ITS filesystem and fingerprinting a daemon
 * that reloads from ANOTHER, so every adoption was refused and the credential expired. The first
 * fix refused the two-root composition at manager construction, which made a second manager on a
 * second machine (or a second root on one machine) impossible. That is a regression against the
 * product requirement, ruled 2026-09-15: a space has many managers on any device.
 *
 * THE FIX: the manager CLASSIFIES the daemon's reload store instead of refusing it. A manager whose
 * store is the daemon's is the renewal owner and remints. A manager whose store is foreign STARTS,
 * serves seats, never remints daemon creds (a write the daemon could not read), and records that
 * renewal is owned elsewhere. Fingerprint-only `reloadCreds` stays for the owner.
 *
 * Both roots are load-bearing and every outcome is produced end to end by shipped code:
 *   - root A is the foreign Manager's actual `workspaceRoot`;
 *   - root B is the daemon's actual read path (its `--creds` source and membership feed store).
 * The suite never hand-sends a fingerprint; `Manager.start()` drives the whole pass. Phase 1 must
 * START, must NOT remint (A's and B's bytes stay the original generation), and must record the
 * owner-elsewhere note naming both stores.
 *
 * The CONTROL phase runs the IDENTICAL path over a UNIFIED root (manager and daemon share one
 * root, the stock single-host composition): adoption succeeds, proving phase 1's silence is the
 * classification and not a broken rig. Each phase gets its own space AND its own broker: the
 * per-space artifact store reserves 4 GiB of JetStream capacity, so two spaces on one broker
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
  CONTROL_DELIVERY_ADMIN,
  CotalEndpoint,
  controlServiceSubject,
  createSpaceAuth,
  credsFingerprint,
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
/** An adoption schedules a resident wire swap, and the daemon's `nc.reconnect()` unbinds its
 *  delivery-admin responder for well under a second before `armDeliveryControl` re-binds it. A
 *  caller arriving inside that window sees a genuine NoResponders, which is a TRANSIENT RIG STATE
 *  and not the property under test — so the admin-rail probes retry across it. This retries only on
 *  a THROWN request error; a reply that arrives is returned as-is, refusal included, because a
 *  refusal is exactly what several cells below are measuring. */
const railRetry = async <T>(attempt: () => Promise<T>, tries = 20): Promise<T> => {
  let last: unknown;
  for (let i = 0; i < tries; i++) {
    try { return await attempt(); }
    catch (e) { last = e; await wait(300); }
  }
  throw last instanceof Error ? last : new Error(String(last));
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
const EXPECTED_CELLS = 42;

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
  ok("many managers: a manager rooted at A STARTS while the daemon reloads from B (no construction refusal)", startRefusal === undefined, { startRefusal, rootA, rootB });

  const rec = readRenewalRecord(rootA);
  ok("many managers: the foreign manager recorded that renewal is owned elsewhere", rec?.renewalOwner?.elsewhere === true, rec);
  ok("many managers: the record names the daemon's store", rec?.renewalOwner?.store === rootB, rec?.renewalOwner);
  ok("many managers: the note names both stores", rec?.renewalOwner?.note.includes(rootA) === true && rec?.renewalOwner?.note.includes(rootB) === true, rec?.renewalOwner?.note);
  ok("many managers: the foreign manager reminted nothing (empty results, no adoption request)", rec?.results.length === 0 && rec?.adoption === undefined, rec);
  ok("many managers: root A's delivery cred still holds the ORIGINAL generation (no remint into the foreign store)", readFileSync(join(segA, DELIVERY_CREDS_KIND), "utf8") === dlvGen1);
  ok("many managers: root B's delivery cred still holds the ORIGINAL generation (nothing pushed at the daemon)", readFileSync(join(segB, DELIVERY_CREDS_KIND), "utf8") === dlvGen1);
  ok("many managers: root B's membership rw cred still holds the ORIGINAL generation", readFileSync(join(segB, MEMBERSHIP_RW_CREDS_KIND), "utf8") === rwGen1);
  ok("daemon B outlives the foreign manager's start and pass", !sinkB.exited);

  // ---- (a) a foreign manager must not abandon its OWN credentials ------------------------------
  // The foreign classification establishes exactly one thing: the DAEMON's creds are renewed
  // elsewhere. It says nothing about the credentials this manager owns outright, which no other
  // process on any host renews. The defect was an early `return` above every one of those duties,
  // and a 24h class on a TTL/4 tick hides it for a full day — a green first day is what the bug
  // looks like. So drive the REAL renewal pass again and require that it reached them.
  //
  // Instrumented on `Manager.prototype` by DELEGATING wrappers: each duty still runs its shipped
  // body, the wrapper only records that the pass arrived. A stub would grade the wrapper.
  const M = mgrA as unknown as Record<string, (...a: unknown[]) => unknown>;
  const proto = Object.getPrototypeOf(M) as Record<string, (...a: unknown[]) => unknown>;
  const reached: string[] = [];
  const originals: Record<string, (...a: unknown[]) => unknown> = {};
  for (const duty of ["warnOnSystemCredExpiry", "classifyDaemonSecretStore"]) {
    originals[duty] = proto[duty];
    proto[duty] = function (this: unknown, ...a: unknown[]) { reached.push(duty); return originals[duty].apply(this, a); };
  }
  // The agent-cred READ is the observable proof that the managed-static renewal scan ran: the scan's
  // first act per slot is a store `get`. Count reads through the manager's own store seam.
  const secrets = (mgrA as unknown as { secrets: { get(k: string): Promise<string | undefined> } }).secrets;
  const originalGet = secrets.get.bind(secrets);
  let agentCredReads = 0;
  (secrets as { get: (k: string) => Promise<string | undefined> }).get = async (k: string) => { agentCredReads++; return originalGet(k); };
  // A LIVE managed slot, so the scan has something to walk. `seed` + `secretPaths.creds` are what
  // the shipped filter requires before it reads the slot's credential.
  const agents = (mgrA as unknown as { agents: Map<string, unknown> }).agents;
  agents.set("renewal-probe", { id: newIdentity().id, name: "renewal-probe", lifecycleUid: "l".repeat(26), seed: "SU", secretPaths: { creds: join(segA, "agent-renewal-probe.creds") } });

  const beforeForeignPass = reached.length;
  await (mgrA as unknown as { renewDaemonCreds(): Promise<void> }).renewDaemonCreds();
  const recForeign = readRenewalRecord(rootA);

  ok("(a) the foreign pass still classified the daemon's store (the pass really ran)", reached.slice(beforeForeignPass).includes("classifyDaemonSecretStore"), reached.slice(beforeForeignPass));
  ok("(a) a FOREIGN manager still reaches warnOnSystemCredExpiry (the $SYS expiry warning is its own duty, not the daemon's)", reached.slice(beforeForeignPass).includes("warnOnSystemCredExpiry"), reached.slice(beforeForeignPass));
  ok("(a) a FOREIGN manager still runs the managed-static renewal scan (it read a managed credential through its own store)", agentCredReads > 0, { agentCredReads });
  ok("(a) ...and it STILL reminted nothing into the foreign store (skipping only the daemon remint, not the own-credential duties)", recForeign?.results.length === 0 && recForeign?.renewalOwner?.elsewhere === true, recForeign);
  ok("(a) the foreign pass left root B's delivery cred at the ORIGINAL generation", readFileSync(join(segB, DELIVERY_CREDS_KIND), "utf8") === dlvGen1);

  agents.delete("renewal-probe");
  (secrets as { get: (k: string) => Promise<string | undefined> }).get = originalGet;

  // ---- (b) absence must be a DETERMINATION, never a text match ---------------------------------
  // Two separate dangers, measured against the same live rig.
  //
  // (b1) A peer that merely ECHOES the phrase. The rail decodes replies with JSON.parse, so a body
  // of `no responders` throws `Unexpected token 'o', "no responders" is not valid JSON` — which the
  // shipped `/no responders|\b503\b/i` predicate matched. A FAILURE TO PARSE was then rendered as a
  // DETERMINATION OF ABSENCE, and the absent branch remints: a peer able to put two words on the
  // rail could make this manager write creds the real daemon can never read.
  //
  // (b2) A second responder naming THIS manager's store. The rail is queue-grouped, so any bound
  // responder can answer; only the delivery LEASE HOLDER reloads the creds. An unbound answerer's
  // store must not certify this manager as the renewal owner.
  //
  // Both are driven through the SHIPPED classification path, with the honest daemon still live.
  const classify = () => (mgrA as unknown as { classifyDaemonSecretStore(): Promise<{ kind: string }> }).classifyDaemonSecretStore();

  // CONTROL FIRST, in this same file and this same run: with only the honest daemon bound, the
  // shipped path still reaches a real verdict. Without this, a refusal below proves only that
  // something is broken.
  let controlVerdict: string | undefined;
  let controlError: string | undefined;
  try { controlVerdict = (await classify()).kind; } catch (e) { controlError = (e as Error).message; }
  ok("(b) CONTROL: with only the lease-holding daemon bound, the shipped classification still returns a verdict", controlVerdict === "foreign", { controlVerdict, controlError });

  // A rogue endpoint on the SAME queue group as the daemon's admin rail. It holds a `delivery` cred,
  // which is what makes this the real danger rather than a hypothetical: the grant permits binding
  // the rail. It does NOT hold the delivery lease.
  const rogueId = newIdentity();
  const rogue = new CotalEndpoint({
    space: SPACE_DIVERGED, servers: servers1,
    creds: await mintCreds(auth1, rogueId, "delivery"),
    card: { id: rogueId.id, name: "rogue-responder", role: "delivery", kind: "endpoint" },
    channels: [], consume: false, registerPresence: false, watchPresence: false, watchChannels: false,
  });
  rogue.on("error", () => {});
  await rogue.start();

  // (b1) THE ECHO. Reply with a RAW body quoting the phrase, so the decode fails with the peer's own
  // words in the message — the exact input the text predicate could not distinguish from absence.
  const rogueNc = (rogue as unknown as { nc: { subscribe(s: string, o: { queue: string }): AsyncIterable<{ respond(p: string): void }> } }).nc;
  const echoSub = rogueNc.subscribe(controlServiceSubject(SPACE_DIVERGED, CONTROL_DELIVERY_ADMIN, "*", "*"), { queue: CONTROL_DELIVERY_ADMIN });
  void (async () => { for await (const m of echoSub) { try { m.respond("no responders"); } catch { /* raced */ } } })().catch(() => {});

  // The honest daemon is still bound, so the queue group hands the request to one of the two. Ask
  // until the echo answers at least once; a run where it never won is not evidence either way.
  let echoAbsent = 0, echoRefused = 0, echoOther = 0;
  const echoReasons: string[] = [];
  for (let i = 0; i < 12; i++) {
    try { const r = await classify(); if (r.kind === "absent") echoAbsent++; else echoOther++; }
    catch (e) { echoRefused++; if (echoReasons.length < 2) echoReasons.push((e as Error).message); }
  }
  ok("(b1) a peer body quoting \"no responders\" is NEVER classified as absence (a failure to parse is not a determination)", echoAbsent === 0, { echoAbsent, echoRefused, echoOther });
  // RIG VALIDITY, and deliberately counted so it does NOT depend on the verdict it is validating.
  // The honest daemon answers `foreign`; any other outcome means the echo won the queue that round.
  // Counting only refusals would make this cell red under a mutant that turns those refusals into
  // false absences, which would blame the rig for a real defect instead of naming the property.
  const rogueWins = echoAbsent + echoRefused;
  ok("(b1) ...and the rogue really did win the queue at least once, so the sweep measured something", rogueWins > 0, { rogueWins, echoAbsent, echoRefused, echoOther, echoReasons });
  ok("(b1) the refusal names the failure rather than asserting absence", echoReasons.every((m) => !/^no responders$/i.test(m)), echoReasons);

  // The absent branch is what a false absence would have reached. Nothing may have been written.
  ok("(b1) nothing was reminted into root A while the echo was on the rail", readFileSync(join(segA, DELIVERY_CREDS_KIND), "utf8") === dlvGen1);
  ok("(b1) nothing was pushed at the daemon's root B either", readFileSync(join(segB, DELIVERY_CREDS_KIND), "utf8") === dlvGen1);

  ok("daemon B is still alive after the echo sweep (the rig was live throughout)", !sinkB.exited);

  await mgrA.stop({ withAgents: true });
  mgrA = undefined;
  await rogue.stop().catch(() => {});

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

  // ---- (b2) the store answer must be bound to the DELIVERY LEASE HOLDER -------------------------
  // The rail is queue-grouped, so any process holding a `delivery` credential can bind it and
  // answer. Only ONE of them holds the lease and actually reloads the standing credentials. Here
  // the SHARED root is the dangerous direction: a second responder naming THIS manager's store
  // would classify the manager as `shared` and send it down the remint path on the word of a
  // process that reloads nothing.
  //
  // Control first: the honest lease-holding daemon alone still answers `shared` (asserted by the
  // adoption cells above, and re-measured here directly so this cell has its own positive control).
  const classifyC = () => (mgrC as unknown as { classifyDaemonSecretStore(): Promise<{ kind: string }> }).classifyDaemonSecretStore();
  // `classifyDaemonSecretStore` CATCHES the broker's no-responder signal and returns `absent`
  // rather than throwing, which is the correct shipped behaviour and precisely why `railRetry` is
  // the wrong instrument here: there is no throw to retry on. The control phase's adoption has just
  // scheduled daemon C's resident wire swap, so the rail is genuinely unbound for a moment and the
  // honest answer during that window IS `absent`. Wait for the responder to come back, then
  // measure. Measured: without this the control read `absent` and the cell failed on the rig.
  let sharedControl: string | undefined;
  for (let i = 0; i < 40; i++) {
    try { sharedControl = (await classifyC()).kind; } catch (e) { sharedControl = `threw: ${(e as Error).message}`; }
    if (sharedControl !== "absent") break;
    await wait(300);
  }
  ok("(b2) CONTROL: the lease-HOLDING daemon alone classifies this manager as the renewal owner", sharedControl === "shared", { sharedControl });

  // Now a second responder, holding a real `delivery` cred but NOT the lease, naming root C — this
  // manager's own store. Under the old first-reply-wins rule its answer is indistinguishable from
  // the daemon's, so it certifies the manager as the owner.
  const squatId = newIdentity();
  const squatter = new CotalEndpoint({
    space: SPACE_UNIFIED, servers: servers2,
    creds: await mintCreds(auth2, squatId, "delivery"),
    card: { id: squatId.id, name: "lease-less-responder", role: "delivery", kind: "endpoint" },
    channels: [], consume: false, registerPresence: false, watchPresence: false, watchChannels: false,
  });
  squatter.on("error", () => {});
  await squatter.start();
  // It serves the rail through the SHIPPED Plane-3 handler, naming root C as its reload store. What
  // it does NOT have is the delivery lease: daemon C holds that.
  await squatter.startPlane3(async () => undefined, { reloadStoreIdentity: () => ({ kind: "fs", root: rootC }) });

  let squatShared = 0, squatRefused = 0, squatOther = 0;
  const squatReasons: string[] = [];
  for (let i = 0; i < 12; i++) {
    try { const r = await classifyC(); if (r.kind === "shared") squatShared++; else squatOther++; }
    catch (e) { squatRefused++; if (squatReasons.length < 2) squatReasons.push((e as Error).message); }
  }
  ok("(b2) a lease-LESS responder naming this manager's store is refused at least once (the answer is bound to the process that reloads)", squatRefused > 0, { squatShared, squatRefused, squatOther, squatReasons });
  ok("(b2) the refusal says the answerer does not hold the delivery lease", squatReasons.some((m) => m.includes("does not hold this space's delivery lease")), squatReasons);
  await squatter.stop().catch(() => {});

  // ---- (c) a DIFFERENT generation under the SAME daemon identity must be REFUSED ----------------
  // The expected-generation guard is what makes `reloadCreds` prove the daemon adopted THIS
  // re-signed generation rather than merely re-reading some file. Its refusal had no cell, so
  // disabling the guard in the artifact the suite loads left the suite green.
  //
  // Same daemon identity throughout: the cred on disk is the one daemon C is running. Only the
  // GENERATION presented as `expected` diverges, which is the state a torn read or a second store
  // produces. The identity pin is a different guard and must not be what refuses here.
  const liveCredC = readFileSync(join(segC, DELIVERY_CREDS_KIND), "utf8");
  // A REAL second generation for the SAME nkey: signed by the same trusted signer, so nothing but
  // the generation differs. Never written to disk — it is only the expectation handed to the daemon.
  //
  // The wait is load-bearing, not padding: a JWT's `iat` is SECOND-GRANULAR, so a re-sign inside the
  // same second reproduces the previous generation byte for byte and the "divergent" arm would be
  // the CURRENT generation wearing a different name. Measured: without this the fingerprints were
  // equal and the guard correctly accepted, which would have read as a survived mutant.
  await wait(1100);
  const divergentGen = await mintCreds(auth2, dlvId2, "delivery");
  const divergentFingerprint = credsFingerprint(divergentGen);
  ok("(c) the rig really presents a DIFFERENT generation of the SAME identity (not a different nkey)", divergentFingerprint !== credsFingerprint(liveCredC), { same: divergentFingerprint === credsFingerprint(liveCredC) });

  const supId = newIdentity();
  const sup = new CotalEndpoint({
    space: SPACE_UNIFIED, servers: servers2,
    creds: await mintCreds(auth2, supId, "supervisor"),
    card: { id: supId.id, name: "renewal-owner", kind: "endpoint" },
    consume: false, watchChannels: false, watchPresence: false, registerPresence: false,
  });
  sup.on("error", () => {});
  await sup.start();
  try {
    // POSITIVE CONTROL, same file and same run: the CURRENT generation is accepted. Without it a
    // refusal below could just mean the rail is broken.
    const accepted = await railRetry(() => sup.requestDeliveryAdmin("reloadCreds", { expected: { delivery: credsFingerprint(liveCredC) } }, 20_000));
    ok("(c) CONTROL: the daemon ACCEPTS the generation that is actually on disk", accepted.ok === true, accepted);

    // THE GUARDED REFUSAL: same identity, divergent generation.
    const refused = await railRetry(() => sup.requestDeliveryAdmin("reloadCreds", { expected: { delivery: divergentFingerprint } }, 20_000));
    const detail = (refused.data ?? {}) as { delivery?: { ok?: boolean; error?: string } };
    ok("(c) a DIFFERENT generation under the SAME daemon identity is REFUSED (nothing adopted)", refused.ok === false && detail.delivery?.ok === false, refused);
    ok("(c) ...and the refusal is the GENERATION mismatch, not the identity pin or a timeout", detail.delivery?.error?.includes("did not match the expected re-signed generation") === true, detail.delivery?.error);
    ok("(c) the refusal leaks neither the observed nor the expected digest", detail.delivery?.error !== undefined && !detail.delivery.error.includes(divergentFingerprint), detail.delivery?.error);
  } finally {
    await sup.stop().catch(() => {});
  }
  ok("(c) daemon C survived the refused adoption (a refusal must not disturb the responder)", !sinkC.exited);

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
  try { await mgrA?.stop({ withAgents: true }); } catch { /* already stopped or never started */ }
  try { await mgrC?.stop({ withAgents: true }); } catch { /* already stopped or never started */ }
  try { if (daemonB && !sinkB.exited) daemonB.kill("SIGKILL"); } catch { /* gone */ }
  try { if (daemonC && !sinkC.exited) daemonC.kill("SIGKILL"); } catch { /* gone */ }
  if (broker1) await killAndAwaitExit(broker1.srv, "SIGKILL");
  if (broker2) await killAndAwaitExit(broker2.srv, "SIGKILL");
  for (const d of [broker1?.dir, broker2?.dir, rootA, rootB, rootC, home]) if (d) rmSync(d, { recursive: true, force: true });
  broker1?.release();
  broker2?.release();
}
