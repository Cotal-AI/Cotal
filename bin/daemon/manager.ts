/** Per-space stock Manager children. Only an answered instance records a hosting intent. */
import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { appendFileSync, chmodSync, existsSync, lstatSync, readFileSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { assertLifecycleToken, mkSecretDir, writeSecretFileAtomic } from "@cotal-ai/core";
import { daemonArgv } from "@cotal-ai/cli/self-exec";
import { writeDefaultPersonaForLaunch } from "@cotal-ai/cli/default-persona";
import { loadIdpSession, withIdpSessionDir } from "@cotal-ai/auth";
import { findMesh, homeCotalDir, resolveControlTarget, spaceFromSegment, spaceSegment } from "@cotal-ai/workspace";
import { askManager } from "@cotal-ai/workspace/control";
import type { HostedManager } from "./protocol.js";

export const daemonManagerRoot = (space: string, home: string) => join(home, "daemon", spaceSegment(space), "manager");
export const daemonManagerIntentFile = (space: string, home: string) => join(home, "daemon", spaceSegment(space), "manager-host.json");

/** Forget only the daemon's per-space hosting records after its owned service was removed. */
export function forgetHostedManagerIntents(home: string): void {
  let entries: string[];
  try { entries = readdirSync(join(home, "daemon")); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  for (const entry of entries) {
    if (spaceFromSegment(entry) === undefined || !lstatSync(join(home, "daemon", entry)).isDirectory()) continue;
    for (const name of ["manager-host.json", "manager-refusal.json"]) rmSync(join(home, "daemon", entry, name), { force: true });
  }
}
// Redact before truncating so a length bound cannot expose part of a credential.
const safeDiagnostic = (text: string) => text.replace(/\u001b\[[0-9;]*m/g, "").replace(/eyJ[A-Za-z0-9_.-]*/g, "<redacted>");
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const controlClient = { versionSkew: (detail: string) => detail, roster: async () => [] };
interface Live {
  view: HostedManager;
  child?: ChildProcess;
  exited?: Promise<void>;
  starting?: Promise<HostedManager>;
  timer?: ReturnType<typeof setTimeout>;
  healthTimer?: ReturnType<typeof setTimeout>;
  healthTask?: Promise<void>;
  stopping: boolean;
  failures: number;
}

export function createHostedManagers(home = homeCotalDir()) {
  const live = new Map<string, Live>();
  let closed = false;
  let generationPending = false;
  let generationPrepared = false;
  let generationTask: Promise<void> | undefined;
  const generationAttempts = new Map<ChildProcess, string>();
  const generationCall = (child: ChildProcess, attemptId: string, op: "inspect" | "prepare" | "abort") => new Promise<number | undefined>((resolve, reject) => {
    if (child.exitCode !== null || child.signalCode !== null) { resolve(undefined); return; }
    const finish = (error?: Error) => {
      clearTimeout(timer);
      child.off("message", receive);
      error ? reject(error) : resolve(seats);
    };
    const receive = (raw: unknown) => {
      const frame = raw as { kind?: unknown; attemptId?: unknown; op?: unknown; ok?: unknown; seats?: unknown } | null;
      if (frame?.kind === "machine-generation-result" && frame.attemptId === attemptId && frame.op === op) {
        if (op === "inspect" && (!Number.isSafeInteger(frame.seats) || Number(frame.seats) < 0)) { finish(new Error("hosted Manager did not confirm its seat count")); return; }
        seats = op === "inspect" ? Number(frame.seats) : undefined;
        finish(frame.ok === true ? undefined : new Error("hosted Manager still holds seats or cannot confirm an idle preservation fence"));
      }
    };
    let seats: number | undefined;
    const timer = setTimeout(() => finish(new Error("hosted Manager did not confirm the generation request; retrying without stopping it")), 10_000);
    child.on("message", receive);
    child.send({ kind: "machine-generation", attemptId, op }, (error) => { if (error) finish(new Error("hosted Manager parent channel is unavailable")); });
  });
  const refusalFile = (space: string) => join(home, "daemon", spaceSegment(space), "manager-refusal.json");
  const recordError = (space: string): string | undefined => {
    for (const file of [daemonManagerIntentFile(space, home), refusalFile(space)]) {
      if (!existsSync(file)) continue;
      try {
        const saved = JSON.parse(readFileSync(file, "utf8")) as { space?: unknown; v?: unknown; state?: unknown };
        if (!saved || saved.space !== space || (file === refusalFile(space) ? saved.state !== "refused" : saved.v !== 1)) throw new Error("invalid record");
      } catch { return `invalid hosted Manager record: ${file}`; }
    }
  };
  const persistRefusal = (l: Live) => {
    mkSecretDir(join(refusalFile(l.view.space), ".."));
    writeSecretFileAtomic(refusalFile(l.view.space), JSON.stringify(l.view));
  };
  const refuse = (l: Live, reason: string, next: string) => {
    reason = safeDiagnostic(reason).slice(0, 1500);
    l.view = { ...l.view, state: "refused", reason, lastRefusal: reason, next };
    persistRefusal(l);
    return l.view;
  };
  const status = (space: string): HostedManager => {
    const current = live.get(space);
    const invalid = recordError(space);
    if (invalid) return { ...(current?.view ?? { space, restarts: 0 }), state: "refused", reason: invalid, lastRefusal: invalid, next: `run cotal daemon setup --space ${space} to repair its hosting records` };
    if (current) return { ...current.view };
    if (existsSync(refusalFile(space))) {
      const saved = JSON.parse(readFileSync(refusalFile(space), "utf8")) as HostedManager;
      if (saved.space === space && saved.state === "refused") return saved;
      throw new Error("invalid hosted Manager refusal record");
    }
    return { space, state: "stopped", restarts: 0 };
  };
  const probe = (space: string, selected: string) => withIdpSessionDir(home, async () => {
    const target = await resolveControlTarget({ space }, "control-caller-privileged", selected, { onRefusal: "throw", readOnly: true });
    return askManager(controlClient, space, target.server, "managerStatus", undefined, target.auth, "owner", 3000, { instanceId: selected });
  });
  const observe = (l: Live) => {
    if (l.healthTimer) clearTimeout(l.healthTimer);
    if (closed || generationPending || l.stopping || !l.child) return;
    l.healthTimer = setTimeout(() => {
      l.healthTimer = undefined;
      const child = l.child;
      const selected = l.view.instanceId;
      if (!child || !selected || l.starting || closed || generationPending || l.stopping) { observe(l); return; }
      const current = () => !closed && !generationPending && !l.stopping && l.child === child;
      l.healthTask = (async () => {
        try {
          const pending = generationAttempts.get(child);
          if (pending) {
            try { await generationCall(child, pending, "abort"); generationAttempts.delete(child); }
            catch { return; }
          }
          const reply = await probe(l.view.space, selected);
          if (!reply.ok) throw new Error(reply.error ?? "the hosted Manager did not answer status");
          if (current()) l.view = { ...l.view, state: "answering", reason: undefined, next: undefined, observedAt: new Date().toISOString() };
        } catch (error) {
          if (!current()) return;
          l.view = { ...l.view, state: "starting", reason: safeDiagnostic(error instanceof Error ? error.message : String(error)).slice(0, 1500), observedAt: new Date().toISOString(), next: `inspect cotal daemon status --space ${l.view.space}; restore the Manager connection or stop its seats before running cotal daemon setup --space ${l.view.space}` };
          const attempt = randomUUID();
          try {
            // The native parent fence confirms no seats and blocks new admission. A failed or
            // unknown inventory never authorizes killing an occupied or unresponsive Manager.
            generationAttempts.set(child, attempt);
            await generationCall(child, attempt, "prepare");
            if (!current()) return;
            l.view = { ...l.view, state: "restarting" };
            await stopChild(l);
            if (!closed && !generationPending && !l.stopping) schedule(l);
          } catch { /* retain the child and report the failed observation */ }
          finally {
            if (l.child === child) {
              try { await generationCall(child, attempt, "abort"); generationAttempts.delete(child); }
              catch { /* Keep the exact attempt for rollback before the next health probe. */ }
            }
          }
        }
      })().finally(() => { l.healthTask = undefined; observe(l); });
      void l.healthTask.catch(() => {});
    }, 5000);
    l.healthTimer.unref();
  };
  async function stopChild(l: Live): Promise<void> {
    const child = l.child;
    if (!child) return;
    if (child.connected) child.disconnect();
    // Signal only this retained ChildProcess. Never rediscover a child from a recorded pid.
    const ended = async (ms: number) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try { return await Promise.race([l.exited!.then(() => true), new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), ms); })]); }
      finally { if (timer) clearTimeout(timer); }
    };
    if (await ended(3000)) l.view = { ...l.view, lastStop: "graceful" };
    else {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      if (await ended(2000)) l.view = { ...l.view, lastStop: "terminated" };
      else {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        if (!(await ended(2000))) throw new Error("the daemon's owned Manager child did not confirm exit after SIGKILL");
        l.view = { ...l.view, lastStop: "killed" };
      }
    }
    l.child = undefined;
  }
  const schedule = (l: Live) => {
    if (closed || generationPending || l.stopping || l.view.state === "refused") return;
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
    if (closed || generationPending || l.stopping) return l.view;
    const entry = findMesh(space);
    if (!entry) return refuse(l, "this space is no longer registered on this machine", `run cotal daemon setup --space ${space} --idp <url> to discover it again`);
    if (entry.mode !== "user" || entry.userAuth?.remote !== true) return refuse(l, "hosted Managers require a registered user-auth participant space", "use cotal manager start from the folder that hosts the space");
    if (!loadIdpSession(home, entry.userAuth.idp.url)) return refuse(l, "the daemon has no sign-in for this space's provider", `run cotal daemon login --idp ${entry.userAuth.idp.url}, then cotal daemon setup --space ${space}`);
    const root = daemonManagerRoot(space, home);
    mkSecretDir(root); mkSecretDir(join(root, ".cotal"));
    writeDefaultPersonaForLaunch(root);
    const logFile = join(root, "manager.log");
    const append = (text: string) => {
      const safe = safeDiagnostic(text);
      if (existsSync(logFile) && statSync(logFile).size + Buffer.byteLength(safe) > 1024 * 1024) renameSync(logFile, `${logFile}.1`);
      appendFileSync(logFile, safe, { mode: 0o600 });
      chmodSync(logFile, 0o600);
    };
    const [node, ...argv] = daemonArgv();
    l.view = { ...l.view, state: "starting" };
    let nativeReason: string | undefined;
    let authorityTerminal = false;
    let authorityStatus: number | undefined;
    let stderr = "";
    // Each pipe has its own line boundary. Oversized lines are discarded in full,
    // never emitted as fragments that could reconstruct a split credential.
    const lines = (accept: (line: string) => void) => {
      let pending = "", dropping = false;
      return (text: string, end = false) => {
        for (const part of text.split(/(?<=\n)/)) {
          if (!dropping) {
            if (pending.length + part.length > 16_384) { pending = ""; dropping = true; }
            else pending += part;
          }
          if (part.endsWith("\n")) {
            accept(dropping ? "<oversized Manager log line omitted>\n" : safeDiagnostic(pending));
            pending = ""; dropping = false;
          }
        }
        if (end && (pending || dropping)) {
          accept(dropping ? "<oversized Manager log line omitted>\n" : safeDiagnostic(pending));
          pending = ""; dropping = false;
        }
      };
    };
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("COTAL_") || ["COTAL_HOME", "COTAL_SKIP_CONNECTOR_SEED", "COTAL_TELEMETRY"].includes(key)));
    const child = spawn(node!, [...argv, "__machine-manager", "--space", space, "--runtime", "pty", "--console-port", "0", "--session-directory", home], {
      cwd: root, env: { ...env, COTAL_SKIP_CONNECTOR_SEED: "1" }, windowsHide: true, stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    l.child = child;
    l.view = { ...l.view, pid: child.pid };
    let instanceId: string | undefined;
    child.on("message", (message: unknown) => {
      if (!message || typeof message !== "object") return;
      const frame = message as { kind?: unknown; instanceId?: unknown; reason?: unknown; terminal?: unknown; status?: unknown };
      if (frame.kind === "manager-refusal" && typeof frame.reason === "string") {
        nativeReason = safeDiagnostic(frame.reason).slice(0, 1500);
        authorityTerminal = frame.terminal === true;
        authorityStatus = typeof frame.status === "number" ? frame.status : undefined;
        return;
      }
      if (frame.kind !== "manager-instance" || typeof frame.instanceId !== "string") return;
      try { instanceId = assertLifecycleToken(frame.instanceId, "instanceId"); } catch { /* an invalid frame never selects another instance */ }
    });
    let ended = false;
    l.exited = new Promise<void>((resolve) => {
      child.once("error", (error) => { nativeReason = safeDiagnostic(error.message).slice(0, 1500); ended = true; resolve(); });
      child.once("exit", (code, signal) => {
        stdoutLine("", true);
        stderrLine("", true);
        child.stdout?.destroy();
        child.stderr?.destroy();
        ended = true;
        generationAttempts.delete(child);
        if (l.child === child) l.child = undefined;
        resolve();
        if (!l.stopping && !closed && (l.view.state === "answering" || (l.view.state === "starting" && !l.starting))) {
          const last = stderr.trim().split("\n").pop()?.slice(-500);
          const reason = `Manager exited (${signal ?? `code ${code}`})${last ? `: ${last}` : ""}`;
          l.view = { ...l.view, reason, lastExit: reason };
          schedule(l);
        }
      });
    });
    child.stderr?.setEncoding("utf8");
    const logged = (text: string) => { try { append(text); } catch { l.view = { ...l.view, logError: "the hosted Manager log could not be written; inspect its private state directory" }; } };
    const stdoutLine = lines(logged);
    const stderrLine = lines((line) => {
      logged(line);
      stderr = (stderr + line).slice(-8192);
      if (!authorityTerminal && /✗|remote supervision.*refused|the manager did not start/.test(line)) nativeReason = line.slice(0, 1500);
    });
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => stdoutLine(chunk));
    child.stderr?.on("data", (chunk: string) => stderrLine(chunk));
    const deadline = Date.now() + 90_000;
    let last: unknown;
    while (!ended && !closed && !l.stopping && Date.now() < deadline) {
      try {
        if (instanceId) {
          const selected = instanceId;
          l.view = { ...l.view, instanceId: selected };
          const reply = await probe(space, selected);
          if (reply.ok && !ended && !l.stopping && !closed) {
            const path = daemonManagerIntentFile(space, home);
            writeSecretFileAtomic(path, JSON.stringify({ v: 1, space }));
            rmSync(refusalFile(space), { force: true });
            l.view = { ...l.view, state: "answering", reason: undefined, next: undefined, observedAt: new Date().toISOString() };
            l.failures = 0;
            observe(l);
            return { ...l.view };
          }
          last = reply.error;
        }
      } catch (error) { last = error; }
      await pause(250);
    }
    await stopChild(l);
    if (closed || l.stopping) return l.view;
    const reason = safeDiagnostic(nativeReason ?? (last instanceof Error ? last.message : typeof last === "string" ? last : "the Manager exited before answering status")).replaceAll("`cotal login --idp ", "`cotal daemon login --idp ").slice(0, 1500);
    if (authorityTerminal) return refuse(l, reason, authorityStatus === 403
      ? `ask the space owner to grant your cli actor the supervise scope, then run cotal daemon setup --space ${space}`
      : `run cotal daemon login --idp ${entry.userAuth.idp.url}, correct the reported cause, then run cotal daemon setup --space ${space}`);
    l.view = { ...l.view, reason, next: `read cotal daemon status --space ${space}; the daemon will retry` };
    schedule(l);
    return { ...l.view };
  }
  const start = async (space: string): Promise<HostedManager> => {
    if (closed || generationPending) throw new Error("the daemon is stopping or preparing an installed generation transition");
    let l = live.get(space);
    if (!l) { const previous = status(space); l = { view: { space, state: "starting", restarts: 0, ...(previous.lastRefusal ? { lastRefusal: previous.lastRefusal } : {}) }, stopping: false, failures: 0 }; live.set(space, l); }
    if (l.starting) return l.starting;
    if (l.child && l.view.instanceId) {
      try {
        const reply = await probe(space, l.view.instanceId);
        if (!reply.ok) throw new Error(reply.error ?? "the hosted Manager did not answer status");
        if (closed || l.stopping || !l.child) throw new Error("the hosted Manager is stopping");
        writeSecretFileAtomic(daemonManagerIntentFile(space, home), JSON.stringify({ v: 1, space }));
        rmSync(refusalFile(space), { force: true });
        l.view = { ...l.view, state: "answering", reason: undefined, next: undefined, observedAt: new Date().toISOString() };
      } catch (error) {
        l.view = { ...l.view, state: "starting", reason: error instanceof Error ? safeDiagnostic(error.message).slice(0, 1500) : "the hosted Manager did not answer status", next: `read cotal daemon status --space ${space}; correct its connection or restart the daemon`, observedAt: new Date().toISOString() };
      }
      return { ...l.view };
    }
    if (l.timer) { clearTimeout(l.timer); l.timer = undefined; }
    if (l.healthTask) await l.healthTask;
    l.stopping = false;
    const current = l;
    current.starting = launch(current).catch((error) => refuse(current, (error as Error).message, `correct the cause and run cotal daemon setup --space ${space}`)).finally(() => { current.starting = undefined; });
    return current.starting;
  };
  const spaces = (refusals = false): string[] => {
    let entries: string[];
    try { entries = readdirSync(join(home, "daemon")); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
    return entries.flatMap((entry) => {
      const space = spaceFromSegment(entry);
      if (space === undefined || !lstatSync(join(home, "daemon", entry)).isDirectory()) return [];
      const intent = join(home, "daemon", entry, "manager-host.json");
      const path = existsSync(intent) ? intent : refusals ? join(home, "daemon", entry, "manager-refusal.json") : intent;
      if (!existsSync(path)) return [];
      return [space];
    });
  };
  return {
    start, status,
    async generationSeats(): Promise<{ space: string; seats: number }[]> {
      return Promise.all([...live.values()].filter((l) => l.child).map(async (l) => {
        const child = l.child!;
        const seats = await generationCall(child, randomUUID(), "inspect");
        if (seats === undefined || l.child !== child) throw new Error(`hosted Manager for ${l.view.space} changed during seat observation`);
        return { space: l.view.space, seats };
      }));
    },
    prepareGenerationRestart(): Promise<void> {
      if (generationTask) return generationTask.then(() => { if (!generationPrepared) throw new Error("generation preparation was rolled back; retry the transition"); });
      if (generationPrepared) return Promise.resolve();
      const task = (async () => {
      generationPending = true;
      try {
        await Promise.all([...live.values()].map((l) => l.healthTask));
        // A timed-out prepare can still have landed. Roll back every retained attempt before retrying.
        for (const [child, attemptId] of generationAttempts) {
          await generationCall(child, attemptId, "abort");
          generationAttempts.delete(child);
        }
        await Promise.all([...live.values()].map((l) => l.starting));
        for (const l of live.values()) {
          if (!l.child) continue;
          if (l.view.state !== "answering") throw new Error("a hosted Manager is not ready to confirm a safe generation transition");
          const attemptId = randomUUID();
          generationAttempts.set(l.child, attemptId);
          await generationCall(l.child, attemptId, "prepare");
        }
        // Keep empty-manager admission fences held through the caller's close.
        generationPrepared = true;
      } catch (error) {
        for (const [child, attemptId] of generationAttempts) {
          try { await generationCall(child, attemptId, "abort"); generationAttempts.delete(child); }
          catch { /* Retain the exact attempt for rollback on the next automatic retry. */ }
        }
        generationPending = generationAttempts.size !== 0;
        if (!generationPending) for (const l of live.values()) {
          if (!l.child && !l.starting && !l.timer && l.view.state === "restarting") schedule(l);
          else if (l.child) observe(l);
        }
        throw error;
      }
      })();
      const held = task.finally(() => { if (generationTask === held) generationTask = undefined; });
      generationTask = held;
      return held;
    },
    abortGenerationRestart(): Promise<void> {
      const previous = generationTask;
      generationPrepared = false;
      const task = (async () => {
        await previous?.catch(() => {});
        generationPrepared = false;
        for (const [child, attemptId] of generationAttempts) {
          await generationCall(child, attemptId, "abort");
          generationAttempts.delete(child);
        }
        generationPending = false;
        for (const l of live.values()) {
          if (!l.child && !l.starting && !l.timer && l.view.state === "restarting") schedule(l);
          else if (l.child) observe(l);
        }
      })();
      const held = task.finally(() => { if (generationTask === held) generationTask = undefined; });
      generationTask = held;
      return held;
    },
    all: () => [...new Set([...spaces(true), ...live.keys()])].map(status),
    async disconnect(space: string) {
      const l = live.get(space);
      if (l) {
        l.stopping = true;
        if (l.timer) clearTimeout(l.timer);
        if (l.healthTimer) clearTimeout(l.healthTimer);
        await stopChild(l);
        await l.healthTask;
        await l.starting;
        l.view = { ...l.view, state: "stopped", pid: undefined, reason: undefined, next: `run cotal daemon setup --space ${space} to host its Manager again` };
      }
      rmSync(daemonManagerIntentFile(space, home), { force: true });
      rmSync(refusalFile(space), { force: true });
    },
    async resume() {
      const recordRefusal = (space: string, error: unknown) => {
        const reason = safeDiagnostic(`could not resume hosted Manager: ${error instanceof Error ? error.message : String(error)}`).slice(0, 1500);
        // Keep the original records intact for diagnosis, and trust only the directory's identity.
        live.set(space, { view: { space, state: "refused", restarts: 0, reason, lastRefusal: reason, next: `inspect the hosted Manager records in ${join(home, "daemon", spaceSegment(space))}, then run cotal daemon setup --space ${space}` }, stopping: false, failures: 0 });
      };
      const intended = spaces();
      await Promise.all(intended.map(async (space) => {
        const invalid = recordError(space);
        if (invalid) { recordRefusal(space, new Error(invalid)); return; }
        try { await start(space); } catch (error) { recordRefusal(space, error); }
      }));
    },
    async close() {
      closed = true;
      await Promise.all([...live.values()].map(async (l) => {
        l.stopping = true;
        if (l.timer) clearTimeout(l.timer);
        if (l.healthTimer) clearTimeout(l.healthTimer);
        await stopChild(l);
        await l.healthTask;
        await l.starting;
      }));
    },
  };
}
