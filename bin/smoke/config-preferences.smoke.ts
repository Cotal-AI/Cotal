/**
 * `cotal config` and the preferences it saves, driven through the built binary in a fresh sandbox:
 * the effective values with their sources and shadowed values, `get`, `set` and `unset` for the user
 * and for one space, the refusals (a read, set or unset for a space this machine does not know among
 * them), a value left for a removed space, the named environment tiers, the selected space, an invalid
 * file stopping every command but help and completion without being reset, a linked file stopping
 * them the same way, a `COTAL_HOME` that is not a directory stopping them the same way, a folder
 * other accounts can write refusing a write and warning on a read, a stale write refused, a persona
 * the space's catalog does not hold saved with a warning that names the catalog, two concurrent
 * writers both landing, and the consumers outside `spawn`: color, the `personas edit` editor and the
 * detach key.
 * The launch consumers (harness, persona) are proved through real spawns in `smoke:persona-agent`.
 * Broker-free and offline.
 *
 * Run: pnpm smoke:config-preferences
 */
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSuite } from "@cotal-ai/smoke-kit";

const BIN = join(import.meta.dirname, "..", "dist", "cotal.js");
if (!existsSync(BIN)) {
  console.error(`✗ ${BIN} missing - build first: pnpm --filter cotal-ai... build`);
  process.exit(1);
}
const { check, finish } = createSuite();
const TIERS = ["COTAL_DEFAULT_AGENT", "COTAL_DEFAULT_PERSONA", "COTAL_DETACH_KEY", "NO_COLOR", "FORCE_COLOR", "VISUAL", "EDITOR"];
const HOST_ENV = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("COTAL_") && !TIERS.includes(k)));
const home = mkdtempSync(join(tmpdir(), "cotal-config-"));
process.on("exit", () => rmSync(home, { recursive: true, force: true }));
const xdg = join(home, ".config");
const cotalHome = join(home, ".cotal-home");
const file = join(xdg, "cotal", "preferences.json");
const project = join(home, "project");
mkdirSync(join(project, ".cotal", "agents"), { recursive: true });
writeFileSync(join(project, ".cotal", "agents", "x.md"), "---\nname: x\n---\nhi\n");

type Setting = { key: string; value: string | null; winner: { source: string; name?: string; value: string } | null; shadowed: { source: string; name?: string; value: string }[] };
type Envelope = {
  outcome: string;
  completeness?: string;
  command: string;
  target: unknown;
  result: Record<string, unknown> | null;
  warnings: { code: string; message: string }[];
  error?: { code: string; message: string; remedy?: string };
};
const sandboxEnv = (extra: NodeJS.ProcessEnv) => ({ ...HOST_ENV, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: xdg, COTAL_HOME: cotalHome, COTAL_SKIP_CONNECTOR_SEED: "1", ...extra });
function run(args: string[], extra: NodeJS.ProcessEnv = {}, cwd = home) {
  const r = spawnSync(process.execPath, [BIN, ...args], { cwd, env: sandboxEnv(extra), encoding: "utf8", timeout: 60_000 });
  const stdout = r.stdout ?? "";
  const lines = stdout.split("\n").filter(Boolean);
  const envelope = lines.length === 1 && lines[0]!.startsWith("{") ? (JSON.parse(lines[0]!) as Envelope) : undefined;
  return { status: r.status, stdout, stderr: r.stderr ?? "", envelope };
}
const shown = (r: { status: number | null; stdout: string; stderr: string }) => ({ status: r.status, stdout: r.stdout.slice(0, 700), stderr: r.stderr.slice(0, 400) });
const settingOf = (r: ReturnType<typeof run>, key: string) => ((r.envelope?.result as { settings?: Setting[] } | null)?.settings ?? []).find((s) => s.key === key);
const fileText = () => (existsSync(file) ? readFileSync(file, "utf8") : null);
const saved = () => JSON.parse(readFileSync(file, "utf8")) as { schemaVersion: number; revision: number; defaults: Record<string, string>; spaces: Record<string, Record<string, string>> };
const ansi = /\x1b\[/;

// ── no file: every key at its default, nothing written ───────────────────────────────────────────
{
  const r = run(["config", "--json"]);
  const res = r.envelope?.result as { kind: string; file: string; revision: number; scope: { space: unknown }; settings: Setting[] } | undefined;
  check("config --json with no file is one ok envelope for your defaults", r.status === 0 && r.envelope?.outcome === "ok" && r.envelope.target === null && res?.kind === "preferences" && res.file === file && res.revision === 0 && res.scope.space === null, shown(r));
  check("every key is listed, in order", JSON.stringify(res?.settings.map((s) => s.key)) === JSON.stringify(["harness", "persona", "detach-key", "color", "editor"]), res?.settings.map((s) => s.key));
  check("each key with a product default resolves to it, and the editor to nothing", settingOf(r, "harness")?.winner?.source === "default" && settingOf(r, "persona")?.value === "default" && settingOf(r, "detach-key")?.value === "ctrl-]" && settingOf(r, "color")?.value === "auto" && settingOf(r, "editor")?.value === null && settingOf(r, "editor")?.winner === null, res?.settings);
  check("reading writes nothing", !existsSync(file));
  // The file is in the Storage section, which only --verbose prints.
  const plain = run(["config", "--plain", "--verbose"]);
  check("the plain view names the file, the scope and each key's source", plain.status === 0 && !ansi.test(plain.stdout) && plain.stdout.includes(file) && /^ {2}your defaults$/m.test(plain.stdout) && /Setting\s+Value\s+Source/.test(plain.stdout) && /harness\s+claude\s+the default/.test(plain.stdout), shown(plain));
}

// ── set, get, a repeated set, unset ──────────────────────────────────────────────────────────────
{
  const set = run(["config", "set", "harness", "opencode", "--json"]);
  const w = set.envelope?.result as { kind: string; revision: number; key: string; previous: unknown; value: string; effective: Setting } | undefined;
  check("set saves the value for the user and reports what a command here now uses", set.status === 0 && set.envelope?.outcome === "ok" && w?.kind === "preference-write" && w.revision === 1 && w.previous === null && w.value === "opencode" && w.effective.winner?.source === "user", shown(set));
  check("the file holds it at revision 1, versioned", saved().schemaVersion === 1 && saved().revision === 1 && saved().defaults.harness === "opencode");
  if (process.platform !== "win32") check("the file is private to its owner (0600)", (statSync(file).mode & 0o777) === 0o600, (statSync(file).mode & 0o777).toString(8));
  check("no temporary file is left beside it", readdirSync(join(xdg, "cotal")).every((n) => !n.endsWith(".tmp") && !n.endsWith(".lock")), readdirSync(join(xdg, "cotal")));
  const get = run(["config", "get", "harness", "--json"]);
  const s = (get.envelope?.result as { setting?: Setting } | null)?.setting;
  check("get names the winner and the default it shadows", get.status === 0 && s?.value === "opencode" && s.winner?.source === "user" && s.shadowed.length === 1 && s.shadowed[0]!.source === "default" && s.shadowed[0]!.value === "claude", s);
  const again = run(["config", "set", "harness", "opencode", "--json"]);
  check("setting the same value again is a no-op, exit 0, and writes nothing", again.status === 0 && again.envelope?.outcome === "no-op" && saved().revision === 1, shown(again));
  // A per-space value is saved only for a space this machine knows, so prepare demo first.
  mkdirSync(join(home, "demo"), { recursive: true });
  const prepared = run(["space", "create", "demo", "--root", join(home, "demo"), "--json"]);
  check("setup: demo is prepared", prepared.status === 0 && prepared.envelope?.outcome === "ok", shown(prepared));
  const plainSet = run(["config", "set", "persona", "reviewer", "--space", "demo", "--plain"]);
  check("--space saves a personal value for one space", plainSet.status === 0 && /persona = reviewer in space demo/.test(plainSet.stdout) && saved().spaces.demo?.persona === "reviewer" && saved().revision === 2, shown(plainSet));
  run(["config", "set", "persona", "mine"]);
  const forSpace = run(["config", "--space", "demo", "--json"]);
  check("reading through --space applies that space's value over the user's", settingOf(forSpace, "persona")?.winner?.source === "space" && settingOf(forSpace, "persona")?.winner?.name === "demo" && settingOf(forSpace, "persona")?.shadowed[0]?.source === "user" && settingOf(forSpace, "harness")?.value === "opencode", forSpace.envelope?.result);
  const forUser = run(["config", "--user", "--json"]);
  check("--user reads your defaults without any space's values", settingOf(forUser, "persona")?.value === "mine", forUser.envelope?.result);
  run(["config", "unset", "persona"]);
  const unset = run(["config", "unset", "persona", "--space", "demo", "--json"]);
  const u = unset.envelope?.result as { previous: unknown; value: unknown } | undefined;
  check("unset removes the value and reports what it was", unset.status === 0 && unset.envelope?.outcome === "ok" && u?.previous === "reviewer" && u.value === null && saved().spaces.demo === undefined, shown(unset));
  const unsetAgain = run(["config", "unset", "persona", "--space", "demo", "--json"]);
  check("unsetting a value that is not set is a no-op", unsetAgain.status === 0 && unsetAgain.envelope?.outcome === "no-op", shown(unsetAgain));
}

// ── refusals: each one exit 1 and the file unchanged ─────────────────────────────────────────────
{
  const before = fileText();
  const refusals: [string, string[], RegExp][] = [
    ["an unknown key names the valid keys", ["config", "set", "colour", "never"], /unknown preference "colour"; valid keys: harness, persona, detach-key, color, editor/],
    ["a color outside auto, always and never", ["config", "set", "color", "purple"], /invalid color "purple": use auto, always, never/],
    ["a detach key that is not ctrl-<char> or ^<char>", ["config", "set", "detach-key", "alt-x"], /invalid detach-key "alt-x"/],
    ["an empty persona", ["config", "set", "persona", " "], /invalid persona " ": it cannot be empty/],
    ["a harness no connector provides, naming the known ones", ["config", "set", "harness", "nosuch"], /no harness "nosuch"; known harnesses: .*claude.*opencode/],
    ["color saved for one space", ["config", "set", "color", "never", "--space", "demo"], /color has no per-space value/],
    ["color saved for a space this machine does not know still names the key", ["config", "set", "color", "never", "--space", "nope"], /color has no per-space value/],
    ["--user with --space", ["config", "get", "harness", "--user", "--space", "demo"], /--user and --space choose different scopes/],
    ["a space name with a space in it", ["config", "--space", "a b"], /"a b" is not a space name/],
    ["get without a key", ["config", "get"], /usage: cotal config get <key>/],
    ["set without a value", ["config", "set", "harness"], /usage: cotal config set <key> <value>/],
    ["an unknown subcommand", ["config", "show"], /cotal config has no subcommand "show"/],
  ];
  for (const [name, args, message] of refusals) {
    const r = run([...args, "--json"]);
    check(`refused: ${name}`, r.status === 1 && r.envelope?.outcome === "refused" && r.envelope.error?.code === "USAGE_INVALID" && message.test(r.envelope.error.message) && fileText() === before, shown(r));
    // A refusal that wrote anyway is graded above. Put the file back so the later sections still run.
    if (fileText() !== before) before === null ? rmSync(file) : writeFileSync(file, before);
  }
  const both = run(["config", "--json", "--plain"]);
  check("--json with --plain is refused", both.status === 1 && both.envelope?.error?.code === "USAGE_INVALID", shown(both));
  // A value saved for a space that is neither registered nor prepared would never apply.
  const unknown = run(["config", "set", "persona", "rev", "--space", "nope", "--json"]);
  check("set for a space that is neither registered nor prepared is refused, naming the known spaces, and writes nothing",
    unknown.status === 2 && unknown.envelope?.outcome === "refused" && unknown.envelope.error?.code === "TARGET_NOT_FOUND" && /no space named "nope" is registered or prepared here; known spaces: demo$/.test(unknown.envelope.error.message) && fileText() === before, shown(unknown));
  // A read or an unset for such a space is refused the same way, unless the space still holds a saved value.
  for (const args of [["config", "--space", "nope"], ["config", "get", "persona", "--space", "nope"], ["config", "unset", "persona", "--space", "nope"]]) {
    const r = run([...args, "--json"]);
    check(`\`${args.join(" ")}\` is refused, naming the known spaces, and writes nothing`,
      r.status === 2 && r.envelope?.outcome === "refused" && r.envelope.error?.code === "TARGET_NOT_FOUND" && /no space named "nope" is registered, prepared or holding a saved value here; known spaces: demo$/.test(r.envelope.error.message) && fileText() === before, shown(r));
  }
  writeFileSync(file, JSON.stringify({ ...saved(), spaces: { ...saved().spaces, gone: { persona: "old" } } }));
  const goneGet = run(["config", "get", "persona", "--space", "gone", "--json"]);
  check("a value left for a removed space can still be read", goneGet.status === 0 && (goneGet.envelope?.result as { setting?: Setting } | null)?.setting?.winner?.source === "space" && (goneGet.envelope?.result as { setting?: Setting } | null)?.setting?.value === "old", shown(goneGet));
  const goneUnset = run(["config", "unset", "persona", "--space", "gone", "--json"]);
  check("a value left for a removed space can still be removed", goneUnset.status === 0 && goneUnset.envelope?.outcome === "ok" && saved().spaces.gone === undefined, shown(goneUnset));
  if (before !== null) writeFileSync(file, before);
  // A persona's harness pin takes the same check as the harness preference.
  const pinned = run(["persona", "create", "pinned", "--prompt", "hi", "--subscribe", "", "--harness", "nosuch", "--json"], {}, project);
  check("persona create --harness refuses a harness no connector provides, writing no file",
    pinned.status === 1 && pinned.envelope?.error?.code === "USAGE_INVALID" && /no harness "nosuch"; known harnesses: .*claude.*opencode/.test(pinned.envelope.error.message) && !existsSync(join(project, ".cotal", "agents", "pinned.md")), shown(pinned));
}

// ── the named environment tiers ──────────────────────────────────────────────────────────────────
{
  run(["config", "set", "harness", "codex", "--space", "demo"]);
  const env = run(["config", "get", "harness", "--space", "demo", "--json"], { COTAL_DEFAULT_AGENT: "jcode" });
  const s = (env.envelope?.result as { setting?: Setting } | null)?.setting;
  check("COTAL_DEFAULT_AGENT beats the space's and the user's saved harness, which it lists as shadowed", s?.value === "jcode" && s.winner?.source === "environment" && s.winner.name === "COTAL_DEFAULT_AGENT" && JSON.stringify(s.shadowed.map((l) => `${l.source}:${l.value}`)) === JSON.stringify(["space:codex", "user:opencode", "default:claude"]), s);
  const shadowedSet = run(["config", "set", "harness", "pi", "--json"], { COTAL_DEFAULT_AGENT: "jcode" });
  check("a write that a variable outranks in this shell says so", shadowedSet.status === 0 && shadowedSet.envelope?.warnings.some((w) => w.code === "PREFERENCE_SHADOWED" && /COTAL_DEFAULT_AGENT \(jcode\) outranks this value/.test(w.message)) === true, shown(shadowedSet));
  const shadowedPlain = run(["config", "set", "harness", "opencode"], { COTAL_DEFAULT_AGENT: "jcode" });
  check("the plain write prints that warning on stderr", shadowedPlain.status === 0 && /! COTAL_DEFAULT_AGENT \(jcode\) outranks this value in this shell/.test(shadowedPlain.stderr), shown(shadowedPlain));
  run(["config", "unset", "harness", "--space", "demo"]);

  run(["config", "set", "color", "always"]);
  const noColor = run(["config", "get", "color", "--json"], { NO_COLOR: "1" });
  const c1 = (noColor.envelope?.result as { setting?: Setting } | null)?.setting;
  check("a non-empty NO_COLOR beats a saved color=always", c1?.value === "never" && c1.winner?.name === "NO_COLOR" && c1.shadowed[0]?.source === "user" && c1.shadowed[0]?.value === "always", c1);
  const forced = run(["config", "get", "color", "--json"], { NO_COLOR: "1", FORCE_COLOR: "1" });
  const c2 = (forced.envelope?.result as { setting?: Setting } | null)?.setting;
  check("FORCE_COLOR keeps its precedence over NO_COLOR", c2?.value === "always" && c2.winner?.name === "FORCE_COLOR", c2);
  const empty = run(["config", "get", "color", "--json"], { NO_COLOR: "" });
  check("an empty NO_COLOR supplies nothing", (empty.envelope?.result as { setting?: Setting } | null)?.setting?.winner?.source === "user", empty.envelope?.result);

  const editors = run(["config", "--json"], { VISUAL: "vi-visual", EDITOR: "vi-editor" });
  const e = settingOf(editors, "editor");
  check("VISUAL beats EDITOR for the editor", e?.value === "vi-visual" && e.shadowed[0]?.name === "EDITOR", e);
  const blankVisual = run(["config", "--json"], { VISUAL: "", EDITOR: "vi-editor" });
  check("an empty VISUAL falls to EDITOR, as before", settingOf(blankVisual, "editor")?.value === "vi-editor", settingOf(blankVisual, "editor"));
  const persona = run(["config", "--json"], { COTAL_DEFAULT_PERSONA: "lead", COTAL_DETACH_KEY: "^_" });
  check("COTAL_DEFAULT_PERSONA and COTAL_DETACH_KEY supply their keys", settingOf(persona, "persona")?.winner?.name === "COTAL_DEFAULT_PERSONA" && settingOf(persona, "detach-key")?.value === "^_", persona.envelope?.result);
  check("valid values from the environment raise no warning", persona.status === 0 && persona.envelope?.warnings.length === 0, persona.envelope?.warnings);

  // A variable with a value `config set` refuses still wins, and every read names it.
  const invalidEnv = { COTAL_DETACH_KEY: "bogus", COTAL_DEFAULT_AGENT: "bogus", COTAL_DEFAULT_PERSONA: "bad:name" };
  const invalid = run(["config", "--json"], invalidEnv);
  const named = (r: ReturnType<typeof run>) => (r.envelope?.warnings ?? []).filter((w) => w.code === "PREFERENCE_INVALID").map((w) => (w as { target: { variable: string } } & typeof w).target.variable).sort().join();
  check("config names each variable whose value config set refuses, and each still wins",
    invalid.status === 0 && invalid.envelope?.outcome === "ok" && named(invalid) === "COTAL_DEFAULT_AGENT,COTAL_DEFAULT_PERSONA,COTAL_DETACH_KEY" &&
      settingOf(invalid, "detach-key")?.value === "bogus" && settingOf(invalid, "harness")?.winner?.name === "COTAL_DEFAULT_AGENT" && settingOf(invalid, "persona")?.value === "bad:name", invalid.envelope);
  const one = run(["config", "get", "detach-key"], invalidEnv);
  check("config get names its own key's variable on stderr", one.status === 0 && /! COTAL_DETACH_KEY: invalid detach-key "bogus"/.test(one.stderr) && !/COTAL_DEFAULT_AGENT/.test(one.stderr), shown(one));
  const statusRun = run(["status", "--json"], invalidEnv);
  check("status names them too and stays complete", statusRun.envelope?.completeness === "complete" && named(statusRun) === "COTAL_DEFAULT_AGENT,COTAL_DEFAULT_PERSONA,COTAL_DETACH_KEY", { status: statusRun.status, outcome: statusRun.envelope?.outcome, warnings: statusRun.envelope?.warnings });
}

// ── the selected space ───────────────────────────────────────────────────────────────────────────
{
  run(["config", "set", "persona", "demo-lead", "--space", "demo"]);
  mkdirSync(cotalHome, { recursive: true });
  writeFileSync(join(cotalHome, "current-mesh"), "demo");
  const selected = run(["config", "--json"]);
  const res = selected.envelope?.result as { scope?: { space: string; from: string } } | null;
  check("bare config reads through the selected space", res?.scope?.space === "demo" && res.scope.from === "selected" && settingOf(selected, "persona")?.value === "demo-lead" && JSON.stringify(selected.envelope?.target) === JSON.stringify({ space: "demo" }), selected.envelope);
  const plain = run(["config", "--plain"]);
  check("the plain view says the scope is the selected space", /^Preferences\n {2}space demo \(selected\)$/m.test(plain.stdout), shown(plain));
  check("--user ignores the selection", settingOf(run(["config", "--user", "--json"]), "persona")?.value === "default");
  const write = run(["config", "set", "persona", "mine", "--json"]);
  check("a write without --space goes to your defaults, and reports the selected space's value still winning here", saved().defaults.persona === "mine" && (write.envelope?.result as { effective?: Setting } | null)?.effective?.value === "demo-lead" && write.envelope?.warnings.some((w) => w.code === "PREFERENCE_SHADOWED" && /your preference for space demo \(demo-lead\)/.test(w.message)) === true, shown(write));
  // --user chooses where the value is saved, not what a command here uses: the receipt used to give
  // your defaults' value while spawn took the selected space's.
  const userWrite = run(["config", "set", "persona", "solo", "--user", "--json"]);
  check("a write with --user reports the selected space's value still winning here, and warns",
    saved().defaults.persona === "solo" && (userWrite.envelope?.result as { effective?: Setting } | null)?.effective?.value === "demo-lead" && userWrite.envelope?.warnings.some((w) => w.code === "PREFERENCE_SHADOWED") === true, userWrite.envelope);
  rmSync(join(cotalHome, "current-mesh"));
  const folderWrite = run(["config", "set", "harness", "claude", "--user", "--json"], {}, join(home, "demo"));
  run(["config", "set", "harness", "opencode", "--space", "demo"]);
  const folderAgain = run(["config", "set", "harness", "codex", "--user", "--json"], {}, join(home, "demo"));
  check("with nothing selected, a --user write in a prepared folder reports that folder's value",
    folderWrite.status === 0 && (folderAgain.envelope?.result as { effective?: Setting } | null)?.effective?.value === "opencode" && folderAgain.envelope?.warnings.some((w) => w.code === "PREFERENCE_SHADOWED") === true, folderAgain.envelope);
  run(["config", "unset", "harness"]);
  run(["config", "unset", "harness", "--space", "demo"]);
  run(["config", "unset", "persona"]);
  run(["config", "unset", "persona", "--space", "demo"]);
}

// ── with nothing selected, a read goes through the space spawn uses from this folder ──────────────
// It used to read your defaults while spawn took the folder's value.
{
  const demoRoot = join(home, "demo");
  run(["config", "set", "harness", "opencode", "--space", "demo"]);
  run(["config", "set", "harness", "claude"]);
  const here = run(["config", "get", "harness", "--json"], {}, demoRoot);
  const res = here.envelope?.result as { scope?: { space: string; from: string }; setting?: Setting } | null;
  check("in a prepared folder with nothing selected, get reads through that folder's space",
    here.status === 0 && res?.scope?.space === "demo" && res.scope.from === "folder" && res.setting?.value === "opencode" && JSON.stringify(here.envelope?.target) === JSON.stringify({ space: "demo" }), here.envelope);
  const plain = run(["config", "--plain"], {}, demoRoot);
  check("the plain view says the scope is this folder's space", /^Preferences\n {2}space demo \(this folder's\)$/m.test(plain.stdout), shown(plain));
  const preview = run(["spawn", "--dry-run", "--json"], {}, demoRoot);
  check("spawn there takes the same value", preview.status === 0 && (preview.envelope?.result as { harness?: string } | null)?.harness === "opencode", shown(preview));
  const ghost = run(["config", "set", "persona", "ghost", "--json"], {}, demoRoot);
  check("a persona that folder's catalog does not hold is saved with PERSONA_NOT_FOUND",
    ghost.status === 0 && saved().defaults.persona === "ghost" && ghost.envelope?.warnings.some((w) => w.code === "PERSONA_NOT_FOUND" && w.message.startsWith('no persona "ghost" in space demo\'s catalog')) === true, ghost.envelope);
  const away = run(["config", "get", "harness", "--json"]);
  check("outside a project, with nothing running, a read is your defaults", (away.envelope?.result as { scope?: { space: unknown } } | null)?.scope?.space === null && (away.envelope?.result as { setting?: Setting } | null)?.setting?.value === "claude", away.envelope);
  run(["config", "unset", "persona"]);
  run(["config", "unset", "harness"]);
  run(["config", "unset", "harness", "--space", "demo"]);
}

// ── a persona the space's catalog does not hold is saved, with a warning naming the catalog ──────
{
  const catProject = join(home, "cat-project");
  mkdirSync(catProject);
  const created = run(["space", "create", "cat"], {}, catProject);
  check("fixture: a prepared space with its own catalog", created.status === 0, shown(created));
  const catalog = join(realpathSync(catProject), ".cotal", "agents");
  const warned = (r: ReturnType<typeof run>) => r.envelope?.warnings.find((w) => w.code === "PERSONA_NOT_FOUND");
  const ghost = run(["config", "set", "persona", "ghost", "--space", "cat", "--json"]);
  check("a name the catalog does not hold is saved, with PERSONA_NOT_FOUND naming the catalog",
    ghost.status === 0 && ghost.envelope?.outcome === "ok" && saved().spaces.cat?.persona === "ghost" && warned(ghost)?.message === `no persona "ghost" in space cat's catalog ${catalog}; the preference was saved, and a launch there needs that file`,
    ghost.envelope);
  const ghostText = run(["config", "set", "persona", "ghost2", "--space", "cat"]);
  check("the text report says so on stderr", ghostText.status === 0 && ghostText.stderr.includes(`no persona "ghost2" in space cat's catalog ${catalog}`), shown(ghostText));
  writeFileSync(join(catalog, "real.md"), "---\nname: real\n---\nhi\n");
  const real = run(["config", "set", "persona", "real", "--space", "cat", "--json"]);
  check("a name the catalog holds raises no warning", real.status === 0 && warned(real) === undefined, real.envelope);
  const path = run(["config", "set", "persona", "./nosuch.md", "--space", "cat", "--json"]);
  check("a persona file path that is missing names the file", path.status === 0 && warned(path)?.message.startsWith(`no persona file ${join(realpathSync(catProject), "nosuch.md")};`) === true, path.envelope);
  const broken = run(["config", "set", "persona", "bad name", "--space", "cat", "--json"]);
  check("a name that breaks the persona name rule is still refused", broken.status === 1 && broken.envelope?.error?.code === "USAGE_INVALID", broken.envelope);
  run(["config", "unset", "persona", "--space", "cat"]);
}

// ── consumers: color, the editor, the detach key ─────────────────────────────────────────────────
{
  run(["config", "set", "color", "always"]);
  const refusal = ["ext", "remove", "not-installed"];
  check("a saved color=always colors piped output", ansi.test(run(refusal).stderr), shown(run(refusal)));
  check("NO_COLOR beats the saved color=always", !ansi.test(run(refusal, { NO_COLOR: "1" }).stderr));
  check("--no-color beats the saved color=always", !ansi.test(run(["--no-color", ...refusal]).stderr));
  run(["config", "set", "color", "never"]);
  check("FORCE_COLOR beats a saved color=never", ansi.test(run(refusal, { FORCE_COLOR: "1" }).stderr));
  run(["config", "unset", "color"]);
  check("control: with nothing saved, piped output has no color", !ansi.test(run(refusal).stderr));

  const mark = join(home, "edited");
  const marker = (who: string) => `node -e "require('fs').writeFileSync(process.env.EDIT_MARK, '${who}')"`;
  run(["config", "set", "editor", marker("saved")]);
  rmSync(mark, { force: true });
  const edited = run(["personas", "edit", "x"], { EDIT_MARK: mark }, project);
  check("personas edit opens the saved editor when VISUAL and EDITOR are unset", edited.status === 0 && existsSync(mark) && readFileSync(mark, "utf8") === "saved", { ...shown(edited), mark: existsSync(mark) && readFileSync(mark, "utf8") });
  rmSync(mark, { force: true });
  const envEditor = run(["personas", "edit", "x"], { EDIT_MARK: mark, EDITOR: marker("env") }, project);
  check("EDITOR beats the saved editor", envEditor.status === 0 && readFileSync(mark, "utf8") === "env", shown(envEditor));
  run(["config", "unset", "editor"]);
  const none = run(["personas", "edit", "x"], {}, project);
  check("with no editor anywhere, personas edit names both ways to set one", none.status === 2 && none.stderr.includes("set VISUAL or EDITOR, or run `cotal config set editor vim`"), shown(none));

  // The detach key is read by the attach client before it connects; drive that function in-process.
  process.env.XDG_CONFIG_HOME = xdg;
  for (const k of ["COTAL_DETACH_KEY"]) delete process.env[k];
  const { detachKey } = await import("../../implementations/cli/src/lib/attach-client.js");
  const plain = detachKey();
  check("the detach key defaults to Ctrl-]", plain.byte === 0x1d && plain.label === "Ctrl-]" && !plain.overridden, plain);
  const { readPreferences, writePreference } = await import("@cotal-ai/workspace");
  writePreference({}, "detach-key", "ctrl-b", readPreferences().revision);
  const savedKey = detachKey();
  check("a saved detach-key rebinds it and names its source", savedKey.byte === 0x02 && savedKey.label === "Ctrl-B" && savedKey.overridden && savedKey.from === "your preference", savedKey);
  process.env.COTAL_DETACH_KEY = "^_";
  const envKey = detachKey();
  check("COTAL_DETACH_KEY beats the saved detach-key", envKey.byte === 0x1f && envKey.from === "COTAL_DETACH_KEY", envKey);
  process.env.COTAL_DETACH_KEY = "meta-x";
  let thrown = "";
  try {
    detachKey();
  } catch (e) {
    thrown = (e as Error).message;
  }
  check("an unparseable COTAL_DETACH_KEY still fails loud, by name", /invalid COTAL_DETACH_KEY "meta-x"/.test(thrown), thrown);
  delete process.env.COTAL_DETACH_KEY;

  // A writer that read an older revision is refused, and the file is not touched.
  const at = readPreferences().revision;
  const beforeStale = fileText();
  let conflict: { code?: string; outcome?: string } = {};
  try {
    writePreference({}, "persona", "late", at - 1);
  } catch (e) {
    conflict = e as { code?: string; outcome?: string };
  }
  check("a write from a stale revision is refused with CONFLICT and changes nothing", conflict.code === "CONFLICT" && conflict.outcome === "refused" && fileText() === beforeStale, conflict);
  writePreference({}, "detach-key", undefined, readPreferences().revision);
}

// ── two writers at once both land ────────────────────────────────────────────────────────────────
{
  const start = saved().revision;
  const writer = (args: string[]) =>
    new Promise<number | null>((resolve) => {
      const child = spawn(process.execPath, [BIN, ...args], { cwd: home, env: sandboxEnv({}), stdio: "ignore" });
      child.on("exit", (code) => resolve(code));
    });
  const codes = await Promise.all([writer(["config", "set", "persona", "one"]), writer(["config", "set", "editor", "two"])]);
  const after = saved();
  // A writer that read before the other wrote is refused (CONFLICT, exit 2) rather than losing its
  // edit; one that read after lands. Either way the file holds every edit that reported success.
  const landed = [after.defaults.persona === "one", after.defaults.editor === "two"];
  check("two concurrent writers lose no reported write", codes.every((code, i) => (code === 0 ? landed[i] : code === 2 && !landed[i])) && after.revision === start + landed.filter(Boolean).length, { codes, after });
  run(["config", "unset", "persona"]);
  run(["config", "unset", "editor"]);
}

// ── a write replaces a file whose mode is not 0600, and says so ──────────────────────────────────
// A read-only 0400 file used to come back at 0600 without a word.
if (process.platform !== "win32") {
  run(["config", "set", "color", "always"]);
  chmodSync(file, 0o400);
  const r = run(["config", "set", "color", "never", "--json"]);
  check("a write over a 0400 file names the old mode in PREFERENCES_MODE_CHANGED and leaves a 0600 file",
    r.status === 0 && r.envelope?.warnings.some((w) => w.code === "PREFERENCES_MODE_CHANGED" && w.message === `${file} was mode 0400, and this write replaced it with a new file at mode 0600; a file's mode does not stop config set or unset`) === true && (statSync(file).mode & 0o777) === 0o600 && saved().defaults.color === "never", r.envelope);
  const text = run(["config", "set", "color", "always"]);
  check("a write over a 0600 file says nothing about its mode", text.status === 0 && !/was mode/.test(text.stderr), shown(text));
  run(["config", "unset", "color"]);
}

// ── a preferences folder you cannot write is refused, naming it, and nothing changes ─────────────
if (process.platform !== "win32" && process.getuid?.() !== 0) {
  const dir = join(xdg, "cotal");
  const before = fileText();
  chmodSync(dir, 0o500);
  try {
    const r = run(["config", "set", "color", "always", "--json"]);
    check("a read-only preferences folder is refused with PERMISSION_DENIED, exit 2, naming the folder",
      r.status === 2 && r.envelope?.outcome === "refused" && r.envelope.error?.code === "PERMISSION_DENIED" && r.envelope.error.message.includes(dir) && /chmod u\+w/.test(r.envelope.error.remedy ?? ""), shown(r));
    check("and the read-only folder's preferences are unchanged", fileText() === before);
  } finally {
    chmodSync(dir, 0o700);
  }
}

// ── a preferences folder other local accounts can write: a read warns, a write is refused ─────────
// World write is refused on every host; group write depends on whether the host proves a private group.
if (process.platform !== "win32") {
  const dir = join(xdg, "cotal");
  run(["config", "set", "editor", "vi"]);
  const before = fileText();
  const unprotected = (w: { code: string; message: string; target?: unknown }) =>
    w.code === "PREFERENCES_FOLDER_UNPROTECTED" && (w.target as { path?: string } | undefined)?.path === dir && w.message.includes(`${dir} is writable by every local account`) && w.message.endsWith(`chmod o-w ${dir}`);
  chmodSync(dir, 0o757);
  try {
    const write = run(["config", "set", "editor", "ed", "--json"]);
    check("a write into a world-writable preferences folder is refused with PERMISSION_DENIED, exit 2, naming the folder and its chmod",
      write.status === 2 && write.envelope?.error?.code === "PERMISSION_DENIED" && (write.envelope.error.message ?? "").includes(`the preferences folder is not protected against other local writers: ${dir} is writable by every local account`) && write.envelope.error.remedy === `chmod o-w ${dir}`, shown(write));
    check("and the file is left as it was", fileText() === before);
    const read = run(["config", "--json"]);
    check("a read applies the saved values with a PREFERENCES_FOLDER_UNPROTECTED warning naming the folder and its chmod",
      read.status === 0 && read.envelope?.outcome === "ok" && settingOf(read, "editor")?.value === "vi" && read.envelope.warnings.filter(unprotected).length === 1 && read.stderr.includes("! the preferences folder is not protected"), shown(read));
    const status = run(["status", "--json"]);
    const hints = ((status.envelope?.result as { hints?: string[] } | null)?.hints ?? []);
    check("status warns too, and its Next protects the folder", status.status === 0 && (status.envelope?.warnings ?? []).some(unprotected) && hints.includes(`protect the preferences folder: chmod o-w ${dir}`), shown(status));
    const other = run(["ext", "root"]);
    check("every command that uses the preferences warns", other.status === 0 && other.stderr.includes(`! the preferences folder is not protected against other local writers: ${dir}`), shown(other));
    const version = run(["version"]);
    check("version, which uses no preference, does not warn", version.status === 0 && !version.stderr.includes("not protected"), shown(version));
  } finally {
    chmodSync(dir, 0o700);
  }
  const quiet = run(["config", "--json"]);
  check("a protected folder gives no warning", quiet.status === 0 && quiet.envelope?.warnings.every((w) => w.code !== "PREFERENCES_FOLDER_UNPROTECTED") === true && !quiet.stderr.includes("not protected"), shown(quiet));
  run(["config", "unset", "editor"]);
  // A folder not made yet is checked from the nearest folder above it, and nothing is created.
  const open = mkdtempSync(join(home, "open-config-"));
  chmodSync(open, 0o757);
  const fresh = run(["config", "set", "color", "never", "--json"], { XDG_CONFIG_HOME: open });
  check("a write whose folder would be made in a world-writable parent is refused, and nothing is created",
    fresh.status === 2 && fresh.envelope?.error?.code === "PERMISSION_DENIED" && fresh.envelope.error.remedy === `chmod o-w ${open}` && readdirSync(open).length === 0, shown(fresh));
  chmodSync(open, 0o700);
}

// ── a linked preferences file is refused as a private record's link is, and never replaced ──────────
if (process.platform !== "win32") {
  run(["config", "set", "editor", "vi"]);
  const before = fileText();
  const target = join(home, "dotfiles-preferences.json");
  writeFileSync(target, before!, { mode: 0o600 });
  rmSync(file);
  symlinkSync(target, file);
  try {
    const read = run(["config", "--json"]);
    check("a symlinked preferences file is refused with PERMISSION_DENIED, exit 2, naming the link and its target",
      read.status === 2 && read.envelope?.error?.code === "PERMISSION_DENIED" && (read.envelope.error.message ?? "").includes(`${file} is a symbolic link to ${target}`), shown(read));
    const other = run(["ext", "root"]);
    check("it stops other commands too, as an invalid file does", other.status === 2 && other.stderr.includes(target), shown(other));
    const version = run(["version"]);
    check("and, as with an invalid file, version still works", version.status === 0 && version.stdout !== "" && !version.stderr.includes(target), shown(version));
    const write = run(["config", "set", "editor", "ed"]);
    check("config set leaves the link and its target as they were",
      write.status === 2 && lstatSync(file).isSymbolicLink() && readFileSync(target, "utf8") === before, shown(write));
  } finally {
    rmSync(file);
    writeFileSync(file, before!, { mode: 0o600 });
  }
  run(["config", "unset", "editor"]);
}

// ── an invalid file stops every command that could act on a default, and is never reset ──────────
{
  for (const [name, text, message] of [
    ["not JSON", "{ nope", /not JSON/],
    ["a newer schema", JSON.stringify({ schemaVersion: 2, revision: 1, defaults: {}, spaces: {} }), /schemaVersion 2 is not 1; this cotal reads version 1/],
    ["an unknown key", JSON.stringify({ schemaVersion: 1, revision: 1, defaults: { colour: "never" }, spaces: {} }), /defaults has an unknown key "colour"/],
    ["an invalid value", JSON.stringify({ schemaVersion: 1, revision: 1, defaults: { color: "sometimes" }, spaces: {} }), /defaults\.color "sometimes": use auto, always, never/],
    ["a per-space color", JSON.stringify({ schemaVersion: 1, revision: 1, defaults: {}, spaces: { demo: { color: "never" } } }), /spaces\.demo sets "color", which has no per-space value/],
  ] as const) {
    writeFileSync(file, text);
    const r = run(["config", "--json"]);
    check(`an invalid file (${name}) is refused with SCHEMA_INVALID, naming the file`, r.status === 1 && r.envelope?.error?.code === "SCHEMA_INVALID" && message.test(r.envelope.error.message) && r.envelope.error.message.includes(file) && /nothing resets it/.test(r.envelope.error.remedy ?? ""), shown(r));
    check(`and the file (${name}) is left as it was`, fileText() === text);
  }
  const other = run(["ext", "root"]);
  check("an invalid file stops other commands too, before they run", other.status === 1 && /the preferences file .* is invalid/.test(other.stderr) && other.stdout === "", shown(other));
  const write = run(["config", "set", "color", "never"]);
  check("a write does not replace an invalid file", write.status === 1 && /is invalid/.test(write.stderr) && fileText()?.includes("spaces") === true, shown(write));
  const help = run(["config", "--help"]);
  check("help still works", help.status === 0 && /cotal config/.test(help.stdout), shown(help));
  for (const args of [["help"], ["--help"], ["help", "config"], ["completion"], ["completion", "script", "bash"]]) {
    const r = run(args);
    check(`cotal ${args.join(" ")} still works`, r.status === 0 && r.stdout !== "" && !/is invalid/.test(r.stderr), shown(r));
  }
  // version and docs use no preference. They used to refuse with SCHEMA_INVALID like every other command.
  for (const args of [["version"], ["version", "--json"], ["docs"], ["docs", "cli"]]) {
    const r = run(args);
    check(`cotal ${args.join(" ")} uses no preference and still works`, r.status === 0 && r.stdout !== "" && !/is invalid/.test(r.stderr), shown(r));
  }
  // status reports the file as one part it could not read, names it, and gives the fix as the next step.
  const report = run(["status", "--json"]);
  const warning = report.envelope?.warnings.find((w) => w.code === "PREFERENCES_UNREADABLE");
  check("status reports an invalid file as a warning naming it, partial, exit 4",
    report.status === 4 && report.envelope?.outcome === "partial" && warning?.message.startsWith(`the saved agent defaults could not be read: the preferences file ${file} is invalid`) === true, shown(report));
  const text = run(["status"]);
  const next = text.stdout.slice(text.stdout.indexOf("Next"));
  check("and its Next says to fix or remove the file", text.status === 4 && next.includes(`fix or remove ${file}; nothing resets it`) && text.stderr.includes(`the preferences file ${file} is invalid`), shown(text));
  check("status leaves the file as it was", fileText()?.includes("spaces") === true);
  rmSync(file);
  check("removing the file restores the defaults", run(["config", "--json"]).status === 0);
}

// ── a COTAL_HOME that is not a directory stops every command but help and completion ─────────────
{
  const notHome = join(home, "not-a-home");
  writeFileSync(notHome, "a file\n");
  for (const [name, value] of [["a file", notHome], ["a path under a file", join(notHome, "sub")]] as const) {
    const r = run(["space", "create", "x", "--root", project, "--json"], { COTAL_HOME: value });
    check(`a COTAL_HOME that is ${name} is refused with SCHEMA_INVALID, naming it, and the command does not run`,
      r.status === 1 && r.envelope?.outcome === "refused" && r.envelope.error?.code === "SCHEMA_INVALID" && r.envelope.error.message.includes(`COTAL_HOME ${value} is not a directory`) &&
        /point COTAL_HOME at a directory, or unset it/.test(r.envelope.error.remedy ?? ""), shown(r));
  }
  const status = run(["status"], { COTAL_HOME: notHome });
  check("status there gives the same refusal, not the raw read error", status.status === 1 && /COTAL_HOME .* is not a directory/.test(status.stderr) && !/ENOTDIR/.test(status.stdout + status.stderr), shown(status));
  const help = run(["help"], { COTAL_HOME: notHome });
  check("help still works", help.status === 0 && help.stdout !== "", shown(help));
  check("and the file is left as it was", readFileSync(notHome, "utf8") === "a file\n");
}

finish();
