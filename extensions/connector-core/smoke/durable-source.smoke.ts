/**
 * `[P6]` durable-source read — the cursor must survive a crash and must never consume a
 * half-written record.
 *
 * WHY THE PARTIAL-LINE CASE IS THE POINT. The writer is a separate process appending concurrently,
 * so a read lands mid-line routinely, not rarely. Parsing that yields a throw or — worse — a
 * truncated object that looks valid and gets published as if it were what the agent did. The rule
 * is: consume only up to the last newline, and advance the cursor only that far.
 *
 * MUTATION LEDGER — predicted before the run:
 *   M1  consume the whole chunk instead of stopping at the last newline
 *       -> MUST kill "a half-written trailing line is NOT consumed" and
 *          "the fragment is delivered once the writer completes it" (it would already be gone)
 *   M2  advance the cursor to file size rather than past consumed bytes
 *       -> MUST kill "the fragment is delivered once the writer completes it"
 *   M3  skip unparseable complete lines instead of throwing
 *       -> MUST kill "an unparseable COMPLETE line fails loud"
 *   M4  start a fresh adopt at 0 instead of at the current end
 *       -> MUST kill "a fresh adopt does not rebroadcast existing history"
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

const dir = mkdtempSync(join(tmpdir(), "durable-source-"));
const path = join(dir, "session.jsonl");

try {
  // ── a fresh adopt starts at the END: an existing session is not rebroadcast ──
  writeFileSync(path, '{"i":1}\n{"i":2}\n');
  const src = new JsonlFileSource<{ i: number }>(path);
  const adopt = await src.read(undefined);
  c("a fresh adopt does not rebroadcast existing history", adopt.records.length === 0, adopt.records);
  c("the adopt cursor is the current end", adopt.cursor === "16", adopt.cursor);

  // ── new complete records are read forward ──
  appendFileSync(path, '{"i":3}\n{"i":4}\n');
  const r1 = await src.read(adopt.cursor);
  c("new complete records are read forward from the cursor", r1.records.length === 2 && r1.records[1].i === 4, r1.records);

  // ── nothing new: no records, cursor unmoved ──
  const r2 = await src.read(r1.cursor);
  c("an unchanged file yields no records and does not move the cursor", r2.records.length === 0 && r2.cursor === r1.cursor, r2);

  // ── THE CASE: a half-written line must not be consumed ──
  appendFileSync(path, '{"i":5}\n{"i":6'); // no trailing newline: the writer is mid-line
  const r3 = await src.read(r2.cursor);
  c("a half-written trailing line is NOT consumed", r3.records.length === 1 && r3.records[0].i === 5, r3.records);
  c("the cursor stops at the last complete line", Number(r3.cursor) < 16 + 16 + 8 + 6, r3.cursor);

  // ── and it arrives once the writer finishes it ──
  appendFileSync(path, '}\n');
  const r4 = await src.read(r3.cursor);
  c("the fragment is delivered once the writer completes it", r4.records.length === 1 && r4.records[0].i === 6, r4.records);

  // ── a complete but unparseable line is LOUD, never silently skipped ──
  appendFileSync(path, 'not json at all\n');
  let threw = false;
  try { await src.read(r4.cursor); } catch { threw = true; }
  c("an unparseable COMPLETE line fails loud", threw);

  // ── truncation/replacement is loud too: neither re-adopting nor re-sending is safe to guess ──
  writeFileSync(path, '{"i":1}\n');
  let truncThrew = false;
  try { await src.read("9999"); } catch { truncThrew = true; }
  c("a cursor past the end (truncated or replaced file) fails loud", truncThrew);

  // ── a malformed cursor is refused rather than coerced ──
  let badCursor = false;
  try { await src.read("-1"); } catch { badCursor = true; }
  c("a malformed cursor is refused", badCursor);
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(`durable-source smoke: ${ok} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
