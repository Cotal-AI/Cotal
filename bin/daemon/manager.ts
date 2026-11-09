/** Per-space stock Manager children. Only an answered instance records a hosting intent. */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { assertLifecycleToken, mkSecretDir, writeSecretFileAtomic } from "@cotal-ai/core";
import { daemonArgv } from "@cotal-ai/cli/self-exec";
import { loadIdpSession, withIdpSessionDir } from "@cotal-ai/auth";
import { findMesh, homeCotalDir, resolveControlTarget, spaceSegment } from "@cotal-ai/workspace";
import { askManager } from "@cotal-ai/workspace/control";
import type { HostedManager } from "./protocol.js";

export const daemonManagerRoot = (space: string, home: string) => join(home, "daemon", spaceSegment(space), "manager");
export const daemonManagerIntentFile = (space: string, home: string) => join(home, "daemon", spaceSegment(space), "manager-host.json");

/** Forget only the daemon's per-space hosting records after its owned service was removed. */
export function forgetHostedManagerIntents(home: string): void {
  let entries: string[];
  try { entries = readdirSync(join(home, "daemon")); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  for (const entry of entries) {
    for (const name of ["manager-host.json", "manager-refusal.json"]) rmSync(join(home, "daemon", entry, name), { force: true });
  }
}
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const controlClient = { versionSkew: (detail: string) => detail, roster: async () => [] };
interface Live {
  view: HostedManager;
  child?: ChildProcess;
  exited?: Promise<void>;
  starting?: Promise<HostedManager>;
  timer?: ReturnType<typeof setTimeout>;
  stopping: boolean;
  failures: number;
}

export function createHostedManagers(home = homeCotalDir()) {
  const live = new Map<string, Live>();
  let closed = false;
  const refusalFile = (space: string) => join(home, "daemon", spaceSegment(space), "manager-refusal.json");
  const persistRefusal = (l: Live) => {
    mkSecretDir(join(refusalFile(l.view.space), ".."));
    writeSecretFileAtomic(refusalFile(l.view.space), JSON.stringify(l.view));
  };
  const refuse = (l: Live, reason: string, next: string) => {
    l.view = { ...l.view, state: "refused", reason, lastRefusal: reason, next };
    persistRefusal(l);
    return l.view;
  };
  const status = (space: string): HostedManager => {
    const current = live.get(space);
    if (current) return { ...current.view };
    if (existsSync(refusalFile(space))) {
      const saved = JSON.parse(readFileSync(refusalFile(space), "utf8")) as HostedManager;
      if (saved.space === space && saved.state === "refused") return saved;
      throw new Error("invalid hosted Manager refusal record");
    }
    return { space, state: "stopped", restarts: 0 };
  };
  async function stopChild(l: Live): Promise<void> {
    const child = l.child;
    if (!child) return;
    if (child.connected) child.disconnect();
    // IPC loss invokes the stock sparing stop, including on Windows. Never signal another pid.
    await l.exited;
    l.child = undefined;
  }
  const schedule = (l: Live) => {
    if (closed || l.stopping || l.view.state === "refused") return;
    l.view = { ...l.view, state: "restarting", restarts: l.view.restarts + 1 };
    const delay = Math.min(30_000, 1000 * 2 ** Math.min(l.failures++, 5));
    l.timer = setTimeout(() => {
      l.timer = undefined;
      l.starting = launch(l).catch((error) => refuse(l, (error as Error).message, `correct the cause and run cotal daemon setup --space ${l.view.space}`)).finally(() => { l.starting = undefined; });
      void l.starting.catch(() => {});
    }, delay);
  };
  async function launch(l: Live): Promise<HostedManager> {
    const space = l.view.space;
    if (closed || l.stopping) return l.view;
    const entry = findMesh(space);
    if (!entry) return refuse(l, "this space is no longer registered on this machine", `run cotal daemon setup --space ${space} --idp <url> to discover it again`);
    if (entry.mode !== "user" || entry.userAuth?.remote !== true) return refuse(l, "hosted Managers require a registered user-auth participant space", "use cotal manager start from the folder that hosts the space");
    if (!loadIdpSession(home, entry.userAuth.idp.url)) return refuse(l, "the daemon has no sign-in for this space's provider", `run cotal daemon login --idp ${entry.userAuth.idp.url}, then cotal daemon setup --space ${space}`);
    const root = daemonManagerRoot(space, home);
    mkSecretDir(root); mkSecretDir(join(root, ".cotal"));
    const [node, ...argv] = daemonArgv();
    l.view = { ...l.view, state: "starting" };
    let nativeReason: string | undefined;
    let authorityTerminal = false;
    let stderr = "";
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("COTAL_") || ["COTAL_HOME", "COTAL_SKIP_CONNECTOR_SEED", "COTAL_TELEMETRY"].includes(key)));
    const child = spawn(node!, [...argv, "__machine-manager", "--space", space, "--runtime", "pty", "--console-port", "0", "--session-directory", home], {
      cwd: root, env, windowsHide: true, stdio: ["ignore", "ignore", "pipe", "ipc"],
    });
    l.child = child;
    l.view = { ...l.view, pid: child.pid };
    let instanceId: string | undefined;
    child.on("message", (message: unknown) => {
      if (!message || typeof message !== "object") return;
      const frame = message as { kind?: unknown; instanceId?: unknown; reason?: unknown; terminal?: unknown };
      if (frame.kind === "manager-refusal" && typeof frame.reason === "string") {
        nativeReason = frame.reason.slice(0, 1500);
        authorityTerminal = frame.terminal === true;
        return;
      }
      if (frame.kind !== "manager-instance" || typeof frame.instanceId !== "string") return;
      try { instanceId = assertLifecycleToken(frame.instanceId, "instanceId"); } catch { /* an invalid frame never selects another instance */ }
    });
    let ended = false;
    l.exited = new Promise<void>((resolve) => {
      child.once("error", (error) => { nativeReason = error.message; ended = true; resolve(); });
      child.once("exit", () => {
        ended = true;
        child.stderr?.destroy();
        if (l.child === child) l.child = undefined;
        resolve();
        if (l.view.state === "answering") schedule(l);
      });
    });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-8192);
      for (const line of stderr.split("\n")) {
        if (!authorityTerminal && /✗|remote supervision.*refused|the manager did not start/.test(line)) {
          nativeReason = line.replace(/\u001b\[[0-9;]*m/g, "").replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "<redacted>").slice(0, 1500);
        }
      }
    });
    const deadline = Date.now() + 90_000;
    let last: unknown;
    while (!ended && !closed && !l.stopping && Date.now() < deadline) {
      try {
        if (instanceId) {
          const selected = instanceId;
          l.view = { ...l.view, instanceId: selected };
          const reply = await withIdpSessionDir(home, async () => {
            const target = await resolveControlTarget({ space }, "control-caller-privileged", selected, { onRefusal: "throw", readOnly: true });
            return askManager(controlClient, space, target.server, "managerStatus", undefined, target.auth, "owner", 3000, { instanceId: selected });
          });
          if (reply.ok && !ended && !l.stopping && !closed) {
            const path = daemonManagerIntentFile(space, home);
            writeSecretFileAtomic(path, JSON.stringify({ v: 1, space }));
            l.view = { ...l.view, state: "answering", reason: undefined, next: undefined };
            l.failures = 0;
            return { ...l.view };
          }
          last = reply.error;
        }
      } catch (error) { last = error; }
      await pause(250);
    }
    await stopChild(l);
    if (closed || l.stopping) return l.view;
    const reason = nativeReason ?? (last instanceof Error ? last.message : typeof last === "string" ? last : "the Manager exited before answering status");
    const terminal = authorityTerminal || /scope|sign.?in|signed.?out|cached session|unsupported|not implement|not registered|permission.denied|HTTP (401|403|404)|version skew|trust pins|does not support/i.test(reason);
    if (terminal) return refuse(l, reason, /scope|supervise/i.test(reason)
      ? `ask the space owner to grant your cli actor the supervise scope, then run cotal daemon setup --space ${space}`
      : `run cotal daemon login --idp ${entry.userAuth.idp.url}, correct the reported cause, then run cotal daemon setup --space ${space}`);
    l.view = { ...l.view, reason, next: `read cotal daemon status --space ${space}; the daemon will retry` };
    schedule(l);
    return { ...l.view };
  }
  const start = async (space: string): Promise<HostedManager> => {
    if (closed) throw new Error("the daemon is stopping");
    let l = live.get(space);
    if (!l) { const previous = status(space); l = { view: { space, state: "starting", restarts: 0, ...(previous.lastRefusal ? { lastRefusal: previous.lastRefusal } : {}) }, stopping: false, failures: 0 }; live.set(space, l); }
    if (l.starting) return l.starting;
    if (l.view.state === "answering") return { ...l.view };
    if (l.timer) { clearTimeout(l.timer); l.timer = undefined; }
    l.stopping = false;
    const current = l;
    current.starting = launch(current).catch((error) => refuse(current, (error as Error).message, `correct the cause and run cotal daemon setup --space ${space}`)).finally(() => { current.starting = undefined; });
    return current.starting;
  };
  const spaces = (refusals = false): string[] => {
    let entries: string[];
    try { entries = readdirSync(join(home, "daemon")); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
    return entries.flatMap((entry) => {
      const intent = join(home, "daemon", entry, "manager-host.json");
      const path = existsSync(intent) ? intent : refusals ? join(home, "daemon", entry, "manager-refusal.json") : intent;
      if (!existsSync(path)) return [];
      const record = JSON.parse(readFileSync(path, "utf8")) as { v?: unknown; space?: unknown };
      if (typeof record.space !== "string" || spaceSegment(record.space) !== entry || (path === intent && record.v !== 1)) throw new Error("invalid hosted Manager record");
      return [record.space];
    });
  };
  return {
    start, status,
    all: () => [...new Set([...spaces(true), ...live.keys()])].map(status),
    async disconnect(space: string) {
      const l = live.get(space);
      if (l) {
        l.stopping = true;
        if (l.timer) clearTimeout(l.timer);
        await stopChild(l);
        await l.starting;
        live.delete(space);
      }
      rmSync(daemonManagerIntentFile(space, home), { force: true });
      rmSync(refusalFile(space), { force: true });
    },
    async resume() { await Promise.all(spaces().map(start)); },
    async close() {
      closed = true;
      await Promise.all([...live.values()].map(async (l) => {
        l.stopping = true;
        if (l.timer) clearTimeout(l.timer);
        await stopChild(l);
        await l.starting;
      }));
    },
  };
}
