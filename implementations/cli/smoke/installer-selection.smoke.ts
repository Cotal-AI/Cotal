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
  printf 'cotal-ai %s\\n' "$(cat "$FIXTURE_VERSION_FILE")"
fi
CLI
  chmod 755 "$INSTALL_DIR/bin/cotal"
}
main --no-setup --no-modify-path --version "\${FIXTURE_TARGET:-0.82.2}"
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
  const shadow = fixture("shadow");
  const shadowed = spawnSync("/bin/sh", [driver, library], { env: { ...shadow.env, PATH: `${shadow.oldBin}:${shadow.newBin}:${toolPath}` }, encoding: "utf8" });
  assert.equal(shadowed.status, 0, output(shadowed));
  assert(output(shadowed).includes("Your PATH does not select the Cotal just installed."), "installer warns when the new directory is on PATH but an old executable wins");
  assert(output(shadowed).includes("type -a cotal") && output(shadowed).includes("cached commands, aliases or functions"), "installer explains the parent-shell selection boundary");
  assert(!existsSync(shadow.marker), "installer never executes the shadowing old command to diagnose it");
  const quote = (value: string): string => "'" + value.replaceAll("'", "'\\''") + "'";
  for (const command of ["setup", "up --detach", "spawn"])
    assert(output(shadowed).includes(`${quote(join(shadow.newBin, "cotal"))} ${command}`), `installer next step uses its absolute safely quoted executable: ${command}`);

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
  console.log("INSTALLER SELECTION: all real-shell main-path controls passed");
  emitSentinel({ passed: 26, failed: 0 });
  passed = true;
} finally {
  if (passed) rmSync(root, { recursive: true, force: true });
  else console.error(`installer selection fixture retained: ${root}`);
}
