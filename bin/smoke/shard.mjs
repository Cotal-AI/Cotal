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

const isWin = process.platform === "win32";
for (const cmd of mine) {
  const [bin, ...args] = cmd.split(/\s+/);
  console.log(`\n===== ${cmd} =====`);
  // shell:true on Windows so `pnpm` resolves to pnpm.cmd; the tokens are our own fixed script names.
  const r = spawnSync(bin, args, { stdio: "inherit", shell: isWin });
  if (r.status !== 0) {
    console.error(`\n✗ shard ${shard}/${count} FAILED at: ${cmd} (exit ${r.status})`);
    process.exit(r.status || 1);
  }
}
console.log(`\n✓ smoke:ci shard ${shard}/${count} passed (${mine.length} smokes)`);
