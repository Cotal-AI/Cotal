#!/usr/bin/env node
/**
 * mutation-proof — prove a suite would actually catch the bug it claims to guard.
 *
 * A suite that passes with the change reverted proves nothing (AGENTS.md). The way to know is to
 * break the implementation on purpose and watch the suite go red **on its own line**. Doing that by
 * hand is a destructive experiment on a working tree, and every step of it has a way to lie:
 *
 *   - the mutation silently does not apply       → "unmutated" and "mutated" are the same run, and
 *                                                  the verdict is an accusation about nothing
 *   - the target string appears more than once   → you mutated something else as well
 *   - the suite dies EARLY for an unrelated reason → red, but not the red you claimed
 *   - the run never reached the new check at all → green that never executed the test
 *   - the restore silently fails                 → the next person inherits a broken tree
 *   - the mutation applied and the run NEVER SAW IT → the file changed; the thing under test read a
 *                                                  DIFFERENT copy of it. `@cotal-ai/core` resolves
 *                                                  to `dist/`, so a suite under `implementations/*`
 *                                                  audits the last BUILD, not `src`. Measured: two
 *                                                  authority changes to `endpoint-binding.ts` left
 *                                                  the 59-cell matrix audit fully green; with a
 *                                                  core build prepended, the same two mutations
 *                                                  KILLED on the assertions predicted for them.
 *                                                  Give such a mutation a `command` that builds
 *                                                  first — AND an `afterRestore` that rebuilds, or
 *                                                  the tree keeps a `dist/` compiled FROM THE
 *                                                  MUTANT after the source is put back. `dist/` is
 *                                                  gitignored, so git cannot be the recovery for it,
 *                                                  and the repo's own freshness check is an mtime
 *                                                  ORDERING test that a newer-but-wrong build passes.
 *
 * Each of those has happened. This runs the experiment so that none of them can pass as a result.
 *
 * Usage:
 *   node scripts/mutation-proof.mjs --config mutations.json
 *   node scripts/mutation-proof.mjs --file <path> --find <str> --replace <str> \
 *        --command "pnpm smoke:x" --expect-red "<substring of the failing assertion>"
 *
 * Every mutation must name the assertion it expects to redden (`expectRed`). "It went red" and "it
 * went red for my reason" are the same exit code until you say which.
 */
import { readFileSync, writeFileSync, copyFileSync, existsSync, rmSync } from "node:fs";
import { execSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const C = { red: "\x1b[31m", green: "\x1b[32m", yellow: "\x1b[33m", dim: "\x1b[2m", off: "\x1b[0m" };
const say = (s = "") => process.stdout.write(`${s}\n`);
const sha = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");

function usage(msg) {
  say(`${C.red}${msg}${C.off}\n`);
  say(readFileSync(new URL(import.meta.url)).toString().split("\n").slice(2, 40).join("\n").replace(/^ \* ?/gm, ""));
  process.exit(2);
}

/** Pairs `--k v`, but a flag whose next token is another flag (or nothing) is a boolean. Pairing
 *  unconditionally made `--allow-dirty` unusable: alone it parsed as `undefined`, and followed by
 *  another flag it swallowed it. A documented escape hatch that cannot be typed is not an escape. */
function parseArgs(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith("--")) usage(`unexpected argument: ${argv[i]}`);
    const key = argv[i].slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) a[key] = true;
    else {
      a[key] = next;
      i++;
    }
  }
  return a;
}

/**
 * Count occurrences of a literal. Deliberately literal, not a regex: a regex target is how a
 * mutation silently matches nothing (an unescaped `.` or `(` is easy), and how it silently matches
 * something else as well. If you need a multi-line target, pass one — literals span lines fine,
 * which a line-oriented matcher does not. A compiled body puts `if (…)` and its statement on
 * separate lines, so a single-line pattern misses exactly the guards worth proving.
 */
const countOccurrences = (hay, needle) => hay.split(needle).length - 1;

/** The tree must be recoverable WITHOUT this tool before a destructive experiment starts. */
function assertCleanTree(cwd, allowDirty) {
  const out = execSync("git status --porcelain", { cwd, encoding: "utf8" }).trim();
  if (!out) return;
  if (allowDirty) {
    say(`${C.yellow}! tree is dirty and --allow-dirty was passed; git cannot be your recovery${C.off}`);
    return;
  }
  say(`${C.red}REFUSING: working tree is dirty.${C.off}`);
  say("Commit before you mutate — the tree has to be recoverable independently of this tool.");
  say(`${out.split("\n").slice(0, 10).join("\n")}`);
  process.exit(3);
}

/** Run a command, capture combined output, never let a pipe eat the status. */
function run(command, cwd, timeoutMs) {
  const r = spawnSync(command, { cwd, shell: true, encoding: "utf8", timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 });
  const output = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  // A timeout kills the child and leaves status null; that is not a red, it is an unknown.
  return { status: r.status, timedOut: r.error?.code === "ETIMEDOUT" || r.signal === "SIGTERM", output };
}

/**
 * How far into the suite did the run get? Counting a suite's own progress markers separates
 * "failed at my assertion" from "died before reaching it" and from "ran an older copy of the file".
 * Convention-bound by nature, so it is advisory unless the caller supplies `progressPattern`.
 */
const progressCount = (output, pattern) => {
  // `m`, not just `g`: a caller-supplied pattern that anchors with `^` (the natural way to say "a
  // progress line", since a suite's marks are line-initial) matches ONCE without it — against the
  // start of the whole transcript. The floor then compares 1 to 1 forever and silently never fires,
  // while the baseline banner prints "1 progress marks" as though it had measured something.
  const re = new RegExp(pattern ?? "✓", "gm");
  return (output.match(re) ?? []).length;
};

/** Keys a mutation may carry. An unknown key is an ERROR, not a shrug: this tool exists because
 *  every step of the experiment has a way to lie, and "the field I set was quietly ignored" is one
 *  of them — a mis-spelled `expectRed` turns a graded proof into an ungraded red. */
const MUTATION_KEYS = new Set(["name", "file", "find", "replace", "expectRed", "command", "allowMultiple", "afterRestore"]);

function proveOne(m, opts) {
  const cwd = opts.cwd;
  const path = join(cwd, m.file);
  const label = m.name ?? `${m.file}: ${m.find.slice(0, 48).replace(/\n/g, "⏎")}`;
  say(`\n${C.dim}────────────────────────────────────────────────────────${C.off}`);
  say(`${label}`);

  const unknown = Object.keys(m).filter((k) => !MUTATION_KEYS.has(k));
  if (unknown.length) return { label, verdict: "ERROR", why: `unknown mutation key(s): ${unknown.join(", ")}` };
  if (!existsSync(path)) return { label, verdict: "ERROR", why: `target file not found: ${m.file}` };

  const before = readFileSync(path, "utf8");
  const hits = countOccurrences(before, m.find);
  // Assert the target is present AND unambiguous BEFORE grading anything. Zero means the mutation
  // would be a no-op and the verdict would be an accusation about nothing; more than one means the
  // experiment changed something you did not name.
  if (hits === 0) return { label, verdict: "ERROR", why: `target string not found in ${m.file} — nothing would have been mutated` };
  if (hits > 1 && !m.allowMultiple) {
    return { label, verdict: "ERROR", why: `target appears ${hits}× in ${m.file}; pass allowMultiple to mutate them all, or narrow it` };
  }
  // Declared mandatory at the top of this file since the first version, enforced only now. Without
  // it the sole reach evidence is the tick floor, whose default is 1 — so a mutant that crashed the
  // suite after its second mark out of four graded KILLED, exactly as if it had reddened the check.
  // "It went red" and "it went red for my reason" really are the same exit code until you say which.
  if (!m.expectRed) {
    return { label, verdict: "ERROR", why: "no expectRed: name the assertion this mutation must redden, or the verdict is an accusation about nothing" };
  }

  const backup = join(tmpdir(), `mutation-proof-${createHash("sha1").update(path).digest("hex").slice(0, 12)}.bak`);
  copyFileSync(path, backup);
  const shaBefore = sha(path);

  // Restoring the FILE is not restoring the TREE when the command under test compiles it. The sha
  // check below proves the source is byte-identical again; it says nothing about a `dist/` the run
  // produced from the mutant, which is gitignored and therefore outside the recovery this tool
  // insists on before it starts. `afterRestore` runs AFTER the source is back, so whatever it
  // regenerates is regenerated from the original.
  const restore = () => {
    copyFileSync(backup, path);
    const ok = sha(path) === shaBefore;
    rmSync(backup, { force: true });
    if (ok && m.afterRestore) {
      const rr = run(m.afterRestore, cwd, opts.timeoutMs);
      if (rr.status !== 0) {
        say(`${C.red}  afterRestore FAILED (exit ${rr.status}): derived artefacts may still be built from the mutant${C.off}`);
        return false;
      }
    }
    return ok;
  };

  try {
    writeFileSync(path, before.split(m.find).join(m.replace));
    // Assert the mutation APPLIED. A no-op mutation makes a green uninterpretable and leaves a red
    // sound only by accident.
    if (sha(path) === shaBefore) {
      restore();
      return { label, verdict: "ERROR", why: "mutation produced an identical file — it did not apply" };
    }
    say(`${C.dim}  mutated ${hits}× · running: ${m.command ?? opts.command}${C.off}`);

    const r = run(m.command ?? opts.command, cwd, opts.timeoutMs);
    const ticks = progressCount(r.output, opts.progressPattern);

    const restored = restore();
    if (!restored) return { label, verdict: "ERROR", why: `RESTORE FAILED for ${m.file} — backup at ${backup}`, ticks };

    if (r.timedOut) return { label, verdict: "INCONCLUSIVE", why: `run timed out; a hang is not a red`, ticks };

    // ---- FIRST QUESTION, ON EVERY PATH: did this run actually execute the check being graded? ---
    //
    // It used to be asked last, and only on the path where it could not matter. A matched
    // `expectRed` short-circuited the floor outright, on the reasoning that a printed assertion IS
    // direct evidence the suite reached it. The reasoning is right; the implementation was not.
    // `output.includes(expectRed)` is a substring search over the whole transcript, and a suite that
    // prints `✓ <label>` on PASS satisfies it with a GREEN line. So a mutation that left the named
    // cell untouched and crashed the suite somewhere else graded KILLED, with the tool quoting back
    // the label of an assertion that had just succeeded. Measured, not argued: in the rig, a mutant
    // that made an unrelated guard THROW, named against a cell that passed, was reported
    // `KILLED — red, and named: <that cell>`.
    //
    // The fix keeps the right reasoning and gets the evidence right. The question is not "was the
    // label printed" but "did the named assertion CHANGE STATE", and the baseline run is the
    // control that answers it: the line the label appears on when the suite is green is known, so a
    // mutated run whose only occurrences are that same line has proved nothing about that cell.
    // That is strictly stronger than the tick floor AND it is direct, so it does not reintroduce the
    // false negative the floor caused on a suite's first assertion. Its one blind spot is a harness
    // that prints byte-identical text on pass and on fail; such a harness cannot be graded by any
    // signal this tool has, and no heuristic here should pretend otherwise.
    // EXIT STATUS IS CORROBORATION, NEVER THE EVIDENCE — in BOTH directions, and the second one was
    // found the same way as the first. A teardown that calls `process.exit(0)` after the suite has
    // printed real failures and set `exitCode = 1` produces a green status over a red run; graded on
    // status alone that is SURVIVED, and the tool says "the suite PASSED with the implementation
    // broken" about a suite that printed `✗ FAIL: <the named cell>`. Measured in the rig before this
    // was written. The failure direction is the cheap one — it accuses a working test instead of
    // blessing a broken one — but in a kill set it is exactly the verdict that makes someone rewrite
    // a test that already worked.
    //
    // So both branches ask the SAME question of the named assertion's own line, and only the answer
    // differs: a KILL needs a line the green run does not print, a SURVIVOR needs the line the green
    // run does print. Deliberately NOT adopted here: a rule requiring the suite to print its own
    // summary, a zero-failure count in it, or an incompleteness marker. Those need the grader to know
    // a suite's output convention, this tool grades hundreds of suites it did not write, and a guessed
    // convention is the `progressPattern` mistake again. The baseline transcript is convention-free
    // and answers the same question.
    const short = opts.minTicks !== undefined && ticks < opts.minTicks;
    const named = r.output.split("\n").filter((l) => l.includes(m.expectRed));
    const baseHits = new Set(
      (opts.baseOutputBy?.get(m.command ?? opts.command) ?? "").split("\n").filter((l) => l.includes(m.expectRed)),
    );
    // `baseHits` empty = the label appears ONLY on failure in this harness (a throw-only suite). Then
    // its absence from a green run is normal and carries no information, so these checks stay off.
    if (r.status === 0) {
      // Green after barely running is not a survivor — it is a run that never reached the check,
      // which is the fourth lie listed at the top of this file.
      if (short) {
        return { label, verdict: "INCONCLUSIVE",
          why: `exited 0 but reached only ${ticks} progress marks (expected ≥ ${opts.minTicks}) — the suite did not run far enough for its pass to mean anything`, ticks };
      }
      if (baseHits.size > 0 && named.length === 0) {
        return { label, verdict: "INCONCLUSIVE",
          why: `exited 0 but never printed the named assertion at all (the green run prints it) — the cell did not run, so its "pass" is about nothing`, ticks };
      }
      const changed = named.find((l) => !baseHits.has(l));
      if (changed !== undefined) {
        return { label, verdict: "INCONCLUSIVE",
          why: `exited 0, but the named assertion did NOT print what it prints when green (${JSON.stringify(changed.trim())}) — the suite noticed and something swallowed the exit code; a green status is not a pass`, ticks };
      }
      return { label, verdict: "SURVIVED",
        why: "the suite PASSED with the implementation broken — it does not test this", ticks };
    }

    if (named.length === 0) {
      return { label, verdict: "WRONG-RED",
        why: `exited ${r.status} but never printed the expected failure: ${JSON.stringify(m.expectRed)}`, ticks };
    }
    if (baseHits.size > 0 && named.every((l) => baseHits.has(l))) {
      return { label, verdict: "WRONG-RED",
        why: `exited ${r.status}, but the named assertion printed exactly what it prints when GREEN `
           + `(${JSON.stringify(named[0].trim())}) — it did not go red, so this red is some other failure`, ticks };
    }
    return { label, verdict: "KILLED", why: `red, and named: ${m.expectRed}`, ticks };
  } catch (e) {
    restore();
    return { label, verdict: "ERROR", why: `harness threw: ${e.message}` };
  }
}

// ---- entry ------------------------------------------------------------------------------------
const a = parseArgs(process.argv.slice(2));
const cwd = a.cwd ?? process.cwd();
let mutations;
let opts = {
  cwd,
  command: a.command,
  timeoutMs: Number(a.timeout ?? 900_000),
  progressPattern: a["progress-pattern"],
  minTicks: a["min-ticks"] === undefined ? undefined : Number(a["min-ticks"]),
};

if (a.config) {
  // `resolve`, not `join`: an ABSOLUTE --config path joined to cwd becomes a nonexistent path under
  // the repo, and the tool dies on ENOENT with the two paths glued together.
  const cfg = JSON.parse(readFileSync(resolve(cwd, a.config), "utf8"));
  mutations = cfg.mutations ?? usage("config has no `mutations` array");
  opts = { ...opts, command: cfg.command ?? opts.command, progressPattern: cfg.progressPattern ?? opts.progressPattern, minTicks: cfg.minTicks ?? opts.minTicks };
} else if (a.file && a.find !== undefined && a.replace !== undefined) {
  mutations = [{ file: a.file, find: a.find, replace: a.replace, expectRed: a["expect-red"] }];
} else {
  usage("need --config <file>, or --file/--find/--replace");
}
if (!opts.command) usage("no --command given (and none in the config)");

assertCleanTree(cwd, a["allow-dirty"] !== undefined);

// A baseline is not optional: a suite that is ALREADY red grades every mutation as KILLED.
//
// ONE BASELINE PER DISTINCT COMMAND, because a mutation may name its own (`m.command`). Baselining
// only the top-level one left every mutation that ran a DIFFERENT suite with no proof its suite was
// green beforehand — and compared its progress marks against a tally from an unrelated suite, so
// the "did the run reach the check" floor was being applied across suites that count different
// things. Both protections silently covered a fraction of the set and reported as if they covered
// all of it.
const commands = [...new Set(mutations.map((m) => m.command ?? opts.command))];
const baseTicksBy = new Map();
// The green transcript is kept, not just its tally: it is the control that says what each named
// assertion looks like when it PASSES, which is the only way to tell a red line from a green one
// without guessing at a suite's marker convention.
opts.baseOutputBy = new Map();
for (const cmd of commands) {
  say(`${C.dim}baseline: ${cmd}${C.off}`);
  const base = run(cmd, cwd, opts.timeoutMs);
  const ticks = progressCount(base.output, opts.progressPattern);
  if (base.status !== 0) {
    say(`${C.red}REFUSING: \`${cmd}\` is red BEFORE any mutation (exit ${base.status}).${C.off}`);
    say("Every mutation running it would grade as KILLED for a reason that has nothing to do with the mutation.");
    process.exit(4);
  }
  // A suite that emits no marks has NO reached-the-assertion protection, whatever else it printed.
  // Say so out loud rather than letting the floor quietly not apply.
  say(`${C.green}baseline green${C.off} (${ticks} progress marks)`
    + (ticks === 0 ? ` ${C.yellow}— no progress marks: the reached-the-check floor cannot apply to this suite${C.off}` : ""));
  baseTicksBy.set(cmd, ticks);
  opts.baseOutputBy.set(cmd, base.output);
}
if (opts.minTicks === undefined && [...baseTicksBy.values()].some((t) => t > 0)) {
  // Default the floor just under the baseline: a mutated run that dies much earlier failed for
  // some other reason, and a run that never reaches the check is not evidence about it.
  opts.minTicks = 1;
}

const results = [];
for (const m of mutations) {
  // Report each verdict's marks against ITS OWN suite's baseline. Two suites count different
  // things, so "8 marks (baseline 24)" across a suite boundary reads as a run that died early
  // when it may have run to completion.
  results.push({ ...proveOne(m, opts), baseTicks: baseTicksBy.get(m.command ?? opts.command) });
}

say(`\n${C.dim}════════════════════════════════════════════════════════${C.off}`);
let bad = 0;
for (const r of results) {
  const good = r.verdict === "KILLED";
  if (!good) bad++;
  const colour = good ? C.green : r.verdict === "SURVIVED" ? C.red : C.yellow;
  say(`${colour}${r.verdict.padEnd(12)}${C.off} ${r.label}`);
  say(`  ${C.dim}${r.why}${r.ticks !== undefined ? ` · ${r.ticks} marks (baseline ${r.baseTicks ?? "?"})` : ""}${C.off}`);
}
say("");
if (bad === 0) {
  say(`${C.green}All ${results.length} mutation(s) killed. The suite discriminates.${C.off}`);
  say(`${C.dim}Scope: this proves the suite DEPENDS on the mutated code. It does not prove a real entry`);
  say(`point reaches that code — if the test builds its inputs by hand, prove that separately.${C.off}`);
} else {
  say(`${C.red}${bad} of ${results.length} mutation(s) did not produce a clean, named red.${C.off}`);
}
process.exit(bad === 0 ? 0 : 1);
