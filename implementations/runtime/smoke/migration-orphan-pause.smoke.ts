/** A migration's pending orphan pauses, driven through startRun and the real timer writer. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "@nats-io/transport-node";
import { jetstream, jetstreamManager } from "@nats-io/jetstream";
import { Kvm } from "@nats-io/kv";
import {
  isReachable, createEndpointStreams, createSpaceStreams, openRecordsBucket,
  timerWriterContext, timerWriterConsumerConfig, timerWriterDurable, armCheckpointTimer,
  readCheckpointStatus, eptReqStreamName, replayRunJournal, newTakeoverId,
  readRunRecord, listRunMigrations, chatStream,
} from "@cotal-ai/core";
import { type JournalEntry } from "@cotal-ai/lang";
import { MeshHandler, EpfSettleWatcher, startRun, migrateRun, commitMigration, waitConsumerName } from "../src/index.js";
import { pickFreePort } from "./_free-port.js";
import { withDeadline, SMOKE_BROKER_TOKEN, teardownOnSignal } from "@cotal-ai/smoke-kit";

const SPACE = "migrationpause";
const EP = "manager";
const port = await pickFreePort();
const store = mkdtempSync(join(tmpdir(), `${SMOKE_BROKER_TOKEN}migration-pause-`));
const broker = spawn("nats-server", ["-js", "-sd", store, "-p", String(port), "-a", "127.0.0.1"], { stdio: "ignore" });
teardownOnSignal(broker, store);
const cleanup = () => { broker.kill("SIGKILL"); rmSync(store, { recursive: true, force: true }); };
process.on("exit", cleanup);
const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
async function until(test: () => Promise<boolean>, label: string): Promise<void> {
  for (let n = 0; n < 80; n++) { if (await test()) return; await delay(100); }
  throw new Error(`timed out: ${label}`);
}
await until(() => isReachable(`nats://127.0.0.1:${port}`), "isolated broker");
const nc = await connect({ servers: `nats://127.0.0.1:${port}` });
const js = jetstream(nc);
const jsm = await jetstreamManager(nc);
await createEndpointStreams(jsm, new Kvm(nc), SPACE);
await createSpaceStreams(jsm, SPACE);
const kv = await openRecordsBucket(nc, SPACE);
await jsm.consumers.add(eptReqStreamName(SPACE), timerWriterConsumerConfig(SPACE, { ackWaitMs: 5_000 }));
const writer = await js.consumers.get(eptReqStreamName(SPACE), timerWriterDurable(SPACE));
const context = await timerWriterContext(nc, SPACE);
let passed = 0, failed = 0;
function check(name: string, value: boolean): void {
  if (value) passed++; else { failed++; console.error(`FAIL: ${name}`); }
}
const entriesFor = async (run: string): Promise<JournalEntry[]> => {
  const replay = await replayRunJournal(js, jsm, SPACE, run, newTakeoverId());
  return replay.records.filter(r => r.record.kind === "step").map(r => (r.record as { entry: JournalEntry }).entry);
};
try {
  for (const kind of ["sleep", "wait"] as const) {
    const run = `orphan-${kind}`;
    const handler = new MeshHandler(nc, kv, js, jsm, {
      space: SPACE, endpoint: EP, runId: run,
      caller: { owner: "local", actor: "wf_migration", uid: "a".repeat(26) },
      instanceId: "i".repeat(26), epoch: 1,
      holder: { id: "manager", lifecycleUid: "u_migration" }, defaultCheckpointTimeout: "1h",
    }, new EpfSettleWatcher(jsm, SPACE, 3_000), Date.now);
    const source = kind === "sleep" ? 'await sleep("30m");' : 'await wait(message(channel("general")), { timeout: "30m" });';
    const drive = startRun(js, jsm, {
      space: SPACE, endpoint: EP, kv, runId: run, source, handler,
      lease: { holder: "m1", epoch: 1, fencingToken: 1, takeoverId: newTakeoverId() },
    }).then(value => ({ value }), error => ({ error }));
    let entries: JournalEntry[] = [];
    let pending: JournalEntry | undefined;
    try {
      await until(async () => {
        entries = await entriesFor(run);
        pending = entries.find(e => e.kind === kind && e.state === "pending" && e.requestId !== undefined);
        return pending !== undefined && (await readCheckpointStatus(kv, { endpoint: EP, token: pending.requestId! }))?.value.state === "waiting";
      }, `${kind} journal and durable pause`);
      assert(pending?.requestId);
      check(`${kind}: real run recorded a waiting pause`, true);
      let armed = 0;
      for await (const m of await writer.fetch({ max_messages: 1, expires: 1_000 })) {
        if ((await armCheckpointTimer(context, { subject: m.subject, headers: m.headers, data: m.data })).armed) armed++;
        m.ack();
      }
      check(`${kind}: real timer writer armed one schedule`, armed === 1);
      if (kind === "wait") check("wait owns a durable consumer before commit", (await jsm.consumers.list(chatStream(SPACE)).next()).some(c => c.name === waitConsumerName(pending!.requestId!)));
      const record = await readRunRecord(kv, EP, run);
      assert(record);
      const report = await migrateRun({ endpoint: EP, runId: run, source: 'log("moved on");', entries,
        pins: record.spec.value.pins as unknown as Parameters<typeof migrateRun>[0]["pins"], kv, actor: "fixture", now: Date.now });
      check(`${kind}: migration is admissible and reports the orphan`, report.admissible && report.orphans.some(o => o.kind === kind && o.verdict === "ignored"));
      const blind = await commitMigration(kv, EP, report, "migration-driver").then(() => undefined, error => error as Error);
      check(`${kind}: missing handler refuses without recording a migration`, blind instanceof Error && (await listRunMigrations(kv, EP, run)).length === 0);
      const cleanupError = new Error("fixture pause cleanup failed before effects");
      const failedCleanup = await commitMigration(kv, EP, report, "migration-driver", { entries, handler: {
        discharge: handler.discharge.bind(handler), endPause: async () => { throw cleanupError; },
      } }).then(() => undefined, error => error);
      check(`${kind}: cleanup failure propagates before the migration record`, failedCleanup === cleanupError && (await listRunMigrations(kv, EP, run)).length === 0);
      check(`${kind}: refused commits leave the original pause waiting`, (await readCheckpointStatus(kv, { endpoint: EP, token: pending.requestId }))?.value.state === "waiting");
      const committed = await commitMigration(kv, EP, report, "migration-driver", { entries, handler });
      check(`${kind}: one migration record was filed`, committed.created && (await listRunMigrations(kv, EP, run)).length === 1);
      const after = await readCheckpointStatus(kv, { endpoint: EP, token: pending.requestId });
      check(`${kind}: commit ended the orphan pause`, after?.value.state === "resumed");
      if (kind === "wait") check("commit removed the orphan wait consumer", !(await jsm.consumers.list(chatStream(SPACE)).next()).some(c => c.name === waitConsumerName(pending!.requestId!)));
      // Positive control on the baseline, idempotence on the fix: the real pause plane can end it.
      await handler.endPause(pending);
      check(`${kind}: explicit endPause leaves no waiting pause`, (await readCheckpointStatus(kv, { endpoint: EP, token: pending.requestId }))?.value.state === "resumed");
    } finally {
      if (pending) await handler.endPause(pending);
      await withDeadline(drive, 15_000, `${kind} fixture driver cleanup`);
    }
  }
} finally {
  await nc.close();
  cleanup();
  process.removeListener("exit", cleanup);
}
console.log(`migration orphan pause: ${passed} passed, ${failed} failed`);
assert.equal(passed + failed, 20, "all native cells ran");
if (failed) process.exitCode = 1;
