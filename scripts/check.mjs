#!/usr/bin/env node
/**
 * `pnpm check`: run every step, then name each one that failed.
 *
 * The check used to be one `&&` chain. The first red step ended it, and the output named only
 * that step, so a dead `:live` suite near the front hid every step after it and a red run looked
 * the same whether it stopped at step 3 or step 30 (#708). Here a failing step is recorded and
 * the next one still runs, and the closing summary lists every failure.
 *
 * Steps are written `pnpm <script>`, as the chain wrote them, so the step list reads as the
 * commands it runs and the gate inventory still resolves each smoke entry in it. Anything else in
 * the argument list, or a script the root manifest does not define, is refused before any step
 * starts.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const { scripts } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const argv = process.argv.slice(2);
const steps = [];
for (let i = 0; i < argv.length; i += 2) {
  if (argv[i] !== "pnpm" || !argv[i + 1]) {
    console.error(`check: refused: expected "pnpm <script>" pairs, got ${JSON.stringify(argv.slice(i, i + 2))}`);
    process.exit(2);
  }
  steps.push(argv[i + 1]);
}
const unknown = steps.filter((s) => !Object.hasOwn(scripts, s));
if (steps.length === 0 || unknown.length > 0) {
  console.error(`check: refused: ${steps.length === 0 ? "no steps given" : `no root script named ${unknown.join(", ")}`}`);
  process.exit(2);
}

const failed = [];
for (const [i, step] of steps.entries()) {
  console.log(`\ncheck [${i + 1}/${steps.length}] pnpm ${step}`);
  const r = spawnSync("pnpm", [step], { stdio: "inherit", shell: process.platform === "win32" });
  if (r.status !== 0) failed.push(`pnpm ${step} (${r.error ? r.error.message : r.signal ? `signal ${r.signal}` : `exit ${r.status}`})`);
}

if (failed.length === 0) {
  console.log(`\ncheck: all ${steps.length} steps passed`);
} else {
  console.error(`\ncheck: ${failed.length} of ${steps.length} steps failed (every step ran):`);
  for (const f of failed) console.error(`  ${f}`);
  process.exit(1);
}
