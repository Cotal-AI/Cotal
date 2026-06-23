/**
 * Composition root for example 02 — the self-improving console demo.
 *
 * Runs a manager that spawns teammates via `run-agent.sh <role>` (a real Claude
 * Code coder cd'd into its part of the repo, wired to the cotal MCP server/hooks).
 * Registered as "cotal" so the orchestrator's `cotal_spawn(name, role)` routes here.
 *
 * Runtime is env-selected:
 *   COTAL_RUNTIME=cmux  (default) → a cmux tab per teammate (the on-stage demo)
 *   COTAL_RUNTIME=pty             → headless PTY (the overnight harness); the PTY
 *                                   runtime auto-accepts claude's dev-channels prompt
 *                                   via the `confirm` string below.
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
import "@cotal-ai/cmux"; // registers the cmux runtime (default here); harmless under COTAL_RUNTIME=pty
import { fileURLToPath } from "node:url";

const RUN_AGENT = fileURLToPath(new URL("../run-agent.sh", import.meta.url));

const roleAgentConnector: Connector = {
  kind: "connector",
  name: "cotal",
  buildLaunch: (opts: LaunchOpts): LaunchSpec => {
    // Claude agents via run-agent.sh; `confirm` lets the PTY runtime auto-accept dev-channels.
    return { command: RUN_AGENT, args: [opts.role ?? opts.name], confirm: "Enter to confirm", env: launchEnv() };
  },
};
registry.register(roleAgentConnector);

const space = process.env.COTAL_SPACE?.trim() || "console";
const server = process.env.COTAL_SERVERS?.trim() || DEFAULT_SERVER;
const runtime = (process.env.COTAL_RUNTIME?.trim() as "cmux" | "pty" | "tmux") || "cmux";

if (!(await isReachable(server))) {
  console.error(`Can't reach NATS at ${server}. Run: pnpm cotal up`);
  process.exit(1);
}

const mgr = new Manager({ space, servers: server, runtime });
await mgr.start();
console.log(`example-02 manager up in space "${space}" — runtime: ${runtime}`);

process.on("SIGINT", () => void mgr.stop().then(() => process.exit(0)));
process.on("SIGTERM", () => void mgr.stop().then(() => process.exit(0)));
await new Promise<void>(() => {});
