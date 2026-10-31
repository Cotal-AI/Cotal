/** Grade actual suite output, not pnpm's pre-run dependency-policy banner.
 * Run: pnpm smoke:shard-launcher:live (registry access; no broker or model).
 * The shipped shard reaps orphaned smoke processes. Run it only in an isolated CI/PID namespace. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runPool } from "./shard-pool.mjs";
import { emitSentinel, parseSentinel, skipSuite } from "./sentinel.mjs";

if (process.platform !== "linux") skipSuite("native pooled runner requires Linux process-group cleanup");
const fixture = fileURLToPath(new URL("./fixtures/pnpm-policy/", import.meta.url));
const shard = fileURLToPath(new URL("./shard.mjs", import.meta.url));
const packageManager = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")).packageManager;
const root = mkdtempSync(join(tmpdir(), "cotal-launcher-sentinel-"));
const originalCwd = process.cwd();
// Restoration-only entries, never a child environment.
const originalEnv = new Map(Object.entries(process.env));
const corepackHome = process.env.COREPACK_HOME ?? join(process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "node/corepack");
let passed = 0, failed = 0;
function check(name, condition) {
  if (condition) passed++; else failed++;
  console.log(`${condition ? "PASS" : "FAIL"} ${name}`);
}
function prepare(name) {
  const dir = join(root, name);
  cpSync(fixture, dir, { recursive: true });
  const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  pkg.packageManager = packageManager;
  writeFileSync(join(dir, "package.json"), JSON.stringify(pkg));
  writeFileSync(join(dir, ".npmrc"), `store-dir=${join(root, "store")}\n`);
  return dir;
}
try {
  for (const key of Object.keys(process.env)) if (key.startsWith("COTAL_")) delete process.env[key];
  process.env.CI = "true";
  // pnpm disables nested verification in script children; this fixture exercises its install mode.
  process.env.pnpm_config_verify_deps_before_run = "install";
  process.env.FORCE_COLOR = "0";
  process.env.COREPACK_HOME = corepackHome;
  process.env.npm_config_store_dir = join(root, "store");
  process.env.pnpm_config_store_dir = join(root, "store");
  for (const [key, leaf] of Object.entries({ HOME: "home", XDG_CONFIG_HOME: "config", XDG_CACHE_HOME: "cache" })) {
    process.env[key] = join(root, leaf); mkdirSync(process.env[key], { recursive: true, mode: 0o700 });
  }
  const control = prepare("control");
  const launcher = spawnSync("pnpm", ["smoke:silent"], { cwd: control, env: process.env, encoding: "utf8", timeout: 60_000 });
  const launcherOutput = `${launcher.stdout ?? ""}${launcher.stderr ?? ""}`;
  check("real pnpm installs the locked policy fixture and runs its silent command", launcher.status === 0);
  check("the real launcher emits the policy banner that can mint a false cell", /✓ Lockfile.*passes supply-chain policies/.test(launcherOutput) && parseSentinel(launcherOutput)?.cells > 0);
  assert.equal(launcher.status, 0, launcherOutput);
  assert.match(launcherOutput, /✓ Lockfile.*passes supply-chain policies/);

  for (const suite of ["smoke:silent", "smoke:green"]) {
    const dir = prepare(`serial-${suite.split(":")[1]}`);
    const list = join(dir, "ci-suites.txt"); writeFileSync(list, `${suite}\n`);
    const childEnv = { ...process.env };
    for (const key of Object.keys(childEnv)) if (key.startsWith("COTAL_")) delete childEnv[key];
    const result = spawnSync(process.execPath, [shard, "0", "1"], { cwd: dir,
      env: { ...childEnv, COTAL_CI_SUITES: list, SMOKE_CI_JOBS: "1" }, encoding: "utf8", timeout: 60_000 });
    const out = `${result.stdout ?? ""}${result.stderr ?? ""}`;
    console.log(`serial observation ${JSON.stringify({ suite, status: result.status, shardCells: out.match(/passed \(1 smokes, (\d+) cells\)/)?.[1] ?? null, noSentinel: out.includes("(no sentinel)") })}`);
    check(`${suite}: serial runner completed without a timeout`, !result.error && result.signal === null);
    check(`${suite}: serial runner did not grade a pnpm policy banner`, !/✓ Lockfile.*passes supply-chain policies/.test(out));
    check(`${suite}: serial runner reports the suite's actual cell outcome`, suite === "smoke:silent"
      ? result.status === 1 && out.includes(`FAILED at: pnpm ${suite} (no sentinel)`)
      : result.status === 0 && out.includes("passed (1 smokes, 3 cells)"));
  }
  for (const suite of ["smoke:silent", "smoke:green"]) {
    const dir = prepare(`pool-${suite.split(":")[1]}`); process.chdir(dir);
    const command = `pnpm ${suite}`;
    const result = await runPool([command], { jobs: 1, runMarker: `launcher-sentinel-${process.pid}`,
      indices: new Map([[command, 0]]), onStart: () => {} });
    const row = result.results[0];
    console.log(`pool observation ${JSON.stringify({ suite, status: row?.status, cells: row?.cells, failure: result.failure?.reason ?? null })}`);
    check(`${suite}: pooled runner ran its fixture`, row?.status === 0);
    check(`${suite}: pooled runner did not grade a pnpm policy banner`, !/✓ Lockfile.*passes supply-chain policies/.test(row?.out ?? ""));
    check(`${suite}: pooled runner reports the suite's actual cell outcome`, suite === "smoke:silent"
      ? result.failure?.reason === "no sentinel" && row?.cells === 0
      : !result.failure && row?.cells === 3);
  }
} finally {
  process.chdir(originalCwd);
  for (const key of Object.keys(process.env)) if (!originalEnv.has(key)) delete process.env[key];
  for (const [key, value] of originalEnv) process.env[key] = value;
  rmSync(root, { recursive: true, force: true });
}
assert.equal(passed + failed, 14, "every launcher cell ran");
emitSentinel({ passed, failed });
if (failed) process.exitCode = 1;
