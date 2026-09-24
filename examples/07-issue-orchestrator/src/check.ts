/**
 * `pnpm check`: validate both programs and run them over four scripted outcomes with no broker.
 *
 * Each script runs three ways: `dryRun` (the plan), `run` (the tree-walker, with a `SimHandler`),
 * and `runInWorker` (the compiled engine a manager runs programs on, over the same scripted handler).
 * The two journals must hold the same keyed steps, the lane record must equal the script's
 * expectation, and the settled steps must equal the expected journal. Steps are compared as a
 * multiset: inside a concurrent scope the journal appends branches in completion order, and a
 * resume matches steps by key, never by append order. Any refusal or difference exits non-zero.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  LangErrors,
  SimHandler,
  dryRun,
  journalEntryKeyString,
  run,
  runInWorker,
  transform,
  validate,
  type JournalEntry,
  type SimScript,
} from "@cotal-ai/lang";

const here = dirname(fileURLToPath(import.meta.url));
const programs = join(here, "..", "programs");
const read = (name: string): string => readFileSync(join(programs, name), "utf8");
const SINGLE = "resolve-issue.cotal.js";
const DRIVER = "resolve-issues.cotal.js";
const sources: Record<string, string> = { [SINGLE]: read(SINGLE), [DRIVER]: read(DRIVER) };

// The compiled engine's thread entry, from the built package, as the manager runs it.
const WORKER_ENTRY = new URL(import.meta.resolve("@cotal-ai/lang/engine/worker-entry"));

/** A refusal in full: every language error with its code, frame and fix, or the message. */
const refusal = (e: unknown): string =>
  e instanceof LangErrors ? e.render() : String((e as Error)?.message ?? e);

let failed = 0;
function check(name: string, ok: boolean, detail?: unknown): void {
  if (ok) console.log(`  ✓ ${name}`);
  else {
    failed++;
    console.log(`  ✗ ${name}`);
    if (detail !== undefined) console.log(`    ${typeof detail === "string" ? detail : JSON.stringify(detail)}`);
  }
}

// ---- 1. the two lane copies are one block ----------------------------------------------------------
console.log("lane block");
const laneBlock = (src: string): string => {
  const begin = src.indexOf("// ---- lane: begin");
  const end = src.indexOf("// ---- lane: end ----");
  return begin < 0 || end < 0 ? "" : src.slice(begin, end);
};
check("both programs carry the lane block", laneBlock(sources[SINGLE]!) !== "" && laneBlock(sources[DRIVER]!) !== "");
check("the two lane blocks are identical", laneBlock(sources[SINGLE]!) === laneBlock(sources[DRIVER]!));

// ---- 2. validation ----------------------------------------------------------------------------------
console.log("validate");
for (const [file, src] of Object.entries(sources)) {
  try {
    const r = validate(src, file);
    check(`${file} validates`, r.warnings.length === 0, r.warnings);
  } catch (e) {
    check(`${file} validates`, false, refusal(e));
  }
}

// ---- 3. the four scripts ----------------------------------------------------------------------------
// The simulator stamps `at` from its virtual clock; the type still asks for one.
const done = { status: "done", at: 0 } as const;
const S1 = "1111111111111111111111111111111111111111";
const S2 = "2222222222222222222222222222222222222222";
const M1 = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const M2 = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const approve = (sha: string) => ({ verdict: "APPROVE", sha, blockers: [] });
const block = (sha: string, blockers: string[]) => ({ verdict: "BLOCK", sha, blockers });

// The expected journal of each script, as `kind:name` steps (order is for reading; compared as a multiset).
const DRIVER_PREFIX = ["spawn:triage", "turn:select", "ask:issues", "fanOut:lanes"];
const LANE_PREFIX = [
  "spawn:worker", "notify", "turn:reproduce", "ask:reproduced", "turn:fix", "ask:opened",
  "fanOut:reviewers", "spawn:reviewer", "spawn:reviewer",
  "fanOut:review", "notify", "turn:grade-a", "ask:verdict-a", "notify", "turn:grade-b", "ask:verdict-b",
];
const REGRADE = [
  "notify", "turn:address", "ask:revised",
  "fanOut:regrade", "notify", "turn:regrade-a", "ask:reverdict-a", "notify", "turn:regrade-b", "ask:reverdict-b",
];
const MERGE = ["spawn:merger", "notify", "turn:merge", "ask:merged"];

interface Case {
  readonly name: string;
  readonly file: string;
  readonly script: SimScript;
  readonly record: Record<string, unknown>;
  readonly steps: readonly string[];
}

const cases: Case[] = [
  {
    name: "happy path: reproduce, PR, two approvals, merge",
    file: DRIVER,
    script: {
      turns: { select: done, reproduce: done, fix: done, "grade-a": done, "grade-b": done, merge: done },
      asks: {
        issues: { issues: [101] },
        reproduced: { reproduced: true, evidence: "fails on main" },
        opened: { sha: S1, pr: 7 },
        "verdict-a": approve(S1),
        "verdict-b": approve(S1),
        merged: { merged: true, mergeSha: M1 },
      },
    },
    record: { issue: 101, outcome: "merged", sha: S1, pr: 7, mergeSha: M1, rounds: 1, blockers: [] },
    steps: [...DRIVER_PREFIX, ...LANE_PREFIX, ...MERGE],
  },
  {
    name: "not reproduced: the lane stops before any fix",
    file: SINGLE,
    script: {
      turns: { reproduce: done },
      checkpoints: { issue: { status: "resolved", value: { issue: 102 }, by: "operator" } },
      asks: { reproduced: { reproduced: false, evidence: "passes on main at the reported version" } },
    },
    record: {
      issue: 102, outcome: "not-reproduced", sha: null, pr: null, mergeSha: null, rounds: 0,
      blockers: ["not reproduced: passes on main at the reported version"],
    },
    steps: ["checkpoint:issue", "spawn:worker", "notify", "turn:reproduce", "ask:reproduced", "notify"],
  },
  {
    name: "one block, a fix, then two approvals at the new sha",
    file: DRIVER,
    script: {
      turns: {
        select: done, reproduce: done, fix: done, "grade-a": done, "grade-b": done,
        address: done, "regrade-a": done, "regrade-b": done, merge: done,
      },
      asks: {
        issues: { issues: [103] },
        reproduced: { reproduced: true, evidence: "fails on main" },
        opened: { sha: S1, pr: 7 },
        "verdict-a": block(S1, ["missing test for the empty input"]),
        "verdict-b": approve(S1),
        revised: { sha: S2, pr: 7 },
        "reverdict-a": approve(S2),
        "reverdict-b": approve(S2),
        merged: { merged: true, mergeSha: M2 },
      },
    },
    record: { issue: 103, outcome: "merged", sha: S2, pr: 7, mergeSha: M2, rounds: 2, blockers: [] },
    steps: [...DRIVER_PREFIX, ...LANE_PREFIX, ...REGRADE, ...MERGE],
  },
  {
    name: "two blocks reach the review cap",
    file: DRIVER,
    script: {
      turns: {
        select: done, reproduce: done, fix: done, "grade-a": done, "grade-b": done,
        address: done, "regrade-a": done, "regrade-b": done,
      },
      asks: {
        issues: { issues: [104] },
        reproduced: { reproduced: true, evidence: "fails on main" },
        opened: { sha: S1, pr: 7 },
        "verdict-a": approve(S1),
        "verdict-b": block(S1, ["race in the retry loop"]),
        revised: { sha: S2, pr: 7 },
        "reverdict-a": approve(S1),
        "reverdict-b": block(S2, ["the retry still races"]),
      },
    },
    record: {
      issue: 104, outcome: "blocked", sha: S2, pr: 7, mergeSha: null, rounds: 2,
      blockers: [`a: verdict names ${S1}, expected ${S2}`, "b: the retry still races"],
    },
    steps: [...DRIVER_PREFIX, ...LANE_PREFIX, ...REGRADE, "notify"],
  },
];

const sorted = (xs: readonly string[]): string => JSON.stringify([...xs].sort());

/** The settled steps in journal order, as `kind:name` (a bare kind when the step is unnamed). */
const settledSteps = (entries: readonly JournalEntry[]): string[] =>
  entries.filter((e) => e.state === "settled").map((e) => (e.name === "" ? e.kind : `${e.kind}:${e.name}`));

/** The lane records a program logged: the single lane's `lane` line, or each of the driver's `lanes`. */
function laneRecords(logs: readonly (readonly unknown[])[]): unknown[] {
  const out: unknown[] = [];
  for (const [tag, value] of logs) {
    if (tag === "lane") out.push(value);
    if (tag === "lanes" && Array.isArray(value)) out.push(...value);
  }
  return out;
}

const summary = (entries: readonly JournalEntry[]): string =>
  entries
    .filter((e) => e.state === "settled")
    .map((e) => `${journalEntryKeyString(e)} ${e.status ?? ""}`.trimEnd())
    .join("\n      ");

for (const c of cases) {
  console.log(`${c.name} (${c.file})`);
  const src = sources[c.file]!;
  const runId = `check-${cases.indexOf(c) + 1}`;
  try {
    const plan = await dryRun(src, c.script, { runId, file: c.file });
    check("the dry run uses every scripted answer", plan.unusedScript.length === 0, plan.unusedScript);

    const walkerLogs: unknown[][] = [];
    const walker = await run(src, {
      runId, file: c.file, handler: new SimHandler(c.script),
      onLog: (l) => walkerLogs.push([...l.values]),
    });
    const walked = walker.journal.entries();

    const engineLogs: unknown[][] = [];
    const stored: JournalEntry[] = [];
    const engine = await runInWorker(
      { source: src, module: transform(src, { file: c.file }).module, runId, file: c.file, handler: "bridged" },
      {
        entry: WORKER_ENTRY,
        bridge: { handler: new SimHandler(c.script), store: { append: async (e) => { stored.push(e); } } },
        onLog: (l) => engineLogs.push([...l.values]),
      },
    ).done;
    check("the compiled engine completes", engine.ok === true, engine.ok ? undefined : `${engine.code ?? ""} ${engine.message}`);

    const records = laneRecords(walkerLogs);
    check("one lane record", records.length === 1, records);
    check("the lane record is the expected one", JSON.stringify(records[0]) === JSON.stringify(c.record), records[0]);
    check("the engine logs the same record", JSON.stringify(laneRecords(engineLogs)) === JSON.stringify(records), laneRecords(engineLogs));
    check("the settled steps are the expected journal", sorted(settledSteps(walked)) === sorted(c.steps),
      { got: settledSteps(walked), want: c.steps });
    check("every settled step is ok", walked.every((e) => e.state !== "settled" || e.status === "ok"),
      walked.filter((e) => e.state === "settled" && e.status !== "ok").map(journalEntryKeyString));
    if (engine.ok) {
      const key = (e: JournalEntry) => `${journalEntryKeyString(e)} ${e.state} ${e.status ?? ""}`;
      const e2 = engine.entries.map(key), w2 = walked.map(key);
      check("the engine journal holds the walker's keyed steps", sorted(e2) === sorted(w2),
        { engineOnly: e2.filter((k) => !w2.includes(k)), walkerOnly: w2.filter((k) => !e2.includes(k)), lengths: [e2.length, w2.length] });
    }
    console.log(`    outcome ${String((records[0] as { outcome?: unknown } | undefined)?.outcome)}, ${settledSteps(walked).length} settled steps, ${plan.agents.length} spawns, ${plan.checkpoints.length} checkpoints`);
    console.log(`      ${summary(walked)}`);
  } catch (e) {
    check("the script runs without a refusal", false, refusal(e));
  }
}

console.log(failed === 0 ? "check: all passed" : `check: ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
