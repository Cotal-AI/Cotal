import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Manager } from "../src/manager.js";
import { evictDeniedPrincipalWithCreds, registry, type AgentHandle, type AttachSession, type Connector, type EvictionResult, type LaunchOpts, type LaunchSpec, type Runtime } from "@cotal-ai/core";

const root = process.env.REPRO_ROOT!;
const space = process.env.REPRO_SPACE!;
const servers = process.env.REPRO_SERVERS!;
const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../../..");
const stub = join(here, "e2e-stub.mjs");
const wrapper = join(here, "_orphan-seat-wrapper.mjs");
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };
const envFor = (o: LaunchOpts): Record<string, string> => ({ COTAL_SPACE: o.space, COTAL_SERVERS: String(o.servers ?? servers), COTAL_CREDS: String(o.creds), COTAL_ID: String(o.id), COTAL_NAME: o.name, COTAL_LIFECYCLE_UID: String(o.lifecycleUid), COTAL_E2E_SURVIVE_DISCONNECT: "1", PATH: process.env.PATH ?? "" });
registry.register({ kind: "connector", name: "orphan-repro", requires: ["node"], buildLaunch: (o): LaunchSpec => ({ command: process.execPath, args: [wrapper, stub], env: envFor(o) }) } as Connector);
const session: AttachSession = { cols: 80, rows: 24, backlog: () => Buffer.alloc(0), onData: () => () => {}, onExit: () => () => {}, write: () => {}, resize: () => {} };
class DetachedRuntime implements Runtime {
  readonly kind = "orphan-repro";
  spawn(name: string, spec: LaunchSpec, cwd: string): AgentHandle {
    const child = spawn(spec.command, spec.args, { cwd, env: spec.env, detached: true, stdio: "ignore" });
    const pid = child.pid!; child.unref();
    return { name, kind: this.kind, pid, status: () => alive(pid) ? "running" : "exited", stop: () => { try { process.kill(-pid, "SIGKILL"); } catch { try { process.kill(pid, "SIGKILL"); } catch {} } }, waitForExit: async () => { for (let i = 0; i < 100 && alive(pid); i++) await wait(50); if (alive(pid)) throw new Error(`seat ${pid} survived stop`); }, interrupt: () => {}, attach: () => session };
  }
}
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
(manager as unknown as { runtime: Runtime }).runtime = new DetachedRuntime();
let reply = await manager.startAgent({ name: "worker", agent: "orphan-repro", cwd: repo });
for (let i = 0; !reply.ok && /reconcil|terminal|standing slot|held/i.test(reply.error ?? "") && i < 320; i++) { await wait(250); reply = await manager.startAgent({ name: "worker", agent: "orphan-repro", cwd: repo }); }
if (!reply.ok) {
  process.stdout.write(`REPRO_SPAWN ${JSON.stringify({ managerPid: process.pid, managerInstanceId, reply, managedNames: [...(manager as unknown as { agents: Map<string, unknown> }).agents.keys()] })}\n`);
  await new Promise<void>(() => {});
}
const managed = (manager as unknown as { agents: Map<string, { id: string; lifecycleUid: string; handle: AgentHandle }> }).agents.get("worker");
if (!managed) await new Promise<void>(() => {});
process.stdout.write(`REPRO_READY ${JSON.stringify({ managerPid: process.pid, managerInstanceId, seatPid: managed!.handle.pid, actor: managed!.id, lifecycleUid: managed!.lifecycleUid })}\n`);
await new Promise<void>(() => {});
