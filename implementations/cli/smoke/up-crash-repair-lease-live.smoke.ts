/**
 * LIVE e2e for #4092 and #4155: repair `cotal up` before and after a crashed control-plane process's
 * lease expires. The manager and the delivery daemon each take their lease by atomic create,
 * and a holder killed without releasing it leaves the row until the bucket TTL removes it. Before the
 * fix, the repair launched a replacement that lost the create, and `up` exited 1.
 *
 * Cells (auth mode, the default, because only an authed mesh runs a delivery daemon):
 *   M1  manager SIGKILLed, repair at once: the new manager waits out the dead pid's row, and `up` exits 0.
 *   M2  manager SIGKILLed while something keeps rewriting its row: the new manager refuses at the
 *       first rewrite, and `up` exits 1. A live holder is never waited past.
 *   D1  broker SIGKILLed, so the daemon exits on its own: `up` restores the daemon whether its row
 *       is still held or has expired during shutdown.
 *   D1-held / D1-expired  daemon SIGKILLed with a fresh lease: repair before and after observed
 *       expiry. Only the held row requires a wait message; both repairs exit 0 with the daemon up.
 *   D2  daemon SIGKILLed while something keeps rewriting shard 0 under its credential: the repair
 *       refuses at the first rewrite and starts no daemon.
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
const cli = (...args: string[]) => {
  const options = { cwd: root, env, encoding: "utf8" as const, timeout: 180_000 };
  assertSmokeSandboxDown(sandbox, args, options);
  const r = spawnSync(TSX, [CLI, ...args], options);
  return { status: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
};
const UP = ["up", "--server", SERVER, "--detach", "--space", SPACE];
const up = () => cli(...UP);
/** `up` without blocking this process, so a rewriter in this process keeps running while it waits. */
const upAsync = () => {
  const options = { cwd: root, env };
  assertSmokeSandboxDown(sandbox, UP, options);
  const child = spawn(TSX, [CLI, ...UP], options);
  let out = "";
  child.stdout.on("data", (b) => (out += b));
  child.stderr.on("data", (b) => (out += b));
  return new Promise<{ status: number | null; out: string }>((r) => child.on("close", (status) => r({ status, out })));
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
/** Wait for every lease this root's crashed processes left behind to expire before the next cell. */
const settle = () => sleep(35_000);

try {
  const first = up();
  ok("mesh up with a delivery daemon and a manager", first.status === 0 && alive(pidOf(DELIVERY_PIDFILE)) && alive(pidOf(MANAGER_PIDFILE)), first.out);

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
