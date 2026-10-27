/**
 * Every usage error has the one format the docs describe: the error, then any remedy, then the
 * command's help, all on stderr, nothing on stdout, exit 1. A command's own input checks used to
 * print a framed "Request refused … Code: USAGE_INVALID" block with no help; `clean` printed a bare
 * `usage:` line or a lowercase "refusing to clean store without --force"; and `help service nosuch`
 * refused without listing the subcommands. A missing `--yes` is the exception: its refusal and remedy
 * are the whole fix, so it prints without the help. A mistyped word that is near a command, leading
 * flag, subcommand or option names it. Under `--plain` or a locale without UTF-8, which have no
 * refusal mark, the error is the classified report instead, still followed by the help; it used to
 * print the `✗` mark under `--plain` and the `!` warning mark under such a locale.
 *
 * A folder whose `.cotal` is a file refuses every command with `CONFLICT`, naming that file, before
 * anything runs. A removed working folder refuses every command but help, version, docs and
 * telemetry with its line and the `cd` remedy and no help, as a missing --yes does, `up`, `down` and
 * `backup create` included, which crashed with Node's stack trace. Help there says the folder no
 * longer exists.
 *
 * Every command and subcommand `cotal help` lists shows one to three examples, each a whole command
 * with a note on what it does, which parses under the options its help lists. They come right after
 * Usage and Shorthands, before Commands and Options; they used to come last, after the options, as
 * bare command lines, and most commands had none.
 *
 * A usage that declares several forms, one per line, as `linear` does, shows each form on its own
 * lines; help printed them joined by an escaped `\u000a`. A flag a `linear` operation does not take
 * is refused naming it and that operation's flags and usage, without the help: `serve --json` says
 * serve has no --json or --plain output.
 *
 * Driven through the built binary in a sandboxed HOME, XDG_CONFIG_HOME and COTAL_HOME, with the
 * built `@cotal-ai/linear` extension imported for its cells. The examples census renders each help
 * in this process from the built surfaces the binary composes. Nothing is started or deleted.
 *
 * Run: pnpm smoke:usage-format
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { findCommand, findSubcommand, parseCommandArgs, registry, type Command, type ParsedArgs, type Subcommand } from "@cotal-ai/core";
import { assertSmokeSandboxDown, createSuite, recordSmokeSandbox } from "@cotal-ai/smoke-kit";
import { displayWidth } from "@cotal-ai/workspace";

const REPO = join(import.meta.dirname, "..", "..", "..");
const BIN = join(REPO, "bin", "dist", "cotal.js");
if (!existsSync(BIN)) {
  console.error(`✗ ${BIN} missing - build first: pnpm --filter cotal-ai... build`);
  process.exit(1);
}

const { check, finish } = createSuite();
const home = mkdtempSync(join(tmpdir(), "cotal-usage-format-"));
const neutral = join(home, "neutral");
mkdirSync(neutral);
process.on("exit", () => rmSync(home, { recursive: true, force: true }));

// The locale decides the refusal's shape, so the host's is replaced with a UTF-8 one.
const HOST_ENV = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("COTAL_") && !["FORCE_COLOR", "NO_COLOR", "LC_ALL", "LC_CTYPE"].includes(k)));
const env = { ...HOST_ENV, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, ".config"), COTAL_HOME: join(home, ".cotal"), COTAL_SKIP_CONNECTOR_SEED: "1", NO_COLOR: "1", LANG: "C.UTF-8" };
const run = (args: string[], extra: Record<string, string> = {}, cwd = neutral) => {
  const r = spawnSync(process.execPath, [BIN, ...args], { cwd, env: { ...env, ...extra }, encoding: "utf8", timeout: 120_000 });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
};
const shown = (r: ReturnType<typeof run>) => ({ status: r.status, stdout: r.stdout.slice(0, 600), stderr: r.stderr.slice(0, 900) });
const usageShape = (r: ReturnType<typeof run>, message: RegExp) =>
  r.status === 1 && r.stdout === "" && /^✗ /m.test(r.stderr) && message.test(r.stderr) && /Usage/.test(r.stderr) && !/Request refused|Code:/.test(r.stderr);

const parser = run(["status", "--bogus"]);
check("control: a parser usage error has the documented shape", usageShape(parser, /Unknown option '--bogus'/), shown(parser));

// The linear extension declares one usage form per line.
const LINEAR = join(import.meta.dirname, "..", "..", "linear", "dist", "index.js");
const linear = (args: string[]) => {
  const r = spawnSync(process.execPath, ["--import", pathToFileURL(LINEAR).href, BIN, "linear", ...args], { cwd: neutral, env, encoding: "utf8", timeout: 120_000 });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
};
const linearHelp = linear(["--help"]);
check("a usage of several forms shows each form on its own lines, with no escaped newline", linearHelp.status === 0 && !linearHelp.stdout.includes("\\u000a")
  && ["cotal linear account add <name>", "cotal linear account login <name> --mode <write|readonly>", "cotal linear serve <account> --endpoint <reverse-dns-name> [--space <s>] [--server <url>]"].every((form) => linearHelp.stdout.includes(`\n  ${form}`)), shown(linearHelp));
const serveJson = linear(["serve", "work", "--endpoint", "com.example.linear", "--json"]);
check("linear serve --json is refused naming the flag, that serve has no --json or --plain output, and its own flags and usage, without the help",
  serveJson.status === 1 && serveJson.stdout === "" && serveJson.stderr.startsWith("✗ --json does not belong to linear serve, a foreground service that reports as text and has no --json or --plain output")
  && serveJson.stderr.includes("drop --json; linear serve takes --endpoint, --space, --server: cotal linear serve <account> --endpoint <reverse-dns-name> [--space <s>] [--server <url>]") && !/Usage|Options/.test(serveJson.stderr), shown(serveJson));

// A refusal points the way the command reads its words: a word that starts with "-" goes after
// --, an option value that starts with "-" is written --name=value, a short option takes its value
// after a space, and an option typed with a typographic dash is named with hyphens.
const dashWord = run(["send", "-c", "general", "-n is a flag here"]);
check("an unknown option names -- for a word that starts with -", usageShape(dashWord, /Unknown option '-n'/) && /put -- before it/.test(dashWord.stderr), shown(dashWord));
const dashValue = run(["history", "--from", "-bob"]);
check("an option value that starts with - is given its --name=value form", usageShape(dashValue, /the value of --from starts with "-"/) && /write it as --from=-bob/.test(dashValue.stderr), shown(dashValue));
const noValue = run(["history", "--limit"]);
check("an option given last with no value is refused naming it and its placeholder", usageShape(noValue, /--limit needs a value/) && /write --limit <n>/.test(noValue.stderr) && !/argument missing/.test(noValue.stderr), shown(noValue));
const flagValue = run(["history", "--limit", "--from", "bob"]);
check("an option followed by another of the command's options is refused as missing its value", usageShape(flagValue, /--limit needs a value/) && /write --limit <n>/.test(flagValue.stderr), shown(flagValue));
const shortEquals = run(["send", "-c=general", "hello"]);
check("-c=value is refused naming the value it would give", usageShape(shortEquals, /-c=general gives -c the value "=general"/) && /write -c general or --channel=general/.test(shortEquals.stderr), shown(shortEquals));
for (const typed of ["\u2014json", "\u2212\u2212json", "\u2013json"]) {
  const r = run(["status", typed]);
  check(`${typed} is refused as a typographic dash, naming --json`, usageShape(r, /starts with a typographic dash/) && /type the option with hyphens: --json/.test(r.stderr), shown(r));
}

const missing = run(["space", "create"]);
check("a missing argument a command checks has the same shape", usageShape(missing, /space create/), shown(missing));

const conflict = run(["up", "--foreground", "--detach"]);
check("two conflicting flags have the same shape", usageShape(conflict, /--foreground or --detach/), shown(conflict));

const noTarget = run(["clean"]);
check("clean with no target has the same shape and names the targets", usageShape(noTarget, /clean needs a target: history, store, all/), shown(noTarget));

const noForce = run(["clean", "store"]);
check("clean store without --force has the same shape, with the remedy on its own line", usageShape(noForce, /requires --force/) && /cotal clean store --force/.test(noForce.stderr), shown(noForce));

const helpPath = run(["help", "service", "nosuch"]);
check("help with an unknown subcommand names it and lists the command's subcommands", usageShape(helpPath, /cotal service has no subcommand "nosuch"/) && /\bstart\b/.test(helpPath.stderr) && /\bstop\b/.test(helpPath.stderr), shown(helpPath));

const subcommand = run(["service", "frob"]);
check("control: the parser's unknown subcommand has the same words", usageShape(subcommand, /cotal service has no subcommand "frob"/), shown(subcommand));

// --help after a word that names no subcommand refuses as `cotal help` does, with the nearest one.
// After a real subcommand, history's channel word or a leaf's argument it still prints the help.
for (const args of [["space", "nosuch", "--help"], ["persona", "nosuch", "--help"], ["config", "nosuch", "--help"], ["channel", "nosuch", "--help"], ["team", "nosuch", "-h"]] as const) {
  const r = run([...args]);
  check(`${args.join(" ")} refuses the unknown subcommand`, usageShape(r, new RegExp(`cotal ${args[0]} has no subcommand "nosuch"`)), shown(r));
}
const nearHelp = run(["space", "creat", "--help"]);
check("space creat --help names the nearest subcommand", usageShape(nearHelp, /cotal space has no subcommand "creat" - did you mean create\?/), shown(nearHelp));
for (const args of [["space", "create", "--help"], ["history", "general", "--help"], ["team", "show", "anything", "--help"]] as const) {
  const r = run([...args]);
  check(`control: ${args.join(" ")} prints its help`, r.status === 0 && /Usage/.test(r.stdout), shown(r));
}

// A subcommand's help gives its whole usage, name argument included, and only its own options.
for (const [args, usage, foreign] of [
  [["help", "channel", "set"], "cotal channel set <name> ", /--purge|--follow/],
  [["help", "channel", "show"], "cotal channel show <name> ", /--purge|--desc/],
  [["help", "persona", "create"], "cotal persona create <name> ", /--yes/],
  [["help", "history", "clear"], "cotal history clear ", /--grep|--follow/],
  [["help", "meshes"], "cotal meshes ", undefined],
  [["help", "personas"], "cotal personas ", undefined],
] as const) {
  const r = run([...args]);
  check(`${args.join(" ")} prints the usage ${usage.trim()} and no other subcommand's options`, r.status === 0 && r.stdout.includes(`Usage\n  ${usage}`) && !foreign?.test(r.stdout), shown(r));
}

// Every command and subcommand `cotal help` lists shows one to three examples, the most common use
// first, each a whole command with a note on what it does. Each example parses under the options its
// help lists and selects that subcommand. Examples follow Usage and Shorthands, before Commands and
// Options, and on 80 columns each command is one line that fits, with its note beside it or under it.
{
  const built = (path: string): Promise<unknown> => import(pathToFileURL(join(REPO, path)).href);
  // The surfaces the composition root imports (bin/run.ts); each registers its commands.
  for (const surface of ["implementations/cli/dist/index.js", "implementations/manager/dist/index.js", "implementations/delivery/dist/index.js", "implementations/runtime/dist/index.js", "implementations/auth/dist/index.js", "bin/dist/docs.js", "bin/dist/daemon/command.js"]) await built(surface);
  const { printHelpPath } = (await built("implementations/cli/dist/help.js")) as typeof import("../src/help.js");
  const { servicePresetCommand } = (await built("implementations/cli/dist/lib/service-presets.js")) as typeof import("../src/lib/service-presets.js");
  const { managerServiceCommand } = (await built("implementations/cli/dist/commands/manager-service.js")) as typeof import("../src/commands/manager-service.js");
  const commands = registry.all<Command>("command").filter((cmd) => !cmd.name.startsWith("__") && !cmd.hidden);
  const listing = run(["help"]).stdout;
  const listed = listing.slice(listing.indexOf("Help does not check services.")).split("\n").flatMap((line) => /^ {2}([a-z][\w-]*)[, ]/.exec(line)?.[1] ?? []);
  check("the examples census walks every command cotal help lists", listed.length > 30 && JSON.stringify([...listed].sort()) === JSON.stringify(commands.map((cmd) => cmd.name).sort()), { listed, walked: commands.map((cmd) => cmd.name) });
  const words = (line: string): string[] => [...line.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map((match) => match[1] ?? match[2] ?? match[3]!);
  // How an example's words reach a parser, as the dispatcher reads them: a service takes its preset's
  // flags, and `manager <verb>` is `service <verb> manager`.
  const problemsOf = (cmd: Command, path: readonly string[], command: string): string[] => {
    const [program, word, ...rest] = words(command);
    if (program !== "cotal" || findCommand([cmd], word) !== cmd) return [`${command}: does not run cotal ${cmd.name}`];
    const lifecycle = managerServiceCommand(cmd, rest);
    const target = lifecycle?.cmd ?? servicePresetCommand(cmd, rest);
    let parsed: ParsedArgs;
    try { parsed = parseCommandArgs(target, lifecycle?.argv ?? rest); } catch (error) { return [`${command}: ${(error as Error).message}`]; }
    let selected: Command | Subcommand = target;
    const chosen: string[] = [];
    for (const positional of parsed.positionals) {
      const sub = findSubcommand(selected, positional);
      if (!sub || sub.hidden) break;
      chosen.push(sub.name);
      selected = sub;
    }
    const problems: string[] = [];
    if (path.some((name, i) => chosen[i] !== name)) problems.push(`${command}: selects ${chosen.join(" ") || "no subcommand"}, not ${path.join(" ")}`);
    const unlisted = Object.keys(parsed.values).filter((name) => selected.flagNames && !selected.flagNames.includes(name));
    if (unlisted.length) problems.push(`${command}: --${unlisted.join(", --")} is not among the options its help lists`);
    return problems;
  };
  let covered = 0;
  const census = (cmd: Command, path: readonly string[], node: Command | Subcommand): void => {
    covered++;
    const examples = node.examples ?? [];
    const problems: string[] = [];
    if (examples.length < 1 || examples.length > 3) problems.push(`declares ${examples.length} examples`);
    const lines: string[] = [];
    printHelpPath(cmd, path, (line) => lines.push(...line.replace(/\x1b\[[0-9;]*m/g, "").split("\n")), 80);
    const at = lines.indexOf("Examples");
    const end = lines.indexOf("", at);
    const section = lines.slice(at + 1, end === -1 ? undefined : end);
    if (at === -1 || at < Math.max(lines.indexOf("Usage"), lines.indexOf("Shorthands")) || ["Commands", "Options"].some((title) => lines.includes(title) && lines.indexOf(title) < at)) problems.push(`Examples is not between Usage and Commands or Options: ${lines.join(" | ").slice(0, 300)}`);
    for (const example of examples) {
      if (typeof example === "string") { problems.push(`${example}: has no note`); continue; }
      const { command, note } = example;
      if (!note || note.length > 60 || note.endsWith(".")) problems.push(`${command}: its note "${note}" is empty, over 60 characters or ends with a period`);
      if (!section.some((line) => line.startsWith(`  ${command}`) && displayWidth(line) <= 80) || !section.join(" ").replace(/\s+/g, " ").includes(`${command} ${note}`)) problems.push(`${command}: is not one line that fits 80 columns with its note: ${section.join(" | ")}`);
      problems.push(...problemsOf(cmd, path, command));
    }
    check(`${["cotal", cmd.name, ...path].join(" ")} shows one to three examples after its usage, each one line with a note, parsing under its own options`, problems.length === 0, problems);
    for (const sub of node.subcommands ?? []) if (!sub.hidden) census(cmd, [...path, sub.name], sub);
  };
  for (const cmd of commands) census(cmd, [], cmd);
  console.log(`  examples census: ${covered} commands and subcommands`);

  // The binary prints the same order, and `manager <verb> --help`, which reads the service command,
  // shows the manager's own examples.
  const spawnHelp = run(["spawn", "--help"]);
  const order = ["Usage", "Shorthands", "Examples", "Options"].map((title) => spawnHelp.stdout.indexOf(`\n${title}\n`));
  check("cotal spawn --help shows Usage, Shorthands, Examples, then Options", spawnHelp.status === 0 && order.every((index, i) => index !== -1 && (i === 0 || index > order[i - 1]!)), shown(spawnHelp));
  const managerStart = run(["manager", "start", "--help"]);
  const declared = registry.resolve<Command>("command", "manager").subcommands?.find((sub) => sub.name === "start")?.examples ?? [];
  check("cotal manager start --help shows the manager start examples", managerStart.status === 0 && declared.length > 0 && declared.every((example) => typeof example !== "string" && managerStart.stdout.includes(`  ${example.command}`)), shown(managerStart));
}

// No mark at all: the report names the outcome in words, and `!` stays the warning mark.
const reportShape = (r: ReturnType<typeof run>, message: RegExp) =>
  r.status === 1 && r.stdout === "" && /^Request refused$/m.test(r.stderr) && /Code: +USAGE_INVALID/.test(r.stderr) && message.test(r.stderr) && /Usage/.test(r.stderr) && !/[✗↳]|^! /m.test(r.stderr);
const ascii = { LANG: "C" };
const plainOwn = run(["config", "get", "bogus", "--plain"]);
check("under --plain a command's own usage refusal is the plain report with its Next, then the help", reportShape(plainOwn, /unknown preference "bogus"/) && /^Next$/m.test(plainOwn.stderr), shown(plainOwn));
const asciiOwn = run(["config", "get", "bogus"], ascii);
check("under a locale without UTF-8 a command's own usage refusal is the report, then the help", reportShape(asciiOwn, /unknown preference "bogus"/), shown(asciiOwn));
const plainParser = run(["status", "--bogus", "--plain"]);
check("under --plain a parser usage error is the plain report, then the help", reportShape(plainParser, /Unknown option '--bogus'/), shown(plainParser));
const asciiParser = run(["status", "--bogus"], ascii);
check("under a locale without UTF-8 a parser usage error is the report, then the help", reportShape(asciiParser, /Unknown option '--bogus'/), shown(asciiParser));
const asciiUnknown = run(["frobnicate"], ascii);
check("under a locale without UTF-8 an unknown command is the report, with no warning mark", asciiUnknown.status === 1 && /^Request refused$/m.test(asciiUnknown.stderr) && /unknown command: frobnicate/.test(asciiUnknown.stderr) && !/^! /m.test(asciiUnknown.stderr), shown(asciiUnknown));
// A missing --yes outside a terminal is not a grammar mistake: the refusal and a remedy that names
// --yes are the whole fix, so the command's help is left out, as `down` already did.
const project = join(home, "proj");
mkdirSync(join(project, ".cotal", "agents"), { recursive: true });
writeFileSync(join(project, ".cotal", "agents", "p1.md"), "---\nname: p1\n---\nhello\n");
const confirmShape = (r: ReturnType<typeof run>, message: RegExp, remedy: string) =>
  r.status === 1 && r.stdout === "" && /^✗ /m.test(r.stderr) && message.test(r.stderr) && r.stderr.includes(remedy) && !/Usage|Options/.test(r.stderr);
for (const [args, message, remedy] of [
  [["persona", "remove", "p1"], /removing 'p1' .* requires --yes/, "confirm with cotal persona remove p1 --yes"],
  [["history", "clear", "--dms"], /history clear requires --yes/, "then confirm it with cotal history clear --dms --yes"],
  [["space", "delete", "nosuch"], /live space deletion requires a terminal/, "then run cotal space delete nosuch --yes"],
  [["reset", "store", "nosuch"], /reset store needs a terminal confirmation/, "then run cotal reset store nosuch --yes"],
  [["reset", "space", "nosuch"], /reset space needs a terminal confirmation/, "then run cotal reset space nosuch --yes"],
] as const) {
  const r = run([...args], {}, project);
  check(`${args.join(" ")} without --yes prints its refusal and remedy without the help`, confirmShape(r, message, remedy), shown(r));
}

// A mistyped command, leading flag, subcommand or option names the nearest one; a word near nothing
// keeps the plain line.
for (const [args, message] of [
  [["stauts"], /unknown command: stauts - did you mean status\? Or run `cotal help` to list commands/],
  [["help", "stauts"], /unknown command: stauts - did you mean status\?/],
  // Cotal's own word for a stop, which is nearer to spawn, its opposite.
  [["despawn", "zzt1"], /unknown command: despawn - did you mean stop\? Or run `cotal help` to list commands/],
  [["help", "despawn"], /unknown command: despawn - did you mean stop\?/],
  [["--jsno"], /unknown command: --jsno - did you mean --json\?/],
  [["--verison"], /unknown command: --verison - did you mean --version\?/],
  [["persona", "shwo"], /cotal persona has no subcommand "shwo" - did you mean show\? Or run `cotal help persona`/],
  [["help", "persona", "shwo"], /cotal persona has no subcommand "shwo" - did you mean show\?/],
  [["status", "--jsno"], /Unknown option '--jsno' - did you mean --json\?/],
] as const) {
  const r = run([...args]);
  check(`${args.join(" ")} names the nearest word`, r.status === 1 && message.test(r.stderr), shown(r));
}
const far = run(["frobnicate"]);
check("control: a word near nothing gets no suggestion", far.status === 1 && /unknown command: frobnicate - run `cotal help` to list commands/.test(far.stderr) && !/did you mean/.test(far.stderr), shown(far));

// A word that is no subcommand is refused naming the subcommands the command takes, as telemetry
// names its levels, and a hidden subcommand is not offered.
const level = run(["telemetry", "bogus"]);
check("telemetry with a word that is no level is refused naming the levels", usageShape(level, /cotal telemetry has no subcommand "bogus"; it takes off, minimal or regular - run `cotal help telemetry`/), shown(level));
const levelHelp = run(["help", "telemetry", "bogus"]);
check("help telemetry with the same word names the same levels", usageShape(levelHelp, /cotal telemetry has no subcommand "bogus"; it takes off, minimal or regular/), shown(levelHelp));
const levelJson = run(["telemetry", "bogus", "--json"]);
check("the --json refusal names the levels in its message", (() => { try { return (JSON.parse(levelJson.stdout) as { error?: { message?: string } }).error?.message?.includes("it takes off, minimal or regular") === true; } catch { return false; } })(), shown(levelJson));
const hiddenSub = run(["ext", "bogus"]);
check("the refusal lists the visible subcommands only", /cotal ext has no subcommand "bogus"; it takes \w/.test(hiddenSub.stderr) && !/__/.test(hiddenSub.stderr.split("\n")[0] ?? ""), shown(hiddenSub));

// A word of any length is refused whole. The refusal repeats its first 128 characters and its length,
// so one over-long argument does not print a line as long as itself; a word of 128 characters, the
// longest name a command takes, is repeated whole.
const long = "x".repeat(100_000);
const longest = (text: string) => Math.max(...text.split("\n").map((line) => line.length));
const longCommand = run([long]);
check("an over-long unknown command is repeated as its first 128 characters and its length", longCommand.status === 1 && longCommand.stderr.includes(`unknown command: ${"x".repeat(128)}… (100000 characters) - run \`cotal help\` to list commands`) && longest(longCommand.stderr) < 400, shown(longCommand));
const longSub = run(["telemetry", long]);
check("an over-long unknown subcommand is repeated the same way", usageShape(longSub, /cotal telemetry has no subcommand "x{128}… \(100000 characters\)"; it takes off, minimal or regular/) && longest(longSub.stderr) < 400, shown(longSub));
const longSubJson = run(["telemetry", long, "--json"]);
const parsed = (r: ReturnType<typeof run>) => { try { return JSON.parse(r.stdout) as { target?: unknown; error?: { code?: string; message?: string } }; } catch { return undefined; } };
check("its --json message is repeated the same way", longSubJson.status === 1 && parsed(longSubJson)?.error?.code === "USAGE_INVALID" && parsed(longSubJson)?.error?.message?.startsWith(`cotal telemetry has no subcommand "${"x".repeat(128)}… (100000 characters)"`) === true && longSubJson.stdout.length < 1_000, shown(longSubJson));
check("its --json target is what a short word's refusal carries", JSON.stringify(parsed(longSubJson)?.target) === JSON.stringify(parsed(levelJson)?.target), { long: parsed(longSubJson)?.target, short: parsed(levelJson)?.target });
const longRun = run(["run", "show", `run-${long}`]);
check("an over-long run id is refused repeating its first 128 characters and its length", longRun.status === 1 && longRun.stderr.includes(`run show: "run-${"x".repeat(124)}… (100004 characters)" is not a run id`) && longest(longRun.stderr) < 400, shown(longRun));
const longRunJson = run(["run", "show", `run-${long}`, "--json"]);
check("its --json message is repeated the same way", longRunJson.status === 1 && parsed(longRunJson)?.error?.code === "USAGE_INVALID" && parsed(longRunJson)?.error?.message?.startsWith(`run show: "run-${"x".repeat(124)}… (100004 characters)" is not a run id`) === true && longRunJson.stdout.length < 1_000, shown(longRunJson));
const edge = "w".repeat(128);
const edgeCommand = run([edge]);
check("control: a 128-character unknown command is repeated whole", edgeCommand.status === 1 && edgeCommand.stderr.includes(`unknown command: ${edge} - run`) && !/characters\)/.test(edgeCommand.stderr), shown(edgeCommand));
const edgeSub = run(["telemetry", edge]);
check("control: a 128-character unknown subcommand is repeated whole", usageShape(edgeSub, new RegExp(`cotal telemetry has no subcommand "${edge}"; it takes`)), shown(edgeSub));
const edgeRun = run(["run", "show", `run-${"w".repeat(124)}`, "--json"]);
check("control: a 128-character run id is repeated whole", edgeRun.status === 1 && parsed(edgeRun)?.error?.message?.startsWith(`run show: "run-${"w".repeat(124)}" is not a run id`) === true, shown(edgeRun));

const json = run(["clean", "--json"]);
check("control: a command without JSON output still refuses --json as an unknown option", json.status === 1 && /Unknown option '--json'/.test(json.stderr), shown(json));

if (process.platform !== "win32") {
  // The shell enters a folder and removes it, so the CLI starts with a working folder that is gone.
  const fromRemoved = (args: string[]) => {
    const gone = mkdtempSync(join(home, "gone-"));
    // The guard reads the folder's marker, which the shell must find gone, so it goes after the check.
    assertSmokeSandboxDown(recordSmokeSandbox({ root: gone, cotalHome: env.COTAL_HOME, xdgConfigHome: env.XDG_CONFIG_HOME }), args, { cwd: gone, env });
    rmSync(join(gone, ".cotal"), { recursive: true });
    const r = spawnSync("/bin/sh", ["-c", 'cd "$1" && rmdir "$1" && shift && exec "$@"', "sh", gone, process.execPath, BIN, ...args], { cwd: neutral, env, encoding: "utf8", timeout: 120_000 });
    return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  };
  // Two lines and no help: the folder is not a grammar mistake, and the remedy is the whole fix.
  const removedShape = (r: ReturnType<typeof run>) => r.status === 1 && r.stdout === "" && r.stderr === "✗ this folder no longer exists\n  cd to an existing folder and run the command again\n";
  const removed = fromRemoved(["status"]);
  check("a command run from a removed folder says the folder is gone and to cd elsewhere, with no help", removedShape(removed), shown(removed));
  const removedJson = fromRemoved(["status", "--json"]);
  const envelope = removedJson.stdout.startsWith("{") ? JSON.parse(removedJson.stdout) : undefined;
  check("with --json it is a USAGE_INVALID refusal, not an unknown outcome", removedJson.status === 1 && envelope?.outcome === "refused" && envelope.error?.code === "USAGE_INVALID", shown(removedJson));
  const version = fromRemoved(["--version"]);
  check("version still answers from a removed folder", version.status === 0 && /^cotal-ai /.test(version.stdout), shown(version));
  // A command whose own checks read the folder before it runs, such as up's, refuses the same way
  // instead of crashing with Node's stack trace.
  for (const args of [["up"], ["down", "--yes"], ["down", "--dry-run"], ["backup", "create", "bk"]]) {
    const r = fromRemoved(args);
    check(`${args.join(" ")} from a removed folder refuses the same way, with no stack trace`, removedShape(r), shown(r));
  }
  const upJson = fromRemoved(["up", "--json"]);
  const upEnvelope = upJson.stdout.startsWith("{") ? JSON.parse(upJson.stdout) : undefined;
  check("up --json from a removed folder is a USAGE_INVALID refusal", upJson.status === 1 && upEnvelope?.outcome === "refused" && upEnvelope.error?.code === "USAGE_INVALID", shown(upJson));
  const upHelp = fromRemoved(["up", "--help"]);
  check("up --help still answers from a removed folder", upHelp.status === 0 && /cotal up/.test(upHelp.stdout + upHelp.stderr), shown(upHelp));
  // Help said the space or defaults could not be read, and docs and telemetry, which use no folder,
  // refused.
  // `cotal help` leads with the title line; the bare entry screen does not.
  for (const args of [["help"], []]) {
    const r = fromRemoved(args);
    const body = r.stdout.replace(/^cotal - lateral agent coordination over NATS\n\n/, "");
    check(`${["cotal", ...args].join(" ")} from a removed folder says the folder no longer exists, exit 0`,
      r.status === 0 && body.startsWith("This folder no longer exists, so commands that use a space refuse here. cd to an existing folder first.\n") && !/could not be read/.test(r.stdout), shown(r));
  }
  const docs = fromRemoved(["docs", "--json"]);
  check("docs runs from a removed folder", docs.status === 0 && docs.stdout.includes('"outcome":"ok"'), shown(docs));
  const telemetry = fromRemoved(["telemetry", "--json"]);
  check("telemetry runs from a removed folder", telemetry.status === 0 && telemetry.stdout.includes('"outcome":"ok"'), shown(telemetry));
}

// A folder whose `.cotal` is a file, such as a notes file: every command names it and runs nothing.
{
  const notes = mkdtempSync(join(home, "notes-"));
  writeFileSync(join(notes, ".cotal"), "notes\n");
  const at = (args: string[], cwd = notes) => {
    const r = spawnSync(process.execPath, [BIN, ...args], { cwd, env, encoding: "utf8", timeout: 120_000 });
    return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  };
  const named = (r: ReturnType<typeof at>) => r.status === 2 && r.stderr.includes(`${join(notes, ".cotal")} is a file, not a directory, so it cannot hold this folder's Cotal records; the command did not run`) && r.stderr.includes("rename or move that file");
  for (const args of [["status"], ["space", "create", "notes"], ["up"], ["send", "-c", "general", "hi"], ["ps"], ["doctor", "auth"]]) {
    const r = at(args);
    check(`${args.join(" ")} in a folder whose .cotal is a file refuses CONFLICT, exit 2, naming it`, named(r), shown(r));
  }
  const json = at(["status", "--json"]);
  const envelope = json.stdout.startsWith("{") ? JSON.parse(json.stdout) : undefined;
  check("with --json it is one CONFLICT refusal", json.status === 2 && envelope?.outcome === "refused" && envelope.error?.code === "CONFLICT", shown(json));
  const rooted = at(["space", "create", "notes", "--root", notes], neutral);
  check("--root naming that folder refuses the same way", named(rooted), shown(rooted));
  for (const args of [["--version"], ["version"]]) {
    const version = at(args);
    check(`${args[0]} still answers there`, version.status === 0 && /^cotal-ai /.test(version.stdout), shown(version));
  }
  check("the file is left as it was", readFileSync(join(notes, ".cotal"), "utf8") === "notes\n");
}

finish();
process.exit(process.exitCode ?? 0);
