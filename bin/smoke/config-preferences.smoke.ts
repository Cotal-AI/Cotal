/**
 * `cotal config` and the preferences it saves, driven through the built binary in a fresh sandbox:
 * the effective values with their sources and shadowed values, `get`, `set` and `unset` for the user
 * and for one space, the refusals, the named environment tiers, the selected space, an invalid file
 * stopping every command without being reset, a stale write refused, two concurrent writers both
 * landing, and the consumers outside `spawn`: color, the `personas edit` editor and the detach key.
 * The launch consumers (harness, persona) are proved through real spawns in `smoke:persona-agent`.
 * Broker-free and offline.
 *
 * Run: pnpm smoke:config-preferences
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
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
  const plain = run(["config", "--plain"]);
  check("the plain view names the file, the scope and each key's source", plain.status === 0 && !ansi.test(plain.stdout) && plain.stdout.includes(file) && /KEY\s+VALUE\s+FROM\s+ALSO SET/.test(plain.stdout) && /harness\s+claude\s+the default/.test(plain.stdout), shown(plain));
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
  const plainSet = run(["config", "set", "persona", "reviewer", "--space", "demo", "--plain"]);
  check("--space saves a personal value for one space", plainSet.status === 0 && /persona = reviewer in space demo/.test(plainSet.stdout) && saved().spaces.demo?.persona === "reviewer" && saved().revision === 2, shown(plainSet));
  const forSpace = run(["config", "--space", "demo", "--json"]);
  check("reading through --space applies that space's value over the user's", settingOf(forSpace, "persona")?.winner?.source === "space" && settingOf(forSpace, "persona")?.winner?.name === "demo" && settingOf(forSpace, "harness")?.value === "opencode", forSpace.envelope?.result);
  const forUser = run(["config", "--user", "--json"]);
  check("--user reads your defaults without any space's values", settingOf(forUser, "persona")?.value === "default", forUser.envelope?.result);
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
    ["--user with --space", ["config", "get", "harness", "--user", "--space", "demo"], /--user and --space choose different scopes/],
    ["a space name with a space in it", ["config", "--space", "a b"], /"a b" is not a space name/],
    ["get without a key", ["config", "get"], /usage: cotal config get <key>/],
    ["set without a value", ["config", "set", "harness"], /usage: cotal config set <key> <value>/],
    ["an unknown subcommand", ["config", "show"], /cotal config has no subcommand "show"/],
  ];
  for (const [name, args, message] of refusals) {
    const r = run([...args, "--json"]);
    check(`refused: ${name}`, r.status === 1 && r.envelope?.outcome === "refused" && r.envelope.error?.code === "USAGE_INVALID" && message.test(r.envelope.error.message) && fileText() === before, shown(r));
  }
  const both = run(["config", "--json", "--plain"]);
  check("--json with --plain is refused", both.status === 1 && both.envelope?.error?.code === "USAGE_INVALID", shown(both));
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
  check("the plain view says the scope is the selected space", /Scope:\s+space demo \(selected\)/.test(plain.stdout), shown(plain));
  check("--user ignores the selection", settingOf(run(["config", "--user", "--json"]), "persona")?.value === "default");
  const write = run(["config", "set", "persona", "mine", "--json"]);
  check("a write without --space goes to your defaults, and reports the selected space's value still winning here", saved().defaults.persona === "mine" && (write.envelope?.result as { effective?: Setting } | null)?.effective?.value === "demo-lead" && write.envelope?.warnings.some((w) => w.code === "PREFERENCE_SHADOWED" && /your preference for space demo \(demo-lead\)/.test(w.message)) === true, shown(write));
  rmSync(join(cotalHome, "current-mesh"));
  run(["config", "unset", "persona"]);
  run(["config", "unset", "persona", "--space", "demo"]);
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
  check("with no editor anywhere, personas edit names both ways to set one", none.status === 1 && /export EDITOR .*cotal config set editor/.test(none.stderr), shown(none));

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

// ── an invalid file stops every command and is never reset ───────────────────────────────────────
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
    check(`an invalid file (${name}) is refused with SCHEMA_INVALID, naming the file`, r.status === 1 && r.envelope?.error?.code === "SCHEMA_INVALID" && message.test(r.envelope.error.message) && r.envelope.error.message.includes(file) && /nothing reset it/.test(r.envelope.error.remedy ?? ""), shown(r));
    check(`and the file (${name}) is left as it was`, fileText() === text);
  }
  const other = run(["ext", "root"]);
  check("an invalid file stops other commands too, before they run", other.status === 1 && /the preferences file .* is invalid/.test(other.stderr) && other.stdout === "", shown(other));
  const write = run(["config", "set", "color", "never"]);
  check("a write does not replace an invalid file", write.status === 1 && /is invalid/.test(write.stderr) && fileText()?.includes("spaces"), shown(write));
  const help = run(["config", "--help"]);
  check("help still works", help.status === 0 && /cotal config/.test(help.stdout), shown(help));
  rmSync(file);
  check("removing the file restores the defaults", run(["config", "--json"]).status === 0);
}

finish();
