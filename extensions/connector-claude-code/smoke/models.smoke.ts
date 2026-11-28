import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { catalogChoiceRefusal, discardLaunchArtifacts, readModelCatalog, type LaunchOpts, type ModelCatalog } from "@cotal-ai/core";
import { createSuite, skipSuite } from "@cotal-ai/smoke-kit";
import { claudeConnector } from "../src/extension.js";

if (process.platform === "win32") skipSuite("the stand-in claude is a POSIX shell script");

const { check, finish } = createSuite();
const recorded = JSON.parse(readFileSync(new URL("./fixtures/claude-initialize.json", import.meta.url), "utf8"));
// What claude 2.1.332 applies with each model in turn, and the fast-mode states it reported as its
// organization check answered: on at first, then off, because this account's organization disables it.
const settings = JSON.parse(readFileSync(new URL("./fixtures/claude-settings.json", import.meta.url), "utf8"));
/** The whole read, from claude's start to its exit, ends within this bound. */
const BOUND_MS = 8_000;
const FAKE = fileURLToPath(new URL("./fake-claude-models.mjs", import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "claude-models-smoke-"));
const LOGGED_IN_IDS = ["opus", "fable", "sonnet", "haiku", "claude-fable-5-1", "claude-haiku-4-5-20251001", "claude-sonnet-5", "claude-opus-5", "claude-fable-5", "claude-opus-4-8", "claude-opus-4-7", "claude-opus-4-6", "claude-sonnet-4-6"];

process.env.CLAUDECODE = "1";
process.env.COTAL_NAME = "models-smoke";

const logs: string[] = [];
function standIn(name: string, reply: unknown, vars: Record<string, string> = {}, recordedSettings: unknown = settings): { bin: string; log: string } {
  const bin = join(dir, name);
  const log = `${bin}.log`;
  logs.push(log);
  writeFileSync(`${bin}.reply.json`, JSON.stringify(reply));
  writeFileSync(`${bin}.settings.json`, JSON.stringify(recordedSettings));
  const assign = Object.entries({ FAKE_CLAUDE_REPLY: `${bin}.reply.json`, FAKE_CLAUDE_SETTINGS: `${bin}.settings.json`, FAKE_CLAUDE_LOG: log, ...vars }).map(([k, v]) => `${k}='${v}'`).join(" ");
  writeFileSync(bin, `#!/bin/sh\n${assign} exec '${process.execPath}' '${FAKE}' "$@"\n`, { mode: 0o700 });
  return { bin, log };
}

const ask = async (bin: string): Promise<ModelCatalog> => claudeConnector.listModels!({ resolvedBinaries: { claude: bin } });
const timed = async (bin: string): Promise<{ catalog: ModelCatalog; waited: number }> => {
  const asked = Date.now();
  const catalog = await ask(bin);
  return { catalog, waited: Date.now() - asked };
};
/** A read that should fail: the catalog it listed instead, or the error it threw. */
const failure = async (bin: string): Promise<{ catalog?: ModelCatalog; error: string; waited: number }> => {
  const asked = Date.now();
  try {
    return { catalog: await ask(bin), error: "", waited: Date.now() - asked };
  } catch (e) {
    return { error: (e as Error).message, waited: Date.now() - asked };
  }
};
const logged = (log: string) => readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line));
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const withModels = (models: unknown) => ({ ...recorded.loggedIn, response: { ...recorded.loggedIn.response, response: { ...recorded.loggedIn.response.response, models } } });
const withSettings = (changes: Record<string, unknown>) => ({ ...settings, ...changes });
const modeIds = (catalog: ModelCatalog, mode: string) => catalog.models.filter((m) => m.modes?.some((x) => x.id === mode)).map((m) => m.id);
/** The models claude says support fast mode, in claude's order. */
const FAST_IDS = ["opus", "fable", "claude-opus-5", "claude-opus-4-8"];
/** The fast toggle of each model that lists one, by model id. */
const fastModes = (catalog: ModelCatalog) => Object.fromEntries(catalog.models.flatMap((m) => m.modes?.filter((x) => x.id === "fast").map((x) => [m.id, x]) ?? []));
const ORG_OFF = "Fast mode has been disabled by your organization";

console.log("claude connector: the model catalog asks claude, never hangs, and fails a read that lists nothing a seat can run");

{
  const { bin, log } = standIn("logged-in", recorded.loggedIn);
  const catalog = await ask(bin);
  const [started, ...rest] = logged(log);
  const goneAtReturn = !alive(started.pid);
  check(
    "a logged-in reply lists every model claude offers except its default pointer, in claude's order",
    catalog.unavailable === undefined && JSON.stringify(catalog.models.map((m) => m.id)) === JSON.stringify(LOGGED_IN_IDS),
    catalog,
  );
  const rows = new Map<string, { displayName: string; resolvedModel: string; supportedEffortLevels?: string[] }>(recorded.loggedIn.response.response.models.map((m: { value: string }) => [m.value, m]));
  const pinned = catalog.models.filter((m) => rows.get(m.id)?.resolvedModel === m.id);
  const aliases = catalog.models.filter((m) => rows.get(m.id)?.resolvedModel !== m.id);
  check("a pinned model carries claude's display name as written", pinned.length === 9 && pinned.every((m) => m.name === rows.get(m.id)?.displayName), pinned);
  check(
    "an alias carries claude's display name and the model it resolves to",
    JSON.stringify(aliases.map((m) => m.name)) === JSON.stringify(["Opus 5.5 (claude-opus-5-5)", "Fable 5.2 (claude-fable-5-2)", "Sonnet 5.5 (claude-sonnet-5-5)", "Haiku 5.5 (claude-haiku-5-5)"]),
    aliases,
  );
  check(
    "each model offers claude's effort levels for it as variants, in claude's order",
    catalog.models.length > 0 && catalog.models.every((m) => JSON.stringify(m.variants?.map((v) => v.name)) === JSON.stringify(rows.get(m.id)?.supportedEffortLevels)),
    catalog.models,
  );
  check(
    "a model claude lists without effort levels offers no variant, and a model with fewer offers only those",
    catalog.models.find((m) => m.id === "claude-haiku-4-5-20251001")?.variants === undefined &&
      JSON.stringify(catalog.models.find((m) => m.id === "claude-opus-4-6")?.variants) === JSON.stringify(["low", "medium", "high", "max"].map((name) => ({ name }))),
    catalog.models,
  );
  const requests = rest.filter((entry) => entry.request).map((entry) => entry.request);
  check(
    "asking writes only control requests, one get_settings per model among them, and no user message",
    requests.length > 0 && requests.every((r) => r.type === "control_request") && requests.filter((r) => r.request?.subtype === "get_settings").length === LOGGED_IN_IDS.length + 1,
    requests,
  );
  const flags = started.argv.flatMap((a: string, i: number) => (a === "--settings" ? [started.argv[i + 1]] : []));
  check(
    "the question starts no MCP server, runs no hook, saves no session, and asks for fast mode in claude's one --settings flag",
    started.argv.includes("--strict-mcp-config") && started.argv.includes("--no-session-persistence") && flags.length === 1 &&
      JSON.parse(flags[0]).disableAllHooks === true && JSON.parse(flags[0]).fastMode === true,
    started.argv,
  );
  check("each model carries claude's own description of it", catalog.models.every((m) => m.description !== undefined && m.description === (rows.get(m.id) as { description?: string })?.description), catalog.models);
  const defaults = Object.fromEntries(catalog.models.map((m) => [m.id, m.defaultVariant]));
  check(
    "each model's default variant is the effort claude applies to a launch of it, and a model claude runs at no level has none",
    defaults.opus === "high" && defaults.fable === "medium" && defaults["claude-opus-4-7"] === "xhigh" && defaults["claude-haiku-4-5-20251001"] === undefined &&
      catalog.models.every((m) => m.defaultVariant === (settings.byModel[m.id].effort ?? undefined)),
    defaults,
  );
  check(
    "the one default model is the first claude lists for the model a launch that names none runs",
    JSON.stringify(catalog.models.filter((m) => m.isDefault).map((m) => m.id)) === JSON.stringify(["opus"]),
    catalog.models.map((m) => [m.id, m.isDefault]),
  );
  const ultracode = modeIds(catalog, "ultracode");
  check(
    "ultracode is an off-by-default toggle on each model claude says can run it, and on no other",
    JSON.stringify(ultracode) === JSON.stringify(LOGGED_IN_IDS.filter((id) => settings.byModel[id].ultracodeAvailable)) &&
      !["claude-opus-4-6", "claude-sonnet-4-6", "claude-haiku-4-5-20251001"].some((id) => ultracode.includes(id)) &&
      catalog.models.every((m) => (m.modes ?? []).filter((x) => x.id === "ultracode").every((x) => JSON.stringify(x) === JSON.stringify({ id: "ultracode", label: "Ultracode", kind: "toggle", default: false }))),
    ultracode,
  );
  const fast = fastModes(catalog);
  check(
    "claude turned fast off once its organization check answered, so each model that supports fast lists it unavailable with claude's own message",
    JSON.stringify(Object.keys(fast)) === JSON.stringify(FAST_IDS) &&
      Object.values(fast).every((x) => JSON.stringify(x) === JSON.stringify({ id: "fast", label: "Fast", kind: "toggle", default: false, unavailable: ORG_OFF })),
    fast,
  );
  const checked = await readModelCatalog({ name: "claude", listModels: () => catalog }, {}).then(() => "read", (e: Error) => e.message);
  check("core reads the catalog as consistent: one default model, and every default among its model's values", checked === "read", checked);
  // The launch check a spawn runs, against this catalog where the organization turns fast off.
  const refusal = (modes: Record<string, boolean>) => catalogChoiceRefusal(claudeConnector, { model: "opus", modes }, async () => catalog);
  const on = await refusal({ fast: true });
  check("core refuses a launch that turns the unavailable fast on, with claude's reason", on?.includes(ORG_OFF) === true, on);
  const off = await refusal({ fast: false });
  const spec = claudeConnector.buildLaunch({ space: "s", name: "seat", events: false, model: "opus", modes: { fast: false } } as LaunchOpts);
  discardLaunchArtifacts(spec.artifacts ?? []);
  const rendered = spec.args.flatMap((a, i) => (a === "--settings" ? [spec.args[i + 1]] : []));
  check(
    "fast=false passes core's check though fast is unavailable, and reaches claude as fast mode off",
    off === undefined && JSON.stringify(rendered) === JSON.stringify(['{"fastMode":false}']),
    { off, rendered },
  );
  check(
    "claude gets a launch's env, without this process's mesh identity or Claude session marker",
    started.env.includes("PATH") && !started.env.includes("COTAL_NAME") && !started.env.includes("CLAUDECODE"),
    started.env,
  );
  check("the claude that answered is gone when the read returns", goneAtReturn, started.pid);
  check("that claude exits 0 on its own once the lister closes its input", rest.some((entry) => entry.stdinClosed) && rest.some((entry) => entry.exited === 0), rest);
  check(
    "claude runs in an empty private directory, which is gone when the read returns",
    Array.isArray(started.cwdEntries) && started.cwdEntries.length === 0 && typeof started.cwd === "string" && !existsSync(started.cwd),
    started.cwd,
  );
}

{
  const read = await failure(standIn("logged-out", recorded.loggedOut).bin);
  check("a logged-out claude fails the read and says to log in, though it answered with its built-in aliases", read.catalog === undefined && /not logged in; run claude to log in/.test(read.error), read);
}

{
  // The account claude 2.1.322 reports when ANTHROPIC_API_KEY is its only credential.
  const account = { tokenSource: "none", apiKeySource: "ANTHROPIC_API_KEY", apiProvider: "firstParty" };
  const reply = { ...recorded.loggedOut, response: { ...recorded.loggedOut.response, response: { ...recorded.loggedOut.response.response, account } } };
  const catalog = await ask(standIn("api-key", reply).bin);
  check(
    "a reply with no login token but an API key source lists the models instead of saying claude is logged out",
    catalog.unavailable === undefined && JSON.stringify(catalog.models.map((m) => m.id)) === JSON.stringify(["opus", "fable", "sonnet", "haiku"]),
    catalog,
  );
  // This login's display names carry no version, so the resolved model is what tells them apart.
  check(
    "an alias whose display name has no version still names the model it resolves to",
    JSON.stringify(catalog.models.map((m) => m.name)) === JSON.stringify(["Opus (claude-opus-5-5)", "Fable (claude-fable-5-2)", "Sonnet (claude-sonnet-5-5)", "Haiku (claude-haiku-5-5)"]),
    catalog.models,
  );
}

{
  // claude 2.1.331 lists Fable this way for a gateway-token login: the 1M-context id with a bare display name.
  const fable = { value: "claude-fable-5-2[1m]", resolvedModel: "claude-fable-5-2", displayName: "Fable", supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"] };
  const catalog = await ask(standIn("extended-id", withModels([fable])).bin);
  check("a model id that extends the resolved model is named with that id, not the shorter one", catalog.models[0]?.name === "Fable (claude-fable-5-2[1m])", catalog);
}

{
  // An organization that allows fast mode: claude keeps reporting it on.
  const { catalog } = await timed(standIn("fast-allowed", recorded.loggedIn, {}, withSettings({ fastStates: [{ fast_mode_state: "on" }] })).bin);
  const fast = fastModes(catalog);
  check(
    "an account that can run fast gets a usable, off-by-default fast toggle on each model claude says supports it, and on no other",
    JSON.stringify(Object.keys(fast)) === JSON.stringify(FAST_IDS) &&
      Object.values(fast).every((x) => JSON.stringify(x) === JSON.stringify({ id: "fast", label: "Fast", kind: "toggle", default: false })),
    fast,
  );
}

{
  // claude reports fast on for its first answers, then off once its organization check answers.
  const late = [...Array(4).fill({ fast_mode_state: "on" }), { fast_mode_state: "off", fast_mode_disabled_reason: "preference" }];
  const { catalog } = await timed(standIn("fast-off-late", recorded.loggedIn, {}, withSettings({ fastStates: late })).bin);
  check(
    "fast that claude turns off a few answers in, before its organization check could be missed, is listed unavailable with claude's message",
    catalog.unavailable === undefined && Object.keys(fastModes(catalog)).length === FAST_IDS.length && Object.values(fastModes(catalog)).every((x) => x.unavailable === ORG_OFF),
    catalog,
  );
}

for (const [name, state, reason] of [
  ["fast-off-other-code", { fast_mode_state: "off", fast_mode_disabled_reason: "network_error" }, "claude reports fast mode off: network_error"],
  ["fast-off-no-code", { fast_mode_state: "off" }, "claude reports fast mode off"],
] as const) {
  const { catalog } = await timed(standIn(name, recorded.loggedIn, {}, withSettings({ fastStates: [state] })).bin);
  const fast = Object.values(fastModes(catalog));
  check(`${name}: a reason claude gave no message for here is shown in claude's own words`, fast.length === FAST_IDS.length && fast.every((x) => x.unavailable === reason), fast);
}

{
  const models = recorded.loggedIn.response.response.models.map(({ supportsFastMode: _, ...m }: Record<string, unknown>) => m);
  const { bin, log } = standIn("no-fast-model", withModels(models), {}, withSettings({ fastStates: [{ fast_mode_state: "on" }] }));
  const { catalog, waited } = await timed(bin);
  const initializes = logged(log).filter((e) => e.request?.request?.subtype === "initialize").length;
  check(
    "a login with no model that supports fast offers none, and is not kept waiting on its organization's answer",
    catalog.unavailable === undefined && modeIds(catalog, "fast").length === 0 && initializes === 1 && waited < 2_000,
    { initializes, waited },
  );
}

{
  const byModel = { ...settings.byModel, opus: { ...settings.byModel.opus, effort: "turbo" } };
  const { catalog } = await timed(standIn("default-not-listed", recorded.loggedIn, {}, withSettings({ byModel })).bin);
  check(
    "an effort claude applies that is not one of the model's levels is not named its default",
    catalog.unavailable === undefined && catalog.models.find((m) => m.id === "opus")?.defaultVariant === undefined && catalog.models.find((m) => m.id === "fable")?.defaultVariant === "medium",
    catalog.models.slice(0, 2),
  );
}

{
  const launchDefault = { ...settings.launchDefault, model: "claude-unlisted-1" };
  const { catalog } = await timed(standIn("default-unlisted", recorded.loggedIn, {}, withSettings({ launchDefault })).bin);
  check("a model a launch with none would run, which claude does not list, marks no default", catalog.unavailable === undefined && !catalog.models.some((m) => m.isDefault), catalog.models);
}

{
  const read = await failure(standIn("no-get-settings", recorded.loggedIn, {}, withSettings({ refuse: "get_settings" })).bin);
  check("a claude that refuses get_settings fails the read with its reason, not a list without defaults", read.catalog === undefined && /refused.*get_settings/.test(read.error), read);
}

{
  const read = await failure(standIn("no-applied", recorded.loggedIn, {}, withSettings({ launchDefault: { model: 7 } })).bin);
  check("a get_settings answer without the applied settings fails the read", read.catalog === undefined && /without the settings it applies/.test(read.error), read);
}

{
  const models = recorded.loggedIn.response.response.models.map((m: Record<string, unknown>) => (m.value === "opus" ? { ...m, supportedEffortLevels: "high" } : m));
  const read = await failure(standIn("levels-not-a-list", withModels(models)).bin);
  check("a model whose effort levels are not a list of names fails the read", read.catalog === undefined && /malformed model list/.test(read.error), read);
}

{
  const read = await failure(standIn("refused", recorded.refused).bin);
  check("a refused request fails the read with claude's own reason", read.catalog === undefined && read.error.includes(recorded.refused.response.error), read);
}

{
  const read = await failure(standIn("not-a-list", withModels("opus")).bin);
  check("a model list that is not a list fails the read", read.catalog === undefined && /malformed model list/.test(read.error), read);
}

{
  const read = await failure(standIn("row-without-value", withModels([...recorded.loggedIn.response.response.models, { displayName: "Unnamed" }])).bin);
  check("one model row with no value fails the read, not a partial list", read.catalog === undefined && /malformed model list/.test(read.error), read);
}

{
  const catalog = await ask(standIn("no-list", withModels(undefined)).bin);
  check("an answer with no model list at all is unavailable, since that claude has no catalog to list", catalog.models.length === 0 && /without a model list/.test(catalog.unavailable ?? ""), catalog);
}

{
  const rows = [{ value: "opus", displayName: "Opus", supportsEffort: true, supportedEffortLevels: ["low", "turbo", "max"] }, { value: "haiku", displayName: "Haiku", supportsEffort: false, supportedEffortLevels: ["low"] }];
  const catalog = await ask(standIn("odd-effort", withModels(rows)).bin);
  check(
    "a level --effort does not take is left out, and a model claude marks without effort has no variants",
    JSON.stringify(catalog.models.map((m) => m.variants?.map((v) => v.name))) === JSON.stringify([["low", "max"], undefined]),
    catalog.models,
  );
}

{
  const read = await failure(join(dir, "missing", "claude"));
  check("a missing claude fails the read, naming the failed start", read.catalog === undefined && /could not start/.test(read.error), read);
}

{
  const read = await failure(standIn("exits", "exit").bin);
  check("a claude that exits before answering fails the read, naming its exit", read.catalog === undefined && /exited \(3\)/.test(read.error), read);
}

{
  const { bin, log } = standIn("stubborn", recorded.loggedIn, { FAKE_CLAUDE_STUBBORN: "1" });
  const { catalog, waited } = await timed(bin);
  const [started, ...rest] = logged(log);
  check(
    "a claude still running a second after its input closes is killed then, well inside the bound",
    catalog.unavailable === undefined && rest.some((entry) => entry.stdinClosed) && !alive(started.pid) && waited >= 1_000 && waited < 3_000,
    { waited, pid: started.pid, unavailable: catalog.unavailable },
  );
}

{
  const { bin, log } = standIn("late-and-stubborn", recorded.loggedIn, { FAKE_CLAUDE_STUBBORN: "1", FAKE_CLAUDE_ANSWER_DELAY_MS: String(BOUND_MS - 500) });
  const { waited } = await failure(bin);
  const { pid } = logged(log)[0];
  check("a stubborn claude that answers late still ends the whole read by the bound", waited < BOUND_MS + 500 && !alive(pid), { waited, pid });
}

{
  const { bin, log } = standIn("silent", "silent", { FAKE_CLAUDE_STUBBORN: "1" });
  const { catalog, error, waited } = await failure(bin);
  check(
    "a claude that never answers fails the read once the bound passes, not a hang",
    catalog === undefined && error.includes(`within ${BOUND_MS / 1000}s`) && waited >= BOUND_MS - 500 && waited < BOUND_MS + 3_000,
    { waited, catalog, error },
  );
  check("the bound kills a stuck claude at once, without the exit grace an answered claude gets", waited < BOUND_MS + 900, waited);
  const { pid } = logged(log)[0];
  check("the lister kills the claude it gave up on", !alive(pid), pid);
}

{
  // spawn.env names reach the catalog's claude as they reach a launch, so a provider that only
  // spawn.env configures lists the models a seat would run. A name nobody declared stays out.
  Object.assign(process.env, { CATALOG_GATEWAY_URL: "https://gateway.invalid", CATALOG_UNDECLARED: "undeclared" });
  const { bin, log } = standIn("env-allow", recorded.loggedIn);
  await claudeConnector.listModels!({ resolvedBinaries: { claude: bin }, envAllow: ["CATALOG_GATEWAY_URL"] });
  const seen: string[] = logged(log)[0]?.env ?? [];
  check(
    "a catalog read gives claude the spawn.env names a launch gets, and no name spawn.env does not declare",
    seen.includes("CATALOG_GATEWAY_URL") && !seen.includes("CATALOG_UNDECLARED"),
    seen.filter((name) => name.startsWith("CATALOG_")),
  );
  delete process.env.CATALOG_GATEWAY_URL;
  delete process.env.CATALOG_UNDECLARED;
}

for (const log of logs) {
  const pid = existsSync(log) ? logged(log)[0]?.pid : undefined;
  if (pid !== undefined && alive(pid)) process.kill(pid, "SIGKILL");
}
rmSync(dir, { recursive: true, force: true });
finish();
process.exit();
