/**
 * Every usage error has the one format the docs describe: the error, then any remedy, then the
 * command's help, all on stderr, nothing on stdout, exit 1. A command's own input checks used to
 * print a framed "Request refused … Code: USAGE_INVALID" block with no help; `clean` printed a bare
 * `usage:` line or a lowercase "refusing to clean store without --force"; and `help service nosuch`
 * refused without listing the subcommands. Under `--plain` or a locale without UTF-8, which have no
 * refusal mark, the error is the classified report instead, still followed by the help; it used to
 * print the `✗` mark under `--plain` and the `!` warning mark under such a locale.
 *
 * Driven through the built binary in a sandboxed HOME, XDG_CONFIG_HOME and COTAL_HOME. Nothing is
 * started or deleted.
 *
 * Run: pnpm smoke:usage-format
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
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

// The locale decides the refusal's shape, so the host's is replaced with a UTF-8 one.
const HOST_ENV = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("COTAL_") && !["FORCE_COLOR", "NO_COLOR", "LC_ALL", "LC_CTYPE"].includes(k)));
const env = { ...HOST_ENV, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, ".config"), COTAL_HOME: join(home, ".cotal"), COTAL_SKIP_CONNECTOR_SEED: "1", NO_COLOR: "1", LANG: "C.UTF-8" };
const run = (args: string[], extra: Record<string, string> = {}) => {
  const r = spawnSync(process.execPath, [BIN, ...args], { cwd: neutral, env: { ...env, ...extra }, encoding: "utf8", timeout: 120_000 });
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

const json = run(["clean", "--json"]);
check("control: a command without JSON output still refuses --json as an unknown option", json.status === 1 && /Unknown option '--json'/.test(json.stderr), shown(json));

if (process.platform !== "win32") {
  // The shell enters a folder and removes it, so the CLI starts with a working folder that is gone.
  const fromRemoved = (args: string[]) => {
    const gone = mkdtempSync(join(home, "gone-"));
    const r = spawnSync("/bin/sh", ["-c", 'cd "$1" && rmdir "$1" && shift && exec "$@"', "sh", gone, process.execPath, BIN, ...args], { cwd: neutral, env, encoding: "utf8", timeout: 120_000 });
    return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  };
  const removed = fromRemoved(["status"]);
  check("a command run from a removed folder has the usage shape and says the folder is gone", usageShape(removed, /this folder no longer exists/) && /cd to an existing folder/.test(removed.stderr), shown(removed));
  const removedJson = fromRemoved(["status", "--json"]);
  const envelope = removedJson.stdout.startsWith("{") ? JSON.parse(removedJson.stdout) : undefined;
  check("with --json it is a USAGE_INVALID refusal, not an unknown outcome", removedJson.status === 1 && envelope?.outcome === "refused" && envelope.error?.code === "USAGE_INVALID", shown(removedJson));
  const version = fromRemoved(["--version"]);
  check("version still answers from a removed folder", version.status === 0 && /^cotal-ai /.test(version.stdout), shown(version));
}

finish();
process.exit(process.exitCode ?? 0);
