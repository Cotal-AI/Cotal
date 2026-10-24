/**
 * The command kernel's entry, driven through the built binary in a fresh sandbox per invocation.
 *
 * Bare `cotal`, help and version read local metadata only, and every usage error is refused before
 * any effect: no connector seed, no config write. An alias resolves to the same command as its name
 * (help, refusal and parse), and a word that only prefixes a command selects nothing. A short flag
 * parses as its long form, and a wrong-case short flag or a missing value is refused. `version --json`
 * writes one envelope, and a usage error under `--json` is one refusal envelope. `--no-color` and
 * `--no-input` are accepted by every command in any position before `--`.
 *
 * The aliases and short flags come from the registry the binary composes (the same imports as
 * `bin/run.ts`), and help must list each alias, so a new alias is covered without editing this file.
 * Each invocation gets its own COTAL_HOME and XDG_CONFIG_HOME with checkout seeding allowed, so "wrote
 * nothing" means the gate refused the seed, not that the sandbox could not seed: the positive control
 * is a real command that does seed.
 *
 * Run: pnpm smoke:cli-entry
 */
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parseCommandArgs, registry, type Command } from "@cotal-ai/core";
import { spaceSegment } from "@cotal-ai/workspace";
import "@cotal-ai/cli";
import "@cotal-ai/manager";
import "@cotal-ai/delivery";
import "@cotal-ai/runtime";
import "@cotal-ai/auth";
import { assertSmokeSandboxDown, createSuite, recordSmokeSandbox } from "@cotal-ai/smoke-kit";
import { DEFAULT_AGENT } from "../../implementations/cli/src/lib/default-persona.js";

const REPO = join(import.meta.dirname, "..", "..");
const BIN = join(REPO, "bin", "dist", "cotal.js");
if (!existsSync(BIN)) {
  console.error(`✗ ${BIN} missing - build first: pnpm --filter cotal-ai... build`);
  process.exit(1);
}

const { check, finish } = createSuite();

// A supervising seat's COTAL_* (COTAL_SKIP_CONNECTOR_SEED above all) would suppress the seed under
// test, so the host's are scrubbed and checkout seeding is opted in deliberately.
const HOST_ENV: Record<string, string | undefined> = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("COTAL_")));
const cleanup: string[] = [];
process.on("exit", () => {
  for (const dir of cleanup) rmSync(dir, { recursive: true, force: true });
});

interface Run {
  status: number;
  stdout: string;
  stderr: string;
  /** Entries the run created under `<XDG_CONFIG_HOME>/cotal`. */
  wrote: string[];
}

/** One invocation in a fresh sandbox. `prepare` runs against its COTAL_HOME first. */
function cotal(args: string[], prepare?: (cotalHome: string) => void, extraEnv: Record<string, string> = {}): Run {
  const root = mkdtempSync(join(tmpdir(), "cotal-entry-root-"));
  const cfg = mkdtempSync(join(tmpdir(), "cotal-entry-cfg-"));
  const cotalHome = join(root, "home");
  cleanup.push(root, cfg);
  mkdirSync(cotalHome, { recursive: true });
  prepare?.(cotalHome);
  const sandbox = recordSmokeSandbox({ root, cotalHome, xdgConfigHome: cfg });
  const options = {
    cwd: root,
    env: { ...HOST_ENV, COTAL_HOME: cotalHome, XDG_CONFIG_HOME: cfg, COTAL_ALLOW_CHECKOUT_SEED: "1", NO_COLOR: "1", ...extraEnv },
    encoding: "utf8" as const,
    timeout: 300_000,
  };
  assertSmokeSandboxDown(sandbox, args, options);
  const r = spawnSync("node", [BIN, ...args], options);
  const written = join(cfg, "cotal");
  return { status: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "", wrote: existsSync(written) ? readdirSync(written).sort() : [] };
}

const shown = (r: Run) => ({ status: r.status, stdout: r.stdout.slice(0, 300), stderr: r.stderr.slice(0, 300), wrote: r.wrote });
const same = (a: Run, b: Run) => a.status === b.status && a.stdout === b.stdout && a.stderr === b.stderr;

/** A run that printed to stdout, exited 0 and wrote nothing. */
function local(name: string, r: Run): void {
  check(name, r.status === 0 && r.stdout.length > 0 && r.wrote.length === 0, shown(r));
}

/** A usage refusal: exit 1, the reason on stderr, nothing on stdout that a script could source, and
 *  nothing written. */
function refused(name: string, r: Run, reason: RegExp): void {
  check(name, r.status === 1 && reason.test(r.stderr) && r.wrote.length === 0, shown(r));
}

/** Skips the connector seed, for runs whose question is not whether they seed. */
const noSeed = { COTAL_SKIP_CONNECTOR_SEED: "1" };

const commands = registry.all<Command>("command");
const aliases = commands.flatMap((cmd) => (cmd.aliases ?? []).map((alias) => ({ alias, cmd })));

// ── Bare entry ─────────────────────────────────────────────────────────────────────────────────────
{
  const fresh = cotal([]);
  local("bare cotal prints the entry screen and writes nothing", fresh);
  check("a fresh machine is pointed to setup", /^No space is selected\.$/m.test(fresh.stdout) && /^Start here\n  cotal setup  /m.test(fresh.stdout), shown(fresh));
  check("the entry screen names common commands and where the rest are", /^Everyday\n  cotal ps  /m.test(fresh.stdout) && /^More\n  cotal help --all  /m.test(fresh.stdout), shown(fresh));
  const ghost = cotal([], (home) => writeFileSync(join(home, "current-mesh"), "ghost\n"));
  local("bare cotal with a selected space writes nothing", ghost);
  check("the entry screen names the selected space, and says when it is not recorded here", ghost.stdout.startsWith("ghost · not recorded · "), shown(ghost));
  // A prepared space starts with `up`; spawn refuses on it until then.
  const prepare = (cotalHome: string, space: string, root: string): void => {
    mkdirSync(join(cotalHome, "prepared"), { recursive: true });
    writeFileSync(join(cotalHome, "prepared", `${spaceSegment(space)}.json`), JSON.stringify({ space, root, ts: "2026-10-23T00:00:00.000Z" }));
  };
  const elsewhere = cotal([], (home) => {
    prepare(home, "planned", join(dirname(home), "project"));
    writeFileSync(join(home, "current-mesh"), "planned\n");
  });
  local("bare cotal with a prepared space selected writes nothing", elsewhere);
  check("a selected prepared space is started from its folder",
    elsewhere.stdout.startsWith("planned · prepared · ") && /^Start here\n  cotal up --root \S+\/project +Start this space$/m.test(elsewhere.stdout) && !elsewhere.stdout.includes("cotal spawn"), shown(elsewhere));
  const here = cotal([], (home) => {
    mkdirSync(join(dirname(home), ".cotal"));
    prepare(home, "planned", dirname(home));
  });
  local("bare cotal in a prepared folder writes nothing", here);
  check("the space prepared in this folder is named and started here, with nothing selected",
    here.stdout.startsWith("planned · prepared here · ") && /^Start here\n  cotal up +Start this space$/m.test(here.stdout) && !here.stdout.includes("No space is selected"), shown(here));
}

// ── Help ───────────────────────────────────────────────────────────────────────────────────────────
{
  const help = cotal(["help"]);
  local("help prints the command list and writes nothing", help);
  check("--help and -h print the same list", same(help, cotal(["--help"])) && same(help, cotal(["-h"])));
  check("help hides hidden commands and says how to show them", !/^\s+start\b/m.test(help.stdout) && help.stdout.includes("cotal help --all"), shown(help));
  const all = cotal(["help", "--all"]);
  local("help --all writes nothing", all);
  check("help --all lists hidden commands", /^\s+start\b/m.test(all.stdout), shown(all));
  for (const { alias, cmd } of aliases)
    check(`help lists alias ${alias} beside ${cmd.name}`, new RegExp(`^\\s+${cmd.name}(, [^ ]+)*, ${alias}(,|\\s)`, "m").test(all.stdout), shown(all));
  const spawnHelp = cotal(["help", "spawn"]);
  local("help spawn writes nothing", spawnHelp);
  check("command help shows the usage and the aliases", /^Usage\n  spawn /m.test(spawnHelp.stdout) && /^Shorthands\n  cotal sp$/m.test(spawnHelp.stdout), shown(spawnHelp));
  check("help sp, spawn --help and sp -h print the same help", same(spawnHelp, cotal(["help", "sp"])) && same(spawnHelp, cotal(["spawn", "--help"])) && same(spawnHelp, cotal(["sp", "-h"])));
  const subHelp = cotal(["help", "ext", "remove"]);
  local("help ext remove writes nothing", subHelp);
  check("subcommand help names its path and alias", /^cotal ext remove$/m.test(subHelp.stdout) && /^Shorthands\n  cotal ext rm$/m.test(subHelp.stdout), shown(subHelp));
  check(
    "a subcommand resolves by alias and by its command's alias, in help and in --help",
    same(subHelp, cotal(["help", "x", "rm"])) && same(subHelp, cotal(["ext", "rm", "--help"])) && same(subHelp, cotal(["x", "remove", "-h"])),
  );
  refused("help of an unknown command is a usage error", cotal(["help", "nope"]), /unknown command: nope/);
  refused("help of an unknown subcommand is a usage error", cotal(["help", "ext", "nope"]), /cotal ext has no subcommand "nope"/);
  refused("help of a hidden internal subcommand is a usage error", cotal(["help", "ext", "__update-add"]), /cotal ext has no subcommand "__update-add"/);
  check("command help does not list a hidden subcommand", !cotal(["help", "ext"]).stdout.includes("__update-add"));
  refused("help of a hidden internal command is a usage error", cotal(["help", "__complete"]), /unknown command: __complete/);
  // A subcommand alias reaches the command as its canonical word. The seed is skipped by env so the
  // run reaches `ext remove` quickly; it refuses because nothing is installed.
  const removeByAlias = cotal(["x", "rm", "not-installed"], undefined, noSeed);
  check(
    "ext rm runs ext remove",
    removeByAlias.status === 1 && /no installed extension/.test(removeByAlias.stderr) && same(removeByAlias, cotal(["ext", "remove", "not-installed"], undefined, noSeed)),
    shown(removeByAlias),
  );
  const seedHelp = cotal(["x", "seed", "--help"]);
  local("ext seed --help through the alias prints help and writes nothing", seedHelp);
  // After `--` every word is text, so `-h` there is not a help request.
  refused("-h after -- is a word, not a help request", cotal(["ext", "--", "-h"]), /cotal ext has no subcommand "-h"/);
  refused("ext seed -- -h is a usage error, not help", cotal(["ext", "seed", "--", "-h"]), /usage: cotal ext/);
}

// ── Version ────────────────────────────────────────────────────────────────────────────────────────
{
  const version = cotal(["version"]);
  local("version writes nothing", version);
  check("version prints the binary version", /^cotal-ai \d+\.\d+\.\d+/.test(version.stdout), shown(version));
  check("--version and -V print the same", same(version, cotal(["--version"])) && same(version, cotal(["-V"])));
  refused("-v is not the version flag", cotal(["-v"]), /-v is not the version flag - run `cotal version` or `cotal -V`/);
}

// ── Structured output: one envelope on stdout, the usage refusal included ────────────────────────
{
  const envelopes = (r: Run) => {
    try {
      return r.stdout.split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, any>);
    } catch {
      return [];
    }
  };
  const text = cotal(["version"]);
  const json = cotal(["version", "--json"]);
  local("version --json writes nothing", json);
  const [env] = envelopes(json);
  check(
    "version --json is one ok envelope with no target",
    envelopes(json).length === 1 && env?.schemaVersion === 1 && env.command === "version" && env.target === null && env.outcome === "ok" && env.completeness === "complete" && Array.isArray(env.warnings) && !("error" in env),
    shown(json),
  );
  check("version --json reports the version the text prints", `cotal-ai ${env?.result?.version}` === text.stdout.split("\n")[0], { json: env?.result, text: text.stdout });
  check("version -j, --version --json and -V -j print the same envelope", same(json, cotal(["version", "-j"])) && same(json, cotal(["--version", "--json"])) && same(json, cotal(["-V", "-j"])));
  const colored = cotal(["version", "--json"], undefined, { FORCE_COLOR: "1" });
  check("forced color never reaches the envelope", colored.stdout === json.stdout, shown(colored));

  const bogus = cotal(["version", "--json", "--bogus"]);
  refused("a usage error under --json is refused", bogus, /Unknown option '--bogus'/);
  const [refusal] = envelopes(bogus);
  check(
    "a usage error under --json is one USAGE_INVALID envelope naming the help to read",
    envelopes(bogus).length === 1 && refusal?.outcome === "refused" && refusal.result === null && refusal.error?.code === "USAGE_INVALID" && refusal.error.remedy === "run `cotal help version`",
    shown(bogus),
  );
  const extra = cotal(["version", "-j", "extra"]);
  refused("an unexpected argument under -j is refused", extra, /Unexpected argument 'extra'/);
  check("an unexpected argument under -j is a USAGE_INVALID envelope", envelopes(extra)[0]?.error?.code === "USAGE_INVALID", shown(extra));
  // `--replay` takes no value, so `--replay off` used to be refused as a second channel name.
  const replayOff = cotal(["channel", "set", "general", "--replay", "off", "--json"]);
  check("`channel set <name> --replay off` names the stray value and points to --no-replay",
    envelopes(replayOff)[0]?.error?.code === "USAGE_INVALID" && envelopes(replayOff)[0]?.error?.message?.startsWith('--replay takes no value, so "off" was read as a channel name') === true
      && envelopes(replayOff)[0]?.error?.remedy === "run cotal channel set general --no-replay", shown(replayOff));
  const human = cotal(["version", "--bogus"]);
  refused("a usage error without --json is refused", human, /Unknown option '--bogus'/);
  check("a usage error without --json writes no envelope and prints the help on stderr", envelopes(human).length === 0 && human.stdout === "" && /^Usage\n  cotal version /m.test(human.stderr), shown(human));
  const helpJson = cotal(["help", "--json"]);
  refused("a command with no JSON output refuses --json", helpJson, /Unknown option '--json'/);
  check("a command with no JSON output writes no envelope for it", !helpJson.stdout.startsWith("{"), shown(helpJson));
  // An empty --space used to fall back to the selected space, so `history clear --space "$S" --yes`
  // with S unset purged it.
  const selected = (home: string) => writeFileSync(join(home, "current-mesh"), "ghost\n");
  for (const [argv, flag] of [[["history", "clear", "--space", "", "--yes"], "--space/-s"], [["send", "--space=", "-c", "general", "x"], "--space/-s"], [["whoami", "-s", " "], "--space/-s"], [["doctor", "--space", ""], "--space"]] as const) {
    const r = cotal([...argv], selected, noSeed);
    refused(`cotal ${argv.join(" ")} refuses the empty ${flag} before resolving the selected space`, r, new RegExp(`^✗ ${flag} is empty; name one space$`, "m"));
    check(`cotal ${argv.join(" ")} never reaches the selected space`, !r.stderr.includes("ghost"), shown(r));
  }
  const emptyJson = cotal(["history", "clear", "--space", "", "--yes", "--json"], selected, noSeed);
  check("an empty --space under --json is one USAGE_INVALID envelope with the space-listing remedy",
    envelopes(emptyJson).length === 1 && envelopes(emptyJson)[0]?.error?.code === "USAGE_INVALID" && envelopes(emptyJson)[0]?.error?.remedy === "name the space; `cotal space` lists the spaces this machine knows", shown(emptyJson));
}

// ── Global flags: accepted by every command, before or after its words, and text after -- ─────────
{
  const ansi = /\x1b\[/;
  const forced = { FORCE_COLOR: "1" };
  check("control: forced color colors help", ansi.test(cotal(["help"], undefined, forced).stdout));
  for (const argv of [["--no-color", "help"], ["help", "--no-color"], ["help", "spawn", "--no-color"], ["spawn", "--no-color", "--help"], ["--no-color"]])
  {
    const r = cotal(argv, undefined, forced);
    check(`cotal ${argv.join(" ")} prints with no ANSI color`, r.status === 0 && r.stdout.length > 0 && !ansi.test(r.stdout), shown(r));
  }
  // Under a locale whose character set is not UTF-8, marks and punctuation are written as plain writes
  // them, and a usage error, which has no mark there, is the classified report. An empty variable
  // counts as unset, and with none set the marks stay UTF-8.
  const nonAscii = /[^\x00-\x7f]/;
  const locales: [Record<string, string>, boolean][] = [
    [{}, false], [{ LC_ALL: "C.UTF-8" }, false], [{ LC_ALL: "en_US.utf8" }, false], [{ LC_CTYPE: "C.UTF-8", LANG: "C" }, false],
    [{ LC_ALL: "C" }, true], [{ LC_ALL: "POSIX" }, true], [{ LC_ALL: "en_US.ISO-8859-1" }, true], [{ LC_ALL: "C", LANG: "C.UTF-8" }, true], [{ LANG: "C" }, true],
  ];
  for (const [set, ascii] of locales) {
    const env = { LC_ALL: "", LC_CTYPE: "", LANG: "", ...set };
    const named = Object.entries(set).map(([key, value]) => `${key}=${value}`).join(" ") || "no locale variable";
    const help = cotal(["help"], undefined, env);
    const error = cotal(["nope"], undefined, env);
    check(`under ${named} help and an error are ${ascii ? "ASCII" : "drawn with UTF-8 marks"}`,
      help.status === 0 && error.status === 1 && nonAscii.test(help.stdout + error.stderr) === !ascii && error.stderr.startsWith(ascii ? "Request refused\n  unknown command: nope" : "✗ unknown command: nope"), { help: help.stdout.slice(0, 200), error: shown(error) });
  }
  for (const value of ["0", "false", "FALSE", "False"]) {
    const r = cotal(["help"], undefined, { FORCE_COLOR: value });
    check(`FORCE_COLOR=${value} turns color off`, r.status === 0 && r.stdout.length > 0 && !ansi.test(r.stdout), shown(r));
  }
  const refusal = cotal(["--no-color", "nope"], undefined, forced);
  check("control: forced color colors a refusal", ansi.test(cotal(["nope"], undefined, forced).stderr));
  check("a refusal under --no-color has no ANSI color", refusal.status === 1 && !ansi.test(refusal.stderr), shown(refusal));
  check("--no-input before the command word is accepted", same(cotal(["--no-input", "version"]), cotal(["version"])));
  check("--no-input after the command's words is accepted", same(cotal(["version", "--no-input"]), cotal(["version"])));
  check("--no-input and --no-color together are accepted", same(cotal(["--no-input", "version", "--no-color"]), cotal(["version"])));
  refused("a global flag after -- is a word", cotal(["ext", "--", "--no-input"]), /cotal ext has no subcommand "--no-input"/);
  // `personas edit` opens an editor, which --no-input forbids. The control runs a do-nothing editor.
  const persona = (home: string) => {
    mkdirSync(join(home, "..", ".cotal", "agents"), { recursive: true });
    writeFileSync(join(home, "..", ".cotal", "agents", "x.md"), "---\nname: x\n---\nhi\n");
  };
  const editor = { ...noSeed, VISUAL: 'node -e ""', EDITOR: 'node -e ""' };
  const edited = cotal(["personas", "edit", "x"], persona, editor);
  check("control: personas edit runs the editor", edited.status === 0 && edited.stdout.includes('saved "x"'), shown(edited));
  const forbidden = cotal(["personas", "edit", "x", "--no-input"], persona, editor);
  check("personas edit --no-input refuses to open an editor", forbidden.status === 1 && /--no-input forbids one/.test(forbidden.stderr) && !forbidden.stdout.includes("saved"), shown(forbidden));
  // An edit refused because the persona changed or was removed while the editor was open keeps the
  // draft and names it. The editors write to the draft, then change the catalog file behind it.
  for (const [what, behind, next] of [["changed", "printf B >> .cotal/agents/x.md", /compare it with `cotal persona show x`/], ["was removed", "rm .cotal/agents/x.md", /restore it with `cotal persona create x --file /]] as const) {
    const racing = `sh -c 'printf "edit-A\\n" >> "$1"; ${behind}' sh`;
    const r = cotal(["persona", "edit", "x"], persona, { ...noSeed, VISUAL: racing, EDITOR: racing });
    const draft = /your edit is kept in (\S+\.md);/.exec(r.stderr)?.[1];
    const kept = draft !== undefined && existsSync(draft) && readFileSync(draft, "utf8").includes("edit-A");
    if (draft) rmSync(dirname(draft), { recursive: true, force: true });
    check(`persona edit refused because the persona ${what} keeps the edited draft and says how to use it`,
      r.status === 2 && r.stderr.includes("CONFLICT") && r.stderr.includes(`persona ${what} while the operation was open`) && next.test(r.stderr) && kept, shown(r));
  }
  // The seeded default is `default` in the catalog and launches as `default_agent`.
  const seeded = (home: string) => {
    mkdirSync(join(home, "..", ".cotal", "agents"), { recursive: true });
    writeFileSync(join(home, "..", ".cotal", "agents", "default.md"), DEFAULT_AGENT);
  };
  const shownDefault = cotal(["persona", "show", "default", "--json"], seeded, noSeed);
  check("persona show reads the seeded default persona", shownDefault.status === 0 && JSON.parse(shownDefault.stdout).result?.definition?.name === "default_agent", shown(shownDefault));
  const editedDefault = cotal(["persona", "edit", "default"], seeded, editor);
  check("persona edit saves the seeded default persona", editedDefault.status === 0 && editedDefault.stdout.includes("Persona saved"), shown(editedDefault));
  // A catalog file saved as UTF-16 is named by its encoding, with the step to save it as UTF-8.
  const utf16 = (home: string) => {
    seeded(home);
    writeFileSync(join(home, "..", ".cotal", "agents", "w16.md"), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(DEFAULT_AGENT, "utf16le")]));
  };
  const saved = "it is saved as UTF-16, and Cotal reads only UTF-8";
  const listed16 = cotal(["persona", "--json"], utf16, noSeed);
  check("persona names a UTF-16 catalog file by its encoding", listed16.status === 4 && listed16.stdout.includes(`w16.md: ${saved}; save it as UTF-8`), shown(listed16));
  const shown16 = cotal(["persona", "show", "w16", "--json"], utf16, noSeed);
  check("persona show refuses a UTF-16 file by its encoding and says to save it as UTF-8",
    shown16.status === 1 && shown16.stdout.includes(`w16.md: ${saved}`) && /"remedy":"save \S+w16\.md as UTF-8"/.test(shown16.stdout), shown(shown16));
  const old16 = cotal(["personas", "list"], utf16, noSeed);
  check("personas list names it by its encoding too", old16.stdout.includes(`w16.md: ${saved}; save it as UTF-8`), shown(old16));
  // A catalog file that is a FIFO would block a read, so the list marks it unreadable and names it
  // rather than waiting on it.
  if (process.platform !== "win32") {
    const fifo = (home: string) => {
      seeded(home);
      spawnSync("mkfifo", [join(home, "..", ".cotal", "agents", "x.md")]);
    };
    const listed = cotal(["persona", "--json"], fifo, noSeed);
    const doc = (() => { try { return JSON.parse(listed.stdout) as { result?: { items?: { name: string; valid: boolean }[] }; warnings?: { code: string; message: string }[] }; } catch { return {}; } })();
    check("persona lists a FIFO in its catalog as unreadable, naming it, without waiting on it",
      listed.status === 4 && doc.result?.items?.some((item) => item.name === "x" && !item.valid) === true && doc.result.items.some((item) => item.name === "default" && item.valid) &&
        doc.warnings?.some((w) => w.code === "PERMISSION_DENIED" && /^persona is not a regular file: \S+\/x\.md; it was not read$/.test(w.message)) === true, shown(listed));
  }
  for (const sub of ["list", "show", "edit", "new", "rm"]) {
    const help = cotal(["help", "personas", sub]);
    check(`help personas ${sub} prints that subcommand's help`, help.status === 0 && help.stdout.includes(`cotal personas ${sub}`), shown(help));
  }
  // A catalog folder its owner made read-only stays read-only. Root writes through the mode, so the
  // cell runs only for an ordinary POSIX user.
  if (process.platform !== "win32" && process.getuid?.() !== 0) {
    let agents = "";
    const locked = (home: string) => {
      seeded(home);
      agents = join(home, "..", ".cotal", "agents");
      chmodSync(agents, 0o500);
    };
    const refusedCreate = cotal(["persona", "create", "locked", "--prompt", "x", "--subscribe", ""], locked, noSeed);
    const after = { mode: (statSync(agents).mode & 0o777).toString(8), files: readdirSync(agents).sort() };
    chmodSync(agents, 0o700);
    check("persona create refuses a read-only catalog with PERMISSION_DENIED and leaves it as it was",
      refusedCreate.status === 2 && /PERMISSION_DENIED/.test(refusedCreate.stderr) && after.mode === "500" && after.files.join() === "default.md", { ...shown(refusedCreate), after });
    // The edit draft is made in TMPDIR. One that is missing, not a folder or not writable is refused
    // by name, exit 2, before anything is made, instead of as a raw errno with an unknown outcome.
    const scratch = mkdtempSync(join(tmpdir(), "cotal-entry-tmp-"));
    cleanup.push(scratch);
    const file = join(scratch, "file");
    writeFileSync(file, "");
    const unwritable = join(scratch, "locked");
    mkdirSync(unwritable, { mode: 0o500 });
    for (const [what, dir, code] of [["missing", join(scratch, "nope"), "TARGET_UNAVAILABLE"], ["a file", file, "TARGET_UNAVAILABLE"], ["not writable", unwritable, "PERMISSION_DENIED"]] as const) {
      const r = cotal(["persona", "edit", "x"], persona, { ...editor, TMPDIR: dir });
      check(`persona edit with a TMPDIR that is ${what} refuses ${code}, exit 2, naming it`,
        r.status === 2 && r.stderr.includes(code) && r.stderr.includes(`the temporary directory ${dir} `) && r.stderr.includes("Next") && readdirSync(unwritable).length === 0, shown(r));
    }
    chmodSync(unwritable, 0o700);
    // `up` writes under .cotal first, so one this account cannot write is refused before anything is
    // started or written, naming it and the chmod.
    let dotCotal = "";
    const readOnly = cotal(["up", "--server", "nats://127.0.0.1:1"], (home) => {
      mkdirSync(join(home, "..", ".cotal"), { mode: 0o700 });
      dotCotal = realpathSync(join(home, "..", ".cotal"));
      chmodSync(dotCotal, 0o500);
    }, noSeed);
    const left = readdirSync(dotCotal);
    chmodSync(dotCotal, 0o700);
    check("up refuses a .cotal it cannot write with PERMISSION_DENIED, exit 2, naming it and chmod u+w, and writes nothing",
      readOnly.status === 2 && readOnly.stderr.includes("PERMISSION_DENIED") && readOnly.stderr.includes(`${dotCotal} is not writable by this account`) && readOnly.stderr.includes(`chmod u+w ${dotCotal}`) && left.length === 0, { ...shown(readOnly), left });
  }
  // A catalog travels with a cloned repo, so the legacy list escapes the control characters it reads
  // from one, and the flags that write a persona refuse them.
  const E = "\x1b]0;PWN\x07\x1b[2J";
  const raw = /[\x07\x1b]/;
  const hostile = (home: string) => {
    mkdirSync(join(home, "..", ".cotal", "agents"), { recursive: true });
    writeFileSync(join(home, "..", ".cotal", "agents", "h.md"), `---\nname: h\nrole: "r\\e]0;PWN\\aR"\ndescription: "d\\e[2JD"\n---\nbody ${E}B\n`);
  };
  for (const argv of [["personas", "list"], ["personas", "list", "-v"]]) {
    const r = cotal(argv, hostile, noSeed);
    check(`cotal ${argv.join(" ")} escapes the catalog's control characters`,
      r.status === 0 && !raw.test(r.stdout + r.stderr) && r.stdout.includes("r\\u001b]0;PWN\\u0007R") && r.stdout.includes("d\\u001b[2JD") &&
        (argv.length === 2 || r.stdout.includes("    body \\u001b]0;PWN\\u0007\\u001b[2JB")), shown(r));
  }
  // A parser diagnostic spans lines, and each is printed on its own rather than as escaped breaks.
  const unparseable = cotal(["personas", "list"], (home) => {
    mkdirSync(join(home, "..", ".cotal", "agents"), { recursive: true });
    writeFileSync(join(home, "..", ".cotal", "agents", "broken.md"), "---\nname: broken\nmodel: [unclosed\n---\nbody\n");
  }, noSeed);
  check("personas list prints a YAML diagnostic as lines, with no escaped line breaks",
    unparseable.status === 0 && /⨯ unparseable .*at line 2, column 17:$/m.test(unparseable.stdout) && /^ {4}model: \[unclosed$/m.test(unparseable.stdout) && /^ {20}\^$/m.test(unparseable.stdout) && !unparseable.stdout.includes("\\u000a"), shown(unparseable));
  // The preview was cut at 100 characters whatever the width, so a wide terminal lost its end.
  const longLine = `A reviewer persona whose one-line prompt runs past the old hundred-character cut ${"x".repeat(40)} END`;
  const wide = cotal(["personas", "list"], (home) => {
    mkdirSync(join(home, "..", ".cotal", "agents"), { recursive: true });
    writeFileSync(join(home, "..", ".cotal", "agents", "long.md"), `---\nname: long\n---\n${longLine}\n`);
  }, noSeed);
  check("personas list prints a long first prompt line whole when nothing limits the width",
    wide.status === 0 && wide.stdout.includes(`  ${longLine}\n`) && !wide.stdout.includes("…"), shown(wide));
  const card = `---\nname: h\nrole: "r\\e]0;PWN\\aR"\ndescription: "d\\e[2JD"\n---\nbody ${E}B\n`;
  const piped = cotal(["personas", "show", "h"], hostile, noSeed);
  check("personas show piped writes the file byte for byte", piped.status === 0 && piped.stdout.endsWith(`\n${card}`), shown(piped));
  for (const argv of [["persona", "create", "q", "--role"], ["persona", "create", "q", "--model"], ["personas", "new", "q", "--role"]]) {
    const r = cotal([...argv, `v${E}`, "--prompt", "body", "--subscribe", ""], persona, noSeed);
    check(`cotal ${argv.join(" ")} refuses control characters`,
      r.status === 1 && r.stderr.includes(`${argv[3]} takes a label without control characters`) && !raw.test(r.stdout + r.stderr), shown(r));
  }
  // A name refusal says which rule it broke.
  for (const [name, reason] of [["a".repeat(200), "persona names are at most 128 characters; this one has 200"], ["a.b", "persona names use letters, digits, '_' or '-', up to 128 characters"]]) {
    const r = cotal(["persona", "create", name, "--prompt", "x", "--subscribe", ""], persona, noSeed);
    check(`persona create refuses a ${name.length > 3 ? "200-character" : "dotted"} name with its reason`, r.status === 1 && [`✗ ${reason}`, `! ${reason}`].some((line) => r.stderr.startsWith(line)), shown(r));
  }
  // A --server that no registration names reads the project in this folder, as launch does.
  const inProject = cotal(["persona", "--json", "--server", "nats://127.0.0.1:1"], persona, noSeed);
  check("control: in a project, persona --server <unregistered> lists that project's catalog",
    inProject.status === 0 && /"kind":"personas","items":\[\{"name":"x"/.test(inProject.stdout), shown(inProject));
  // A channel flag entry the channel rules refuse names the flag and the entry, not the private draft.
  for (const [flag, value] of [["--subscribe", "#general"], ["--allow-subscribe", "a b"], ["--allow-publish", "kanäle"]] as const) {
    const r = cotal(["persona", "create", "q", "--prompt", "body", ...(flag === "--subscribe" ? [flag, value] : ["--subscribe", "", flag, value]), "--json"], persona, noSeed);
    check(`persona create ${flag} ${value} is USAGE_INVALID, naming the flag and the entry`,
      r.status === 1 && r.stdout.includes('"code":"USAGE_INVALID"') && r.stdout.includes(`${flag}: invalid channel \\"${value}\\"`) && !r.stdout.includes("cotal-persona-") &&
        (value !== "#general" || r.stdout.includes("name the channel without its #, as general")), shown(r));
  }
  const outside = cotal(["persona", "create", "q", "--prompt", "body", "--subscribe", "general", "--allow-subscribe", "ops", "--json"], persona, noSeed);
  check("persona create with --subscribe outside --allow-subscribe is USAGE_INVALID, naming both flags",
    outside.status === 1 && outside.stdout.includes('"code":"USAGE_INVALID"') && outside.stdout.includes("every --subscribe channel must be within --allow-subscribe") && !outside.stdout.includes("cotal-persona-"), shown(outside));
}

// ── team check names each located manifest problem, without quoting a persona file ───────────────
{
  const head = "apiVersion: cotal/v1\nkind: Mesh\nspace: entry\nagent: claude\n";
  const files = (manifest: string) => (home: string) => {
    mkdirSync(join(home, "..", "agents"), { recursive: true });
    writeFileSync(join(home, "..", "agents", "sec.md"), "---\nname: sec\nmodel: [SECRETPERSONA42\n---\nSec.\n");
    writeFileSync(join(home, "..", "m.yaml"), manifest);
  };
  const cases: [string, string, string[]][] = [
    ["a tab indent", `${head}channels:\n\tops: {}\n`, ["m.yaml:6:1: Tabs are not allowed as indentation at line 6, column 1"]],
    ["a misspelt key", `${head}chanels: {}\n`, ["m.yaml:5:", 'Unrecognized key: "chanels"']],
    ["an alias bomb", `${head}channels: {}\na: &a [x,x,x,x,x,x,x,x,x]\nb: &b [*a,*a,*a,*a,*a,*a,*a,*a,*a]\nc: &c [*b,*b,*b,*b,*b,*b,*b,*b,*b]\nd: &d [*c,*c,*c,*c,*c,*c,*c,*c,*c]\ne: [*d,*d,*d,*d,*d,*d,*d,*d,*d]\n`, ["m.yaml: Excessive alias count indicates a resource exhaustion attack"]],
    ["an undeclared subscriber", `${head}channels:\n  ops:\n    subscribe: [ghost]\n`, ['m.yaml:7:16: "ghost" is not declared in agents: (at channels.ops.subscribe)']],
    ["a persona with invalid frontmatter", `${head}agents:\n  sec: agents/sec.md\nchannels:\n  ops:\n    subscribe: [sec]\n`, ["m.yaml: agent file ", "sec.md: invalid YAML frontmatter; Flow sequence in block collection must be sufficiently indented and end with a ] at line 2, column 24 (at agents.sec)"]],
  ];
  for (const verb of ["boot", "deploy"]) {
    const r = cotal(["team", verb, "m.yaml"], files(cases[0]![1]), noSeed);
    check(`team ${verb} names a manifest problem by file, line and reason`,
      r.status === 1 && cases[0]![2].every((part) => r.stderr.includes(part)) && r.stderr.includes("fix each named problem and run team check again"), shown(r));
  }
  for (const [label, manifest, located] of cases) {
    const r = cotal(["team", "check", "m.yaml"], files(manifest), noSeed);
    check(`team check names ${label} by file, line and reason`,
      r.status === 1 && located.every((part) => r.stderr.includes(part)) && r.stderr.includes("fix each named problem and run team check again") && !r.stderr.includes("SECRETPERSONA42"), shown(r));
  }
  // `space:` takes only a name `space create` takes, so the check and both dry runs refuse any other
  // with the reason, before a later step fails on it. A dead broker address keeps any probe local.
  const named = (space: string) => `apiVersion: cotal/v1\nkind: Mesh\nspace: ${space}\nbroker:\n  servers: nats://127.0.0.1:9\nchannels: {}\n`;
  const notName = "is not a space name: a space name is 1 to 200 letters, digits, underscores or hyphens";
  for (const args of [["team", "check", "m.yaml"], ["team", "boot", "m.yaml", "--dry-run"], ["up", "-f", "m.yaml", "--dry-run"]]) {
    const r = cotal(args, files(named('"bad name"')), noSeed);
    check(`${args.join(" ")} refuses a space name that space create refuses, naming it`, r.status === 1 && r.stderr.includes(`m.yaml:3:8: space "bad name" ${notName}`), shown(r));
  }
  const escaped = cotal(["team", "check", "m.yaml"], files(named('"e\\u001b]0;X\\u0007c"')), noSeed);
  check("team check shows a space name with control characters escaped", escaped.status === 1 && escaped.stderr.includes(`space "e\\u001b]0;X\\u0007c" ${notName}`) && !/[\u0000-\u0009\u000b-\u001f]/u.test(escaped.stdout + escaped.stderr), shown(escaped));
  const lead = cotal(["team", "check", "m.yaml"], files(named('"-lead"')), noSeed);
  check("team check resolves a name space create takes, such as -lead", lead.status === 0 && lead.stdout.includes("Team manifest resolved"), shown(lead));
}

// ── Unknown words, prefixes, uninstalled seeded commands ──────────────────────────────────────────
{
  refused("an unknown command is a usage error", cotal(["nope"]), /unknown command: nope - run `cotal help`/);
  refused("a prefix of a command selects nothing", cotal(["spaw"]), /unknown command: spaw/);
  refused("a prefix of an aliased command selects nothing", cotal(["hist"]), /unknown command: hist/);
  refused("help for a seeded command that is not installed yet seeds nothing", cotal(["web", "--help"]), /unknown command: web - run `cotal help`/);
}

// ── A `✗` line shows the control characters of an argument it repeats as escapes ─────────────────
{
  const utf8 = { ...noSeed, LC_ALL: "C.UTF-8" };
  for (const [what, args] of [["an unknown command", ["c\u001b[2J"]], ["an unknown docs page", ["docs", "d\u001b[2J"]], ["an unknown preference", ["config", "get", "k\u001b[2J"]], ["an invalid channel", ["send", "-c", "c\u001b[2J", "x"]]] as const) {
    const r = cotal([...args], undefined, utf8);
    check(`${what} is refused on a ✗ line that shows its escape sequence escaped`,
      r.status === 1 && r.stderr.startsWith("✗ ") && r.stderr.includes("\\u001b[2J") && !/[\u0000-\u0009\u000b-\u001f\u007f]/u.test(r.stdout + r.stderr), shown(r));
  }
}

// ── Every alias is its command: same help, same refusal ───────────────────────────────────────────
// The refusal pairs skip the seed by env. Whether an alias's usage error writes anything is the
// `sp --bogus` cell below; a seed in every pair would make a proof of the seed order outrun its budget.
check("the binary registers the aliases this cut ships", ["sp:spawn", "a:attach", "s:status", "r:run", "x:ext", "h:history"].every((pair) => aliases.some(({ alias, cmd }) => `${alias}:${cmd.name}` === pair)), aliases.map(({ alias, cmd }) => `${alias}:${cmd.name}`));
for (const { alias, cmd } of aliases) {
  check(`${alias} --help prints ${cmd.name}'s help`, same(cotal([alias, "--help"]), cotal([cmd.name, "--help"])));
  if (cmd.rawArgs) continue;
  const viaAlias = cotal([alias, "--not-a-flag"], undefined, noSeed);
  refused(`${alias} --not-a-flag is refused`, viaAlias, /Unknown option '--not-a-flag'/);
  check(`${alias} --not-a-flag is refused as ${cmd.name} refuses it`, same(viaAlias, cotal([cmd.name, "--not-a-flag"], undefined, noSeed)), shown(viaAlias));
}

// ── Usage errors are refused before the seed; a valid command seeds ──────────────────────────────
{
  refused("an unknown flag writes no seed store", cotal(["spawn", "--bogus"]), /Unknown option '--bogus'/);
  refused("an alias's unknown flag writes no seed store", cotal(["sp", "--bogus"]), /Unknown option '--bogus'/);
  refused("an undeclared subcommand writes no seed store", cotal(["ext", "bogus"]), /cotal ext has no subcommand "bogus"/);
  refused("a missing flag value writes no seed store", cotal(["spawn", "--space"]), /--space/);
  const control = cotal(["sync"]);
  check("control: a valid command that is not a read seeds the same sandbox shape", control.status === 0 && control.wrote.length > 0, shown(control));
}

// ── Short flags parse as their long form; a wrong-case short is refused ───────────────────────────
// In process against the registry the binary composes: running each command would perform it.
for (const cmd of commands) {
  if (cmd.rawArgs) continue;
  for (const flag of cmd.flags ?? []) {
    if (!flag.short) continue;
    const value = flag.type === "string" ? ["v"] : [];
    const short = parseCommandArgs(cmd, [`-${flag.short}`, ...value]).values;
    const long = parseCommandArgs(cmd, [`--${flag.name}`, ...value]).values;
    check(`${cmd.name} -${flag.short} parses as --${flag.name}`, JSON.stringify(short) === JSON.stringify(long), { short, long });
    const swapped = flag.short === flag.short.toUpperCase() ? flag.short.toLowerCase() : flag.short.toUpperCase();
    if (swapped === flag.short || (cmd.flags ?? []).some((f) => f.short === swapped)) continue;
    let error = "";
    try {
      parseCommandArgs(cmd, [`-${swapped}`, ...value]);
    } catch (e) {
      error = String((e as { code?: string }).code);
    }
    check(`${cmd.name} -${swapped} (wrong case of -${flag.short}) is refused`, error.startsWith("ERR_PARSE_ARGS"), error);
    if (flag.type !== "string") continue;
    let missing = "";
    try {
      parseCommandArgs(cmd, [`-${flag.short}`]);
    } catch (e) {
      missing = String((e as { code?: string }).code);
    }
    check(`${cmd.name} -${flag.short} without its value is refused`, missing.startsWith("ERR_PARSE_ARGS"), missing);
  }
}

finish();
