/**
 * `cotal ext seed --help` / `-h` must print the seed maintenance usage and exit 0 WITHOUT running the
 * seed (which writes the ever-seeded stamp + manifest). Seed maintenance is dispatched before the
 * global help intercept, so its help has to be routed explicitly; this proves it exits clean and
 * mutates nothing.
 *
 * Also covers the two `ext` discoverability contracts that only break on a FRESH config (an empty
 * XDG_CONFIG_HOME, where the auto-reconcile would otherwise seed and print `✓ added …` first):
 *   - `cotal ext root` prints EXACTLY the prefix path (one line, no seed noise), so `$(cotal ext root)`
 *     stays single-line on first use;
 *   - `cotal ext --help` advertises the `root` subcommand (the `ext list` footer points users at it).
 * Runs the built binary. Run: pnpm smoke:ext-seed-help
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO = join(import.meta.dirname, "..", "..", "..");
const BIN = join(REPO, "bin", "dist", "cotal.js");
assert.ok(existsSync(BIN), `built binary missing at ${BIN} - run \`pnpm --filter cotal-ai... build\` first`);

for (const flag of ["--help", "-h"]) {
  const xdg = mkdtempSync(join(tmpdir(), "cotal-ext-seed-help-"));
  try {
    const r = spawnSync("node", [BIN, "ext", "seed", flag], { encoding: "utf8", env: { ...process.env, XDG_CONFIG_HOME: xdg } });
    const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
    assert.equal(r.status, 0, `\`ext seed ${flag}\` should exit 0, got ${r.status}: ${out}`);
    assert.match(out, /--repair/, `\`ext seed ${flag}\` should render the seed usage: ${out}`);
    assert.match(out, /--reset|--force/, "seed usage lists its maintenance flags");
    assert.equal(existsSync(join(xdg, "cotal", "extensions")), false, `\`ext seed ${flag}\` must not write config`);
    console.log(`  ✓ ext seed ${flag}: exit 0, usage rendered, no config written`);
  } finally {
    rmSync(xdg, { recursive: true, force: true });
  }
}

// `ext root` is a scripting primitive: exactly the prefix path, one line, and NO seed - even on a
// first-run empty config, where the auto-reconcile would otherwise emit `✓ added …` ahead of the path.
{
  const xdg = mkdtempSync(join(tmpdir(), "cotal-ext-root-"));
  try {
    const r = spawnSync("node", [BIN, "ext", "root"], { encoding: "utf8", env: { ...process.env, XDG_CONFIG_HOME: xdg } });
    const expected = join(xdg, "cotal", "extensions");
    assert.equal(r.status, 0, `\`ext root\` should exit 0, got ${r.status}: ${r.stdout}${r.stderr}`);
    assert.equal(r.stdout, `${expected}\n`, `\`ext root\` must print exactly the prefix path with no seed noise, got ${JSON.stringify(r.stdout)}`);
    assert.equal(existsSync(join(xdg, "cotal", "extensions")), false, "`ext root` must not seed or write config");
    console.log("  ✓ ext root: single-line prefix path, no seed, no config written");
  } finally {
    rmSync(xdg, { recursive: true, force: true });
  }
}

// `ext --help` must advertise the `root` subcommand: the `ext list` footer sends users to `ext --help`
// for the full command set, so a stale declaration would contradict the discoverability goal.
{
  const xdg = mkdtempSync(join(tmpdir(), "cotal-ext-help-"));
  try {
    const r = spawnSync("node", [BIN, "ext", "--help"], { encoding: "utf8", env: { ...process.env, XDG_CONFIG_HOME: xdg } });
    const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
    assert.equal(r.status, 0, `\`ext --help\` should exit 0, got ${r.status}: ${out}`);
    assert.match(out, /\broot\b/, `\`ext --help\` must list the \`root\` subcommand: ${out}`);
    assert.equal(existsSync(join(xdg, "cotal", "extensions")), false, "`ext --help` must not write config");
    console.log("  ✓ ext --help: lists root, exit 0, no config written");
  } finally {
    rmSync(xdg, { recursive: true, force: true });
  }
}
console.log("ext-seed-help.smoke: all assertions passed");
