/** CI acceptance for copied-install generation changes and guarded manual update admission. */
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { skipSuite } from "@cotal-ai/smoke-kit";

if (process.platform !== "linux") skipSuite("daemon-generation-live: Linux only");
const repo = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
// All copies stay under this suite's private TMPDIR. The invoking lane owns cleanup once no
// process can enter them. Never merge artifact assembly into an existing install.
const root = mkdtempSync(join(tmpdir(), "daemon-generation-ci-"));
const fixture = join(root, "packages");
async function run(args: string[], env = process.env, cpuQuota?: string): Promise<void> {
  const child = cpuQuota
    ? spawn("systemd-run", ["--user", "--scope", "--quiet", "-p", `CPUQuota=${cpuQuota}`, process.execPath, ...args], { cwd: repo, env, stdio: "inherit" })
    : spawn(process.execPath, args, { cwd: repo, env, stdio: "inherit" });
  const code = await new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); });
  if (code !== 0) throw new Error(`generation acceptance subprocess exited ${code}`);
}
await run([join(repo, "bin/smoke/build-daemon-upgrade-fixture.mjs"), fixture, "--workspace-source"]);
const args = process.argv.slice(2);
if (args.includes("--cold-reconcile") || args.includes("--cold-reconcile-quota")) {
  const home = join(root, "cold-home");
  await run(["--input-type=module", "-e", `
    import assert from 'node:assert/strict';
    import {mkdirSync} from 'node:fs';
    import {pathToFileURL} from 'node:url';
    mkdirSync(process.env.HOME, {recursive:true, mode:0o700});
    const prefix = ${JSON.stringify(join(fixture, "hoisted-fix2-0.151.2"))};
    const entry = prefix + '/dist/cotal.js';
    Object.defineProperty(globalThis, Symbol.for('cotal.execution.identity'), {
      value: Object.freeze({logicalEntry: entry, launchEntry: entry, loadedEntry: entry}),
    });
    const {reconcileHostedConnectors} = await import(pathToFileURL(prefix + '/dist/daemon/generation.js').href);
    const {loadExtensionsManifest} = await import(pathToFileURL(prefix + '/node_modules/@cotal-ai/workspace/dist/index.js').href);
    const start = Date.now();
    await reconcileHostedConnectors('0.151.2');
    const builtins = loadExtensionsManifest().extensions.filter(entry => entry.source === 'seeded');
    assert.equal(builtins.length, 7);
    assert.ok(builtins.every(entry => entry.version === '0.151.2'));
    const elapsedMs = Date.now()-start;
    if (${process.argv.includes("--cold-reconcile-quota")}) assert.ok(elapsedMs > 120000, 'cold reconciliation must cross the former deadline');
    console.log('cold hosted reconciliation passed', elapsedMs, 'ms, seven current built-ins');
  `], { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("COTAL_"))), HOME: home, COTAL_HOME: join(home, ".cotal"), XDG_CONFIG_HOME: join(home, "config"), XDG_DATA_HOME: join(home, "data"), XDG_CACHE_HOME: join(home, "cache"), npm_config_cache: join(home, "npm"), COTAL_SKIP_CONNECTOR_SEED: "1" }, args.includes("--cold-reconcile-quota") ? "15%" : undefined);
} else {
  const cases = args.includes("--manual-admission-repros")
    ? [["--update-repro", "--manual-admission-race-repro"], ["--update-repro", "--manual-admission-empty-repro"]]
    : [args.length ? args : ["--upgrade-active-repro", "--watcher-seat-repro"]];
  for (const flags of cases) {
    await run([join(repo, "node_modules/tsx/dist/cli.mjs"), join(repo, "bin/smoke/daemon-service-connect.smoke.ts"), "--hosting-only", ...(flags.includes("--update-repro") ? [] : ["--upgrade-repro"]), ...flags], { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("COTAL_"))), COTAL_DAEMON_UPGRADE_FIXTURE: fixture });
  }
}
console.log("daemon-generation-live: copied-install generation acceptance passed");
