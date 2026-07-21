#!/usr/bin/env node
// Test 2: full Cotal mesh review. Per PR, a fresh mesh space with the 3 trio-r reviewers
// (bug-hunter -> breaker -> keeper) in ONE shared channel, posting sequentially so each sees
// the thread so far. Endorsements count as votes. Patches/pr.json are reused from a prior
// bench.ts run dir (no network). An observer (example-02 pattern) records the transcript;
// findings are parsed from FINDINGS_JSON messages. Output: Martian-shaped benchmark_data.json
// + candidates.json under tool key cotal-mesh, judged by the usual local judge afterwards.
//
// Boot model (verified by live debugging):
//   * ONE long-lived NATS broker for the whole run, started from a config with a big
//     max_control_line (the Cotal connector's CONNECT/SUB exceeds the 4KB default, so a
//     default-config broker rejects every agent in a retry loop and presence never registers).
//   * `cotal up -f` REFUSES when a broker is already up, so agents are deployed with
//     `cotal spawn -f` onto our broker. spawn -f is same-checkout: it needs a registry entry
//     (~/.cotal/meshes/<space>.json) pointing this space at this repo root, which we write.
//   * The harness posts the packet with `cotal send msg` (no poster agent).
//   * A presence-based boot gate waits for the 3 reviewer join events in the transcript and
//     fails fast (120s) instead of burning the full finding timeout on a dead mesh.
//   * Per-PR teardown is scoped: `cotal down -f <manifest> --run <id>` (run id parsed from the
//     spawn output), then we verify the reviewers left presence before the next PR.
//
// Usage: tsx src/mesh.ts <sourceRunId> [--limit N] [--resume]
import { mkdir, readFile, readdir, writeFile, copyFile } from "node:fs/promises";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";

const root = path.resolve(import.meta.dirname, "../../..");
const exampleRoot = path.resolve(import.meta.dirname, "..");
const meshTemplates = path.join(exampleRoot, "mesh");
const runsRoot = path.join(root, ".runs", "code-review-bench");
const martianRoot = process.env.COTAL_BENCH_MARTIAN_DIR || path.join(runsRoot, "martian");
const offlineRoot = path.join(martianRoot, "offline");
const toolName = process.env.COTAL_BENCH_TOOL || "cotal-mesh";
const judgeModel = process.env.MARTIAN_MODEL || process.env.COTAL_BENCH_JUDGE_MODEL || "openai/gpt-5.5";
// Per-reviewer budget: after DMing a reviewer, wait this long for its FINDINGS_JSON before moving on.
const reviewerTimeoutMs = Number(process.env.COTAL_BENCH_MESH_REVIEWER_TIMEOUT_MS || 240_000);
// Fail fast if the agents do not register presence within this window (a broker/auth/model
// problem), instead of burning the full finding timeout on a mesh that will never respond.
const bootTimeoutMs = Number(process.env.COTAL_BENCH_MESH_BOOT_TIMEOUT_MS || 120_000);
// Fail fast if the poster does not post the packet within this window (DM trigger / poster failure),
// so it is diagnosed as its own stage rather than a silent 0/3.
const packetTimeoutMs = Number(process.env.COTAL_BENCH_MESH_PACKET_TIMEOUT_MS || 180_000);
// The broker binds this port for the whole run; per-PR spaces share it.
const brokerUrl = process.env.COTAL_SERVERS || "nats://127.0.0.1:4222";
const brokerPort = Number(new URL(brokerUrl).port) || 4222;
const brokerHost = new URL(brokerUrl).hostname || "127.0.0.1";
// The connector's CONNECT/SUB blows past the 4KB default; give the broker room (matches the manual
// sequence that got all 4 agents onto presence within seconds).
const maxControlLine = Number(process.env.COTAL_BENCH_MESH_MAX_CONTROL_LINE || 65536);
const maxPayload = Number(process.env.COTAL_BENCH_MESH_MAX_PAYLOAD || 8_388_608);

// Isolated COTAL_HOME so this run's mesh registry (~/.cotal/meshes) can't collide with another
// repo's always-on mesh state on this machine — e.g. cotal-brain's stray delivery daemon spamming
// CONNZ errors, or a shared current-mesh pointer. Defaults to <meshRunRoot>/.cotal-home, set in
// main() and threaded into every cotal subprocess as COTAL_HOME. An explicit COTAL_HOME wins.
// NOTE: core honors COTAL_HOME only for the machine-home dir (registry, current-mesh, onboarded
// marker — mesh-registry.ts:41). The manager/delivery/nats pids+logs resolve via findCotalRoot
// (walk-up for .cotal) and land under <repo>/.cotal REGARDLESS of COTAL_HOME — so those pids are
// still shared across concurrent runs from THIS repo. The registry (the actual cross-repo
// collision the lead hit) IS isolated.
let cotalHome = "";

/** The env every cotal subprocess (spawn/send/down) and the broker registry writes run under. */
function cotalEnv(extra: Record<string, string> = {}): Record<string, string> {
  return { COTAL_HOME: cotalHome, ...extra };
}

// The harness sequences the reviewers via directed DMs (bug-hunter -> breaker -> keeper), so the
// persona no longer carries a "wait until X posts" order rule — the ordering is enforced here.
const REVIEWERS = [
  { name: "bug-hunter", tilt: "logic and correctness: behavior contradicting intent, broken control flow, subtle single-line defects" },
  { name: "breaker", tilt: "security and hostile conditions: auth bypass, injection, secret exposure, race conditions, concurrent access, malformed inputs" },
  { name: "keeper", tilt: "data integrity and API misuse: partial writes, cache invalidation, stale reads, lost updates, misused framework APIs, misleading code" },
];
const REVIEWER_NAMES = REVIEWERS.map((r) => r.name);
// The poster is DM-triggered: a DM (directed traffic) always drives an agent turn, whereas an
// ambient channel post from the unmanaged `cotal send` identity is not a declared channel actor
// and gets ignored. The poster reads the packet from disk and posts it into review.gateway.
const POSTER = "poster";
const ALL_AGENTS = [POSTER, ...REVIEWER_NAMES];

type Finding = { id?: string; path?: string | null; line?: number | null; severity?: string; body?: string };
type ReviewerMsg = { reviewer?: string; endorse?: string[]; findings?: Finding[] };
type TranscriptEntry = { type?: string; text?: string; from?: string; ev?: string; name?: string; status?: string };
type Candidate = { text: string; path: string | null; line: number | null; source: string; severity?: string; votes: Array<{ persona: string; weight: number }> };

function sanitizeModelName(model: string) {
  return model.trim().replace(/\//g, "_");
}

async function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Spawn a child, streaming stdout+stderr into a log file. Buffered and flushed on an interval AND
 *  on close — the previous version cleared the interval on close and dropped whatever was still
 *  buffered, so the tail of a short-lived command's output (often its error) was lost. */
function spawnLogged(command: string, args: string[], cwd: string, logPath: string, extraEnv: Record<string, string> = {}): ChildProcess {
  const child = spawn(command, args, {
    cwd,
    env: { ...process.env, ...extraEnv },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const chunks: string[] = [];
  const flush = () => {
    if (chunks.length) appendFileSync(logPath, chunks.splice(0).join(""));
  };
  child.stdout?.on("data", (chunk) => chunks.push(chunk.toString()));
  child.stderr?.on("data", (chunk) => chunks.push(chunk.toString()));
  const timer = setInterval(flush, 1000);
  child.on("close", () => {
    clearInterval(timer);
    flush(); // drain the tail (the dropped-chunks bug fix)
  });
  return child;
}

/** Run a command to completion, capturing stdout/stderr. Never rejects — returns the exit code so
 *  the caller decides. */
function run(command: string, args: string[], cwd: string, extraEnv: Record<string, string> = {}): { stdout: string; stderr: string; code: number | null } {
  const result = spawnSync(command, args, { cwd, env: { ...process.env, ...extraEnv }, encoding: "utf8" });
  return { stdout: result.stdout ?? "", stderr: result.stderr ?? "", code: result.status };
}

// ---- broker lifecycle ------------------------------------------------------

/** Write a nats-server config with the big control-line/payload limits and JetStream store, then
 *  start the broker if the port is free. If a broker is ALREADY on the port we cannot know it has
 *  our limits (a default-config one silently breaks every agent), so refuse rather than adopt it. */
async function startBroker(runRoot: string): Promise<ChildProcess> {
  const storeDir = path.join(runRoot, ".nats");
  mkdirSync(storeDir, { recursive: true });
  const confPath = path.join(runRoot, "nats.conf");
  writeFileSync(
    confPath,
    [
      `port: ${brokerPort}`,
      `host: "${brokerHost}"`,
      `max_control_line: ${maxControlLine}`,
      `max_payload: ${maxPayload}`,
      `jetstream {`,
      `  store_dir: "${storeDir}"`,
      `}`,
      "",
    ].join("\n"),
  );

  // Preflight the binary before anything else, so a missing nats-server fails with one clear
  // sentence instead of a 15s reachability timeout.
  if (run("nats-server", ["--version"], root).code !== 0) {
    throw new Error("nats-server not found on PATH — install it (https://github.com/nats-io/nats-server/releases) and re-run");
  }
  if (await portInUse()) {
    throw new Error(
      `a broker is already listening on ${brokerUrl}; refusing to adopt it (it may use the default ` +
        `4KB max_control_line, which rejects every Cotal agent). Stop it first, then re-run.`,
    );
  }

  const logPath = path.join(runRoot, "nats.log");
  const child = spawnLogged("nats-server", ["-c", confPath], root, logPath);
  let spawnError: string | undefined;
  child.on("error", (err) => { spawnError = err.message; });

  // Wait until the broker accepts TCP connections.
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

/** Cheap liveness probe: a TCP connect to the broker port. */
function portInUse(): Promise<boolean> {
  return new Promise((resolve) => {
    import("node:net").then((net) => {
      const socket = net.connect({ host: brokerHost, port: brokerPort });
      const done = (result: boolean) => {
        socket.removeAllListeners();
        socket.destroy();
        resolve(result);
      };
      socket.once("connect", () => done(true));
      socket.once("error", () => done(false));
      socket.setTimeout(1000, () => done(false));
    });
  });
}

// ---- mesh registry (spawn -f is same-checkout: it needs an entry pointing this space here) ------

/** Write the ~/.cotal/meshes/<space>.json entry cotal's resolver reads, so `spawn -f` accepts this
 *  open broker as belonging to this checkout. Shape mirrors core's MeshEntry; we write it directly
 *  because @cotal-ai/core is not a dependency of this example (no other files touched). */
function recordMesh(space: string): void {
  const dir = path.join(cotalHome, "meshes");
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${encodeURIComponent(space)}.json`);
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ space, server: brokerUrl, root, mode: "open", ts: new Date().toISOString() }, null, 2), { mode: 0o600 });
  renameSync(tmp, file);
}

function removeMeshRecord(space: string): void {
  const file = path.join(cotalHome, "meshes", `${encodeURIComponent(space)}.json`);
  try {
    rmSync(file, { force: true });
  } catch { /* best-effort — a stale entry is pruned by the resolver anyway */ }
}

// ---- shared manager (repo-root, one per space; NOT under COTAL_HOME) --------

// The manager pid + its delivery-aware marker resolve via findCotalRoot (walk-up for .cotal), so
// they live under <repo>/.cotal REGARDLESS of COTAL_HOME. spawn -f creates .cotal at the repo root
// on first run, so from then on this is the path the CLI uses.
const managerPidPath = path.join(root, ".cotal", "manager.pid");
const managerMarkerPath = path.join(root, ".cotal", "manager.delivery-aware");

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0); // signal 0 — liveness probe only
    return true;
  } catch {
    return false;
  }
}

function managerPid(): number | undefined {
  if (!existsSync(managerPidPath)) return undefined;
  const pid = Number(readFileSync(managerPidPath, "utf8").trim());
  return Number.isFinite(pid) ? pid : undefined;
}

/** Stop the shared manager (SIGTERM, then SIGKILL if it lingers) and remove its pid + marker, so the
 *  next PR's `spawn -f` starts a fresh manager on the new space instead of reusing this one. */
async function stopSharedManager(): Promise<void> {
  const pid = managerPid();
  if (pid !== undefined && isAlive(pid)) {
    try { process.kill(pid, "SIGTERM"); } catch { /* already gone */ }
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline && isAlive(pid)) await sleep(250);
    if (isAlive(pid)) {
      try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
      await sleep(500);
    }
  }
  try { rmSync(managerPidPath, { force: true }); } catch { /* best-effort */ }
  try { rmSync(managerMarkerPath, { force: true }); } catch { /* best-effort */ }
}

/** Belt-and-suspenders before a PR's spawn: if a stale manager pid is present but dead (or its
 *  process is gone), clear the pid file so spawn -f doesn't see managerUp()=true for a corpse. */
function clearStaleManager(): void {
  const pid = managerPid();
  if (pid === undefined || !isAlive(pid)) {
    try { rmSync(managerPidPath, { force: true }); } catch { /* best-effort */ }
    try { rmSync(managerMarkerPath, { force: true }); } catch { /* best-effort */ }
  }
}

// ---- transcript parsing ----------------------------------------------------

function readTranscript(transcript: string): TranscriptEntry[] {
  let lines: string[];
  try {
    lines = readFileSync(transcript, "utf8").split("\n").filter(Boolean);
  } catch {
    return [];
  }
  const entries: TranscriptEntry[] = [];
  for (const line of lines) {
    try {
      entries.push(JSON.parse(line) as TranscriptEntry);
    } catch { /* partial trailing line; ignore */ }
  }
  return entries;
}

/** The subset of `names` currently present (joined and not offline), from the observer's presence
 *  events. Used by the boot gate (all agents) and the teardown-confirm. */
function presentAgents(entries: TranscriptEntry[], names: string[]): Set<string> {
  const present = new Set<string>();
  for (const entry of entries) {
    if (entry.type !== "presence" || !entry.name || !names.includes(entry.name)) continue;
    if (entry.status === "offline" || entry.ev === "leave") present.delete(entry.name);
    else present.add(entry.name);
  }
  return present;
}

/** Has the poster posted the packet to the channel yet? (its transcript message carrying the
 *  packet's "PR REVIEW PACKET" header). Gates the findings poll so a poster failure is its own
 *  diagnosed stage, not a silent 0/3. */
function packetPosted(entries: TranscriptEntry[]): boolean {
  return entries.some((e) => e.type === "message" && e.from === POSTER && (e.text ?? "").includes("PR REVIEW PACKET"));
}

/** Parse each reviewer's single FINDINGS_JSON message from the transcript (first one wins). */
function collectFindings(entries: TranscriptEntry[]): Map<string, ReviewerMsg> {
  const seen = new Map<string, ReviewerMsg>();
  for (const entry of entries) {
    if (entry.type !== "message" || !entry.text) continue;
    const marker = entry.text.indexOf("FINDINGS_JSON:");
    if (marker === -1) continue;
    try {
      const parsed = JSON.parse(entry.text.slice(marker + "FINDINGS_JSON:".length).trim()) as ReviewerMsg;
      if (parsed.reviewer && REVIEWER_NAMES.includes(parsed.reviewer) && !seen.has(parsed.reviewer)) seen.set(parsed.reviewer, parsed);
    } catch { /* malformed JSON in a reviewer message; keep polling */ }
  }
  return seen;
}

// ---- one PR ----------------------------------------------------------------

type PrResult = { responded: number; candidates: Candidate[] };

async function runOnePr(prDir: string, sourceDir: string, meshRunRoot: string, index: number): Promise<PrResult> {
  const slug = prDir.replace(/^\d+__/, "");
  const space = `bench-mesh-${index}`;
  const meshDir = path.join(meshRunRoot, prDir);
  await mkdir(meshDir, { recursive: true });

  const pr = JSON.parse(await readFile(path.join(sourceDir, prDir, "pr.json"), "utf8")) as { title?: string; body?: string };
  await copyFile(path.join(sourceDir, prDir, "patch.diff"), path.join(meshDir, "patch.diff"));
  const patchPath = path.join(meshDir, "patch.diff");

  // Render manifest + poster + reviewer personas. The poster persona is generic (no per-PR
  // substitution) — the packet path rides the DM trigger instead.
  const manifestPath = path.join(meshDir, "cotal.yaml");
  const manifest = (await readFile(path.join(meshTemplates, "cotal.yaml.template"), "utf8")).replace("__SPACE__", space);
  await writeFile(manifestPath, manifest);
  await writeFile(path.join(meshDir, "poster.md"), await readFile(path.join(meshTemplates, "poster.md.template"), "utf8"));
  const reviewerTemplate = await readFile(path.join(meshTemplates, "reviewer.md.template"), "utf8");
  for (const reviewer of REVIEWERS) {
    const persona = reviewerTemplate
      .replaceAll("__NAME__", reviewer.name)
      .replace("__TILT__", reviewer.tilt);
    await writeFile(path.join(meshDir, `${reviewer.name}.md`), persona);
  }

  // The packet the poster reads from disk and posts to review.gateway on our DM trigger.
  const packet = `PR REVIEW PACKET\n\nTitle: ${pr.title || slug}\n\nBody:\n${(pr.body || "").slice(0, 4000)}\n\nPatch file (read it from disk): ${patchPath}\n\nReviewers: bug-hunter first, then breaker, then keeper. Post FINDINGS_JSON messages to review.gateway as instructed in your persona.`;
  const packetPath = path.join(meshDir, "packet.md");
  await writeFile(packetPath, packet);

  // Register the space so spawn -f accepts this open broker as belonging to this checkout.
  recordMesh(space);

  // Start the observer FIRST so it captures every agent's join presence for the boot gate.
  const transcript = path.join(meshDir, "transcript.jsonl");
  await writeFile(transcript, "");
  const observer = spawnLogged(
    path.join(root, "node_modules", ".bin", "tsx"),
    [path.join(root, "examples/02-self-improving-console/harness/observer.ts")],
    root,
    path.join(meshDir, "observer.log"),
    cotalEnv({ COTAL_SPACE: space, COTAL_SERVERS: brokerUrl, TRANSCRIPT: transcript }),
  );

  let runId: string | undefined;
  try {
    // A dead-but-recorded manager pid from a prior PR would make spawn -f skip starting a fresh one
    // and then time out waiting for the wrong (or absent) manager — clear a stale pid first.
    clearStaleManager();
    // Deploy poster + 3 reviewers onto the running broker. spawn -f prints "Run <id> · ledger <path>".
    const spawnLog = path.join(meshDir, "spawn.log");
    const spawned = run("pnpm", ["cotal", "spawn", "-f", manifestPath], root, cotalEnv({ COTAL_HEADLESS: "1" }));
    await writeFile(spawnLog, `${spawned.stdout}\n---stderr---\n${spawned.stderr}`);
    if (spawned.code !== 0) {
      throw new Error(`cotal spawn -f exited ${spawned.code}: ${(spawned.stderr || spawned.stdout).trim().slice(-400)}`);
    }
    runId = parseRunId(spawned.stdout);
    if (!runId) throw new Error(`could not parse run id from spawn output (see ${spawnLog})`);

    // Boot gate: wait for ALL agents (poster + 3 reviewers) to register presence, or fail fast.
    // `cotal send dm` resolves the poster by presence roster, so the poster MUST be present first.
    const booted = await waitForPresent(transcript, ALL_AGENTS, bootTimeoutMs);
    if (!booted) {
      throw new Error(`agents did not all register presence within ${bootTimeoutMs}ms (booted: ${[...presentAgents(readTranscript(transcript), ALL_AGENTS)].join(", ") || "none"}) — see ${path.join(meshDir, "observer.log")} and the manager log at ${path.join(root, ".cotal", "manager.log")} (that path is NOT under COTAL_HOME)`);
    }

    // Trigger the poster with a DM (directed traffic always drives a turn). It reads the packet from
    // disk and posts it to review.gateway as a declared channel actor.
    const dm = run("pnpm", ["cotal", "send", "dm", POSTER, `Post the review packet now: read ${packetPath} and post its complete contents to review.gateway as one message.`, "--space", space], root, cotalEnv());
    if (dm.code !== 0) {
      throw new Error(`cotal send dm poster failed (exit ${dm.code}): ${(dm.stderr || dm.stdout).trim().slice(-300)}`);
    }

    // Packet gate: wait for the poster's packet to land on the channel before starting the findings
    // poll, so a poster failure is diagnosed as its own stage rather than a silent 0/3.
    const packetLanded = await waitForPacket(transcript, packetTimeoutMs);
    if (!packetLanded) {
      throw new Error(`poster did not post the packet to review.gateway within ${packetTimeoutMs}ms — the DM trigger or the poster agent failed (see ${path.join(meshDir, "observer.log")})`);
    }

    // Drive each reviewer with a directed DM (directed traffic always drives a turn; ambient is held
    // while the reviewer is still initializing). Sequentially bug-hunter -> breaker -> keeper: DM,
    // then wait for THAT reviewer's FINDINGS_JSON on the channel before the next, so each recalls the
    // packet + prior findings (shared context) and the ordering is deterministic. One reviewer's
    // silence is isolated — we DM the next regardless, and score whoever responded.
    for (const reviewer of REVIEWER_NAMES) {
      const dmReviewer = run(
        "pnpm",
        ["cotal", "send", "dm", reviewer, "Review the PR packet on review.gateway now. Read the patch file it names, review through your lens, and post your FINDINGS_JSON to review.gateway. Earlier reviewers' findings are in the channel; endorse rather than repeat.", "--space", space],
        root,
        cotalEnv(),
      );
      if (dmReviewer.code !== 0) {
        console.warn(`  cotal send dm ${reviewer} failed (exit ${dmReviewer.code}): ${(dmReviewer.stderr || dmReviewer.stdout).trim().slice(-200)}`);
        continue;
      }
      const responded = await waitForReviewer(transcript, reviewer, reviewerTimeoutMs);
      if (!responded) console.warn(`  ${reviewer} did not post FINDINGS_JSON within ${reviewerTimeoutMs}ms — continuing to the next reviewer`);
    }

    const seen = collectFindings(readTranscript(transcript));
    const result = assembleCandidates(seen);
    await writeFile(path.join(meshDir, "mesh-candidates.json"), JSON.stringify(result.candidates, null, 2));
    console.log(`${prDir}: ${result.responded}/3 reviewers responded, ${result.candidates.length} candidates`);
    return result;
  } finally {
    // Scoped teardown: stop ONLY this run's agents/channels, then confirm every agent left.
    if (runId) {
      const down = run("pnpm", ["cotal", "down", "-f", manifestPath, "--run", runId], root, cotalEnv());
      await writeFile(path.join(meshDir, "down.log"), `${down.stdout}\n---stderr---\n${down.stderr}`);
    }
    observer.kill("SIGTERM");
    await confirmTornDown(transcript);
    observer.kill("SIGKILL");
    // Stop the shared repo-root manager. It is bound to THIS PR's space (one manager per space), but
    // `down -f` leaves it running; the next PR uses a fresh space, so a lingering manager makes the
    // next `spawn -f` see managerUp()=true, skip starting a new one, then time out on
    // "manager did not become ready for control" (the PR2 failure). Kill it + wait for it to die so
    // the next spawn boots a fresh manager on the new space.
    await stopSharedManager();
    removeMeshRecord(space);
  }
}

/** Parse `Run <id> · ledger <path>` out of the spawn output (color codes tolerated). */
function parseRunId(stdout: string): string | undefined {
  // eslint-disable-next-line no-control-regex
  const clean = stdout.replace(/\[[0-9;]*m/g, "");
  return clean.match(/Run\s+(\S+)\s+·\s+ledger/)?.[1] ?? clean.match(/--run\s+(\S+)/)?.[1];
}

/** Poll the transcript until every name in `names` is present, or timeout. */
async function waitForPresent(transcript: string, names: string[], timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (presentAgents(readTranscript(transcript), names).size >= names.length) return true;
    await sleep(2000);
  }
  return presentAgents(readTranscript(transcript), names).size >= names.length;
}

/** Poll the transcript until the poster's packet has landed on the channel, or timeout. */
async function waitForPacket(transcript: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (packetPosted(readTranscript(transcript))) return true;
    await sleep(3000);
  }
  return packetPosted(readTranscript(transcript));
}

/** Poll the transcript until a specific reviewer has posted its FINDINGS_JSON message, or timeout. */
async function waitForReviewer(transcript: string, reviewer: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (collectFindings(readTranscript(transcript)).has(reviewer)) return true;
    await sleep(5000);
  }
  return collectFindings(readTranscript(transcript)).has(reviewer);
}

/** Best-effort wait (≤15s) for every agent to drop off presence after down -f, so the next PR's
 *  boot gate can't see a stale agent from this PR. */
async function confirmTornDown(transcript: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (presentAgents(readTranscript(transcript), ALL_AGENTS).size === 0) return;
    await sleep(1000);
  }
}

/** Findings are candidates; endorsements are votes on the endorsed finding's id. */
function assembleCandidates(seen: Map<string, ReviewerMsg>): PrResult {
  const findingById = new Map<string, Finding & { reviewer: string }>();
  const votesById = new Map<string, string[]>();
  for (const reviewer of REVIEWERS) {
    const msg = seen.get(reviewer.name);
    if (!msg) continue;
    for (const finding of msg.findings || []) {
      if (!finding.body) continue;
      const id = finding.id || `${reviewer.name}-${findingById.size}`;
      findingById.set(id, { ...finding, reviewer: reviewer.name });
      votesById.set(id, [reviewer.name]);
    }
    for (const endorsed of msg.endorse || []) {
      const votes = votesById.get(endorsed);
      if (votes && !votes.includes(reviewer.name)) votes.push(reviewer.name);
    }
  }
  const candidates: Candidate[] = [...findingById.entries()].map(([id, finding]) => ({
    text: finding.body!,
    path: typeof finding.path === "string" ? finding.path : null,
    line: typeof finding.line === "number" ? finding.line : null,
    source: finding.reviewer,
    severity: finding.severity,
    votes: (votesById.get(id) || []).map((persona) => ({ persona, weight: 1 })),
  }));
  return { responded: seen.size, candidates };
}

// ---- run manifest / resume -------------------------------------------------

type RunManifest = {
  runId: string;
  sourceRunId: string;
  tool: string;
  prs: Array<{ prDir: string; url: string; status: "ok" | "incomplete" | "failed"; responded?: number; candidates?: number; error?: string }>;
};

async function main() {
  const args = process.argv.slice(2);
  const sourceRunId = args.find((a) => !a.startsWith("--"));
  if (!sourceRunId) {
    console.error("Usage: tsx src/mesh.ts <sourceRunId> [--limit N] [--resume]");
    process.exit(2);
  }
  const limitFlag = args.indexOf("--limit");
  const limit = limitFlag !== -1 ? Number(args[limitFlag + 1]) : undefined;
  if (limit !== undefined && (!Number.isInteger(limit) || limit <= 0)) {
    throw new Error("--limit must be a positive integer");
  }
  const resume = args.includes("--resume");
  const sourceDir = path.join(runsRoot, sourceRunId);
  if (!existsSync(sourceDir)) throw new Error(`Source run not found: ${sourceDir}`);

  const sourceBenchmark = JSON.parse(await readFile(path.join(sourceDir, "benchmark_data.json"), "utf8")) as Record<string, Record<string, unknown>>;
  const prDirs = (await readdir(sourceDir))
    .filter((name) => /^\d+__/.test(name))
    .sort((a, b) => Number.parseInt(a, 10) - Number.parseInt(b, 10));
  const goldenByDir = new Map<string, { url: string; entry: Record<string, unknown> }>();
  for (const prDir of prDirs) {
    const match = prDir.match(/^\d+__([^_]+)__(.+)__PR(\d+)$/);
    const resolved = match ? `https://github.com/${match[1]}/${match[2]}/pull/${match[3]}` : undefined;
    if (resolved && sourceBenchmark[resolved]) goldenByDir.set(prDir, { url: resolved, entry: sourceBenchmark[resolved] });
  }

  const requested = limit === undefined ? prDirs : prDirs.slice(0, limit);
  const selected = requested.filter((dir) =>
    goldenByDir.has(dir) &&
    existsSync(path.join(sourceDir, dir, "patch.diff")) &&
    existsSync(path.join(sourceDir, dir, "pr.json")),
  );
  const uniqueUrls = new Set(selected.map((dir) => goldenByDir.get(dir)!.url));
  if (
    selected.length !== requested.length ||
    uniqueUrls.size !== selected.length ||
    (limit === undefined && uniqueUrls.size !== Object.keys(sourceBenchmark).length)
  ) {
    throw new Error(`Resolved ${selected.length}/${requested.length} requested PRs (${uniqueUrls.size} unique URLs); refusing a partial mesh run`);
  }
  if (!selected.length) throw new Error("No PRs resolvable from source run");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const meshRunRoot = path.join(runsRoot, `mesh-${stamp}`);
  await mkdir(meshRunRoot, { recursive: true });
  // Isolate the mesh registry for this run (explicit COTAL_HOME wins; else a per-run sandbox dir).
  cotalHome = process.env.COTAL_HOME || path.join(meshRunRoot, ".cotal-home");
  mkdirSync(cotalHome, { recursive: true, mode: 0o700 });
  // The CLI's same-checkout guard compares the registry entry's root against cotalRoot(),
  // which walks UP from cwd for a `.cotal` dir. Without one at the repo root the walk lands
  // at ~/.cotal (home) and every spawn -f fails "belongs to a different checkout" — so make
  // sure the repo-root .cotal exists (it also keeps manager.pid/log inside this repo).
  mkdirSync(path.join(root, ".cotal"), { recursive: true });
  console.log(`Mesh run: ${meshRunRoot} (${selected.length} PRs, source ${sourceRunId})`);
  console.log(`COTAL_HOME (isolated registry): ${cotalHome}`);

  const broker = await startBroker(meshRunRoot);
  const shutdown = () => {
    // Best-effort synchronous kill of the shared manager, then the broker, so a Ctrl-C doesn't
    // orphan the last PR's detached manager or the broker.
    const pid = managerPid();
    if (pid !== undefined) { try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ } }
    try { broker.kill("SIGKILL"); } catch { /* already gone */ }
  };
  process.on("SIGINT", () => { shutdown(); process.exit(130); });
  process.on("SIGTERM", () => { shutdown(); process.exit(143); });

  const benchmarkData: Record<string, unknown> = {};
  const allCandidates: Record<string, Record<string, unknown[]>> = {};
  const manifest: RunManifest = { runId: `mesh-${stamp}`, sourceRunId, tool: toolName, prs: [] };
  let incomplete = 0;

  try {
    for (let index = 0; index < selected.length; index++) {
      const prDir = selected[index];
      const { url, entry } = goldenByDir.get(prDir)!;
      console.log(`[${index + 1}/${selected.length}] ${url}`);

      // Resume: reuse a prior mesh run's mesh-candidates.json for this PR if present.
      const cached = resume ? await loadCachedCandidates(prDir) : undefined;
      let result: PrResult;
      if (cached) {
        console.log(`  reusing cached candidates (${cached.length})`);
        result = { responded: 3, candidates: cached };
        await mkdir(path.join(meshRunRoot, prDir), { recursive: true });
        await writeFile(path.join(meshRunRoot, prDir, "mesh-candidates.json"), JSON.stringify(cached, null, 2));
      } else {
        try {
          result = await runOnePr(prDir, sourceDir, meshRunRoot, index);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          console.warn(`  mesh PR failed, skipping: ${prDir}: ${message}`);
          manifest.prs.push({ prDir, url, status: "failed", error: message });
          incomplete++;
          continue; // per-PR failure isolation
        }
      }

      if (result.responded < 3) incomplete++;
      manifest.prs.push({ prDir, url, status: result.responded < 3 ? "incomplete" : "ok", responded: result.responded, candidates: result.candidates.length });
      benchmarkData[url] = {
        ...entry,
        reviews: [{
          tool: toolName,
          repo_name: `mesh__${prDir}`,
          pr_url: url,
          review_comments: result.candidates.map((candidate) => ({
            path: candidate.path,
            line: candidate.line,
            body: `[${candidate.votes.map((vote) => vote.persona).join("+")}${candidate.severity ? ` ${candidate.severity}` : ""}] ${candidate.text}`,
            created_at: new Date().toISOString(),
          })),
        }],
      };
      allCandidates[url] = { [toolName]: result.candidates };
    }
  } finally {
    shutdown();
  }

  const offlineResults = path.join(offlineRoot, "results");
  await mkdir(offlineResults, { recursive: true });
  await writeFile(path.join(offlineResults, "benchmark_data.json"), JSON.stringify(benchmarkData, null, 2));
  const modelDir = path.join(offlineResults, sanitizeModelName(judgeModel));
  await mkdir(modelDir, { recursive: true });
  await writeFile(path.join(modelDir, "candidates.json"), JSON.stringify(allCandidates, null, 2));
  await writeFile(path.join(meshRunRoot, "benchmark_data.json"), JSON.stringify(benchmarkData, null, 2));
  await writeFile(path.join(meshRunRoot, "candidates.json"), JSON.stringify(allCandidates, null, 2));
  await writeFile(path.join(meshRunRoot, "run.json"), JSON.stringify(manifest, null, 2));
  console.log(JSON.stringify({ prs: selected.length, incomplete, runDir: meshRunRoot, note: "now run: COTAL_BENCH_TOOL=cotal-mesh pnpm judge:local" }, null, 2));
}

/** Find a prior mesh run's cached candidates for this PR dir (newest first), for --resume. */
async function loadCachedCandidates(prDir: string): Promise<Candidate[] | undefined> {
  const meshRuns = (await readdir(runsRoot)).filter((n) => n.startsWith("mesh-")).sort().reverse();
  for (const meshRun of meshRuns) {
    const candidatesPath = path.join(runsRoot, meshRun, prDir, "mesh-candidates.json");
    if (existsSync(candidatesPath)) {
      try {
        return JSON.parse(await readFile(candidatesPath, "utf8")) as Candidate[];
      } catch { /* corrupt cache; ignore and keep looking */ }
    }
  }
  return undefined;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
