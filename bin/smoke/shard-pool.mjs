/** The measured cohort runs together, never alongside the remainder of a shard. */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { availableParallelism, homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { reapSmokeBrokers, reportReaped } from "./reap-smoke-brokers.mjs";
import { reapRunCustodians, reportCustodians } from "./reap-seat-custodians.mjs";
import { parseSentinel } from "./sentinel.mjs";

const COHORT = new Map([
  ["pnpm smoke:attach-stdin", "tsx implementations/manager/smoke/attach-stdin.smoke.ts"],
  ["pnpm smoke:opencode", "tsx extensions/connector-opencode/smoke/turn-wedge.smoke.ts"],
]);
const OUTPUT_LIMIT = 32 * 1024 * 1024;

export function poolSelection(planned) {
  const raw = process.env.SMOKE_CI_JOBS;
  if (raw !== undefined && !/^[1-2]$/.test(raw)) throw new Error("SMOKE_CI_JOBS must be an integer from 1 to 2");
  const candidates = planned.filter((cmd) => COHORT.has(cmd));
  const unavailable = process.platform !== "linux" ? `attribution unavailable on ${process.platform}`
    : ["COTAL_HOME", "COTAL_SEAT_ROOT"].find((key) => process.env[key] !== undefined);
  if (unavailable && raw !== undefined && Number(raw) > 1) throw new Error(`smoke pool unavailable: ${unavailable}`);
  const jobs = raw === undefined ? (unavailable ? 1 : Math.min(2, Math.max(1, availableParallelism() - 1))) : Number(raw);
  if (candidates.length < 2 || jobs === 1) {
    if (candidates.length > 1) console.log(`[pool] serial execution: ${unavailable || "SMOKE_CI_JOBS or CPU budget is 1"}`);
    return { commands: [], jobs: 1 };
  }
  const scripts = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")).scripts;
  for (const cmd of candidates) {
    if (scripts[cmd.slice("pnpm ".length)] !== COHORT.get(cmd)) throw new Error(`pooled script changed: ${cmd}`);
  }
  return { commands: candidates, jobs: Math.min(jobs, candidates.length) };
}

function killGroup(child, signal) {
  if (child.pid === undefined) return;
  try { process.kill(-child.pid, signal); }
  catch (error) { if (error.code !== "ESRCH") throw error; }
}

// spawn consumes the inherited environment synchronously. Restore the parent's values before
// admitting another child; unrelated caller settings, including test pins, remain inherited.
function spawnWithState(bin, args, state) {
  const previous = Object.fromEntries(Object.keys(state).map((key) => [key, process.env[key]]));
  try {
    for (const [key, value] of Object.entries(state)) process.env[key] = value;
    return spawn(bin, args, { detached: true, stdio: ["ignore", "pipe", "pipe"] });
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

export async function runPool(commands, { jobs, runMarker, indices, onStart }) {
  const root = mkdtempSync(join(tmpdir(), "csp-"));
  // Corepack otherwise changes its cache when HOME/XDG_CACHE_HOME changes for a suite.
  const corepackHome = process.env.COREPACK_HOME ?? join(
    process.env.XDG_CACHE_HOME ?? process.env.LOCALAPPDATA ?? join(homedir(), ".cache"), "node/corepack",
  );
  const results = new Array(commands.length);
  const active = new Set();
  let next = 0;
  let printed = 0;
  let failure;
  let interrupted;
  const stop = (entry, reason) => {
    entry.stopped ??= reason;
    killGroup(entry.child, "SIGTERM");
    entry.grace ??= setTimeout(() => killGroup(entry.child, "SIGKILL"), 3000);
  };
  const stopOthers = (reason) => { for (const entry of active) stop(entry, reason); };
  const signals = ["SIGINT", "SIGTERM", "SIGHUP"].map((signal) => {
    const handler = () => { interrupted ??= signal; stopOthers(`interrupted by ${signal}`); };
    process.on(signal, handler);
    return [signal, handler];
  });
  const onExit = () => {
    for (const entry of active) {
      try { killGroup(entry.child, "SIGKILL"); }
      catch (error) { console.error(`[pool] exit cleanup failed: ${error.message}`); process.exitCode = 1; }
    }
  };
  process.on("exit", onExit);
  const heartbeat = setInterval(() => console.log(`[pool] ${active.size} suite(s) still running`), 30_000);
  heartbeat.unref();
  const flush = () => {
    while (printed < commands.length && results[printed]) {
      const r = results[printed++];
      process.stdout.write(`\n===== ${r.cmd} =====\n${r.out}${r.out.endsWith("\n") ? "" : "\n"}`);
      reportReaped(r.cmd, r.brokers);
      reportCustodians(r.cmd, r.seats);
      if (r.stopped) console.error(`[pool] STOPPED IN FLIGHT: ${r.cmd} (${r.stopped})`);
      console.log(`[pool] done ${r.cmd}: exit ${r.status}, ${r.seconds.toFixed(2)}s`);
    }
  };
  const runOne = (index) => new Promise((resolve, reject) => {
    const cmd = commands[index];
    const dir = join(root, String(index));
    mkdirSync(dir, { mode: 0o700 });
    const state = { COREPACK_HOME: corepackHome, COTAL_RUN: `${runMarker.trim().replace(/\s+/g, "_")}.${indices.get(cmd)}.${randomUUID()}`, SMOKE_BROKER_SCOPE: randomUUID() };
    for (const [key, leaf] of Object.entries({ HOME: "h", COTAL_HOME: "c", COTAL_SEAT_ROOT: "seats", XDG_CONFIG_HOME: "cfg", XDG_DATA_HOME: "d", XDG_STATE_HOME: "s", XDG_CACHE_HOME: "cache", XDG_RUNTIME_DIR: "r", TMPDIR: "t" })) {
      state[key] = join(dir, leaf);
      mkdirSync(state[key], { mode: 0o700 });
    }
    state.TMP = state.TEMP = state.TMPDIR;
    const [bin, ...args] = cmd.split(/\s+/);
    const start = performance.now();
    onStart(cmd);
    console.log(`[pool] start ${cmd}`);
    const child = spawnWithState(bin, args, state);
    const entry = { child, stopped: undefined, grace: undefined };
    active.add(entry);
    const chunks = [];
    let bytes = 0;
    let done = false;
    const take = (chunk) => {
      if (bytes > OUTPUT_LIMIT) return;
      bytes += chunk.length;
      if (bytes > OUTPUT_LIMIT) {
        failure ??= { cmd, reason: "output exceeded 32 MiB", status: 1 };
        stopOthers(`failure of ${cmd}`);
      } else chunks.push(chunk);
    };
    child.stdout.on("data", take);
    child.stderr.on("data", take);
    const finish = (status, error) => {
      if (done) return;
      done = true;
      if (entry.grace) clearTimeout(entry.grace);
      try {
        const out = Buffer.concat(chunks).toString("utf8") + (error ? `${error.message}\n` : "");
        const r = { cmd, status: status ?? 1, out, stopped: entry.stopped, seconds: (performance.now() - start) / 1000 };
        r.brokers = reapSmokeBrokers({ scope: state.SMOKE_BROKER_SCOPE });
        r.seats = reapRunCustodians(state.COTAL_RUN);
        const sentinel = parseSentinel(out);
        r.cells = sentinel?.cells ?? 0;
        const reason = r.status !== 0 ? `exit ${r.status}` : !sentinel ? "no sentinel" : sentinel.cells === 0 ? "zero cells" : undefined;
        if (!r.stopped && reason) failure ??= { cmd, reason, status: r.status || 1 };
        if (r.stopped) r.status = r.status || 1;
        // Reap and record attributable leaks before sweeping the remaining process group.
        killGroup(child, "SIGKILL");
        active.delete(entry);
        results[index] = r;
        if (failure) stopOthers(`failure of ${failure.cmd}`);
        flush();
        resolve();
      } catch (error) {
        failure ??= { cmd, reason: `pool cleanup failed: ${error.message}`, status: 1 };
        stopOthers("pool cleanup failed");
        reject(error);
      }
    };
    child.on("error", (error) => { if (child.pid === undefined) finish(1, error); });
    child.on("close", (status) => finish(status));
  });
  const worker = async () => {
    while (!failure && !interrupted && next < commands.length) {
      const index = next++;
      try { await runOne(index); }
      catch (error) {
        failure ??= { cmd: commands[index], reason: `pool failed: ${error.message}`, status: 1 };
        stopOthers("pool failed");
        throw error;
      }
    }
  };
  try {
    const workers = await Promise.allSettled(Array.from({ length: jobs }, worker));
    const failed = workers.find((r) => r.status === "rejected");
    if (failed) throw failed.reason;
    return { results: results.filter(Boolean), failure, interrupted };
  } finally {
    clearInterval(heartbeat);
    onExit();
    process.off("exit", onExit);
    for (const [signal, handler] of signals) process.off(signal, handler);
    for (const entry of active) if (entry.grace) clearTimeout(entry.grace);
    rmSync(root, { recursive: true, force: true });
  }
}
