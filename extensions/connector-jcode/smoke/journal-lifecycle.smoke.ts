import assert from "node:assert/strict";
import { mkdtemp, writeFile, appendFile, rm, rename, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AguiBrackets, JsonlFileSource } from "@cotal-ai/connector-core";
import { JcodeJournalSource } from "../src/agui-source.js";
import { createJcodeMapper, type JcodeJournalRecord } from "../src/agui-map.js";

const root = await mkdtemp(join(tmpdir(), "jcode-checkpoint-"));
let checked = 0, failed = 0;
const check = async (name: string, run: () => Promise<void>) => {
  checked++;
  try { await run(); console.log(`ok ${name}`); }
  catch (error) { failed++; console.log(`FAIL ${name}: ${(error as Error).message}`); }
};
const start = { role: "assistant", content: [{ type: "tool_use", id: "call-1", name: "bash" }] };
const result = { role: "user", content: [{ type: "tool_result", tool_use_id: "call-1" }] };
const line = (record: JcodeJournalRecord) => `${JSON.stringify(record)}\n`;
const snapshot = (id: string) => writeFile(join(root, `${id}.json`), JSON.stringify({ id, messages: [start] }));
try {
  await check("checkpoint during an open tool preserves valid event brackets", async () => {
    const path = join(root, "open.journal.jsonl");
    await writeFile(path, line({ append_messages: [start] }));
    const source = new JcodeJournalSource(path, 30);
    const mapper = createJcodeMapper({ threadId: "open", mintRunId: () => "run-open" });
    const brackets = new AguiBrackets();
    const first = await source.read(undefined);
    for (const r of first.records) for (const e of mapper.map({ cursor: r.cursor, record: r.value })?.events ?? []) brackets.accept(e);
    await snapshot("open");
    await writeFile(path, "");
    const next = await source.read(first.cursor);
    const events = next.records.flatMap(r => mapper.map({ cursor: r.cursor, record: r.value })?.events ?? []);
    for (const e of events) brackets.accept(e);
    assert(events.some(e => e.type === "RUN_ERROR" && e.code === "jcode_journal_fold"));
    assert(!events.some(e => e.type === "RUN_FINISHED"));
    brackets.assertClosed();
  });
  await check("a post-checkpoint tool result without its start is an explicit valid discontinuity", async () => {
    const path = join(root, "unseen.journal.jsonl");
    await writeFile(path, line({ append_messages: [] }));
    const source = new JcodeJournalSource(path, 30);
    const first = await source.read(undefined);
    await snapshot("unseen");
    await rm(path);
    await writeFile(path, line({ append_messages: [result] }));
    const next = await source.read(first.cursor);
    const mapper = createJcodeMapper({ threadId: "unseen", mintRunId: () => "run-unseen" });
    const brackets = new AguiBrackets();
    const events = next.records.flatMap(r => mapper.map({ cursor: r.cursor, record: r.value })?.events ?? []);
    for (const e of events) brackets.accept(e);
    assert(events.some(e => e.type === "RUN_ERROR" && e.code === "jcode_tool_start_missing"));
    assert(!events.some(e => e.type === "TOOL_CALL_END" || e.type === "TOOL_CALL_START" || e.type === "RUN_FINISHED"));
    brackets.assertClosed();
  });
  await check("snapshot-before-unlink with a long tool does not turn a checkpoint into ENOENT", async () => {
    const path = join(root, "absent.journal.jsonl");
    await writeFile(path, line({ append_messages: [start] }));
    const source = new JcodeJournalSource(path, 30);
    const first = await source.read(undefined);
    await snapshot("absent");
    const between = await source.read(first.cursor);
    await rm(path);
    const waiting = await source.read(between.cursor);
    assert.equal(waiting.cursor, between.cursor);
    assert.equal(waiting.records.length, 1);
    assert(waiting.records[0]?.value.journal_fold);
    await writeFile(path, line({ append_messages: [result] }));
    const resumed = await source.read(waiting.cursor);
    assert(resumed.records.some(r => r.value.journal_fold));
    assert.equal(resumed.records.at(-1)?.value.append_messages?.[0]?.content?.[0]?.tool_use_id, "call-1");
  });
  await check("restart restores open tool observations without manufacturing a gap", async () => {
    const before = createJcodeMapper({ threadId: "restart", mintRunId: () => "run-restart" });
    const brackets = new AguiBrackets();
    for (const e of before.map({ cursor: "before", record: { append_messages: [start] } })!.events) brackets.accept(e);
    const saved = brackets.snapshot();
    const restored = createJcodeMapper({ threadId: "restart", mintRunId: () => "unexpected", resumeRunId: saved.run, resumeTools: saved.tools });
    const events = restored.map({ cursor: "after", record: { append_messages: [result] } })!.events;
    assert.deepEqual(events.map(e => e.type), ["TOOL_CALL_END"]);
    for (const e of events) brackets.accept(e);
    assert.deepEqual(brackets.snapshot().tools, []);
  });
  await check("a missing journal without a session snapshot still refuses", async () => {
    const path = join(root, "missing.journal.jsonl");
    await writeFile(path, line({ append_messages: [start] }));
    const source = new JcodeJournalSource(path, 10);
    const first = await source.read(undefined);
    await rm(path);
    await assert.rejects(source.read(first.cursor), { code: "ENOENT" });
  });
  await check("a foreign session snapshot cannot authorize a reset", async () => {
    const path = join(root, "foreign.journal.jsonl");
    await writeFile(path, line({ append_messages: [start] }));
    const source = new JcodeJournalSource(path, 10);
    const first = await source.read(undefined);
    await writeFile(join(root, "foreign.json"), JSON.stringify({ id: "other", messages: [start] }));
    await rm(path);
    await assert.rejects(source.read(first.cursor), /does not identify this session/);
  });
  await check("a symlinked session snapshot refuses", async () => {
    const path = join(root, "linked.journal.jsonl");
    await writeFile(path, line({ append_messages: [start] }));
    const source = new JcodeJournalSource(path, 10);
    const first = await source.read(undefined);
    await writeFile(join(root, "target.json"), JSON.stringify({ id: "linked", messages: [start] }));
    await symlink(join(root, "target.json"), join(root, "linked.json"));
    await rm(path);
    await assert.rejects(source.read(first.cursor));
  });
  await check("a valid snapshot cannot disguise a malformed cursor", async () => {
    const path = join(root, "cursor.journal.jsonl");
    await writeFile(path, line({ append_messages: [start] }));
    await snapshot("cursor");
    await assert.rejects(new JcodeJournalSource(path, 10).read("invalid"), /malformed cursor/);
  });
  await check("a missing journal cannot disguise a malformed cursor behind a valid snapshot", async () => {
    const path = join(root, "missing-invalid.journal.jsonl");
    await snapshot("missing-invalid");
    await assert.rejects(new JcodeJournalSource(path, 10).read("invalid"), /malformed cursor/);
  });
  await check("a valid snapshot cannot disguise an invalid complete journal record", async () => {
    const path = join(root, "invalid.journal.jsonl");
    await writeFile(path, line({ append_messages: [start] }));
    const source = new JcodeJournalSource(path, 10);
    const first = await source.read(undefined);
    await snapshot("invalid");
    await appendFile(path, "not-json\n");
    await assert.rejects(source.read(first.cursor));
  });
  await check("a same-size snapshot checkpoint is not mistaken for an append-only journal", async () => {
    const path = join(root, "same.journal.jsonl");
    await snapshot("same");
    await writeFile(path, line({ append_messages: [start] }));
    const source = new JcodeJournalSource(path, 10);
    const first = await source.read(undefined);
    await snapshot("same");
    await writeFile(path, "");
    const next = await source.read(first.cursor);
    assert(next.records.some(r => r.value.journal_fold));
  });
  await check("a checkpoint racing the new-journal adoption remains recoverable", async () => {
    const path = join(root, "racing.journal.jsonl");
    await writeFile(path, line({ append_messages: [start] }));
    const source = new JcodeJournalSource(path, 10);
    const first = await source.read(undefined);
    await snapshot("racing");
    await writeFile(path, "");
    const original = JsonlFileSource.prototype.read;
    let rotated = false;
    JsonlFileSource.prototype.read = async function(cursor) {
      if (!rotated && cursor !== first.cursor) {
        rotated = true;
        await writeFile(join(root, "replacement"), line({ append_messages: [result] }));
        await rename(join(root, "replacement"), path);
      }
      return original.call(this, cursor);
    };
    try {
      const waiting = await source.read(first.cursor);
      assert(rotated);
      assert.equal(waiting.cursor, first.cursor);
      assert(waiting.records[0]?.value.journal_fold);
    } finally {
      JsonlFileSource.prototype.read = original;
    }
    const next = await source.read(first.cursor);
    assert.equal(next.records.at(-1)?.value.append_messages?.[0]?.content?.[0]?.tool_use_id, "call-1");
  });
} finally { await rm(root, { recursive: true, force: true }); }
console.log(`checked=${checked} failed=${failed}`);
if (failed) process.exitCode = 1;
