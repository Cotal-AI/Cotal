// The manager host for orphan-seat-reap.smoke.ts: a real Manager on the production custodial pty
// runtime (COTAL_SEAT_ROOT points every host of one run at the same custody root), spawning the
// lifecycle e2e stub through a pty so the seat is a real custodian + child pair. Prints the seat's
// custody reference so the suite can read the record and watch both pids.
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, writeFileSync } from "node:fs";
import { Manager, type SpawnHooks } from "../src/manager.js";
import { evictDeniedPrincipalWithCreds, registry, type AgentHandle, type Connector, type EvictionResult, type LaunchOpts, type LaunchSpec, type Runtime } from "@cotal-ai/core";

const root = process.env.REPRO_ROOT!;
const space = process.env.REPRO_SPACE!;
const servers = process.env.REPRO_SERVERS!;
const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../../..");
const stub = join(here, "e2e-stub.mjs");
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const envFor = (o: LaunchOpts): Record<string, string> => ({ PATH: process.env.PATH ?? "", COTAL_SPACE: o.space, COTAL_SERVERS: String(o.servers ?? servers), COTAL_CREDS: String(o.creds), COTAL_ID: String(o.id), COTAL_NAME: o.name, COTAL_LIFECYCLE_UID: String(o.lifecycleUid) });
registry.register({ kind: "connector", name: "orphan-reap-repro", requires: ["node"], buildLaunch: (o): LaunchSpec => ({ command: process.execPath, args: [stub], env: envFor(o) }) } as Connector);
const alias = process.env.REPRO_ALIAS ?? "worker";
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
// Freeze this manager INSIDE runtime.spawn, after the seat processes exist and before startAgent
// reaches the slot activation CAS. That window is unschedulable from outside the process, and it is
// the one the reservation exists for: everything up to the hang is production code, and the suite
// SIGKILLs from here. The reserved reference is forwarded so the runtime custodies the seat under
// exactly the id the manager already recorded.
if (process.env.REPRO_HANG_AFTER_SPAWN === "1") {
  const runtime = (manager as unknown as { runtime: Runtime }).runtime;
  const spawnSeat = runtime.spawn.bind(runtime);
  runtime.spawn = (name, spec, cwd, reference) => {
    const handle = spawnSeat(name, spec, cwd, reference);
    writeFileSync(process.env.REPRO_MARKER!, `${JSON.stringify({ managerPid: process.pid, seatPid: handle.pid, reference: handle.reference })}\n`);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
    return handle;
  };
}
// A spawn that LAUNCHED its seat and then threw, inside the manager that launched it. `onLaunched`
// is the production callback the spawn-as-action seam already passes, and it fires between the
// launch and the slot activation CAS below it: the window where the handle lives only in a local,
// so the rollback can address the seat only through the reference the spawn reserved. The hook
// parks the manager there until the suite has seen both seat processes live, so a reap observed
// afterwards cannot be a seat that never started.
const hooks: SpawnHooks | undefined = process.env.REPRO_THROW_AFTER_LAUNCH === "1"
  ? {
      onLaunched: () => {
        const marker = process.env.REPRO_MARKER!;
        writeFileSync(marker, `${JSON.stringify({ managerPid: process.pid })}\n`);
        for (let i = 0; i < 600 && !existsSync(`${marker}.go`); i++) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
        throw new Error("the spawn threw after the seat launched");
      },
    }
  : undefined;
await manager.start();
const managerInstanceId = (manager as unknown as { managerInstanceId: string }).managerInstanceId;
process.stdout.write(`REPRO_MANAGER ${JSON.stringify({ managerPid: process.pid, managerInstanceId })}\n`);
if (process.env.REPRO_SPAWN === "1") {
  let reply = await manager.startAgent({ name: alias, agent: "orphan-reap-repro", cwd: repo }, undefined, hooks);
  for (let i = 0; !reply.ok && /reconcil|terminal|standing slot|held/i.test(reply.error ?? "") && i < 320; i++) { await wait(250); reply = await manager.startAgent({ name: alias, agent: "orphan-reap-repro", cwd: repo }, undefined, hooks); }
  if (!reply.ok) {
    process.stdout.write(`REPRO_SPAWN ${JSON.stringify({ managerPid: process.pid, managerInstanceId, reply })}\n`);
    await new Promise<void>(() => {});
  }
  const managed = (manager as unknown as { agents: Map<string, { id: string; lifecycleUid: string; handle: AgentHandle }> }).agents.get(alias);
  if (!managed) await new Promise<void>(() => {});
  process.stdout.write(`REPRO_READY ${JSON.stringify({ managerPid: process.pid, managerInstanceId, seatPid: managed!.handle.pid, reference: managed!.handle.reference, actor: managed!.id, lifecycleUid: managed!.lifecycleUid })}\n`);
}
await new Promise<void>(() => {});
