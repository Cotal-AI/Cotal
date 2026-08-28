/**
 * A Claude startup prompt may already be in the transcript when SessionStart reaches Cotal.
 *
 * `source: "startup"` is Claude's explicit statement that this is a new session, so a virgin event
 * WAL reads from byte zero. Every retained-history source (`resume`, `fork`, `clear`, `compact`)
 * keeps the generic adopt-at-current-boundary rule. A DEFINED cursor always wins over either mode:
 * crash recovery resumes after what the WAL folded and never replays from zero.
 *
 * This is the source-policy half of `smoke:claude-run-error`, whose real broker arm proves the same
 * startup order produces frames through the shipped hook → holder → source → mapper → emitter path.
 */
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClaudeTranscriptSource } from "../src/agui-source.js";

const line = (id: number): string => `${JSON.stringify({ id })}\n`;

let pass = 0;
let fail = 0;
const check = (name: string, condition: boolean, extra?: unknown): void => {
  if (condition) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name}${extra === undefined ? "" : ` - ${JSON.stringify(extra)}`}`);
  }
};

const dir = mkdtempSync(join(tmpdir(), "cotal-claude-start-source-"));
const file = (name: string): string => join(dir, `${name}.jsonl`);

try {
  // A positional prompt plus any records that arrived while the connector was binding are all part
  // of this new session. Starting at zero is exact here, and only here.
  const startup = file("startup");
  writeFileSync(startup, line(1) + line(2));
  const startupRead = await createClaudeTranscriptSource(startup, "startup").read(undefined);
  check(
    "startup:a-virgin-source-reads-the-complete-records-already-written-before-SessionStart",
    startupRead.records.map((r) => r.value.id).join(",") === "1,2",
    startupRead.records.map((r) => r.value.id),
  );

  // The retained SessionStart relay can now beat Claude's creation of the JSONL itself. The source
  // must wait for that real artifact, not turn one early ENOENT into a terminal emitter failure.
  const delayed = file("delayed");
  let delayedRead: Awaited<ReturnType<ReturnType<typeof createClaudeTranscriptSource>["read"]>> | undefined;
  let delayedError: Error | undefined;
  const created = new Promise<void>((resolve) =>
    setTimeout(() => {
      writeFileSync(delayed, line(13));
      resolve();
    }, 75),
  );
  await Promise.all([
    createClaudeTranscriptSource(delayed, "startup")
      .read(undefined)
      .then((read) => (delayedRead = read))
      .catch((error) => (delayedError = error as Error)),
    created,
  ]);
  check(
    "startup:a-SessionStart-before-transcript-creation-waits-for-the-real-file",
    delayedError === undefined && delayedRead?.records.length === 1 && delayedRead.records[0]?.value.id === 13,
    { error: delayedError?.message, records: delayedRead?.records.map((r) => r.value.id) },
  );

  // The explicit from-zero door must preserve JsonlFileSource's core partial-record guarantee.
  const partial = file("partial");
  writeFileSync(partial, line(3) + '{"id":4');
  const partialRead = await createClaudeTranscriptSource(partial, "startup").read(undefined);
  check(
    "startup:read-from-zero-consumes-only-complete-records-not-a-trailing-fragment",
    partialRead.records.length === 1 && partialRead.records[0]?.value.id === 3,
    partialRead.records.map((r) => r.value.id),
  );
  appendFileSync(partial, "}\n");
  const completed = await createClaudeTranscriptSource(partial, "startup").read(partialRead.cursor);
  check(
    "startup:the-completed-trailing-record-is-resumable-from-the-returned-cursor",
    completed.records.length === 1 && completed.records[0]?.value.id === 4,
    completed.records.map((r) => r.value.id),
  );

  // A fresh session with no positional prompt remains ordinary: zero now, appended turn later.
  const promptless = file("promptless");
  writeFileSync(promptless, "");
  const promptlessAdopt = await createClaudeTranscriptSource(promptless, "startup").read(undefined);
  check("startup:a-promptless-fresh-session-starts-empty", promptlessAdopt.records.length === 0);
  appendFileSync(promptless, line(5) + line(6));
  const promptlessTurn = await createClaudeTranscriptSource(promptless, "startup").read(promptlessAdopt.cursor);
  check(
    "startup:a-later-turn-in-a-promptless-session-is-read-after-the-virgin-cursor",
    promptlessTurn.records.map((r) => r.value.id).join(",") === "5,6",
    promptlessTurn.records.map((r) => r.value.id),
  );

  const neverCreated = file("never-created");
  let missingError: Error | undefined;
  try {
    await createClaudeTranscriptSource(neverCreated, "startup", { startupFileWaitMs: 60 }).read(undefined);
  } catch (error) {
    missingError = error as Error;
  }
  check(
    "startup:a-transcript-that-never-appears-fails-loud-after-the-bounded-wait",
    missingError?.message.includes("did not appear within 60ms") === true &&
      missingError.message.includes("refusing to lose the first run"),
    missingError?.message,
  );

  // These four source values all name retained history. Each cell proves BOTH halves: no replay of
  // the old records, and the first new append remains readable from the adopt cursor.
  for (const sessionSource of ["resume", "fork", "clear", "compact"] as const) {
    const retained = file(sessionSource);
    writeFileSync(retained, line(7) + line(8));
    const adopted = await createClaudeTranscriptSource(retained, sessionSource).read(undefined);
    appendFileSync(retained, line(9));
    const next = await createClaudeTranscriptSource(retained, sessionSource).read(adopted.cursor);
    check(
      `${sessionSource}:retained-history-is-not-replayed-and-the-next-record-is-still-readable`,
      adopted.records.length === 0 && next.records.length === 1 && next.records[0]?.value.id === 9,
      { adopted: adopted.records.map((r) => r.value.id), next: next.records.map((r) => r.value.id) },
    );
  }

  // Crash recovery: a startup-labelled process can restart with an existing WAL. The defined cursor
  // is the authority; replay-from-zero applies only to an actually virgin frontier.
  const recovery = file("recovery");
  writeFileSync(recovery, line(10) + line(11));
  const first = await createClaudeTranscriptSource(recovery, "startup").read(undefined);
  appendFileSync(recovery, line(12));
  const resumed = await createClaudeTranscriptSource(recovery, "startup").read(first.cursor);
  check(
    "recovery:a-defined-WAL-cursor-wins-over-startup-and-reads-only-the-successor",
    resumed.records.length === 1 && resumed.records[0]?.value.id === 12,
    resumed.records.map((r) => r.value.id),
  );

  for (const unsupported of [undefined, "future-mode"] as const) {
    let error: Error | undefined;
    try {
      createClaudeTranscriptSource(startup, unsupported);
    } catch (e) {
      error = e as Error;
    }
    check(
      `refusal:${unsupported === undefined ? "missing" : "unknown"}-SessionStart-source-fails-loud-instead-of-guessing`,
      error?.message.includes("unsupported source") === true && error.message.includes("refusing to guess"),
      error?.message,
    );
  }

  check("every cell ran", pass + fail === 14, { ran: pass + fail, expected: 14 });
  console.log(`claude-start-source smoke: ${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
} finally {
  rmSync(dir, { recursive: true, force: true });
}
