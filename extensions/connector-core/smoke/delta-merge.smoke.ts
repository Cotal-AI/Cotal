/**
 * Streamed deltas reach the event plane in one order, whenever and from wherever they are read.
 *
 * A harness JSONL file and its delta journal go through `DeltaMergedSource`: journal lines land
 * before the first harness record that ends after their anchor; a read from any record's cursor
 * answers the same records under the same cursors, as a restart does; a line anchored past the
 * harness read waits for the next read, and a line journaled late goes where the read starts.
 * `DeltaJournal` writes at most one line per 250 ms, mode 0600. `StreamedParts` closes a streamed
 * part with the rest of its saved text, ends it and maps the saved text anew after a provider retry,
 * and leaves a part that never streamed to the mapper. `streamSeed` rebuilds that state at a cursor.
 *
 * Files only; no broker. Run: pnpm smoke:delta-merge
 */
import { execFileSync } from "node:child_process";
import { appendFileSync, chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Part } from "@cotal-ai/core";
import { memorySubjectFrontier } from "@cotal-ai/smoke-kit";
import {
  AGUI_EVENT_TYPE, AguiEmitter, DELTA_JOURNAL_INTERVAL_MS, DeltaJournal, DeltaMergedSource, EventWal, JsonlFileSource, StreamedParts,
  runStarted, streamSeed, textMessageContent, textMessageEnd, textMessageStart,
  type AguiEvent, type DeltaRecord, type EmitterEndpoint, type Merged, type OrderedSource, type RecordMapper, type SourceRead, type StreamDelta, type StreamSeed,
} from "../src/index.js";

let passed = 0;
let failed = 0;
const check = (label: string, ok: boolean, extra?: unknown): void => {
  if (ok) { passed++; console.log(`  ✓ ${label}`); return; }
  failed++;
  console.log(`  FAIL  ${label}${extra !== undefined ? ` — ${JSON.stringify(extra)}` : ""}`);
};
const throws = async (fn: () => Promise<unknown>): Promise<string | undefined> => {
  try {
    await fn();
    return undefined;
  } catch (e) {
    return (e as Error).message;
  }
};

type H = { i: string };
const label = (v: Merged<H>): string => ("harness" in v ? v.harness.i : v.deltas.map((d) => d.text).join("+"));
const labels = (r: SourceRead<Merged<H>>): string => r.records.map((x) => label(x.value)).join(",");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const root = mkdtempSync(join(tmpdir(), "cotal-delta-merge-"));
let n = 0;
/** A fresh harness file, journal and merged source. `line` journals text at the harness's end now,
 *  or at a given anchor. */
function fixture() {
  const dir = mkdtempSync(join(root, `f${n++}-`));
  const hPath = join(dir, "harness.jsonl");
  const jPath = join(dir, "deltas.jsonl");
  writeFileSync(hPath, "");
  writeFileSync(jPath, "", { mode: 0o600 });
  const harness = new JsonlFileSource<H>(hPath);
  const merged = new DeltaMergedSource<H>(harness, jPath);
  const record = (i: string) => appendFileSync(hPath, `${JSON.stringify({ i })}\n`);
  const line = (text: string, anchor = harness.endSync(), ts = 1) =>
    appendFileSync(jPath, `${JSON.stringify({ anchor, ts, deltas: [{ key: "k", kind: "text", text }] } satisfies DeltaRecord)}\n`);
  return { dir, hPath, jPath, harness, merged, record, line };
}

try {
  console.log("merge order");
  {
    const f = fixture();
    const c0 = f.merged.start(await f.harness.cursorAtBeginning());
    f.line("L0"); f.record("R1"); f.record("R2"); f.line("L1"); f.record("R3"); f.line("L2"); f.line("L3"); f.record("R4");
    const full = await f.merged.read(c0);
    check("journal lines sit after the records written before them and before the ones after",
      labels(full) === "L0,R1,R2,L1,R3,L2,L3,R4", labels(full));
    check("the read's cursor is the merged end now", full.cursor === (await f.merged.end()), { cursor: full.cursor });
    check("a read from that end answers nothing", (await f.merged.read(full.cursor)).records.length === 0);

    console.log("restart from every record cursor");
    let same = true;
    for (const [i, rec] of full.records.entries()) {
      const again = await f.merged.read(rec.cursor);
      const want = full.records.slice(i + 1);
      if (again.records.length !== want.length || again.records.some((r, k) => r.cursor !== want[k]!.cursor || label(r.value) !== label(want[k]!.value))) same = false;
    }
    check("a read from each record's cursor answers the rest, under the same cursor strings", same);

    console.log("read while written");
    const g = fixture();
    let at = g.merged.start(await g.harness.cursorAtBeginning());
    const live: { cursor: string; label: string }[] = [];
    const pump = async () => {
      const r = await g.merged.read(at);
      live.push(...r.records.map((x) => ({ cursor: x.cursor, label: label(x.value) })));
      at = r.cursor;
    };
    const start = at;
    for (const step of [() => g.line("L0"), () => g.record("R1"), () => g.record("R2"), () => g.line("L1"), () => g.record("R3"), () => g.line("L2")]) {
      step();
      await pump();
    }
    const replay = await g.merged.read(start);
    check("pumping after every write and one read after a restart give the same records and cursors",
      JSON.stringify(live) === JSON.stringify(replay.records.map((x) => ({ cursor: x.cursor, label: label(x.value) }))), { live, replay: labels(replay) });
  }

  console.log("hold and late lines");
  {
    const f = fixture();
    f.record("R1");
    const c = f.merged.start(f.harness.endSync());
    // The harness grows between the merged read's harness read and its journal read.
    const racing: OrderedSource<H> = {
      kind: "racing",
      end: () => f.harness.end(),
      compare: (a, b) => f.harness.compare(a, b),
      read: async (cursor) => {
        const r = await f.harness.read(cursor);
        f.record("R2");
        f.line("L-after-R2");
        return r;
      },
    };
    const first = await new DeltaMergedSource<H>(racing, f.jPath).read(c);
    check("a line anchored past the harness read waits", labels(first) === "", labels(first));
    const second = await f.merged.read(first.cursor);
    check("the next read places it after the record it was written after", labels(second) === "R2,L-after-R2", labels(second));

    const old = (await f.harness.read(await f.harness.cursorAtBeginning())).records[0]!.cursor;
    f.line("L-late", old);
    const late = await f.merged.read(second.cursor);
    const startHarness = f.merged.harnessOf(second.cursor);
    check("a line journaled after its anchor was passed goes where the read starts",
      labels(late) === "L-late" && f.merged.harnessOf(late.records[0]!.cursor) === startHarness, { got: labels(late) });
  }

  console.log("a harness cursor stored alone");
  {
    const f = fixture();
    f.record("R1");
    f.line("L-before");
    const bare = f.harness.endSync();
    const r = await f.merged.read(bare);
    check("starts the journal at its end, so lines written before it are not replayed", labels(r) === "", labels(r));
    f.line("L-after");
    f.record("R2");
    check("and reads what comes after", labels(await f.merged.read(r.cursor)) === "L-after,R2");
    check("its harness half is itself", f.merged.harnessOf(bare) === bare);
    check("a malformed merged cursor is refused", (await throws(() => f.merged.read('["only one"]')))?.includes("malformed cursor") === true);
  }

  console.log("journal lines");
  {
    const f = fixture();
    const c = f.merged.start(f.harness.endSync());
    appendFileSync(f.jPath, `${JSON.stringify({ anchor: f.harness.endSync(), ts: 1, deltas: [] })}\n`);
    check("a JSON line that is not a delta record throws", (await throws(() => f.merged.read(c)))?.includes("not a delta record") === true);
    const g = fixture();
    const d = g.merged.start(g.harness.endSync());
    appendFileSync(g.jPath, '{"anchor":"torn\n');
    g.line("L1");
    const r = await g.merged.read(d);
    check("a torn line is reported as a gap of the journal and stepped over",
      labels(r) === "L1" && r.unreadable?.length === 1 && r.unreadable[0]!.file === g.jPath, r.unreadable);
  }

  console.log("the writer");
  {
    const f = fixture();
    const path = join(f.dir, "written.jsonl");
    let writes = 0;
    const errors: Error[] = [];
    const journal = DeltaJournal.open({ path, anchor: () => f.harness.endSync(), onWrite: () => writes++, onError: (e) => errors.push(e) });
    check("the journal is created readable only by its owner", (statSync(path).mode & 0o777) === 0o600, (statSync(path).mode & 0o777).toString(8));
    let sent = "";
    const began = Date.now();
    for (let i = 0; Date.now() - began < 1200; i++) {
      journal.append({ key: "k", kind: "text", text: `t${i} ` });
      sent += `t${i} `;
      await sleep(10);
    }
    await sleep(DELTA_JOURNAL_INTERVAL_MS + 100);
    const lines = readFileSync(path, "utf8").trim().split("\n").map((l) => JSON.parse(l) as DeltaRecord);
    const gaps = lines.slice(1).map((l, i) => l.ts - lines[i]!.ts);
    check("at most one line per 250 ms", lines.length <= Math.ceil(1200 / DELTA_JOURNAL_INTERVAL_MS) + 1 && gaps.every((g) => g >= DELTA_JOURNAL_INTERVAL_MS),
      { lines: lines.length, gaps });
    check("the lines carry every delta, coalesced per key, in order", lines.map((l) => l.deltas.map((d) => d.text).join("")).join("") === sent);
    check("each line woke the reader once", writes === lines.length && errors.length === 0, { writes, errors: errors.map((e) => e.message) });
    journal.append({ key: "k", kind: "text", text: "never written" });
    journal.settle();
    await sleep(DELTA_JOURNAL_INTERVAL_MS + 100);
    check("settle drops the text not yet written", !readFileSync(path, "utf8").includes("never written"));
    check("a key cannot change kind", (await throws(async () => {
      journal.append({ key: "k", kind: "text", text: "a" });
      journal.append({ key: "k", kind: "reasoning", text: "b" });
    }))?.includes("streamed as text") === true);
    journal.close();
    check("a closed journal refuses appends", (await throws(async () => journal.append({ key: "k", kind: "text", text: "x" })))?.includes("closed") === true);
    const open = join(f.dir, "open.jsonl");
    writeFileSync(open, "");
    chmodSync(open, 0o644);
    check("a journal others can read is refused", (await throws(async () => DeltaJournal.open({ path: open, anchor: () => "", onWrite: () => {}, onError: () => {} })))?.includes("only it can read") === true);
  }

  console.log("streamed parts");
  {
    const types = (events: { type: string }[]) => events.map((e) => e.type).join(",");
    const parts = new StreamedParts();
    const a1 = parts.delta({ key: "a", kind: "text", text: "Hel" }, 1);
    const a2 = parts.delta({ key: "a", kind: "text", text: "lo" }, 2);
    const a3 = parts.saved("a", "Hello world", 3);
    check("a part opens at its first delta and adds content for each",
      types(a1) === `${AGUI_EVENT_TYPE.TEXT_MESSAGE_START},${AGUI_EVENT_TYPE.TEXT_MESSAGE_CONTENT}` && types(a2) === AGUI_EVENT_TYPE.TEXT_MESSAGE_CONTENT);
    check("its saved text sends the rest and ends it", !a3.mapAsNew && types(a3.events) === `${AGUI_EVENT_TYPE.TEXT_MESSAGE_CONTENT},${AGUI_EVENT_TYPE.TEXT_MESSAGE_END}` &&
      (a3.events[0] as { delta?: string }).delta === " world");
    const text = [...a1, ...a2, ...a3.events].flatMap((e) => ((e as { delta?: string }).delta ?? [])).join("");
    check("the streamed text and the rest are the saved text", text === "Hello world", text);
    parts.delta({ key: "b", kind: "text", text: "Hello wor" }, 4);
    const retry = parts.saved("b", "Goodbye", 5);
    check("a saved text that does not continue the stream ends it and is mapped anew",
      retry.mapAsNew && types(retry.events) === AGUI_EVENT_TYPE.TEXT_MESSAGE_END);
    const never = parts.saved("c", "unstreamed", 6);
    check("a part that never streamed is left to the mapper", never.mapAsNew && never.events.length === 0);
    check("a delta of a closed part publishes nothing", parts.delta({ key: "a", kind: "text", text: "late" }, 7).length === 0);
    parts.delta({ key: "r", kind: "reasoning", text: "think" }, 8);
    check("endAll ends what is still open", types(parts.endAll(9)) === AGUI_EVENT_TYPE.REASONING_MESSAGE_END && parts.endAll(10).length === 0);
    check("one key keeps one kind", (await throws(async () => {
      parts.delta({ key: "x", kind: "text", text: "a" }, 11);
      parts.delta({ key: "x", kind: "reasoning", text: "b" }, 12);
    }))?.includes("is text") === true);
  }

  console.log("a line another process journals after the reader passed its anchor");
  {
    const f = fixture();
    const c0 = f.merged.start(f.harness.endSync());
    f.record("R1");
    const anchor = f.harness.endSync(); // the other process takes its anchor here...
    f.record("R2");
    const published: AguiEvent[] = [];
    const ep: EmitterEndpoint = {
      principal: { owner: "local", actor: "seat" }, actorIsEphemeral: false, maxPayload: 100_000,
      assertExpectationSemantics: async () => {},
      encodedSize: (o) => Buffer.byteLength(JSON.stringify(o)) + 100,
      multicastExpecting: async (o) => {
        for (const p of o.parts as Part[]) published.push(...((p as unknown as { events?: AguiEvent[] }).events ?? []));
        return { ack: { seq: published.length, duplicate: false } };
      },
    };
    const walPath = join(f.dir, "wal.json");
    const frontier = memorySubjectFrontier();
    // A mapper over the merged records: the run opens at the first record, each harness record is a
    // message of its own, and each journal line streams into one part.
    const mapper = (run: string | undefined, seed?: StreamSeed): RecordMapper<Merged<H>> => {
      let open = run;
      const parts = new StreamedParts(seed);
      return (r) => {
        const events: AguiEvent[] = [];
        if (!open) events.push(runStarted({ threadId: "t", runId: (open = "run"), timestamp: 1 }));
        if ("deltas" in r) events.push(...r.deltas.flatMap((d) => parts.delta(d, r.timestamp)));
        else events.push(textMessageStart({ messageId: r.harness.i, timestamp: 1 }), textMessageContent({ messageId: r.harness.i, delta: r.harness.i, timestamp: 1 }), textMessageEnd({ messageId: r.harness.i, timestamp: 1 }));
        return { runId: open, events };
      };
    };
    const boot = async () => {
      const wal = await EventWal.open(walPath, { space: "s", threadId: "t", principal: "local.seat", subjectMayExist: false });
      if (wal.frontier.sourceCursor === undefined) await wal.advanceCursorOnly(c0);
      const seed = await streamSeed(f.jPath, wal.frontier.sourceCursor, wal.brackets);
      return AguiEmitter.start({ endpoint: ep, wal, subjectFrontier: frontier, source: f.merged, map: mapper(wal.brackets?.run, seed) });
    };
    const first = await boot();
    await first.pump();
    // ...and writes its line only now, after the reader passed the anchor.
    execFileSync(process.execPath, ["-e", `require("node:fs").appendFileSync(${JSON.stringify(f.jPath)}, ${JSON.stringify(`${JSON.stringify({ anchor, ts: 2, deltas: [{ key: "late", kind: "text", text: "LATE" }] })}\n`)})`]);
    await first.pump();
    const second = await boot(); // a restart resumes from the acknowledged cursor
    await second.pump();
    f.record("R3");
    await second.pump();
    const third = await boot();
    await third.pump();
    const texts = published.filter((e) => e.type === AGUI_EVENT_TYPE.TEXT_MESSAGE_CONTENT).map((e) => (e as { delta: string }).delta);
    check("the late line is published once, after the records already published, across restarts",
      JSON.stringify(texts) === JSON.stringify(["R1", "R2", "LATE", "R3"]), texts);
  }

  console.log("restart seed");
  {
    const f = fixture();
    const c0 = f.merged.start(f.harness.endSync());
    const write = (deltas: StreamDelta[]) =>
      appendFileSync(f.jPath, `${JSON.stringify({ anchor: f.harness.endSync(), ts: 1, deltas } satisfies DeltaRecord)}\n`);
    write([{ key: "open", kind: "text", text: "Hel" }, { key: "done", kind: "reasoning", text: "x" }]);
    write([{ key: "open", kind: "text", text: "lo" }]);
    const upTo = (await f.merged.read(c0)).cursor;
    write([{ key: "open", kind: "text", text: " after" }]);
    const seed = await streamSeed(f.jPath, upTo, { run: "run", text: ["open"], reasoning: [], tools: [] });
    check("a part the brackets hold open resumes with what streamed up to the cursor",
      JSON.stringify(seed.open) === JSON.stringify([{ key: "open", kind: "text", text: "Hello" }]), seed.open);
    check("every other part seen is closed", JSON.stringify(seed.closed) === JSON.stringify(["done"]), seed.closed);
    const resumed = new StreamedParts(seed);
    const closed = resumed.saved("open", "Hello world", 2);
    check("the resumed part closes with the rest of its saved text", (closed.events[0] as { delta?: string }).delta === " world");
    check("a harness cursor stored alone streamed nothing", (await streamSeed(f.jPath, f.harness.endSync(), null)).open.length === 0);
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
