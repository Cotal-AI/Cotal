import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as p from "@clack/prompts";
import { registry, type Connector, type FlagSpec, type FlagValues, type ParsedArgs } from "@cotal-ai/core";
import { homeCotalDir, provenance } from "@cotal-ai/workspace";
import { brand, brandBold, dim, ok, note, splash } from "../lib/theme.js";
import { runSteps, type Step } from "../lib/steps.js";
import { abortIfCancel } from "../lib/cancel.js";
import { openSetupLog } from "../lib/setup-log.js";
import { resolveNatsServer } from "../lib/nats-bin.js";
import { isOnboarded, markOnboarded } from "../lib/onboard.js";
import { machineStatus, meshStatus, onPath } from "../lib/status.js";
import { webUp, WEB_URL } from "./web.js";
import { managerUp } from "../lib/manager-proc.js";
import { cotalOnPath, displayCmd, isNpx } from "../lib/self-exec.js";
import { cotalPath } from "../lib/paths.js";

const ONBOARD_VERSION = "2";
const README_URL = "https://github.com/Cotal-AI/Cotal/blob/main/README.md";
const CC_DOCS_URL = "https://github.com/Cotal-AI/Cotal/blob/main/docs/claude-code-integration.md";
const NATS_RELEASES_URL = "https://github.com/nats-io/nats-server/releases";

/** `cotal setup`'s grammar — configure-only knobs. The old `--auth`/`--open` flags configured the
 *  MESH MODE at setup-launch time; setup no longer launches anything, so both are gone here —
 *  mesh mode is `cotal up [--open]`'s concern (where `--open` already lived; `--auth` simply died
 *  with the launch behavior). An unknown-option error rejects them, nothing silently. */
export const setupFlags = [
  { name: "full", type: "boolean", description: "redo the full guided flow" },
  { name: "yes", type: "boolean", short: "y", description: "non-interactive accept-all (agents/CI)" },
] as const satisfies readonly FlagSpec[];

/**
 * `cotal setup`: guided setup — CONFIGURE-ONLY, state-independent. It checks prerequisites,
 * installs the Claude Code plugin, and seeds persona files; it NEVER launches anything (no mesh,
 * no web, no manager, no delivery daemon, no cmux/tmux session — launching is `cotal up` /
 * `cotal web` / `cotal supervise`). Every file it writes is announced (`→ wrote …`). First run
 * (no onboarded stamp) gets the full narrated flow; later runs get a status card. `--full`
 * forces the full flow. Each failed step offers an interactive Claude handoff
 * (COTAL_SKIP_ASSIST=1 disables).
 */
export async function setup(args: ParsedArgs): Promise<void> {
  const values = args.values as FlagValues<typeof setupFlags>;
  if (!isOnboarded() || values.full || values.yes) await runFirstRun(Boolean(values.yes));
  else await runEnsure();
}

/** The full, narrated first-run experience. `yes` = non-interactive accept-all. Configure-only:
 *  prerequisites are CHECKED (never started); the finale tells the user what to run. */
async function runFirstRun(yes: boolean): Promise<void> {
  splash();
  p.intro(brandBold("Welcome to Cotal"));
  note(
    "Cotal is the open web for agents: they join a shared space, see who's around, and coordinate as peers instead of in silos. Build whole agent societies, even across different machines, on one open web. Let's set yours up.",
    "Give your agents a place to work together",
  );

  const log = openSetupLog(process.cwd());

  // Prerequisites — CHECKS only, no side effects, no prompts.
  const core: Step[] = [
    {
      name: "node-version",
      title: "Check Node.js",
      explain: "Cotal needs Node 20 or newer.",
      context: [README_URL],
      async run() {
        const major = Number(process.versions.node.split(".")[0]);
        if (major < 20) throw new Error(`Node ${process.versions.node} is too old; Cotal needs Node >= 20`);
        return `Node ${process.versions.node}`;
      },
    },
    {
      name: "nats-binary",
      title: "Locate the NATS server",
      explain: "Cotal runs on NATS + JetStream, the wire your agents speak over. (Located only — `cotal up` starts it.)",
      context: [NATS_RELEASES_URL, README_URL],
      async run() {
        const r = await resolveNatsServer();
        return r.source === "path" ? "nats-server from PATH" : "bundled binary";
      },
    },
  ];
  if (!(await runSteps(core, log, { yes }))) return abort();

  // Connectors: which agents should be able to join. Only Claude needs an install
  // (its wake channel binds to an installed plugin); OpenCode auto-wires at spawn.
  const found = { claude: onPath("claude"), opencode: onPath("opencode") };
  const selected = await pickConnectors(found, yes);
  if (selected.has("claude")) {
    if (!found.claude)
      p.log.warn(`claude isn't on PATH. Install it (https://claude.com/claude-code), then re-run ${displayCmd()} setup.`);
    else if (!(await runSteps([claudePluginStep()], log, { yes }))) return abort();
  }
  for (const name of ["opencode"] as const) {
    if (selected.has(name) && found[name]) {
      p.log.success(`${name} ready (auto-wired when you spawn it)`);
      log.line(`connector ${name}: ready (no install)`);
    }
  }

  // Two experts plus your own driving session, by default. These are setup-managed: refreshed when
  // DEMO_AGENTS changes (so persona edits actually land), but a file you've taken ownership of is
  // backed up first, never silently lost — see writeDemoAgent. Every write is announced.
  mkdirSync(cotalPath("agents"), { recursive: true });
  for (const [name, body] of Object.entries(DEMO_AGENTS)) {
    writeDemoAgent(cotalPath("agents", `${name}.md`), body);
  }
  seedDefaultAgent(); // the generic persona `cotal spawn` (no name) launches
  p.log.success("Added david (the engineer), sven (the guide), and your session (me); spawn them when your mesh is up");
  log.line("demo-agents: wrote david + sven + me");

  await offerGlobalInstall(yes);

  markOnboarded(ONBOARD_VERSION);
  provenance.wrote("onboarded stamp", join(homeCotalDir(), "onboarded.json"));
  const cmd = displayCmd();
  note(
    [
      "Everything is configured — nothing has been started. Bring your mesh up when you're ready:",
      "",
      `${ok("✓")} start the mesh      ${dim(`${cmd} up --detach`)}`,
      `${ok("✓")} open the dashboard  ${dim(`${cmd} web`)}`,
      `${ok("✓")} drive a session     ${dim(`${cmd} spawn me`)}`,
      `${ok("✓")} ask the experts     ${dim(`${cmd} spawn david · ${cmd} spawn sven`)}`,
      `${ok("✓")} watch the mesh      ${dim(`${cmd} console`)}`,
      `${ok("✓")} stop everything     ${dim(`${cmd} down`)}`,
      "",
      dim(`Cotal not working? Tell your agent to send feedback (built-in cotal_feedback), or run ${cmd} feedback "<msg>".`),
    ].join("\n"),
    "You're set",
  );
  p.outro(brand(yes ? "Cotal is configured." : "Happy meshing."));

  function abort() {
    p.outro(brand(`Setup paused. Fix the step above and run \`${displayCmd()} setup\` again.`));
    process.exitCode = 1;
  }
}

/** When run via `npx` without a global `cotal`, offer to install it so the user can just type
 *  `cotal`. Interactive: a Y/n prompt (default yes). Non-interactive (`--yes` / no TTY): takes the
 *  default and installs. Best-effort — `npm i -g` fails a lot (EACCES, nvm/fnm/volta), so on failure
 *  we warn with the manual command and continue; setup never aborts over a PATH convenience. */
export async function offerGlobalInstall(yes: boolean): Promise<void> {
  if (!isNpx() || cotalOnPath()) return; // already have `cotal`, or not an npx run

  if (!yes && process.stdin.isTTY) {
    const go = abortIfCancel(
      await p.confirm({ message: "Install `cotal` globally so you can just type `cotal`?", initialValue: true }),
    );
    if (!go) {
      p.log.info(`No problem — keep using ${dim("npx cotal-ai")}. Install later with ${dim("npm i -g cotal-ai")}.`);
      return;
    }
  }

  const pkg = `cotal-ai@${runningVersion() ?? "latest"}`;
  const s = p.spinner();
  s.start("Installing cotal globally");
  const r = spawnSync("npm", ["install", "-g", pkg], { encoding: "utf8" });
  if (r.status === 0) {
    s.stop("Installed — you can now run `cotal`");
  } else {
    s.stop("Couldn't install globally");
    const tail = `${r.stdout ?? ""}${r.stderr ?? ""}`.trim().split("\n").slice(-3).join("\n");
    p.log.warn(
      `${tail ? `${tail}\n\n` : ""}Install it yourself with ${dim("npm i -g cotal-ai")}, or keep using ${dim("npx cotal-ai")}.`,
    );
  }
}

/** The version of the running `cotal-ai` package (from the package.json next to the entry script),
 *  so a global install pins the same version npx just ran. Null if it can't be read. */
function runningVersion(): string | null {
  try {
    const pkg = JSON.parse(readFileSync(join(process.argv[1], "..", "..", "package.json"), "utf8"));
    return typeof pkg.version === "string" ? pkg.version : null;
  } catch {
    return null;
  }
}

/** Pick which agent connectors to set up. Detected ones are pre-checked (= the "all"
 *  default). Non-interactive / --yes selects all detected without prompting. */
async function pickConnectors(
  found: Record<"claude" | "opencode", boolean>,
  yes: boolean,
): Promise<Set<string>> {
  const all = (["claude", "opencode"] as const).filter((n) => found[n]);
  if (yes || !process.stdin.isTTY) return new Set(all);
  const labels: Record<string, string> = { claude: "Claude Code", opencode: "OpenCode" };

  // Common case: show what was detected and offer a visible Continue button (clack's multiselect
  // has no native one). Only "Customize" (or nothing detected) drops into the toggle list.
  if (all.length) {
    note(all.map((n) => labels[n]).join(", "), "Agents found");
    const go = abortIfCancel(
      await p.confirm({ message: "Set these up?", active: "Continue", inactive: "Customize", initialValue: true }),
    );
    if (go) return new Set(all);
  }

  const picked = abortIfCancel(
    await p.multiselect({
      message: "Pick the agents to set up (space toggles, enter continues)",
      options: (["claude", "opencode"] as const).map((n) => ({
        value: n,
        label: labels[n],
        hint: !found[n] ? "not on PATH" : n === "claude" ? "installs a plugin" : "ready at spawn",
      })),
      initialValues: all,
      required: false,
    }),
  );
  return new Set(picked as string[]);
}

/** The Claude Code plugin install, as a step (spinner + failure handling + handoff). */
function claudePluginStep(): Step {
  return {
    name: "claude-plugin",
    title: "Install the Claude Code plugin",
    explain: "Lets a Claude Code session join the web and wake on peer messages.",
    context: [join(homeCotalDir(), "claude-plugin"), CC_DOCS_URL],
    async run() {
      installClaudePlugin();
      return "cotal@cotal-mesh (local scope)";
    },
  };
}

/** The compact repeat-run: a one-glance status card, plus re-seeding the default persona if it's
 *  missing (announced). Nothing is launched — the card tells you what's down and how to start it. */
async function runEnsure(): Promise<void> {
  seedDefaultAgent(); // ensure `cotal spawn` (no name) always has a default to launch
  await readyCard(process.cwd());
}

/** The `cotal · status` one-glance card: machine + mesh + web + manager status (read-only
 *  probes — displaying state is not depending on it), plus the key commands. */
async function readyCard(cwd: string): Promise<void> {
  const mesh = await meshStatus(cwd);
  const m = await machineStatus();
  const web = await webUp();
  const mgr = managerUp();
  const cmd = displayCmd();
  const line = (on: boolean, text: string) => `${on ? ok("✓") : dim("○")} ${text}`;
  note(
    [
      line(m.nats !== "missing", `NATS     ${dim(m.nats === "missing" ? "missing" : m.nats)}`),
      line(m.claudePlugin, `plugin   ${dim(m.claudePlugin ? "installed" : "not installed")}`),
      line(mesh.reachable, `mesh     ${dim(mesh.reachable ? `${mesh.server} · space ${mesh.space}` : `down — start: ${cmd} up --detach`)}`),
      line(web, `web      ${dim(web ? WEB_URL : `down — start: ${cmd} web`)}`),
      line(mgr, `manager  ${dim(mgr ? "running" : `not running — start: ${cmd} up, or: ${cmd} supervise`)}`),
      "",
      `start the mesh:  ${dim(`${cmd} up --detach`)}`,
      `drive it:        ${dim(`${cmd} spawn me`)}   ${dim("(or david / sven)")}`,
      `watch it:        ${dim(`${cmd} console`)}   ${dim("(live TUI in this terminal)")}`,
      `more:            ${dim(`${cmd} web · ${cmd} down · ${cmd} feedback "<msg>" · ${cmd} --help`)}`,
    ].join("\n"),
    brandBold("cotal · status"),
  );
}

/** Materialize a stable plugin marketplace under ~/.cotal/claude-plugin (surviving
 *  npx cache eviction) and install the plugin from it. The marketplace name must stay
 *  `cotal-mesh` (the connector's channel ref `plugin:cotal@cotal-mesh` depends on it). */
function installClaudePlugin(): void {
  const { pluginRoot } = registry.resolve<Connector>("connector", "claude");
  if (!pluginRoot) throw new Error('the registered "claude" connector ships no plugin assets');
  for (const f of ["dist/mcp.cjs", "dist/hook.cjs", ".claude-plugin/plugin.json", ".mcp.json", "hooks/hooks.json"]) {
    if (!existsSync(join(pluginRoot, f))) {
      throw new Error(
        `plugin asset missing: ${join(pluginRoot, f)} (in a dev clone, build it with: pnpm --filter @cotal-ai/connector-claude-code bundle)`,
      );
    }
  }

  const marketDir = join(homeCotalDir(), "claude-plugin");
  const pluginDir = join(marketDir, "cotal");
  for (const f of [".claude-plugin", ".mcp.json", "hooks", "dist/mcp.cjs", "dist/hook.cjs"]) {
    cpSync(join(pluginRoot, f), join(pluginDir, f), { recursive: true });
  }
  mkdirSync(join(marketDir, ".claude-plugin"), { recursive: true });
  writeFileSync(
    join(marketDir, ".claude-plugin", "marketplace.json"),
    JSON.stringify(
      {
        name: "cotal-mesh",
        description: "The Cotal mesh adapter for Claude Code: join a shared pub/sub space as a lateral peer.",
        owner: { name: "Cotal" },
        plugins: [{ name: "cotal", source: "./cotal" }],
      },
      null,
      2,
    ),
  );
  provenance.wrote("plugin marketplace", marketDir);

  // `add` fails when the marketplace is already registered; refresh it instead.
  const add = claude("plugin", "marketplace", "add", marketDir);
  if (add.status !== 0) {
    const update = claude("plugin", "marketplace", "update", "cotal-mesh");
    if (update.status !== 0) throw new Error(`couldn't register the plugin marketplace:\n${add.output}\n${update.output}`);
  }
  const install = claude("plugin", "install", "cotal@cotal-mesh", "--scope", "local");
  if (install.status !== 0 && !/already installed/i.test(install.output)) {
    throw new Error(`plugin install failed:\n${install.output}`);
  }
  const list = claude("plugin", "list");
  if (!list.output.includes("cotal")) throw new Error(`plugin not visible in \`claude plugin list\`:\n${list.output}`);
}

function claude(...args: string[]): { status: number | null; output: string } {
  const r = spawnSync("claude", args, { encoding: "utf8" });
  return { status: r.status, output: `${r.stdout ?? ""}${r.stderr ?? ""}`.trim() };
}

/** Frontmatter marker (a comment line — the parser ignores `#` lines) stamping a demo persona as
 *  setup-managed, so re-runs may refresh it; remove the line to take ownership. */
const MANAGED_MARKER = "# managed by cotal-setup";

/** Write a setup-managed demo persona, refreshing it when its DEMO_AGENTS body changes — but never
 *  silently clobber a file the user has taken ownership of (one without the marker): back it up to
 *  `<name>.md.bak` first. Missing or marker-carrying files are written in place; every write is
 *  announced. */
function writeDemoAgent(path: string, body: string): void {
  if (existsSync(path)) {
    const cur = readFileSync(path, "utf8");
    if (cur === body) return; // already current
    if (!cur.includes(MANAGED_MARKER)) {
      writeFileSync(`${path}.bak`, cur); // preserve a user/pre-marker edit
      provenance.wrote("backup of your edited persona", `${path}.bak`);
    }
  }
  writeFileSync(path, body);
  provenance.wrote("persona", path);
}

/** The default persona `cotal spawn` (no name) launches: a generic mesh agent, seeded once and
 *  then the user's to shape. Unlike the demo team it's never refreshed (seed-if-absent), so any
 *  edits stand; deleting it just means the next `cotal setup` writes a fresh copy. */
const DEFAULT_AGENT = `---
name: default_agent
role: default
description: An agent on the mesh
tags: []
subscribe: [">"]
allowPublish: [">"]
capabilities: [spawn]
---

You are an agent on the Cotal mesh — a shared space where agents join, see who's around, and
coordinate as peers rather than working in silos. Use the Cotal tools available to you to find
your peers and work with them. Edit this file to give yourself a name, role, and purpose.
`;

/** Seed the default persona if it's missing (idempotent, seed-if-absent). Called from both the
 *  first-run and repeat-run paths so `cotal spawn` always has a default on hand. */
function seedDefaultAgent(): void {
  const path = cotalPath("agents", "default.md");
  if (existsSync(path)) return;
  mkdirSync(cotalPath("agents"), { recursive: true });
  writeFileSync(path, DEFAULT_AGENT);
  provenance.wrote("default persona", path);
}

const DEMO_AGENTS: Record<string, string> = {
  david: `---
${MANAGED_MARKER} — edit DEMO_AGENTS in the cotal CLI; delete this line to keep local changes
name: david
role: cotal-tech
description: "the engineer: how Cotal works (the wire, NATS, connectors, integration)."
tags: [cotal, technical, help]
subscribe: [general]
allowPublish: [general]
---

You are david, Cotal's engineer, live on the web for agents with the operator who just set Cotal
up. You help them set up and experiment. Your topic is how Cotal works: the wire contract (subjects,
message schemas, presence), NATS and JetStream underneath, the endpoint/connector model, the
delivery modes (multicast, unicast, anycast), and how to get any agent or framework onto the mesh.
You ground every answer in the real thing, never a guess. Start from \`docs/OVERVIEW.md\` (what Cotal
is and its core primitives) and \`docs/getting-started.md\`, then read the source for your topic —
\`docs/architecture.md\`, \`docs/claude-code-integration.md\`, \`docs/setup-internals.md\`, and, in a
source checkout, \`packages/\` and \`extensions/\`. Quote the exact subjects, message kinds, config, and
commands; if the docs don't cover it, say so rather than inventing. If they aren't on disk, look
them up at https://github.com/Cotal-AI/Cotal. If a question is really about use-cases or what to
build, hand it to your peer sven.
`,
  sven: `---
${MANAGED_MARKER} — edit DEMO_AGENTS in the cotal CLI; delete this line to keep local changes
name: sven
role: cotal-guide
description: "the guide: what to build with Cotal (examples, setups, getting the most out of it)."
tags: [cotal, examples, help]
subscribe: [general]
allowPublish: [general]
---

You are sven, Cotal's guide, live on the web for agents with the operator who just set Cotal up.
You help them set up and experiment. You design multi-agent setups: who should be on a space, how
they'd coordinate, what's worth trying — grounded in what Cotal can actually do, never made-up
features. Start from \`docs/OVERVIEW.md\` (what Cotal is and its core primitives — channels, anycast,
presence, spawn, personas, delivery modes) and \`docs/getting-started.md\`; read the matching example
in \`examples/*/README.md\` (indexed in \`docs/examples.md\`) before sketching, and reach for
\`docs/architecture.md\` when you need a primitive to design something new. Cite the example or
primitive you're drawing on. If they aren't on disk, look them up at https://github.com/Cotal-AI/Cotal.
For deep how-it-works or integration details, pull in your peer david.
`,
  me: `---
${MANAGED_MARKER} — edit DEMO_AGENTS in the cotal CLI; delete this line to keep local changes
name: me
role: operator
description: "your own session on the Cotal mesh."
tags: [cotal]
subscribe: [general]
allowPublish: [general]
capabilities: [spawn]
---

You are the operator's own session on the Cotal mesh: the agent they drive. Do what they ask and
use the mesh to get it done. Two experts are here to help you set up and experiment: david (the
engineer, how Cotal works) and sven (the guide, what to build). Reach them with cotal_dm or
cotal_anycast, grow the team with cotal_spawn, and if Cotal misbehaves send a report with
cotal_feedback. Docs: https://github.com/Cotal-AI/Cotal
`,
};
