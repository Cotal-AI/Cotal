/**
 * `--json`, `-j` and `--plain` may come before the command word, as the docs say. `cotal --json
 * status` and `cotal --no-input --json version` used to fail with "unknown command: --json",
 * `cotal --plain version` with "unknown command: --plain", and `cotal -- version` with "unknown
 * command: --". A leading output flag is now the command's own, so a command without that output
 * refuses it as it does after the command word. A command that takes its words raw has no flags to
 * read it as: `cotal --json __complete status` used to hand `__complete` the words `--json status`,
 * and it is now a usage error.
 *
 * Usage errors retain periods inside rejected words in both text and JSON.
 *
 * Driven through the built binary in a sandboxed HOME, XDG_CONFIG_HOME and COTAL_HOME. No broker is
 * started.
 *
 * Run: pnpm smoke:leading-output-flags
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

interface Envelope { command?: string; outcome?: string; error?: { code?: string; message?: string; remedy?: string } }

const { check, finish } = createSuite();
const home = mkdtempSync(join(tmpdir(), "cotal-leading-flags-"));
const neutral = join(home, "neutral");
mkdirSync(neutral);
process.on("exit", () => rmSync(home, { recursive: true, force: true }));

const HOST_ENV = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("COTAL_") && k !== "FORCE_COLOR" && k !== "NO_COLOR"));
const env = { ...HOST_ENV, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, ".config"), COTAL_HOME: join(home, ".cotal"), COTAL_SKIP_CONNECTOR_SEED: "1", NO_COLOR: "1" };
const run = (args: string[]) => {
  const r = spawnSync(process.execPath, [BIN, ...args], { cwd: neutral, env, encoding: "utf8", timeout: 120_000 });
  let envelope: Envelope | undefined;
  try { envelope = JSON.parse(r.stdout ?? "") as Envelope; } catch { envelope = undefined; }
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "", envelope };
};
const shown = (r: ReturnType<typeof run>) => ({ status: r.status, stdout: r.stdout.slice(0, 600), stderr: r.stderr.slice(0, 600) });

const after = run(["version", "--json"]);
check("control: version --json writes one envelope", after.status === 0 && after.envelope?.command === "version", shown(after));

for (const args of [["--json", "version"], ["-j", "version"], ["--no-input", "--json", "version"], ["--json", "--no-input", "version"]]) {
  const r = run(args);
  check(`cotal ${args.join(" ")} writes the version envelope`, r.status === 0 && r.envelope?.command === "version" && r.envelope.outcome === "ok", shown(r));
}

const status = run(["--json", "status"]);
check("cotal --json status writes the status envelope", (status.status === 0 || status.status === 4) && status.envelope?.command === "status", shown(status));

const plain = run(["--plain", "status"]);
check("cotal --plain status prints the plain report", (plain.status === 0 || plain.status === 4) && plain.stdout.length > 0 && !plain.stdout.trimStart().startsWith("{"), shown(plain));

const plainVersion = run(["--plain", "version"]), versionPlain = run(["version", "--plain"]);
check("cotal --plain version is refused as version --plain is: version has no plain output", plainVersion.status === 1 && /Unknown option '--plain'/.test(plainVersion.stderr) && versionPlain.status === 1 && /Unknown option '--plain'/.test(versionPlain.stderr), { before: shown(plainVersion), after: shown(versionPlain) });

const dottedMessage = "Unknown option '--js.on' - did you mean --json?";
for (const [args, diagnostic] of [
  [["version", "--js.on"], dottedMessage],
  [["version", "--jso"], "Unknown option '--jso' - did you mean --json?"],
  [["version", "-."], "Unknown option '-.'"],
  [["version", "value.with.dots"], "Unexpected argument 'value.with.dots'"],
] as const) {
  const r = run([...args]);
  check(`${args.join(" ")} keeps the full rejected word in its usage error`, r.status === 1 && r.stdout === ""
    && r.stderr.includes(diagnostic) && r.stderr.includes("Usage\n  cotal version"), shown(r));
}
const dottedJson = run(["version", "--js.on", "--json"]);
check("a JSON usage refusal keeps the dotted option name and suggestion", dottedJson.status === 1 && dottedJson.stderr === ""
  && dottedJson.envelope?.error?.code === "USAGE_INVALID" && dottedJson.envelope.error.message === dottedMessage, shown(dottedJson));
const dottedSend = run(["send", "--chan.nel"]);
check("a command with positionals keeps the dotted option name and its own remedy", dottedSend.status === 1 && dottedSend.stdout === ""
  && dottedSend.stderr.includes("Unknown option '--chan.nel' - did you mean --channel?") && dottedSend.stderr.includes("put -- before it")
  && !dottedSend.stderr.includes("To specify a positional argument"), shown(dottedSend));

// The manager group accepts positionals, but parsing the child command rejects the extra word.
for (const flags of [[], ["--plain"]]) {
  const r = run(["manager", "seats", "extra.word", ...flags]);
  check(`manager seats preserves the nested parse diagnostic${flags.length ? " under --plain" : ""}`, r.status === 1 && r.stdout === ""
    && r.stderr.includes("Unexpected argument 'extra.word'") && /Usage\r?\n +cotal manager seats/.test(r.stderr), shown(r));
}
for (const [word, message] of [
  ["mesh.example.com", "Unexpected argument 'mesh.example.com'"],
  ["--drain", "Unknown option '--drain'"],
] as const) {
  const r = run(["--json", "manager", "reconcile", word]);
  check(`manager reconcile ${word} keeps the nested parse diagnostic in JSON`, r.status === 1 && r.stderr === ""
    && r.envelope?.error?.code === "USAGE_INVALID" && r.envelope.error.message === message, shown(r));
}

const siblingOption = run(["--json", "manager", "seats", "--end.point=review.invalid"]);
check("manager seats points to its own help instead of suggesting reconcile's --endpoint or a positional", siblingOption.status === 1 && siblingOption.stderr === ""
  && siblingOption.envelope?.error?.code === "USAGE_INVALID" && siblingOption.envelope.error.message === "Unknown option '--end.point'"
  && siblingOption.envelope.error.remedy === "run `cotal help manager seats`", shown(siblingOption));
const siblingPlain = run(["mgr", "reconcile", "--plain", "--dr.ain"]);
check("manager reconcile does not suggest seats' --drain or a positional remedy", siblingPlain.status === 1 && siblingPlain.stdout === ""
  && siblingPlain.stderr.includes("Unknown option '--dr.ain'") && /Usage\r?\n +cotal manager reconcile/.test(siblingPlain.stderr)
  && !/did you mean|put -- before it/.test(siblingPlain.stderr), shown(siblingPlain));
const ownOption = run(["manager", "seats", "--dr.ain"]);
check("manager seats still suggests its own --drain", ownOption.status === 1 && ownOption.stdout === ""
  && ownOption.stderr.includes("Unknown option '--dr.ain' - did you mean --drain?") && !ownOption.stderr.includes("put -- before it"), shown(ownOption));

const dashes = run(["--", "version"]);
check("cotal -- version runs version", dashes.status === 0 && /\d+\.\d+\.\d+/.test(dashes.stdout), shown(dashes));

const afterDashes = run(["--", "--json"]);
check("after --, a flag is an ordinary word and names no command", afterDashes.status === 1 && /unknown command: --json/.test(afterDashes.stderr), shown(afterDashes));

const unknown = run(["--json", "frobnicate"]);
check("cotal --json frobnicate names the unknown command, not the flag", unknown.status === 1 && /frobnicate/.test(unknown.stdout + unknown.stderr) && !/unknown command: --json/.test(unknown.stderr), shown(unknown));

const bare = run(["--json"]);
check("an output flag with no command after it is a usage error, exit 1", bare.status === 1 && /--json needs a command after it/.test(bare.stderr), shown(bare));

const raw = run(["--json", "__complete", "status"]), rawPlain = run(["--plain", "start"]);
check("a leading output flag before a command that takes its words raw is a usage error, exit 1", raw.status === 1 && /--json before __complete is not read/.test(raw.stderr) && raw.stdout === "", shown(raw));
check("…the same before the raw `start` signpost", rawPlain.status === 1 && /--plain before start is not read/.test(rawPlain.stderr), shown(rawPlain));
const completed = run(["__complete", "status"]);
check("control: __complete still completes its own words", completed.status === 0, shown(completed));

const undeclared = run(["--json", "ext", "root"]), trailing = run(["ext", "root", "--json"]);
check("a mode without that output refuses the leading flag as it does after the word", undeclared.status === 1 && /has no --json or --plain/.test(undeclared.stderr) && trailing.status === 1 && /has no --json or --plain/.test(trailing.stderr), { before: shown(undeclared), after: shown(trailing) });

finish();
process.exit(process.exitCode ?? 0);
