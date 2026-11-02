// One open-mesh manager process for spawn-once-unheld.smoke.ts: it starts the manager, prints
// REPRO_MANAGER, and waits to be SIGKILLed. An open-mesh manager adopts no seats, so a successor
// holds none of the seats an earlier one started.
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Manager } from "../src/manager.js";
import { registry, type Connector, type LaunchOpts, type LaunchSpec } from "@cotal-ai/core";

const root = process.env.REPRO_ROOT!;
const space = process.env.REPRO_SPACE!;
const servers = process.env.REPRO_SERVERS!;
const here = dirname(fileURLToPath(import.meta.url));
const seat = join(here, "_once-unheld-seat.cjs");
const coreDist = resolve(here, "../../../packages/core/dist/index.js");
const envFor = (o: LaunchOpts): Record<string, string> => ({ COTAL_SPACE: o.space, COTAL_SERVERS: String(o.servers ?? servers), COTAL_ID: String(o.id), COTAL_NAME: o.name, COTAL_LIFECYCLE_UID: String(o.lifecycleUid), CORE_DIST: coreDist, PATH: process.env.PATH ?? "" });
registry.register({
  kind: "connector", name: "once-unheld-stub", requires: ["node"], supportsPrompt: true, supportsTurnRelay: true,
  buildLaunch: (o): LaunchSpec => ({ command: process.execPath, args: [seat, space, o.name], env: envFor(o) }),
} as Connector);
const manager = new Manager({ space, servers, runtime: "pty", workspaceRoot: root, consolePort: 0 });
(manager as unknown as { readinessTimeoutMs: number }).readinessTimeoutMs = Number(process.env.REPRO_READINESS_MS);
await manager.start();
const managerInstanceId = (manager as unknown as { managerInstanceId: string }).managerInstanceId;
process.stdout.write(`REPRO_MANAGER ${JSON.stringify({ managerPid: process.pid, managerInstanceId })}\n`);
await new Promise<void>(() => {});
