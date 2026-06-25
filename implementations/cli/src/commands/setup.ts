import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import * as p from "@clack/prompts";
import {
  DEFAULT_SERVER,
  isReachable,
  registry,
  type Connector,
  type Pane,
  type TerminalLayout,
} from "@cotal-ai/core";
import { authDir, loadSpaceAuth } from "@cotal-ai/workspace";
import { brand, brandBold, dim, ok, note, splash } from "../lib/theme.js";
import { LivePane } from "../lib/live-window.js";
import { runSteps, type Step } from "../lib/steps.js";
import { abortIfCancel } from "../lib/cancel.js";
import { openSetupLog } from "../lib/setup-log.js";
import { resolveNatsServer } from "../lib/nats-bin.js";
import { isOnboarded, markOnboarded } from "../lib/onboard.js";
import { machineStatus, meshStatus, onPath, resolveSpace } from "../lib/status.js";
import { startMeshDetached, up } from "./up.js";
import { ensureWeb, webUp, WEB_URL } from "./web.js";
import { cmuxManagerRunning, tmuxManagerRunning, managerUp, pgrepMatches, stopManager } from "../lib/manager-proc.js";
import { ensureControlPlane } from "../lib/delivery-proc.js";
import { cotalOnPath, displayCmd, isNpx, selfArgv } from "../lib/self-exec.js";
import { cotalPath, cotalRoot } from "../lib/paths.js";
import { spawn } from "./spawn.js";

const ONBOARD_VERSION = "1";
/** The teammates the cmux/background demo pre-spawns (manager-owned, so they're despawnable). One
 *  source of truth for both the `--spawn` list and the `cotal-<n>` tabs we clean up on restart. */
const DEMO_TEAM = ["david", "sven"] as const;
const README_URL = "https://github.com/Cotal-AI/Cotal/blob/main/README.md";
const CC_DOCS_URL = "https://github.com/Cotal-AI/Cotal/blob/main/docs/claude-code-integration.md";
const NATS_RELEASES_URL = "https://github.com/nats-io/nats-server/releases";

/** `cotal setup`: guided setup. First run (no `~/.cotal/onboarded.json`) gets the full
 *  narrated flow; later runs get a compact ensure+status. `--full` forces the full flow.
 *  Each failed step offers an interactive Claude handoff (COTAL_SKIP_ASSIST=1 disables). */
export async function setup(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      full: { type: "boolean" },
      yes: { type: "boolean", short: "y" },
      auth: { type: "boolean" }, // (now the DEFAULT; kept for back-compat / explicitness)
      open: { type: "boolean" }, // opt OUT of auth — a frictionless loopback-only open mesh (no JWT/ACLs, no durable backstop)
    },
  });
  // `--yes` (agents/CI) always runs the full flow non-interactively. The mesh is AUTHED by default
  // (JWT/ACLs — the trust-first default, and what the server-side delivery daemon needs to run); `--open`
  // opts out to a frictionless loopback-only open mesh with no auth (and so no durable backstop).
  if (!isOnboarded() || values.full || values.yes) await runFirstRun(Boolean(values.yes), Boolean(values.open));
  else await runEnsure();
}

/** `cotal go` — open or resume your session. A friendlier-named alias of `cotal setup`: the first
 *  run installs (full guided flow), later runs fast-forward to the ensure path and reopen your
 *  cmux session. `cotal setup` stays the explicit install/update name. */
export async function go(argv: string[]): Promise<void> {
  return setup(argv);
}

/** The full, narrated first-run experience. `yes` = non-interactive accept-all; `open` = run the mesh
 *  WITHOUT auth (the `--open` opt-out; auth is the default). Auth mode also brings up the server-side
 *  delivery daemon (durable backstop); open mode is live-only. */
async function runFirstRun(yes: boolean, open: boolean): Promise<void> {
  splash();
  p.intro(brandBold("Welcome to Cotal"));
  note(
    "Cotal is the open web for agents: they join a shared space, see who's around, and coordinate as peers instead of in silos. Build whole agent societies, even across different machines, on one open web. Let's set yours up.",
    "Give your agents a place to work together",
  );

  const log = openSetupLog(process.cwd());

  // Prerequisites + the local web (NATS). These never prompt.
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
      explain: "Cotal runs on NATS + JetStream, the wire your agents speak over.",
      context: [NATS_RELEASES_URL, README_URL],
      async run() {
        const r = await resolveNatsServer();
        return r.source === "path" ? "nats-server from PATH" : "bundled binary";
      },
    },
    {
      name: "start-mesh",
      title: "Start the web for agents",
      explain: "A local NATS + JetStream server you own; the web your agents join, in the background.",
      live: true,
      context: [cotalPath("nats.log"), cotalPath("auth/server.conf"), README_URL],
      async run() {
        if (await isReachable(DEFAULT_SERVER)) return `already running at ${DEFAULT_SERVER}`;
        const pane = new LivePane();
        pane.start("Booting nats-server");
        try {
          const { server } = await startMeshDetached({ onLine: (l) => pane.push(l), open });
          return `running at ${server} (stop with: ${displayCmd()} down)`;
        } finally {
          pane.clear();
        }
      },
    },
  ];
  if (!(await runSteps(core, log, { yes }))) return abort();

  // The web dashboard, in the background, so it's just there (best-effort; never blocks setup).
  try {
    const web = await ensureWeb({ space: resolveSpace(process.cwd()), server: DEFAULT_SERVER });
    if (web.running) {
      p.log.success(`Web dashboard at ${web.url} (stop with: ${displayCmd()} down)`);
      log.line(`web: ${web.url}`);
    }
  } catch {
    /* non-fatal: the card still shows how to start it */
  }

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
  // backed up first, never silently lost — see writeDemoAgent.
  mkdirSync(cotalPath("agents"), { recursive: true });
  for (const [name, body] of Object.entries(DEMO_AGENTS)) {
    writeDemoAgent(cotalPath("agents", `${name}.md`), body);
  }
  seedDefaultAgent(); // the generic persona `cotal spawn` (no name) launches
  p.log.success("Added david (the engineer), sven (the guide), and your session (me); they join when you spawn them or open the demo");
  log.line("demo-agents: wrote david + sven + me");

  await offerGlobalInstall(yes);

  markOnboarded(ONBOARD_VERSION);
  const cmd = displayCmd();
  note(
    [
      "Your agent has direct access to Cotal: spawn one and just talk to it (it can message peers, spawn teammates, and send feedback). Now any agent can join and collaborate. You can also use the CLI.",
      "",
      `${ok("✓")} drive a session     ${dim(`${cmd} spawn me`)}`,
      `${ok("✓")} ask the engineer    ${dim(`${cmd} spawn david`)}`,
      `${ok("✓")} ask the guide       ${dim(`${cmd} spawn sven`)}`,
      `${ok("✓")} watch the mesh      ${dim(`${cmd} console`)}`,
      `${ok("✓")} open the dashboard  ${dim(WEB_URL)}`,
      `${ok("✓")} resume later        ${dim(`${cmd} go`)}`,
      `${ok("✓")} stop everything     ${dim(`${cmd} down`)}`,
      "",
      dim(`Cotal not working? Tell your agent to give us feedback and it sends it for you (built-in cotal_feedback), or run ${cmd} feedback "<msg>".`),
    ].join("\n"),
    "You're set",
  );

  if (!yes) await offerDemo(found.claude);
  else {
    // Agents/CI: bring up the control plane (delivery daemon, auth only → manager) so cotal_spawn /
    // despawn / purge work right away.
    try {
      await ensureControlPlane({ space: resolveSpace(process.cwd()), server: DEFAULT_SERVER });
    } catch {
      /* non-fatal */
    }
  }
  p.outro(brand(yes ? "Cotal is ready." : "Happy meshing."));

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
    context: [join(homedir(), ".cotal/claude-plugin"), CC_DOCS_URL],
    async run() {
      installClaudePlugin();
      return "cotal@cotal-mesh (local scope)";
    },
  };
}

/** Finale: a live demo — a Claude the operator drives, with david and sven (manager-owned
 *  teammates) helping. In cmux they get their own tabs; otherwise they run in the background and
 *  the terminal is handed to the driving session. The demo spawns Claude sessions, so it needs
 *  Claude Code. If declined / no Claude, fall back to the `cotal · ready` card. Skipped under --yes. */
async function offerDemo(haveClaude: boolean): Promise<void> {
  const haveAgents = (["me", "david", "sven"] as const).every((n) => existsSync(cotalPath("agents", `${n}.md`)));
  const isTTY = Boolean(process.stdin.isTTY);

  if (haveClaude && haveAgents && isTTY) {
    const cmux = inCmuxSurface();
    const tmux = inTmuxSurface();

    if (cmux) {
      const go = abortIfCancel(
        await p.confirm({
          message: "Open the cmux demo? A Claude you drive, with david and sven helping in cmux tabs.",
          initialValue: true,
        }),
      );
      if (go) {
        ensureCmuxSession(cotalRoot());
        p.log.success("Session open: drive the 'cotal-main' pane; david and sven are on the mesh in the background.");
        return;
      }
    }

    if (tmux) {
      const go = abortIfCancel(
        await p.confirm({
          message: "Open the tmux demo? A Claude you drive, with david and sven helping in tmux windows.",
          initialValue: true,
        }),
      );
      if (go) {
        ensureTmuxSession(cotalRoot());
        p.log.success("Session open: switch to the 'cotal-main' window; david and sven are warming up in the background.");
        return;
      }
    }

    if (!cmux && !tmux) {
      const go = abortIfCancel(
        await p.confirm({
          message: "Open the demo? A Claude you drive, with david and sven helping in the background.",
          initialValue: true,
        }),
      );
      if (go) {
        // Background pty manager pre-spawns david/sven (managed, despawnable), then we hand this
        // terminal to the driving session. (auth → delivery daemon first, then the manager.)
        await ensureControlPlane({ space: resolveSpace(process.cwd()), server: DEFAULT_SERVER, spawn: [...DEMO_TEAM] });
        p.outro(brand("Launching your session... david and sven are warming up in the background."));
        await spawn(["me", "--prompt", ME_GREETING]);
        process.exit(0);
      }
    }
  } else if (isTTY && haveAgents && !haveClaude) {
    p.log.info(`The demo needs Claude Code. Install it (https://claude.com/claude-code), then run \`${displayCmd()} go\`.`);
  }

  // Declined, or no Claude: start the background control plane (delivery daemon, auth only → pty
  // manager) so cotal_spawn / despawn / purge still work, then leave them the quick-reference card.
  try {
    await ensureControlPlane({ space: resolveSpace(process.cwd()), server: DEFAULT_SERVER });
  } catch {
    /* non-fatal: the card still shows how to start it */
  }
  await readyCard(process.cwd());
}

/** Greeting the driving session auto-submits on start (no apostrophes — it rides through
 *  cmux's `bash -lc '…'` quoting). Teaches the capabilities by telling, not by calling tools,
 *  so it does not depend on david/sven having joined yet when this first turn runs. */
const ME_GREETING =
  "Greet the operator in a few short lines. Open with one line on what Cotal is: an open space where AI agents join and work together as peers. Say you are their Cotal session and that david (the engineer) and sven (the guide) are on the mesh to help. Then tell them what you can do for them: message david or sven, spawn new teammates and despawn them when done, and send feedback. End by asking what they want to build.";

/** True when we're running inside a real cmux pane (cmux sets `CMUX_SURFACE_ID` per surface).
 *  Opening/closing cmux tabs is only authorized from a live pane, so this — not the terminal
 *  provider's `available()` (which only pings the app) — is the gate for opening it. */
function inCmuxSurface(): boolean {
  return Boolean(process.env.CMUX_SURFACE_ID);
}

/** True when we're running inside a tmux session (tmux sets `$TMUX` to the socket path). */
function inTmuxSurface(): boolean {
  return Boolean(process.env.TMUX);
}

/** (Re)open the cmux working session, idempotently. A background cmux-runtime manager pre-spawns
 *  david/sven (so they're managed teammates you can `cotal_despawn`) into their own tabs; the
 *  focused `cotal-main` workspace is the console + the driving session "me" (your foreground
 *  driver). Re-running reuses whatever's already open — only missing tabs are created, so there's
 *  never a second manager. The `me` pane presses Enter on its own cmux surface a few times to
 *  auto-accept the one-time dev-channels prompt (the manager's cmux runtime does the same for
 *  david/sven). */
function ensureCmuxSession(cwd: string): void {
  // Open/close cmux tabs by resolving the registered "cmux" terminal-layout provider, so the CLI
  // drives cmux without importing the extension (the composition root's import is what registers it).
  const term = registry.resolve<TerminalLayout>("terminal", "cmux");

  // The cmux-tab manager becomes the control plane; drop any detached pty manager so they don't
  // both answer control requests.
  stopManager();

  // Describe each pane as plain argv (command + args + cwd) — the terminal provider owns all
  // shell quoting and the cmux layout. Invoke this CLI by its own argv (absolute node + entry),
  // not bare `cotal`, so the panes work whether installed via npx, `npm i -g`, or a dev clone (no
  // dependency on `cotal` being on PATH). The space follows the folder's auth so every pane matches
  // the running mesh.
  const cotal = selfArgv();
  const run = (...args: string[]): Pane => ({ command: cotal[0], args: [...cotal.slice(1), ...args], cwd });
  const space = resolveSpace(cwd);
  // `space` reaches the panes as a discrete argv token, but keep it a bare token anyway so it can't
  // confuse downstream parsing.
  if (!/^[A-Za-z0-9_.-]+$/.test(space))
    throw new Error(`cotal setup: unsafe space ${JSON.stringify(space)} (allowed: letters, digits, _ . -)`);

  // Control plane: a cmux-runtime manager that pre-spawns david/sven into their own tabs and owns
  // them (so cotal_despawn / cotal_spawn work). A cmux tab persists after its process dies, so
  // "workspace exists" != "manager running" — gate on the live process. When none is up, drop the
  // dead manager + teammate tabs first, then open a fresh one; otherwise re-runs keep skipping a
  // never-restarted manager and david/sven never join.
  if (!cmuxManagerRunning(space)) {
    for (const label of ["cotal-manager", ...DEMO_TEAM.map((n) => `cotal-${n}`)]) closeStaleTabs(term, label);
    term.open(
      "cotal-manager",
      { panes: [run("supervise", "--runtime", "cmux", "--space", space, "--spawn", DEMO_TEAM.join(","))] },
      { focus: false },
    );
  }

  // Your focused driver: console + the "me" session. Gate on the live driving session (not the
  // persistent tab) so a session you're driving is never disturbed; a dead/closed one gets its stale
  // tab dropped and reopened. The "me" pane sets `confirm` so the provider auto-clears Claude's
  // dev-channels prompt; the greeting rides as a plain argv token (the provider quotes it).
  if (!pgrepMatches(`spawn me --space ${space}`)) {
    closeStaleTabs(term, "cotal-main");
    term.open(
      "cotal-main",
      {
        split: { direction: "vertical", ratio: 0.34 },
        panes: [
          run("console", "--space", space),
          { ...run("spawn", "me", "--space", space, "--prompt", ME_GREETING), confirm: true },
        ],
      },
      { focus: true },
    );
  }
}

/** (Re)open the tmux working session, idempotently. Mirrors ensureCmuxSession using the "tmux"
 *  terminal provider: a background window runs the tmux-runtime manager (pre-spawning david/sven);
 *  the focused "cotal-main" window has the console + driving session "me". */
function ensureTmuxSession(cwd: string): void {
  const term = registry.resolve<TerminalLayout>("terminal", "tmux");

  stopManager();

  const cotal = selfArgv();
  const run = (...args: string[]): Pane => ({ command: cotal[0], args: [...cotal.slice(1), ...args], cwd });
  const space = resolveSpace(cwd);
  if (!/^[A-Za-z0-9_.-]+$/.test(space))
    throw new Error(`cotal setup: unsafe space ${JSON.stringify(space)} (allowed: letters, digits, _ . -)`);

  if (!tmuxManagerRunning(space)) {
    for (const label of ["cotal-manager", ...DEMO_TEAM.map((n) => `cotal-${n}`)]) closeStaleTabs(term, label);
    term.open(
      "cotal-manager",
      { panes: [run("supervise", "--runtime", "tmux", "--space", space, "--spawn", DEMO_TEAM.join(","))] },
      { focus: false },
    );
  }

  if (!pgrepMatches(`spawn me --space ${space}`)) {
    closeStaleTabs(term, "cotal-main");
    term.open(
      "cotal-main",
      {
        split: { direction: "vertical", ratio: 0.34 },
        panes: [
          run("console", "--space", space),
          { ...run("spawn", "me", "--space", space, "--prompt", ME_GREETING), confirm: true },
        ],
      },
      { focus: true },
    );
  }
}

/** Close any lingering cmux tabs labelled `name` (dead tabs persist in the tab list after their
 *  process exits) so a freshly opened one is the only instance. */
function closeStaleTabs(term: TerminalLayout, name: string): void {
  for (const ref of term.refs(name)) {
    try {
      term.close(ref);
    } catch {
      /* already gone */
    }
  }
}

/** The compact repeat-run: quietly ensure the mesh + web are up here, then a one-glance card. */
async function runEnsure(): Promise<void> {
  seedDefaultAgent(); // ensure `cotal spawn` (no name) always has a default to launch
  let mesh = await meshStatus(process.cwd());
  if (!mesh.reachable) {
    const s = p.spinner();
    s.start("Starting the web for agents");
    try {
      // Match how the mesh last ran: open when this folder has no space auth (the frictionless
      // default), authed when it does — so restarting a downed open mesh doesn't come back JWT-authed.
      const authed = Boolean(loadSpaceAuth(authDir(cotalRoot())));
      await up(authed ? ["--detach"] : ["--detach", "--open"]);
      s.stop("Web for agents started");
    } catch (e) {
      s.stop(`Couldn't start it: ${(e as Error).message}`);
      process.exitCode = 1;
      return;
    }
    mesh = await meshStatus(process.cwd());
  }
  await ensureWeb({ space: mesh.space, server: mesh.server }).catch(() => {});
  // Inside cmux, re-running setup reopens your session (idempotent: reuse the live manager +
  // david/sven, open only missing tabs). Otherwise bring up the background pty control plane.
  try {
    if (inCmuxSurface()) ensureCmuxSession(cotalRoot());
    else await ensureControlPlane({ space: mesh.space, server: mesh.server });
  } catch {
    /* non-fatal */
  }
  await readyCard(process.cwd());
}

/** The `cotal · ready` one-glance card: machine + mesh + web + manager status, plus the key
 *  commands. Shared by the repeat-run ensure and the first-run no-demo finale. */
async function readyCard(cwd: string): Promise<void> {
  const mesh = await meshStatus(cwd);
  const m = await machineStatus();
  const web = await webUp();
  // The control plane is either the detached pty manager (pid file) or a live cmux-tab manager
  // (its tab lingers after it exits, so check the process, not the workspace list).
  const mgr = managerUp() || (inCmuxSurface() && cmuxManagerRunning(mesh.space));
  const cmd = displayCmd();
  const line = (on: boolean, text: string) => `${on ? ok("✓") : dim("○")} ${text}`;
  note(
    [
      line(m.nats !== "missing", `NATS     ${dim(m.nats === "missing" ? "missing" : m.nats)}`),
      line(m.claudePlugin, `plugin   ${dim(m.claudePlugin ? "installed" : "not installed")}`),
      line(mesh.reachable, `mesh     ${dim(`${mesh.server} · space ${mesh.space}`)}`),
      line(web, `web      ${dim(WEB_URL)}`),
      line(mgr, `manager  ${dim(mgr ? "running" : "not running")}`),
      "",
      `resume:    ${dim(`${cmd} go`)}   ${dim("(reopen this session anytime)")}`,
      `watch it:  ${dim(`${cmd} console`)}   ${dim("(live TUI in this terminal)")}`,
      `drive it:  ${dim(`${cmd} spawn me`)}   ${dim("(or david / sven)")}`,
      `more:      ${dim(`${cmd} web · ${cmd} down · ${cmd} feedback "<msg>" · ${cmd} --help`)}`,
    ].join("\n"),
    brandBold("cotal · ready"),
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

  const marketDir = join(homedir(), ".cotal", "claude-plugin");
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
 *  `<name>.md.bak` first. Missing or marker-carrying files are written in place. */
function writeDemoAgent(path: string, body: string): void {
  if (existsSync(path)) {
    const cur = readFileSync(path, "utf8");
    if (cur === body) return; // already current
    if (!cur.includes(MANAGED_MARKER)) writeFileSync(`${path}.bak`, cur); // preserve a user/pre-marker edit
  }
  writeFileSync(path, body);
}

/** The default persona `cotal spawn` (no name) launches: a generic mesh agent, seeded once and
 *  then the user's to shape. Unlike the demo team it's never refreshed (seed-if-absent), so any
 *  edits stand; deleting it just means the next `cotal setup`/`go` writes a fresh copy. */
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
