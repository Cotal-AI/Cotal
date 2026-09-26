/**
 * Run a round-robin SHARD of the `smoke:ci` chain, so CI can fan the (serial) protocol/security
 * suite across N parallel runners without dropping or duplicating a single smoke.
 *
 *   node bin/smoke/shard.mjs <shardIndex> <shardCount> [--offline]
 *
 * `--offline` runs the SAME shard minus its live-shaped suites, classified by behaviour through the
 * shared predicate in scripts/mutation-command-safety.mjs: a live-named script, a live-named source
 * file, an infrastructure marker, or a resolved source that invokes `cotal up` (#1410). Every
 * exclusion is printed with its reason and the completion banner names itself OFFLINE, so the
 * partial artifact can never be read as the gate. An offline run that excludes nothing is refused:
 * the mode exists because the inventory holds live suites, and an empty exclusion set means the
 * classifier stopped working, not that the tree is clean.
 *
 * The frozen legacy list is read from `bin/smoke/ci-suites.txt`; new suites are one-file fragments
 * under `bin/smoke/ci-suites.d/`. Legacy entries keep round-robin `index % count`. Fragment entries
 * use a stable hash of their suite name, so an independently-merged fragment cannot move another.
 * Each smoke runs in its own `pnpm` subprocess (separate broker/ports) exactly as the serial chain
 * does; the shards run on SEPARATE runners, so there is no cross-smoke port contention within a shard.
 *
 * Exit status is not enough. A suite that returns 0 having run zero cells is the same false green
 * as an empty chain; the runner parses a cell-count sentinel from the suite's own output and refuses
 * a missing sentinel or a zero-cell run, naming the suite and the reason.
 */
import { spawn } from "node:child_process";
import { parseCiSuites, readCiSuiteFragments, suitesForShard, CI_SUITES_PATH } from "./ci-suites.mjs";
import { readFileSync } from "node:fs";
import { liveShapedCommandReason } from "../../scripts/mutation-command-safety.mjs";
import { reapSmokeBrokers, reportReaped } from "./reap-smoke-brokers.mjs";
import { reapRunCustodians, reportCustodians } from "./reap-seat-custodians.mjs";
import { neverRanBlock } from "./shard-never-ran.mjs";
import { parseSentinel } from "./sentinel.mjs";

const REPO = process.cwd();

const offline = process.argv.includes("--offline");
const positional = process.argv.slice(2).filter((arg) => arg !== "--offline");
const shard = Number(positional[0]);
const count = Number(positional[1]);
if (!Number.isInteger(shard) || !Number.isInteger(count) || count < 1 || shard < 0 || shard >= count) {
  console.error(
    `usage: node bin/smoke/shard.mjs <shardIndex 0..N-1> <shardCount N> [--offline]  (got: ${positional.join(" ")})`,
  );
  process.exit(2);
}

// An EMPTY chain is an error, not a fast green: a runner that finds no suites and exits 0 reports
// the same thing as a runner that passed all of them.
const listPath = process.env.COTAL_CI_SUITES || CI_SUITES_PATH;
const legacy = parseCiSuites(readFileSync(listPath, "utf8"), listPath);
const fragments = listPath === CI_SUITES_PATH ? readCiSuiteFragments() : [];
const all = [...legacy, ...fragments].map((s) => `pnpm ${s}`);
if (all.length === 0) { console.error(`no suites in ${listPath}`); process.exit(2); }
const mine = suitesForShard(legacy, fragments, shard, count).map((s) => `pnpm ${s}`);

// The offline exclusion set, derived from BEHAVIOUR through the shared predicate under the runner's
// cwd: the repo root in production (`pnpm smoke:ci:offline`), and the fixture dir when the sentinel
// suite drives this file over a synthetic list, so the temp package.json and suite bodies are the
// ones classified. Classify only this shard's entries, so a shard's exclusion block names exactly
// what it did not run.
const excluded = offline
  ? mine
      .map((cmd) => ({ cmd, reason: liveShapedCommandReason(cmd, { cwd: REPO }) }))
      .filter(({ reason }) => reason !== null)
  : [];
if (offline && excluded.length === 0) {
  console.error(
    "--offline refused: the inventory yielded no live-shaped suite to exclude. This mode exists " +
      "because the gate holds live suites; an empty exclusion set means the classifier is broken, " +
      "not that the tree is clean.",
  );
  process.exit(2);
}
const planned = offline ? mine.filter((cmd) => !excluded.some((e) => e.cmd === cmd)) : mine;

// NAME THIS RUN, and hand the name to every suite. `@cotal-ai/seat` stamps it onto each custodian's
// argv, so the sweep after a suite can kill the custodians THIS run started and leave every other
// lane's alone (#1648). Set before the first suite starts, because a suite that launches a seat
// before the marker exists would leave one nothing here can claim.
const RUN_MARKER = process.env.COTAL_RUN ?? `smoke-shard-${shard}-${count}-${process.pid}`;
process.env.COTAL_RUN = RUN_MARKER;

if (offline) {
  console.log(`smoke:ci OFFLINE shard ${shard}/${count} — excluding ${excluded.length} live-shaped suite(s):`);
  for (const { cmd, reason } of excluded) console.log(`  ${cmd} (${reason})`);
  console.log("");
}
console.log(
  `smoke:ci ${offline ? "OFFLINE " : ""}shard ${shard}/${count} — ${planned.length} of ${all.length} smokes:\n  ${planned.join("\n  ")}\n`,
);
console.log(`[seat-reaper] this run is named ${RUN_MARKER}; custodians it leaves behind are reaped by that marker\n`);

// Clear the field BEFORE attributing anything. A developer box accumulates these, and a broker that
// predates this run is not evidence against the suite that happens to run first: reaped, counted,
// and explicitly not blamed on anyone.
const pre = reapSmokeBrokers();
if (pre.supported && pre.reaped.length > 0) {
  console.log(`[reaper] ${pre.reaped.length} leaked smoke broker(s) already running before this shard started; reaped, NOT attributed to any suite here:`);
  for (const { pid, args } of pre.reaped) console.log(`[reaper]   killed pid ${pid}: ${args.slice(0, 120)}`);
}

const isWin = process.platform === "win32";

/** Capture stdout+stderr while still writing them, so the sentinel can be parsed from the suite. */
function runSuite(bin, args) {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { stdio: ["inherit", "pipe", "pipe"], shell: isWin });
    let out = "";
    const take = (buf, write) => {
      const s = typeof buf === "string" ? buf : buf.toString();
      out += s;
      write(s);
    };
    child.stdout?.on("data", (buf) => take(buf, (s) => process.stdout.write(s)));
    child.stderr?.on("data", (buf) => take(buf, (s) => process.stderr.write(s)));
    child.on("error", (err) => {
      resolve({ status: 1, out: `${out}${err}\n` });
    });
    child.on("close", (status, signal) => {
      resolve({ status: status === null ? (signal ? 1 : 1) : status, out });
    });
  });
}

const leaked = [];
const leakedSeats = [];
let failure;
let totalCells = 0;

/** One emit site: later suites that never started stay named the same way for every break reason. */
function failAt(cmd, i, reason, status) {
  console.error(`\n✗ shard ${shard}/${count} FAILED at: ${cmd} (${reason})`);
  const never = neverRanBlock(planned, i);
  if (never) console.error(never);
  failure = status;
}

async function main() {
  for (let i = 0; i < planned.length; i++) {
    const cmd = planned[i];
    const [bin, ...args] = cmd.split(/\s+/);
    console.log(`\n===== ${cmd} =====`);
    // shell:true on Windows so `pnpm` resolves to pnpm.cmd; the tokens are our own fixed script names.
    const r = await runSuite(bin, args);
    // Reap BEFORE deciding what to do about the exit status, so a suite that fails does not also get to
    // abandon its broker for the rest of the run. Anything with the token here is new since the sweep
    // above, so it belongs to the suite that just returned.
    const after = reapSmokeBrokers();
    reportReaped(cmd, after);
    if (after.reaped.length > 0) leaked.push({ cmd, count: after.reaped.length });
    // Same rule for seat custodians: anything still carrying this run's marker outlived the suite
    // that launched it, so it is that suite's leak and it is killed here rather than left to the
    // custodian's own (much longer) unattended timer.
    const seats = reapRunCustodians(RUN_MARKER);
    reportCustodians(cmd, seats);
    if (seats.reaped.length > 0) leakedSeats.push({ cmd, count: seats.reaped.length });
    if (r.status !== 0) {
      failAt(cmd, i, `exit ${r.status}`, r.status || 1);
      break;
    }
    const sentinel = parseSentinel(r.out);
    if (!sentinel) {
      failAt(cmd, i, "no sentinel", 1);
      break;
    }
    if (sentinel.cells === 0) {
      failAt(cmd, i, "zero cells", 1);
      break;
    }
    totalCells += sentinel.cells;
  }

  // A suite that passes its assertions and leaves a broker running is a FALSE GREEN, so it fails the
  // shard. It is reported at the end rather than at the first offender because one full run naming
  // every leaking suite is worth more than a run that stops at the first and hides the rest. A failing
  // suite is reported by its own status first: it already has a reason, and a leak on the way out is a
  // consequence of it, not an independent finding.
  if (failure !== undefined) process.exit(failure);
  if (leakedSeats.length > 0) {
    console.error(`\n✗ shard ${shard}/${count}: ${leakedSeats.length} suite(s) passed but LEAKED a seat custodian:`);
    for (const { cmd, count: n } of leakedSeats) console.error(`    ${cmd} (${n})`);
    console.error(`  A custodian that outlives the suite that launched it holds ~65 MB with no manager left to`);
    console.error(`  answer, and they accumulate across runs. Each was killed; the suite must reap its own.`);
    process.exit(1);
  }
  if (leaked.length > 0) {
    console.error(`\n✗ shard ${shard}/${count}: ${leaked.length} suite(s) passed but LEAKED a broker they owned:`);
    for (const { cmd, count: n } of leaked) console.error(`    ${cmd} (${n})`);
    console.error(`  A green suite that leaves a broker running is a false green. Each of these tore down on`);
    console.error(`  its normal path in review, so this is a real regression in one of them, not reaper noise.`);
    process.exit(1);
  }
  if (offline) {
    console.log(
      `\n✓ smoke:ci OFFLINE shard ${shard}/${count} passed (${planned.length} of ${all.length} smokes, ${totalCells} cells; ` +
        `${excluded.length} live-shaped suite(s) excluded)`,
    );
  } else {
    console.log(`\n✓ smoke:ci shard ${shard}/${count} passed (${mine.length} smokes, ${totalCells} cells)`);
  }
}

await main();
