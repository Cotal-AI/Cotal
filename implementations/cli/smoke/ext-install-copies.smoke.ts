/** Real npm removal and failed seed cleanup must preserve copied file-based extensions.
 * Exercises both paths offline with an empty npm cache, using the built CLI and Claude connector
 * in private prefixes. Never starts a connector or broker.
 * Build the workspace first. Run: pnpm smoke:ext-install-copies
 */
import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { emitSentinel } from "@cotal-ai/smoke-kit";
import { resolveOnPath } from "@cotal-ai/workspace";

const execFileAsync = promisify(execFile);

function snapshotTree(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string, prefix: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      const full = join(dir, entry.name);
      const st = lstatSync(full);
      if (st.isSymbolicLink()) out[rel] = `link:${realpathSync(full)}`;
      else if (st.isDirectory()) walk(full, rel);
      else out[rel] = createHash("sha256").update(readFileSync(full)).digest("hex");
    }
  };
  walk(root, "");
  return out;
}

async function checkPackageLockOverride(
  repo: string,
  root: string,
  digest: (path: string) => string,
  check: (name: string, value: boolean) => void,
): Promise<void> {
  const strippedEnv: NodeJS.ProcessEnv = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("COTAL_") && !key.toLowerCase().startsWith("npm_config_")),
  );
  const makeIsolated = (dir: string) => {
    const home = join(dir, "home");
    const xdg = join(dir, "xdg");
    const appData = join(dir, "appdata");
    const cotalHome = join(dir, "cotal-home");
    const tmp = join(dir, "tmp");
    const npmPrefix = join(dir, "npm-global");
    const cache = join(dir, "npm-cache");
    for (const d of [home, xdg, appData, cotalHome, tmp, npmPrefix, cache]) mkdirSync(d, { recursive: true, mode: 0o700 });
    const userNpmrc = join(dir, "user.npmrc");
    const globalNpmrc = join(dir, "global.npmrc");
    writeFileSync(userNpmrc, "");
    writeFileSync(globalNpmrc, "");
    const env: NodeJS.ProcessEnv = {
      ...strippedEnv,
      HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: xdg, APPDATA: appData, LOCALAPPDATA: appData,
      COTAL_HOME: cotalHome,
      TMPDIR: tmp, TMP: tmp, TEMP: tmp, DO_NOT_TRACK: "1",
      npm_config_prefix: npmPrefix, npm_config_cache: cache,
      npm_config_userconfig: userNpmrc, npm_config_globalconfig: globalNpmrc,
      npm_config_update_notifier: "false",
    };
    const pkg = join(dir, "installed/lib/node_modules/cotal-ai");
    mkdirSync(pkg, { recursive: true });
    cpSync(join(repo, "bin/package.json"), join(pkg, "package.json"));
    cpSync(join(repo, "bin/dist"), join(pkg, "dist"), { recursive: true });
    symlinkSync(join(repo, "bin/node_modules"), join(pkg, "node_modules"), "junction");
    const entry = join(pkg, "dist/cotal.js");
    return { dir, home, xdg, userNpmrc, env, entry };
  };

  const version = JSON.parse(readFileSync(join(repo, "bin/package.json"), "utf8")).version as string;
  const queryExtRoot = (entryPath: string, dir: string, env: NodeJS.ProcessEnv): string => {
    const out = spawnSync(process.execPath, [entryPath, "ext", "root"], { cwd: dir, env, encoding: "utf8", timeout: 60_000 });
    assert.equal(out.status, 0, out.stdout + out.stderr);
    return out.stdout.trim();
  };

  // Default npm configuration: installed tree and package-lock.json package list match main's npm invocation.
  {
    const { dir, env, entry } = makeIsolated(join(root, "lock-parity-default"));
    const elsewhere = process.platform === "darwin" ? "linux" : "darwin";
    const mkDep = (name: string, extra: Record<string, unknown>) => {
      const d = join(dir, "fixtures", name);
      mkdirSync(d, { recursive: true });
      writeFileSync(join(d, "package.json"), JSON.stringify({ name, version: "1.0.0", ...extra }));
      writeFileSync(join(d, "index.js"), "export default 1;\n");
      return d;
    };
    const optHere = mkDep("probe-opt-here", { os: [process.platform] });
    const optElsewhere = mkDep("probe-opt-elsewhere", { os: [elsewhere] });
    const extSrc = join(dir, "fixtures", "probe-parity-ext");
    mkdirSync(extSrc, { recursive: true });
    writeFileSync(join(extSrc, "package.json"), JSON.stringify({
      name: "probe-parity-ext", version: "1.0.0", type: "module", main: "index.js",
      peerDependencies: { "@cotal-ai/core": "*" },
      optionalDependencies: { "probe-opt-here": `file:${optHere}`, "probe-opt-elsewhere": `file:${optElsewhere}` },
    }));
    writeFileSync(join(extSrc, "index.js"), `import { registry } from "@cotal-ai/core"; registry.register({ kind: "command", name: "probe-parity", summary: "probe", run() {} });\n`);
    const cliAdd = spawnSync(process.execPath, [entry, "ext", "add", extSrc], {
      cwd: dir, env, encoding: "utf8", timeout: 180_000,
    });
    assert.equal(cliAdd.status, 0, cliAdd.stdout + cliAdd.stderr);
    const cliPrefix = queryExtRoot(entry, dir, env);
    const mainPrefix = join(dir, "main-control");
    mkdirSync(mainPrefix, { recursive: true });
    writeFileSync(join(mainPrefix, "package.json"), `${JSON.stringify({ name: "cotal-extensions", private: true }, null, 2)}\n`);
    const realNpm = resolveOnPath("npm", env);
    assert.ok(realNpm, "npm must be on PATH");
    const cliPkg = JSON.parse(readFileSync(join(cliPrefix, "package.json"), "utf8")) as { dependencies: Record<string, string> };
    const mainSpecs = Object.values(cliPkg.dependencies).map(spec => spec.startsWith("file:") ? resolve(cliPrefix, spec.slice(5)) : spec);
    const mainAdd = spawnSync(realNpm, ["install", "--save", "--no-audit", "--no-fund", "--install-links", ...mainSpecs, "--prefix", mainPrefix, "--include=optional", "--legacy-peer-deps"], {
      cwd: dir, env, encoding: "utf8", timeout: 180_000, shell: process.platform === "win32",
    });
    assert.equal(mainAdd.status, 0, mainAdd.stdout + mainAdd.stderr);
    const cliLock = JSON.parse(readFileSync(join(cliPrefix, "package-lock.json"), "utf8")) as { packages: Record<string, unknown> };
    const mainLock = JSON.parse(readFileSync(join(mainPrefix, "package-lock.json"), "utf8")) as { packages: Record<string, unknown> };
    const cliLockKeys = Object.keys(cliLock.packages).sort();
    const mainLockKeys = Object.keys(mainLock.packages).sort();
    const nonCotalDirs = (p: string) => readdirSync(join(p, "node_modules")).filter(n => !n.startsWith(".") && !n.startsWith("@cotal-ai")).sort();
    check("default npm config writes the same lock package list and installed tree as main",
      JSON.stringify(cliLockKeys) === JSON.stringify(mainLockKeys)
      && JSON.stringify(nonCotalDirs(cliPrefix)) === JSON.stringify(nonCotalDirs(mainPrefix))
      && existsSync(join(cliPrefix, "node_modules", "probe-opt-here"))
      && !existsSync(join(cliPrefix, "node_modules", "probe-opt-elsewhere")));
  }

  const server = createServer((req, res) => {
    if (req.url?.startsWith("/refused")) {
      res.writeHead(503, { "content-type": "application/json" }).end(JSON.stringify({ error: "registry unavailable" }));
      return;
    }
    if (req.url === "/cotal-ai") {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
        name: "cotal-ai", "dist-tags": { latest: version }, versions: { [version]: { name: "cotal-ai", version } },
      }));
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolveListen, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolveListen));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const registryUrl = `http://127.0.0.1:${address.port}`;
    const { dir, userNpmrc, env, entry } = makeIsolated(join(root, "lock-override-installed"));
    env.npm_config_registry = registryUrl;
    const extPrefix = queryExtRoot(entry, dir, env);
    const lockPath = join(extPrefix, "package-lock.json");
    const run = async (args: string[], opts?: { cwd?: string; env?: NodeJS.ProcessEnv }): Promise<{ code: number; stdout: string; stderr: string }> => {
      try {
        const out = await execFileAsync(process.execPath, [entry, ...args], {
          cwd: opts?.cwd ?? dir, env: { ...env, ...opts?.env }, timeout: 180_000, maxBuffer: 16 * 1024 * 1024,
        });
        return { code: 0, stdout: out.stdout, stderr: out.stderr };
      } catch (err) {
        const e = err as { code?: number; stdout?: string; stderr?: string };
        return { code: typeof e.code === "number" ? e.code : 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
      }
    };
    const builtInPkgs = [
      "@cotal-ai/connector-claude-code", "@cotal-ai/connector-opencode", "@cotal-ai/connector-codex",
      "@cotal-ai/connector-hermes", "@cotal-ai/connector-jcode", "@cotal-ai/pi", "@cotal-ai/web",
    ];
    const lockCoversBuiltIns = (): boolean => {
      if (!existsSync(lockPath)) return false;
      const lock = JSON.parse(readFileSync(lockPath, "utf8")) as { packages?: Record<string, { version?: string }> };
      return builtInPkgs.every(name => lock.packages?.[`node_modules/${name}`]?.version === version);
    };

    // (a) User .npmrc package-lock=false: seed + damaged built-in update + repeat update keeps lock current and .npmrc byte-identical.
    writeFileSync(userNpmrc, "package-lock=false\n");
    const npmrcBefore = readFileSync(userNpmrc);
    const seeded = await run(["ext", "seed"]);
    assert.equal(seeded.code, 0, seeded.stdout + seeded.stderr);
    const claudeEntry = join(extPrefix, "node_modules/@cotal-ai/connector-claude-code/dist/index.js");
    writeFileSync(claudeEntry, `${readFileSync(claudeEntry, "utf8")}\n`);
    const repaired = await run(["update"]);
    const verified = await run(["update"]);
    const selfCurrent = await run(["update", "--self"]);
    check("user .npmrc package-lock=false: update keeps built-ins current, writes package-lock.json, and leaves .npmrc byte-identical",
      repaired.code === 0 && /refreshed claude\b/.test(repaired.stdout + repaired.stderr)
      && verified.code === 0 && !/reinstalling every built-in|Reconciling built-in/.test(verified.stdout + verified.stderr)
      && selfCurrent.code === 0 && selfCurrent.stdout.includes("installed package closure is current")
      && lockCoversBuiltIns() && readFileSync(userNpmrc).equals(npmrcBefore));

    // (b) Environment npm_config_package_lock=false and working-folder project .npmrc package-lock=false.
    writeFileSync(userNpmrc, "");
    rmSync(lockPath);
    const envRepair = await run(["update"], { env: { npm_config_package_lock: "false" } });
    const envVerify = await run(["update"], { env: { npm_config_package_lock: "false" } });
    check("env npm_config_package_lock=false: update writes package-lock.json and next update verifies built-ins",
      envRepair.code === 0 && lockCoversBuiltIns()
      && envVerify.code === 0 && !/reinstalling every built-in|Reconciling built-in/.test(envVerify.stdout + envVerify.stderr));

    const projectDir = join(dir, "working-project");
    mkdirSync(projectDir, { recursive: true });
    const projectNpmrc = join(projectDir, ".npmrc");
    writeFileSync(projectNpmrc, "package-lock=false\n");
    const projectNpmrcBefore = readFileSync(projectNpmrc);
    rmSync(lockPath);
    const projRepair = await run(["update"], { cwd: projectDir });
    const projVerify = await run(["update"], { cwd: projectDir });
    check("project .npmrc package-lock=false in working folder: update writes prefix lock, next update verifies built-ins, and project .npmrc is untouched",
      projRepair.code === 0 && lockCoversBuiltIns()
      && projVerify.code === 0 && !/reinstalling every built-in|Reconciling built-in/.test(projVerify.stdout + projVerify.stderr)
      && readFileSync(projectNpmrc).equals(projectNpmrcBefore) && !existsSync(join(projectDir, "package-lock.json")));

    // (d) Stale prefix without package-lock.json: first run reinstalls built-ins once, second run changes nothing.
    writeFileSync(userNpmrc, "package-lock=false\n");
    rmSync(lockPath);
    const staleFirst = await run(["update"]);
    const lockDigestAfterFirst = existsSync(lockPath) ? digest(lockPath) : "";
    const staleSecond = await run(["update"]);
    check("stale prefix without package-lock.json repairs built-ins once and next update changes nothing",
      staleFirst.code === 0 && /reinstalling every built-in: the prefix lock is unreadable/.test(staleFirst.stdout + staleFirst.stderr)
      && lockCoversBuiltIns()
      && staleSecond.code === 0 && !/reinstalling every built-in|Reconciling built-in/.test(staleSecond.stdout + staleSecond.stderr)
      && digest(lockPath) === lockDigestAfterFirst);

    // (e) Linked extensions folder with a refused registry: nothing in the live prefix is removed.
    {
      const linkCase = makeIsolated(join(root, "linked-extensions-refused"));
      writeFileSync(linkCase.userNpmrc, "package-lock=false\n");
      const localExt = join(linkCase.dir, "kept-local-ext");
      mkdirSync(localExt, { recursive: true });
      writeFileSync(join(localExt, "package.json"), JSON.stringify({
        name: "kept-local-ext", version: "1.0.0", type: "module", main: "index.js", peerDependencies: { "@cotal-ai/core": "*" },
      }));
      writeFileSync(join(localExt, "index.js"), `import { registry } from "@cotal-ai/core"; registry.register({ kind: "command", name: "kept-local", summary: "kept", run() {} });\n`);
      const seedLocal = spawnSync(process.execPath, [linkCase.entry, "ext", "add", localExt], {
        cwd: linkCase.dir, env: linkCase.env, encoding: "utf8", timeout: 180_000,
      });
      assert.equal(seedLocal.status, 0, seedLocal.stdout + seedLocal.stderr);
      const configuredExt = queryExtRoot(linkCase.entry, linkCase.dir, linkCase.env);
      const realExt = join(linkCase.dir, "real-extensions");
      renameSync(configuredExt, realExt);
      symlinkSync(realExt, configuredExt, "junction");
      const beforeTree = snapshotTree(realExt);
      let refusedCode = 0;
      try {
        await execFileAsync(process.execPath, [linkCase.entry, "ext", "add", "@probe/refused-pkg@1.0.0"], {
          cwd: linkCase.dir,
          env: {
            ...linkCase.env,
            npm_config_registry: `${registryUrl}/refused`,
            npm_config_cache: join(linkCase.dir, "empty-cache"),
            npm_config_fetch_retries: "0",
          },
          timeout: 60_000,
        });
      } catch (err) {
        refusedCode = typeof (err as { code?: number }).code === "number" ? (err as { code: number }).code : 1;
      }
      const afterTree = snapshotTree(realExt);
      check("linked extensions folder with refused registry leaves every live file untouched",
        refusedCode !== 0 && lstatSync(configuredExt).isSymbolicLink()
        && JSON.stringify(afterTree) === JSON.stringify(beforeTree)
        && existsSync(join(realExt, "node_modules", "kept-local-ext", "index.js")));
    }
  } finally {
    await new Promise<void>((resolveClose, reject) => server.close(err => err ? reject(err) : resolveClose()));
  }
}

function recordNpmSpawns(dir: string): { record: string; env: NodeJS.ProcessEnv } {
  const record = join(dir, "npm-spawn.jsonl");
  const preload = join(dir, "record-npm-spawn.cjs");
  writeFileSync(preload, `const cp = require("node:child_process");
const { appendFileSync } = require("node:fs");
const { syncBuiltinESMExports } = require("node:module");
const spawn = cp.spawn;
cp.spawn = (file, args, options) => {
  const command = [file, ...(Array.isArray(args) ? args : [])].join(" ");
  if (/npm/i.test(command) && /\\binstall\\b/.test(command) && command.includes("example-extension")) {
    appendFileSync(${JSON.stringify(record)}, JSON.stringify({ windowsHide: options?.windowsHide }) + "\\n");
  }
  return spawn(file, args, options);
};
syncBuiltinESMExports();
`);
  return { record, env: { NODE_OPTIONS: `--require="${preload}"` } };
}

function checkMissingLocalTarball(
  dir: string,
  prefix: string,
  cli: (args: string[], extra?: NodeJS.ProcessEnv) => { status: number | null; stderr: string },
): void {
  const source = join(dir, "bad-dependency");
  mkdirSync(source);
  writeFileSync(join(source, "package.json"), JSON.stringify({
    name: "cotal-bad-dependency-demo", version: "1.0.0", type: "module", main: "./greeting.mjs",
    peerDependencies: { "@cotal-ai/core": "*" }, dependencies: { "missing-library": "file:./missing-library.tgz" },
  }));
  writeFileSync(join(source, "greeting.mjs"), `import { registry } from "@cotal-ai/core";
registry.register({ kind: "command", name: "demo-bad-dependency", summary: "Print a greeting", run() {} });
`);
  const files = ["package.json", "package-lock.json", "extensions.json"].map(name => join(prefix, name));
  const before = files.map(file => readFileSync(file));
  const refused = cli(["ext", "add", "./bad-dependency"], { npm_config_offline: "true" });
  assert.equal(refused.status, 1, refused.stderr);
  assert.match(refused.stderr, /cotal-bad-dependency-demo: it could not open the tarball for missing-library/);
  assert.match(refused.stderr, /`npm pack --dry-run \.\/bad-dependency`/);
  assert.match(refused.stderr, /absolute path of an existing archive/);
  assert.match(refused.stderr, /`(?:pnpm )?cotal ext add \.\/bad-dependency`/);
  assert.match(refused.stderr, /npm can install from a registry/);
  assert.doesNotMatch(refused.stderr, /\.extensions\.stage-/);
  assert.deepEqual(files.map(file => readFileSync(file)), before);
}

async function main(): Promise<void> {
  const repo = resolve(import.meta.dirname, "../../..");
  const binary = join(repo, "bin", "dist", "cotal.js");
  const source = join(repo, "extensions", "connector-claude-code");
  const keptName = "@cotal-ai/connector-claude-code";
  const digest = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
  const sourceEntry = join(source, "dist", "index.js");
  const sourceDigest = digest(sourceEntry);
  const hostCore = realpathSync(join(repo, "packages", "core"));
  const root = realpathSync(mkdtempSync(join(tmpdir(), "cotal-ext-copies-")));
  let passed = 0, failed = 0;
  const check = (name: string, value: boolean): void => {
    if (value) passed++; else failed++;
    console.log(`  ${value ? "✓" : "✗"} ${name}`);
  };
  // A private home, config prefix and npm configuration under `dir`, and the built CLI run inside it.
  const sandbox = (dir: string) => {
    const home = join(dir, "home");
    const xdg = join(dir, "xdg");
    mkdirSync(join(dir, ".cotal"), { recursive: true });
    mkdirSync(home, { mode: 0o700 });
    mkdirSync(xdg, { mode: 0o700 });
    for (const file of ["user.npmrc", "global.npmrc"]) writeFileSync(join(dir, file), "");
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH, SystemRoot: process.env.SystemRoot,
      HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: xdg, COTAL_HOME: join(home, ".cotal"),
      TMPDIR: dir, TMP: dir, TEMP: dir, DO_NOT_TRACK: "1", COTAL_SKIP_CONNECTOR_SEED: "1",
      npm_config_cache: join(dir, "npm-cache"), npm_config_userconfig: join(dir, "user.npmrc"),
      npm_config_globalconfig: join(dir, "global.npmrc"), npm_config_update_notifier: "false",
    };
    const child = (args: string[], extra?: NodeJS.ProcessEnv) =>
      spawnSync(process.execPath, args, { cwd: dir, env: { ...env, ...extra }, encoding: "utf8", timeout: 180_000 });
    const offline = { npm_config_cache: join(dir, "empty-npm-cache"), npm_config_offline: "true" };
    return { prefix: join(xdg, "cotal", "extensions"), env, child, offline, cli: (args: string[], extra?: NodeJS.ProcessEnv) => child([binary, ...args], extra) };
  };
  try {
    if (process.platform === "linux" || process.platform === "darwin") {
      const dir = join(root, "installed-root");
      const { child, env } = sandbox(dir);
      const pkg = join(dir, "prefix/lib/node_modules/cotal-ai");
      mkdirSync(pkg, { recursive: true });
      cpSync(join(repo, "bin/package.json"), join(pkg, "package.json"));
      cpSync(join(repo, "bin/dist"), join(pkg, "dist"), { recursive: true });
      symlinkSync(join(repo, "bin/node_modules"), join(pkg, "node_modules"));
      const entry = join(pkg, "dist/cotal.js");
      const version = JSON.parse(readFileSync(join(pkg, "package.json"), "utf8")).version as string;
      const expected = join(env.XDG_CONFIG_HOME!, "cotal/installs", createHash("sha256").update(entry).digest("hex"), "sets", version, "cotal/extensions");
      const before = child([entry, "ext", "root"]);
      const listed = child([entry, "ext", "--json"]);
      check("installed root is the retained prefix before initial seeding", before.status === 0 && before.stdout.trim() === expected && listed.status === 0 && JSON.parse(listed.stdout).result.root === expected);
      check("reading the fresh installed root creates no prefix", !existsSync(expected));
      const added = child([entry, "ext", "add", join(repo, "implementations", "acp")]);
      assert.equal(added.status, 0, added.stdout + added.stderr);
      const helpBefore = child([entry, "acp", "--help"]);
      assert.equal(helpBefore.status, 0, helpBefore.stdout + helpBefore.stderr);
      const seeded = child([entry, "ext", "seed"]);
      assert.equal(seeded.status, 0, seeded.stdout + seeded.stderr);
      const after = child([entry, "ext", "root"]);
      check("initial seeding keeps the advertised installed root", after.status === 0 && after.stdout === before.stdout && existsSync(expected));
      const helpAfter = child([entry, "acp", "--help"]);
      check("initial seeding keeps the installed ACP command", helpAfter.status === 0 && helpAfter.stdout === helpBefore.stdout);
      const listAfter = child([entry, "ext", "list", "--json"]);
      const items = listAfter.status === 0 ? JSON.parse(listAfter.stdout).result.items as { pkg: string; seeded: boolean }[] : [];
      check("initial seeding keeps ACP alongside the seven built-ins", items.some(item => item.pkg === "@cotal-ai/acp" && !item.seeded) && items.filter(item => item.seeded).length === 7);
    }
    {
      const dir = join(root, "remove");
      const { prefix, cli, offline } = sandbox(dir);
      const invalidAdd = cli(["ext", "add", source, "unexpected-extra-argument"]);
      check("remove: surplus add operand refuses with usage", invalidAdd.status === 1 && invalidAdd.stderr.includes("ext add <npm-package>"));
      check("remove: invalid add leaves the prefix absent", !existsSync(prefix));
      const added = cli(["ext", "add", source]);
      assert.equal(added.status, 0, `stock connector install failed: ${added.stderr.slice(-800)}`);
      const kept = join(prefix, "node_modules", keptName);
      check("remove: built-in starts as a copy", !lstatSync(kept).isSymbolicLink() && realpathSync(kept) !== realpathSync(source));
      const manifestBefore = readFileSync(join(prefix, "extensions.json"), "utf8");
      const invalidRemove = cli(["ext", "remove", keptName, "unexpected-extra-argument"]);
      check("remove: surplus remove operand refuses with usage", invalidRemove.status === 1 && invalidRemove.stderr.includes("ext remove <name>"));
      check("remove: invalid remove keeps the manifest and installed package", readFileSync(join(prefix, "extensions.json"), "utf8") === manifestBefore && existsSync(join(kept, "dist", "index.js")));
      const before = digest(join(kept, "dist", "index.js"));
      check("remove: installed bytes match built source", before === sourceDigest);
      const siblingName = "@_cotal-test/_copy-remove";
      const sibling = join(dir, "sibling");
      mkdirSync(sibling);
      writeFileSync(join(sibling, "package.json"), JSON.stringify({ name: siblingName, version: "1.0.0", type: "module", main: "index.js", peerDependencies: { "@cotal-ai/core": "*" } }));
      writeFileSync(join(sibling, "index.js"), `import { registry } from "@cotal-ai/core"; registry.register({ kind: "command", name: "copy-sibling", summary: "fixture", run: async () => {} });\n`);
      const installed = cli(["ext", "add", sibling]);
      assert.equal(installed.status, 0, installed.stderr.slice(-800));
      check("remove: adding a sibling preserves the built-in copy", !lstatSync(kept).isSymbolicLink());
      const removed = cli(["ext", "remove", siblingName], offline);
      if (removed.status !== 0) console.error(removed.stderr.trim());
      check("remove: a package with leading underscores in its scope and name is removed offline with an empty npm cache", removed.status === 0);
      check("remove: unrelated built-in remains a copy", !lstatSync(kept).isSymbolicLink() && realpathSync(kept) !== realpathSync(source));
      check("remove: unrelated built-in bytes are unchanged", digest(join(kept, "dist", "index.js")) === before);
      check("remove: operated package is absent", !existsSync(join(prefix, "node_modules", siblingName)));
      const manifest = JSON.parse(readFileSync(join(prefix, "extensions.json"), "utf8")) as { extensions: { pkg: string }[] };
      check("remove: manifest keeps only the built-in", manifest.extensions.length === 1 && manifest.extensions[0]?.pkg === keptName);
      check("remove: source package remains unchanged", digest(sourceEntry) === sourceDigest);
      check("remove: retained core peer matches the running CLI", realpathSync(join(kept, "node_modules", "@cotal-ai", "core")) === hostCore);
    }
    // A fresh seed child installs in place. The renamed Claude bundle already owns the same
    // providers, so the real seed refuses after npm installs the candidate and must remove it.
    {
      const dir = join(root, "seed-refusal");
      const { prefix, cli, offline } = sandbox(dir);
      const alternateName = "cotal-ext-copy-claude";
      const alternate = join(dir, alternateName);
      mkdirSync(alternate);
      writeFileSync(join(alternate, "package.json"), JSON.stringify({ name: alternateName, version: "1.0.0", type: "module", main: "index.js", peerDependencies: { "@cotal-ai/core": "*" } }));
      cpSync(sourceEntry, join(alternate, "index.js"));
      const added = cli(["ext", "add", alternate]);
      assert.equal(added.status, 0, added.stderr);
      const manifestPath = join(prefix, "extensions.json");
      const manifestBefore = readFileSync(manifestPath, "utf8");
      const refused = cli(["ext", "seed", "--force"], { ...offline, COTAL_ALLOW_CHECKOUT_SEED: "1" });
      const collision = refused.status === 1 && refused.stderr.includes('failed to seed connector "claude"')
        && refused.stderr.includes(`already provided by installed extension ${alternateName}@1.0.0`);
      if (!collision) console.error(refused.stdout + refused.stderr);
      check("seed: the offline seed child refuses on the installed provider collision", collision);
      const modules = join(prefix, "node_modules");
      check("seed: the refused candidate is removed from disk", !existsSync(join(modules, keptName)));
      type Dependencies = Record<string, string>;
      const pkg = JSON.parse(readFileSync(join(prefix, "package.json"), "utf8")) as { dependencies: Dependencies };
      const lock = JSON.parse(readFileSync(join(prefix, "package-lock.json"), "utf8")) as { packages: Record<string, { dependencies?: Dependencies }> };
      check("seed: npm metadata records only the survivor as a direct dependency",
        Object.keys(pkg.dependencies).join(",") === alternateName && Object.keys(lock.packages[""]?.dependencies ?? {}).join(",") === alternateName
        && !Object.hasOwn(lock.packages, `node_modules/${keptName}`));
      check("seed: the extension manifest is unchanged", readFileSync(manifestPath, "utf8") === manifestBefore);
      const kept = join(modules, alternateName);
      check("seed: the installed connector stays a copy with unchanged bytes",
        !lstatSync(kept).isSymbolicLink() && digest(join(kept, "index.js")) === sourceDigest);
      check("seed: the surviving core peer matches the running CLI", realpathSync(join(kept, "node_modules", "@cotal-ai", "core")) === hostCore);
    }
    for (const [form, exports] of [
      ["nested", { ".": { import: "./greet.mjs" } }],
      ["shorthand", { import: "./greet.mjs" }],
      ["node-conditional", { ".": { node: { import: "./greet.mjs" }, default: "./fallback.mjs" } }],
    ] as const) {
      const dir = join(root, `exports-entry-${form}`);
      const { prefix, cli } = sandbox(dir);
      const source = join(dir, "example-extension");
      mkdirSync(source);
      const name = "cotal-example-greet";
      const meta = { name, version: "1.0.0", type: "module", exports, peerDependencies: { "@cotal-ai/core": "*" } };
      writeFileSync(join(source, "package.json"), JSON.stringify(meta));
      writeFileSync(join(source, "greet.mjs"), `import { registry } from "@cotal-ai/core";
registry.register({ kind: "command", name: "greet-example", summary: "Print a greeting", run() { console.log("Hello from the extension"); } });
`);
      if (form === "node-conditional") {
        writeFileSync(join(source, "fallback.mjs"), `import { registry } from "@cotal-ai/core";
registry.register({ kind: "command", name: "greet-example", summary: "Print a fallback greeting", run() { console.log("Hello from the fallback"); } });
registry.register({ kind: "command", name: "greet-fallback", summary: "Fallback provider", run() {} });
`);
      }
      const { record, env } = recordNpmSpawns(dir);
      const added = cli(["ext", "add", "./example-extension"], env);
      assert.equal(added.status, 0, `${form} exports-only ext add failed: ${added.stderr.slice(-800)}`);
      if (form === "node-conditional") {
        check("ext add records the Node import providers instead of the default providers",
          added.stdout.includes("command:greet-example") && !added.stdout.includes("command:greet-fallback"));
      }
      check(`ext add passes windowsHide to the actual npm install for the ${form} root export`, existsSync(record) && readFileSync(record, "utf8").trim().split("\n").every(line => JSON.parse(line).windowsHide === true));
      const greeted = cli(["greet-example"]);
      check(`a fresh CLI loads the installed command through its ${form} root export`, greeted.status === 0 && greeted.stdout.trim() === "Hello from the extension");

      if (form !== "nested") continue;
      checkMissingLocalTarball(dir, prefix, cli);
      const manifestPath = join(prefix, "extensions.json");
      const before = readFileSync(manifestPath, "utf8");
      writeFileSync(join(source, "README.md"), "# Greeting extension\n");
      writeFileSync(join(source, "package.json"), JSON.stringify({ ...meta, version: "2.0.0", exports: "./greet.mjs", files: ["README.md"] }));
      const omitted = cli(["ext", "add", "./example-extension"]);
      check("ext add explains when npm omits the local entry", omitted.status === 1 &&
        omitted.stderr.includes(`the installed npm package ${name} is missing its entry \`./greet.mjs\``) &&
        omitted.stderr.includes("`npm pack --dry-run ./example-extension`") &&
        omitted.stderr.includes("include the entry in `files` or generate it") &&
        ["cotal", "pnpm cotal"].some((cmd) => omitted.stderr.includes(`\`${cmd} ext add ./example-extension\``)) &&
        !omitted.stderr.includes(".extensions.stage-") && existsSync(join(source, "greet.mjs")));
      check("a package missing its entry leaves the previous manifest intact", readFileSync(manifestPath, "utf8") === before);

      writeFileSync(join(source, "package.json"), JSON.stringify({ ...meta, version: "2.0.0", main: "./greet.mjs", exports: { ".": "./missing.mjs" } }));
      const refused = cli(["ext", "add", "./example-extension"]);
      check("ext add refuses a missing root export even when main exists", refused.status === 1 && refused.stderr.includes("missing.mjs"));
      check("the refusal leaves the previous installation intact", readFileSync(manifestPath, "utf8") === before && cli(["greet-example"]).stdout.trim() === "Hello from the extension");
    }
    // Two extensions that depend on one package with a bin. The second add's stage carries the bin
    // link the prefix already holds, so its promotion copies a link onto an existing one (#5669).
    {
      const dir = join(root, "shared-bin");
      const { prefix, cli } = sandbox(dir);
      const lib = join(dir, "shared-bin-lib");
      mkdirSync(join(lib, "bin"), { recursive: true });
      writeFileSync(join(lib, "package.json"), JSON.stringify({ name: "shared-bin-lib", version: "1.0.0", bin: { "shared-bin": "bin/shared-bin.js" } }));
      writeFileSync(join(lib, "bin", "shared-bin.js"), "#!/usr/bin/env node\n");
      const extension = (name: string): string => {
        const pkg = join(dir, name);
        mkdirSync(pkg);
        writeFileSync(join(pkg, "package.json"), JSON.stringify({ name, version: "1.0.0", type: "module", main: "index.js", peerDependencies: { "@cotal-ai/core": "*" }, dependencies: { "shared-bin-lib": `file:${lib}` } }));
        writeFileSync(join(pkg, "index.js"), `import { registry } from "@cotal-ai/core"; registry.register({ kind: "command", name: "${name}", summary: "fixture", run: async () => {} });\n`);
        return pkg;
      };
      const link = join(prefix, "node_modules", ".bin", "shared-bin");
      const symlinked = (): boolean => process.platform === "win32" || lstatSync(link, { throwIfNoEntry: false })?.isSymbolicLink() === true;
      const first = cli(["ext", "add", extension("cotal-ext-bin-first")]);
      check("shared bin: the first add leaves the bin link in the prefix", first.status === 0 && symlinked());
      const second = cli(["ext", "add", extension("cotal-ext-bin-second")]);
      if (second.status !== 0) console.log(second.stderr.slice(-800));
      check("shared bin: an add whose stage carries a link the prefix holds commits", second.status === 0);
      const manifest = JSON.parse(readFileSync(join(prefix, "extensions.json"), "utf8")) as { extensions: { pkg: string }[] };
      check("shared bin: both extensions are recorded and installed",
        manifest.extensions.map((e) => e.pkg).sort().join(",") === "cotal-ext-bin-first,cotal-ext-bin-second" &&
          existsSync(join(prefix, "node_modules", "cotal-ext-bin-first")) && existsSync(join(prefix, "node_modules", "cotal-ext-bin-second")));
      check("shared bin: the bin link still reaches the shared package", symlinked() && existsSync(link));
    }
    // Add uses one candidate metadata snapshot too, even when the entry changes its own file.
    for (const damage of [false, true]) {
      const dir = join(root, damage ? "metadata-changed" : "metadata-control");
      const { prefix, cli } = sandbox(dir);
      const name = damage ? "cotal-ext-metadata-changed" : "cotal-ext-metadata-control";
      const source = join(dir, name);
      mkdirSync(source);
      writeFileSync(join(source, "package.json"), JSON.stringify({ name, version: "1.0.0", type: "module", main: "index.js", peerDependencies: { "@cotal-ai/core": "*", "@cotal-ai/workspace": ">=99.0.0" } }));
      writeFileSync(join(source, "index.js"), `import { writeFileSync } from "node:fs";\nimport { registry } from "@cotal-ai/core";\nvoid registry;\n${damage ? 'writeFileSync(new URL("./package.json", import.meta.url), "{corrupt");' : ''}\nawait import("./missing-export.mjs");\n`);
      writeFileSync(join(source, "missing-export.mjs"), 'import { notAnExportOfWorkspace } from "@cotal-ai/workspace";\nvoid notAnExportOfWorkspace;\n');
      const added = cli(["ext", "add", source]);
      check(`${name}: missing-export add refuses`, added.status === 1 && added.stderr.includes("notAnExportOfWorkspace"));
      check(`${name}: diagnosis keeps the validated peer floor`, added.stderr.includes("The installed @cotal-ai/workspace is BEHIND") && added.stderr.includes(">=99.0.0") && !added.stderr.includes("is corrupt or unreadable"));
      check(`${name}: failed add leaves no installed candidate`, !existsSync(join(prefix, "node_modules", name)));
    }
    await checkPackageLockOverride(repo, root, digest, check);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  assert.equal(passed + failed, process.platform === "linux" || process.platform === "darwin" ? 52 : 47, "all expected copy/rollback checks ran");
  console.log(`ext-install-copies smoke: ${passed} passed, ${failed} failed`);
  emitSentinel({ passed, failed });
  process.exit(failed ? 1 : 0);
}

void main();
