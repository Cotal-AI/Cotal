/**
 * A classified failure raised after a command resolved its space is reported in that space.
 *
 * Many refusals deep in a command name no space in their target, so they printed no `Mesh:` line and
 * their JSON envelope had no `target.space`, although the operation's space was already resolved.
 * A single-space command now records that space once it resolves it, and the kernel adds it to a
 * later failure whose target has no `space` field.
 *
 * The kernel cells run the src kernel over a fixture command in a child, because a classified failure
 * ends the process. The persona cells run the built binary: `persona create` over an existing file
 * refuses with a target-less CONFLICT on a prepared space, and a `--file` the agent-file rules refuse
 * names the field and the reason, as does a role token `send -r` would refuse. An edit that is not
 * saved keeps its draft and names it, a malformed `--on` names the command to rerun, and no create
 * takes the seeded default's launch name. Removing the seeded default says so, and a launch preview
 * refuses a missing persona as the launch does. A managed preview exits 0, and both previews name
 * the persona's source in words. A direct preview refuses an unknown harness; a managed preview
 * warns because its execution host is not checked. A managed preview names its
 * `--runtime` and what this host said about it, and `--runtime auto` is refused before anything is
 * resolved. No broker is started.
 *
 * Run: pnpm smoke:operation-space
 */
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { agentFilePath } from "@cotal-ai/core";
import { createSuite } from "@cotal-ai/smoke-kit";
import { recordMesh } from "@cotal-ai/workspace";
import { execWords } from "../src/lib/exec-words.js";
import { installNoVariantConnector, NO_VARIANT_HARNESS } from "./_no-variant-connector.js";

const BIN = join(import.meta.dirname, "..", "..", "..", "bin", "dist", "cotal.js");
if (!existsSync(BIN)) {
  console.error(`✗ ${BIN} missing - build first: pnpm --filter cotal-ai... build`);
  process.exit(1);
}

interface Envelope {
  outcome: string;
  completeness?: string;
  result?: { requestedName?: string; name?: string; path?: string; definition?: { name?: string }; source?: string; kind?: string; allocated?: boolean; launched?: boolean; items?: { name: string; path: string; valid: boolean }[] };
  warnings?: { code: string; message: string; target: unknown }[];
  target: Record<string, unknown> | null;
  error?: { code: string; message?: string; remedy?: string };
}

const { check, finish } = createSuite();
const home = mkdtempSync(join(tmpdir(), "cotal-operation-space-"));
const root = realpathSync(mkdtempSync(join(home, "project-")));
process.on("exit", () => rmSync(home, { recursive: true, force: true }));
const HOST_ENV = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("COTAL_") && k !== "FORCE_COLOR" && k !== "NO_COLOR"));
const env: NodeJS.ProcessEnv & { XDG_CONFIG_HOME: string } = { ...HOST_ENV, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, ".config"), COTAL_HOME: join(home, ".cotal"), COTAL_SKIP_CONNECTOR_SEED: "1", DO_NOT_TRACK: "1", NO_COLOR: "1" };

const outcome = (r: ReturnType<typeof spawnSync>) => {
  const stdout = String(r.stdout ?? ""), stderr = String(r.stderr ?? "");
  let envelope: Envelope | undefined;
  try { envelope = JSON.parse(stdout) as Envelope; } catch { envelope = undefined; }
  return { status: r.status, stdout, stderr, envelope, first: stderr.split("\n")[0] };
};
const fixture = join(import.meta.dirname, "operation-space.fixture.ts");
const kernel = (...words: string[]) => outcome(spawnSync(process.execPath, [...process.execArgv, fixture, ...words], { cwd: root, env, encoding: "utf8", timeout: 60_000 }));
const cotalAt = (cwd: string, ...words: string[]) => outcome(spawnSync(process.execPath, [BIN, ...words], { cwd, env, encoding: "utf8", timeout: 120_000 }));
const cotal = (...words: string[]) => cotalAt(root, ...words);
const shown = (r: ReturnType<typeof kernel>) => ({ status: r.status, stdout: r.stdout.slice(0, 600), stderr: r.stderr.slice(0, 600) });
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

const bare = kernel("scoped", "--json", "--record", "s9", "--fail", "bare");
check("a target-less refusal after the record is refused, exit 2", bare.status === 2 && bare.envelope?.error?.code === "TARGET_NOT_FOUND", shown(bare));
check("its envelope target is the recorded space", same(bare.envelope?.target, { space: "s9" }), bare.envelope?.target);
check("under --json the envelope alone reports it, with nothing on stderr", bare.stderr === "", shown(bare));
const bareText = kernel("scoped", "--record", "s9", "--fail", "bare");
check("its report begins with Mesh: <space>", bareText.status === 2 && bareText.first === "Mesh: s9", shown(bareText));

const plain = kernel("scoped", "--plain", "--record", "s9", "--fail", "bare");
check("the plain report begins with Mesh: <space>", plain.status === 2 && plain.first === "Mesh: s9", shown(plain));

const named = kernel("scoped", "--json", "--record", "s9", "--fail", "named");
check("a target without a space keeps its fields and gains the space", same(named.envelope?.target, { space: "s9", name: "x" }), named.envelope?.target);

const own = kernel("scoped", "--json", "--record", "s9", "--fail", "own");
const ownText = kernel("scoped", "--record", "s9", "--fail", "own");
check("a target that names its own space is kept", same(own.envelope?.target, { space: "other" }) && ownText.first === "Mesh: other", shown(ownText));

const none = kernel("scoped", "--json", "--record", "s9", "--fail", "none");
const noneText = kernel("scoped", "--record", "s9", "--fail", "none");
check("a target whose space is null is kept, with no Mesh line", same(none.envelope?.target, { space: null }) && noneText.status === 2 && !noneText.stderr.includes("Mesh:"), shown(noneText));

const unrecorded = kernel("scoped", "--json", "--fail", "bare");
const unrecordedText = kernel("scoped", "--fail", "bare");
check("control: without a record the refusal has no target and no Mesh line", unrecorded.status === 2 && unrecorded.envelope?.target === null && unrecordedText.status === 2 && !unrecordedText.stderr.includes("Mesh:"), shown(unrecordedText));

const unknown = kernel("scoped", "--json", "--record", "s9", "--fail", "plain");
check("an unclassified failure after the record is OPERATION_UNKNOWN in that space", unknown.status === 3 && unknown.envelope?.error?.code === "OPERATION_UNKNOWN" && same(unknown.envelope.target, { space: "s9" }), shown(unknown));

for (const args of [["reviewer", "Audit text"], ["--name", "reviewer", "--text=--verbose"], ["reviewer", "Audit text", "--on", "aaaaaaaaaaaaaaaaaaaaaaaaaa"]]) {
  const missing = cotal("input", ...args, "--space", "fifth_missing", "--json");
  check(`input ${args.join(" ")} reports an unregistered target as JSON, exit 2`,
    missing.status === 2 && missing.stderr === "" && missing.envelope?.outcome === "refused" &&
    missing.envelope.error?.code === "TARGET_NOT_FOUND" && missing.envelope.error.message?.includes('"fifth_missing"') === true, shown(missing));
}

const emptyInputPin = cotal("input", "--name", "reviewer", "--text", "/compact", "--no-enter", "--on", "", "--space", "fifth_missing", "-j");
const inputRetry = /`((?:pnpm )?cotal input [^`]+)`/.exec(emptyInputPin.envelope?.error?.message ?? "")?.[1];
const inputInstance = "a".repeat(26);
const inputWords = inputRetry ? execWords(inputRetry.replace("<instance>", inputInstance)) : [];
const inputArgs = inputWords.slice(inputWords.indexOf("input"));
check("an empty input pin keeps the text, --no-enter, target and JSON format in its retry",
  emptyInputPin.status === 1 && emptyInputPin.stderr === "" && emptyInputPin.envelope?.error?.code === "USAGE_INVALID" &&
  same(inputArgs, ["input", "reviewer", "/compact", "--no-enter", "--json", "--space", "fifth_missing", "--on", inputInstance]), shown(emptyInputPin));
const retriedInput = inputArgs[0] === "input" ? cotal(...inputArgs) : undefined;
check("replacing only the manager instance placeholder keeps the retry refusal on JSON stdout",
  retriedInput?.status === 2 && retriedInput.stderr === "" && retriedInput.envelope?.outcome === "refused" &&
  retriedInput.envelope.error?.code === "TARGET_NOT_FOUND", retriedInput && shown(retriedInput));

const prepared = cotal("space", "create", "opsp", "--root", ".");
check("fixture: the space is prepared and not started", prepared.status === 0, shown(prepared));

{
  const file = "./Owner's persona.md";
  writeFileSync(join(root, file), "---\nname: example\nrole: reviewer\n---\n");
  const options = ["--name", "example", "--live-only", "--dry-run", "--json"];
  const retryFor = (r: ReturnType<typeof cotal>) => r.stderr.split("\n").find(line => line.startsWith("  "))?.trim();
  for (const [config, target] of [["default", ["default", "--foreground"]], [file, ["--foreground", "--file", file]]] as const) {
    const removed = cotal("start", "--config", config, ...options);
    const command = retryFor(removed);
    const words = command ? execWords(command) : [];
    const tail = words.slice(words.indexOf("spawn"));
    const expected = ["spawn", ...target, ...options];
    const agrees = same(tail, expected);
    check(`start with --live-only explains the manager conflict and prints a foreground retry for ${config}`,
      removed.status === 1 && removed.stdout === "" && removed.stderr.includes("It cannot be used with a manager launch") && agrees, shown(removed));
    const preview = agrees ? cotal(...tail) : undefined;
    const result = preview?.envelope?.result;
    check(`running that retry for ${config} previews without allocating or launching`,
      preview?.status === 0 && preview.envelope?.outcome === "ok" && result?.kind === "direct-launch-preview" &&
      result.allocated === false && result.launched === false, preview && shown(preview));
  }
  for (const extra of [["--detach", "--dry-run"], ["--on", "manager", "--dry-run"], ["--json"], ["--plain"]]) {
    const removed = cotal("start", "--config", "default", "--live-only", ...extra);
    const explanation = extra.includes("--dry-run") ? "It cannot be used with a manager launch" : "Use `--dry-run` with `--json` or `--plain`";
    check(`start with --live-only ${extra.join(" ")} explains the conflict without printing a rejected retry`,
      removed.status === 1 && removed.stderr.includes(explanation) && !retryFor(removed)?.includes(" spawn default "), shown(removed));
  }
  for (const [extra, explanation, correction] of [
    [["--space="], "--space/-s is empty", "name the space"],
    [["-m=example"], "-m=example gives -m the value", "write -m example or --model=example"],
    [["--server=localhost"], "--server is not a valid URL", ""],
    [["--name", ""], "--name cannot be empty", ""],
    [["--subscribe", "#bad"], 'invalid channel "#bad"', "name the channel without its #, as bad"],
  ] as const) {
    const removed = cotal("start", "--config=default", "--live-only", "--dry-run", "--json", ...extra);
    check(`start with --live-only and invalid ${extra[0]} reports the argument problem rather than a manager conflict`,
      removed.status === 1 && removed.stdout === "" && removed.stderr.includes(explanation) && removed.stderr.includes(correction) &&
      !removed.stderr.includes("It cannot be used with a manager launch") && !retryFor(removed)?.includes(" spawn default "), shown(removed));
  }
}

const persona = agentFilePath(root, "rev");
mkdirSync(dirname(persona), { recursive: true });
writeFileSync(persona, "---\nname: rev\nrole: reviewer\n---\n");
const conflict = cotal("persona", "create", "rev", "--json");
check("persona create over an existing file is a CONFLICT in the prepared space", conflict.status === 2 && conflict.envelope?.error?.code === "CONFLICT" && conflict.envelope.target?.space === "opsp", shown(conflict));
check("its remedy names the edit and the remove that resolve it", (conflict.envelope?.error?.remedy ?? "").includes("cotal persona edit rev") && (conflict.envelope?.error?.remedy ?? "").includes("cotal persona remove rev"), conflict.envelope?.error);
const conflictPlain = cotal("persona", "create", "rev", "--plain");
check("its plain report begins with Mesh: <space> and ends with a Next", conflictPlain.status === 2 && conflictPlain.first === "Mesh: opsp" && /\nNext\n\s+change it with `cotal persona edit rev`/.test(conflictPlain.stderr), shown(conflictPlain));
// A persona that does not exist: show and remove name where to see the ones that do.
for (const args of [["show", "nosuch"], ["remove", "nosuch", "--yes"]]) {
  const missing = cotal("persona", ...args, "--json");
  check(`persona ${args[0]} of a missing persona is TARGET_NOT_FOUND with a remedy`, missing.status === 2 && missing.envelope?.error?.code === "TARGET_NOT_FOUND" && missing.envelope.error.remedy === "see the personas here with `cotal persona --json`", shown(missing));
}
const alternate = mkdtempSync(join(home, "alternate-"));
const alternatePrepared = cotalAt(alternate, "space", "create", "alternate-catalog", "--root", ".");
check("fixture: a second catalog is prepared", alternatePrepared.status === 0, shown(alternatePrepared));
for (const verb of ["show", "edit", "remove"]) {
  const miss = cotal("persona", verb, "nosuch", "--space", "alternate-catalog", "--json");
  const list = miss.envelope?.error?.remedy?.match(/`([^`]+)`/)?.[1];
  check(`persona ${verb} suggests a JSON inventory of the requested catalog`, miss.status === 2
    && miss.envelope?.error?.code === "TARGET_NOT_FOUND" && list === "cotal persona --space alternate-catalog --json"
    && cotal(...list.split(" ").slice(1)).envelope?.target?.space === "alternate-catalog", shown(miss));
}
const legacyMiss = cotal("personas", "show", "nosuch", "--space", "alternate-catalog", "--creds", "unused.creds");
check("legacy show names the selected catalog without an unused credential option", legacyMiss.status === 2
  && legacyMiss.stderr.includes("see the personas here with `cotal persona --space alternate-catalog`"), shown(legacyMiss));
// A complete file that names another persona: the refusal names the file's name and the create that keeps it.
const otherFile = join(root, "bernie.md");
writeFileSync(otherFile, "---\nname: bernie\nrole: reviewer\nsubscribe: []\n---\n");
const mismatch = cotal("persona", "create", "ex11", "--file", otherFile, "--json");
check("a --file naming another persona is SCHEMA_INVALID, naming the file's name and its own create",
  mismatch.status === 1 && mismatch.envelope?.error?.code === "SCHEMA_INVALID" && (mismatch.envelope.error.message ?? "").includes(`${otherFile} names 'bernie'`) && (mismatch.envelope.error.remedy ?? "").includes(`cotal persona create bernie --file ${otherFile}`), shown(mismatch));
// A file the agent-file rules refuse: the refusal names the field and the reason. A YAML error keeps
// only its position, since the parser's text can quote the document.
for (const [label, text, reason] of [
  ["no frontmatter", "no frontmatter\n", 'missing "---" frontmatter block'],
  ["the legacy channels key", "---\nname: bad\nchannels: [general]\n---\n", '"channels" was renamed'],
  ["a read channel outside allowSubscribe", "---\nname: bad\nsubscribe: [ops]\nallowSubscribe: [general]\n---\n", 'subscribe "ops" is not within allowSubscribe [general]'],
  ["a family wider than every read entry", "---\nname: bad\nsubscribe: [perm.>]\nallowSubscribe: [perm.*]\n---\n", 'subscribe "perm.>" is not within allowSubscribe [perm.*]'],
  ["a YAML error", "---\nname: bad\nrole: [secret-value\n---\n", "the frontmatter is not valid YAML at line 3"],
] as const) {
  const badFile = join(root, "bad.md");
  writeFileSync(badFile, text);
  const refused = cotal("persona", "create", "bad", "--file", badFile, "--json");
  const message = refused.envelope?.error?.message ?? "";
  check(`a --file with ${label} is SCHEMA_INVALID naming the file and the reason`,
    refused.status === 1 && refused.envelope?.error?.code === "SCHEMA_INVALID" && message.includes(`invalid persona definition ${badFile}: ${reason}`) && !message.includes("secret-value"), shown(refused));
}
// A role is an address `send -r` reaches, so create refuses a role token it would refuse.
const roleFlag = cotal("persona", "create", "badrole", "--prompt", "x", "--role", "bad role!", "--subscribe", "", "--json");
check("persona create --role with a role send -r refuses is USAGE_INVALID naming --role",
  roleFlag.status === 1 && roleFlag.envelope?.error?.code === "USAGE_INVALID" && (roleFlag.envelope.error.message ?? "").startsWith('--role: invalid role "bad role!"') && !existsSync(agentFilePath(root, "badrole")), shown(roleFlag));
const roleFile = join(root, "badrole.md");
writeFileSync(roleFile, "---\nname: badrole\nrole: bad role!\nsubscribe: []\n---\n");
const roleInFile = cotal("persona", "create", "badrole", "--file", roleFile, "--json");
check("persona create --file whose role send -r refuses is SCHEMA_INVALID naming the file and the role",
  roleInFile.status === 1 && roleInFile.envelope?.error?.code === "SCHEMA_INVALID" && (roleInFile.envelope.error.message ?? "").includes(`invalid persona definition ${roleFile}: "role" must be a single token`) && !roleInFile.envelope.error.message?.includes("bad role!") && !existsSync(agentFilePath(root, "badrole")), shown(roleInFile));
const nullOptions = agentFilePath(root, "null-options");
writeFileSync(nullOptions, "---\nname: null-options\nlaunchOptions: null\n---\n");
const badOptions = cotal("persona", "show", "null-options", "--json");
check("persona show refuses null launchOptions and names the file and mapping rule",
  badOptions.status === 1 && badOptions.envelope?.error?.code === "SCHEMA_INVALID" && badOptions.envelope.error.message?.includes(`${nullOptions}: "launchOptions" must be a mapping of key: value pairs`) === true, shown(badOptions));
rmSync(nullOptions);
const roleOk = cotal("persona", "create", "goodrole", "--prompt", "x", "--role", "reviewer", "--subscribe", "", "--json");
check("control: a valid role token is created", roleOk.status === 0 && existsSync(agentFilePath(root, "goodrole")), shown(roleOk));

const legacyNew = ["personas", "new", "--prompt", "Review changes.", "--subscribe", "", "--"];
const invalidLegacyNew = cotal(...legacyNew, "-legacy-reviewer");
check("personas new refuses a leading hyphen before writing and explains how to retry",
  invalidLegacyNew.status === 1 && invalidLegacyNew.stderr.includes('cannot start with "-"') &&
  invalidLegacyNew.stderr.includes("then retry") && !existsSync(agentFilePath(root, "-legacy-reviewer")), shown(invalidLegacyNew));
const validLegacyNew = cotal(...legacyNew, "legacy-reviewer");
check("personas new with a corrected name creates the definition",
  validLegacyNew.status === 0 && existsSync(agentFilePath(root, "legacy-reviewer")), shown(validLegacyNew));

// A malformed --on names the command to rerun, with --on written once.
for (const [argv, rerun] of [
  [["persona", "--on", "bad"], "cotal persona --on <instance>"],
  // #7322: a verb that targets an agent keeps the agent, its other positionals and the space it named.
  [["stop", "default_agent", "--on", "bad"], "cotal stop default_agent --json --on <instance>"],
  // #7644: input gives its text again, quoted for a shell, rather than a `<text>` a shell reads as a redirection.
  [["input", "default_agent", "hello world", "--on", "bad"], "cotal input default_agent 'hello world' --json --on <instance>"],
  [["input", "default_agent", "hello world", "--no-enter", "--on", "bad"], "cotal input default_agent 'hello world' --no-enter --json --on <instance>"],
  [["status", "default_agent", "--on", "bad"], "cotal status default_agent --json --on <instance>"],
  [["stop", "default_agent", "--force", "--space", "elsewhere", "--on", "bad"], "cotal stop default_agent --force --json --space elsewhere --on <instance>"],
  // #7644: ps and models keep the --space and filter they were given.
  [["ps", "--space", "elsewhere", "--on", "bad"], "cotal ps --json --space elsewhere --on <instance>"],
  [["ps", "--slots", "--server", "nats://127.0.0.1:39200", "--on", "bogus"], "cotal ps --slots --json --server nats://127.0.0.1:39200 --on <instance>"],
  [["models", "--harness", "claude", "--on", "bad"], "cotal models --harness claude --on <instance>"],
  [["spawn", "default", "-d", "--on", "bad"], "cotal spawn default -d --json --on <instance>"],
] as const) {
  const pinned = cotal(...argv, "--json");
  const said = `${pinned.envelope?.error?.message ?? ""} ${pinned.envelope?.error?.remedy ?? ""}`;
  check(`${argv.slice(0, -2).join(" ")} --on bad names ${rerun} and never --on twice`,
    pinned.status === 1 && pinned.envelope?.error?.code === "USAGE_INVALID" && (pinned.envelope.error.remedy ?? "").endsWith(`rerun it as \`${rerun}\``) && !said.includes("--on --on"), shown(pinned));
}
const emptyPsPin = cotal("ps", "--slots", "--space", "elsewhere", "--json", "--on=");
const lookupHint = emptyPsPin.envelope?.error?.message ?? "";
check("an empty slot pin names the JSON manager lookup and a separate JSON slot retry", emptyPsPin.status === 1
  && lookupHint.includes("`cotal ps --json --space elsewhere`") && lookupHint.includes("`cotal ps --slots --json --space elsewhere --on <instance>`"), shown(emptyPsPin));
const widePsPin = cotal("ps", "--wide", "--plain", "--on", "local.U123");
check("a roster principal leaves the wide plain view on the pin retry", widePsPin.status === 1
  && widePsPin.stderr.includes("cotal ps --wide --plain --on <instance>"), shown(widePsPin));
for (const [verb, ...args] of [["stop", "target"], ["attach", "target"], ["status", "target"], ["input", "target", "review"]] as const) {
  for (const pin of ["", "local.U123"]) {
    const server = "nats://127.0.0.1:39200";
    const refused = cotal(verb, ...args, "--on", pin, "--space", "elsewhere", "--server", server);
    check(`${verb} keeps the selected space and broker on the manager lookup for ${pin || "an empty pin"}`,
      refused.status === 1 && refused.stderr.includes(`\`cotal ps --space elsewhere --server ${server}\``) && !refused.stderr.includes("`cotal ps`"), shown(refused));
  }
}
const createPin = cotal("persona", "create", "h1", "--prompt", "keep this definition private", "--on", "bad", "--space", "opsp", "--server", "nats://127.0.0.1:39200", "--json");
check("persona create with a malformed pin tells JSON callers to replace only the original --on value",
  createPin.status === 1 && createPin.envelope?.error?.code === "USAGE_INVALID" &&
  (createPin.envelope.error.remedy ?? "").includes("`cotal ps --space opsp --server nats://127.0.0.1:39200 --json`") &&
  (createPin.envelope.error.remedy ?? "").includes("replace only the --on value in the original command") &&
  !createPin.stdout.includes("cotal persona create h1 --on") && !createPin.stdout.includes("keep this definition private"), shown(createPin));
// #7644: a principal id, an empty value and an endpoint's malformed --on are refused while the
// arguments are read, with the command to rerun in the message. It keeps the command's words and
// the --space it was given; it used to keep only the verb.
for (const [argv, rerun] of [
  [["stop", "default_agent", "--space", "elsewhere", "--on", "local.U123"], "cotal stop default_agent --json --space elsewhere --on <instance>"],
  [["status", "default_agent", "--on", "local.U123"], "cotal status default_agent --json --on <instance>"],
  [["stop", "default_agent", "--on", ""], "cotal stop default_agent --json --on <instance>"],
  [["input", "reviewer", "Review this", "--no-enter", "--on", "", "--space", "audit", "--server", "nats://127.0.0.1:39200"], "cotal input reviewer 'Review this' --no-enter --json --space audit --server nats://127.0.0.1:39200 --on <instance>"],
  [["input", "reviewer", "--text=--verbose now", "--no-enter", "--on", "local.U123"], "cotal input reviewer '--text=--verbose now' --no-enter --json --on <instance>"],
  [["endpoint", "describe", "ai.cotal.manager", "--space", "elsewhere", "--on", "bad"], "cotal endpoint describe ai.cotal.manager --space elsewhere --on <instance> --json"],
  [["endpoint", "invoke", "ai.cotal.manager", "ps", "--on", "bad"], "cotal endpoint invoke ai.cotal.manager ps --on <instance> --json"],
  [["spawn", "--no-input", "-d", "--on=", "--name", "explicit", "--", "-persona"], "cotal spawn --no-input -d --name explicit --json --on <instance> -- -persona"],
] as const) {
  const refused = cotal("--json", ...argv);
  check(`${argv.join(" ")} names ${rerun}`,
    refused.status === 1 && refused.envelope?.error?.code === "USAGE_INVALID" && (refused.envelope.error.message ?? "").includes(`\`${rerun}\``), shown(refused));
}
for (const words of [["describe", "manager"], ["invoke", "ep:manager", "ps"]]) {
  const server = "nats://127.0.0.1:39200";
  const denied = cotal("endpoint", ...words, "--on", "bad", "--space", "elsewhere", "--server", server, "--json");
  const message = denied.envelope?.error?.message ?? "";
  check(`endpoint ${words[0]} names the requested Manager roster for a malformed pin`, denied.status === 1 &&
    denied.envelope?.error?.code === "USAGE_INVALID" && message.includes(`\`cotal ps --space elsewhere --server ${server}\``) && !message.includes("`cotal ps`"), shown(denied));
}
const otherEndpoint = cotal("endpoint", "invoke", "ref:reviews", "read", "--args", '{"note":"fixture body"}', "--on", "bad", "--json");
check("a saved endpoint pin keeps the original request and never suggests a Manager roster", otherEndpoint.status === 1 &&
  otherEndpoint.envelope?.error?.message?.includes("Replace only the --on value") === true && !otherEndpoint.stdout.includes("cotal ps") && !otherEndpoint.stdout.includes("fixture body"), shown(otherEndpoint));
for (const words of [["watch", "ref:reviews", "progress"], ["session", "ref:reviews", "read"], ["work", "lease", "ref:reviews", "pool"]]) {
  const pin = "a".repeat(26), server = "nats://127.0.0.1:39200";
  const denied = cotal("endpoint", ...words, "--space", "elsewhere", "--server", server, "--on", pin, "--json");
  const lookup = `cotal endpoint describe ref:reviews --space elsewhere --server ${server} --on ${pin} --json`;
  check(`unsupported endpoint ${words[0]} keeps the selected reference and route for discovery`, denied.status === 2 &&
    denied.envelope?.error?.code === "UNSUPPORTED" && denied.envelope.error.remedy?.includes(`\`${lookup}\``) === true, shown(denied));
}
const privateDiscovery = cotal("endpoint", "watch", "ref:reviews", "progress", "--creds", "unopened.creds", "--json");
check("endpoint discovery keeps an explicit caller without printing its file", privateDiscovery.status === 2 &&
  privateDiscovery.envelope?.error?.remedy?.includes("same --space, --server, --creds and --on options") === true &&
  !privateDiscovery.stdout.includes("unopened.creds"), shown(privateDiscovery));
const plainStatusPin = cotal("status", "default_agent", "--plain", "--on", "bad");
check("a malformed named status pin keeps plain output on the retry",
  plainStatusPin.status === 1 && /`(?:pnpm )?cotal status default_agent --plain --on <instance>`/.test(plainStatusPin.stderr), shown(plainStatusPin));
const plainInputPin = cotal("input", "reviewer", "/compact", "--plain", "--on", "");
check("an empty input pin keeps plain output on the retry",
  plainInputPin.status === 1 && /`(?:pnpm )?cotal input reviewer \/compact --plain --on <instance>`/.test(plainInputPin.stderr), shown(plainInputPin));
const attachPrincipal = cotal("attach", "default_agent", "--on", "local.U123");
check("attach default_agent --on local.U123 names cotal attach default_agent --on <instance> (#7644)",
  attachPrincipal.status === 1 && attachPrincipal.stderr.includes("`cotal attach default_agent --on <instance>`"), shown(attachPrincipal));
// attach has no structured output, so its refusal is read from the terminal text.
const attachPinned = cotal("attach", "default_agent", "--on", "bad");
check("attach default_agent --on bad names cotal attach default_agent --on <instance> (#7322)",
  attachPinned.status === 1 && attachPinned.stderr.includes("rerun it as `cotal attach default_agent --on <instance>`") && !attachPinned.stderr.includes("`cotal attach --on <instance>`"), shown(attachPinned));

// The seeded default's agents launch as default_agent, so no create takes that name.
for (const argv of [
  ["persona", "create", "default_agent", "--prompt", "x", "--subscribe", ""],
  ["personas", "new", "default_agent", "--prompt", "x", "--subscribe", ""],
  ["persona", "create", "default_agent", "--prompt", "x", "--on", "a".repeat(26)],
]) {
  const reserved = cotal(...argv);
  check(`${argv.slice(0, 3).join(" ")}${argv.includes("--on") ? " --on" : ""} refuses the reserved default_agent and writes nothing`,
    reserved.status === 1 && reserved.stderr.includes("'default_agent' is reserved") && !existsSync(agentFilePath(root, "default_agent")), shown(reserved));
}

// An edit that is not saved keeps its draft and names it: a draft the agent-file rules refuse says
// why, and an editor that exits non-zero cancels the edit and keeps what it wrote. The catalog file
// is unchanged.
const drafts = join(home, "drafts");
mkdirSync(drafts);
const editorScript = (file: string, body: string) => { const path = join(home, file); writeFileSync(path, `#!/bin/sh\n${body}\n`, { mode: 0o755 }); return path; };
const saved = readFileSync(persona, "utf8");
if (process.platform !== "win32") {
  const editTo = (name: string) => {
    const editor = editorScript(`ed-${name}`, `printf '%s\\n' '---' 'name: ${name}' 'subscribe: []' '---' 'Review changes.' > "$1"`);
    return outcome(spawnSync(process.execPath, [BIN, "persona", "edit", "legacy-reviewer", "--json"], {
      cwd: root, env: { ...env, EDITOR: editor, TMPDIR: drafts }, encoding: "utf8", timeout: 120_000,
    }));
  };
  const path = agentFilePath(root, "legacy-reviewer");
  const before = readFileSync(path, "utf8");
  const refused = editTo("-reviewer");
  check("persona edit refuses a new hyphen-leading launch name without saving and keeps the draft",
    refused.status === 1 && refused.envelope?.error?.message?.includes('the new frontmatter name cannot start with "-"') === true &&
    refused.envelope.error.remedy?.includes("cotal persona edit legacy-reviewer --json") === true && readFileSync(path, "utf8") === before, shown(refused));
  const corrected = editTo("reviewer");
  check("retrying the edit with a corrected frontmatter name saves it",
    corrected.status === 0 && readFileSync(path, "utf8").includes("name: reviewer\n"), shown(corrected));
  for (const dir of readdirSync(drafts)) rmSync(join(drafts, dir), { recursive: true });
}
for (const [label, editor, status, says] of [
  ["a draft the rules refuse", editorScript("ed-acl", 'printf -- "---\\nname: rev\\nsubscribe: [ops]\\nallowSubscribe: [general]\\n---\\nx\\n" > "$1"'), 1, 'subscribe "ops" is not within allowSubscribe [general] - not saved'],
  ...[3, 126, 127].map(code => [
    `an editor that exits ${code}`, editorScript(`ed-exit-${code}`, `printf '\\nUnsaved instructions.\\n' >> "$1" || exit 4; exit ${code}`),
    0, `Edit cancelled: the editor exited with status ${code}.`,
  ] as const),
] as const) {
  const edit = outcome(spawnSync(process.execPath, [BIN, "persona", "edit", "rev", "--plain"], { cwd: root, env: { ...env, EDITOR: editor, TMPDIR: drafts }, encoding: "utf8", timeout: 120_000 }));
  const kept = readdirSync(drafts).map((dir) => join(drafts, dir, "rev.md")).filter((path) => existsSync(path));
  check(`persona edit with ${label} keeps the draft, names it and leaves the catalog file unchanged`,
    edit.status === status && (edit.stderr + edit.stdout).includes(says) && kept.length === 1 && (edit.stderr + edit.stdout).includes(kept[0]!) &&
      readFileSync(kept[0]!, "utf8") !== saved && readFileSync(persona, "utf8") === saved, { ...shown(edit), kept });
  for (const dir of readdirSync(drafts)) rmSync(join(drafts, dir), { recursive: true });
}
if (process.platform !== "win32") {
  const editor = join(home, "missing-editor");
  const edit = outcome(spawnSync(process.execPath, [BIN, "persona", "edit", "rev", "--plain"], { cwd: root, env: { ...env, EDITOR: editor, TMPDIR: drafts }, encoding: "utf8", timeout: 120_000 }));
  check("persona edit with a missing editor refuses without keeping a draft or changing the catalog file",
    edit.status === 2 && edit.stderr.includes("DEPENDENCY_UNAVAILABLE") && edit.stderr.includes(`the editor ${JSON.stringify(editor)} was not found - not saved`) &&
      readdirSync(drafts).length === 0 && readFileSync(persona, "utf8") === saved, shown(edit));

  const jsonEdit = (visual: string) => outcome(spawnSync(process.execPath, [BIN, "persona", "edit", "rev", "--space", "opsp", "--json"], {
    cwd: root, env: { ...env, VISUAL: visual, EDITOR: "", TMPDIR: drafts }, encoding: "utf8", timeout: 120_000,
  }));
  for (const visual of ["no-receipt-editor-binary", `'${editor}' --wait`]) {
    const refused = jsonEdit(visual);
    check("persona edit --json reports a missing shell editor only in the refusal envelope",
      refused.status === 2 && refused.stderr === "" && refused.envelope?.outcome === "refused" &&
      refused.envelope.target?.space === "opsp" && refused.envelope.error?.code === "DEPENDENCY_UNAVAILABLE" &&
      refused.envelope.error.message === `the editor ${JSON.stringify(visual)} was not found - not saved` &&
      readdirSync(drafts).length === 0 && readFileSync(persona, "utf8") === saved, shown(refused));
  }
  const reportingEditor = editorScript("editor with spaces", `test "$1" = --wait && test -f "$2" || exit 1
printf 'Editor stdout\n'
printf 'Editor stderr\n' >&2`);
  const ran = jsonEdit(`'${reportingEditor}' --wait`);
  check("persona edit --json sends both editor streams to stderr and leaves stdout as one receipt",
    ran.status === 0 && ran.envelope?.outcome === "no-op" && ran.stderr === "Editor stdout\nEditor stderr\n" &&
    readdirSync(drafts).length === 0 && readFileSync(persona, "utf8") === saved, shown(ran));
}
// A save refused because the catalog became unwritable while the editor was open keeps the edited
// draft and names it beside the chmod that fixes the catalog. Root writes through any mode.
if (process.platform !== "win32" && process.getuid?.() !== 0) {
  const agents = dirname(persona), mode = statSync(agents).mode & 0o7777;
  const editor = editorScript("ed-readonly", `printf '\\nUnsaved instructions.\\n' >> "$1"; chmod u-w '${agents}'`);
  let edit: ReturnType<typeof outcome>;
  try { edit = outcome(spawnSync(process.execPath, [BIN, "persona", "edit", "rev", "--plain"], { cwd: root, env: { ...env, EDITOR: editor, TMPDIR: drafts }, encoding: "utf8", timeout: 120_000 })); }
  finally { chmodSync(agents, mode); }
  const kept = readdirSync(drafts).map((dir) => join(drafts, dir, "rev.md")).filter((path) => existsSync(path));
  check("persona edit refused PERMISSION_DENIED at save keeps the edited draft, names it with the chmod, and leaves the catalog file unchanged",
    edit.status === 2 && edit.stderr.includes("PERMISSION_DENIED") && edit.stderr.includes(`chmod u+w ${agents}`) && kept.length === 1
      && readFileSync(kept[0]!, "utf8").includes("Unsaved instructions.") && edit.stderr.includes(`your edit is kept in ${kept[0]}`) && readFileSync(persona, "utf8") === saved, { ...shown(edit), kept });
  for (const dir of readdirSync(drafts)) rmSync(join(drafts, dir), { recursive: true });
} else console.log("SKIP unwritable catalog at save: requires a non-root POSIX account");

// Removing the seeded default says what it was and how it comes back; another removal does not.
const removedOther = cotal("persona", "remove", "goodrole", "--yes", "--json");
check("removing another persona does not call it the seeded default", removedOther.status === 0 && !removedOther.stdout.includes("seededDefault"), shown(removedOther));
const removedDefault = cotal("persona", "remove", "default", "--yes", "--plain");
check("removing the seeded default says so and names what writes a fresh copy",
  removedDefault.status === 0 && removedDefault.stdout.includes("This was the seeded default persona, which a bare `cotal spawn` launches") && !existsSync(agentFilePath(root, "default")), shown(removedDefault));

// A launch preview refuses a missing persona as the launch does, naming where it looked: the catalog
// for a name, the file for a path, and for the default also the command that writes one.
const spawnHelp = cotal("spawn", "--help");
check("public spawn help shows the two persona forms, not the persisted config option", spawnHelp.status === 0 &&
  spawnHelp.stdout.includes("[<persona> | --file <persona-file>]") && !spawnHelp.stdout.includes("--config"), shown(spawnHelp));
const publicConfig = cotal("spawn", "-d", "--config", "default", "--name", "cfg-test");
check("public spawn config refuses with both supported forms and the public help", publicConfig.status === 1 && publicConfig.stdout === "" &&
  publicConfig.stderr.includes("--config is reserved for persisted internal launch callers") &&
  publicConfig.stderr.includes("`cotal spawn <persona>` for a catalog name") && publicConfig.stderr.includes("`cotal spawn --file <persona-file>` for a file") &&
  publicConfig.stderr.endsWith(spawnHelp.stdout), shown(publicConfig));
const catalog = dirname(agentFilePath(root, "default"));
const noName = cotal("spawn", "nosuch", "--dry-run", "--json");
check("spawn --dry-run of a missing name is TARGET_NOT_FOUND, naming the catalog and --file",
  noName.status === 2 && noName.envelope?.error?.code === "TARGET_NOT_FOUND" && noName.envelope.error.message === `no persona "nosuch" in ${catalog} (mesh "opsp")`
    && noName.envelope.error.remedy === "pass a catalog name, or a persona file elsewhere with `--file <persona.md>`", shown(noName));
const noFile = cotal("spawn", "--file", "missing.md", "--dry-run", "--json");
check("spawn --dry-run of a missing --file names the file it checked",
  noFile.status === 2 && noFile.envelope?.error?.code === "TARGET_NOT_FOUND" && noFile.envelope.error.message === `no persona "missing.md": ${join(root, "missing.md")} was not found`, shown(noFile));
if (process.platform !== "win32") {
  const link = agentFilePath(root, "broken-probe");
  symlinkSync("absent-probe.md", link);
  for (const flags of [["--dry-run", "--plain"], ["--server", "nats://127.0.0.1:34300"]]) {
    const refused = cotal("spawn", "broken-probe", ...flags);
    check(`spawn ${flags[0]} diagnoses a dangling persona link`, refused.status === 2 &&
      /Code:\s+TARGET_NOT_FOUND/.test(refused.stderr) && refused.stderr.includes(`${link} is a symbolic link to a missing target: absent-probe.md`) &&
      refused.stderr.includes("restore the link's target, or move the link aside and put a regular persona file in its place"), shown(refused));
  }
  writeFileSync(agentFilePath(root, "absent-probe"), "---\nname: broken-probe\n---\n");
  const restored = cotal("spawn", "broken-probe", "--dry-run", "--json");
  check("spawn preview follows the same link when its target is restored",
    restored.status === 0 && restored.envelope?.result?.requestedName === "broken-probe", shown(restored));
}
if (process.getuid && process.getuid() !== 0) {
  const unreadable = join(root, "unreadable persona.md");
  writeFileSync(unreadable, "---\nname: reader\n---\n", { mode: 0o000 });
  const refused = cotal("spawn", "--file", unreadable, "--dry-run", "--json");
  const remedy = refused.envelope?.error?.remedy;
  check("spawn preview quotes the chmod remedy for an owned file without changing its mode",
    refused.status === 2 && refused.envelope?.error?.code === "PERMISSION_DENIED" && refused.envelope.target?.path === unreadable &&
    remedy === `run \`chmod u+r '${unreadable}'\`, then retry` && (statSync(unreadable).mode & 0o777) === 0, shown(refused));
  chmodSync(unreadable, 0o400);
  const retried = cotal("spawn", "--file", unreadable, "--dry-run", "--json");
  check("the spawn preview succeeds once owner read permission is restored", retried.status === 0, shown(retried));
}
const prefix = join(env.XDG_CONFIG_HOME, "cotal", "extensions");
mkdirSync(join(prefix, "node_modules", "@cotal-ai"), { recursive: true });
const previewExtensions = ["connector-claude-code", "connector-opencode"].map((pkg) => {
  const source = join(import.meta.dirname, "..", "..", "..", "extensions", pkg);
  symlinkSync(source, join(prefix, "node_modules", "@cotal-ai", pkg), "dir");
  const name = pkg === "connector-claude-code" ? "claude" : pkg.slice("connector-".length);
  return { pkg: `@cotal-ai/${pkg}`, version: JSON.parse(readFileSync(join(source, "package.json"), "utf8")).version, commands: [], provides: [{ kind: "connector", name }], connectors: [{ name, requires: [name], eventPlane: true, setup: null }] };
});
writeFileSync(join(prefix, "extensions.json"), JSON.stringify({ extensions: [...previewExtensions, installNoVariantConnector(prefix)] }));
if (process.platform !== "win32") {
  const path = agentFilePath(alternate, "edit-receipt");
  const edited = '---\nname: "Review Bot"\nagent: claude\n---\n';
  const editor = join(home, "rename-editor");
  writeFileSync(path, "---\nname: edit-receipt\nagent: claude\n---\n");
  writeFileSync(editor, `#!/bin/sh\ncat > "$1" <<'EOF'\n${edited}EOF\n`, { mode: 0o700 });
  const saved = outcome(spawnSync(process.execPath, [BIN, "persona", "edit", "edit-receipt", "--space", "alternate-catalog", "--plain"],
    { cwd: root, env: { ...env, VISUAL: editor }, encoding: "utf8", timeout: 120_000 }));
  const launch = /^\s+(?:pnpm )?cotal (spawn .+?) {2,}Launch an agent from this persona\s*$/m.exec(saved.stdout)?.[1];
  check("persona edit saves a distinct display name and prints a launch with a valid override and the same space",
    saved.status === 0 && readFileSync(path, "utf8") === edited &&
    launch === "spawn edit-receipt --space alternate-catalog --name edit-receipt", shown(saved));
  const preview = launch && cotal(...launch.split(" "), "--dry-run", "--json");
  check("the launch arguments in the edit receipt preview the saved persona in the selected space",
    !!preview && preview.status === 0 && preview.envelope?.target?.space === "alternate-catalog" &&
    preview.envelope.result?.requestedName === "edit-receipt", preview && shown(preview));
}
const noDefault = cotal("spawn", "--dry-run", "--plain");
check("spawn --dry-run with no default persona previews the shipped default without writing it",
  noDefault.status === 0 && noDefault.stdout.includes("the launch writes the shipped default persona here; the preview wrote nothing") && !existsSync(agentFilePath(root, "default")), shown(noDefault));

const dottedCatalog = join(dirname(agentFilePath(root, "default")), "review.md.md");
const dottedFile = join(root, "review.md");
const dottedSource = "---\nname: reviewer\n---\nReview this change.\n";
const projectSource = "---\nname: other\n---\n";
writeFileSync(dottedCatalog, dottedSource);
writeFileSync(dottedFile, projectSource);
try {
  const listed = cotal("persona", "--space", "opsp", "--plain");
  check("persona lists the dotted name", listed.status === 0 && /^  review\.md\s/m.test(listed.stdout), shown(listed));
  const show = cotal("persona", "show", "review.md", "--space", "opsp", "--json");
  const card = show.envelope?.result;
  check("persona show reads the listed dotted name from the catalog rather than the project file",
    show.status === 0 && card?.name === "review.md" && card.path === dottedCatalog && card.definition?.name === "reviewer" && card.source === dottedSource, shown(show));
  const legacyShow = cotal("personas", "show", "review.md", "--space", "opsp");
  check("legacy personas show copies the dotted catalog source", legacyShow.status === 0 && legacyShow.stdout === dottedSource, shown(legacyShow));
  const fileRef = cotal("persona", "show", "./review.md", "--space", "opsp", "--json");
  check("persona show refuses a path", fileRef.status === 1 && fileRef.envelope?.error?.code === "USAGE_INVALID", shown(fileRef));
  const create = cotal("persona", "create", "new.review", "--prompt", "Review this.", "--subscribe", "", "--space", "opsp", "--json");
  check("persona create still refuses dotted names",
    create.status === 1 && create.envelope?.error?.code === "USAGE_INVALID" && !existsSync(join(dirname(dottedCatalog), "new.review.md")), shown(create));
  const preview = cotal("spawn", "review.md", "--dry-run", "--plain");
  check("spawn --dry-run previews the dotted catalog name instead of the project file",
    preview.status === 0 && preview.stdout.includes(dottedCatalog) && preview.stdout.includes("reviewer"), shown(preview));
  for (const [ref, path, name] of [["review.md", dottedCatalog, "reviewer"], ["./review.md", dottedFile, "other"]]) {
    env.COTAL_DEFAULT_PERSONA = ref;
    const preferred = cotal("spawn", "--dry-run", "--plain");
    check(`spawn --dry-run with COTAL_DEFAULT_PERSONA=${ref} selects ${name}`,
      preferred.status === 0 && preferred.stdout.includes(path) && new RegExp(`Requested name:\\s+${name}$`, "m").test(preferred.stdout), shown(preferred));
  }
  const remove = cotal("personas", "rm", "review.md", "--space", "opsp");
  check("legacy personas rm asks for confirmation without changing either file",
    remove.status === 1 && remove.stderr.includes("cotal personas rm review.md --space opsp --force") &&
    readFileSync(dottedCatalog, "utf8") === dottedSource && readFileSync(dottedFile, "utf8") === projectSource, shown(remove));
  const forced = cotal("personas", "rm", "review.md", "--space", "opsp", "--force");
  check("legacy personas rm --force removes only the dotted catalog entry",
    forced.status === 0 && !existsSync(dottedCatalog) && existsSync(dottedFile) &&
    readFileSync(dottedFile, "utf8") === projectSource, shown(forced));
} finally {
  delete env.COTAL_DEFAULT_PERSONA;
  rmSync(dottedCatalog, { force: true });
  rmSync(dottedFile, { force: true });
}

if (process.platform !== "win32") {
  const stem = "outbound-back\\slash";
  const path = join(dirname(dottedCatalog), `${stem}.md`);
  writeFileSync(path, "---\nname: backslash\n---\nPerform the fixture task.\n");
  try {
    const list = cotal("persona", "--space", "opsp", "--plain");
    const remedy = `spawn --space opsp --file '${path}'`;
    const hasRemedy = (text: string) => ["cotal", "pnpm cotal"].some(launcher => text.includes(`\`${launcher} ${remedy}\``));
    check("persona marks the backslash stem as an invalid selector and names its explicit file without failing the list",
      list.status === 0 && list.stdout.split("\n").some(line => line.includes(stem) && line.includes("invalid selector")) &&
      hasRemedy(list.stderr), shown(list));
    const json = cotal("persona", "--space", "opsp", "--json");
    const row = json.envelope?.result?.items?.find(item => item.name === stem);
    const warning = json.envelope?.warnings?.find(item => item.code === "USAGE_INVALID" && same(item.target, { name: stem, path }));
    check("JSON keeps a complete inventory and flags the unusable selector",
      json.status === 0 && json.envelope?.completeness === "complete" && row?.path === path && row.valid === false &&
      warning?.message.includes(`\`cotal ${remedy}\``) === true, shown(json));
    const legacy = cotal("personas", "list", "--space", "opsp");
    check("legacy list flags the backslash stem with the same explicit-file remedy", legacy.status === 0 &&
      legacy.stdout.split("\n").some(line => line.includes(stem) && line.includes("invalid selector")) && hasRemedy(legacy.stdout), shown(legacy));
    const file = cotal("spawn", "--space", "opsp", "--dry-run", "--plain", "--file", path);
    check("spawn preview still accepts the literal backslash in an explicit file", file.status === 0 &&
      file.stdout.includes(path) && /Requested name:\s+backslash$/m.test(file.stdout), shown(file));
  } finally {
    rmSync(path, { force: true });
  }
}

if (process.platform !== "win32") {
  const stems = ["release\tcheck", "release\x7fcheck"];
  const escaped = ["release\\u0009check", "release\\u007fcheck"];
  const paths = stems.map(stem => join(dirname(dottedCatalog), `${stem}.md`));
  const advisesRename = (text: string) => text.includes("contains control characters. Rename it to open it with") &&
    text.includes("persona show`") && !text.includes("--file");
  try {
    for (const path of paths) writeFileSync(path, "---\nname: checker\n---\nCheck the release.\n");
    const plain = cotal("persona", "--space", "opsp", "--plain");
    const legacy = cotal("personas", "list", "--space", "opsp");
    for (const [label, list, warnings] of [["plain", plain, plain.stderr], ["legacy", legacy, legacy.stdout]] as const) {
      check(`${label} catalog marks control characters in selectors and recommends renaming without failing the list`, list.status === 0 &&
        escaped.every(name => list.stdout.split("\n").some(line => line.includes(name) && line.includes("invalid selector")) &&
          warnings.split("\n").some(line => line.includes(name) && advisesRename(line))), shown(list));
    }
    const json = cotal("persona", "--space", "opsp", "--json");
    check("JSON keeps both control-character filenames in the complete inventory with invalid selectors", json.status === 0 &&
      json.envelope?.completeness === "complete" && stems.every((name, i) =>
        json.envelope?.result?.items?.some(item => item.name === name && item.path === paths[i] && item.valid === false) &&
        json.envelope?.warnings?.some(item => item.code === "USAGE_INVALID" && same(item.target, { name, path: paths[i] }) &&
          advisesRename(item.message ?? ""))), shown(json));
    const show = cotal("persona", "show", "--space", "opsp", "--json", "--", stems[0]);
    check("persona show still refuses the tab-containing selector", show.status === 1 &&
      show.envelope?.error?.code === "USAGE_INVALID" && show.envelope.error.message?.includes("control characters") === true, shown(show));
    const positional = cotal("spawn", "--space", "opsp", "--dry-run", "--plain", "--", stems[0]);
    check("positional spawn preview still selects the tab-containing filename", positional.status === 0 &&
      positional.stdout.includes(`${escaped[0]}.md`) && /Requested name:\s+checker$/m.test(positional.stdout), shown(positional));
    const byFile = cotal("spawn", "--space", "opsp", "--dry-run", "--plain", "--file", paths[0]);
    check("explicit file preview still refuses the tab-containing path", byFile.status === 1 &&
      byFile.stderr.includes("--file needs one nonempty persona-file path without control characters"), shown(byFile));
  } finally {
    for (const path of paths) rmSync(path, { force: true });
  }
}

// #7526: spawning or previewing an invalid native persona preserves the field/position error without
// echoing persona values and without recommending `cotal team deploy`, while a Mesh manifest still
// names `cotal team deploy <file>`.
for (const [label, body, reason] of [
  ["a list where a string is required", "---\nname: badspawn\nmodel: [opus]\n---\nReview.\n", '"model" must be a string; got array'],
  ["a duplicate YAML key", "---\nname: badspawn\nmodel: secret-one\nmodel: secret-two\n---\nReview.\n", "the frontmatter has a duplicate YAML key at line 4, column 1"],
  ["an empty file", "", 'missing "---" frontmatter block'],
  ["a blank model", '---\nname: badspawn\nmodel: "   "\n---\n', '"model" must not be empty'],
  ["a blank variant", '---\nname: badspawn\nvariant: "   "\n---\n', '"variant" must not be empty'],
  ["a null options mapping", "---\nname: badspawn\nlaunchOptions: null\n---\n", '"launchOptions" must be a mapping of key: value pairs'],
  ["an invalid role", "---\nname: badspawn\nrole: secret-role value\n---\n", '"role" must be a single token using letters, digits, underscores or hyphens'],
  ["an invalid channel declaration", "---\nname: badspawn\nsubscribe: [ops]\nallowSubscribe: [general]\n---\n", 'subscribe "ops" is not within allowSubscribe [general]'],
  ["malformed YAML with a secret value", "---\nname: badspawn\nrole: [secret-value\n---\n", "the frontmatter is not valid YAML at line 3"],
] as const) {
  const badSpawnPath = agentFilePath(root, "badspawn");
  writeFileSync(badSpawnPath, body);
  for (const [modeLabel, flags] of [["foreground", ["--foreground"]], ["dry-run", ["--dry-run"]]] as const) {
    const r = cotal("spawn", "badspawn", ...flags, ...(modeLabel === "dry-run" ? ["--json"] : ["--server", "nats://127.0.0.1:34300"]));
    const msg = r.envelope?.error?.message ?? r.stderr;
    const rem = r.envelope?.error?.remedy ?? r.stderr;
    check(`spawn ${modeLabel} with ${label} reports ${reason} without recommending team deploy (#7526)`,
      r.status === 1 && (r.envelope?.error?.code === "SCHEMA_INVALID" || /Code:\s+SCHEMA_INVALID/.test(r.stderr))
        && msg.includes(`invalid persona definition ${badSpawnPath}: ${reason}`)
        && !msg.includes("secret-")
        && rem.includes("check the agent-file frontmatter and channel declarations")
        && !rem.includes("team deploy"), shown(r));
  }
  rmSync(badSpawnPath, { force: true });
}
const manifestAsPersona = join(root, "team-manifest.yaml");
const invalidBytes = join(root, "bad-utf8.md");
writeFileSync(invalidBytes, Buffer.from("---\nname: bad-utf8\n---\nbefore\xffafter\n", "latin1"));
const invalidEncoding = cotal("spawn", "--file", invalidBytes, "--dry-run", "--json");
check("spawn preview refuses invalid UTF-8 and says how to repair the file",
  invalidEncoding.status === 1 && invalidEncoding.envelope?.error?.code === "SCHEMA_INVALID" &&
  invalidEncoding.envelope.error.message?.includes(`${invalidBytes}: it is not valid UTF-8`) === true &&
  invalidEncoding.envelope.error.remedy === `save ${invalidBytes} as UTF-8`, shown(invalidEncoding));
writeFileSync(manifestAsPersona, "apiVersion: cotal/v1\nkind: Mesh\nspace: opsp\nagents: {}\nchannels: {}\n");
for (const [modeLabel, flags] of [["foreground", ["--foreground"]], ["dry-run", ["--dry-run"]]] as const) {
  const r = cotal("spawn", "--file", manifestAsPersona, ...flags, ...(modeLabel === "dry-run" ? ["--json"] : ["--server", "nats://127.0.0.1:34300"]));
  check(`spawn ${modeLabel} given a Mesh manifest still recommends cotal team deploy (#7526)`,
    r.status === 1 && (r.envelope?.error?.code === "SCHEMA_INVALID" || /Code:\s+SCHEMA_INVALID/.test(r.stderr))
      && (r.envelope?.error?.message ?? r.stderr).includes("--file names a Mesh manifest")
      && (r.envelope?.error?.remedy ?? r.stderr).includes("`cotal team deploy <file>`"), shown(r));
}

// A managed preview cannot validate the execution host. A direct preview knows its effective
// harness and refuses an unknown name before reporting success, regardless of its source.
interface Preview { requested?: { source?: string }; persona?: { source?: string }; harness?: string; model?: string | null; variant?: string | null; connectorArgumentValidation?: string }
const managed = cotal("spawn", "-d", "nosuch", "--dry-run", "--json");
const managedResult = (managed.envelope as unknown as { result?: Preview; completeness?: string } | undefined);
check("a managed spawn --dry-run exits 0, not-checked, with the name's source as argument",
  managed.status === 0 && managed.envelope?.outcome === "ok" && managedResult?.completeness === "not-checked" && managedResult.result?.requested?.source === "argument", shown(managed));
for (const mode of [[], ["--dry-run"]]) {
  for (const resume of ["--resume=", "--resume=   "]) {
    const invalid = cotal("spawn", "-d", resume, ...mode, "--json");
    check(`managed ${mode.length ? "preview" : "launch"} rejects ${JSON.stringify(resume)} with one usage envelope`,
      invalid.status === 1 && invalid.envelope?.outcome === "refused" && invalid.envelope.error?.code === "USAGE_INVALID"
        && invalid.envelope.error.message?.includes("--resume needs a session id") === true && invalid.stderr === "", shown(invalid));
  }
}
const managedHarness = cotal("spawn", "-d", "--harness", "nosuch", "--dry-run", "--plain");
check("a managed preview warns about an unknown harness and labels the default persona in words",
  managedHarness.status === 0 && managedHarness.stderr.includes('! no harness "nosuch"; known harnesses:') && managedHarness.stdout.includes("Persona source:            the default persona") && !managedHarness.stdout.includes("explicit-or-product-default"), shown(managedHarness));
writeFileSync(join(root, "pv.md"), "---\nname: pv\nrole: reviewer\nsubscribe: []\n---\n");
const direct = cotal("spawn", "--file", "pv.md", "--harness", "nosuch", "--dry-run", "--json");
check("a direct preview of an unknown --harness is refused DEPENDENCY_UNAVAILABLE, exit 2",
  direct.status === 2 && direct.envelope?.outcome === "refused" && direct.envelope.error?.code === "DEPENDENCY_UNAVAILABLE"
    && direct.envelope.error.message === 'no connector "nosuch" is installed' && direct.envelope.target?.space === "opsp"
    && direct.envelope.target.path === join(root, "pv.md")
    && direct.envelope.error.remedy === "install its integration with `cotal ext add <npm-package>`, or check the name", shown(direct));
for (const format of [[], ["--plain"], ["--json"]]) {
  const fromEnv = outcome(spawnSync(process.execPath, [BIN, "spawn", "--file", "pv.md", "--dry-run", ...format], { cwd: root, env: { ...env, COTAL_DEFAULT_AGENT: "nosuch" }, encoding: "utf8", timeout: 120_000 }));
  check(`a harness only COTAL_DEFAULT_AGENT chose is refused in ${format[0] ?? "text"} output`,
    fromEnv.status === 2 && (format[0] === "--json"
      ? fromEnv.envelope?.outcome === "refused" && fromEnv.envelope.error?.code === "DEPENDENCY_UNAVAILABLE" && fromEnv.stderr === ""
      : fromEnv.stdout === "" && fromEnv.stderr.includes('no connector "nosuch" is installed') && !fromEnv.stderr.includes("! ")), shown(fromEnv));
}
const uppercase = cotal("spawn", "--file", "pv.md", "--harness", "OPENCODE", "--dry-run", "--json");
check("a direct preview refuses a case-mismatched harness without normalizing it",
  uppercase.status === 2 && uppercase.envelope?.error?.code === "DEPENDENCY_UNAVAILABLE" && uppercase.envelope.error.message === 'no connector "OPENCODE" is installed', shown(uppercase));
const knownDirect = cotal("spawn", "--file", "pv.md", "--harness", "opencode", "--dry-run", "--json");
const knownPreview = knownDirect.envelope as unknown as { result?: Preview; warnings?: unknown[] } | undefined;
check("an installed harness validates and previews the file's source without warnings",
  knownDirect.status === 0 && knownPreview?.result?.harness === "opencode" && knownPreview.result.persona?.source === "file" && knownPreview.result.connectorArgumentValidation === "checked" && same(knownPreview.warnings, []), shown(knownDirect));

const agentFilesDoc = readFileSync(join(import.meta.dirname, "..", "..", "..", "docs", "agent-files.mdx"), "utf8");
const agentFileExample = /^```markdown\r?\n([\s\S]*?)^```\r?$/m.exec(agentFilesDoc)?.[1];
if (!agentFileExample) throw new Error("missing Markdown example in docs/agent-files.mdx");
writeFileSync(join(root, "dave.md"), agentFileExample);
const docsPreview = cotal("spawn", "--file", "./dave.md", "--dry-run", "--space", "opsp", "--harness", "claude", "--json");
const docsResult = (docsPreview.envelope as { result?: Preview } | undefined)?.result;
check("the opening Agent files example previews with Claude and validates its model",
  docsPreview.status === 0 && docsPreview.envelope?.outcome === "ok" && docsResult?.harness === "claude"
    && docsResult.model === "opus" && docsResult.variant === null && docsResult.connectorArgumentValidation === "checked", shown(docsPreview));

const opencodeGuide = readFileSync(join(import.meta.dirname, "..", "..", "..", "docs", "connect-opencode.mdx"), "utf8");
const opencodeFile = /use `--file ([^`]+)`/.exec(opencodeGuide)?.[1];
if (!opencodeFile) throw new Error("missing --file example in docs/connect-opencode.mdx");
const catalogFile = join(root, ".cotal", "agents", "researcher.md");
mkdirSync(dirname(catalogFile), { recursive: true });
writeFileSync(catalogFile, "---\nname: researcher\nrole: research\n---\nYou research questions and summarize your findings.\n");
const guidePreview = cotal("spawn", "--foreground", "--harness", "opencode", "--file", opencodeFile, "--dry-run", "--plain");
check("the OpenCode guide's --file example previews the catalog persona it tells readers to create",
  opencodeFile === "./.cotal/agents/researcher.md" && guidePreview.status === 0
    && guidePreview.stdout.includes(catalogFile) && /Requested name:\s+researcher$/m.test(guidePreview.stdout)
    && /Harness:\s+opencode$/m.test(guidePreview.stdout), shown(guidePreview));
const guideMiss = cotal("spawn", "--foreground", "--harness", "opencode", "--file", "./researcher.md", "--dry-run", "--plain");
check("a project-root researcher.md is still refused when only the catalog file exists",
  guideMiss.status === 2 && guideMiss.stderr.includes('no persona "./researcher.md"')
    && guideMiss.stderr.includes("TARGET_NOT_FOUND"), shown(guideMiss));

const variantPersona = join(root, "variant-persona.md");
const previewVariant = (...flags: string[]) => cotal("spawn", "--file", variantPersona, "--dry-run", ...flags);
// The fixture connector takes no model variant, so a persona's variant is refused there.
const noVariantPersona = `---\nname: variant_check\nagent: ${NO_VARIANT_HARNESS}\nmodel: test-model\n`;
const removeVariantField = `remove the \`variant:\` field from ${JSON.stringify(variantPersona)}`;
writeFileSync(variantPersona, `${noVariantPersona}variant: high\n---\n`);
for (const [flags, remedy] of [[[], removeVariantField], [["--variant", "high"], `omit \`--variant\` and ${removeVariantField}`]] as const) {
  const denied = previewVariant("--json", ...flags);
  check(`direct preview names ${flags.length ? "both variant inputs" : "the persona variant field"} in its remedy`,
    denied.status === 1 && denied.envelope?.outcome === "refused" && denied.envelope.error?.code === "USAGE_INVALID"
      && denied.envelope.error.remedy === remedy && denied.envelope.target?.path === variantPersona, shown(denied));
}
const variantPlain = previewVariant("--plain");
check("plain preview prints the persona variant remedy as Next",
  variantPlain.status === 1 && variantPlain.stderr.split("\nNext\n")[1]?.includes("remove the `variant:` field") === true
    && variantPlain.stderr.split("\nNext\n")[1]?.includes(JSON.stringify(variantPersona)) === true, shown(variantPlain));
writeFileSync(variantPersona, `${noVariantPersona}---\n`);
const noVariant = previewVariant("--json");
const noVariantResult = (noVariant.envelope as { result?: Preview } | undefined)?.result;
check("direct preview passes connector validation after removing the persona variant",
  noVariant.status === 0 && noVariantResult?.variant === null && noVariantResult.connectorArgumentValidation === "checked"
    && noVariant.envelope?.result?.allocated === false && noVariant.envelope.result.launched === false, shown(noVariant));
const variantFlag = previewVariant("--json", "--variant", "high");
check("direct preview names only the variant flag when the file has no variant",
  variantFlag.status === 1 && variantFlag.envelope?.error?.remedy === "omit `--variant`", shown(variantFlag));

// The display name in a persona need not be a launch identity. Preview the effective value with
// the same local rule as foreground launch, including the selected space's actor-token bound.
writeFileSync(agentFilePath(root, "invalid-name"), "---\nname: bad name\n---\n");
for (const [args, remedy] of [
  [["invalid-name"], "retry with `cotal spawn invalid-name --name invalid-name --json --dry-run`"],
  [["invalid-name", "--server", "nats://127.0.0.1:34300"], "retry with `cotal spawn invalid-name --server nats://127.0.0.1:34300 --name invalid-name --json --dry-run`"],
  [["--file", "pv.md", "--name", "bad name"], undefined],
] as const) {
  for (const format of [[], ["--plain"], ["--json"]]) {
    const invalid = cotal("spawn", ...args, "--dry-run", ...format);
    const message = 'unsafe name "bad name" (allowed: letters, digits, _ -)';
    const jsonMessage = remedy === undefined ? message : `the persona's frontmatter name cannot be used for launch: ${message}`;
    check(`direct preview refuses the effective name from ${args.join(" ")} in ${format[0] ?? "text"}`,
      invalid.status === 1 && (format[0] === "--json"
        ? invalid.envelope?.outcome === "refused" && invalid.envelope.error?.code === "USAGE_INVALID"
          && invalid.envelope.error.message === jsonMessage && invalid.envelope.error.remedy === remedy
          && invalid.envelope.target?.space === "opsp" && invalid.stderr === ""
        : invalid.stdout === "" && invalid.stderr.includes(message)), shown(invalid));
  }
}
for (const [args, name] of [
  [["--file", "pv.md", "--name", "good-name"], "good-name"],
  [["invalid-name", "--name", "good_override"], "good_override"],
] as const) {
  const valid = cotal("spawn", ...args, "--dry-run", "--json");
  check(`direct preview accepts effective name ${name} without validating the overridden display name`,
    valid.status === 0 && valid.envelope?.outcome === "ok" && valid.envelope.completeness === "complete"
      && valid.envelope.result?.requestedName === name, shown(valid));
}
const userRoot = join(home, "user-project");
mkdirSync(dirname(agentFilePath(userRoot, "minimal")), { recursive: true });
writeFileSync(agentFilePath(userRoot, "minimal"), "---\nname: minimal\n---\n");
const priorHome = process.env.COTAL_HOME;
try {
  process.env.COTAL_HOME = env.COTAL_HOME;
  recordMesh({ space: "preview-user", server: "nats://127.0.0.1:34300", root: userRoot, mode: "user", origin: "manual",
    userAuth: { provider: "cotal", idp: { url: "https://idp.example/api/auth", issuer: "https://idp.example", audience: "https://idp.example" } }, ts: new Date().toISOString() });
} finally {
  if (priorHome === undefined) delete process.env.COTAL_HOME;
  else process.env.COTAL_HOME = priorHome;
}
for (const [name, accepted] of [["good_user_name", true], ["a".repeat(64), true], ["bad-hyphen", false], ["a".repeat(65), false]] as const) {
  const preview = cotal("spawn", "minimal", "--space", "preview-user", "--name", name, "--dry-run", "--json");
  check(`user-mode direct preview ${accepted ? "accepts" : "refuses"} ${name}`,
    accepted
      ? preview.status === 0 && preview.envelope?.outcome === "ok" && preview.envelope.result?.requestedName === name
      : preview.status === 1 && preview.envelope?.outcome === "refused" && preview.envelope.error?.code === "USAGE_INVALID"
        && preview.envelope.error.message?.startsWith(`name "${name}" cannot be a mesh identity in user mode`) === true
        && preview.envelope.target?.space === "preview-user" && preview.stderr === "", shown(preview));
}
writeFileSync(join(root, "pin.md"), "---\nname: pinned\nagent: nosuch\n---\n");
const pinned = cotal("spawn", "--file", "pin.md", "--dry-run", "--json");
check("an unknown persona harness pin is refused by a direct preview",
  pinned.status === 2 && pinned.envelope?.error?.code === "DEPENDENCY_UNAVAILABLE" && pinned.envelope.error.message === 'no connector "nosuch" is installed', shown(pinned));
const overridden = outcome(spawnSync(process.execPath, [BIN, "spawn", "--file", "pin.md", "--harness", "opencode", "--dry-run", "--json"], { cwd: root, env: { ...env, COTAL_DEFAULT_AGENT: "nosuch" }, encoding: "utf8", timeout: 120_000 }));
check("a valid explicit harness overrides an unknown persona pin and environment default",
  overridden.status === 0 && (overridden.envelope as unknown as { result?: Preview } | undefined)?.result?.harness === "opencode", shown(overridden));

// A managed preview names the runtime it asks for and what this host said about it. This sandbox has
// no runtime extension installed, so only the built-in pty is available here.
interface RuntimePreview { result?: { requested?: { runtime?: string | null }; runtimeCheck?: { host?: string; available?: boolean; error?: string | null } | null }; warnings?: { code: string }[] }
const previewRuntime = (...words: string[]) => { const r = cotal("spawn", "-d", "--dry-run", "--json", ...words); return { r, p: r.envelope as unknown as RuntimePreview | undefined }; };
const unknownRuntime = previewRuntime("--runtime", "nosuch");
check("a managed preview of an unknown --runtime exits 0, carries it, and says this host cannot run it",
  unknownRuntime.r.status === 0 && unknownRuntime.p?.result?.requested?.runtime === "nosuch" && unknownRuntime.p.result.runtimeCheck?.host === hostname()
    && unknownRuntime.p.result.runtimeCheck.available === false && unknownRuntime.p.result.runtimeCheck.error?.startsWith('unknown runtime "nosuch" (known: pty, orca, tmux, cmux, herdr)') === true
    && same(unknownRuntime.p.warnings?.map((w) => w.code), ["RUNTIME_UNAVAILABLE"]), shown(unknownRuntime.r));
const uninstalledRuntime = previewRuntime("--runtime", "tmux");
check("a known runtime that is not installed here names its cotal ext add package",
  uninstalledRuntime.r.status === 0 && uninstalledRuntime.p?.result?.runtimeCheck?.available === false
    && uninstalledRuntime.p.result.runtimeCheck.error === 'no installed extension provides runtime "tmux" - install it with `cotal ext add @cotal-ai/tmux`', shown(uninstalledRuntime.r));
const builtInRuntime = previewRuntime("--runtime", "pty");
check("the built-in pty is available here, with no warning",
  builtInRuntime.r.status === 0 && builtInRuntime.p?.result?.requested?.runtime === "pty" && builtInRuntime.p.result.runtimeCheck?.available === true
    && builtInRuntime.p.result.runtimeCheck.error === null && same(builtInRuntime.p.warnings, []), shown(builtInRuntime.r));
const foregroundRuntime = cotal("spawn", "--foreground", "--runtime", "pty", "--json");
check("foreground spawn refuses --runtime and offers compatible foreground and managed retries",
  foregroundRuntime.status === 1 && foregroundRuntime.envelope?.error?.code === "USAGE_INVALID"
    && foregroundRuntime.envelope.error.remedy === "omit --runtime, --json to launch in this terminal, or replace --foreground with -d (with --on <instance> to select a manager) to launch through a manager",
  shown(foregroundRuntime));
const combinedRuntime = cotal("spawn", "--foreground", "--runtime", "pty", "--json", "-d");
check("foreground spawn with -d already supplied tells the operator to omit --foreground for a managed launch",
  combinedRuntime.status === 1 && combinedRuntime.envelope?.error?.code === "USAGE_INVALID"
    && combinedRuntime.envelope.error.remedy?.endsWith("or omit --foreground to launch through a manager") === true, shown(combinedRuntime));
for (const mode of [["--foreground"], []]) {
  const args = ["--dry-run", "--json", ...mode, "--live-only"];
  const denied = cotal("spawn", ...args, "--runtime", "pty");
  check(`spawn ${mode[0] ?? "with default placement"} and --live-only only recommends omitting --runtime`,
    denied.status === 1 && denied.envelope?.error?.code === "USAGE_INVALID"
      && denied.envelope.error.remedy === "omit --runtime to launch in this terminal", shown(denied));
  const retry = cotal("spawn", ...args);
  const result = retry.envelope?.result;
  check(`the ${mode[0] ? "explicit" : "default"} foreground retry preserves --live-only without allocating or launching`,
    retry.status === 0 && retry.envelope?.outcome === "ok" && result?.kind === "direct-launch-preview"
      && result.allocated === false && result.launched === false, shown(retry));
}
const noRuntime = previewRuntime();
check("without --runtime the preview names none and checks none",
  noRuntime.r.status === 0 && noRuntime.p?.result?.requested?.runtime === null && noRuntime.p.result.runtimeCheck === null, shown(noRuntime.r));
const runtimeText = cotal("spawn", "-d", "--dry-run", "--plain", "--runtime", "nosuch");
check("the plain preview shows the runtime and where it was checked, and warns",
  runtimeText.status === 0 && runtimeText.stdout.includes(`Runtime:                   nosuch - not available on ${hostname()}; a manager on another host checks its own`)
    && runtimeText.stderr.includes('! unknown runtime "nosuch"'), shown(runtimeText));
for (const mode of [["--dry-run"], []]) {
  const auto = cotal("spawn", "-d", "--json", "--runtime", "auto", ...mode);
  check(`--runtime auto is refused USAGE_INVALID ${mode.length ? "by the preview" : "before a launch resolves any target"}`,
    auto.status === 1 && auto.envelope?.error?.code === "USAGE_INVALID" && auto.envelope.error.message === "--runtime auto chooses a manager's own runtime, not the runtime of one seat", shown(auto));
}

check("the fixture does not create a reporting identity", !existsSync(join(home, ".cotal", "telemetry.json")));
finish();
process.exit(process.exitCode ?? 0);
