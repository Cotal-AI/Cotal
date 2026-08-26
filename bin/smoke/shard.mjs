/**
 * Run a round-robin SHARD of the `smoke:ci` chain, so CI can fan the (serial) protocol/security
 * suite across N parallel runners without dropping or duplicating a single smoke.
 *
 *   node bin/smoke/shard.mjs <shardIndex> <shardCount>
 *
 * The list is read from `bin/smoke/ci-suites.txt` — the ONE source of truth, so a smoke added there
 * is automatically distributed (no shard membership to hand-maintain). Round-robin
 * (index % count) interleaves the list, which balances runtime better than contiguous slices.
 * Each smoke runs in its own `pnpm` subprocess (separate broker/ports) exactly as the serial chain
 * does; the shards run on SEPARATE runners, so there is no cross-smoke port contention within a shard.
 */
import { spawnSync } from "node:child_process";
import { readCiSuites } from "./ci-suites.mjs";
import { reapSmokeBrokers, reportReaped } from "./reap-smoke-brokers.mjs";

const shard = Number(process.argv[2]);
const count = Number(process.argv[3]);
if (!Number.isInteger(shard) || !Number.isInteger(count) || count < 1 || shard < 0 || shard >= count) {
  console.error(`usage: node bin/smoke/shard.mjs <shardIndex 0..N-1> <shardCount N>  (got: ${process.argv[2]} ${process.argv[3]})`);
  process.exit(2);
}

// An EMPTY chain is an error, not a fast green: a runner that finds no suites and exits 0 reports
// the same thing as a runner that passed all of them.
const all = readCiSuites().map((s) => `pnpm ${s}`);
if (all.length === 0) { console.error(`no suites in bin/smoke/ci-suites.txt`); process.exit(2); }
const mine = all.filter((_, i) => i % count === shard);

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
for (const cmd of mine) {
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
