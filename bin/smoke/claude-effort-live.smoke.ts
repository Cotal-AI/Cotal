/**
 * LIVE: a Claude Code seat runs at the effort level its launch names, and the catalog offers it.
 *
 * Against the real `claude` on PATH and a local Manager, through the built binary:
 *
 *   1. The shipped catalog asks this machine's `claude` for its models. Every model is named, an
 *      alias names the model it resolves to, and each variant is a level `claude --effort` takes.
 *   2. `cotal up --detach`, then two `cotal spawn --detach` of one persona on haiku, at
 *      `--variant low` and at `--variant high`, each with a prompt. Claude records the effort of
 *      each turn as `perTurnEffort` on the assistant line of its own transcript, and each seat's
 *      must be its level. Two levels rule out a default that happens to match one of them.
 *      `cotal ps --json` reports each seat's variant.
 *   3. An unknown level is refused before anything is provisioned.
 *   4. `cotal down --yes` stops the sandbox stack, seats included.
 *
 * The catalog needs this machine's `claude` logged in. The seats do not: their profile is scratch,
 * so each turn ends "Not logged in" after Claude has recorded its effort, and the run spends no
 * tokens. HOME, COTAL_HOME and the XDG dirs are scratch, and the operator's own COTAL_*, CLAUDE_*
 * and ANTHROPIC_* variables never reach a seat. Kills only what it starts.
 *
 * Run: pnpm smoke:claude-effort:live   (needs claude and nats-server on PATH; `pnpm build` first)
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { assertSmokeSandboxDown, createSuite, freePort, recordSmokeSandbox, type SmokeSandboxAnchor } from "@cotal-ai/smoke-kit";
import { claudeConnector } from "../../extensions/connector-claude-code/src/extension.js";

const WT = resolve(import.meta.dirname, "..", "..");
const CLI = join(WT, "bin", "dist", "cotal.js");
const LEVELS = ["low", "medium", "high", "xhigh", "max"];

const version = spawnSync("claude", ["--version"], { encoding: "utf8" });
if (version.status !== 0) throw new Error(`this suite drives the real Claude Code CLI, and \`claude --version\` failed: ${version.error?.message ?? version.stderr}`);
console.log(`claude-effort:live (${version.stdout.trim()})`);
if (!existsSync(CLI)) throw new Error(`${CLI} is missing: run pnpm build first`);

const { check, finish } = createSuite();

console.log("the catalog, from this machine's claude:");
{
  const catalog = await claudeConnector.listModels!({});
  check("claude lists its models", catalog.unavailable === undefined && catalog.models.length > 0, catalog);
  for (const m of catalog.models) console.log(`  ${m.id}: ${m.name} [${m.variants?.map((v) => v.name).join(", ") ?? "no effort levels"}]`);
  check("every model has a name", catalog.models.every((m) => !!m.name), catalog.models);
  const aliases = catalog.models.filter((m) => !m.id.startsWith("claude-"));
  check("every alias names the claude- model it resolves to", aliases.length > 0 && aliases.every((m) => /\(claude-[^()]+\)$/.test(m.name ?? "")), aliases);
  check("every variant is a level claude --effort takes", catalog.models.every((m) => (m.variants ?? []).every((v) => LEVELS.includes(v.name))), catalog.models);
  check("haiku offers the levels this suite launches", ["low", "high"].every((l) => catalog.models.find((m) => m.id === "haiku")?.variants?.some((v) => v.name === l)), catalog.models);
}

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "cotal-claude-effort-")));
const home = join(scratch, "user");
const cotalHome = join(scratch, "cotal");
const xdg = join(home, "config");
const root = join(scratch, "project");
mkdirSync(join(root, ".cotal", "agents"), { recursive: true });
mkdirSync(join(home, ".claude"), { recursive: true });
// A profile that has run Claude once and accepted the Bypass Permissions warning a managed seat raises.
writeFileSync(join(home, ".claude.json"), JSON.stringify({ hasCompletedOnboarding: true, theme: "dark", bypassPermissionsModeAccepted: true }), { mode: 0o600 });
writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({ skipDangerousModePermissionPrompt: true }));
writeFileSync(join(root, ".cotal", "agents", "probe.md"), "---\nname: probe\nrole: tester\n---\nYou are a test seat. Answer the prompt and do nothing else.\n");

const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
  !key.startsWith("COTAL_") && !key.startsWith("CLAUDE") && !key.startsWith("ANTHROPIC_") && key !== "NODE_OPTIONS"));
const env: NodeJS.ProcessEnv = {
  ...inherited,
  HOME: home,
  USERPROFILE: home,
  XDG_CONFIG_HOME: xdg,
  XDG_DATA_HOME: join(home, "data"),
  XDG_CACHE_HOME: join(home, "cache"),
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

/** The `perTurnEffort` Claude recorded on each assistant line of the session whose prompt names `word`. */
function recordedEfforts(word: string): unknown[] | undefined {
  const projects = join(home, ".claude", "projects");
  if (!existsSync(projects)) return undefined;
  for (const file of readdirSync(projects, { recursive: true, encoding: "utf8" }).filter((f) => f.endsWith(".jsonl"))) {
    const lines = readFileSync(join(projects, file), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { type?: string; perTurnEffort?: unknown; message?: { content?: unknown } });
    if (!lines.some((l) => l.type === "user" && JSON.stringify(l.message?.content ?? "").includes(word))) continue;
    const replies = lines.filter((l) => l.type === "assistant");
    if (replies.length > 0) return replies.map((l) => l.perTurnEffort);
  }
  return undefined;
}

async function waitForEfforts(word: string): Promise<unknown[] | undefined> {
  for (const end = Date.now() + 120_000; Date.now() < end; await new Promise((r) => setTimeout(r, 1_000))) {
    const efforts = recordedEfforts(word);
    if (efforts) return efforts;
  }
  return undefined;
}

const anchor = recordSmokeSandbox({ root, cotalHome, xdgConfigHome: xdg });
let up = false;
try {
  console.log("\nseats through a local Manager:");
  check("connectors seed from this checkout", cotal(undefined, "ext", "seed").status === 0);
  const setup = cotal(anchor, "setup", "--destination", "local", "-H", "claude", "--project", root, "-s", "effort-live", "--configure-only", "-y");
  check("setup -H claude prepares the project", setup.status === 0, setup.out);
  const started = cotal(anchor, "up", "--detach", "--open", "--server", `nats://127.0.0.1:${await freePort()}`);
  up = started.status === 0;
  check("up --detach starts the stack", up, started.out);

  const refused = cotal(anchor, "spawn", "--detach", "probe", "--agent", "claude", "--model", "haiku", "--variant", "extreme", "--name", "effort_bad");
  check("an unknown level is refused before launch", refused.status !== 0 && /effort level "extreme" is not one claude accepts/.test(refused.out), refused.out);

  const seats = ["low", "high"].map((level) => ({ level, name: `effort_${level}`, word: `effortprobe${level}` }));
  for (const { level, name, word } of seats) {
    const spawned = cotal(anchor, "spawn", "--detach", "probe", "--agent", "claude", "--model", "haiku", "--variant", level, "--name", name, "--prompt", `Reply with the single word ${word}.`);
    check(`spawn --variant ${level} starts a seat`, spawned.status === 0, spawned.out);
  }
  for (const { level, word } of seats) {
    const efforts = await waitForEfforts(word);
    check(`the --variant ${level} seat's own transcript records effort ${level} for its turn`, !!efforts?.length && efforts.every((e) => e === level), efforts);
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
  rmSync(scratch, { recursive: true, force: true });
}
finish();
