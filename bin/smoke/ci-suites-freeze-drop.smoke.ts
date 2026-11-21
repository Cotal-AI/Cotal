/**
 * The freeze suite's committed-list cell must redden by name when BASE and HEAD are absent.
 * A green inventory that adapted to that absence is the defect in #1422.
 *
 * Run: pnpm smoke:ci-suites-freeze-drop
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createSuite } from "@cotal-ai/smoke-kit";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const CELL = "the committed frozen list added no suite names versus base";

const { check, finish, passed, failed } = createSuite();

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
  passed() + failed() === EXPECTED,
  `${passed() + failed()} cells reported`,
);

console.log(`CI SUITES FREEZE DROP SMOKE ${failed() === 0 ? "OK" : "FAILED"} (${passed()} passed, ${failed()} failed)`);
finish();
