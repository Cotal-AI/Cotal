// One tmux-runtime manager process for tmux-adopt-manager-crash.smoke.ts: it starts the manager,
// prints REPRO_MANAGER, and waits to be SIGKILLed, which is the crash the suite grades. The suite
// spawns seats over the manager's own spawn command, so the suite is their spawner.
import "@cotal-ai/tmux"; // registers the `tmux` runtime provider
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Manager } from "../src/manager.js";
import { evictDeniedPrincipalWithCreds, registry, type Connector, type EvictionResult, type LaunchOpts, type LaunchSpec } from "@cotal-ai/core";
import { aclEnv } from "@cotal-ai/connector-core";

const root = process.env.REPRO_ROOT!;
const space = process.env.REPRO_SPACE!;
const servers = process.env.REPRO_SERVERS!;
const here = dirname(fileURLToPath(import.meta.url));
const stub = join(here, "e2e-stub.mjs");
// The stub seat gets the endpoint list the way a real connector writes it, so a suite can read the
// value the session received.
const envFor = (o: LaunchOpts): Record<string, string> => ({ COTAL_SPACE: o.space, COTAL_SERVERS: String(o.servers ?? servers), COTAL_CREDS: String(o.creds), COTAL_ID: String(o.id), COTAL_NAME: o.name, COTAL_LIFECYCLE_UID: String(o.lifecycleUid), ...aclEnv({ endpoints: o.endpoints }), PATH: process.env.PATH ?? "" });
registry.register({ kind: "connector", name: "tmux-adopt-stub", requires: ["node"], buildLaunch: (o): LaunchSpec => ({ command: process.execPath, args: [stub, space], env: envFor(o) }) } as Connector);
const manager = new Manager({ space, servers, runtime: "tmux", workspaceRoot: root, consolePort: 0 });
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
// A suite that grades a renewal sets REPRO_RENEW_ON_STDIN and writes `RENEW <name>` on stdin. The
// host runs the manager's own renewal of that seat, the one its renewal timer calls, and answers
// `REPRO_RENEWED <name> ok` or the error.
if (process.env.REPRO_RENEW_ON_STDIN === "1") {
  const { createInterface } = await import("node:readline");
  const m = manager as unknown as { agents: Map<string, unknown>; renewManagedStaticCred: (a: unknown) => Promise<void> };
  createInterface({ input: process.stdin }).on("line", (line) => {
    const name = /^RENEW (\S+)$/.exec(line)?.[1];
    if (name === undefined) return;
    const seat = m.agents.get(name);
    void (seat ? m.renewManagedStaticCred(seat) : Promise.reject(new Error(`no seat named ${name}`))).then(
      () => process.stdout.write(`REPRO_RENEWED ${name} ok\n`),
      (e: unknown) => process.stdout.write(`REPRO_RENEWED ${name} ${JSON.stringify(String((e as Error).message))}\n`),
    );
  });
}
const managerInstanceId = (manager as unknown as { managerInstanceId: string }).managerInstanceId;
process.stdout.write(`REPRO_MANAGER ${JSON.stringify({ managerPid: process.pid, managerInstanceId })}\n`);
await new Promise<void>(() => {});
