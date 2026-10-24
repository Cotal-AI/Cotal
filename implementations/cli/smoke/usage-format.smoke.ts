/**
 * Every usage error has the one format the docs describe: the error, then any remedy, then the
 * command's help, all on stderr, nothing on stdout, exit 1. A command's own input checks used to
 * print a framed "Request refused … Code: USAGE_INVALID" block with no help; `clean` printed a bare
 * `usage:` line or a lowercase "refusing to clean store without --force"; and `help service nosuch`
 * refused without listing the subcommands. A missing `--yes` is the exception: its refusal and remedy
 * are the whole fix, so it prints without the help. A mistyped word that is near a command, leading
 * flag, subcommand or option names it.
 *
 * A folder whose `.cotal` is a file refuses every command with `CONFLICT`, naming that file, before
 * anything runs. A removed working folder refuses every command but help, version, docs and
 * telemetry with its line and the `cd` remedy and no help, as a missing --yes does, `up`, `down` and
 * `backup create` included, which crashed with Node's stack trace. Help there says the folder no
 * longer exists.
 *
 * Driven through the built binary in a sandboxed HOME, XDG_CONFIG_HOME and COTAL_HOME. Nothing is
 * started or deleted.
 *
 * Run: pnpm smoke:usage-format
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSuite } from "@cotal-ai/smoke-kit";

const BIN = join(import.meta.dirname, "..", "..", "..", "bin", "dist", "cotal.js");
if (!existsSync(BIN)) {
  console.error(`✗ ${BIN} missing - build first: pnpm --filter cotal-ai... build`);
  process.exit(1);
}

const { check, finish } = createSuite();
const home = mkdtempSync(join(tmpdir(), "cotal-usage-format-"));
const neutral = join(home, "neutral");
mkdirSync(neutral);
process.on("exit", () => rmSync(home, { recursive: true, force: true }));

const HOST_ENV = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("COTAL_") && k !== "FORCE_COLOR" && k !== "NO_COLOR"));
const env = { ...HOST_ENV, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, ".config"), COTAL_HOME: join(home, ".cotal"), COTAL_SKIP_CONNECTOR_SEED: "1", NO_COLOR: "1" };
const run = (args: string[], cwd = neutral) => {
  const r = spawnSync(process.execPath, [BIN, ...args], { cwd, env, encoding: "utf8", timeout: 120_000 });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
};
const shown = (r: ReturnType<typeof run>) => ({ status: r.status, stdout: r.stdout.slice(0, 600), stderr: r.stderr.slice(0, 900) });
const usageShape = (r: ReturnType<typeof run>, message: RegExp) =>
  r.status === 1 && r.stdout === "" && /^✗ /m.test(r.stderr) && message.test(r.stderr) && /Usage/.test(r.stderr) && !/Request refused|Code:/.test(r.stderr);

const parser = run(["status", "--bogus"]);
check("control: a parser usage error has the documented shape", usageShape(parser, /Unknown option '--bogus'/), shown(parser));

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
  const r = run([...args], project);
  check(`${args.join(" ")} without --yes prints its refusal and remedy without the help`, confirmShape(r, message, remedy), shown(r));
}

// A mistyped command, leading flag, subcommand or option names the nearest one; a word near nothing
// keeps the plain line.
for (const [args, message] of [
  [["stauts"], /unknown command: stauts - did you mean status\? Or run `cotal help` to list commands/],
  [["help", "stauts"], /unknown command: stauts - did you mean status\?/],
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

const json = run(["clean", "--json"]);
check("control: a command without JSON output still refuses --json as an unknown option", json.status === 1 && /Unknown option '--json'/.test(json.stderr), shown(json));

if (process.platform !== "win32") {
  // The shell enters a folder and removes it, so the CLI starts with a working folder that is gone.
  const fromRemoved = (args: string[]) => {
    const gone = mkdtempSync(join(home, "gone-"));
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
  for (const args of [["help"], []]) {
    const r = fromRemoved(args);
    check(`${["cotal", ...args].join(" ")} from a removed folder says the folder no longer exists, exit 0`,
      r.status === 0 && r.stdout.startsWith("This folder no longer exists, so commands that use a space refuse here. cd to an existing folder first.\n") && !/could not be read/.test(r.stdout), shown(r));
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
