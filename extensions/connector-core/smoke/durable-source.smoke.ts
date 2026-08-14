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
 *       RE-MEASURED 2026-08-14 and the ledger was STALE — it named three and the mutation kills
 *       FOUR. The missing one is "the cursor stops EXACTLY at the end of the last complete line",
 *       a cell added after this entry was written, which is exactly how a kill-set claim rots:
 *       silently, on every cell addition, while still reading as authoritative. The full set:
 *         - "a half-written trailing line is NOT consumed"
 *         - "the cursor stops EXACTLY at the end of the last complete line"   ← was missing
 *         - "the fragment is delivered once the writer completes it"
 *         - the harness's own unexpected-throw guard (the truncated JSON throws where the real
 *           code would not) — this one is NOT a cell of the suite's 29; the guard adds a failure
 *           row when it fires, which is why a "26 passed / 4 failed" run and a 29-cell baseline
 *           are consistent rather than contradictory.
 *       Original entry, kept because the correction is the finding: predicted 2, recorded 3.
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
import { mkdtempSync, rmSync, writeFileSync, appendFileSync, statSync, openSync, readSync, writeSync, closeSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonlFileSource, type SourceRecord } from "../src/durable-source.js";

let ok = 0, fail = 0;
const c = (n: string, v: boolean, extra?: unknown) => {
  if (v) { ok++; } else { fail++; console.log("  ✗ FAIL:", n, extra ?? ""); }
};

/** Read, converting an UNEXPECTED throw into a cell failure instead of crashing the suite.
 *  A run that aborts on the first surprise cannot report which cells a mutation killed, and an
 *  illegible kill set is the same as no mutation testing at all. */
const readOr = async <T>(src: JsonlFileSource<T>, cursor: string | undefined, what: string) => {
  try { return await src.read(cursor); }
  catch (e) { c(`${what} (unexpected throw)`, false, String(e)); return { records: [] as SourceRecord<T>[], cursor: cursor ?? "0" }; }
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
  c("new complete records are read forward from the cursor", r1.records.length === 2 && r1.records[1].value.i === 4, r1.records);

  // ── nothing new: no records, cursor unmoved ──
  const r2 = await readOr(src, r1.cursor, "unchanged read");
  c("an unchanged file yields no records and does not move the cursor", r2.records.length === 0 && r2.cursor === r1.cursor, r2);

  // ── THE CASE: a half-written line must not be consumed ──
  appendFileSync(path, '{"i":5}\n{"i":6'); // no trailing newline: the writer is mid-line
  const r3 = await readOr(src, r2.cursor, "partial-line read");
  c("a half-written trailing line is NOT consumed", r3.records.length === 1 && r3.records[0].value.i === 5, r3.records);
  // EXACT, not an inequality. This read `< 46` while the correct stop is 40, so 32..45 all passed —
  // a wrong stop one byte either side would have gone unnoticed (fmae-rev-test F1). The expected
  // value is computed from the fixture bytes so it stays true if the fixture changes.
  const expectedStop = Buffer.byteLength('{"i":1}\n{"i":2}\n{"i":3}\n{"i":4}\n{"i":5}\n');
  c("the cursor stops EXACTLY at the end of the last complete line", off(r3.cursor) === expectedStop, { got: r3.cursor, want: expectedStop });

  // ── and it arrives once the writer finishes it ──
  appendFileSync(path, '}\n');
  const r4 = await readOr(src, r3.cursor, "completed-fragment read");
  c("the fragment is delivered once the writer completes it", r4.records.length === 1 && r4.records[0].value.i === 6, r4.records);

  // ── a complete but unparseable line is LOUD, never silently skipped ──
  appendFileSync(path, 'not json at all\n');
  let threw = false;
  try { await src.read(r4.cursor); } catch { threw = true; }
  c("an unparseable COMPLETE line fails loud", threw);

  // ── truncation/replacement is loud too: neither re-adopting nor re-sending is safe to guess ──
  //
  // THIS CELL USED TO PROVE NOTHING. It built its past-end cursor with
  // `adopt.cursor.replace(/:\d+$/, ":9999")` — but a cursor is `dev:ino:offset:seal` and the seal is
  // 16 HEX characters, so `/:\d+$/` matched in 0 of 200 trials. The cell went green anyway, because
  // the `writeFileSync` above shrank the file and `offset > size` fired for an entirely different
  // reason than the one the cell is named for. Found in review; the production path was always fine.
  // Now the cursor is built by PARTS, so the offset is genuinely past the end and the seal is real.
  writeFileSync(path, '{"i":1}\n');
  const st = statSync(path);
  const live = await src.read(undefined);                       // a real 4-part cursor for this file
  const seal = live.cursor.split(":")[3];
  const pastEnd = `${st.dev}:${st.ino}:${st.size + 4096}:${seal}`;
  c("the crafted cursor is genuinely 4-part with a real seal", pastEnd.split(":").length === 4 && /^[0-9a-f]{16}$/.test(seal), pastEnd);
  let truncThrew = false, truncWhy = "";
  try { await src.read(pastEnd); } catch (e) { truncThrew = true; truncWhy = (e as Error).message; }
  // TWO cells, and their names say which is which. The first is the WEAK one and is named for the
  // weaker property it actually proves: no path returns data for a past-end cursor, by ANY route.
  // It stays green with the past-end check deleted (the seal check throws instead), so on its own it
  // is a bystander — it was previously named "…past the end…fails loud", which read as coverage of
  // the past-end rule and was not. A cell may be weak; its NAME must not be stronger than its
  // assertion. The second cell is the discriminating one.
  c("a past-end cursor never silently succeeds — it is refused by SOME named refusal", truncThrew, truncWhy);
  c("and it is refused for the PAST-END reason specifically, not by the seal check downstream", /past end/.test(truncWhy), truncWhy);

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
      r.records.length === 1 && r.records[0].value.i === 12, r.records);
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
    c("B3a: unlink+recreate (new inode) is DETECTED", detected);
    rmSync(d, { recursive: true, force: true });
  }

  // B3b — IN-PLACE rewrite: same inode, so dev/ino cannot see it, and a LARGER rewrite is
  //       invisible to a size check too. fmae-rev-eng CONFIRMED the residual after the B3a fix:
  //       `writeFileSync` without unlink still resumed at the old offset inside a new document and
  //       emitted `{c:3}` as a record. My B3a smoke used rmSync+writeFileSync — the variant my own
  //       fix handled — which is the same fixture blindness that hid B1.
  {
    const d = mkdtempSync(join(tmpdir(), "ds-b3b-"));
    const f = join(d, "s.jsonl");
    writeFileSync(f, '{"a":1}\n');
    const s3b = new JsonlFileSource(f);
    const a = await readOr(s3b, undefined, "B3b adopt");
    writeFileSync(f, '{"b":2}\n{"c":3}\n');          // IN PLACE: no unlink, same inode, LARGER
    let msg = "";
    try { await s3b.read(a.cursor); } catch (e) { msg = (e as Error).message; }
    c("B3b: an IN-PLACE larger rewrite is DETECTED (same inode, bigger file)", /rewritten in place/.test(msg), msg || "did not throw");
    rmSync(d, { recursive: true, force: true });
  }

  // B3c — the seal states an invariant, not a guess: a rewrite reproducing the SAME consumed
  //       prefix is not an error, because the bytes we already read are genuinely unchanged.
  {
    const d = mkdtempSync(join(tmpdir(), "ds-b3c-"));
    const f = join(d, "s.jsonl");
    writeFileSync(f, '{"a":1}\n');
    const s3c = new JsonlFileSource<{ z?: number }>(f);
    const a = await readOr(s3c, undefined, "B3c adopt");
    writeFileSync(f, '{"a":1}\n{"z":9}\n');           // same prefix, then genuinely new content
    const r = await readOr(s3c, a.cursor, "B3c read");
    c("B3c: a rewrite preserving the consumed prefix is NOT an error", r.records.length === 1 && r.records[0].value.z === 9, r.records);
    rmSync(d, { recursive: true, force: true });
  }

  // B4 — Number() coerced non-canonical cursors; " " became 0 and replayed all history.
  // The refusal must be a CURSOR refusal, not any throw. Against the old Number()-coercing code
  // "1e0"/"01"/"+1" all became valid offsets and then threw for an incidental reason (an
  // unparseable line at that offset) — which a bare "did it throw?" cell would have scored as a
  // pass. Asserting the message names the cursor is what makes these discriminate.
  for (const bad of [" ", "1e0", "01", "+1", "", "x:y:1", "1:2", "1:2:3:4"]) {
    let msg = "";
    try { await src.read(bad); } catch (e) { msg = (e as Error).message; }
    c(`B4: non-canonical cursor ${JSON.stringify(bad)} is refused AS a malformed cursor`,
      /malformed cursor/.test(msg), msg || "did not throw");
  }
  // ── a SYMLINKED source is refused, not followed (R-SEC-2) ──
  //    Built before any seam feeds this class a caller-controlled path, which is the cheap moment:
  //    afterwards it stops being a fix and becomes a compatibility argument. The CONTROL matters as
  //    much as the refusal — without it this cell would pass for an `open` that had broken outright.
  {
    const ld = mkdtempSync(join(tmpdir(), "symlink-src-"));
    try {
      const real = join(ld, "real.jsonl");
      writeFileSync(real, '{"i":1}\n');
      const link = join(ld, "link.jsonl");
      symlinkSync(real, link);

      let linkErr = "";
      try { await new JsonlFileSource(link).read(undefined); } catch (e) { linkErr = String((e as NodeJS.ErrnoException).code ?? (e as Error).message); }
      c("a SYMLINKED source is refused (ELOOP), never silently followed", /ELOOP/.test(linkErr), linkErr || "not refused");

      const direct = await new JsonlFileSource(real).read(undefined);
      c("CONTROL: the same file opened directly still reads, so the refusal is about the symlink",
        typeof direct.cursor === "string" && direct.cursor.split(":").length === 4, direct);
    } finally {
      rmSync(ld, { recursive: true, force: true });
    }
  }

  // ── THE SEAL'S WINDOW IS PINNED BY THESE CELLS, AND BY NOTHING ELSE. ──
  //
  // `sealAt` authenticates the last `min(offset, 512)` bytes of the consumed prefix. Until now the
  // suite proved the seal EXISTS but never proved how far it REACHES: reducing the window from 512
  // to 7 bytes left the whole file green (fmae-rev-test). A size that nothing asserts is a size
  // that can be tuned to nothing, and narrowing the doc comment does not help — a comment cannot
  // be mutation-killed. The honest description and the enforced behaviour are separate deliverables.
  //
  // Two cells, one on each side of the boundary, so the window is bounded from BOTH directions:
  // a rewrite 500 bytes back MUST be caught (any shrink below that reddens this), and one 600 bytes
  // back is NOT caught — which is the documented residual, asserted rather than merely described,
  // so if the seal is ever widened this cell fails and forces the comment to be updated with it.
  {
    const sd = mkdtempSync(join(tmpdir(), "seal-window-"));
    try {
      const sealPath = join(sd, "s.jsonl");
      // >512 bytes of COMPLETE records, so the cursor sits far enough in for both probes.
      writeFileSync(sealPath, "");
      for (let i = 0; i < 30; i++) appendFileSync(sealPath, `${JSON.stringify({ i, pad: "p".repeat(40) })}\n`);
      const sealSrc = new JsonlFileSource(sealPath);
      const at = await sealSrc.read(undefined);
      const off = Number(at.cursor.split(":")[2]);
      c("the seal fixture has a consumed prefix longer than the window", off > 600, off);

      /** Flip one byte in place at an absolute position: same inode, same size. */
      const flipAt = (pos: number) => {
        const fd = openSync(sealPath, "r+");
        const b = Buffer.alloc(1);
        readSync(fd, b, 0, 1, pos);
        writeSync(fd, Buffer.from([b[0]! === 0x70 ? 0x71 : 0x70]), 0, 1, pos);
        closeSync(fd);
      };

      flipAt(off - 500);
      let caught = "";
      try { await sealSrc.read(at.cursor); } catch (e) { caught = (e as Error).message; }
      c("a rewrite 500 bytes before the cursor IS caught — the window really is ~512, not smaller",
        /have changed/.test(caught), caught || "not detected");
      flipAt(off - 500); // restore that byte so the next probe is independent

      flipAt(off - 600);
      let outside = "";
      try { await sealSrc.read(at.cursor); } catch (e) { outside = (e as Error).message; }
      c("a rewrite 600 bytes before the cursor is NOT caught — the bound, asserted rather than only described",
        outside === "", outside || "(not detected, as documented)");
    } finally {
      rmSync(sd, { recursive: true, force: true });
    }
  }

  // ── PER-RECORD CURSORS — what `[P8]` needs and what the batch cursor cannot give it ────────────
  //
  // The emitter may turn one read into several frames, and each frame is its own durable
  // pending/publish/ack cycle with its OWN `sourceCursor`. With only an end-of-batch cursor, a frame
  // covering the first half of a read can store nothing except "the whole batch was consumed" — fold
  // it, crash, and the frontier has skipped the records the later frames were carrying, with no
  // `seq` gap for a consumer to see. So these cells are not decoration on a convenience field; they
  // are the property the resume path rests on.
  {
    const pd = mkdtempSync(join(tmpdir(), "durable-source-percur-"));
    try {
      const f = join(pd, "s.jsonl");
      writeFileSync(f, "");
      const s = new JsonlFileSource<{ i: number; t?: string }>(f);
      const start = await readOr(s, undefined, "per-record adopt");

      appendFileSync(f, '{"i":1}\n{"i":2}\n{"i":3}\n');
      const all = await readOr(s, start.cursor, "per-record read");
      c("per-record:three-records-arrive", all.records.length === 3, all.records.map((r) => r.value));

      // THE CELL THE WHOLE FIELD EXISTS FOR: resuming from record 0's cursor yields records 1 and 2
      // and NOT record 0. An off-by-one in either direction is visible here — a cursor placed before
      // record 0's newline re-delivers it, one placed past record 1 loses it.
      const after0 = await readOr(s, all.records[0].cursor, "resume after record 0");
      c(
        "per-record:cursor-resumes-EXACTLY-after-that-record",
        after0.records.length === 2 && after0.records[0].value.i === 2 && after0.records[1].value.i === 3,
        after0.records.map((r) => r.value),
      );

      // The batch cursor and the last record's cursor are the SAME position. They are computed by
      // two different walks over the same bytes, and a disagreement is silent in the dangerous
      // direction, so it is asserted rather than assumed.
      c(
        "per-record:the-last-record's-cursor-IS-the-batch-cursor",
        all.records[all.records.length - 1].cursor === all.cursor,
        { last: all.records[all.records.length - 1].cursor, batch: all.cursor },
      );

      const afterLast = await readOr(s, all.records[all.records.length - 1].cursor, "resume after the last record");
      c("per-record:CONTROL-resuming-after-the-last-record-yields-nothing", afterLast.records.length === 0, afterLast.records);

      // ── THE MULTI-BYTE TRAP, and it is the reason this walk counts BYTES ───────────────────────
      //
      // The cursor is a byte offset; `complete.split("\n")` yields a decoded STRING. Walking it with
      // `line.length` costs nothing on ASCII and is wrong the moment a record carries anything else
      // — every cursor after the first multi-byte record lands short, inside a record rather than
      // between two. An ASCII-only fixture cannot see that: it is the same defect class as a suite
      // whose fixtures all happened to end on a record boundary.
      //
      // "é" is 2 bytes, "…" is 3, "🙂" is 4 — one of each, so a character walk is off by 6 and lands
      // inside the SECOND record, not merely at its edge.
      const mb = join(pd, "utf8.jsonl");
      writeFileSync(mb, "");
      const ms = new JsonlFileSource<{ i: number; t: string }>(mb);
      const mstart = await readOr(ms, undefined, "utf8 adopt");
      appendFileSync(mb, '{"i":1,"t":"é…🙂"}\n{"i":2,"t":"plain"}\n{"i":3,"t":"ünïcøde"}\n');
      const mall = await readOr(ms, mstart.cursor, "utf8 read");
      c(
        "per-record:multi-byte-records-are-read-whole",
        mall.records.length === 3 && mall.records[0].value.t === "é…🙂" && mall.records[2].value.t === "ünïcøde",
        mall.records.map((r) => r.value),
      );
      // Resuming after a MULTI-BYTE record is the assertion a character walk cannot pass: it would
      // resume 6 bytes early, inside `{"i":2,...}`, and either throw on the fragment or hand back a
      // record that was never written.
      const afterMb = await readOr(ms, mall.records[0].cursor, "resume after a multi-byte record");
      c(
        "per-record:resume-after-a-MULTI-BYTE-record-is-byte-exact",
        afterMb.records.length === 2 && afterMb.records[0].value.i === 2 && afterMb.records[0].value.t === "plain",
        afterMb.records.map((r) => r.value),
      );

      // A blank separator is not a record but it IS bytes. If the walk skipped it, the internal
      // consistency check would refuse the whole read — which is the loud outcome, and this cell
      // pins that the ordinary case does not trip it.
      const bl = join(pd, "blank.jsonl");
      writeFileSync(bl, "");
      const bs = new JsonlFileSource<{ i: number }>(bl);
      const bstart = await readOr(bs, undefined, "blank adopt");
      appendFileSync(bl, '{"i":1}\n\n{"i":2}\n');
      const ball = await readOr(bs, bstart.cursor, "blank read");
      c("per-record:blank-separators-advance-the-offset-without-becoming-records",
        ball.records.length === 2 && ball.records[1].value.i === 2 && ball.records[1].cursor === ball.cursor,
        ball.records);
      const afterBlank = await readOr(bs, ball.records[0].cursor, "resume across a blank line");
      c("per-record:resuming-across-a-blank-line-yields-only-the-later-record",
        afterBlank.records.length === 1 && afterBlank.records[0].value.i === 2,
        afterBlank.records.map((r) => r.value));
    } finally {
      rmSync(pd, { recursive: true, force: true });
    }
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(`durable-source smoke: ${ok} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
