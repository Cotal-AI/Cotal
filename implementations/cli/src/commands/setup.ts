import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import * as p from "@clack/prompts";
import { type Connector, type FlagSpec, type FlagValues, type ParsedArgs } from "@cotal-ai/core";
import { homeCotalDir, installedExtensionVersion, loadExtensionsManifest, manifestExtensionNames, provenance } from "@cotal-ai/workspace";
import { materializeExtension } from "../ext-loader.js";
import { agentSkillsHome, canonicalSkillNames, installAgentSkills, type AgentSkillsResult } from "../lib/agent-skills.js";
import { cliVersion } from "../lib/version.js";
import { brand, brandBold, dim, ok, note, splash } from "../lib/theme.js";
import { runSteps, type Step } from "../lib/steps.js";
import { abortIfCancel } from "../lib/cancel.js";
import { openSetupLog } from "../lib/setup-log.js";
import { resolveNatsServer } from "../lib/nats-bin.js";
import { isOnboarded, markOnboarded } from "../lib/onboard.js";
import { machineStatus, meshStatus, onPath, webUp, WEB_URL } from "../lib/status.js";
import { managerUp } from "../lib/manager-proc.js";
import { cotalOnPath, displayCmd, isNpx, selfArgv } from "../lib/self-exec.js";
import { cotalPath } from "../lib/paths.js";

const ONBOARD_VERSION = "2";
const README_URL = "https://github.com/Cotal-AI/Cotal/blob/main/README.md";
const CC_DOCS_URL = "https://github.com/Cotal-AI/Cotal/blob/main/docs/connect-claude.md";
const NATS_RELEASES_URL = "https://github.com/nats-io/nats-server/releases";

/** `cotal setup`'s grammar — configure-only knobs. The old `--auth`/`--open` flags configured the
 *  MESH MODE at setup-launch time; setup no longer launches anything, so both are gone here —
 *  mesh mode is `cotal up [--open]`'s concern (where `--open` already lived; `--auth` simply died
 *  with the launch behavior). An unknown-option error rejects them, nothing silently. */
export const setupFlags = [
  { name: "full", type: "boolean", description: "redo the full guided flow (implies --demo)" },
  { name: "demo", type: "boolean", description: "also seed the guided expert team (david, sven, me)" },
  { name: "yes", type: "boolean", short: "y", description: "non-interactive accept-all (agents/CI)" },
] as const satisfies readonly FlagSpec[];

/**
 * `cotal setup`: guided setup — CONFIGURE-ONLY, state-independent. It checks prerequisites,
 * installs the Claude Code plugin, and seeds persona files; it NEVER launches anything (no mesh,
 * no web, no manager, no delivery daemon, no cmux/tmux session — launching is `cotal up` /
 * `cotal web` / `cotal supervise`). Every file it writes is announced (`→ wrote …`). First run
 * (no onboarded stamp) gets the full narrated flow; later runs get a status card. `--full`
 * forces the full flow. By default it seeds ONE agent (the `default` persona a bare `cotal spawn`
 * launches); the guided expert team (david/sven/me) is opt-in via `--demo` (and `--full`). Each
 * failed step offers an interactive Claude handoff (COTAL_SKIP_ASSIST=1 disables).
 */
export async function setup(args: ParsedArgs): Promise<void> {
  const values = args.values as FlagValues<typeof setupFlags>;
  const demo = Boolean(values.demo) || Boolean(values.full); // --full is the whole guided flow ⇒ team
  if (!isOnboarded() || values.full || values.yes) await runFirstRun(Boolean(values.yes), demo);
  else await runEnsure(demo);
}

/** The full, narrated first-run experience. `yes` = non-interactive accept-all; `demo` also seeds
 *  the guided expert team. Configure-only: prerequisites are CHECKED (never started); the finale
 *  tells the user what to run. */
async function runFirstRun(yes: boolean, demo: boolean): Promise<void> {
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
      explain: "Cotal needs Node 22 or newer.",
      context: [README_URL],
      async run() {
        const major = Number(process.versions.node.split(".")[0]);
        if (major < 22) throw new Error(`Node ${process.versions.node} is too old; Cotal needs Node >= 22`);
        return `Node ${process.versions.node}`;
      },
    },
    {
      name: "nats-binary",
      title: "Locate the NATS server",
      explain: "Cotal runs on NATS + JetStream, the wire your agents speak over. (Located only - `cotal up` starts it.)",
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
  // The Cotal skills plugin is independent of the mesh connector: install it for ANY Claude Code user
  // (its own user-scope plugin), since Claude Code does not read the cross-vendor `.agents/skills` dir.
  if (found.claude && !(await runSteps([skillsPluginStep()], log, { yes }))) return abort();
  for (const name of ["opencode"] as const) {
    if (selected.has(name) && found[name]) {
      p.log.success(`${name} ready (auto-wired when you spawn it)`);
      log.line(`connector ${name}: ready (no install)`);
    }
  }

  // Your agent: the generic `default` persona a bare `cotal spawn` launches — one agent, yours to
  // shape. This is the whole first-run default; the guided expert team is opt-in right below.
  seedDefaultAgent();
  p.log.success("Seeded your agent (.cotal/agents/default.md) - spawn it with `cotal spawn` once your mesh is up");
  log.line("default-agent: wrote default.md");
  // The guided expert team (david the engineer + sven the guide + me, your session) is opt-in:
  // `cotal setup --demo` (or `--full`). Keeps the default first run to one agent, not a crowd.
  if (demo) seedDemoTeam(log);

  // Cotal's own skills, for the non-Claude harnesses, via the cross-vendor `.agents/skills` convention.
  const skills = seedAgentSkills(log);
  p.log.success(
    `Installed ${skills.installed.length} cross-vendor skill${skills.installed.length !== 1 ? "s" : ""} (${skills.installed.join(", ")}) to ~/.agents/skills; read by Codex, Cursor, OpenCode, Gemini CLI, and Windsurf`,
  );
  if (skills.backedUp.length)
    p.log.warn(`Backed up your edited copy before refreshing: ${skills.backedUp.map((b) => `${b.name} -> ${b.path}`).join(", ")} (Cotal manages only its own skills under ~/.agents/skills).`);

  await offerGlobalInstall(yes);

  markOnboarded(ONBOARD_VERSION);
  provenance.wrote("onboarded stamp", join(homeCotalDir(), "onboarded.json"));
  const cmd = displayCmd();
  // The finale is the whole loop, minimal by default: start the mesh, talk to your one agent, stop.
  // With --demo it names the team; without, it points at --demo (and the optional dashboard).
  const driveLines = demo
    ? [
        `${ok("✓")} start the mesh      ${dim(`${cmd} up --detach`)}`,
        `${ok("✓")} drive a session     ${dim(`${cmd} spawn me`)}`,
        `${ok("✓")} ask the experts     ${dim(`${cmd} spawn david · ${cmd} spawn sven`)}`,
        `${ok("✓")} watch the mesh      ${dim(`${cmd} console`)}`,
        `${ok("✓")} stop everything     ${dim(`${cmd} down`)}`,
      ]
    : [
        `${ok("✓")} start the mesh      ${dim(`${cmd} up --detach`)}`,
        `${ok("✓")} talk to your agent  ${dim(`${cmd} spawn`)}`,
        `${ok("✓")} watch the mesh      ${dim(`${cmd} console`)}`,
        `${ok("✓")} stop everything     ${dim(`${cmd} down`)}`,
      ];
  const tail = demo
    ? [dim(`Visual dashboard: ${cmd} web`)]
    : [
        dim(`Want a visual dashboard? ${cmd} web`),
        dim(`Want a guided team (david the engineer, sven the guide)? ${cmd} setup --demo`),
      ];
  note(
    [
      "Everything is configured - nothing has been started. Bring your mesh up when you're ready:",
      "",
      ...driveLines,
      "",
      ...tail,
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
      p.log.info(`No problem - keep using ${dim("npx cotal-ai")}. Install later with ${dim("npm i -g cotal-ai")}.`);
      return;
    }
  }

  const pkg = `cotal-ai@${runningVersion() ?? "latest"}`;
  const s = p.spinner();
  s.start("Installing cotal globally");
  const r = spawnSync("npm", ["install", "-g", pkg], { encoding: "utf8" });
  if (r.status === 0) {
    s.stop("Installed - you can now run `cotal`");
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

/** The Claude Code plugin install, as a step (spinner + failure handling + handoff). Exported for the
 *  setup-failloud smoke (removed-connector skip vs broken-connector throw). */
export function claudePluginStep(): Step {
  return {
    name: "claude-plugin",
    title: "Install the Claude Code plugin",
    explain: "Lets a Claude Code session join the web and wake on peer messages.",
    context: [join(homeCotalDir(), "claude-plugin"), CC_DOCS_URL],
    async run() {
      // The claude connector is a seeded/`ext add`ed plugin now, not a static import. Only a GENUINE
      // removal (absent from the manifest) skips the plugin; a present-but-broken connector (version
      // skew, incompatible core, missing entry, import throw) must fail loud through runSteps with the
      // real repair diagnostic, never be misreported as a deliberate removal.
      if (!manifestExtensionNames("connector").includes("claude"))
        return "claude connector not installed - skipping the plugin (re-add it: cotal ext add @cotal-ai/connector-claude-code)";
      const claude = await materializeExtension<Connector>({ kind: "connector", name: "claude" });
      installConnectorPlugin(claude);
      return "cotal@cotal-mesh (local scope)";
    },
  };
}

/** The Claude Code skills-plugin install, as a step. Independent of the mesh connector: it runs whenever
 *  Claude is on PATH, so a Claude user gets Cotal's authored skills (team-topology today) even with no
 *  connector, and a repeat `cotal setup` updates them. Installed at user scope (machine-wide). */
export function skillsPluginStep(): Step {
  return {
    name: "claude-skills-plugin",
    title: "Add Cotal's skills to Claude Code",
    explain: "Installs Cotal's authored skills (team-topology) as a Claude Code plugin, updatable and removable on their own.",
    context: [join(homeCotalDir(), "claude-plugin"), CC_DOCS_URL],
    async run() {
      installSkillsPlugin();
      return "cotal-skills@cotal-mesh (user scope)";
    },
  };
}

/** The compact repeat-run: a one-glance status card, plus re-seeding the default persona if it's
 *  missing (announced). Nothing is launched — the card tells you what's down and how to start it.
 *  `--demo` here adds the guided team to an already-configured machine (no need to re-narrate). */
async function runEnsure(demo: boolean): Promise<void> {
  seedDefaultAgent(); // ensure `cotal spawn` (no name) always has a default to launch
  if (demo) seedDemoTeam(); // `cotal setup --demo` on a configured machine: add the team, then card
  ensureSkillsPlugin(); // fail-loud: close the upgrade gap so an onboarded machine re-running setup gets/refreshes (not silently stale) the Claude skills plugin
  seedAgentSkills(); // reconcile the cross-vendor `.agents/skills` drop so an upgrade + re-run isn't stale
  // A repeat `npx cotal-ai setup` on an onboarded machine that still lacks a durable `cotal` must
  // ALSO get the global-install offer — the first-run stamp is written once, so without this any
  // second setup (declined/failed install the first time, or a machine onboarded before the offer
  // existed) never installs `cotal`. The offer no-ops for a dev clone (`!isNpx()`) or an already
  // installed `cotal` (`cotalOnPath()`), so only the npx-without-cotal case is affected. Before the
  // card so its hints render `cotal` rather than `npx cotal-ai`.
  await offerGlobalInstall(false);
  await readyCard(process.cwd());
}

/** Install/refresh the Claude skills plugin on a repeat `cotal setup`. FAIL-LOUD: a registry, install,
 *  update, or version-verification failure aborts `cotal setup` with a nonzero exit rather than leaving
 *  Claude silently on a stale or missing skill. This is the customer clean-update-path invariant (no
 *  silent fallback), and it closes the gap where an onboarded machine never re-entered the first-run
 *  plugin step. Skipped only when Claude isn't on PATH. */
function ensureSkillsPlugin(): void {
  if (!onPath("claude")) return;
  installSkillsPlugin();
  provenance.wrote("claude skills plugin", claudeMarketDir());
}

/** True when an installed extension contributes the `web` command (the dashboard moved out to
 *  `@cotal-ai/web` in stage 4) — decides whether the ready-card says "start it" or "install it". */
function webInstalled(): boolean {
  try {
    return loadExtensionsManifest().extensions.some((e) => installedExtensionVersion(e.pkg) !== undefined && e.commands.some((cm) => cm.name === "web"));
  } catch {
    return false; // corrupt manifest — the card stays honest ("not installed"); `ext` commands surface the error
  }
}

// The web dashboard is a first-party seeded extension now (@cotal-ai/web, in SEEDED_EXTENSIONS): the
// boot reconcile installs and version-refreshes it from the umbrella's bundled payload, exactly like
// the connectors. So setup no longer fetches it — by the time these steps run, the reconcile has
// already seeded web at the binary's version.

/** The `cotal · status` one-glance card: machine + mesh + web + manager status (read-only
 *  probes — displaying state is not depending on it), plus the key commands. */
async function readyCard(cwd: string): Promise<void> {
  const mesh = await meshStatus(cwd);
  const m = await machineStatus();
  const web = await webUp();
  const mgr = managerUp();
  const cmd = displayCmd();
  const hasDemo = existsSync(cotalPath("agents", "david.md")); // the guided team is present ⇒ richer hint
  const line = (on: boolean, text: string) => `${on ? ok("✓") : dim("○")} ${text}`;
  note(
    [
      line(m.nats !== "missing", `NATS     ${dim(m.nats === "missing" ? "missing" : m.nats)}`),
      line(m.claudePlugin, `plugin   ${dim(m.claudePlugin ? "installed" : "not installed")}`),
      line(mesh.reachable, `mesh     ${dim(mesh.reachable ? `${mesh.server} · space ${mesh.space}` : `down · start: ${cmd} up --detach`)}`),
      line(web, `web      ${dim(web ? WEB_URL : webInstalled() ? `down · start: ${cmd} web` : `not installed · retry: ${cmd} setup`)}`),
      line(mgr, `manager  ${dim(mgr ? "running" : `not running · start: ${cmd} up, or: ${cmd} supervise`)}`),
      "",
      `start the mesh:  ${dim(`${cmd} up --detach`)}`,
      // Match the hint to what's actually on disk: the guided team (with --demo) vs the one default agent.
      hasDemo
        ? `drive it:        ${dim(`${cmd} spawn me`)}   ${dim("(or david / sven)")}`
        : `drive it:        ${dim(`${cmd} spawn`)}   ${dim("(talk to your agent · guided team: " + cmd + " setup --demo)")}`,
      `watch it:        ${dim(`${cmd} console`)}   ${dim("(live TUI in this terminal)")}`,
      `more:            ${dim(`${cmd} web · ${cmd} down · ${cmd} feedback "<msg>" · ${cmd} --help`)}`,
    ].join("\n"),
    brandBold("cotal · status"),
  );
}

/** The shared marketplace dir for the Cotal Claude Code plugins (materialized under ~/.cotal so it
 *  survives npx cache eviction). The marketplace name must stay `cotal-mesh` (the connector's channel
 *  ref `plugin:cotal@cotal-mesh` depends on it). Two plugins live here, installed by independent steps:
 *  `cotal` (the mesh connector, shipped by @cotal-ai/connector-claude-code, `--scope local`) and
 *  `cotal-skills` (Cotal-authored skills shipped in THIS CLI package, `--scope user`). They install,
 *  update, and uninstall on their own. */
function claudeMarketDir(): string {
  return join(homeCotalDir(), "claude-plugin");
}

/** The exact set of plugins Cotal materializes into the shared marketplace. The marketplace manifest is
 *  built from THIS list (not an arbitrary `readdir`), so a crash remnant like `cotal.old.<pid>` or a
 *  third-party dir can never be published as a bogus marketplace entry. */
const COTAL_PLUGINS = ["cotal", "cotal-skills"] as const;

/** Materialize one plugin into the shared marketplace by REPLACING its dir, never merging into a stale
 *  one: a leftover `hooks/`, `.mcp.json`, or `agents/` in an old plugin dir would be auto-discovered by
 *  Claude and turn an otherwise data-only plugin into a code surface. Only the allowlisted assets are
 *  copied into a sibling staging dir; an optional release `version` is stamped into plugin.json (its
 *  manifest version is Claude's cache key, so a new release must present a new version to update a
 *  deployed install); then the live dir is moved aside and staging renamed in.
 *
 *  The swap keeps a live source at all times: on a FAILED `staging -> dest` rename the moved-aside `old`
 *  is restored to `dest` before cleanup, and `old` is deleted only once the new dir is safely in place. A
 *  process crash mid-swap leaves `<name>.old.<pid>`/`<name>.staging.<pid>`; on the next run a leftover
 *  `old` is restored to `dest` if the live dir was lost, then remnants are swept, and none are ever
 *  published (the marketplace is built from an explicit plugin list, not a readdir). */
function materializePluginDir(name: string, root: string, assets: string[], version?: string): void {
  const marketDir = claudeMarketDir();
  mkdirSync(marketDir, { recursive: true });
  const dest = join(marketDir, name);
  const staging = `${dest}.staging.${process.pid}`;
  const old = `${dest}.old.${process.pid}`;
  // Recover, THEN sweep, orphan swap dirs left by a crashed prior run. If `dest` is absent but a crash
  // left a moved-aside `<name>.old.*` (a previously-live, complete copy), restore it first so we never
  // delete the only recoverable source before the rebuild proves out. Staging dirs may be half-copied,
  // so they are only swept, never promoted.
  const orphans = readdirSync(marketDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && (e.name.startsWith(`${name}.old.`) || e.name.startsWith(`${name}.staging.`)))
    .map((e) => e.name);
  if (!existsSync(dest)) {
    const recoverable = orphans.find((n) => n.startsWith(`${name}.old.`));
    if (recoverable) renameSync(join(marketDir, recoverable), dest);
  }
  for (const n of orphans) rmSync(join(marketDir, n), { recursive: true, force: true }); // the recovered one (if any) is already renamed away
  let movedAside = false; // dest -> old happened
  let swapped = false; // staging -> dest happened
  try {
    for (const f of assets) cpSync(join(root, f), join(staging, f), { recursive: true, dereference: true });
    if (version) {
      const pj = join(staging, ".claude-plugin", "plugin.json");
      const manifest = JSON.parse(readFileSync(pj, "utf8")) as Record<string, unknown>;
      manifest.version = version;
      writeFileSync(pj, JSON.stringify(manifest, null, 2) + "\n");
    }
    if (existsSync(dest)) {
      renameSync(dest, old); // move the live dir aside (recoverable) rather than delete-then-rebuild
      movedAside = true;
    }
    renameSync(staging, dest);
    swapped = true;
  } finally {
    // If the swap failed after moving the live dir aside, put it back so the marketplace keeps a source.
    if (movedAside && !swapped && !existsSync(dest)) {
      try {
        renameSync(old, dest);
      } catch {
        /* best effort: `old` remains on disk for manual recovery */
      }
    }
    rmSync(staging, { recursive: true, force: true });
    if (swapped || !movedAside) rmSync(old, { recursive: true, force: true }); // drop the saved copy only once the new dir is in place (or none was saved)
  }
}

/** Rewrite marketplace.json to list EXACTLY the Cotal plugins currently materialized, so the connector
 *  and skills plugins (installed in either order, by independent steps) always coexist, and a removed one
 *  drops out. Built from the explicit `COTAL_PLUGINS` list (not a `readdir`), so a crash remnant or a
 *  foreign directory can never be published as a marketplace entry. */
function writeMarketplaceManifest(): void {
  const marketDir = claudeMarketDir();
  const plugins = COTAL_PLUGINS.filter((name) => existsSync(join(marketDir, name, ".claude-plugin", "plugin.json")))
    .map((name) => ({ name, source: `./${name}` }))
    .sort((a, b) => a.name.localeCompare(b.name));
  mkdirSync(join(marketDir, ".claude-plugin"), { recursive: true });
  writeFileSync(
    join(marketDir, ".claude-plugin", "marketplace.json"),
    JSON.stringify({ name: "cotal-mesh", description: "Cotal for Claude Code: the mesh connector plus Cotal-authored skills.", owner: { name: "Cotal" }, plugins }, null, 2),
  );
  provenance.wrote("plugin marketplace", marketDir);
}

/** Register (or refresh) the materialized marketplace with Claude. */
function registerMarketplace(): void {
  const add = claude("plugin", "marketplace", "add", claudeMarketDir());
  if (add.status !== 0) {
    const update = claude("plugin", "marketplace", "update", "cotal-mesh");
    if (update.status !== 0) throw new Error(`couldn't register the plugin marketplace:\n${add.output}\n${update.output}`);
  }
}

/** Install a plugin at `scope`, or UPDATE it if already installed. A bare re-`install` is a no-op that
 *  keeps the cached (possibly older) version; pairing a release-stamped manifest version with an explicit
 *  `plugin update` is what actually refreshes a deployed install. Then verify it truly loaded, at
 *  `expectedVersion` when one is given (so a cache that didn't update is caught, not passed). */
function installOrUpdatePlugin(name: string, scope: string, expectedVersion?: string): void {
  registerMarketplace();
  const install = claude("plugin", "install", `${name}@cotal-mesh`, "--scope", scope);
  // Trigger the update on what `plugin install` SAYS, not on its exit status: when the plugin is
  // already installed it reports that and exits ZERO. Gating the update on a non-zero status meant
  // it never ran on an upgrade, so the cache kept the old version and verifyPluginLoaded below
  // threw "the update did not take" at every customer who upgraded.
  const already = /already installed/i.test(install.output);
  if (install.status !== 0 && !already) throw new Error(`plugin install failed (${name}):\n${install.output}`);
  if (already) {
    const update = claude("plugin", "update", `${name}@cotal-mesh`, "--scope", scope);
    if (update.status !== 0) throw new Error(`plugin update failed (${name}):\n${update.output}`);
  }
  verifyPluginLoaded(name, scope, expectedVersion);
}

/** Verify a plugin actually loaded at the intended scope via `claude plugin list --json` (exact id,
 *  scope, enabled, load errors, and version when pinned). The human-output substring check this replaces
 *  accepted a failed-to-load entry (its name still prints) and let `cotal-skills` satisfy a check for
 *  `cotal`. For local scope the entry must be THIS project's (there is one `cotal@cotal-mesh` per
 *  project, some from other projects with load errors), matched by `projectPath`. */
function verifyPluginLoaded(name: string, scope: string, expectedVersion?: string): void {
  const r = claude("plugin", "list", "--json");
  if (r.status !== 0) throw new Error(`\`claude plugin list --json\` failed:\n${r.output}`);
  let entries: Array<Record<string, unknown>>;
  try {
    const parsed = JSON.parse(r.output) as unknown;
    entries = Array.isArray(parsed) ? (parsed as Array<Record<string, unknown>>) : [];
  } catch {
    throw new Error(`could not parse \`claude plugin list --json\`:\n${r.output}`);
  }
  const id = `${name}@cotal-mesh`;
  const here = resolve(process.cwd());
  const match = entries.find(
    (e) => e.id === id && e.scope === scope && (scope !== "local" || (typeof e.projectPath === "string" && resolve(e.projectPath) === here)),
  );
  const where = scope === "local" ? `${scope}, project ${here}` : scope;
  if (!match) throw new Error(`plugin ${id} (scope ${where}) is not present in \`claude plugin list --json\` after install`);
  if (match.enabled === false) throw new Error(`plugin ${id} installed but disabled`);
  const errs = (match.errors ?? match.error) as unknown;
  if (Array.isArray(errs) ? errs.length > 0 : Boolean(errs)) throw new Error(`plugin ${id} loaded with errors: ${JSON.stringify(errs)}`);
  if (expectedVersion && match.version !== expectedVersion)
    throw new Error(`plugin ${id} is at version ${String(match.version)}, expected ${expectedVersion} (the update did not take)`);
}

/** Install the connector plugin (`cotal`, `--scope local`; its lifecycle hooks bind to a locally-installed
 *  plugin). Called from claudePluginStep when the claude connector is present in the manifest. */
function installConnectorPlugin(claudeConnector: Connector): void {
  const { pluginRoot } = claudeConnector;
  if (!pluginRoot) throw new Error('the "claude" connector ships no plugin assets');
  for (const f of ["dist/mcp.cjs", "dist/hook.cjs", ".claude-plugin/plugin.json", ".mcp.json", "hooks/hooks.json"]) {
    if (!existsSync(join(pluginRoot, f)))
      throw new Error(`plugin asset missing: ${join(pluginRoot, f)} (in a dev clone, build it with: pnpm --filter @cotal-ai/connector-claude-code bundle)`);
  }
  materializePluginDir("cotal", pluginRoot, [".claude-plugin", ".mcp.json", "hooks", "dist/mcp.cjs", "dist/hook.cjs"]);
  writeMarketplaceManifest();
  installOrUpdatePlugin("cotal", "local");
}

/** Install/update the skills plugin (`cotal-skills`, `--scope user` so it is machine-wide, and independent
 *  of the mesh connector: it carries no code and no core dependency, so it can never be core-skewed). Its
 *  manifest version is stamped from the running CLI release, so an upgrade actually replaces the cached
 *  skill in Claude. The canonical `SKILL.md` files are shared with the `.agents/skills` drop and the
 *  website index (see lib/agent-skills.ts). Runs whenever Claude is on PATH, on first run AND on a repeat
 *  `cotal setup`. */
function installSkillsPlugin(): void {
  const root = join(import.meta.dirname, "..", "..", "cotal-skills");
  if (!existsSync(join(root, ".claude-plugin", "plugin.json")))
    throw new Error(`cotal-skills plugin manifest missing at ${join(root, ".claude-plugin")}. Corrupt cotal-ai install.`);
  canonicalSkillNames(); // fail loud on a missing/corrupt skills bundle before we touch Claude
  const version = cliVersion();
  materializePluginDir("cotal-skills", root, [".claude-plugin", "skills"], version);
  writeMarketplaceManifest();
  installOrUpdatePlugin("cotal-skills", "user", version);
}

function claude(...args: string[]): { status: number | null; output: string } {
  const r = spawnSync("claude", args, { encoding: "utf8" });
  return { status: r.status, output: `${r.stdout ?? ""}${r.stderr ?? ""}`.trim() };
}

/** Reconcile Cotal's authored skills into the cross-vendor `~/.agents/skills` directory that Codex,
 *  Cursor, OpenCode, Gemini CLI, and Windsurf/Devin all read. Unlike the Claude Code plugin, these
 *  harnesses have no remote install/update path, so `cotal setup` reconciles the files (install/refresh,
 *  back up a user's edited copy, remove a retired Cotal skill) and `cotal status` reports skew. Idempotent;
 *  a re-run after an upgrade brings a deployed install current. */
function seedAgentSkills(log?: ReturnType<typeof openSetupLog>): AgentSkillsResult {
  const r = installAgentSkills();
  provenance.wrote("cross-vendor skills", agentSkillsHome());
  log?.line(
    `agent-skills: installed ${r.installed.join(", ")}` +
      (r.backedUp.length ? `; backed up ${r.backedUp.map((b) => b.path).join(", ")}` : "") +
      (r.removed.length ? `; removed ${r.removed.join(", ")}` : ""),
  );
  return r;
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
 *  edits stand; deleting it just means the next `cotal setup` writes a fresh copy.
 *
 *  Read scope is split intentionally: the ACTIVE set (`subscribe`) is EMPTY, so a fresh
 *  agent isn't firehosed every channel on the mesh at boot, while the read ACL (`allowSubscribe:
 *  [">"]`) still PERMITS it to read anything — it just has to `cotal_join` a channel to start
 *  receiving it. (`subscribe: [">"]` would auto-subscribe to every channel, the old behavior.) */
const DEFAULT_AGENT = `---
name: default_agent
role: default
description: An agent on the mesh
tags: []
subscribe: []
allowSubscribe: [">"]
allowPublish: []
capabilities: [spawn]
---

You are an agent on the Cotal mesh - a shared space where agents join, see who's around, and
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

/** Seed the guided expert team — david (the engineer), sven (the guide), me (your session) — the
 *  opt-in richer first experience (`cotal setup --demo` / `--full`). These are setup-managed, unlike
 *  the seed-once default: refreshed when a DEMO_AGENTS body changes so persona edits actually land,
 *  but a file you've taken ownership of is backed up first, never silently lost (see writeDemoAgent).
 *  Every write is announced; `log` (present only in the narrated first run) also records it. */
function seedDemoTeam(log?: { line(msg: string): void }): void {
  mkdirSync(cotalPath("agents"), { recursive: true });
  for (const [name, body] of Object.entries(DEMO_AGENTS)) {
    writeDemoAgent(cotalPath("agents", `${name}.md`), body);
  }
  p.log.success("Added the guided team - david (the engineer), sven (the guide), and your session (me); spawn them when your mesh is up");
  log?.line("demo-agents: wrote david + sven + me");
}

const DEMO_AGENTS: Record<string, string> = {
  david: `---
${MANAGED_MARKER} - edit DEMO_AGENTS in the cotal CLI; delete this line to keep local changes
name: david
role: cotal-tech
description: "the engineer: how Cotal works (the wire, NATS, connectors, integration)."
tags: [cotal, technical, help]
subscribe: [welcome]
allowPublish: [welcome]
---

You are david, Cotal's engineer, live on the web for agents with the operator who just set Cotal
up. You help them set up and experiment. Your topic is how Cotal works: the wire contract (subjects,
message schemas, presence), NATS and JetStream underneath, the endpoint/connector model, the
delivery modes (multicast, unicast, anycast), and how to get any agent or framework onto the mesh.
You ground every answer in the real thing, never a guess. Start from \`docs/what-is-cotal.md\` (what Cotal
is and its core primitives) and \`docs/getting-started.md\`, then read the source for your topic:
\`docs/architecture.md\`, \`docs/connect-claude.md\`, \`docs/setup-internals.md\`, and, in a
source checkout, \`packages/\` and \`extensions/\`. Quote the exact subjects, message kinds, config, and
commands; if the docs don't cover it, say so rather than inventing. If they aren't on disk, look
them up at https://github.com/Cotal-AI/Cotal. If a question is really about use-cases or what to
build, hand it to your peer sven.
`,
  sven: `---
${MANAGED_MARKER} - edit DEMO_AGENTS in the cotal CLI; delete this line to keep local changes
name: sven
role: cotal-guide
description: "the guide: what to build with Cotal (examples, setups, getting the most out of it)."
tags: [cotal, examples, help]
subscribe: [welcome]
allowPublish: [welcome]
---

You are sven, Cotal's guide, live on the web for agents with the operator who just set Cotal up.
You help them set up and experiment. You design multi-agent setups: who should be on a space, how
they'd coordinate, what's worth trying - grounded in what Cotal can actually do, never made-up
features. Start from \`docs/what-is-cotal.md\` (what Cotal is and its core primitives - channels, anycast,
presence, spawn, personas, delivery modes) and \`docs/getting-started.md\`; read the matching example
in \`examples/*/README.md\` (indexed in \`docs/examples.md\`) before sketching, and reach for
\`docs/architecture.md\` when you need a primitive to design something new. Cite the example or
primitive you're drawing on. If they aren't on disk, look them up at https://github.com/Cotal-AI/Cotal.
For deep how-it-works or integration details, pull in your peer david.
`,
  me: `---
${MANAGED_MARKER} - edit DEMO_AGENTS in the cotal CLI; delete this line to keep local changes
name: me
role: operator
description: "your own session on the Cotal mesh."
tags: [cotal]
subscribe: [welcome]
allowPublish: [welcome]
capabilities: [spawn]
---

You are the operator's own session on the Cotal mesh: the agent they drive. Do what they ask and
use the mesh to get it done. Two experts are here to help you set up and experiment: david (the
engineer, how Cotal works) and sven (the guide, what to build). Reach them with cotal_dm or
cotal_anycast, grow the team with cotal_spawn, and if Cotal misbehaves send a report with
cotal_feedback. Docs: https://github.com/Cotal-AI/Cotal
`,
};
