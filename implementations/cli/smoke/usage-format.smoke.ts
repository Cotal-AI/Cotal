/**
 * Every usage error has the one format the docs describe: the error, then any remedy, then the
 * command's help, all on stderr, nothing on stdout, exit 1. A command's own input checks used to
 * print a framed "Request refused … Code: USAGE_INVALID" block with no help; `clean` printed a bare
 * `usage:` line or a lowercase "refusing to clean store without --force"; and `help service nosuch`
 * refused without listing the subcommands. A missing `--yes` is the exception: its refusal and remedy
 * are the whole fix, so it prints without the help. A mistyped word that is near a command, leading
 * flag, subcommand or option names it. A leading flag typed with a typographic dash, as `––json
 * status`, is refused naming the flag with hyphens, as it is after the command word; it was an
 * unknown command. Under `--plain` or a locale without UTF-8, which have no
 * refusal mark, the error is the classified report instead, still followed by the help; it used to
 * print the `✗` mark under `--plain` and the `!` warning mark under such a locale.
 *
 * A folder whose `.cotal` is a file refuses every command with `CONFLICT`, naming that file, before
 * anything runs. A removed working folder refuses every command but help, version, docs and
 * telemetry with its line and the `cd` remedy and no help, as a missing --yes does, `up`, `down` and
 * `backup create` included, which crashed with Node's stack trace. Help there says the folder no
 * longer exists, even when PATH or the pnpm cache contains a relative path.
 *
 * Every command and subcommand `cotal help` lists shows one to three examples, each a whole command
 * with a note on what it does, which parses under the options its help lists. They come right after
 * Usage and Shorthands, before Commands and Options; they used to come last, after the options, as
 * bare command lines, and most commands had none.
 *
 * `cotal <command> --help` prints the same help as `cotal help <command>` for every command and
 * subcommand `cotal help` lists. `manager <verb> --help` showed the service command's summary while
 * `help manager <verb>` listed only --json and --plain under Options, and `ext seed --help` printed
 * the `ext` help.
 *
 * The `persona create` example runs as written against a fresh Cotal home; it lacked the
 * `--subscribe=` a persona body needs. A usage refusal shows the help `--help` prints for the same
 * words, so a refused `persona create` shows its own help; it showed the `persona` help.
 *
 * A usage that declares several forms, one per line, as `linear` does, shows each form on its own
 * lines; help printed them joined by an escaped `\u000a`. A flag a `linear` operation does not take
 * is refused naming it and that operation's flags and usage, without the help: `serve --json` says
 * serve has no --json or --plain output.
 *
 * On an 80-column pty a command wider than the line keeps one line: the exec-endpoint `next:` of
 * `cotal service` and the remedy of its `service add` refusal, which each broke onto a second line.
 * A span in backticks that is no command is one word too: the Next of `daemon install --dry-run`
 * where no user manager answers split `systemctl --user show-environment` after `--user`.
 *
 * A usage whose first group is wider than the line starts that group on the `cotal` line, at 80 and
 * 120 columns: `help daemon` and `help service-endpoint` printed `cotal` alone on the first line.
 *
 * Driven through the built binary in a sandboxed HOME, XDG_CONFIG_HOME and COTAL_HOME, with the
 * built `@cotal-ai/linear` extension imported for its cells. The examples census renders each help
 * in this process from the built surfaces the binary composes, and runs both help forms of each
 * through the binary. Nothing is started or deleted.
 *
 * Run: pnpm smoke:usage-format
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { delimiter, join } from "node:path";
import { pathToFileURL } from "node:url";
import { findCommand, findSubcommand, parseCommandArgs, registry, type Command, type ParsedArgs, type Subcommand } from "@cotal-ai/core";
import { assertSmokeSandboxDown, createSuite, recordSmokeSandbox } from "@cotal-ai/smoke-kit";
import { displayWidth, endpointContractTemplate } from "@cotal-ai/workspace";
import ts from "typescript";
import { clean, nodePty } from "./_console-pty.js";

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
const env = { ...HOST_ENV, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, ".config"), COTAL_HOME: join(home, ".cotal"), COTAL_SKIP_CONNECTOR_SEED: "1", DO_NOT_TRACK: "1", NO_COLOR: "1", LANG: "C.UTF-8" };
const run = (args: string[], extra: Record<string, string> = {}, cwd = neutral) => {
  const r = spawnSync(process.execPath, [BIN, ...args], { cwd, env: { ...env, ...extra }, encoding: "utf8", timeout: 120_000 });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
};
const runShell = (args: string, extra: Record<string, string> = {}, cwd = neutral) =>
  spawnSync("sh", ["-c", `exec "$0" "$1" ${args}`, process.execPath, BIN], { cwd, env: { ...env, ...extra }, encoding: "utf8", timeout: 120_000 });
const shown = (r: ReturnType<typeof run>) => ({ status: r.status, stdout: r.stdout.slice(0, 600), stderr: r.stderr.slice(0, 900) });
const parsed = (r: ReturnType<typeof run>) => { try { return JSON.parse(r.stdout) as { schemaVersion?: number; command?: string; outcome?: string; target?: unknown; result?: { endpoint?: string }; error?: { code?: string; message?: string; remedy?: string } }; } catch { return undefined; } };
const usageShape = (r: ReturnType<typeof run>, message: RegExp) =>
  r.status === 1 && r.stdout === "" && /^✗ /m.test(r.stderr) && message.test(r.stderr) && /Usage/.test(r.stderr) && !/Request refused|Code:/.test(r.stderr);

const parser = run(["status", "--bogus"]);
check("control: a parser usage error has the documented shape", usageShape(parser, /Unknown option '--bogus'/), shown(parser));
const dottedOperand = run(["version", "release.3"]);
check("an unexpected positional keeps the full value in its refusal",
  usageShape(dottedOperand, /^✗ Unexpected argument 'release\.3'\n/m) && dottedOperand.stderr.includes("\ncotal version\n"), shown(dottedOperand));

for (const verb of ["start", "stop", "restart", "status", "logs", "install", "uninstall"]) {
  const extra = run(["manager", verb, "extra", "--json"]);
  const error = parsed(extra)?.error;
  check(`manager ${verb} names the extra operand and its own selectors`, extra.status === 1 && error?.code === "USAGE_INVALID" &&
    error.message === `unexpected argument "extra" for \`cotal manager ${verb}\`` &&
    error.remedy?.includes("remove the extra argument") === true && error.remedy.includes("--space <space> or --instance <full-id>"), shown(extra));
}
const managerExtra = run(["manager", "status", "extra", "--plain"]);
check("a plain manager operand refusal keeps the manager status help", managerExtra.status === 1 &&
  managerExtra.stderr.includes('unexpected argument "extra" for `cotal manager status`') &&
  managerExtra.stderr.includes("Usage\n  cotal manager status") && !managerExtra.stderr.includes("use service"), shown(managerExtra));

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
const spaceTypo = run(["space", "--json", "--unlisted-option"]);
check("an unknown option cannot become the space subcommand", spaceTypo.status === 1 && spaceTypo.stderr === ""
  && JSON.parse(spaceTypo.stdout).error.remedy === "run `cotal help space`", shown(spaceTypo));
for (const args of [
  ["example", "--server", "nats://127.0.0.1:4222", "--mode", "open", "--root", ".", "--force"],
  ["--file", "bundle.json", "example"],
]) {
  const refusal = run(["space", "add", ...args, "--json", "--no-such-option"]);
  const error = parsed(refusal)?.error;
  check(`space add with a name and ${args.includes("--file") ? "--file" : "--server"} tells the caller to drop an unknown option`,
    refusal.status === 1 && refusal.stderr === "" && error?.code === "USAGE_INVALID"
    && error.message === "Unknown option '--no-such-option'" && error.remedy === "drop the unknown option", shown(refusal));
}
const dashValue = run(["history", "--from", "-bob"]);
check("an option value that starts with - is given its --name=value form", usageShape(dashValue, /the value of --from starts with "-"/) && /write it as --from=-bob/.test(dashValue.stderr), shown(dashValue));
if (process.platform !== "win32") {
  for (const query of ["-help usage", "-reviewer's $HOME"]) {
    const refused = run(["docs", "--search", query]);
    const correction = /^  write it as (.+)$/m.exec(refused.stderr)?.[1];
    const copied = correction && runShell(`docs ${correction} --json`);
    check("the printed --search correction keeps the full query in one shell argument",
      usageShape(refused, /the value of --search starts with "-"/) && !!copied && copied.status === 0 && JSON.parse(copied.stdout).result.query === query,
      { refused: shown(refused), copied });
  }
}
const noValue = run(["history", "--limit"]);
check("an option given last with no value is refused naming it and its placeholder", usageShape(noValue, /--limit needs a value/) && /write --limit <n>/.test(noValue.stderr) && !/argument missing/.test(noValue.stderr), shown(noValue));
const flagValue = run(["history", "--limit", "--from", "bob"]);
check("an option followed by another of the command's options is refused as missing its value", usageShape(flagValue, /--limit needs a value/) && /write --limit <n>/.test(flagValue.stderr), shown(flagValue));
const separateJson = run(["config", "get", "harness", "--json", "-Z"]);
const groupedJson = run(["config", "get", "harness", "-jZ"]);
check("an unknown short option after grouped -j gives the same JSON refusal as separate options",
  groupedJson.status === 1 && groupedJson.stderr === "" && groupedJson.stdout === separateJson.stdout
  && JSON.parse(groupedJson.stdout).error.code === "USAGE_INVALID"
  && JSON.parse(groupedJson.stdout).error.message === "Unknown option '-Z'", shown(groupedJson));
const unknownBeforeJson = run(["config", "get", "harness", "-Zj"]);
check("an unknown short option before j does not select JSON", usageShape(unknownBeforeJson, /Unknown option '-Z'/), shown(unknownBeforeJson));
const missingLimit = run(["history", "--json", "--limit", "--from", "abc"]);
for (const [global, operand] of [["--no-input", "abc"], ["--no-color", "1"]] as const) {
  const result = run(["history", "--json", "--limit", global, operand]);
  check(`a ${global} flag cannot move an operand into a missing option value`,
    result.status === 1 && result.stderr === "" && result.stdout === missingLimit.stdout
    && JSON.parse(result.stdout).error.code === "USAGE_INVALID"
    && JSON.parse(result.stdout).error.message === "--limit needs a value"
    && JSON.parse(result.stdout).error.remedy === "write --limit <n>", shown(result));
}
const followGlobal = run(["history", "--json", "--follow", "--limit", "--no-input", "abc"]);
const followRecords = followGlobal.stdout.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
check("a global flag after a missing history follow value preserves the stream refusal and channel",
  followGlobal.status === 1 && followGlobal.stderr === ""
  && followRecords.map((record) => record.type).join() === "error,end"
  && followRecords.every((record) => record.stream === "history" && record.target?.channel === "abc")
  && followRecords[0]?.data?.code === "USAGE_INVALID" && followRecords[0]?.data?.message === "--limit needs a value"
  && followRecords[0]?.data?.remedy === "write --limit <n>" && followRecords[1]?.data?.reason === "setup-failed", shown(followGlobal));
for (const [args, stream] of [[["history", "general"], "history"], [["channel", "members", "general"], "membership"]] as const) {
  for (const [fixed, valid, malformed] of [["--follow", "--json", "--json=false"], ["--json", "--follow", "--follow=false"]]) {
    for (const pair of [[valid, malformed], [malformed, valid]]) {
      const result = run([...args, fixed, ...pair]);
      const records = result.stdout.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
      check(`${args.join(" ")} ${fixed} ${pair.join(" ")} emits a stream usage refusal`,
        result.status === 1 && result.stderr === "" && result.stdout.endsWith("\n")
        && records.map((record) => record.type).join() === "error,end"
        && records.every((record) => record.schemaVersion === 1 && record.stream === stream && record.target?.channel === "general")
        && records[0]?.data?.code === "USAGE_INVALID" && records[1]?.data?.reason === "setup-failed", shown(result));
    }
  }
  for (const suffix of [[], ["--", "--follow"]]) {
    const result = run([...args, "--json", "--follow=false", ...suffix]);
    check(`${args.join(" ")} without a bare follow option emits a finite usage refusal`,
      result.status === 1 && result.stderr === "" && parsed(result)?.outcome === "refused"
      && parsed(result)?.error?.code === "USAGE_INVALID", shown(result));
  }
}
const groupedSpace = run(["config", "get", "harness", "-js", "--no-input", "abc"]);
for (const [args, space] of [[[], null], [["--space", "watch-test"], "watch-test"]] as const) {
  const result = run(["watch", ...args, "--view", "--json"]);
  const records = result.stdout.trim().split("\n").map((line) => JSON.parse(line));
  check("a missing watch view emits a stream refusal and end record",
    result.status === 1 && result.stderr === "" && records.map((record) => record.type).join() === "error,end"
    && records.every((record) => record.stream === "watch" && record.target?.requestedSpace === space)
    && records[0]?.data?.code === "USAGE_INVALID" && records[0]?.data?.message === "--view needs a value"
    && records[0]?.data?.remedy === "write --view <view>" && records[1]?.data?.reason === "setup-failed", shown(result));
}
for (const flags of [["--json", "--json=false"], ["--json=false", "--json"], ["-j", "--json=false"]]) {
  const result = run(["watch", ...flags]);
  const records = result.stdout.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  check(`watch ${flags.join(" ")} emits the usage refusal as a watch stream`,
    result.status === 1 && result.stderr === "" && records.map((record) => record.type).join() === "error,end"
    && records.every((record) => record.schemaVersion === 1 && record.stream === "watch" && record.target?.requestedSpace === null)
    && records[0]?.data?.code === "USAGE_INVALID" && records[0]?.data?.message === "Option '-j, --json' does not take an argument"
    && records[0]?.data?.remedy === "run `cotal help watch`" && records[1]?.data?.reason === "setup-failed", shown(result));
}
for (const flags of [["--json=false"], ["--json=false", "--", "--json"]]) {
  const result = run(["watch", ...flags]);
  check(`watch ${flags.join(" ")} does not select JSON`, usageShape(result, /does not take an argument/), shown(result));
}
check("a global flag cannot hide a missing value at the end of a short option group",
  groupedSpace.status === 1 && groupedSpace.stderr === "" && JSON.parse(groupedSpace.stdout).error.message === "--space needs a value", shown(groupedSpace));
for (const global of ["--no-input", "--no-color"]) {
  const args = [global, "config", "get", "harness", "--space", global];
  const text = run(args);
  const json = run([...args, "--json"]);
  const complete = run([global, "config", "get", "harness", "--space", "demo", global, "--json"]);
  check(`a repeated ${global} in the value slot reports the missing value in text and JSON`,
    usageShape(text, /--space needs a value/) && text.stderr.includes("write --space <name>")
    && json.status === 1 && json.stderr === "" && JSON.parse(json.stdout).error.code === "USAGE_INVALID"
    && JSON.parse(json.stdout).error.message === "--space needs a value" && JSON.parse(json.stdout).error.remedy === "write --space <name>",
    { text: shown(text), json: shown(json) });
  check(`a repeated ${global} with the value supplied still refuses the duplicate`, complete.status === 1 && complete.stderr === ""
    && JSON.parse(complete.stdout).error.message === `Option '${global}' cannot be repeated`, shown(complete));
}
const completeValue = run(["docs", "--json", "--search", "usage", "--no-input"]);
check("a global flag after a supplied value is accepted", completeValue.status === 0 && completeValue.stderr === ""
  && JSON.parse(completeValue.stdout).result.query === "usage", shown(completeValue));
const groupedServer = run(["status", "--server", "-jv"]);
const separateServer = run(["status", "--server", "-j", "-v"]);
const groupedError = JSON.parse(groupedServer.stdout).error;
check("a short option group after --server gets the same missing-value refusal as separate options",
  groupedServer.status === 1 && separateServer.status === 1 && groupedServer.stderr === "" && separateServer.stderr === ""
  && groupedServer.stdout === separateServer.stdout && groupedError.code === "USAGE_INVALID"
  && groupedError.message === "--server needs a value" && groupedError.remedy === "write --server <url>", shown(groupedServer));
const separatorValue = run(["history", "--json", "--limit", "--", "general"]);
const separatorError = JSON.parse(separatorValue.stdout).error;
check("an option followed by the separator asks for its value before the separator", separatorValue.status === 1 && separatorValue.stderr === ""
  && separatorError.code === "USAGE_INVALID" && separatorError.message === "--limit needs a value"
  && separatorError.remedy === "write --limit <n> before --", shown(separatorValue));
for (const args of [["--search", "-1"], ["--search=-1"], ["--search", "first"]]) {
  const repeated = run(["docs", "--json", ...args, "--search", "--"]);
  const error = JSON.parse(repeated.stdout).error;
  check(`a second --search with no value after ${args.join(" ")} asks to use --search once`, repeated.status === 1 && repeated.stderr === ""
    && error.code === "USAGE_INVALID" && error.message === "--search cannot be repeated" && error.remedy === "use --search once", shown(repeated));
}
const numericQuery = run(["docs", "--json", "--search", "-1"]);
check("one search accepts a dash and digit without an equals sign", numericQuery.status === 0 && numericQuery.stderr === ""
  && JSON.parse(numericQuery.stdout).result.query === "-1", shown(numericQuery));
const noHitQuery = "zzq-cotal-help-probe-nohit";
const searchTypo = run(["docs", "--json", "--serch", noHitQuery]);
const searchError = JSON.parse(searchTypo.stdout).error;
const searchCorrection = /^use (--[\w-]+)$/.exec(searchError.remedy)?.[1];
const searchRetry = searchCorrection && run(["docs", "--json", searchCorrection, noHitQuery]);
check("a typo in --search names a replacement option that searches for the same query",
  searchTypo.status === 1 && searchTypo.stderr === "" && searchError.code === "USAGE_INVALID"
  && searchError.message === "Unknown option '--serch' - did you mean --search?" && searchCorrection === "--search"
  && !!searchRetry && searchRetry.status === 0 && searchRetry.stderr === ""
  && JSON.parse(searchRetry.stdout).result.kind === "docs-search" && JSON.parse(searchRetry.stdout).result.query === noHitQuery,
  { refused: shown(searchTypo), retry: searchRetry && shown(searchRetry) });
for (const args of [["--search", noHitQuery], [`--search=${noHitQuery}`]]) {
  const refused = run(["docs", "--json", ...args, "--serch", "other"]);
  const error = JSON.parse(refused.stdout).error;
  const retry = run(["docs", "--json", ...args]);
  check(`a typo after ${args.join(" ")} asks to drop the extra option and its value`,
    refused.status === 1 && refused.stderr === "" && error.code === "USAGE_INVALID"
    && error.message === "Unknown option '--serch'" && error.remedy === "drop the unknown option and its value, if any; --search is already set"
    && retry.status === 0 && retry.stderr === "" && JSON.parse(retry.stdout).result.query === noHitQuery,
    { refused: shown(refused), retry: shown(retry) });
}
const shortEquals = run(["send", "-c=general", "hello"]);
check("-c=value is refused naming the value it would give", usageShape(shortEquals, /-c=general gives -c the value "=general"/) && /write -c general or --channel=general/.test(shortEquals.stderr), shown(shortEquals));
for (const typed of ["\u2014json", "\u2212\u2212json", "\u2013json"]) {
  const r = run(["status", typed]);
  check(`${typed} is refused as a typographic dash, naming --json`, usageShape(r, /starts with a typographic dash/) && /type the option with hyphens: --json/.test(r.stderr), shown(r));
}
for (const [sub, words] of [["root", ["root", "\u2013json"]], ["add", ["\u2212j", "add"]]] as const) {
  const refused = run(["ext", ...words]);
  check(`ext ${sub} does not suggest a listing flag`, usageShape(refused, /starts with a typographic dash/)
    && refused.stderr.includes(`omit this option; \`cotal ext ${sub}\` does not take --json`)
    && !refused.stderr.includes("type the option with hyphens"), shown(refused));
}
const listSpelling = run(["ext", "list", "\u2212j"]);
const listFlag = /^  type the option with hyphens: (-j)$/m.exec(listSpelling.stderr)?.[1];
const inventory = listFlag && run(["ext", "list", listFlag]);
check("the suggested short listing flag returns the inventory", listSpelling.status === 1 && !!inventory
  && inventory.status === 0 && Array.isArray(JSON.parse(inventory.stdout).result.items), { refused: shown(listSpelling), retry: inventory && shown(inventory) });
const shortHelp = run(["send", "-c", "general", "\u2013h"]);
check("a typographic short help flag is refused with -h", usageShape(shortHelp, /starts with a typographic dash/)
  && shortHelp.stderr.includes("type the option with hyphens: -h"), shown(shortHelp));
const helpValue = run(["docs", "--search", "\u2014help", "--json"]);
check("typographic help used as an option value stays literal", helpValue.status === 0 && helpValue.stderr === ""
  && JSON.parse(helpValue.stdout).result.query === "\u2014help", shown(helpValue));
const historyTypo = run(["history", "\u2013\u2013limit=10", "--json"]);
check("the typographic history option correction retains the attached limit", historyTypo.status === 1 && historyTypo.stderr === ""
  && JSON.parse(historyTypo.stdout).error.remedy === "type the option with hyphens: --limit=10", shown(historyTypo));
if (process.platform !== "win32") {
  const query = "reviewer's $HOME = usage";
  const refused = run(["docs", `\u2013\u2013search=${query}`]);
  const correction = /^  type the option with hyphens: (.+)$/m.exec(refused.stderr)?.[1];
  const copied = correction && runShell(`docs ${correction} --json`);
  check("the typographic option correction quotes the attached value for the shell",
    usageShape(refused, /starts with a typographic dash/) && !!copied && copied.status === 0 && JSON.parse(copied.stdout).result.query === query,
    { refused: shown(refused), copied });
}
// Before the command word the same word was an unknown command: `––json status` got no suggestion
// and `−−version` was offered the version command.
for (const [args, flag] of [
  [["\u2013\u2013json", "status"], "--json"],
  [["\u2212\u2212version"], "--version"],
  [["\u2013\u2013plain", "status"], "--plain"],
  [["\u2013no-input", "status"], "--no-input"],
  [["\u2014json", "status"], "--json"],
  [["\u2013j", "version"], "-j"],
  [["\u2013h"], "-h"],
  [["\u2013V"], "-V"],
] as const) {
  const r = run([...args]);
  check(`${args.join(" ")} is refused as a typographic dash before the command word, naming ${flag}`, r.status === 1 && r.stdout === ""
    && r.stderr.startsWith(`✗ ${args[0]} starts with a typographic dash, so it is not an option\n  type the option with hyphens: ${flag}\n`) && !/unknown command|did you mean/.test(r.stderr), shown(r));
}
const leadingBogus = run(["\u2013\u2013bogus", "status"]);
check("control: a leading typographic-dash word that names no leading flag is an unknown command", leadingBogus.status === 1
  && leadingBogus.stderr.startsWith("✗ unknown command: \u2013\u2013bogus - run `cotal help` to list commands"), shown(leadingBogus));

const missing = run(["space", "create"]);
check("a missing argument a command checks has the same shape", usageShape(missing, /space create/), shown(missing));

if (process.platform !== "win32") {
  const cwd = realpathSync(neutral);
  const parent = "reviewer's $draft/nested";
  const dir = `${parent}/reviews`;
  const scaffold = run(["endpoint", "init", "com.example.reviews", "--dir", dir, "--json"], {}, cwd);
  const receipt = JSON.parse(scaffold.stdout);
  const directories = ["reviewer's $draft", parent, dir].map((path) => join(cwd, path));
  const files = ["contract.json", "handler.mjs"].map((name) => join(cwd, dir, name));
  const expected = [...directories.map((path) => ({ path, kind: "directory", complete: true })), ...files.map((path) => ({ path, kind: "file", complete: true }))];
  check("endpoint init creates and reports all missing directories privately in one invocation",
    scaffold.status === 0 && scaffold.stderr === "" && receipt.command === "endpoint init"
    && JSON.stringify(receipt.result?.changed) === JSON.stringify(expected)
    && directories.every((path) => (statSync(path).mode & 0o777) === 0o700)
    && files.every((path, index) => (statSync(path).mode & 0o777) === (index === 0 ? 0o600 : 0o700)), shown(scaffold));

  const original = files.map((path) => readFileSync(path));
  const checkArgs = ["endpoint", "check", join(dir, "contract.json")];
  const pastedFile = "\u2013\u2013file=example.json";
  const pastedCheck = run([...checkArgs, pastedFile], {}, cwd);
  const checkRetry = run(checkArgs, {}, cwd);
  check("endpoint check tells the caller to omit a pasted reference option and the retry works",
    usageShape(pastedCheck, /starts with a typographic dash/) && ["cotal", "pnpm cotal"].some((cli) =>
      pastedCheck.stderr.includes(`omit this option; \`${cli} endpoint check\` does not take --file`))
    && !pastedCheck.stderr.includes("type the option with hyphens")
    && checkRetry.status === 0 && checkRetry.stderr === "" && checkRetry.stdout.includes("Endpoint contract valid locally")
    && files.every((path, index) => readFileSync(path).equals(original[index]!)), [pastedCheck, checkRetry].map(shown));
  const pastedAdd = run(["endpoint", "add", pastedFile], {}, cwd);
  check("endpoint add still suggests the hyphenated spelling for its reference option",
    usageShape(pastedAdd, /starts with a typographic dash/) && pastedAdd.stderr.includes("type the option with hyphens: --file=example.json"), shown(pastedAdd));

  const conflictArgs = ["endpoint", "init", "different", "--dir", dir];
  const conflict = run([...conflictArgs, "--json"], {}, cwd);
  const plainConflict = run([...conflictArgs, "--plain"], {}, cwd);
  const rejected = JSON.parse(conflict.stdout);
  const copyDir = `${parent}/reviews-copy`;
  const retry = /cotal (endpoint init different --dir <new-directory>(?: --json)?)/.exec(rejected.error?.remedy ?? "");
  if (!retry) throw new Error("endpoint init conflict omitted the alternate-directory command");
  const copy = run(retry[1]!.split(" ").map((word) => word === "<new-directory>" ? copyDir : word), {}, cwd);
  const checked = run(["endpoint", "check", join(copyDir, "contract.json"), "--plain"], {}, cwd);
  check("endpoint init preserves scaffold files and names the alternate destination remedy in JSON and plain output",
    conflict.status === 2 && conflict.stderr === "" && rejected.command === "endpoint init" && rejected.outcome === "refused"
    && rejected.error?.code === "CONFLICT" && rejected.target?.path === files[0]
    && retry?.[1]?.endsWith(" --json") && plainConflict.status === 2
    && plainConflict.stderr.includes("cotal endpoint init different --dir <new-directory> --plain")
    && files.every((path, index) => readFileSync(path).equals(original[index]!))
    && copy.status === 0 && JSON.parse(copy.stdout).result?.endpoint === "com.example.different" && checked.status === 0,
    [conflict, plainConflict, copy, checked].map(shown));

  symlinkSync(directories[0]!, join(cwd, dir, "linked-parent"), "dir");
  for (const blocked of [`${dir}/linked-parent`, `${dir}/contract.json`]) {
    const args = ["endpoint", "init", "scratch", "--dir", `${blocked}/missing/scratch`];
    const rejected = run([...args, "--json"], {}, cwd);
    const plain = run([...args, "--plain"], {}, cwd);
    const { target, error } = JSON.parse(rejected.stdout);
    check("endpoint init names a blocked parent and advises using a real directory",
      rejected.status === 2 && rejected.stderr === "" && error?.code === "PERMISSION_DENIED" && target?.path === join(cwd, blocked)
      && /real directory path/.test(error.remedy) && plain.status === 2 && plain.stdout === ""
      && plain.stderr.includes(join(cwd, blocked).replace(/'/g, `'\\''`)) && plain.stderr.includes("Next") && plain.stderr.includes(error.remedy)
      && !existsSync(join(directories[0]!, "missing")), { json: shown(rejected), plain: shown(plain) });
  }
  const physical = run(["endpoint", "init", "scratch", "--dir", join(directories[0]!, "missing/scratch"), "--json"], {}, cwd);
  check("endpoint init succeeds with a real directory instead of the symlink", physical.status === 0
    && existsSync(join(directories[0]!, "missing/scratch/contract.json")), shown(physical));

  const partial = run(["endpoint", "init", "scratch", "--dir", `partial-parent/${"x".repeat(256)}/scratch`, "--json"], {}, cwd);
  const partialReceipt = JSON.parse(partial.stdout);
  check("endpoint init reports directories created before a component exceeds the filename limit", partial.status === 4
    && partialReceipt.error?.code === "OPERATION_PARTIAL" && JSON.stringify(partialReceipt.changed) === JSON.stringify([{ path: join(cwd, "partial-parent"), kind: "directory", complete: true }])
    && (statSync(join(cwd, "partial-parent")).mode & 0o777) === 0o700, shown(partial));

  const directoryArgs = ["endpoint", "check", dir];
  const directoryText = [run(directoryArgs, {}, cwd), run([...directoryArgs, "--plain"], {}, cwd)];
  const directoryJson = run([...directoryArgs, "--json"], {}, cwd);
  const refusal = parsed(directoryJson);
  const quotedDir = join(cwd, dir).replace(/'/g, `'\\''`);
  const message = `\`'${quotedDir}'\` is a directory. Pass an endpoint contract file.`;
  const remedy = `cotal endpoint check '${quotedDir}/contract.json'`;
  const jsonRemedy = `${remedy} --json`;
  const retried = refusal?.error?.remedy === jsonRemedy ? runShell(refusal.error.remedy.slice("cotal ".length), {}, cwd) : undefined;
  const retryReceipt = retried && parsed(retried);
  check("endpoint check names its scaffold directory and prints a working contract-file command in each format",
    directoryJson.status === 1 && directoryJson.stderr === "" && refusal?.command === "endpoint check" && refusal.outcome === "refused" && refusal.error?.code === "SCHEMA_INVALID"
    && (refusal.target as { path?: string } | undefined)?.path === join(cwd, dir)
    && refusal.error.message === message
    && directoryText.every((r, index) => {
      const next = index === 0 ? remedy : `${remedy} --plain`;
      return r.status === 1 && r.stdout === "" && r.stderr.includes(message)
        && [next, `pnpm ${next}`].some((command) => r.stderr.includes(`Next\n  ${command}\n`));
    })
    && retried?.status === 0 && retried.stderr === "" && retryReceipt?.schemaVersion === 1
    && retryReceipt.command === "endpoint check" && retryReceipt.outcome === "ok" && retryReceipt.result?.endpoint === "com.example.reviews"
    && files.every((path, index) => readFileSync(path).equals(original[index]!)),
    { text: directoryText.map(shown), json: shown(directoryJson), retried: retried && shown(retried) });

  const escaped = "notes \u2708\ufe0f";
  const escapedPath = join(cwd, escaped);
  const escapedInit = run(["endpoint", "init", "notes", "--dir", escaped, "--plain"], {}, cwd);
  const escapedArgs = ["endpoint", "check", escaped];
  const escapedText = [run(escapedArgs, {}, cwd), run([...escapedArgs, "--plain"], {}, cwd)];
  const escapedJson = run([...escapedArgs, "--json"], {}, cwd);
  const escapedRefusal = parsed(escapedJson);
  const recovery = /^  Use shell completion to enter the scaffold directory, then run `(?:pnpm )?cotal (endpoint check contract\.json(?: --plain)?)`\.$/m;
  const exact = `cotal endpoint check '${escapedPath.replace(/'/g, `'\\''`)}/contract.json' --json`;
  const exactRetry = escapedRefusal?.error?.remedy === exact ? runShell(escapedRefusal.error.remedy.slice("cotal ".length), {}, cwd) : undefined;
  const exactReceipt = exactRetry && parsed(exactRetry);
  const localRetry = run(["endpoint", "check", "contract.json"], {}, escapedPath);
  check("endpoint authoring does not print a broken terminal command for a path that is escaped in display",
    escapedInit.status === 0 && recovery.exec(escapedInit.stdout)?.[1] === "endpoint check contract.json" && !escapedInit.stdout.includes("\ufe0f")
    && escapedText.every((r, index) => r.status === 1 && r.stdout === "" && r.stderr.includes("\\ufe0f") && !r.stderr.includes("\ufe0f")
      && recovery.exec(r.stderr)?.[1] === (index === 0 ? "endpoint check contract.json" : "endpoint check contract.json --plain") && !r.stderr.includes("/contract.json'"))
    && localRetry.status === 0 && localRetry.stdout.includes("Endpoint contract valid locally"),
    { init: shown(escapedInit), text: escapedText.map(shown), localRetry: shown(localRetry) });
  check("endpoint check JSON retains a working command with the exact Unicode path",
    escapedJson.status === 1 && escapedJson.stderr === "" && escapedRefusal?.error?.code === "SCHEMA_INVALID"
    && (escapedRefusal.target as { path?: string } | undefined)?.path === escapedPath
    && exactRetry?.status === 0 && exactRetry.stderr === "" && exactReceipt?.command === "endpoint check"
    && exactReceipt.outcome === "ok" && exactReceipt.result?.endpoint === "com.example.notes",
    { json: shown(escapedJson), exactRetry: exactRetry && shown(exactRetry) });

  const backslashes = String.raw`review\\draft`;
  const intended = run(["endpoint", "init", "intended", "--dir", backslashes, "--plain"], {}, cwd);
  const neighbor = run(["endpoint", "init", "neighbor", "--dir", String.raw`review\draft`, "--plain"], {}, cwd);
  const backslashCheck = run(["endpoint", "check", backslashes, "--plain"], {}, cwd);
  const backslashJson = run(["endpoint", "check", backslashes, "--json"], {}, cwd);
  const copied = recovery.exec(backslashCheck.stderr)?.[1];
  const backslashRetry = copied && runShell(copied, {}, join(cwd, backslashes));
  const jsonRecovery = /`cotal (endpoint check contract\.json --json)`\.$/.exec(parsed(backslashJson)?.error?.remedy ?? "")?.[1];
  const backslashJsonRetry = jsonRecovery && runShell(jsonRecovery, {}, join(cwd, backslashes));
  const backslashReceipt = backslashJsonRetry && parsed(backslashJsonRetry);
  check("endpoint authoring offers a relative recovery that selects the intended backslash path",
    intended.status === 0 && neighbor.status === 0 && recovery.test(intended.stdout)
    && backslashCheck.status === 1 && backslashCheck.stderr.includes("SCHEMA_INVALID")
    && backslashJson.status === 1 && backslashJson.stderr === "" && parsed(backslashJson)?.error?.code === "SCHEMA_INVALID"
    && copied === "endpoint check contract.json --plain"
    && !!backslashRetry && backslashRetry.status === 0 && backslashRetry.stderr === ""
    && backslashRetry.stdout.includes("com.example.intended") && !backslashRetry.stdout.includes("com.example.neighbor")
    && !!backslashJsonRetry && backslashJsonRetry.status === 0 && backslashJsonRetry.stderr === ""
    && !!backslashReceipt && backslashReceipt.outcome === "ok" && backslashReceipt.result?.endpoint === "com.example.intended",
    { init: shown(intended), check: shown(backslashCheck), json: shown(backslashJson), retry: backslashRetry && shown(backslashRetry), jsonRetry: backslashJsonRetry && shown(backslashJsonRetry) });

  const other = join(cwd, "other-contracts");
  mkdirSync(other);
  writeFileSync(join(other, "custom.json"), original[0]!);
  symlinkSync(files[0]!, join(other, "contract.json"));
  const unrelated = run(["endpoint", "check", other, "--json"], {}, cwd);
  const unrelatedRefusal = parsed(unrelated);
  check("endpoint check neither picks another JSON file nor suggests a symlink as the contract",
    unrelated.status === 1 && unrelated.stderr === "" && unrelatedRefusal?.error?.code === "SCHEMA_INVALID"
    && (unrelatedRefusal.target as { path?: string } | undefined)?.path === other
    && unrelatedRefusal.error.message?.includes("is a directory. Pass an endpoint contract file.") === true
    && unrelatedRefusal.error.remedy === "retry with the path to an existing endpoint contract file", shown(unrelated));

  const authoring = run(["endpoint", "init", "reviews"], {}, cwd);
  const wrong = "reviews/wrong.json";
  const path = join(cwd, wrong);
  const text = [run(["endpoint", "check", wrong, "--plain"]), run(["endpoint", "check", wrong])];
  const json = run(["endpoint", "check", wrong, "--json"]);
  const envelope = JSON.parse(json.stdout);
  const corrected = run(["endpoint", "check", "reviews/contract.json", "--json"]);
  const checkedReceipt = parsed(corrected);
  check("endpoint check names the missing file and asks for an existing contract in every format",
    authoring.status === 0 && json.status === 2 && json.stderr === "" && envelope.target.path === path
    && envelope.command === "endpoint check" && envelope.outcome === "refused"
    && envelope.error.code === "TARGET_NOT_FOUND" && /existing endpoint contract file/.test(envelope.error.remedy)
    && text.every((r) => r.status === 2 && r.stdout === "" && r.stderr.includes(path) && r.stderr.includes(envelope.error.remedy))
    && corrected.status === 0 && corrected.stderr === "" && checkedReceipt?.command === "endpoint check" && checkedReceipt.outcome === "ok",
    { text: text.map(shown), json: shown(json), corrected: shown(corrected) });

  writeFileSync(join(cwd, "malformed.json"), "{invalid json\n");
  const malformed = run(["endpoint", "check", "malformed.json", "--json"], {}, cwd);
  const malformedReceipt = parsed(malformed);
  check("endpoint check names the operation on a malformed contract refusal",
    malformed.status === 1 && malformed.stderr === "" && malformedReceipt?.command === "endpoint check"
    && malformedReceipt.outcome === "refused" && malformedReceipt.error?.code === "SCHEMA_INVALID", shown(malformed));

  const unknown = run(["ep", "check", "reviews/contract.json", "--json", "--no-such-option"], {}, cwd);
  check("endpoint check with a contract already supplied tells the caller to drop the unknown option",
    unknown.status === 1 && parsed(unknown)?.error?.remedy === "drop the unknown option"
    && corrected.status === 0, { refusal: shown(unknown), retry: shown(corrected) });
  const dashContract = "--no-such-option";
  writeFileSync(join(cwd, dashContract), readFileSync(join(cwd, "reviews/contract.json")));
  const unfilled = run(["endpoint", "check", "--json", dashContract], {}, cwd);
  const afterSeparator = run(["endpoint", "check", "--json", "--", dashContract], {}, cwd);
  check("endpoint check still suggests the separator when the contract operand is missing",
    unfilled.status === 1 && parsed(unfilled)?.error?.remedy?.includes("put -- before it") === true && afterSeparator.status === 0,
    { refusal: shown(unfilled), retry: shown(afterSeparator) });
} else {
  const dir = join(realpathSync(neutral), "reviewer's copy");
  mkdirSync(dir);
  writeFileSync(join(dir, "contract.json"), JSON.stringify(endpointContractTemplate("reviews")));
  const args = ["endpoint", "check", dir];
  const text = [run(args), run([...args, "--plain"])];
  const json = run([...args, "--json"]);
  const refusal = parsed(json);
  const remedy = (flag = "") => `Use shell completion to enter the scaffold directory, then run \`cotal endpoint check contract.json${flag}\`.`;
  const retryArgs = /`cotal (endpoint check contract\.json --json)`\.$/.exec(refusal?.error?.remedy ?? "")?.[1];
  const retry = retryArgs ? run(retryArgs.split(" "), {}, dir) : undefined;
  check("Windows endpoint check keeps the output mode in its relative recovery",
    json.status === 1 && json.stderr === "" && refusal?.error?.code === "SCHEMA_INVALID" && refusal.error.remedy === remedy(" --json")
    && (refusal.target as { path?: string } | undefined)?.path === dir
    && text.every((r, index) => {
      const next = remedy(index === 0 ? "" : " --plain");
      return r.status === 1 && r.stdout === "" && [next, next.replace("`cotal ", "`pnpm cotal ")].some((msg) => r.stderr.includes(`Next\n  ${msg}\n`));
    })
    && retry?.status === 0 && retry.stderr === "" && JSON.parse(retry.stdout).result?.file === join(dir, "contract.json"),
    { text: text.map(shown), json: shown(json), retry: retry && shown(retry) });
}

const referenceProject = join(home, "endpoint-reference");
mkdirSync(referenceProject);
const addReference = (path: string) => run(["endpoint", "add", "example", "--file", path, "--space", "usage-examples", "--json"], {}, referenceProject);
const beforePreparation = addReference("");
const prepared = run(["space", "create", "usage-examples", "--root", referenceProject, "--json"], {}, referenceProject);
const afterPreparation = addReference("");
for (const r of [beforePreparation, afterPreparation]) {
  const envelope = JSON.parse(r.stdout);
  check("endpoint add rejects empty --file before resolving the space or path", r.status === 1 && r.stderr === ""
    && envelope.target === null && envelope.error?.code === "USAGE_INVALID" && envelope.error.message === "--file is empty"
    && /reference JSON file/.test(envelope.error.remedy), shown(r));
}
const reference = { schemaVersion: 1, space: "usage-examples", endpoint: "com.example.reviews" };
writeFileSync(join(referenceProject, "reference.json"), JSON.stringify(reference), { mode: 0o600 });
const added = addReference("reference.json");
check("endpoint add saves the reference after retrying with a file path", prepared.status === 0 && added.status === 0
  && JSON.parse(added.stdout).result?.reference?.endpoint === reference.endpoint, { prepared: shown(prepared), added: shown(added) });

const conflict = run(["up", "--foreground", "--detach"]);
check("two conflicting flags have the same shape", usageShape(conflict, /--foreground or --detach/), shown(conflict));

const noTarget = run(["clean"]);
check("clean with no target has the same shape and names the targets", usageShape(noTarget, /clean needs a target: history, store, all/), shown(noTarget));

const noForce = run(["clean", "store"]);
check("clean store without --force has the same shape, with the remedy on its own line", usageShape(noForce, /requires --force/) && /cotal clean store --force/.test(noForce.stderr), shown(noForce));

// The command that refusal prints keeps every flag that picks what is deleted. Without --store-dir,
// following it deleted the default store and left the one the user named (#7517).
for (const [args, remedy] of [
  [["clean", "store", "--store-dir", "custom"], "cotal clean store --store-dir custom --force"],
  [["clean", "all", "--store-dir", "my store"], "cotal clean all --store-dir 'my store' --force"],
  [["clean", "history", "--space", "s1", "--dms"], "cotal clean history --space s1 --dms --force"],
  [["clean", "history", "--server", "nats://127.0.0.1:4999", "--creds", "/tmp/a b.creds"], "cotal clean history --server nats://127.0.0.1:4999 --creds '/tmp/a b.creds' --force"],
] as const) {
  const r = run([...args]);
  check(`${args.join(" ")} without --force prints a command that keeps its target`, usageShape(r, /requires --force/) && r.stderr.includes(`\n  ${remedy}\n`), shown(r));
}
const twoStores = join(home, "two-stores");
mkdirSync(join(twoStores, ".cotal", "nats", "jetstream"), { recursive: true });
mkdirSync(join(twoStores, "custom", "jetstream"), { recursive: true });
const asked = run(["clean", "store", "--store-dir", "custom"], {}, twoStores);
const printed = /\n {2}cotal (clean store [^\n]*--force)\n/.exec(asked.stderr)?.[1].split(" ") ?? [];
const followed = run(printed, {}, twoStores);
check("following that printed command removes the store that was named and leaves the default store",
  followed.status === 0 && !existsSync(join(twoStores, "custom", "jetstream")) && existsSync(join(twoStores, ".cotal", "nats", "jetstream")),
  { printed, followed: shown(followed) });

const helpPath = run(["help", "service", "nosuch"]);
check("help with an unknown subcommand names it and lists the command's subcommands", usageShape(helpPath, /cotal service has no subcommand "nosuch"/) && /\bstart\b/.test(helpPath.stderr) && /\bstop\b/.test(helpPath.stderr), shown(helpPath));

const explicitStatus = run(["help", "service", "status", "manager"]);
const flagStatus = run(["service", "status", "manager", "--help"]);
check("both help forms show service status usage with a service name",
  explicitStatus.status === 0 && flagStatus.status === 0 && explicitStatus.stderr === "" && flagStatus.stderr === ""
  && explicitStatus.stdout === flagStatus.stdout && /^  cotal service status <name>/m.test(explicitStatus.stdout),
  { explicit: shown(explicitStatus), flag: shown(flagStatus) });
const misspelledStatus = run(["help", "service", "sttaus", "manager"]);
check("explicit help still refuses a misspelled service subcommand before its operand",
  usageShape(misspelledStatus, /cotal service has no subcommand "sttaus" - did you mean status\?/), shown(misspelledStatus));

for (const [command, word, title] of [
  ["docs", "cli", "cotal docs"],
  ["history", "general", "cotal history"],
  ["h", "general", "cotal history"],
  ["history", "clear", "cotal history clear"],
  ["history", "limit", "cotal history limit"],
] as const) {
  const explicit = run(["help", command, word]);
  const flag = run([command, word, "--help"]);
  check(`both help forms for ${command} ${word} show ${title}`,
    explicit.status === 0 && flag.status === 0 && explicit.stderr === "" && flag.stderr === ""
    && explicit.stdout === flag.stdout && explicit.stdout.startsWith(`${title}\n`),
    { explicit: shown(explicit), flag: shown(flag) });
}

const subcommand = run(["service", "frob"]);
check("control: the parser's unknown subcommand has the same words", usageShape(subcommand, /cotal service has no subcommand "frob"/), shown(subcommand));

// --help after a word that names no subcommand refuses as `cotal help` does, with the nearest one.
// After a real subcommand or a leaf's argument it prints the help.
for (const args of [["space", "nosuch", "--help"], ["persona", "nosuch", "--help"], ["config", "nosuch", "--help"], ["channel", "nosuch", "--help"], ["team", "nosuch", "-h"]] as const) {
  const r = run([...args]);
  check(`${args.join(" ")} refuses the unknown subcommand`, usageShape(r, new RegExp(`cotal ${args[0]} has no subcommand "nosuch"`)), shown(r));
}
const nearHelp = run(["space", "creat", "--help"]);
check("space creat --help names the nearest subcommand", usageShape(nearHelp, /cotal space has no subcommand "creat" - did you mean create\?/), shown(nearHelp));
for (const args of [["space", "create", "--help"], ["team", "show", "anything", "--help"]] as const) {
  const r = run([...args]);
  check(`control: ${args.join(" ")} prints its help`, r.status === 0 && /Usage/.test(r.stdout), shown(r));
}

const createHelp = run(["space", "create", "--help"]);
check("space create help documents adopt in usage and options", createHelp.status === 0 && /Usage\n[^\n]*\[--adopt\]/.test(createHelp.stdout) && /--adopt\s+create: take over the stack journal a copied or moved project folder holds/.test(createHelp.stdout), shown(createHelp));

const modelsHelp = run(["models", "--help"]);
const modelsHelpText = modelsHelp.stdout.replace(/\s+/g, " ");
check("models help explains the registration requirement without offering --creds",
  modelsHelp.status === 0 && modelsHelpText.includes("Authenticated meshes must be registered.")
  && modelsHelpText.includes("Raw credential files are not accepted.")
  && /--space <s>/.test(modelsHelp.stdout) && /--server <url>/.test(modelsHelp.stdout)
  && !/--creds/.test(modelsHelp.stdout), shown(modelsHelp));

const psHelp = run(["ps", "--help"]);
check("ps help shows the supported target selectors without offering --creds",
  psHelp.status === 0 && /--space <s>/.test(psHelp.stdout) && /--server <url>/.test(psHelp.stdout)
  && !/--creds/.test(psHelp.stdout), shown(psHelp));
const psCreds = run(["ps", "--plain", "--server", "nats://127.0.0.1:37943", "--creds", join(neutral, "not-created")]);
check("ps refuses a raw credential file and points to the project folder or registered space",
  psCreds.status === 2 && /Code:\s+UNSUPPORTED/.test(psCreds.stderr)
  && psCreds.stderr.includes("run the command again without --creds: in the mesh's project folder, or with --space naming its registry entry"), shown(psCreds));

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

// On an 80-column terminal a command wider than the line keeps one line: the exec-endpoint `next:`
// of `cotal service` broke before `--handler <file>`, and the remedy of its `service add` refusal
// before `<file>`, in the refusal line and under `--plain` in its Next.
{
  const root = join(home, "wide-next");
  mkdirSync(root, { mode: 0o700 });
  const created = run(["space", "create", "widenext", "--root", root]);
  const at80 = async (args: string[], ptyEnv: Record<string, string> = env as Record<string, string>): Promise<string[]> => {
    let out = "";
    const pty = nodePty([BIN, ...args], { cwd: neutral, env: ptyEnv, cols: 80, rows: 200 });
    pty.onData((data) => { out += data; });
    await new Promise<void>((resolve) => pty.onExit(() => resolve()));
    return clean(out).split(/\r?\n/);
  };
  const command = "cotal service add <name> --preset exec-endpoint --contract <file> --handler <file>";
  // The list was given --space, so its next: names it too (#7642).
  const listedCommand = `${command} --space widenext`;
  const listed = await at80(["service", "--space", "widenext"]);
  check(`cotal service on 80 columns keeps the ${listedCommand.length}-column exec-endpoint next: command on one line`, created.status === 0 && listed.some((line) => line.trim() === listedCommand), { created: shown(created), listed });
  // With the broker URL already registered, this complete retry fits with its explicit space.
  const shortRoot = join(home, "short-next");
  mkdirSync(shortRoot, { mode: 0o700 });
  const registered = run(["space", "add", "w", "--root", shortRoot, "--mode", "open", "--server", "nats://127.0.0.1:4222", "--force", "--yes", "--json"]);
  const shortCommand = "cotal service add b --preset broker --config <file> --binary <file> --space w";
  for (const flags of [[], ["--plain"]]) {
    const refused = await at80(["service", "add", "myep", "--preset", "exec-endpoint", "--space", "widenext", ...flags]);
    const short = await at80(["service", "add", "b", "--preset", "broker", "--space", "w", ...flags]);
    check(`the service add refusal on 80 columns${flags.length ? " under --plain" : ""} keeps the remedy's flags together`,
      registered.status === 0 && (flags.length
        ? refused.some((line) => line.includes("`--contract <file> --handler <file>`")) && short.some((line) => line.includes("`--config <file> --binary <file>`"))
        : refused.some((line) => line.trim() === listedCommand.replace("<name>", "myep")) && short.some((line) => line.trim() === shortCommand && displayWidth(line) <= 80)),
      { refused: refused.slice(0, 16), registered: shown(registered), short: short.slice(0, 16) });
  }
  // A logged-in user with a private runtime directory and no session bus reaches no user manager, so
  // the dry run refuses before it renders a unit. Its Next split the span after `--user`.
  if (process.platform === "linux") {
    const runtime = join(home, "no-user-manager");
    mkdirSync(runtime, { mode: 0o700 });
    const { DBUS_SESSION_BUS_ADDRESS: _bus, ...noBus } = env as Record<string, string>;
    const span = "`systemctl --user show-environment`";
    for (const flags of [[], ["--plain"]]) {
      const refused = await at80(["daemon", "install", "--dry-run", ...flags], { ...noBus, USER: userInfo().username, LOGNAME: userInfo().username, XDG_RUNTIME_DIR: runtime });
      const next = refused.slice(refused.indexOf("Next") + 1);
      check(`the daemon install --dry-run refusal on 80 columns${flags.length ? " under --plain" : ""} keeps ${span} whole in its Next`,
        refused.includes("Next") && next.some((line) => line.includes(`${span} answers`)) && refused.every((line) => displayWidth(line) <= 80), refused.slice(0, 16));
    }
  }
}

// Every supported command and subcommand `cotal help` lists shows one to three examples, the most common
// use first, each a whole command with a note on what it does. Each example parses under the options its
// help lists and selects that subcommand. Examples follow Usage and Shorthands, before Commands and
// Options, and on 80 columns each command is one line that fits, with its note beside it or under it.
{
  const built = (path: string): Promise<unknown> => import(pathToFileURL(join(REPO, path)).href);
  // The surfaces the composition root imports (bin/run.ts); each registers its commands.
  for (const surface of ["implementations/cli/dist/index.js", "implementations/manager/dist/index.js", "implementations/delivery/dist/index.js", "implementations/runtime/dist/index.js", "implementations/auth/dist/index.js", "bin/dist/docs.js", "bin/dist/mcp.js", "bin/dist/daemon/command.js"]) await built(surface);
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
  const paths: string[][] = [];
  const census = (cmd: Command, path: readonly string[], node: Command | Subcommand): void => {
    paths.push([cmd.name, ...path]);
    const examples = node.examples ?? [];
    const problems: string[] = [];
    // Gated endpoint modes and Manager unit installation are listed but have no runnable examples.
    const unavailable = (cmd.name === "endpoint" && ["watch", "session", "work"].some((mode) => mode === path[0])) || (cmd.name === "manager" && path[0] === "install");
    if (unavailable ? examples.length !== 0 : examples.length < 1 || examples.length > 3) problems.push(`declares ${examples.length} examples`);
    const lines: string[] = [];
    printHelpPath(cmd, path, (line) => lines.push(...line.replace(/\x1b\[[0-9;]*m/g, "").split("\n")), 80);
    const at = lines.indexOf("Examples");
    const end = lines.indexOf("", at);
    const section = lines.slice(at + 1, end === -1 ? undefined : end);
    if (unavailable ? at !== -1 : at === -1 || at < Math.max(lines.indexOf("Usage"), lines.indexOf("Shorthands")) || ["Commands", "Options"].some((title) => lines.includes(title) && lines.indexOf(title) < at)) problems.push(`unexpected Examples section: ${lines.join(" | ").slice(0, 300)}`);
    for (const example of examples) {
      if (typeof example === "string") { problems.push(`${example}: has no note`); continue; }
      const { command, note } = example;
      if (!note || note.length > 60 || note.endsWith(".")) problems.push(`${command}: its note "${note}" is empty, over 60 characters or ends with a period`);
      if (!section.some((line) => line.startsWith(`  ${command}`) && displayWidth(line) <= 80) || !section.join(" ").replace(/\s+/g, " ").includes(`${command} ${note}`)) problems.push(`${command}: is not one line that fits 80 columns with its note: ${section.join(" | ")}`);
      problems.push(...problemsOf(cmd, path, command));
    }
    const expectation = unavailable ? "omits examples for an unavailable operation" : "shows one to three examples after its usage, each one line with a note, parsing under its own options";
    check(`${["cotal", cmd.name, ...path].join(" ")} ${expectation}`, problems.length === 0, problems);
    for (const sub of node.subcommands ?? []) if (!sub.hidden) census(cmd, [...path, sub.name], sub);
  };
  for (const cmd of commands) census(cmd, [], cmd);
  console.log(`  examples census: ${paths.length} commands and subcommands`);

  // A usage whose first group is wider than the line starts that group on the `cotal` line, and
  // every line of the help fits. Daemon's and service-endpoint's put `cotal` on a line of its own.
  for (const name of ["daemon", "service-endpoint"]) {
    for (const width of [80, 120]) {
      const lines: string[] = [];
      printHelpPath(registry.resolve<Command>("command", name), [], (line) => lines.push(...line.replace(/\x1b\[[0-9;]*m/g, "").split("\n")), width);
      const at = lines.indexOf("Usage");
      check(`cotal help ${name} at ${width} columns starts its usage with cotal ${name}, every line within the width`,
        at > 0 && lines[at + 1]!.startsWith(`  cotal ${name} `) && lines.every((line) => displayWidth(line) <= width), { usage: lines.slice(at, lines.indexOf("", at)), wide: lines.filter((line) => displayWidth(line) > width) });
    }
  }

  // At 60 columns an option's description wraps without splitting a `--flag <value>` unit or a
  // command it names. Up's -d named cotal down bare and spawn's --allow-stale cotal team deploy
  // <file>, and both split after `cotal`.
  for (const [name, named] of [["up", "`cotal down`"], ["spawn", "`cotal team deploy <file>`"]] as const) {
    const help = (width: number): string[] => {
      const lines: string[] = [];
      printHelpPath(registry.resolve<Command>("command", name), [], (line) => lines.push(...line.replace(/\x1b\[[0-9;]*m/g, "").split("\n")), width);
      return lines;
    };
    const narrow = help(60), whole = help(Number.POSITIVE_INFINITY).join("\n");
    const count = (text: string, unit: string): number => text.split(unit).length - 1;
    const units = [...new Set([...whole.matchAll(/(?<![\w-])--?[a-zA-Z][\w-]* (?:<[^>]+>|"[^"]*")|`cotal [^`]+`/g)].map((match) => match[0]))];
    const split = units.filter((unit) => narrow.reduce((sum, line) => sum + count(line, unit), 0) !== count(whole, unit));
    check(`cotal ${name} --help at 60 columns keeps every --flag <value> unit and every command it names, ${named} included, on one line`,
      units.length > 10 && units.includes(named) && split.length === 0 && narrow.every((line) => displayWidth(line) <= 60), { split, narrow });
  }
  // At 40 columns run's --on names `cotal ps` in backticks on one line, in run's help and its hosted
  // verbs'. It named it bare.
  for (const path of [[], ["start"], ["show"], ["answer"], ["amend"]]) {
    const lines: string[] = [];
    printHelpPath(registry.resolve<Command>("command", "run"), path, (line) => lines.push(...line.replace(/\x1b\[[0-9;]*m/g, "").split("\n")), 40);
    const text = lines.join("\n");
    check(`cotal ${["run", ...path].join(" ")} --help at 40 columns names \`cotal ps\` under --on in backticks on one line`,
      lines.some((line) => line.includes("`cotal ps`") && displayWidth(line) <= 40) && text.split("cotal ps").length === text.split("`cotal ps`").length, lines);
  }

  // Every string literal in the shipped sources, under implementations/*/src, packages/*/src,
  // extensions/*/src and bin, that names a command after other words, as a remedy, a Next, a hint or
  // a message does, writes it in backticks, so the renderer keeps it whole and --json carries the same
  // text, and so does every option description a registered command declares, which its help prints.
  // A command is `cotal` and a registered command name, `linear` included, or an interpolated one;
  // `displayCmd()`, or a const bound to it, prints as `cotal`. Comments are not string literals, and a
  // usage line or a literal that starts with its command is not a sentence naming one, unless that
  // command is interpolated and words follow it: such a literal is a clause another sentence holds, as
  // a last operation's "cotal up, with no recorded outcome" was. The smoke-kit helpers ship nowhere,
  // and this file is not under the sources it reads.
  {
    await built("implementations/linear/dist/index.js");
    const names = new Set(registry.all<Command>("command").flatMap((cmd) => [cmd.name, ...(cmd.aliases ?? [])]));
    // Literals that are code, a data value or a usage form, or name cotal itself or its config file:
    // a file and the literal's text.
    const exempt: readonly (readonly [string, RegExp])[] = [
      ["implementations/cli/src/lib/completion-scripts.ts", /(?:)/], // shell completion scripts
      ["implementations/cli/src/lib/completion-install.ts", /^# (>>>|<<<) cotal completion (>>>|<<<)$/], // the startup-file markers
      ["implementations/cli/src/lib/setup-log.ts", /^\n=== cotal setup - /], // the setup log's header
      ["implementations/cli/src/seed/paths.ts", /can take an installed cotal down\.|cannot determine the (?:loaded )?cotal version: /], // cotal, the program
      ["implementations/cli/src/seed/reconcile.ts", /and this cotal \$\{\} does not move it back/],
      ["implementations/cli/src/commands/status-render.ts", /^cotal \$\{\} {2}· {2}Node \$\{\}/], // cotal, the program, and its version
      ["implementations/cli/src/lib/nearest-word.ts", /^cotal \$\{\} has no subcommand /], // a refusal that starts with its command
      ["implementations/cli/src/commands/service-registry.ts", /^cotal up or cotal supervise$/], // startedBy, a data value
      ["packages/core/src/connector-config.ts", /^modelPolicy\.\$\{\} in the cotal config$/], // the config file
      ["extensions/connector-claude-code/src/setup.ts", /remove the heavy ones from the cotal config or spawn/],
      ["implementations/auth/src/commands.ts", /^cotal \$\{\} grant <actor> --sub <IdP subject> --full {3}\(|^cotal \$\{\} revoke <actor> --sub <IdP subject>\|--owner <u_…>$/], // usage forms with alternatives
      ["implementations/manager/src/commands.ts", /^use cotal endpoint deregister <class> <full-instance-id> \[--space <space>\] \[--yes\|--dry-run\], /],
    ];
    // Where `text` names a command after other words, or leads with an interpolated one that words
    // follow, outside backticks.
    const bare = (text: string): number[] => [...text.matchAll(/(?:^|(?<=[ ("']))cotal (\S+)/g)].flatMap((match) => {
      // Environment assignments before a command, as in ZDOTDIR=<dir> cotal completion, are part of it.
      const before = text.slice(0, match.index), line = before.slice(before.lastIndexOf("\n") + 1).replace(/^(?:[A-Z_][A-Z0-9_]*=\S* )+/, "");
      const word = match[1]!.replace(/[,;:.)"']+$/, "");
      const command = names.has(word) || names.has(word.replace(/\$\{\}.*$/, "")) || word.startsWith("${}");
      const clause = word.startsWith("${}") && /[A-Za-z]/.test(text.slice(match.index + match[0].length).split("\n")[0]!.replace(/\$\{\}|--?[\w-]+|<[^>]*>|\[[^\]]*\]/g, ""));
      return !command || !(/[A-Za-z]/.test(line) || clause) || /(usage: |\| )$/.test(before) || (before.match(/`/g) ?? []).length % 2 === 1 ? [] : [match.index];
    });
    const roots = ["implementations/*/src", "packages/*/src", "extensions/*/src", "bin"];
    const sources = spawnSync("git", ["ls-files", "--", ...roots.flatMap((root) => [`${root}/*.ts`, `${root}/*.tsx`]), ":(exclude)bin/smoke", ":(exclude)packages/smoke-kit"], { cwd: REPO, encoding: "utf8" }).stdout.split("\n").filter(Boolean);
    const offenders: string[] = [];
    for (const file of sources) {
      const source = readFileSync(join(REPO, file), "utf8");
      const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
      const display = new Set(["displayCmd()"]);
      const bind = (node: ts.Node): void => {
        if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer?.getText(tree) === "displayCmd()") display.add(node.name.text);
        ts.forEachChild(node, bind);
      };
      bind(tree);
      const visit = (node: ts.Node): void => {
        // The argument of codeSpan() is printed inside backticks, so a shell line there, such as
        // `cd <dir> && cotal down`, already has its command in a code span.
        const spanned = node.parent !== undefined && ts.isCallExpression(node.parent) && node.parent.expression.getText(tree) === "codeSpan" && node.parent.arguments[0] === node;
        const text = spanned ? undefined : ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) ? node.text
          : ts.isTemplateExpression(node) ? node.head.text + node.templateSpans.map((span) => (display.has(span.expression.getText(tree)) ? "cotal" : "${}") + span.literal.text).join("") : undefined;
        if (text !== undefined && !exempt.some(([path, literal]) => path === file && literal.test(text)))
          for (const at of bare(text)) offenders.push(`${file}:${tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1}: ${JSON.stringify(text.slice(Math.max(0, at - 40), at + 40))}`);
        ts.forEachChild(node, visit);
      };
      visit(tree);
    }
    const options = registry.all<Command>("command").flatMap((cmd) => (cmd.flags ?? []).map((flag) => [`cotal ${cmd.name} --${flag.name}`, flag.description ?? ""] as const));
    for (const [option, description] of options) for (const at of bare(description)) offenders.push(`${option}: ${JSON.stringify(description.slice(Math.max(0, at - 40), at + 40))}`);
    check(`every shipped source string literal and option description that names a command after other words writes it in backticks (${sources.length} files, ${options.length} options)`,
      roots.every((root) => sources.some((file) => file.startsWith(`${root.split("/")[0]}/`))) && sources.length > 800 && options.length > 300 && offenders.length === 0, offenders);
  }

  // `cotal <path> --help` and `cotal help <path>` reach the help through two routes, the dispatcher's
  // and the help command's, and print one help. Run a few at a time; each is a process of its own.
  const binary = (args: string[]) => new Promise<ReturnType<typeof run>>((resolve) => {
    const child = spawn(process.execPath, [BIN, ...args], { cwd: neutral, env, timeout: 120_000 });
    let stdout = "", stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
  const helps: [ReturnType<typeof run>, ReturnType<typeof run>][] = [];
  let next = 0;
  await Promise.all(Array.from({ length: 3 }, async () => {
    for (let i = next++; i < paths.length; i = next++) helps[i] = await Promise.all([binary([...paths[i]!, "--help"]), binary(["help", ...paths[i]!])]);
  }));
  paths.forEach((path, i) => {
    const [flag, word] = helps[i]!;
    check(`cotal ${path.join(" ")} --help prints the same help as cotal help ${path.join(" ")}`, flag.status === word.status && flag.stdout === word.stdout && flag.stderr === word.stderr, { "--help": shown(flag), help: shown(word) });
  });

  // The binary prints the same order, and `manager <verb> --help`, which reads the service command,
  // shows the manager's own examples.
  const spawnHelp = run(["spawn", "--help"]);
  const order = ["Usage", "Shorthands", "Examples", "Options"].map((title) => spawnHelp.stdout.indexOf(`\n${title}\n`));
  check("cotal spawn --help shows Usage, Shorthands, Examples, then Options", spawnHelp.status === 0 && order.every((index, i) => index !== -1 && (i === 0 || index > order[i - 1]!)), shown(spawnHelp));
  const managerStart = run(["manager", "start", "--help"]);
  const declared = registry.resolve<Command>("command", "manager").subcommands?.find((sub) => sub.name === "start")?.examples ?? [];
  check("cotal manager start --help shows the manager start examples", managerStart.status === 0 && declared.length > 0 && declared.every((example) => typeof example !== "string" && managerStart.stdout.includes(`  ${example.command}`)), shown(managerStart));
  const rejectedNoOpen = run(["manager", "start", "--no-open", "--dry-run"]);
  const webStart = run(["service", "start", "web", "--help"]);
  check("manager start omits the web-only --no-open option even in refusal help, and web start shows it",
    managerStart.status === 0 && !/^  --no-open\b/m.test(managerStart.stdout) &&
    rejectedNoOpen.status === 1 && /--no-open belongs to service start web/.test(rejectedNoOpen.stderr) && !/^  --no-open\b/m.test(rejectedNoOpen.stderr) &&
    webStart.status === 0 && /^  --no-open\b/m.test(webStart.stdout),
    { manager: shown(managerStart), refused: shown(rejectedNoOpen), web: shown(webStart) });
  const brokerStart = run(["service", "start", "broker", "--help"]);
  const brokerHelp = run(["help", "service", "start", "broker"]);
  const brokerRefusal = run(["service", "start", "broker", "--no-open", "--dry-run"]);
  check("broker start help shows broker options and omits the web-only --no-open option, including on refusal",
    brokerStart.status === 0 && brokerHelp.status === 0 && brokerStart.stdout === brokerHelp.stdout &&
    /^  --config <file>/m.test(brokerStart.stdout) && /^  --binary <file>/m.test(brokerStart.stdout) && !/^  --no-open\b/m.test(brokerStart.stdout) &&
    brokerRefusal.status === 1 && /--no-open belongs to service start web/.test(brokerRefusal.stderr) &&
    /^  --config <file>/m.test(brokerRefusal.stderr) && !/^  --no-open\b/m.test(brokerRefusal.stderr),
    { start: shown(brokerStart), help: shown(brokerHelp), refused: shown(brokerRefusal) });

  const addBroker = ["service", "add", "broker", "--preset", "broker"];
  const addSuffix = run([...addBroker, "--help"]);
  check("broker add suffix help lists both required flags", addSuffix.status === 0 && addSuffix.stderr === "" &&
    /^  --config <file>.*\(required\)$/m.test(addSuffix.stdout) && /^  --binary <file>.*\(required\)$/m.test(addSuffix.stdout), shown(addSuffix));
  for (const words of [addBroker, ["svc", "add", "broker", "--preset=broker"]]) {
    const explicit = run(["help", "--", ...words]);
    check(`explicit help shows the same preset options for ${words.join(" ")}`,
      explicit.status === 0 && explicit.stderr === "" && explicit.stdout === addSuffix.stdout, shown(explicit));
  }
  const addGeneric = run(["service", "add", "--help"]);
  for (const selector of [["--preset", "not-a-preset"], ["--preset"], ["--preset=broker", "--preset=broker"]]) {
    const explicit = run(["help", "--", "service", "add", "broker", ...selector]);
    check(`explicit help keeps generic add help for ${selector.join(" ")}`, addGeneric.status === 0 &&
      explicit.status === 0 && explicit.stderr === "" && explicit.stdout === addGeneric.stdout && !/^  --config\b/m.test(explicit.stdout), shown(explicit));
  }
  const addUnescaped = run(["help", ...addBroker]);
  check("explicit help with an unescaped preset flag points to suffix help",
    usageShape(addUnescaped, /Unknown option '--preset'/) &&
    ["cotal", "pnpm cotal"].some((cli) => addUnescaped.stderr.includes(`\`${cli} service add <name> --preset <preset> --help\``)) && !addUnescaped.stderr.includes("put -- before it"),
    shown(addUnescaped));

  for (const path of [["endpoint", "watch"], ["endpoint", "session"], ["endpoint", "work"], ["endpoint", "work", "lease"], ["endpoint", "work", "commit"]]) {
    const help = run([...path, "--help"]);
    check(`cotal ${path.join(" ")} help states the limit without offering working examples`,
      help.status === 0 && /unavailable in this CLI/.test(help.stdout) && /^Usage$/m.test(help.stdout) && !/^Examples$/m.test(help.stdout) &&
      help.stdout.trimEnd().endsWith("Structured output: json, plain"), shown(help));
  }

  for (const operation of ["lease", "commit"]) {
    const extra = operation === "commit" ? ["--lease", "missing.creds", "--result", "{}"] : [];
    const refused = run(["endpoint", "work", operation, "ep:example", "review", ...extra, "--json"]);
    const receipt = JSON.parse(refused.stdout);
    check(`endpoint work ${operation} still returns the finite unsupported refusal`,
      refused.status === 2 && receipt.schemaVersion === 1 && receipt.command === "endpoint" && receipt.outcome === "refused" &&
      receipt.target?.capability === "work" && receipt.target.operation === operation && receipt.error?.code === "UNSUPPORTED", shown(refused));
  }
  const badLeaseFlag = run(["endpoint", "work", "lease", "ep:example", "review", "--no-such-option", "--json"]);
  check("endpoint work lease does not suggest an extra operand when given an unknown option",
    badLeaseFlag.status === 1 && parsed(badLeaseFlag)?.error?.remedy === "drop the unknown option", shown(badLeaseFlag));

  // The persona create example, its placeholders filled in, run as written against a fresh Cotal home
  // in the folder of a space prepared there, which needs no stack. Without --subscribe the refusal
  // shows the persona create help.
  const fresh = { COTAL_HOME: join(home, "persona-home") };
  const project = join(home, "persona-project");
  mkdirSync(project, { mode: 0o700 });
  const prepared = run(["space", "create", "personas", "--root", project], fresh);
  const [example] = registry.resolve<Command>("command", "persona").subcommands?.find((sub) => sub.name === "create")?.examples ?? [];
  const written = typeof example === "string" ? example : example?.command ?? "";
  const created = run(words(written.replace("<name>", "reviewer").replace("<text>", "review the diff")).slice(1), fresh, project);
  const saved = run(["persona", "show", "reviewer", "--json"], fresh, project);
  check(`${written} runs as written and saves a persona that reads no channels`, prepared.status === 0 && created.status === 0 && saved.status === 0 && JSON.stringify(JSON.parse(saved.stdout).result.definition.subscribe) === "[]", { prepared: shown(prepared), created: shown(created), saved: shown(saved) });
  const noReadSet = run(["persona", "create", "other", "--prompt", "review the diff"], fresh, project);
  check("persona create without --subscribe is refused with the persona create help, not the persona help",
    usageShape(noReadSet, /provide --subscribe <a,b> or --subscribe= for none/) && noReadSet.stderr.includes("\nUsage\n  cotal persona create <name> ") && !/^Commands$/m.test(noReadSet.stderr), shown(noReadSet));
  if (process.platform !== "win32") {
    for (const [name, prompt, option] of [["short", "Review only", 0], ["long", "Review only", 1], ["dash", "-Review only", 0]] as const) {
      const refused = run(["persona", "create", name, `-p=${prompt}`, "--subscribe", ""], fresh, project);
      const corrections = /^  write (.+)$/m.exec(refused.stderr)?.[1]?.split(" or ");
      const correction = corrections?.[option];
      const copied = correction && runShell(`persona create ${name} ${correction} --subscribe ''`, fresh, project);
      check(`the printed ${name} persona correction preserves the prompt in a shell`,
        usageShape(refused, /gives -p the value/) && corrections?.length === (name === "dash" ? 1 : 2) && !!copied && copied.status === 0
        && readFileSync(join(project, ".cotal", "agents", `${name}.md`), "utf8").trimEnd().endsWith(`\n${prompt}`), { refused: shown(refused), copied });
    }
  }
}

// No mark at all: the report names the outcome in words, and `!` stays the warning mark.
const reportShape = (r: ReturnType<typeof run>, message: RegExp) =>
  r.status === 1 && r.stdout === "" && /^Request refused$/m.test(r.stderr) && /Code: +USAGE_INVALID/.test(r.stderr) && message.test(r.stderr) && /Usage/.test(r.stderr) && !/[✗↳]|^! /m.test(r.stderr);
const describeLive = run(["endpoint", "describe", "manager", "--live", "--plain"]);
check("endpoint describe explains the --live refusal and both available reads",
  reportShape(describeLive, /endpoint describe already reads the contract live and does not take --live/) &&
  describeLive.stderr.includes("remove --live") && describeLive.stderr.includes("cotal endpoint list --live") &&
  !describeLive.stderr.includes("--file and --yes"), shown(describeLive));
const inventoryHelp = run(["endpoint", "--help"]);
check("endpoint help distinguishes saved and live inventory and scopes the broker and credential options",
  inventoryHelp.status === 0 && /(?:pnpm )?cotal endpoint \[--space <s>\]/.test(inventoryHelp.stdout)
    && /(?:pnpm )?cotal endpoint --live \[--space <s>\]/.test(inventoryHelp.stdout)
    && /--space <s>[^\n]*saved references without a broker/.test(inventoryHelp.stdout)
    && /--server <url>[^\n]*requires --live/.test(inventoryHelp.stdout)
    && /--creds <path>[^\n]*requires --live/.test(inventoryHelp.stdout), shown(inventoryHelp));
for (const [flag, value] of [["--server", "nats://127.0.0.1:37126"], ["--creds", "inventory.creds"]] as const) {
  const inventory = run(["endpoint", flag, value, "--json"]);
  const error = JSON.parse(inventory.stdout).error;
  check(`endpoint inventory tells users how to use or omit ${flag}`,
    inventory.status === 1 && inventory.stderr === "" && error?.code === "USAGE_INVALID"
      && error.remedy === `add --live to read native registrations, or omit ${flag} to list saved references`, shown(inventory));
}
const ascii = { LANG: "C" };
const forcedColor = { FORCE_COLOR: "1", NO_COLOR: "" };
const plainOwn = run(["config", "get", "bogus", "--plain"], forcedColor);
check("under --plain a command's own usage refusal and help stay uncolored with forced color",
  reportShape(plainOwn, /unknown preference "bogus"/) && /^Next$/m.test(plainOwn.stderr) && !plainOwn.stderr.includes("\x1b"), shown(plainOwn));
const asciiOwn = run(["config", "get", "bogus"], ascii);
check("under a locale without UTF-8 a command's own usage refusal is the report, then the help", reportShape(asciiOwn, /unknown preference "bogus"/), shown(asciiOwn));
const plainParser = run(["status", "--bogus", "--plain"], forcedColor);
check("under --plain a parser usage refusal and help stay uncolored with forced color",
  reportShape(plainParser, /Unknown option '--bogus'/) && !plainParser.stderr.includes("\x1b"), shown(plainParser));
const asciiParser = run(["status", "--bogus"], ascii);
check("under a locale without UTF-8 a parser usage error is the report, then the help", reportShape(asciiParser, /Unknown option '--bogus'/), shown(asciiParser));
const asciiUnknown = run(["frobnicate"], ascii);
check("under a locale without UTF-8 an unknown command is the report, with no warning mark", asciiUnknown.status === 1 && /^Request refused$/m.test(asciiUnknown.stderr) && /unknown command: frobnicate/.test(asciiUnknown.stderr) && !/^! /m.test(asciiUnknown.stderr), shown(asciiUnknown));
// A missing --yes outside a terminal is not a grammar mistake: the refusal and a remedy that names
// --yes are the whole fix, so the command's help is left out, as `down` already did.
const project = join(home, "proj");
mkdirSync(project, { mode: 0o700 });
const backupDestination = join(home, "unused");
const backupCreate = run(["backup", "create", "../unused", "--yes", "--plain"], {}, project);
check("backup create names the unsupported option and refuses before writing",
  reportShape(backupCreate, /backup create does not accept --yes/) && backupCreate.stderr.includes("remove --yes to create the backup")
  && !existsSync(backupDestination), shown(backupCreate));
const confirmationSpace = run(["space", "create", "confirmation", "--root", project]);
check("confirmation refusals use a prepared local space", confirmationSpace.status === 0, shown(confirmationSpace));
const deleteTarget = run(["space", "add", "delete-target", "--root", project, "--mode", "open", "--server", "nats://127.0.0.1:43028", "--force", "--yes"]);
check("space delete confirmation uses a registered target", deleteTarget.status === 0, shown(deleteTarget));
mkdirSync(join(project, ".cotal", "agents"), { recursive: true });
writeFileSync(join(project, ".cotal", "agents", "p1.md"), "---\nname: p1\n---\nhello\n");
const confirmShape = (r: ReturnType<typeof run>, message: RegExp, remedy: string) =>
  r.status === 1 && r.stdout === "" && /^✗ /m.test(r.stderr) && message.test(r.stderr) && r.stderr.includes(remedy) && !/Usage|Options/.test(r.stderr);
for (const [args, message, remedy] of [
  [["persona", "remove", "p1"], /removing 'p1' .* requires --yes/, "confirm with `cotal persona remove p1 --yes`"],
  [["history", "clear", "--dms"], /history clear requires --yes/, "then confirm it with `cotal history clear --dms --yes`"],
  [["space", "delete", "delete-target"], /live space deletion requires a terminal/, "then run `cotal space delete delete-target --yes`"],
  [["reset", "store", "nosuch"], /reset store needs a terminal confirmation/, "then run `cotal reset store nosuch --yes`"],
  [["reset", "space", "nosuch"], /reset space needs a terminal confirmation/, "then run `cotal reset space nosuch --yes`"],
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
  [["version", "--js.on"], /Unknown option '--js\.on' - did you mean --json\?/],
  [["history", "general", "--gr.ep"], /Unknown option '--gr\.ep' - did you mean --grep\?/],
  [["config", "get", "harness", "--jsno"], /Unknown option '--jsno' - did you mean --json\?/],
] as const) {
  const r = run([...args]);
  check(`${args.join(" ")} names the nearest word`, r.status === 1 && message.test(r.stderr), shown(r));
}
for (const words of [["--json", "--jsn"], ["--jsn", "-j"]]) {
  const r = run(["version", ...words]);
  const error = parsed(r)?.error;
  check(`version ${words.join(" ")} keeps the JSON switch already supplied`, r.status === 1 && error?.message === "Unknown option '--jsn'" && error.remedy === "drop the unknown option; --json is already set", shown(r));
}
const afterEnd = run(["version", "--jsn", "--", "--json"]);
check("an operand after -- is not a switch already set", afterEnd.status === 1 && afterEnd.stderr.includes("did you mean --json?"), shown(afterEnd));
const configTypo = run(["config", "get", "harness", "--verbsoe", "--json"]);
check("config get does not suggest a flag only bare config takes",
  configTypo.status === 1 && configTypo.stderr === "" && JSON.parse(configTypo.stdout).error.message === "Unknown option '--verbsoe'", shown(configTypo));
const configGet = ["config", "get", "harness", "--user", "--json"];
const configUnknown = run([...configGet, "--mystery-flag"]);
const { error: configError } = JSON.parse(configUnknown.stdout);
const configRetry = run(configGet);
check("config get with its key filled says to drop the unknown option, and dropping it returns the setting",
  configUnknown.status === 1 && configUnknown.stderr === "" && configError?.code === "USAGE_INVALID"
  && configError.message === "Unknown option '--mystery-flag'" && configError.remedy === "drop the unknown option"
  && configRetry.status === 0 && JSON.parse(configRetry.stdout).result?.setting?.key === "harness",
  { refusal: shown(configUnknown), retry: shown(configRetry) });
{
  const flag = "--mystery-manifest";
  writeFileSync(join(neutral, flag), "apiVersion: cotal/v1\nkind: Mesh\nspace: fixture\nchannels: {}\n");
  for (const verb of ["check", "boot", "deploy"]) {
    const words = ["team", verb, ...(verb === "check" ? [] : ["--dry-run"]), "--json"];
    const filled = run([...words, `./${flag}`, flag]);
    const empty = run([...words, flag]);
    check(`team ${verb} only suggests a separator when its file is missing`,
      filled.status === 1 && parsed(filled)?.error?.remedy === "drop the unknown option"
      && empty.status === 1 && parsed(empty)?.error?.remedy?.includes("put -- before it") === true,
      { filled: shown(filled), empty: shown(empty) });
  }
  for (const operand of [[`./${flag}`], ["--", flag]]) {
    const retry = run(["team", "check", "--json", ...operand]);
    check(`team check reads the manifest with ${operand.join(" ")}`, retry.status === 0 && JSON.parse(retry.stdout).result.space === "fixture", shown(retry));
  }
}
const clearTypo = run(["history", "clear", "--folow"]);
check("history clear does not suggest a flag only history reads take",
  usageShape(clearTypo, /Unknown option '--folow'/) && !/did you mean/.test(clearTypo.stderr), shown(clearTypo));
const far = run(["frobnicate"]);
check("control: a word near nothing gets no suggestion", far.status === 1 && /unknown command: frobnicate - run `cotal help` to list commands/.test(far.stderr) && !/did you mean/.test(far.stderr), shown(far));

for (const [args, suggestion] of [
  [["auth", "handle", "inspec"], "inspect"],
  [["endpoint", "work", "commti"], "commit"],
] as const) {
  const [command, parent, typo] = args;
  const message = `cotal ${command} ${parent} has no subcommand "${typo}" - did you mean ${suggestion}? Or run \`cotal help ${command} ${parent}\``;
  const text = run([...args]);
  const help = run([...args, "--help"]);
  const json = run([...args, "--json"]);
  check(`${args.join(" ")} refuses with the same text and parent help as --help`,
    text.status === 1 && help.status === 1 && text.stdout === "" && help.stdout === ""
    && text.stderr.startsWith(`✗ ${message}\n`) && text.stderr === help.stderr, { text: shown(text), help: shown(help) });
  check(`${args.join(" ")} --json reports the nested typo as USAGE_INVALID`,
    json.status === 1 && json.stderr === "" && parsed(json)?.error?.code === "USAGE_INVALID"
    && parsed(json)?.error?.message === message, shown(json));
}
const missingHandleFile = run(["auth", "handle", "inspect", "--json"]);
check("auth handle inspect without a file still reports the missing operand",
  missingHandleFile.status === 1 && missingHandleFile.stderr === "" && parsed(missingHandleFile)?.error?.code === "USAGE_INVALID"
  && parsed(missingHandleFile)?.error?.message === "use auth handle inspect <private-file>", shown(missingHandleFile));

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
  const fromRemoved = (args: string[], extra: Record<string, string> = {}) => {
    const gone = mkdtempSync(join(home, "gone-"));
    const childEnv = { ...env, ...extra };
    // The guard reads the folder's marker, which the shell must find gone, so it goes after the check.
    assertSmokeSandboxDown(recordSmokeSandbox({ root: gone, cotalHome: env.COTAL_HOME, xdgConfigHome: env.XDG_CONFIG_HOME }), args, { cwd: gone, env: childEnv });
    rmSync(join(gone, ".cotal"), { recursive: true });
    const r = spawnSync("/bin/sh", ["-c", 'cd "$1" && command -p rmdir "$1" && shift && exec "$@"', "sh", gone, process.execPath, BIN, ...args], { cwd: neutral, env: childEnv, encoding: "utf8", timeout: 120_000 });
    return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  };
  // Two lines and no help: the folder is not a grammar mistake, and the remedy is the whole fix.
  const removedShape = (r: ReturnType<typeof run>) => r.status === 1 && r.stdout === "" && r.stderr === "✗ this folder no longer exists\n  cd to an existing folder and run the command again\n";
  const removed = fromRemoved(["status"]);
  check("a command run from a removed folder says the folder is gone and to cd elsewhere, with no help", removedShape(removed), shown(removed));
  const removedJson = fromRemoved(["status", "--json"]);
  const envelope = removedJson.stdout.startsWith("{") ? JSON.parse(removedJson.stdout) : undefined;
  check("with --json it is a USAGE_INVALID refusal, not an unknown outcome", removedJson.status === 1 && envelope?.outcome === "refused" && envelope.error?.code === "USAGE_INVALID", shown(removedJson));
  for (const [stream, args, target] of [
    ["watch", ["watch"], { requestedSpace: null }],
    ["history", ["history", "general", "--follow"], { space: null, channel: "general", dms: false }],
    ["membership", ["channel", "members", "general", "--follow"], { space: null, channel: "general" }],
  ] as const) {
    const r = fromRemoved([...args, "--json"]);
    const records = r.stdout.trimEnd().split("\n").map((line) => JSON.parse(line || "{}"));
    check(`${stream} frames a removed-folder refusal without a snapshot`, r.status === 1 && r.stderr === ""
      && records.length === 2 && records.every((record) => record.schemaVersion === 1 && record.stream === stream && Object.entries(target).every(([key, value]) => record.target?.[key] === value))
      && records[0]?.type === "error" && records[0].data?.code === "USAGE_INVALID"
      && records[0].data?.message === "this folder no longer exists" && records[0].data?.remedy === "cd to an existing folder and run the command again"
      && records[1]?.type === "end" && records[1].data?.reason === "setup-failed"
      && (stream !== "membership" || records[1].data.lastAsOf === null), shown(r));
  }
  const finite = fromRemoved(["history", "general", "--json"]);
  check("finite history from a removed folder still emits one usage refusal", finite.status === 1 && finite.stderr === ""
    && parsed(finite)?.error?.code === "USAGE_INVALID", shown(finite));
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
  // An absolute PATH entry must still supply the command prefix when a relative entry is unusable.
  const pathBin = mkdtempSync(join(home, "path-bin-"));
  writeFileSync(join(pathBin, "cotal"), "#!/bin/sh\nexit 5\n", { mode: 0o700 });
  const usage = "\n  cotal <command> [options]\n";
  const notice = "This folder no longer exists, so commands that use a space refuse here. cd to an existing folder first.\n";
  for (const args of [["help"], []]) {
    const form = ["cotal", ...args].join(" ");
    const heading = args.length ? "cotal - lateral agent coordination over NATS\n\n" : "";
    for (const [label, extra] of [
      ["absolute PATH", { PATH: pathBin, npm_config_cache_dir: "" }],
      ["relative PATH entry", { PATH: [".", pathBin].join(delimiter), npm_config_cache_dir: "" }],
      ["relative pnpm cache", { PATH: pathBin, npm_config_cache_dir: "relative-cache" }],
    ] as const) {
      const r = fromRemoved(args, extra);
      check(`${form} from a removed folder with ${label} prints the notice and uses the absolute executable, exit 0`,
        r.status === 0 && r.stderr === "" && r.stdout.startsWith(heading + notice) && r.stdout.includes(usage), shown(r));
    }
    const r = run(args, { PATH: ".", npm_config_cache_dir: "" }, pathBin);
    check(`${form} still finds a relative PATH executable from an existing folder`,
      r.status === 0 && r.stderr === "" && r.stdout.includes(usage) && !r.stdout.includes(notice), shown(r));
  }
  const docs = fromRemoved(["docs", "--json"]);
  check("docs runs from a removed folder", docs.status === 0 && docs.stdout.includes('"outcome":"ok"'), shown(docs));
  const telemetry = fromRemoved(["telemetry", "--json"]);
  check("telemetry runs from a removed folder", telemetry.status === 0 && telemetry.stdout.includes('"outcome":"ok"'), shown(telemetry));
}

{
  const homeFile = join(home, "home-file");
  writeFileSync(homeFile, "notes\n");
  const streams = [
    ["watch", ["watch"], { requestedSpace: null }],
    ["history", ["history", "review", "--follow"], { space: null, channel: "review", dms: false }],
    ["membership", ["channel", "members", "review", "--follow"], { space: null, channel: "review" }],
  ] as const;
  for (const [label, path, code, message, remedy] of [
    ["relative path", "relative", "USAGE_INVALID", '"relative" is a relative path', "set COTAL_HOME to an absolute path"],
    ["file", homeFile, "SCHEMA_INVALID", `${homeFile} is not a directory`, "point COTAL_HOME at a directory"],
  ] as const) {
    const extra = { COTAL_HOME: path };
    for (const [stream, args, target] of streams) {
      const r = run([...args, "--json"], extra);
      const records = r.stdout.trimEnd().split("\n").map((line) => JSON.parse(line || "{}"));
      check(`${stream} frames a COTAL_HOME refusal for a ${label} without a snapshot`, r.status === 1 && r.stderr === ""
        && records.length === 2 && records.every((record) => record.schemaVersion === 1 && record.stream === stream && Object.entries(target).every(([key, value]) => record.target?.[key] === value))
        && records[0]?.type === "error" && records[0].data?.code === code
        && records[0].data?.message?.startsWith(`COTAL_HOME ${message}`)
        && records[0].data?.remedy?.startsWith(`${remedy}, or unset it to use `)
        && records[1]?.type === "end" && records[1].data?.reason === "setup-failed"
        && (stream !== "membership" || records[1].data.lastAsOf === null), shown(r));
    }
    const finite = run(["history", "review", "--json"], extra);
    const receipt = JSON.parse(finite.stdout || "{}");
    check(`finite history with COTAL_HOME set to a ${label} still emits one refusal envelope`, finite.status === 1 && finite.stderr === ""
      && receipt.command === "history" && receipt.outcome === "refused" && receipt.error?.code === code, shown(finite));
  }
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
  for (const [stream, args, target] of [
    ["history", ["history", "review", "--follow"], { space: null, channel: "review", dms: false }],
    ["membership", ["channel", "members", "review", "--follow"], { space: null, channel: "review" }],
    ["watch", ["watch"], { requestedSpace: null }],
  ] as const) {
    const r = at([...args, "--json"]);
    const records = r.stdout.trimEnd().split("\n").map((line) => JSON.parse(line || "{}"));
    check(`${stream} reports the project conflict as a setup failure without a snapshot`, r.status === 2 && r.stderr === ""
      && records.length === 2 && records.every((record) => record.schemaVersion === 1 && record.stream === stream && Object.entries(target).every(([key, value]) => record.target?.[key] === value))
      && records[0]?.type === "error" && records[0].data?.code === "CONFLICT" && records[0].data?.message?.includes(join(notes, ".cotal"))
      && records[0].data?.remedy === "rename or move that file, then run the command again"
      && records[1]?.type === "end" && records[1].data?.reason === "setup-failed" && (stream !== "membership" || records[1].data.lastAsOf === null), shown(r));
  }
  const history = at(["history", "review", "--json"]);
  const receipt = JSON.parse(history.stdout || "{}");
  check("finite history still reports one CONFLICT receipt", history.status === 2 && history.stderr === ""
    && receipt.command === "history" && receipt.outcome === "refused" && receipt.error?.code === "CONFLICT", shown(history));
  const rooted = at(["space", "create", "notes", "--root", notes], neutral);
  check("--root naming that folder refuses the same way", named(rooted), shown(rooted));
  for (const args of [["--version"], ["version"]]) {
    const version = at(args);
    check(`${args[0]} still answers there`, version.status === 0 && /^cotal-ai /.test(version.stdout), shown(version));
  }
  check("the file is left as it was", readFileSync(join(notes, ".cotal"), "utf8") === "notes\n");
}

// The command a missing --yes prints keeps the --space, --server and --creds it was given. Without
// them, following it removed the selected space's persona, reference or history (#7564).
{
  const spaces = mkdtempSync(join(home, "two-spaces-"));
  for (const space of ["alpha", "beta"]) {
    mkdirSync(join(spaces, space));
    run(["space", "create", space, "--root", join(spaces, space)], {}, spaces);
    run(["persona", "create", "reviewer", "--prompt", `${space} reviewer`, "--subscribe", "general", "--space", space], {}, spaces);
    writeFileSync(join(spaces, `${space}.json`), JSON.stringify({ schemaVersion: 1, space, endpoint: "com.example.orders" }));
    run(["endpoint", "add", "orders", "--file", join(spaces, `${space}.json`), "--space", space], {}, spaces);
  }
  run(["use", "alpha"], {}, spaces);
  const persona = (space: string) => existsSync(join(spaces, space, ".cotal", "agents", "reviewer.md"));
  const reference = (space: string) => run(["endpoint", "show", "orders", "--space", space], {}, spaces).status === 0;
  check("control: both spaces hold the persona and the reference", persona("alpha") && persona("beta") && reference("alpha") && reference("beta"));
  for (const [args, remedy] of [
    [["history", "clear", "--space", "beta", "--dms"], "`cotal history clear --space beta --dms --yes`"],
    [["persona", "remove", "reviewer", "--space", "beta"], "`cotal persona remove reviewer --space beta --yes`"],
    [["endpoint", "remove", "orders", "--space", "beta"], "`cotal endpoint remove orders --space beta --yes`"],
  ] as const) {
    const r = run([...args, "--no-input"], {}, spaces);
    check(`${args.join(" ")} without --yes prints a command that keeps --space`, r.status === 1 && r.stderr.includes(remedy), shown(r));
    if (args[0] === "history") continue;
    const printed = /`cotal ([^`]*--yes)`/.exec(r.stderr)?.[1].split(" ") ?? [];
    const followed = run(printed, {}, spaces);
    const kept = args[0] === "persona" ? persona : reference;
    check(`following the printed ${args[0]} remove removes beta's and keeps alpha's`, followed.status === 0 && !kept("beta") && kept("alpha"), { printed, followed: shown(followed) });
  }
}

// Scoped help and flag/subcommand refusals across config, run, daemon, manager, service,
// service-endpoint and ext (#7553, #7552, #7550, #7548, #7547, #7540, #7574).
{
  const configVerbose = run(["config", "--verbose"]);
  check("bare config --verbose prints the Storage section", configVerbose.status === 0 && /^Storage$/m.test(configVerbose.stdout), shown(configVerbose));
  const savedPreference = run(["config", "set", "color", "never"]);
  const preferencesFile = join(env.XDG_CONFIG_HOME, "cotal", "preferences.json");
  check("control: a preference is saved before verbose refusals", savedPreference.status === 0 && existsSync(preferencesFile), shown(savedPreference));
  const preferencesBefore = readFileSync(preferencesFile, "utf8");
  for (const words of [
    ["config", "get", "harness"],
    ["config", "set", "color", "auto"],
    ["config", "unset", "color"],
  ]) for (const verbose of ["--verbose", "-v"]) for (const output of [[], ["--json"]]) {
    const args = [...words, verbose, ...output];
    const r = run(args, { COTAL_SKIP_CONNECTOR_SEED: "" });
    const envelope = parsed(r);
    const refused = output.length
      ? r.status === 1 && r.stderr === "" && envelope?.error?.code === "USAGE_INVALID" && /--verbose belongs to bare `cotal config`/.test(envelope.error.message ?? "")
      : usageShape(r, /--verbose belongs to bare `cotal config`/);
    check(`${args.join(" ")} refuses verbose before seeding or changing preferences`, refused && readFileSync(preferencesFile, "utf8") === preferencesBefore, shown(r));
  }

  const runShowHelp = run(["run", "show", "--help"]);
  check("run show --help lists --limit in Usage and Options", runShowHelp.status === 0 && /Usage\n[^\n]*\[--limit <n>\]/.test(runShowHelp.stdout) && /\n {2}--limit <n>\s+/.test(runShowHelp.stdout), shown(runShowHelp));
  const runCheckHelp = run(["run", "check", "--help"]);
  check("run check --help lists --file and --local in Usage and Options", runCheckHelp.status === 0 && /Usage[\s\S]*--file <program>[\s\S]*\[--local\]/.test(runCheckHelp.stdout) && /\n {2}-f, --file <program>\s+/.test(runCheckHelp.stdout) && /\n {2}--local\s+/.test(runCheckHelp.stdout), shown(runCheckHelp));

  const daemonHelp = run(["daemon", "--help"]);
  check("bare daemon --help scopes Options to --daemon-home, --json and --plain", daemonHelp.status === 0 && /--daemon-home <abs dir>/.test(daemonHelp.stdout) && !/\n {2}--(?:refresh|no-manager|wait|cloud|idp)\b/.test(daemonHelp.stdout) && !/--refresh|--no-manager|--wait/.test(daemonHelp.stdout.split("\nCommands\n")[0] ?? ""), shown(daemonHelp));
  for (const [args, message] of [
    [["daemon", "--json"], /cotal daemon needs a mode:/],
    [["daemon", "bogus", "--json"], /cotal daemon has no subcommand "bogus"/],
    [["daemon", "--bogus", "--json"], /Unknown option '--bogus'/],
  ] as const) {
    const r = run([...args]);
    const envJson = parsed(r) as { outcome?: string; error?: { code?: string; message?: string } } | undefined;
    check(`${args.join(" ")} writes a USAGE_INVALID JSON envelope on stdout and nothing on stderr`, r.status === 1 && r.stderr === "" && envJson?.outcome === "refused" && envJson.error?.code === "USAGE_INVALID" && message.test(envJson.error.message ?? ""), shown(r));
  }

  const presetSpace = join(home, "preset-space");
  mkdirSync(presetSpace, { mode: 0o700 });
  const createdPresetSpace = run(["space", "create", "presetspace", "--root", presetSpace]);
  const mgrFlagFirst = run(["manager", "--runtime", "pty", "start", "--dry-run", "--space", "presetspace"], {}, presetSpace);
  const mgrFlagAfter = run(["manager", "start", "--runtime", "pty", "--dry-run", "--space", "presetspace"], {}, presetSpace);
  check("manager --runtime pty start --dry-run matches manager start --runtime pty --dry-run", createdPresetSpace.status === 0 && mgrFlagFirst.status === 0 && mgrFlagAfter.status === 0 && mgrFlagFirst.stdout === mgrFlagAfter.stdout, { first: shown(mgrFlagFirst), after: shown(mgrFlagAfter) });
  const mgrHelpFirst = run(["manager", "--runtime", "pty", "start", "--help"]);
  const mgrHelpAfter = run(["manager", "start", "--runtime", "pty", "--help"]);
  check("manager --runtime pty start --help prints manager start help", mgrHelpFirst.status === 0 && mgrHelpFirst.stdout === mgrHelpAfter.stdout && /--runtime/.test(mgrHelpFirst.stdout), shown(mgrHelpFirst));
  const svcFlagFirst = run(["service", "start", "--runtime", "pty", "manager", "--dry-run", "--space", "presetspace"], {}, presetSpace);
  const svcFlagAfter = run(["service", "start", "manager", "--runtime", "pty", "--dry-run", "--space", "presetspace"], {}, presetSpace);
  check("service start --runtime pty manager --dry-run matches service start manager --runtime pty --dry-run", svcFlagFirst.status === 0 && svcFlagAfter.status === 0 && svcFlagFirst.stdout === svcFlagAfter.stdout, { first: shown(svcFlagFirst), after: shown(svcFlagAfter) });
  const helpSvcStartMgr = run(["help", "service", "start", "manager"]);
  const svcStartMgrHelp = run(["service", "start", "manager", "--help"]);
  check("help service start manager prints the same preset-augmented help as service start manager --help", helpSvcStartMgr.status === 0 && helpSvcStartMgr.stdout === svcStartMgrHelp.stdout && /--runtime/.test(helpSvcStartMgr.stdout), shown(helpSvcStartMgr));
  check("manager preset start help keeps --instance and omits --new-instance in Usage and Options",
    svcStartMgrHelp.status === 0 && /\[--instance <id>\]/.test(svcStartMgrHelp.stdout) && !svcStartMgrHelp.stdout.includes("--new-instance"), shown(svcStartMgrHelp));
  const genericStartHelp = run(["service", "start", "--help"]);
  check("generic service start help still lists --new-instance in Usage and Options",
    genericStartHelp.status === 0 && /\[--instance <id>\|--new-instance\]/.test(genericStartHelp.stdout) && /^  --new-instance\s/m.test(genericStartHelp.stdout), shown(genericStartHelp));
  const multiManager = run(["service", "start", "manager", "--new-instance", "--dry-run", "--json", "--space", "presetspace"], {}, presetSpace);
  const multiRefusal = parsed(multiManager) as { outcome?: string; error?: { code?: string } } | undefined;
  check("manager preset still refuses --new-instance in a preview", multiManager.status === 2 && multiRefusal?.outcome === "refused" && multiRefusal.error?.code === "UNSUPPORTED", shown(multiManager));
  const serviceList = run(["service", "list", "--space", "presetspace", "--json"], {}, presetSpace);
  const helpService = run(["service", "--help"]);
  const helpServiceList = run(["help", "service", "list"]);
  const serviceListHelp = run(["service", "list", "--help"]);
  check("both help forms for the hidden service list mode print parent help without listing the mode",
    serviceList.status === 0 && JSON.parse(serviceList.stdout).result.kind === "service-inventory"
    && [helpService, helpServiceList, serviceListHelp].every((r) => r.status === 0 && r.stderr === "" && r.stdout === helpService.stdout)
    && /^Commands\n/m.test(helpService.stdout) && !/^  list\s/m.test(helpService.stdout), shown(helpServiceList));
  const svcAddPresetMissingHelp = run(["service", "add", "--preset", "--help"]);
  const svcAddPresetBogusHelp = run(["service", "add", "x", "--preset", "bogus", "--help"]);
  const svcAddHelp = run(["service", "add", "--help"]);
  check("service add --help wins over missing or unknown --preset", svcAddPresetMissingHelp.status === 0 && svcAddPresetMissingHelp.stdout === svcAddHelp.stdout && svcAddPresetBogusHelp.status === 0 && svcAddPresetBogusHelp.stdout === svcAddHelp.stdout, { missing: shown(svcAddPresetMissingHelp), bogus: shown(svcAddPresetBogusHelp) });
  const svcAddPresetMissing = run(["service", "add", "widget", "--preset"]);
  check("service add with no preset value refuses with the scoped help and preset option",
    svcAddPresetMissing.status === 1 && svcAddPresetMissing.stdout === "" && svcAddHelp.stdout.includes("--preset <name>")
    && svcAddPresetMissing.stderr === `✗ --preset needs one declared preset name\n${svcAddHelp.stdout}`, shown(svcAddPresetMissing));

  for (const args of [
    ...["start", "show", "stop", "status", "logs", "remove"].map((mode) => ["service", mode, "myweb", "--preset", "web"]),
    ["service", "--preset", "web"],
    ["service", "start", "mymgr", "--preset", "manager"],
  ]) {
    const r = run(args);
    check(`${args.join(" ")} rejects --preset as USAGE_INVALID without recommending ext add`, usageShape(r, /--preset belongs to service add/) && !/ext add|DEPENDENCY_UNAVAILABLE/.test(r.stderr), shown(r));
  }

  const helpSeApprove = run(["help", "service-endpoint", "approve"]);
  check("help service-endpoint approve prints approve's scoped help", helpSeApprove.status === 0 && /cotal service-endpoint approve <proposalId>/.test(helpSeApprove.stdout) && /--caller-ceiling/.test(helpSeApprove.stdout) && !/--cursor|--commands/.test(helpSeApprove.stdout), shown(helpSeApprove));
  const seBogusHelp = run(["service-endpoint", "bogus", "--help"]);
  check("service-endpoint bogus --help refuses the unknown subcommand", usageShape(seBogusHelp, /cotal service-endpoint has no subcommand "bogus"/), shown(seBogusHelp));
  const unseededEnv = Object.fromEntries(Object.entries(env).filter(([k]) => k !== "COTAL_SKIP_CONNECTOR_SEED"));
  const runUnseeded = (args: string[]) => {
    const r = spawnSync(process.execPath, [BIN, ...args], { cwd: neutral, env: unseededEnv, encoding: "utf8", timeout: 120_000 });
    return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  };
  for (const [args, message] of [
    [["service-endpoint"], /service-endpoint <approve <proposalId>/],
    [["service-endpoint", "approve"], /service-endpoint <approve <proposalId>/],
    [["service-endpoint", "name-bind", "com.example.api"], /service-endpoint <approve <proposalId>/],
    [["service-endpoint", "bogus"], /cotal service-endpoint has no subcommand "bogus"/],
    [["service-endpoint", "approv"], /cotal service-endpoint has no subcommand "approv" - did you mean approve\?/],
    [["service-endpoint", "grant", "p1"], /grant needs --commands <a,b>/],
  ] as const) {
    const r = runUnseeded([...args]);
    check(`unseeded ${args.join(" ")} exits 1 as USAGE_INVALID before target resolution or seeding`, usageShape(r, message) && !/TARGET_NOT_FOUND|operator-global seed store/.test(r.stderr), shown(r));
  }

  const extBareHelp = run(["ext", "--help"]);
  check("bare ext --help omits seed-only flags --repair, --reset and --force from Options", extBareHelp.status === 0 && !/\n {2}--(?:repair|reset|force)\b/.test(extBareHelp.stdout), shown(extBareHelp));
  for (const [args, flag] of [
    [["ext", "--repair"], "--repair"],
    [["ext", "list", "--reset"], "--reset"],
    [["ext", "root", "--repair"], "--repair"],
    [["ext", "remove", "nonexistent-pkg", "--force"], "--force"],
  ] as const) {
    const r = runUnseeded([...args]);
    check(`${args.join(" ")} refuses ${flag} outside ext seed`, usageShape(r, new RegExp(`${flag} belongs to \`cotal ext seed\``)), shown(r));
  }
}

finish();
process.exit(process.exitCode ?? 0);
