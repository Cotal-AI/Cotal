/**
 * `cotal ext seed --help` / `-h` must print the seed maintenance usage and exit 0 WITHOUT running the
 * seed (which writes the ever-seeded stamp + manifest). Seed maintenance is dispatched before the
 * global help intercept, so its help has to be routed explicitly; this proves it exits clean and
 * mutates nothing. Runs the built binary. Run: pnpm smoke:ext-seed-help
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
console.log("ext-seed-help.smoke: all assertions passed");
