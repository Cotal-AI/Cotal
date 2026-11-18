/**
 * A workflow run's memory is bounded by its engine thread, through `cotal run start --local`
 * against a real broker.
 *
 * The compiled engine runs each program in its own worker thread. That thread is created with a
 * fixed heap limit, so a program that allocates without bound is stopped when it reaches the limit,
 * the run is recorded failed with a message naming the limit, and the driver's process carries on.
 *
 * Cells:
 *   1. control: a program that builds a few megabytes of arrays completes;
 *   2. a program that allocates without bound ends its start with a failure, and the host
 *      process's resident memory stays under a ceiling the whole time;
 *   3. its run record says failed, with a message naming the engine's memory limit;
 *   4. the same process then starts another run, which completes.
 *
 * Run: pnpm smoke:runtime-worker-memory   (needs nats-server on PATH)
 */
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "@nats-io/transport-node";
import {
  isReachable, createSpaceAuth, serverConfig, setupSpaceStreams, mintCreds, newIdentity, standaloneConnectOpts,
  openRecordsBucket, readRunRecord,
} from "@cotal-ai/core";
import { authDir, recordMesh, saveSpaceAuth } from "@cotal-ai/workspace";
import { runWorkflow } from "../src/index.js";
import { pickFreePort } from "./_free-port.js";
import { SMOKE_BROKER_TOKEN, emitSentinel, teardownOnSignal } from "@cotal-ai/smoke-kit";

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

const DECLARED = 4;
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

const LOGS: string[] = [];
const origLog = console.log;
console.log = (...a: unknown[]) => { LOGS.push(a.map(String).join(" ")); };
const captured = () => LOGS.join("\n");
const startedId = () => /starting run (run-[0-9a-f]+) on endpoint/.exec(captured())?.[1] ?? "";
const start = async (file: string): Promise<unknown> => {
  LOGS.length = 0;
  process.exitCode = undefined;
  try {
    await runWorkflow({ values: { server: servers, space: SPACE, local: true, file, "admit-read": "none", "admit-publish": "none" }, positionals: ["start"], raw: [] });
    return undefined;
  } catch (e) {
    return e;
  }
};

const SMALL = join(sd, "small.cotal.js");
writeFileSync(SMALL, 'const xs = [];\nfor (let i = 0; i < 20; i += 1) {\n  xs.push(range(10000));\n}\nlog("built", len(xs));\n');
const UNBOUNDED = join(sd, "unbounded.cotal.js");
writeFileSync(UNBOUNDED, "const xs = [];\nwhile (true) {\n  xs.push(range(100000));\n}\n");

// ── 1) control ───────────────────────────────────────────────────────────────────────────────
{
  const error = await start(SMALL);
  const id = startedId();
  c("a program building a few megabytes of arrays completes", error === undefined && captured().includes(`run ${id}: completed`), error ?? captured());
}

// ── 2) a program that allocates without bound ────────────────────────────────────────────────
// The heap limit is far below this ceiling and the host's own heap is a small part of it. Without a
// limit the thread grows to the process's own heap size, so crossing the ceiling fails the cell and
// ends the suite before the host is pushed further.
const CEILING_MB = 2048;
let peakMb = 0;
const sampler = setInterval(() => {
  const mb = process.memoryUsage().rss / 1048576;
  if (mb > peakMb) peakMb = mb;
  if (mb > CEILING_MB) {
    c(`the host process stays under ${CEILING_MB} MB resident while the run allocates`, false, { rssMb: Math.round(mb) });
    console.log = origLog;
    console.log(`worker-memory: ${ok} ok, ${fail} failed`);
    emitSentinel({ passed: ok, failed: fail, cells: DECLARED });
    process.exit(1);
  }
}, 25);
const failed = await start(UNBOUNDED);
clearInterval(sampler);
const unboundedId = startedId();
c(`the start fails and the host process stays under ${CEILING_MB} MB resident while the run allocates`,
  failed instanceof Error && peakMb < CEILING_MB, { failed: (failed as Error | undefined)?.message?.slice(0, 200), peakMb: Math.round(peakMb) });

// ── 3) the run record names the limit ───────────────────────────────────────────────────────
{
  const rec = await record(unboundedId);
  const status = rec?.status?.value;
  c("the run is recorded failed with a message naming the engine's memory limit",
    status?.state === "failed" && /memory limit of \d+ MB/.test(status.failure?.message ?? ""), status);
}

// ── 4) the host carries on ───────────────────────────────────────────────────────────────────
{
  const error = await start(SMALL);
  const id = startedId();
  c("the same process starts another run, which completes", error === undefined && captured().includes(`run ${id}: completed`), error ?? captured());
}

console.log = origLog;
console.log(`worker-memory: ${ok} ok, ${fail} failed (peak resident ${Math.round(peakMb)} MB)`);
emitSentinel({ passed: ok, failed: fail, cells: DECLARED });
if (ok + fail !== DECLARED) {
  console.log(`SUITE INCOMPLETE: ran ${ok + fail} of ${DECLARED} cells; a partial run is not a pass`);
  process.exit(1);
}
process.exit(fail === 0 ? 0 : 1);
