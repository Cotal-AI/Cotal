import { parseArgs } from "node:util";
import { readFileSync, existsSync, rmSync } from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import { join } from "node:path";
import {
  CotalEndpoint,
  isReachable,
  DEFAULT_SERVER,
  DEFAULT_SPACE,
  authDir,
  findCotalRoot,
  loadSpaceAuth,
  registry,
  type Command,
  type ControlReply,
} from "@cotal-ai/core";
import { Manager } from "./manager.js";
import { findWorkspaceRoot, type RuntimeMode } from "./runtime/index.js";
import { attachClient } from "./attach-client.js";
import { c } from "./ui.js";

type Values = Record<string, string | undefined>;

/** The space to operate on: explicit `--space`, else this folder's `.cotal/auth` space, else the
 *  default — so a manually-run manager matches the folder's mesh instead of assuming the default. */
function spaceFor(v: Values): string {
  return v.space ?? loadSpaceAuth(authDir(findCotalRoot()))?.space ?? DEFAULT_SPACE;
}

function parse(argv: string[]): Values {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      space: { type: "string" },
      server: { type: "string" },
      name: { type: "string" },
      role: { type: "string" },
      agent: { type: "string" },
      config: { type: "string" },
      creds: { type: "string" },
      resume: { type: "string" },
      "console-port": { type: "string" },
      drive: { type: "boolean" },
      spawn: { type: "string" }, // comma-separated agent names to pre-spawn at startup
    },
  });
  // These commands are flags-only — reject stray positionals instead of silently ignoring
  // them (e.g. `cotal cmux up`, which used to start a default-space manager). (`cotal cmux go`
  // is now a real sub-verb, intercepted before this runs.)
  if (positionals.length) {
    const x = positionals[0];
    const hint = x === "up" ? " — did you mean `cotal up`?" : x === "go" ? " — did you mean `cotal cmux go`?" : "";
    console.error(c.red(`✗ unexpected argument: ${x}${hint}`));
    process.exit(1);
  }
  return values as Values;
}

/** Connect a short-lived client, send one control request to the manager, disconnect. */
async function ask(
  space: string,
  server: string,
  op: string,
  args?: Record<string, unknown>,
  credsPath?: string,
): Promise<ControlReply> {
  const creds = credsPath ? readFileSync(credsPath, "utf8") : undefined;
  if (!(await isReachable(server, { creds }))) {
    console.error(c.red(`Can't reach NATS at ${server}. Run: cotal up`));
    process.exit(1);
  }
  const ep = new CotalEndpoint({
    space,
    servers: server,
    creds,
    channels: [],
    consume: false, // request/reply only — binds no consumers (and under auth has no pre-created DM durable)
    registerPresence: false,
    watchPresence: false,
    card: { name: "cli", kind: "endpoint" },
  });
  ep.on("error", (e: Error) => console.error(c.red("! " + e.message)));
  await ep.start();
  try {
    return await ep.requestControl("manager", { op, args });
  } catch (e) {
    return { ok: false, error: `no manager reachable (${(e as Error).message})` };
  } finally {
    await ep.stop();
  }
}

function failIfNotOk(reply: ControlReply): void {
  if (!reply.ok) {
    console.error(c.red(`✗ ${reply.error ?? "error"}`));
    process.exit(1);
  }
}

async function start(argv: string[]): Promise<void> {
  const v = parse(argv);
  if (!v.name) {
    console.error(c.red("--name is required"));
    process.exit(1);
  }
  const reply = await ask(spaceFor(v), v.server ?? DEFAULT_SERVER, "start", {
    name: v.name,
    role: v.role,
    agent: v.agent,
    config: v.config,
    resume: v.resume,
  }, v.creds);
  failIfNotOk(reply);
  const d = reply.data as { name: string; role?: string; agent: string; mode: string };
  console.log(
    c.green(`✓ started ${c.bold(d.name)}`) +
      c.dim(` (${d.role ?? "no role"} · ${d.agent} · ${d.mode})`),
  );
}

async function stop(argv: string[]): Promise<void> {
  const v = parse(argv);
  if (!v.name) {
    console.error(c.red("--name is required"));
    process.exit(1);
  }
  const reply = await ask(spaceFor(v), v.server ?? DEFAULT_SERVER, "stop", {
    name: v.name,
  }, v.creds);
  failIfNotOk(reply);
  console.log(c.dim(`✓ stopped ${v.name}`));
}

async function ps(argv: string[]): Promise<void> {
  const v = parse(argv);
  const reply = await ask(spaceFor(v), v.server ?? DEFAULT_SERVER, "ps", undefined, v.creds);
  failIfNotOk(reply);
  const rows =
    (reply.data as Array<{
      name: string;
      role?: string;
      agent: string;
      mode: string;
      mesh: string;
    }>) ?? [];
  if (!rows.length) {
    console.log(c.dim("(no managed agents)"));
    return;
  }
  for (const r of rows) {
    const status =
      r.mesh === "absent"
        ? c.yellow("starting…")
        : r.mesh === "offline"
          ? c.dim("offline")
          : r.mesh === "working"
            ? c.green("working")
            : r.mesh === "waiting"
              ? c.yellow("waiting")
              : c.cyan(r.mesh);
    console.log(
      `${c.bold(r.name)}${r.role ? c.dim("/" + r.role) : ""}  ${c.dim(
        r.agent + " · " + r.mode,
      )}  ${status}`,
    );
  }
}

async function attach(argv: string[]): Promise<void> {
  const v = parse(argv);
  if (!v.name) {
    console.error(c.red("--name is required"));
    process.exit(1);
  }
  const reply = await ask(spaceFor(v), v.server ?? DEFAULT_SERVER, "attach", {
    name: v.name,
  }, v.creds);
  failIfNotOk(reply);
  const { ws } = reply.data as { ws: string };
  console.error(c.dim(`attached to ${v.name} — Ctrl-] to detach`));
  await attachClient(ws);
  console.error(c.dim(`\ndetached from ${v.name}`));
}

/** Run a manager daemon in this process (the long-lived supervisor), then block.
 *  `pty`/`tmux` ship with the manager; `cmux` needs its integration imported by the
 *  composition root (the `cotal` binary does). Stays alive until SIGINT/SIGTERM. */
async function runManager(argv: string[], runtime: RuntimeMode): Promise<void> {
  const v = parse(argv);
  const space = spaceFor(v);
  const server = v.server ?? DEFAULT_SERVER;
  if (!(await isReachable(server))) {
    console.error(c.red(`Can't reach NATS at ${server}. Run: cotal up`));
    process.exit(1);
  }
  const consolePort = v["console-port"] ? Number(v["console-port"]) : undefined;
  const mgr = new Manager({ space, servers: server, runtime, consolePort });
  await mgr.start();
  console.log(
    c.green("✓ manager up") +
      c.dim(` (space ${space} · ${mgr.runtimeKind})`) +
      `\n  console: ${mgr.consoleUrl}` +
      c.dim("\n  spawn: cotal start --name <n>   ·   stop: cotal stop --name <n>   (Ctrl-C to shut down)"),
  );
  // Pre-spawn teammates the manager owns (e.g. the demo's david/sven), so they're despawnable.
  // Stagger them: wait for each to register presence before launching the next, so several heavy
  // Claude cold-starts don't boot simultaneously and spike memory. The last one needs no wait.
  if (v.spawn) {
    const names = v.spawn.split(",").map((s) => s.trim()).filter(Boolean);
    for (let i = 0; i < names.length; i++) {
      const name = names[i];
      const reply = await mgr.startByName(name);
      if (!reply.ok) {
        console.error(c.red(`✗ couldn't spawn ${name}: ${reply.error ?? "unknown error"}`));
        continue;
      }
      console.log(c.green(`✓ spawned ${name}`));
      if (i < names.length - 1) {
        const joined = await mgr.waitForPresence(name);
        console.log(c.dim(joined ? `  ${name} joined; starting next` : `  ${name} still starting; continuing`));
      }
    }
  }
  const shutdown = () => void mgr.stop().then(() => process.exit(0));
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  await new Promise<void>(() => {});
}

/** One-command cmux onboarding (the built-in, generalized `launch.sh --drive`): from a
 *  cmux pane, install the plugin, bring up the mesh, open the manager in its own tab, and
 *  open a workspace with the console + a ready driving session. Orchestrates, then exits. */
async function runDrive(argv: string[]): Promise<void> {
  const v = parse(argv);
  const space = spaceFor(v);
  const name = v.name ?? "me";
  const server = v.server ?? DEFAULT_SERVER;
  // name/space get interpolated into the cmux pane's `bash -lc '…'` command; keep them bare
  // tokens so they can't break out of the quoting.
  for (const [label, val] of [["name", name], ["space", space]] as const)
    if (!/^[A-Za-z0-9_.-]+$/.test(val))
      throw new Error(`cotal cmux go: unsafe ${label} ${JSON.stringify(val)} (allowed: letters, digits, _ . -)`);
  const root = findWorkspaceRoot();
  const tsx = join(root, "node_modules", ".bin", "tsx");
  const cmuxCli = join(root, "extensions", "cmux", "src", "cli.ts");
  const cotalBin = join(root, "bin", "cotal.ts");
  // A cmux terminal leaf running a cotal subcommand (panes open in the login shell, which
  // may be nushell — wrap in `bash -lc` like launch.sh; `exec` so pgrep sees the real cmd).
  const leaf = (sub: string) => ({
    pane: {
      surfaces: [{ type: "terminal", command: `bash -lc 'cd ${root} && exec ${tsx} ${cotalBin} ${sub}'` }],
    },
  });
  // A driving pane that auto-accepts Claude's one-time dev-channels prompt by pressing Enter on
  // its own cmux surface a few times — so the session joins the mesh with no manual keypress.
  const enterLoop =
    '( [ -n "$CMUX_SURFACE_ID" ] && [ -n "$CMUX_BUNDLED_CLI_PATH" ] && ' +
    'for _ in 1 2 3 4 5; do sleep 1; "$CMUX_BUNDLED_CLI_PATH" send-key --surface "$CMUX_SURFACE_ID" enter >/dev/null 2>&1; done ) &';
  const leafConfirm = (sub: string) => ({
    pane: {
      surfaces: [
        { type: "terminal", command: `bash -lc 'cd ${root} || exit 1; ${enterLoop} exec ${tsx} ${cotalBin} ${sub}'` },
      ],
    },
  });
  const openWs = (wsName: string, layout: unknown) =>
    execFileSync(tsx, [cmuxCli, "open", wsName, JSON.stringify(layout)], { stdio: "ignore" });
  const cmuxBin = process.env.CMUX_BUNDLED_CLI_PATH;
  const workspaceExists = (wsName: string): boolean => {
    if (!cmuxBin) return false;
    try {
      return execFileSync(cmuxBin, ["list-workspaces"], { encoding: "utf8" })
        .split("\n")
        .some((l) => l.includes(wsName));
    } catch {
      return false;
    }
  };

  // Must run inside a live cmux surface (cmux authorizes its socket only from a real pane).
  try {
    execFileSync(tsx, [cmuxCli, "check"], { stdio: "ignore" });
  } catch {
    console.error(c.red("✗ can't reach cmux — run `cotal cmux go` from inside a cmux terminal."));
    process.exit(1);
  }

  // Plugin (idempotent) so the spawned Claude sessions have the cotal_* tools.
  // `--yes` runs the guided setup non-interactively (cmux go is one-shot onboarding).
  execFileSync(tsx, [cotalBin, "setup", "--yes"], { cwd: root, stdio: "inherit" });

  // Mesh: start it in the background if it isn't already up (cotal up blocks in the foreground).
  if (!(await isReachable(server))) {
    console.log(c.dim("Starting the mesh (cotal up --open)…"));
    spawn(tsx, [cotalBin, "up", "--open"], { cwd: root, detached: true, stdio: "ignore" }).unref();
    for (let i = 0; i < 40 && !(await isReachable(server)); i++)
      await new Promise((r) => setTimeout(r, 250));
    if (!(await isReachable(server))) {
      console.error(c.red("✗ mesh did not come up — try `cotal up --open` manually."));
      process.exit(1);
    }
  }
  console.log(c.green(`✓ mesh up at ${server}`));

  // A prior interactive `cotal setup` may have left a detached (pty) manager; cmux go wants its
  // own cmux-runtime manager, so stop that one first — queue-grouped control would otherwise split
  // spawns between the two.
  const pidFile = join(root, ".cotal", "manager.pid");
  if (existsSync(pidFile)) {
    const pid = Number(readFileSync(pidFile, "utf8").trim());
    try {
      process.kill(pid, "SIGTERM");
      console.log(c.dim(`stopped a background manager (pid ${pid}) to use cmux tabs`));
    } catch {
      /* already gone */
    }
    rmSync(pidFile);
  }

  // Manager in its own tab (skip if one is already running for this space).
  let mgrRunning = false;
  try {
    execFileSync("pgrep", ["-f", `cotal.ts cmux --space ${space}`], { stdio: "ignore" });
    mgrRunning = true;
  } catch {
    /* none running */
  }
  if (mgrRunning) {
    console.log(
      c.dim(
        `✓ manager already running for space "${space}" — to pick up code changes, restart it: ` +
          `Ctrl-C its tab or \`pkill -f "cotal.ts cmux --space ${space}"\`, then re-run.`,
      ),
    );
  } else {
    openWs("cotal-manager", leaf(`cmux --space ${space}`));
    console.log(c.green("✓ opened the manager tab (cotal-manager)"));
  }

  // Work workspace: console on top, a ready driving session below (skip if already open).
  if (workspaceExists(`cotal-${space}`)) {
    console.log(c.dim(`✓ workspace cotal-${space} already open`));
  } else {
    openWs(`cotal-${space}`, {
      direction: "vertical",
      split: 0.4,
      children: [leaf(`console --space ${space}`), leafConfirm(`spawn ${name} --space ${space}`)],
    });
    console.log(c.green(`✓ opened the cotal-${space} workspace (console + ${name})`));
  }
  console.log(
    c.dim(`\nSwitch to the "${name}" pane, then drive: cotal_persona · cotal_spawn · cotal_despawn.`),
  );
}

/** The manager's control-plane commands — the daemon runners (`supervise`/`cmux`)
 *  plus thin NATS request/reply clients that drive a running manager. Self-registered
 *  on import; the `cotal` binary resolves them from the registry. */
const managerCommands: Command[] = [
  {
    kind: "command",
    name: "supervise",
    group: "Manager",
    summary:
      "run a manager (terminal / pty runtime) — [--space <s>] [--server <url>] [--console-port <n>]",
    run: (argv) => runManager(argv, "auto"),
  },
  {
    kind: "command",
    name: "cmux",
    group: "Manager",
    summary:
      "run a manager that spawns each teammate into its own cmux tab — [--space <s>] [--server <url>]; " +
      "`cotal cmux go` = one-command onboarding (plugin + mesh + manager + console/driving session)",
    run: (argv) => (argv[0] === "go" ? runDrive(argv.slice(1)) : runManager(argv, "cmux")),
  },
  {
    kind: "command",
    name: "start",
    group: "Control plane",
    summary:
      "ask the manager to spawn an agent — --name <n> [--role <r>] [--agent <a>] [--config <file>] [--resume <id>] (auto-discovers .cotal/agents/<n>.md)",
    run: start,
  },
  {
    kind: "command",
    name: "stop",
    group: "Control plane",
    summary: "ask the manager to stop an agent — --name <n>",
    run: stop,
  },
  {
    kind: "command",
    name: "ps",
    group: "Control plane",
    summary: "list managed agents + their mesh status",
    run: ps,
  },
  {
    kind: "command",
    name: "attach",
    group: "Control plane",
    summary: "stream + drive an agent's terminal (pty runtime) — --name <n>",
    run: attach,
  },
];

registry.register(...managerCommands);
