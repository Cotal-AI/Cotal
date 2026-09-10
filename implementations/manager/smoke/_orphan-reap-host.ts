// The manager host for orphan-seat-reap.smoke.ts: a real Manager on the production custodial pty
// runtime (COTAL_SEAT_ROOT points every host of one run at the same custody root), spawning the
// lifecycle e2e stub through a pty so the seat is a real custodian + child pair. Prints the seat's
// custody reference so the suite can read the record and watch both pids.
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Manager } from "../src/manager.js";
import { evictDeniedPrincipalWithCreds, registry, type AgentHandle, type Connector, type EvictionResult, type LaunchOpts, type LaunchSpec } from "@cotal-ai/core";

const root = process.env.REPRO_ROOT!;
const space = process.env.REPRO_SPACE!;
const servers = process.env.REPRO_SERVERS!;
const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../../..");
const stub = join(here, "e2e-stub.mjs");
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const envFor = (o: LaunchOpts): Record<string, string> => ({ PATH: process.env.PATH ?? "", COTAL_SPACE: o.space, COTAL_SERVERS: String(o.servers ?? servers), COTAL_CREDS: String(o.creds), COTAL_ID: String(o.id), COTAL_NAME: o.name, COTAL_LIFECYCLE_UID: String(o.lifecycleUid) });
registry.register({ kind: "connector", name: "orphan-reap-repro", requires: ["node"], buildLaunch: (o): LaunchSpec => ({ command: process.execPath, args: [stub], env: envFor(o) }) } as Connector);
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
const managerInstanceId = (manager as unknown as { managerInstanceId: string }).managerInstanceId;
process.stdout.write(`REPRO_MANAGER ${JSON.stringify({ managerPid: process.pid, managerInstanceId })}\n`);
if (process.env.REPRO_SPAWN === "1") {
  let reply = await manager.startAgent({ name: "worker", agent: "orphan-reap-repro", cwd: repo });
  for (let i = 0; !reply.ok && /reconcil|terminal|standing slot|held/i.test(reply.error ?? "") && i < 320; i++) { await wait(250); reply = await manager.startAgent({ name: "worker", agent: "orphan-reap-repro", cwd: repo }); }
  if (!reply.ok) {
    process.stdout.write(`REPRO_SPAWN ${JSON.stringify({ managerPid: process.pid, managerInstanceId, reply })}\n`);
    await new Promise<void>(() => {});
  }
  const managed = (manager as unknown as { agents: Map<string, { id: string; lifecycleUid: string; handle: AgentHandle }> }).agents.get("worker");
  if (!managed) await new Promise<void>(() => {});
  process.stdout.write(`REPRO_READY ${JSON.stringify({ managerPid: process.pid, managerInstanceId, seatPid: managed!.handle.pid, reference: managed!.handle.reference, actor: managed!.id, lifecycleUid: managed!.lifecycleUid })}\n`);
}
await new Promise<void>(() => {});
