/**
 * `checkpoint` on the real planes: a program pauses, a person answers through the run driver, and
 * the answer the program reads is the one the arbiter accepted.
 *
 * The load-bearing cell is the RACE. A workflow checkpoint's holder is the run driver, and every
 * resolver reaches it through `resolveCheckpoint`, so every presenter is the SAME principal — which
 * means an answer cannot be matched back to the winning settlement by who presented it. Two
 * resolvers answering at once must therefore end with the program reading the winner's value and
 * not the last one written, and that property is exactly what the `(token, answerId)` key and the
 * `answerId` on the settle fact exist to provide. A suite that only ever resolved a checkpoint once
 * would pass with the rejected first draft of this shape.
 *
 * Everything else here is about honesty at the edges: an expiry returns an expiry rather than an
 * empty answer, a late resolver is told it was late rather than told it succeeded, and a resume
 * that named no answer at all raises instead of inventing a value.
 *
 * Run: pnpm smoke:runtime-mesh-checkpoint   (needs nats-server on PATH)
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "@nats-io/transport-node";
import { jetstream, jetstreamManager } from "@nats-io/jetstream";
import { Kvm } from "@nats-io/kv";
import { isReachable, createEndpointStreams, openRecordsBucket, timerWriterContext, timerWriterConsumerConfig, timerWriterDurable, armCheckpointTimer, readCheckpointSettle, readCheckpointAnswer, readCheckpointStatus, resumeCheckpoint, mintCheckpoint, activateRun, checkpointAnswerId, eptReqStreamName, eptStreamName, eptSubject, } from "@cotal-ai/core";
import { MeshHandler, EpfSettleWatcher, CheckpointAnswerMissing, resolveCheckpoint, openCheckpointToken, CheckpointNotOpen, outstandingPauseTokens, rearmOutstandingPauses, startRun, } from "../src/index.js";
import { pickFreePort } from "./_free-port.js";
const SPACE = "meshcp";
const EP = "manager";
const IID = "i".repeat(26);
const EPOCH = 4;
const HOLDER = { id: "manager", lifecycleUid: "u_meshcp" };
let ok = 0, fail = 0;
const c = (n, v, extra) => { if (v) {
    ok++;
}
else {
    fail++;
    console.log("  ✗ FAIL:", n, extra ?? "");
} };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const PORT = await pickFreePort();
const sd = mkdtempSync(join(tmpdir(), "cotal-meshcp-"));
const broker = spawn("nats-server", ["-js", "-sd", sd, "-p", String(PORT), "-a", "127.0.0.1"], { stdio: "ignore" });
const done = () => {
    try {
        broker.kill("SIGKILL");
    }
    catch { /* already gone */ }
    rmSync(sd, { recursive: true, force: true });
};
process.on("exit", done);
let up = false;
for (let i = 0; i < 60 && !up; i += 1) {
    up = await isReachable(`nats://127.0.0.1:${PORT}`);
    if (!up)
        await wait(100);
}
if (!up)
    throw new Error(`nats-server did not come up on ${PORT}`);
const nc = await connect({ servers: `nats://127.0.0.1:${PORT}` });
const js = jetstream(nc);
const jsm = await jetstreamManager(nc);
await createEndpointStreams(jsm, new Kvm(nc), SPACE);
const kv = await openRecordsBucket(nc, SPACE);
// The mediated timer writer as its own loop: the driver publishes `.schedule` REQUESTS and never
// arms anything itself.
await jsm.consumers.add(eptReqStreamName(SPACE), timerWriterConsumerConfig(SPACE, { ackWaitMs: 5_000 }));
const writerC = await js.consumers.get(eptReqStreamName(SPACE), timerWriterDurable(SPACE));
const wctx = await timerWriterContext(nc, SPACE);
const armPending = async (expect) => {
    let armed = 0;
    for await (const m of await writerC.fetch({ max_messages: expect, expires: 1_500 })) {
        const r = await armCheckpointTimer(wctx, { subject: m.subject, headers: m.headers, data: m.data });
        if (r.armed)
            armed += 1;
        m.ack();
    }
    return armed;
};
/** Whether the broker has published its own `.fire` for a token — an OBSERVATION of the timer
 *  plane, never a delivery. A suite that hands the fire to `handleCheckpointFire` itself grades
 *  the plane's expiry and not whether anything in the tree takes a fire. */
const brokerFired = async (token, epoch = EPOCH) => {
    const subject = eptSubject(SPACE, EP, IID, epoch, token, "fire");
    const fired = await jsm.streams.getMessage(eptStreamName(SPACE), { last_by_subj: subject }).catch(() => null);
    return fired !== null && fired !== undefined;
};
/** A cell whose claim is "this ENDS" must fail as a RED, not as a suite that stops: a bare `await`
 *  on a pause that never expires is graded on the harness's patience rather than on the code. */
const withDeadline = async (p, ms, what) => {
    let timer;
    const late = new Promise((r) => { timer = setTimeout(() => r(undefined), ms); });
    try {
        const got = await Promise.race([p.then((v) => ({ v })), late]);
        if (got === undefined) {
            fail++;
            console.log(`  ✗ FAIL: ${what} did not end within ${ms}ms`);
            return undefined;
        }
        return got.v;
    }
    finally {
        if (timer !== undefined)
            clearTimeout(timer);
    }
};
const NOW = Date.now(); // real schedules need real wall-clock deadlines
const binding = {
    space: SPACE, endpoint: EP, runId: "r-cp", instanceId: IID, epoch: EPOCH, holder: HOLDER,
    defaultCheckpointTimeout: "1h",
};
const handler = new MeshHandler(kv, js, jsm, binding, new EpfSettleWatcher(js, jsm, SPACE, 3_000), () => NOW);
const deps = { kv, js, jsm, space: SPACE, endpoint: EP, holder: HOLDER };
const PROGRAM = `
const a = await checkpoint("approve", "Ship it?", { timeout: "1h", onExpiry: "proceed" });
`;
const STEP = "/checkpoint:approve#0";
let takeovers = 0;
const lease = (holder, epoch, fencingToken) => ({ holder, epoch, fencingToken, takeoverId: `t${(takeovers += 1)}` });
/** Start a run that will pause, and wait until its pause is actually durable. */
const startPaused = async (runId) => {
    const driven = startRun(js, jsm, {
        space: SPACE, endpoint: EP, kv, runId, source: PROGRAM, lease: lease("m1", 1, takeovers + 1), handler,
    });
    for (let i = 0; i < 100; i += 1) {
        const token = await tokenOf(runId);
        if (token !== undefined && (await readCheckpointStatus(kv, { endpoint: EP, token })) !== undefined) {
            return { driven, token };
        }
        await wait(50);
    }
    throw new Error(`run ${runId} never reached its checkpoint`);
};
/** The token the run is waiting on, read the way a resolver reads it: out of the journal. */
const tokenOf = async (runId) => {
    try {
        // openCheckpointToken is exercised for real below; here it is only the probe.
        const { replayRunJournal, newTakeoverId } = await import("@cotal-ai/core");
        const replay = await replayRunJournal(js, jsm, SPACE, runId, newTakeoverId());
        const entries = replay.records.filter((r) => r.record.kind === "step").map((r) => r.record.entry);
        return openCheckpointToken(entries, runId, STEP);
    }
    catch {
        return undefined;
    }
};
// ── 1) a checkpoint pauses, is answered through the driver, and the program reads the answer ──
{
    const { driven, token } = await startPaused("cp-1");
    await armPending(4);
    const st = await readCheckpointStatus(kv, { endpoint: EP, token });
    c("the pause is durable before anybody answers: a `waiting` status exists", st?.value.state === "waiting", st?.value.state);
    const r = await resolveCheckpoint(deps, { runId: "cp-1", stepKey: STEP, by: "david", value: { ship: true }, now: NOW + 1_000 });
    c("the resolve settles the checkpoint as RESUMED", r.settle.settle === "resumed", r.settle.settle);
    c("and the settle NAMES the answer it accepted", r.settle.answerId === r.answerId, `${r.settle.answerId} vs ${r.answerId}`);
    const filed = await readCheckpointAnswer(kv, EP, r.token, r.answerId);
    c("the answer itself is a record, keyed (token, answerId), carrying the value and the answerer", filed?.by === "david" && JSON.stringify(filed?.value) === JSON.stringify({ ship: true }), JSON.stringify(filed));
    const out = await driven;
    c("the run completes", out.status === "completed", out.status === "completed" ? "" : out.reason?.name);
    const entry = out.status === "completed"
        ? out.result.journal.entries().find((e) => e.kind === "checkpoint")
        : undefined;
    // The journal holds the RAW outcome, not the program's `CheckpointResultValue`: whether an expiry
    // throws or returns is `onExpiry`, recomputed from today's source on every replay, and recording
    // the policy's answer would bake one reading of it into the record.
    const rec = entry?.result;
    c("and the program's checkpoint resolved with the value that was answered", rec?.outcome === "resolved" && JSON.stringify(rec?.value) === JSON.stringify({ ship: true }), JSON.stringify(rec));
    c("the recorded outcome names the answer it came from, so the journal is readable back to the record", rec?.answerId === r.answerId, `${rec?.answerId} vs ${r.answerId}`);
    c("attributed to the ANSWERER, not to the driver that presented the token", rec?.by === "david", rec?.by);
}
// ── 2) two resolvers race: the program reads the WINNER, not the last write ──────────────────
//
// This is the cell the record's key exists for. Both answers are filed — they are different values,
// so they are different ids — and exactly one settlement happens. If the answer were one slot per
// token, or if the settle did not name its choice, the program would read whichever write landed
// last, which is a different answer from the one that won.
{
    const { driven, token } = await startPaused("cp-2");
    await armPending(4);
    const yes = resolveCheckpoint(deps, { runId: "cp-2", stepKey: STEP, by: "ann", value: "yes", now: NOW + 1_000 });
    const no = resolveCheckpoint(deps, { runId: "cp-2", stepKey: STEP, by: "bob", value: "no", now: NOW + 1_000 });
    const results = await Promise.allSettled([yes, no]);
    const won = results.filter((r) => r.status === "fulfilled");
    const lost = results.filter((r) => r.status === "rejected");
    c("exactly one resolver wins the one-use settlement", won.length === 1 && lost.length === 1, `${won.length}/${lost.length}`);
    const winner = won[0].value;
    const bothFiled = await Promise.all([
        readCheckpointAnswer(kv, EP, token, checkpointAnswerId({ token, by: "ann", value: "yes" })),
        readCheckpointAnswer(kv, EP, token, checkpointAnswerId({ token, by: "bob", value: "no" })),
    ]);
    c("BOTH answers are filed: the loser's record is orphaned, never overwritten", bothFiled[0] !== undefined && bothFiled[1] !== undefined, bothFiled.map((a) => a?.by).join(","));
    const out = await driven;
    const rec = out.status === "completed"
        ? out.result.journal.entries().find((e) => e.kind === "checkpoint")?.result
        : undefined;
    const winnerAnswer = await readCheckpointAnswer(kv, EP, token, winner.answerId);
    c("and the program reads the WINNER's answer, matched by the id the settle named", rec?.value === winnerAnswer?.value && rec?.by === winnerAnswer?.by, `${JSON.stringify(rec)} vs ${JSON.stringify(winnerAnswer)}`);
}
// ── 3) nobody answers: the deadline settles it, and a late answer is told it was late ─────────
{
    const source = `
const a = await checkpoint("approve", "Ship it?", { timeout: "2s", onExpiry: "proceed" });
`;
    // Its OWN handler, on a clock that MOVES. Everywhere else here the clock is pinned so a deadline
    // is a value the cells can name; this block's subject is a deadline actually passing, and a clock
    // frozen before its own deadline judges every real fire premature and re-arms instead of expiring.
    const expiring = new MeshHandler(kv, js, jsm, binding, new EpfSettleWatcher(js, jsm, SPACE, 3_000), () => Date.now());
    const driven = startRun(js, jsm, {
        space: SPACE, endpoint: EP, kv, runId: "cp-3", source, lease: lease("m1", 1, takeovers + 1), handler: expiring,
    });
    let token;
    for (let i = 0; i < 100 && token === undefined; i += 1) {
        token = await tokenOf("cp-3");
        if (token === undefined)
            await wait(50);
    }
    await armPending(4);
    const armedAt = await readCheckpointStatus(kv, { endpoint: EP, token: token });
    while (Date.now() < (armedAt?.value.deadline ?? 0) + 400)
        await wait(100);
    c("the broker publishes the deadline's own fire, and nobody hands it to the handler", await brokerFired(token));
    // Progress mark, printed upstream of everything that touches the fire.
    console.log("• 3 — nobody answers: the deadline is armed and past due");
    const out = (await withDeadline(driven, 30_000, "the run"));
    const rec = out?.status === "completed"
        ? out.result.journal.entries().find((e) => e.kind === "checkpoint")?.result
        : undefined;
    c("the program sees an EXPIRY, not an empty answer", rec?.outcome === "expired", JSON.stringify(rec));
    // A late resolver meets TWO refusals, and both are worth pinning because they are reached by
    // different routes: once the run has recorded the expiry the journal itself says the step is over,
    // and if nobody drove the run at all the plane's own fail-closed expiry is what refuses.
    let late;
    try {
        await resolveCheckpoint(deps, { runId: "cp-3", stepKey: STEP, by: "david", value: "too late", now: Date.now() });
    }
    catch (e) {
        late = e;
    }
    c("a resolver arriving after the run recorded the expiry is refused at the journal, by name", late instanceof CheckpointNotOpen && late.why === "settled", late?.message?.slice(0, 70));
    let closed;
    try {
        await resumeCheckpoint(kv, js, jsm, SPACE, { ref: { endpoint: EP, token: token }, presenter: HOLDER, now: Date.now(), answerId: "zzz" });
    }
    catch (e) {
        closed = e;
    }
    c("and the plane refuses the token itself: expiry fails the checkpoint CLOSED, answer or no answer", closed?.code === "failed-precondition", closed?.message?.slice(0, 70));
}
// ── 4) addressing a step that is not an open checkpoint ───────────────────────────────────────
{
    const entries = [
        { v: 1, seq: 0, run: "r", scope: "", kind: "checkpoint", name: "approve", occurrence: 0, inputHash: "h", requestId: "tok", state: "settled", status: "ok", startedAt: 0 },
        { v: 1, seq: 1, run: "r", scope: "", kind: "sleep", name: "nap", occurrence: 0, inputHash: "h", requestId: "tok2", state: "pending", startedAt: 0 },
    ];
    const why = (fn) => { try {
        fn();
        return "no-throw";
    }
    catch (e) {
        return e.why;
    } };
    c("an unknown step key refuses by name", why(() => openCheckpointToken(entries, "r", "/checkpoint:nope#0")) === "unknown");
    c("a settled step refuses as settled, never re-answered", why(() => openCheckpointToken(entries, "r", "/checkpoint:approve#0")) === "settled");
    c("a step that is not a checkpoint refuses as that", why(() => openCheckpointToken(entries, "r", "/sleep:nap#0")) === "not-a-checkpoint");
}
// ── 5) the answer id is derived, so a resolver's own retry files one answer and not two ───────
{
    const { driven, token } = await startPaused("cp-5");
    await armPending(4);
    const a = checkpointAnswerId({ token, by: "david", value: 42 });
    const b = checkpointAnswerId({ token, by: "david", value: 42 });
    c("the same answer derives the same id: a retry after a crash lands on its own record", a === b, `${a} ${b}`);
    c("a different answer derives a different id: two resolvers are never one slot", a !== checkpointAnswerId({ token, by: "david", value: 43 }));
    const r = await resolveCheckpoint(deps, { runId: "cp-5", stepKey: STEP, by: "david", value: 42, now: NOW + 1_000 });
    c("and the id the resolve filed is exactly that derivation", r.answerId === a, `${r.answerId} vs ${a}`);
    await driven;
}
// ── 6) a resume that named no answer is a loud refusal, never an invented value ───────────────
//
// The only way to reach this is to present the token WITHOUT going through resolveCheckpoint, which
// means the run's own command was bypassed. There is no honest value to return: something released
// the pause and what it answered is not recoverable.
{
    const { driven, token } = await startPaused("cp-6");
    // Take the rejection NOW: this run is going to fail, and the cells below do real awaits in
    // between — an unattached rejected promise would kill the process instead of failing a cell.
    const outcome = driven.then(() => undefined, (e) => e);
    await armPending(4);
    await resumeCheckpoint(kv, js, jsm, SPACE, { ref: { endpoint: EP, token }, presenter: HOLDER, now: NOW + 1_000 });
    const settled = await readCheckpointSettle(jsm, SPACE, { endpoint: EP, token });
    c("the bypassing resume settles with NO answerId", settled?.settle === "resumed" && settled?.answerId === undefined, JSON.stringify(settled));
    const raised = await outcome;
    // The interpreter turns a handler's throw into an L4000 handler-fault — the effect FAILED, which
    // is the honest record. What matters is that nothing returned a `resolved` checkpoint carrying a
    // value nobody gave.
    c("and the effect FAILS rather than returning a resolved checkpoint with an empty value", raised?.kind === "handler-fault"
        && raised?.message?.includes("settled as resumed"), raised?.message?.slice(0, 70));
    c("naming the class the driver raises, so the failure is diagnosable rather than generic", new CheckpointAnswerMissing("t", undefined).name === "CheckpointAnswerMissing");
}
// ── 6b) the answer is written BEFORE the token is presented ──────────────────────────────────
//
// A resolver whose PRESENTATION is refused must still have filed its answer, because the record is
// the payload and the settle is the fact that releases the run: in this order a refusal (or a
// crash) between the two leaves an answer nobody accepted, which is harmless, and in the other
// order it leaves a run released with its answer nowhere.
//
// The journal here is BUILT rather than driven, and deliberately: the window this cell needs — a
// step still pending while its checkpoint is already settled — closes the moment a live driver
// notices, so a cell that raced for it would be flaky about the thing it is trying to prove.
// That `openCheckpointToken` is reached through a real replay is proven by every other cell here.
{
    const RUN = "cp-6b";
    const TOKEN = "cnRlc3RfcHJlc2VudGF0aW9uX29yZGVy";
    const appender = await activateRun(js, jsm, {
        space: SPACE, runId: RUN, holder: "m1", fencingToken: 1, epoch: 1,
        takeoverId: `t${(takeovers += 1)}`, at: NOW, expect: "new",
    });
    await appender.append({
        v: 1, seq: 0, run: RUN, scope: "", kind: "checkpoint", name: "approve", occurrence: 0,
        inputHash: "sha256:built", requestId: TOKEN, attempt: 0, state: "pending", startedAt: NOW,
    }, NOW);
    await mintCheckpoint(kv, js, SPACE, {
        ref: { endpoint: EP, token: TOKEN }, instanceId: IID, epoch: EPOCH, holder: HOLDER,
        deadline: NOW + 3_600_000, now: NOW,
    });
    await armPending(4);
    // Somebody else settles it first — an expiry would do just as well; what matters is that the
    // presentation this resolver is about to make cannot win.
    await resumeCheckpoint(kv, js, jsm, SPACE, { ref: { endpoint: EP, token: TOKEN }, presenter: HOLDER, now: NOW + 500 });
    const lateId = checkpointAnswerId({ token: TOKEN, by: "carol", value: "mine" });
    let refused;
    try {
        await resolveCheckpoint(deps, { runId: RUN, stepKey: STEP, by: "carol", value: "mine", now: NOW + 1_100 });
    }
    catch (e) {
        refused = e;
    }
    c("a resolver whose presentation is refused is told so, not told it succeeded", refused?.code === "conflict", refused?.message?.slice(0, 60));
    c("and its answer is on disk anyway: the payload is written BEFORE the fact that releases the run", (await readCheckpointAnswer(kv, EP, TOKEN, lateId))?.by === "carol");
}
// ── 7) a run adopted at a new epoch re-arms its pauses, or its timers fire where nobody reads ──
{
    const { driven, token } = await startPaused("cp-7");
    await armPending(4);
    const entries = [
        { v: 1, seq: 0, run: "cp-7", scope: "", kind: "checkpoint", name: "approve", occurrence: 0, inputHash: "h", requestId: token, state: "pending", startedAt: 0 },
        { v: 1, seq: 1, run: "cp-7", scope: "", kind: "sleep", name: "over", occurrence: 0, inputHash: "h", requestId: "settled-tok", state: "settled", status: "ok", startedAt: 0 },
    ];
    const open = outstandingPauseTokens(entries);
    c("the outstanding pauses are the PENDING ones: a settled step is not re-armed", open.length === 1 && open[0] === token, open.join(","));
    const NEXT = EPOCH + 1;
    const rearmed = await rearmOutstandingPauses({ kv, js, jsm }, { ...binding, epoch: NEXT }, entries);
    c("a takeover at a new epoch re-emits the pause's schedule", rearmed.length === 1 && rearmed[0] === token, rearmed.join(","));
    c("and the writer arms it onto the NEW epoch's own subjects", (await armPending(4)) === 1);
    const armedAtNext = await jsm.streams
        .getMessage(eptStreamName(SPACE), { last_by_subj: eptSubject(SPACE, EP, IID, NEXT, token, "armed") })
        .catch(() => null);
    c("so an armed schedule now exists at the successor's coordinates, where it will actually be read", armedAtNext !== null);
    // AND `wait` IS A PAUSE, which is the half this cell did not have and a review found.
    //
    // A `wait` mints no pause of its own, so it does not look like one — but it ARMS mediated
    // deadlines exactly as `sleep` does, an idle window or a timeout, and neither was re-armed. A run
    // adopted at a new epoch sat on a deadline no live epoch would fire: the run waits forever, and
    // nothing anywhere is red. Reproduced as a pending `wait` entry that yielded NO tokens at all.
    //
    // Asserted on `outstandingPauseTokens` rather than end-to-end because that list IS the mechanism —
    // `rearmOutstandingPauses` re-arms exactly what it returns, which cell 7 above already proves.
    {
        const waitTok = "req-wait-token-7";
        const shapes = [
            { kind: "sleep", requestId: "tok-sleep" },
            { kind: "checkpoint", requestId: "tok-cp" },
            { kind: "wait", requestId: waitTok },
        ].map((s, i) => ({
            v: 1, seq: i, run: "cp-7w", scope: "", name: `s${i}`, occurrence: 0, inputHash: "h",
            state: "pending", startedAt: 0, ...s,
        }));
        const open = outstandingPauseTokens(shapes);
        c("REPAIRED: a pending `wait` is an outstanding pause, so a takeover re-arms its deadline", open.includes(waitTok), open.join(","));
        // The IDLE wait's second deadline. It is derived rather than recorded, so the repair has to
        // derive it too — a wait that had to remember it would carry state its own key determines.
        const derived = createHash("sha256").update(`${waitTok}:wait-timeout`, "utf8").digest("base64url").slice(0, 43);
        c("...including the outer timeout an idle wait arms, re-derived rather than remembered", open.includes(derived), open.join(","));
        // NARROWNESS, both directions. Emitting a derived token for a wait that never armed an outer
        // deadline is harmless — the reconciler reads the checkpoint's status first and re-emits
        // nothing when there is none — but a SETTLED wait must contribute nothing at all, or a takeover
        // re-arms timers for pauses that are already over.
        const settledWait = [{
                v: 1, seq: 0, run: "cp-7w", scope: "", kind: "wait", name: "over", occurrence: 0, inputHash: "h",
                requestId: "tok-done", state: "settled", status: "ok", startedAt: 0,
            }];
        c("while a SETTLED wait contributes nothing: a pause that is over is not re-armed", outstandingPauseTokens(settledWait).length === 0, outstandingPauseTokens(settledWait).join(","));
        c("and the other kinds are unchanged by the addition", open.includes("tok-sleep") && open.includes("tok-cp"), open.join(","));
    }
    await resolveCheckpoint(deps, { runId: "cp-7", stepKey: STEP, by: "david", value: "done", now: NOW + 1_000 });
    await driven;
}
// ── 8) a checkpoint with no timeout of its own gets the driver's PINNED one ───────────────────
//
// There is no such thing as a pause that waits forever on this plane: `mintCheckpoint` refuses a
// deadline that is not in the future, and an unbounded pause would be a run nothing can reconcile.
// So the default is a value the host states, not a constant hidden in the handler.
{
    const source = `
const a = await checkpoint("approve", "Ship it?", { onExpiry: "proceed" });
`;
    const driven = startRun(js, jsm, {
        space: SPACE, endpoint: EP, kv, runId: "cp-8", source, lease: lease("m1", 1, takeovers + 1), handler,
    });
    let token;
    for (let i = 0; i < 100 && token === undefined; i += 1) {
        token = await tokenOf("cp-8");
        if (token === undefined)
            await wait(50);
    }
    await armPending(4);
    const st = await readCheckpointStatus(kv, { endpoint: EP, token: token });
    c("an unnamed timeout takes the binding's pinned default, not a constant of the handler's own", st?.value.deadline === NOW + 3_600_000, `${st?.value.deadline} vs ${NOW + 3_600_000}`);
    await resolveCheckpoint(deps, { runId: "cp-8", stepKey: STEP, by: "david", value: "ok", now: NOW + 1_000 });
    await driven;
}
console.log(`mesh-checkpoint.smoke: ${ok} passed, ${fail} failed`);
done();
process.exit(fail === 0 ? 0 : 1);
//# sourceMappingURL=mesh-checkpoint.smoke.js.map