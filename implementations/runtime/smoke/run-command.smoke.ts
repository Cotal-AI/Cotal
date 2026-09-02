/**
 * `cotal run`, against a real broker.
 *
 * The command layer is thin on purpose — every verb is composition over exports the other suites
 * already prove — so what THIS suite tests is the composition: that the values/positionals a
 * dispatcher hands `runWorkflow` reach a broker as a start, a resume, a listing, a journal render,
 * and a checkpoint answer, through the command's own connection (the raw `--server` + unregistered
 * `--space` escape hatch, the same one `spawn-from-anywhere` proves for the CLI).
 *
 * Run ids are minted by the driver, never supplied (the records table forbids caller-supplied
 * ids), so the suite learns each id the way an operator does: from the `starting run <id>` line.
 *
 * A mesh sleep needs the mediated timer writer, which is the delivery daemon's loop and not the
 * command's, so the completing program here is pure and the durable effect exercised end-to-end is
 * a checkpoint — its resolve path needs no timer.
 *
 * Run: pnpm smoke:runtime-run-command   (needs nats-server on PATH; part of smoke:ci)
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "@nats-io/transport-node";
import { jetstreamManager, jetstream } from "@nats-io/jetstream";
import { Kvm } from "@nats-io/kv";
import { isReachable, createEndpointStreams, replayRunJournal, openRecordsBucket, readRunRecord } from "@cotal-ai/core";
import type { JournalEntry } from "@cotal-ai/lang";
import { runWorkflow } from "../src/index.js";
import { pickFreePort } from "./_free-port.js";

const SPACE = "wfjcmd";
const PORT = await pickFreePort();
const sd = mkdtempSync(join(tmpdir(), "cotal-wfjcmd-"));
const broker = spawn("nats-server", ["-js", "-sd", sd, "-p", String(PORT), "-a", "127.0.0.1"], { stdio: "ignore" });
const servers = `nats://127.0.0.1:${PORT}`;

let ok = 0, fail = 0;
const c = (n: string, v: boolean, extra?: unknown) => { if (v) { ok++; } else { fail++; console.error("  ✗ FAIL:", n, extra ?? ""); } };
const done = () => {
  try { broker.kill("SIGKILL"); } catch { /* already gone */ }
  rmSync(sd, { recursive: true, force: true });
};
process.on("exit", done);

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
let up = false;
for (let i = 0; i < 60 && !up; i += 1) { up = await isReachable(servers); if (!up) await wait(100); }
if (!up) throw new Error(`nats-server did not come up on ${PORT}`);
const nc = await connect({ servers });
const jsm = await jetstreamManager(nc);
const js = jetstream(nc);
await createEndpointStreams(jsm, new Kvm(nc), SPACE);
const kv = await openRecordsBucket(nc, SPACE);
const EP = "manager";
let takeovers = 100;

// The command prints to console.log; the suite reads what an operator would read.
const LOGS: string[] = [];
const origLog = console.log;
console.log = (...a: unknown[]) => { LOGS.push(a.map(String).join(" ")); };
const captured = () => LOGS.join("\n");
const reset = () => { LOGS.length = 0; process.exitCode = undefined; };
/** The minted id, read from the `starting run <id>` line exactly as an operator would. */
const startedId = () => /starting run (run-[0-9a-f]+) on endpoint/.exec(captured())?.[1];

/** One command invocation, as the dispatcher would hand it over. */
const wf = (positionals: string[], values: Record<string, string | boolean | undefined> = {}) =>
  runWorkflow({ values: { server: servers, space: SPACE, ...values }, positionals, raw: [] });

const PURE = join(sd, "pure.cotal.js");
writeFileSync(PURE, 'const xs = [1, 2, 3];\nlog("doubled", xs.map((x) => x * 2));\n');
// `conclave` is still on the not-yet-durable seam (`spawn` itself now performs, so it no longer
// refuses); when the conclave substrate lands this program moves to whatever the seam still holds,
// and when the seam empties the block that drives it goes with it.
const REFUSING = join(sd, "refusing.cotal.js");
writeFileSync(REFUSING, 'await conclave([], async (room) => { return 1; }, { name: "huddle" });\n');
const CHECKPOINT = join(sd, "checkpoint.cotal.js");
writeFileSync(CHECKPOINT, 'const d = await checkpoint("approve", "Ship it?");\nlog("resolved", d.status);\n');

// ── 1) start: a pure program completes through the command, under a minted id ────────────────
let P = "";
{
  reset();
  await wf(["start"], { file: PURE });
  P = startedId() ?? "";
  c("start mints and announces the run id", P !== "", captured());
  c("start drives a pure program to completion", captured().includes(`run ${P}: completed`), captured());
  c("a completing start leaves the exit code alone", process.exitCode === undefined, process.exitCode);
  const rec = await readRunRecord(kv, EP, P);
  c("and the run record says completed", rec?.status?.value.state === "completed", rec?.status?.value.state);
}

// ── 2) ps: the listing shows the record ──────────────────────────────────────────────────────
{
  reset();
  await wf(["ps"]);
  c("ps lists the run", captured().includes(P), captured());
  c("with its state", captured().includes("completed"), captured());
}

// ── 3) journal: the durable records render ───────────────────────────────────────────────────
{
  reset();
  await wf(["journal", P]);
  c("journal prints the activation", captured().includes("activation"), captured());
}

// ── 4) resume: a completed run replays to the same completion ────────────────────────────────
{
  reset();
  await wf(["resume", P], { file: PURE });
  c("resume replays a completed run to completed", captured().includes(`run ${P}: completed`), captured());
}

// ── 5) a refused effect holds the run, and the command says so ───────────────────────────────
let H = "";
{
  reset();
  await wf(["start"], { file: REFUSING });
  H = startedId() ?? "";
  c("a refused effect reports released", H !== "" && captured().includes(`run ${H}: released`), captured());
  c("names RunHeld", captured().includes("RunHeld"), captured());
  c("and tells the operator what a hold means", captured().includes("held"), captured());
  c("a held start exits nonzero", process.exitCode === 2, process.exitCode);
  reset();
  await wf(["journal", H]);
  c("its journal shows the step settled refused with the crossing code", captured().includes("refused (L5016)"), captured());
}

// ── 6) answer: an open checkpoint is resolved through the command ────────────────────────────
{
  reset();
  const driven = wf(["start"], { file: CHECKPOINT });
  let C: string | undefined;
  for (let i = 0; i < 100 && C === undefined; i += 1) { await wait(50); C = startedId(); }
  c("the driven start announces its minted id before settling", C !== undefined, captured());
  const cid = C ?? "";
  let open = false;
  for (let i = 0; i < 100 && !open; i += 1) {
    await wait(200);
    const back = await replayRunJournal(js, jsm, SPACE, cid, `t${(takeovers += 1)}`).catch(() => undefined);
    for (const r of back?.records ?? []) {
      if (r.record.kind !== "step") continue;
      const e = r.record.entry as JournalEntry;
      if (e.kind === "checkpoint" && e.state === "pending") open = true;
    }
  }
  c("the checkpoint opens durably", open);
  // A THROW here must fail the cell rather than kill the suite: the holder-bound presenter is the
  // load-bearing part of `answer`, and a suite that dies names no claim.
  const answered = await wf(["answer", cid, "/checkpoint:approve#0"], { by: "smoke", value: '"yes"' })
    .then(() => true, (e: Error) => e);
  c("answer presents as the arming holder and is accepted", answered === true, answered);
  c("and reports the resumed settle", captured().includes('"settle": "resumed"'), captured());
  // Bounded on purpose: a refused answer leaves the run paused forever, and a suite that awaits it
  // unconditionally HANGS on that defect instead of failing on it. A hang is not a red.
  const outcome = await Promise.race([driven.then(() => "completed"), wait(15_000).then(() => "still-paused")]);
  c("and the held start completes", outcome === "completed" && captured().includes(`run ${cid}: completed`), outcome);
}

// ── 6b) a parked run survives its driver dying: a fresh holder's resume attaches and completes ─
//
// The strand measured through the real binary before the repair: every invocation mints its own
// holder, so a resume of a checkpoint-parked run re-minted the pause under it, the plane refused
// ("a token is minted once"), and the interpreter journalled the refusal as the step's own
// failure — ONE resume stranded the run with `failed (L4000)` and a record blaming the program.
// Here the start's driver is simply abandoned (in the real repro the process died), a second
// invocation resumes under its own fresh holder, and the answer arrives after that.
{
  reset();
  // The abandoned driver: superseded by the resume below, its settle append is refused and it
  // reports released — the in-process crash shape, and not this section's claim.
  const orphan = wf(["start"], { file: CHECKPOINT }).catch(() => undefined);
  let C2: string | undefined;
  for (let i = 0; i < 100 && C2 === undefined; i += 1) { await wait(50); C2 = startedId(); }
  const cid = C2 ?? "";
  let open = false;
  for (let i = 0; i < 100 && !open; i += 1) {
    await wait(200);
    const back = await replayRunJournal(js, jsm, SPACE, cid, `t${(takeovers += 1)}`).catch(() => undefined);
    for (const r of back?.records ?? []) {
      if (r.record.kind !== "step") continue;
      const e = r.record.entry as JournalEntry;
      if (e.kind === "checkpoint" && e.state === "pending") open = true;
    }
  }
  reset();
  const resumed = wf(["resume", cid], { file: CHECKPOINT });
  // Give the attach time to reach the plane, then grade what it did NOT do: no step settled
  // failed, and the recorded pause still open under its original mint.
  await wait(1_500);
  const back = await replayRunJournal(js, jsm, SPACE, cid, `t${(takeovers += 1)}`);
  const failedSteps = back.records.filter((r) => r.record.kind === "step"
    && (r.record.entry as JournalEntry).state !== "pending"
    && (r.record.entry as JournalEntry).status === "failed");
  c("a fresh holder's resume of a parked run strands nothing: no step settles failed", open && failedSteps.length === 0, failedSteps.length);
  const answered = await wf(["answer", cid, "/checkpoint:approve#0"], { by: "smoke", value: '"go"' })
    .then(() => true, (e: Error) => e);
  c("the answer is accepted with no holder supplied: the resolver reads the arming holder off the record", answered === true, answered);
  const outcome = await Promise.race([resumed.then(() => "completed"), wait(15_000).then(() => "still-paused")]);
  c("and the RESUME completes the run under its own holder", outcome === "completed" && captured().includes(`run ${cid}: completed`), outcome);
  // Bounded like the raced completions above: when every answer is refused, the abandoned driver
  // never resolves, and a suite that awaits it unconditionally HANGS on that defect. On the green
  // path it has already settled (its superseded append reports released).
  await Promise.race([orphan, wait(15_000)]);
  const rec = await readRunRecord(kv, EP, cid);
  c("the record ends completed, never failed", rec?.status?.value.state === "completed", rec?.status?.value.state);
}

// ── 7) the takeover barrier through the command ──────────────────────────────────────────────
// Two concurrent drives of one run derive the same fencing token and epoch from the same record
// read, so only the holder id can tell them apart; the activation barrier relaxes the exact
// (token, holder, epoch) tuple as one process picking its own run back up. The defect shape is a
// CONSTANT holder id, under which both drives co-activate through that relaxation — and its
// durable signature is two activation records sharing one fencing token. The cell asserts the
// journal invariant rather than which promise lost, because a lost race is a legitimate takeover
// (higher token) while a shared token is impossible by design.
{
  reset();
  for (let k = 0; k < 5; k += 1) {
    await Promise.allSettled([
      wf(["resume", P], { file: PURE }).catch(() => undefined),
      wf(["resume", P], { file: PURE }).catch(() => undefined),
    ]);
  }
  const back = await replayRunJournal(js, jsm, SPACE, P, `t${(takeovers += 1)}`);
  const tokens = back.records
    .filter((r) => r.record.kind === "activation")
    .map((r) => (r.record as { fencingToken: number }).fencingToken);
  const duplicated = tokens.filter((t, i) => tokens.indexOf(t) !== i);
  c("concurrent drives never co-activate: every activation token is held exactly once", duplicated.length === 0, { tokens, duplicated });
  c("and the concurrent drives did drive: activations advanced past the original", tokens.length > 2, tokens);
}

// The sentinel: a skipped block above would exit green while running fewer cells than the suite
// declares, and a count is the only reader that can see that.
const DECLARED = 24;
if (ok + fail !== DECLARED) {
  fail += 1;
  console.error(`  ✗ FAIL: the suite declares ${DECLARED} cells but ran ${ok + fail - 1}`);
}

console.log = origLog;
console.log(`run-command: ${ok} ok, ${fail} failed`);
await nc.drain().catch(() => {});
process.exit(fail === 0 ? 0 : 1);
