/**
 * Run a round-robin SHARD of the `smoke:ci` chain, so CI can fan the (serial) protocol/security
 * suite across N parallel runners without dropping or duplicating a single smoke.
 *
 *   node bin/smoke/shard.mjs <shardIndex> <shardCount>
 *
 * The frozen legacy list is read from `bin/smoke/ci-suites.txt`; new suites are one-file fragments
 * under `bin/smoke/ci-suites.d/`. Legacy entries keep round-robin `index % count`. Fragment entries
 * use a stable hash of their suite name, so an independently-merged fragment cannot move another.
 * Each smoke runs in its own `pnpm` subprocess (separate broker/ports) exactly as the serial chain
 * does; the shards run on SEPARATE runners, so there is no cross-smoke port contention within a shard.
 */
import { spawnSync } from "node:child_process";
import { parseCiSuites, readCiSuiteFragments, suitesForShard, CI_SUITES_PATH } from "./ci-suites.mjs";
import { readFileSync } from "node:fs";
import { reapSmokeBrokers, reportReaped } from "./reap-smoke-brokers.mjs";
import { neverRanBlock } from "./shard-never-ran.mjs";

const shard = Number(process.argv[2]);
const count = Number(process.argv[3]);
if (!Number.isInteger(shard) || !Number.isInteger(count) || count < 1 || shard < 0 || shard >= count) {
  console.error(`usage: node bin/smoke/shard.mjs <shardIndex 0..N-1> <shardCount N>  (got: ${process.argv[2]} ${process.argv[3]})`);
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

console.log(`smoke:ci shard ${shard}/${count} — ${mine.length} of ${all.length} smokes:\n  ${mine.join("\n  ")}\n`);

// Clear the field BEFORE attributing anything. A developer box accumulates these, and a broker that
// predates this run is not evidence against the suite that happens to run first: reaped, counted,
// and explicitly not blamed on anyone.
const pre = reapSmokeBrokers();
if (pre.supported && pre.reaped.length > 0) {
  console.log(`[reaper] ${pre.reaped.length} leaked smoke broker(s) already running before this shard started; reaped, NOT attributed to any suite here:`);
  for (const { pid, args } of pre.reaped) console.log(`[reaper]   killed pid ${pid}: ${args.slice(0, 120)}`);
}

const isWin = process.platform === "win32";
const leaked = [];
let failure;
for (let i = 0; i < mine.length; i++) {
  const cmd = mine[i];
  const [bin, ...args] = cmd.split(/\s+/);
  console.log(`\n===== ${cmd} =====`);
  // shell:true on Windows so `pnpm` resolves to pnpm.cmd; the tokens are our own fixed script names.
  const r = spawnSync(bin, args, { stdio: "inherit", shell: isWin });
  // Reap BEFORE deciding what to do about the exit status, so a suite that fails does not also get to
  // abandon its broker for the rest of the run. Anything with the token here is new since the sweep
  // above, so it belongs to the suite that just returned.
  const after = reapSmokeBrokers();
  reportReaped(cmd, after);
  if (after.reaped.length > 0) leaked.push({ cmd, count: after.reaped.length });
  if (r.status !== 0) {
    console.error(`\n✗ shard ${shard}/${count} FAILED at: ${cmd} (exit ${r.status})`);
    const never = neverRanBlock(mine, i);
    if (never) console.error(never);
    failure = r.status || 1;
    break;
  }
}

// A suite that passes its assertions and leaves a broker running is a FALSE GREEN, so it fails the
// shard. It is reported at the end rather than at the first offender because one full run naming
// every leaking suite is worth more than a run that stops at the first and hides the rest. A failing
// suite is reported by its own status first: it already has a reason, and a leak on the way out is a
// consequence of it, not an independent finding.
if (failure !== undefined) process.exit(failure);
if (leaked.length > 0) {
  console.error(`\n✗ shard ${shard}/${count}: ${leaked.length} suite(s) passed but LEAKED a broker they owned:`);
  for (const { cmd, count: n } of leaked) console.error(`    ${cmd} (${n})`);
  console.error(`  A green suite that leaves a broker running is a false green. Each of these tore down on`);
  console.error(`  its normal path in review, so this is a real regression in one of them, not reaper noise.`);
  process.exit(1);
}
console.log(`\n✓ smoke:ci shard ${shard}/${count} passed (${mine.length} smokes)`);
