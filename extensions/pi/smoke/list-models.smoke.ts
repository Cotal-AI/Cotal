/**
 * The pi connector's model catalog asks the user's own pi over `pi --mode rpc`.
 *
 * A fake `pi` replays replies recorded from pi 1.5.2, with a provider key set and with none, and the
 * failures around them. Each case runs the shipped `listPiModels` against it and checks the ids it
 * returns, the reason it gives when pi has no credentials, is missing, refuses, answers garbage or
 * never answers, and that pi is stopped every time.
 *
 * Run: pnpm smoke:pi-list-models
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createSuite } from "@cotal-ai/smoke-kit";
import type { ModelCatalog } from "@cotal-ai/core";
import { listPiModels, piConnector } from "../src/connector.js";

// Whatever runs this suite may be a managed agent session. Drop the whole COTAL_ prefix before the
// first read, then set a seat identity and a provider key the probe must and must not pass to pi.
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
  command?: { id?: string; type?: string };
  sigterm?: boolean;
}

const journals: (() => JournalEntry[])[] = [];
let cases = 0;
/** A `pi` executable in its own directory that runs the fake in `mode`, and its journal. */
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
    check("a pi that never answers is unavailable after 10 seconds", /did not answer get_available_models within 10s/.test(catalog.unavailable ?? "") && elapsed >= 9_500 && elapsed < 12_000, { catalog, elapsed });
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
    const models = [{ provider: "anthropic", id: "claude-sonnet-5-5" }, { name: "No identity" }];
    const pi = fakePi("reply", { FAKE_PI_REPLY: replyFile({ type: "response", command: "get_available_models", success: true, data: { models } }) });
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
