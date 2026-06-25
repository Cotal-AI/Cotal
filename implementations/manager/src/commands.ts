import { parseArgs } from "node:util";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  CotalEndpoint,
  isReachable,
  DEFAULT_SERVER,
  DEFAULT_SPACE,
  mintCreds,
  newIdentity,
  registry,
  probeConnect,
  CONTROL_PRIVILEGED,
  CONTROL_ADMIN,
  type Command,
  type ControlReply,
  type ControlTier,
} from "@cotal-ai/core";
import {
  authDir,
  findCotalRoot,
  loadSpaceAuth,
  findMesh,
  isWorkspaceTargetError,
  resolveMeshTarget,
  preflightTarget,
  pruneStaleMeshes,
  removeMesh,
  renderWorkspaceError,
  type MeshTarget,
} from "@cotal-ai/workspace";
import { Manager } from "./manager.js";
import { loadRoster } from "./roster.js";
import { loadLaunchSpec, materializePersona, launchAgentToStartOpts } from "./launch.js";
import { type RuntimeMode } from "./runtime/index.js";
import { attachClient } from "./attach-client.js";
import { c } from "./ui.js";

type Values = Record<string, string | undefined>;

/** The space to operate on: explicit `--space`, else this folder's `.cotal/auth` space, else the
 *  default — so a manually-run manager matches the folder's mesh instead of assuming the default. */
function spaceFor(v: Values): string {
  return v.space ?? loadSpaceAuth(authDir(findCotalRoot()))?.space ?? DEFAULT_SPACE;
}

/** Raw off-registry reachability — one plain sentence, never a registry/stale-entry message and
 *  never a prune. Used by the `--creds` and `--server`+unregistered-`--space` escape hatches, which
 *  connect to a broker the operator named, not the registry. The manager's copy of the CLI's
 *  `reachableOrExit` (an implementation can't import another); the wording lives in `@cotal-ai/workspace`. */
async function reachableOrExit(server: string, auth: { creds?: string } = {}): Promise<void> {
  const probe = await probeConnect(server, auth);
  if (probe.ok) return;
  console.error(c.red(renderWorkspaceError({ kind: "reachable", reason: probe.reason, server })));
  process.exit(1);
}

/** Confirm a registry-resolved mesh is up + accepts these creds — replacing the raw NATS auth trace
 *  with one sentence and pruning a stale entry. The manager's copy of the CLI's `preflightOrExit`:
 *  the probe/classify/render/prune-decision live in `@cotal-ai/workspace` (`preflightTarget`); this owns
 *  the I/O — it acts on the prune decision, colours, and exits. */
async function preflightOrExit(target: MeshTarget, probeCreds?: string): Promise<void> {
  const r = await preflightTarget(target, probeCreds);
  if (r.ok) return;
  if (r.prune) removeMesh(target.space);
  console.error(c.red(renderWorkspaceError({ kind: "preflight", failure: r.kind, target, pruned: r.prune })));
  process.exit(1);
}

/** Resolve which running mesh a control command (`ps`/`start`/`stop`/`attach`) targets, with the
 *  same precedence + preflight as the rest of the CLI ({@link resolveMeshTarget} / `connectOrExit`):
 *    1. explicit `--creds` → a raw off-registry connection (plain reachability, no prune). Space
 *       defaults to this folder's auth-space via {@link spaceFor} (a deliberate manager-command
 *       choice — more correct than `DEFAULT_SPACE` for a non-default-space project, and what these
 *       commands did before — NOT `connectOrExit`'s `DEFAULT_SPACE`).
 *    2. `--server` + an UNregistered `--space` → a raw OPEN off-registry connection, no creds (the
 *       same escape hatch `connectOrExit` has; plain reachability, no prune).
 *    3. otherwise the registry/`current` resolver, with the same stale-prune + friendly preflight —
 *       so `cotal ps --space <name>` reaches that mesh's RECORDED broker instead of silently assuming
 *       `DEFAULT_SERVER` (:4222); `--server` overrides. The privileged "manager" cred is minted from
 *       the RESOLVED mesh's own recorded root (so `--space other` loads other's auth, guarded by
 *       `targetFromEntry`'s `auth.space === m.space` check), or none for an open mesh.
 *  Shares `@cotal-ai/workspace`'s `preflightTarget`/`pruneStaleMeshes` with the CLI, so a dead/mismatched entry gets
 *  the same one-sentence message + stale-prune the rest of the CLI gives — not a raw NATS trace. The
 *  pre-resolution sweep runs only for bare / `--server`-only resolution; an explicit `--space` is
 *  resolved + preflighted directly (so a `--server` override can recover a dead-recorded mesh).
 *  `ask()` can therefore trust the target is reachable + auth-valid. */
export async function resolveManagerTarget(v: Values): Promise<{ space: string; server: string; creds?: string }> {
  if (v.creds) {
    const server = v.server ?? DEFAULT_SERVER;
    const creds = readFileSync(v.creds, "utf8");
    await reachableOrExit(server, { creds });
    return { space: spaceFor(v), server, creds };
  }
  // A raw OPEN off-registry mesh: explicit `--server` + a `--space` that isn't registered. Naming
  // both is as deliberate as `--creds`, but an open broker has no creds to pass — connect bare,
  // off-registry (no registry lookup, no prune). Mirrors `connectOrExit`'s same-shaped escape hatch;
  // a registered `--space` still goes through the resolver below (which honors `--server` as override).
  if (v.server && v.space && !findMesh(v.space)) {
    await reachableOrExit(v.server, {});
    return { space: v.space, server: v.server, creds: undefined };
  }
  // Sweep dead entries before resolving ONLY when we must CHOOSE one (bare / `--server`-only). An
  // explicit `--space` names its target, so pre-pruning would erase a dead-recorded mesh that the
  // operator is recovering with a live `--server` override — resolve it and let preflight verify +
  // prune-on-dead (with the friendly message), honoring the override. Without `--space`, a dead
  // entry must not be offered, so the sweep stays.
  if (!v.space) await pruneStaleMeshes();
  let target: MeshTarget;
  try {
    target = resolveMeshTarget(process.cwd(), { server: v.server, space: v.space });
  } catch (e) {
    if (isWorkspaceTargetError(e)) {
      console.error(c.red(renderWorkspaceError({ kind: "target", error: e })));
      process.exit(1);
    }
    throw e;
  }
  const creds = target.auth ? await mintCreds(target.auth, newIdentity(), "manager") : undefined;
  await preflightOrExit(target, creds);
  return { space: target.space, server: target.server, creds };
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
      model: { type: "string" }, // start: model override, wins over the agent file's `model:`
      roster: { type: "string" },
      creds: { type: "string" },
      runtime: { type: "string" }, // supervise: force pty | tmux | cmux (default pty)
      "console-port": { type: "string" },
      drive: { type: "boolean" },
      transcript: { type: "boolean" },
      "no-transcript": { type: "boolean" },
      spawn: { type: "string" }, // comma-separated agent names to pre-spawn at startup
      launch: { type: "string" }, // supervise: a resolved mesh-manifest launch spec (cotal up -f / spawn -f)
    },
  });
  // These commands are flags-only — reject stray positionals instead of silently ignoring them
  // (e.g. `cotal supervise up`, fat-fingering `cotal up`).
  if (positionals.length) {
    const x = positionals[0];
    const hint = x === "up" ? " — did you mean `cotal up`?" : x === "go" ? " — did you mean `cotal go`?" : "";
    console.error(c.red(`✗ unexpected argument: ${x}${hint}`));
    process.exit(1);
  }
  return values as Values;
}

/** Connect a short-lived client with the resolved creds, send one control request to the manager,
 *  disconnect. The target is already reachability- + auth-preflighted by {@link resolveManagerTarget}
 *  (which prints the friendly message + prunes on failure), so this connects straight through. `tier`
 *  picks the control subject: privileged for spawn/ps; admin for the operator's cross-agent ops
 *  (stop/attach/purge), which the manager refuses on the privileged subject for a non-owner. `creds`
 *  is the privileged "manager" cred resolved by {@link resolveManagerTarget} (allow-all, so it
 *  reaches either subject), or undefined on an open mesh. */
async function ask(
  space: string,
  server: string,
  op: string,
  args?: Record<string, unknown>,
  creds?: string,
  tier: ControlTier = CONTROL_PRIVILEGED,
): Promise<ControlReply> {
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
    return await ep.requestControl(tier, { op, args });
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
  const t = await resolveManagerTarget(v);
  const reply = await ask(t.space, t.server, "start", {
    name: v.name,
    role: v.role,
    agent: v.agent,
    config: v.config,
    model: v.model,
    // Opt-in: only sent when `--transcript` is given; absent => the daemon's default (mirror off).
    transcript: v.transcript ? true : undefined,
  }, t.creds);
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
  // Operator stop is a cross-agent (admin) op — the CLI operator isn't the agent's spawner, so the
  // privileged subject would reject it; admin (its allow-all "manager" cred reaches it) is correct.
  const t = await resolveManagerTarget(v);
  const reply = await ask(t.space, t.server, "stop", {
    name: v.name,
  }, t.creds, CONTROL_ADMIN);
  failIfNotOk(reply);
  console.log(c.dim(`✓ stopped ${v.name}`));
}

async function ps(argv: string[]): Promise<void> {
  const v = parse(argv);
  const t = await resolveManagerTarget(v);
  const reply = await ask(t.space, t.server, "ps", undefined, t.creds);
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
  // Operator attach is a cross-agent (admin) op — same reasoning as stop (the operator isn't the
  // spawner; admin reaches any agent).
  const t = await resolveManagerTarget(v);
  const reply = await ask(t.space, t.server, "attach", {
    name: v.name,
  }, t.creds, CONTROL_ADMIN);
  failIfNotOk(reply);
  const { ws } = reply.data as { ws: string };
  console.error(c.dim(`attached to ${v.name} — Ctrl-] to detach`));
  await attachClient(ws);
  console.error(c.dim(`\ndetached from ${v.name}`));
}

/** Run a manager daemon in this process (the long-lived supervisor), then block.
 *  `pty` ships with the manager; `tmux` and `cmux` need their integration imported by
 *  the composition root (the `cotal` binary does). Stays alive until SIGINT/SIGTERM. */
// `--runtime` forces the manager runtime; honored only on the `supervise` path (default
// pty). `cmux` gives each teammate its own cmux tab — `cotal supervise --runtime cmux` is
// the cmux-tab manager. The session machinery launches it with `--runtime cmux --space <space>`
// contiguous, which is what `cmuxManagerRunning` pgreps for.
const RUNTIME_OVERRIDES: readonly RuntimeMode[] = ["pty", "tmux", "cmux"];

async function runManager(argv: string[], defaultRuntime: RuntimeMode): Promise<void> {
  const v = parse(argv);
  let runtime = defaultRuntime;
  if (defaultRuntime === "auto" && v.runtime) {
    if (!RUNTIME_OVERRIDES.includes(v.runtime as RuntimeMode)) {
      console.error(c.red(`unknown runtime "${v.runtime}" — expected ${RUNTIME_OVERRIDES.join(", ")}`));
      process.exit(1);
    }
    runtime = v.runtime as RuntimeMode;
  }
  const space = spaceFor(v);
  const server = v.server ?? DEFAULT_SERVER;
  // Parse the roster + launch spec before touching the network — a malformed file should fail fast,
  // before the manager comes up or any agent is spawned.
  const roster = v.roster ? loadRoster(v.roster) : [];
  const launchSpec = v.launch ? loadLaunchSpec(v.launch) : undefined;
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
      c.dim("\n  spawn: cotal start --name <persona>   ·   stop: cotal stop --name <n>   (Ctrl-C to shut down)"),
  );
  // Register shutdown handlers before any spawning, so a Ctrl-C during the (possibly slow,
  // staggered) boot tears the manager and its spawned teammates down rather than orphaning them.
  const shutdown = () => void mgr.stop().then(() => process.exit(0));
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  // Declarative boot: bring up each rostered agent through the same spawn path as `start`.
  // A failed entry is logged but non-fatal — healthy agents stay up and the operator can
  // fix the roster without the supervisor crash-looping.
  for (const entry of roster) {
    const reply = await mgr.startAgent(entry);
    // Log the spawned IDENTITY (the persona's name:), which can differ from entry.name (the file ref).
    const spawned = (reply.data as { name?: string } | undefined)?.name ?? entry.name;
    if (reply.ok) console.log(c.green(`✓ started ${c.bold(spawned)}`) + c.dim(` (${entry.agent})`));
    else console.error(c.red(`✗ ${entry.name}: ${reply.error}`));
  }
  // Pre-spawn teammates the manager owns (e.g. the demo's david/sven), so they're despawnable.
  // Stagger them: wait for each to register presence before launching the next, so several heavy
  // Claude cold-starts don't boot simultaneously and spike memory. The last one needs no wait.
  if (v.spawn) {
    const names = v.spawn.split(",").map((s) => s.trim()).filter(Boolean);
    for (let i = 0; i < names.length; i++) {
      const ref = names[i];
      const reply = await mgr.startByName(ref);
      if (!reply.ok) {
        console.error(c.red(`✗ couldn't spawn ${ref}: ${reply.error ?? "unknown error"}`));
        continue;
      }
      // The peer joins under its persona's name: (the spawned identity), which may differ from the
      // ref filename — wait on (and log) THAT, or staggering blocks the full timeout on a name that
      // never appears (e.g. ref review-critic → identity socrates).
      const spawned = (reply.data as { name?: string } | undefined)?.name ?? ref;
      console.log(c.green(`✓ spawned ${spawned}`));
      if (i < names.length - 1) {
        const joined = await mgr.waitForPresence(spawned);
        console.log(c.dim(joined ? `  ${spawned} joined; starting next` : `  ${spawned} still starting; continuing`));
      }
    }
  }
  // Declarative manifest boot (`cotal up -f` / `spawn -f`): materialize each resolved agent's
  // transient persona, then spawn it with its resolved ACLs/identity. Staggered like `--spawn` so
  // heavy cold-starts don't pile up. A failed entry is logged, non-fatal — healthy agents stay up.
  if (launchSpec) {
    const root = findCotalRoot();
    for (let i = 0; i < launchSpec.agents.length; i++) {
      const la = launchSpec.agents[i];
      let configPath: string;
      try {
        configPath = materializePersona(root, launchSpec.runId, la);
      } catch (e) {
        console.error(c.red(`✗ ${la.name}: ${(e as Error).message}`));
        continue;
      }
      const reply = await mgr.startAgent(launchAgentToStartOpts(la, configPath));
      if (!reply.ok) {
        console.error(c.red(`✗ ${la.name}: ${reply.error}`));
        continue;
      }
      const spawned = (reply.data as { name?: string } | undefined)?.name ?? la.name;
      console.log(c.green(`✓ launched ${spawned}`) + c.dim(` (${la.agent})`));
      if (i < launchSpec.agents.length - 1) {
        const joined = await mgr.waitForPresence(spawned);
        console.log(c.dim(joined ? `  ${spawned} joined; starting next` : `  ${spawned} still starting; continuing`));
      }
    }
  }
  await new Promise<void>(() => {});
}

/** The manager's control-plane commands — the `supervise` daemon runner plus thin NATS
 *  request/reply clients that drive a running manager. Self-registered on import; the `cotal`
 *  binary resolves them from the registry. */
const managerCommands: Command[] = [
  {
    kind: "command",
    name: "supervise",
    group: "Manager",
    summary:
      "run a manager — [--runtime <pty|tmux|cmux>] (default pty; tmux/cmux are explicit-only, each teammate in its own window/tab) [--space <s>] [--server <url>] [--console-port <n>] [--roster <file>] [--launch <spec>]",
    run: (argv) => runManager(argv, "auto"),
  },
  {
    kind: "command",
    name: "start",
    group: "Control plane",
    summary:
      "ask the manager to spawn a persona — --name <persona> [--role <r>] [--agent <a>] [--config <file>] [--model <m>] (loads .cotal/agents/<persona>.md; the peer joins under its name:)",
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
