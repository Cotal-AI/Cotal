/**
 * The run driver, against a real broker.
 *
 * Two claims, and the second is the one that is easy to get wrong. First, that a run driven to
 * completion, killed mid-flight and taken over by another driver performs each effect ONCE — the
 * resume replays the journal rather than the world. Second, that a driver which has lost the run
 * says so as `released` and never as a run result: a program whose journal refused an append has not
 * failed, and recording that it did would be the durability layer inventing an outcome.
 *
 * The handler here counts what it actually performed, which is the only way to tell a replayed
 * effect from a repeated one — a journal that looks right proves nothing if the world was touched
 * twice.
 *
 * Run: pnpm smoke:runtime-run-driver   (needs nats-server on PATH; part of smoke:ci)
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "@nats-io/transport-node";
import { jetstream, jetstreamManager } from "@nats-io/jetstream";
import { Kvm } from "@nats-io/kv";
import { isReachable, createEndpointStreams, activateRun, replayRunJournal } from "@cotal-ai/core";
import { SimHandler } from "@cotal-ai/lang";
import { startRun, driveRun, RunJournalStore } from "../src/index.js";
import { pickFreePort } from "./_free-port.js";

const SPACE = "wfjdrive";
const PORT = await pickFreePort();
const sd = mkdtempSync(join(tmpdir(), "cotal-wfjdrive-"));
const broker = spawn("nats-server", ["-js", "-sd", sd, "-p", String(PORT), "-a", "127.0.0.1"], { stdio: "ignore" });
const servers = `nats://127.0.0.1:${PORT}`;

let ok = 0, fail = 0;
const c = (n: string, v: boolean, extra?: unknown) => { if (v) { ok++; } else { fail++; console.log("  ✗ FAIL:", n, extra ?? ""); } };
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

const lease = (holder: string, epoch: number, fencingToken: number) => ({ holder, epoch, fencingToken });

/**
 * A drive attempt, with a THROW as a third observable outcome.
 *
 * The claim under test is that losing a run comes back as an answer rather than as an exception, so
 * a cell that let the exception escape would be asserting nothing — the suite would die instead of
 * failing, and the failure would name no claim.
 */
type Attempt = Awaited<ReturnType<typeof driveRun>> | { readonly status: "threw"; readonly reason: Error };
const attempt = async (p: Promise<Awaited<ReturnType<typeof driveRun>>>): Promise<Attempt> => {
  try { return await p; } catch (e) { return { status: "threw" as const, reason: e as Error }; }
};
const why = (a: Attempt) => (a.status === "completed" ? "completed" : a.reason.name);

/** A handler that COUNTS what it performed. A replayed effect must not reach it at all. */
class CountingHandler extends SimHandler {
  readonly performed: string[] = [];
  override async sleep(req: Parameters<SimHandler["sleep"]>[0], ctx: Parameters<SimHandler["sleep"]>[1]) {
    this.performed.push(`sleep:${req.duration}`);
    return await super.sleep(req, ctx);
  }
}

// A program is a top-level script, not a module: `export` is L1020.
const PROGRAM = `
await sleep("1h", { name: "first" });
await sleep("2h", { name: "second" });
`;

// ── 1) a run driven start to finish ───────────────────────────────────────────────────────────
{
  const handler = new CountingHandler();
  const out = await startRun(js, jsm, {
    space: SPACE, runId: "d-1", source: PROGRAM, lease: lease("m1", 1, 1), handler,
  });
  c("a started run completes", out.status === "completed",
    out.status === "released" ? out.reason.name : out.status);
  // Two logical entries, four durable records: the journal is keyed by STEP and each step is
  // written twice, pending then settled. The broker count below is the other half of that fact.
  c("its journal holds one entry per step, not one per append",
    out.status === "completed" && out.result.journal.entries().length === 2,
    out.status === "completed" ? out.result.journal.entries().length : "-");
  c("the handler performed each effect exactly once", handler.performed.join(",") === "sleep:1h,sleep:2h",
    handler.performed);
  const back = await replayRunJournal(js, jsm, SPACE, "d-1");
  c("and both phases of both steps are durable on the broker, not in the driver",
    back.records.filter((r) => r.record.kind === "step").length === 4,
    back.records.map((r) => r.record.kind));
}

// ── 2) a takeover REPLAYS the journal rather than the world ──────────────────────────────────
//
// The property durability exists for. A second driver resumes a run whose effects are all recorded
// and performs NONE of them again: the journal answers, the handler is never asked. A journal that
// merely looks right proves nothing here — the handler counts what it actually did.
{
  const second = new CountingHandler();
  const taken = await driveRun(js, jsm, {
    space: SPACE, runId: "d-1", source: PROGRAM, lease: lease("m2", 2, 2), handler: second,
  });
  c("a successor resumes a fully-journalled run to completion", taken.status === "completed",
    taken.status === "released" ? taken.reason.name : taken.status);
  c("and performs NOTHING again: every effect came back from the journal",
    second.performed.length === 0, second.performed);
  const back = await replayRunJournal(js, jsm, SPACE, "d-1");
  c("the resume wrote no duplicate steps either — only its activation",
    back.records.filter((r) => r.record.kind === "step").length === 4 &&
    back.records.filter((r) => r.record.kind === "activation").length === 2,
    back.records.map((r) => r.record.kind).join(","));
}

// ── 2b) a driver superseded MID-FLIGHT is released, and its program is not called failed ──────
//
// The first driver is held inside an effect while a newer lease takes the run. Its next append is
// refused, so the interpreter unwinds — and the answer that comes back must be `released`, because
// nothing here is a fact about the program. A driver that reported this as a run failure would be
// recording a conclusion about work it can no longer see.
{
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  class Blocking extends CountingHandler {
    override async sleep(req: Parameters<CountingHandler["sleep"]>[0], ctx: Parameters<CountingHandler["sleep"]>[1]) {
      const out = await super.sleep(req, ctx);
      if (this.performed.length === 1) await gate; // held inside the FIRST effect
      return out;
    }
  }
  const blocked = new Blocking();
  const started = startRun(js, jsm, {
    space: SPACE, runId: "d-2", source: PROGRAM, lease: lease("m1", 1, 1), handler: blocked,
  });
  await wait(300);
  const usurper = await activateRun(js, jsm, {
    space: SPACE, runId: "d-2", holder: "m2", fencingToken: 2, epoch: 2, at: 1, expect: "existing",
  });
  release();
  const firstOut = await attempt(started);
  c("the superseded driver is RELEASED, not completed and not thrown", firstOut.status === "released",
    why(firstOut));
  c("and it says so as a durability failure, which is what the journal actually reported",
    firstOut.status === "released" && firstOut.reason.name === "JournalAppendRejected",
    why(firstOut));
  c("the successor holds the run and can still write", (await usurper.append({ mine: true }, 1)) > 0);
}

// ── 3) the four ways a drive is not this driver's to make ─────────────────────────────────────
{
  const handler = new CountingHandler();
  const req = { space: SPACE, runId: "d-3", source: PROGRAM, handler };
  await startRun(js, jsm, { ...req, lease: lease("m1", 1, 5) });

  const restart = await attempt(startRun(js, jsm, { ...req, lease: lease("m1", 1, 6) }));
  c("starting a run that already has a journal is released, not silently re-run",
    restart.status === "released" && restart.reason.name === "RunAlreadyStarted",
    why(restart));

  const stale = await attempt(driveRun(js, jsm, { ...req, lease: lease("m9", 9, 1) }));
  c("driving on an older fencing token is released", stale.status === "released" &&
    stale.reason.name === "StaleLeaseToken", why(stale));

  const impostor = await attempt(driveRun(js, jsm, { ...req, lease: lease("m2", 2, 5) }));
  c("driving on another holder's current token is released", impostor.status === "released" &&
    impostor.reason.name === "ActivationNotAuthorized",
    why(impostor));

  const missing = await attempt(driveRun(js, jsm, {
    space: SPACE, runId: "d-3-never", source: PROGRAM, handler, lease: lease("m1", 1, 1),
  }));
  c("and resuming a run with no journal is released rather than started from scratch",
    missing.status === "released" && missing.reason.name === "RunNotResumable",
    why(missing));
  c("none of those touched the world", handler.performed.length === 2, handler.performed);
}

// ── 4) a program cannot CATCH the loss of its own journal ────────────────────────────────────
//
// The worst shape this lane can produce, and it was live: an ordinary `try { await sleep() } catch`
// swallowed the journal's refusal, the program went on to perform two more effects against the
// world, and the run returned normally — with nothing recorded from the refusal onward, so a resume
// would perform them all again. A cancellation was already uncatchable for the same reason. A run
// that cannot record must stop, and no catch block may decide otherwise.
{
  const CATCHER = `
try {
  await sleep("1h", { name: "first" });
} catch (e) {
  await sleep("2h", { name: "swallowed" });
}
await sleep("3h", { name: "after-the-catch" });
`;
  const handler = new CountingHandler();
  const out = await attempt(startRun(js, jsm, {
    space: SPACE, runId: "d-4", source: CATCHER, lease: lease("m1", 1, 1), handler,
  }));
  // Take the run away while the first effect is in flight? No — simpler and stricter: the run is
  // superseded before it starts its second effect, by a driver that just activates.
  c("a run whose journal is intact completes normally", out.status === "completed", why(out));

  // Hold the run INSIDE its first effect so the takeover lands mid-flight: a virtual-clock sleep
  // returns instantly, so without the gate the program is finished before anything can supersede it.
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  class Held extends CountingHandler {
    override async sleep(req: Parameters<CountingHandler["sleep"]>[0], ctx: Parameters<CountingHandler["sleep"]>[1]) {
      const out = await super.sleep(req, ctx);
      if (this.performed.length === 1) await gate;
      return out;
    }
  }
  const handler2 = new Held();
  const started = startRun(js, jsm, {
    space: SPACE, runId: "d-5", source: CATCHER, lease: lease("m1", 1, 1), handler: handler2,
  });
  await wait(300);
  await activateRun(js, jsm, {
    space: SPACE, runId: "d-5", holder: "m2", fencingToken: 2, epoch: 2, at: 1, expect: "existing",
  });
  release();
  const lost = await attempt(started);
  c("but a run that LOSES its journal is released, not caught and carried on", lost.status === "released",
    why(lost));
  c("and it stopped at the refusal rather than performing the catch block's effects",
    handler2.performed.length < 3, handler2.performed);

  // The sharper shape, and the one a dead appender MASKS: when the catch block performs no further
  // effect, nothing else tries to append, so a swallowed refusal is never re-raised and the run
  // returns NORMALLY — a driver reporting success over a journal missing the tail of its own run.
  // Losing the journal has to end the run by itself, not by whatever the program does next.
  const QUIET = `
try {
  await sleep("1h", { name: "first" });
} catch (e) {
}
`;
  let letGo!: () => void;
  const held = new Promise<void>((r) => { letGo = r; });
  class HeldOnce extends CountingHandler {
    override async sleep(req: Parameters<CountingHandler["sleep"]>[0], ctx: Parameters<CountingHandler["sleep"]>[1]) {
      const out = await super.sleep(req, ctx);
      await held;
      return out;
    }
  }
  const quiet = new HeldOnce();
  const running = startRun(js, jsm, {
    space: SPACE, runId: "d-5b", source: QUIET, lease: lease("m1", 1, 1), handler: quiet,
  });
  await wait(300);
  await activateRun(js, jsm, {
    space: SPACE, runId: "d-5b", holder: "m2", fencingToken: 2, epoch: 2, at: 1, expect: "existing",
  });
  letGo();
  const quietOut = await attempt(running);
  c("a run whose catch block is EMPTY still cannot report success over a journal it lost",
    quietOut.status === "released", why(quietOut));
}

// ── 5) a journal belongs to ONE run, at both ends ────────────────────────────────────────────
//
// The keys are structural, so another run's entry with the same scope and name MATCHES. A journal
// crossed with the wrong run does not mislabel anything — it returns another run's recorded results
// as this run's own, and a PubAck on one run's subject makes the other's journal say "durable".
{
  const a = await activateRun(js, jsm, {
    space: SPACE, runId: "d-6", holder: "m1", fencingToken: 1, epoch: 1, at: 1, expect: "new",
  });
  const store = new RunJournalStore(a);
  let crossed: unknown;
  try {
    await store.append({
      v: 1, seq: 0, run: "SOME-OTHER-RUN", scope: "", kind: "sleep", name: "x", occurrence: 0,
      inputHash: "h", state: "pending", startedAt: 1,
    } as never);
  } catch (e) { crossed = e; }
  c("a store refuses an entry that belongs to another run", crossed instanceof Error,
    (crossed as Error)?.message?.slice(0, 60));
  const back = await replayRunJournal(js, jsm, SPACE, "d-6");
  c("and nothing of it reached this run's subject",
    back.records.filter((r) => r.record.kind === "step").length === 0);
}

console.log(`run-driver.smoke: ${ok} passed, ${fail} failed`);
done();
process.exit(fail === 0 ? 0 : 1);
