import assert from "node:assert/strict";
import { copyFileSync, constants, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copyCredentialFile, ensurePinnedPrivateDirectory, jcodeCredentialMirrorInventory, mirrorJcodeCredentials, removeCredentialMirror, shortSocketHome, unlinkThroughSwappedPinForTest } from "../src/private-state.js";

let pass = 0;
const check = (name: string, condition: boolean, actual?: unknown): void => {
  assert.ok(condition, `${name}${actual === undefined ? "" : ` — ${JSON.stringify(actual)}`}`);
  pass++;
  console.log(`  ✓ ${name}`);
};
const mode = (path: string) => statSync(path).mode & 0o777;
const leafKind = (path: string): { kind: "file" | "dir" | "other" | "absent"; bytes: string | null } => {
  try {
    const st = lstatSync(path);
    if (st.isDirectory()) return { kind: "dir", bytes: null };
    if (st.isFile()) return { kind: "file", bytes: readFileSync(path, "utf8") };
    return { kind: "other", bytes: null };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "absent", bytes: null };
    throw error;
  }
};

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

  // #1211. The alias path is derived from the seat home, so one seat NAME reuses one path forever.
  // A launch hands that path back through dispose(), and a Jcode server the dead lifecycle left
  // running then re-creates it as a real directory under its own JCODE_HOME. Refusing a
  // non-symlink there retired the NAME permanently: every later launch threw at this call, before
  // Jcode was started, so nothing reached the seat's private Jcode log to say why.
  mkdirSync(join(short.socketDir, "home", "logs"), { recursive: true, mode: 0o700 });
  writeFileSync(join(short.socketDir, "home", "servers.json"), "{}", { mode: 0o600 });
  const afterOrphan = shortSocketHome(pathological);
  check(
    "an alias a dead lifecycle re-created as a real directory is reclaimed, not refused forever",
    lstatSync(afterOrphan.jcodeHome).isSymbolicLink() && readlinkSync(afterOrphan.jcodeHome) === pathological,
    afterOrphan.jcodeHome,
  );
  // The reclaim removes an entry it classified with lstat, so it can never reach through the alias
  // into the seat home that alias names. Everything the seat owns must survive a relaunch.
  writeFileSync(join(pathological, "seat-state"), "keep", { mode: 0o600 });
  const afterRelink = shortSocketHome(pathological);
  check(
    "reclaiming a symlinked alias leaves the seat home it points at intact",
    readFileSync(join(pathological, "seat-state"), "utf8") === "keep" && readlinkSync(afterRelink.jcodeHome) === pathological,
  );
  afterRelink.dispose();

  if (process.platform !== "win32") {
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
    let copied = false;
    let writePinError: unknown;
    try {
      copied = copyCredentialFile(writePinHome, writeSrc, join("external", ".hermes", "auth.json"), () => {
        renameSync(writePinParent, writePinSaved);
        symlinkSync(writePinOutside, writePinParent, "dir");
      });
    } catch (error) {
      writePinError = error;
    }
    check(
      "parent-swap after the write parent is pinned does not copy outside",
      writePinError === undefined &&
        copied === true &&
        existsSync(join(writePinSaved, "auth.json")) &&
        readFileSync(join(writePinSaved, "auth.json"), "utf8") === "SECRET-OAUTH-TOKEN" &&
        !existsSync(join(writePinOutside, "auth.json")) &&
        lstatSync(writePinParent).isSymbolicLink(),
    );

    const pdControlParent = join(root, "pd-control-parent");
    const pdControlOutside = join(root, "pd-control-outside");
    mkdirSync(pdControlParent, { mode: 0o700 });
    mkdirSync(pdControlOutside, { mode: 0o700 });
    symlinkSync(join(pdControlParent, "elsewhere"), join(pdControlParent, "managed"));
    writeFileSync(join(pdControlOutside, "managed"), "VICTIM-BYTES", { mode: 0o600 });
    const pdControlPath = join(pdControlParent, "managed");
    const pdControlSaved = `${pdControlParent}.real`;
    lstatSync(pdControlPath);
    renameSync(pdControlParent, pdControlSaved);
    symlinkSync(pdControlOutside, pdControlParent, "dir");
    rmSync(pdControlPath, { force: true });
    mkdirSync(pdControlPath, { mode: 0o700 });
    const pdControlVictim = leafKind(join(pdControlOutside, "managed"));
    check(
      "control: rmSync after privateDirectory lstat replaces the namesake file",
      // existsSync stays true on the replacement directory. Inode numbers can reuse immediately, so
      // the oracle is kind plus bytes, not existence and not inode equality.
      pdControlVictim.kind === "dir" &&
        pdControlVictim.bytes === null &&
        existsSync(join(pdControlOutside, "managed")),
      pdControlVictim,
    );

    const pdPinParent = join(root, "pd-pin-parent");
    const pdPinOutside = join(root, "pd-pin-outside");
    mkdirSync(pdPinParent, { mode: 0o700 });
    mkdirSync(pdPinOutside, { mode: 0o700 });
    symlinkSync(join(pdPinParent, "elsewhere"), join(pdPinParent, "managed"));
    writeFileSync(join(pdPinOutside, "managed"), "VICTIM-BYTES", { mode: 0o600 });
    const pdPinPath = join(pdPinParent, "managed");
    const pdPinSaved = `${pdPinParent}.real`;
    let pdPinError: unknown;
    try {
      ensurePinnedPrivateDirectory(pdPinPath, {
        replaceSymlink: true,
        beforeEnsure: () => {
          renameSync(pdPinParent, pdPinSaved);
          symlinkSync(pdPinOutside, pdPinParent, "dir");
        },
      });
    } catch (error) {
      pdPinError = error;
    }
    const pdPinVictim = leafKind(join(pdPinOutside, "managed"));
    check(
      "parent-swap after privateDirectory parent is pinned does not replace the outside file",
      pdPinError === undefined &&
        pdPinVictim.kind === "file" &&
        pdPinVictim.bytes === "VICTIM-BYTES" &&
        lstatSync(join(pdPinSaved, "managed")).isDirectory(),
      { pdPinError: pdPinError instanceof Error ? pdPinError.message : pdPinError, pdPinVictim },
    );

    // The pin is entered by path on macOS and BSD (there is no /dev/fd subpath namespace to name a
    // child through), so a swap landing between the descriptor open and that entry is the one
    // window the two mechanisms close differently: procfs holds the inode and proceeds, cwd-inode
    // detects the inode disagreement and refuses. Both must leave the outside namesake alone.
    const enterHome = join(root, "enter-swap-home");
    const enterOutside = join(root, "enter-swap-outside");
    mkdirSync(enterHome, { recursive: true, mode: 0o700 });
    mkdirSync(enterOutside, { mode: 0o700 });
    writeFileSync(join(enterHome, "auth.json"), "mirror", { mode: 0o600 });
    writeFileSync(join(enterOutside, "auth.json"), "victim", { mode: 0o600 });
    const enterSaved = `${enterHome}.real`;
    const enterOutcome = unlinkThroughSwappedPinForTest(enterHome, "auth.json", () => {
      renameSync(enterHome, enterSaved);
      symlinkSync(enterOutside, enterHome, "dir");
    });
    check(
      "a directory swapped between the pin open and the pin entry never unlinks outside",
      leafKind(join(enterOutside, "auth.json")).bytes === "victim" &&
        (enterOutcome.unlinked
          ? leafKind(join(enterSaved, "auth.json")).kind === "absent"
          : /refusing swapped Jcode credential mirror parent/.test(enterOutcome.refusal ?? "")),
      enterOutcome,
    );

    // The cwd-inode pin moves the process working directory. Every mirror entry point must put it
    // back, including the ones that throw: a leaked chdir would silently re-root every later
    // relative path in the host process.
    const cwdBefore = process.cwd();
    const cwdHome = join(root, "cwd-restore-home");
    mkdirSync(join(cwdHome, "external", ".codex"), { recursive: true, mode: 0o700 });
    const cwdSources = {
      jcodeHome: join(root, "cwd-restore-src", "jcode"),
      appConfigDir: join(root, "cwd-restore-src", "config", "jcode"),
      externalHome: join(root, "cwd-restore-src", "home"),
    };
    mkdirSync(cwdSources.jcodeHome, { recursive: true, mode: 0o700 });
    writeFileSync(join(cwdSources.jcodeHome, "auth.json"), "token", { mode: 0o600 });
    mirrorJcodeCredentials(cwdHome, cwdSources);
    const cwdAfterMirror = process.cwd();
    rmSync(join(cwdHome, "external", ".codex"), { recursive: true, force: true });
    symlinkSync(join(root, "cwd-restore-outside"), join(cwdHome, "external", ".codex"), "dir");
    mkdirSync(join(root, "cwd-restore-outside"), { mode: 0o700 });
    let cwdThrew = false;
    try {
      mirrorJcodeCredentials(cwdHome, cwdSources);
    } catch {
      cwdThrew = true;
    }
    check(
      "credential mirroring restores the working directory, including when it refuses",
      cwdAfterMirror === cwdBefore && cwdThrew && process.cwd() === cwdBefore,
      { cwdBefore, cwdAfterMirror, cwdThrew, cwdNow: process.cwd() },
    );

    const pdMkParent = join(root, "pd-mkdir-parent");
    const pdMkOutside = join(root, "pd-mkdir-outside");
    mkdirSync(pdMkParent, { mode: 0o700 });
    mkdirSync(pdMkOutside, { mode: 0o700 });
    const pdMkPath = join(pdMkParent, "managed");
    const pdMkSaved = `${pdMkParent}.real`;
    let pdMkError: unknown;
    try {
      ensurePinnedPrivateDirectory(pdMkPath, {
        beforeEnsure: () => {
          renameSync(pdMkParent, pdMkSaved);
          symlinkSync(pdMkOutside, pdMkParent, "dir");
        },
      });
    } catch (error) {
      pdMkError = error;
    }
    check(
      "parent-swap after privateDirectory parent is pinned does not mkdir outside",
      pdMkError === undefined &&
        lstatSync(join(pdMkSaved, "managed")).isDirectory() &&
        leafKind(join(pdMkOutside, "managed")).kind === "absent",
      { pdMkError: pdMkError instanceof Error ? pdMkError.message : pdMkError },
    );
  } else {
    // The connector refuses Windows in buildLaunch, so the pin never runs there. Assert that
    // refusal is named and skip the battery. A `check(name, true)` here would report a passing
    // cell that cannot fail, which reads as coverage this platform does not have.
    const refuseHome = join(root, "managed");
    mkdirSync(refuseHome, { recursive: true, mode: 0o700 });
    let removalNamed = false;
    try {
      removeCredentialMirror(refuseHome, "auth.json");
    } catch (error) {
      removalNamed = /requires a directory pin to name each parent by inode/.test((error as Error).message);
    }
    check("Windows credential mirror removal names the unavailable directory pin", removalNamed);
    console.log(`  .. credential mirror battery skipped on ${process.platform}: the connector refuses it before launch`);
  }

  console.log(`\n${pass} checks passed`);
} finally {
  rmSync(root, { recursive: true, force: true });
}
