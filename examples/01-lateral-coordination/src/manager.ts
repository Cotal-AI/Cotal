/**
 * Composition root for Demo 1's manager daemon. It picks which connectors this
 * demo can spawn: the built-in `cotal` CLI peer (defined + registered here) plus
 * the Claude Code connector (self-registers when `@cotal-ai/connector-claude-code` is imported).
 * The manager resolves them from the registry — it never sees this list directly.
 */
import {
  DEFAULT_SERVER,
  isReachable,
  registry,
  type Connector,
  type LaunchOpts,
  type LaunchSpec,
} from "@cotal-ai/core";
import { Manager } from "@cotal-ai/manager";
import { launchEnv } from "@cotal-ai/connector-core";
import { claudeConnector } from "@cotal-ai/connector-claude-code";

/** The walking-skeleton peer: a manual CLI endpoint launched via `cotal join`. */
const cotalConnector: Connector = {
  kind: "connector",
  name: "cotal",
  buildLaunch(opts: LaunchOpts): LaunchSpec {
    const args = ["cotal", "join", "--space", opts.space, "--name", opts.name];
    if (opts.role) args.push("--role", opts.role);
    if (opts.servers) args.push("--server", opts.servers);
    return { command: "pnpm", args, env: launchEnv() };
  },
};
registry.register(cotalConnector, claudeConnector);

const space = process.env.COTAL_SPACE?.trim() || "demo";
const server = process.env.COTAL_SERVERS?.trim() || DEFAULT_SERVER;
const consolePort = Number(process.env.COTAL_CONSOLE_PORT) || 7878;
// Spawn backend: default `auto` (pty), or `cmux`/`tmux` via env (a tab/pane per teammate).
const runtime = process.env.COTAL_RUNTIME?.trim() as "pty" | "tmux" | "cmux" | "auto" | undefined;

if (!(await isReachable(server))) {
  console.error(`Can't reach NATS at ${server}. Run: pnpm cotal up`);
  process.exit(1);
}

const mgr = new Manager({ space, servers: server, consolePort, runtime });
await mgr.start();
console.log(`example-01 manager up in space "${space}" — runtime: ${mgr.runtimeKind} — connectors: cotal, claude`);
console.log(`console: ${mgr.consoleUrl}`);

process.on("SIGINT", () => void mgr.stop().then(() => process.exit(0)));
process.on("SIGTERM", () => void mgr.stop().then(() => process.exit(0)));
await new Promise<void>(() => {});
