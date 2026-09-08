/**
 * A partial `cotal down --with-agents` reap reports the seats it stopped separately from the seats
 * still running. The old renderer said "no seats were reaped" whenever any one stop failed, even
 * after an earlier seat had stopped successfully.
 *
 * Representative: a real open NATS broker, a real Manager endpoint, the real generic control rail,
 * and the real `down()` command. Only the two runtime handles are fakes, so one exit can be proven
 * while the other reports a failed proof deterministically.
 *
 * Run: pnpm smoke:down-partial-reap
 */
import { strict as assert } from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pickFreePort } from "../../../packages/core/smoke/_free-port.js";
import { SMOKE_BROKER_TOKEN, teardownOnSignal } from "@cotal-ai/smoke-kit";
import type { AgentHandle, AttachSession } from "@cotal-ai/core";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const scratch = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
const home = join(scratch, "home");
const root = join(scratch, "root");
mkdirSync(join(home, ".cotal"), { recursive: true });
mkdirSync(join(root, ".cotal", "agents"), { recursive: true });
process.env.COTAL_HOME = home;

let manager: InstanceType<typeof import("../../manager/src/manager.js").Manager> | undefined;
let stackChild: ChildProcess | undefined;
let releaseBroker: (() => void) | undefined;
let failedMayExit = false;
let passed = false;

try {
  const core = await import("@cotal-ai/core");
  const workspace = await import("@cotal-ai/workspace");
  const { Manager } = await import("../../manager/src/manager.js");
  const { down } = await import("../src/commands/down.js");
  await import("@cotal-ai/cli");

  const port = await pickFreePort();
  const server = `nats://127.0.0.1:${port}`;
  const space = "down-partial-reap";
  const store = join(scratch, "js");
  const broker = spawn("nats-server", ["-p", String(port), "-js", "-sd", store], { stdio: "ignore" });
  releaseBroker = teardownOnSignal(broker, scratch);
  let up = false;
  for (let i = 0; i < 100; i++) {
    if (await core.isReachable(server)) { up = true; break; }
    await wait(50);
  }
  if (!up) throw new Error(`fixture broker never came up on ${server}`);

  workspace.recordMesh({ space, server, root, mode: "open", ts: new Date().toISOString() });
  manager = new Manager({ space, servers: server, runtime: "pty", workspaceRoot: root, preserveStopTimeoutMs: 100 });
  await manager.start();

  const session: AttachSession = {
    cols: 80, rows: 24, backlog: () => Buffer.alloc(0), onData: () => () => {},
    onExit: () => () => {}, write: () => {}, resize: () => {},
  };
  const handle = (name: string, fails: boolean): AgentHandle => {
    let exited = false;
    return {
      name, kind: "fixture", status: () => exited ? "exited" : "running",
      stop: () => { if (!fails || failedMayExit) exited = true; },
      waitForExit: async () => {
        if (fails && !failedMayExit) throw new Error("fixture exit proof failed");
        exited = true;
      },
      interrupt: () => {}, attach: () => session,
    };
  };
  const agents = (manager as unknown as { agents: Map<string, unknown> }).agents;
  const managed = (name: string, fails: boolean) => ({
    name, role: "worker", agent: "fixture", id: core.newIdentity().id,
    lifecycleUid: core.mintLifecycleUid(), spawner: "local.manager", startedAt: Date.now() - 60_000,
    handle: handle(name, fails), suppressCleanup: false, terminalizing: false,
    launch: {
      source: { kind: "persona", ref: name, configPath: join(root, ".cotal", "agents", `${name}.md`), configSha256: "fixture" },
      cwd: root, subscribe: [], allowSubscribe: [], allowPublish: [], capabilities: [],
    },
  });
  for (const name of ["seat-a", "seat-b"])
    writeFileSync(join(root, ".cotal", "agents", `${name}.md`), `---\nname: ${name}\nrole: worker\n---\n`);
  agents.set("seat-a", managed("seat-a", false));
  agents.set("seat-b", managed("seat-b", true));

  stackChild = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { detached: true, stdio: "ignore" });
  stackChild.unref();
  const pidPath = workspace.localProcessPath(workspace.MANAGER_PIDFILE, { root, space });
  writeFileSync(pidPath, String(stackChild.pid), { mode: 0o600 });
  writeFileSync(`${pidPath}.identity`, `${stackChild.pid} ${workspace.defaultStartToken(stackChild.pid ?? 0)}`, { mode: 0o600 });

  const out: string[] = [];
  const err: string[] = [];
  const realLog = console.log;
  const realError = console.error;
  const beforeCwd = process.cwd();
  const beforeExitCode = process.exitCode;
  process.exitCode = 0;
  try {
    console.log = (...args: unknown[]) => { out.push(args.map(String).join(" ")); };
    console.error = (...args: unknown[]) => { err.push(args.map(String).join(" ")); };
    process.chdir(root);
    await down({ values: { "with-agents": true }, positionals: [], raw: [] });
  } finally {
    process.chdir(beforeCwd);
    console.log = realLog;
    console.error = realError;
  }

  const stdout = out.join("\n");
  const stderr = err.join("\n");
  assert.match(stdout, /stopped 1 managed agent/);
  assert.match(stdout, /seat-a/);
  assert.match(stderr, /could not stop 1 managed agent/);
  assert.match(stderr, /seat-b/);
  assert.match(stderr, /fixture exit proof failed/);
  assert.doesNotMatch(`${stdout}\n${stderr}`, /no seats were reaped/);
  assert.equal(process.exitCode, 1);
  assert.equal(agents.has("seat-a"), false);
  assert.equal(agents.has("seat-b"), true);
  process.exitCode = beforeExitCode;

  console.log("down partial reap smoke: 9 checks passed");
  passed = true;
} finally {
  failedMayExit = true;
  await manager?.stop({ withAgents: true }).catch(() => {});
  if (stackChild?.pid) {
    try { process.kill(stackChild.pid, "SIGKILL"); } catch { /* already stopped by down */ }
  }
  releaseBroker?.();
  rmSync(scratch, { recursive: true, force: true });
  if (passed) process.exit(0);
}
