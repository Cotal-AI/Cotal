// After building, run with pnpm exec tsx implementations/cli/smoke/update-runtime-entry.smoke.ts.
import strictAssert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { countedAssert, emitSentinel } from "../../../bin/smoke/sentinel.mjs";
import { SEED_BUILTINS } from "../src/seed/paths.js";

const currentClosure = /installed package closure is current/;

function run(args: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<{ status: number | null; output: string; stdout: string }> {
  return new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, args, { cwd, env, timeout: 60_000 });
    let stdout = "", stderr = "";
    child.stdout.on("data", data => { stdout += data; });
    child.stderr.on("data", data => { stderr += data; });
    child.once("error", reject);
    child.once("close", status => resolveRun({ status, output: stdout + stderr, stdout }));
  });
}

export async function repairRuntimeEntry(assert: typeof strictAssert): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), "cotal-update-runtime-"));
  const repo = join(import.meta.dirname, "../../..");
  const pkg = "@cotal-ai/tmux";
  const version = JSON.parse(readFileSync(join(repo, "bin/package.json"), "utf8")).version as string;
  const config = join(home, "config");
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(?:cotal_|npm_config_|(?:https?_proxy|all_proxy|proxy|no_proxy)$)/i.test(key)));
  const registryRequests: string[] = [];
  const registry = createServer((request, response) => {
    registryRequests.push(`${request.method} ${request.url} [${request.headers["npm-command"] ?? "no npm-command"}]`);
    const name = decodeURIComponent(request.url ?? "");
    if (name === "/cotal-ai" || name === `/${pkg}`) {
      const packageName = name.slice(1);
      response.end(JSON.stringify({ name: packageName, "dist-tags": { latest: version }, versions: {
        [version]: { name: packageName, version, dist: { tarball: `${origin}/tmux.tgz` } },
      } }));
    } else if (name === "/tmux.tgz" && !refuseArchive) {
      response.end(archive);
    } else {
      response.writeHead(404).end();
    }
  });
  let origin: string, archive: Buffer, refuseArchive = false;
  try {
    const seed = join(config, "cotal", "seed");
    mkdirSync(seed, { recursive: true });
    for (const name of ["authority.json", "authority.bak.json"]) {
      writeFileSync(join(seed, name), JSON.stringify({ everSeeded: SEED_BUILTINS }));
    }
    writeFileSync(join(seed, "witness.json"), JSON.stringify({ initialized: true, firstGeneration: version }));
    writeFileSync(join(seed, "stamp.json"), JSON.stringify({ generation: version }));
    Object.assign(env, { HOME: home, USERPROFILE: home, COTAL_HOME: join(home, "cotal"), XDG_CONFIG_HOME: config,
      APPDATA: config, LOCALAPPDATA: config, XDG_RUNTIME_DIR: home, XDG_DATA_HOME: join(home, "data"),
      XDG_CACHE_HOME: join(home, "xdg-cache"), XDG_STATE_HOME: join(home, "state"), npm_config_cache: join(home, "cache"),
      npm_config_userconfig: join(home, "user.npmrc"), npm_config_globalconfig: join(home, "global.npmrc"),
      COTAL_ALLOW_CHECKOUT_SEED: "1", COTAL_NO_UPDATE_CHECK: "1", COTAL_TELEMETRY: "off" });
    mkdirSync(env.COTAL_HOME!, { mode: 0o700 });
    mkdirSync(join(home, ".cotal"), { mode: 0o700 });
    const packed = spawnSync("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", home], {
      cwd: join(repo, "extensions/tmux"), env, encoding: "utf8", shell: process.platform === "win32", timeout: 30_000,
    });
    assert.equal(packed.status, 0, packed.stdout + packed.stderr);
    archive = readFileSync(join(home, JSON.parse(packed.stdout)[0].filename));
    await new Promise<void>((resolveListen, reject) => registry.once("error", reject).listen(0, "127.0.0.1", resolveListen));
    origin = `http://127.0.0.1:${(registry.address() as AddressInfo).port}`;
    env.npm_config_registry = origin;
    const cliEntry = join(repo, "bin/dist/cotal.js");
    const cli = (...args: string[]) => run([cliEntry, ...args], home, { ...env, COTAL_SKIP_CONNECTOR_SEED: "1" });
    // Observe the fixture's empty custody without scanning host processes. The package repair uses the real updater and npm.
    const selfUpdate = () => run(["--input-type=module", "-e", `
      const { executeUpdate, updateRuntime } = await import(${JSON.stringify(new URL("../dist/commands/update.js", import.meta.url).href)});
      process.exitCode = await executeUpdate(true, { ...updateRuntime, reportRunningManager: async () => "none" });
    `, cliEntry], home, env);
    const added = await cli("ext", "add", `${pkg}@${version}`);
    assert.equal(added.status, 0, added.output);
    const root = await cli("ext", "root");
    assert.equal(root.status, 0, root.output);
    const entry = join(root.stdout.trim(), "node_modules", pkg, "dist/index.js");
    const original = readFileSync(entry);
    assert.ok(original.length > 0);
    const offlineCli = (...args: string[]) => run([cliEntry, ...args], home, { ...env, COTAL_SKIP_CONNECTOR_SEED: "1", CI: "false" });
    await assertOfflineRuntimeRepair(assert, offlineCli, env, entry, original, registryRequests);
    const brokenImport = 'import { notAnExportOfCore } from "@cotal-ai/core";\nvoid notAnExportOfCore;\n';
    for (const damage of ["missing", "empty", "import"]) {
      if (damage === "missing") renameSync(entry, join(home, "tmux-index.saved"));
      else if (damage === "empty") truncateSync(entry, 0);
      else writeFileSync(entry, brokenImport);
      const broken = await cli("runtimes", "--plain");
      assert.equal(broken.status, 4, broken.output);
      assert.match(broken.output, /tmux\s+installed - load failed/);
      if (damage === "import") assert.match(broken.output, /notAnExportOfCore/);
      refuseArchive = true;
      env.npm_config_cache = join(home, `empty-cache-${damage}`);
      const refused = await selfUpdate();
      assert.equal(refused.status, 1, refused.output);
      assert.match(refused.output, /extension set npm install failed/);
      assert.doesNotMatch(refused.output, currentClosure);
      if (damage === "missing") assert.throws(() => readFileSync(entry), { code: "ENOENT" });
      else assert.equal(readFileSync(entry, "utf8"), damage === "empty" ? "" : brokenImport);
      refuseArchive = false;
      const repaired = await selfUpdate();
      assert.equal(repaired.status, 0, repaired.output);
      assert.doesNotMatch(repaired.output, currentClosure);
      assert.deepEqual(readFileSync(entry), original);
      const runtimes = await cli("runtimes", "--plain");
      assert.equal(runtimes.status, 0, runtimes.output);
      assert.match(runtimes.output, /tmux\s+installed - (?:un)?reachable/);
    }
    if (process.platform === "linux") {
      const repeated = await selfUpdate();
      assert.equal(repeated.status, 0, repeated.output);
      assert.match(repeated.output, currentClosure);
    }
  } finally {
    if (registry.listening) await new Promise<void>(resolveClose => registry.close(() => resolveClose()));
    rmSync(home, { recursive: true, force: true });
  }
}

async function assertOfflineRuntimeRepair(
  assert: typeof strictAssert, cli: (...args: string[]) => ReturnType<typeof run>,
  env: NodeJS.ProcessEnv, entry: string, original: Buffer, requests: readonly string[],
): Promise<void> {
  const count = requests.length;
  const warmCache = env.npm_config_cache!;
  const notifierStamp = join(warmCache, "..", "_update-notifier-last-checked");
  truncateSync(entry, 0);
  // Keep the package cache warm, but make npm's notifier eligible to check this run.
  rmSync(notifierStamp, { force: true });
  writeFileSync(env.npm_config_userconfig!, "offline=true\n");
  const repaired = await cli("update", "--self");
  assert.equal(repaired.status, 0, repaired.output);
  assert.match(repaired.stdout, /The latest-version check was skipped/);
  assert.doesNotMatch(repaired.output, /Offline extension repair.*did not finish/);
  assert.deepEqual(readFileSync(entry), original);
  const runtimes = await cli("runtimes", "--plain");
  assert.equal(runtimes.status, 0, runtimes.output);
  assert.match(runtimes.output, /tmux\s+installed - (?:un)?reachable/);

  const repeated = await cli("update", "--self");
  assert.equal(repeated.status, 0, repeated.output);
  assert.equal(repeated.output.trim(), "npm is in offline mode. The latest-version check was skipped.");
  assert.deepEqual(requests.slice(count), []);
  rmSync(env.npm_config_userconfig!);

  truncateSync(entry, 0);
  env.npm_config_offline = "true";
  env.npm_config_cache = `${warmCache}-cold`;
  rmSync(notifierStamp, { force: true });
  const missed = await cli("update", "--self");
  assert.equal(missed.status, 0, missed.output);
  assert.match(missed.output, /Offline extension repair for @cotal-ai\/tmux@\S+ did not finish: extension set npm install failed/);
  assert.equal(readFileSync(entry).length, 0);
  assert.deepEqual(requests.slice(count), []);
  writeFileSync(entry, original);
  env.npm_config_cache = warmCache;
  delete env.npm_config_offline;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const counted = countedAssert(strictAssert);
  await repairRuntimeEntry(counted.assert as typeof strictAssert);
  emitSentinel({ passed: counted.cells(), failed: 0 });
}
