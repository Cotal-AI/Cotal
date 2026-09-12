/**
 * The freeze suite's committed-list cell must redden by name when BASE and HEAD are absent.
 * A green inventory that adapted to that absence is the defect in #1422.
 *
 * Run: pnpm smoke:ci-suites-freeze-drop
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const CELL = "the committed frozen list added no suite names versus base";

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

const env = { ...process.env };
for (const key of Object.keys(env)) if (key.startsWith("COTAL_")) delete env[key];
delete env.BASE;
delete env.HEAD;

const ran = spawnSync("pnpm", ["smoke:ci-suites-freeze"], {
  cwd: ROOT,
  encoding: "utf8",
  env,
  timeout: 60_000,
  maxBuffer: 2 * 1024 * 1024,
});
const out = `${ran.stdout ?? ""}${ran.stderr ?? ""}`;
const named = out.includes(`FAIL: ${CELL}`);

check(
  "ci-suites-freeze is red when BASE and HEAD are unset",
  ran.status !== 0 && !ran.error,
  ran.error ? String(ran.error) : `status=${ran.status}`,
);
check(
  "the red names the committed frozen-list cell",
  named,
  named ? undefined : out.slice(-800),
);

const EXPECTED = 2;
check(
  `every cell ran - ${EXPECTED} expected, so a cell that stops existing is not mistaken for one that passed`,
  pass + fail === EXPECTED,
  `${pass + fail} cells reported`,
);

console.log(`CI SUITES FREEZE DROP SMOKE ${fail === 0 ? "OK" : "FAILED"} (${pass} passed, ${fail} failed)`);
if (fail) process.exitCode = 1;
