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
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSuite } from "@cotal-ai/smoke-kit";

const BIN = join(import.meta.dirname, "..", "..", "..", "bin", "dist", "cotal.js");
if (!existsSync(BIN)) {
  console.error(`✗ ${BIN} missing - build first: pnpm --filter cotal-ai... build`);
  process.exit(1);
}

interface Envelope { command?: string; outcome?: string; error?: { code?: string; message?: string; remedy?: string }; warnings?: { code?: string; message?: string }[] }

const { check, finish } = createSuite();
const home = mkdtempSync(join(tmpdir(), "cotal-leading-flags-"));
const neutral = join(home, "neutral");
mkdirSync(neutral);
process.on("exit", () => rmSync(home, { recursive: true, force: true }));

const HOST_ENV = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("COTAL_") && k !== "FORCE_COLOR" && k !== "NO_COLOR"));
const env = { ...HOST_ENV, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, ".config"), COTAL_HOME: join(home, ".cotal"), COTAL_SKIP_CONNECTOR_SEED: "1", DO_NOT_TRACK: "1", NO_COLOR: "1" };
const run = (args: string[], config = env.XDG_CONFIG_HOME, extra: Record<string, string> = {}) => {
  const r = spawnSync(process.execPath, [BIN, ...args], { cwd: neutral, env: { ...env, XDG_CONFIG_HOME: config, ...extra }, encoding: "utf8", timeout: 120_000 });
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
  ["--no-input", "--no-input", "--plain=false", "version", "--json"],
  ["--no-input", "--plain=false", "--no-input", "-j", "-V"],
  ["--no-input", "version", "--no-input", "--json"],
  ["version", "--no-input", "--no-input", "--json"],
]) {
  const r = run(args);
  check(`${args.join(" ")} preserves the JSON refusal`, jsonDuplicate(r, "version"), shown(r));
}
const literalJson = run(["--no-input", "--no-input", "--plain=false", "version", "--", "--json"]);
check("a duplicate with a valued leading switch ignores literal --json", literalJson.status === 1 &&
  literalJson.stdout === "" && literalJson.stderr === `✗ ${duplicateInput}\n`, shown(literalJson));

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
for (const [args, message] of [
  [["--no-input=false", "config", "get", "harness", "--json"], "--no-input takes no value"],
  [["config", "get", "harness", "--no-input=false", "--json"], "--no-input takes no value"],
  [["--no-input", "config", "get", "harness", "--no-input", "--json"], duplicateInput],
  [["--no-input", "--no-input", "--plain=false", "config", "get", "harness", "--json"], duplicateInput],
] as const) {
  const r = run([...args], collisionConfig);
  check(`${args.join(" ")} carries the retained collision once in the refusal`, r.status === 1 && r.stderr === "" &&
    r.envelope?.command === "config" && r.envelope.outcome === "refused" && r.envelope.error?.code === "USAGE_INVALID" &&
    r.envelope.error.message === message && r.envelope.warnings?.length === 1 &&
    r.envelope.warnings[0]?.code === "EXTENSION_COMMAND_COLLISION" && r.envelope.warnings[0].message?.includes("output-fixture@1.0.0") === true &&
    readFileSync(collisionManifest, "utf8") === collisionFixture, shown(r));
}
const collisionText = run(missingKey, collisionConfig);
check("text refusal keeps the retained extension collision on stderr", collisionText.status === 1 && collisionText.stdout === "" &&
  collisionText.stderr.includes("output-fixture@1.0.0"), shown(collisionText));
const forcedColor = { FORCE_COLOR: "1", NO_COLOR: "" };
const collisionPlain = run(["config", "get", "harness", "--plain"], collisionConfig, forcedColor);
const collisionPlainRefusal = run(["--plain", ...missingKey], collisionConfig, forcedColor);
const collisionRich = run(["config", "get", "harness"], collisionConfig, forcedColor);
const collisionLine = collisionRich.stderr.split("\n")[0] ?? "";
const uncoloredCollision = collisionLine.replace(/\u001b\[\d+m/g, "");
check("rich output still colors the collision warning under FORCE_COLOR", collisionRich.status === 0 && collisionLine.startsWith("\u001b[31m") &&
  uncoloredCollision.startsWith('! command "config"') && ["cotal", "pnpm cotal"].some((cli) => uncoloredCollision.includes(`\`${cli} ext remove output-fixture\``)), shown(collisionRich));
check("plain success keeps the same warning without ANSI escapes under FORCE_COLOR", collisionPlain.status === 0 && collisionPlain.stdout.includes("Preference - harness") &&
  !collisionPlain.stdout.includes("\u001b") && collisionPlain.stderr === `${uncoloredCollision}\n`, shown(collisionPlain));
check("plain refusal keeps the same warning without ANSI escapes under FORCE_COLOR", collisionPlainRefusal.status === 1 && collisionPlainRefusal.stdout === "" &&
  collisionPlainRefusal.stderr.startsWith(`${uncoloredCollision}\nRequest refused\n`) && !collisionPlainRefusal.stderr.includes("\u001b"), shown(collisionPlainRefusal));
const collisionLiteral = run(["config", "get", "--", "--plain"], collisionConfig, forcedColor);
check("--plain after -- does not turn off collision warning color", collisionLiteral.status === 1 &&
  collisionLiteral.stderr.startsWith(`${collisionLine}\n`), shown(collisionLiteral));
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
  const follow = [...args, "--json", "--follow"];
  for (const streamArgs of [[...follow, "--follow=false"], ["--no-input=false", ...follow], ["--no-input", ...follow, "--no-input"]]) {
    const stream = run(streamArgs, collisionConfig);
    check(`${streamArgs.join(" ")} keeps the collision on stderr for its JSON stream refusal`, stream.status === 1 &&
      stream.envelope === undefined && stream.stdout.includes('"type":"error"') && stream.stdout.includes('"type":"end"') &&
      stream.stderr.includes("output-fixture@1.0.0"), shown(stream));
  }
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

const malformedVersion = run(["--plain=true", "--json", "version"]);
check("the version receipt tells you to omit the unsupported --plain flag", malformedVersion.status === 1 && malformedVersion.stderr === "" &&
  malformedVersion.envelope?.command === "version" && malformedVersion.envelope.outcome === "refused" &&
  malformedVersion.envelope.error?.code === "USAGE_INVALID" && malformedVersion.envelope.error.message === "--plain takes no value" &&
  malformedVersion.envelope.error.remedy === "omit --plain", shown(malformedVersion));
const retryVersion = run(["--json", "version"]);
check("dropping the unsupported flag returns the JSON version receipt", retryVersion.status === 0 && retryVersion.stderr === "" &&
  retryVersion.envelope?.command === "version" && retryVersion.envelope.outcome === "ok", shown(retryVersion));
const malformedVersionCollision = run(["--plain=true", "--json", "version"], collisionConfig);
check("a malformed leading output flag keeps the unsupported-flag remedy and collision warning together", malformedVersionCollision.status === 1 &&
  malformedVersionCollision.stderr === "" && malformedVersionCollision.envelope?.command === "version" &&
  malformedVersionCollision.envelope.error?.code === "USAGE_INVALID" && malformedVersionCollision.envelope.error.remedy === "omit --plain" &&
  malformedVersionCollision.envelope.warnings?.length === 1 && malformedVersionCollision.envelope.warnings[0]?.code === "EXTENSION_COMMAND_COLLISION",
  shown(malformedVersionCollision));

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

const helpPage = run(["help", "--help"]);
const valuedHelp = run(["help", "--help=false"]);
check("a value on the help switch names the bare switch, not a positional", valuedHelp.status === 1 && valuedHelp.stdout === "" &&
  valuedHelp.stderr.startsWith("✗ --help takes no value\n") &&
  ["cotal", "pnpm cotal"].some((cli) => valuedHelp.stderr.includes(`  run \`${cli} help --help\`\n`)) &&
  !valuedHelp.stderr.includes("put -- before it") && !valuedHelp.stderr.includes("Unknown option") &&
  valuedHelp.stderr.endsWith(helpPage.stdout), shown(valuedHelp));
const separatedHelp = run(["help", "--", "--help=false"]);
check("after -- a valued help switch stays a command name", separatedHelp.status === 1 && separatedHelp.stdout === "" &&
  /unknown command: --help=false/.test(separatedHelp.stderr) && !separatedHelp.stderr.includes("--help takes no value"), shown(separatedHelp));
check("the bare help switch still prints the help page", helpPage.status === 0 && helpPage.stderr === "" && helpPage.stdout.length > 0, shown(helpPage));

for (const [flag, ...tail] of [
  ["--no-color", "--no-input=false", "status", "--json"],
  ["--no-input", "-j", "--no-color=false", "--", "status"],
]) {
  const args = [`${flag}=false`, ...tail];
  const r = run(args);
  check(`${args.join(" ")} preserves the first error in JSON`, r.status === 1 && r.stderr === "" &&
    r.envelope?.command === "status" && r.envelope.outcome === "refused" && r.envelope.error?.code === "USAGE_INVALID" &&
    r.envelope.error.message === `${flag} takes no value` && r.envelope.error.remedy === `omit ${flag} or pass it without a value`, shown(r));
}

const malformedWithLiteralJson = run(["--no-color=false", "--no-input=false", "status", "--", "--json"]);
check("a literal --json does not set the format of a malformed leading switch refusal", malformedWithLiteralJson.status === 1 &&
  malformedWithLiteralJson.stdout === "" && malformedWithLiteralJson.stderr.includes("--no-color takes no value"), shown(malformedWithLiteralJson));

for (const [args, flag] of [
  [["--plain=false", "status", "--json"], "--plain"],
  [["--json=false", "status", "--json"], "--json"],
  [["--plain=false", "--json=false", "-j", "--", "s"], "--plain"],
  [["--json", "-j=false", "status"], "-j"],
] as const) {
  const r = run([...args]);
  const remedy = flag === "--plain" ? "omit --plain" : `omit ${flag} or pass it without a value`;
  check(`${args.join(" ")} preserves the JSON refusal`, r.status === 1 && r.stderr === "" &&
    r.envelope?.command === "status" && r.envelope.outcome === "refused" && r.envelope.error?.code === "USAGE_INVALID" &&
    r.envelope.error.message === `${flag} takes no value` && r.envelope.error.remedy === remedy, shown(r));
}

const retryStatus = run(["status", "--json"]);
check("omitting the malformed --plain flag returns the requested JSON status", retryStatus.status === 0 && retryStatus.stderr === "" &&
  retryStatus.envelope?.command === "status" && retryStatus.envelope.outcome === "ok", shown(retryStatus));

const malformedPlainOnly = run(["--plain=false", "status"]);
check("without JSON, the refusal still offers bare --plain", malformedPlainOnly.status === 1 && malformedPlainOnly.stdout === "" &&
  malformedPlainOnly.stderr.includes("omit --plain or pass it without a value"), shown(malformedPlainOnly));

const malformedOutput = run(["--json=false", "status", "--", "--json"]);
check("only a valid output switch before -- requests JSON", malformedOutput.status === 1 && malformedOutput.stdout === "" &&
  malformedOutput.stderr.includes("--json takes no value"), shown(malformedOutput));

const literalGlobal = run([...search, "--", "--no-input=false"]);
check("after -- an attached global value is still a page word", literalGlobal.status === 1 && literalGlobal.stderr === "" &&
  literalGlobal.envelope?.error?.message === "give a page or --search, not both", shown(literalGlobal));
const literalSearch = run(["docs", "--search=--no-input=false", "--json"]);
check("an attached search value can look like a malformed global flag", literalSearch.status === 0 && literalSearch.envelope?.outcome === "ok", shown(literalSearch));
const rawGlobal = run(["__complete", "status", "--no-input=false"]);
check("a command that takes its words raw still accepts the word", rawGlobal.status === 0, shown(rawGlobal));

const undeclared = run(["--json", "ext", "root"]), trailing = run(["ext", "root", "--json"]);
check("a mode without that output refuses the leading flag as it does after the word", undeclared.status === 1 && /has no --json or --plain/.test(undeclared.stderr) && trailing.status === 1 && /has no --json or --plain/.test(trailing.stderr), { before: shown(undeclared), after: shown(trailing) });
const malformedRoot = run(["--json=true", "ext", "root"]);
check("the remedy uses the subcommand's outputs, not the parent command's", malformedRoot.status === 1 && malformedRoot.stdout === "" &&
  malformedRoot.stderr.includes("--json takes no value") && malformedRoot.stderr.includes("omit --json") &&
  !malformedRoot.stderr.includes("pass it without a value"), shown(malformedRoot));

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
const secondDashFlag = "\u2013\u2013no-input";
const dashMessage = `${dashFlag} starts with a typographic dash, so it is not an option`;
const dashRemedy = "type the option with hyphens: --no-color";
const dashCollision = run([dashFlag, "config", "get", "harness", "--json"], collisionConfig);
check("a leading typographic flag keeps the dash diagnosis and collision warning in the same receipt", dashCollision.status === 1 &&
  dashCollision.stderr === "" && dashCollision.envelope?.command === "config" && dashCollision.envelope.outcome === "refused" &&
  dashCollision.envelope.error?.code === "USAGE_INVALID" && dashCollision.envelope.error.message === dashMessage &&
  dashCollision.envelope.error.remedy === dashRemedy && dashCollision.envelope.warnings?.length === 1 &&
  dashCollision.envelope.warnings[0]?.code === "EXTENSION_COMMAND_COLLISION" &&
  readFileSync(collisionManifest, "utf8") === collisionFixture, shown(dashCollision));
for (const args of [
  [dashFlag, "config", "get", "harness", "--json"],
  ["-j", dashFlag, "cfg", "get", "harness"],
  [dashFlag, "--json", "config", "get", "harness"],
]) {
  const r = run(args);
  check(`${args.join(" ")} keeps the dash diagnosis in a finite JSON refusal`, r.status === 1 && r.stderr === "" &&
    r.envelope?.command === "config" && r.envelope.outcome === "refused" && r.envelope.error?.code === "USAGE_INVALID" &&
    r.envelope.error.message === dashMessage && r.envelope.error.remedy === dashRemedy, shown(r));
}
const twoDashVersion = run([dashFlag, secondDashFlag, "version", "--json"]);
check("two leading typographic flags keep the first diagnosis in a version JSON refusal", twoDashVersion.status === 1 &&
  twoDashVersion.stderr === "" && twoDashVersion.envelope?.command === "version" && twoDashVersion.envelope.outcome === "refused" &&
  twoDashVersion.envelope.error?.code === "USAGE_INVALID" && twoDashVersion.envelope.error.message === dashMessage &&
  twoDashVersion.envelope.error.remedy === dashRemedy, shown(twoDashVersion));
const plainWords = "\u2013\u2013plain";
const dashPlainMessage = `${plainWords} starts with a typographic dash, so it is not an option`;
for (const second of ["\u2013\u2013help", "\u2013h", "\u2013\u2013version", "\u2013V"]) {
  const r = run([dashFlag, second, "version", "--json"]);
  check(`${dashFlag} ${second} version --json keeps the JSON refusal and reports the first flag`, r.status === 1 && r.stderr === "" &&
    r.envelope?.command === "version" && r.envelope.outcome === "refused" && r.envelope.error?.code === "USAGE_INVALID" &&
    r.envelope.error.message === dashMessage && r.envelope.error.remedy === dashRemedy, shown(r));
}
const jsonPlain = run(["status", "--json", plainWords]);
check("a mistyped plain option with --json says to omit it, not to retype it beside --json", jsonPlain.status === 1 &&
  jsonPlain.stderr === "" && jsonPlain.envelope?.command === "status" && jsonPlain.envelope.outcome === "refused" &&
  jsonPlain.envelope.error?.code === "USAGE_INVALID" && jsonPlain.envelope.error.message === dashPlainMessage &&
  jsonPlain.envelope.error.remedy === "omit the mistyped plain option", shown(jsonPlain));
const jsonLeadingPlain = run([plainWords, "status", "--json"]);
check("a leading mistyped plain option with --json gets the same omit remedy", jsonLeadingPlain.status === 1 &&
  jsonLeadingPlain.stderr === "" && jsonLeadingPlain.envelope?.command === "status" && jsonLeadingPlain.envelope.outcome === "refused" &&
  jsonLeadingPlain.envelope.error?.code === "USAGE_INVALID" && jsonLeadingPlain.envelope.error.message === dashPlainMessage &&
  jsonLeadingPlain.envelope.error.remedy === "omit the mistyped plain option", shown(jsonLeadingPlain));
for (const args of [
  [dashFlag, "config", "get", "harness", "--", "--json"],
  ["--json", "--", dashFlag, "config", "get", "harness"],
  [dashFlag, "ext", "root", "--json"],
  [dashFlag, secondDashFlag, "version", "--", "--json"],
  [dashFlag, "\u2013\u2013json", "version"],
  [dashFlag, "\u2013\u2013not-a-global", "version", "--json"],
]) {
  const r = run(args);
  check(`${args.join(" ")} keeps the dash diagnosis on stderr when JSON is not selected`, r.status === 1 && r.stdout === "" &&
    r.stderr.includes(dashMessage) && r.stderr.includes(dashRemedy), shown(r));
}
for (const [stream, ...words] of [
  ["watch", "watch"],
  ["watch", secondDashFlag, "watch"],
  ["history", "history", "general", "--follow"],
  ["membership", "channel", "members", "general", "--follow"],
]) {
  const r = run([dashFlag, ...words, "--json"]);
  const records = r.stdout.trim().split("\n").map((line) => {
    try { return JSON.parse(line); } catch { return undefined; }
  });
  const [error, end] = records;
  check(`${words.join(" ")} reports a leading dash error and ends the JSON stream`, r.status === 1 && r.stderr === "" &&
    records.length === 2 && error?.stream === stream && error.type === "error" && error.data?.code === "USAGE_INVALID" &&
    error.data.message === dashMessage && error.data.remedy === dashRemedy &&
    end?.stream === stream && end.type === "end" && end.data?.reason === "setup-failed", shown(r));
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

const scaffold = run(["endpoint", "init", "note", "--dir", "starter"]);
check("endpoint init creates the contract for the separator check", scaffold.status === 0, shown(scaffold));
if (scaffold.status === 0) {
  const contract = "starter/contract.json";
  for (const option of ["--file", "--server"]) {
    for (const flags of [[option, "--json"], ["--json", option]]) {
      const r = run(["endpoint", "check", contract, ...flags]);
      check(`endpoint check ${flags.join(" ")} tells the caller to omit ${option}`,
        r.status === 1 && r.stderr === "" && r.envelope?.command === "endpoint check" && r.envelope.outcome === "refused" &&
        r.envelope.error?.code === "USAGE_INVALID" && r.envelope.error.message === `\`endpoint check\` does not take ${option}` &&
        r.envelope.error.remedy === `omit ${option} and keep the contract path`, shown(r));
    }
  }
  const retry = run(["endpoint", "check", contract, "--json"]);
  check("endpoint check succeeds with the same contract and output mode after omitting --file",
    retry.status === 0 && retry.stderr === "" && retry.envelope?.command === "endpoint check" && retry.envelope.outcome === "ok", shown(retry));
  const add = run(["endpoint", "add", "note", "--file", "--json"]);
  check("endpoint add still asks for a missing reference filename",
    add.status === 1 && add.stderr === "" && add.envelope?.outcome === "refused" &&
    add.envelope.error?.code === "USAGE_INVALID" && add.envelope.error.message === "--file needs a value" &&
    add.envelope.error.remedy === "write --file <reference.json>", shown(add));

  copyFileSync(join(neutral, "starter", "contract.json"), join(neutral, "--plain"));
  const endpointCheck = (...args: string[]) => run(["endpoint", "check", ...args], undefined,
    { FORCE_COLOR: "1", NO_COLOR: "", LC_ALL: "C.UTF-8" });
  const separated = endpointCheck("--wibble", "--", "--plain");
  const prefixed = endpointCheck("--wibble", "./--plain");
  check("a filename after -- cannot switch a usage refusal to plain output",
    separated.status === 1 && prefixed.status === 1 && separated.stdout === "" && prefixed.stdout === "" &&
    separated.stderr === prefixed.stderr && separated.stderr.startsWith("\x1b[31m✗ Unknown option '--wibble'"),
    { separated: shown(separated), prefixed: shown(prefixed) });
  const explicit = endpointCheck("--plain", "--wibble", "--", "--plain");
  check("--plain before the separator still selects an uncolored usage refusal",
    explicit.status === 1 && explicit.stdout === "" && explicit.stderr.startsWith("Request refused\n") &&
    explicit.stderr.includes("USAGE_INVALID") && !explicit.stderr.includes("\x1b"), shown(explicit));
  const valid = endpointCheck("--", "--plain");
  check("endpoint check still accepts the file named --plain after the separator",
    valid.status === 0 && valid.stdout.includes("Endpoint contract valid locally") && valid.stdout.includes("\x1b[") && valid.stderr === "", shown(valid));
}

finish();
process.exit(process.exitCode ?? 0);
