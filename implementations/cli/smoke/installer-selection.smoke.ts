import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
  writeFileSync(join(npmPackage, "package.json"), JSON.stringify({ name: "cotal-ai", version: "0.0.0", bin: { cotal: "cotal.js" } }));
  writeFileSync(join(npmPackage, "cotal.js"), '#!/usr/bin/env node\nconsole.log("cotal-ai 0.0.0");\n');
  chmodSync(join(npmPackage, "cotal.js"), 0o755);
  const installation = readFileSync(resolve(import.meta.dirname, "../../../docs/installation.mdx"), "utf8");
  const npmSection = installation.split("## Install with npm")[1]?.split("## ")[0];
  const npmSteps = npmSection?.match(/```bash\n([^`]+)```/)?.[1];
  assert(npmSteps, "npm instructions include a shell command block");
  assert(npmSteps.includes('npm config set prefix "$HOME/.local"'), "npm instructions select a user-owned prefix before installing");
  assert(npmSteps.includes('export PATH="$HOME/.local/bin:$PATH"'), "npm instructions put the prefix's bin directory first on PATH");
  assert(npmSteps.includes("npm install -g cotal-ai"), "npm instructions retain the global install command");
  const npmEnv = {
    HOME: npmHome, PATH: toolPath, CI: "1", NO_COLOR: "1",
    npm_config_userconfig: join(npmHome, ".npmrc"),
    npm_config_globalconfig: join(npmHome, "global-npmrc"),
    npm_config_cache: join(npmHome, ".npm"),
    npm_config_registry: "http://127.0.0.1:9",
    FIXTURE_PACKAGE: npmPackage,
  };
  const npmInstall = spawnSync("/bin/sh", ["-c", `set -eu\n${npmSteps.replace("npm install -g cotal-ai", 'npm install -g "$FIXTURE_PACKAGE" --offline --ignore-scripts --no-audit --no-fund')}\ncotal --version`], { env: npmEnv, encoding: "utf8", timeout: 30_000 });
  assert.equal(npmInstall.status, 0, output(npmInstall));
  assert(output(npmInstall).includes("cotal-ai 0.0.0"), "the documented PATH selects npm's installed executable, including with spaces and quotes in HOME");
  const npmPrefix = spawnSync("npm", ["prefix", "-g"], { env: npmEnv, encoding: "utf8", timeout: 10_000 });
  assert.equal(npmPrefix.status, 0, output(npmPrefix));
  assert.equal(npmPrefix.stdout.trim(), join(npmHome, ".local"), "the documented npm prefix persists for future global installs");
  const removeSection = installation.split("## Remove Cotal")[1]?.split("## ")[0];
  const removeSteps = removeSection?.match(/```bash\n([^`]+)```/)?.[1];
  assert(removeSteps, "npm removal instructions include a shell command block");
  assert(removeSteps.includes('rm -rf "$(npm root -g)/../.cotal-generations"'), "npm removal instructions clean up the retained generation store");
  assert(removeSteps.includes("npm uninstall -g cotal-ai"), "npm removal instructions uninstall the global package");
  const fakeGen = join(npmHome, ".local", "lib", ".cotal-generations", "deadbeef");
  mkdirSync(fakeGen, { recursive: true });
  writeFileSync(join(fakeGen, "inventory.json"), "[]");
  const npmRemove = spawnSync("/bin/sh", ["-c", `set -eu\nexport PATH="$HOME/.local/bin:$PATH"\n${removeSteps}`], { env: npmEnv, encoding: "utf8", timeout: 30_000 });
  assert.equal(npmRemove.status, 0, output(npmRemove));
  assert(!existsSync(join(npmHome, ".local", "lib", ".cotal-generations")), "documented npm removal deletes .cotal-generations");
  assert(!existsSync(join(npmHome, ".local", "bin", "cotal")), "documented npm removal deletes the cotal executable");
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
  emitSentinel({ passed: 58, failed: 0 });
  passed = true;
} finally {
  if (passed) rmSync(root, { recursive: true, force: true });
  else console.error(`installer selection fixture retained: ${root}`);
}
