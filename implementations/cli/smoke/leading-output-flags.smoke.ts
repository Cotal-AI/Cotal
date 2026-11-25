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
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSuite } from "@cotal-ai/smoke-kit";
import type { StreamRecord } from "@cotal-ai/workspace";

const BIN = join(import.meta.dirname, "..", "..", "..", "bin", "dist", "cotal.js");
if (!existsSync(BIN)) {
  console.error(`✗ ${BIN} missing - build first: pnpm --filter cotal-ai... build`);
  process.exit(1);
}

interface Envelope { schemaVersion?: number; command?: string; outcome?: string; error?: { code?: string; message?: string; remedy?: string }; warnings?: { code?: string; message?: string }[] }

const { check, finish } = createSuite();
const home = mkdtempSync(join(tmpdir(), "cotal-leading-flags-"));
const neutral = join(home, "neutral");
const runtime = join(home, "runtime");
mkdirSync(neutral);
mkdirSync(runtime, { mode: 0o700 });
process.on("exit", () => rmSync(home, { recursive: true, force: true }));

const HOST_ENV = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("COTAL_") && k !== "FORCE_COLOR" && k !== "NO_COLOR"));
const env = { ...HOST_ENV, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, ".config"), XDG_RUNTIME_DIR: runtime, COTAL_HOME: join(home, ".cotal"), COTAL_SKIP_CONNECTOR_SEED: "1", COTAL_NO_UPDATE_CHECK: "1", DO_NOT_TRACK: "1", NO_COLOR: "1" };
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

const collisionConfig = join(home, "retained-collision");
const collisionRoot = join(collisionConfig, "cotal", "extensions");
const collisionManifest = join(collisionRoot, "extensions.json");
const collisionFixture = JSON.stringify({ extensions: [{ pkg: "output-fixture", spec: "output-fixture@1.0.0", version: "1.0.0", commands: [{ name: "config", summary: "Test a retained command collision" }] }] });
mkdirSync(collisionRoot, { recursive: true });
writeFileSync(collisionManifest, collisionFixture);
const missingKey = ["config", "get", "missing-key"];
const collisionRefusal = run([...missingKey, "--json"], collisionConfig);
const collisionWarnings = collisionRefusal.envelope?.warnings;
check("finite JSON refusal carries the retained extension collision once", collisionRefusal.status === 1 && collisionRefusal.stderr === "" &&
  collisionRefusal.envelope?.command === "config" && collisionRefusal.envelope.outcome === "refused" &&
  collisionRefusal.envelope.error?.code === "USAGE_INVALID" && collisionRefusal.envelope.error.message?.includes('unknown preference "missing-key"') === true &&
  collisionWarnings?.length === 1 && collisionWarnings[0]?.code === "EXTENSION_COMMAND_COLLISION" &&
  collisionWarnings[0].message?.includes("output-fixture@1.0.0") === true && readFileSync(collisionManifest, "utf8") === collisionFixture, shown(collisionRefusal));
const collisionText = run(missingKey, collisionConfig);
check("text refusal keeps the retained extension collision on stderr", collisionText.status === 1 && collisionText.stdout === "" &&
  collisionText.stderr.includes("output-fixture@1.0.0"), shown(collisionText));
const collisionParse = run(["--json", "config", "get", "color", "--unknown-option"], collisionConfig);
check("JSON parser refusal carries the retained extension collision", collisionParse.status === 1 && collisionParse.stderr === "" &&
  collisionParse.envelope?.error?.code === "USAGE_INVALID" && collisionParse.envelope.warnings?.[0]?.code === "EXTENSION_COMMAND_COLLISION", shown(collisionParse));
const collisionSuccess = run(["cfg", "get", "color", "-j"], collisionConfig);
check("JSON success keeps the built-in alias and the retained extension warning", collisionSuccess.status === 0 && collisionSuccess.stderr === "" &&
  collisionSuccess.envelope?.command === "config" && collisionSuccess.envelope.outcome === "ok" &&
  collisionSuccess.envelope.warnings?.[0]?.code === "EXTENSION_COMMAND_COLLISION", shown(collisionSuccess));
for (const args of [["history", "general"], ["channel", "members", "general"]]) {
  const finite = run([...args, "--json", "--follow=false"], collisionConfig);
  check(`${args.join(" ")} keeps the collision in its finite JSON refusal`, finite.status === 1 && finite.stderr === "" &&
    finite.envelope?.error?.code === "USAGE_INVALID" && finite.envelope.warnings?.[0]?.code === "EXTENSION_COMMAND_COLLISION", shown(finite));
  const stream = run([...args, "--json", "--follow", "--follow=false"], collisionConfig);
  check(`${args.join(" ")} keeps the collision on stderr for its JSON stream refusal`, stream.status === 1 &&
    stream.envelope === undefined && stream.stdout.includes('"type":"error"') && stream.stdout.includes('"type":"end"') &&
    stream.stderr.includes("output-fixture@1.0.0"), shown(stream));
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

const search = ["docs", "--search", "structured output", "--json"];
for (const flag of ["--no-input", "--no-color"]) {
  const bad = `${flag}=false`;
  for (const args of [[bad, ...search], [...search.slice(0, -1), bad, "--json"]]) {
    const r = run(args);
    check(`${args.join(" ")} says how to pass the switch`, r.status === 1 && r.stderr === "" &&
      r.envelope?.command === "docs" && r.envelope.outcome === "refused" && r.envelope.error?.code === "USAGE_INVALID" &&
      r.envelope.error.message === `${flag} takes no value` && r.envelope.error.remedy === `omit ${flag} or pass it without a value`, shown(r));
  }
  const bareSwitch = run([flag, ...search]);
  const omitted = run(search);
  check(`passing ${flag} without a value or omitting it runs the same search`, bareSwitch.status === 0 && omitted.status === 0 &&
    bareSwitch.stderr === "" && omitted.stderr === "" && bareSwitch.envelope?.outcome === "ok" && bareSwitch.stdout === omitted.stdout, shown(bareSwitch));
}

const malformedText = run(["--no-input=", ...search.slice(0, -1)]);
check("an empty attached value still gets the switch remedy in text", malformedText.status === 1 && malformedText.stdout === "" &&
  malformedText.stderr.includes("--no-input takes no value") && malformedText.stderr.includes("omit --no-input or pass it without a value"), shown(malformedText));

const literalGlobal = run([...search, "--", "--no-input=false"]);
check("after -- an attached global value is still a page word", literalGlobal.status === 1 && literalGlobal.stderr === "" &&
  literalGlobal.envelope?.error?.message === "give a page or --search, not both", shown(literalGlobal));
const literalSearch = run(["docs", "--search=--no-input=false", "--json"]);
check("an attached search value can look like a malformed global flag", literalSearch.status === 0 && literalSearch.envelope?.outcome === "ok", shown(literalSearch));
const rawGlobal = run(["__complete", "status", "--no-input=false"]);
check("a command that takes its words raw still accepts the word", rawGlobal.status === 0, shown(rawGlobal));

const undeclared = run(["--json", "ext", "root"]), trailing = run(["ext", "root", "--json"]);
check("a mode without that output refuses the leading flag as it does after the word", undeclared.status === 1 && /has no --json or --plain/.test(undeclared.stderr) && trailing.status === 1 && /has no --json or --plain/.test(trailing.stderr), { before: shown(undeclared), after: shown(trailing) });

for (const { args, command, status, code } of [
  { args: ["backup", "inspect", "./not-there", "--json"], command: "backup inspect", status: 2, code: "TARGET_NOT_FOUND" },
  { args: ["--json", "backup", "verify", "./not-there"], command: "backup verify", status: 2, code: "TARGET_NOT_FOUND" },
  { args: ["backup", "--store-dir", "", "create", "./artifact", "--json"], command: "backup create", status: 1, code: "USAGE_INVALID" },
  { args: ["backup", "restore", "--json"], command: "backup restore", status: 1, code: "USAGE_INVALID" },
  { args: ["backup", "recover", "--json"], command: "backup recover", status: 1, code: "USAGE_INVALID" },
  { args: ["backup", "cleanup-fallback", "--json"], command: "backup cleanup-fallback", status: 1, code: "USAGE_INVALID" },
  { args: ["backup", "unknown", "--json"], command: "backup", status: 1, code: "USAGE_INVALID" },
]) {
  const r = run(args);
  check(`${args.join(" ")} identifies its operation in the refusal`, r.status === status && r.stderr === "" &&
    r.envelope?.command === command && r.envelope.outcome === "refused" && r.envelope.error?.code === code, shown(r));
}

const dashFlag = "\u2013\u2013no-color";
const dashRefusal = {
  code: "USAGE_INVALID",
  message: `${dashFlag} starts with a typographic dash, so it is not an option`,
  remedy: "type the option with hyphens: --no-color",
};
const configJson = ["config", "get", "harness", "--json"];
const asciiConfig = run(["--no-color", ...configJson]);
check("control: an ASCII leading global runs config get", asciiConfig.status === 0 && asciiConfig.stderr === "" &&
  asciiConfig.envelope?.command === "config" && asciiConfig.envelope.outcome === "ok", shown(asciiConfig));
for (const args of [
  [...configJson, dashFlag], [dashFlag, ...configJson], ["-j", dashFlag, "cfg", "get", "harness"],
  [dashFlag, "--no-input=0", ...configJson],
]) {
  const r = run(args);
  check(`${args.join(" ")} writes one JSON dash refusal`, r.status === 1 && r.stderr === "" && r.envelope?.schemaVersion === 1 && r.envelope.command === "config" &&
    r.envelope.outcome === "refused" && r.envelope.error?.code === dashRefusal.code && r.envelope.error.message === dashRefusal.message &&
    r.envelope.error.remedy === dashRefusal.remedy, shown(r));
}
const mixedPrefix = ["--no-input=0", "\u2212no-color", "-j", "\u2014no-input", "--"];
const mixed = run([...mixedPrefix, "cfg", "get", "harness"]);
check("multiple malformed flags keep the first diagnostic and a JSON flag between them", mixed.status === 1 && mixed.stderr === "" &&
  mixed.envelope?.schemaVersion === 1 && mixed.envelope.command === "config" && mixed.envelope.outcome === "refused" &&
  mixed.envelope.error?.code === "USAGE_INVALID" && mixed.envelope.error.message === "--no-input takes no value" &&
  mixed.envelope.error.remedy === "omit --no-input or pass it without a value", shown(mixed));
for (const [args, message] of [
  [[dashFlag, "config", "get", "harness", "--", "--json"], dashRefusal.message],
  [[dashFlag, "__complete", "--json"], dashRefusal.message],
  [["--", dashFlag, ...configJson], dashRefusal.message],
  [[...mixedPrefix, dashFlag, ...configJson], "--no-input takes no value"],
  [[dashFlag, "--unknown", ...configJson], dashRefusal.message],
] as const) {
  const r = run([...args]);
  check(`${args.join(" ")} keeps the diagnostic on stderr`, r.status === 1 && r.stdout === "" && r.stderr.includes(message), shown(r));
}

function refusalRecords(stdout: string): StreamRecord<Record<string, unknown>>[] {
  try { return stdout.trim().split("\n").map((line) => JSON.parse(line) as StreamRecord<Record<string, unknown>>); }
  catch { return []; }
}

for (const { words, stream } of [
  { words: ["watch"], stream: "watch" },
  { words: ["history", "general", "--follow"], stream: "history" },
  { words: ["channel", "members", "general", "--follow"], stream: "membership" },
]) {
  const first = "\u2212no-input";
  const stacked = { ...dashRefusal, message: `${first} starts with a typographic dash, so it is not an option`, remedy: "type the option with hyphens: --no-input" };
  for (const { args, expected } of [
    { args: [...words, "--json", dashFlag], expected: dashRefusal },
    { args: [dashFlag, ...words, "--json"], expected: dashRefusal },
    { args: [first, "\u2014no-color", ...words, "-j"], expected: stacked },
  ]) {
    const r = run(args);
    const records = refusalRecords(r.stdout);
    const [error, end] = records;
    check(`${args.join(" ")} writes only ${stream} error and end records`, r.status === 1 && r.stderr === "" && records.length === 2 &&
      error?.schemaVersion === 1 && error.stream === stream && error.type === "error" && error.data?.code === expected.code &&
      error.data.message === expected.message && error.data.remedy === expected.remedy && end?.schemaVersion === 1 &&
      end.stream === stream && end.type === "end" && end.data?.reason === "setup-failed", shown(r));
  }
}

const broker = ["service", "start", "broker"];
const brokerHelp = run([...broker, "--help"]);
const brokerRefusal = "✗ --no-color takes no value\n  omit --no-color or pass it without a value\n";
check("control: broker start help lists its preset options", brokerHelp.status === 0 && brokerHelp.stderr === "" &&
  ["--root <dir>", "--config <file>", "--binary <file>", "--server <url>", "--log-file <path>"].every((flag) =>
    brokerHelp.stdout.split("\n").some((line) => line.trimStart().startsWith(flag))), shown(brokerHelp));
for (const args of [[...broker, "--no-color=false"], ["--no-color=false", ...broker]]) {
  const r = run(args);
  check(`${args.join(" ")} refuses with the same broker preset help`, r.status === 1 && r.stdout === "" &&
    r.stderr === brokerRefusal + brokerHelp.stdout, shown(r));
}
for (const prefix of [["--no-color=false"], ["--no-input=0", "--no-color=false"]]) {
  const brokerPlain = run([...broker, ...prefix, "--plain"]);
  const leadingBrokerPlain = run([...prefix, "svc", "start", "broker", "--plain"]);
  check(`${prefix.join(" ")} preserves broker preset help in plain output`, brokerPlain.status === 1 && leadingBrokerPlain.status === 1 &&
    brokerPlain.stdout === "" && leadingBrokerPlain.stdout === "" && brokerPlain.stderr.includes("USAGE_INVALID") &&
    leadingBrokerPlain.stderr === brokerPlain.stderr, { before: shown(leadingBrokerPlain), after: shown(brokerPlain) });
}

for (const { words, command } of [
  { words: [dashFlag, "inspect", "./not-there"], command: "backup inspect" },
  { words: [dashFlag, "verify", "./not-there"], command: "backup verify" },
  { words: [dashFlag, "--store-dir", "--only", "inspect", "restore"], command: "backup restore" },
  { words: ["\u2014dry-run", "\u2212y", "recover"], command: "backup recover" },
  { words: ["\u2014store-dir=inspect", "restore"], command: "backup restore" },
  { words: ["\u2014store-dir", "inspect", "restore"], command: "backup restore" },
  { words: ["\u2014store-dir", "--only", "inspect", "restore"], command: "backup restore" },
  { words: [dashFlag, "unknown", "verify"], command: "backup" },
  { words: [dashFlag, "--", "\u2014dry-run", "recover"], command: "backup" },
  { words: ["\u2014store-dir", "--", "inspect", "./not-there"], command: "backup inspect" },
]) {
  const r = run(["backup", "-j", ...words]);
  check(`backup -j ${words.join(" ")} keeps the typed-option refusal and attributes it`, r.status === 1 && r.stderr === "" &&
    r.envelope?.command === command && r.envelope.outcome === "refused" && r.envelope.error?.code === "USAGE_INVALID" &&
    r.envelope.error.message?.startsWith(`${words[0]} starts with a typographic dash`) === true, shown(r));
}

for (const { words, command, remedy } of [
  { words: ["--only", "inspect", "restore"], command: "backup restore", remedy: "write --store-dir <dir>" },
  { words: ["--", "--only", "inspect", "verify"], command: "backup", remedy: "write --store-dir <dir> before --" },
]) {
  const r = run(["backup", "-j", "--store-dir", ...words]);
  check(`backup -j --store-dir ${words.join(" ")} preserves the missing-value refusal`, r.status === 1 && r.stderr === "" &&
    r.envelope?.command === command && r.envelope.outcome === "refused" && r.envelope.error?.code === "USAGE_INVALID" &&
    r.envelope.error.message === "--store-dir needs a value" && r.envelope.error.remedy === remedy, shown(r));
}

const dashValue = run(["backup", "-j", "--store-dir", "\u2014only", "inspect", "./not-there"]);
check("a typographic-looking value after an ASCII string option stays a value", dashValue.status === 1 && dashValue.stderr === "" &&
  dashValue.envelope?.command === "backup inspect" && dashValue.envelope.outcome === "refused" &&
  dashValue.envelope.error?.code === "USAGE_INVALID" &&
  dashValue.envelope.error.message === "backup inspection and verification accept no creation, target or restore inputs", shown(dashValue));

const dashAfterVerb = run(["backup", "verify", dashFlag, "./not-there", "-j"]);
check("a typographic flag after the backup verb keeps the same refusal", dashAfterVerb.status === 1 && dashAfterVerb.stderr === "" &&
  dashAfterVerb.envelope?.command === "backup verify" && dashAfterVerb.envelope.error?.code === "USAGE_INVALID" &&
  dashAfterVerb.envelope.error.message?.startsWith(`${dashFlag} starts with a typographic dash`) === true, shown(dashAfterVerb));

finish();
process.exit(process.exitCode ?? 0);
