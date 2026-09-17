#!/usr/bin/env node
// @ts-check
/**
 * Every CLI under `scripts/` must behave the same whether its path is a symlink or not.
 *
 * The defect this grades is silent and points the safe way round: a gate whose entry guard
 * compares `process.argv[1]` against `import.meta.url` as strings never runs its `main()` through
 * a link, prints nothing, and exits 0. Measured on main before this suite existed, with a macOS
 * checkout reached through `/tmp` (a symlink to `private/tmp`): `check-attribution.mjs` with no
 * arguments refused with its usage line and exit 2 by its real path, and printed nothing at exit 0
 * by the linked one. Its `--selftest` exits 0 on a pass, and through the link it also exited 0,
 * having printed nothing. Nothing downstream can tell either apart from a clean run.
 *
 * Two kinds of cell, because the scripts split into two kinds.
 *
 *   PARITY, for the six that have an invocation which refuses before doing any work: run the
 *   script by its real path and through a symlink. Both runs must reach that script's own refusal,
 *   its exit code and a stderr line that only its `main()` prints, and the two must agree on exit
 *   code, stdout and stderr. Agreement alone is not the grade: two runs that both skip `main()`
 *   agree perfectly, at exit 0 with nothing on either stream. This is the live grade, and it is
 *   what the registered mutants redden.
 *
 *   CENSUS, for the two that cannot be spawned safely. `post-publish-install-probe.mjs` and
 *   `preflight-npm-publish.mjs` start their work at entry with no argv that refuses first, so
 *   there is no probe for them that does not pack a tarball or read the registry. They are graded
 *   on the source instead: the entry-point question is asked in one place, and a hand-rolled
 *   comparison written on one line of a top-level `scripts/*.mjs` file is refused. The census
 *   carries a planted control in each direction, so a census that has stopped looking fails rather
 *   than passing quietly. What it cannot see is listed in `scripts/mutations/entrypoint-guard.json`.
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
 *
 * `status` and `stderr` are the witness that `main()` ran: the exit code of that refusal and one
 * whole line of the diagnostic it prints. Neither is enough alone. A skipped `main()` exits 0, but
 * `live-job-conclusion.mjs` refuses with 1, which is also what Node exits with when the script
 * cannot even load; only the line tells those apart.
 */
const PROBES = [
  {
    script: "check-attribution.mjs",
    argv: [],
    status: 2,
    stderr: "usage: check-attribution.mjs --range <base>..<head> [--event <event.json>] | --selftest",
  },
  {
    script: "check-operator-literals.mjs",
    argv: ["--help"],
    status: 2,
    stderr: "operator literal check: unknown argument: --help",
  },
  {
    script: "doc-binding.mjs",
    argv: [],
    status: 2,
    stderr: "usage: pnpm doc-binding <ref> | pnpm doc-binding --self-test",
  },
  { script: "live-job-conclusion.mjs", argv: [], status: 1, stderr: "--result is required" },
  { script: "pr-head-gate.mjs", argv: [], status: 2, stderr: "usage: pnpm pr-head-gate <pull-request-number>" },
  {
    script: "verify-publish-closure.mjs",
    argv: [],
    status: 2,
    stderr: "usage: verify-publish-closure.mjs <version> [--json]",
  },
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

/**
 * Did this run reach the refusal only the script's `main()` prints?
 *
 * @param {{ status: number | null, stderr: string }} r
 * @param {{ status: number, stderr: string }} probe
 */
function reachedMain(r, probe) {
  return r.status === probe.status && r.stderr.split("\n").includes(probe.stderr);
}

const workdir = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), "entrypoint-guard-")));
try {
  for (const probe of PROBES) {
    const { script, argv } = probe;
    const real = join(SCRIPTS, script);
    const link = join(workdir, script);
    symlinkSync(real, link);

    // A cell that quietly stopped testing a symlink would pass forever, so the link is asserted
    // to be one before its result is read.
    const linked = lstatSync(link).isSymbolicLink() && realpathSync(link) === real;

    const direct = run(real, argv);
    const through = run(link, argv);
    const ranByRealPath = reachedMain(direct, probe);
    const ranThroughLink = reachedMain(through, probe);
    const same =
      direct.status === through.status &&
      direct.stdout === through.stdout &&
      direct.stderr === through.stderr;

    cell(`${script} runs main() by its real path and through a symlink, and answers the same`,
      linked && ranByRealPath && ranThroughLink && same, {
        linked,
        ranByRealPath,
        ranThroughLink,
        same,
        expected: { exit: probe.status, err: probe.stderr },
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
  "every one-line entry-point guard in a top-level scripts/*.mjs goes through isMainEntry",
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
