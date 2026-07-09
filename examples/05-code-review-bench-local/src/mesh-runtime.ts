// Shared Cotal-mesh scaffolding for the local bench harnesses (the mesh review in mesh.ts and the
// debate transport in debate.ts). Extracted so debate.ts can reuse the proven mechanics without
// duplicating them. (mesh.ts still carries its own inline copies while its 50-PR run is live; a
// post-run refactor can point it here too — the logic is identical.)
//
// The mechanics, and why each exists (all cracked during mesh.ts bringup):
//   * ONE long-lived NATS broker started from a config with a BIG max_control_line — the Cotal
//     connector's CONNECT/SUB exceeds the 4KB default, so a default-config broker rejects every
//     agent in a retry loop and presence never registers.
//   * spawn -f (not up -f) to deploy agents onto the running broker; up -f refuses when a broker
//     is already up.
//   * spawn -f is same-checkout: it needs a ~/.cotal/meshes/<space>.json registry entry pointing
//     the space at this repo root, and a repo-root .cotal to exist. We write both.
//   * An isolated COTAL_HOME so the registry can't collide with another repo's always-on mesh.
//     (COTAL_HOME isolates ONLY the machine-home dir — registry/current-pointer/onboard marker.
//     manager.pid/log resolve via findCotalRoot walk-up and stay under <repo>/.cotal regardless.)
//   * Directed DMs to drive agent turns (ambient is held while an agent is still initializing).
//   * ONE manager per space, and down -f does NOT stop it, so a per-run mesh must stop the shared
//     manager between spaces or the next spawn -f times out "manager not ready".
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";

export const repoRoot = path.resolve(import.meta.dirname, "../../..");
export const brokerUrl = process.env.COTAL_SERVERS || "nats://127.0.0.1:4222";
const brokerPort = Number(new URL(brokerUrl).port) || 4222;
const brokerHost = new URL(brokerUrl).hostname || "127.0.0.1";
const maxControlLine = Number(process.env.COTAL_BENCH_MESH_MAX_CONTROL_LINE || 65536);
const maxPayload = Number(process.env.COTAL_BENCH_MESH_MAX_PAYLOAD || 8_388_608);

// Manager pid + marker resolve via findCotalRoot (walk-up for .cotal) → under <repo>/.cotal,
// independent of COTAL_HOME.
const managerPidPath = path.join(repoRoot, ".cotal", "manager.pid");
const managerMarkerPath = path.join(repoRoot, ".cotal", "manager.delivery-aware");

/** The isolated COTAL_HOME for a run. Set once via {@link setCotalHome} before any subprocess. */
let cotalHome = "";

/** Create + record an isolated COTAL_HOME (explicit env wins). Also ensures the repo-root .cotal
 *  exists so spawn -f's same-checkout guard resolves this root. Call once at the start of a run. */
export function setCotalHome(runRoot: string): string {
  cotalHome = process.env.COTAL_HOME || path.join(runRoot, ".cotal-home");
  mkdirSync(cotalHome, { recursive: true, mode: 0o700 });
  mkdirSync(path.join(repoRoot, ".cotal"), { recursive: true });
  return cotalHome;
}

/** The env every cotal subprocess (spawn/send/down) and the observer runs under. */
export function cotalEnv(extra: Record<string, string> = {}): Record<string, string> {
  return { ...(cotalHome ? { COTAL_HOME: cotalHome } : {}), ...extra };
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Spawn a child, streaming stdout+stderr to a log file, flushed on an interval AND on close (so a
 *  short-lived command's tail — often its error — is never dropped). */
export function spawnLogged(command: string, args: string[], cwd: string, logPath: string, extraEnv: Record<string, string> = {}): ChildProcess {
  const child = spawn(command, args, { cwd, env: { ...process.env, ...extraEnv }, stdio: ["ignore", "pipe", "pipe"] });
  const chunks: string[] = [];
  const flush = () => { if (chunks.length) appendFileSync(logPath, chunks.splice(0).join("")); };
  child.stdout?.on("data", (chunk) => chunks.push(chunk.toString()));
  child.stderr?.on("data", (chunk) => chunks.push(chunk.toString()));
  const timer = setInterval(flush, 1000);
  child.on("close", () => { clearInterval(timer); flush(); });
  return child;
}

/** Run a command to completion. Never throws — returns the exit code for the caller to decide. */
export function run(command: string, args: string[], cwd: string, extraEnv: Record<string, string> = {}): { stdout: string; stderr: string; code: number | null } {
  const result = spawnSync(command, args, { cwd, env: { ...process.env, ...extraEnv }, encoding: "utf8" });
  return { stdout: result.stdout ?? "", stderr: result.stderr ?? "", code: result.status };
}

// ---- broker ---------------------------------------------------------------

/** TCP liveness probe on the broker port. */
export function portInUse(): Promise<boolean> {
  return new Promise((resolve) => {
    import("node:net").then((net) => {
      const socket = net.connect({ host: brokerHost, port: brokerPort });
      const done = (result: boolean) => { socket.removeAllListeners(); socket.destroy(); resolve(result); };
      socket.once("connect", () => done(true));
      socket.once("error", () => done(false));
      socket.setTimeout(1000, () => done(false));
    });
  });
}

/** Write a big-limit nats-server config and start the broker if the port is free. Refuses to adopt
 *  an existing broker (it may use the default 4KB max_control_line, which breaks every agent). */
export async function startBroker(runRoot: string): Promise<ChildProcess> {
  const storeDir = path.join(runRoot, ".nats");
  mkdirSync(storeDir, { recursive: true });
  const confPath = path.join(runRoot, "nats.conf");
  writeFileSync(confPath, [
    `port: ${brokerPort}`,
    `host: "${brokerHost}"`,
    `max_control_line: ${maxControlLine}`,
    `max_payload: ${maxPayload}`,
    `jetstream {`,
    `  store_dir: "${storeDir}"`,
    `}`,
    "",
  ].join("\n"));

  if (run("nats-server", ["--version"], repoRoot).code !== 0) {
    throw new Error("nats-server not found on PATH — install it (https://github.com/nats-io/nats-server/releases) and re-run");
  }
  if (await portInUse()) {
    throw new Error(`a broker is already listening on ${brokerUrl}; refusing to adopt it (it may use the default 4KB max_control_line, which rejects every Cotal agent). Stop it first, then re-run.`);
  }

  const logPath = path.join(runRoot, "nats.log");
  const child = spawnLogged("nats-server", ["-c", confPath], repoRoot, logPath);
  let spawnError: string | undefined;
  child.on("error", (err) => { spawnError = err.message; });

  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (spawnError) throw new Error(`failed to start nats-server: ${spawnError}`);
    if (await portInUse()) {
      console.log(`broker up at ${brokerUrl} (max_control_line ${maxControlLine}) — log ${logPath}`);
      return child;
    }
    await sleep(200);
  }
  child.kill("SIGKILL");
  throw new Error(`nats-server did not become reachable at ${brokerUrl} within 15s — see ${logPath}`);
}

// ---- mesh registry (spawn -f is same-checkout) -----------------------------

/** Write the ~/.cotal/meshes/<space>.json entry so spawn -f accepts this open broker as belonging
 *  to this checkout. Shape mirrors core's MeshEntry; written directly with node:fs because
 *  @cotal-ai/core is not a dependency of this example. */
export function recordMesh(space: string): void {
  const dir = path.join(cotalHome || path.join(os.homedir(), ".cotal"), "meshes");
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${encodeURIComponent(space)}.json`);
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ space, server: brokerUrl, root: repoRoot, mode: "open", ts: new Date().toISOString() }, null, 2), { mode: 0o600 });
  renameSync(tmp, file);
}

export function removeMeshRecord(space: string): void {
  const file = path.join(cotalHome || path.join(os.homedir(), ".cotal"), "meshes", `${encodeURIComponent(space)}.json`);
  try { rmSync(file, { force: true }); } catch { /* best-effort — a stale entry is pruned by the resolver anyway */ }
}

// ---- shared manager (repo-root, one per space; NOT under COTAL_HOME) --------

function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

export function managerPid(): number | undefined {
  if (!existsSync(managerPidPath)) return undefined;
  const pid = Number(readFileSync(managerPidPath, "utf8").trim());
  return Number.isFinite(pid) ? pid : undefined;
}

/** Stop the shared manager (SIGTERM → wait → SIGKILL) and remove its pid + marker, so the next
 *  spawn -f starts a fresh manager on the new space. */
export async function stopSharedManager(): Promise<void> {
  const pid = managerPid();
  if (pid !== undefined && isAlive(pid)) {
    try { process.kill(pid, "SIGTERM"); } catch { /* already gone */ }
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline && isAlive(pid)) await sleep(250);
    if (isAlive(pid)) { try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ } await sleep(500); }
  }
  try { rmSync(managerPidPath, { force: true }); } catch { /* best-effort */ }
  try { rmSync(managerMarkerPath, { force: true }); } catch { /* best-effort */ }
}

/** Clear a dead-but-recorded manager pid before a spawn, so spawn -f doesn't skip-start for a corpse. */
export function clearStaleManager(): void {
  const pid = managerPid();
  if (pid === undefined || !isAlive(pid)) {
    try { rmSync(managerPidPath, { force: true }); } catch { /* best-effort */ }
    try { rmSync(managerMarkerPath, { force: true }); } catch { /* best-effort */ }
  }
}

/** Best-effort synchronous manager+broker kill for a signal handler / run shutdown. */
export function killManagerAndBroker(broker: ChildProcess): void {
  const pid = managerPid();
  if (pid !== undefined) { try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ } }
  try { broker.kill("SIGKILL"); } catch { /* already gone */ }
}

// ---- transcript (the observer writes it; we parse presence + messages) ------

export type TranscriptEntry = { type?: string; text?: string; from?: string; ev?: string; name?: string; status?: string };

export function readTranscript(transcript: string): TranscriptEntry[] {
  let lines: string[];
  try {
    lines = readFileSync(transcript, "utf8").split("\n").filter(Boolean);
  } catch {
    return [];
  }
  const entries: TranscriptEntry[] = [];
  for (const line of lines) {
    try { entries.push(JSON.parse(line) as TranscriptEntry); } catch { /* partial trailing line */ }
  }
  return entries;
}

/** The subset of `names` currently present (joined, not offline) from the observer's presence events. */
export function presentAgents(entries: TranscriptEntry[], names: string[]): Set<string> {
  const present = new Set<string>();
  for (const entry of entries) {
    if (entry.type !== "presence" || !entry.name || !names.includes(entry.name)) continue;
    if (entry.status === "offline" || entry.ev === "leave") present.delete(entry.name);
    else present.add(entry.name);
  }
  return present;
}

/** Start the read-only observer that records every message + presence event to a JSONL transcript. */
export function startObserver(space: string, transcript: string, logPath: string): ChildProcess {
  writeFileSync(transcript, "");
  return spawnLogged(
    path.join(repoRoot, "node_modules", ".bin", "tsx"),
    [path.join(repoRoot, "examples/02-self-improving-console/harness/observer.ts")],
    repoRoot,
    logPath,
    cotalEnv({ COTAL_SPACE: space, COTAL_SERVERS: brokerUrl, TRANSCRIPT: transcript }),
  );
}

/** Poll the transcript until every name in `names` is present, or timeout. */
export async function waitForPresent(transcript: string, names: string[], timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (presentAgents(readTranscript(transcript), names).size >= names.length) return true;
    await sleep(2000);
  }
  return presentAgents(readTranscript(transcript), names).size >= names.length;
}

/** Best-effort wait (≤15s) for every agent to drop off presence after down -f. */
export async function confirmTornDown(transcript: string, names: string[]): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (presentAgents(readTranscript(transcript), names).size === 0) return;
    await sleep(1000);
  }
}

/** Parse `Run <id> · ledger <path>` out of spawn -f output (color codes tolerated). */
export function parseRunId(stdout: string): string | undefined {
  // eslint-disable-next-line no-control-regex
  const clean = stdout.replace(/\[[0-9;]*m/g, "");
  return clean.match(/Run\s+(\S+)\s+·\s+ledger/)?.[1] ?? clean.match(/--run\s+(\S+)/)?.[1];
}
