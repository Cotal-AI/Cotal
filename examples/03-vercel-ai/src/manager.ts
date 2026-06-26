/**
 * Composition root for example 03 (Vercel AI SDK). Runs a manager that spawns
 * Vercel-AI-SDK peers into the space. Each spawn is a real agent loop
 * (extensions/vercel-ai) that embeds a Cotal endpoint and answers DMs, anycasts,
 * and @-mentions on channels via generateText + tool calls. Importing the connector
 * self-registers it as "vercel-ai"; we also alias it under "cotal" so a bare
 * `cotal start --name x` (the default agent type) spawns one too.
 */
import { DEFAULT_SERVER, isReachable, registry, type Connector } from "@cotal-ai/core";
import { Manager } from "@cotal-ai/manager";
import { vercelAiConnector } from "@cotal-ai/vercel-ai"; // self-registers "vercel-ai"

const cotalAlias: Connector = {
  kind: "connector",
  name: "cotal",
  buildLaunch: vercelAiConnector.buildLaunch,
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
console.log(`example-03-vercel-ai manager up in space "${space}" — connectors: vercel-ai, cotal`);
console.log(`console: ${mgr.consoleUrl}`);

process.on("SIGINT", () => void mgr.stop().then(() => process.exit(0)));
process.on("SIGTERM", () => void mgr.stop().then(() => process.exit(0)));
await new Promise<void>(() => {});
