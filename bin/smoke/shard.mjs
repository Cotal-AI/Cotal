/**
 * Run a round-robin SHARD of the `smoke:ci` chain, so CI can fan the (serial) protocol/security
 * suite across N parallel runners without dropping or duplicating a single smoke.
 *
 *   node bin/smoke/shard.mjs <shardIndex> <shardCount>
 *
 * The list is derived from the `smoke:ci` script in package.json — the ONE source of truth, so a
 * smoke added there is automatically distributed (no shard membership to hand-maintain). Round-robin
 * (index % count) interleaves the list, which balances runtime better than contiguous slices.
 * Each smoke runs in its own `pnpm` subprocess (separate broker/ports) exactly as the serial chain
 * does; the shards run on SEPARATE runners, so there is no cross-smoke port contention within a shard.
 */
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const shard = Number(process.argv[2]);
const count = Number(process.argv[3]);
if (!Number.isInteger(shard) || !Number.isInteger(count) || count < 1 || shard < 0 || shard >= count) {
  console.error(`usage: node bin/smoke/shard.mjs <shardIndex 0..N-1> <shardCount N>  (got: ${process.argv[2]} ${process.argv[3]})`);
  process.exit(2);
}

const pkg = JSON.parse(readFileSync(fileURLToPath(new URL("../../package.json", import.meta.url)), "utf8"));
const chain = pkg.scripts?.["smoke:ci"];
if (!chain) { console.error("no `smoke:ci` script in package.json"); process.exit(2); }

// "pnpm a && pnpm b && …" → ["pnpm a", "pnpm b", …]
const all = chain.split("&&").map((s) => s.trim()).filter(Boolean);
const mine = all.filter((_, i) => i % count === shard);

console.log(`smoke:ci shard ${shard}/${count} — ${mine.length} of ${all.length} smokes:\n  ${mine.join("\n  ")}\n`);

/**
 * THREE statuses, not two. A member that ran but measured NOTHING — a suite that declined because
 * its preconditions are unavailable on this platform — is neither a pass nor a failure, and this
 * runner used to have no way to say so: it branched only on zero/nonzero, so a suite that exited 0
 * having executed zero cells was counted as a passed member and the shard printed green over it.
 *
 * That is absence of evidence rendered as success, which is the exact defect class the delivery
 * incident was: messages accepted, senders told they were sent, zero log entries. A skipped member
 * and a passing member being indistinguishable in the outcome means a shard that ran nothing
 * reports what a shard that ran everything reports — AN ABSENCE LOOKS LIKE A CLEAN BOARD.
 *
 * A member signals it by exiting DECLINED. It is carried separately, named in the output, and
 * reconciled: declared === measured + declined, checked rather than assumed, because a member that
 * dies before its cells is indistinguishable from one that declined if you read only exit codes.
 * A declined member can never be summarised as passed.
 */
const DECLINED = 3;

const isWin = process.platform === "win32";
const declared = mine.length;
let measured = 0;
const declined = [];

for (const cmd of mine) {
  const [bin, ...args] = cmd.split(/\s+/);
  console.log(`\n===== ${cmd} =====`);
  // shell:true on Windows so `pnpm` resolves to pnpm.cmd; the tokens are our own fixed script names.
  const r = spawnSync(bin, args, { stdio: "inherit", shell: isWin });
  if (r.status === DECLINED) {
    console.log(`\n⊘ DECLINED (nothing measured): ${cmd}`);
    declined.push(cmd);
    continue;
  }
  if (r.status !== 0) {
    console.error(`\n✗ shard ${shard}/${count} FAILED at: ${cmd} (exit ${r.status})`);
    process.exit(r.status || 1);
  }
  measured++;
}

// Reconcile rather than trust. Every declared member must have been accounted for exactly once; if
// this does not balance, the run lost track of a member and NO verdict it prints can be believed.
if (measured + declined.length !== declared) {
  console.error(
    `\n✗ shard ${shard}/${count} ACCOUNTING FAILURE: declared ${declared}, ` +
      `measured ${measured}, declined ${declined.length} — these do not reconcile.`,
  );
  process.exit(1);
}

if (declined.length > 0) {
  // Deliberately never the word "passed", and deliberately not exit 0. A reader skimming for green
  // and a script reading $? must BOTH be able to tell this from a clean run.
  console.log(
    `\n⊘ smoke:ci shard ${shard}/${count} INCOMPLETE — ` +
      `${measured} of ${declared} measured, ${declined.length} DECLINED (nothing measured):`,
  );
  for (const cmd of declined) console.log(`    ⊘ ${cmd}`);
  console.log(`  This is NOT a pass. Nothing was measured for the members above.`);
  process.exit(DECLINED);
}

console.log(`\n✓ smoke:ci shard ${shard}/${count} passed (${measured} of ${declared} smokes measured)`);
