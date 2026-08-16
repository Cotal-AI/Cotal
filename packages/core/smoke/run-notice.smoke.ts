/**
 * The run notice record, proved against the SOURCE that implements it.
 *
 * These claims were already covered from `implementations/runtime`, but that suite reaches this code
 * through the package name and therefore through `dist`: a mutation there is graded against a built
 * artifact, so a green says nothing about the source a reader is looking at. This suite imports
 * `../src/index.js`, which is what makes the claims here claimable at all.
 *
 * What it proves, and each is a different failure:
 *
 * 1. **The addressee is a derived token.** An agent name is dotted and a dot is the records-key
 *    separator, so a raw name would re-tokenize the key into a key of another shape.
 * 2. **The spec is create-only.** The retry a crash forces lands on its own record; two different
 *    decisions under one id are refused rather than overwritten.
 * 3. **The consumption has ONE arbiter.** Two turns racing to claim a notice both write; the store
 *    decides and the loser hears about it.
 * 4. **Both enumerations return what they are named for.** Per addressee is one key token wide, per
 *    RUN is two — and a KV filter's `*` matches exactly one token, so a filter that is one wildcard
 *    short matches a key shape that does not exist and returns nothing at all. The migrate rule
 *    reads the per-run one, and a silently empty enumeration there is a question answered wrong.
 *
 * Run: pnpm smoke:run-notice   (needs nats-server on PATH)
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "@nats-io/transport-node";
import { jetstreamManager } from "@nats-io/jetstream";
import { Kvm } from "@nats-io/kv";
import {
  isReachable,
  EpEnvelopeError,
  createEndpointStreams,
  openRecordsBucket,
  parseRecordKey,
  noticeAddresseeId,
  runNoticeId,
  writeRunNotice,
  readRunNotice,
  listRunNotices,
  listRunNoticesForRun,
  markRunNoticeConsumed,
  type RunNoticeSpecValue,
} from "../src/index.js";
import { pickFreePort } from "./_free-port.js";

const SPACE = "runnotice";
const EP = "manager";
const RUN = "r-1";
const OTHER_RUN = "r-2";
/** Dotted on purpose: the dot is the records-key separator, and that is the whole point. */
const PLANNER = "local.planner-1";
const BUILDER = "local.builder-2";

let ok = 0, fail = 0;
const c = (n: string, v: boolean, extra?: unknown) => {
  if (v) { ok++; return; }
  fail++;
  console.log("  ✗ FAIL:", n, extra === undefined ? "" : JSON.stringify(extra));
};
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const caught = async (f: () => Promise<unknown>): Promise<Error | null> =>
  await f().then(() => null, (e: unknown) => e as Error);

const PORT = await pickFreePort();
const sd = mkdtempSync(join(tmpdir(), "cotal-runnotice-"));
const broker = spawn("nats-server", ["-js", "-sd", sd, "-p", String(PORT), "-a", "127.0.0.1"], { stdio: "ignore" });
const done = () => {
  try { broker.kill("SIGKILL"); } catch { /* already gone */ }
  rmSync(sd, { recursive: true, force: true });
};
process.on("exit", done);

let up = false;
for (let i = 0; i < 60 && !up; i += 1) { up = await isReachable(`nats://127.0.0.1:${PORT}`); if (!up) await wait(100); }
if (!up) throw new Error(`nats-server did not come up on ${PORT}`);

const nc = await connect({ servers: `nats://127.0.0.1:${PORT}` });
await createEndpointStreams(await jetstreamManager(nc), new Kvm(nc), SPACE);
const kv = await openRecordsBucket(nc, SPACE);

const NOW = 1_770_000_000_000;
const spec = (over: Partial<RunNoticeSpecValue> = {}): RunNoticeSpecValue => ({
  v: 1,
  run: RUN,
  step: "/notify:told#0",
  addressee: PLANNER,
  fact: { decision: "shipped", outcome: "ok" },
  at: NOW,
  ...over,
});

// ── 1) the key holds a digest, never the name ──────────────────────────────────────────────────
{
  const id = noticeAddresseeId(PLANNER);
  c("an addressee token is a 43-character id token", id.length === 43, id);
  c("and it does not contain the dotted name it stands for", !id.includes("."), id);
  c("two agents get two tokens", noticeAddresseeId(BUILDER) !== id, { id, other: noticeAddresseeId(BUILDER) });
  c("the same agent gets the same one, or a reader could not re-derive it",
    noticeAddresseeId(PLANNER) === id, id);
  const empty = await caught(async () => noticeAddresseeId(""));
  c("the empty string names nobody and is refused", empty instanceof EpEnvelopeError, empty?.name);
}

// ── 2) one notify call, N addressees, N records ────────────────────────────────────────────────
{
  const req = "q".repeat(43);
  const a = runNoticeId(req, PLANNER);
  const b = runNoticeId(req, BUILDER);
  c("one call to two agents derives two notice ids", a !== b, { a, b });
  c("and the same call re-derives the same id after a crash", runNoticeId(req, PLANNER) === a, a);

  const w = await writeRunNotice(kv, EP, a, spec());
  c("the first write creates", w.created === true, w);
  const key = parseRecordKey(w.key);
  c("the key is a notice record with four qualifiers and a spec half",
    key?.def.kind === "notice" && key?.qualifiers.length === 4 && key?.part === "spec",
    { kind: key?.def.kind, n: key?.qualifiers.length, part: key?.part });
  c("with the addressee's DIGEST in it, not the addressee",
    w.key.includes(noticeAddresseeId(PLANNER)) && !w.key.includes(PLANNER), w.key);

  const again = await writeRunNotice(kv, EP, a, spec());
  c("an identical retry is this run's own earlier attempt, not a conflict", again.created === false, again);

  const differing = await caught(async () => await writeRunNotice(kv, EP, a, spec({ fact: { decision: "reverted", outcome: "ok" } })));
  c("a DIFFERENT decision under the same id is refused rather than overwritten",
    differing instanceof EpEnvelopeError && (differing as EpEnvelopeError).code === "conflict",
    (differing as EpEnvelopeError)?.code);

  const read = await readRunNotice(kv, EP, RUN, PLANNER, a);
  c("the notice reads back with the decision it was filed with",
    read?.spec.fact.decision === "shipped", read?.spec);
  c("and with the step that decided it, which the migrate rule needs",
    read?.spec.step === "/notify:told#0", read?.spec.step);
  c("nothing has consumed it yet", read?.consumed === undefined, read?.consumed);
}

// ── 3) consumption, decided by the store and by nothing else ───────────────────────────────────
{
  const id = runNoticeId("c".repeat(43), PLANNER);
  await writeRunNotice(kv, EP, id, spec({ at: NOW + 1 }));

  await markRunNoticeConsumed(kv, EP, RUN, PLANNER, id, "goal-1", NOW + 5);
  const read = await readRunNotice(kv, EP, RUN, PLANNER, id);
  c("a consumption records WHICH turn carried it", read?.consumed?.by === "goal-1", read?.consumed);
  c("and when", read?.consumed?.consumedAt === NOW + 5, read?.consumed);

  const second = await caught(async () => await markRunNoticeConsumed(kv, EP, RUN, PLANNER, id, "goal-2", NOW + 6));
  c("a second turn claiming the same notice loses loudly: the create-only CAS is the only arbiter",
    second instanceof EpEnvelopeError && (second as EpEnvelopeError).code === "conflict",
    (second as EpEnvelopeError)?.code);
  const after = await readRunNotice(kv, EP, RUN, PLANNER, id);
  c("and the winner is unchanged", after?.consumed?.by === "goal-1", after?.consumed);

  const missing = await caught(async () =>
    await markRunNoticeConsumed(kv, EP, RUN, PLANNER, runNoticeId("z".repeat(43), PLANNER), "goal-3", NOW));
  c("consuming a notice nobody filed is a failed precondition, not a new record",
    missing instanceof EpEnvelopeError && (missing as EpEnvelopeError).code === "failed-precondition",
    (missing as EpEnvelopeError)?.code);
}

// ── 4) the two enumerations, and the one-token difference between them ─────────────────────────
{
  const toBuilder = runNoticeId("b".repeat(43), BUILDER);
  await writeRunNotice(kv, EP, toBuilder, spec({ addressee: BUILDER, at: NOW + 2, step: "/notify:told#1" }));
  const onOtherRun = runNoticeId("o".repeat(43), PLANNER);
  await writeRunNotice(kv, EP, onOtherRun, spec({ run: OTHER_RUN, at: NOW + 3 }));

  // ORDER, built so id order and decision order DISAGREE. Two notices whose ids happen to sort the
  // way they were decided would pass against a list sorted by id, which is a different contract:
  // the render is a table read top to bottom and `at` is what a reader is following.
  const REVIEWER = "local.reviewer-3";
  const pair = [runNoticeId("1".repeat(43), REVIEWER), runNoticeId("2".repeat(43), REVIEWER)].sort();
  await writeRunNotice(kv, EP, pair[0] as string,
    spec({ addressee: REVIEWER, at: NOW + 90, step: "/notify:told#9" }));
  await writeRunNotice(kv, EP, pair[1] as string,
    spec({ addressee: REVIEWER, at: NOW + 10, step: "/notify:told#8" }));
  const ordered = await listRunNotices(kv, EP, RUN, REVIEWER);
  c("the earlier DECISION comes first even though its id sorts later",
    ordered[0]?.noticeId === pair[1] && ordered[1]?.noticeId === pair[0],
    ordered.map((n) => ({ id: n.noticeId.slice(0, 6), at: n.spec.at })));

  const mine = await listRunNotices(kv, EP, RUN, PLANNER);
  c("the per-addressee list returns this agent's notices", mine.length >= 2, mine.map((n) => n.noticeId));
  c("and nobody else's", mine.every((n) => n.spec.addressee === PLANNER), mine.map((n) => n.spec.addressee));
  c("and one agent's own list is oldest-first too",
    mine.every((n, i) => i === 0 || (mine[i - 1] as { spec: { at: number } }).spec.at <= n.spec.at),
    mine.map((n) => n.spec.at));

  const all = await listRunNoticesForRun(kv, EP, RUN);
  // THE LOAD-BEARING ONE. A filter one wildcard short matches a key shape that does not exist, so
  // this list comes back EMPTY — and an empty list is the answer "nothing was ever filed", which
  // the migrate rule would read as "there is nothing undelivered here".
  c("the per-RUN list spans every addressee on the run",
    all.some((n) => n.spec.addressee === PLANNER) && all.some((n) => n.spec.addressee === BUILDER),
    all.map((n) => n.spec.addressee));
  c("it is not empty, which is the failure a one-token-short filter produces", all.length >= 5, all.length);
  c("and it is scoped to the run: another run's notices are not on it",
    all.every((n) => n.spec.run === RUN), all.map((n) => n.spec.run));
  c("the other run has its own", (await listRunNoticesForRun(kv, EP, OTHER_RUN)).length === 1,
    (await listRunNoticesForRun(kv, EP, OTHER_RUN)).map((n) => n.spec.run));
  c("each entry carries the step that decided it, which is how a run-wide list maps back to entries",
    all.every((n) => n.spec.step.startsWith("/notify:")), all.map((n) => n.spec.step));
}

console.log(`run-notice.smoke: ${ok} passed, ${fail} failed`);
done();
process.exit(fail === 0 ? 0 : 1);
