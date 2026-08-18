/**
 * The step journal's durable half, against a real broker.
 *
 * The claim under test is that the language's journal and the activation barrier compose without
 * either one lying to the other: an entry the interpreter believes is recorded is on disk where
 * another host can find it, and a barrier failure reaches the interpreter as a DURABILITY failure
 * (L5010) rather than as an effect result. The second half is the one worth proving — the failure
 * mode it rules out is a run reporting that work failed when the work was done and only the log
 * refused.
 *
 * Run: pnpm smoke:runtime-journal-store   (needs nats-server on PATH; part of smoke:ci)
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "@nats-io/transport-node";
import { jetstream, jetstreamManager } from "@nats-io/jetstream";
import { Kvm } from "@nats-io/kv";
import { isReachable, createEndpointStreams, activateRun, replayRunJournal, } from "@cotal-ai/core";
import { Journal, JournalAppendRejected, KeyScope } from "@cotal-ai/lang";
import { RunJournalStore, RunJournalUnavailable } from "../src/index.js";
import { pickFreePort } from "./_free-port.js";
const SPACE = "wfjstore";
const PORT = await pickFreePort();
const sd = mkdtempSync(join(tmpdir(), "cotal-wfjstore-"));
const broker = spawn("nats-server", ["-js", "-sd", sd, "-p", String(PORT), "-a", "127.0.0.1"], { stdio: "ignore" });
const servers = `nats://127.0.0.1:${PORT}`;
let ok = 0, fail = 0;
const c = (n, v, extra) => { if (v) {
    ok++;
}
else {
    fail++;
    console.log("  ✗ FAIL:", n, extra ?? "");
} };
const done = () => {
    try {
        broker.kill("SIGKILL");
    }
    catch { /* already gone */ }
    rmSync(sd, { recursive: true, force: true });
};
process.on("exit", done);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let up = false;
for (let i = 0; i < 60 && !up; i += 1) {
    up = await isReachable(servers);
    if (!up)
        await wait(100);
}
if (!up)
    throw new Error(`nats-server did not come up on ${PORT}`);
const nc = await connect({ servers });
const jsm = await jetstreamManager(nc);
const js = jetstream(nc);
await createEndpointStreams(jsm, new Kvm(nc), SPACE);
let takeovers = 0;
const takeover = (runId, holder, token, expect = "new") => ({
    space: SPACE, runId, holder, fencingToken: token, epoch: token, at: 1_700_000_000_000, expect,
    takeoverId: `t${(takeovers += 1)}`,
});
const key = (name) => new KeyScope().nextEffect("sleep", name);
// ── 1) an entry the interpreter recorded is on the broker, not in this process ────────────────
{
    const appender = await activateRun(js, jsm, takeover("s-1", "d1", 1));
    const journal = new Journal({ run: "s-1", store: new RunJournalStore(appender) });
    const entry = await journal.begin(key("nap"), "h1", 1_000);
    const back = await replayRunJournal(js, jsm, SPACE, "s-1", `r${(takeovers += 1)}`);
    const steps = back.records.filter((r) => r.record.kind === "step");
    c("a pending entry is durable BEFORE the handler runs, which is the whole point of two phases", steps.length === 1, back.records.map((r) => r.record.kind));
    c("and it is the entry the interpreter built, not a summary of it", steps[0].record.entry !== null &&
        steps[0].record.entry.state === entry.state, steps[0].record.entry);
    await journal.settle(key("nap"), { status: "ok", result: null }, 2_000);
    const after = await replayRunJournal(js, jsm, SPACE, "s-1", `r${(takeovers += 1)}`);
    c("settling appends a second record rather than editing the first: the journal is append-only", after.records.filter((r) => r.record.kind === "step").length === 2, after.records.map((r) => r.record.kind));
}
// ── 2) a superseded run cannot record, and says so as a DURABILITY failure ────────────────────
//
// The failure this rules out: a handler that completed plus a log that refused, written down as an
// effect that FAILED. The work happened; only the ability to say so is gone.
{
    const first = await activateRun(js, jsm, takeover("s-2", "d1", 1));
    const journal = new Journal({ run: "s-2", store: new RunJournalStore(first) });
    await journal.begin(key("one"), "h1", 1_000);
    await activateRun(js, jsm, takeover("s-2", "d2", 2, "existing")); // someone else takes the run
    let refused;
    try {
        await journal.begin(key("two"), "h2", 2_000);
    }
    catch (e) {
        refused = e;
    }
    c("the interpreter sees L5010, the journal's own durability failure", refused instanceof JournalAppendRejected && refused.code === "L5010", `${refused?.name}`);
    c("and the barrier's reason survives inside it, rather than being flattened to 'append failed'", refused?.reason instanceof RunJournalUnavailable, refused?.reason?.name);
    c("the in-memory journal is left as it was: a rejected append moved nothing", journal.entries().length === 1, journal.entries().length);
}
// ── 3) a stalled appender is the same answer, from the other terminal state ───────────────────
{
    const nc2 = await connect({ servers });
    const jsm2 = await jetstreamManager(nc2);
    const appender = await activateRun(jetstream(nc2), jsm2, takeover("s-3", "d1", 1));
    const store = new RunJournalStore(appender);
    const journal = new Journal({ run: "s-3", store });
    await journal.begin(key("one"), "h1", 1_000);
    await nc2.close();
    let stalled;
    try {
        await journal.begin(key("two"), "h2", 2_000);
    }
    catch (e) {
        stalled = e;
    }
    // L5010 alone does not discriminate — the journal wraps ANY store error into it — so what is
    // actually being asked here is whether the STORE recognised a barrier state or let a raw
    // transport error through under a durability label.
    c("losing the connection is a durability failure too, not a transport error the interpreter sees", stalled instanceof JournalAppendRejected &&
        stalled.reason instanceof RunJournalUnavailable, `${stalled?.name}/${stalled?.reason?.name}`);
    c("and the store reports itself finished, so a driver can stop without waiting for the next entry", store.isFinished);
}
console.log(`journal-store.smoke: ${ok} passed, ${fail} failed`);
done();
process.exit(fail === 0 ? 0 : 1);
//# sourceMappingURL=journal-store.smoke.js.map