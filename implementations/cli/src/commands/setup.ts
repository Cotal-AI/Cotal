import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import * as p from "@clack/prompts";
import { registry, type Connector, type ConnectorSetupAction, type ConnectorSetupProvider, type ConnectorSkillsSetupInput, type FlagSpec, type FlagValues, type ParsedArgs } from "@cotal-ai/core";
import { homeCotalDir, installedExtensionVersion, loadExtensionsManifest, manifestExtensionNames, provenance } from "@cotal-ai/workspace";
import { materializeExtension } from "../ext-loader.js";
import { agentSkillsHome, canonicalSkillNames, canonicalSkillsDir, installAgentSkills, type AgentSkillsResult } from "../lib/agent-skills.js";
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
const NATS_RELEASES_URL = "https://github.com/nats-io/nats-server/releases";

/** `cotal setup`'s grammar — configure-only knobs. The old `--auth`/`--open` flags configured the
 *  MESH MODE at setup-launch time; setup no longer launches anything, so both are gone here —
 *  mesh mode is `cotal up [--open]`'s concern (where `--open` already lived; `--auth` simply died
 *  with the launch behavior). An unknown-option error rejects them, nothing silently. */
export const setupFlags = [
  { name: "full", type: "boolean", description: "redo the full guided flow (implies --demo)" },
  { name: "demo", type: "boolean", description: "also seed the guided expert team (david, sven, me)" },
  { name: "yes", type: "boolean", short: "y", description: "non-interactive accept-all (agents/CI)" },
  { name: "skills", type: "boolean", description: "reconcile Cotal skills through installed connector providers and ~/.agents/skills; no personas or onboard writes" },
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
  if (values.skills) {
    if (values.full || values.demo) throw new Error("--skills cannot be combined with --full or --demo");
    await runSkillsOnly();
    return;
  }
  const demo = Boolean(values.demo) || Boolean(values.full); // --full is the whole guided flow ⇒ team
  if (!isOnboarded() || values.full || values.yes) await runFirstRun(Boolean(values.yes), demo);
  else await runEnsure(demo);
}

/** Skills-only write for the status card: let installed connectors reconcile their own harness,
 *  then reconcile `~/.agents/skills`. Does not seed personas, offer a global install, or write the
 *  onboarded stamp. */
async function runSkillsOnly(): Promise<void> {
  await reconcileConnectorSkills();
  seedAgentSkills();
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

  // Connectors: which agents should be able to join. MEMBERSHIP is the live registry plus the
  // installed extension manifest — every connector that declares itself is a choice — and each
  // candidate's hints come from that connector's own declarations (`requires`, `setup`,
  // `pluginRoot`). No connector name is privileged here: the install itself is whatever the
  // connector's own setup provider declares.
  const candidates = setupConnectorCandidates(await setupConnectorSurface());
  const selected = await pickConnectors(candidates, yes);
  for (const candidate of candidates) {
    if (!selected.has(candidate.value)) continue;
    if (candidate.missing.length) {
      p.log.warn(`${candidate.value} needs ${candidate.missing.join(", ")} on PATH. Install it, then re-run ${displayCmd()} setup.`);
      continue;
    }
    const step = await connectorSetupStep(candidate.connector, "connector");
    if (step) {
      if (!(await runSteps([step], log, { yes }))) return abort();
    } else {
      p.log.success(`${candidate.value} ready (auto-wired when you spawn it)`);
      log.line(`connector ${candidate.value}: ready (no install)`);
    }
  }
  // A connector's skills action is independent of the mesh connector selection: it runs for every
  // connector whose harness is present, so someone using that harness gets Cotal's authored skills
  // even without joining the mesh through it (Claude Code, for one, does not read `.agents/skills`).
  for (const candidate of candidates) {
    if (candidate.missing.length) continue;
    const step = await connectorSetupStep(candidate.connector, "skills");
    if (step && !(await runSteps([step], log, { yes }))) return abort();
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
export interface SetupConnectorCandidate {
  connector: Connector;
  value: string;
  label: string;
  hint: string;
  missing: string[];
}

/** Every connector on the setup surface becomes a choice. Its OWN declarations drive the hints —
 *  `requires` for readiness, `setup` for whether it runs connector-owned setup at all, `pluginRoot`
 *  for how that reads — and connector names never gate membership. Exported for the genericity smoke. */
export function setupConnectorCandidates(
  connectors: readonly Connector[],
  pathProbe: (bin: string) => boolean = onPath,
): SetupConnectorCandidate[] {
  return [...connectors]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((connector) => {
      const missing = (connector.requires ?? []).filter((bin) => !pathProbe(bin));
      return {
        connector,
        value: connector.name,
        label: connector.name,
        missing,
        hint: missing.length
          ? `${missing.join(", ")} not on PATH`
          : connector.setup
            ? connector.pluginRoot
              ? "installs a plugin"
              : "runs its own setup"
            : "ready at spawn",
      };
    });
}

/** Materialize every connector advertised by the registry or installed manifest. Exported so the
 *  fail-loud smoke reaches the same discovery boundary as guided setup. */
export async function setupConnectorSurface(): Promise<Connector[]> {
  const names = new Set(registry.all<Connector>("connector").map((connector) => connector.name));
  for (const name of manifestExtensionNames("connector")) names.add(name);
  return Promise.all([...names].sort().map((name) =>
    materializeExtension<Connector>({ kind: "connector", name })
  ));
}

async function pickConnectors(candidates: readonly SetupConnectorCandidate[], yes: boolean): Promise<Set<string>> {
  const all = candidates.filter((candidate) => candidate.missing.length === 0).map((candidate) => candidate.value);
  if (yes || !process.stdin.isTTY) return new Set(all);

  // Common case: show what was detected and offer a visible Continue button (clack's multiselect
  // has no native one). Only "Customize" (or nothing detected) drops into the toggle list.
  if (all.length) {
    note(all.join(", "), "Agents found");
    const go = abortIfCancel(
      await p.confirm({ message: "Set these up?", active: "Continue", inactive: "Customize", initialValue: true }),
    );
    if (go) return new Set(all);
  }

  const picked = abortIfCancel(
    await p.multiselect({
      message: "Pick the agents to set up (space toggles, enter continues)",
      options: [...candidates],
      initialValues: all,
      required: false,
    }),
  );
  return new Set(picked as string[]);
}

/** The compact repeat-run: a one-glance status card, plus re-seeding the default persona if it's
 *  missing (announced). Nothing is launched — the card tells you what's down and how to start it.
 *  `--demo` here adds the guided team to an already-configured machine (no need to re-narrate). */
async function runEnsure(demo: boolean): Promise<void> {
  seedDefaultAgent(); // ensure `cotal spawn` (no name) always has a default to launch
  if (demo) seedDemoTeam(); // `cotal setup --demo` on a configured machine: add the team, then card
  await reconcileConnectorSkills();
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

/** Resolve a connector's declared setup provider from the CONNECTOR the surface produced, never
 * from a name this file knows. A connector that declares none simply owns no setup; a DECLARED
 * provider that is missing or broken fails loud, because the base CLI never substitutes a built-in
 * harness implementation. Exported for the fail-loud smoke. */
export async function connectorSetupProvider(connector: Connector): Promise<ConnectorSetupProvider | null> {
  if (!connector.setup) return null;
  return materializeExtension<ConnectorSetupProvider>(connector.setup);
}

/** One connector-owned setup action as a narrated step, or null when this connector declares no
 * provider, no such action, or its provider's executables are absent — none of which is a failure
 * of guided setup (the cross-vendor skills drop still reconciles). Exported for the fail-loud
 * smoke, which drives this exact seam. */
export async function connectorSetupStep(connector: Connector, action: "connector" | "skills"): Promise<Step | null> {
  const provider = await connectorSetupProvider(connector);
  const setup = provider?.[action] as ConnectorSetupAction | undefined;
  if (!provider || !setup || !setupProviderAvailable(provider)) return null;
  const input = action === "skills" ? connectorSkillsInput() : undefined;
  return {
    name: setup.name,
    title: setup.title,
    explain: setup.explain,
    context: [...(setup.context ?? [])],
    async run() { return setup.run(input as never); },
  };
}

/** The generic Cotal inputs every connector-owned skills installer receives. Nothing in it names a
 * harness: the provider decides how its own harness consumes the cross-vendor skills. */
function connectorSkillsInput(): ConnectorSkillsSetupInput {
  return { skillsDir: canonicalSkillsDir(), version: cliVersion(), stateDir: homeCotalDir() };
}

async function reconcileConnectorSkills(): Promise<void> {
  for (const connector of await setupConnectorSurface()) {
    const provider = await connectorSetupProvider(connector);
    if (!provider?.skills || !setupProviderAvailable(provider)) continue;
    await provider.skills.run(connectorSkillsInput());
  }
}

/** Pure availability rule for connector-owned setup actions. No executable means no harness write;
 * the caller still continues to the cross-vendor Agent Skills reconcile. */
export function setupProviderAvailable(provider: Pick<ConnectorSetupProvider, "requires">): boolean {
  return !(provider.requires?.some((command) => !onPath(command)) ?? false);
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
 *  then the user's to shape. Unlike the demo team it is not generally refreshed; only the
 *  byte-exact legacy template below is migrated, so any edit stands. Deleting it means the next
 *  `cotal setup` writes a fresh copy.
 *
 *  Channel scope is split intentionally: the ACTIVE set (`subscribe`) is EMPTY, so a fresh agent
 *  isn't firehosed every channel on the mesh at boot, while the read and post ACLs permit it to
 *  join, create, read, and post channels on demand. (`subscribe: [">"]` would auto-subscribe to
 *  every channel, the old behavior.) */
export const DEFAULT_AGENT = `---
name: default_agent
role: default
description: An agent on the mesh
tags: []
subscribe: []
allowSubscribe: [">"]
allowPublish: [">"]
capabilities: [spawn]
---

You are an agent on the Cotal mesh - a shared space where agents join, see who's around, and
coordinate as peers rather than working in silos. Use the Cotal tools available to you to find
your peers and work with them. Edit this file to give yourself a name, role, and purpose.
`;

/** The byte-exact default template shipped before wildcard post permission. Keep this frozen: a
 *  future edit to the current template must not make an older untouched file ineligible for repair. */
export const LEGACY_DEFAULT_AGENT = [
  "---",
  "name: default_agent",
  "role: default",
  "description: An agent on the mesh",
  "tags: []",
  "subscribe: []",
  'allowSubscribe: [">"]',
  "allowPublish: []",
  "capabilities: [spawn]",
  "---",
  "",
  "You are an agent on the Cotal mesh - a shared space where agents join, see who's around, and",
  "coordinate as peers rather than working in silos. Use the Cotal tools available to you to find",
  "your peers and work with them. Edit this file to give yourself a name, role, and purpose.",
  "",
].join("\n");

/** Return the shipped replacement only for the byte-exact legacy default. Any user edit, including
 *  whitespace or frontmatter changes, keeps the persona under user ownership. Exported so the
 *  static template smoke can grade the upgrade decision without touching real setup state. */
export function migrateLegacyDefaultAgent(current: string): string | undefined {
  return current === LEGACY_DEFAULT_AGENT ? DEFAULT_AGENT : undefined;
}

export function reconcileDefaultAgent(path: string): "seeded" | "migrated" | "unchanged" {
  if (existsSync(path)) {
    const replacement = migrateLegacyDefaultAgent(readFileSync(path, "utf8"));
    if (replacement === undefined) return "unchanged";
    writeFileSync(path, replacement);
    return "migrated";
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, DEFAULT_AGENT);
  return "seeded";
}

/** Seed the default persona if it's missing, or migrate the byte-exact legacy template. Called from
 *  both first-run and repeat-run paths so new installs and untouched upgrades get the current grant
 *  while edited personas are never overwritten. */
function seedDefaultAgent(): void {
  const path = cotalPath("agents", "default.md");
  const result = reconcileDefaultAgent(path);
  if (result === "migrated") {
    provenance.wrote("updated default persona permissions", path);
    return;
  }
  if (result === "seeded") provenance.wrote("default persona", path);
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
