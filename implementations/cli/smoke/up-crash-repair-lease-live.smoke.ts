/**
 * LIVE e2e for #4092 and #4155: repair `cotal up` before and after a crashed control-plane process's
 * lease expires. The manager and the delivery daemon each take their lease by atomic create,
 * and a holder killed without releasing it leaves the row until the bucket TTL removes it. Before the
 * fix, the repair launched a replacement that lost the create, and `up` exited 1.
 *
 * Cells (auth mode, the default, because only an authed mesh runs a delivery daemon):
 *   U   delivery daemon SIGTERMed once the first `up -d` starts the manager, after the daemon's
 *       readiness wait returned: `up` exits 1 naming the daemon it lost, its Next offers only
 *       `cotal down`, the daemon gives its lease back, and the next `up` restores it without a wait.
 *   P   broker stalled just after the daemon renews, until the daemon (restored by U with a 2s
 *       broker-gone window) exits on its own with no pidfile and leaves its row: `down --yes` on an
 *       80-column terminal waits the row out, wraps the line that says so, and exits 0. Before the
 *       fix it read that row as a live daemon and refused.
 *   M1  manager SIGKILLed, repair at once: the new manager waits out the dead pid's row, and `up` exits 0.
 *   M2  manager SIGKILLed while something keeps rewriting its row: the new manager refuses at the
 *       first rewrite, and `up` exits 1. A live holder is never waited past.
 *   D1  broker SIGKILLed just after the daemon renews its row, so the daemon exits on its own:
 *       `up` restores the daemon whether its row is still held or has expired during shutdown.
 *   D1-held / D1-expired  daemon SIGKILLed with a fresh lease: repair before and after observed
 *       expiry. Only the held row requires a wait message; both repairs exit 0 with the daemon up.
 *   D2  daemon SIGKILLed while something keeps rewriting shard 0 under its credential: the repair
 *       refuses at the first rewrite and starts no daemon.
 *   R   `down --yes` with the broker stalled from the manager's exit until 2.5s later, past the two
 *       seconds the delivery daemon gives its release, then `up` 2.5s after, three times. `down`
 *       exits 0 and keeps the daemon's credential, and `up` waits the row out and binds a new daemon.
 *       Before the fix `down` dropped the credential and `up` was refused with "a live lease already
 *       exists".
 *
 * Sandboxes COTAL_HOME, XDG_CONFIG_HOME and the root; picks a free port; kills only pids its own
 * root recorded; tears down with `cotal down`. Needs `nats-server` on PATH.
 * Run: pnpm smoke:up-crash-repair-lease:live
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { connect, credsAuthenticator } from "@nats-io/transport-node";
import { Kvm } from "@nats-io/kv";
import { CotalEndpoint, deliveryBucket, deliveryLeaseHolderFor, idFromCreds, LEASE_TTL_MS, leaseKey, mintCreds, newIdentity } from "@cotal-ai/core";
import { canonicalLocalProcessPath, deliveryCredsKey, DELIVERY_LOGFILE, DELIVERY_PIDFILE, getSpaceAuth, MANAGER_LOGFILE, MANAGER_PIDFILE, parsePid, workspaceSecretStore } from "@cotal-ai/workspace";
import { assertSmokeSandboxDown, recordSmokeSandbox } from "@cotal-ai/smoke-kit";
import { pickFreePort } from "../../../packages/core/smoke/_free-port.js";
import { clean, cotalPty } from "./_console-pty.js";

const PORT = await pickFreePort();
const SERVER = `nats://127.0.0.1:${PORT}`;
const SPACE = "lease-repair";
const WT = resolve(import.meta.dirname, "..", "..", "..");
const CLI = join(WT, "bin", "cotal.ts");
const TSX = join(WT, "node_modules", ".bin", "tsx");

const home = mkdtempSync(join(tmpdir(), "cotal-lease-repair-home-"));
const root = mkdtempSync(join(tmpdir(), "cotal-lease-repair-root-"));
const configDir = join(home, "xdg");
const sandbox = recordSmokeSandbox({ root, cotalHome: home, xdgConfigHome: configDir });
const rootEnv = { ...process.env };
for (const key of Object.keys(rootEnv)) if (key.startsWith("COTAL_")) delete rootEnv[key];
const env = { ...rootEnv, COTAL_HOME: home, XDG_CONFIG_HOME: configDir, COTAL_SKIP_CONNECTOR_SEED: "1" };

let pass = 0;
const ok = (name: string, cond: boolean, extra?: unknown) => {
  if (!cond) throw new Error(`FAIL: ${name}${extra !== undefined ? `\n${typeof extra === "string" ? extra : JSON.stringify(extra)}` : ""}`);
  pass++;
  console.log(`  ✓ ${name}`);
};
const cli = (...args: string[]) => cliWith({}, ...args);
const cliWith = (extra: NodeJS.ProcessEnv, ...args: string[]) => {
  const options = { cwd: root, env: { ...env, ...extra }, encoding: "utf8" as const, timeout: 180_000 };
  assertSmokeSandboxDown(sandbox, args, options);
  const r = spawnSync(TSX, [CLI, ...args], options);
  return { status: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
};
const UP = ["up", "--server", SERVER, "--detach", "--space", SPACE];
const up = () => cli(...UP);
/** A command without blocking this process, so a rewriter in this process keeps running while it waits. */
const cliAsync = (...args: string[]) => {
  const options = { cwd: root, env };
  assertSmokeSandboxDown(sandbox, args, options);
  const child = spawn(TSX, [CLI, ...args], options);
  let out = "";
  child.stdout.on("data", (b) => (out += b));
  child.stderr.on("data", (b) => (out += b));
  return new Promise<{ status: number | null; out: string }>((r) => child.on("close", (status) => r({ status, out })));
};
const upAsync = () => cliAsync(...UP);
/** A command on a terminal `cols` columns wide: its exit code and what it printed, escapes removed. */
const cliOnTerminal = (cols: number, ...args: string[]) => {
  assertSmokeSandboxDown(sandbox, args, { cwd: root, env });
  const pty = cotalPty(args, { cwd: root, env: { ...env, TERM: "xterm-256color" } as Record<string, string>, cols });
  let out = "";
  pty.onData((d) => (out += d));
  return new Promise<{ status: number; out: string }>((r) => pty.onExit((e) => r({ status: e.exitCode, out: clean(out).replace(/\r/g, "") })));
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ctx = { root, space: SPACE };
const pidOf = (file: string): number | undefined => {
  const p = file === "nats.pid" ? join(root, ".cotal", file) : canonicalLocalProcessPath(file, ctx);
  return existsSync(p) ? parsePid(readFileSync(p, "utf8")) : undefined;
};
const alive = (pid: number | undefined) => {
  if (pid === undefined) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
};
const readLog = (file: string) => {
  const p = canonicalLocalProcessPath(file, ctx);
  return existsSync(p) ? readFileSync(p, "utf8") : "";
};
const until = async (cond: () => boolean | Promise<boolean>, ms: number) => {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(200)) if (await cond()) return true;
  return cond();
};
/** SIGKILL the pid this root recorded for `file`, and wait until it is gone. */
const crash = async (file: string, what: string): Promise<number> => {
  const pid = pidOf(file);
  ok(`${what} is running before the crash`, alive(pid), { pid });
  process.kill(pid!, "SIGKILL");
  ok(`${what} (pid ${pid}) is gone after SIGKILL`, await until(() => !alive(pid), 10_000));
  return pid!;
};
/** Rewrite a lease row under its current revision every 500ms, as a live holder renewing it would. */
const rewriting = (rewrite: () => Promise<void>) => {
  let on = true;
  let rewrites = 0;
  const loop = (async () => {
    while (on) {
      await rewrite();
      rewrites++;
      await sleep(500);
    }
  })();
  return { stop: async () => { on = false; await loop; return rewrites; } };
};
/** The shard-0 delivery row on the broker, read with this root's delivery credential. */
const deliveryRow = async () => {
  const creds = (await workspaceSecretStore(root).get(deliveryCredsKey(SPACE, { injected: false, root })))!;
  const nc = await connect({ servers: SERVER, authenticator: credsAuthenticator(new TextEncoder().encode(creds)), inboxPrefix: `_INBOX_${idFromCreds(creds)}` });
  try {
    const row = await (await new Kvm(nc).open(deliveryBucket(SPACE))).get(leaseKey(0));
    return row?.operation === "PUT" ? row : undefined;
  } finally {
    await nc.close();
  }
};
/** Wait for every lease this root's crashed processes left behind to expire before the next cell. */
const settle = () => sleep(35_000);

try {
  // U
  const booting = upAsync();
  for (const end = Date.now() + 120_000; pidOf(MANAGER_PIDFILE) === undefined && Date.now() < end; await sleep(10));
  const lostDaemon = pidOf(DELIVERY_PIDFILE);
  ok("U1 the daemon is running when up starts the manager", alive(lostDaemon), { lostDaemon });
  process.kill(lostDaemon!, "SIGTERM");
  const lost = await booting;
  ok("U2 up exits 1 and names the delivery daemon it lost", lost.status === 1 && lost.out.includes(`! control plane degraded: the delivery daemon started for space "${SPACE}" (pid ${lostDaemon}) exited before this boot finished`), lost.out);
  ok("U3 its summary leaves the daemon out", /running in the background: nats-server \(pid \d+\), manager /.test(lost.out), lost.out);
  ok("U3b its Next offers only cotal down, since spawn needs the control plane it lost", /\nNext\n {2}cotal down +Stop the stack\n/.test(lost.out) && !lost.out.includes("cotal spawn"), lost.out);
  ok("U4 the daemon exited and gave its lease back", await until(() => !alive(lostDaemon), 10_000) && await deliveryRow() === undefined);
  const restoring = cliWith({ COTAL_DELIVERY_BROKER_GONE_MS: "2000" }, ...UP);
  ok("U5 the next up restores the daemon without waiting for a lease", restoring.status === 0 && alive(pidOf(DELIVERY_PIDFILE)) && !/still leased/.test(restoring.out), restoring.out);

  // P
  {
    const pausedDaemon = pidOf(DELIVERY_PIDFILE), pausedBroker = pidOf("nats.pid")!;
    const held = await deliveryRow();
    let renewed = false;
    for (const end = Date.now() + 20_000; !renewed && Date.now() < end; await sleep(50)) renewed = ((await deliveryRow())?.revision ?? 0) > held!.revision;
    ok("P1 the daemon renewed its row just before the stall", renewed);
    process.kill(pausedBroker, "SIGSTOP");
    const exited = await until(() => !alive(pausedDaemon), 25_000);
    process.kill(pausedBroker, "SIGCONT");
    ok("P2 the daemon exited on its own during the stall and left no pidfile", exited && pidOf(DELIVERY_PIDFILE) === undefined && readLog(DELIVERY_LOGFILE).includes("exiting (coupled to the broker)"), readLog(DELIVERY_LOGFILE).slice(-800));
    ok("P3 its row is still on the broker", await deliveryRow() !== undefined);
    const stop = await cliOnTerminal(80, "down", "--yes");
    const waiting = stop.out.split("\n").findIndex((line) => /^\S+ delivery daemon has no pidfile;/.test(line));
    ok("P4 down waits the row out and exits 0", stop.status === 0 && /delivery daemon has no pidfile; waiting up to \d+s to see whether its lease is renewed/.test(stop.out.replace(/\n {2}/g, " ")), stop.out);
    ok("P4b on an 80-column terminal the line that says so wraps at a space under its text", waiting >= 0 && [...stop.out.split("\n")[waiting]!].length <= 80 && /^ {2}\S/.test(stop.out.split("\n")[waiting + 1] ?? ""), stop.out);
    ok("P5 and it stopped the broker", await until(() => !alive(pausedBroker), 10_000), stop.out);
  }

  const first = up();
  ok("mesh up with a delivery daemon and a manager", first.status === 0 && alive(pidOf(DELIVERY_PIDFILE)) && alive(pidOf(MANAGER_PIDFILE)), first.out);

  // R
  for (let round = 1; round <= 3; round++) {
    const manager = pidOf(MANAGER_PIDFILE)!, daemon = pidOf(DELIVERY_PIDFILE)!, broker = pidOf("nats.pid")!;
    const stopped = deliveryLeaseHolderFor((await workspaceSecretStore(root).get(deliveryCredsKey(SPACE, { injected: false, root })))!);
    const down = cliAsync("down", "--yes");
    // `down` stops the manager, then signals the daemon; the broker stalls in between.
    while (alive(manager)) await sleep(5);
    process.kill(broker, "SIGSTOP");
    const signalledInStall = alive(daemon);
    await sleep(2_500);
    process.kill(broker, "SIGCONT");
    const stop = await down;
    ok(`R${round} the daemon was still running when the broker stalled`, signalledInStall, { daemon });
    ok(`R${round} down exits 0 and stops the daemon`, stop.status === 0 && stop.out.includes(`stopped delivery daemon (pid ${daemon})`) && !alive(daemon), stop.out);
    ok(`R${round} down keeps the credential of a daemon that left its row`, stop.out.replace(/\s+/g, " ").includes("exited without releasing shard 0 of its lease, so its credential stays"), stop.out);
    await sleep(2_500);
    const restart = up();
    const log = readLog(DELIVERY_LOGFILE);
    ok(`R${round} up right after down exits 0`, restart.status === 0, restart.out);
    ok(`R${round} no daemon is refused for a live lease`, !/a live lease already exists/.test(`${restart.out}${log}`), `${restart.out}\n${log.slice(-800)}`);
    const fresh = (await workspaceSecretStore(root).get(deliveryCredsKey(SPACE, { injected: false, root })))!;
    const nc = await connect({ servers: SERVER, authenticator: credsAuthenticator(new TextEncoder().encode(fresh)), inboxPrefix: `_INBOX_${idFromCreds(fresh)}` });
    try {
      const row = await (await new Kvm(nc).open(deliveryBucket(SPACE))).get(leaseKey(0));
      const lease = row?.operation === "PUT" ? row.json<{ holder: string; ready: boolean }>() : undefined;
      const replacement = deliveryLeaseHolderFor(fresh);
      ok(`R${round} the new daemon holds a ready lease`, replacement !== stopped && lease?.holder === replacement && lease.ready === true && alive(pidOf(DELIVERY_PIDFILE)), lease);
    } finally {
      await nc.close();
    }
  }

  // M1
  const deadManager = await crash(MANAGER_PIDFILE, "manager");
  const m1 = up();
  ok("M1 repair up after a manager SIGKILL exits 0", m1.status === 0, m1.out);
  ok("M1 the manager is restored by that one run", /restored in the background: manager/.test(m1.out) && alive(pidOf(MANAGER_PIDFILE)), m1.out);
  ok(
    "M1 the new manager waited out the dead pid's lease",
    readLog(MANAGER_LOGFILE).includes(`its lease is still held by pid ${deadManager}, which is not running on this host; waiting`),
    readLog(MANAGER_LOGFILE).slice(-1500),
  );

  // M2
  const auth = (await getSpaceAuth(workspaceSecretStore(root), SPACE))!;
  const supId = newIdentity();
  const sup = new CotalEndpoint({ space: SPACE, servers: SERVER, creds: await mintCreds(auth, supId, "supervisor"), card: { id: supId.id, name: "lease-rewriter", kind: "endpoint" }, consume: false, watchChannels: false, watchPresence: false, registerPresence: false });
  sup.on("error", () => {});
  await sup.start();
  try {
    const crashedManager = await crash(MANAGER_PIDFILE, "manager");
    const held = await sup.readManagerLease();
    ok("M2 the crashed manager's row is still held", held?.pid === crashedManager, held);
    const { since: _since, ...info } = held!;
    const rewriter = rewriting(async () => {
      const row = await sup.readOwnManagerLease(info.instanceId);
      if (row) await sup.renewManagerLease(info, row.revision);
    });
    const m2 = await upAsync();
    const rewrites = await rewriter.stop();
    ok("M2 the row was rewritten during the repair", rewrites > 1, { rewrites });
    ok("M2 repair up exits 1 when the row is being rewritten", m2.status === 1, m2.out);
    ok(
      "M2 the new manager refused at the rewrite",
      readLog(MANAGER_LOGFILE).includes(`its lease was written again while waiting for pid ${crashedManager}'s lease to expire, so a live process holds it`),
      readLog(MANAGER_LOGFILE).slice(-1500),
    );
  } finally {
    await sup.stop();
  }
  await settle();
  const restored = up();
  ok("the manager comes back once the rewritten row expires", restored.status === 0 && alive(pidOf(MANAGER_PIDFILE)), restored.out);

  // D1-held / D1-expired. Run these before the broker crash so the wait-bypass mutation always
  // reaches its named held-lease cell, regardless of how long a broker-loss shutdown takes.
  {
    const previous = (await workspaceSecretStore(root).get(deliveryCredsKey(SPACE, { injected: false, root })))!;
    const nc = await connect({ servers: SERVER, authenticator: credsAuthenticator(new TextEncoder().encode(previous)), inboxPrefix: `_INBOX_${idFromCreds(previous)}` });
    try {
      const kv = await new Kvm(nc).open(deliveryBucket(SPACE));
      for (const state of ["held", "expired"] as const) {
        const holder = deliveryLeaseHolderFor((await workspaceSecretStore(root).get(deliveryCredsKey(SPACE, { injected: false, root })))!);
        ok(`D1-${state} the running daemon has a fresh lease`, await until(async () => {
          const row = await kv.get(leaseKey(0));
          return row?.operation === "PUT" && row.json<{ holder: string }>().holder === holder
            && Date.now() - row.created.getTime() < 5_000;
        }, LEASE_TTL_MS));
        const crashedDaemon = await crash(DELIVERY_PIDFILE, "delivery daemon");
        const held = await kv.get(leaseKey(0));
        ok(`D1-${state} the crashed daemon's lease is still held`, held?.operation === "PUT" && held.json<{ holder: string }>().holder === holder);
        if (state === "expired") {
          ok("D1-expired the broker expires the dead daemon's lease", await until(async () =>
            (await kv.get(leaseKey(0)))?.operation !== "PUT", LEASE_TTL_MS + 5_000));
        }
        const repaired = up();
        ok(`D1-${state} repair up after a daemon SIGKILL exits 0`, repaired.status === 0, repaired.out);
        const waited = /shard 0 is still leased to this folder's previous delivery daemon.*which is not running; waiting \d+s for the lease to expire/.test(repaired.out);
        ok(`D1-${state} repair waits only when the lease is still held`, waited === (state === "held"), repaired.out);
        const replacementPid = pidOf(DELIVERY_PIDFILE);
        ok(`D1-${state} the delivery daemon is up after that one run`, alive(replacementPid) && replacementPid !== crashedDaemon, { crashedDaemon, replacementPid });
        const replacement = deliveryLeaseHolderFor((await workspaceSecretStore(root).get(deliveryCredsKey(SPACE, { injected: false, root })))!);
        const row = await kv.get(leaseKey(0));
        const ready = row?.operation === "PUT" ? row.json<{ holder: string; ready: boolean }>() : undefined;
        ok(`D1-${state} the replacement owns a ready lease`, replacement !== holder && ready?.holder === replacement && ready.ready === true);
      }
    } finally {
      await nc.close();
    }
  }

  // D1. Broker-loss detection and shutdown can outlast the lease, so this scenario does not
  // require a wait message. The cases above check waiting against the broker's observed row.
  const daemon = pidOf(DELIVERY_PIDFILE);
  // The daemon renews its row every 15s and takes about 17s to exit once its broker is gone, so a
  // row last renewed early in that window has outlived its 30s TTL by the time the repair reads it,
  // and the repair finds the shard free. Kill the broker just after a renewal, so the repair meets a
  // row that is still held.
  const ownCreds = (await workspaceSecretStore(root).get(deliveryCredsKey(SPACE, { injected: false, root })))!;
  const own = await connect({ servers: SERVER, authenticator: credsAuthenticator(new TextEncoder().encode(ownCreds)), inboxPrefix: `_INBOX_${idFromCreds(ownCreds)}` });
  try {
    const kv = await new Kvm(own).open(deliveryBucket(SPACE));
    const held = await kv.get(leaseKey(0));
    ok("D1 the daemon holds shard 0 before the crash", held?.operation === "PUT", held?.operation);
    let renewed = false;
    for (const end = Date.now() + 20_000; !renewed && Date.now() < end; await sleep(50)) {
      const row = await kv.get(leaseKey(0));
      renewed = row !== null && row.revision > held!.revision;
    }
    ok("D1 the daemon renewed its row just before the crash", renewed);
  } finally {
    await own.close();
  }
  await crash("nats.pid", "broker");
  ok("D1 the daemon exits on its own once its broker is gone", await until(() => !alive(daemon), 60_000), { daemon });
  const d1 = up();
  ok("D1 repair up after a broker SIGKILL exits 0", d1.status === 0, d1.out);
  ok("D1 the delivery daemon is up after that one run", /delivery daemon/.test(d1.out) && alive(pidOf(DELIVERY_PIDFILE)), d1.out);

  // D2
  const previous = (await workspaceSecretStore(root).get(deliveryCredsKey(SPACE, { injected: false, root })))!;
  const nc = await connect({ servers: SERVER, authenticator: credsAuthenticator(new TextEncoder().encode(previous)), inboxPrefix: `_INBOX_${idFromCreds(previous)}` });
  try {
    const kv = await new Kvm(nc).open(deliveryBucket(SPACE));
    const crashedDaemon = await crash(DELIVERY_PIDFILE, "delivery daemon");
    const before = await kv.get(leaseKey(0));
    ok("D2 the crashed daemon's row is still held", before?.operation === "PUT", before?.operation);
    const rewriter = rewriting(async () => {
      const row = await kv.get(leaseKey(0));
      if (row?.operation === "PUT") await kv.update(leaseKey(0), row.value, row.revision);
    });
    const d2 = await upAsync();
    const rewrites = await rewriter.stop();
    ok("D2 the row was rewritten during the repair", rewrites > 1, { rewrites });
    ok("D2 repair up exits 1 when the row is being rewritten", d2.status === 1, d2.out);
    ok("D2 the repair refused at the rewrite", /it was written again while waiting for it to expire, so a live daemon holds it/.test(d2.out), d2.out);
    ok("D2 no replacement daemon was started", pidOf(DELIVERY_PIDFILE) === crashedDaemon || !alive(pidOf(DELIVERY_PIDFILE)), readLog(DELIVERY_LOGFILE).slice(-800));
  } finally {
    await nc.close();
  }

  console.log(`\nUP CRASH-REPAIR LEASE LIVE SMOKE OK ✅ (${pass} checks)`);
} finally {
  cli("down");
  rmSync(home, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
}
