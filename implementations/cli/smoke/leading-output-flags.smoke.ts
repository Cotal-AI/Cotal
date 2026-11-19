/**
 * `--json`, `-j` and `--plain` may come before the command word, as the docs say. `cotal --json
 * status` and `cotal --no-input --json version` used to fail with "unknown command: --json",
 * `cotal --plain version` with "unknown command: --plain", and `cotal -- version` with "unknown
 * command: --". A leading output flag is now the command's own, so a command without that output
 * refuses it as it does after the command word. A command that takes its words raw has no flags to
 * read it as: `cotal --json __complete status` used to hand `__complete` the words `--json status`,
 * and it is now a usage error.
 * Repeated global flags refuse using the requested output and the help of the invoked subcommand.
 *
 * Driven through the built binary in a sandboxed HOME, XDG_CONFIG_HOME and COTAL_HOME. No broker is
 * started.
 *
 * Run: pnpm smoke:leading-output-flags
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSuite } from "@cotal-ai/smoke-kit";
import { jsonFlag } from "@cotal-ai/workspace";

const BIN = join(import.meta.dirname, "..", "..", "..", "bin", "dist", "cotal.js");
if (!existsSync(BIN)) {
  console.error(`✗ ${BIN} missing - build first: pnpm --filter cotal-ai... build`);
  process.exit(1);
}

interface Envelope {
  schemaVersion?: number;
  command?: string;
  outcome?: string;
  completeness?: string;
  result?: unknown;
  error?: { code?: string; message?: string };
}

const { check, finish } = createSuite();
const home = mkdtempSync(join(tmpdir(), "cotal-leading-flags-"));
const neutral = join(home, "neutral");
mkdirSync(neutral);
process.on("exit", () => rmSync(home, { recursive: true, force: true }));

const HOST_ENV = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("COTAL_") && k !== "FORCE_COLOR" && k !== "NO_COLOR"));
const env = {
  ...HOST_ENV, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, ".config"), XDG_RUNTIME_DIR: home,
  COTAL_HOME: join(home, ".cotal"), COTAL_SKIP_CONNECTOR_SEED: "1", COTAL_NO_UPDATE_CHECK: "1",
  COTAL_TELEMETRY: "off", LC_ALL: "C.UTF-8", NO_COLOR: "1",
};
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
  check(`cotal ${args.join(" ")} writes the version envelope`, r.status === 0 && r.stderr === "" && r.envelope?.command === "version" && r.envelope.outcome === "ok", shown(r));
}

const duplicateInput = "Option '--no-input' cannot be repeated";
const jsonRefusal = (r: ReturnType<typeof run>, command: string) => r.status === 1 && r.stderr === "" &&
  r.envelope?.schemaVersion === 1 && r.envelope.command === command && r.envelope.outcome === "refused" &&
  r.envelope.completeness === "not-checked" && r.envelope.result === null &&
  r.envelope.error?.code === "USAGE_INVALID" && r.envelope.error.message === duplicateInput;
for (const args of [
  ["--json", "--no-input", "--no-input", "version"],
  ["version", "--no-input", "--no-input", "--json"],
  ["--no-input", "version", "--no-input", "--json"],
  ["--no-input", "--no-input", "-j", "--", "-V"],
]) {
  const r = run(args);
  check(`cotal ${args.join(" ")} refuses the repeated global flag in JSON`, jsonRefusal(r, "version"), shown(r));
}

const configGetHelp = run(["config", "get", "--help"]);
check("control: config get --help shows scoped options", configGetHelp.status === 0 && configGetHelp.stderr === "" &&
  configGetHelp.stdout.includes("cotal config get <key>") && !configGetHelp.stdout.includes("--verbose"), shown(configGetHelp));
const configGet = run(["config", "get", "harness", "--no-input"]);
check("control: config get with one global flag reads the preference", configGet.status === 0 && configGet.stderr === "" &&
  configGet.stdout.includes("Preference · harness") && configGet.stdout.includes("claude"), shown(configGet));

for (const args of [
  ["--no-input", "--no-input", "config", "get", "harness"],
  ["config", "get", "harness", "--no-input", "--no-input"],
  ["--no-input", "--no-input", "cfg", "get", "harness", "--", "--json", "--plain"],
]) {
  const r = run(args);
  check(`cotal ${args.join(" ")} refuses with config get help`, r.status === 1 && r.stdout === "" &&
    r.stderr === `✗ ${duplicateInput}\n${configGetHelp.stdout}`, shown(r));
}
const plainDuplicate = run(["--plain", "--no-input", "--no-input", "config", "get", "harness"]);
check("a leading duplicate preserves plain refusal formatting and scoped help", plainDuplicate.status === 1 &&
  plainDuplicate.stdout === "" && plainDuplicate.stderr.includes("Request refused") &&
  plainDuplicate.stderr.includes("USAGE_INVALID") && plainDuplicate.stderr.endsWith(configGetHelp.stdout), shown(plainDuplicate));

const status = run(["--json", "status"]);
check("cotal --json status writes the status envelope", (status.status === 0 || status.status === 4) && status.envelope?.command === "status", shown(status));

const plain = run(["--plain", "status"]);
check("cotal --plain status prints the plain report", (plain.status === 0 || plain.status === 4) && plain.stdout.length > 0 && !plain.stdout.trimStart().startsWith("{"), shown(plain));

const plainVersion = run(["--plain", "version"]), versionPlain = run(["version", "--plain"]);
check("cotal --plain version is refused as version --plain is: version has no plain output", plainVersion.status === 1 && /Unknown option '--plain'/.test(plainVersion.stderr) && versionPlain.status === 1 && /Unknown option '--plain'/.test(versionPlain.stderr), { before: shown(plainVersion), after: shown(versionPlain) });

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

// Cached help is enough to report a leading duplicate. Neither a package nor a recoverable
// installation is needed. The invalid journal would block a path that tried recovery first.
const config = join(env.XDG_CONFIG_HOME, "cotal");
const extensions = join(config, "extensions");
mkdirSync(extensions, { recursive: true });
writeFileSync(join(extensions, "extensions.json"), JSON.stringify({ extensions: [{
  pkg: "duplicate-probe", spec: "duplicate-probe", version: "1.0.0", commands: [{
    name: "duplicate-probe", summary: "Report the duplicate without loading a package", outputs: ["json"],
    flags: [jsonFlag],
  }],
}] }));
writeFileSync(join(config, ".extensions-promotion.json"), "invalid journal\n");
const extension = run(["--json", "--no-input", "--no-input", "duplicate-probe"]);
check("a leading duplicate uses installed command metadata without recovery or import", jsonRefusal(extension, "duplicate-probe"), shown(extension));

finish();
process.exit(process.exitCode ?? 0);
