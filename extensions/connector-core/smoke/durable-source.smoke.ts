/**
 * `[P6]` durable-source read — the cursor must survive a crash and must never consume a
 * half-written record.
 *
 * WHY THE PARTIAL-LINE CASE IS THE POINT. The writer is a separate process appending concurrently,
 * so a read lands mid-line routinely, not rarely. Parsing that yields a throw or — worse — a
 * truncated object that looks valid and gets published as if it were what the agent did. The rule
 * is: consume only up to the last newline, and advance the cursor only that far.
 *
 * MUTATION LEDGER — predicted, then CORRECTED from what actually died. Both runs are recorded
 * because one prediction was wrong in an instructive way.
 *
 *   M1  consume the whole chunk instead of stopping at the last newline
 *       predicted 2, ACTUAL 3: "a half-written trailing line is NOT consumed", "the fragment is
 *       delivered once the writer completes it", plus the harness's own unexpected-throw guard
 *       (the truncated JSON throws where the real code would not). Correct on all three.
 *
 *   M4  start a fresh adopt at 0 instead of the current end
 *       predicted 2, ACTUAL 1: only "a fresh adopt does not rebroadcast existing history".
 *       "the adopt cursor is the current end" SURVIVED — reading from 0 still advances the cursor
 *       to the end of the last complete line, i.e. the same value. **That cell does not
 *       discriminate this mutation**, and saying so is more useful than quietly counting it.
 *
 * The suite converts an unexpected throw into a cell failure rather than aborting. A run that dies
 * on the first surprise cannot report WHICH cells a mutation killed, and an illegible kill set is
 * indistinguishable from no mutation testing.
 *
 * Run: pnpm smoke:durable-source
 */
import { mkdtempSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonlFileSource } from "../src/durable-source.js";

let ok = 0, fail = 0;
const c = (n: string, v: boolean, extra?: unknown) => {
  if (v) { ok++; } else { fail++; console.log("  ✗ FAIL:", n, extra ?? ""); }
};

/** Read, converting an UNEXPECTED throw into a cell failure instead of crashing the suite.
 *  A run that aborts on the first surprise cannot report which cells a mutation killed, and an
 *  illegible kill set is the same as no mutation testing at all. */
const readOr = async <T>(src: JsonlFileSource<T>, cursor: string | undefined, what: string) => {
  try { return await src.read(cursor); }
  catch (e) { c(`${what} (unexpected throw)`, false, String(e)); return { records: [] as T[], cursor: cursor ?? "0" }; }
};

const dir = mkdtempSync(join(tmpdir(), "durable-source-"));
const path = join(dir, "session.jsonl");

try {
  // ── a fresh adopt starts at the END: an existing session is not rebroadcast ──
  writeFileSync(path, '{"i":1}\n{"i":2}\n');
  const src = new JsonlFileSource<{ i: number }>(path);
  const adopt = await readOr(src, undefined, "fresh adopt");
  // ONE cell asserting both halves: the separate cursor row did not discriminate M4 (reading from 0
  // still lands the cursor on the same value), so it read as coverage without being any
  // (fmae-rev-test F2). Folded rather than kept as a green tick that proves nothing.
  const off = (cur: string) => Number(cur.split(":")[2]);
  c("a fresh adopt reads nothing and starts at the last COMPLETE boundary",
    adopt.records.length === 0 && off(adopt.cursor) === Buffer.byteLength('{"i":1}\n{"i":2}\n'),
    adopt);

  // ── new complete records are read forward ──
  appendFileSync(path, '{"i":3}\n{"i":4}\n');
  const r1 = await readOr(src, adopt.cursor, "read forward");
  c("new complete records are read forward from the cursor", r1.records.length === 2 && r1.records[1].i === 4, r1.records);

  // ── nothing new: no records, cursor unmoved ──
  const r2 = await readOr(src, r1.cursor, "unchanged read");
  c("an unchanged file yields no records and does not move the cursor", r2.records.length === 0 && r2.cursor === r1.cursor, r2);

  // ── THE CASE: a half-written line must not be consumed ──
  appendFileSync(path, '{"i":5}\n{"i":6'); // no trailing newline: the writer is mid-line
  const r3 = await readOr(src, r2.cursor, "partial-line read");
  c("a half-written trailing line is NOT consumed", r3.records.length === 1 && r3.records[0].i === 5, r3.records);
  // EXACT, not an inequality. This read `< 46` while the correct stop is 40, so 32..45 all passed —
  // a wrong stop one byte either side would have gone unnoticed (fmae-rev-test F1). The expected
  // value is computed from the fixture bytes so it stays true if the fixture changes.
  const expectedStop = Buffer.byteLength('{"i":1}\n{"i":2}\n{"i":3}\n{"i":4}\n{"i":5}\n');
  c("the cursor stops EXACTLY at the end of the last complete line", off(r3.cursor) === expectedStop, { got: r3.cursor, want: expectedStop });

  // ── and it arrives once the writer finishes it ──
  appendFileSync(path, '}\n');
  const r4 = await readOr(src, r3.cursor, "completed-fragment read");
  c("the fragment is delivered once the writer completes it", r4.records.length === 1 && r4.records[0].i === 6, r4.records);

  // ── a complete but unparseable line is LOUD, never silently skipped ──
  appendFileSync(path, 'not json at all\n');
  let threw = false;
  try { await src.read(r4.cursor); } catch { threw = true; }
  c("an unparseable COMPLETE line fails loud", threw);

  // ── truncation/replacement is loud too: neither re-adopting nor re-sending is safe to guess ──
  writeFileSync(path, '{"i":1}\n');
  let truncThrew = false;
  try { await src.read(adopt.cursor.replace(/:\d+$/, ":9999")); } catch { truncThrew = true; }
  c("a cursor past the end (truncated or replaced file) fails loud", truncThrew);

  // ── a malformed cursor is refused rather than coerced ──
  let badCursor = false;
  try { await src.read("-1"); } catch { badCursor = true; }
  c("a malformed cursor is refused", badCursor);

  // ══ fmae-rev-sec, four CONFIRMED defects. Each cell reproduces the reviewer's own repro. ══

  // B1 — adopting INSIDE an unfinished line made the next read parse only the record's SUFFIX.
  //      The adopt path had the exact bug the read path exists to prevent.
  {
    const d = mkdtempSync(join(tmpdir(), "ds-b1-"));
    const f = join(d, "s.jsonl");
    writeFileSync(f, '{"i":1');                       // writer is mid-record
    const s1 = new JsonlFileSource<{ i: number }>(f);
    const a = await readOr(s1, undefined, "B1 adopt");
    appendFileSync(f, '2}\n');                        // completes it: the real record is {"i":12}
    const r = await readOr(s1, a.cursor, "B1 read");
    c("B1: adopting mid-record does not emit the record's suffix",
      r.records.length === 1 && r.records[0].i === 12, r.records);
    rmSync(d, { recursive: true, force: true });
  }

  // B2 — malformed UTF-8 was substituted with U+FFFD, so corrupted data PARSED and would publish.
  {
    const d = mkdtempSync(join(tmpdir(), "ds-b2-"));
    const f = join(d, "s.jsonl");
    writeFileSync(f, '{"a":1}\n');
    const s2 = new JsonlFileSource(f);
    const a = await readOr(s2, undefined, "B2 adopt");
    appendFileSync(f, Buffer.concat([Buffer.from('{"s":"'), Buffer.from([0xff]), Buffer.from('"}\n')]));
    let rejected = false;
    try { await s2.read(a.cursor); } catch { rejected = true; }
    c("B2: invalid UTF-8 is REJECTED, never silently rewritten to U+FFFD", rejected);
    rmSync(d, { recursive: true, force: true });
  }

  // B3 — a same-size-or-larger REPLACEMENT was read as an ordinary append.
  {
    const d = mkdtempSync(join(tmpdir(), "ds-b3-"));
    const f = join(d, "s.jsonl");
    writeFileSync(f, '{"a":1}\n');
    const s3 = new JsonlFileSource(f);
    const a = await readOr(s3, undefined, "B3 adopt");
    rmSync(f, { force: true });
    writeFileSync(f, '{"b":1}\n{"b":2}\n');           // unrelated file, LARGER than the cursor
    let detected = false;
    try { await s3.read(a.cursor); } catch { detected = true; }
    c("B3: a larger replacement file is DETECTED, not read as an append", detected);
    rmSync(d, { recursive: true, force: true });
  }

  // B4 — Number() coerced non-canonical cursors; " " became 0 and replayed all history.
  for (const bad of [" ", "1e0", "01", "+1", "", "x:y:1"]) {
    let refused = false;
    try { await src.read(bad); } catch { refused = true; }
    c(`B4: non-canonical cursor ${JSON.stringify(bad)} is refused`, refused);
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(`durable-source smoke: ${ok} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
