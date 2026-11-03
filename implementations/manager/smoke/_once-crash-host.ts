// One manager process for spawn-once-restart.smoke.ts: it starts the manager, prints
// REPRO_MANAGER, and waits to be SIGKILLed, which is the crash the suite grades. The suite spawns
// the seats over the manager's own spawn command, so the suite is their spawner.
import { appendFileSync, existsSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Manager } from "../src/manager.js";
import { evictDeniedPrincipalWithCreds, registry, type Connector, type EvictionResult, type LaunchOpts, type LaunchSpec } from "@cotal-ai/core";

const root = process.env.REPRO_ROOT!;
const space = process.env.REPRO_SPACE!;
const servers = process.env.REPRO_SERVERS!;
const here = dirname(fileURLToPath(import.meta.url));
const stub = join(here, "e2e-stub.mjs");
const envFor = (o: LaunchOpts): Record<string, string> => ({ COTAL_SPACE: o.space, COTAL_SERVERS: String(o.servers ?? servers), COTAL_CREDS: String(o.creds), COTAL_ID: String(o.id), COTAL_NAME: o.name, COTAL_LIFECYCLE_UID: String(o.lifecycleUid), PATH: process.env.PATH ?? "" });
// The space and the seat name ride argv so the suite can find each seat by its command line.
// Its retireAfterExit stands in for a connector whose seat launches processes of its own: each call
// and each discard is logged with the manager process that made it, which the suite reads back.
const retireLog = (entry: Record<string, unknown>) => appendFileSync(join(root, "retire.log"), `${JSON.stringify({ ...entry, manager: process.pid })}\n`);
registry.register({
  kind: "connector", name: "once-crash-stub", requires: ["node"], supportsPrompt: true, supportsTurnRelay: true,
  buildLaunch: (o): LaunchSpec => ({ command: process.execPath, args: [stub, space, o.name], env: envFor(o) }),
  async retireAfterExit(seat) {
    retireLog({ retire: seat.lifecycleUid, name: seat.name });
    return { discard: async () => retireLog({ discard: seat.lifecycleUid }) };
  },
} as Connector);
const manager = new Manager({ space, servers, runtime: "pty", workspaceRoot: root, consolePort: 0 });
(manager as unknown as { staticLifecycleEvict?: (principal: string) => Promise<EvictionResult> }).staticLifecycleEvict =
  (principal) => evictDeniedPrincipalWithCreds({
    servers,
    observerCreds: process.env.REPRO_OBSERVER_CREDS!,
    evictorCreds: process.env.REPRO_EVICTOR_CREDS!,
    accountId: process.env.REPRO_ACCOUNT_ID!,
    principal,
    options: { maxVerifyRounds: 12 },
  });
await manager.start();
// Armed by the suite with a marker file: the manager dies at its next checkpoint write, the deadline
// hold a once task mints after its goal and index entry exist and before its seat launches.
const kv = (manager as unknown as { goalWriter: { ctx: { kv: { put: (key: string, ...rest: unknown[]) => Promise<unknown> } } } }).goalWriter.ctx.kv;
const put = kv.put.bind(kv);
const crashMarker = join(root, "crash-at-hold");
kv.put = async (key, ...rest) => {
  if (key.startsWith("cp.") && existsSync(crashMarker)) { rmSync(crashMarker); process.kill(process.pid, "SIGKILL"); }
  return put(key, ...rest);
};
// Armed with another marker file: the manager dies at a spawn's `presence` progress, the step right
// before its succeeded terminal is written, so the seat joined and its task was never served.
const progress = manager as unknown as { emitGoalProgress(ref: unknown, epoch: number, event: { phase?: string }): void };
const emit = progress.emitGoalProgress.bind(manager);
const successMarker = join(root, "crash-at-success");
progress.emitGoalProgress = (ref, epoch, event) => {
  if (event.phase === "presence" && existsSync(successMarker)) { rmSync(successMarker); process.kill(process.pid, "SIGKILL"); }
  emit(ref, epoch, event);
};
const managerInstanceId = (manager as unknown as { managerInstanceId: string }).managerInstanceId;
process.stdout.write(`REPRO_MANAGER ${JSON.stringify({ managerPid: process.pid, managerInstanceId })}\n`);
await new Promise<void>(() => {});
