/**
 * shard.mjs has THREE statuses, and a skipped member is not a passed member.
 *
 * The defect this guards: `bin/smoke/shard.mjs` used to branch only on zero/nonzero, so a suite that
 * exited 0 having executed ZERO cells was counted as a passed member and the shard printed green
 * over it. Absence of evidence rendered as success — the same shape as the delivery incident, and
 * sitting in the tool that decides whether the gate ran at all. Every lane quoting a shard result as
 * evidence inherits this, so if skip reads as pass here, every green above it is weaker than it looks.
 *
 * WHY THE CELLS BELOW ARE SHAPED THE WAY THEY ARE. A cell asserting "the run completed" is true
 * whether or not anything was skipped, so it is not a control. Every cell here is FALSE IN THE
 * UNSAFE STATE: if DECLINED collapsed back into pass, the declining arms would report rc 0, print
 * "passed", and claim 3 of 3 measured — so the rc, the absent-"passed", and the measured/declined
 * counts each independently go red. The reconciliation cells catch a different failure: a member
 * that dies before its cells is indistinguishable from one that declined if you read only exit
 * codes, so declared === measured + declined is CHECKED, not assumed.
 *
 * The real, unmodified shard.mjs is driven end to end. Only `pnpm` is stood in for, by a shim, so
 * no real suite runs and no broker is touched: this smoke is about the RUNNER's arithmetic.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, chmodSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

let pass = 0, fail = 0;
const check = (name: string, cond: boolean): void => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ FAIL: ${name}`); }
};

/** Declared up front so a run that dies before its cells cannot look like a run that caught nothing.
 *  Asserted against the actual executed count at the end; exit code alone would not tell them apart. */
const CELLS_DECLARED = 27;

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const shardJs = join(repoRoot, "bin", "smoke", "shard.mjs");

// This smoke spawns nothing but a shim; assert that, rather than leave it to the reader.
const LIVE = "broker.cotal.ai";
console.log(`\nshard-status — no broker, no network; only ${shardJs} and a pnpm shim (not ${LIVE})\n`);

const dir = mkdtempSync(join(tmpdir(), "cotal-shard-status-"));
const shimDir = join(dir, "shim");
const planPath = join(dir, "plan.json");

/** A `pnpm` that exits with whatever the plan says for that script name, printing a marker so the
 *  member's own output is distinguishable from the runner's summary in the captured stream. */
const shim = `#!/bin/sh
script=""
for a in "$@"; do script="$a"; done
rc=$(node -e '
  const p = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  process.stdout.write(String(p[process.argv[2]] ?? 0));
' "${planPath}" "$script")
echo "MEMBER-RAN $script -> rc=$rc"
exit "$rc"
`;

const SHARD = 0, COUNT = 74; // round-robin i % 74 === 0 selects exactly 3 members

mkdirSync(shimDir, { recursive: true });
writeFileSync(join(shimDir, "pnpm"), shim);
chmodSync(join(shimDir, "pnpm"), 0o755);

// --- derive this shard's members exactly as shard.mjs does ------------------------------------
const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
const all = String(pkg.scripts["smoke:ci"]).split("&&").map((s) => s.trim()).filter(Boolean);
const members = all.filter((_, i) => i % COUNT === SHARD);

const scriptName = (cmd: string): string => cmd.split(/\s+/).pop() as string;

type Arm = { out: string; rc: number };
const runShard = (plan: Record<string, number>): Arm => {
  writeFileSync(planPath, JSON.stringify(plan));
  const r = spawnSync(process.execPath, [shardJs, String(SHARD), String(COUNT)], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${shimDir}:${process.env.PATH}` },
  });
  return { out: `${r.stdout}${r.stderr}`, rc: r.status ?? -1 };
};

/** Read the runner's own arithmetic back out of its summary, so the counts are ASSERTED, not eyeballed. */
const counts = (out: string): { measured: number; declined: number; declared: number } | null => {
  const inc = out.match(/INCOMPLETE — (\d+) of (\d+) measured, (\d+) DECLINED/);
  if (inc) return { measured: +inc[1], declared: +inc[2], declined: +inc[3] };
  const ok = out.match(/passed \((\d+) of (\d+) smokes measured\)/);
  if (ok) return { measured: +ok[1], declared: +ok[2], declined: 0 };
  return null;
};

try {
  console.log(`shard ${SHARD}/${COUNT} selects ${members.length} members:`);
  for (const m of members) console.log(`    ${m}`);
  check("rig: the shard selects exactly 3 members to reason about", members.length === 3);

  // ---- ARM 1: every member measures something -> a real pass -------------------------------
  console.log("\nARM 1 — all members pass");
  const a1 = runShard({});
  check("A1.1 rc is 0", a1.rc === 0);
  check("A1.2 summary says passed", /✓ smoke:ci shard 0\/74 passed/.test(a1.out));
  check("A1.3 no member reported DECLINED", !a1.out.includes("DECLINED"));
  const c1 = counts(a1.out);
  check("A1.4 summary exposes counts at all", c1 !== null);
  check("A1.5 measured === declared (3 of 3)", c1?.measured === 3 && c1?.declared === 3);
  check("A1.6 RECONCILES: declared === measured + declined",
    !!c1 && c1.declared === c1.measured + c1.declined);
  check("A1.7 all 3 members actually ran (not skipped by the rig)",
    (a1.out.match(/MEMBER-RAN/g) ?? []).length === 3);

  // ---- ARM 2: ONE member declines -> not a pass, and not a failure -------------------------
  // Every cell here is FALSE if DECLINED collapses into pass.
  console.log("\nARM 2 — one member DECLINES (the defect's exact shape)");
  const declining = scriptName(members[1]);
  const a2 = runShard({ [declining]: 3 });
  check("A2.1 rc is 3 (DECLINED), distinct from both 0 and 1", a2.rc === 3);
  check("A2.2 the word 'passed' does NOT appear", !a2.out.includes("passed"));
  check("A2.3 summary says INCOMPLETE", a2.out.includes("INCOMPLETE"));
  // Deliberately anchored to the SUMMARY list (four-space indent under INCOMPLETE), not to the
  // per-member `⊘ DECLINED …` echo. M-WD1 proved the looser form was not a control: the collapse
  // mutant left the per-member echo in place, so a regex matching either one stayed green while
  // the shard reported "passed". A cell has to be false in the unsafe state or it is decoration.
  check("A2.4 the declining member is NAMED in the summary list",
    a2.out.includes(`\n    ⊘ ${members[1]}`));
  check("A2.5 output states it is not a pass", a2.out.includes("This is NOT a pass"));
  const c2 = counts(a2.out);
  check("A2.6 measured is 2, NOT 3", c2?.measured === 2);
  check("A2.7 declined is 1, NOT 0", c2?.declined === 1);
  check("A2.8 declared is still 3", c2?.declared === 3);
  check("A2.9 RECONCILES: declared === measured + declined",
    !!c2 && c2.declared === c2.measured + c2.declined);
  check("A2.10 all 3 members were still invoked", (a2.out.match(/MEMBER-RAN/g) ?? []).length === 3);

  // ---- ARM 3: EVERY member declines -> a shard that measured nothing -----------------------
  // The headline case: a shard that ran nothing must not report what a clean shard reports.
  console.log("\nARM 3 — every member declines (a shard that measured NOTHING)");
  const a3 = runShard(Object.fromEntries(members.map((m) => [scriptName(m), 3])));
  check("A3.1 rc is 3, not 0", a3.rc === 3);
  check("A3.2 the word 'passed' does NOT appear", !a3.out.includes("passed"));
  check("A3.3 measured is 0", counts(a3.out)?.measured === 0);
  check("A3.4 declined is 3", counts(a3.out)?.declined === 3);
  const c3 = counts(a3.out);
  check("A3.5 RECONCILES: 3 === 0 + 3", !!c3 && c3.declared === c3.measured + c3.declined);

  // ---- ARM 4: a real failure must STILL fail, and must not be confused with a decline -------
  console.log("\nARM 4 — a real failure is unchanged by the third status");
  const failing = scriptName(members[2]);
  const a4 = runShard({ [failing]: 1 });
  check("A4.1 rc is 1, distinct from 3", a4.rc === 1);
  check("A4.2 summary says FAILED at that member", a4.out.includes(`FAILED at: ${members[2]}`));
  check("A4.3 the word 'passed' does NOT appear", !a4.out.includes("passed"));
  check("A4.4 a failure is NOT reported as a decline", !a4.out.includes("INCOMPLETE"));
} finally {
  rmSync(dir, { recursive: true, force: true });
}

// A run that dies before its cells is indistinguishable from a clean catch by exit code alone.
// Reconcile what was declared against what actually executed.
const executed = pass + fail;
console.log(`\ncells: declared ${CELLS_DECLARED}, executed ${executed}, pass ${pass}, fail ${fail}`);
if (executed !== CELLS_DECLARED) {
  console.log(`  ✗ FAIL: cell accounting — declared ${CELLS_DECLARED} cells but executed ${executed}`);
  fail++;
}

console.log(`\nshard-status: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
