/**
 * `cotal daemon` local transport: the platform defaults every OS uses, over real sockets or pipes
 * and the stock `@cotal-ai/seat` native helper. No peer reader is injected anywhere: each cell
 * drives `serveDaemon` / `queryDaemon` with the defaults the CLI gets and counts what happened.
 *
 * Linux and macOS cells:
 *  T1  serve and status with no peer hooks on either side: ready, with this pid;
 *  T2  a same-user listener that is not the lock holder, at a socket whose lock record names the
 *      real daemon, is refused PEER_NOT_LOCK_OWNER and receives 0 bytes;
 *  T3  birth binding: a record naming that listener's pid with another start token is refused with
 *      0 bytes; naming its real {@link processBirth} token lets the request through;
 *  T4  the lifetime lock primitive: a second open file is refused while the first holds it, and
 *      takes it once the first closes;
 *  T5  processBirth: this process has a stable token, a pid that does not exist has none;
 *  T6  socket path limits: the longest path the kernel binds is accepted, one byte more refused.
 * Windows cells (run only on Windows):
 *  W1  serve and status over the pipe with the platform defaults: ready, with this pid;
 *  W2  a second serve for the same daemon refuses LOCK_HELD;
 *  W3  a pipe name another process already serves (Node's own pipe server) is refused
 *      ALREADY_RUNNING, and that squatter receives 0 bytes from a client, which refuses
 *      PEER_NOT_LOCK_OWNER;
 *  W4  a daemon home whose DACL grants Everyone access is refused DIR_WRONG_MODE.
 * Cells for another platform are listed as not run on this one, never counted as passed.
 *
 * Run: tsx bin/smoke/daemon-transport.smoke.ts
 */
import { closeSync, mkdtempSync, openSync, readdirSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { mkSecretDir } from "@cotal-ai/core";
import { lockExclusiveNb } from "@cotal-ai/seat";
import { EndpointRefusal, assertSocketPathFits, checkDir, type DaemonPaths } from "../daemon/endpoint.js";
import { serveDaemon, type RunningDaemon, type ServeOptions } from "../daemon/server.js";
import { queryDaemon, type ClientCounters } from "../daemon/client.js";
import { processBirth } from "../daemon/lifetime.js";

let pass = 0, fail = 0;
const notRun: string[] = [];
const check = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ FAIL: ${name}`, extra ?? ""); }
};
const refusalCode = async (p: Promise<unknown>): Promise<string> => {
  try { await p; return "no-refusal"; } catch (e) { return e instanceof EndpointRefusal ? e.code : `other:${(e as Error).message}`; }
};
// Restoration-only entries, never a child environment.
const savedEnvironment = Object.entries(process.env);
for (const key of Object.keys(process.env)) if (key.startsWith("COTAL_") && key !== "COTAL_DAEMON_SMOKE_TMP") delete process.env[key];
const root = mkdtempSync(join(process.env.COTAL_DAEMON_SMOKE_TMP ?? tmpdir(), "cotal-transport-"));
mkSecretDir(root);
for (const name of ["home", "runtime", "config", "data", "cache", "appdata", "localappdata"]) mkSecretDir(join(root, name));
Object.assign(process.env, { HOME: join(root, "home"), USERPROFILE: join(root, "home"), XDG_RUNTIME_DIR: join(root, "runtime"), XDG_CONFIG_HOME: join(root, "config"), XDG_DATA_HOME: join(root, "data"), XDG_CACHE_HOME: join(root, "cache"), APPDATA: join(root, "appdata"), LOCALAPPDATA: join(root, "localappdata"), DO_NOT_TRACK: "1" });
const ownedDaemons = new Set<RunningDaemon>();
const ownedChildren = new Set<ChildProcess>();
const unix = process.platform === "linux" || process.platform === "darwin";

/** A private directory under the scratch root. */
const privateDir = (name: string): string => { const d = join(root, name); mkSecretDir(d); return d; };
/** Unix daemon paths in fresh private directories, short enough for macOS's 103-byte limit. */
const unixPaths = (name: string): DaemonPaths & { dir: string } => {
  const dir = privateDir(`${name}-r`), state = privateDir(`${name}-s`);
  return { dir, socket: join(dir, "d.sock"), state, lock: join(state, "daemon.lock") };
};

async function ownedServe(opts: ServeOptions): Promise<RunningDaemon> {
  const daemon = await serveDaemon({ ...opts, sessionDir: opts.paths.state });
  ownedDaemons.add(daemon);
  return daemon;
}

/** A same-user process listening at `path` (a socket path or pipe name) that counts what it receives. */
async function listener(path: string): Promise<{ proc: ChildProcess; pid: number; bytes: () => number }> {
  const code = `const n=require("net");let g=0;const sockets=new Set();const server=n.createServer((c)=>{sockets.add(c);c.on("close",()=>sockets.delete(c));c.on("data",(b)=>{g+=b.length;process.stdout.write("BYTES "+g+"\\n")})}).listen(process.argv[1],()=>process.stdout.write("LISTENING\\n"));process.stdin.resume();process.stdin.once("end",()=>{for(const c of sockets)c.destroy();server.close()})`;
  const proc = spawn(process.execPath, ["-e", code, path], { stdio: ["pipe", "pipe", "inherit"] });
  ownedChildren.add(proc);
  let out = "";
  proc.stdout!.on("data", (b) => { out += String(b); });
  for (let i = 0; i < 100 && !out.includes("LISTENING"); i++) await new Promise((r) => setTimeout(r, 50));
  if (!out.includes("LISTENING")) throw new Error(`listener at ${path} never started`);
  return { proc, pid: proc.pid!, bytes: () => Math.max(0, ...[...out.matchAll(/BYTES (\d+)/g)].map((m) => Number(m[1]))) };
}
const stop = (p: ChildProcess) => new Promise<void>((resolve, reject) => {
  if (p.exitCode !== null || p.signalCode !== null) return resolve();
  const force = setTimeout(() => p.kill("SIGKILL"), 1000);
  const bound = setTimeout(() => reject(new Error("owned listener exit was not confirmed")), 5000);
  p.once("exit", () => { clearTimeout(force); clearTimeout(bound); resolve(); });
  p.stdin?.end();
  p.kill();
});

try {
  if (unix) {
    // ---- T1: defaults on both ends ----
    {
      const p = unixPaths("t1");
      const d = await ownedServe({ paths: p, version: "0.0.0-transport" });
      const r = await queryDaemon({ paths: p });
      check("T1 serve and status with no peer hooks: ready, this pid", r.ok && r.result.state === "ready" && r.result.pid === process.pid, r);
      check("T1 the daemon accepted 1 connection and rejected none", d.counters.accepted === 1 && d.counters.peerRejected === 0, d.counters);
      await d.close();
    }

    // ---- T2: a same-user listener that is not the lock holder ----
    {
      const real = unixPaths("t2a");
      const d = await ownedServe({ paths: real, version: "0.0.0-transport" });
      const fake = unixPaths("t2b");
      const other = await listener(fake.socket);
      chmodSync(fake.socket, 0o600);
      const counters: ClientCounters = { bytesWritten: 0 };
      const code = await refusalCode(queryDaemon({ paths: { ...fake, lock: real.lock }, counters, timeoutMs: 2000 }));
      await new Promise((r) => setTimeout(r, 200));
      check("T2 a same-user listener that is not the lock holder is refused PEER_NOT_LOCK_OWNER", code === "PEER_NOT_LOCK_OWNER", code);
      check("T2 nothing was sent: 0 bytes written, 0 received", counters.bytesWritten === 0 && other.bytes() === 0, { written: counters.bytesWritten, received: other.bytes() });
      await stop(other.proc);
      await d.close();
    }

    // ---- T3: the record's start token binds the pid to one process ----
    {
      const p = unixPaths("t3");
      const other = await listener(p.socket);
      chmodSync(p.socket, 0o600);
      const birth = processBirth(other.pid);
      check("T3 instrument: the listener has a start token", typeof birth === "string" && birth.length > 0, birth);
      writeFileSync(p.lock, `${JSON.stringify({ v: 1, pid: other.pid, start: `${birth}0`, startedAt: new Date().toISOString() })}\n`);
      const counters: ClientCounters = { bytesWritten: 0 };
      const wrong = await refusalCode(queryDaemon({ paths: p, counters, timeoutMs: 2000 }));
      await new Promise((r) => setTimeout(r, 200));
      check("T3 the right pid with another start token is refused PEER_NOT_LOCK_OWNER, 0 bytes", wrong === "PEER_NOT_LOCK_OWNER" && counters.bytesWritten === 0 && other.bytes() === 0, { wrong, received: other.bytes() });
      writeFileSync(p.lock, `${JSON.stringify({ v: 1, pid: other.pid, start: birth, startedAt: new Date().toISOString() })}\n`);
      const through = await refusalCode(queryDaemon({ paths: p, timeoutMs: 1000 }));
      for (let i = 0; i < 40 && other.bytes() === 0; i++) await new Promise((r) => setTimeout(r, 50));
      check("T3 its real start token lets the request through (the listener received it)", other.bytes() > 0, { through, received: other.bytes() });
      await stop(other.proc);
    }

    // ---- T5: process birth tokens ----
    {
      const a = processBirth(process.pid), b = processBirth(process.pid);
      check("T5 this process has a stable start token", typeof a === "string" && a === b, { a, b });
      const dead = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" });
      check("T5 an exited process has no start token", processBirth(Number(dead.stdout)) === undefined, dead.stdout);
    }

    // ---- T6: socket path limits ----
    {
      const max = process.platform === "darwin" ? 103 : 107;
      const at = (n: number) => `/${"x".repeat(n - 1)}`;
      let ok = true;
      try { assertSocketPathFits(at(max)); } catch { ok = false; }
      const over = await refusalCode(Promise.resolve().then(() => assertSocketPathFits(at(max + 1))));
      check(`T6 a ${max}-byte socket path is accepted and ${max + 1} bytes refused NO_RUNTIME_DIR`, ok && over === "NO_RUNTIME_DIR", { ok, over });
    }
  } else {
    notRun.push("T1", "T2", "T3", "T5", "T6");
  }

  // ---- T4: the lifetime lock primitive (every platform) ----
  {
    const f = join(privateDir("t4"), "daemon.lock");
    const a = openSync(f, "a+"), b = openSync(f, "a+");
    const first = lockExclusiveNb(a), second = lockExclusiveNb(b);
    closeSync(a);
    const after = lockExclusiveNb(b);
    closeSync(b);
    check("T4 a second open file is refused while the first holds the lock, and takes it after", first && !second && after, { first, second, after });
  }

  if (process.platform === "win32") {
    const pipe = (tag: string) => `\\\\.\\pipe\\cotal-daemon-smoke-${tag}-${randomBytes(4).toString("hex")}`;
    const pipePaths = (tag: string): DaemonPaths => { const state = privateDir(`${tag}-s`); return { socket: pipe(tag), state, lock: join(state, "daemon.lock") }; };

    // ---- W1, W2 ----
    {
      const p = pipePaths("w1");
      const d = await ownedServe({ paths: p, version: "0.0.0-transport" });
      const r = await queryDaemon({ paths: p });
      check("W1 serve and status over the pipe: ready, this pid", r.ok && r.result.state === "ready" && r.result.pid === process.pid, r);
      check("W2 a second serve for the same daemon refuses LOCK_HELD", (await refusalCode(ownedServe({ paths: p, version: "x" }))) === "LOCK_HELD");
      await d.close();
      check("W1 after close nothing answers: NOT_RUNNING", (await refusalCode(queryDaemon({ paths: p, timeoutMs: 1000 }))) === "NOT_RUNNING");
    }

    // ---- W3: a squatted pipe name ----
    {
      const p = pipePaths("w3");
      const other = await listener(p.socket);
      check("W3 a pipe name another process serves is refused ALREADY_RUNNING", (await refusalCode(ownedServe({ paths: p, version: "x" }))) === "ALREADY_RUNNING");
      const counters: ClientCounters = { bytesWritten: 0 };
      const code = await refusalCode(queryDaemon({ paths: p, counters, timeoutMs: 2000 }));
      await new Promise((r) => setTimeout(r, 200));
      check("W3 a client refuses the squatter PEER_NOT_LOCK_OWNER and sends it 0 bytes", code === "PEER_NOT_LOCK_OWNER" && counters.bytesWritten === 0 && other.bytes() === 0, { code, received: other.bytes() });
      await stop(other.proc);
    }

    // ---- W4: a daemon home others can reach ----
    {
      const d = privateDir("w4");
      const grant = spawnSync(join(process.env.SystemRoot ?? "C:\\Windows", "System32", "icacls.exe"), [d, "/grant", "*S-1-1-0:(R)"], { encoding: "utf8" });
      check("W4 instrument: Everyone was granted read", grant.status === 0, grant.stderr);
      check("W4 a daemon home whose DACL grants Everyone is refused DIR_WRONG_MODE", (await refusalCode(Promise.resolve().then(() => checkDir(d)))) === "DIR_WRONG_MODE");
    }
  } else {
    notRun.push("W1", "W2", "W3", "W4");
  }
} catch (e) {
  fail++;
  console.log("  ✗ smoke crashed:", e);
} finally {
  const cleanup = await Promise.allSettled([...ownedDaemons].map((daemon) => daemon.close()).concat([...ownedChildren].map(stop)));
  if (cleanup.every((result) => result.status === "fulfilled")) {
    try {
      rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } catch (error) {
      let entries: string[] | string;
      try { entries = readdirSync(root); } catch (listingError) { entries = `could not list leftovers: ${String(listingError)}`; }
      check("cleanup scratch directory removed", false, { root, error, entries });
    }
  } else {
    check("cleanup owned resources stopped", false, { retained: root, cleanup });
  }
  for (const key of Object.keys(process.env)) if (!savedEnvironment.some(([name]) => name === key)) delete process.env[key];
  for (const [key, value] of savedEnvironment) process.env[key] = value;
}

if (notRun.length) console.log(`  ○ NOT RUN on ${process.platform}: ${notRun.join(", ")}`);
console.log(`\nDAEMON TRANSPORT SMOKE ${fail ? "FAILED" : "OK"}  (${pass} passed, ${fail} failed, ${notRun.length} not run on ${process.platform})`);
process.exit(fail ? 1 : 0);
