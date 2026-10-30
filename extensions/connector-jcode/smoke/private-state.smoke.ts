import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, constants, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, readlinkSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync, writeSync, closeSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { copyCredentialFile, ensurePinnedPrivateDirectory, jcodeCredentialMirrorInventory, mirrorJcodeCredentials, removeCredentialMirror, shortSocketHome, unlinkThroughSwappedPinForTest } from "../src/private-state.js";
import { JcodeCursorStateUnreadable } from "../src/startup-diagnostics.js";

let pass = 0;
const check = (name: string, condition: boolean, actual?: unknown): void => {
  assert.ok(condition, `${name}${actual === undefined ? "" : `: ${JSON.stringify(actual)}`}`);
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

// #5298: Cursor-shaped state databases with fake values. Jcode reads four ItemTable keys; the rest
// stands in for the rows and chat history a real one carries around them.
const CURSOR_KEYS = ["cursorAuth/accessToken", "cursorAuth/refreshToken", "storage.serviceMachineId", "cursorAuth/cachedEmail"];
const cursorValues = (generation: string): Record<string, string> => Object.fromEntries(CURSOR_KEYS.map((key) => [key, `${generation}-${key}-fake`]));
const CURSOR_REL = join(".config", "Cursor", "User", "globalStorage", "state.vscdb");
function writeCursorDb(path: string, values: Record<string, string | Uint8Array> = cursorValues("v1"), journal: "delete" | "wal" = "delete"): DatabaseSync {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path);
  db.exec(`PRAGMA journal_mode = ${journal}`);
  db.exec("CREATE TABLE ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)");
  db.exec("CREATE TABLE cursorDiskKV (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)");
  const insert = db.prepare("INSERT INTO ItemTable (key, value) VALUES (?, ?)");
  for (const [key, value] of Object.entries(values)) insert.run(key, value);
  insert.run("cursorAuth/stripeMembershipType", "not-read-by-jcode");
  insert.run("workbench.panel.state", "x".repeat(4096));
  db.prepare("INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)").run("composerData:fake", "chat ".repeat(40_000));
  if (journal === "wal") db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  return db;
}
function readExtract(path: string): { tables: string[]; rows: Record<string, unknown>; bytes: number } {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { name: string }[]).map((row) => row.name);
    const rows = Object.fromEntries((db.prepare("SELECT key, value FROM ItemTable").all() as { key: string; value: unknown }[]).map((row) => [row.key, row.value]));
    return { tables, rows, bytes: statSync(path).size };
  } finally {
    db.close();
  }
}
const sameRows = (a: Record<string, unknown>, b: Record<string, unknown>): boolean => JSON.stringify(Object.entries(a).sort()) === JSON.stringify(Object.entries(b).sort());
const isExtractOf = (path: string, values: Record<string, unknown>): boolean => {
  const extract = readExtract(path);
  return extract.tables.join() === "ItemTable" && sameRows(extract.rows, values) && extract.bytes < 32 * 1024 && !lstatSync(path).isSymbolicLink();
};
/** Inode, size and content hash of every file in a directory, to show a reader left it alone. */
function snapshotDir(dir: string): string {
  return JSON.stringify(readdirSync(dir).sort().map((name) => {
    const st = lstatSync(join(dir, name));
    return [name, st.ino, st.size, st.isFile() ? createHash("sha256").update(readFileSync(join(dir, name))).digest("hex") : "-"];
  }));
}
function mirrorError(run: () => void): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  return undefined;
}

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
  let afterOrphan: ReturnType<typeof shortSocketHome> | undefined;
  let orphanRefusal: unknown;
  try {
    afterOrphan = shortSocketHome(pathological);
  } catch (error) {
    orphanRefusal = error;
  }
  check(
    "an alias a dead lifecycle re-created as a real directory is reclaimed, not refused forever",
    afterOrphan !== undefined && lstatSync(afterOrphan.jcodeHome).isSymbolicLink() && readlinkSync(afterOrphan.jcodeHome) === pathological,
    orphanRefusal instanceof Error ? orphanRefusal.message : afterOrphan?.jcodeHome,
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
  writeCursorDb(external).close();
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
    "Cursor's state database is published as a fresh four-key extract, replacing a legacy symlink",
    firstMirrorError === undefined && lstatSync(copiedExternal).isFile() && isExtractOf(copiedExternal, cursorValues("v1")) && statSync(external).size > 200 * 1024,
    firstMirrorError instanceof Error ? firstMirrorError.message : readExtract(copiedExternal),
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

    // #5298: Cursor's state database. Each case has its own source home and seat home.
    const cursorCase = (name: string) => {
      const caseRoot = join(root, `cursor-${name}`);
      const caseSources = { jcodeHome: join(caseRoot, "jcode"), appConfigDir: join(caseRoot, "config", "jcode"), externalHome: join(caseRoot, "home") };
      const caseHome = join(caseRoot, "managed");
      mkdirSync(caseSources.jcodeHome, { recursive: true, mode: 0o700 });
      mkdirSync(caseHome, { recursive: true, mode: 0o700 });
      writeFileSync(join(caseSources.jcodeHome, "auth.json"), "case-token", { mode: 0o600 });
      return {
        home: caseHome,
        sources: caseSources,
        source: join(caseSources.externalHome, CURSOR_REL),
        destination: join(caseHome, "external", CURSOR_REL),
        mirror: () => mirrorJcodeCredentials(caseHome, caseSources),
      };
    };
    const reasonOf = (error: unknown): string | undefined => (error instanceof JcodeCursorStateUnreadable ? error.reason : undefined);
    /** A refused launch writes nothing: the seat's other copies and its Cursor destination stay as they were. */
    const refusedCleanly = (c: ReturnType<typeof cursorCase>, error: unknown, reason: string): boolean =>
      reasonOf(error) === reason &&
      (error as JcodeCursorStateUnreadable).sourceRelative === CURSOR_REL &&
      readFileSync(join(c.home, "auth.json"), "utf8") === "previous" &&
      readFileSync(c.destination, "utf8") === "previous-cursor";
    const seedPrevious = (c: ReturnType<typeof cursorCase>): void => {
      writeFileSync(join(c.home, "auth.json"), "previous", { mode: 0o600 });
      mkdirSync(dirname(c.destination), { recursive: true, mode: 0o700 });
      writeFileSync(c.destination, "previous-cursor", { mode: 0o600 });
    };

    const legacy = cursorCase("legacy");
    writeCursorDb(legacy.source).close();
    mkdirSync(dirname(legacy.destination), { recursive: true, mode: 0o700 });
    copyFileSync(legacy.source, legacy.destination);
    writeFileSync(join(legacy.home, "session-owned.json"), "keep", { mode: 0o600 });
    const legacyIno = statSync(legacy.destination).ino;
    const legacySourceDir = snapshotDir(dirname(legacy.source));
    legacy.mirror();
    check(
      "a legacy full copy is replaced by a fresh extract through the rename, and session files stay",
      isExtractOf(legacy.destination, cursorValues("v1")) && statSync(legacy.destination).ino !== legacyIno && readFileSync(join(legacy.home, "session-owned.json"), "utf8") === "keep",
      readExtract(legacy.destination),
    );
    check("reading a rollback-journal source leaves its directory unchanged", snapshotDir(dirname(legacy.source)) === legacySourceDir);
    check("the published extract is owner-only", mode(legacy.destination) === 0o600, { mode: mode(legacy.destination).toString(8) });

    const live = cursorCase("wal-live");
    const writer = writeCursorDb(live.source, cursorValues("old"), "wal");
    writer.exec("BEGIN");
    const update = writer.prepare("INSERT INTO ItemTable (key, value) VALUES (?, ?)");
    for (const [key, value] of Object.entries(cursorValues("new"))) update.run(key, value);
    writer.exec("COMMIT");
    const liveMain = snapshotDir(dirname(live.source));
    live.mirror();
    const liveAfter = JSON.parse(snapshotDir(dirname(live.source))) as [string, number, number, string][];
    const liveBefore = JSON.parse(liveMain) as [string, number, number, string][];
    const unchangedExceptShm = liveBefore.length === liveAfter.length && liveBefore.every((entry, index) => entry[0].endsWith("-shm") || JSON.stringify(entry) === JSON.stringify(liveAfter[index]));
    writer.close();
    check("a live WAL source publishes its uncheckpointed commit", isExtractOf(live.destination, cursorValues("new")), readExtract(live.destination));
    check("reading a live WAL source changes neither the main file nor the -wal", unchangedExceptShm, { liveBefore, liveAfter });

    // A closed WAL database has no -wal or -shm. SQLite's read-only open creates them, as any reader
    // does, and the database itself must stay as it was.
    const closed = cursorCase("wal-closed");
    writeCursorDb(closed.source, cursorValues("v1"), "wal").close();
    const closedBefore = JSON.parse(snapshotDir(dirname(closed.source))) as unknown[];
    closed.mirror();
    const closedAfter = JSON.parse(snapshotDir(dirname(closed.source))) as [string, ...unknown[]][];
    check("a closed WAL source is read like any other", isExtractOf(closed.destination, cursorValues("v1")), readExtract(closed.destination));
    check(
      "reading it leaves the database as it was and adds nothing but SQLite's own -wal and -shm",
      JSON.stringify(closedAfter.filter(([name]) => name === "state.vscdb")) === JSON.stringify(closedBefore) &&
        closedAfter.every(([name]) => ["state.vscdb", "state.vscdb-wal", "state.vscdb-shm"].includes(name)),
      { closedBefore, closedAfter },
    );
    // A Cursor that died leaves its last commits in a -wal with no -shm. The read must include them.
    const crashedWal = cursorCase("wal-without-shm");
    const crashedTarget = join(root, "cursor-crashed-wal", "state.vscdb");
    const crashedWriter = writeCursorDb(crashedTarget, cursorValues("old"), "wal");
    const crashedUpdate = crashedWriter.prepare("INSERT INTO ItemTable (key, value) VALUES (?, ?)");
    for (const [key, value] of Object.entries(cursorValues("new"))) crashedUpdate.run(key, value);
    mkdirSync(dirname(crashedWal.source), { recursive: true, mode: 0o700 });
    copyFileSync(crashedTarget, crashedWal.source);
    copyFileSync(`${crashedTarget}-wal`, `${crashedWal.source}-wal`);
    crashedWriter.close();
    crashedWal.mirror();
    check("a -wal left without its -shm is read with the commits it holds", isExtractOf(crashedWal.destination, cursorValues("new")), readExtract(crashedWal.destination));

    const odd = cursorCase("odd-header");
    writeCursorDb(odd.source).close();
    const oddFd = openSync(odd.source, "r+");
    writeSync(oddFd, Buffer.from([3, 3]), 0, 2, 18);
    closeSync(oddFd);
    seedPrevious(odd);
    check("a header SQLite does not accept refuses as not SQLite", refusedCleanly(odd, mirrorError(() => odd.mirror()), "not_sqlite"));

    const text = cursorCase("not-sqlite");
    mkdirSync(dirname(text.source), { recursive: true, mode: 0o700 });
    writeFileSync(text.source, "cursor-store", { mode: 0o600 });
    seedPrevious(text);
    check("a plain-text source refuses as not SQLite instead of being copied", refusedCleanly(text, mirrorError(() => text.mirror()), "not_sqlite"));

    const hot = cursorCase("hot-journal");
    writeCursorDb(hot.source).close();
    // A writer killed mid-transaction leaves a hot journal that a read-only open cannot roll back.
    const crashed = spawnSync(process.execPath, ["-e", `
      const { DatabaseSync } = require("node:sqlite");
      const db = new DatabaseSync(${JSON.stringify(hot.source)});
      db.exec("PRAGMA cache_size = 1; BEGIN");
      const insert = db.prepare("INSERT INTO ItemTable (key, value) VALUES (?, ?)");
      for (let n = 0; n < 2000; n++) insert.run("filler" + n, "x".repeat(500));
      process.kill(process.pid, "SIGKILL");
    `], { stdio: "ignore" });
    seedPrevious(hot);
    const hotJournal = existsSync(`${hot.source}-journal`) ? statSync(`${hot.source}-journal`).size : 0;
    check("a hot journal beside a rollback source refuses and stays in place", crashed.signal === "SIGKILL" && hotJournal > 0 && refusedCleanly(hot, mirrorError(() => hot.mirror()), "hot_journal") && statSync(`${hot.source}-journal`).size === hotJournal);

    const locked = cursorCase("locked");
    writeCursorDb(locked.source).close();
    seedPrevious(locked);
    const holder = new DatabaseSync(locked.source);
    holder.exec("BEGIN EXCLUSIVE");
    const lockedStart = Date.now();
    const lockedError = mirrorError(() => locked.mirror());
    const lockedWait = Date.now() - lockedStart;
    holder.exec("ROLLBACK");
    holder.close();
    check("a source locked past the 2 s bound refuses after waiting for it", refusedCleanly(locked, lockedError, "locked") && lockedWait >= 1900, { lockedWait, error: String(lockedError) });

    const noTable = cursorCase("no-item-table");
    mkdirSync(dirname(noTable.source), { recursive: true, mode: 0o700 });
    const noTableDb = new DatabaseSync(noTable.source);
    noTableDb.exec("CREATE TABLE cursorDiskKV (key TEXT, value BLOB)");
    noTableDb.close();
    seedPrevious(noTable);
    check("a SQLite source without ItemTable refuses", refusedCleanly(noTable, mirrorError(() => noTable.mirror()), "no_item_table"));

    const blob = cursorCase("blob");
    writeCursorDb(blob.source, { ...cursorValues("v1"), "cursorAuth/accessToken": new Uint8Array([1, 2, 3]) }).close();
    seedPrevious(blob);
    check("a non-text value under a read key refuses instead of being copied", refusedCleanly(blob, mirrorError(() => blob.mirror()), "value_type"));
    const huge = cursorCase("oversized");
    writeCursorDb(huge.source, { ...cursorValues("v1"), "cursorAuth/refreshToken": "r".repeat(17 * 1024) }).close();
    seedPrevious(huge);
    check("an oversized value under a read key refuses instead of being truncated", refusedCleanly(huge, mirrorError(() => huge.mirror()), "value_size"));

    const none = cursorCase("no-keys");
    writeCursorDb(none.source, {}).close();
    seedPrevious(none);
    none.mirror();
    check("a readable source with none of the keys removes the destination", !existsSync(none.destination) && readFileSync(join(none.home, "auth.json"), "utf8") === "case-token");
    const blank = cursorCase("blank-keys");
    writeCursorDb(blank.source, Object.fromEntries(CURSOR_KEYS.map((key) => [key, "  "]))).close();
    seedPrevious(blank);
    blank.mirror();
    check("blank values count as missing, so four of them remove the destination", !existsSync(blank.destination));
    const partial = cursorCase("partial");
    const partialValues = { "cursorAuth/refreshToken": "only-refresh-fake", "storage.serviceMachineId": "only-machine-fake" };
    writeCursorDb(partial.source, { ...partialValues, "cursorAuth/accessToken": "" }).close();
    partial.mirror();
    check("a partial source publishes only the keys it holds, leaving out a blank one", isExtractOf(partial.destination, partialValues), readExtract(partial.destination));

    const everyPath = cursorCase("six-paths");
    const cursorEntries = jcodeCredentialMirrorInventory(everyPath.home, everyPath.sources).filter((entry) => entry.family === "cursor-state");
    cursorEntries.forEach((entry, index) => writeCursorDb(entry.source, cursorValues(`path${index}`)).close());
    everyPath.mirror();
    const publishedPaths = cursorEntries.filter((entry, index) => isExtractOf(join(everyPath.home, entry.destinationRelative), cursorValues(`path${index}`)));
    check("all six Cursor paths are in the inventory and each publishes its own extract", cursorEntries.length === 6 && publishedPaths.length === 6, cursorEntries.map((entry) => entry.destinationRelative));

    const linked = cursorCase("linked-live");
    const linkedTarget = join(root, "cursor-linked-target", "state.vscdb");
    const linkedWriter = writeCursorDb(linkedTarget, cursorValues("old"), "wal");
    const linkedUpdate = linkedWriter.prepare("INSERT INTO ItemTable (key, value) VALUES (?, ?)");
    for (const [key, value] of Object.entries(cursorValues("new"))) linkedUpdate.run(key, value);
    mkdirSync(dirname(linked.source), { recursive: true, mode: 0o700 });
    symlinkSync(linkedTarget, linked.source);
    linked.mirror();
    linkedWriter.close();
    check("a linked source is read at its target, where its live sidecars are", isExtractOf(linked.destination, cursorValues("new")), readExtract(linked.destination));
    const stray = cursorCase("linked-stray-wal");
    const strayTarget = join(root, "cursor-stray-target", "state.vscdb");
    writeCursorDb(strayTarget, cursorValues("v1"), "wal").close();
    mkdirSync(dirname(stray.source), { recursive: true, mode: 0o700 });
    symlinkSync(strayTarget, stray.source);
    writeFileSync(`${stray.source}-wal`, "not a WAL");
    writeFileSync(`${stray.source}-shm`, "not a wal-index");
    const strayLinkDir = snapshotDir(dirname(stray.source));
    stray.mirror();
    check(
      "a linked source uses the target's own -wal and -shm and leaves files named after the link alone",
      isExtractOf(stray.destination, cursorValues("v1")) && snapshotDir(dirname(stray.source)) === strayLinkDir,
      readExtract(stray.destination),
    );

    const linkedText = cursorCase("linked-not-sqlite");
    const linkedTextTarget = join(root, "cursor-linked-text-target", "state.vscdb");
    mkdirSync(dirname(linkedTextTarget), { recursive: true, mode: 0o700 });
    writeFileSync(linkedTextTarget, "cursor-store", { mode: 0o600 });
    mkdirSync(dirname(linkedText.source), { recursive: true, mode: 0o700 });
    symlinkSync(linkedTextTarget, linkedText.source);
    seedPrevious(linkedText);
    const linkedTextError = mirrorError(() => linkedText.mirror());
    check(
      "a linked source's refusal names its path under the home and never the link's target",
      refusedCleanly(linkedText, linkedTextError, "not_sqlite") && !String(linkedTextError).includes(dirname(linkedTextTarget)),
      String(linkedTextError),
    );

    const folder = cursorCase("directory");
    mkdirSync(folder.source, { recursive: true, mode: 0o700 });
    seedPrevious(folder);
    folder.mirror();
    check("a directory at the source path counts as absent and removes the destination", !existsSync(folder.destination));

    // The public line carries the code and connector-owned words, never SQLite's text or `unknown`.
    const publicCase = cursorCase("public-line");
    mkdirSync(dirname(publicCase.source), { recursive: true, mode: 0o700 });
    writeFileSync(publicCase.source, "cursor-store", { mode: 0o600 });
    const env: NodeJS.ProcessEnv = {};
    for (const [key, value] of Object.entries(process.env)) if (!key.startsWith("COTAL_") && value !== undefined) env[key] = value;
    const hostRun = spawnSync(fileURLToPath(new URL("../node_modules/.bin/tsx", import.meta.url)), [fileURLToPath(new URL("../src/host-main.ts", import.meta.url))], {
      cwd: dirname(publicCase.home),
      env: {
        ...env,
        HOME: publicCase.sources.externalHome,
        JCODE_HOME: publicCase.sources.jcodeHome,
        COTAL_SPACE: "cursorpublic",
        COTAL_NAME: "cursorpeer",
        COTAL_ID: "cursorpeer",
        COTAL_SERVERS: "nats://127.0.0.1:9",
        COTAL_JCODE_HOME: dirname(publicCase.home),
        COTAL_JCODE_TUI: "0",
        COTAL_CONTROL_SOCKET: join(dirname(publicCase.home), "control.sock"),
        COTAL_CONTROL_TOKEN: "cursor-public-line-token",
      },
      encoding: "utf8",
      timeout: 60_000,
    });
    const fatal = hostRun.stderr.split("\n").find((line) => line.includes("fatal:")) ?? "";
    check(
      "an unreadable Cursor source fails the launch with its own public code",
      hostRun.status === 1 &&
        fatal.includes(`startup failed (cursor_state_unreadable): Cursor's state database ~/${CURSOR_REL} could not be read (not_sqlite`) &&
        !/private_state|unknown|file is not a database|ExperimentalWarning/.test(fatal),
      { status: hostRun.status, stderr: hostRun.stderr.slice(-2000) },
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
