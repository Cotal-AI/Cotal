import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
  console.log("NPM INSTALL: documented user-owned prefix and PATH commands passed with real npm (offline package)");

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
  console.log("INSTALLER SELECTION: all real-shell main-path controls passed");
  emitSentinel({ passed: 54, failed: 0 });
  passed = true;
} finally {
  if (passed) rmSync(root, { recursive: true, force: true });
  else console.error(`installer selection fixture retained: ${root}`);
}
