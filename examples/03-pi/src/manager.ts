/**
 * Composition root for example 03 (pi coding agent). Runs a manager that spawns
 * pi peers into the space. Each spawn is a real pi agent session
 * (extensions/pi) that embeds a Cotal endpoint and answers DMs, anycasts, and
 * @-mentions on channels — waking an idle session with prompt() and folding
 * same-scope traffic into a live turn with steer(). Importing the connector
 * self-registers it as "pi"; we also alias it under "cotal" so a bare
 * `cotal start --name x` (the default agent type) spawns one too.
 */
import { DEFAULT_SERVER, isReachable, registry, type Connector } from "@cotal-ai/core";
import { Manager } from "@cotal-ai/manager";
import { piConnector } from "@cotal-ai/pi"; // self-registers "pi"

const cotalAlias: Connector = {
  kind: "connector",
  name: "cotal",
  buildLaunch: piConnector.buildLaunch,
};
registry.register(cotalAlias);

const space = process.env.COTAL_SPACE?.trim() || "demo";
const server = process.env.COTAL_SERVERS?.trim() || DEFAULT_SERVER;

if (!(await isReachable(server))) {
  console.error(`Can't reach NATS at ${server}. Run: pnpm cotal up`);
  process.exit(1);
}

const mgr = new Manager({ space, servers: server });
await mgr.start();
console.log(`example-03-pi manager up in space "${space}" — connectors: pi, cotal`);
console.log(`console: ${mgr.consoleUrl}`);

process.on("SIGINT", () => void mgr.stop().then(() => process.exit(0)));
process.on("SIGTERM", () => void mgr.stop().then(() => process.exit(0)));
await new Promise<void>(() => {});
