/**
 * `cotal run`, against a real broker.
 *
 * The command layer is thin on purpose — every verb is composition over exports the other suites
 * already prove — so what THIS suite tests is the composition: that the values/positionals a
 * dispatcher hands `runWorkflow` reach a broker as a start, a resume, a listing, a journal render,
 * and a checkpoint answer, through the command's own connection (the raw `--server` + unregistered
 * `--space` escape hatch, the same one `spawn-from-anywhere` proves for the CLI).
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

/** One command invocation, as the dispatcher would hand it over. */
const wf = (positionals: string[], values: Record<string, string | boolean | undefined> = {}) =>
  runWorkflow({ values: { server: servers, space: SPACE, ...values }, positionals, raw: [] });

const PURE = join(sd, "pure.cotal.js");
writeFileSync(PURE, 'const xs = [1, 2, 3];\nlog("doubled", xs.map((x) => x * 2));\n');
const REFUSING = join(sd, "refusing.cotal.js");
writeFileSync(REFUSING, 'await spawn("builder");\n');
const CHECKPOINT = join(sd, "checkpoint.cotal.js");
writeFileSync(CHECKPOINT, 'const d = await checkpoint("approve", "Ship it?");\nlog("resolved", d.status);\n');

// ── 1) start: a pure program completes through the command ───────────────────────────────────
{
  reset();
  await wf(["start"], { file: PURE, run: "p-1" });
  c("start drives a pure program to completion", captured().includes("run p-1: completed"), captured());
  c("a completing start leaves the exit code alone", process.exitCode === undefined, process.exitCode);
  const rec = await readRunRecord(kv, EP, "p-1");
  c("and the run record says completed", rec?.status?.value.state === "completed", rec?.status?.value.state);
}

// ── 2) ps: the listing shows the record ──────────────────────────────────────────────────────
{
  reset();
  await wf(["ps"]);
  c("ps lists the run", captured().includes("p-1"), captured());
  c("with its state", captured().includes("completed"), captured());
}

// ── 3) journal: the durable records render ───────────────────────────────────────────────────
{
  reset();
  await wf(["journal", "p-1"]);
  c("journal prints the activation", captured().includes("activation"), captured());
}

// ── 4) resume: a completed run replays to the same completion ────────────────────────────────
{
  reset();
  await wf(["resume", "p-1"], { file: PURE });
  c("resume replays a completed run to completed", captured().includes("run p-1: completed"), captured());
}

// ── 5) a refused effect holds the run, and the command says so ───────────────────────────────
{
  reset();
  await wf(["start"], { file: REFUSING, run: "h-1" });
  c("a refused effect reports released", captured().includes("run h-1: released"), captured());
  c("names RunHeld", captured().includes("RunHeld"), captured());
  c("and tells the operator what a hold means", captured().includes("held"), captured());
  c("a held start exits nonzero", process.exitCode === 2, process.exitCode);
  reset();
  await wf(["journal", "h-1"]);
  c("its journal shows the step settled refused with the crossing code", captured().includes("refused (L5016)"), captured());
}

// ── 6) answer: an open checkpoint is resolved through the command ────────────────────────────
{
  reset();
  const driven = wf(["start"], { file: CHECKPOINT, run: "c-1" });
  let open = false;
  for (let i = 0; i < 100 && !open; i += 1) {
    await wait(200);
    const back = await replayRunJournal(js, jsm, SPACE, "c-1", `t${(takeovers += 1)}`).catch(() => undefined);
    for (const r of back?.records ?? []) {
      if (r.record.kind !== "step") continue;
      const e = r.record.entry as JournalEntry;
      if (e.kind === "checkpoint" && e.state === "pending") open = true;
    }
  }
  c("the checkpoint opens durably", open);
  // A THROW here must fail the cell rather than kill the suite: the holder-bound presenter is the
  // load-bearing part of `answer`, and a suite that dies names no claim.
  const answered = await wf(["answer", "c-1", "/checkpoint:approve#0"], { by: "smoke", value: '"yes"' })
    .then(() => true, (e: Error) => e);
  c("answer presents as the arming holder and is accepted", answered === true, answered);
  c("and reports the resumed settle", captured().includes('"settle": "resumed"'), captured());
  await driven;
  c("and the held start completes", captured().includes("run c-1: completed"), captured());
}

console.log = origLog;
console.log(`run-command: ${ok} ok, ${fail} failed`);
await nc.drain().catch(() => {});
process.exit(fail === 0 ? 0 : 1);
