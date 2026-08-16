/**
 * The migration record, proved against the source that implements it.
 *
 * A migration is append-only history with an actor on it, which is why it is its own kind rather
 * than a field on the run: a run's spec is decided once and its status is rewritten by every driver
 * heartbeat, and a run can migrate more than once.
 *
 * Four claims, each a different failure:
 *
 * 1. **The id is the report.** Derived from what the check found, so the retry a crash forces lands
 *    on the same record — and a different decision is a different migration, which it is.
 * 2. **The report is immutable.** Two decisions under one id would mean one identity holding two
 *    accounts of what a person authorised to discard.
 * 3. **Deciding and APPLYING are different acts.** The status is create-only, so two drivers racing
 *    to advance one run cannot both believe they did — but a driver finding its OWN application is
 *    looking at its own earlier attempt, and that is a retry rather than a race.
 * 4. **The history reads oldest first**, because a run's second migration is only interpretable
 *    beside its first.
 *
 * Run: pnpm smoke:run-migration   (needs nats-server on PATH)
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
  runMigrationId,
  writeRunMigration,
  readRunMigration,
  listRunMigrations,
  markRunMigrationApplied,
  type RunMigrationSpecValue,
} from "../src/index.js";
import { pickFreePort } from "./_free-port.js";

const SPACE = "runmigration";
const EP = "manager";
const RUN = "r-1";
const OTHER = "r-2";
const NOW = 1_770_000_000_000;

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
const sd = mkdtempSync(join(tmpdir(), "cotal-runmigration-"));
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

const content = (over: Partial<Omit<RunMigrationSpecValue, "at">> = {}): Omit<RunMigrationSpecValue, "at"> => ({
  v: 1,
  run: RUN,
  toHash: "sha256:aaaa",
  consumedThrough: 3,
  orphans: [{ step: "/checkpoint:approve#0", kind: "checkpoint", verdict: "kept" }],
  overrides: ["--discard-approvals"],
  actor: "david",
  ...over,
});

// ── 1) the id IS the report ────────────────────────────────────────────────────────────────────
{
  const a = runMigrationId(content());
  c("a migration id is a 43-character id token", a.length === 43, a);
  c("the same decision re-derives the same id after a crash", runMigrationId(content()) === a, a);
  c("a different actor is a different migration",
    runMigrationId(content({ actor: "sam" })) !== a, runMigrationId(content({ actor: "sam" })));
  c("so is a different override set",
    runMigrationId(content({ overrides: [] })) !== a, runMigrationId(content({ overrides: [] })));
  c("and so is a different orphan table, which is the thing a person authorised",
    runMigrationId(content({ orphans: [] })) !== a, runMigrationId(content({ orphans: [] })));
  c("a different target source is a different migration",
    runMigrationId(content({ toHash: "sha256:bbbb" })) !== a, "");
}

// ── 2) the report is filed once and never rewritten ────────────────────────────────────────────
{
  const id = runMigrationId(content());
  const w = await writeRunMigration(kv, EP, id, { ...content(), at: NOW });
  c("the first write creates", w.created === true, w);
  const key = parseRecordKey(w.key);
  c("it is a migration record with three qualifiers and a spec half",
    key?.def.kind === "migration" && key?.qualifiers.length === 3 && key?.part === "spec",
    { kind: key?.def.kind, n: key?.qualifiers.length, part: key?.part });

  const again = await writeRunMigration(kv, EP, id, { ...content(), at: NOW });
  c("an identical retry is this attempt's own earlier write", again.created === false, again);

  const differing = await caught(async () =>
    await writeRunMigration(kv, EP, id, { ...content(), at: NOW, consumedThrough: 99 }));
  c("a DIFFERENT report under the same id is refused rather than overwritten",
    differing instanceof EpEnvelopeError && (differing as EpEnvelopeError).code === "conflict",
    (differing as EpEnvelopeError)?.code);

  const read = await readRunMigration(kv, EP, RUN, id);
  c("it reads back with the orphan rows", read?.spec.orphans.length === 1, read?.spec.orphans);
  c("with the override a person passed", read?.spec.overrides[0] === "--discard-approvals", read?.spec.overrides);
  c("and with the actor who passed it", read?.spec.actor === "david", read?.spec.actor);
  c("fromHash is absent rather than approximate when the caller did not know one",
    read?.spec.fromHash === undefined, read?.spec.fromHash);
  c("nothing has applied it yet", read?.applied === undefined, read?.applied);
}

// ── 3) applying is a different act, and the store decides who did it ───────────────────────────
{
  const id = runMigrationId(content({ toHash: "sha256:cccc" }));
  await writeRunMigration(kv, EP, id, { ...content({ toHash: "sha256:cccc" }), at: NOW + 1 });

  await markRunMigrationApplied(kv, EP, RUN, id, "driver-1", NOW + 5);
  const read = await readRunMigration(kv, EP, RUN, id);
  c("the application names the driver that made it", read?.applied?.by === "driver-1", read?.applied);
  c("and when", read?.applied?.appliedAt === NOW + 5, read?.applied);

  const retry = await caught(async () => await markRunMigrationApplied(kv, EP, RUN, id, "driver-1", NOW + 6));
  c("the SAME driver re-applying is its own earlier attempt, not a race", retry === null, retry?.message?.slice(0, 120));
  const unchanged = await readRunMigration(kv, EP, RUN, id);
  c("and the retry does not move the recorded time", unchanged?.applied?.appliedAt === NOW + 5, unchanged?.applied);

  const raced = await caught(async () => await markRunMigrationApplied(kv, EP, RUN, id, "driver-2", NOW + 7));
  c("a DIFFERENT driver claiming it loses loudly: a run moves once",
    raced instanceof EpEnvelopeError && (raced as EpEnvelopeError).code === "conflict",
    (raced as EpEnvelopeError)?.code);
  c("and the loser is told who won", raced?.message.includes("driver-1") === true, raced?.message?.slice(0, 140));
  const after = await readRunMigration(kv, EP, RUN, id);
  c("the winner is unchanged", after?.applied?.by === "driver-1", after?.applied);

  const missing = await caught(async () =>
    await markRunMigrationApplied(kv, EP, RUN, runMigrationId(content({ toHash: "sha256:zzzz" })), "driver-1", NOW));
  c("applying a migration nobody filed is a failed precondition, not a new record",
    missing instanceof EpEnvelopeError && (missing as EpEnvelopeError).code === "failed-precondition",
    (missing as EpEnvelopeError)?.code);
}

// ── 4) the history, in the order it happened ───────────────────────────────────────────────────
{
  // Built so id order and decision order DISAGREE, or a list sorted by id would pass this too.
  const first = content({ toHash: "sha256:1111" });
  const second = content({ toHash: "sha256:2222" });
  const ids = [runMigrationId(first), runMigrationId(second)];
  const [earlyContent, lateContent] = ids[0]! < ids[1]! ? [second, first] : [first, second];
  await writeRunMigration(kv, EP, runMigrationId(earlyContent), { ...earlyContent, at: NOW + 10 });
  await writeRunMigration(kv, EP, runMigrationId(lateContent), { ...lateContent, at: NOW + 90 });

  const all = await listRunMigrations(kv, EP, RUN);
  c("the run's history holds every migration filed on it", all.length >= 4, all.length);
  c("the earlier DECISION comes first even though its id sorts later",
    all.findIndex((m) => m.migrationId === runMigrationId(earlyContent))
      < all.findIndex((m) => m.migrationId === runMigrationId(lateContent)),
    all.map((m) => ({ id: m.migrationId.slice(0, 6), at: m.spec.at })));
  c("and every row belongs to this run", all.every((m) => m.spec.run === RUN), all.map((m) => m.spec.run));

  const other = await listRunMigrations(kv, EP, OTHER);
  c("another run's history is empty, which is what scoping means", other.length === 0, other.length);
}

console.log(`run-migration.smoke: ${ok} passed, ${fail} failed`);
done();
process.exit(fail === 0 ? 0 : 1);
