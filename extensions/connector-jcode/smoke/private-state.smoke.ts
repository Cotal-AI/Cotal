import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { jcodeCredentialMirrorInventory, mirrorJcodeCredentials, shortSocketHome } from "../src/private-state.js";

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

  // #850: drive every persistent credential mirror family with throwaway bytes. Dynamic app-config
  // and OpenClaw-agent families go through their real discovery paths. Count before checking absence so
  // a discovery regression cannot turn a zero-iteration loop green. Unique inventory families must
  // equal driven families so a new construction site cannot keep the fixture-constant count green.
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
  const inventoryFamilies = [...new Set(firstInventory.map((entry) => entry.family))].sort();
  const drivenFamilies = [...driven.map((mirror) => mirror.family)].sort();
  check("credential removal checked 4 persistent mirror families", driven.length === 4, { mirrorsChecked: driven.length, families: driven.map((mirror) => mirror.family) });
  check(
    "driven families equal unique inventory families",
    inventoryFamilies.length === drivenFamilies.length && inventoryFamilies.every((family, index) => family === drivenFamilies[index]),
    { inventoryFamilies, drivenFamilies },
  );
  check("all driven credential mirrors exist before source removal", driven.filter((mirror) => existsSync(join(home, mirror.destinationRelative))).length === 4);
  for (const mirror of driven) rmSync(mirror.source, { force: true });
  mirrorJcodeCredentials(home, sources);
  const surviving = driven.filter((mirror) => existsSync(join(home, mirror.destinationRelative)));
  check("removed credentials are absent from every persistent mirror on the next launch", surviving.length === 0, surviving.map((mirror) => ({ family: mirror.family, destination: join(home, mirror.destinationRelative) })));
  check("credential reconciliation preserves unrelated private-home state", existsSync(unrelated) && readFileSync(unrelated, "utf8") === "keep");

  if (process.platform === "win32") {
    check("absent-source symlink escape guard is unreachable on unsupported Windows", true);
  } else {
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
  }

  console.log(`\nJCODE PRIVATE STATE SMOKE PASSED (${pass} checks passed)`);
} finally {
  rmSync(root, { recursive: true, force: true });
}
