/**
 * npm children start under a umask with 022 added. Under a umask of 0002, npm makes group-writable
 * directories, files and bin targets, and its own `--umask` setting leaves package directories and
 * bin targets group-writable, so the CLI sets the process umask around each npm spawn and restores
 * it when the spawn call returns. A stub npm records the umask it starts with. An install an earlier
 * installer left group-writable is repaired without following links. Broker-free; the
 * extension prefix is private to this run.
 *
 * Run: pnpm smoke:npm-umask
 */
import { strict as nodeAssert } from "node:assert";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { countedAssert, emitSentinel, skipSuite } from "@cotal-ai/smoke-kit";
import { claimExtensionUpdatePass, extensionsDir } from "@cotal-ai/workspace";
import { EXT_UPDATE_PARENT_ENV } from "../src/commands/ext.js";
import { repairInstallModes, withInstallUmask } from "../src/lib/install-umask.js";
import { SEED_BUILTINS } from "../src/seed/paths.js";

if (process.platform === "win32") skipSuite("umask is POSIX-only");
const counted = countedAssert(nodeAssert);
const assert: typeof nodeAssert = counted.assert;
const cells = counted.cells;

// The `cotal ext` child must not inherit a managed session's mesh identity from whatever runs this
// suite; it gets only the values set on its own spawn below.
for (const key of Object.keys(process.env)) if (key.startsWith("COTAL_")) delete process.env[key];

const root = mkdtempSync(join(tmpdir(), "cotal-npm-umask-"));
const fakeBin = join(root, "bin");
const recorded = join(root, "npm-umask");
mkdirSync(fakeBin);
// One line per npm child, so an install and its rollback remove are both checked.
writeFileSync(join(fakeBin, "npm"), '#!/bin/sh\numask >> "$FAKE_NPM_UMASK"\nexit 1\n');
chmodSync(join(fakeBin, "npm"), 0o755);
const env = { ...process.env, PATH: `${fakeBin}${delimiter}${process.env.PATH ?? ""}`, FAKE_NPM_UMASK: recorded };
/** The umask of each recorded npm child, then a fresh record. */
function recordedUmasks(): number[] {
  const masks = existsSync(recorded) ? readFileSync(recorded, "utf8").split("\n").filter(Boolean).map((line) => parseInt(line.trim(), 8)) : [];
  rmSync(recorded, { force: true });
  return masks;
}
const stub = () => spawnSync(join(fakeBin, "npm"), [], { env });

const prior = process.umask(0o002);
const priorXdg = process.env.XDG_CONFIG_HOME;
let releasePass: (() => void) | undefined;
try {
  // 1. The helper itself, from a parent umask of 0002.
  withInstallUmask(stub);
  assert.deepEqual(recordedUmasks(), [0o022], "npm starts under 022 from a parent umask of 0002");
  assert.equal(process.umask(0o002), 0o002, "the parent's umask is back once the spawn returns");
  stub();
  assert.deepEqual(recordedUmasks(), [0o002], "a spawn outside the helper still inherits 0002, so the stub reads the real umask");
  process.umask(0o077);
  withInstallUmask(stub);
  assert.deepEqual(recordedUmasks(), [0o077], "a stricter parent umask keeps its bits");
  assert.equal(process.umask(0o002), 0o077, "the stricter umask is restored");
  assert.throws(() => withInstallUmask(() => { throw new Error("spawn refused"); }), /spawn refused/, "a failed spawn propagates");
  assert.equal(process.umask(0o002), 0o002, "a failed spawn still restores the umask");

  // 2. The real `ext __update-add` path, started under 0002: every npm child it runs starts under
  //    022, and the extension prefix it creates is not group-writable.
  const xdg = join(root, "xdg");
  const fixture = join(root, "fixture");
  const pkg = "@cotal-ai/umask-smoke";
  mkdirSync(fixture);
  writeFileSync(join(fixture, "package.json"), JSON.stringify({ name: pkg, version: "1.0.0", type: "module", peerDependencies: { "@cotal-ai/core": "*" } }));
  process.env.XDG_CONFIG_HOME = xdg;
  releasePass = claimExtensionUpdatePass();
  const cli = join(import.meta.dirname, "..", "..", "..", "bin", "cotal.ts");
  const add = spawnSync(
    process.execPath,
    [...process.execArgv, cli, "ext", "__update-add", pkg, fixture],
    { env: { ...env, ...Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith("COTAL_UPDATE_CLOSURE_"))), XDG_CONFIG_HOME: xdg, COTAL_SKIP_CONNECTOR_SEED: "1", [EXT_UPDATE_PARENT_ENV]: String(process.pid) }, encoding: "utf8", timeout: 30_000 },
  );
  assert.notEqual(add.status, 0, `the stub npm fails the add: ${add.stderr}`);
  const masks = recordedUmasks();
  assert.ok(masks.length >= 1, `the add reached npm: ${JSON.stringify({ status: add.status, signal: add.signal, error: add.error?.message, stdout: add.stdout, stderr: add.stderr })}`);
  assert.deepEqual(masks, masks.map(() => 0o022), "every npm child of ext add starts under 022");
  assert.equal(statSync(extensionsDir()).mode & 0o777, 0o755, "the extension prefix is created 0755 under a umask of 0002");
  assert.equal(statSync(join(extensionsDir(), "package.json")).mode & 0o777, 0o644, "the prefix package.json is created 0644 under a umask of 0002");
} finally {
  releasePass?.();
  process.umask(prior);
  if (priorXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = priorXdg;
  rmSync(root, { recursive: true, force: true });
}

// An install an earlier installer left group-writable is repaired: group and other write are removed
// from its own folders and files, other bits stay, and a link is not followed.
{
  const install = mkdtempSync(join(tmpdir(), "cotal-install-modes-"));
  const outside = mkdtempSync(join(tmpdir(), "cotal-install-outside-"));
  try {
    const runtime = join(install, "runtime", "node-v0-linux-x64");
    mkdirSync(join(runtime, "bin"), { recursive: true });
    writeFileSync(join(runtime, "bin", "node"), "");
    writeFileSync(join(outside, "target"), "");
    symlinkSync(join(outside, "target"), join(install, "link"));
    for (const [path, mode] of [[install, 0o775], [join(install, "runtime"), 0o757], [runtime, 0o775], [join(runtime, "bin"), 0o755], [join(runtime, "bin", "node"), 0o775], [join(outside, "target"), 0o666]] as const) chmodSync(path, mode);
    assert.equal(repairInstallModes(install), 4, "the four group- or world-writable entries are repaired");
    for (const [path, mode] of [[install, 0o755], [join(install, "runtime"), 0o755], [runtime, 0o755], [join(runtime, "bin"), 0o755], [join(runtime, "bin", "node"), 0o755]] as const)
      assert.equal(statSync(path).mode & 0o777, mode, `${path.slice(install.length) || "the install root"} is 0${mode.toString(8)} after the repair`);
    assert.equal(statSync(join(outside, "target")).mode & 0o777, 0o666, "a link in the install is not followed");
    assert.equal(repairInstallModes(install), 0, "a repaired install has nothing left to change");
    assert.equal(repairInstallModes(join(install, "missing")), 0, "a missing root, such as a config folder no command has written yet, has nothing to repair");
  } finally {
    rmSync(install, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
}

function ownedSharedWriteEntries(treeRoot: string): string[] {
  const uid = process.getuid!();
  const found: string[] = [];
  const walk = (path: string, rel: string): void => {
    const info = lstatSync(path);
    if (info.isSymbolicLink() || info.uid !== uid) return;
    if ((info.mode & 0o022) !== 0 && (info.isDirectory() || info.isFile())) found.push(rel || ".");
    if (info.isDirectory()) for (const item of readdirSync(path).sort()) walk(join(path, item), rel ? `${rel}/${item}` : item);
  };
  walk(treeRoot, "");
  return found;
}

function runShell(umaskOctal: string, cmd: string, cwd: string, env: NodeJS.ProcessEnv): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolveRun, reject) => {
    const child = spawn("/bin/sh", ["-c", `umask ${umaskOctal} && ${cmd}`], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk.toString(); });
    child.stderr.on("data", chunk => { stderr += chunk.toString(); });
    const timer = setTimeout(() => child.kill("SIGTERM"), 120_000);
    child.once("error", err => { clearTimeout(timer); reject(err); });
    child.once("close", status => { clearTimeout(timer); resolveRun({ status, stdout, stderr }); });
  });
}

async function startSelfUpdateRegistry(sandbox: string, repoBin: string, versionsList: readonly string[], getLatest: () => string) {
  const payloadDir = join(sandbox, "payload", "package");
  mkdirSync(join(payloadDir, "dist"), { recursive: true, mode: 0o700 });
  mkdirSync(join(payloadDir, "scripts"), { recursive: true, mode: 0o700 });
  cpSync(join(repoBin, "dist"), join(payloadDir, "dist"), { recursive: true });
  copyFileSync(join(repoBin, "scripts", "pin-npm-node.cjs"), join(payloadDir, "scripts", "pin-npm-node.cjs"));
  const archives = new Map<string, Buffer>(versionsList.map(ver => {
    writeFileSync(join(payloadDir, "package.json"), JSON.stringify({
      name: "cotal-ai", version: ver, type: "module",
      bin: { cotal: "./dist/cotal.js" }, cotalPreinstall: { v: 1, entry: "./dist/execution-preinstall.js" },
    }, null, 2) + "\n");
    const tgz = join(sandbox, `${ver}.tgz`);
    assert.equal(spawnSync("tar", ["-czf", tgz, "-C", join(sandbox, "payload"), "package"]).status, 0);
    return [ver, readFileSync(tgz)] as const;
  }));
  let serverUrl = "";
  const server = createServer((req, res) => {
    const urlPath = decodeURIComponent((req.url ?? "/").split("?")[0]!);
    if (urlPath.endsWith(".tgz")) {
      const bytes = archives.get(urlPath.slice(1, -4));
      res.writeHead(bytes ? 200 : 404).end(bytes);
      return;
    }
    const latest = getLatest();
    const versions = Object.fromEntries([...archives.entries()].map(([ver, bytes]) => [ver, {
      name: "cotal-ai", version: ver, type: "module",
      bin: { cotal: "./dist/cotal.js" }, cotalPreinstall: { v: 1, entry: "./dist/execution-preinstall.js" },
      dist: { tarball: `${serverUrl}/${ver}.tgz`, integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}` },
    }]));
    const selector = urlPath.replace(/^\/cotal-ai\/?/, "");
    const body = selector ? versions[selector === "latest" ? latest : selector] : { name: "cotal-ai", "dist-tags": { latest }, versions };
    res.writeHead(body ? 200 : 404, { "content-type": "application/json" }).end(JSON.stringify(body ?? {}));
  });
  await new Promise<void>((resolveListen, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolveListen); });
  const addr = server.address();
  assert.ok(addr && typeof addr === "object");
  serverUrl = `http://127.0.0.1:${addr.port}`;
  return { server, serverUrl };
}

async function verifyUnreadableOwnedModeRepairWarning(
  workDir: string, prefix: string, installed: string, cfgCotal: string, currentVersion: string, cleanEnv: NodeJS.ProcessEnv,
): Promise<void> {
  const unreadablePkgDir = join(installed, "unreadable-owned");
  const unreadableCfgDir = join(cfgCotal, "unreadable-owned");
  const unreadableLauncherDir = join(prefix, "unreadable-owned");
  mkdirSync(unreadablePkgDir, { mode: 0o700 });
  mkdirSync(unreadableCfgDir, { mode: 0o700 });
  mkdirSync(unreadableLauncherDir, { mode: 0o700 });
  chmodSync(unreadablePkgDir, 0o000);
  chmodSync(unreadableCfgDir, 0o000);
  chmodSync(unreadableLauncherDir, 0o000);
  chmodSync(join(installed, "package.json"), 0o664);
  try {
    const pkgAndCfgWarn = await runShell("022", "cotal update --self", workDir, cleanEnv);
    assert.equal(pkgAndCfgWarn.status, 0, pkgAndCfgWarn.stdout + pkgAndCfgWarn.stderr);
    assert.match(pkgAndCfgWarn.stdout, /removed group and other write from 1 entry in Cotal's install at /);
    assert.ok(pkgAndCfgWarn.stderr.includes(`Could not finish permission repair in Cotal's install at ${installed} (EACCES).`), pkgAndCfgWarn.stderr);
    assert.ok(pkgAndCfgWarn.stderr.includes(`Could not finish permission repair in Cotal's config at ${cfgCotal} (EACCES).`), pkgAndCfgWarn.stderr);
    assert.equal(statSync(join(installed, "package.json")).mode & 0o777, 0o644);
    const verAfterWarn = await runShell("022", "cotal --version", workDir, cleanEnv);
    assert.equal(verAfterWarn.status, 0, verAfterWarn.stderr);
    assert.equal(verAfterWarn.stdout.split("\n")[0], `cotal-ai ${currentVersion}`);

    chmodSync(unreadablePkgDir, 0o700);
    rmSync(unreadablePkgDir, { recursive: true, force: true });
    const launcherEnv = { ...cleanEnv, COTAL_LAUNCHER: "1", npm_config_prefix: prefix };
    const launcherWarn = await runShell("022", "cotal update --self", workDir, launcherEnv);
    assert.equal(launcherWarn.status, 0, launcherWarn.stdout + launcherWarn.stderr);
    assert.ok(launcherWarn.stderr.includes(`Could not finish permission repair in Cotal's install at ${prefix} (EACCES).`), launcherWarn.stderr);
  } finally {
    for (const dir of [unreadablePkgDir, unreadableCfgDir, unreadableLauncherDir]) {
      try { chmodSync(dir, 0o700); } catch {}
      rmSync(dir, { recursive: true, force: true });
    }
  }
}

async function verifyReadonlyGenerationsModeRepairWarning(
  workDir: string, prefix: string, installed: string, currentVersion: string, cleanEnv: NodeJS.ProcessEnv,
): Promise<void> {
  const generations = join(prefix, "lib", ".cotal-generations");
  const manifest = join(installed, "package.json");
  const warning = `Could not finish permission repair in Cotal's install at ${installed} (EACCES).`;
  const priorMode = statSync(generations).mode & 0o777;
  try {
    for (const cmd of ["cotal update --self", "cotal update"] as const) {
      chmodSync(generations, priorMode);
      chmodSync(manifest, 0o664);
      chmodSync(generations, 0o555);
      const res = await runShell("022", cmd, workDir, cleanEnv);
      assert.equal(res.status, 0, `${cmd} under 0555 .cotal-generations: ${res.stdout + res.stderr}`);
      assert.ok(res.stderr.includes(warning), res.stderr);
      assert.equal(statSync(manifest).mode & 0o777, 0o644);
    }
    const verWhileReadonly = await runShell("022", "cotal --version", workDir, cleanEnv);
    assert.equal(verWhileReadonly.status, 0, verWhileReadonly.stderr);
    assert.equal(verWhileReadonly.stdout.split("\n")[0], `cotal-ai ${currentVersion}`);
  } finally {
    chmodSync(generations, priorMode);
  }
}

async function verifyWritableExtensionStagesSkipped(
  stageParent: string, stageNames: readonly string[], workDir: string, cleanEnv: NodeJS.ProcessEnv,
): Promise<void> {
  const stages = stageNames.map(name => join(stageParent, name));
  try {
    for (const stage of stages) {
      mkdirSync(stage, { mode: 0o700 });
      writeFileSync(join(stage, "marker.txt"), "foreign-or-unverified\n");
      chmodSync(join(stage, "marker.txt"), 0o664);
      chmodSync(stage, 0o777);
    }
    for (const pass of [1, 2]) {
      const res = await runShell("022", "cotal update --self", workDir, cleanEnv);
      assert.equal(res.status, 0, `stage skip pass ${pass}: ${res.stdout + res.stderr}`);
      assert.doesNotMatch(res.stdout, /removed group and other write/, `stage skip pass ${pass} leaves stage modes untouched`);
    }
    for (const stage of stages) {
      assert.ok(existsSync(stage), `${stage} survives two already-current cotal update --self runs`);
      assert.equal(statSync(stage).mode & 0o777, 0o777, `${stage} keeps mode 0777`);
      assert.equal(statSync(join(stage, "marker.txt")).mode & 0o777, 0o664, `${stage} is not descended into`);
    }
  } finally {
    for (const stage of stages) rmSync(stage, { recursive: true, force: true });
  }
}

async function verifyGlobalNpmSelfUpdateModes(): Promise<void> {
  const sandbox = mkdtempSync(join(tmpdir(), "cotal-self-update-modes-"));
  chmodSync(sandbox, 0o700);
  const repoCli = join(import.meta.dirname, ".."), repoBin = join(import.meta.dirname, "..", "..", "..", "bin");
  const currentVersion = (JSON.parse(readFileSync(join(repoBin, "package.json"), "utf8")) as { version: string }).version;
  const oldVersion = "0.1.0";
  let latest = currentVersion;
  const { server, serverUrl } = await startSelfUpdateRegistry(sandbox, repoBin, [oldVersion, currentVersion], () => latest);
  try {
    symlinkSync(join(repoBin, "node_modules"), join(sandbox, "node_modules"));
    for (const dir of ["home", "cotal", "config", "runtime", "tmp", "cache", "work"]) mkdirSync(join(sandbox, dir), { recursive: true, mode: 0o700 });
    const prefix = join(sandbox, "prefix"), installed = join(prefix, "lib", "node_modules", "cotal-ai"), workDir = join(sandbox, "work");
    mkdirSync(prefix, { recursive: true, mode: 0o755 });
    const cleanEnv: NodeJS.ProcessEnv = {
      ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(?:cotal_|npm_config_)/i.test(k))),
      HOME: join(sandbox, "home"), COTAL_HOME: join(sandbox, "cotal"), XDG_CONFIG_HOME: join(sandbox, "config"),
      XDG_RUNTIME_DIR: join(sandbox, "runtime"), TMPDIR: join(sandbox, "tmp"), DO_NOT_TRACK: "1", COTAL_TELEMETRY: "off",
      COTAL_NO_UPDATE_CHECK: "1", PATH: `${join(prefix, "bin")}${delimiter}${process.env.PATH ?? ""}`,
      npm_config_registry: serverUrl, npm_config_cache: join(sandbox, "cache"), npm_config_audit: "false", npm_config_fund: "false",
    };

    const initialInstall = await runShell("002", `npm install -g --prefix '${prefix}' cotal-ai@${currentVersion}`, workDir, cleanEnv);
    assert.equal(initialInstall.status, 0, initialInstall.stdout + initialInstall.stderr);
    assert.ok(ownedSharedWriteEntries(installed).length > 0, "real npm install -g under umask 002 creates group-writable package entries");
    const siblingFile = join(prefix, "lib", "node_modules", "other-pkg", "index.js");
    mkdirSync(join(prefix, "lib", "node_modules", "other-pkg"), { recursive: true, mode: 0o775 });
    writeFileSync(siblingFile, "module.exports = 1;\n");
    chmodSync(siblingFile, 0o664);
    const outsideFile = join(sandbox, "outside-file.txt"), outsideDir = join(sandbox, "outside-dir");
    writeFileSync(outsideFile, "outside\n");
    chmodSync(outsideFile, 0o664);
    mkdirSync(outsideDir, { mode: 0o775 });
    chmodSync(outsideDir, 0o775);
    symlinkSync(outsideFile, join(installed, "external-file-link.txt"));
    symlinkSync(outsideDir, join(installed, "external-dir-link"));

    const cfgCotal = join(sandbox, "config", "cotal");
    const seed = join(cfgCotal, "seed"), extDir = join(cfgCotal, "extensions");
    mkdirSync(seed, { recursive: true, mode: 0o700 });
    mkdirSync(extDir, { recursive: true, mode: 0o775 });
    for (const file of ["authority.json", "authority.bak.json"]) writeFileSync(join(seed, file), JSON.stringify({ everSeeded: SEED_BUILTINS }));
    writeFileSync(join(seed, "witness.json"), JSON.stringify({ initialized: true, firstGeneration: currentVersion }));
    writeFileSync(join(seed, "stamp.json"), JSON.stringify({ generation: currentVersion }));
    writeFileSync(join(extDir, "extensions.json"), JSON.stringify({ extensions: [] }));
    for (const [p, m] of [[extDir, 0o775], [join(extDir, "extensions.json"), 0o664]] as const) chmodSync(p, m);

    const currentRun = await runShell("002", "cotal update --self", workDir, cleanEnv);
    assert.equal(currentRun.status, 0, currentRun.stdout + currentRun.stderr);
    assert.match(currentRun.stdout, /removed group and other write from \d+ (?:entry|entries) in Cotal's install at /);
    assert.match(currentRun.stdout, /removed group and other write from \d+ (?:entry|entries) in Cotal's config at /);
    assert.deepEqual(ownedSharedWriteEntries(installed), [], "already-current self-update hardens the global npm package under umask 002");
    assert.deepEqual(ownedSharedWriteEntries(cfgCotal), [], "already-current self-update hardens config under umask 002");
    assert.equal(statSync(siblingFile).mode & 0o777, 0o664, "unrelated packages in the npm prefix are untouched");
    assert.equal(statSync(outsideFile).mode & 0o777, 0o664, "file symlink inside package pointing outside keeps target mode");
    assert.equal(statSync(outsideDir).mode & 0o777, 0o775, "directory symlink inside package pointing outside keeps target mode");
    rmSync(join(installed, "external-file-link.txt"));
    rmSync(join(installed, "external-dir-link"));

    const quietRetry = await runShell("022", "cotal update --self", workDir, cleanEnv);
    assert.equal(quietRetry.status, 0, quietRetry.stdout + quietRetry.stderr);
    assert.doesNotMatch(quietRetry.stdout, /removed group and other write/);
    await verifyWritableExtensionStagesSkipped(cfgCotal, [".extensions.stage-Ab1234", ".extensions.stage-Gh3456.ready"], workDir, cleanEnv);

    rmSync(prefix, { recursive: true, force: true });
    mkdirSync(prefix, { recursive: true, mode: 0o755 });
    const oldInstall = await runShell("002", `npm install -g --prefix '${prefix}' cotal-ai@${oldVersion}`, workDir, cleanEnv);
    assert.equal(oldInstall.status, 0, oldInstall.stdout + oldInstall.stderr);
    const oldCliDir = join(installed, "node_modules", "@cotal-ai", "cli");
    mkdirSync(oldCliDir, { recursive: true, mode: 0o775 });
    cpSync(join(repoCli, "dist"), join(oldCliDir, "dist"), { recursive: true });
    symlinkSync(join(repoCli, "node_modules"), join(oldCliDir, "node_modules"));
    const cliPkg = JSON.parse(readFileSync(join(repoCli, "package.json"), "utf8")) as Record<string, unknown>;
    writeFileSync(join(oldCliDir, "package.json"), JSON.stringify({ ...cliPkg, version: oldVersion }, null, 2) + "\n");
    writeFileSync(join(seed, "witness.json"), JSON.stringify({ initialized: true, firstGeneration: oldVersion }));
    writeFileSync(join(seed, "stamp.json"), JSON.stringify({ generation: oldVersion }));
    for (const [p, m] of [[oldCliDir, 0o775], [join(oldCliDir, "package.json"), 0o664], [join(extDir, "extensions.json"), 0o664]] as const) chmodSync(p, m);
    assert.ok(ownedSharedWriteEntries(installed).length > 0, "real npm install -g of oldVersion under umask 002 creates group-writable entries");
    latest = currentVersion;
    const upgradeRun = await runShell("002", "cotal update --self", workDir, cleanEnv);
    assert.equal(upgradeRun.status, 0, upgradeRun.stdout + upgradeRun.stderr);
    assert.match(upgradeRun.stdout, /removed group and other write from \d+ (?:entry|entries) in Cotal's install at /);
    assert.ok(upgradeRun.stdout.includes(`cotal-ai@${currentVersion} in use and reconciled`), upgradeRun.stdout);
    assert.deepEqual(ownedSharedWriteEntries(installed), [], "staged upgrade hardens the live npm package under umask 002");
    assert.deepEqual(ownedSharedWriteEntries(join(prefix, "lib", ".cotal-generations")), [], "retained generation store has no group- or world-writable entries");
    assert.deepEqual(ownedSharedWriteEntries(cfgCotal), [], "staged upgrade hardens config under umask 002");
    const verAfterUpgrade = await runShell("002", "cotal --version", workDir, cleanEnv);
    assert.equal(verAfterUpgrade.status, 0, verAfterUpgrade.stderr);
    assert.equal(verAfterUpgrade.stdout.split("\n")[0], `cotal-ai ${currentVersion}`);

    chmodSync(join(installed, "package.json"), 0o664);
    const postUpgradeCurrent = await runShell("022", "cotal update --self", workDir, cleanEnv);
    assert.equal(postUpgradeCurrent.status, 0, postUpgradeCurrent.stdout + postUpgradeCurrent.stderr);
    assert.match(postUpgradeCurrent.stdout, /removed group and other write from 1 entry in Cotal's install at /);
    assert.equal(statSync(join(installed, "package.json")).mode & 0o777, 0o644);
    const verAfterCurrentRepair = await runShell("022", "cotal --version", workDir, cleanEnv);
    assert.equal(verAfterCurrentRepair.status, 0, verAfterCurrentRepair.stderr);
    assert.equal(verAfterCurrentRepair.stdout.split("\n")[0], `cotal-ai ${currentVersion}`, "manifest mode repair on an already-current retained generation preserves launcher selection");

    const installKeys = readdirSync(join(cfgCotal, "installs"));
    assert.equal(installKeys.length, 1, "retained connector reconciliation creates one installation key");
    const setCotalDir = join(cfgCotal, "installs", installKeys[0]!, "sets", currentVersion, "cotal");
    await verifyWritableExtensionStagesSkipped(setCotalDir, [".extensions.stage-Cd5678", ".extensions.stage-Ef9012.ready"], workDir, cleanEnv);
    const foreignSetFile = join(cfgCotal, "installs", "f".repeat(64), "sets", "0.0.0-foreign", "cotal", "extensions", "package.json");
    mkdirSync(join(cfgCotal, "installs", "f".repeat(64), "sets", "0.0.0-foreign", "cotal", "extensions"), { recursive: true, mode: 0o775 });
    writeFileSync(foreignSetFile, "{}\n");
    chmodSync(foreignSetFile, 0o664);
    const foreignPass = await runShell("022", "cotal update --self", workDir, cleanEnv);
    assert.equal(foreignPass.status, 0, foreignPass.stdout + foreignPass.stderr);
    assert.equal(statSync(foreignSetFile).mode & 0o777, 0o664, "another installation's retained set under installs/ is untouched");
    rmSync(join(cfgCotal, "installs", "f".repeat(64)), { recursive: true, force: true });
    await verifyReadonlyGenerationsModeRepairWarning(workDir, prefix, installed, currentVersion, cleanEnv);

    await verifyUnreadableOwnedModeRepairWarning(workDir, prefix, installed, cfgCotal, currentVersion, cleanEnv);
  } finally {
    server.closeAllConnections();
    await new Promise<void>(done => server.close(() => done()));
    rmSync(sandbox, { recursive: true, force: true });
  }
}

await verifyGlobalNpmSelfUpdateModes();

console.log("npm-umask smoke: OK - npm children start under 022 from a parent umask of 0002, a stricter umask keeps its bits, the parent's umask is restored, ext add's npm children, prefix and prefix package.json are not group-writable, and a group-writable install is repaired without following links");
emitSentinel({ passed: cells(), failed: 0 });
