#!/usr/bin/env node
// @ts-check
/**
 * Every CLI under `scripts/` must behave the same whether its path is a symlink or not.
 *
 * The defect this grades is silent and points the safe way round: a gate whose entry guard
 * compares `process.argv[1]` against `import.meta.url` as strings never runs its `main()` through
 * a link, prints nothing, and exits 0. Measured on main before this suite existed, with an
 * ordinary macOS checkout reached through `/tmp` (a symlink to `private/tmp`):
 * `check-attribution.mjs --selftest` graded 14 fixtures and exited 2 by its real path, and printed
 * nothing at exit 0 by the linked one. Nothing downstream can tell that apart from a clean run.
 *
 * Two kinds of cell, because the scripts split into two kinds.
 *
 *   PARITY, for the six that have an invocation which refuses before doing any work: run the
 *   script by its real path and through a symlink, and require the same exit code, stdout and
 *   stderr. This is the live grade, and it is what the registered mutants redden.
 *
 *   CENSUS, for the two that cannot be spawned safely. `post-publish-install-probe.mjs` and
 *   `preflight-npm-publish.mjs` start their work at entry with no argv that refuses first, so
 *   there is no probe for them that does not pack a tarball or read the registry. They are graded
 *   on the source instead: the entry-point question is asked in one place, and a hand-rolled
 *   comparison anywhere under `scripts/` is refused. The census carries a planted control in each
 *   direction, so a census that has stopped looking fails rather than passing quietly.
 *
 * Cells run to the end and each prints its own line: a mutation that reddens two of them must
 * still be readable as reddening the one it names.
 */
import { spawnSync } from "node:child_process";
import { lstatSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPTS = dirname(realpathSync(fileURLToPath(import.meta.url)));
const ROOT = dirname(SCRIPTS);

/**
 * One invocation per script that refuses before it does anything. Each was measured by hand first:
 * an argv that reaches the network or the working tree would make this suite a side effect.
 */
const PROBES = [
  { script: "check-attribution.mjs", argv: [] },
  { script: "check-operator-literals.mjs", argv: ["--help"] },
  { script: "doc-binding.mjs", argv: [] },
  { script: "live-job-conclusion.mjs", argv: [] },
  { script: "pr-head-gate.mjs", argv: [] },
  { script: "verify-publish-closure.mjs", argv: [] },
];

/**
 * Files allowed to mention `process.argv[1]` without going through `isMainEntry`, with the reason.
 * An empty map would be the stronger rule; this one entry is a guard that was already correct and
 * already has a registered mutant of its own naming its own cell, so moving it would move somebody
 * else's proof for no gain here.
 */
const CENSUS_EXEMPT = new Map([
  ["upgrade-section-gate.mjs", "carries the same realpath comparison inline, graded by its own cell and mutant"],
  ["entrypoint-guard.selftest.mjs", "holds the planted controls below, which are guards on purpose"],
  ["main-entry.mjs", "is the one place the question is asked"],
]);

/** What makes a `process.argv[1]` line an entry-point comparison rather than an ordinary read. */
const GUARD_SHAPE = ["import.meta.url", "fileURLToPath", "pathToFileURL", "file://", "resolve("];

let pass = 0;
let fail = 0;

/** @param {string} name @param {boolean} ok @param {unknown} [detail] */
function cell(name, ok, detail) {
  if (ok) pass += 1;
  else fail += 1;
  const suffix = ok || detail === undefined ? "" : `: ${typeof detail === "string" ? detail : JSON.stringify(detail)}`;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${suffix}`);
}

/** @param {string} path @param {string[]} argv */
function run(path, argv) {
  const r = spawnSync(process.execPath, [path, ...argv], { cwd: ROOT, encoding: "utf8" });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

const workdir = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), "entrypoint-guard-")));
try {
  for (const { script, argv } of PROBES) {
    const real = join(SCRIPTS, script);
    const link = join(workdir, script);
    symlinkSync(real, link);

    // A cell that quietly stopped testing a symlink would pass forever, so the link is asserted
    // to be one before its result is read.
    const linked = lstatSync(link).isSymbolicLink() && realpathSync(link) === real;

    const direct = run(real, argv);
    const through = run(link, argv);
    const same =
      linked &&
      direct.status === through.status &&
      direct.stdout === through.stdout &&
      direct.stderr === through.stderr;

    cell(`${script} answers the same through a symlink`, same, {
      linked,
      direct: { exit: direct.status, out: direct.stdout.trim().slice(0, 120), err: direct.stderr.trim().slice(0, 120) },
      symlink: { exit: through.status, out: through.stdout.trim().slice(0, 120), err: through.stderr.trim().slice(0, 120) },
    });
  }
} finally {
  rmSync(workdir, { recursive: true, force: true });
}

/**
 * Lines that ask the entry-point question by hand, in one file's source.
 *
 * @param {string} name file name, used to apply the exemption
 * @param {string} source
 * @returns {string[]} the offending lines, trimmed
 */
function handRolledGuards(name, source) {
  if (CENSUS_EXEMPT.has(name)) return [];
  return source
    .split("\n")
    .map((line) => line.trim())
    // Prose that describes the defect is not the defect. Comment lines are dropped by their
    // opening token, which is coarse and deliberately so: the planted controls below prove the
    // census still refuses a real guard, and a rule nobody can predict is a rule people route
    // around.
    .filter((line) => !line.startsWith("*") && !line.startsWith("//") && !line.startsWith("/*"))
    .filter((line) => line.includes("process.argv[1]"))
    .filter((line) => GUARD_SHAPE.some((token) => line.includes(token)));
}

const censusFindings = readdirSync(SCRIPTS)
  .filter((name) => name.endsWith(".mjs"))
  .flatMap((name) => handRolledGuards(name, readFileSync(join(SCRIPTS, name), "utf8")).map((line) => `${name}: ${line}`));

cell(
  "every entry-point guard under scripts/ goes through isMainEntry",
  censusFindings.length === 0,
  censusFindings,
);

// Both directions, because a census that answers "clean" to everything is indistinguishable from a
// census that works until you plant something in front of it.
const plantedBad = handRolledGuards(
  "planted.mjs",
  "if (import.meta.url === `file://${process.argv[1]}`) {\n  main();\n}\n",
);
const plantedGood = handRolledGuards(
  "planted.mjs",
  'import { isMainEntry } from "./main-entry.mjs";\nif (isMainEntry(import.meta.url)) {\n  main();\n}\n',
);
cell(
  "the census control refuses a planted hand-rolled guard and accepts a planted isMainEntry",
  plantedBad.length === 1 && plantedGood.length === 0,
  { plantedBad, plantedGood },
);

console.log(`\nENTRYPOINT GUARD SELF-TEST ${fail === 0 ? "OK" : "FAILED"} (${pass} passed, ${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);
