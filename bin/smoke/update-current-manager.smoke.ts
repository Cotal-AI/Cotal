import "../../implementations/cli/smoke/update-isolation.js";
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { assertSmokeSandboxDown, freePort, recordSmokeSandbox } from "@cotal-ai/smoke-kit";

if (process.platform !== "linux") {
  console.log("current installed closure fast path is Linux-only");
} else {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "cm-")));
  const repo = join(import.meta.dirname, "../..");
  const installed = join(root, "prefix/lib/node_modules/cotal-ai");
  cpSync(join(repo, "bin/dist"), join(installed, "dist"), { recursive: true });
  cpSync(join(repo, "bin/package.json"), join(installed, "package.json"));
  const entry = realpathSync.native(join(installed, "dist/cotal.js"));
  try {
    for (const checkout of [false, true]) {
      const home = join(root, String(checkout));
      mkdirSync(home, { mode: 0o700 });
      mkdirSync(join(home, ".cotal"), { mode: 0o700 });
      const env: NodeJS.ProcessEnv = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("COTAL_"))), HOME: home, COTAL_HOME: join(home, "cotal"), XDG_CONFIG_HOME: join(home, "config"), COTAL_SKIP_CONNECTOR_SEED: "1" };
      delete env.XDG_RUNTIME_DIR;
      const script = `
process.argv[1] = ${JSON.stringify(entry)};
const { registry } = await import(${JSON.stringify(pathToFileURL(join(repo, "packages/core/dist/index.js")).href)});
await import(${JSON.stringify(pathToFileURL(join(repo, "implementations/cli/dist/index.js")).href)});
const { updateRuntime } = await import(${JSON.stringify(pathToFileURL(join(repo, "implementations/cli/dist/commands/update.js")).href)});
Object.defineProperty(globalThis, Symbol.for('cotal.execution.started'), { value: true });
Object.defineProperty(globalThis, Symbol.for('cotal.execution.identity'), { value: Object.freeze({ logicalEntry: ${JSON.stringify(entry)}, loadedEntry: ${JSON.stringify(entry)} }) });
let legacyReads = 0;
Object.assign(updateRuntime, {
  checkout: () => ${checkout}, isCurrent: () => true, version: () => '0.164.18',
  npm: () => ({ status: 0, stdout: '"0.164.18"', stderr: '' }),
  preflightReplacement: async () => {},
  reportRunningManager: async () => { legacyReads++; return 'legacy'; },
});
await import(${JSON.stringify(pathToFileURL(join(repo, "bin/dist/daemon/update-entry.js")).href)});
await registry.resolve('command', 'update').run({ raw: ['--self'], positionals: [], values: { self: true } });
console.log('LEGACY_READS=' + legacyReads);
`;
      const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], { cwd: home, env, encoding: "utf8", timeout: 30_000 });
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.match(result.stdout, new RegExp(`LEGACY_READS=${checkout ? 1 : 0}`), "installed no-op uses retained reads, while a source checkout keeps the in-place report");
      if (checkout) assert.match(result.stdout, /later update will require stopping/i);
      else assert.doesNotMatch(result.stdout, /later update will require stopping/i);
    }
    console.log("current Manager report: installed retention and checkout isolation pass");

    // Exercise the public installed entry against a real standalone stack and local daemon.
    const payload = spawnSync(process.execPath, [join(repo, "bin/scripts/copy-seeded-connectors.mjs")], { cwd: repo, encoding: "utf8" });
    assert.equal(payload.status, 0, payload.stdout + payload.stderr);
    cpSync(join(repo, "bin/seeded-connectors"), join(installed, "seeded-connectors"), { recursive: true });
    symlinkSync(join(repo, "bin/node_modules"), join(installed, "node_modules"));
    const home = join(root, "live"), project = join(home, "demo");
    const env: NodeJS.ProcessEnv = {
      ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("COTAL_"))),
      HOME: home, COTAL_HOME: join(home, "cotal"), XDG_CONFIG_HOME: join(home, "config"),
      XDG_RUNTIME_DIR: join(root, "rt"), COTAL_NO_UPDATE_CHECK: "1", DO_NOT_TRACK: "1",
    };
    for (const path of [project, env.COTAL_HOME!, env.XDG_CONFIG_HOME!, env.XDG_RUNTIME_DIR!]) mkdirSync(path, { recursive: true, mode: 0o700 });
    const anchor = recordSmokeSandbox({ root: project, cotalHome: env.COTAL_HOME!, xdgConfigHome: env.XDG_CONFIG_HOME! });
    const cli = (...args: string[]) => {
      const options = { cwd: project, env, encoding: "utf8" as const, timeout: 120_000 };
      assertSmokeSandboxDown(anchor, args, options);
      return spawnSync(process.execPath, [entry, ...args], options);
    };
    let daemon: ChildProcess | undefined;
    let daemonExit: Promise<number | null> | undefined;
    try {
      const up = cli("up", "--detach", "--space", "demo", "--server", `nats://127.0.0.1:${await freePort()}`);
      assert.equal(up.status, 0, up.stdout + up.stderr);
      const before = cli("update");
      assert.equal(before.status, 0, before.stdout + before.stderr);
      assert.match(before.stdout, /Standalone Manager .* keeps its loaded execution generation/);
      const initial = cli("ps", "--json");
      assert.equal(initial.status, 0, initial.stdout + initial.stderr);
      daemon = spawn(process.execPath, [entry, "daemon", "serve"], { cwd: project, env, stdio: ["ignore", "pipe", "pipe"] });
      daemonExit = new Promise(resolve => daemon!.once("exit", resolve));
      let daemonOutput = "";
      daemon.stdout!.on("data", chunk => { daemonOutput += chunk; });
      daemon.stderr!.on("data", chunk => { daemonOutput += chunk; });
      const deadline = Date.now() + 30_000;
      while (!daemonOutput.includes("daemon ready at")) {
        assert.equal(daemon.exitCode, null, daemonOutput);
        assert.ok(Date.now() < deadline, daemonOutput);
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      const status = cli("daemon", "status", "--json");
      assert.equal(status.status, 0, status.stdout + status.stderr);
      assert.deepEqual(JSON.parse(status.stdout).result.managers ?? [], [], "daemon hosts no Managers");
      const after = cli("update");
      assert.equal(after.status, 0, after.stdout + after.stderr);
      assert.match(after.stdout, /Standalone Manager .* keeps its loaded execution generation/);
      assert.match(after.stdout, /connectors reconciled/);
      assert.doesNotMatch(after.stdout + after.stderr, /legacy manager custody|Cannot determine this Manager/);
      const final = cli("ps", "--json");
      assert.equal(final.status, 0, final.stdout + final.stderr);
      const initialManagers = JSON.parse(initial.stdout).result.managers;
      assert.equal(initialManagers.length, 1, "one standalone Manager is running");
      assert.ok(initialManagers[0].instanceId);
      assert.deepEqual(JSON.parse(final.stdout).result.managers.map((manager: { instanceId: string }) => manager.instanceId), initialManagers.map((manager: { instanceId: string }) => manager.instanceId), "reconciliation does not restart the standalone Manager");
      assert.equal(daemon.exitCode, null, "reconciliation leaves the foreground daemon running");
      console.log("standalone update: succeeds with and without a reachable daemon, without restarting the Manager");
    } finally {
      const down = cli("down", "--yes");
      if (daemon?.exitCode === null) { daemon.kill("SIGTERM"); await daemonExit; }
      assert.equal(down.status, 0, down.stdout + down.stderr);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
}
