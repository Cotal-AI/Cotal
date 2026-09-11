/**
 * Issue #1482: workflow-shape control for the scheduled full mutation sweep.
 *
 * The checks are anchored on parsed job ids and exercise the aggregate gate's real shell. A matrix
 * failure or cancellation must therefore make the named aggregate red rather than only looking right
 * in YAML comments.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const childEnv = (): NodeJS.ProcessEnv => {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("COTAL_")) delete env[key];
  return env;
};
const workflow = parse(readFileSync(join(ROOT, ".github/workflows/mutation-reproof.yml"), "utf8"));
const jobs = workflow?.jobs ?? {};
const shardJob = jobs.full_shard;
const aggregate = jobs.full;
const alarm = jobs["full-alarm"];
const shards = Array.from({ length: 12 }, (_, index) => index);
let passed = 0;
let failed = 0;

function check(name: string, ok: unknown, detail = ""): void {
  if (ok) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ FAIL: ${name}${detail ? `\n      ${detail}` : ""}`); }
}

const reproof = shardJob?.steps?.find((step: { name?: string }) =>
  step.name === "Re-prove every mutation fixture assigned to this shard");
const report = shardJob?.steps?.find((step: { name?: string }) => step.name === "Report elapsed");
check("full_shard is a 12-way fail-fast-disabled Tenki matrix",
  shardJob?.["runs-on"] === "tenki-standard-medium-4c-8g"
    && shardJob?.["timeout-minutes"] === 240
    && shardJob?.strategy?.["fail-fast"] === false
    && JSON.stringify(shardJob?.strategy?.matrix?.shard) === JSON.stringify(shards));
check("every full shard uses the runner's --all --shard support with a 225-minute step ceiling",
  reproof?.["timeout-minutes"] === 225
    && typeof reproof?.run === "string"
    && reproof.run.includes('node scripts/mutation-reproof.mjs --all --shard "${{ matrix.shard }}/12"'));
check("every full shard preserves time for an always-running elapsed report",
  report?.if === "always()" && typeof report?.run === "string"
    && report.run.includes("step budget 225m; job budget 240m"));
check("full is the named always-running aggregate gate over full_shard",
  aggregate?.name === "full sweep aggregate"
    && aggregate?.if === "(github.event_name == 'schedule' || github.event_name == 'workflow_dispatch') && always()"
    && JSON.stringify(aggregate?.needs) === JSON.stringify(["full_shard"])
    && aggregate?.["continue-on-error"] !== true);

const previousSentinel = process.env.COTAL_REPROOF_SENTINEL;
process.env.COTAL_REPROOF_SENTINEL = "synthetic-session-secret";
const gate = aggregate?.steps?.find((step: { name?: string }) => step.name === "Gate");
let aggregateEnvClean = true;
for (const [result, accepts] of [["success", true], ["failure", false], ["cancelled", false], ["skipped", false]] as const) {
  const command = typeof gate?.run === "string"
    ? `if [ "\${COTAL_REPROOF_SENTINEL+x}" ]; then echo SESSION_LEAK; fi\n${gate.run}`
    : undefined;
  const run = command ? spawnSync("bash", ["-c", command], {
    encoding: "utf8",
    env: { ...childEnv(), SHARD_RESULT: result },
  }) : undefined;
  aggregateEnvClean &&= run !== undefined && !`${run.stdout ?? ""}${run.stderr ?? ""}`.includes("SESSION_LEAK");
  check(`the full aggregate ${accepts ? "accepts" : "rejects"} matrix=${result}`,
    gate?.env?.SHARD_RESULT === "${{ needs.full_shard.result }}"
      && run?.status !== null && run?.status !== undefined
      && (accepts ? run.status === 0 : run.status !== 0),
    `status=${run?.status ?? "not run"}`);
}
check("aggregate probes do not inherit Cotal session credentials", aggregateEnvClean);
if (previousSentinel === undefined) delete process.env.COTAL_REPROOF_SENTINEL;
else process.env.COTAL_REPROOF_SENTINEL = previousSentinel;
check("full-alarm remains pointed at the full aggregate gate",
  alarm?.needs === "full"
    && alarm?.if === "always() && (needs.full.result == 'failure' || needs.full.result == 'cancelled')"
    && alarm?.steps?.some((step: { env?: { SWEEP_RESULT?: string } }) =>
      step.env?.SWEEP_RESULT === "${{ needs.full.result }}"));

console.log(`\nmutation full workflow: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
