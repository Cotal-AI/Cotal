import assert from "node:assert/strict";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mirrorJcodeCredentials, mirrorJcodeSkills, shortSocketHome } from "../src/private-state.js";

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

  const skillSource = join(root, "skills-source");
  const managedSkill = join(home, "external", ".agents", "skills", "team-topology", "SKILL.md");
  mkdirSync(join(skillSource, "team-topology"), { recursive: true });
  writeFileSync(join(skillSource, "team-topology", "SKILL.md"), "generation-one\n");
  check("managed Jcode skills mirror from the canonical source", mirrorJcodeSkills(home, skillSource).join(",") === "team-topology" && readFileSync(managedSkill, "utf8") === "generation-one\n");
  writeFileSync(join(skillSource, "team-topology", "SKILL.md"), "generation-two\n");
  mirrorJcodeSkills(home, skillSource);
  check("managed Jcode skills refresh to the next Cotal generation", readFileSync(managedSkill, "utf8") === "generation-two\n");
  const retiredSource = join(root, "retired-skills-source");
  mkdirSync(join(retiredSource, "replacement"), { recursive: true });
  writeFileSync(join(retiredSource, "replacement", "SKILL.md"), "replacement\n");
  writeFileSync(managedSkill, "edited-retired\n");
  mirrorJcodeSkills(home, retiredSource);
  check("managed Jcode retirement backs up edits and removes only the retired SKILL.md", !lstatSync(join(home, "external", ".agents", "skills", "team-topology", "SKILL.md.bak")).isSymbolicLink() && readFileSync(join(home, "external", ".agents", "skills", "team-topology", "SKILL.md.bak"), "utf8") === "edited-retired\n" && !readFileSync(join(home, "cotal-agent-skills.json"), "utf8").includes("team-topology"));
  mkdirSync(join(skillSource, "team-topology"), { recursive: true });
  writeFileSync(join(skillSource, "team-topology", "SKILL.md"), "generation-two\n");
  mirrorJcodeSkills(home, skillSource);
  const outside = join(root, "outside-skill");
  writeFileSync(outside, "outside\n");
  rmSync(managedSkill);
  symlinkSync(outside, managedSkill);
  mirrorJcodeSkills(home, skillSource);
  check("managed Jcode skill refresh replaces a planted symlink without touching its target", !lstatSync(managedSkill).isSymbolicLink() && readFileSync(managedSkill, "utf8") === "generation-two\n" && readFileSync(outside, "utf8") === "outside\n");
  const sourceLink = join(root, "skills-source-link");
  symlinkSync(skillSource, sourceLink, "dir");
  assert.throws(() => mirrorJcodeSkills(home, sourceLink), /not a real directory/);
  check("managed Jcode skills refuse a symlinked canonical source root", true);
  rmSync(managedSkill);
  mkdirSync(managedSkill);
  assert.throws(() => mirrorJcodeSkills(home, skillSource), /destination is a directory/);
  check("managed Jcode skills refuse a directory where SKILL.md belongs", true);

  console.log(`\nJCODE PRIVATE STATE SMOKE PASSED (${pass} checks)`);
} finally {
  rmSync(root, { recursive: true, force: true });
}
