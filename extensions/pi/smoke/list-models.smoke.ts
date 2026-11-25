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
  env?: Record<string, string | null>;
  command?: { id?: string; type?: string };
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
/** A read that should fail: the catalog it listed instead, or the error it threw. */
async function failure(bin: string): Promise<{ catalog?: ModelCatalog; error: string }> {
  try {
    return { catalog: await listPiModels({ resolvedBinaries: { pi: bin } }), error: "" };
  } catch (e) {
    return { error: (e as Error).message };
  }
}
const replyFile = (body: unknown): string => {
  const file = join(dir, `reply-${++cases}.json`);
  writeFileSync(file, JSON.stringify(body));
  return file;
};

try {
  check("the pi connector serves its catalog from listPiModels", piConnector.listModels === listPiModels);

  {
    const pi = fakePi("reply", { FAKE_PI_REPLY: fixture("pi-models-anthropic.jsonl") });
    const catalog = await listPiModels({ resolvedBinaries: { pi: pi.bin } });
    const recorded = (JSON.parse(readFileSync(fixture("pi-models-anthropic.jsonl"), "utf8")) as { data: { models: { provider: string; id: string }[] } }).data.models;
    check(
      "maps pi's recorded reply to one provider/id per model, the form pi's --model takes",
      catalog.models.length === 18 && catalog.models.map((m) => m.id).join(",") === recorded.map((m) => `anthropic/${m.id}`).join(","),
      catalog.models.map((m) => m.id),
    );
    const sonnet = catalog.models.find((m) => m.id === "anthropic/claude-sonnet-5-5");
    check("keeps pi's provider and display name", sonnet?.provider === "anthropic" && sonnet.name === "Claude Sonnet 5.5", sonnet);
    const levels = (id: string): string | undefined => catalog.models.find((m) => m.id === `anthropic/${id}`)?.variants?.map((v) => v.name).join(",");
    check("a model's variants are the thinking levels pi offers for it, leaving out the levels its map marks null",
      levels("claude-sonnet-5-5") === "low,medium,high,xhigh,max" && levels("claude-fable-5") === "minimal,low,medium,high,xhigh,max",
      { sonnet: levels("claude-sonnet-5-5"), fable: levels("claude-fable-5") });
    check("xhigh and max only where the map names them",
      levels("claude-haiku-4-5") === "off,minimal,low,medium,high" && levels("claude-opus-4-6") === "off,minimal,low,medium,high,max",
      { haiku: levels("claude-haiku-4-5"), opus: levels("claude-opus-4-6") });
    check("a listed catalog is supported and names its source", catalog.unavailable === undefined && catalog.source === "pi --mode rpc get_available_models", catalog);
    const [start, ...rest] = pi.journal();
    const argv = start?.argv ?? [];
    check(
      "asks pi in RPC mode with no session and no startup network work",
      argv.join(" ").includes("--mode rpc") && argv.includes("--no-session") && argv.includes("--offline"),
      argv,
    );
    const commands = rest.filter((e) => e.command).map((e) => e.command?.type);
    check("sends pi one get_available_models command and no prompt", commands.join(",") === "get_available_models", commands);
    check("gives pi the provider keys a launch gets", start?.providerKey === true, start);
    check("gives pi no seat identity", start?.seatIdentity === false, start);
    check("stops pi once it answered", await goneWithin(pi.pid(), 3_000));
  }

  {
    // spawn.env names reach the catalog's pi as they reach a launch, so it reads the agent dir and
    // provider key a seat reads. A name nobody declared stays out.
    const agentDir = join(dir, "private-agent");
    Object.assign(process.env, { PI_CODING_AGENT_DIR: agentDir, PI_CATALOG_DECLARED_KEY: "declared", PI_CATALOG_UNDECLARED: "undeclared" });
    const names = ["PI_CODING_AGENT_DIR", "PI_CATALOG_DECLARED_KEY", "PI_CATALOG_UNDECLARED"];
    const envAllow = ["PI_CODING_AGENT_DIR", "PI_CATALOG_DECLARED_KEY"];
    const declared = fakePi("reply", { FAKE_PI_REPLY: fixture("pi-models-anthropic.jsonl"), FAKE_PI_REPORT_ENV: names.join(",") });
    await listPiModels({ resolvedBinaries: { pi: declared.bin }, envAllow });
    const seen = declared.journal()[0]?.env;
    check("a catalog read gives pi the spawn.env names it is handed, with their values",
      seen?.PI_CODING_AGENT_DIR === agentDir && seen?.PI_CATALOG_DECLARED_KEY === "declared", seen);
    check("a name spawn.env does not declare stays out of the catalog read", seen?.PI_CATALOG_UNDECLARED === null, seen);
    const launch = piConnector.buildLaunch({ space: "pilistmodels", name: "pi-1", events: false, envAllow }).env ?? {};
    check("the catalog read gets the declared names a launch gets",
      names.every((name) => (name in launch) === (seen?.[name] !== null)), { launch: names.filter((name) => name in launch), seen });
    const bare = fakePi("reply", { FAKE_PI_REPLY: fixture("pi-models-anthropic.jsonl"), FAKE_PI_REPORT_ENV: names.join(",") });
    await listPiModels({ resolvedBinaries: { pi: bare.bin } });
    check("without spawn.env names the catalog read gets none of them",
      names.every((name) => bare.journal()[0]?.env?.[name] === null), bare.journal()[0]?.env);
    for (const name of names) delete process.env[name];
  }

  {
    const models = [{ provider: "openai", id: "gpt-4o", reasoning: false }, { provider: "openai", id: "o9", reasoning: true }];
    const pi = fakePi("reply", { FAKE_PI_REPLY: replyFile({ type: "response", command: "get_available_models", success: true, data: { models } }) });
    const catalog = await listPiModels({ resolvedBinaries: { pi: pi.bin } });
    check("a model without reasoning has no variants, and one with no map gets pi's five base levels",
      catalog.models[0]?.variants === undefined && catalog.models[1]?.variants?.map((v) => v.name).join(",") === "off,minimal,low,medium,high", catalog.models);
  }

  {
    const pi = fakePi("reply", { FAKE_PI_REPLY: fixture("pi-models-none.jsonl") });
    const read = await failure(pi.bin);
    check(
      "a pi with no credentials fails the read, saying it holds no provider credentials and how to sign in",
      read.catalog === undefined && /holds no provider credentials; sign in with \/login in pi/.test(read.error),
      read,
    );
  }

  {
    const read = await failure(join(dir, "not-installed", "pi"));
    check("a missing pi fails the read, saying it could not start", read.catalog === undefined && /could not be started \(ENOENT\)/.test(read.error), read);
  }

  {
    const pi = fakePi("silent");
    const started = Date.now();
    const read = await Promise.race([
      failure(pi.bin),
      new Promise<{ error: string }>((r) => setTimeout(() => r({ error: "the suite stopped waiting after 15s" }), 15_000)),
    ]);
    const elapsed = Date.now() - started;
    check("a pi that never answers fails the read after 6 seconds", /did not answer get_available_models within 6s/.test(read.error) && elapsed >= 5_500 && elapsed < 8_000, { read, elapsed });
    check("a pi that never answered is stopped", await goneWithin(pi.pid(), 3_000));
  }

  {
    const pi = fakePi("garbage");
    const read = await failure(pi.bin);
    check("a pi that writes a line that is not JSON fails the read, saying so", read.catalog === undefined && /not JSON/.test(read.error), read);
  }

  {
    const pi = fakePi("reply", { FAKE_PI_REPLY: replyFile({ type: "response", command: "get_available_models", success: false, error: "Model registry failed to load" }) });
    const read = await failure(pi.bin);
    check("a pi that refuses fails the read with pi's own error", read.error === "pi refused get_available_models: Model registry failed to load", read);
  }

  {
    const pi = fakePi("reply", { FAKE_PI_REPLY: replyFile({ type: "response", command: "get_available_models", success: true, data: {} }) });
    const read = await failure(pi.bin);
    check("a reply with no models list fails the read", read.catalog === undefined && /without a models list/.test(read.error), read);
  }

  {
    const models = [{ provider: "anthropic", id: "claude-sonnet-5-5" }, { name: "No identity" }];
    const pi = fakePi("reply", { FAKE_PI_REPLY: replyFile({ type: "response", command: "get_available_models", success: true, data: { models } }) });
    const read = await failure(pi.bin);
    check("a model with no provider or id fails the whole read", read.catalog === undefined && /no provider or id/.test(read.error), read);
  }

  {
    const pi = fakePi("exit");
    const read = await failure(pi.bin);
    check("a pi that exits before answering fails the read, naming its exit code", read.catalog === undefined && /exited \(3\) before get_available_models answered/.test(read.error), read);
  }

  {
    const pi = fakePi("reply", { FAKE_PI_REPLY: fixture("pi-models-none.jsonl"), FAKE_PI_STUBBORN: "1" });
    await failure(pi.bin);
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
