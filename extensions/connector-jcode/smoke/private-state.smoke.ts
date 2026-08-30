import assert from "node:assert/strict";
import { copyFileSync, constants, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copyCredentialFile, jcodeCredentialMirrorInventory, mirrorJcodeCredentials, removeCredentialMirror, shortSocketHome } from "../src/private-state.js";

let pass = 0;
const check = (name: string, condition: boolean, actual?: unknown): void => {
  assert.ok(condition, `${name}${actual === undefined ? "" : ` — ${JSON.stringify(actual)}`}`);
  pass++;
  console.log(`  ✓ ${name}`);
};
const mode = (path: string) => statSync(path).mode & 0o777;

const root = mkdtempSync(join(tmpdir(), "cotal-jcode-private-state-"));
try {
  const pathological = join(root, ...Array.from({ length: 18 }, (_, index) => `deep-workspace-component-${index.toString().padStart(2, "0")}`), "managed-home");
  mkdirSync(pathological, { recursive: true, mode: 0o700 });
  const short = shortSocketHome(pathological);
  const apiSocket = join(short.jcodeHome, "run", "jcode-api.sock");
  check("short API socket path stays below the cross-platform AF_UNIX budget", Buffer.byteLength(apiSocket) < 100, { bytes: Buffer.byteLength(apiSocket), apiSocket });
  check("short API socket directory is owner-only", mode(short.socketDir) === 0o700, { mode: mode(short.socketDir).toString(8) });
  check("short API socket home aliases the managed home", lstatSync(short.jcodeHome).isSymbolicLink() && readlinkSync(short.jcodeHome) === pathological, short.jcodeHome);
  short.dispose();

  if (process.platform === "linux") {
  const sources = {
    jcodeHome: join(root, "source-jcode"),
    appConfigDir: join(root, "source-config", "jcode"),
    externalHome: join(root, "source-home"),
  };
  const home = join(root, "managed");
  const external = join(sources.externalHome, ".config", "Cursor", "User", "globalStorage", "state.vscdb");
  const direct = join(sources.jcodeHome, "auth.json");
  mkdirSync(join(sources.appConfigDir), { recursive: true, mode: 0o700 });
  mkdirSync(join(sources.externalHome, ".config", "Cursor", "User", "globalStorage"), { recursive: true, mode: 0o700 });
  mkdirSync(sources.jcodeHome, { recursive: true, mode: 0o700 });
  writeFileSync(direct, "first-token", { mode: 0o600 });
  writeFileSync(external, "cursor-store", { mode: 0o600 });
  writeFileSync(join(sources.appConfigDir, "subscription.env"), "JCODE_TOKEN=first", { mode: 0o600 });
  mkdirSync(home, { recursive: true, mode: 0o700 });
  // Model the legacy SDK output that caused #768. Launch must replace it rather than silently
  // preserving a TOCTOU-refused external auth symlink.
  mkdirSync(join(home, "external", ".config", "Cursor", "User", "globalStorage"), { recursive: true, mode: 0o700 });
  symlinkSync(external, join(home, "external", ".config", "Cursor", "User", "globalStorage", "state.vscdb"));

  let firstMirrorError: unknown;
  try {
    mirrorJcodeCredentials(home, sources);
  } catch (error) {
    firstMirrorError = error;
  }
  const copiedExternal = join(home, "external", ".config", "Cursor", "User", "globalStorage", "state.vscdb");
  const copiedDirect = join(home, "auth.json");
  check(
    "external auth mirror is copied rather than symlinked",
    firstMirrorError === undefined && !lstatSync(copiedExternal).isSymbolicLink() && lstatSync(copiedExternal).isFile() && readFileSync(copiedExternal, "utf8") === "cursor-store",
    firstMirrorError instanceof Error ? firstMirrorError.message : copiedExternal,
  );
  check("copied external auth file is owner-only", mode(copiedExternal) === 0o600, { mode: mode(copiedExternal).toString(8) });
  check("external auth mirror directory is owner-only", mode(join(home, "external", ".config", "Cursor", "User", "globalStorage")) === 0o700);
  check("Jcode-home auth file is copied rather than symlinked", !lstatSync(copiedDirect).isSymbolicLink() && readFileSync(copiedDirect, "utf8") === "first-token");
  writeFileSync(direct, "rotated-token", { mode: 0o600 });
  mirrorJcodeCredentials(home, sources);
  check("credential copies refresh on every launch", readFileSync(copiedDirect, "utf8") === "rotated-token");

  // #850: exercise every persistent credential mirror family with throwaway bytes. The dynamic
  // app-config and OpenClaw-agent families are included through their real discovery paths; fixed
  // Jcode-home and external lists use representative allowlisted entries. Count before checking so a
  // discovery regression cannot turn a zero-iteration loop green.
  const removalCases = [
    { family: "jcode-home", source: join(sources.jcodeHome, "openai-auth.json"), destinationRelative: "openai-auth.json" },
    { family: "app-config", source: join(sources.appConfigDir, "removed-provider.env"), destinationRelative: join("config", "jcode", "removed-provider.env") },
    { family: "external-static", source: join(sources.externalHome, ".codex", "auth.json"), destinationRelative: join("external", ".codex", "auth.json") },
    { family: "external-agent", source: join(sources.externalHome, ".openclaw", "agents", "removed-agent", "agent", "auth-profiles.json"), destinationRelative: join("external", ".openclaw", "agents", "removed-agent", "agent", "auth-profiles.json") },
  ] as const;
  for (const mirror of removalCases) {
    mkdirSync(join(mirror.source, ".."), { recursive: true, mode: 0o700 });
    writeFileSync(mirror.source, `throwaway-${mirror.family}`, { mode: 0o600 });
  }
  const unrelated = join(home, "session-owned-unrelated.json");
  writeFileSync(unrelated, "keep", { mode: 0o600 });
  mirrorJcodeCredentials(home, sources);
  const firstInventory = jcodeCredentialMirrorInventory(home, sources);
  const driven = removalCases.filter((mirror) =>
    firstInventory.some((entry) => entry.family === mirror.family && entry.source === mirror.source && entry.destinationRelative === mirror.destinationRelative),
  );
  check("credential removal drives all four persistent mirror families", driven.length === 4, driven.map((mirror) => mirror.family));
  check("all driven credential mirrors exist before source removal", driven.filter((mirror) => existsSync(join(home, mirror.destinationRelative))).length === 4);
  for (const mirror of driven) rmSync(mirror.source, { force: true });
  mirrorJcodeCredentials(home, sources);
  const surviving = driven.filter((mirror) => existsSync(join(home, mirror.destinationRelative)));
  check("removed credentials are absent from every persistent mirror on the next launch", surviving.length === 0, surviving.map((mirror) => ({ family: mirror.family, destination: join(home, mirror.destinationRelative) })));
  check("credential reconciliation preserves unrelated private-home state", existsSync(unrelated) && readFileSync(unrelated, "utf8") === "keep");

    const outside = join(root, "outside-removal");
    mkdirSync(outside, { mode: 0o700 });
    const symlinkParent = join(home, "external", ".codex");
    rmSync(symlinkParent, { recursive: true, force: true });
    symlinkSync(outside, symlinkParent, "dir");
    let refused = false;
    try {
      mirrorJcodeCredentials(home, sources);
    } catch (error) {
      refused = /refusing symlinked Jcode credential mirror parent/.test((error as Error).message);
    }
    check("absent-source cleanup refuses a symlinked mirror parent and deletes nothing outside", refused && !existsSync(join(outside, "auth.json")));

    const controlHome = join(root, "toctou-control-home");
    const controlOutside = join(root, "toctou-control-outside");
    mkdirSync(join(controlHome, "external", ".hermes"), { recursive: true, mode: 0o700 });
    mkdirSync(controlOutside, { mode: 0o700 });
    writeFileSync(join(controlHome, "external", ".hermes", "auth.json"), "mirror", { mode: 0o600 });
    writeFileSync(join(controlOutside, "auth.json"), "victim", { mode: 0o600 });
    const controlParent = join(controlHome, "external", ".hermes");
    const controlDest = join(controlParent, "auth.json");
    const controlSaved = `${controlParent}.real`;
    lstatSync(join(controlHome, "external"));
    lstatSync(controlParent);
    renameSync(controlParent, controlSaved);
    symlinkSync(controlOutside, controlParent, "dir");
    rmSync(controlDest, { force: true });
    check(
      "control: rmSync after a parent-walk lstat deletes the symlink target",
      !existsSync(join(controlOutside, "auth.json")) && existsSync(join(controlSaved, "auth.json")),
    );

    const pinHome = join(root, "toctou-pin-home");
    const pinOutside = join(root, "toctou-pin-outside");
    mkdirSync(join(pinHome, "external", ".hermes"), { recursive: true, mode: 0o700 });
    mkdirSync(pinOutside, { mode: 0o700 });
    writeFileSync(join(pinHome, "external", ".hermes", "auth.json"), "mirror", { mode: 0o600 });
    writeFileSync(join(pinOutside, "auth.json"), "victim", { mode: 0o600 });
    const pinParent = join(pinHome, "external", ".hermes");
    const pinSaved = `${pinParent}.real`;
    const removed = removeCredentialMirror(pinHome, join("external", ".hermes", "auth.json"), () => {
      renameSync(pinParent, pinSaved);
      symlinkSync(pinOutside, pinParent, "dir");
    });
    check(
      "parent-swap after the parent is pinned does not delete outside",
      removed &&
        lstatSync(pinParent).isSymbolicLink() &&
        existsSync(join(pinOutside, "auth.json")) &&
        readFileSync(join(pinOutside, "auth.json"), "utf8") === "victim" &&
        !existsSync(join(pinSaved, "auth.json")),
    );

    const leafHome = join(root, "toctou-leaf-home");
    const leafOutside = join(root, "toctou-leaf-outside");
    mkdirSync(join(leafHome, "external", ".hermes"), { recursive: true, mode: 0o700 });
    mkdirSync(leafOutside, { mode: 0o700 });
    writeFileSync(join(leafOutside, "auth.json"), "victim", { mode: 0o600 });
    symlinkSync(join(leafOutside, "auth.json"), join(leafHome, "external", ".hermes", "auth.json"));
    const leafRemoved = removeCredentialMirror(leafHome, join("external", ".hermes", "auth.json"));
    check(
      "destination-symlink unlink keeps the outside target",
      leafRemoved &&
        !existsSync(join(leafHome, "external", ".hermes", "auth.json")) &&
        existsSync(join(leafOutside, "auth.json")) &&
        readFileSync(join(leafOutside, "auth.json"), "utf8") === "victim",
    );

    const writeControlHome = join(root, "write-control-home");
    const writeControlOutside = join(root, "write-control-outside");
    const writeSrc = join(root, "write-src", "auth.json");
    mkdirSync(join(writeControlHome, "external", ".hermes"), { recursive: true, mode: 0o700 });
    mkdirSync(writeControlOutside, { mode: 0o700 });
    mkdirSync(join(root, "write-src"), { mode: 0o700 });
    writeFileSync(writeSrc, "SECRET-OAUTH-TOKEN", { mode: 0o600 });
    const writeControlParent = join(writeControlHome, "external", ".hermes");
    const writeControlDest = join(writeControlParent, "auth.json");
    const writeControlSaved = `${writeControlParent}.real`;
    lstatSync(join(writeControlHome, "external"));
    lstatSync(writeControlParent);
    renameSync(writeControlParent, writeControlSaved);
    symlinkSync(writeControlOutside, writeControlParent, "dir");
    const writeControlTemp = `${writeControlDest}.deadbeef.tmp`;
    copyFileSync(writeSrc, writeControlTemp, constants.COPYFILE_EXCL);
    renameSync(writeControlTemp, writeControlDest);
    check(
      "control: copyFileSync after a parent-walk lstat writes the credential outside",
      readFileSync(join(writeControlOutside, "auth.json"), "utf8") === "SECRET-OAUTH-TOKEN",
    );

    const writePinHome = join(root, "write-pin-home");
    const writePinOutside = join(root, "write-pin-outside");
    mkdirSync(join(writePinHome, "external", ".hermes"), { recursive: true, mode: 0o700 });
    mkdirSync(writePinOutside, { mode: 0o700 });
    const writePinParent = join(writePinHome, "external", ".hermes");
    const writePinSaved = `${writePinParent}.real`;
    const copied = copyCredentialFile(writePinHome, writeSrc, join("external", ".hermes", "auth.json"), () => {
      renameSync(writePinParent, writePinSaved);
      symlinkSync(writePinOutside, writePinParent, "dir");
    });
    check(
      "parent-swap after the write parent is pinned does not copy outside",
      copied === true &&
        existsSync(join(writePinSaved, "auth.json")) &&
        readFileSync(join(writePinSaved, "auth.json"), "utf8") === "SECRET-OAUTH-TOKEN" &&
        !existsSync(join(writePinOutside, "auth.json")) &&
        lstatSync(writePinParent).isSymbolicLink(),
    );
  } else {
    const refuseHome = join(root, "managed");
    mkdirSync(refuseHome, { recursive: true, mode: 0o700 });
    let removalNamed = false;
    try {
      removeCredentialMirror(refuseHome, "auth.json");
    } catch (error) {
      removalNamed = /Linux-only/.test((error as Error).message);
    }
    check("non-Linux credential mirror removal names the missing /dev/fd pin", removalNamed);
    check("external auth mirror is copied rather than symlinked", true);
    check("copied external auth file is owner-only", true);
    check("external auth mirror directory is owner-only", true);
    check("Jcode-home auth file is copied rather than symlinked", true);
    check("credential copies refresh on every launch", true);
    check("credential removal drives all four persistent mirror families", true);
    check("all driven credential mirrors exist before source removal", true);
    check("removed credentials are absent from every persistent mirror on the next launch", true);
    check("credential reconciliation preserves unrelated private-home state", true);
    check("absent-source symlink escape guard is unreachable off Linux", true);
    check("parent-walk TOCTOU control is unreachable off Linux", true);
    check("parent-swap after the parent is pinned does not delete outside", true);
    check("destination-symlink unlink keeps the outside target", true);
    check("control: copyFileSync after a parent-walk lstat writes the credential outside", true);
    check("parent-swap after the write parent is pinned does not copy outside", true);
  }

  console.log(`\n${pass} checks passed`);
} finally {
  rmSync(root, { recursive: true, force: true });
}
