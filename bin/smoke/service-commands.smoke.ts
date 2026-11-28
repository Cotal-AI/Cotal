/**
 * The short service commands, with no broker: `service add --exec` word splitting, preset option
 * defaults, the refusal that names an option with no default, the built-in presets' own defaults,
 * which recorded adapter pins this release still controls after an upgrade, `cotal manager <verb>`
 * dispatch onto the manager preset, the help listing that names `manager` and `service` under
 * Services, and the confirmation command a refused remove prints, which acts on the space it named.
 *
 * The in-process cells register a fixture adapter and preset of their own. The CLI cells run the real
 * binary from a sandboxed HOME, COTAL_HOME and project root against a registered space whose broker
 * port nothing listens on; every one of them refuses or reads before any process starts. The suite
 * removes its directories.
 *
 * Run: pnpm smoke:service-commands
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createSuite, freePort, recordSmokeSandbox } from "@cotal-ai/smoke-kit";

const WT = join(import.meta.dirname, "..", "..");
const TSX_LOADER = import.meta.resolve("tsx");
const BIN = join(WT, "bin", "cotal.ts");
const home = mkdtempSync(join(tmpdir(), "cotal-service-commands-home-"));
const root = mkdtempSync(join(tmpdir(), "cotal-service-commands-root-"));
// A second project, prepared with `space create` and never started, so its space has no registered broker.
const prepared = mkdtempSync(join(tmpdir(), "cotal-service-commands-prepared-"));
const xdg = join(home, "xdg");
for (const dir of [join(root, ".cotal"), join(home, ".cotal"), xdg]) mkdirSync(dir, { recursive: true, mode: 0o700 });
const anchor = recordSmokeSandbox({ root, cotalHome: join(home, ".cotal"), xdgConfigHome: xdg });
process.env.COTAL_HOME = join(home, ".cotal");
process.env.XDG_CONFIG_HOME = xdg;
const { registry } = await import("@cotal-ai/core");
type Command = import("@cotal-ai/core").Command;
type LocalProcess = import("@cotal-ai/workspace").LocalProcess;
type ServicePreset = import("@cotal-ai/workspace").ServicePreset;
const { cacheServicePreset, isCommandFailure, recordMesh } = await import("@cotal-ai/workspace");
const { execWords } = await import("../../implementations/cli/src/lib/exec-words.js");
const { serviceConfirmCommand } = await import("../../implementations/cli/src/lib/confirmation-required.js");
const { serviceDefinitionStore } = await import("../../implementations/cli/src/lib/service-definitions.js");
const { presetDefaultOptions, presetMaterialPath, presetOptionRefusal, resolveServicePreset, servicePresetDefinition, servicePresetFlags } = await import("../../implementations/cli/src/lib/service-presets.js");
const { controlsRecordedAdapter, resolveServiceAdapter } = await import("../../implementations/cli/src/lib/service-adapters.js");
await import("@cotal-ai/cli");
await import("@cotal-ai/manager");
await import("@cotal-ai/delivery");
await import("@cotal-ai/auth");
await import("@cotal-ai/web");

const { check, finish } = createSuite();
/** The refusal a call throws, as code, message and remedy, or undefined when it returns. */
const refusal = (fn: () => unknown) => {
  try { fn(); return undefined; }
  catch (error) { return isCommandFailure(error) ? { code: error.code, message: error.message, remedy: error.remedy } : { code: "thrown", message: String(error), remedy: undefined }; }
};

// ---- --exec splits words as a shell quotes them, and runs no shell -----------------------------
const words = (line: string) => { try { return execWords(line); } catch (error) { return isCommandFailure(error) ? `${error.code}: ${error.message}` : String(error); } };
const same = (line: string, expected: string[]) => check(`--exec ${JSON.stringify(line)} is ${JSON.stringify(expected)}`, JSON.stringify(words(line)) === JSON.stringify(expected), words(line));
same("node server.js --port 8080", ["node", "server.js", "--port", "8080"]);
same("  ./run.sh\t'big world'  ", ["./run.sh", "big world"]);
same(`echo "a \\"b\\" \\$HOME" it\\'s`, ["echo", `a "b" $HOME`, "it's"]);
same("echo '' x", ["echo", "", "x"]);
same("echo a#b 'x|y' \"*\"", ["echo", "a#b", "x|y", "*"]);
for (const [line, what] of [
  ["a | tee x", "an unquoted |"], ["a > out", "an unquoted >"], ["a; b", "an unquoted ;"], ["a && b", "an unquoted &"],
  ["echo $HOME", "an unquoted $"], ["echo `id`", "an unquoted `"], ["ls *.js", "an unquoted *"], ["cat ~/x", "an unquoted ~"],
  ["echo # note", "an unquoted #"], ["echo \"$HOME\"", "$ inside double quotes"], ["a\nb", "a line break"],
] as const) {
  const result = words(line);
  check(`--exec ${JSON.stringify(line)} refuses naming ${what}`, typeof result === "string" && result.startsWith("USAGE_INVALID: ") && result.includes(`so ${what} would not work as it does in a terminal`), result);
}
for (const [line, what] of [["echo 'x", "single quote that is never closed"], ["echo \"x", "double quote that is never closed"], ["echo x\\", "backslash that escapes nothing"], ["   ", "needs the program to run"], ["'' x", "needs the program to run"]] as const) {
  const result = words(line);
  check(`--exec ${JSON.stringify(line)} refuses: ${what}`, typeof result === "string" && result.startsWith("USAGE_INVALID: ") && result.includes(what), result);
}

// A guided answer is checked without requiring the form's other answers yet.
const guidedAuth = resolveServicePreset("auth-service");
check("a guided integer answer rejects invalid JSON", presetOptionRefusal(guidedAuth, "port", "abc")?.includes("not valid JSON") === true);
check("a guided integer answer rejects a fractional value", presetOptionRefusal(guidedAuth, "port", "1.25")?.includes("closed schema") === true);
check("a guided port answer applies its schema bound", presetOptionRefusal(guidedAuth, "port", "65536")?.includes("closed schema") === true);
check("a corrected guided port answer needs no other answers", presetOptionRefusal(guidedAuth, "port", "65535") === undefined);

// ---- A preset's defaults are a closed declaration ----------------------------------------------
const base = { kind: "service-preset" as const, name: "fixture", summary: "fixture", adapter: "fixture-adapter", timeoutMs: 1000 };
const cached = refusal(() => cacheServicePreset({ ...base, defaults: { root: { space: "root" }, server: { space: "server" }, creds: { space: "material", kind: "fixture.creds" }, count: { value: 3 }, mode: { value: "fast" }, on: { value: true } } }));
check("a preset may default an option to a literal, the space's root or broker, or a file the space keeps", cached === undefined, cached);
for (const [label, defaults] of [
  ["an unknown default source", { root: { space: "home" } }],
  ["a material default without its kind", { creds: { space: "material" } }],
  ["a material kind that is a path", { creds: { space: "material", kind: "../creds" } }],
  ["a default with an extra key", { root: { space: "root", value: "x" } }],
  ["a literal with a control character", { mode: { value: "a\nb" } }],
  ["a literal that is not a scalar", { mode: { value: ["a"] } }],
  ["an option name that is no flag", { "Bad Name": { value: 1 } }],
  ["defaults that are a list", [{ value: 1 }]],
] as [string, unknown][]) {
  const result = refusal(() => cacheServicePreset({ ...base, defaults: defaults as ServicePreset["defaults"] }));
  check(`a preset declaring ${label} is refused`, result?.code === "SCHEMA_INVALID" && result.message.includes("unsupported option default"), result);
}

// ---- Defaults fill only what the person did not give; a missing option is named -----------------
const adapter: LocalProcess = {
  kind: "local-process", name: "fixture-adapter", label: "Fixture adapter", controllerOnly: true, pidFile: "fixture.{space}.pid",
  service: {
    abiVersion: 1, readiness: "process", capabilities: { multiInstance: false, foreground: false, logs: true },
    optionsSchema: { type: "object", additionalProperties: false, required: ["root", "token"], properties: {
      root: { type: "string", description: "the root" },
      token: { type: "string", description: "a required option with no default" },
      count: { type: "integer", description: "a number with a default" },
      server: { type: "string", description: "the broker" },
      creds: { type: "string", description: "a file the space keeps" },
      logFile: { type: "string", description: "a camelCase option, taken as --log-file" },
    } },
  },
};
const preset: ServicePreset = { ...base, defaults: { root: { space: "root" }, count: { value: 3 }, server: { space: "server" }, creds: { space: "material", kind: "fixture.creds" } } };
registry.register(adapter, preset);
const flags = servicePresetFlags(preset);
const flag = (name: string) => flags.find((row) => row.name === name)?.description ?? "";
check("help shows each defaulted option's default", flag("root").includes("(default: this space's root)") && flag("count").includes("(default: 3)") && flag("creds").includes("(default: this space's fixture.creds)"), flags);
check("  and no default for an option that has none", !flag("token").includes("(default:"), flag("token"));
check("a camelCase option takes its dashed flag, as `cotal up --log-file` spells it", flags.some((row) => row.name === "log-file") && !flags.some((row) => row.name === "logFile"), flags.map((row) => row.name));

const SPACE = "servicecommands";
const missing = refusal(() => servicePresetDefinition(preset, SPACE, {}, root, "start"));
check("a start missing an option with no default refuses naming its flag, and each default the space cannot fill yet, before any effect",
  missing?.code === "USAGE_INVALID" && missing.message === "the fixture preset needs --token, which has no default, and --server, since space servicecommands has no registered broker, and --creds, since space servicecommands keeps no fixture.creds yet; nothing was saved or started"
    && missing.remedy === "cotal service start fixture --token <string> --server <url> --creds <file>", missing);
const added = refusal(() => servicePresetDefinition(preset, SPACE, {}, root));
check("  and the add form repeats its own command line", added?.remedy?.startsWith("cotal service add <name> --preset fixture --token ") === true, added);
const unregistered = refusal(() => presetDefaultOptions(preset, SPACE, root, { token: "t" }, false));
check("a broker default with no registered space refuses and names the flag", unregistered?.code === "DEPENDENCY_UNAVAILABLE" && unregistered.message.includes("--server") && unregistered.remedy?.includes("pass --server <url>") === true && unregistered.remedy.includes("original command") && !unregistered.remedy.includes("cotal up"), unregistered);
const SERVER = `nats://127.0.0.1:${await freePort()}`;
recordMesh({ space: SPACE, server: SERVER, root, mode: "open", ts: new Date().toISOString() });
const absent = refusal(() => presetDefaultOptions(preset, SPACE, root, { token: "t" }, false));
const creds = presetMaterialPath("fixture.creds", SPACE, root, false);
check("a file default the space does not keep refuses, naming the file and the flag, and invents none",
  absent?.code === "DEPENDENCY_UNAVAILABLE" && absent.message.includes(creds) && absent.message.includes("does not exist yet") && absent.remedy?.includes("pass --creds <file>") === true && absent.remedy.includes(`space show ${SPACE}`) && !absent.remedy.includes("cotal up"), absent);
const extra = refusal(() => presetDefaultOptions(preset, SPACE, root, { token: "t", "new-instance": true }, false));
check("an additional instance cannot take file flags, so the remedy identifies the first-start alternative", extra?.remedy?.includes("to configure a first start instead, remove `--new-instance` and pass --creds <file>") === true, extra);
mkdirSync(dirname(creds), { recursive: true, mode: 0o700 });
writeFileSync(creds, "fixture\n", { mode: 0o600 });
const filledMissing = refusal(() => servicePresetDefinition(preset, SPACE, {}, root, "start"));
check("  and once the space has its broker and file, the refusal and its line name only the option with no default",
  filledMissing?.message === "the fixture preset needs --token, which has no default; nothing was saved or started" && filledMissing.remedy === "cotal service start fixture --token <string>", filledMissing);
const filled = (() => { try { return presetDefaultOptions(preset, SPACE, root, { token: "t" }, false); } catch (error) { return String(error); } })();
check("defaults resolve to the space's root, broker and file, and a literal number", JSON.stringify(filled) === JSON.stringify({ root, count: "3", server: SERVER, creds }), filled);
const given = (() => { try { return presetDefaultOptions(preset, SPACE, root, { token: "t", root: "/elsewhere", count: "5" }, false); } catch (error) { return String(error); } })();
check("an option the person gave is never replaced by its default", typeof given === "object" && given.root === undefined && given.count === undefined, given);
const logged = (() => { try { return servicePresetDefinition(preset, SPACE, { token: "t", "log-file": "/var/log/fixture.log" }, root); } catch (error) { return String(error); } })();
check("  and its value is saved under the adapter's own option name", typeof logged === "object" && logged.launch.type === "adapter" && (logged.launch.options as Record<string, unknown>).logFile === "/var/log/fixture.log", logged);

// ---- The built-in presets declare defaults for everything a space already knows -----------------
/** JSON with object keys in sorted order, so a declaration's key order does not matter. */
const sorted = (value: unknown): string => JSON.stringify(value, (_, inner) => inner && typeof inner === "object" && !Array.isArray(inner) ? Object.fromEntries(Object.entries(inner).sort(([a], [b]) => a.localeCompare(b))) : inner);
const builtIn = (name: string) => registry.all<ServicePreset>("service-preset").find((row) => row.name === name);
const brokerFlags = (() => { try { return servicePresetFlags(builtIn("broker")!).map((row) => row.name); } catch (error) { return String(error); } })();
check("the broker preset's flags include --log-file for its logFile option", Array.isArray(brokerFlags) && brokerFlags.includes("log-file") && brokerFlags.includes("server"), brokerFlags);
check("the manager preset defaults to this space's root and the pty runtime",
  JSON.stringify(builtIn("manager")?.defaults) === JSON.stringify({ root: { space: "root" }, runtime: { value: "pty" } }), builtIn("manager")?.defaults);
check("the delivery preset defaults to this space's root and its delivery credential file",
  builtIn("delivery")?.defaults?.root !== undefined && JSON.stringify(builtIn("delivery")?.defaults?.creds) === JSON.stringify({ space: "material", kind: "delivery.creds" }), builtIn("delivery")?.defaults);
check("the web preset defaults to this space's root, read-only and its web credential file", sorted(builtIn("web")?.defaults) === sorted({ "read-only": { value: true }, root: { space: "root" }, creds: { space: "material", kind: "web.creds" } }), builtIn("web")?.defaults);
check("the auth-service and feedback-intake presets default only the root",
  ["auth-service", "feedback-intake"].every((name) => JSON.stringify(builtIn(name)?.defaults) === JSON.stringify({ root: { space: "root" } })), ["auth-service", "feedback-intake"].map((name) => builtIn(name)?.defaults));
check("every built-in preset's summary is plain words a person reads", ["manager", "delivery", "web", "auth-service", "feedback-intake"].every((name) => (builtIn(name)?.summary.length ?? 0) > 10), ["manager", "delivery", "web", "auth-service", "feedback-intake"].map((name) => builtIn(name)?.summary));

// ---- An upgrade keeps a built-in adapter's instances controllable; a third party's stay pinned ----
const broker = resolveServiceAdapter("nats-broker", {}, false), manager = resolveServiceAdapter("manager-service", {}, false);
/** A pin an earlier release wrote under another declaration, as a changed option description makes. */
const earlier = (pin: typeof broker.pin) => ({ ...pin, version: "0.0.1", declarationSha256: "0".repeat(64) });
check("a broker record an earlier release wrote under another declaration is controlled by this release",
  controlsRecordedAdapter({ adapter: earlier(broker.pin), kernelStopRequired: true }, broker), earlier(broker.pin));
check("  and so is such a manager record, under its native stop", controlsRecordedAdapter({ adapter: earlier(manager.pin), nativeStopRequired: true }, manager));
check("  and a first-party extension's", controlsRecordedAdapter({ adapter: { ...earlier(broker.pin), package: "@cotal-ai/fixture" }, kernelStopRequired: true }, { ...broker, pin: { ...broker.pin, package: "@cotal-ai/fixture" } }));
check("  but not one launched under another stop policy",
  !controlsRecordedAdapter({ adapter: earlier(broker.pin) }, broker) && !controlsRecordedAdapter({ adapter: earlier(manager.pin), kernelStopRequired: true }, manager));
check("  nor one of another adapter", !controlsRecordedAdapter({ adapter: earlier(manager.pin), kernelStopRequired: true }, broker));
const thirdParty = { pin: { name: "fixture-adapter", package: "acme-fixture", version: "1.2.0", declarationSha256: "a".repeat(64) }, declaration: adapter.service! };
check("a third-party adapter controls its record at its own version and declaration", controlsRecordedAdapter({ adapter: thirdParty.pin }, thirdParty));
check("  and refuses one under a changed declaration or another version",
  !controlsRecordedAdapter({ adapter: { ...thirdParty.pin, declarationSha256: "b".repeat(64) } }, thirdParty) && !controlsRecordedAdapter({ adapter: { ...thirdParty.pin, version: "1.1.0" } }, thirdParty));

// ---- A stop's confirmation keeps the instance and --with-agents it was refused for -------------
check("a stop's confirmation command names the space, the instance and --with-agents as given",
  serviceConfirmCommand("stop", "worker", "beta", { instance: "6a01a71b-45a1-472e-afff-f7d2c444145e", "with-agents": true }) === "cotal svc stop worker --space beta --instance 6a01a71b-45a1-472e-afff-f7d2c444145e --with-agents --yes"
    && serviceConfirmCommand("restart", "worker", "beta", {}) === "cotal svc restart worker --space beta --yes",
  [serviceConfirmCommand("stop", "worker", "beta", { instance: "6a01a71b-45a1-472e-afff-f7d2c444145e", "with-agents": true }), serviceConfirmCommand("restart", "worker", "beta", {})]);

// ---- Help lists manager and service under Services; supervise is hidden ------------------------
const command = (name: string) => registry.all<Command>("command").find((row) => row.name === name);
check("manager and service are listed under Services", command("manager")?.group === "Services" && command("service")?.group === "Services" && !command("manager")?.hidden && !command("service")?.hidden, [command("manager")?.group, command("service")?.group]);
check("supervise is hidden", command("supervise")?.hidden === true);

// ---- The real binary --------------------------------------------------------------------------
const env: NodeJS.ProcessEnv = { ...process.env };
for (const key of Object.keys(env)) if (key.startsWith("COTAL_") || key === "INVOCATION_ID") delete env[key];
Object.assign(env, { HOME: home, USERPROFILE: home, COTAL_HOME: join(home, ".cotal"), XDG_CONFIG_HOME: xdg, COTAL_SKIP_CONNECTOR_SEED: "1", DO_NOT_TRACK: "1", NO_COLOR: "1", COLUMNS: "200" });
const cotal = (args: string[], commandEnv = env) => spawnSync(process.execPath, ["--import", TSX_LOADER, BIN, ...args], { cwd: root, env: commandEnv, encoding: "utf8", timeout: 120_000 });
const out = (run: ReturnType<typeof cotal>) => `${run.stdout ?? ""}${run.stderr ?? ""}`;
const definitions = () => {
  const run = cotal(["service", "--space", SPACE, "--json"]);
  try { return (JSON.parse(run.stdout) as { result: { definitions: { name: string }[] } }).result.definitions.map((row) => row.name); }
  catch { return out(run); }
};

try {
  const help = cotal(["help"]);
  const services = `${out(help).split("\n\n").find((block) => block.startsWith("Services")) ?? ""}\n`;
  check("cotal help lists manager and service under Services, each with its summary",
    help.status === 0 && /\n {2}manager(, [a-z]+)* +start, stop and check the manager that runs your agents\n/.test(services) && /\n {2}service(, [a-z]+)* +run Cotal's built-in services and your own programs: list, add, start, stop, status, logs\n/.test(services), services || out(help));
  check("  and does not list supervise", !/\n {2}supervise\b/.test(out(help)), out(help));

  const startHelp = cotal(["manager", "start", "--help"]);
  check("cotal manager start --help shows its own usage and the manager preset's options with their defaults",
    startHelp.status === 0 && out(startHelp).includes("cotal manager start [--runtime <name>]") && out(startHelp).includes('(default: "pty")') && out(startHelp).includes("--roster"), out(startHelp));
  check("  and none of service add's definition flags", !/--preset\b|--file\b|--new-instance\b|--exec\b/.test(out(startHelp)), out(startHelp));
  const managerHelpWithOptions = cotal(["help", "--", "mgr", "--space", "help-audit", "start"]);
  check("explicit manager start help resolves the alias and skips the leading space option",
    managerHelpWithOptions.status === 0 && managerHelpWithOptions.stderr === "" && managerHelpWithOptions.stdout === startHelp.stdout,
    out(managerHelpWithOptions));

  const managerStartPath = ["service", "start", "manager"];
  const managerPresetHelp = cotal([...managerStartPath, "--help"]);
  const managerHelpCommand = cotal(["help", ...managerStartPath]);
  const managerStartRefusal = cotal([...managerStartPath, "--no-open", "--dry-run"]);
  const noOpenOption = /^  --no-open\b/m;
  check("both manager preset help forms keep --runtime and omit the web-only option",
    managerPresetHelp.status === 0 && managerHelpCommand.status === 0 && managerPresetHelp.stdout === managerHelpCommand.stdout
    && /^  --runtime <string>/m.test(managerPresetHelp.stdout) && !noOpenOption.test(managerPresetHelp.stdout), out(managerPresetHelp));
  check("the manager preset refuses --no-open without listing it in the usage help",
    managerStartRefusal.status === 1 && managerStartRefusal.stdout === "" && managerStartRefusal.stderr.includes("--no-open belongs to service start web")
    && managerStartRefusal.stderr.endsWith(managerPresetHelp.stdout) && !noOpenOption.test(managerStartRefusal.stderr), out(managerStartRefusal));
  for (const [name, showsNoOpen] of [[undefined, true], ["web", true], ["broker", false], ["hello", false]] as const) {
    const args = ["service", "start", ...(name === undefined ? [] : [name]), "--help"];
    const result = cotal(args);
    check(`cotal ${args.join(" ")} ${showsNoOpen ? "lists" : "omits"} --no-open`,
      result.status === 0 && noOpenOption.test(result.stdout) === showsNoOpen, out(result));
  }
  const idleExitOption = /^  --idle-exit <seconds>(?: |$)/m;
  for (const [name, showsIdleExit] of [[undefined, true], ["manager", true], ["web", false], ["broker", false], ["hello", false]] as const) {
    const args = ["service", "start", ...(name === undefined ? [] : [name]), "--help"];
    const result = cotal(args);
    check(`cotal ${args.join(" ")} ${showsIdleExit ? "lists" : "omits"} --idle-exit`,
      result.status === 0 && idleExitOption.test(result.stdout) === showsIdleExit, out(result));
  }

  for (const args of [["manager", "install", "--help"], ["help", "manager", "install"]]) {
    const installHelp = cotal(args);
    check(`cotal ${args.join(" ")} explains that Manager unit installation is unsupported and shows the foreground command`,
      installHelp.status === 0 && out(installHelp).includes("installing a manager unit is not supported")
        && out(installHelp).includes("cotal manager start --foreground") && !out(installHelp).includes("--dry-run")
        && !out(installHelp).includes("start it at login"), out(installHelp));
  }

  for (const verb of ["status", "stop", "restart"]) {
    const absent = cotal(["manager", verb, "--space", SPACE, "--json"]);
    const error = JSON.parse(absent.stdout).error;
    check(`cotal manager ${verb} with no manager started names a start in the same space`,
      absent.status === 2 && error?.code === "TARGET_NOT_FOUND" && error.message.includes(`no manager has been started in space ${SPACE}`) && error.remedy === `start it with \`cotal manager start --space ${SPACE}\``, out(absent));
  }

  for (const flags of [[], ["--dry-run"]]) {
    const install = cotal(["manager", "install", "--space", SPACE, ...flags]);
    const text = out(install);
    const next = flags.length ? text.includes(`\`cotal service --space ${SPACE}\``) && !/ExecStart=|KillMode=mixed/.test(text) : process.platform === "win32"
      ? ["cotal", "pnpm cotal"].some(cli => text.includes(`\`${cli} up --space ${SPACE}\``)) && !/ExecStart=|KillMode=mixed/.test(text)
      : text.includes(`manager start --foreground --space ${SPACE}`) && text.includes("KillMode=mixed");
    check(`cotal manager install ${flags.join(" ")} refuses before any effect and names a platform-appropriate next step`,
      install.status === 2 && text.includes("UNSUPPORTED") && text.includes("cotal manager install is not supported yet") && next, text);
  }

  const intake = cotal(["service", "start", "feedback-intake", "--space", SPACE]);
  check("a built-in preset that needs files refuses naming each flag", intake.status === 1 && out(intake).includes("the feedback-intake preset needs --keys, --creds, which have no default; nothing was saved or started"), out(intake));
  check("  and saves nothing", JSON.stringify(definitions()) === "[]", definitions());

  const piped = cotal(["service", "add", "hello", "--exec", "echo hi | tee out", "--space", SPACE]);
  check("service add --exec with a pipe refuses and saves nothing", piped.status === 1 && out(piped).includes("an unquoted | would not work") && JSON.stringify(definitions()) === "[]", out(piped));
  for (const char of ["$", "`"]) {
    const quoted = cotal(["service", "add", "quoted-expansion", "--space", SPACE, "--exec", `node "review process.mjs" "space argument" "literal ${char}HOME"`, "--json"]);
    const { outcome, error } = JSON.parse(quoted.stdout);
    check(`service add --exec explains how to pass ${char} literally when double quotes alone do not work`,
      quoted.status === 1 && outcome === "refused" && error?.code === "USAGE_INVALID"
        && error.message.includes(`${char} inside double quotes`)
        && error.remedy.includes("within the value passed to `--exec`, put the literal argument in single quotes")
        && error.remedy.includes("put a backslash before the character inside double quotes")
        && error.remedy.includes("run a shell yourself") && JSON.stringify(definitions()) === "[]", out(quoted));
  }
  const conflicting = cotal(["service", "add", "hello", "--exec", "echo hi", "--preset", "manager", "--space", SPACE]);
  check("service add --exec with --preset refuses and saves nothing", conflicting.status === 1 && JSON.stringify(definitions()) === "[]", out(conflicting));
  const addExec = ["service", "add", "hello", "--exec", "echo 'big world'", "--space", SPACE];
  for (const args of [addExec, ["service", "list"], ["svc", "rm", "hello"], ["manager", "status"]]) {
    const unknown = cotal([...args, "--wibble"]);
    check(`cotal ${args.slice(0, 2).join(" ")} tells you to drop an unknown option when no operand fits`,
      unknown.status === 1 && unknown.stdout === "" && /Unknown option '--wibble'\n  drop the unknown option\n/.test(unknown.stderr), out(unknown));
  }
  const unknownJson = cotal([...addExec, "--json", "--wibble"]);
  const { error: unknownError } = JSON.parse(unknownJson.stdout);
  check("service add gives the same remedy in JSON and saves nothing",
    unknownJson.status === 1 && unknownJson.stderr === "" && unknownError?.code === "USAGE_INVALID"
      && unknownError.message === "Unknown option '--wibble'" && unknownError.remedy === "drop the unknown option"
      && JSON.stringify(definitions()) === "[]", out(unknownJson));
  const managerUnknown = cotal(["--json", "mgr", "--space", SPACE, "logs", "--tail", "1", "--wibble=3"]);
  const { error: managerUnknownError } = JSON.parse(managerUnknown.stdout);
  check("mgr logs gives the same remedy in JSON with its implicit service name",
    managerUnknown.status === 1 && managerUnknown.stderr === "" && managerUnknownError?.code === "USAGE_INVALID"
      && managerUnknownError.message === "Unknown option '--wibble'" && managerUnknownError.remedy === "drop the unknown option", out(managerUnknown));
  const added = cotal(addExec);
  check("service add <name> --exec saves a program of your own in one command", added.status === 0 && JSON.stringify(definitions()) === '["hello"]', out(added));
  const helloStartHelp = cotal(["service", "start", "hello", "--space", SPACE, "--help"]);
  const helloIdleRefusal = cotal(["service", "start", "hello", "--space", SPACE, "--idle-exit", "5"]);
  check("a saved non-manager service omits --idle-exit in start help and in its manager-only refusal help",
    helloStartHelp.status === 0 && !idleExitOption.test(helloStartHelp.stdout)
    && helloIdleRefusal.status === 1 && helloIdleRefusal.stdout === ""
    && helloIdleRefusal.stderr.includes("--idle-exit belongs to the manager; no launch was allocated")
    && helloIdleRefusal.stderr.endsWith(helloStartHelp.stdout) && !idleExitOption.test(helloIdleRefusal.stderr),
    { help: out(helloStartHelp), refusal: out(helloIdleRefusal) });
  for (const flags of [["--exec", "--json"], ["--json", "--exec"]]) {
    const refusedStatus = cotal(["service", "status", "hello", "--space", SPACE, ...flags]);
    const { outcome, error } = JSON.parse(refusedStatus.stdout);
    check(`service status ${flags.join(" ")} tells you to omit --exec rather than give it a value`,
      refusedStatus.status === 1 && refusedStatus.stderr === "" && outcome === "refused" && error?.code === "USAGE_INVALID"
        && error.message === "`service status` does not take --exec" && error.remedy === "omit --exec", out(refusedStatus));
  }
  const retriedStatus = cotal(["service", "status", "hello", "--space", SPACE, "--json"]);
  const { result: savedStatus } = JSON.parse(retriedStatus.stdout);
  check("omitting --exec reads the saved service without starting it",
    retriedStatus.status === 0 && savedStatus?.recordedState === "not started" && savedStatus.instanceId === null, out(retriedStatus));
  const missingExec = cotal(["service", "add", "hello", "--space", SPACE, "--exec", "--json"]);
  const { error: missingExecError } = JSON.parse(missingExec.stdout);
  check("service add still asks for the value of --exec",
    missingExec.status === 1 && missingExec.stderr === "" && missingExecError?.code === "USAGE_INVALID"
      && missingExecError.remedy === "write --exec <command>", out(missingExec));
  const show = cotal(["service", "show", "hello", "--space", SPACE, "--json"]);
  let launch: { type?: string; executable?: string; argumentCount?: number; cwd?: string } = {};
  try { launch = (JSON.parse(show.stdout) as { result: { launch: typeof launch } }).result.launch; } catch { /* the cell reports the output */ }
  check("  as a direct process: the program pinned to the file PATH finds, its quoted words as one argument, this folder as its directory",
    launch.type === "process" && launch.executable?.endsWith("/echo") === true && launch.executable.startsWith("/") && launch.argumentCount === 1 && launch.cwd === root, show.stdout || out(show));

  // ---- The broker preset in a space that `space create` prepared, with no registered broker -------
  const PREPARED = "servicecommandsprep";
  const created = cotal(["space", "create", PREPARED, "--root", prepared]);
  check("space create prepares a second space, with no registered broker", created.status === 0, out(created));
  const restartPreview = cotal(["manager", "restart", "--space", PREPARED, "--dry-run", "--json"]);
  const { error: restartError, target: restartTarget } = JSON.parse(restartPreview.stdout);
  const firstStart = `manager start --space ${PREPARED} --dry-run`;
  const suggestedPreview = /^preview the first start with `cotal ([^`]+)`$/.exec(restartError?.remedy)?.[1];
  check("a Manager restart preview with no saved definition refuses and suggests a first-start preview in the same space",
    restartPreview.status === 2 && restartError?.code === "TARGET_NOT_FOUND" && restartTarget?.space === PREPARED
      && suggestedPreview === `${firstStart} --json`, out(restartPreview));
  const firstStartPreview = suggestedPreview === `${firstStart} --json` ? cotal(suggestedPreview.split(" ")) : undefined;
  const { result: firstStartResult } = firstStartPreview ? JSON.parse(firstStartPreview.stdout) : {};
  check("the suggested preview loads no provider code and saves or allocates nothing",
    firstStartPreview?.status === 0 && firstStartResult?.dryRun === true && firstStartResult.saved === false
      && firstStartResult.allocated === false && firstStartResult.providerCodeLoaded === false, firstStartPreview && out(firstStartPreview));
  for (const format of [[], ["--plain"]]) {
    const text = cotal(["manager", "restart", "--space", PREPARED, "--dry-run", ...format]);
    check(`a Manager restart preview preserves ${format.length ? "plain" : "default"} output in the suggested command`,
      text.status === 2 && ["cotal", "pnpm cotal"].some((launcher) =>
        out(text).includes(`preview the first start with \`${launcher} ${[firstStart, ...format].join(" ")}\``)), out(text));
  }
  const config = join(prepared, ".cotal", "nats.conf"), binary = join(home, "nats-server");
  writeFileSync(config, "port: 4222\n", { mode: 0o600 });
  writeFileSync(binary, "#!/bin/sh\n", { mode: 0o700 });
  const brokerRow = (() => {
    const run = cotal(["service", "--space", PREPARED, "--json"]);
    try { return (JSON.parse(run.stdout) as { result: { services: { name: string; next: string }[] } }).result.services.find((row) => row.name === "broker")?.next; }
    catch { return out(run); }
  })();
  // The list was given --space, so its Next names it too (#7642).
  check("bare service offers the broker with --server <url> when the space has no registered broker", brokerRow === `cotal service start broker --config <file> --binary <file> --server <url> --space ${PREPARED}`, brokerRow);
  const selected = cotal(["use", SPACE, "--json"]);
  check("the calling project has selected the other space", selected.status === 0, out(selected));
  for (const verb of ["logs", "status"]) {
    for (const operand of [[], ["absent-worker"]]) {
      const missing = cotal(["service", verb, ...operand, "--space", PREPARED, "--json"]);
      const { error, target } = JSON.parse(missing.stdout);
      const inventory = /`cotal (service --space [^`]+)`/.exec(error?.remedy)?.[1];
      const listed = inventory === `service --space ${PREPARED} --json` ? cotal(inventory.split(" ")) : undefined;
      check(`service ${verb} with ${operand.length ? "an unknown" : "no"} name offers a JSON listing of the requested space`,
        (operand.length ? missing.status === 2 && error?.code === "TARGET_NOT_FOUND" && target.space === PREPARED && error.message.endsWith("nothing was read")
          : missing.status === 1 && error?.code === "USAGE_INVALID" && error.message === `service ${verb} needs a definition name`)
          && listed?.status === 0 && JSON.parse(listed.stdout).target.space === PREPARED, { missing: out(missing), listed: listed && out(listed) });
    }
  }
  const missingLog = cotal(["service", "logs", "stack-manager", "--space", PREPARED, "--tail", "30", "--json"]);
  const logError = JSON.parse(missingLog.stdout).error;
  const managerStart = /`cotal (manager start [^`]+)`/.exec(logError.remedy)?.[1];
  const managerPreview = managerStart ? cotal([...managerStart.split(" "), "--dry-run", "--json"]) : undefined;
  check("the missing manager log names the stack root and previews starting the manager in the requested space",
    missingLog.status === 2 && logError.code === "TARGET_NOT_FOUND" && logError.remedy.includes(`\`cotal up --root ${prepared} --space ${PREPARED}\``)
      && managerPreview?.status === 0 && JSON.parse(managerPreview.stdout).target.space === PREPARED, { missingLog: out(missingLog), preview: managerPreview && out(managerPreview) });
  const retryWith = (flags: string) => `rerun the original command with \`${flags}\`, keeping all other arguments and flags unchanged`;
  const fills: Record<string, string> = { "--config": config, "--binary": binary, "--server": `nats://127.0.0.1:${await freePort()}` };
  const previewBrokerCommand = (command: string) => {
    const words = command.split(" ");
    return cotal([...words.slice(words.indexOf("service")).map((word, index, args) => word.startsWith("<") ? fills[args[index - 1]!] ?? word : word), "--dry-run", "--json"]);
  };
  for (const verb of ["status", "logs"]) {
    const missing = cotal(["service", verb, "broker", "--space", PREPARED, "--json"]);
    const { error } = JSON.parse(missing.stdout);
    const command = /`(cotal service start broker[^`]*)`/.exec(error?.remedy)?.[1];
    const retry = command ? previewBrokerCommand(command) : undefined;
    const receipt = retry?.status === 0 ? JSON.parse(retry.stdout) : undefined;
    check(`broker ${verb} names all missing options and its remedy previews a start in the same space`,
      missing.status === 2 && error?.code === "TARGET_NOT_FOUND" && command === brokerRow && receipt?.target.space === PREPARED
      && receipt.result?.saved === false && receipt.result?.allocated === false, { missing: out(missing), retry: retry && out(retry) });
  }
  const registered = cotal(["service", "status", "broker", "--space", SPACE, "--json"]);
  check("the broker status remedy omits --server when the space has a registered broker",
    registered.status === 2 && JSON.parse(registered.stdout).error?.remedy === `start it with \`cotal service start broker --config <file> --binary <file> --space ${SPACE}\``, out(registered));

  const brokerStartHelp = cotal(["service", "start", "broker", "--help"]);
  const brokerHelpCommand = cotal(["help", "service", "start", "broker"]);
  const example = brokerStartHelp.stdout.split("\n").find((line) => line.includes("start the broker in the background"))?.trim().split(/ {2,}/)[0];
  const examplePreview = example ? previewBrokerCommand(`${example} --space ${PREPARED}`) : undefined;
  check("broker start help omits unsupported modes, names the absolute config path requirement, and gives a start that previews successfully",
    brokerStartHelp.status === 0 && brokerHelpCommand.status === 0 && brokerStartHelp.stdout === brokerHelpCommand.stdout
    && !/--foreground\b|--new-instance\b/.test(brokerStartHelp.stdout) && /^  --config <file> +absolute path\b/m.test(brokerStartHelp.stdout)
    && examplePreview?.status === 0, { help: out(brokerStartHelp), preview: examplePreview && out(examplePreview) });
  const badGlobalLeading = cotal(["--no-color=false", "service", "start", "broker"]);
  const badGlobalTrailing = cotal(["service", "start", "broker", "--no-color=false"]);
  check("a malformed global before or after broker start refuses with the full preset help",
    [badGlobalLeading, badGlobalTrailing].every((run) => run.status === 1 && run.stdout === ""
      && run.stderr.includes("--no-color takes no value") && run.stderr.endsWith(brokerStartHelp.stdout)),
    { leading: out(badGlobalLeading), trailing: out(badGlobalTrailing) });
  for (const words of [
    ["start", "broker", "--config", "./nats.conf"],
    ["--space", "help-audit", "start", "broker", "--config", "./nats.conf"],
    ["start", "--space", "help-audit", "broker", "--config", "./nats.conf"],
    ["start", "--config", "./nats.conf", "broker"],
  ]) {
    const brokerHelpWithOptions = cotal(["help", "--", "service", ...words]);
    check(`explicit service ${words.join(" ")} help keeps the broker preset options`,
      brokerHelpWithOptions.status === 0 && brokerHelpWithOptions.stderr === "" && brokerHelpWithOptions.stdout === brokerStartHelp.stdout,
      out(brokerHelpWithOptions));
  }
  const genericStartHelp = cotal(["service", "start", "--help"]);
  check("generic service start help still lists --foreground",
    genericStartHelp.status === 0 && /^  --foreground\b/m.test(genericStartHelp.stdout), out(genericStartHelp));
  const brokerPreviewArgs = ["service", "start", "broker", "--space", PREPARED, "--dry-run", "--server", fills["--server"]!];
  const brokerPreviewWithFiles = [...brokerPreviewArgs, "--config", config, "--binary", binary];
  const foregroundPreview = cotal([...brokerPreviewWithFiles, "--foreground", "--json"]);
  const foregroundError = JSON.parse(foregroundPreview.stdout).error;
  const foregroundPlain = cotal([...brokerPreviewWithFiles, "--foreground", "--plain"]);
  const retry = "Retry without --foreground, keeping --dry-run and the rest of the command unchanged.";
  check("a first broker foreground preview names only the unsupported flag and keeps dry-run in its retry",
    foregroundPreview.status === 2 && foregroundError?.code === "UNSUPPORTED" && foregroundError.message.includes(retry)
      && !foregroundError.message.includes("--new-instance") && foregroundPlain.status === 2 && out(foregroundPlain).includes(retry)
      && serviceDefinitionStore(PREPARED).read("broker") === undefined,
    { json: out(foregroundPreview), plain: out(foregroundPlain) });

  const brokerPartial = cotal(brokerPreviewArgs);
  const brokerCorrected = cotal([...brokerPreviewWithFiles, "--plain"]);
  check("adding missing files or dropping only --foreground gives a valid broker preview that saves and launches nothing",
    brokerPartial.status === 1 && out(brokerPartial).includes(retryWith("--config <file> --binary <file>"))
      && brokerCorrected.status === 0 && out(brokerCorrected).includes("Nothing was saved, launched or loaded.")
      && serviceDefinitionStore(PREPARED).read("broker") === undefined, { refused: out(brokerPartial), corrected: out(brokerCorrected) });

  const brokerNewArgs = ["service", "start", "broker", "--space", PREPARED, "--dry-run", "--new-instance", "--json"];
  const brokerNew = cotal(brokerNewArgs);
  const { error: brokerNewError } = JSON.parse(brokerNew.stdout);
  const edits = /^remove `(--new-instance)` and add `(--config <file> --binary <file> --server <url>)`, keeping the rest of the command unchanged$/.exec(brokerNewError?.remedy);
  const brokerRetry = edits && cotal([...brokerNewArgs.filter((word) => word !== edits[1]), ...edits[2]!.split(" ").map((word, index, words) => fills[words[index - 1]!] ?? word)]);
  const retried = brokerRetry?.status === 0 ? JSON.parse(brokerRetry.stdout) : undefined;
  check("the broker preview retry drops --new-instance, fills the missing options and changes no service state",
    brokerNew.status === 1 && brokerNew.stderr === "" && brokerNewError?.code === "USAGE_INVALID"
      && retried?.target.space === PREPARED && retried.result?.dryRun === true && retried.result.saved === false
      && retried.result.allocated === false && serviceDefinitionStore(PREPARED).read("broker") === undefined,
    { refused: out(brokerNew), retry: brokerRetry && out(brokerRetry) });

  const unready = cotal(["service", "add", "b0", "--preset", "broker", "--space", PREPARED]);
  const printed = out(unready).split("\n").map((line) => line.trim()).find((line) => line.startsWith("cotal service add b0 --preset broker")) ?? "";
  check("a broker add missing its options prints all three options and keeps the explicit space",
    unready.status === 1 && out(unready).includes("the broker preset needs --config, --binary, which have no default, and --server, since space servicecommandsprep has no registered broker; nothing was saved or started")
      && printed === `cotal service add b0 --preset broker --config <file> --binary <file> --server <url> --space ${PREPARED}`, out(unready));
  const tokens = printed.split(" ").slice(1);
  const followed = cotal(tokens.map((word, index) => /^<[a-z]+>$/.test(word) ? fills[tokens[index - 1]!] ?? word : word));
  check("  filling only its placeholders saves the broker in the requested space, not the selected space",
    followed.status === 0 && serviceDefinitionStore(PREPARED).read("b0") !== undefined && serviceDefinitionStore(SPACE).read("b0") === undefined, out(followed));

  const managerArgs = ["manager", "start", "--space", PREPARED, "--dry-run", "--json"];
  const launchFile = join(prepared, ".cotal", "manager launch.json"), launchBytes = "{}\n";
  writeFileSync(launchFile, launchBytes, { mode: 0o600 });
  const digest = createHash("sha256").update(launchBytes).digest("hex");
  const managerPartial = cotal([...managerArgs, "--launch-sha256", digest]);
  const managerError = JSON.parse(managerPartial.stdout);
  check("a pinned manager preview asks for only its missing launch file and preserves the original command",
    managerPartial.status === 1 && managerPartial.stderr === "" && managerError.target.space === PREPARED
      && managerError.error?.code === "USAGE_INVALID" && managerError.error.remedy === retryWith("--launch <file>"), out(managerPartial));
  const managerCorrected = cotal([...managerArgs, "--launch-sha256", digest, "--launch", launchFile]);
  const managerResult = JSON.parse(managerCorrected.stdout);
  check("  adding the launch file previews the requested manager without saving or allocating it",
    managerCorrected.status === 0 && managerResult.command === "manager" && managerResult.target.space === PREPARED
      && managerResult.result?.dryRun === true && managerResult.result.saved === false && managerResult.result.allocated === false
      && serviceDefinitionStore(PREPARED).read("manager") === undefined, out(managerCorrected));

  const brokerAddArgs = ["service", "add", "logs-check", "--preset", "broker", "--space", PREPARED, "--config", config, "--server", fills["--server"]!, "--json"];
  const addPartial = cotal(brokerAddArgs);
  const addCorrected = cotal([...brokerAddArgs, "--binary", binary]);
  const addError = JSON.parse(addPartial.stdout), addResult = JSON.parse(addCorrected.stdout);
  check("a partial broker add asks for only its missing binary, and the corrected command saves without starting",
    addPartial.status === 1 && addPartial.stderr === "" && addError.error?.code === "USAGE_INVALID" && addError.error.remedy === retryWith("--binary <file>")
      && addCorrected.status === 0 && addResult.target.space === PREPARED && addResult.result?.started === false, { refused: out(addPartial), corrected: out(addCorrected) });

  const brokerHelp = out(cotal(["service", "add", "b1", "--preset", "broker", "--space", PREPARED, "--help"]));
  check("broker preset help shows --log-file as a path, as `cotal up` does, described for a preset add", /--log-file <path> +the nats-server log file this configuration's log_file names/.test(brokerHelp) && !brokerHelp.includes("prepared by `cotal up`"), brokerHelp);
  check("broker preset help shows --server as a URL, as its refusal does", /--server <url> +the one broker URL this configuration serves/.test(brokerHelp), brokerHelp);
  /** A broker add in the prepared space with these extra flags, as its JSON error, or the output when it has none. */
  const brokerAdd = (name: string, extra: string[]) => {
    const run = cotal(["service", "add", name, "--preset", "broker", "--space", PREPARED, "--config", config, "--binary", binary, "--server", fills["--server"]!, ...extra, "--json"]);
    try { return { status: run.status, error: (JSON.parse(run.stdout) as { error?: { code: string; message: string; remedy?: string } }).error }; }
    catch { return { status: run.status, error: out(run) }; }
  };
  const next = (name: string) => `see what each option takes with \`cotal service add ${name} --preset broker --help\``;
  // The binary runs in `root`, so a relative --log-file is made absolute there, as `cotal up --log-file` makes it.
  const relativeLog = brokerAdd("b1", ["--log-file", "logs/broker.log"]);
  const installPreview = cotal(["service", "install", "b1", "--space", PREPARED, "--dry-run", "--json"]);
  const installError = JSON.parse(installPreview.stdout).error;
  const read = /`cotal (service [^`]+)`/.exec(installError?.remedy ?? "")?.[1];
  const inventory = read === `service --space ${PREPARED} --json` ? cotal(read.split(" ")) : undefined;
  check("a broker install preview offers a read that lists the saved broker in its own space", installPreview.status === 2 && installError?.code === "UNSUPPORTED" && inventory?.status === 0 && JSON.parse(inventory.stdout).result.services.some((row: { name: string }) => row.name === "b1"), out(installPreview));
  const savedLog = (() => { const launch = serviceDefinitionStore(PREPARED).read("b1")?.record.value.launch; return launch?.type === "adapter" ? launch.options.logFile : undefined; })();
  const absolute = join(realpathSync(root), "logs", "broker.log");
  check("a relative --log-file is saved absolute against the folder add runs in, and its file need not exist yet",
    relativeLog.status === 0 && relativeLog.error === undefined && savedLog === absolute && !existsSync(absolute), { relativeLog, savedLog, absolute });
  const emptyLog = brokerAdd("b2", ["--log-file", ""]), controlLog = brokerAdd("b2", ["--log-file", "logs/a\tb.log"]);
  check("an empty --log-file, or one with a control character, is refused as `cotal up --log-file` refuses it",
    [emptyLog, controlLog].every((run) => run.status === 1 && typeof run.error === "object" && run.error?.code === "USAGE_INVALID" && run.error.message === "--log-file must be a non-empty file path without control characters"), { emptyLog, controlLog });
  const emptyConfig = (() => { const run = cotal(["service", "add", "b2", "--preset", "broker", "--space", PREPARED, "--config", "", "--binary", binary, "--server", fills["--server"]!, "--json"]); try { return (JSON.parse(run.stdout) as { error: { message: string; remedy?: string } }).error; } catch { return out(run); } })();
  check("an empty --config is refused naming the flag typed, not the schema key, with the help as its Next",
    typeof emptyConfig === "object" && emptyConfig.message === "the service options do not match the installed adapter's closed schema at --config; option values were not printed" && emptyConfig.remedy === next("b2"), emptyConfig);

  // ---- A preset name reaches the space's one service built on it, for show and remove too -------
  const addManager = ["service", "add", "m1", "--preset", "manager", "--space", SPACE, "--json", "--max-sessions"];
  for (const [input, rule] of [["0", ">= 1"], ["9007199254740992", "<= 9007199254740991"], ['"private-input-marker"', "integer"]] as const) {
    const refused = cotal([...addManager, input]);
    const { error } = JSON.parse(refused.stdout);
    check(`Manager preset add reports the declared ${rule} constraint without saving a definition`,
      refused.status === 1 && error?.code === "SCHEMA_INVALID" && error.message.includes(`at --max-sessions (must be ${rule})`)
        && !out(refused).includes("private-input-marker") && !serviceDefinitionStore(SPACE).read("m1"), out(refused));
  }
  const manager = cotal([...addManager, "1"]);
  check("service add m1 --preset manager saves m1", manager.status === 0, out(manager));
  for (const args of [["service", "start", "m1", "--space", SPACE, "--help"], ["help", "--", "service", "start", "m1", "--space", SPACE]]) {
    const m1Help = cotal(args);
    check(`cotal ${args.join(" ")} lists --idle-exit for a saved manager definition`,
      m1Help.status === 0 && idleExitOption.test(m1Help.stdout), out(m1Help));
  }
  const m1OtherSpace = cotal(["help", "--", "service", "start", "m1", "--space=missing-manager-help-space"]);
  const m1BadIdle = cotal(["service", "start", "m1", "--space", SPACE, "--idle-exit", "0"]);
  check("saved manager start help is scoped to its space and stays on usage refusals",
    m1OtherSpace.status === 0 && !idleExitOption.test(m1OtherSpace.stdout)
    && m1BadIdle.status === 1 && idleExitOption.test(m1BadIdle.stderr),
    { otherSpace: out(m1OtherSpace), refusal: out(m1BadIdle) });
  const shown = cotal(["service", "show", "manager", "--space", SPACE]);
  check("service show manager reads m1 and says so on stderr", shown.status === 0 && shown.stderr.includes("manager in space servicecommands is the saved service m1") && /Name: +m1\n/.test(shown.stdout), out(shown));
  // #7072: a dry run with another option used to save m1 again, so the next real start used the
  // previewed --runtime. The note about m1 shows the preview reached m1.
  const savedM1 = () => JSON.stringify(serviceDefinitionStore(SPACE).read("m1"));
  const beforePreview = savedM1();
  const preview = cotal(["manager", "start", "--space", SPACE, "--runtime", "absent", "--dry-run"]);
  check("manager start --runtime absent --dry-run refuses the unknown runtime and leaves m1 unchanged",
    preview.status === 2 && out(preview).includes("DEPENDENCY_UNAVAILABLE") && out(preview).includes('unknown runtime "absent"') && savedM1() === beforePreview, { preview: out(preview), before: beforePreview, after: savedM1() });
  const removed = cotal(["service", "remove", "manager", "--space", SPACE, "--yes", "--json"]);
  let removedName: unknown;
  try { removedName = (JSON.parse(removed.stdout) as { result: { kind: string; name: string } }).result; } catch { removedName = out(removed); }
  check("service remove manager --yes forgets m1", removed.status === 0 && JSON.stringify(removedName).includes('"kind":"service-definition-removed","name":"m1"') && JSON.stringify(definitions()) === '["hello"]', removedName);

  // ---- A confirmation command keeps the space it was refused for (#7543) ------------------------
  // `hello` is saved in both spaces, and this folder's space is SPACE, so a printed command without
  // --space forgot SPACE's `hello` instead.
  const second = cotal(["service", "add", "hello", "--exec", "echo hi", "--space", PREPARED]);
  const unconfirmed = cotal(["service", "remove", "hello", "--space", PREPARED, "--no-input"]);
  const confirm = /`(cotal svc remove [^`]*)`/.exec(out(unconfirmed))?.[1] ?? "";
  check("service remove --space <other> --no-input prints a confirmation that names that space",
    second.status === 0 && unconfirmed.status === 1 && confirm === `cotal svc remove hello --space ${PREPARED} --yes`, out(unconfirmed));
  const refusedJson = cotal(["service", "remove", "hello", "--space", PREPARED, "--json"]);
  const confirmJson: string | undefined = JSON.parse(refusedJson.stdout).error?.remedy?.match(/^confirm with `cotal (.+)`$/)?.[1];
  check("service remove with --json keeps the definition until confirmed and prints a JSON confirmation",
    refusedJson.status === 1 && serviceDefinitionStore(PREPARED).read("hello") !== undefined && confirmJson === `svc remove hello --space ${PREPARED} --yes --json`, out(refusedJson));
  const confirmed = confirmJson ? cotal(confirmJson.split(" ")) : undefined;
  check("the printed confirmation returns a JSON receipt, forgets that space's service and keeps this folder's",
    confirmed?.status === 0 && JSON.parse(confirmed.stdout).result?.kind === "service-definition-removed"
      && serviceDefinitionStore(PREPARED).read("hello") === undefined && serviceDefinitionStore(SPACE).read("hello") !== undefined, confirmed && out(confirmed));

  const colorEnv: NodeJS.ProcessEnv = { ...env, FORCE_COLOR: "1" };
  delete colorEnv.NO_COLOR;
  const addedPlain = cotal(["service", "add", "plain-retry", "--exec", "/bin/true", "--space", PREPARED, "--json"]);
  const refusedPlain = cotal(["service", "remove", "plain-retry", "--space", PREPARED, "--plain", "--no-input"], colorEnv);
  const confirmPlain = /confirm with `(?:pnpm )?cotal ([^`]+)`/.exec(refusedPlain.stderr)?.[1];
  check("service remove with --plain keeps the definition until confirmed and prints a plain confirmation",
    addedPlain.status === 0 && refusedPlain.status === 1 && serviceDefinitionStore(PREPARED).read("plain-retry") !== undefined
      && confirmPlain === `svc remove plain-retry --space ${PREPARED} --yes --plain`, out(refusedPlain));
  const removedPlain = confirmPlain ? cotal(confirmPlain.split(" "), colorEnv) : undefined;
  check("the copied plain confirmation removes the definition and writes no ANSI even with color forced",
    removedPlain?.status === 0 && removedPlain.stdout.includes("Service definition forgotten") && !removedPlain.stdout.includes("\x1b")
      && serviceDefinitionStore(PREPARED).read("plain-retry") === undefined, removedPlain && out(removedPlain));

  const definitionFile = join(prepared, "service definition.json");
  writeFileSync(definitionFile, JSON.stringify({ schemaVersion: 1, space: PREPARED, launch: { type: "process", executable: "echo", args: ["hello"], cwd: prepared }, readiness: { type: "process", timeoutMs: 1000 } }));
  for (const [name, source, preset] of [
    ["preset-example", ["--preset", "manager", "--runtime", "pty"], "manager"],
    ["file-example", ["--file", definitionFile], null],
    ["exec-example", ["--exec", "echo 'hello world'", "--cwd", prepared], null],
  ] as const) {
    const flags = [...source, "--space", PREPARED, "--json"];
    const refused = cotal(["service", "add", ...flags]);
    const { outcome, error } = JSON.parse(refused.stdout);
    check(`${source[0]} without a name asks to insert only the definition name`,
      refused.status === 1 && refused.stderr === "" && outcome === "refused" && error?.code === "USAGE_INVALID"
        && error.message === "scripted service add needs a definition name"
        && error.remedy === "insert your definition name immediately after `add` in the original command, keeping all flags and values unchanged", out(refused));
    const retry = cotal(["service", "add", name, ...flags]);
    const { result } = JSON.parse(retry.stdout);
    check(`adding the name to ${source[0]} saves in the requested space without starting the service`,
      retry.status === 0 && result?.name === name && result.space === PREPARED && result.preset === preset && result.started === false
        && serviceDefinitionStore(PREPARED).read(name) !== undefined && serviceDefinitionStore(SPACE).read(name) === undefined, out(retry));
  }
} catch (e) {
  check(`suite ran without throwing: ${e instanceof Error ? e.message : String(e)}`, false, e instanceof Error ? e.stack : e);
} finally {
  void anchor;
  for (const dir of [home, root, prepared]) rmSync(dir, { recursive: true, force: true });
  finish();
  process.exit(process.exitCode ?? 0);
}
