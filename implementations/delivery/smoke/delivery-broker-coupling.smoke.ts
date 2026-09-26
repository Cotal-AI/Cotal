/**
 * delivery broker-coupling smoke. The delivery daemon is part of the server: it should survive a brief
 * broker blip (the endpoint reconnects), but if the broker is truly GONE it must EXIT rather than loop
 * reconnect-attempts forever — so it never outlives the broker it serves. This spawns the real daemon
 * (`cotal deliver`) against a throwaway broker with a short broker-gone window, confirms it comes up,
 * kills the broker, and asserts the daemon process exits on its own.
 *
 * Run: pnpm smoke:delivery-broker-coupling   (needs `nats-server` on PATH; auth/JetStream, local-only)
 */
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CotalEndpoint, isReachable, createSpaceAuth, mintCreds, mintMembershipObserverCreds, serverConfig, newIdentity, setupSpaceStreams, idFromCreds, controlServiceSubject, CONTROL_DELIVERY, DEV_OWNER, provisionAgent, mintLifecycleUid, deliveryBucket, leaseKey } from "@cotal-ai/core";
import { connect, credsAuthenticator } from "@nats-io/transport-node";
import { Kvm } from "@nats-io/kv";
import { spaceMaterialDir, recordMesh, spaceSegment } from "@cotal-ai/workspace";
import { SMOKE_BROKER_TOKEN, teardownOnSignal } from "@cotal-ai/smoke-kit";
import { pickFreePort } from "./_free-port.js";

const PORT = await pickFreePort();
const SERVERS = `nats://127.0.0.1:${PORT}`;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const repoRoot = join(import.meta.dirname, "..", "..", "..");
let pass = 0, fail = 0;
const check = (name: string, cond: boolean, detail: string | Record<string, unknown> = "") => {
  const text = typeof detail === "string" ? detail : JSON.stringify(detail);
  if (cond) { pass++; console.log(`  ✓ ${name}`); return; }
  fail++;
  console.log(`  ✗ FAIL: ${name}`);
  // A red that does not say what the daemon said sends the next reader to re-instrument this file by
  // hand, which is how a startup refusal stayed invisible here for as long as it did.
  if (text.trim()) console.log(text.trim().split("\n").map((l) => `      | ${l}`).join("\n"));
};
let daemonLog = "";

const space = `delivery-couple-${randomUUID().slice(0, 8)}`;
const auth = await createSpaceAuth(space);
const dir = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
writeFileSync(join(dir, "server.conf"), serverConfig(auth, [auth], { transport: { kind: "plaintext" }, port: PORT, storeDir: join(dir, "js") }));
let srv = spawn("nats-server", ["-c", join(dir, "server.conf")], { stdio: "ignore" });
// Owned, so a SIGNALLED run takes the broker and its store dir with it. The `finally` below is the
// only teardown this suite has and no signal handler is registered, so before this line a SIGINT
// left both behind. Killing the broker mid-test is this suite's SUBJECT, not its teardown: it proves
// the daemon exits on its own once the broker is gone, and the ~10s wait for that is also why the
// removal at the end of the `finally` is nowhere near the exit it follows.
const releaseBroker = teardownOnSignal(srv, dir);
const credsPath = join(dir, "delivery.creds");

let daemon: ReturnType<typeof spawn> | undefined;
let daemonExited = false;
// The daemon's stdout/stderr are CAPTURED asynchronously; a check that greps the log needs every
// byte the daemon wrote before it greps, or a fast exit races the pipe drain and flakes (seen:
// L4 red with the loss line missing from a log that ended mid-flush).
const drainDaemonOutput = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) await wait(50);
};
try {
  let up = false;
  for (let i = 0; i < 50; i++) { if (await isReachable(SERVERS)) { up = true; break; } await wait(200); }
  if (!up) throw new Error(`auth nats-server did not come up on ${PORT}`);
  const mgrCreds = await mintCreds(auth, newIdentity(), "provisioner");
  await setupSpaceStreams({ servers: SERVERS, space, creds: mgrCreds });
  writeFileSync(credsPath, await mintCreds(auth, newIdentity(), "delivery"), { mode: 0o600 });

  // PROVISION THE $SYS OBSERVER CRED AND PIN THE WORKSPACE THE DAEMON WILL ADOPT. Without both of
  // these the daemon refuses during startup, before endpoint construction, before lease admission,
  // and so before any of the broker-coupling behaviour this suite exists to grade. That refusal was
  // ALSO an exit, so cell 2 kept reporting green while the daemon it was meant to observe had been
  // dead since startup and had never once been coupled to the broker it was asked to outlive. A
  // suite whose subject never runs cannot notice its subject breaking, which is the only thing this
  // suite is for. `cwd: repoRoot` is what made it reachable at all: findCotalRoot's cwd walk climbs
  // out of the repo into whatever real workspace sits above it, so the daemon inherited an operator
  // account and refused the foreign tenancy. A scratch root with its own `.cotal` stops the walk.
  const wsRoot = join(dir, "ws");
  mkdirSync(join(wsRoot, ".cotal"), { recursive: true });
  mkdirSync(spaceMaterialDir(wsRoot, space), { recursive: true });
  writeFileSync(
    join(spaceMaterialDir(wsRoot, space), "membership-observer.creds"),
    await mintMembershipObserverCreds(auth, newIdentity()),
    { mode: 0o600 },
  );

  // The child env is built ONCE, before every daemon child this suite spawns: the R cells below
  // and the broker-coupling subject after them run the same real CLI against the same scratch
  // COTAL_HOME, so a registry record one cell writes is exactly what the next child resolves.
  // The short broker-gone window is set only where it is the subject, never on an R cell: an R
  // daemon that comes up would otherwise be reaped 2s in and read as a startup refusal.
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith("COTAL_")) delete env[k];
  env.XDG_CONFIG_HOME = join(dir, "xdg");
  env.COTAL_HOME = join(dir, "cotal-home");
  env.COTAL_SKIP_CONNECTOR_SEED = "1";

  // ── R. THE DIAL TARGET COMES FROM THE MESH REGISTRY, NOT THE LOOPBACK DEFAULT (#756) ─────────
  //
  // `runStartedDelivery` used to take `v.server ?? DEFAULT_SERVER` with no registry lookup, so a
  // registered space whose record named a non-default broker was dialed at `127.0.0.1:4222` and the
  // refusal named that wrong URL with a remedy that is wrong for a hand-registered record. These
  // cells stage a record under the suite's scratch COTAL_HOME and grade the daemon's dial/refusal
  // behavior through the real CLI binary, exactly as an operator typing `cotal deliver` would.
  // Each cell spawns its own daemon child and waits for it to exit (or come up) before the next;
  // none of them needs the broker killed, so they run before the broker-kill subject below.
  // `recordMesh` writes under the CALLING process's COTAL_HOME (`homeCotalDir()` reads the env at
  // call time), so the suite points its own COTAL_HOME at the scratch home for the duration of the
  // write and restores it after: the record lands in the scratch registry the daemon child reads,
  // never in the operator's. (First draft called it without the override and the record silently
  // landed in the real registry while every cell graded a no-record default.) The children's `env`
  // was snapshotted above and is unaffected.
  const writeRecord = (entry: { server: string; root: string; origin?: "up" | "manual" }): void => {
    const prev = process.env.COTAL_HOME;
    process.env.COTAL_HOME = join(dir, "cotal-home");
    try {
      recordMesh({ space, mode: "auth", ts: new Date().toISOString(), ...entry });
    } finally {
      if (prev === undefined) delete process.env.COTAL_HOME;
      else process.env.COTAL_HOME = prev;
    }
  };
  const meshRecordFile = join(dir, "cotal-home", "meshes", `${spaceSegment(space)}.json`);
  const clearRecord = (): void => { rmSync(meshRecordFile, { force: true }); };
  const spawnDaemon = (args: string[], cwd: string) => {
    const d = spawn(
      join(repoRoot, "node_modules", ".bin", "tsx"),
      [join(repoRoot, "bin", "cotal.ts"), "deliver", ...args],
      { cwd, stdio: ["ignore", "pipe", "pipe"], env },
    );
    let log = "";
    const sink2 = (b: Buffer) => { log += b.toString(); };
    d.stdout?.on("data", sink2);
    d.stderr?.on("data", sink2);
    return {
      proc: d,
      log: () => log,
      done: async (): Promise<string> => {
        for (let i = 0; i < 120; i++) {
          if (d.exitCode !== null) return log;
          await wait(250);
        }
        d.kill("SIGKILL");
        return log;
      },
    };
  };

  // CELL ORDER: the refusal cells (R2-R4) must run while NO daemon this suite spawned has ever
  // held the lease row on the suite broker: each of them exits before binding, so the broker's row
  // stays virgin until R1. R1 IS the suite's subject daemon below — a record naming this broker and
  // root with no `--server` is exactly the registry-resolved dial the fix exists for, so the
  // subject's own "comes up + stays running" cell grades it (the same readiness the suite already
  // waited for) instead of a second daemon racing the subject for the singleton lease.

  // R2: a record naming a port nothing listens on, no --server: the refusal must name THAT URL
  // (not 127.0.0.1:4222), and for a `manual` record it must not prescribe `Run: cotal up`.
  const deadPort = await pickFreePort();
  const deadServer = `nats://127.0.0.1:${deadPort}`;
  writeRecord({ server: deadServer, root: wsRoot, origin: "manual" });
  let r2 = spawnDaemon(["--space", space, "--creds", credsPath], wsRoot);
  let r2Log = await r2.done();
  check(
    "R2 an unreachable RECORDED broker is refused naming that URL (not the loopback default), without `Run: cotal up` for a manual record",
    r2Log.includes(deadServer) && !r2Log.includes("nats://127.0.0.1:4222") && !r2Log.includes("Run: cotal up"),
    r2Log,
  );

  // R3: an explicit --server that DIFFERS from the record: refused BEFORE any dial, naming both.
  writeRecord({ server: deadServer, root: wsRoot });
  let r3 = spawnDaemon(["--space", space, "--server", `nats://127.0.0.1:${PORT}`, "--creds", credsPath], wsRoot);
  let r3Log = await r3.done();
  check(
    "R3 an explicit --server differing from the record is refused before any dial, naming both URLs",
    r3Log.includes(`--server nats://127.0.0.1:${PORT} does not match registered space "${space}" at ${deadServer}`) && !/can't reach NATS|no broker answered|no mesh running/.test(r3Log),
    r3Log,
  );

  // R4: a record whose ROOT is a different scratch directory: refused before any dial, naming both.
  // The daemon names the workspace root as ITS process sees it — Node's `process.cwd()` (what
  // `findCotalRoot` walks up from) resolves through symlinks, and this suite's scratch dir sits
  // behind one on a sandboxed host, so the served-root half of the assertion compares the REALPATH.
  const otherRoot = join(dir, "other-ws");
  mkdirSync(join(otherRoot, ".cotal"), { recursive: true });
  writeRecord({ server: SERVERS, root: otherRoot });
  let r4 = spawnDaemon(["--space", space, "--creds", credsPath], wsRoot);
  let r4Log = await r4.done();
  check(
    "R4 a record for a different workspace root is refused before any dial, naming both roots",
    r4Log.includes(otherRoot) && r4Log.includes(realpathSync(wsRoot)) && !/can't reach NATS|no broker answered|no mesh running/.test(r4Log),
    r4Log,
  );

  // R5 CONTROL: no record and no --server keeps today's bare default. The default port may be LIVE
  // on this host (another lane's broker), and `isReachable` with creds answers true even on an auth
  // rejection, so unreachability is not assertable there. The cell always grades the DIAL TARGET the
  // daemon prints (the banner exists precisely so this is observable in both worlds), and asserts
  // the unchanged refusal line only when a credless probe finds 4222 dead.
  clearRecord();
  const defaultLive = await isReachable("nats://127.0.0.1:4222"); // credless INFO probe, silent
  let r5 = spawnDaemon(["--space", space, "--creds", credsPath], wsRoot);
  let r5Log = await r5.done();
  check(
    "R5 CONTROL (dial target): no record + no --server dials the bare default 127.0.0.1:4222",
    r5Log.includes(`no meshes entry for "${space}" - dialing nats://127.0.0.1:4222 (the local default)`) &&
      !r5Log.includes("is registered at"),
    r5Log,
  );
  if (!defaultLive)
    check(
      "R5 CONTROL: 4222 dead here, so the refusal keeps today's line",
      r5Log.includes("can't reach NATS at nats://127.0.0.1:4222. Run: cotal up"),
      r5Log,
    );
  if (r5.proc.exitCode === null) { try { r5.proc.kill("SIGKILL"); } catch { /* gone */ } }
  clearRecord();

  // R6: a credential that can connect and read the lease bucket but holds no publish on the lease
  // key (#374). The lease row is still virgin here (no daemon before this point has ever acquired
  // it), so a denial line naming a live conflict would be provably false, not merely misleading.
  writeRecord({ server: SERVERS, root: wsRoot });
  const observerPath = join(dir, "observer.creds");
  writeFileSync(observerPath, await mintCreds(auth, newIdentity(), "observer"), { mode: 0o600 });
  let r6 = spawnDaemon(["--space", space, "--server", SERVERS, "--creds", observerPath], wsRoot);
  let r6Log = await r6.done();
  const leaseSubject = `$KV.${deliveryBucket(space)}.${leaseKey(0)}`;
  check(
    "R6 a permission denial on the lease write is reported as a denial naming the subject and operation",
    r6Log.includes(`refused (publish "${leaseSubject}")`) && r6Log.includes(leaseSubject),
    r6Log,
  );
  check(
    "R6 the denial never says another daemon is running",
    !r6Log.includes("a live lease already exists"),
    r6Log,
  );
  check("R6 the observer daemon exited non-zero", r6.proc.exitCode !== null && r6.proc.exitCode !== 0, `exitCode=${r6.proc.exitCode}`);
  {
    const probeId = newIdentity();
    const r6Probe = new CotalEndpoint({
      space, servers: SERVERS, creds: await mintCreds(auth, probeId, "delivery"), channels: [],
      consume: false, watchPresence: false, registerPresence: false,
      card: { id: probeId.id, name: "r6-probe", role: "probe", kind: "endpoint" },
    });
    r6Probe.on("error", () => {});
    await r6Probe.start();
    try {
      const row = await r6Probe.readDeliveryLease(0);
      check("R6 the refused acquire never wrote the lease row", row === undefined, JSON.stringify(row));
    } finally {
      await r6Probe.stop();
    }
  }
  clearRecord();

  // R1 + THE SUBJECT: a record naming this suite's broker and workspace root, and the daemon
  // spawned with NO `--server` — the exact registry-resolved dial the fix exists for. The subject's
  // own cells below then grade it (comes up + stays, exits when the broker dies, names the reason),
  // so this is the same readiness the suite always waited for, now through the registry. The
  // SHORT broker-gone window stays on the subject only. stderr is CAPTURED so an exit can be
  // attributed to the reason the daemon gave rather than merely counted.
  writeRecord({ server: SERVERS, root: wsRoot });
  const subjectEnv = { ...env, COTAL_DELIVERY_BROKER_GONE_MS: "2000" };
  daemon = spawn(
    join(repoRoot, "node_modules", ".bin", "tsx"),
    [join(repoRoot, "bin", "cotal.ts"), "deliver", "--space", space, "--creds", credsPath],
    { cwd: wsRoot, stdio: ["ignore", "pipe", "pipe"], env: subjectEnv },
  );
  const sink = (b: Buffer) => { daemonLog += b.toString(); };
  daemon.stdout?.on("data", sink);
  daemon.stderr?.on("data", sink);
  daemon.on("exit", () => { daemonExited = true; });

  // Give the daemon time to connect + bind. If it couldn't reach the broker it would have exited
  // (runDelivery process.exit), so "still alive after the startup window" means it came up and is serving.
  await wait(5000);
  check("the daemon comes up + stays running against a live broker", !daemonExited, daemonLog);

  // C1: the conflict branch survives the #374 fix. A second daemon with the SAME `delivery` creds
  // and the same arguments as the subject loses the CAS create (the subject already holds the row)
  // and must still report a real conflict, not a permission denial, while the subject stays up.
  {
    const c1 = spawnDaemon(["--space", space, "--creds", credsPath], wsRoot);
    const c1Log = await c1.done();
    check(
      "C1 a genuine conflict still reports the conflict line byte for byte",
      c1Log.includes(`✗ delivery: a live lease already exists for shard 0 — another delivery daemon is running. Not binding.`),
      c1Log,
    );
    check("C1 the conflict daemon's log carries no permission denial", !c1Log.includes("permission denied"), c1Log);
    check("C1 the conflict daemon exited non-zero", c1.proc.exitCode !== null && c1.proc.exitCode !== 0, `exitCode=${c1.proc.exitCode}`);
    check("C1 the subject is still alive (conflict did not disturb the holder)", !daemonExited, daemonLog);
  }

  check(
    "R1 the subject daemon dialed the RECORDED broker (banner), no --server given",
    daemonLog.includes(`is registered at ${SERVERS} (meshes entry)`),
    daemonLog,
  );

  // Kill the broker. The daemon should give up reconnecting after the short window and EXIT.
  srv.kill("SIGKILL");
  let exitedInTime = false;
  for (let i = 0; i < 40; i++) { // up to ~10s (window 2s + reconnect attempts + margin)
    if (daemonExited) { exitedInTime = true; break; }
    await wait(250);
  }
  check("the daemon EXITS on its own when the broker is gone (coupled to the broker)", exitedInTime, daemonLog);
  // AND IT EXITED FOR THAT REASON. Any exit satisfies the cell above, including the startup refusal
  // that made this suite green for the wrong reason; only the stated reason distinguishes the
  // guarantee from a daemon that happened to die. This is also the control on #1318's repair: the
  // starvation fix must not buy availability by making a genuinely dead broker survivable.
  check(
    "and the exit names the broker-gone reason rather than being any exit at all",
    /can't reach NATS|broker unreachable/i.test(daemonLog),
    daemonLog,
  );
  // The L cells below stage a SECOND daemon on a FRESH broker; this first one is gone for good,
  // so its lease row dies with the killed broker's JetStream store (server.conf reuses the same
  // storeDir, but the row was TTL-bound to the OLD stream instance). Nothing to wait for here.
  daemon = undefined;

  // ── L. A LEASE ROW THAT CHANGES HANDS IS FELT AT DELIVERY LATENCY, NOT AT THE RENEW TICK ────
  //
  // (#1596) The daemon's renew interval was the only observer of the lease row, so a daemon whose
  // shard was taken by another holder kept its ctl.delivery responder (and the fan-out/reader
  // bindings) for up to a full renew period: two processes serving one shard. The lease-loss watch
  // closes that: a KV watch filtered to the daemon's own lease key triggers the SAME decision tree
  // the failed-renew path runs (quiesce first, re-read, re-arm or exit), so the loss-to-quiesce
  // window is bounded by the KV update's delivery latency. Measured at the base (3e5ac1ad1):
  // ~14.6 s, on the order of the 15 s renew period; the bound here is 5 s with ~10x margin over
  // the post-fix measurement.
  //
  // ── L. A LEASE ROW THAT CHANGES HANDS IS FELT AT DELIVERY LATENCY, NOT AT THE RENEW TICK ────
  //
  // The broker was killed for the cells above; a FRESH broker + daemon are staged so the takeover
  // has a live row to steal. The overtake writes the row from a second cred under a DIFFERENT
  // incarnation (a replacement daemon re-reading the same creds file presents the same holder; the
  // incarnation is what distinguishes runs), via a previousSeq CAS exactly like a real takeover.
  // The L cells need the broker's lease row GONE (a fresh row the new daemon can own), so the
  // store dir is wiped with the server down: the killed server's JetStream state would otherwise
  // come back with the old row in it (same storeDir in server.conf) and the fresh daemon below
  // would be refused with "a live lease already exists" — measured, exactly that.
  rmSync(join(dir, "js"), { recursive: true, force: true });
  srv = spawn("nats-server", ["-c", join(dir, "server.conf")], { stdio: "ignore" });
  let upAgain = false;
  for (let i = 0; i < 50; i++) { if (await isReachable(SERVERS)) { upAgain = true; break; } await wait(200); }
  if (!upAgain) throw new Error(`auth nats-server did not come back on ${PORT}`);
  // The wipe also took the space's streams and KV buckets; re-provision them exactly as the
  // first staging did, or the daemon's Plane-3 bind fails on missing infrastructure.
  await setupSpaceStreams({ servers: SERVERS, space, creds: await mintCreds(auth, newIdentity(), "provisioner") });
  daemonLog = "";
  daemonExited = false;
  daemon = spawn(
    join(repoRoot, "node_modules", ".bin", "tsx"),
    [join(repoRoot, "bin", "cotal.ts"), "deliver", "--space", space, "--server", SERVERS, "--creds", credsPath],
    { cwd: wsRoot, stdio: ["ignore", "pipe", "pipe"], env },
  );
  daemon.stdout?.on("data", sink);
  daemon.stderr?.on("data", sink);
  daemon.on("exit", () => { daemonExited = true; });

  const probeId = newIdentity();
  const probe = new CotalEndpoint({
    space, servers: SERVERS, creds: await mintCreds(auth, probeId, "delivery"), channels: [],
    consume: false, watchPresence: false, registerPresence: false,
    card: { id: probeId.id, name: "probe", role: "probe", kind: "endpoint" },
  });
  probe.on("error", () => {});
  await probe.start();
  try {
    let ready = false;
    for (let i = 0; i < 50; i++) {
      const row = await probe.readDeliveryLease(0);
      if (row?.ready === true) { ready = true; break; }
      await wait(200);
    }
    check("L1 CONTROL: the fresh daemon's lease row turns ready", ready, daemonLog);

    // A caller that can ask ctl.delivery (the V cells' harness shape): proves the rail answers
    // before the overtake and measures how long it keeps answering after.
    const lIdentity = newIdentity();
    const lLifecycleUid = mintLifecycleUid();
    const lNoop = { commitAcl: async () => {}, reissueAcl: async () => {}, provisionDmInbox: async () => {}, provisionDlvInbox: async () => {}, provisionTaskQueue: async () => {} };
    const lCreds = await provisionAgent(lNoop, auth, lIdentity, { subscribe: [], allowSubscribe: [], lifecycleUid: lLifecycleUid });
    const lNc = await connect({
      servers: SERVERS, authenticator: credsAuthenticator(new TextEncoder().encode(lCreds)),
      inboxPrefix: `_INBOX_${lIdentity.id}`, maxReconnectAttempts: 0,
    });
    try {
      const lSubject = controlServiceSubject(space, CONTROL_DELIVERY, DEV_OWNER, lIdentity.id);
      const ask = async (): Promise<{ ok?: boolean; error?: string } | undefined> => {
        const replyTo = `${lSubject}.reply.${randomUUID()}`;
        const inbox = lNc.subscribe(replyTo, { max: 1 });
        const answer = (async () => {
          for await (const m of inbox) {
            try { return m.json<{ ok?: boolean; error?: string }>(); } catch { return { error: "unparseable reply" }; }
          }
          return undefined;
        })();
        lNc.publish(lSubject, new TextEncoder().encode(JSON.stringify({
          op: "listMemberships", args: { lifecycleUid: lLifecycleUid },
          from: { id: `${DEV_OWNER}.${lIdentity.id}`, name: "l-caller", kind: "agent" },
        })), { reply: replyTo });
        await lNc.flush();
        const out = await Promise.race([answer, wait(2000).then(() => undefined)]);
        try { inbox.unsubscribe(); } catch { /* already gone */ }
        return out;
      };
      const serving = await ask();
      check("L2 CONTROL: while serving, the control rail ANSWERS this caller", serving?.ok === true, daemonLog);
      const servingOkAt = Date.now();

      // THE OVERTAKE: a previousSeq CAS from a second cred, different incarnation.
      const row = await probe.readDeliveryLeaseEntry(0);
      if (row === undefined) throw new Error("no lease row to steal");
      const overtakerId = newIdentity();
      const overtakerNc = await connect({
        servers: SERVERS, authenticator: credsAuthenticator(new TextEncoder().encode(await mintCreds(auth, overtakerId, "delivery"))),
        inboxPrefix: `_INBOX_${overtakerId.id}`, maxReconnectAttempts: 0,
      });
      const overtakeAt = Date.now();
      try {
        await (await new Kvm(overtakerNc).open(deliveryBucket(space)))
          .update(leaseKey(0), new TextEncoder().encode(JSON.stringify({ ...row.info, holder: `local.${idFromCreds(await mintCreds(auth, overtakerId, "delivery"))}`, incarnation: "ll1-overtaker", since: Date.now() })), row.revision);
      } finally { await overtakerNc.close(); }

      // Measure: how long does the loser keep answering ok:true? `lastOkAt` seeds from the accept
      // control above (the rail WAS answering at overtakeAt), so the first poll landing after a
      // quiesce that already happened — which is the whole point of the fix, the window can be
      // shorter than one poll gap — still records a first refusal instead of waiting for an ok
      // that will never come.
      let lastOkAt = servingOkAt;
      let firstRefusalAt = 0;
      for (let i = 0; i < 120; i++) {
        const r = await ask();
        if (r?.ok === true) lastOkAt = Date.now();
        else if (firstRefusalAt === 0) { firstRefusalAt = Date.now(); break; }
        if (daemonExited) break;
        await wait(250);
      }
      const windowMs = firstRefusalAt - overtakeAt;
      console.log(`      measured loss-to-quiesce window: ${windowMs}ms (bound 5000ms, renew period 15000ms)`);
      await drainDaemonOutput();
      check(
        "L3 the loser stops answering within 5s of the row changing hands (was ~one renew period, 15s)",
        firstRefusalAt > 0 && windowMs < 5000,
        { windowMs, lastOkAt, daemonLog },
      );
      check(
        "L4 and the daemon's log names the watch-driven loss rather than a renew failure",
        /lease watch event/i.test(daemonLog),
        daemonLog,
      );
      // The loser must EXIT (the row is held by another daemon: the `taken` exit), not linger.
      await drainDaemonOutput();
      let exitedForLoss = false;
      for (let i = 0; i < 40; i++) { if (daemonExited) { exitedForLoss = true; break; } await wait(250); }
      check("L5 and it exits so the holder is single", exitedForLoss, daemonLog);
    } finally {
      try { await lNc.close(); } catch { /* ignore */ }
    }
  } finally {
    try { await probe.stop(); } catch { /* ignore */ }
  }

  console.log(`\nDELIVERY-BROKER-COUPLING SMOKE ${fail === 0 ? "OK ✅" : "FAILED ❌"}  (${pass} passed, ${fail} failed)`);
  if (fail) process.exitCode = 1;
} catch (e) {
  fail++;
  console.error("  ✗ scenario threw:", (e as Error).message);
  process.exitCode = 1;
} finally {
  try { if (daemon && !daemonExited) daemon.kill("SIGKILL"); } catch { /* gone */ }
  try { srv.kill("SIGKILL"); } catch { /* gone */ }
  rmSync(dir, { recursive: true, force: true });
  releaseBroker(); // last: ownership is held until this teardown has actually finished
}
