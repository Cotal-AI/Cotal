/**
 * A spawn carrying `supervise` restarts the process in place until the budget is spent.
 *
 * The load-bearing properties: identity and lifecycle stay the same, pending turns are not
 * stamped dead across a restart, a spent budget retires the seat, a host that cannot relaunch
 * in place refuses at accept, and a failed relaunch retires with supervise-recovery-failed.
 *
 * Run: pnpm smoke:manager-supervise-restart
 */
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEV_OWNER,
  principalKey,
  registry,
  type AgentHandle,
  type AttachSession,
  type Connector,
  type LaunchOpts,
  type LaunchSpec,
  type Presence,
} from "@cotal-ai/core";
import { Manager } from "../src/manager.js";

let ok = 0, fail = 0;
const c = (n: string, v: boolean, extra?: unknown): void => {
  if (v) ok++;
  else { fail++; console.log("  ✗ FAIL:", n, extra ?? ""); }
};

interface CrashHandle extends AgentHandle {
  crash(): void;
}

const workspaceRoot = mkdtempSync(join(tmpdir(), "cotal-supervise-restart-"));
mkdirSync(join(workspaceRoot, ".cotal", "agents"), { recursive: true });

const spawnedOpts: LaunchOpts[] = [];
const connector: Connector = {
  kind: "connector",
  name: "smoke-supervise-restart",
  buildLaunch(opts): LaunchSpec {
    spawnedOpts.push(opts);
    return { command: "true", args: [], env: {} };
  },
};
registry.register(connector);

const presenceListeners = new Set<() => void>();
const roster: Presence[] = [];
const handles: CrashHandle[] = [];
let publishPresence = true;

const makeHandle = (name: string): CrashHandle => {
  let running = true;
  const exits = new Set<() => void>();
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
    interrupt: () => {},
    attach: () => session,
    crash: () => {
      if (!running) return;
      running = false;
      for (const fn of [...exits]) fn();
    },
  };
  handles.push(handle);
  return handle;
};

const manager = new Manager({ space: "smoke", workspaceRoot, runtime: "pty" });
const doors = manager as unknown as {
  runtime: { kind: string; spawn(name: string, spec: LaunchSpec): AgentHandle };
  ep: {
    ref(): { id: string };
    getRoster(): Presence[];
    on(event: string, fn: () => void): void;
    off(event: string, fn: () => void): void;
  };
  agents: Map<string, Managed>;
  userMode: boolean;
  readinessTimeoutMs: number;
  pendingTurns: Map<string, { seat: { name: string; uid: string }; seatDiedAt?: number }>;
  watchExit(agent: Managed): void;
  onAgentExit(agent: Managed): void;
  opStart(args: Record<string, unknown>, caller: string): Promise<{ ok: boolean; error?: string }>;
  startAgentActive(opts: Record<string, unknown>): Promise<{ ok: boolean; error?: string }>;
};
doors.runtime = {
  kind: "pty",
  spawn: (name) => {
    const handle = makeHandle(name);
    refreshRoster();
    return handle;
  },
};
doors.ep = {
  ref: () => ({ id: "manager" }),
  getRoster: () => roster,
  on: (_event, fn) => { presenceListeners.add(fn); },
  off: (_event, fn) => { presenceListeners.delete(fn); },
};

interface Managed {
  name: string;
  agent: string;
  id: string;
  lifecycleUid: string;
  spawner: string;
  startedAt: number;
  handle: CrashHandle;
  launch: {
    source: { kind: "persona"; ref: string; configPath: string; configSha256: string };
    cwd: string;
    allowSubscribe: string[];
    events: boolean;
  };
  restart?: {
    opts: LaunchOpts;
    sessionStatePath?: string;
    crashes: number[];
    recovering: boolean;
    armed: boolean;
    policy?: { restarts: number; windowMs: number };
  };
  terminalizing?: boolean;
}

const initialOpts: LaunchOpts = {
  space: "smoke",
  name: "seat",
  id: "seatid",
  lifecycleUid: "12345678901234567890123456",
  prompt: "must not replay",
  resume: "source-fork",
  workspaceRoot,
};
const initial = makeHandle("seat");
const managed: Managed = {
  name: "seat",
  agent: connector.name,
  id: "seatid",
  lifecycleUid: "12345678901234567890123456",
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
    crashes: [],
    recovering: false,
    armed: true,
    policy: { restarts: 1, windowMs: 60_000 },
  },
};
writeFileSync(managed.launch.source.configPath, "---\nname: seat\n---\n");
const agents = doors.agents;
agents.set(managed.name, managed);

const refreshRoster = (): void => {
  roster.length = 0;
  const a = agents.get(managed.name);
  if (!publishPresence || !a) {
    for (const fn of presenceListeners) fn();
    return;
  }
  roster.push({
    card: { id: principalKey(DEV_OWNER, a.id).key, name: a.name, kind: "agent" },
    lifecycleUid: a.lifecycleUid,
    status: "idle",
    ts: Date.now(),
  });
  for (const fn of presenceListeners) fn();
};
refreshRoster();
doors.watchExit(managed);

const pending: {
  ref: { endpoint: string; caller: { owner: string; actor: string; uid: string }; goalId: string };
  goalId: string;
  seat: { name: string; owner: string; actor: string; uid: string };
  payload: string;
  acceptedAt: number;
  deadlineAt: number;
  holdToken: string;
  holdEpoch: number;
  seatDiedAt?: number;
} = {
  ref: { endpoint: "manager", caller: { owner: "local", actor: "wf", uid: "u".repeat(26) }, goalId: "turn-1" },
  goalId: "turn-1",
  seat: { name: managed.name, owner: DEV_OWNER, actor: managed.id, uid: managed.lifecycleUid },
  payload: "{}",
  acceptedAt: Date.now(),
  deadlineAt: Date.now() + 60_000,
  holdToken: "hold",
  holdEpoch: 0,
};
doors.pendingTurns.set("turn-1", pending);

const waitFor = async (predicate: () => boolean, label: string, ms = 5_000): Promise<boolean> => {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) {
      c(`${label} settled in time`, false);
      return false;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return true;
};
const bounded = async (p: Promise<{ ok: boolean; error?: string }>, ms: number): Promise<{ ok: boolean; error?: string }> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p.catch((e) => ({ ok: false as const, error: (e as Error).message })),
      new Promise<{ ok: false; error: string }>((resolve) => {
        timer = setTimeout(() => resolve({ ok: false, error: `timed out after ${ms}ms` }), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
};

handles.at(-1)!.crash();
await waitFor(
  () => spawnedOpts.length === 1 || !agents.has(managed.name),
  "first crash",
);
c("a supervised crash keeps the same managed row", agents.get(managed.name) === managed);
if (agents.has(managed.name))
  await waitFor(() => managed.restart?.recovering === false, "first recovery");
c("a supervised crash keeps identity and lifecycle", managed.id === "seatid" && managed.lifecycleUid === initialOpts.lifecycleUid);
c("a non-continuation connector is relaunched without a session id", spawnedOpts[0]?.continueSession === undefined);
c("a restart never replays fork source or initial prompt", spawnedOpts[0]?.resume === undefined && spawnedOpts[0]?.prompt === undefined);
c("a pending turn is not stamped dead across a restart", pending.seatDiedAt === undefined);

handles.at(-1)!.crash();
await waitFor(
  () => managed.restart?.recovering === false || !agents.has(managed.name),
  "second crash",
);
c("spending the restart budget starts no further replacement", spawnedOpts.length === 1);
c("a spent supervise budget retires the seat", !agents.has(managed.name));
c("retiring the seat stamps pending turns dead", typeof pending.seatDiedAt === "number");

const parse = await doors.opStart({ name: "seat", supervise: { restart: "always" } }, "caller");
c("opStart refuses an unknown supervise key", parse.ok === false && (parse.error ?? "").includes("unknown key"), parse);

const missing = await doors.opStart({ name: "seat", supervise: { restarts: 1 } }, "caller");
c("opStart refuses a policy without windowMs", missing.ok === false && (missing.error ?? "").includes("windowMs"), missing);

writeFileSync(join(workspaceRoot, ".cotal", "agents", "seat.md"), "---\nname: seat\nagent: smoke-supervise-restart\n---\n");
doors.userMode = true;
const user = await bounded(doors.startAgentActive({ name: "seat", agent: connector.name, supervise: { restarts: 1, windowMs: 1_000 } }), 2_000);
c("user-mode refuses supervise at accept", user.ok === false && (user.error ?? "").includes("user-mode"), user);
doors.userMode = false;

doors.runtime.kind = "tmux";
const ext = await bounded(doors.startAgentActive({ name: "seat", agent: connector.name, supervise: { restarts: 1, windowMs: 1_000 } }), 2_000);
c("a non-pty runtime refuses supervise at accept", ext.ok === false && (ext.error ?? "").includes("runtime \"tmux\""), ext);
doors.runtime.kind = "pty";

const failedOpts: LaunchOpts = { ...initialOpts, name: "failed" };
const failedHandle = makeHandle("failed");
publishPresence = false;
const failed: Managed = {
  ...managed,
  name: "failed",
  id: "failid",
  handle: failedHandle,
  terminalizing: false,
  restart: { opts: failedOpts, crashes: [], recovering: false, armed: true, policy: { restarts: 2, windowMs: 60_000 } },
};
agents.set(failed.name, failed);
doors.readinessTimeoutMs = 50;
doors.watchExit(failed);
failedHandle.crash();
await waitFor(() => !agents.has(failed.name), "failed relaunch");
c("a failed supervised relaunch retires the seat", !agents.has(failed.name));

const EXPECTED = 13;
const ran = ok + fail;
console.log(`supervise restart smoke: ${ok} passed, ${fail} failed`);
if (ran !== EXPECTED) {
  console.log(`SUITE INCOMPLETE — ran ${ran} of ${EXPECTED} cells; a partial run is not a pass`);
  process.exit(1);
}
process.exit(fail === 0 ? 0 : 1);
