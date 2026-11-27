// After building, run with pnpm exec tsx implementations/cli/smoke/update-runtime-entry.smoke.ts.
import strictAssert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, truncateSync, writeFileSync } from "node:fs";
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
    const extroot = root.stdout.trim();
    const manifestPath = join(extroot, "extensions.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { extensions: { pkg: string; spec?: string }[] };
    const recorded = manifest.extensions.find(entry => entry.pkg === pkg);
    assert.equal(recorded?.spec, `${pkg}@${version}`);
    const entry = join(extroot, "node_modules", pkg, "dist/index.js");
    const original = readFileSync(entry);
    assert.ok(original.length > 0);
    const offlineCli = (...args: string[]) => run([cliEntry, ...args], home, { ...env, COTAL_SKIP_CONNECTOR_SEED: "1", CI: "false" });
    await assertOfflineExactSpec(assert, offlineCli, env, entry, original, registryRequests);
    recorded!.spec = `${pkg}@latest`;
    writeFileSync(manifestPath, JSON.stringify(manifest));
    await assertOfflineRuntimeRepair(assert, offlineCli, env, manifestPath, pkg, version, entry, original, registryRequests);
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
    await assertOfflineBundledRepair(assert, cli, env, config, version, registryRequests);
  } catch (error) {
    console.error(error);
    throw error;
  } finally {
    if (registry.listening) await new Promise<void>(resolveClose => registry.close(() => resolveClose()));
    rmSync(home, { recursive: true, force: true });
  }
}

async function assertOfflineExactSpec(
  assert: typeof strictAssert, cli: (...args: string[]) => ReturnType<typeof run>,
  env: NodeJS.ProcessEnv, entry: string, original: Buffer, requests: readonly string[],
): Promise<void> {
  const count = requests.length;
  truncateSync(entry, 0);
  writeFileSync(env.npm_config_userconfig!, "offline=true\n");
  const repaired = await cli("update", "--self");
  assert.equal(repaired.status, 0, repaired.output);
  assert.match(repaired.stdout, /The latest-version check was skipped/);
  assert.doesNotMatch(repaired.output, /Offline extension repair.*did not finish/);
  assert.deepEqual(readFileSync(entry), original);
  const repeated = await cli("update", "--self");
  assert.equal(repeated.status, 0, repeated.output);
  assert.equal(repeated.output.trim(), "npm is in offline mode. The latest-version check was skipped.");
  assert.deepEqual(requests.slice(count), []);
  rmSync(env.npm_config_userconfig!);
}

async function assertOfflineRuntimeRepair(
  assert: typeof strictAssert, cli: (...args: string[]) => ReturnType<typeof run>,
  env: NodeJS.ProcessEnv, manifestPath: string, pkg: string, version: string, entry: string, original: Buffer, requests: readonly string[],
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
  const pinned = JSON.parse(readFileSync(manifestPath, "utf8")) as { extensions: { pkg: string; spec?: string }[] };
  assert.equal(pinned.extensions.find(item => item.pkg === pkg)?.spec, `${pkg}@${version}`);

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

async function assertOfflineBundledRepair(
  assert: typeof strictAssert, cli: (...args: string[]) => ReturnType<typeof run>,
  env: NodeJS.ProcessEnv, config: string, version: string, requests: readonly string[],
): Promise<void> {
  const builtin = "@cotal-ai/connector-claude-code";
  const seedCli = (...args: string[]) => run([join(import.meta.dirname, "../../../bin/dist/cotal.js"), ...args], config, env);
  // The fixture records every built-in as already seeded, and --force still leaves a missing one
  // removed. Drop only this connector so the seed installs it; the others stay removed.
  const releaseClaude = () => {
    const everSeeded = SEED_BUILTINS.filter(name => name !== "claude");
    for (const name of ["authority.json", "authority.bak.json"]) {
      writeFileSync(join(config, "cotal", "seed", name), JSON.stringify({ everSeeded }));
    }
  };
  releaseClaude();
  const seeded = await seedCli("ext", "seed", "--force");
  assert.equal(seeded.status, 0, seeded.output);
  const root = (await cli("ext", "root")).stdout.trim();
  const manifestPath = join(root, "extensions.json");
  const readManifest = () => JSON.parse(readFileSync(manifestPath, "utf8")) as { extensions: { pkg: string; spec?: string; version?: string }[] };
  const row = () => readManifest().extensions.find(entry => entry.pkg === builtin);
  assert.equal(row()?.version, version);
  const dir = join(root, "node_modules", builtin);
  const store = join(config, "cotal", "seed", "store", version, "claude");
  const entryFile = () => {
    const meta = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { main?: string };
    return join(dir, meta.main ?? "dist/index.js");
  };
  const offline = { ...env, npm_config_offline: "true", npm_config_cache: join(config, "..", "empty-builtin-cache"), COTAL_SKIP_CONNECTOR_SEED: "1", CI: "false" };
  writeFileSync(env.npm_config_userconfig!, "offline=true\n");
  const self = () => run([join(import.meta.dirname, "../../../bin/dist/cotal.js"), "update", "--self"], config, offline);
  const count = requests.length;
  rmSync(dir, { recursive: true, force: true });
  const missing = await self();
  assert.equal(missing.status, 0, missing.output);
  assert.match(missing.stdout, /The latest-version check was skipped/);
  assert.match(missing.output, /added @cotal-ai\/connector-claude-code@/);
  assert.doesNotMatch(missing.output, /Offline extension repair for @cotal-ai\/tmux/);
  assert.ok(readFileSync(entryFile()).length > 0);
  offline.npm_config_cache = join(config, "..", "cache");
  const restored = readFileSync(entryFile());
  truncateSync(entryFile(), 0);
  const empty = await self();
  assert.equal(empty.status, 0, empty.output);
  assert.deepEqual(readFileSync(entryFile()), restored);
  writeFileSync(join(dir, "package.json"), "{");
  const corrupt = await self();
  assert.equal(corrupt.status, 0, corrupt.output);
  assert.doesNotMatch(corrupt.output, /did not finish/);
  assert.equal(JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).name, builtin);
  const removed = await cli("ext", "remove", builtin);
  assert.equal(removed.status, 0, removed.output);
  const stayed = await self();
  assert.equal(stayed.status, 0, stayed.output);
  assert.equal(stayed.output.trim(), "npm is in offline mode. The latest-version check was skipped.");
  assert.equal(row(), undefined);
  releaseClaude();
  const reseeded = await seedCli("ext", "seed", "--force");
  assert.equal(reseeded.status, 0, reseeded.output);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const emptied = await self();
  assert.equal(emptied.status, 0, emptied.output);
  assert.match(emptied.output, /added @cotal-ai\/connector-claude-code@/);
  assert.ok(readFileSync(entryFile()).length > 0);
  rmSync(dir, { recursive: true, force: true });
  const otherName = "opencode";
  const otherPkg = "@cotal-ai/connector-opencode";
  assert.equal(SEED_BUILTINS.includes(otherName), true);
  for (const name of ["authority.json", "authority.bak.json"]) {
    writeFileSync(join(config, "cotal", "seed", name), JSON.stringify({ everSeeded: SEED_BUILTINS.filter(item => item !== "claude" && item !== otherName) }));
  }
  const otherSeeded = await seedCli("ext", "seed", "--force");
  assert.equal(otherSeeded.status, 0, otherSeeded.output);
  const otherDir = join(root, "node_modules", otherPkg);
  assert.equal(existsSync(join(otherDir, "package.json")), true);
  rmSync(otherDir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "closed"), "");
  chmodSync(join(dir, "closed"), 0o000);
  const unread = await self();
  const closed = join(dir, "closed");
  if (existsSync(closed)) chmodSync(closed, 0o700);
  rmSync(dir, { recursive: true, force: true });
  assert.equal(unread.status, 0, unread.output);
  assert.match(unread.output, /Offline extension repair for @cotal-ai\/connector-claude-code@/);
  assert.match(unread.output, /added @cotal-ai\/connector-opencode@/);
  assert.doesNotMatch(unread.output, /Offline extension repair for @cotal-ai\/tmux/);
  assert.doesNotMatch(unread.output, /Offline extension repair for extensions@/);
  assert.equal(existsSync(join(otherDir, "package.json")), true);
  const storeFile = join(store, "package.json");
  const damaged = Buffer.from(JSON.stringify({ name: "damaged-before-admission", version }));
  writeFileSync(storeFile, damaged);
  const stamp = statSync(storeFile);
  const meshes = join(env.COTAL_HOME!, "meshes");
  mkdirSync(meshes, { recursive: true });
  chmodSync(meshes, 0o000);
  const refused = await self();
  chmodSync(meshes, 0o700);
  rmSync(meshes, { recursive: true, force: true });
  assert.equal(refused.status, 0, refused.output);
  assert.match(refused.output, /continuity or installation checks did not permit changes/);
  assert.doesNotMatch(refused.output, /wrote operator-global seed store payload/);
  const after = statSync(storeFile);
  assert.equal(after.ino, stamp.ino);
  assert.equal(after.mtimeMs, stamp.mtimeMs);
  assert.deepEqual(readFileSync(storeFile), damaged);
  assert.deepEqual(requests.slice(count), []);
  await assertHeldLocksRelease(assert, self, env, config, dir);
  await assertInterruptedInstall(assert, offline, config, dir);
}

async function assertHeldLocksRelease(
  assert: typeof strictAssert, self: () => ReturnType<typeof run>,
  env: NodeJS.ProcessEnv, config: string, dir: string,
): Promise<void> {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const holderScript = `
    import { acquireLock } from ${JSON.stringify(pathToFileURL(join(import.meta.dirname, "../../../packages/workspace/dist/advisory-lock.js")).href)};
    const held = acquireLock(process.argv[1], { label: "offline repair fixture" });
    process.stdout.write("held\\n");
    setTimeout(() => { held.release(); process.exit(0); }, 4000);
  `;
  const locks = [
    { path: join(env.COTAL_HOME!, ".update-closure.lock"), line: "waiting for another cotal command" },
    { path: join(config, "cotal", "seed", "reconcile.lock"), line: "waiting for another connector reconcile to finish" },
    { path: join(config, "cotal", ".extensions.lock"), line: "another extension mutation is in progress" },
  ];
  for (const lock of locks) {
    const holderEnv: NodeJS.ProcessEnv = { PATH: env.PATH ?? "", HOME: env.HOME ?? "", USERPROFILE: env.USERPROFILE ?? "" };
    const holder = spawn(process.execPath, ["--input-type=module", "-e", holderScript, lock.path], { cwd: config, env: holderEnv, stdio: ["ignore", "pipe", "pipe"] });
    let holderOut = "";
    holder.stdout.on("data", chunk => { holderOut += chunk; });
    holder.stderr.on("data", chunk => { holderOut += chunk; });
    const ready = await new Promise<boolean>(resolveReady => {
      const timer = setTimeout(() => resolveReady(false), 10_000);
      holder.stdout.on("data", () => { if (holderOut.includes("held")) { clearTimeout(timer); resolveReady(true); } });
      holder.once("exit", () => { clearTimeout(timer); resolveReady(false); });
    });
    assert.equal(ready, true, holderOut);
    const blocked = await self();
    const gone = await new Promise<number | null>(resolveExit => { if (holder.exitCode !== null) resolveExit(holder.exitCode); else holder.once("exit", resolveExit); });
    assert.equal(gone, 0, holderOut);
    assert.equal(blocked.status, 0, blocked.output);
    assert.match(blocked.output, new RegExp(lock.line));
    const waitAt = blocked.output.indexOf(lock.line);
    const addedAt = blocked.output.indexOf("added @cotal-ai/connector-claude-code@");
    assert.equal(waitAt >= 0 && addedAt > waitAt, true, blocked.output);
    assert.equal(existsSync(join(dir, "package.json")), true);
    rmSync(dir, { recursive: true, force: true });
    if (lock !== locks[locks.length - 1]) mkdirSync(dir, { recursive: true });
    for (const lockPath of [join(env.COTAL_HOME!, ".update-closure.lock"), join(config, "cotal", "seed", "reconcile.lock"), join(config, "cotal", ".extensions.lock"), join(config, "cotal", ".extensions.lock.update")]) {
      assert.equal(existsSync(lockPath), false, lockPath);
    }
  }
}

async function assertInterruptedInstall(assert: typeof strictAssert, offline: NodeJS.ProcessEnv, config: string, dir: string): Promise<void> {
  rmSync(dir, { recursive: true, force: true });
  const pausing = spawn(process.execPath, [join(import.meta.dirname, "../../../bin/dist/cotal.js"), "update", "--self"], { cwd: config, env: offline, stdio: ["ignore", "pipe", "pipe"] });
  let pausingOut = "";
  pausing.stdout.on("data", chunk => { pausingOut += chunk; });
  pausing.stderr.on("data", chunk => { pausingOut += chunk; });
  const started = await new Promise<boolean>(resolveStarted => {
    const timer = setTimeout(() => resolveStarted(false), 20_000);
    const watch = () => { if (pausingOut.includes("installing ")) { clearTimeout(timer); resolveStarted(true); } };
    pausing.stdout.on("data", watch);
    pausing.stderr.on("data", watch);
    pausing.once("exit", () => { clearTimeout(timer); resolveStarted(false); });
  });
  if (started) pausing.kill("SIGINT");
  const paused = await new Promise<{ status: number | null }>(resolveExit => pausing.once("exit", status => resolveExit({ status })));
  assert.equal(started, true, pausingOut);
  assert.equal(paused.status, 130, pausingOut);
  assert.doesNotMatch(pausingOut, /Offline extension repair for @cotal-ai\/connector-claude-code@.*did not finish/);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const counted = countedAssert(strictAssert);
  await repairRuntimeEntry(counted.assert as typeof strictAssert);
  emitSentinel({ passed: counted.cells(), failed: 0 });
}
