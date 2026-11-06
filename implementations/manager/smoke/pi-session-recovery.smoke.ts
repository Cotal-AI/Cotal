import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  registry,
  type AgentHandle,
  type AttachSession,
  type Connector,
  type LaunchOpts,
  type LaunchSpec,
} from "@cotal-ai/core";
import { controlEndpoint, startControlServer, type MeshAgent } from "@cotal-ai/connector-core";
import { Manager } from "../src/manager.js";

let checks = 0;
const check = (condition: unknown, message: string, detail?: unknown): void => {
  assert.ok(condition, `${message}${detail === undefined ? "" : `: ${JSON.stringify(detail)}`}`);
  checks++;
};

interface CrashHandle extends AgentHandle {
  crash(): void;
}

const workspaceRoot = mkdtempSync(join(tmpdir(), "cotal-pi-recovery-"));
const stateDir = join(workspaceRoot, ".cotal", "pi-sessions");
mkdirSync(stateDir, { recursive: true });
const sessionId = "01999999-9999-7999-8999-000000000123";
const statePath = join(stateDir, "pi-seat-life.json");
writeFileSync(statePath, JSON.stringify({ version: 1, sessionId, status: "running" }) + "\n");

const spawnedOpts: LaunchOpts[] = [];
const connector: Connector = {
  kind: "connector",
  name: "smoke-pi-recovery",
  supportsSessionContinuation: true,
  buildLaunch(opts): LaunchSpec {
    spawnedOpts.push(opts);
    const control = controlEndpoint("smoke", opts.name);
    return { command: "true", args: [], env: {}, control, sessionStatePath: statePath };
  },
};
registry.register(connector);

const handles: CrashHandle[] = [];
const servers: Array<ReturnType<typeof startControlServer>> = [];
const makeHandle = (name: string, spec: LaunchSpec): CrashHandle => {
  let running = true;
  const exits = new Set<() => void>();
  let ownedServer: ReturnType<typeof startControlServer> | undefined;
  if (spec.control) {
    const server = startControlServer(
      {} as unknown as MeshAgent,
      spec.control,
      async () => ({}),
      { onSession: () => sessionId },
    );
    servers.push(server);
    ownedServer = server;
  }
  const session: AttachSession = {
    cols: 80,
    rows: 24,
    backlog: () => Buffer.alloc(0),
    onData: () => () => {},
    onExit: (fn) => {
      if (!running) { queueMicrotask(fn); return () => {}; }
      exits.add(fn);
      return () => exits.delete(fn);
    },
    write: () => {},
    resize: () => {},
  };
  const handle: CrashHandle = {
    name,
    kind: "fake",
    status: () => (running ? "running" : "exited"),
    stop: () => {
      if (!running) return;
      running = false;
      for (const fn of [...exits]) fn();
    },
    waitForExit: async () => {},
    // This unit runtime creates only the control server, which crash closes synchronously.
    waitForWorkExit: async () => { assert.equal(running, false); },
    interrupt: () => {},
    attach: () => session,
    crash: () => {
      if (!running) return;
      running = false;
      ownedServer?.close();
      for (const fn of [...exits]) fn();
    },
  };
  handles.push(handle);
  return handle;
};

const manager = new Manager({ space: "smoke", workspaceRoot, runtime: "pty" });
(manager as unknown as { runtime: { kind: string; spawn(name: string, spec: LaunchSpec): AgentHandle } }).runtime = {
  kind: "fake",
  spawn: makeHandle,
};
(manager as unknown as { ep: unknown }).ep = {
  ref: () => ({ id: "manager" }),
  getRoster: () => [],
  on: () => {},
  off: () => {},
};

// A connector that reaches its native project-trust prompt but never starts a session names that
// prompt and directory. It must not degrade to the generic missing-session-state failure.
{
  const promptCwd = join(workspaceRoot, "project-with-resources");
  writeFileSync(statePath, JSON.stringify({
    version: 2,
    connector: "pi",
    status: "prompt",
    prompt: "Trust project folder?",
    cwd: promptCwd,
  }) + "\n");
  const stopped = makeHandle("pi-prompt", { command: "true", args: [], env: {} });
  stopped.stop();
  const promptAgent = {
    handle: stopped,
    restart: { sessionStatePath: statePath },
  };
  await assert.rejects(
    () => (manager as unknown as { awaitManagedSessionState(agent: typeof promptAgent): Promise<unknown> }).awaitManagedSessionState(promptAgent),
    (error: unknown) => error instanceof Error && error.message.includes("Trust project folder?") && error.message.includes(promptCwd) &&
      !error.message.includes("connector did not write session state"),
    "a failed Pi startup names the native prompt and directory",
  );
  checks++;
  writeFileSync(statePath, JSON.stringify({ version: 1, sessionId, status: "running" }) + "\n");
}

const initialOpts: LaunchOpts = {
  space: "smoke",
  name: "pi-seat",
  id: "seatid",
  lifecycleUid: "12345678901234567890123456",
  prompt: "must not replay",
  resume: "source-fork",
  workspaceRoot,
};
const initial = makeHandle("pi-seat", { command: "true", args: [], env: {}, sessionStatePath: statePath });
const managed = {
  name: "pi-seat",
  agent: connector.name,
  id: "seatid",
  lifecycleUid: initialOpts.lifecycleUid,
  spawner: "manager",
  startedAt: Date.now(),
  handle: initial,
  launch: {
    source: { kind: "persona", ref: "default", configPath: join(workspaceRoot, "agent.md"), configSha256: "x" },
    cwd: workspaceRoot,
    allowSubscribe: ["general"],
    events: false,
  },
  restart: {
    opts: initialOpts,
    sessionStatePath: statePath,
    crashes: [],
    recovering: false,
    armed: true,
  },
};
writeFileSync(managed.launch.source.configPath, "---\nname: pi-seat\n---\n");
const agents = (manager as unknown as { agents: Map<string, typeof managed> }).agents;
agents.set(managed.name, managed);
(manager as unknown as { watchExit(agent: typeof managed): void }).watchExit(managed);

const waitFor = async (predicate: () => boolean, label: string, ms = 5_000): Promise<void> => {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

// Three unexpected exits recover in place.
for (let attempt = 1; attempt <= 3; attempt++) {
  handles.at(-1)!.crash();
  await waitFor(() => spawnedOpts.length === attempt && managed.restart.recovering === false, `recovery ${attempt}`);
  check(agents.get(managed.name) === managed, `crash ${attempt} keeps the same managed row`);
  check(managed.id === "seatid" && managed.lifecycleUid === initialOpts.lifecycleUid, `crash ${attempt} keeps identity and lifecycle`);
  const opts = spawnedOpts.at(-1)!;
  check(opts.continueSession === sessionId, `crash ${attempt} reopens the exact Pi session`);
  check(opts.resume === undefined && opts.prompt === undefined, `crash ${attempt} never replays fork source or initial prompt`);
}

const inventory = (manager as unknown as { resumeEntry(agent: typeof managed): { launch: { sessionId?: string }; identity: { lifecycleUid: string }; name: string } }).resumeEntry(managed);
check(inventory.launch.sessionId === sessionId, "manager preservation records the exact current Pi session");
const legacyInventory = { ...inventory, launch: { ...inventory.launch, sessionId: undefined } };
const legacyPath = join(workspaceRoot, ".cotal", "pi-sessions", `${legacyInventory.name}-${legacyInventory.identity.lifecycleUid}.json`);
writeFileSync(legacyPath, JSON.stringify({ version: 1, sessionId, status: "running" }) + "\n");
const bridged = (manager as unknown as { retainedSessionId(entry: typeof legacyInventory, connector: Connector): string | undefined }).retainedSessionId(legacyInventory, connector);
check(bridged === sessionId, "an older inventory recovers the exact session from lifecycle-keyed upgrade state");
rmSync(legacyPath, { force: true });
assert.throws(
  () => (manager as unknown as { retainedSessionId(entry: typeof legacyInventory, connector: Connector): string | undefined }).retainedSessionId(legacyInventory, connector),
  /refusing to resume fresh/,
  "an older inventory without upgrade state must fail loud instead of losing context",
);
checks++;
writeFileSync(statePath, JSON.stringify({ version: 1, sessionId, status: "running" }) + "\n");

// Fourth crash in the rolling window is a loop: no fourth spawn and normal terminal cleanup runs.
handles.at(-1)!.crash();
await waitFor(() => !agents.has(managed.name), "crash-loop retirement");
check(spawnedOpts.length === 3, "the fourth crash starts no replacement process");
check(!agents.has(managed.name), "crash-loop exhaustion retires the seat");
check(!existsSync(statePath), "terminal cleanup removes the managed session-state carrier");

// Deliberate terminal never restarts.
const deliberateHandle = makeHandle("pi-stop", { command: "true", args: [], env: {} });
const deliberate = {
  ...managed,
  name: "pi-stop",
  id: "stopid",
  handle: deliberateHandle,
  terminalizing: false,
  restart: { ...managed.restart, crashes: [], recovering: false, armed: true },
};
writeFileSync(statePath, JSON.stringify({ version: 1, sessionId, status: "quit" }) + "\n");
agents.set(deliberate.name, deliberate);
const before = spawnedOpts.length;
(manager as unknown as { onAgentExit(agent: typeof deliberate): void }).onAgentExit(deliberate);
check(spawnedOpts.length === before, "a deliberate terminal starts no replacement");
check(!agents.has(deliberate.name), "a deliberate terminal follows normal cleanup");

// The same recovery entry refuses missing/failed proof without declaring outstanding work done.
for (const mode of ["absent", "rejected", "pending", "retired", "timeout"] as const) {
  const handle = makeHandle(`closure-${mode}`, { command: "true", args: [], env: {} });
  let closeWork!: () => void;
  if (mode === "absent") delete handle.waitForWorkExit;
  else if (mode === "rejected") handle.waitForWorkExit = async () => { throw new Error("ownership unknown"); };
  else handle.waitForWorkExit = () => new Promise<void>((resolve) => { closeWork = resolve; });
  const row = {
    ...managed, name: handle.name, id: `closure_${mode}`, handle, terminalizing: false,
    restart: { ...managed.restart, crashes: [], recovering: false, armed: true },
  };
  writeFileSync(statePath, JSON.stringify({ version: 1, sessionId, status: "running" }) + "\n");
  agents.set(row.name, row);
  handle.crash();
  const before = spawnedOpts.length;
  (manager as unknown as { onAgentExit(agent: typeof row): void }).onAgentExit(row);
  if (mode === "pending" || mode === "retired") {
    await waitFor(() => closeWork !== undefined, `${mode} closure requested`);
    await new Promise((resolve) => setTimeout(resolve, 30));
    check(spawnedOpts.length === before, `${mode}: no replacement before work closure`);
    if (mode === "retired") { row.terminalizing = true; agents.delete(row.name); }
    closeWork();
  }
  if (mode === "pending") {
    await waitFor(() => spawnedOpts.length === before + 1 && !row.restart.recovering, "closed work restart");
    check(agents.get(row.name) === row, "proved closure permits recovery under the existing lifecycle");
    row.terminalizing = true;
    row.handle.stop();
    agents.delete(row.name);
  } else {
    await waitFor(() => !agents.has(row.name), `${mode} refusal`, 12_000);
    if (mode === "timeout") closeWork(); // A late proof must never revive the timed-out retry.
    await new Promise((resolve) => setTimeout(resolve, 30));
    check(spawnedOpts.length === before, `${mode}: no replacement after unknown work or concurrent retirement`);
  }
}

// A successor cannot turn a missing reference or an ordinary process reap into work closure.
const recover = manager as unknown as {
  restartSupervisedSeat(row: { alias: string; runtime?: { kind: string; id: string } }, record: { supervise: { restarts: number; windowMs: number }; crashes: number[] }): Promise<string | undefined>;
};
const storedPolicy = { supervise: { restarts: 1, windowMs: 60_000 }, crashes: [] };
check((await recover.restartSupervisedSeat({ alias: "orphan" }, storedPolicy))?.includes("no durable custody reference"), "successor refuses missing durable work custody");
check((await recover.restartSupervisedSeat({ alias: "orphan", runtime: { kind: "fake", id: "owned" } }, storedPolicy))?.includes("cannot prove prior local work ended"), "successor refuses a runtime without durable work closure");

for (const server of servers) try { server.close(); } catch { /* already closed */ }
console.log(`pi session recovery smoke: ${checks} checks passed`);
