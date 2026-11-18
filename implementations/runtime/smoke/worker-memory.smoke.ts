/**
 * A workflow run's memory is bounded, and reaching the bound ends the run and never the process,
 * through the `cotal` binary's `run start --local` against a real broker.
 *
 * The compiled engine runs each program in its own worker thread, created with a fixed heap limit.
 * A thread that reaches the limit is ended by node and its run fails; the process carries on. That
 * holds only while the heap grows in steps the collector sees coming: one very large allocation
 * made near the limit ends the whole process instead. So the language also bounds every array and
 * string a program builds, and a value over the bound is refused (L4016) before it is built.
 *
 * Every start runs in its own child process, so a process that ends shows as its exit code and
 * signal instead of ending this suite.
 *
 * Cells:
 *   1. control: a program building a few megabytes completes, exit 0;
 *   2. a process started with a V8 heap flag that replaces the thread's limit refuses to run a
 *      program at all, naming the heap limit; the control is every other cell, which runs under no
 *      such flag and whose thread therefore reports the engine's own limits;
 *   3. four `range(30000000)` calls are refused L4016 naming `range`, the start fails, and the
 *      process exits on its own rather than aborting;
 *   4. doubling an array by spread until it is too large is refused the same way;
 *   5. a string over the bound is refused L4016 naming `repeat`;
 *   6. the largest allowed `range`, repeated until the heap limit, fails the run at the memory limit
 *      and the process exits on its own;
 *   7. the same for the largest allowed two-byte string;
 *   8. that run's record says failed, naming the memory limit;
 *   9. a record built field by field in a loop is stopped by the step budget (L4013) at a size well
 *      under the one that ends the process.
 *
 * Run: pnpm smoke:runtime-worker-memory   (needs nats-server on PATH and a built `bin/dist`)
 */
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { connect } from "@nats-io/transport-node";
import {
  isReachable, createSpaceAuth, serverConfig, setupSpaceStreams, mintCreds, newIdentity, standaloneConnectOpts,
  openRecordsBucket, readRunRecord,
} from "@cotal-ai/core";
import { authDir, recordMesh, saveSpaceAuth } from "@cotal-ai/workspace";
import { pickFreePort } from "./_free-port.js";
import { SMOKE_BROKER_TOKEN, emitSentinel, teardownOnSignal } from "@cotal-ai/smoke-kit";

const COTAL = fileURLToPath(new URL("../../../bin/dist/cotal.js", import.meta.url));
const home = mkdtempSync(join(tmpdir(), "cotal-wmem-home-"));
for (const k of Object.keys(process.env)) if (k.startsWith("COTAL_")) delete process.env[k];
process.env.COTAL_HOME = home;

const SPACE = "wmem";
const PORT = await pickFreePort();
const sd = mkdtempSync(join(tmpdir(), `${SMOKE_BROKER_TOKEN}wmem-`));
const auth = await createSpaceAuth(SPACE);
writeFileSync(join(sd, "server.conf"), serverConfig(auth, [auth], { transport: { kind: "plaintext" }, port: PORT, storeDir: join(sd, "js") }));
const broker = spawn("nats-server", ["-c", join(sd, "server.conf")], { stdio: "ignore" });
teardownOnSignal(broker);
const servers = `nats://127.0.0.1:${PORT}`;
const root = mkdtempSync(join(tmpdir(), "cotal-wmem-root-"));

const DECLARED = 9;
let ok = 0, fail = 0;
const c = (n: string, v: boolean, extra?: unknown) => { if (v) { ok++; } else { fail++; console.error("  ✗ FAIL:", n, extra ?? ""); } };
const done = () => {
  try { broker.kill("SIGKILL"); } catch { /* already gone */ }
  for (const d of [sd, home, root]) rmSync(d, { recursive: true, force: true });
};
process.on("exit", done);

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
let up = false;
for (let i = 0; i < 60 && !up; i += 1) {
  up = await isReachable(servers, { creds: await mintCreds(auth, newIdentity(), "probe") }).catch(() => false);
  if (!up) await wait(100);
}
if (!up) throw new Error(`nats-server did not come up on ${PORT}`);
await setupSpaceStreams({ servers, space: SPACE, creds: await mintCreds(auth, newIdentity(), "provisioner") });
mkdirSync(join(root, ".cotal"), { recursive: true });
saveSpaceAuth(authDir(root), auth);
recordMesh({ space: SPACE, server: servers, root, mode: "auth", ts: new Date().toISOString() });

const EP = "manager";
const record = async (runId: string) => {
  const creds = await mintCreds(auth, newIdentity(), "run-operator", { runOperator: { endpoint: EP, runId, takeoverId: "t1" } });
  const nc = await connect({ servers, ...standaloneConnectOpts({ creds, tls: false }), maxReconnectAttempts: 0 });
  try { return await readRunRecord(await openRecordsBucket(nc, SPACE), EP, runId); } finally { await nc.drain().catch(() => {}); }
};

interface Started { code: number | null; signal: NodeJS.Signals | null; out: string; runId: string }
/** `cotal run start <file> --local` in its own process, as an operator types it. Any heap flag the
 *  suite was started with is dropped, so each run gets the engine's own limits unless `nodeOptions`
 *  says otherwise. */
const start = (name: string, source: string, nodeOptions?: string): Promise<Started> => {
  const file = join(sd, `${name}.cotal.js`);
  writeFileSync(file, source);
  const child = spawn(process.execPath, [COTAL, "run", "start", file, "--local", "--admit-read", "none", "--admit-publish", "none", "--space", SPACE, "--server", servers],
    { cwd: root, env: { ...process.env, COTAL_SKIP_CONNECTOR_SEED: "1", NODE_OPTIONS: nodeOptions ?? "" }, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stdout.on("data", (d: Buffer) => { out += d.toString(); });
  child.stderr.on("data", (d: Buffer) => { out += d.toString(); });
  return new Promise((resolve) => child.once("exit", (code, signal) =>
    resolve({ code, signal, out, runId: /starting run (run-[0-9a-f]+)/.exec(out)?.[1] ?? "" })));
};
/** The process ended on its own with the CLI's failure code: no signal, no V8 abort. */
const exitedOnItsOwn = (r: Started) => r.signal === null && r.code !== null && r.code !== 134 && !r.out.includes("FATAL ERROR");
/** The failure the run record keeps whole; the start's own report carries only the code's title. */
const failureOf = async (r: Started) => (r.runId === "" ? "" : (await record(r.runId))?.status?.value.failure?.message ?? "");

// ── 1) control ───────────────────────────────────────────────────────────────────────────────
{
  const r = await start("small", 'const xs = [];\nfor (let i = 0; i < 20; i += 1) {\n  xs.push(range(10000));\n}\nlog("built", len(xs));\n');
  c("a program building a few megabytes completes, exit 0", r.code === 0 && r.out.includes(`run ${r.runId}: completed`), r);
}

// ── 2) the heap limit itself ─────────────────────────────────────────────────────────────────
// A V8 heap flag on the process replaces the limits a thread is created with. The engine thread
// checks the limits it reports before any run exists, so a replaced limit refuses the run instead of
// running it unbounded. Every other cell runs with no flag and gets past this check, so they read the
// same check from the other side.
{
  const r = await start("heap", 'log("ran");\n', "--max-old-space-size=4096");
  c("a process whose heap flag replaces the engine thread's limit refuses to run the program, naming the limit",
    r.code !== 0 && !r.out.includes("log ran") && r.out.includes("heap limit is") && exitedOnItsOwn(r), { code: r.code, signal: r.signal, out: r.out.slice(-600) });
}

// ── 3) four very large ranges ────────────────────────────────────────────────────────────────
{
  const r = await start("ranges", "const a = range(30000000);\nconst b = range(30000000);\nconst c = range(30000000);\nconst d = range(30000000);\n");
  c("four range(30000000) calls are refused L4016 naming range, and the process exits on its own",
    r.code !== 0 && r.out.includes("L4016") && /range: an array of 30000000 elements/.test(await failureOf(r)) && exitedOnItsOwn(r), { code: r.code, signal: r.signal, out: r.out.slice(-400) });
}

// ── 4) doubling by spread ────────────────────────────────────────────────────────────────────
{
  const r = await start("doubling", "let xs = [1];\nconst keep = [];\nwhile (true) {\n  xs = [...xs, ...xs];\n  keep.push(xs);\n}\n");
  c("doubling an array by spread is refused L4016 at the array literal, and the process exits on its own",
    r.code !== 0 && r.out.includes("L4016") && /this array literal: an array of \d+ elements/.test(await failureOf(r)) && exitedOnItsOwn(r), { code: r.code, signal: r.signal, out: r.out.slice(-400) });
}

// ── 5) a string over the bound ───────────────────────────────────────────────────────────────
{
  const r = await start("repeat", 'const s = "ab".repeat(30000000);\n');
  c("a string over the bound is refused L4016 naming repeat", r.code !== 0 && r.out.includes("L4016") && /repeat: a string of 60000000 units/.test(await failureOf(r)) && exitedOnItsOwn(r), { code: r.code, out: r.out.slice(-400) });
}

// ── 6, 7, 8) the largest allowed values, repeated until the limit ───────────────────────────
let lastLimited = "";
{
  const r = await start("max-range", "const keep = [];\nwhile (true) {\n  keep.push(range(1000000));\n}\n");
  c("the largest allowed range, repeated, fails the run at the memory limit and the process exits on its own",
    r.code !== 0 && r.out.includes("memory limit of 512 MB") && exitedOnItsOwn(r), { code: r.code, signal: r.signal, out: r.out.slice(-400) });
}
{
  const r = await start("max-string", 'const keep = [];\nlet i = 0;\nwhile (true) {\n  keep.push("\\u0101".repeat(3999990) + `${i}`);\n  i += 1;\n}\n');
  lastLimited = r.runId;
  c("the largest allowed two-byte string, repeated, fails the run at the memory limit and the process exits on its own",
    r.code !== 0 && r.out.includes("memory limit of 512 MB") && exitedOnItsOwn(r), { code: r.code, signal: r.signal, out: r.out.slice(-400) });
}
{
  const status = (await record(lastLimited))?.status?.value;
  c("that run is recorded failed with a message naming the engine's memory limit",
    status?.state === "failed" && /memory limit of 512 MB/.test(status.failure?.message ?? ""), status);
}

// ── 9) a record built field by field ───────────────────────────────────────────────────────────
// No builtin is involved, so no size bound applies; under the default pins the step budget ends the
// walk first. Records of 500,000 fields never ended the process in measurement.
{
  const r = await start("fields", 'const o = {};\nlet i = 0;\nwhile (true) {\n  o[`k${i}`] = i;\n  i += 1;\n}\n');
  c("a record built field by field is stopped by the step budget (L4013), and the process exits on its own",
    r.code !== 0 && r.out.includes("L4013") && exitedOnItsOwn(r), { code: r.code, signal: r.signal, out: r.out.slice(-400) });
}

console.log(`worker-memory: ${ok} ok, ${fail} failed`);
emitSentinel({ passed: ok, failed: fail, cells: DECLARED });
if (ok + fail !== DECLARED) {
  console.log(`SUITE INCOMPLETE: ran ${ok + fail} of ${DECLARED} cells; a partial run is not a pass`);
  process.exit(1);
}
process.exit(fail === 0 ? 0 : 1);
