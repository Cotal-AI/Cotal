/**
 * `cotal ext seed` prints scoped help for both help requests and usage errors, before reading or
 * repairing the extension store.
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
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO = join(import.meta.dirname, "..", "..", "..");
const BIN = join(REPO, "bin", "dist", "cotal.js");
assert.ok(existsSync(BIN), `built binary missing at ${BIN} - run \`pnpm --filter cotal-ai... build\` first`);

{
  const home = mkdtempSync(join(tmpdir(), "cotal-ext-seed-help-"));
  const xdg = join(home, "config");
  const config = join(xdg, "cotal");
  const journal = join(config, ".extensions-promotion.json");
  try {
    mkdirSync(config, { recursive: true, mode: 0o700 });
    writeFileSync(journal, "{}\n", { mode: 0o600 });
    const run = (args: string[]) => spawnSync(process.execPath, [BIN, ...args], {
      cwd: home,
      encoding: "utf8",
      timeout: 30_000,
      env: {
        HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: xdg, COTAL_HOME: join(home, "state"),
        PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TMPDIR: tmpdir(),
        LANG: "C.UTF-8", LC_ALL: "C.UTF-8", NO_COLOR: "1", COTAL_NO_UPDATE_CHECK: "1",
      },
    });
    const help = run(["ext", "seed", "--help"]);
    assert.equal(help.status, 0, help.stderr);
    assert.equal(help.stderr, "");
    assert.match(help.stdout, /^cotal ext seed$/m);
    for (const flag of ["--repair", "--reset", "--force"]) assert.ok(help.stdout.includes(flag));
    const shortHelp = run(["x", "seed", "-h"]);
    assert.equal(shortHelp.status, 0, shortHelp.stderr);
    assert.equal(shortHelp.stderr, "");
    assert.equal(shortHelp.stdout, help.stdout);

    for (const [args, reason] of [
      [["ext", "seed", "--not-an-option"], /Unknown option '--not-an-option'$/],
      [["ext", "--reapir", "seed"], /Unknown option '--reapir' - did you mean --repair\?/],
      [["ext", "seed", "--missing.flag"], /Unknown option '--missing\.flag'/],
      [["ext", "seed", "--jsno"], /Unknown option '--jsno'$/],
      [["ext", "seed", "--repair", "--repair"], /Option '--repair' cannot be repeated/],
      [["ext", "seed", "--repair=unexpected"], /Option '--repair' does not take an argument/],
      [["ext", "seed", "connector"], /does not take positional arguments/],
      [["ext", "seed", "--", "-h"], /does not take positional arguments/],
      [["x", "seed", "--json"], /--json and --plain are taken by the listing only/],
      [["--no-input", "x", "seed", "--no-input"], /Option '--no-input' cannot be repeated/],
    ] as const) {
      const r = run([...args]);
      assert.equal(r.status, 1, `${args.join(" ")}: ${r.stderr}`);
      assert.equal(r.stdout, "");
      const endOfReason = r.stderr.indexOf("\n");
      assert.match(r.stderr.slice(0, endOfReason), reason);
      assert.equal(r.stderr.slice(endOfReason + 1), help.stdout);
    }
    const plain = run(["ext", "seed", "--plain"]);
    assert.equal(plain.status, 1);
    assert.equal(plain.stdout, "");
    assert.match(plain.stderr, /--json and --plain are taken by the listing only/);
    assert.ok(plain.stderr.endsWith(help.stdout));

    const valid = run(["x", "--repair", "seed"]);
    assert.equal(valid.status, 1);
    assert.equal(valid.stdout, "");
    assert.match(valid.stderr, /invalid extension promotion journal/);
    assert.deepEqual(readdirSync(home), ["config"]);
    assert.deepEqual(readdirSync(config), [".extensions-promotion.json"]);
    assert.equal(readFileSync(journal, "utf8"), "{}\n");
    console.log("  ✓ ext seed: scoped help and refusals leave promotion state untouched");
  } finally {
    rmSync(home, { recursive: true, force: true });
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
