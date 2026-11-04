/**
 * The short service commands, with no broker: `service add --exec` word splitting, preset option
 * defaults, the refusal that names an option with no default, the built-in presets' own defaults,
 * which recorded adapter pins this release still controls after an upgrade, `cotal manager <verb>`
 * dispatch onto the manager preset, and the help listing that names `manager` and `service` under
 * Services.
 *
 * The in-process cells register a fixture adapter and preset of their own. The CLI cells run the real
 * binary from a sandboxed HOME, COTAL_HOME and project root against a registered space whose broker
 * port nothing listens on; every one of them refuses or reads before any process starts. The suite
 * removes its directories.
 *
 * Run: pnpm smoke:service-commands
 */
import { spawnSync } from "node:child_process";
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
const { serviceDefinitionStore } = await import("../../implementations/cli/src/lib/service-definitions.js");
const { presetDefaultOptions, presetMaterialPath, servicePresetDefinition, servicePresetFlags } = await import("../../implementations/cli/src/lib/service-presets.js");
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
check("a broker default with no registered space refuses and names the flag", unregistered?.code === "DEPENDENCY_UNAVAILABLE" && unregistered.message.includes("--server") && unregistered.remedy?.includes("pass --server <url>") === true, unregistered);
const SERVER = `nats://127.0.0.1:${await freePort()}`;
recordMesh({ space: SPACE, server: SERVER, root, mode: "open", ts: new Date().toISOString() });
const absent = refusal(() => presetDefaultOptions(preset, SPACE, root, { token: "t" }, false));
const creds = presetMaterialPath("fixture.creds", SPACE, root, false);
check("a file default the space does not keep refuses, naming the file and the flag, and invents none",
  absent?.code === "DEPENDENCY_UNAVAILABLE" && absent.message.includes(creds) && absent.message.includes("does not exist yet") && absent.remedy?.includes("pass --creds <file>") === true, absent);
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
check("the web preset defaults to this space's root and read-only", sorted(builtIn("web")?.defaults) === sorted({ "read-only": { value: true }, root: { space: "root" } }), builtIn("web")?.defaults);
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

// ---- Help lists manager and service under Services; supervise is hidden ------------------------
const command = (name: string) => registry.all<Command>("command").find((row) => row.name === name);
check("manager and service are listed under Services", command("manager")?.group === "Services" && command("service")?.group === "Services" && !command("manager")?.hidden && !command("service")?.hidden, [command("manager")?.group, command("service")?.group]);
check("supervise is hidden", command("supervise")?.hidden === true);

// ---- The real binary --------------------------------------------------------------------------
const env: NodeJS.ProcessEnv = { ...process.env };
for (const key of Object.keys(env)) if (key.startsWith("COTAL_") || key === "INVOCATION_ID") delete env[key];
Object.assign(env, { HOME: home, USERPROFILE: home, COTAL_HOME: join(home, ".cotal"), XDG_CONFIG_HOME: xdg, COTAL_SKIP_CONNECTOR_SEED: "1", NO_COLOR: "1", COLUMNS: "200" });
const cotal = (args: string[]) => spawnSync(process.execPath, ["--import", TSX_LOADER, BIN, ...args], { cwd: root, env, encoding: "utf8", timeout: 120_000 });
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

  const status = cotal(["manager", "status", "--space", SPACE]);
  check("cotal manager status with no manager started says so and names manager start",
    status.status === 2 && out(status).includes("TARGET_NOT_FOUND") && out(status).includes("no manager has been started in space servicecommands") && out(status).includes("cotal manager start"), out(status));

  const install = cotal(["manager", "install", "--space", SPACE, "--dry-run"]);
  check("cotal manager install refuses before any effect and names a unit of your own running manager start --foreground",
    install.status === 2 && out(install).includes("UNSUPPORTED") && out(install).includes("cotal manager install is not supported yet") && out(install).includes("manager start --foreground --space servicecommands") && out(install).includes("KillMode=mixed"), out(install));

  const intake = cotal(["service", "start", "feedback-intake", "--space", SPACE]);
  check("a built-in preset that needs files refuses naming each flag", intake.status === 1 && out(intake).includes("the feedback-intake preset needs --keys, --creds, which have no default; nothing was saved or started"), out(intake));
  check("  and saves nothing", JSON.stringify(definitions()) === "[]", definitions());

  const piped = cotal(["service", "add", "hello", "--exec", "echo hi | tee out", "--space", SPACE]);
  check("service add --exec with a pipe refuses and saves nothing", piped.status === 1 && out(piped).includes("an unquoted | would not work") && JSON.stringify(definitions()) === "[]", out(piped));
  const conflicting = cotal(["service", "add", "hello", "--exec", "echo hi", "--preset", "manager", "--space", SPACE]);
  check("service add --exec with --preset refuses and saves nothing", conflicting.status === 1 && JSON.stringify(definitions()) === "[]", out(conflicting));
  const added = cotal(["service", "add", "hello", "--exec", "echo 'big world'", "--space", SPACE]);
  check("service add <name> --exec saves a program of your own in one command", added.status === 0 && JSON.stringify(definitions()) === '["hello"]', out(added));
  const show = cotal(["service", "show", "hello", "--space", SPACE, "--json"]);
  let launch: { type?: string; executable?: string; argumentCount?: number; cwd?: string } = {};
  try { launch = (JSON.parse(show.stdout) as { result: { launch: typeof launch } }).result.launch; } catch { /* the cell reports the output */ }
  check("  as a direct process: the program pinned to the file PATH finds, its quoted words as one argument, this folder as its directory",
    launch.type === "process" && launch.executable?.endsWith("/echo") === true && launch.executable.startsWith("/") && launch.argumentCount === 1 && launch.cwd === root, show.stdout || out(show));

  // ---- The broker preset in a space that `space create` prepared, with no registered broker -------
  const PREPARED = "servicecommandsprep";
  const created = cotal(["space", "create", PREPARED, "--root", prepared]);
  check("space create prepares a second space, with no registered broker", created.status === 0, out(created));
  const config = join(prepared, ".cotal", "nats.conf"), binary = join(home, "nats-server");
  writeFileSync(config, "port: 4222\n", { mode: 0o600 });
  writeFileSync(binary, "#!/bin/sh\n", { mode: 0o700 });
  const brokerRow = (() => {
    const run = cotal(["service", "--space", PREPARED, "--json"]);
    try { return (JSON.parse(run.stdout) as { result: { services: { name: string; next: string }[] } }).result.services.find((row) => row.name === "broker")?.next; }
    catch { return out(run); }
  })();
  check("bare service offers the broker with --server <url> when the space has no registered broker", brokerRow === "cotal service start broker --config <file> --binary <file> --server <url>", brokerRow);
  const unready = cotal(["service", "add", "b0", "--preset", "broker", "--space", PREPARED]);
  const printed = out(unready).split("\n").map((line) => line.trim()).find((line) => line.startsWith("cotal service add b0 --preset broker")) ?? "";
  check("a broker add missing its options names --server too, and prints a line with all three",
    unready.status === 1 && out(unready).includes("the broker preset needs --config, --binary, which have no default, and --server, since space servicecommandsprep has no registered broker; nothing was saved or started")
      && printed === "cotal service add b0 --preset broker --config <file> --binary <file> --server <url>", out(unready));
  const fills: Record<string, string> = { "--config": config, "--binary": binary, "--server": `nats://127.0.0.1:${await freePort()}` };
  const tokens = printed.split(" ").slice(1);
  const followed = cotal([...tokens.map((word, index) => /^<[a-z]+>$/.test(word) ? fills[tokens[index - 1]!] ?? word : word), "--space", PREPARED]);
  check("  and that line, with each placeholder filled in, saves the broker the first time it runs", followed.status === 0 && out(followed).includes("Service definition saved"), out(followed));

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
  const manager = cotal(["service", "add", "m1", "--preset", "manager", "--space", SPACE]);
  check("service add m1 --preset manager saves m1", manager.status === 0, out(manager));
  const shown = cotal(["service", "show", "manager", "--space", SPACE]);
  check("service show manager reads m1 and says so on stderr", shown.status === 0 && shown.stderr.includes("manager in space servicecommands is the saved service m1") && /Name: +m1\n/.test(shown.stdout), out(shown));
  const removed = cotal(["service", "remove", "manager", "--space", SPACE, "--yes", "--json"]);
  let removedName: unknown;
  try { removedName = (JSON.parse(removed.stdout) as { result: { kind: string; name: string } }).result; } catch { removedName = out(removed); }
  check("service remove manager --yes forgets m1", removed.status === 0 && JSON.stringify(removedName).includes('"kind":"service-definition-removed","name":"m1"') && JSON.stringify(definitions()) === '["hello"]', removedName);
} catch (e) {
  check(`suite ran without throwing: ${e instanceof Error ? e.message : String(e)}`, false, e instanceof Error ? e.stack : e);
} finally {
  void anchor;
  for (const dir of [home, root, prepared]) rmSync(dir, { recursive: true, force: true });
  finish();
  process.exit(process.exitCode ?? 0);
}
