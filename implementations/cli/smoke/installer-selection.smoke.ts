import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { emitSentinel } from "@cotal-ai/smoke-kit";

// Exercise the real POSIX installer main/launcher/PATH/next-step path. Only runtime discovery
// and npm installation are fixtures; this suite does not qualify a downloaded package.
if (process.platform === "win32") {
  console.log("INSTALLER SELECTION: excluded on Windows; install.sh is POSIX-only");
  emitSentinel({ passed: 0, failed: 0 });
  process.exit(0);
}
const root = mkdtempSync(join(tmpdir(), "cotal-installer-selection-"));
const installer = readFileSync(resolve(import.meta.dirname, "../../../install.sh"), "utf8");
const entry = '{ main "$@"; exit $?; }';
assert(installer.trimEnd().endsWith(entry), "installer retains its truncation-safe entry guard");
const library = join(root, "installer-library.sh");
writeFileSync(library, installer.slice(0, installer.lastIndexOf(entry)));
const driver = join(root, "driver.sh");
writeFileSync(driver, `#!/bin/sh
. "$1"
resolve_node() {
  NODE_BIN="$FIXTURE_NODE"
  NPM_BIN="/usr/bin/true"
  NODE_LABEL="fixture runtime"
}
install_cotal() {
  PREVIOUS_VERSION=$(cat "$FIXTURE_VERSION_FILE" 2>/dev/null || true)
  INSTALLED_VERSION="$OPT_VERSION"
  printf '%s\\n' "$INSTALLED_VERSION" > "$FIXTURE_VERSION_FILE"
  mkdir -p "$INSTALL_DIR/bin"
  cat > "$INSTALL_DIR/bin/cotal" <<'CLI'
#!/bin/sh
if [ "\${1:-}" = update ]; then
  printf '%s\\n' "$*" >> "$FIXTURE_UPDATE_ARGS"
  [ "$#" = 1 ] || exit 42
else
  if [ "\${FIXTURE_CRASH:-}" = 1 ]; then
    printf 'startup failed: package export unavailable\\n' >&2
    exit 1
  fi
  printf 'cotal-ai %s\\n' "$(cat "$FIXTURE_VERSION_FILE")"
fi
CLI
  chmod 755 "$INSTALL_DIR/bin/cotal"
}
if [ "\${FIXTURE_TARGET:-}" = latest ]; then
  main --no-setup --no-modify-path
elif [ "\${FIXTURE_MODIFY_PATH:-}" = 1 ]; then
  main --no-setup --version "\${FIXTURE_TARGET:-0.82.2}"
else
  main --no-setup --no-modify-path --version "\${FIXTURE_TARGET:-0.82.2}"
fi
`);
const toolPath = `${dirname(process.execPath)}:/usr/local/bin:/usr/bin:/bin`;
function fixture(label: string) {
  const home = join(root, label + " home's");
  const oldBin = join(home, "old-bin");
  const newBin = join(home, ".local", "bin");
  const marker = join(home, "old-executed");
  mkdirSync(oldBin, { recursive: true });
  mkdirSync(newBin, { recursive: true });
  writeFileSync(join(oldBin, "cotal"), '#!/bin/sh\nprintf "old\\n" >> "$FIXTURE_OLD_MARKER"\nprintf "cotal-ai 0.54.0\\n"\n');
  chmodSync(join(oldBin, "cotal"), 0o755);
  const env = { HOME: home, SHELL: "/bin/bash", CI: "1", NO_COLOR: "1", FIXTURE_NODE: process.execPath, FIXTURE_OLD_MARKER: marker, FIXTURE_VERSION_FILE: join(home, "version"), FIXTURE_UPDATE_ARGS: join(home, "updates") };
  return { home, oldBin, newBin, marker, env };
}
const output = (result: ReturnType<typeof spawnSync>): string => `${result.stdout ?? ""}${result.stderr ?? ""}`;
let passed = false;
try {
  // Execute the documented npm prefix/PATH commands with real npm and an offline package.
  // The separate published-package check covers Cotal's dependency closure and startup.
  const npmHome = join(root, "npm home's");
  const npmPackage = join(root, "npm-package");
  mkdirSync(npmHome);
  mkdirSync(npmPackage);
  const binRoot = resolve(import.meta.dirname, "../../../bin");
  const { engines, scripts } = JSON.parse(readFileSync(join(binRoot, "package.json"), "utf8"));
  const postinstall = scripts.postinstall.replace(/^node /, "");
  writeFileSync(join(npmPackage, "package.json"), JSON.stringify({ name: "cotal-ai", version: "0.0.0", bin: { cotal: "dist/cotal.js" }, engines, scripts: { postinstall: scripts.postinstall } }));
  mkdirSync(join(npmPackage, "dist"));
  mkdirSync(join(npmPackage, "scripts"));
  copyFileSync(join(binRoot, postinstall), join(npmPackage, postinstall));
  writeFileSync(join(npmPackage, "dist/cotal.js"), '#!/usr/bin/env node\nconsole.log(process.argv[2] === "--entry" ? process.argv[1] : "cotal-ai 0.0.0");\n', { mode: 0o755 });
  const installation = readFileSync(resolve(import.meta.dirname, "../../../docs/installation.mdx"), "utf8");
  assert(installation.includes("`wget` instead of `curl`") && installation.includes("wget -qO- https://get.cotal.ai | sh -s -- --no-setup"), "the install guide offers the wget bootstrap");
  const shellLauncher = join(npmHome, ".local", "bin", "cotal");
  mkdirSync(dirname(shellLauncher), { recursive: true });
  const shellLauncherBody = "#!/bin/sh\nprintf 'shell installer launcher\\n'\n";
  writeFileSync(shellLauncher, shellLauncherBody, { mode: 0o755 });
  const npmSection = installation.split("## Install with npm")[1]?.split("## ")[0];
  const npmSteps = npmSection?.match(/```bash\n([^`]+)```/)?.[1];
  assert(npmSteps, "npm instructions include a shell command block");
  assert(npmSteps.includes('npm config set prefix "$HOME/.npm-global"'), "npm instructions select a prefix separate from the shell launcher");
  assert(npmSteps.includes('export PATH="$HOME/.npm-global/bin:$PATH"'), "npm instructions put the prefix's bin directory first on PATH");
  assert(npmSteps.includes("npm install -g cotal-ai"), "npm instructions retain the global install command");
  const npmEnv = {
    HOME: npmHome, PATH: `${dirname(shellLauncher)}:${toolPath}`, CI: "1", NO_COLOR: "1",
    npm_config_userconfig: join(npmHome, ".npmrc"),
    npm_config_globalconfig: join(npmHome, "global-npmrc"),
    npm_config_cache: join(npmHome, ".npm"),
    npm_config_registry: "http://127.0.0.1:9",
    FIXTURE_PACKAGE: npmPackage,
  };
  const npmInstall = spawnSync("/bin/sh", ["-c", `set -eu\n${npmSteps.replace("npm install -g cotal-ai", 'archive=$(npm pack "$FIXTURE_PACKAGE" --offline --pack-destination "$HOME" --silent)\nnpm install -g "$HOME/$archive" --offline --no-audit --no-fund')}\ncotal --version`], { env: npmEnv, encoding: "utf8", timeout: 30_000 });
  assert.equal(npmInstall.status, 0, output(npmInstall));
  assert(output(npmInstall).includes("cotal-ai 0.0.0"), "the documented PATH selects npm's installed executable, including with spaces and quotes in HOME");
  const npmPrefix = spawnSync("npm", ["prefix", "-g"], { env: npmEnv, encoding: "utf8", timeout: 10_000 });
  assert.equal(npmPrefix.status, 0, output(npmPrefix));
  assert.equal(npmPrefix.stdout.trim(), join(npmHome, ".npm-global"), "the documented npm prefix persists for future global installs");
  assert.equal(readFileSync(shellLauncher, "utf8"), shellLauncherBody, "switching the selected CLI does not overwrite the shell launcher");
  const npmLauncher = join(npmHome, ".npm-global/bin/cotal");
  const npmLink = readlinkSync(npmLauncher);
  const bootstrap = realpathSync(join(npmHome, ".npm-global/lib/node_modules/cotal-ai/dist/cotal.js"));
  assert.equal(realpathSync(npmLauncher), join(dirname(bootstrap), "cotal-npm"), "npm's executable links to the shell launcher");
  const noNode = spawnSync(npmLauncher, ["--version"], { env: { ...npmEnv, PATH: dirname(npmLauncher) }, encoding: "utf8", timeout: 10_000 });
  assert.equal(noNode.status, 0, output(noNode));
  assert.equal(noNode.stdout.trim(), "cotal-ai 0.0.0", "npm launcher uses the install-time Node without Node on PATH");
  const launched = spawnSync(npmLauncher, ["--entry"], { env: { ...npmEnv, PATH: dirname(npmLauncher) }, encoding: "utf8", timeout: 10_000 });
  assert.equal(launched.status, 0, output(launched));
  assert.equal(realpathSync(launched.stdout.trim()), bootstrap, "the shell launcher runs the stable JavaScript entry");
  const daemonDir = join(npmHome, "cotal", "daemon");
  mkdirSync(daemonDir, { recursive: true });
  writeFileSync(join(daemonDir, "service-unit.json"), "{}\n");
  // The defaults no longer collide. Explicitly point the installer at npm's bin to test refusal.
  const cutover = spawnSync("/bin/sh", [resolve(import.meta.dirname, "../../../install.sh"), "--no-setup", "--no-modify-path"], {
    env: { ...npmEnv, COTAL_HOME: dirname(daemonDir), COTAL_BIN_DIR: dirname(npmLauncher) }, encoding: "utf8", timeout: 10_000,
  });
  assert.equal(cutover.status, 1, output(cutover));
  assert.match(output(cutover), /belongs to an npm installation and a Cotal daemon service is recorded/);
  assert.equal(readlinkSync(npmLauncher), npmLink, "the refused switch keeps npm's launcher");
  assert(!existsSync(join(npmHome, ".local/share/cotal")), "the refusal does not stage a second installation");
  const removeSection = installation.split("## Remove Cotal")[1]?.split("## ")[0];
  const removeSteps = removeSection?.match(/```bash\n([^`]+)```/)?.[1];
  assert(removeSteps, "npm removal instructions include a shell command block");
  assert(removeSteps.includes('rm -rf "$(npm root -g)/../.cotal-generations"'), "npm removal instructions clean up the retained generation store");
  assert(removeSteps.includes("npm uninstall -g cotal-ai"), "npm removal instructions uninstall the global package");
  const fakeGen = join(npmHome, ".npm-global", "lib", ".cotal-generations", "deadbeef");
  mkdirSync(fakeGen, { recursive: true });
  writeFileSync(join(fakeGen, "inventory.json"), "[]");
  const npmRemove = spawnSync("/bin/sh", ["-c", `set -eu\n${removeSteps}`], { env: npmEnv, encoding: "utf8", timeout: 30_000 });
  assert.equal(npmRemove.status, 0, output(npmRemove));
  assert(!existsSync(join(npmHome, ".npm-global", "lib", ".cotal-generations")), "documented npm removal deletes .cotal-generations");
  assert(!existsSync(join(npmHome, ".npm-global", "bin", "cotal")), "documented npm removal deletes the npm executable");
  assert.equal(readFileSync(shellLauncher, "utf8"), shellLauncherBody, "npm removal leaves the shell launcher intact");
  console.log("NPM INSTALL: documented user-owned prefix, PATH, and uninstall commands passed with real npm (offline package)");

  const shadow = fixture("shadow");
  const shadowed = spawnSync("/bin/sh", [driver, library], { env: { ...shadow.env, PATH: `${shadow.oldBin}:${shadow.newBin}:${toolPath}` }, encoding: "utf8" });
  assert.equal(shadowed.status, 0, output(shadowed));
  assert(output(shadowed).includes("Your PATH does not select the Cotal just installed."), "installer warns when the new directory is on PATH but an old executable wins");
  assert(output(shadowed).includes("type -a cotal") && output(shadowed).includes("cached commands, aliases or functions"), "installer explains the parent-shell selection boundary");
  assert(!existsSync(shadow.marker), "installer never executes the shadowing old command to diagnose it");
  const quote = (value: string): string => "'" + value.replaceAll("'", "'\\''") + "'";
  for (const command of ["setup", "up --detach", "spawn"])
    assert(output(shadowed).includes(`${quote(join(shadow.newBin, "cotal"))} ${command}`), `installer next step uses its absolute safely quoted executable: ${command}`);

  if (process.platform === "linux") {
    const installForBash = (f: ReturnType<typeof fixture>) => spawnSync("/bin/sh", [driver, library], {
      env: { ...f.env, PATH: toolPath, FIXTURE_MODIFY_PATH: "1" }, encoding: "utf8",
    });
    const bash = (f: ReturnType<typeof fixture>, flags: string, command: string) => spawnSync("/bin/bash", [flags, `test "$HOME" = "$1" && ${command}`, "bash", f.home], {
      env: { ...f.env, PATH: toolPath }, encoding: "utf8", timeout: 10_000,
    });
    const clean = fixture("clean-bash");
    const cleanInstall = installForBash(clean);
    assert.equal(cleanInstall.status, 0, output(cleanInstall));
    assert(output(cleanInstall).includes("PATH updated in ~/.bashrc, ~/.profile"));
    for (const flags of ["-ilc", "-ic"]) {
      const shell = bash(clean, flags, "cotal --version");
      assert.equal(shell.status, 0, output(shell));
      assert.equal(shell.stdout.trim(), "cotal-ai 0.82.2");
    }

    const existing = fixture("existing-bash");
    const previousRc = '# cotal\nexport PATH=' + quote(existing.newBin) + ':"$PATH"\n';
    writeFileSync(join(existing.home, ".bashrc"), previousRc);
    const login = join(existing.home, ".bash_login");
    writeFileSync(login, 'printf "bash login ran\\n"\n. "$HOME/.bashrc"\n');
    writeFileSync(join(existing.home, ".profile"), 'printf "wrong profile\\n"\n');
    const existingInstall = installForBash(existing);
    assert.equal(existingInstall.status, 0, output(existingInstall));
    assert(output(existingInstall).includes("PATH updated in ~/.bash_login"));
    const existingLogin = bash(existing, "-ilc", 'cotal --version && printf "%s\\n" "$PATH"');
    assert.equal(existingLogin.status, 0, output(existingLogin));
    const [profileRan, installedVersion, loginPath] = existingLogin.stdout.trim().split("\n");
    assert.equal(profileRan, "bash login ran");
    assert.equal(installedVersion, "cotal-ai 0.82.2");
    assert.equal(loginPath.split(":").filter((dir) => dir === existing.newBin).length, 1);
    const loginBefore = readFileSync(login, "utf8");
    const rerun = installForBash(existing);
    assert.equal(rerun.status, 0, output(rerun));
    assert.equal(readFileSync(join(existing.home, ".bashrc"), "utf8"), previousRc);
    assert.equal(readFileSync(login, "utf8"), loginBefore);
    assert(!existsSync(join(existing.home, ".bash_profile")), "installer does not mask an existing .bash_login");

    const linked = fixture("linked-bash");
    const outsideProfile = join(root, "outside-profile");
    writeFileSync(outsideProfile, "# do not change\n");
    symlinkSync(outsideProfile, join(linked.home, ".bash_profile"));
    const linkedInstall = installForBash(linked);
    assert.equal(linkedInstall.status, 0, output(linkedInstall));
    assert(output(linkedInstall).includes("Add that export to: ~/.bash_profile"));
    assert(output(linkedInstall).includes("PATH updated in ~/.bashrc"));
    assert.equal(readFileSync(outsideProfile, "utf8"), "# do not change\n");
    assert(!existsSync(join(linked.home, ".profile")), "installer does not bypass the active login file");
    console.log("BASH PATH: clean login and non-login shells, existing profile, reinstall, and an external profile symlink passed");
  }

  const broken = fixture("broken");
  const crashed = spawnSync("/bin/sh", [driver, library], { env: { ...broken.env, FIXTURE_CRASH: "1", PATH: `${broken.newBin}:${toolPath}` }, encoding: "utf8" });
  assert.equal(crashed.status, 1, output(crashed));
  assert(output(crashed).includes("startup failed: package export unavailable"), "installer preserves the installed command's startup error");
  assert(output(crashed).includes("without --version"), "installer gives a recovery command selection");
  assert(!output(crashed).includes("✓ Cotal") && !output(crashed).includes("get your machine ready"), "failed startup never prints installation success or setup instructions");

  const latestBroken = fixture("latest-broken");
  const latestCrashed = spawnSync("/bin/sh", [driver, library], { env: { ...latestBroken.env, FIXTURE_TARGET: "latest", FIXTURE_CRASH: "1", PATH: `${latestBroken.newBin}:${toolPath}` }, encoding: "utf8" });
  assert.equal(latestCrashed.status, 1, output(latestCrashed));
  assert(output(latestCrashed).includes("startup failed: package export unavailable"), "latest failure preserves the startup error");
  assert(output(latestCrashed).includes("The latest Cotal release could not start.") && output(latestCrashed).includes("Report the error above at https://github.com/Cotal-AI/Cotal/issues"), "latest failure names the issue tracker");
  assert(!output(latestCrashed).includes("without --version"), "latest failure does not recommend the same installation again");
  assert(!output(latestCrashed).includes("✓ Cotal") && !output(latestCrashed).includes("get your machine ready"), "latest failure prints no success or setup instructions");

  const obstructed = fixture("launcher-directory");
  const occupiedLauncher = join(obstructed.newBin, "cotal");
  mkdirSync(occupiedLauncher);
  writeFileSync(join(occupiedLauncher, "sentinel"), "keep-me\n");
  const blocked = spawnSync("/bin/sh", [driver, library], { env: { ...obstructed.env, PATH: toolPath }, encoding: "utf8" });
  assert.equal(blocked.status, 1, output(blocked));
  assert.deepEqual(readdirSync(occupiedLauncher), ["sentinel"], "refusal does not leave a hidden launcher inside the directory");
  assert.equal(readFileSync(join(occupiedLauncher, "sentinel"), "utf8"), "keep-me\n");
  assert(!existsSync(join(obstructed.home, ".local/share/cotal")), "refusal leaves the install root absent");
  assert(output(blocked).includes(`${quote(occupiedLauncher)} is a directory.`), "refusal names the obstructing path");
  assert.match(output(blocked), /Move the directory aside or set COTAL_BIN_DIR/);

  const selected = fixture("selected");
  const direct = spawnSync("/bin/sh", [driver, library], { env: { ...selected.env, PATH: `${selected.newBin}:${selected.oldBin}:${toolPath}` }, encoding: "utf8" });
  assert.equal(direct.status, 0, output(direct));
  assert(!output(direct).includes("Your PATH does not select"), "installer does not report a PATH conflict when its launcher wins");
  const aliasBin = join(selected.home, "same-launcher");
  mkdirSync(aliasBin);
  symlinkSync(join(selected.newBin, "cotal"), join(aliasBin, "cotal"));
  const same = spawnSync("/bin/sh", [driver, library], { env: { ...selected.env, PATH: `${aliasBin}:${selected.newBin}:${toolPath}` }, encoding: "utf8" });
  assert.equal(same.status, 0, output(same));
  assert(!output(same).includes("Your PATH does not select"), "a symlink to the same launcher is not a different installation");

  const cache = fixture("cache");
  const parent = spawnSync("/bin/bash", ["--noprofile", "--norc", "-c", `
set -eu
cotal --version
/bin/sh "$1" "$2"
printf 'PARENT_AFTER='
cotal --version
printf 'ABSOLUTE_AFTER='
"$HOME/.local/bin/cotal" --version
hash -r
printf 'REFRESHED_AFTER='
cotal --version
`, "parent", driver, library], { env: { ...cache.env, PATH: `${cache.newBin}:${cache.oldBin}:${toolPath}` }, encoding: "utf8" });
  assert.equal(parent.status, 0, output(parent));
  assert(output(parent).includes("PARENT_AFTER=cotal-ai 0.54.0"), "a child installer cannot silently replace its parent's naturally cached command");
  assert(output(parent).includes("ABSOLUTE_AFTER=cotal-ai 0.82.2"), "the printed absolute launcher runs the newly installed version despite the parent cache");
  assert(output(parent).includes("REFRESHED_AFTER=cotal-ai 0.82.2"), "refreshing the parent cache selects the new earlier PATH executable");
  const pinned = fixture("pinned");
  const pinnedEnv = { ...pinned.env, PATH: `${pinned.newBin}:${toolPath}` };
  const initial = spawnSync("/bin/sh", [driver, library], { env: pinnedEnv, encoding: "utf8" });
  assert.equal(initial.status, 0, output(initial));
  assert(!existsSync(pinned.env.FIXTURE_UPDATE_ARGS), "first installation needs no reconciliation");
  const retained = fixture("retained-service");
  const daemonState = join(retained.home, ".cotal", "daemon");
  mkdirSync(daemonState, { recursive: true });
  writeFileSync(join(daemonState, "service-unit.json"), "{}");
  const reinstalled = spawnSync("/bin/sh", [driver, library], { env: { ...retained.env, PATH: `${retained.newBin}:${toolPath}` }, encoding: "utf8" });
  assert.equal(reinstalled.status, 0, output(reinstalled));
  assert.equal(readFileSync(retained.env.FIXTURE_UPDATE_ARGS, "utf8"), "update\n", "retained native receipt triggers reconciliation without a previous package");
  const downgrade = spawnSync("/bin/sh", [driver, library], { env: { ...pinnedEnv, FIXTURE_TARGET: "0.82.1" }, encoding: "utf8" });
  assert.equal(downgrade.status, 0, output(downgrade));
  assert.equal(readFileSync(pinned.env.FIXTURE_UPDATE_ARGS, "utf8"), "update\n", "rerun reconciles the selected release without --self");
  const version = spawnSync(join(pinned.newBin, "cotal"), ["--version"], { env: pinnedEnv, encoding: "utf8" });
  assert.equal(version.stdout.trim(), "cotal-ai 0.82.1", "the launcher retains the explicitly selected older release");

  // Keep the real npm staging, startup check and promotion functions. Only the downloaded
  // package bytes are offline fixtures, including a requested release that cannot start.
  const staged = fixture("staged");
  const npmFixture = join(root, "npm-fixture.sh");
  writeFileSync(npmFixture, `#!/bin/sh
while [ "$#" -gt 0 ]; do
  if [ "$1" = --prefix ]; then prefix=$2; shift; fi
  spec=$1
  shift
done
version=\${spec#*@}
mkdir -p "$prefix/lib/node_modules/cotal-ai/dist" "$prefix/bin"
printf '{"name":"cotal-ai","version":"%s"}\\n' "$version" > "$prefix/lib/node_modules/cotal-ai/package.json"
if [ "$version" = 0.0.2 ]; then
  printf '#!/usr/bin/env node\\nthrow new Error("requested release cannot start");\\n' > "$prefix/lib/node_modules/cotal-ai/dist/cotal.js"
else
  printf '#!/usr/bin/env node\\nif(process.argv[2]!=="update")console.log("cotal-ai %s");\\n' "$version" > "$prefix/lib/node_modules/cotal-ai/dist/cotal.js"
fi
chmod 755 "$prefix/lib/node_modules/cotal-ai/dist/cotal.js"
ln -s "../lib/node_modules/cotal-ai/dist/cotal.js" "$prefix/bin/cotal"
`);
  chmodSync(npmFixture, 0o755);
  const stagingDriver = join(root, "staging-driver.sh");
  writeFileSync(stagingDriver, `. "$1"
resolve_node() { NODE_BIN="$FIXTURE_NODE"; NPM_BIN="$FIXTURE_NPM"; NODE_LABEL="fixture runtime"; }
main --no-setup --no-modify-path --version "$FIXTURE_TARGET"
`);
  const stagingEnv = { ...staged.env, PATH: `${staged.newBin}:${toolPath}`, FIXTURE_NPM: npmFixture, COTAL_SKIP_CONNECTOR_SEED: "1", COTAL_NO_UPDATE_CHECK: "1" };
  const stageRun = (target: string) => spawnSync("/bin/sh", [stagingDriver, library], { env: { ...stagingEnv, FIXTURE_TARGET: target }, encoding: "utf8", timeout: 90_000 });
  const working = stageRun("0.0.1");
  assert.equal(working.status, 0, output(working));
  const launcher = join(staged.newBin, "cotal"), prefix = join(staged.home, ".local/share/cotal");
  const launcherBefore = readFileSync(launcher, "utf8");
  const packageBefore = readFileSync(join(prefix, "lib/node_modules/cotal-ai/dist/cotal.js"), "utf8");
  const nodeBefore = realpathSync(join(prefix, "nodebin/node"));
  const refused = stageRun("0.0.2");
  assert.equal(refused.status, 1, output(refused));
  assert(output(refused).includes("requested release cannot start"), "requested release fails the real staged startup check");
  assert.equal(readFileSync(launcher, "utf8"), launcherBefore, "failed staging leaves the launcher unchanged");
  assert.equal(readFileSync(join(prefix, "lib/node_modules/cotal-ai/dist/cotal.js"), "utf8"), packageBefore, "failed staging leaves the active package unchanged");
  assert.equal(realpathSync(join(prefix, "nodebin/node")), nodeBefore, "failed staging keeps the previous runtime pin");
  const preserved = spawnSync(launcher, ["--version"], { env: stagingEnv, encoding: "utf8", timeout: 60_000 });
  assert.equal(preserved.status, 0, output(preserved));
  assert.equal(preserved.stdout.trim(), "cotal-ai 0.0.1", "previous installation still starts after refusal");
  assert(!readdirSync(prefix).some(name => name.startsWith(".install-stage.")), "failed staging cleans its private prefix");
  assert.equal(stageRun("0.0.3").status, 0, "a later working requested release still installs");
  assert.equal(spawnSync(launcher, ["--version"], { env: stagingEnv, encoding: "utf8" }).stdout.trim(), "cotal-ai 0.0.3");

  const systemBin = join(staged.home, "system-bin");
  mkdirSync(systemBin);
  const stableNode = join(systemBin, "node");
  for (const name of ["node-22", "node-24"])
    writeFileSync(join(systemBin, name), `#!/bin/sh\nexec ${quote(process.execPath)} "$@"\n`, { mode: 0o755 });
  symlinkSync("node-22", stableNode);
  const switchedEnv = { ...stagingEnv, PATH: `${systemBin}:${stagingEnv.PATH}`, FIXTURE_NODE: stableNode, FIXTURE_TARGET: "0.0.3" };
  const linked = spawnSync("/bin/sh", [stagingDriver, library], { env: switchedEnv, encoding: "utf8", timeout: 90_000 });
  assert.equal(linked.status, 0, output(linked));
  assert.equal(readlinkSync(join(prefix, "nodebin/node")), stableNode, "installer keeps the stable executable path");
  rmSync(stableNode);
  symlinkSync("node-24", stableNode);
  rmSync(join(systemBin, "node-22"));
  const afterSwitch = spawnSync(launcher, ["--version"], { env: switchedEnv, encoding: "utf8" });
  assert.equal(afterSwitch.status, 0, output(afterSwitch));
  assert.equal(afterSwitch.stdout.trim(), "cotal-ai 0.0.3", "the unchanged launcher works after a system runtime switch");
  rmSync(stableNode);
  const missingNode = spawnSync(launcher, ["--version"], { env: switchedEnv, encoding: "utf8" });
  assert.equal(missingNode.status, 1, output(missingNode));
  assert.match(missingNode.stderr, /Repair it by re-running the installer/);

  // Real runtime discovery and linking, including relative links and nodebin on PATH.
  const runtimeHome = join(root, "runtime home's");
  const runtimeBin = join(runtimeHome, "runtime", "bin");
  const nodebin = join(runtimeHome, ".local", "share", "cotal", "nodebin");
  mkdirSync(runtimeBin, { recursive: true });
  mkdirSync(nodebin, { recursive: true });
  for (const [name, target] of [["node", process.execPath], ["npm", "/usr/bin/true"], ["npx", "/usr/bin/true"]]) {
    symlinkSync(target, join(runtimeBin, name));
    symlinkSync(`../../../../runtime/bin/${name}`, join(nodebin, name));
  }
  const relink = spawnSync("/bin/sh", ["-c", '. "$1"; resolve_node; link_node_bin; resolve_node; link_node_bin', "runtime", library], {
    env: { HOME: runtimeHome, PATH: `${nodebin}:${toolPath}` }, encoding: "utf8",
  });
  assert.equal(relink.status, 0, output(relink));
  for (const name of ["node", "npm", "npx"])
    assert.equal(realpathSync(join(nodebin, name)), realpathSync(join(runtimeBin, name)), `${name} retains its physical target across repeated relinking`);
  const nodeVersion = spawnSync(join(nodebin, "node"), ["--version"], { encoding: "utf8" });
  assert.equal(nodeVersion.stdout.trim(), process.version, "the relinked runtime remains executable");

  // #7630: lock remedies, unwritable parent ls -ld, and manual export PATH must shquote file paths.
  const spaceLockHome = join(root, "lock space 'home");
  const lockDir = join(spaceLockHome, ".local", "share", "cotal", ".install-lock");
  mkdirSync(lockDir, { recursive: true });
  const dirLock = spawnSync("/bin/sh", [resolve(import.meta.dirname, "../../../install.sh"), "--no-setup"], {
    env: { HOME: spaceLockHome, PATH: toolPath, CI: "1", NO_COLOR: "1" }, encoding: "utf8",
  });
  assert.equal(dirLock.status, 1, output(dirLock));
  assert(output(dirLock).includes(`rm -rf ${quote(lockDir)}`), "directory lock remedy quotes paths containing spaces and quotes");
  rmSync(lockDir, { recursive: true, force: true });
  symlinkSync(`otherhost:12345`, lockDir);
  const crossLock = spawnSync("/bin/sh", [resolve(import.meta.dirname, "../../../install.sh"), "--no-setup"], {
    env: { HOME: spaceLockHome, PATH: toolPath, CI: "1", NO_COLOR: "1" }, encoding: "utf8",
  });
  assert.equal(crossLock.status, 1, output(crossLock));
  assert(output(crossLock).includes(`rm -f ${quote(lockDir)}`), "cross-host lock remedy quotes paths containing spaces and quotes");
  rmSync(lockDir, { force: true });
  symlinkSync(`${spawnSync("uname", ["-n"], { encoding: "utf8" }).stdout.trim()}:${process.pid}`, lockDir);
  const liveLock = spawnSync("/bin/sh", [resolve(import.meta.dirname, "../../../install.sh"), "--no-setup"], {
    env: { HOME: spaceLockHome, PATH: toolPath, CI: "1", NO_COLOR: "1" }, encoding: "utf8",
  });
  assert.equal(liveLock.status, 1, output(liveLock));
  assert(output(liveLock).includes(`rm -f ${quote(lockDir)}`), "live lock remedy quotes paths containing spaces and quotes");

  if (typeof process.getuid === "function" && process.getuid() !== 0) {
    const roParent = join(root, "ro space \"parent");
    mkdirSync(roParent, { recursive: true, mode: 0o500 });
    try {
      const unwritable = spawnSync("/bin/sh", [resolve(import.meta.dirname, "../../../install.sh"), "--no-setup"], {
        env: { HOME: spaceLockHome, COTAL_INSTALL_DIR: join(roParent, "cotal"), PATH: toolPath, CI: "1", NO_COLOR: "1" }, encoding: "utf8",
      });
      assert.equal(unwritable.status, 1, output(unwritable));
      assert(output(unwritable).includes(`ls -ld ${quote(roParent)}`), "unwritable install parent ls -ld remedy quotes paths containing spaces and quotes");
    } finally {
      chmodSync(roParent, 0o700);
    }
  }

  const manualHome = fixture("manual-quote");
  const weirdBin = join(manualHome.home, 'bin "dir$x');
  const manualRun = spawnSync("/bin/sh", [driver, library], {
    env: { ...manualHome.env, COTAL_BIN_DIR: weirdBin, PATH: toolPath }, encoding: "utf8",
  });
  assert.equal(manualRun.status, 0, output(manualRun));
  const expectedExport = `export PATH=${quote(weirdBin)}:"$PATH"`;
  assert(output(manualRun).includes(expectedExport), "manual PATH export quotes BIN_DIR safely against quotes and parameter expansion");
  const evalExport = spawnSync("/bin/sh", ["-c", `set -eu\n${expectedExport}\nprintf '%s' "\${PATH%%:*}"`], {
    env: { PATH: "/usr/bin:/bin", x: "UNSAFE" }, encoding: "utf8",
  });
  assert.equal(evalExport.status, 0, output(evalExport));
  assert.equal(evalExport.stdout, weirdBin, "manual PATH export evaluates to the exact literal BIN_DIR");

  console.log("INSTALLER SELECTION: all real-shell main-path controls passed");
  emitSentinel({ passed: process.platform === "linux" ? 114 : 93, failed: 0 });
  passed = true;
} finally {
  if (passed) rmSync(root, { recursive: true, force: true });
  else console.error(`installer selection fixture retained: ${root}`);
}
