import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ModelCatalog } from "@cotal-ai/core";
import { createSuite, skipSuite } from "@cotal-ai/smoke-kit";
import { claudeConnector } from "../src/extension.js";

if (process.platform === "win32") skipSuite("the stand-in claude is a POSIX shell script");

const { check, finish } = createSuite();
const recorded = JSON.parse(readFileSync(new URL("./fixtures/claude-initialize.json", import.meta.url), "utf8"));
const FAKE = fileURLToPath(new URL("./fake-claude-models.mjs", import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "claude-models-smoke-"));
const LOGGED_IN_IDS = ["opus", "fable", "sonnet", "haiku", "claude-fable-5-1", "claude-haiku-4-5-20251001", "claude-sonnet-5", "claude-opus-5", "claude-fable-5", "claude-opus-4-8", "claude-opus-4-7", "claude-opus-4-6", "claude-sonnet-4-6"];

process.env.CLAUDECODE = "1";
process.env.COTAL_NAME = "models-smoke";

const logs: string[] = [];
function standIn(name: string, reply: unknown, vars: Record<string, string> = {}): { bin: string; log: string } {
  const bin = join(dir, name);
  const log = `${bin}.log`;
  logs.push(log);
  writeFileSync(`${bin}.reply.json`, JSON.stringify(reply));
  const assign = Object.entries({ FAKE_CLAUDE_REPLY: `${bin}.reply.json`, FAKE_CLAUDE_LOG: log, ...vars }).map(([k, v]) => `${k}='${v}'`).join(" ");
  writeFileSync(bin, `#!/bin/sh\n${assign} exec '${process.execPath}' '${FAKE}' "$@"\n`, { mode: 0o700 });
  return { bin, log };
}

const ask = async (bin: string): Promise<ModelCatalog> => claudeConnector.listModels!({ resolvedBinaries: { claude: bin } });
const timed = async (bin: string): Promise<{ catalog: ModelCatalog; waited: number }> => {
  const asked = Date.now();
  const catalog = await ask(bin);
  return { catalog, waited: Date.now() - asked };
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

console.log("claude connector: the model catalog asks claude, and never hangs or throws");

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
  const requests = rest.filter((entry) => entry.request);
  check(
    "asking writes one initialize control request and no user message",
    requests.length === 1 && requests[0].request.type === "control_request" && requests[0].request.request?.subtype === "initialize",
    requests,
  );
  const settings = started.argv[started.argv.indexOf("--settings") + 1];
  check(
    "the question starts no MCP server, runs no hook and saves no session",
    started.argv.includes("--strict-mcp-config") && started.argv.includes("--no-session-persistence") && JSON.parse(settings ?? "{}").disableAllHooks === true,
    started.argv,
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
  const catalog = await ask(standIn("logged-out", recorded.loggedOut).bin);
  check("a logged-out claude is unavailable and says to log in, though it answered with its built-in aliases", catalog.models.length === 0 && /not logged in/.test(catalog.unavailable ?? ""), catalog);
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
  const models = recorded.loggedIn.response.response.models.map((m: Record<string, unknown>) => (m.value === "opus" ? { ...m, supportedEffortLevels: "high" } : m));
  const catalog = await ask(standIn("levels-not-a-list", withModels(models)).bin);
  check("a model whose effort levels are not a list of names makes the catalog unavailable", catalog.models.length === 0 && /without a model list/.test(catalog.unavailable ?? ""), catalog);
}

{
  const catalog = await ask(standIn("refused", recorded.refused).bin);
  check("a refused request is unavailable with claude's own reason", catalog.models.length === 0 && (catalog.unavailable ?? "").includes(recorded.refused.response.error), catalog);
}

{
  const catalog = await ask(standIn("not-a-list", withModels("opus")).bin);
  check("a model list that is not a list makes the catalog unavailable", catalog.models.length === 0 && /without a model list/.test(catalog.unavailable ?? ""), catalog);
}

{
  const catalog = await ask(standIn("row-without-value", withModels([...recorded.loggedIn.response.response.models, { displayName: "Unnamed" }])).bin);
  check("one model row with no value makes the catalog unavailable, not a partial list", catalog.models.length === 0 && /without a model list/.test(catalog.unavailable ?? ""), catalog);
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
  let thrown: unknown;
  const catalog = await ask(join(dir, "missing", "claude")).catch((e: unknown) => {
    thrown = e;
    return undefined;
  });
  check("a missing claude is unavailable, naming the failed start, and never throws", thrown === undefined && catalog?.models.length === 0 && /could not start/.test(catalog.unavailable ?? ""), { thrown, catalog });
}

{
  const catalog = await ask(standIn("exits", "exit").bin);
  check("a claude that exits before answering is unavailable, naming its exit", catalog.models.length === 0 && /exited \(3\)/.test(catalog.unavailable ?? ""), catalog);
}

{
  const { bin, log } = standIn("stubborn", recorded.loggedIn, { FAKE_CLAUDE_STUBBORN: "1" });
  const { catalog, waited } = await timed(bin);
  const [started, ...rest] = logged(log);
  check(
    "a claude still running a second after its input closes is killed then, well inside the 6s bound",
    catalog.unavailable === undefined && rest.some((entry) => entry.stdinClosed) && !alive(started.pid) && waited >= 1_000 && waited < 3_000,
    { waited, pid: started.pid, unavailable: catalog.unavailable },
  );
}

{
  const { bin, log } = standIn("late-and-stubborn", recorded.loggedIn, { FAKE_CLAUDE_STUBBORN: "1", FAKE_CLAUDE_ANSWER_DELAY_MS: "5500" });
  const { waited } = await timed(bin);
  const { pid } = logged(log)[0];
  check("a stubborn claude that answers late still ends the whole read by the 6s bound", waited < 6_500 && !alive(pid), { waited, pid });
}

{
  const { bin, log } = standIn("silent", "silent", { FAKE_CLAUDE_STUBBORN: "1" });
  const { catalog, waited } = await timed(bin);
  check(
    "a claude that never answers is unavailable once the 6s bound passes, not a hang",
    catalog.models.length === 0 && /within 6s/.test(catalog.unavailable ?? "") && waited >= 5_500 && waited < 9_000,
    { waited, catalog },
  );
  check("the 6s bound kills a stuck claude at once, without the exit grace an answered claude gets", waited < 6_900, waited);
  const { pid } = logged(log)[0];
  check("the lister kills the claude it gave up on", !alive(pid), pid);
}

for (const log of logs) {
  const pid = existsSync(log) ? logged(log)[0]?.pid : undefined;
  if (pid !== undefined && alive(pid)) process.kill(pid, "SIGKILL");
}
rmSync(dir, { recursive: true, force: true });
finish();
process.exit();
