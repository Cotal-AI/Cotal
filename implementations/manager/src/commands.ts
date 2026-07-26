import {
  isReachable,
  DEFAULT_SERVER,
  DEFAULT_SPACE,
  registry,
  type Command,
  type ParsedArgs,
} from "@cotal-ai/core";
import { authDir, findCotalRoot, soleSpaceOf } from "@cotal-ai/workspace";
import { Manager } from "./manager.js";
import { loadRoster } from "./roster.js";
import { loadLaunchSpec, materializePersona, launchAgentToStartOpts } from "./launch.js";
import { type RuntimeMode } from "./runtime/index.js";
import { c } from "./ui.js";

type Values = Record<string, string | undefined>;

/** The space to operate on: explicit `--space`, else this folder's `.cotal/auth` space, else the
 *  default — so a manually-run manager matches the folder's mesh instead of assuming the default. */
function spaceFor(v: Values): string {
  return v.space ?? soleSpaceOf(authDir(findCotalRoot())) ?? DEFAULT_SPACE;
}

/** Run a manager daemon in this process (the long-lived supervisor), then block.
 *  `pty` ships with the manager; every other runtime needs a registered provider. The published
 *  CLI lazy-loads installed providers, while library roots import their integrations explicitly.
 *
 *  The operator CLIENTS of this daemon — detached launch (`cotal spawn --detach`), `stop`, `ps`,
 *  `attach` — live in `@cotal-ai/cli` since stage 2a of the CLI rework: they are thin control-plane
 *  request/reply commands, not daemon code. This package registers only the daemon runner. */
// `--runtime` forces the manager runtime; honored only on the `supervise` path (default
// pty). `cmux` gives each teammate its own cmux tab — `cotal supervise --runtime cmux` is
// the cmux-tab manager.
async function runManager(args: ParsedArgs, defaultRuntime: RuntimeMode): Promise<void> {
  const v = args.values as Values;
  let runtime = defaultRuntime;
  if (defaultRuntime === "auto" && v.runtime) {
    runtime = v.runtime as RuntimeMode;
  }
  const space = spaceFor(v);
  const server = v.server ?? DEFAULT_SERVER;
  // Parse the roster + launch spec before touching the network — a malformed file should fail fast,
  // before the manager comes up or any agent is spawned.
  const roster = v.roster ? loadRoster(v.roster) : [];
  const launchSpec = v.launch ? loadLaunchSpec(v.launch) : undefined;
  if (v["resume-attempt"] && (v.roster || v.launch || v.spawn)) {
    console.error(c.red("✗ --resume-attempt cannot be combined with --roster, --launch, or --spawn; retained agents resume only through the attempt-bound admin control op"));
    process.exit(1);
  }
  if (v["resume-commit-token"] && !v["resume-attempt"]) {
    console.error(c.red("✗ --resume-commit-token requires --resume-attempt"));
    process.exit(1);
  }
  if (!(await isReachable(server))) {
    console.error(c.red(`Can't reach NATS at ${server}. Run: cotal up`));
    process.exit(1);
  }
  const consolePort = v["console-port"] ? Number(v["console-port"]) : undefined;
  // Where the console/attach face binds. Absent → loopback, so a bare `cotal supervise` keeps a
  // machine-local endpoint. `cotal up` passes the address it bound the broker to when that address
  // is reachable, which is what lets `cotal attach` reach this manager from another machine.
  const attachHost = v["console-host"];
  // Construction resolves the runtime (createRuntime) — which fails loud on an unusable env, e.g. the
  // pty runtime under Bun. Render that as one actionable line, not a raw stack (this also lands in
  // `.cotal/manager.log` for a detached `cotal up` daemon).
  let mgr: Manager;
  try {
    // The published-binary supervisor resolves connectors from the operator manifest (seeded +
    // `ext add`ed), NOT from static imports — `bin/cotal.ts` no longer registers any. A direct
    // library `Manager` keeps the registry-only default (opt-in preserved).
    mgr = new Manager({
      space,
      servers: server,
      runtime,
      consolePort,
      attachHost,
      installedExtensions: true,
      resumeAttemptId: v["resume-attempt"],
      resumeDurableCommitToken: v["resume-commit-token"],
    });
  } catch (e) {
    console.error(c.red(`✗ ${(e as Error).message}`));
    process.exit(1);
  }
  await mgr.start();
  console.log(
    c.green("✓ manager up") +
      c.dim(` (space ${space} · ${mgr.runtimeKind})`) +
      `\n  console: ${mgr.consoleUrl}` +
      c.dim("\n  spawn: cotal spawn --detach <persona>   ·   stop: cotal stop --name <n>   (Ctrl-C to shut down)"),
  );
  // Register shutdown handlers before any spawning, so a Ctrl-C during the (possibly slow,
  // staggered) boot tears the manager and its spawned teammates down rather than orphaning them.
  const shutdown = () => void mgr.stop()
    .then(() => process.exit(0))
    .catch((e) => {
      process.exitCode = 1;
      console.error(c.red(`✗ ${(e as Error).message}`));
    });
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  // Declarative boot: bring up each rostered agent through the same spawn path as a detached spawn.
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
      const reply = await mgr.startAgent(launchAgentToStartOpts(la, configPath, launchSpec.owner, launchSpec.runId));
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

/** The manager's one command: the `supervise` daemon runner. Self-registered on import; the
 *  `cotal` binary resolves it from the registry. */
const managerCommands: Command[] = [
  {
    kind: "command",
    name: "supervise",
    group: "Manager",
    summary:
      "run a manager - [--runtime <name>] (default pty; extension runtimes are explicit-only) [--space <s>] [--server <url>] [--console-port <n>] [--roster <file>] [--launch <spec>] [--resume-attempt <id>]",
    flags: [
      { name: "space", type: "string", value: "<s>", description: "space to supervise (default: this folder's auth space)" },
      { name: "server", type: "string", value: "<url>", description: "broker URL (default: the local mesh)" },
      { name: "runtime", type: "string", value: "<name>", description: "agent runtime (default pty; others come from installed extensions)" },
      { name: "console-port", type: "string", value: "<n>", description: "protocol-console port" },
      { name: "console-host", type: "string", value: "<host>", description: "bind host for the console + attach endpoint (default: loopback)" },
      { name: "roster", type: "string", value: "<file>", description: "declarative roster to boot at startup" },
      { name: "launch", type: "string", value: "<spec>", description: "resolved mesh-manifest launch spec (cotal up -f / spawn -f)" },
      { name: "resume-attempt", type: "string", value: "<id>", description: "maintenance restore attempt accepted by resumePreserved" },
      { name: "resume-commit-token", type: "string", value: "<token>", description: "durable resume commit evidence for crash recovery" },
      { name: "spawn", type: "string", value: "<names>", description: "comma-separated personas to pre-spawn at startup" },
    ],
    requiredExtensions: (args) => {
      const runtime = args.values.runtime;
      return typeof runtime === "string" && runtime !== "pty" ? [{ kind: "runtime", name: runtime }] : [];
    },
    run: (args) => runManager(args, "auto"),
  },
];

registry.register(...managerCommands);
