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
 *
 * Each of those has happened. This runs the experiment so that none of them can pass as a result.
 *
 * Usage:
 *   node scripts/mutation-proof.mjs --config mutations.json   (relative to --cwd, or an absolute path)
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
import { join, isAbsolute } from "node:path";

const C = { red: "\x1b[31m", green: "\x1b[32m", yellow: "\x1b[33m", dim: "\x1b[2m", off: "\x1b[0m" };
const say = (s = "") => process.stdout.write(`${s}\n`);
const sha = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");

function usage(msg) {
  say(`${C.red}${msg}${C.off}\n`);
  say(readFileSync(new URL(import.meta.url)).toString().split("\n").slice(2, 27).join("\n").replace(/^ \* ?/gm, ""));
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
  const re = new RegExp(pattern ?? "✓", "g");
  return (output.match(re) ?? []).length;
};

function proveOne(m, opts) {
  const cwd = opts.cwd;
  const path = join(cwd, m.file);
  const label = m.name ?? m.label ?? `${m.file}: ${m.find.slice(0, 48).replace(/\n/g, "⏎")}`;
  say(`\n${C.dim}────────────────────────────────────────────────────────${C.off}`);
  say(`${label}`);

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

  const backup = join(tmpdir(), `mutation-proof-${createHash("sha1").update(path).digest("hex").slice(0, 12)}.bak`);
  copyFileSync(path, backup);
  const shaBefore = sha(path);

  const restore = () => {
    copyFileSync(backup, path);
    const ok = sha(path) === shaBefore;
    rmSync(backup, { force: true });
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
    if (r.status === 0) {
      return {
        label,
        verdict: "SURVIVED",
        why: "the suite PASSED with the implementation broken — it does not test this",
        ticks,
      };
    }
    // Red is necessary but not sufficient: it has to be red for the reason claimed, or an unrelated
    // early failure reads as proof.
    if (m.expectRed && !r.output.includes(m.expectRed)) {
      return {
        label,
        verdict: "WRONG-RED",
        why: `exited ${r.status} but never printed the expected failure: ${JSON.stringify(m.expectRed)}`,
        ticks,
      };
    }
    // The tick floor is a HEURISTIC for "did it get far enough to be about my check", and it must
    // never overrule direct evidence. A matched `expectRed` IS that evidence: the suite printed the
    // assertion we named. Letting the heuristic win graded a correct proof as WRONG-RED whenever the
    // mutation targeted the suite's FIRST assertion — a false negative on a working test, which is
    // the expensive direction, because the fix someone reaches for is to weaken the test.
    if (!m.expectRed && opts.minTicks !== undefined && ticks < opts.minTicks) {
      return {
        label,
        verdict: "WRONG-RED",
        why: `died after only ${ticks} progress marks (expected ≥ ${opts.minTicks}) and no expectRed was given, so there is nothing to tie this red to your check`,
        ticks,
      };
    }
    // A named red says the assertion fired. It does not say the SUITE RAN — a mutant that crashes
    // the run after forty cells can print a failure line carrying the named string and be graded a
    // kill by a suite that never reached its own end. When a config names the marker its suite
    // prints last, its absence is INCONCLUSIVE: the run did not finish, which is not a kill and is
    // not a survival either. A harness with only two verdicts rounds this one to the convenient side.
    // Per mutation first: a fail-fast suite has no single line that always prints, so each mutation
    // names the marker just UPSTREAM of the region it breaks. The marker must be independent of the
    // outcome the mutation changes — a line that only prints on success means absence proves the
    // mutation WORKED, and every genuine kill would be graded INCONCLUSIVE instead.
    const marker = m.completionMarker ?? opts.completionMarker;
    if (marker && !r.output.includes(marker)) {
      return {
        label,
        verdict: "INCONCLUSIVE",
        why: `red, and named — but the run never printed ${JSON.stringify(marker)}, so it did not reach the region under test and this is not evidence about one cell`,
        ticks,
      };
    }
    return { label, verdict: "KILLED", why: m.expectRed ? `red, and named: ${m.expectRed}` : `red (exit ${r.status})`, ticks };
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

/**
 * The key set is CLOSED, because an ignored key is the quietest way to lose a check. A misspelt
 * `expectRed` leaves nothing behind: the strongest grade this tool makes silently stops being made,
 * and every mutation then reports KILLED on any red at all — including an unrelated early crash.
 * "Red alone is not proof" was reachable by one typo in a file nobody re-reads after it goes green.
 *
 * `label` is accepted as an alias for `name` rather than rejected: it is what most configs in
 * flight already use, and until now they printed the fallback label instead of the intent their
 * author wrote. The rest are annotations tools other than this one read; they are listed so that
 * carrying one is a decision rather than a typo that happens to survive.
 */
const MUTATION_KEYS = [
  "name", "label", "file", "find", "replace", "expectRed", "allowMultiple", "command",
  "cell", "cellTemplate", "completionMarker", "id", "note",
];

if (a.config) {
  // An ABSOLUTE config path is used as given. It used to be joined to the repo root, which turned
  // `/tmp/x.json` into `<repo>/tmp/x.json` and died on ENOENT — so the only ways to run a config
  // were to put it in the tree (dirtying the tree this tool then refuses) or to reach it with
  // `../../../`. A harness whose own escape hatch is the only way to grade it is a harness whose
  // guard is untested by construction. Relative paths still resolve against `cwd`, unchanged.
  const cfgPath = isAbsolute(a.config) ? a.config : join(cwd, a.config);
  const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
  mutations = cfg.mutations ?? usage("config has no `mutations` array");
  for (const m of mutations) {
    for (const k of Object.keys(m)) {
      if (!MUTATION_KEYS.includes(k))
        usage(`mutation ${JSON.stringify(m.name ?? m.label ?? m.file)} carries the unknown key ${JSON.stringify(k)}. This tool would ignore it — and if it is a misspelt "expectRed", every mutation below would report KILLED on any red at all. Known keys: ${MUTATION_KEYS.join(", ")}`);
    }
  }
  opts = { ...opts, command: cfg.command ?? opts.command, progressPattern: cfg.progressPattern ?? opts.progressPattern, minTicks: cfg.minTicks ?? opts.minTicks, completionMarker: cfg.completionMarker ?? opts.completionMarker };
} else if (a.file && a.find !== undefined && a.replace !== undefined) {
  mutations = [{ file: a.file, find: a.find, replace: a.replace, expectRed: a["expect-red"] }];
} else {
  usage("need --config <file>, or --file/--find/--replace");
}
if (!opts.command) usage("no --command given (and none in the config)");

assertCleanTree(cwd, a["allow-dirty"] !== undefined);

// EVERY TARGET IS CHECKED BEFORE ANY SUITE RUNS, because a stale anchor is what a REPAIR leaves
// behind and a repair is exactly what you run this tool after.
//
// `proveOne` already refuses an absent or ambiguous target — but per mutation, after the baseline
// and after every earlier mutation has run the suite. A config whose first mutation is stale
// therefore costs a full pass to find out, and the finding lands as one ERROR line among N verdicts
// where a reader scanning for KILLED/SURVIVED does not see it: the guard went UNGRADED while the run
// still looked healthy, and only the trailing tally disagreed. That happened three times in one day
// in this tree, twice on the same mutation, the second time after the rule about it was written
// down — because the rule was about how to READ the log, and reading correctly still costs the run.
//
// So it is asked up front, and all of them are reported at once rather than one per pass: a repair
// usually disarms several anchors, and finding them one run at a time is the same discovery paid
// for repeatedly.
{
  const stale = [];
  for (const m of mutations) {
    const path = join(cwd, m.file);
    if (!existsSync(path)) { stale.push([m, `file not found: ${m.file}`]); continue; }
    const hits = countOccurrences(readFileSync(path, "utf8"), m.find);
    if (hits === 0) stale.push([m, `target string not found in ${m.file}`]);
    else if (hits > 1 && !m.allowMultiple) stale.push([m, `target appears ${hits}× in ${m.file}`]);
  }
  if (stale.length > 0) {
    say(`${C.red}REFUSING: ${stale.length} of ${mutations.length} mutation(s) name a target this tree does not have.${C.off}`);
    say("Nothing would have been mutated for these, so their guards would go UNGRADED while the run looked healthy.");
    for (const [m, why] of stale) say(`  ${C.dim}- ${m.name ?? m.label ?? m.find.slice(0, 48).replace(/\n/g, "⏎")}: ${why}${C.off}`);
    say("Re-anchor them to the code as it is now — or, if the guard they grade has stopped being observable, retire them with the reason.");
    process.exit(6);
  }
}

// A baseline is not optional: a suite that is ALREADY red grades every mutation as KILLED.
say(`${C.dim}baseline: ${opts.command}${C.off}`);
const base = run(opts.command, cwd, opts.timeoutMs);
const baseTicks = progressCount(base.output, opts.progressPattern);
if (base.status !== 0) {
  say(`${C.red}REFUSING: the suite is red BEFORE any mutation (exit ${base.status}).${C.off}`);
  say("Every mutation would grade as KILLED for a reason that has nothing to do with the mutation.");
  process.exit(4);
}
say(`${C.green}baseline green${C.off} (${baseTicks} progress marks)`);

// The reached-the-region protection is OPT-IN BY STRING MATCH, and a suite that prints its own
// glyph — `ok`, `PASS`, anything but `✓` — scores zero marks and has that protection SILENTLY
// DISABLED while every verdict still prints correctly. It fails open and says nothing, which is the
// misspelt-key defect one layer out: in the output parser rather than in the config schema, where
// the closed key set cannot see it.
//
// A suite with no marks is still gradable IF every mutation names a `completionMarker`, which is
// the same protection stated per mutation instead of counted. What is not gradable is a run with
// neither: then "the mutation applied and nothing caught it" and "the run died before reaching the
// cell" produce an identical SURVIVED, and a survivor batch is exactly where that matters.
if (baseTicks === 0) {
  const unprotected = mutations.filter((m) => (m.completionMarker ?? opts.completionMarker) === undefined);
  if (unprotected.length > 0) {
    say(`${C.red}REFUSING: the baseline scored 0 progress marks and ${unprotected.length} mutation(s) name no completionMarker.${C.off}`);
    say(`This suite prints no ${JSON.stringify(opts.progressPattern ?? "✓")}, so the reached-the-assertion guard counted nothing —`);
    say("a SURVIVED here would be indistinguishable from a run that died before the cell.");
    for (const m of unprotected) say(`  ${C.dim}- ${m.name ?? m.label ?? m.find.slice(0, 48)}${C.off}`);
    say("Give each a completionMarker printed UPSTREAM of the mutated region, or --progress-pattern the glyph this suite actually prints.");
    process.exit(5);
  }
  say(`${C.dim}  0 marks, but every mutation names a completionMarker — graded on those instead.${C.off}`);
}

if (opts.minTicks === undefined && baseTicks > 0) {
  // Default the floor just under the baseline: a mutated run that dies much earlier failed for
  // some other reason, and a run that never reaches the check is not evidence about it.
  opts.minTicks = 1;
}

const results = [];
for (const m of mutations) results.push(proveOne(m, opts));

say(`\n${C.dim}════════════════════════════════════════════════════════${C.off}`);
let bad = 0;
for (const r of results) {
  const good = r.verdict === "KILLED";
  if (!good) bad++;
  const colour = good ? C.green : r.verdict === "SURVIVED" ? C.red : C.yellow;
  say(`${colour}${r.verdict.padEnd(12)}${C.off} ${r.label}`);
  say(`  ${C.dim}${r.why}${r.ticks !== undefined ? ` · ${r.ticks} marks (baseline ${baseTicks})` : ""}${C.off}`);
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
