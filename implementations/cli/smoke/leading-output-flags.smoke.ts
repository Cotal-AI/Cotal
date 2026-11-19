/**
 * `--json`, `-j` and `--plain` may come before the command word, as the docs say. `cotal --json
 * status` and `cotal --no-input --json version` used to fail with "unknown command: --json",
 * `cotal --plain version` with "unknown command: --plain", and `cotal -- version` with "unknown
 * command: --". A leading output flag is now the command's own, so a command without that output
 * refuses it as it does after the command word. A command that takes its words raw has no flags to
 * read it as: `cotal --json __complete status` used to hand `__complete` the words `--json status`,
 * and it is now a usage error.
 *
 * Driven through the built binary in a sandboxed HOME, XDG_CONFIG_HOME and COTAL_HOME. No broker is
 * started.
 *
 * Run: pnpm smoke:leading-output-flags
 */
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSuite } from "@cotal-ai/smoke-kit";

const BIN = join(import.meta.dirname, "..", "..", "..", "bin", "dist", "cotal.js");
if (!existsSync(BIN)) {
  console.error(`✗ ${BIN} missing - build first: pnpm --filter cotal-ai... build`);
  process.exit(1);
}

interface Envelope { command?: string; outcome?: string; error?: { code?: string; message?: string }; warnings?: { code?: string }[] }

const { check, finish } = createSuite();
const home = mkdtempSync(join(tmpdir(), "cotal-leading-flags-"));
const neutral = join(home, "neutral");
mkdirSync(neutral);
process.on("exit", () => rmSync(home, { recursive: true, force: true }));

const HOST_ENV = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("COTAL_") && k !== "FORCE_COLOR" && k !== "NO_COLOR"));
const env = { ...HOST_ENV, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, ".config"), COTAL_HOME: join(home, ".cotal"), COTAL_SKIP_CONNECTOR_SEED: "1", NO_COLOR: "1" };
const run = (args: string[], config = env.XDG_CONFIG_HOME) => {
  const r = spawnSync(process.execPath, [BIN, ...args], { cwd: neutral, env: { ...env, XDG_CONFIG_HOME: config }, encoding: "utf8", timeout: 120_000 });
  let envelope: Envelope | undefined;
  try { envelope = JSON.parse(r.stdout ?? "") as Envelope; } catch { envelope = undefined; }
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "", envelope };
};
const shown = (r: ReturnType<typeof run>) => ({ status: r.status, stdout: r.stdout.slice(0, 600), stderr: r.stderr.slice(0, 600) });

const after = run(["version", "--json"]);
check("control: version --json writes one envelope", after.status === 0 && after.envelope?.command === "version", shown(after));

const duplicateInput = "Option '--no-input' cannot be repeated";
const jsonDuplicate = (r: ReturnType<typeof run>, command: string) => r.status === 1 && r.stderr === "" &&
  r.envelope?.command === command && r.envelope.outcome === "refused" && r.envelope.error?.code === "USAGE_INVALID" &&
  r.envelope.error.message === duplicateInput;
for (const args of [
  ["--json", "--no-input", "--no-input", "version"],
  ["--no-input", "--no-input", "-j", "--", "-V"],
  ["--no-input", "version", "--no-input", "--json"],
  ["version", "--no-input", "--no-input", "--json"],
]) {
  const r = run(args);
  check(`${args.join(" ")} preserves the JSON refusal`, jsonDuplicate(r, "version"), shown(r));
}

const configHelp = run(["config", "get", "--help"]);
check("config get help is scoped", configHelp.status === 0 && configHelp.stdout.includes("cotal config get <key>") && !configHelp.stdout.includes("--verbose"), shown(configHelp));
for (const args of [
  ["config", "get", "harness", "--no-input", "--no-input"],
  ["--no-input", "--no-input", "cfg", "get", "harness", "--", "--json", "--plain"],
]) {
  const r = run(args);
  check(`${args.join(" ")} refuses with the exact subcommand help`, r.status === 1 && r.stdout === "" &&
    r.stderr === `✗ ${duplicateInput}\n${configHelp.stdout}`, shown(r));
}

const brokenConfig = join(home, "broken-config");
mkdirSync(join(brokenConfig, "cotal", "extensions"), { recursive: true });
writeFileSync(join(brokenConfig, "cotal", "extensions", "extensions.json"), "invalid manifest\n");
const managerDuplicate = run(["manager", "--runtime", "pty", "start", "--dry-run", "--no-input", "--no-input"], brokenConfig);
check("unreadable preset inventory does not hide the manager lifecycle verb", managerDuplicate.status === 1 &&
  managerDuplicate.stdout === "" && managerDuplicate.stderr.startsWith(`✗ ${duplicateInput}\ncotal manager start\n`), shown(managerDuplicate));

for (const placement of ["leading", "trailing"]) {
  const config = join(home, `promotion-${placement}`), cotal = join(config, "cotal");
  const root = join(cotal, "extensions"), stage = join(cotal, ".extensions.stage-probe.ready");
  const old = join(cotal, ".extensions.rollback-probe"), journal = join(cotal, ".extensions-promotion.json");
  mkdirSync(stage, { recursive: true });
  writeFileSync(join(stage, "extensions.json"), JSON.stringify({ extensions: [{ pkg: "duplicate-probe", spec: "duplicate-probe", version: "1.0.0", commands: [{
    name: "duplicate-probe", aliases: ["dup-probe"], summary: "Test promoted command metadata", flags: [{ name: "json", short: "j", type: "boolean" }], outputs: ["json"],
  }, { name: "config", summary: "Test a built-in name collision" }] }] }));
  const stat = lstatSync(stage);
  writeFileSync(journal, JSON.stringify({ v: 1, root, stage, old, stageIdentity: { dev: String(stat.dev), ino: String(stat.ino), birth: stat.birthtimeMs } }), { mode: 0o600 });
  const global = ["--no-input", "--no-input"];
  const args = placement === "leading" ? [...global, "dup-probe", "-j"] : ["dup-probe", ...global, "-j"];
  const r = run(args, config);
  check(`${placement} duplicates use the promoted alias grammar on the first invocation`, jsonDuplicate(r, "duplicate-probe") &&
    r.envelope?.warnings?.some((warning) => warning.code === "EXTENSION_COMMAND_COLLISION") === true &&
    !existsSync(journal) && existsSync(root), shown(r));
}

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
