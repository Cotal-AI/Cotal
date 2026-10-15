/**
 * The command kernel's entry, driven through the built binary in a fresh sandbox per invocation.
 *
 * Bare `cotal`, help and version read local metadata only, and every usage error is refused before
 * any effect: no connector seed, no config write. An alias resolves to the same command as its name
 * (help, refusal and parse), and a word that only prefixes a command selects nothing. A short flag
 * parses as its long form, and a wrong-case short flag or a missing value is refused.
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
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseCommandArgs, registry, type Command } from "@cotal-ai/core";
import "@cotal-ai/cli";
import "@cotal-ai/manager";
import "@cotal-ai/delivery";
import "@cotal-ai/runtime";
import "@cotal-ai/auth";
import { assertSmokeSandboxDown, createSuite, recordSmokeSandbox } from "@cotal-ai/smoke-kit";

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
  check("a fresh machine is pointed to setup", fresh.stdout.includes("No space is selected. Run cotal setup"), shown(fresh));
  check("the entry screen names common commands and where the rest are", /Common commands/.test(fresh.stdout) && /\bspawn\b/.test(fresh.stdout) && fresh.stdout.includes("cotal help"), shown(fresh));
  const ghost = cotal([], (home) => writeFileSync(join(home, "current-mesh"), "ghost\n"));
  local("bare cotal with a selected space writes nothing", ghost);
  check("the entry screen names the selected space, and says when it is not recorded here", ghost.stdout.includes("Selected space: ghost (not recorded on this machine)"), shown(ghost));
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
  check("command help shows the usage and the aliases", /usage: /.test(spawnHelp.stdout) && /aliases: sp/.test(spawnHelp.stdout), shown(spawnHelp));
  check("help sp, spawn --help and sp -h print the same help", same(spawnHelp, cotal(["help", "sp"])) && same(spawnHelp, cotal(["spawn", "--help"])) && same(spawnHelp, cotal(["sp", "-h"])));
  const subHelp = cotal(["help", "ext", "remove"]);
  local("help ext remove writes nothing", subHelp);
  check("subcommand help names its path and alias", /cotal ext remove/.test(subHelp.stdout) && /aliases: rm/.test(subHelp.stdout), shown(subHelp));
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

// ── Unknown words, prefixes, uninstalled seeded commands ──────────────────────────────────────────
{
  refused("an unknown command is a usage error", cotal(["nope"]), /unknown command: nope - run `cotal help`/);
  refused("a prefix of a command selects nothing", cotal(["spaw"]), /unknown command: spaw/);
  refused("a prefix of an aliased command selects nothing", cotal(["hist"]), /unknown command: hist/);
  refused("help for a seeded command that is not installed yet seeds nothing", cotal(["web", "--help"]), /unknown command: web - run `cotal help`/);
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
  const control = cotal(["ext", "list"]);
  check("control: a valid command seeds the same sandbox shape", control.status === 0 && control.wrote.length > 0, shown(control));
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
