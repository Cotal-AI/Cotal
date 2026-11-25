import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createSuite } from "@cotal-ai/smoke-kit";
import type { ModelCatalog } from "@cotal-ai/core";
import { listPiModels, piConnector } from "../src/connector.js";

for (const key of Object.keys(process.env)) if (key.startsWith("COTAL_")) delete process.env[key];
process.env.COTAL_SPACE = "pilistmodels";
process.env.COTAL_NAME = "pi-1";
process.env.ANTHROPIC_API_KEY = "fake-key-for-the-catalog-probe";

const { check, finish } = createSuite();
const FAKE = fileURLToPath(new URL("./fake-pi.mjs", import.meta.url));
const fixture = (name: string): string => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "cotal-pi-models-"));

interface JournalEntry {
  pid?: number;
  argv?: string[];
  seatIdentity?: boolean;
  providerKey?: boolean;
  command?: { id?: string; type?: string; provider?: string; modelId?: string };
  sigterm?: boolean;
}

const journals: (() => JournalEntry[])[] = [];
let cases = 0;
function fakePi(mode: string, vars: Record<string, string> = {}): { bin: string; journal: () => JournalEntry[]; pid: () => number | undefined } {
  const home = join(dir, String(++cases));
  mkdirSync(home);
  const log = join(home, "journal.jsonl");
  const assign = Object.entries({ FAKE_PI_LOG: log, FAKE_PI_MODE: mode, ...vars }).map(([k, v]) => `${k}='${v}'`).join(" ");
  const bin = join(home, "pi");
  writeFileSync(bin, `#!/bin/sh\n${assign} exec "${process.execPath}" "${FAKE}" "$@"\n`);
  chmodSync(bin, 0o700);
  const journal = (): JournalEntry[] =>
    existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l) as JournalEntry) : [];
  journals.push(journal);
  return { bin, journal, pid: () => journal().find((e) => e.pid !== undefined)?.pid };
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
async function goneWithin(pid: number | undefined, ms: number): Promise<boolean> {
  if (pid === undefined) return false;
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (!alive(pid)) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return !alive(pid);
}
const replyFile = (body: unknown): string => {
  const file = join(dir, `reply-${++cases}.json`);
  writeFileSync(file, JSON.stringify(body));
  return file;
};

try {
  check("the pi connector serves its catalog from listPiModels", piConnector.listModels === listPiModels);

  {
    // pi-catalog.json holds pi 1.5.2's own answers, recorded with an Anthropic key and three local
    // models: a reasoning model, one whose id has a colon, and one without reasoning.
    const pi = fakePi("catalog", { FAKE_PI_REPLY: fixture("pi-catalog.json") });
    const catalog = await listPiModels({ resolvedBinaries: { pi: pi.bin } });
    const recorded = JSON.parse(readFileSync(fixture("pi-catalog.json"), "utf8")) as {
      models: { data: { models: { provider: string; id: string }[] } };
      levels: Record<string, string[]>;
    };
    const ids = recorded.models.data.models.map((m) => `${m.provider}/${m.id}`);
    check(
      "maps pi's recorded reply to one provider/id per model, the form pi's --model takes",
      catalog.models.length === 21 && catalog.models.map((m) => m.id).join(",") === ids.join(","),
      catalog.models.map((m) => m.id),
    );
    const sonnet = catalog.models.find((m) => m.id === "anthropic/claude-sonnet-5-5");
    check("keeps pi's provider and display name", sonnet?.provider === "anthropic" && sonnet.name === "Claude Sonnet 5.5", sonnet);
    const variants = (id: string): string | undefined => catalog.models.find((m) => m.id === id)?.variants?.map((v) => v.name).join(",");
    const differing = ids.filter((id) => variants(id) !== recorded.levels[id]!.join(","));
    check("each model's variants are the thinking levels pi listed for it", ids.length === 21 && differing.length === 0, differing);
    check(
      "Haiku 4.5 offers off to high and Opus 4.6 offers up to max, as pi lists them",
      variants("anthropic/claude-haiku-4-5") === "off,minimal,low,medium,high" && variants("anthropic/claude-opus-4-6") === "off,minimal,low,medium,high,max",
      { haiku: variants("anthropic/claude-haiku-4-5"), opus: variants("anthropic/claude-opus-4-6") },
    );
    check(
      "a model id with a colon keeps its id and its own levels",
      variants("local/qwen3:high") === "off,minimal,low,medium,high" && variants("local/plain") === "off",
      catalog.models.slice(-3),
    );
    check("a listed catalog is supported and names its source", catalog.unavailable === undefined && catalog.source === "pi --mode rpc get_available_models", catalog);
    const [start, ...rest] = pi.journal();
    const argv = start?.argv ?? [];
    check(
      "asks pi in RPC mode with no session and no startup network work",
      argv.join(" ").includes("--mode rpc") && argv.includes("--no-session") && argv.includes("--offline"),
      argv,
    );
    const commands = rest.filter((e) => e.command).map((e) => e.command!);
    const expected = ["get_available_models", ...ids.flatMap((id) => [`set_model ${id}`, "get_available_thinking_levels"])];
    const sent = commands.map((c) => (c.type === "set_model" ? `set_model ${c.provider}/${c.modelId}` : c.type));
    check(
      "one pi lists the models, then selects each and reads its levels, and gets no prompt",
      sent.length === 43 && sent.join("\n") === expected.join("\n"),
      sent,
    );
    check("gives pi the provider keys a launch gets", start?.providerKey === true, start);
    check("gives pi no seat identity", start?.seatIdentity === false, start);
    check("stops pi once it answered", await goneWithin(pi.pid(), 3_000));
  }

  {
    const pi = fakePi("catalog", { FAKE_PI_REPLY: fixture("pi-catalog.json"), FAKE_PI_REFUSE: "get_available_thinking_levels" });
    const catalog = await listPiModels({ resolvedBinaries: { pi: pi.bin } });
    check(
      "a pi that cannot list thinking levels is unavailable with pi's own error and the version that added them",
      catalog.models.length === 0 &&
        catalog.unavailable === "pi refused get_available_thinking_levels for anthropic/claude-fable-5: Unknown command: get_available_thinking_levels (pi 0.81.0 added it)",
      catalog,
    );
  }

  {
    const pi = fakePi("catalog", { FAKE_PI_REPLY: fixture("pi-catalog.json"), FAKE_PI_REFUSE: "set_model" });
    const catalog = await listPiModels({ resolvedBinaries: { pi: pi.bin } });
    check(
      "a pi that refuses to select a listed model is unavailable with pi's own error",
      catalog.models.length === 0 && catalog.unavailable === "pi refused set_model for anthropic/claude-fable-5: Unknown command: set_model",
      catalog,
    );
  }

  {
    const recorded = JSON.parse(readFileSync(fixture("pi-catalog.json"), "utf8")) as { levels: Record<string, unknown> };
    recorded.levels["local/plain"] = "off";
    const pi = fakePi("catalog", { FAKE_PI_REPLY: replyFile(recorded) });
    const catalog = await listPiModels({ resolvedBinaries: { pi: pi.bin } });
    check(
      "a model whose levels are not a list makes the whole catalog unavailable",
      catalog.models.length === 0 && catalog.unavailable === "pi answered get_available_thinking_levels for local/plain without a level list",
      catalog,
    );
  }

  {
    const pi = fakePi("reply", { FAKE_PI_REPLY: fixture("pi-models-none.jsonl") });
    const catalog = await listPiModels({ resolvedBinaries: { pi: pi.bin } });
    check(
      "a pi with no credentials is unavailable, saying it holds no provider credentials",
      catalog.models.length === 0 && /holds no provider credentials/.test(catalog.unavailable ?? ""),
      catalog,
    );
  }

  {
    const catalog = await listPiModels({ resolvedBinaries: { pi: join(dir, "not-installed", "pi") } });
    check("a missing pi is unavailable, saying it could not start", catalog.models.length === 0 && /could not be started \(ENOENT\)/.test(catalog.unavailable ?? ""), catalog);
  }

  {
    const pi = fakePi("silent");
    const started = Date.now();
    const catalog = await Promise.race([
      listPiModels({ resolvedBinaries: { pi: pi.bin } }),
      new Promise<ModelCatalog>((r) => setTimeout(() => r({ models: [], unavailable: "the suite stopped waiting after 15s" }), 15_000)),
    ]);
    const elapsed = Date.now() - started;
    check("a pi that never answers is unavailable after 6 seconds", /did not answer get_available_models within 6s/.test(catalog.unavailable ?? "") && elapsed >= 5_500 && elapsed < 8_000, { catalog, elapsed });
    check("a pi that never answered is stopped", await goneWithin(pi.pid(), 3_000));
  }

  {
    const pi = fakePi("garbage");
    const catalog = await listPiModels({ resolvedBinaries: { pi: pi.bin } });
    check("a pi that writes a line that is not JSON is unavailable, saying so", /not JSON/.test(catalog.unavailable ?? ""), catalog);
  }

  {
    const pi = fakePi("reply", { FAKE_PI_REPLY: replyFile({ type: "response", command: "get_available_models", success: false, error: "Model registry failed to load" }) });
    const catalog = await listPiModels({ resolvedBinaries: { pi: pi.bin } });
    check("a pi that refuses is unavailable with pi's own error", catalog.unavailable === "pi refused get_available_models: Model registry failed to load", catalog);
  }

  {
    const pi = fakePi("reply", { FAKE_PI_REPLY: replyFile({ type: "response", command: "get_available_models", success: true, data: {} }) });
    const catalog = await listPiModels({ resolvedBinaries: { pi: pi.bin } });
    check("a reply with no models list is unavailable", /without a models list/.test(catalog.unavailable ?? ""), catalog);
  }

  {
    const recorded = JSON.parse(readFileSync(fixture("pi-catalog.json"), "utf8")) as { models: { data: { models: unknown[] } } };
    recorded.models.data.models.push({ name: "No identity" });
    const pi = fakePi("catalog", { FAKE_PI_REPLY: replyFile(recorded) });
    const catalog = await listPiModels({ resolvedBinaries: { pi: pi.bin } });
    check("a model with no provider or id makes the whole catalog unavailable", catalog.models.length === 0 && /no provider or id/.test(catalog.unavailable ?? ""), catalog);
  }

  {
    const pi = fakePi("exit");
    const catalog = await listPiModels({ resolvedBinaries: { pi: pi.bin } });
    check("a pi that exits before answering is unavailable, naming its exit code", /exited \(3\) before get_available_models answered/.test(catalog.unavailable ?? ""), catalog);
  }

  {
    const pi = fakePi("reply", { FAKE_PI_REPLY: fixture("pi-models-none.jsonl"), FAKE_PI_STUBBORN: "1" });
    await listPiModels({ resolvedBinaries: { pi: pi.bin } });
    check("a pi that ignores SIGTERM is killed within 5 seconds", await goneWithin(pi.pid(), 7_000));
    check("pi is asked to shut down before it is killed", pi.journal().some((e) => e.sigterm), pi.journal());
  }
} finally {
  for (const journal of journals) {
    const pid = journal().find((e) => e.pid !== undefined)?.pid;
    if (pid !== undefined && alive(pid)) process.kill(pid, "SIGKILL");
  }
  rmSync(dir, { recursive: true, force: true });
}

finish();
