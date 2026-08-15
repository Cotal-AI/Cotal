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
 *   node scripts/mutation-proof.mjs --config mutations.json
 *   node scripts/mutation-proof.mjs --file <path> --find <str> --replace <str> \
 *        --command "pnpm smoke:x" --expect-red "<substring of the failing assertion>"
 *
 *   --private-build <pkgDir>   Compile the mutant into a scratch dir INSIDE that package and point
 *                              the suite at it via COTAL_CORE_ENTRY, instead of writing the shared
 *                              dist/ that sibling worktrees and installed extensions execute. Use
 *                              it whenever the suite loads the mutated package through a BUILD.
 *
 * Every mutation must name the assertion it expects to redden (`expectRed`). "It went red" and "it
 * went red for my reason" are the same exit code until you say which.
 */
import { readFileSync, writeFileSync, copyFileSync, existsSync, rmSync, mkdtempSync } from "node:fs";
import { execSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
function run(command, cwd, timeoutMs, env) {
  const r = spawnSync(command, { cwd, shell: true, encoding: "utf8", timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, env: env ? { ...process.env, ...env } : process.env });
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

/**
 * PRIVATE BUILD — the reason this exists is a defect this harness caused.
 *
 * A mutation proof compiles a deliberately broken implementation. If that build lands in a
 * package's shared `dist/`, it is not merely visible to other readers, it is the artifact they
 * EXECUTE: installed extensions and sibling worktrees resolve the same path. On this box a mutant
 * core was loaded by every claude and opencode seat for the length of a proof.
 *
 * So the mutant is compiled into a scratch directory created by THIS run, and the suite is pointed
 * at it with COTAL_CORE_ENTRY. Exclusivity by construction: the path did not exist until now, so
 * nothing else can already resolve it. That is the only available guarantee — you CANNOT enumerate
 * who resolves a shared path (the filesystem keeps no reverse index of symlinks), so a check at the
 * write site is not a fix.
 *
 * The scratch lives INSIDE the package, not in /tmp: node resolves bare specifiers by walking
 * node_modules upward from the importing file, so a build outside the workspace compiles fine and
 * fails to load its own dependencies.
 */
function makePrivateBuild(projectDir, cwd) {
  const abs = join(cwd, projectDir);
  if (!existsSync(abs)) throw new Error(`--private-build: no such package dir: ${projectDir}`);
  const scratch = mkdtempSync(join(abs, ".privbuild-"));
  const build = () => {
    const r = run(`./node_modules/.bin/tsc -p ${projectDir} --outDir ${scratch}`, cwd, 600_000);
    if (r.status !== 0) throw new Error(`private build failed (exit ${r.status}):\n${r.output.slice(-2000)}`);
  };
  return { scratch, build, env: { COTAL_CORE_ENTRY: join(scratch, "index.js") }, cleanup: () => rmSync(scratch, { recursive: true, force: true }) };
}

function proveOne(m, opts) {
  const cwd = opts.cwd;
  const path = join(cwd, m.file);
  const label = m.name ?? `${m.file}: ${m.find.slice(0, 48).replace(/\n/g, "⏎")}`;
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

  // SIGNAL SAFETY. try/catch does not run on SIGINT or SIGTERM, so before this existed a Ctrl-C
  // during a run left the MUTANT in the working tree indefinitely, with only a .bak in tmpdir and
  // nothing said about it. That is the worst form of this hazard: the tree is wrong, `git status`
  // shows a modification nobody reads as a mutant, and on a shared checkout the next `tsc` compiles
  // it. Restore on the way out of the process, then re-raise so the exit status still reports the
  // signal rather than being swallowed.
  const onSignal = (sig) => {
    try {
      const ok = restore();
      say(`\n${ok ? C.yellow : C.red}${sig}: ${ok ? "restored" : "RESTORE FAILED for"} ${m.file}${C.off}`);
      if (!ok) say(`${C.red}THE MUTANT MAY STILL BE IN THE TREE — check ${m.file} before anything builds.${C.off}`);
    } catch (e) {
      say(`\n${C.red}${sig}: restore threw (${e.message}); the mutant may still be in ${m.file}.${C.off}`);
    }
    opts.priv?.cleanup();
    process.removeListener(sig, onSignal);
    process.kill(process.pid, sig);
  };
  const SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"];
  for (const sig of SIGNALS) process.on(sig, onSignal);
  const clearSignals = () => { for (const sig of SIGNALS) process.removeListener(sig, onSignal); };

  try {
    writeFileSync(path, before.split(m.find).join(m.replace));
    // Assert the mutation APPLIED. A no-op mutation makes a green uninterpretable and leaves a red
    // sound only by accident.
    if (sha(path) === shaBefore) {
      restore();
      clearSignals();
      return { label, verdict: "ERROR", why: "mutation produced an identical file — it did not apply" };
    }
    say(`${C.dim}  mutated ${hits}× · running: ${m.command ?? opts.command}${C.off}`);

    // The mutant is now in `src`; compile it into the PRIVATE build so the suite executes it.
    // Without this the suite would load the last build and grade unmutated code — green for a
    // reason unrelated to the mutation, which is a SURVIVED verdict that means nothing.
    if (opts.priv) opts.priv.build();
    const r = run(m.command ?? opts.command, cwd, opts.timeoutMs, opts.priv?.env);
    const ticks = progressCount(r.output, opts.progressPattern);

    const restored = restore();
    clearSignals();
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
    return { label, verdict: "KILLED", why: m.expectRed ? `red, and named: ${m.expectRed}` : `red (exit ${r.status})`, ticks };
  } catch (e) {
    restore();
    clearSignals();
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
  // --private-build <pkgDir>: compile the mutant into a scratch dir inside that package and point
  // the suite at it, instead of writing the package's SHARED dist that other worktrees and
  // installed extensions resolve.
  priv: a["private-build"] ? makePrivateBuild(a["private-build"], cwd) : undefined,
  minTicks: a["min-ticks"] === undefined ? undefined : Number(a["min-ticks"]),
};

if (a.config) {
  const cfg = JSON.parse(readFileSync(join(cwd, a.config), "utf8"));
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
say(`${C.dim}baseline: ${opts.command}${C.off}`);
if (opts.priv) {
  say(`${C.dim}private build: ${opts.priv.env.COTAL_CORE_ENTRY}${C.off}`);
  try { opts.priv.build(); } catch (e) { say(`${C.red}REFUSING: ${e.message}${C.off}`); opts.priv.cleanup(); process.exit(5); }
}
const base = run(opts.command, cwd, opts.timeoutMs, opts.priv?.env);
// THE SEAM'S FAILURE MODE IS SILENCE, and silence survived forty lines of review once already:
// connection-control's whole-namespace COTAL_ scrub deleted COTAL_CORE_ENTRY before the suite read
// it, so every proof would have graded the SHARED build while reporting success. A fallback that is
// correct behaviour in the normal case is a perfect disguise for a dead seam — no error, no warning,
// no missing file. So REQUIRE the suite to say which build it loaded, and refuse if it says shared.
if (opts.priv) {
  if (!/PRIVATE build/.test(base.output)) {
    say(`${C.red}REFUSING: --private-build was requested but the suite never reported loading a PRIVATE build.${C.off}`);
    say("Either the suite does not honour COTAL_CORE_ENTRY, or something stripped it from the environment.");
    say("Grading would compile the mutant into the SHARED dist's place while reporting a private run.");
    opts.priv.cleanup();
    process.exit(6);
  }
  say(`${C.green}seam confirmed${C.off} — the suite reported loading the private build`);
}
const baseTicks = progressCount(base.output, opts.progressPattern);
if (base.status !== 0) {
  say(`${C.red}REFUSING: the suite is red BEFORE any mutation (exit ${base.status}).${C.off}`);
  say("Every mutation would grade as KILLED for a reason that has nothing to do with the mutation.");
  process.exit(4);
}
say(`${C.green}baseline green${C.off} (${baseTicks} progress marks)`);
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
opts.priv?.cleanup();
say("");
if (bad === 0) {
  say(`${C.green}All ${results.length} mutation(s) killed. The suite discriminates.${C.off}`);
  say(`${C.dim}Scope: this proves the suite DEPENDS on the mutated code. It does not prove a real entry`);
  say(`point reaches that code — if the test builds its inputs by hand, prove that separately.${C.off}`);
} else {
  say(`${C.red}${bad} of ${results.length} mutation(s) did not produce a clean, named red.${C.off}`);
}
process.exit(bad === 0 ? 0 : 1);
