/**
 * Journal corruption fuzz: a journal that is wrong must fail NAMED, or continue CORRECTLY.
 *
 * The property under test is the closed set of outcomes. For every corruption class below, a
 * resume either (a) refuses with a named error (an L-code, or a seed refusal that names the run
 * and the entry) or (b) reaches the same final answer the live run reached. What must never
 * happen is the third thing: an unnamed crash from inside the interpreter, or a run that
 * completes with a different answer and nothing raised. Truncation and reordering are the
 * legitimate shapes (a crash mid-run IS a truncated journal), so those must continue; content
 * corruption must refuse.
 */
import { run, resume, Journal, SimHandler, type JournalEntry, type RunPins } from "../src/index.js";

let pass = 0;
const ok = (name: string, cond: boolean, extra?: unknown) => {
  if (!cond) throw new Error(`FAIL: ${name}${extra !== undefined ? ` - ${JSON.stringify(extra)}` : ""}`);
  pass++;
  console.log(`  ok ${name}`);
};

const SRC = `const a = await spawn("w", { name: "a" });
await sleep("1m", { name: "warm" });
const out = await parallel({
  x: async () => { await sleep("2m", { name: "px" }); return 1; },
  y: async () => { await sleep("3m", { name: "py" }); return 2; },
}, { name: "both" });
log(out.x + out.y);
`;

const RUN_ID = "r-fz";
const anyCode = (e: unknown): string =>
  `${(e as { code?: string } | undefined)?.code ?? ""} ${(e as Error | undefined)?.name ?? ""} ${(e as Error | undefined)?.message ?? ""}`;

// ---- the recorded truth ------------------------------------------------------------------------

let recorded: readonly JournalEntry[];
let pins: RunPins;
{
  const logged: unknown[] = [];
  const r = await run(SRC, { runId: RUN_ID, handler: new SimHandler({}), onLog: (l) => logged.push(l.values[0]) });
  recorded = r.journal.entries();
  pins = r.pins;
  ok("the control run completes with the answer 3", logged[0] === 3, logged);
  ok("and every recorded entry is settled", recorded.every((e) => e.state === "settled"), recorded.length);
}

const replayTo = async (entries: readonly JournalEntry[], runId = RUN_ID) => {
  const logged: unknown[] = [];
  await resume(SRC, new Journal({ run: runId, entries }), {
    runId: RUN_ID,
    pins,
    handler: new SimHandler({}),
    onLog: (l) => logged.push(l.values[0]),
  });
  return logged;
};

// ---- (1) truncation is a crash, and a crash resumes --------------------------------------------

{
  for (let cut = 0; cut <= recorded.length; cut++) {
    const logged = await replayTo(recorded.slice(0, cut));
    if (logged[0] !== 3) {
      ok(`a journal truncated to ${cut} entries resumes to the same answer`, false, logged);
    }
  }
  ok(`every truncation point (0..${recorded.length}) resumes to the recorded answer`, true);
}

// ---- (2) order is not meaning: a shuffled fold reads the same ----------------------------------

{
  const reversed = [...recorded].reverse();
  const logged = await replayTo(reversed);
  ok("a reversed entry order resumes to the same answer, because matching is by key", logged[0] === 3, logged);
}

// ---- (3) a flipped input hash is a DIVERGENCE naming the step ----------------------------------

{
  const flipped = recorded.map((e) =>
    e.name === "warm" ? { ...e, inputHash: "sha256:" + "0".repeat(64) } : e,
  );
  let err: unknown;
  try {
    await replayTo(flipped);
  } catch (e) {
    err = e;
  }
  ok("a corrupted input hash refuses as a divergence, never a silent re-run", (err as Error)?.name === "RunDivergence", anyCode(err));
  ok("and the divergence names the step", anyCode(err).includes("warm"), anyCode(err));
}

// ---- (4) one foreign entry is refused at the seed, naming both runs ----------------------------

{
  const foreign = recorded.map((e, i) => (i === 1 ? { ...e, run: "someone-else" } : e));
  let err: unknown;
  try {
    await replayTo(foreign);
  } catch (e) {
    err = e;
  }
  ok(
    "an entry from another run refuses at the seed and names both runs",
    anyCode(err).includes(RUN_ID) && anyCode(err).includes("someone-else"),
    anyCode(err),
  );
}

// ---- (5) a whole journal from another run is L5011 ---------------------------------------------

{
  const other = recorded.map((e) => ({ ...e, run: "someone-else" }));
  let err: unknown;
  try {
    await replayTo(other, "someone-else");
  } catch (e) {
    err = e;
  }
  ok("another run's journal is refused (L5011)", anyCode(err).includes("L5011"), anyCode(err));
}

// ---- (6) history without pins is L5021 ---------------------------------------------------------

{
  let err: unknown;
  try {
    await resume(SRC, new Journal({ run: RUN_ID, entries: recorded }), {
      runId: RUN_ID,
      handler: new SimHandler({}),
    } as never);
  } catch (e) {
    err = e;
  }
  ok("recorded history without pins is refused (L5021)", anyCode(err).includes("L5021"), anyCode(err));
}

// ---- (7) a malformed entry is refused at the seed, never replayed as data ----------------------
//
// The dangerous corruption is the one lookup would MISREAD: a settled entry whose status is not
// in the vocabulary falls through every verdict arm into "replay", and the program is handed
// `result` (usually absent, so `undefined`) as if the journal had recorded it. Measured on the
// tree before the seed guard existed: the run completed with the wrong answer and nothing raised.
// So the constructor refuses what it cannot read, naming the entry.

{
  const junkStatus = recorded.map((e) => (e.name === "px" ? { ...e, status: "borked" as never } : e));
  let err: unknown;
  try {
    await replayTo(junkStatus);
  } catch (e) {
    err = e;
  }
  ok("a settled entry with an unknown status is refused at the seed", err !== undefined && anyCode(err).includes("px"), anyCode(err));

  const junkState = recorded.map((e) => (e.name === "py" ? { ...e, state: "halfway" as never } : e));
  let err2: unknown;
  try {
    await replayTo(junkState);
  } catch (e) {
    err2 = e;
  }
  ok("an entry with an unknown state is refused at the seed", err2 !== undefined && anyCode(err2).includes("py"), anyCode(err2));

  const okNoStatus = recorded.map((e) => (e.name === "warm" ? { ...e, status: undefined as never } : e));
  let err3: unknown;
  try {
    await replayTo(okNoStatus);
  } catch (e) {
    err3 = e;
  }
  ok("a settled entry with NO status is refused at the seed", err3 !== undefined && anyCode(err3).includes("warm"), anyCode(err3));
}

// ---- (8) the result bound refuses AHEAD of the append (L5006) ----------------------------------

{
  const appended: JournalEntry[] = [];
  const journal = new Journal({
    run: "r-bound",
    resultBytes: 32,
    store: {
      append: async (e) => {
        appended.push(e);
      },
    },
  });
  const key = { scope: [], kind: "ask" as const, name: "big", occurrence: 0 };
  await journal.begin(key, "sha256:" + "1".repeat(64), 0);
  const before = appended.length;
  let err: unknown;
  try {
    await journal.settle(key, { status: "ok", result: { blob: "x".repeat(500) } }, 1);
  } catch (e) {
    err = e;
  }
  ok("an oversized ok result is refused with L5006", (err as { code?: string })?.code === "L5006", anyCode(err));
  ok("by the named class, which travels the append-rejected path", (err as Error)?.name === "EffectResultTooLarge", (err as Error)?.name);
  ok("and AHEAD of the append: the store saw nothing", appended.length === before, appended.length - before);
  ok("so the entry is still pending, exactly where a recovery needs it",
    journal.lookup(key, "sha256:" + "1".repeat(64)).verdict === "pending");

  // The bound is a bound, not a mood: a small result on the same journal settles.
  const small = await journal.settle(key, { status: "ok", result: { n: 1 } }, 2);
  ok("a result under the bound settles and persists", small.status === "ok" && appended.length === before + 1);
}

// ---- (9) `refused` is IN the vocabulary, and it re-begins exactly once ------------------------
//
// A refusal is the one settled status that is not an outcome: the step was never attempted. So the
// vocabulary admits it, lookup says "perform it live", and `begin` accepts exactly one shape of
// re-begin — over a refusal — while refusing to rewrite anything that actually ran.

{
  const H = "sha256:" + "2".repeat(64);
  const refusedEntry = {
    v: 1 as const, seq: 0, run: "r-refused", scope: "", kind: "spawn" as const, name: "dev",
    occurrence: 0, inputHash: H, state: "settled" as const, status: "refused" as const,
    error: { code: "L5016", kind: "refused", message: "not durable here" },
    startedAt: 0, endedAt: 1,
  };
  const journal = new Journal({ run: "r-refused", entries: [refusedEntry] });
  const key = { scope: [], kind: "spawn" as const, name: "dev", occurrence: 0 };
  ok("a refused entry loads: the vocabulary admits it", journal.entries().length === 1);
  ok("and lookup says perform it live, never replay it", journal.lookup(key, H).verdict === "refused");

  const again = await journal.begin(key, H, 5);
  ok("begin over a refused entry writes a fresh pending row", again.state === "pending" && again.seq === 1);
  ok("without duplicating the step in the order", journal.entries().length === 1);
  const done = await journal.settle(key, { status: "ok", result: 7 }, 6);
  ok("and the fresh attempt settles over the refusal", done.status === "ok");
  ok("so the next activation replays the answer", journal.lookup(key, H).verdict === "replay");

  let guard: unknown;
  try {
    await journal.begin(key, H, 9);
  } catch (e) {
    guard = e;
  }
  ok("while begin over anything else already begun is refused loudly",
    guard instanceof Error && guard.message.includes("only a refused step may begin again"), (guard as Error)?.message);

  const fresh = new Journal({ run: "r-r2" });
  const k2 = { scope: [], kind: "turn" as const, name: "t", occurrence: 0 };
  await fresh.begin(k2, H, 0);
  const r2 = await fresh.settle(k2, { status: "refused", error: { code: "L5016", kind: "refused", message: "m" } }, 1);
  ok("settle records a refusal with its error, exclusive of result",
    r2.status === "refused" && r2.error?.code === "L5016" && r2.result === undefined);
}

console.log(`fuzz-journal.smoke: ${pass} checks passed`);
