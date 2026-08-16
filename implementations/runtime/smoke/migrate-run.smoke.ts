/**
 * Migrating a run onto edited source: the orphan table, and the refusals that are the product.
 *
 * The language proves the WALK (`pnpm smoke:lang-migrate`): that a settled scope is entered rather
 * than consumed, so an effect the edit removed actually reaches `orphans()`. This suite proves what
 * is done with what the walk found — §8.4's table — and the interesting rows are the refusals. A
 * migration that silently dropped a live agent, an open conclave, an undelivered notice, or a
 * decision a person actually made would be an evidence-carrying system discarding evidence, and
 * every one of those failures is invisible in the artifact afterwards.
 *
 * **Journals are RECORDED by the simulator and CHECKED by the dry walk**, which is the honest shape:
 * the check reads entries, and the simulator is the only thing in this tree that can produce a
 * journal containing a spawn or a turn (no durable run reaches them until Lane A lands — the gap
 * slice (e) named). Where a cell needs a store fact the simulator cannot file — the notice
 * consumption — it is written through the same core writer the mesh handler uses, and the cell says
 * so rather than implying the handler filed it.
 *
 * Run: pnpm smoke:runtime-migrate   (needs nats-server on PATH)
 */
import { spawn as spawnProc } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "@nats-io/transport-node";
import { Kvm } from "@nats-io/kv";
import { jetstreamManager } from "@nats-io/jetstream";
import {
  isReachable,
  createEndpointStreams,
  openRecordsBucket,
  writeRunNotice,
  markRunNoticeConsumed,
  runNoticeId,
} from "@cotal-ai/core";
import {
  Journal,
  journalEntryKeyString,
  resolvePins,
  run as runProgram,
  SimHandler,
  type JournalEntry,
} from "@cotal-ai/lang";
import { migrateRun, commitMigration, NotYetDurable } from "../src/index.js";
import { pickFreePort } from "./_free-port.js";

const SPACE = "migrun";
const EP = "manager";
const NOW = 1_770_000_000_000;
const PINS = resolvePins({ runId: "r" }, NOW);

let ok = 0, fail = 0;
const c = (n: string, v: boolean, extra?: unknown) => {
  if (v) { ok++; return; }
  fail++;
  console.log("  ✗ FAIL:", n, extra === undefined ? "" : JSON.stringify(extra));
};
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

const PORT = await pickFreePort();
const sd = mkdtempSync(join(tmpdir(), "cotal-migrun-"));
const broker = spawnProc("nats-server", ["-js", "-sd", sd, "-p", String(PORT), "-a", "127.0.0.1"], { stdio: "ignore" });
const done = () => {
  try { broker.kill("SIGKILL"); } catch { /* already gone */ }
  rmSync(sd, { recursive: true, force: true });
};
process.on("exit", done);

let up = false;
for (let i = 0; i < 60 && !up; i += 1) { up = await isReachable(`nats://127.0.0.1:${PORT}`); if (!up) await wait(100); }
if (!up) throw new Error(`nats-server did not come up on ${PORT}`);

const nc = await connect({ servers: `nats://127.0.0.1:${PORT}` });
const jsm = await jetstreamManager(nc);
await createEndpointStreams(jsm, new Kvm(nc), SPACE);
const kv = await openRecordsBucket(nc, SPACE);

/** Record a run in the simulator and hand back its journal entries. */
const record = async (runId: string, source: string, script: unknown = {}): Promise<JournalEntry[]> => {
  const j = new Journal({ run: runId });
  await runProgram(source, { runId, handler: new SimHandler(script as never), journal: j, pins: PINS });
  return [...j.entries()];
};

/** Check the edited source against a recorded journal. */
const check = async (
  runId: string,
  entries: readonly JournalEntry[],
  source: string,
  overrides?: Parameters<typeof migrateRun>[0]["overrides"],
) =>
  await migrateRun({
    endpoint: EP, runId, source, entries, pins: PINS, kv,
    actor: "david", now: () => NOW,
    ...(overrides !== undefined ? { overrides } : {}),
  });

const rowFor = (r: Awaited<ReturnType<typeof check>>, needle: string) =>
  r.orphans.find((o) => o.step.includes(needle));

// ── 1) a removal with nothing behind it ────────────────────────────────────────────────────────
{
  const RUN = "r-plain";
  const LIVE = `await sleep("1s", { name: "one" });\nawait sleep("2s", { name: "two" });`;
  const entries = await record(RUN, LIVE);
  const r = await check(RUN, entries, `await sleep("1s", { name: "one" });`);

  c("a migration that only drops a sleep is admissible", r.admissible === true, r);
  c("the dropped sleep is reported rather than forgotten", rowFor(r, "sleep:two") !== undefined, r.orphans);
  c("and its verdict is ignored, because nothing outlives a sleep",
    rowFor(r, "sleep:two")?.verdict === "ignored", rowFor(r, "sleep:two"));
  c("the surviving step is not an orphan", rowFor(r, "sleep:one") === undefined, r.orphans);
  c("consumedThrough counts what the walk accounted for", r.consumedThrough === entries.length - 1,
    { consumedThrough: r.consumedThrough, entries: entries.length });
  c("nothing was committed, because the check does not commit", r.actor === "david" && r.overrides.length === 0, r);
}

// ── 2) a decision a person actually made ───────────────────────────────────────────────────────
{
  const RUN = "r-approve";
  // `onExpiry: "proceed"` so ONE source covers both recordings: an expired checkpoint under the
  // default would fail the recorded run, and the disposition is not hashed (§5.12) so it changes
  // nothing about the edit under test.
  const LIVE = `const a = await checkpoint("approve", "ship it?", { timeout: "10m", onExpiry: "proceed" });\nawait sleep("1s", { name: "after" });`;
  const EDITED = `await sleep("1s", { name: "after" });`;
  const entries = await record(RUN, LIVE, {
    checkpoints: { approve: { status: "resolved", value: "yes", by: "david", at: NOW } },
  });

  const bare = await check(RUN, entries, EDITED);
  c("dropping a RESOLVED checkpoint is refused", bare.admissible === false, bare);
  c("with L5004, the code the catalog gives it", rowFor(bare, "checkpoint:approve")?.code === "L5004",
    rowFor(bare, "checkpoint:approve"));
  c("and the refusal names who made the decision",
    rowFor(bare, "checkpoint:approve")?.why.includes("david") === true, rowFor(bare, "checkpoint:approve")?.why);

  const forced = await check(RUN, entries, EDITED, { discardApprovals: true });
  c("--discard-approvals makes it admissible", forced.admissible === true, forced);
  c("the row is KEPT rather than ignored: a discarded decision is not a decision that did not happen",
    rowFor(forced, "checkpoint:approve")?.verdict === "kept", rowFor(forced, "checkpoint:approve"));
  c("and the override is on the report with the actor who passed it",
    forced.overrides.includes("--discard-approvals") && forced.actor === "david", forced);

  // The distinction the table turns on: an EXPIRED checkpoint recorded no human decision, so there
  // is nothing to discard and nothing to refuse.
  const expired = await record("r-expired", LIVE, {
    checkpoints: { approve: { status: "expired", at: NOW } },
  });
  const r = await check("r-expired", expired, EDITED);
  c("dropping an EXPIRED checkpoint needs no override", r.admissible === true, r);
  c("because no human decision was recorded against it",
    rowFor(r, "checkpoint:approve")?.verdict === "ignored", rowFor(r, "checkpoint:approve"));
}

// ── 3) a live agent, and an override this host cannot honour ───────────────────────────────────
{
  const RUN = "r-spawn";
  const LIVE = `const dev = await spawn("dev", { name: "dev" });\nawait sleep("1s", { name: "after" });`;
  const EDITED = `await sleep("1s", { name: "after" });`;
  const entries = await record(RUN, LIVE);

  const r = await check(RUN, entries, EDITED);
  c("dropping a spawn is refused with L5003", rowFor(r, "spawn:dev")?.code === "L5003", rowFor(r, "spawn:dev"));
  c("and the migration is not admissible", r.admissible === false, r);

  // §8.4 says --adopt/--release clear it. Neither can be honoured here: there is no durable spawn to
  // adopt or release, so an override that LOOKED accepted would be the fake success this lane
  // refuses. It stays a refusal and says why.
  const adopted = await check(RUN, entries, EDITED, { adopt: ["dev"] });
  c("--adopt does not clear it on this host", adopted.admissible === false, adopted);
  c("and the reason names the substrate rather than the caller's mistake",
    rowFor(adopted, "spawn:dev")?.why.includes("not durable") === true, rowFor(adopted, "spawn:dev")?.why);
}

// ── 4) a notice the addressee has not been told ────────────────────────────────────────────────
{
  const RUN = "r-notify";
  const LIVE = `const dev = await spawn("dev", { name: "dev" });\n`
    + `await notify([dev], { decision: "shipped", outcome: "ok" }, { name: "told" });\n`
    + `await sleep("1s", { name: "after" });`;
  // The spawn stays: this cell is about the notify row, and a spawn orphan would refuse on its own.
  const EDITED = `const dev = await spawn("dev", { name: "dev" });\nawait sleep("1s", { name: "after" });`;
  const entries = await record(RUN, LIVE);
  const told = entries.find((e) => e.kind === "notify")!;
  const step = journalEntryKeyString(told);

  const unknown = await check(RUN, entries, EDITED);
  c("an orphaned notify with NO notice filed is refused rather than assumed harmless",
    rowFor(unknown, "notify:told")?.code === "L5005", rowFor(unknown, "notify:told"));

  // Filed through the same core writer the mesh handler uses, because no durable run reaches
  // `notify` yet — the cell proves the migrate rule against the record, not the handler that files
  // it. Both facts the rule needs are in the value: which step decided it, and who it went to.
  const AGENT = "local.dev-1";
  const noticeId = runNoticeId(told.requestId!, AGENT);
  await writeRunNotice(kv, EP, noticeId, {
    v: 1, run: RUN, step, addressee: AGENT, fact: { decision: "shipped", outcome: "ok" }, at: NOW,
  });

  const pending = await check(RUN, entries, EDITED);
  c("a notice that exists but was never carried is still refused",
    rowFor(pending, "notify:told")?.code === "L5005", rowFor(pending, "notify:told"));
  c("and says what migrating would do: deliver a decision the new program no longer makes",
    rowFor(pending, "notify:told")?.why.includes("no longer makes") === true, rowFor(pending, "notify:told")?.why);
  c("the migration is not admissible while it stands", pending.admissible === false, pending);

  await markRunNoticeConsumed(kv, EP, RUN, AGENT, noticeId, "goal-1", NOW + 1);
  const carried = await check(RUN, entries, EDITED);
  c("once the addressee's turn carried it, the orphan is ignored like a turn",
    rowFor(carried, "notify:told")?.verdict === "ignored", rowFor(carried, "notify:told"));
  c("and the migration becomes admissible", carried.admissible === true, carried);
}

// ── 5) history that cannot be un-taken ─────────────────────────────────────────────────────────
{
  const RUN = "r-turn";
  const LIVE = `const dev = await spawn("dev", { name: "dev" });\n`
    + `await turn(dev, { name: "work" });\nawait sleep("1s", { name: "after" });`;
  const EDITED = `const dev = await spawn("dev", { name: "dev" });\nawait sleep("1s", { name: "after" });`;
  const entries = await record(RUN, LIVE, { turns: { work: { status: "done", at: NOW } } });
  const r = await check(RUN, entries, EDITED);

  c("dropping a turn does not refuse the migration", r.admissible === true, r);
  c("but its verdict is KEPT, not ignored: the agent already spoke",
    rowFor(r, "turn:work")?.verdict === "kept", rowFor(r, "turn:work"));
  c("and the report says so, so no reader is told the work did not happen",
    rowFor(r, "turn:work")?.why.includes("already took this turn") === true, rowFor(r, "turn:work")?.why);
}

// ── 6) an edited input, and a scope the walk cannot enter ──────────────────────────────────────
{
  const RUN = "r-diverge";
  const LIVE = `await sleep("1s", { name: "one" });\nawait sleep("2s", { name: "two" });`;
  const entries = await record(RUN, LIVE);
  const r = await check(RUN, entries, `await sleep("9s", { name: "one" });\nawait sleep("2s", { name: "two" });`);
  c("an edited input is a divergence, not an orphan", r.divergence !== undefined, r);
  c("and it names the step", r.divergence?.step.includes("sleep:one") === true, r.divergence);
  c("a diverged migration is never admissible", r.admissible === false, r);

  const CONCLAVE = `await conclave([], async (room) => { await sleep("1s", { name: "inside" }); return 1; }, { name: "huddle" });`;
  const cj = await record("r-conclave", CONCLAVE);
  const cr = await check("r-conclave", cj, CONCLAVE);
  c("a conclave the walk cannot enter is refused rather than consumed", cr.unwalkable !== undefined, cr);
  c("and the refusal names the scope", cr.unwalkable?.step.includes("conclave:huddle") === true, cr.unwalkable);
  c("which is not admissible either", cr.admissible === false, cr);
}

// ── 7) the commit, which is a seam and says so ─────────────────────────────────────────────────
{
  const RUN = "r-commit";
  const entries = await record(RUN, `await sleep("1s", { name: "one" });\nawait sleep("2s", { name: "two" });`);
  const r = await check(RUN, entries, `await sleep("1s", { name: "one" });`);
  c("the report is admissible", r.admissible === true, r);

  const e = await commitMigration(r).then(() => null, (x: unknown) => x as Error);
  c("committing it refuses BY NAME rather than writing the fact somewhere it would be lost",
    e instanceof NotYetDurable, e?.name);
  c("and names what it is waiting for", e?.message.includes("pinned program hash") === true, e?.message?.slice(0, 200));
}

console.log(`migrate-run.smoke: ${ok} passed, ${fail} failed`);
done();
process.exit(fail === 0 ? 0 : 1);
