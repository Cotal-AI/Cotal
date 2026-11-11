import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

function standIn(name: string, reply: unknown): { bin: string; log: string } {
  const bin = join(dir, name);
  const log = `${bin}.log`;
  writeFileSync(`${bin}.reply.json`, JSON.stringify(reply));
  writeFileSync(bin, `#!/bin/sh\nFAKE_CLAUDE_REPLY='${bin}.reply.json' FAKE_CLAUDE_LOG='${log}' exec '${process.execPath}' '${FAKE}' "$@"\n`, { mode: 0o700 });
  return { bin, log };
}

const ask = async (bin: string): Promise<ModelCatalog> => claudeConnector.listModels!({ resolvedBinaries: { claude: bin } });
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
  check(
    "a logged-in reply lists every model claude offers except its default pointer, in claude's order",
    catalog.unavailable === undefined && JSON.stringify(catalog.models.map((m) => m.id)) === JSON.stringify(LOGGED_IN_IDS),
    catalog,
  );
  const names = new Map(recorded.loggedIn.response.response.models.map((m: { value: string; displayName: string }) => [m.value, m.displayName]));
  check("each model carries claude's display name", catalog.models.length > 0 && catalog.models.every((m) => m.name === names.get(m.id)), catalog.models);
  check("no model offers a variant, because this connector refuses a variant at launch", catalog.models.length > 0 && catalog.models.every((m) => m.variants === undefined), catalog.models);
  const [started, ...requests] = logged(log);
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
}

{
  const catalog = await ask(standIn("logged-out", recorded.loggedOut).bin);
  check("a logged-out claude is unavailable and says to log in, though it answered with its built-in aliases", catalog.models.length === 0 && /not logged in/.test(catalog.unavailable ?? ""), catalog);
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
  const { bin, log } = standIn("silent", "silent");
  const asked = Date.now();
  const catalog = await ask(bin);
  const waited = Date.now() - asked;
  check(
    "a claude that never answers is unavailable once the 6s bound passes, not a hang",
    catalog.models.length === 0 && /within 6s/.test(catalog.unavailable ?? "") && waited >= 5_500 && waited < 9_000,
    { waited, catalog },
  );
  const { pid } = logged(log)[0];
  // The kill is sent before the lister returns. The pid is gone once this process reaps the child.
  for (const giveUp = Date.now() + 3_000; alive(pid) && Date.now() < giveUp; ) await new Promise((r) => setTimeout(r, 50));
  check("the lister kills the claude it gave up on", !alive(pid), pid);
  if (alive(pid)) process.kill(pid, "SIGKILL");
}

rmSync(dir, { recursive: true, force: true });
finish();
process.exit();
