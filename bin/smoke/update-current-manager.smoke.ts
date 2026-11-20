import "../../implementations/cli/smoke/update-isolation.js";
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer as createRegistry } from "node:http";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { assertSmokeSandboxDown, freePort, recordSmokeSandbox } from "@cotal-ai/smoke-kit";
import { daemonPaths } from "../daemon/endpoint.js";
import { holdLifetime } from "../daemon/lifetime.js";

if (process.platform !== "linux") {
  console.log("current installed closure fast path is Linux-only");
} else {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "cm-")));
  const repo = join(import.meta.dirname, "../..");
  const installed = join(root, "prefix/lib/node_modules/cotal-ai");
  cpSync(join(repo, "bin/dist"), join(installed, "dist"), { recursive: true });
  cpSync(join(repo, "bin/package.json"), join(installed, "package.json"));
  const entry = realpathSync.native(join(installed, "dist/cotal.js"));
  mkdirSync(join(root, "prefix/bin"));
  symlinkSync(entry, join(root, "prefix/bin/cotal"));
  const version = JSON.parse(readFileSync(join(installed, "package.json"), "utf8")).version as string;
  const seedCurrent = (config: string) => {
    const seed = join(config, "cotal/seed");
    mkdirSync(seed, { recursive: true, mode: 0o700 });
    for (const file of ["authority.json", "authority.bak.json"]) writeFileSync(join(seed, file), JSON.stringify({ everSeeded: ["claude", "opencode", "codex", "hermes", "jcode", "pi", "web"] }));
    writeFileSync(join(seed, "witness.json"), JSON.stringify({ initialized: true, firstGeneration: version }));
    writeFileSync(join(seed, "stamp.json"), JSON.stringify({ generation: version }));
  };
  const installerOnly = process.argv.includes("--installer-restart");
  try {
    for (const checkout of installerOnly ? [] : [false, true]) {
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
      assert.match(result.stdout, /LEGACY_READS=0/, "a current package closure does not read Manager custody");
      assert.doesNotMatch(result.stdout, /later update will require stopping/i);
    }
    if (!installerOnly) console.log("current package closure: installed CLI and checkout skip Manager custody");

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
    if (!installerOnly) try {
      const create = cli("space", "create", "demo", "--root", ".");
      assert.equal(create.status, 0, create.stdout + create.stderr);
      const up = cli("up", "--open", "--detach", "--space", "demo", "--server", `nats://127.0.0.1:${await freePort()}`);
      assert.equal(up.status, 0, up.stdout + up.stderr);
      assert.match(up.stdout, /Controller stack started/);
      const before = cli("update");
      assert.equal(before.status, 0, before.stdout + before.stderr);
      assert.match(before.stdout, /Standalone Manager .* keeps its loaded execution generation/);
      const initial = cli("ps", "--json");
      assert.equal(initial.status, 0, initial.stdout + initial.stderr);
      const managerBefore = cli("manager", "status", "--json");
      assert.equal(managerBefore.status, 0, managerBefore.stdout + managerBefore.stderr);
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

      const otherPrefix = join(root, "other"), other = join(otherPrefix, "lib/node_modules/cotal-ai");
      cpSync(join(installed, "dist"), join(other, "dist"), { recursive: true });
      cpSync(join(installed, "package.json"), join(other, "package.json"));
      symlinkSync(join(repo, "bin/node_modules"), join(other, "node_modules"));
      mkdirSync(join(otherPrefix, "bin"));
      symlinkSync(join(other, "dist/cotal.js"), join(otherPrefix, "bin/cotal"));
      const otherHome = join(root, "other-home"), config = join(otherHome, "config");
      // The other installation previously removed its built-ins and needs no reconciliation.
      seedCurrent(config);
      const registry = createRegistry((_request, response) => response.end(JSON.stringify({ name: "cotal-ai", "dist-tags": { latest: version }, versions: { [version]: { name: "cotal-ai", version } } })));
      await new Promise<void>(resolve => registry.listen(0, "127.0.0.1", resolve));
      const updateOther = async (cwd: string, updateEnv: NodeJS.ProcessEnv, ...args: string[]) => {
        const child = spawn(process.execPath, [join(other, "dist/cotal.js"), "update", ...args], {
          cwd, stdio: ["ignore", "pipe", "pipe"], timeout: 120_000,
          env: { ...updateEnv, npm_config_registry: `http://127.0.0.1:${(registry.address() as AddressInfo).port}` },
        });
        let output = "";
        child.stdout.on("data", data => { output += String(data); });
        child.stderr.on("data", data => { output += String(data); });
        const code = await new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
        assert.equal(code, 0, output);
        return output;
      };
      try {
        // Keep the live Manager's launch entry unavailable, as during a concurrent npm replacement.
        renameSync(entry, `${entry}.reinstall`);
        try {
          const output = await updateOther(otherHome, { ...env, HOME: otherHome, COTAL_HOME: join(otherHome, "state"),
            XDG_CONFIG_HOME: config, XDG_RUNTIME_DIR: join(otherHome, "runtime"), TMPDIR: otherHome }, "--self");
          assert.match(output, /installed package closure is current\. No connector reconciliation was run\./);
        } finally { renameSync(`${entry}.reinstall`, entry); }

        // The installer adds another prefix in the same home, while the selected stack still uses the old one.
        // No connectors are installed in this prefix. A missing stamp still requires reconciliation.
        seedCurrent(env.XDG_CONFIG_HOME!);
        rmSync(join(env.XDG_CONFIG_HOME!, "cotal/seed/stamp.json"));
        const self = await updateOther(project, env, "--self");
        assert.match(self, /connectors reconciled/, self);
        const plain = await updateOther(project, { ...env, COTAL_INSTALL_RECONCILE: "1" });
        assert.match(plain, /connectors reconciled/, plain);
        assert.doesNotMatch(self + plain, /legacy manager custody|manual cold update/);
      } finally { await new Promise<void>((resolve, reject) => registry.close(error => error ? reject(error) : resolve())); }
      const unchanged = cli("ps", "--json");
      assert.equal(unchanged.status, 0, unchanged.stdout + unchanged.stderr);
      assert.deepEqual(JSON.parse(unchanged.stdout).result.managers.map((manager: { instanceId: string }) => manager.instanceId), initialManagers.map((manager: { instanceId: string }) => manager.instanceId), "updates from the other prefix leave the selected Manager answering");
      const managerAfter = cli("manager", "status", "--json");
      assert.equal(managerAfter.status, 0, managerAfter.stdout + managerAfter.stderr);
      const beforeStatus = JSON.parse(managerBefore.stdout).result, afterStatus = JSON.parse(managerAfter.stdout).result;
      assert.equal(afterStatus.observedProcess, "running");
      assert.ok(beforeStatus.pid);
      assert.equal(afterStatus.pid, beforeStatus.pid, "updates do not replace the selected Manager process");
      assert.deepEqual(afterStatus.nativeEndpoint, beforeStatus.nativeEndpoint, "updates do not replace its native lifecycle");
      assert.equal(daemon.exitCode, null, "the other installation's updates leave the foreground daemon running");
      console.log("separate installation: updates leave the selected Manager and foreground daemon running");
    } finally {
      const down = cli("down", "--yes");
      if (daemon?.exitCode === null) { daemon.kill("SIGTERM"); await daemonExit; }
      assert.equal(down.status, 0, down.stdout + down.stderr);
    }

    const registry = createRegistry((_request, response) => response.end(JSON.stringify({ name: "cotal-ai", "dist-tags": { latest: version }, versions: { [version]: { name: "cotal-ai", version } } })));
    await new Promise<void>(resolve => registry.listen(0, "127.0.0.1", resolve));
    try {
      const native = join(root, "native"), config = join(home, "installer-config");
      // This home previously removed its built-ins. Reconciliation should keep them removed.
      seedCurrent(config);
      const unit = "cotal-daemon.service", unitPath = join(config, "systemd/user", unit);
      const unitSource = `[Service]\nExecStart="${process.execPath}" "${entry}" daemon serve\nRestart=always\n`;
      mkdirSync(native, { mode: 0o700 });
      mkdirSync(dirname(unitPath), { recursive: true, mode: 0o700 });
      writeFileSync(join(native, "systemctl"), `#!/bin/sh\n[ "$*" = '--user show-environment' ] || exit 99\nprintf '%s\\n' 'XDG_CONFIG_HOME=${config}'\n`, { mode: 0o700 });
      writeFileSync(unitPath, unitSource, { mode: 0o600 });
      const reconcileEnv = { ...env, XDG_CONFIG_HOME: config, PATH: `${native}:${env.PATH}`, COTAL_INSTALL_RECONCILE: "1",
        npm_config_registry: `http://127.0.0.1:${(registry.address() as AddressInfo).port}` };
      const paths = daemonPaths(reconcileEnv, env.COTAL_HOME!);
      for (const dir of [paths.dir!, paths.state]) mkdirSync(dir, { recursive: true, mode: 0o700 });
      writeFileSync(join(paths.state, "service-unit.json"), JSON.stringify({ v: 1, unit, unitPath,
        unitSha256: createHash("sha256").update(unitSource).digest("hex"), installedAt: new Date().toISOString() }), { mode: 0o600 });

      // The third status is best-effort connector set collection. Interrupt each required read.
      for (const [dropAt, phase] of [[1, "admission"], [2, "continuity"], [4, "post-update status"], [5, "readiness"]] as const) {
        const lock = holdLifetime(paths.lock);
        const requests: string[] = [];
        const server = createServer(socket => {
          socket.setEncoding("utf8");
          let line = "";
          socket.on("data", (chunk: string) => {
            line += chunk;
            if (!line.includes("\n")) return;
            const { id, op } = JSON.parse(line) as { id: string; op: string };
            if (requests.push(op) === dropAt) socket.end();
            else socket.end(JSON.stringify({ v: 1, id, ok: true, result: { pid: process.pid, state: "ready", protocol: 1, version, managers: [] } }) + "\n");
          });
        });
        await new Promise<void>(resolve => server.listen(paths.socket, resolve));
        chmodSync(paths.socket, 0o600);
        try {
          const child = spawn(process.execPath, [entry, "update"], { cwd: project, env: reconcileEnv, stdio: ["ignore", "pipe", "pipe"], timeout: 30_000 });
          let output = "";
          child.stdout.on("data", data => { output += String(data); });
          child.stderr.on("data", data => { output += String(data); });
          const code = await new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
          assert.equal(code, 0, `${phase}: ${output}`);
          assert.match(output, /connectors reconciled/);
          assert.deepEqual(requests, Array(6).fill("status"), `${phase}: retry status without requesting another restart`);
          console.log(`installer reconciliation retries interrupted daemon ${phase}`);
        } finally {
          await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
          lock.release();
        }
      }
    } finally { await new Promise<void>((resolve, reject) => registry.close(error => error ? reject(error) : resolve())); }
  } finally { rmSync(root, { recursive: true, force: true }); }
}
