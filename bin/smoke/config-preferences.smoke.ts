/**
 * `cotal config` and the preferences it saves, driven through the built binary in a fresh sandbox:
 * the effective values with their sources and shadowed values, `get`, `set` and `unset` for the user
 * and for one space, the refusals (a read, set or unset for a space this machine does not know among
 * them), a value left for a removed space, the named environment tiers, the selected space, an invalid
 * file stopping every command but help and completion without being reset, a linked file stopping
 * them the same way, a FIFO stopping them without being opened, a `COTAL_HOME` that is not a directory
 * stopping them the same way, a config folder that is a file stopping every command but help, version,
 * docs and completion, a folder other accounts can write refusing a write and warning on a read, a
 * config folder reached through an owned private symlink taking the same write a physical folder
 * takes, a relative `COTAL_HOME` refused, a home other accounts can write taking no write and one they can only
 * read made private on the write, a stale write refused, a persona the space's catalog does not hold
 * saved with a warning that names the catalog, two concurrent writers both landing, and the consumers
 * outside `spawn`: color, the `personas edit` editor and the detach key. A file that begins with a UTF-8 byte-order mark reads, and the next write leaves the
 * mark out; one saved as UTF-16 is refused by its encoding.
 * The launch consumers (harness, persona) are proved through real spawns in `smoke:persona-agent`.
 * Broker-free and offline.
 *
 * Run: pnpm smoke:config-preferences
 */
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, relative } from "node:path";
import { createSuite } from "@cotal-ai/smoke-kit";
import {
  assertPreferencesFolderProtected, assertProtectedEntry, isCommandFailure, localWriterGap, meshFile,
  recordMesh, removeMesh, removeSpacePreferences, trustProject, writePreference,
} from "@cotal-ai/workspace";

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
process.env.COTAL_HOME = cotalHome; // Registry fixtures use the same isolated home as the child CLI.
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
  check("every key is listed, in order", JSON.stringify(res?.settings.map((s) => s.key)) === JSON.stringify(["harness", "persona", "detach-key", "color", "editor", "name"]), res?.settings.map((s) => s.key));
  check("each key with a product default resolves to it, and the editor to nothing", settingOf(r, "harness")?.winner?.source === "default" && settingOf(r, "persona")?.value === "default" && settingOf(r, "detach-key")?.value === "ctrl-]" && settingOf(r, "color")?.value === "auto" && settingOf(r, "editor")?.value === null && settingOf(r, "editor")?.winner === null, res?.settings);
  check("reading writes nothing", !existsSync(file));
  const get = run(["config", "get", "name", "--user", "--json"]);
  const name = (get.envelope?.result as { setting?: Setting } | null)?.setting;
  check("an unset name has a null winner and no shadowed layers", get.status === 0 &&
    name?.value === null && name.winner === null && name.shadowed.length === 0, shown(get));
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
  check("user and default layers omit the name property", !!s?.winner && !("name" in s.winner) &&
    s.shadowed.length === 1 && !("name" in s.shadowed[0]!), s);
  const again = run(["config", "set", "harness", "opencode", "--json"]);
  check("setting the same value again is a no-op, exit 0, and writes nothing", again.status === 0 && again.envelope?.outcome === "no-op" && saved().revision === 1, shown(again));
  const before = fileText();
  for (const operands of [["unset", "harness"], ["set", "harness", "claude"]]) {
    const unknown = run(["config", ...operands, "--user", "--json", "--wibble"]);
    const error = unknown.envelope?.error;
    check(`config ${operands.join(" ")} tells the caller to drop an unknown option without writing`,
      unknown.status === 1 && unknown.stderr === "" && unknown.envelope?.outcome === "refused" && error?.code === "USAGE_INVALID"
      && error.message === "Unknown option '--wibble'" && error.remedy === "drop the unknown option" && fileText() === before, shown(unknown));
  }
  for (const operands of [["unset"], ["set", "harness"]]) {
    const missing = run(["config", ...operands, "--space", "demo", "--json", "--wibble"]);
    check(`config ${operands.join(" ")} does not count a space option's value as an operand`,
      missing.status === 1 && missing.envelope?.error?.remedy === 'to pass a word that starts with "-", put -- before it', shown(missing));
  }
  // A per-space value is saved only for a space this machine knows, so prepare demo first.
  mkdirSync(join(home, "demo"), { recursive: true });
  const prepared = run(["space", "create", "demo", "--root", join(home, "demo"), "--json"]);
  check("setup: demo is prepared", prepared.status === 0 && prepared.envelope?.outcome === "ok", shown(prepared));
  const grouped = run(["config", "get", "harness", "-js", "demo"]);
  check("grouped -js selects JSON and reads the named space", grouped.status === 0 && grouped.stderr === "" && grouped.envelope?.outcome === "ok"
    && (grouped.envelope.target as { space?: string } | null)?.space === "demo", shown(grouped));
  for (const flags of [["-js"], ["-j", "-s"]]) {
    const missing = run(["config", "get", "harness", ...flags]);
    check(`${flags.join(" ")} keeps JSON when the space value is missing`, missing.status === 1 && missing.stderr === ""
      && missing.envelope?.outcome === "refused" && missing.envelope.error?.code === "USAGE_INVALID"
      && missing.envelope.error.message === "--space needs a value" && missing.envelope.error.remedy === "write --space <name>", shown(missing));
  }
  const attached = run(["config", "get", "harness", "-sj", "--bogus"]);
  check("a j in an attached space value does not select JSON", attached.status === 1 && attached.stdout === ""
    && attached.stderr.includes("Unknown option '--bogus'"), shown(attached));
  const dashValue = run(["config", "get", "harness", "-js", "\u2014help"]);
  check("a typographic help word after -js is a space value, not an option", dashValue.stderr === "" && dashValue.envelope?.outcome === "refused"
    && dashValue.envelope.error?.message.includes("\u2014help") === true && !dashValue.envelope.error.message.includes("typographic dash"), shown(dashValue));
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

// A registry read can block the follow-up report, not the user preference write.
{
  const xdg = join(home, "damaged-registry-config");
  const runHere = (args: string[]) => run(args, { XDG_CONFIG_HOME: xdg }, project);
  const add = runHere(["space", "add", "archived", "--server", "nats://127.0.0.1:47311", "--root", ".", "--force", "--yes", "--json"]);
  check("setup: archived is registered", add.status === 0, shown(add));
  const record = meshFile("archived");
  writeFileSync(record, "{");
  try {
    const set = runHere(["config", "set", "harness", "opencode", "--user", "--plain"]);
    const get = runHere(["config", "get", "harness", "--user", "--plain"]);
    check("a user set prints its saved value even when the effective value is unavailable",
      set.status === 0 && /harness = opencode in your defaults/.test(set.stdout) && /Effective value:\s+unavailable/.test(set.stdout) &&
      set.stderr.includes("Could not determine the effective value in this project") && set.stderr.includes(record) &&
      get.status === 0 && /Value:\s+opencode/.test(get.stdout), { set: shown(set), get: shown(get) });
    const preferences = join(xdg, "cotal", "preferences.json");
    const before = readFileSync(preferences, "utf8");
    const blocked = runHere(["config", "set", "harness", "claude", "--space", "archived", "--json"]);
    check("a write targeting the damaged space is still refused before changing preferences",
      blocked.status === 1 && blocked.envelope?.error?.code === "SCHEMA_INVALID" && readFileSync(preferences, "utf8") === before, shown(blocked));
    const unset = runHere(["config", "unset", "harness", "--user", "--json"]);
    const after = runHere(["config", "get", "harness", "--user", "--plain"]);
    check("a user unset succeeds with a partial receipt and a separate registry warning",
      unset.status === 0 && unset.envelope?.outcome === "ok" && unset.envelope.completeness === "partial" &&
      unset.envelope.result?.previous === "opencode" && unset.envelope.result.value === null && unset.envelope.result.effective === null &&
      unset.envelope.warnings.some((w) => w.code === "SCHEMA_INVALID" && w.message.includes(record) && w.message.includes("cotal space forget archived")) &&
      after.status === 0 && /Value:\s+claude/.test(after.stdout), { unset: shown(unset), after: shown(after) });
    check("the preference commands leave the damaged registration alone", readFileSync(record, "utf8") === "{");
  } finally {
    rmSync(record);
  }
}

// ── refusals: each one exit 1 and the file unchanged ─────────────────────────────────────────────
{
  const before = fileText();
  const refusals: [string, string[], RegExp][] = [
    ["an unknown key names the valid keys", ["config", "set", "colour", "never"], /unknown preference "colour"; valid keys: harness, persona, detach-key, color, editor, name/],
    ["a color outside auto, always and never", ["config", "set", "color", "purple"], /invalid color "purple": use auto, always, never/],
    ["a detach key that is not ctrl-<char> or ^<char>", ["config", "set", "detach-key", "alt-x"], /invalid detach-key "alt-x"/],
    ["an empty persona", ["config", "set", "persona", " "], /invalid persona " ": it cannot be empty/],
    ["a harness no connector provides, naming the known ones", ["config", "set", "harness", "nosuch"], /no harness "nosuch"; known harnesses: .*claude.*opencode/],
    ["color saved for one space", ["config", "set", "color", "never", "--space", "demo"], /color has no per-space value/],
    ["color saved for a space this machine does not know still names the key", ["config", "set", "color", "never", "--space", "nope"], /color has no per-space value/],
    ["--user with --space", ["config", "get", "harness", "--user", "--space", "demo"], /--user and --space choose different scopes/],
    ["a space name with a space in it", ["config", "--space", "a b"], /"a b" is not a space name/],
    ["a space name with a leading hyphen", ["config", "get", "harness", "--space=-1"], /starts with "-"/],
    ["a space name that is too long", ["config", "get", "harness", "--space", "x".repeat(65)], /at most 64/],
    ["get without a key", ["config", "get"], /usage: cotal config get <key>/],
    ["set without a value", ["config", "set", "harness"], /usage: cotal config set <key> <value>/],
    ["an unknown subcommand", ["config", "show"], /cotal config has no subcommand "show"/],
  ];
  for (const [name, args, message] of refusals) {
    const r = run([...args, "--json"]);
    check(`refused: ${name}`, r.status === 1 && r.envelope?.outcome === "refused" && r.envelope.error?.code === "USAGE_INVALID" && message.test(r.envelope.error.message) && Boolean(r.envelope.error.remedy) && fileText() === before, shown(r));
    // A refusal that wrote anyway is graded above. Put the file back so the later sections still run.
    if (fileText() !== before) before === null ? rmSync(file) : writeFileSync(file, before);
  }
  const both = run(["config", "--json", "--plain"]);
  check("--json with --plain is refused", both.status === 1 && both.envelope?.error?.code === "USAGE_INVALID", shown(both));
  const badName = run(["config", "get", "harness", "--space=-1", "--json"]);
  check("an invalid space selector asks for a valid name, not for a new space",
    badName.envelope?.error?.remedy === "choose a name that starts with a letter, digit or underscore", shown(badName));
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
  const occupied = join(home, "demo");
  const missing = run(["config", "get", "persona", "--space", "other_lab", "--json"], {}, occupied);
  const create = /`cotal (space create other_lab --root) <dir>`/.exec(missing.envelope?.error?.remedy ?? "")?.[1];
  const prepared = create === undefined ? undefined : run([...create.split(" "), join(home, "other-lab"), "--json"], {}, occupied);
  const found = run(["config", "get", "persona", "--space", "other_lab", "--json"], {}, occupied);
  check("config keeps the unknown-space refusal and gives a preparation command usable from an occupied root",
    missing.status === 2 && missing.envelope?.error?.code === "TARGET_NOT_FOUND" && prepared?.status === 0 &&
      found.status === 0 && (found.envelope?.result?.scope as { space?: string } | undefined)?.space === "other_lab" && fileText() === before, shown(missing));
  run(["space", "forget", "other_lab", "--json"]);
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
  // The explicit selection wins without inspecting the prepared folder's running state.
  mkdirSync(join(home, "other"), { recursive: true });
  const other = run(["space", "create", "other", "--root", join(home, "other"), "--json"]);
  check("setup: other is prepared", other.status === 0 && other.envelope?.outcome === "ok", shown(other));
  writeFileSync(join(cotalHome, "current-mesh"), "other");
  run(["config", "set", "harness", "codex", "--space", "other"]);
  const captured = run(["config", "get", "harness", "--json"], {}, join(home, "demo"));
  const capturedScope = (captured.envelope?.result as { scope?: { space: string; from: string }; setting?: Setting } | null);
  check("in a prepared folder, a selected space wins without a folder-running warning",
    captured.status === 0 && capturedScope?.scope?.space === "other" && capturedScope.scope.from === "selected" && capturedScope.setting?.value === "codex" && captured.envelope?.warnings.some((w) => w.code === "FOLDER_SPACE_NOT_RUNNING") === false, captured.envelope);
  const capturedWrite = run(["config", "set", "harness", "claude", "--json"], {}, join(home, "demo"));
  check("a write there still saves your defaults, and its receipt names the selected value",
    saved().defaults.harness === "claude" && (capturedWrite.envelope?.result as { effective?: Setting } | null)?.effective?.value === "codex" && capturedWrite.envelope?.warnings.some((w) => w.code === "PREFERENCE_SHADOWED") === true, capturedWrite.envelope);
  rmSync(join(cotalHome, "current-mesh"));
  run(["config", "unset", "harness"]);
  run(["config", "unset", "harness", "--space", "demo"]);
  run(["config", "unset", "harness", "--space", "other"]);
  run(["config", "unset", "persona"]);
  run(["config", "unset", "persona", "--space", "demo"]);
}

// ── an explicit selection wins over a registered folder ──────────────────────────────────────────
{
  const demoRoot = join(home, "demo");
  // Read-only resolution uses registrations without connecting. The live reproduction separately
  // exercises these records through a running stack; no broker is started by this offline suite.
  for (const space of ["demo", "other"]) recordMesh({ space, root: join(home, space), server: "nats://127.0.0.1:1", mode: "open", ts: new Date().toISOString() });
  try {
    run(["config", "set", "harness", "codex", "--space", "demo"]);
    run(["config", "set", "harness", "opencode", "--space", "other"]);
    run(["config", "set", "harness", "claude"]);
    writeFileSync(join(cotalHome, "current-mesh"), "other");
    const get = run(["config", "get", "harness", "--json"], {}, demoRoot);
    const result = get.envelope?.result as { scope?: { space: string; from: string }; setting?: Setting } | null;
    check("a selection beats the registered folder for config get",
      get.status === 0 && result?.scope?.space === "other" && result.scope.from === "selected" && result.setting?.value === "opencode", get.envelope);
    const all = run(["config", "--json"], {}, demoRoot);
    check("the full config view uses the selected space too", all.status === 0 && settingOf(all, "harness")?.value === "opencode", all.envelope);
    const explicit = run(["config", "get", "harness", "--space", "other", "--json"], {}, demoRoot);
    const user = run(["config", "get", "harness", "--user", "--json"], {}, demoRoot);
    check("explicit space and user reads still override the registered folder",
      explicit.status === 0 && (explicit.envelope?.result as { setting?: Setting } | null)?.setting?.value === "opencode" &&
      user.status === 0 && (user.envelope?.result as { setting?: Setting } | null)?.setting?.value === "claude", { explicit: explicit.envelope, user: user.envelope });
    const write = run(["config", "set", "harness", "claude", "--user", "--json"], {}, demoRoot);
    check("a user write saves defaults but reports the selected space's effective value",
      write.status === 0 && saved().defaults.harness === "claude" && (write.envelope?.result as { effective?: Setting } | null)?.effective?.value === "opencode" && write.envelope?.warnings.some((w) => w.code === "PREFERENCE_SHADOWED") === true, write.envelope);
    const persona = run(["config", "set", "persona", "./agents/missing.md", "--user", "--json"], {}, demoRoot);
    check("a persona warning names the selected space's path, not the command folder's",
      persona.status === 0 && persona.envelope?.warnings.some((w) => w.code === "PERSONA_NOT_FOUND" && w.message.startsWith(`no persona file ${join(realpathSync(join(home, "other")), "agents", "missing.md")};`)) === true, persona.envelope);
    const clear = run(["use", "--clear", "--json"]);
    const control = run(["config", "get", "harness", "--json"], {}, demoRoot);
    check("clearing the selection leaves the registered folder's value unchanged",
      clear.status === 0 && control.status === 0 && (control.envelope?.result as { setting?: Setting } | null)?.setting?.value === "codex", control.envelope);
  } finally {
    rmSync(join(cotalHome, "current-mesh"), { force: true });
    removeMesh("demo");
    removeMesh("other");
    run(["config", "unset", "persona"]);
    run(["config", "unset", "harness"]);
    run(["config", "unset", "harness", "--space", "demo"]);
    run(["config", "unset", "harness", "--space", "other"]);
  }
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
  writeFileSync(join(catalog, "review.md.md"), "---\nname: reviewer\n---\nReview changes.\n");
  const dotted = run(["config", "set", "persona", "review.md", "--space", "cat", "--json"]);
  check("a dotted catalog name can be saved without a missing file warning",
    dotted.status === 0 && saved().spaces.cat?.persona === "review.md" && warned(dotted) === undefined, dotted.envelope);
  const path = run(["config", "set", "persona", "./nosuch.md", "--space", "cat", "--json"]);
  check("a persona file path that is missing names the file", path.status === 0 && warned(path)?.message.startsWith(`no persona file ${join(realpathSync(catProject), "nosuch.md")};`) === true, path.envelope);
  const broken = run(["config", "set", "persona", "bad name", "--space", "cat", "--json"]);
  check("a name that breaks the persona name rule is still refused", broken.status === 1 && broken.envelope?.error?.code === "USAGE_INVALID", broken.envelope);
  run(["config", "unset", "persona", "--space", "cat"]);
}

// ── consumers: color, the editor, the detach key ─────────────────────────────────────────────────
{
  run(["config", "set", "color", "always"]);
  const refusal = ["ext", "remove", "not/a/package"];
  check("a saved color=always colors piped output", ansi.test(run(refusal).stderr), shown(run(refusal)));
  check("NO_COLOR beats the saved color=always", !ansi.test(run(refusal, { NO_COLOR: "1" }).stderr));
  check("--no-color beats the saved color=always", !ansi.test(run(["--no-color", ...refusal]).stderr));
  run(["config", "set", "color", "never"]);
  check("FORCE_COLOR beats a saved color=never", ansi.test(run(refusal, { FORCE_COLOR: "1" }).stderr));
  run(["config", "unset", "color"]);
  check("control: with nothing saved, piped output has no color", !ansi.test(run(refusal).stderr));

  const mark = join(home, "edited");
  const marker = (who: string) => `node -e "require('fs').writeFileSync(process.env.EDIT_MARK, '${who}')"`;
  const none = run(["personas", "edit", "x"], {}, project);
  check("with no editor anywhere, personas edit names both ways to set one", none.status === 2 && none.stderr.includes("set VISUAL or EDITOR, or run `cotal config set editor vim`"), shown(none));
  const preparedEditor = run(["space", "create", "editor-catalog", "--root", project, "--json"]);
  check("the editor fixture prepares its own persona catalog", preparedEditor.status === 0, shown(preparedEditor));
  run(["config", "set", "editor", marker("saved")]);
  rmSync(mark, { force: true });
  const edited = run(["personas", "edit", "x"], { EDIT_MARK: mark }, project);
  check("personas edit opens the saved editor when VISUAL and EDITOR are unset", edited.status === 0 && existsSync(mark) && readFileSync(mark, "utf8") === "saved", { ...shown(edited), mark: existsSync(mark) && readFileSync(mark, "utf8") });
  rmSync(mark, { force: true });
  const envEditor = run(["personas", "edit", "x"], { EDIT_MARK: mark, EDITOR: marker("env") }, project);
  check("EDITOR beats the saved editor", envEditor.status === 0 && readFileSync(mark, "utf8") === "env", shown(envEditor));
  run(["config", "unset", "editor"]);
  // The detach key is read by the attach client before it connects; drive that function in-process.
  process.env.XDG_CONFIG_HOME = xdg;
  for (const k of ["COTAL_DETACH_KEY"]) delete process.env[k];
  const { detachKey } = await import("@cotal-ai/workspace/attach");
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
    check("a write into a world-writable preferences folder is refused with PERMISSION_DENIED, exit 2, naming the folder and its chmod, and leaves stderr empty",
      write.status === 2 && write.envelope?.error?.code === "PERMISSION_DENIED" && (write.envelope.error.message ?? "").includes(`the preferences folder is not protected against other local writers: ${dir} is writable by every local account`) && write.envelope.error.remedy === `chmod o-w ${dir}` && write.stderr === "", shown(write));
    check("and the file is left as it was", fileText() === before);
    const read = run(["config", "--json"]);
    check("a read applies the saved values with a PREFERENCES_FOLDER_UNPROTECTED warning naming the folder and its chmod, and keeps it off stderr",
      read.status === 0 && read.envelope?.outcome === "ok" && settingOf(read, "editor")?.value === "vi" && read.envelope.warnings.filter(unprotected).length === 1 && read.stderr === "", shown(read));
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
  // An owned private folder reached through a symlink is the same folder a physical path names.
  const physical = mkdtempSync(join(home, "physical-config-"));
  chmodSync(physical, 0o700);
  const linked = join(home, "linked-config");
  symlinkSync(physical, linked);
  const through = run(["config", "set", "color", "never", "--json"], { XDG_CONFIG_HOME: linked });
  const linkedFile = join(physical, "cotal", "preferences.json");
  const linkedSaved = () => JSON.parse(readFileSync(linkedFile, "utf8")) as { defaults: Record<string, string> };
  check("a write through an owned private config symlink is saved in the physical folder",
    through.status === 0 && through.envelope?.outcome === "ok" && existsSync(linkedFile) && linkedSaved().defaults.color === "never", shown(through));
  const read = run(["config", "--json"], { XDG_CONFIG_HOME: linked });
  check("a read through that symlink applies the saved value and does not warn",
    read.status === 0 && settingOf(read, "color")?.value === "never" && read.envelope?.warnings.every((w) => w.code !== "PREFERENCES_FOLDER_UNPROTECTED") === true, shown(read));
  chmodSync(physical, 0o757);
  const refusedLink = run(["config", "set", "color", "always", "--json"], { XDG_CONFIG_HOME: linked });
  check("a symlink to a world-writable config folder is still refused, naming the physical folder",
    refusedLink.status === 2 && refusedLink.envelope?.error?.code === "PERMISSION_DENIED" && (refusedLink.envelope.error.message ?? "").includes(`${physical} is writable by every local account`) && refusedLink.envelope.error.remedy === `chmod o-w ${physical}`, shown(refusedLink));
  chmodSync(physical, 0o700);
  const dangling = join(home, "dangling-config");
  symlinkSync(join(home, "missing-config-target"), dangling);
  const missing = run(["config", "set", "color", "always", "--json"], { XDG_CONFIG_HOME: dangling });
  check("a dangling config symlink is refused with PERMISSION_DENIED, exit 2, naming the link and its missing target, and changes nothing",
    missing.status === 2 && missing.envelope?.error?.code === "PERMISSION_DENIED" && (missing.envelope.error.message ?? "").includes(`${dangling} is a symbolic link to ${join(home, "missing-config-target")}, which does not exist`) && !existsSync(join(home, "missing-config-target")), shown(missing));
  const owned = mkdtempSync(join(tmpdir(), "cotal-owned-"));
  chmodSync(owned, 0o700);
  const wide = join(owned, "wide-open");
  mkdirSync(wide, { mode: 0o700 });
  chmodSync(wide, 0o777);
  const step = join(wide, "b");
  mkdirSync(step, { mode: 0o700 });
  const outside = join(owned, "outside-link");
  symlinkSync(`${step}/../../${relative(owned, physical)}`, outside);
  const crossed = run(["config", "set", "color", "always", "--json"], { XDG_CONFIG_HOME: outside });
  check("a link outside a world-writable folder that steps back through it is refused, naming that folder",
    crossed.status === 2 && crossed.envelope?.error?.code === "PERMISSION_DENIED" && (crossed.envelope.error.message ?? "").includes(`${wide} is writable by every local account`), shown(crossed));
  chmodSync(wide, 0o700);
  const relativeWide = join(owned, "relative-wide");
  mkdirSync(relativeWide, { recursive: true });
  chmodSync(relativeWide, 0o777);
  const relativeWrite = run(["config", "set", "color", "always", "--json"], { XDG_CONFIG_HOME: "cfg" }, relativeWide);
  check("a relative config path in a world-writable working folder is refused, exit 2",
    relativeWrite.status === 2 && relativeWrite.envelope?.error?.code === "PERMISSION_DENIED" && (relativeWrite.envelope.error.message ?? "").includes("is writable by every local account"), shown(relativeWrite));
  const relativeCfg = join(owned, "relative-cfg");
  mkdirSync(join(relativeCfg, "cfg"), { recursive: true });
  chmodSync(join(relativeCfg, "cfg"), 0o777);
  const relativeFolder = run(["config", "set", "color", "always", "--json"], { XDG_CONFIG_HOME: "cfg" }, relativeCfg);
  check("a relative config path whose own folder is world-writable is refused, exit 2",
    relativeFolder.status === 2 && relativeFolder.envelope?.error?.code === "PERMISSION_DENIED" && relativeFolder.envelope.error.message.includes("cfg is writable by every local account") && relativeFolder.envelope.error.remedy === "chmod go-w cfg", shown(relativeFolder));
  mkdirSync(join(relativeCfg, "cfg", "cotal"), { recursive: true, mode: 0o777 });
  writeFileSync(join(relativeCfg, "cfg", "cotal", "preferences.json"), JSON.stringify({ schemaVersion: 1, revision: 1, defaults: { color: "never" }, spaces: {} }), { mode: 0o600 });
  const relativeWarn = run(["config", "--json"], { XDG_CONFIG_HOME: "cfg" }, relativeCfg);
  check("a read of a relative world-writable config folder warns PREFERENCES_FOLDER_UNPROTECTED",
    relativeWarn.status === 0 && (relativeWarn.envelope?.warnings ?? []).some((w) => w.code === "PREFERENCES_FOLDER_UNPROTECTED"), shown(relativeWarn));
  const relativeTrust = run(["trust", project, "--json"], { XDG_CONFIG_HOME: "cfg" }, relativeCfg);
  check("trust refuses the same unprotected relative config folder without writing",
    relativeTrust.status === 2 && relativeTrust.envelope?.error?.code === "PERMISSION_DENIED" && !existsSync(join(relativeCfg, "cfg", "cotal", "trusted-projects.json")), shown(relativeTrust));
  const relativeSafe = join(relativeWide, "relative-safe");
  mkdirSync(relativeSafe, { mode: 0o700 });
  const relativeOk = run(["config", "set", "color", "never", "--json"], { XDG_CONFIG_HOME: "cfg" }, relativeSafe);
  check("a relative config path in a protected folder completes",
    relativeOk.status === 0 && existsSync(join(relativeSafe, "cfg", "cotal", "preferences.json")), shown(relativeOk));
  const relativeLink = join(owned, "relative-link");
  mkdirSync(relativeLink, { mode: 0o700 });
  symlinkSync(join("..", basename(relativeWide)), join(relativeLink, "cfg"));
  const relativeLinked = run(["config", "set", "editor", "vi", "--json"], { XDG_CONFIG_HOME: "cfg" }, relativeLink);
  check("a relative link to a world-writable folder is refused, exit 2, and writes nothing there",
    relativeLinked.status === 2 && relativeLinked.envelope?.error?.code === "PERMISSION_DENIED" && !existsSync(join(relativeWide, "cotal", "preferences.json")), shown(relativeLinked));
  rmSync(owned, { recursive: true, force: true });
  const sticky = mkdtempSync(join(tmpdir(), "cotal-sticky-"));
  chmodSync(sticky, 0o700);
  const stickyTarget = join(sticky, "physical");
  mkdirSync(stickyTarget, { mode: 0o700 });
  const stickyLink = join(sticky, "link");
  symlinkSync(stickyTarget, stickyLink);
  const stickyLeaf = join(stickyTarget, "cotal");
  // Supply only the ownership metadata that needs privilege. The CLI still walks and writes the
  // real link and private target, and the fixture never plants a link in a shared directory.
  const statFixture = join(sticky, "owner-fixture.cjs");
  writeFileSync(statFixture, `const fs = require("node:fs");
const lstat = fs.lstatSync;
fs.lstatSync = (path, options) => {
  const stat = lstat(path, options);
  if (stat && ((path === ${JSON.stringify(sticky)} && process.env.FOREIGN_LINK !== "home") ||
    (path === ${JSON.stringify(stickyLeaf)} && process.env.FOREIGN_LINK === "sticky-leaf"))) {
    stat.uid = 0;
    stat.mode = (stat.mode & ~0o7777) | 0o1777;
  }
  if (stat && (path === ${JSON.stringify(stickyLink)} || (path === "link" && process.cwd() === ${JSON.stringify(sticky)}))) {
    if (process.env.FOREIGN_LINK === "root") stat.uid = 0;
    else if (process.env.FOREIGN_LINK === "1" || process.env.FOREIGN_LINK === "home") stat.uid = process.getuid() === 1 ? 2 : 1;
  }
  if (stat && path === ${JSON.stringify(stickyTarget)} && process.env.FOREIGN_LINK === "root-target") {
    stat.uid = 0;
    stat.mode |= 0o002;
  }
  return stat;
};
require("node:module").syncBuiltinESMExports();
`);
  const stickyEnv = { XDG_CONFIG_HOME: stickyLink, NODE_OPTIONS: `--require=${JSON.stringify(statFixture)}` };
  const foreignLink = run(["config", "set", "color", "always", "--json"], { ...stickyEnv, FOREIGN_LINK: "1" });
  check("a link owned by another account is refused even in a root-owned sticky folder",
    foreignLink.status === 2 && foreignLink.envelope?.error?.code === "PERMISSION_DENIED" &&
    foreignLink.envelope.error.message.includes(`${stickyLink} is a symbolic link owned by another account`) && !existsSync(join(stickyTarget, "cotal")), shown(foreignLink));
  const stickyWrite = run(["config", "set", "color", "never", "--json"], { ...stickyEnv, FOREIGN_LINK: undefined });
  check("an owned link in a root-owned sticky folder completes, and the file is in the physical folder",
    stickyWrite.status === 0 && existsSync(join(stickyTarget, "cotal", "preferences.json")), shown(stickyWrite));
  const leafEnv = { ...stickyEnv, XDG_CONFIG_HOME: stickyTarget, FOREIGN_LINK: "sticky-leaf" };
  const leafWrite = run(["config", "set", "editor", "vi", "--json"], leafEnv);
  const leafRead = run(["config", "--json"], leafEnv);
  check("config set updates the caller's preferences in a root-owned sticky config folder and config reads without warning",
    leafWrite.status === 0 && leafRead.status === 0 && settingOf(leafRead, "editor")?.value === "vi" &&
    leafRead.envelope?.warnings.every((w) => w.code !== "PREFERENCES_FOLDER_UNPROTECTED") === true,
    { write: shown(leafWrite), read: shown(leafRead) });
  const leafTrust = run(["trust", project, "--json"], leafEnv);
  const leafTrustFile = join(stickyLeaf, "trusted-projects.json");
  check("trust writes the trusted root in a root-owned sticky config folder",
    leafTrust.status === 0 && existsSync(leafTrustFile) &&
    (JSON.parse(readFileSync(leafTrustFile, "utf8")) as { roots: string[] }).roots.includes(realpathSync(project)), shown(leafTrust));
  const linkedLeafXdg = join(sticky, "linked-leaf");
  mkdirSync(linkedLeafXdg, { mode: 0o700 });
  symlinkSync(stickyLeaf, join(linkedLeafXdg, "cotal"));
  const linkedLeaf = run(["config", "set", "editor", "ed", "--json"], { XDG_CONFIG_HOME: linkedLeafXdg });
  check("a symbolic link at the final config folder is still refused",
    linkedLeaf.status === 2 && linkedLeaf.envelope?.error?.code === "PERMISSION_DENIED" &&
    linkedLeaf.envelope.error.message.includes(`${join(linkedLeafXdg, "cotal")} is a symbolic link`), shown(linkedLeaf));
  const rootLink = run(["config", "set", "color", "always", "--json"], { ...stickyEnv, XDG_CONFIG_HOME: "link", FOREIGN_LINK: "root" }, sticky);
  check("a root-owned relative link is refused with the physical-path remedy",
    rootLink.status === 2 && rootLink.envelope?.error?.code === "PERMISSION_DENIED" &&
    rootLink.envelope.error.remedy === `use the physical path ${realpathSync(join(stickyTarget, "cotal"))}`, shown(rootLink));
  const linkedProject = run(["space", "create", "linked-project", "--root", stickyLink, "--json"], { NODE_OPTIONS: stickyEnv.NODE_OPTIONS, FOREIGN_LINK: "root" });
  check("a root-owned project link keeps the physical-path remedy",
    linkedProject.status === 2 && linkedProject.envelope?.error?.code === "PERMISSION_DENIED" &&
    linkedProject.envelope.error.remedy === `use the physical path ${realpathSync(stickyTarget)}` &&
    !existsSync(join(stickyTarget, ".cotal")), shown(linkedProject));
  if (process.getuid?.() !== 0) {
    // The link stays owned by the caller; only the target's owner and mode are supplied by the fixture.
    const rootTarget = run(["config", "set", "color", "always", "--json"], { ...stickyEnv, FOREIGN_LINK: "root-target" });
    check("a root-owned writable config target is refused without suggesting chmod",
      rootTarget.status === 2 && rootTarget.envelope?.error?.code === "PERMISSION_DENIED" &&
      rootTarget.envelope.error.message.includes(`${stickyTarget} is writable by every local account`) &&
      rootTarget.envelope.error.remedy === "use a folder you own, or ask its owner to protect it", shown(rootTarget));
  }
  const linkedHome = join(home, "setup-linked-home");
  const linkedHomeTarget = join(home, "setup-linked-home-target");
  mkdirSync(linkedHomeTarget, { mode: 0o700 });
  symlinkSync(linkedHomeTarget, linkedHome);
  const projectDir = join(linkedHomeTarget, "project");
  mkdirSync(join(projectDir, ".cotal", "agents"), { recursive: true });
  const bin = join(linkedHomeTarget, "bin");
  mkdirSync(bin, { mode: 0o700 });
  const codexFixture = join(bin, "codex-fixture.cjs");
  writeFileSync(codexFixture, `const fs = require("node:fs");
const { join } = require("node:path");
const args = process.argv.slice(2);
const file = join(process.env.HOME, ".codex-fixture.json");
const saved = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
if (args.join(" ") === "plugin marketplace list") console.log(saved.market ? "cotal-mesh" : "");
else if (args.join(" ") === "plugin marketplace list --json") {
  console.log(JSON.stringify({ marketplaces: saved.market ? [{ name: "cotal-mesh", root: saved.market }] : [] }));
} else if (args.slice(0, 3).join(" ") === "plugin marketplace add") {
  saved.market = args[3];
  fs.writeFileSync(file, JSON.stringify(saved));
} else if (args.join(" ") === "plugin add cotal@cotal-mesh") {
  saved.version = JSON.parse(fs.readFileSync(join(saved.market, "plugins/cotal/.codex-plugin/plugin.json"), "utf8")).version;
  fs.writeFileSync(file, JSON.stringify(saved));
} else if (args.join(" ") === "plugin list" && saved.version) console.log("cotal@cotal-mesh  installed  " + saved.version);
`);
  writeFileSync(join(bin, "codex"), `#!/bin/sh\nexec "${process.execPath}" "${codexFixture}" "$@"\n`, { mode: 0o755 });
  const linkedEnv = { HOME: linkedHome, USERPROFILE: linkedHome, XDG_CONFIG_HOME: join(linkedHome, ".config"), COTAL_HOME: join(linkedHome, ".cotal"), PATH: `${bin}:${process.env.PATH ?? ""}` };
  const seed = run(["ext", "seed"], { ...linkedEnv, COTAL_ALLOW_CHECKOUT_SEED: "1" });
  const setupArgs = ["setup", "--destination", "local", "--harness", "codex", "--project", projectDir, "--space", "linked", "--configure-only", "--yes", "--json"];
  const setup = run(setupArgs, linkedEnv);
  const trusted = run(["trust", projectDir, "--json"], linkedEnv);
  const trustFile = join(linkedHomeTarget, ".config", "cotal", "trusted-projects.json");
  const trustedRoots = existsSync(trustFile) ? (JSON.parse(readFileSync(trustFile, "utf8")) as { roots: string[] }).roots : [];
  check("setup through a linked home writes the preparation, and trust of that project completes",
    seed.status === 0 && setup.status === 0 && setup.envelope?.result?.spaceState === "created" &&
    trusted.status === 0 && trustedRoots.includes(realpathSync(projectDir)), { seed: shown(seed), setup: shown(setup), trust: shown(trusted) });
  const recordHome = join(stickyLink, "records");
  const otherProject = join(linkedHomeTarget, "other-project");
  mkdirSync(otherProject, { mode: 0o700 });
  const otherSetup = run(["setup", "--destination", "local", "--harness", "codex", "--project", otherProject, "--space", "other-linked", "--configure-only", "--yes", "--json"], {
    ...linkedEnv, COTAL_HOME: recordHome, NODE_OPTIONS: stickyEnv.NODE_OPTIONS, FOREIGN_LINK: "home",
  });
  check("setup accepts a protected Cotal record home reached through a non-config link",
    otherSetup.status === 0 && otherSetup.envelope?.result?.spaceState === "created" &&
    existsSync(join(stickyTarget, "records", "prepared")), shown(otherSetup));
  rmSync(sticky, { recursive: true, force: true });
  const missingFolder = join(home, "missing-folder-link");
  const missingTarget = join(physical, "no-such-folder");
  symlinkSync(missingTarget, missingFolder);
  for (const [link, target] of [[dangling, join(home, "missing-config-target")], [missingFolder, missingTarget]] as const) {
    const setupMissing = run(setupArgs, { XDG_CONFIG_HOME: link, COTAL_SKIP_CONNECTOR_SEED: undefined, COTAL_ALLOW_CHECKOUT_SEED: "1" });
    check(`setup refuses ${basename(link)} before seeding, with exit 2 and the missing target`,
      setupMissing.status === 2 && setupMissing.envelope?.error?.code === "PERMISSION_DENIED" &&
      setupMissing.envelope.error.message.includes(`${link} is a symbolic link to ${target}, which does not exist`) &&
      !existsSync(target), shown(setupMissing));
  }
  const unsafeXdg = mkdtempSync(join(home, "unsafe-setup-"));
  chmodSync(unsafeXdg, 0o777);
  const setupUnsafe = run(setupArgs, { XDG_CONFIG_HOME: unsafeXdg, COTAL_SKIP_CONNECTOR_SEED: undefined, COTAL_ALLOW_CHECKOUT_SEED: "1" });
  check("setup refuses an unsafe non-link config path before seeding with a preferences-folder diagnostic",
    setupUnsafe.status === 2 && setupUnsafe.envelope?.error?.code === "PERMISSION_DENIED" &&
    setupUnsafe.envelope.error.message.startsWith(`the preferences folder is not protected against other local writers: ${unsafeXdg}`) &&
    readdirSync(unsafeXdg).length === 0, shown(setupUnsafe));
}

// The library must protect writes even without the CLI's earlier platform check.
if (process.platform !== "win32") {
  const priorXdg = process.env.XDG_CONFIG_HOME;
  const getuid = process.getuid;
  const link = join(home, "unsupported-platform-link");
  symlinkSync(project, link);
  const linkStat = lstatSync(link);
  const calls = {
    assertPreferencesFolderProtected,
    writePreference: () => writePreference({}, "editor", "vi", 0),
    trustProject: () => trustProject(project),
  };
  const savedXdg = mkdtempSync(join(home, "unsupported-saved-"));
  const savedDir = join(savedXdg, "cotal");
  mkdirSync(savedDir, { mode: 0o700 });
  const savedFile = join(savedDir, "preferences.json");
  const savedText = JSON.stringify({ schemaVersion: 1, revision: 1, defaults: {}, spaces: { demo: { persona: "default" } } });
  writeFileSync(savedFile, savedText, { mode: 0o600 });
  const unsupported = (error: unknown): boolean => isCommandFailure(error) && error.code === "UNSUPPORTED" &&
    error.message.includes("no weaker file access was substituted");
  try {
    process.getuid = undefined;
    for (const [name, call] of Object.entries(calls)) {
      const dir = mkdtempSync(join(home, "unsupported-config-"));
      process.env.XDG_CONFIG_HOME = dir;
      let failure: unknown;
      try { call(); } catch (error) { failure = error; }
      check(`${name} refuses UNSUPPORTED without creating a config directory or lock`,
        unsupported(failure) && readdirSync(dir).length === 0, String(failure));
    }
    process.env.XDG_CONFIG_HOME = savedXdg;
    let removeFailure: unknown;
    try { removeSpacePreferences("demo", 1); } catch (error) { removeFailure = error; }
    check("removeSpacePreferences refuses UNSUPPORTED without changing the saved file or creating a lock",
      unsupported(removeFailure) && readFileSync(savedFile, "utf8") === savedText && readdirSync(savedDir).length === 1, String(removeFailure));
    check("localWriterGap still identifies a symbolic link without getuid", localWriterGap(link, linkStat)?.reason === "is a symbolic link");
    let failure: unknown;
    try { assertProtectedEntry("the path", link, linkStat); } catch (error) { failure = error; }
    check("assertProtectedEntry still refuses a symbolic link without getuid",
      isCommandFailure(failure) && failure.code === "PERMISSION_DENIED" && failure.message.includes(`${link} is a symbolic link`), String(failure));
  } finally {
    process.getuid = getuid;
    if (priorXdg === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = priorXdg;
  }
}

// ── a file a Windows editor saved with a UTF-8 byte-order mark reads, and the next write drops it ──
{
  run(["config", "set", "editor", "vi"]);
  writeFileSync(file, `\uFEFF${fileText()!}`, { mode: 0o600 });
  const get = run(["config", "get", "editor", "--json"]);
  check("a preferences file that begins with a UTF-8 byte-order mark reads as the JSON after it",
    get.status === 0 && (get.envelope?.result as { setting?: Setting } | null)?.setting?.value === "vi", shown(get));
  const write = run(["config", "set", "editor", "ed"]);
  check("the next write leaves the byte-order mark out", write.status === 0 && !fileText()!.startsWith("\uFEFF") && fileText()!.includes('"ed"'), shown(write));
  const utf8 = fileText()!;
  writeFileSync(file, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(utf8, "utf16le")]), { mode: 0o600 });
  const utf16 = run(["config", "get", "editor", "--json"]);
  check("a preferences file saved as UTF-16 is refused by its encoding, saying to save it as UTF-8",
    utf16.status === 1 && utf16.envelope?.error?.code === "SCHEMA_INVALID" && (utf16.envelope.error.message ?? "").endsWith("is invalid: it is saved as UTF-16, and Cotal reads only UTF-8; save it as UTF-8"), shown(utf16));
  writeFileSync(file, utf8, { mode: 0o600 });
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
      read.status === 2 && read.envelope?.error?.code === "PERMISSION_DENIED" && read.envelope.error.message.includes("the preferences file is a symbolic link")
        && !read.envelope.error.message.includes(file) && !read.envelope.error.message.includes(target) && read.envelope.error.remedy?.includes(`${file} points to ${target}`) === true, shown(read));
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

{
  const malformed = "{\n";
  writeFileSync(file, malformed);
  const finite = run(["history", "general", "--json"]);
  const error = finite.envelope?.error;
  check("finite JSON history reports malformed preferences in one refusal envelope",
    finite.status === 1 && finite.stderr === "" && finite.envelope?.command === "history" && finite.envelope.outcome === "refused"
      && error?.code === "SCHEMA_INVALID" && error.message.includes(`the preferences file ${file} is invalid: not JSON`)
      && error.remedy === `fix or remove ${file}; nothing resets it`, shown(finite));
  for (const [stream, args, target] of [
    ["watch", ["watch"], { requestedSpace: null }],
    ["history", ["history", "general", "--follow"], { space: null, channel: "general", dms: false }],
    ["membership", ["channel", "members", "general", "--follow"], { space: null, channel: "general" }],
  ] as const) {
    const r = run([...args, "--json"]);
    const records = r.stdout.trimEnd().split("\n").map((line) => JSON.parse(line || "{}"));
    check(`${stream} frames malformed preferences as a setup failure without a snapshot`,
      r.status === 1 && r.stderr === "" && records.map((record) => record.type).join() === "error,end"
        && records.every((record) => record.schemaVersion === 1 && record.stream === stream
          && Object.entries(target).every(([key, value]) => record.target?.[key] === value))
        && error !== undefined && records[0]?.data?.code === error.code && records[0]?.data?.message === error.message
        && records[0]?.data?.remedy === error.remedy && records[1]?.data?.reason === "setup-failed"
        && (stream !== "membership" || records[1].data.lastAsOf === null), shown(r));
  }
  check("the JSON observers leave malformed preferences untouched", fileText() === malformed);
  rmSync(file);
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

// ── a preferences.json that is a FIFO stops them by its file type, without waiting on it ─────────
if (process.platform !== "win32") {
  rmSync(file, { force: true });
  spawnSync("mkfifo", ["-m", "0600", file]);
  for (const args of [["config", "get", "harness", "--json"], ["config", "set", "harness", "claude", "--json"]]) {
    const r = run(args);
    check(`\`${args.join(" ")}\` refuses a FIFO preferences.json with PERMISSION_DENIED, naming it, without waiting on it`,
      r.status === 2 && r.envelope?.error?.code === "PERMISSION_DENIED" &&
        r.envelope.error.message === `the preferences file ${file} is not a regular file, such as a FIFO or a device; preferences are kept only in a regular file, so nothing was read or changed` &&
        r.envelope.error.remedy === `remove ${file}, or replace it with a regular file`, shown(r));
  }
  const status = run(["status"]);
  check("status reports the FIFO as a part it could not read, exit 4", status.status === 4 && status.stderr.includes(`the preferences file ${file} is not a regular file`), shown(status));
  check("and the FIFO is left as it was", lstatSync(file).isFIFO());
  rmSync(file);
}

// ── a config folder that is a file stops every command but help, version, docs and completion ────
{
  const fileXdg = join(home, "xdg-file");
  const folder = join(fileXdg, "cotal");
  mkdirSync(fileXdg);
  writeFileSync(folder, "a file\n");
  const env = { XDG_CONFIG_HOME: fileXdg };
  for (const args of [["config", "--json"], ["status", "--json"], ["ext", "list", "--json"], ["config", "set", "harness", "claude", "--json"]]) {
    const r = run(args, env);
    check(`\`${args.join(" ")}\` is refused with SCHEMA_INVALID naming the folder that is a file, with moving it as Next`,
      r.status === 1 && r.envelope?.outcome === "refused" && r.envelope.error?.code === "SCHEMA_INVALID" &&
        r.envelope.error.message.startsWith(`the Cotal config folder ${folder} is a file, not a folder;`) &&
        r.envelope.error.remedy?.startsWith(`move ${folder} aside, for example \`mv ${folder} ${folder}.old\``) === true, shown(r));
  }
  const status = run(["status"], env);
  check("the text refusal names the folder, not a corrupt extensions manifest or ENOTDIR",
    status.status === 1 && status.stderr.includes(`the Cotal config folder ${folder} is a file`) && !/ENOTDIR|corrupt extensions manifest/.test(status.stdout + status.stderr), shown(status));
  const seed = run(["ext", "seed"], env);
  check("`ext seed` is refused the same way before it reads the seed state",
    seed.status === 1 && seed.stderr.includes(`the Cotal config folder ${folder} is a file`) && !/ENOTDIR/.test(seed.stderr), shown(seed));
  for (const args of [["help"], [], ["config", "--help"], ["version"], ["docs"]]) {
    const r = run(args, env);
    check(`\`cotal ${args.join(" ")}\` still runs`, r.status === 0 && r.stdout !== "" && !/ENOTDIR|corrupt extensions manifest/.test(r.stderr), shown(r));
  }
  const version = run(["version", "--json"], env);
  check("`version --json` is complete with no installed extensions, since that folder can hold none",
    version.status === 0 && version.envelope?.outcome === "ok" && version.envelope.completeness === "complete" && JSON.stringify(version.envelope.result?.extensions) === "[]", shown(version));
  check("and the file is left as it was", readFileSync(folder, "utf8") === "a file\n");
  const r = run(["config", "--json"], { XDG_CONFIG_HOME: folder });
  check("a config home that is itself a file names that file",
    r.status === 1 && r.envelope?.error?.code === "SCHEMA_INVALID" && r.envelope.error.message.startsWith(`the Cotal config folder ${join(folder, "cotal")} cannot be made: ${folder} is a file, not a folder;`), shown(r));
}

// ── a relative COTAL_HOME stops them too, and a home other accounts can write takes no write ─────
{
  for (const value of ["rel-home", "./rel-home"]) {
    const r = run(["space", "create", "x", "--root", project, "--json"], { COTAL_HOME: value });
    check(`a relative COTAL_HOME ${value} is refused with USAGE_INVALID, naming it, and nothing is made`,
      r.status === 1 && r.envelope?.error?.code === "USAGE_INVALID" && r.envelope.error.message.startsWith(`COTAL_HOME ${JSON.stringify(value)} is a relative path`) &&
        /^set COTAL_HOME to an absolute path/.test(r.envelope.error.remedy ?? "") && !existsSync(join(home, "rel-home")), shown(r));
  }
  check("help still works with a relative COTAL_HOME", run(["help"], { COTAL_HOME: "rel-home" }).status === 0);
  const open = join(home, "open-home");
  mkdirSync(open);
  chmodSync(open, 0o757);
  const refused = run(["space", "create", "x", "--root", project, "--json"], { COTAL_HOME: open });
  check("a COTAL_HOME every account can write takes no write: space create is refused naming it, with chmod o-w as Next",
    refused.status === 2 && refused.envelope?.error?.code === "PERMISSION_DENIED" && refused.envelope.error.message.includes(`${open} is writable by every local account; nothing was written`) &&
      refused.envelope.error.remedy === `chmod o-w ${open}` && readdirSync(open).length === 0 && (statSync(open).mode & 0o777) === 0o757, shown(refused));
  const linked = join(home, "linked-home");
  symlinkSync(open, linked);
  const viaLink = run(["space", "create", "x", "--root", project, "--json"], { COTAL_HOME: linked });
  check("a COTAL_HOME that is a symbolic link is refused the same way",
    viaLink.status === 2 && viaLink.envelope?.error?.message.includes(`${linked} is a symbolic link`) === true && readdirSync(open).length === 0, shown(viaLink));
  chmodSync(open, 0o755);
  const made = run(["space", "create", "x", "--root", project, "--json"], { COTAL_HOME: open });
  check("a COTAL_HOME others can only read is written, and made private as the record store requires",
    made.status === 0 && existsSync(join(open, "prepared")) && (statSync(open).mode & 0o777) === 0o700, shown(made));
  chmodSync(open, 0o755);
  const records = run(["service", "--space", "x", "--json"], { COTAL_HOME: open });
  check("reading service records from a home others can read names it, with chmod go-rwx as Next",
    records.status === 2 && records.envelope?.error?.code === "PERMISSION_DENIED" && records.envelope.error.message.includes(`${open} is not private to you (mode 0755)`) &&
      records.envelope.error.remedy === `chmod go-rwx ${open}`, shown(records));
  chmodSync(open, 0o700);
}

{
  const dir = join(home, "proto-project");
  mkdirSync(dir, { mode: 0o700 });
  const prepared = run(["space", "create", "__proto__", "--root", dir, "--json"]);
  const set = run(["config", "set", "persona", "backend", "--space", "__proto__", "--json"]);
  const get = run(["config", "get", "persona", "--space", "__proto__", "--json"]);
  const setting = (get.envelope?.result as { setting?: Setting } | null)?.setting;
  check("an accepted space named __proto__ saves its value for the next CLI process",
    prepared.status === 0 && set.status === 0 && get.status === 0 && setting?.value === "backend"
      && setting.winner?.source === "space" && setting.winner.name === "__proto__"
      && Object.hasOwn(saved().spaces, "__proto__"), { prepared: shown(prepared), set: shown(set), get: shown(get) });
  const unset = run(["config", "unset", "persona", "--space", "__proto__", "--json"]);
  check("unsetting the last preference removes the literal space key",
    unset.status === 0 && unset.envelope?.outcome === "ok" && !Object.hasOwn(saved().spaces, "__proto__"), shown(unset));
}

finish();
