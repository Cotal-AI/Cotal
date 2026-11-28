/**
 * The command mod's cells (`mod-tests/commands.test.ts`) through the real `claude plugin test`, which
 * loads the plugin's hooks module as Claude Code does and needs no session, sign-in or network.
 *
 * Claude runs on a scratch config directory with the operator's CLAUDE_* and ANTHROPIC_* variables
 * removed, so no setting of theirs reaches the run. Fails unless every expected cell ran and passed.
 * Needs `claude` on PATH.
 * Run: pnpm smoke:claude-command-mod
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { emitSentinel } from "@cotal-ai/smoke-kit";

const EXPECTED_CELLS = 68;
const plugin = resolve(import.meta.dirname, "..");
const config = mkdtempSync(join(tmpdir(), "cotal-command-mod-"));
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
  !key.startsWith("CLAUDE") && !key.startsWith("ANTHROPIC_")));

// A mod that never answers runs every cell to the kit's 5 s limit, so leave room for all of them.
const run = spawnSync("claude", ["plugin", "test", plugin], {
  encoding: "utf8", env: { ...env, CLAUDE_CONFIG_DIR: config }, timeout: 900_000,
});
rmSync(config, { recursive: true, force: true });
if (run.error) throw new Error(`\`claude plugin test\` did not run: ${run.error.message}`);
// Without its timings a cell's line reads the same on every run, so a red one stands out from green.
const output = `${run.stdout}${run.stderr}`.replace(/ \[\d+(?:\.\d+)?m?s\]$/gm, "");
process.stdout.write(output);

const tally = (word: string) => Number(output.match(new RegExp(`^\\s*(\\d+) ${word}$`, "m"))?.[1] ?? 0);
const passed = tally("pass");
const failed = tally("fail");
const problems = [
  ...(run.status === 0 ? [] : [`claude plugin test exited ${run.status ?? run.signal}`]),
  ...(passed + failed === EXPECTED_CELLS ? [] : [`ran ${passed + failed} cells, expected ${EXPECTED_CELLS}`]),
];
for (const problem of problems) console.log(`  ✗ FAIL: ${problem}`);
emitSentinel({ passed, failed });
if (problems.length) process.exitCode = 1;
