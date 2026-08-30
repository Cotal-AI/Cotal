/**
 * `shard.mjs` breaks at its first red, and the plan it prints at startup does not say which of
 * itself never got a banner. `neverRanBlock` is the computation shard.mjs calls at the break
 * point to say so explicitly - see bin/smoke/shard-never-ran.mjs for why that has to be the
 * shard's own statement rather than something reconstructed later from its two other statements.
 *
 * The helper cells below prove the census text. The shipped-runner cells spawn `bin/smoke/shard.mjs`
 * itself: a mutation that no-ops the emission line must redden those, not only the helper.
 *
 * Run: pnpm smoke:shard-never-ran
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
// @ts-expect-error - plain .mjs helper, imported by bin/smoke/shard.mjs.
import { neverRanBlock } from "./shard-never-ran.mjs";

const SHARD = fileURLToPath(new URL("./shard.mjs", import.meta.url));

/** Drive the shipped shard runner over a four-suite fixture. Never the repo registry. */
function runShippedShard(scripts: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), "cotal-shard-never-ran-"));
  try {
    const names = Object.keys(scripts);
    writeFileSync(join(dir, "package.json"), JSON.stringify({ private: true, scripts }));
    const listPath = join(dir, "ci-suites.txt");
    writeFileSync(listPath, `${names.join("\n")}\n`);
    // The shipped shard runner reads exactly one COTAL_ name, COTAL_CI_SUITES, which is set on top
    // of the copy below. Everything else the ambient environment carries under that prefix is
    // connection material this fixture has no use for.
    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const key of Object.keys(env)) if (key.startsWith("COTAL_")) delete env[key];
    const r = spawnSync(process.execPath, [SHARD, "0", "1"], {
      cwd: dir,
      env: { ...env, COTAL_CI_SUITES: listPath },
      encoding: "utf8",
      timeout: 60_000,
      maxBuffer: 2 * 1024 * 1024,
    });
    const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
    return {
      status: r.status,
      timedOut: (r.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT" || r.signal === "SIGTERM",
      out,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

let pass = 0;
let fail = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ FAIL: ${name}`, extra ?? "");
  }
};

console.log("shard-never-ran: the never-ran census a shard prints at its break point");

const mine = ["pnpm smoke:a", "pnpm smoke:b", "pnpm smoke:c", "pnpm smoke:d", "pnpm smoke:e"];

// ---- Failure mid-partition: everything after it is named, nothing before it is ------------------
const midBlock = neverRanBlock(mine, 1);
check("a mid-partition failure reports a non-empty block", midBlock !== "");
check("the block names the exact count that never ran", /\b3 of 5\b/.test(midBlock), midBlock);
check("every suite after the failure is named", ["smoke:c", "smoke:d", "smoke:e"].every((s) => midBlock.includes(s)), midBlock);
check("the failed suite itself is not named as never-ran", !midBlock.includes("smoke:b"), midBlock);
check("a suite before the failure is not named as never-ran", !midBlock.includes("smoke:a"), midBlock);
check(
  "the never-ran suites stay in their original execution order",
  midBlock.indexOf("smoke:c") < midBlock.indexOf("smoke:d") && midBlock.indexOf("smoke:d") < midBlock.indexOf("smoke:e"),
  midBlock,
);

// ---- Failure on the partition's LAST entry: nothing was left, so there is nothing to say --------
const lastBlock = neverRanBlock(mine, mine.length - 1);
check("a failure on the last entry of the partition reports nothing (there is nothing behind it)", lastBlock === "", lastBlock);

// ---- Failure on the FIRST entry: everything else in the partition never ran ----------------------
const firstBlock = neverRanBlock(mine, 0);
check(
  "a failure on the first entry reports every other suite in the partition as never-ran",
  /\b4 of 5\b/.test(firstBlock) && ["smoke:b", "smoke:c", "smoke:d", "smoke:e"].every((s) => firstBlock.includes(s)),
  firstBlock,
);

// ---- A partition of one: a failure there has nothing after it, same as the last-entry case -------
check("a single-suite partition's only failure reports nothing", neverRanBlock(["pnpm smoke:solo"], 0) === "");

// Predicted kill set for no-oping `if (never) console.error(never);` in shard.mjs:
//   red: "a mid-partition break through shard.mjs reports NEVER RAN — 2 of 4"
//   red: "the shipped never-ran block names only the two suites that never started"
//   still green: helper isolation cells, and "a fully green shard reports nothing as never-ran"
const green = runShippedShard({
  "smoke:a": "node -e \"process.exit(0)\"",
  "smoke:b": "node -e \"process.exit(0)\"",
  "smoke:c": "node -e \"process.exit(0)\"",
  "smoke:d": "node -e \"process.exit(0)\"",
});
check("the green fixture planned exactly 4 suites and did not time out", !green.timedOut && /shard 0\/1 — 4 of 4 smokes/.test(green.out), green.out.slice(0, 400));
check(
  "a fully green shard reports nothing as never-ran",
  !green.timedOut && green.status === 0 && !/NEVER RAN/.test(green.out),
  green.out.slice(-400),
);
check(
  "a fully green shard started every planned suite",
  !green.timedOut && ["smoke:a", "smoke:b", "smoke:c", "smoke:d"].every((s) => green.out.includes(`===== pnpm ${s} =====`)),
  green.out,
);

const broken = runShippedShard({
  "smoke:a": "node -e \"process.exit(0)\"",
  "smoke:b": "node -e \"process.exit(7)\"",
  "smoke:c": "node -e \"process.exit(0)\"",
  "smoke:d": "node -e \"process.exit(0)\"",
});
const banners = (broken.out.match(/^===== pnpm smoke:/gm) ?? []).length;
check("the broken fixture planned exactly 4 suites and did not time out", !broken.timedOut && /shard 0\/1 — 4 of 4 smokes/.test(broken.out), broken.out.slice(0, 400));
check("a mid-partition break through shard.mjs exits 7", !broken.timedOut && broken.status === 7, { status: broken.status, timedOut: broken.timedOut });
check("a mid-partition break through shard.mjs started exactly 2 suites", banners === 2, banners);
check(
  "a mid-partition break through shard.mjs reports NEVER RAN — 2 of 4",
  /NEVER RAN — 2 of 4/.test(broken.out),
  broken.out.slice(-500),
);
check(
  "the shipped never-ran block names only the two suites that never started",
  /NEVER RAN — 2 of 4/.test(broken.out) &&
    broken.out.includes("pnpm smoke:c") &&
    broken.out.includes("pnpm smoke:d") &&
    !/NEVER RAN[\s\S]*pnpm smoke:a/.test(broken.out) &&
    !/NEVER RAN[\s\S]*pnpm smoke:b/.test(broken.out),
  broken.out.slice(-500),
);

const EXPECTED = 17;
check(
  `every cell ran - ${EXPECTED} expected, so a cell that stops existing is not mistaken for one that passed`,
  pass + fail === EXPECTED,
  `${pass + fail} cells reported`,
);

console.log(`SUITE COMPLETE: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
