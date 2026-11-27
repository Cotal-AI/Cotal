/**
 * LIVE: a Claude Code seat runs at the effort level and with the modes its launch names, and the
 * catalog offers them.
 *
 * Against the real `claude` on PATH and a local Manager, through the built binary:
 *
 *   1. The shipped catalog asks this machine's `claude` for its models, within 12 s. Every model is
 *      named, an alias names the model it resolves to, each variant is a level `claude --effort`
 *      takes, one model is the default, and opus offers ultracode where claude-opus-4-6 does not.
 *      Opus lists fast, with claude's reason when this login cannot run it.
 *   2. `cotal up --detach`, then two `cotal spawn --detach` of one persona on haiku, at
 *      `--variant low` and at `--variant high`, each with a prompt. Claude records the effort of
 *      each turn as `perTurnEffort` on the assistant line of its own transcript, and each seat's
 *      must be its level. Two levels rule out a default that happens to match one of them.
 *      `cotal ps --json` reports each seat's variant.
 *   3. A level the catalog does not list for the model is refused by the Manager, naming the
 *      levels it lists, before anything is provisioned.
 *   4. An opus seat spawned with `--mode ultracode=true` and a prompt: Claude records ultracode on
 *      for its turn as an `ultra_effort_enter` attachment in its transcript, and the haiku seats
 *      record none. Ultracode on claude-opus-4-6 is refused before launch. `--variant high` with
 *      no `--model` is checked against the catalog's default model and starts a seat. When this
 *      login cannot run fast, `cotal models` prints claude's reason, and `--mode fast=true` on opus
 *      is refused before launch with it; a login that can run fast skips both and says so.
 *   5. `cotal down --yes` stops the sandbox stack, seats included.
 *
 * The Manager reads claude's catalog to check each variant, so the stack runs with this machine's
 * Claude login, and three seats' one short turn each spends a few tokens. The space is prepared
 * with `space create`, which leaves the operator's Claude configuration alone, and the persona asks
 * for the default permission mode, because Cotal never accepts Bypass Permissions for the operator.
 * That launch option applies only from a trusted folder, so the suite trusts the project as its
 * operator would.
 * COTAL_HOME and the Cotal config dir are scratch, the operator's own COTAL_*, CLAUDE_* and
 * ANTHROPIC_* variables never reach a seat, and the seats' transcript folder is removed at the end.
 * Kills only what it starts.
 *
 * Claude's installer must not move: it keeps its versions under XDG_DATA_HOME and its launcher under
 * HOME, and a seat given a scratch data dir with the real HOME installs itself there and repoints
 * `~/.local/bin/claude` at a folder this suite deletes. So the data and cache dirs stay the
 * operator's, the project's Claude settings set DISABLE_AUTOUPDATER so a seat installs nothing, and
 * the last cell checks that the launcher still points where it did.
 *
 * Run: pnpm smoke:claude-effort:live   (needs claude and nats-server on PATH; `pnpm build` first)
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { assertSmokeSandboxDown, createSuite, freePort, recordSmokeSandbox, type SmokeSandboxAnchor } from "@cotal-ai/smoke-kit";
import { readModelCatalog } from "@cotal-ai/core";
import { claudeConnector } from "../../extensions/connector-claude-code/src/extension.js";

const WT = resolve(import.meta.dirname, "..", "..");
const CLI = join(WT, "bin", "dist", "cotal.js");
const LEVELS = ["low", "medium", "high", "xhigh", "max"];

const version = spawnSync("claude", ["--version"], { encoding: "utf8" });
if (version.status !== 0) throw new Error(`this suite drives the real Claude Code CLI, and \`claude --version\` failed: ${version.error?.message ?? version.stderr}`);
console.log(`claude-effort:live (${version.stdout.trim()})`);
if (!existsSync(CLI)) throw new Error(`${CLI} is missing: run pnpm build first`);

const { check, finish } = createSuite();

/** Why this login cannot run fast on opus, as the catalog says, or undefined when it can. */
let fastOff: string | undefined;
console.log("the catalog, from this machine's claude:");
{
  const asked = Date.now();
  const catalog = await claudeConnector.listModels!({});
  const waited = Date.now() - asked;
  check("claude lists its models within 12 s", catalog.unavailable === undefined && catalog.models.length > 0 && waited < 12_000, { waited, unavailable: catalog.unavailable });
  for (const m of catalog.models)
    console.log(`  ${m.id}${m.isDefault ? " (default)" : ""}: ${m.name} [${m.variants?.map((v) => v.name + (v.name === m.defaultVariant ? "*" : "")).join(", ") ?? "no effort levels"}] modes: ${m.modes?.map((x) => x.id + (x.unavailable ? ` (unavailable: ${x.unavailable})` : "")).join(", ") || "none"}`);
  console.log(`  read in ${waited} ms; fast offered on ${catalog.models.filter((m) => m.modes?.some((x) => x.id === "fast")).length} models`);
  check("one model is the default", catalog.models.filter((m) => m.isDefault).length === 1, catalog.models.map((m) => [m.id, m.isDefault]));
  const read = await readModelCatalog({ name: "claude", listModels: () => catalog }, {}).then(() => "read", (e: Error) => e.message);
  check("core reads the catalog as consistent, every default among its model's values", read === "read", read);
  const ultracode = (id: string) => catalog.models.find((m) => m.id === id)?.modes?.some((x) => x.id === "ultracode");
  check("opus offers ultracode and claude-opus-4-6 does not, as the seats below need", ultracode("opus") === true && ultracode("claude-opus-4-6") !== true, catalog.models);
  const opusFast = catalog.models.find((m) => m.id === "opus")?.modes?.find((x) => x.id === "fast");
  check("opus lists fast", opusFast !== undefined, catalog.models.find((m) => m.id === "opus"));
  fastOff = opusFast?.unavailable;
  check("every model has a name", catalog.models.every((m) => !!m.name), catalog.models);
  const aliases = catalog.models.filter((m) => !m.id.startsWith("claude-"));
  check("every alias names the claude- model it resolves to", aliases.length > 0 && aliases.every((m) => /\(claude-[^()]+\)$/.test(m.name ?? "")), aliases);
  check("every variant is a level claude --effort takes", catalog.models.every((m) => (m.variants ?? []).every((v) => LEVELS.includes(v.name))), catalog.models);
  check("haiku offers the levels this suite launches", ["low", "high"].every((l) => catalog.models.find((m) => m.id === "haiku")?.variants?.some((v) => v.name === l)), catalog.models);
}

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "cotal-claude-effort-")));
const cotalHome = join(scratch, "cotal");
const xdg = join(scratch, "config");
const root = join(scratch, "project");
// Where claude keeps the seats' transcripts for this project, under the operator's own Claude home.
const transcripts = join(homedir(), ".claude", "projects", root.replace(/[^A-Za-z0-9]/g, "-"));
const launcher = join(homedir(), ".local", "bin", "claude");
const launcherTarget = (): string | undefined => { try { return readlinkSync(launcher); } catch { return undefined; } };
const launcherBefore = launcherTarget();
mkdirSync(join(root, ".cotal", "agents"), { recursive: true });
// A seat reads this from the project it runs in. The Manager starts with a filtered environment, so
// the variable cannot reach a seat from this process.
mkdirSync(join(root, ".claude"), { recursive: true });
writeFileSync(join(root, ".claude", "settings.json"), JSON.stringify({ env: { DISABLE_AUTOUPDATER: "1" } }));
writeFileSync(join(root, ".cotal", "agents", "probe.md"), "---\nname: probe\nrole: tester\nlaunchOptions:\n  permission-mode: default\n---\nYou are a test seat. Answer the prompt and do nothing else.\n");

const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
  !key.startsWith("COTAL_") && !key.startsWith("CLAUDE") && !key.startsWith("ANTHROPIC_") && key !== "NODE_OPTIONS"));
const env: NodeJS.ProcessEnv = {
  ...inherited,
  XDG_CONFIG_HOME: xdg,
  COTAL_HOME: cotalHome,
  COTAL_ALLOW_CHECKOUT_SEED: "1",
  COTAL_SKIP_ASSIST: "1",
};
const cotal = (anchor: SmokeSandboxAnchor | undefined, ...args: string[]) => {
  const options = { cwd: root, env, encoding: "utf8" as const, timeout: 180_000 };
  assertSmokeSandboxDown(anchor, args, options);
  const result = spawnSync(process.execPath, [CLI, ...args], options);
  if (result.error) throw result.error;
  return { status: result.status, stdout: result.stdout, out: result.stdout + result.stderr };
};

type TranscriptLine = { type?: string; perTurnEffort?: unknown; message?: { content?: unknown }; attachment?: { type?: unknown } };

/** The transcript of the session whose prompt names `word`, once Claude has answered it. */
function answeredSession(word: string): TranscriptLine[] | undefined {
  if (!existsSync(transcripts)) return undefined;
  for (const file of readdirSync(transcripts, { recursive: true, encoding: "utf8" }).filter((f) => f.endsWith(".jsonl"))) {
    const lines = readFileSync(join(transcripts, file), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as TranscriptLine);
    if (!lines.some((l) => l.type === "user" && JSON.stringify(l.message?.content ?? "").includes(word))) continue;
    if (lines.some((l) => l.type === "assistant")) return lines;
  }
  return undefined;
}

async function waitForSession(word: string): Promise<TranscriptLine[] | undefined> {
  for (const end = Date.now() + 120_000; Date.now() < end; await new Promise((r) => setTimeout(r, 1_000))) {
    const lines = answeredSession(word);
    if (lines) return lines;
  }
  return undefined;
}

/** The `perTurnEffort` Claude recorded on each assistant line. */
const efforts = (lines: TranscriptLine[] | undefined) => lines?.filter((l) => l.type === "assistant").map((l) => l.perTurnEffort);
/** Whether Claude recorded ultracode on for the session's turn. */
const ultracodeOn = (lines: TranscriptLine[] | undefined) => lines?.some((l) => l.type === "attachment" && l.attachment?.type === "ultra_effort_enter");

const anchor = recordSmokeSandbox({ root, cotalHome, xdgConfigHome: xdg });
let up = false;
try {
  console.log("\nseats through a local Manager:");
  check("connectors seed from this checkout", cotal(undefined, "ext", "seed").status === 0);
  const prepared = cotal(anchor, "space", "create", "effort-live", "--root", root);
  // The persona's launch option applies only from a trusted folder, and space create does not trust a
  // project whose .cotal was already there.
  const trusted = cotal(anchor, "trust", root);
  check("space create prepares the project, and the operator trusts it", prepared.status === 0 && trusted.status === 0, { prepared: prepared.out, trusted: trusted.out });
  const started = cotal(anchor, "up", "--detach", "--open", "--server", `nats://127.0.0.1:${await freePort()}`);
  up = started.status === 0;
  check("up --detach starts the stack", up, started.out);

  const refused = cotal(anchor, "spawn", "--detach", "probe", "--agent", "claude", "--model", "haiku", "--variant", "extreme", "--name", "effort_bad");
  check("a level the catalog does not list is refused before launch, naming the listed ones",
    refused.status !== 0 && /claude lists variants "low", .* for model "haiku", not "extreme" \(variant\)/.test(refused.out), refused.out);

  const seats = ["low", "high"].map((level) => ({ level, name: `effort_${level}`, word: `effortprobe${level}` }));
  for (const { level, name, word } of seats) {
    const spawned = cotal(anchor, "spawn", "--detach", "probe", "--agent", "claude", "--model", "haiku", "--variant", level, "--name", name, "--prompt", `Reply with the single word ${word}.`);
    check(`spawn --variant ${level} starts a seat`, spawned.status === 0, spawned.out);
  }
  const sessions = new Map<string, TranscriptLine[] | undefined>();
  for (const { level, word } of seats) {
    sessions.set(level, await waitForSession(word));
    const recorded = efforts(sessions.get(level));
    check(`the --variant ${level} seat's own transcript records effort ${level} for its turn`, !!recorded?.length && recorded.every((e) => e === level), recorded);
  }
  const on = cotal(anchor, "spawn", "--detach", "probe", "--agent", "claude", "--model", "opus", "--mode", "ultracode=true", "--name", "ultracode_on", "--prompt", "Reply with the single word ultracodeprobe.");
  check("spawn --mode ultracode=true on opus starts a seat", on.status === 0, on.out);
  const onSession = await waitForSession("ultracodeprobe");
  check("the ultracode seat's own transcript records ultracode on for its turn", ultracodeOn(onSession) === true, onSession?.map((l) => l.attachment?.type ?? l.type));
  check("the haiku seats launched without ultracode record none", seats.every(({ level }) => sessions.get(level) !== undefined && ultracodeOn(sessions.get(level)) === false));
  const unlisted = cotal(anchor, "spawn", "--detach", "probe", "--agent", "claude", "--model", "claude-opus-4-6", "--mode", "ultracode=true", "--name", "ultracode_bad");
  check("ultracode on claude-opus-4-6 is refused before launch, naming what the model offers",
    unlisted.status !== 0 && /claude lists (no modes|modes [^\n]*) for model "claude-opus-4-6", not "ultracode" \(modes\)/.test(unlisted.out), unlisted.out);
  const byDefault = cotal(anchor, "spawn", "--detach", "probe", "--agent", "claude", "--variant", "high", "--name", "default_high");
  check("spawn --variant high with no --model is checked against the default model and starts a seat", byDefault.status === 0, byDefault.out);
  if (fastOff === undefined) console.log("  skip: this login can run fast, so no fast launch is refused");
  else {
    const listed = cotal(anchor, "models", "--harness", "claude", "--plain");
    check("cotal models prints fast as unavailable with claude's reason", listed.status === 0 && listed.out.includes(`fast (unavailable: ${fastOff})`), listed.out);
    const fast = cotal(anchor, "spawn", "--detach", "probe", "--agent", "claude", "--model", "opus", "--mode", "fast=true", "--name", "fast_off");
    check("spawn --mode fast=true on opus is refused before launch with claude's reason",
      fast.status !== 0 && fast.out.includes(`mode "fast" of model "opus" is unavailable: ${fastOff} (modes)`), fast.out);
  }

  const ps = cotal(anchor, "ps", "--json");
  const line = ps.stdout.split("\n").find((l) => l.startsWith("{\"schemaVersion\""));
  const rows = line ? ((JSON.parse(line) as { result?: { items?: Array<{ name: string; variant?: string }> } }).result?.items ?? []) : [];
  for (const { level, name } of seats)
    check(`ps reports the ${name} seat's variant as ${level}`, rows.find((r) => r.name === name)?.variant === level, rows);
} finally {
  if (up) {
    const down = cotal(anchor, "down", "--yes");
    check("down stops the stack", down.status === 0, down.out);
  }
  rmSync(transcripts, { recursive: true, force: true });
  rmSync(scratch, { recursive: true, force: true });
}
const after = spawnSync("claude", ["--version"], { encoding: "utf8" });
check(`this machine's claude launcher still points at ${launcherBefore ?? "nothing"}, and claude --version still answers`,
  launcherTarget() === launcherBefore && after.status === 0 && after.stdout.trim() === version.stdout.trim(), { launcher: launcherTarget(), version: after.stdout.trim() });
finish();
