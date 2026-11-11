/** Per-space stock Manager children. Only an answered instance records a hosting intent. */
import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { appendFileSync, chmodSync, existsSync, lstatSync, readFileSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { assertLifecycleToken, mkSecretDir, parseRemoteEndpointDeregisterResult, registry, writeSecretFileAtomic, type AuthProvider } from "@cotal-ai/core";
import { remoteManagerClient } from "@cotal-ai/manager";
import { daemonArgv } from "@cotal-ai/cli/self-exec";
import { writeDefaultPersonaForLaunch } from "@cotal-ai/cli/default-persona";
import { loadIdpSession, withIdpSessionDir } from "@cotal-ai/auth";
import { findMesh, homeCotalDir, resolveControlTarget, spaceFromSegment, spaceSegment, userAuthStateDir, workspaceSecretStore } from "@cotal-ai/workspace";
import { askManager } from "@cotal-ai/workspace/control";
import { installedGenerationVersion, reconcileHostedConnectors, ReplacedDaemonGeneration } from "./generation.js";
import { daemonPaths, daemonPathsFor } from "./endpoint.js";
import { daemonStartedByOwnedService, installedDaemonIdentity, unitReceiptFile } from "./install.js";
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
export class HostedManagerRefusal extends Error {
  constructor(readonly code: "SEATS_ACTIVE" | "GENERATION_PENDING" | "MANAGER_UNAVAILABLE", message: string, readonly remedy: string) { super(message); }
}
interface Live {
  view: HostedManager;
  child?: ChildProcess;
  exited?: Promise<void>;
  starting?: Promise<HostedManager>;
  timer?: ReturnType<typeof setTimeout>;
  healthTimer?: ReturnType<typeof setTimeout>;
  healthTask?: Promise<void>;
  stopping: boolean;
  stopTask?: Promise<void>;
  failures: number;
  healthFailures?: number;
}

export function createHostedManagers(home = homeCotalDir(), version = installedGenerationVersion(), daemonHome?: string) {
  const homeArg = daemonHome === undefined ? undefined : /^[A-Za-z0-9_./-]+$/.test(daemonHome) ? daemonHome : JSON.stringify(daemonHome);
  const command = (text: string) => homeArg === undefined ? text : text.replace(/cotal daemon (setup|status|login|serve)\b(?! --daemon-home)/g, (match) => `${match} --daemon-home ${homeArg}`);
  let reconcileTask: Promise<void> | undefined;
  const reconcile = () => reconcileTask ??= reconcileHostedConnectors(version).finally(() => { reconcileTask = undefined; });
  const connectors = (data: unknown): HostedManager["connectors"] => (data as { connectors?: HostedManager["connectors"] } | undefined)?.connectors;
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
    const view = rawStatus(space);
    return { ...view, ...(view.next ? { next: command(view.next) } : {}), ...(view.reason ? { reason: command(view.reason) } : {}), ...(view.lastRefusal ? { lastRefusal: command(view.lastRefusal) } : {}) };
  };
  const rawStatus = (space: string): HostedManager => {
    const current = live.get(space);
    const invalid = recordError(space);
    if (invalid) return { ...(current?.view ?? { space, restarts: 0 }), pid: current?.child?.pid, state: "refused", reason: invalid, lastRefusal: invalid, next: `run cotal daemon setup --space ${space} to repair its hosting records` };
    if (current) return { ...current.view, pid: current.child?.pid };
    if (existsSync(refusalFile(space))) {
      const saved = JSON.parse(readFileSync(refusalFile(space), "utf8")) as HostedManager;
      if (saved.space === space && saved.state === "refused") return { ...saved, pid: undefined };
      throw new Error("invalid hosted Manager refusal record");
    }
    return { space, state: "stopped", restarts: 0 };
  };
  const probe = (space: string, selected: string) => withIdpSessionDir(home, async () => {
    const target = await resolveControlTarget({ space }, "control-caller-privileged", selected, { onRefusal: "throw", readOnly: true });
    return askManager(controlClient, space, target.server, "managerStatus", undefined, target.auth, "owner", 3000, { instanceId: selected });
  });
  const refresh = async (space: string): Promise<HostedManager> => {
    const l = live.get(space);
    if (generationPending && l?.child) return { ...status(space), state: "starting", reason: "an installed generation transition is pending", next: command(`wait for activation or read cotal daemon status --space ${space}`) };
    if (!l?.child || !l.view.instanceId || l.stopping || l.starting || recordError(space)) return status(space);
    const child = l.child, selected = l.view.instanceId;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      // This includes caller issuance, broker admission and contract resolution, not only status.
      const reply = await Promise.race([probe(space, selected), new Promise<never>((_, reject) => { deadline = setTimeout(() => reject(new Error("the pinned Manager status observation did not complete within 15000ms")), 15_000); })]);
      if (!reply.ok) throw new Error(reply.error ?? "the hosted Manager did not answer status");
      if (l.child === child && !l.stopping && !closed && !generationPending) l.view = { ...l.view, state: "answering", connectors: connectors(reply.data), reason: undefined, next: undefined, observedAt: new Date().toISOString() };
    } catch (error) {
      if (l.child === child && !l.stopping && !closed && !generationPending) l.view = { ...l.view, state: "starting", reason: safeDiagnostic(error instanceof Error ? error.message : String(error)).slice(0, 1500), observedAt: new Date().toISOString(), next: `inspect cotal daemon status --space ${space}; restore its connection, then run cotal daemon setup --space ${space}` };
    } finally { if (deadline) clearTimeout(deadline); }
    return status(space);
  };
  const observe = (l: Live) => {
    if (l.healthTimer) clearTimeout(l.healthTimer);
    if (closed || generationPending || l.stopping || !l.child) return;
    l.healthTimer = setTimeout(() => {
      l.healthTimer = undefined;
      const child = l.child;
      if (!child || l.starting || closed || generationPending || l.stopping) { observe(l); return; }
      const current = () => !closed && !generationPending && !l.stopping && l.child === child;
      l.healthTask = (async () => {
        try {
          const pending = generationAttempts.get(child);
          if (pending) {
            try { await generationCall(child, pending, "abort"); generationAttempts.delete(child); }
            catch { return; }
          }
          // Parent IPC proves child responsiveness without the daemon obtaining mesh credentials.
          await generationCall(child, randomUUID(), "inspect");
          if (current()) l.healthFailures = 0;
        } catch (error) {
          if (!current()) return;
          l.healthFailures = (l.healthFailures ?? 0) + 1;
          l.view = { ...l.view, state: "starting", reason: "the hosted Manager parent IPC probe did not answer", observedAt: new Date().toISOString(), next: `inspect cotal daemon status --space ${l.view.space}; restore the Manager connection or stop its seats before running cotal daemon setup --space ${l.view.space}` };
          if (l.healthFailures < 3) return;
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
    }, 5000 + Math.floor(Math.random() * 1000));
    l.healthTimer.unref();
  };
  function stopChild(l: Live): Promise<void> {
    return l.stopTask ??= stopChildOnce(l).finally(() => { l.stopTask = undefined; });
  }
  async function stopChildOnce(l: Live): Promise<void> {
    const child = l.child;
    if (!child) return;
    l.view = { ...l.view, state: "stopping", observedAt: new Date().toISOString() };
    // Retirement and deregistration need broker round trips even with no seats. Observe over
    // parent IPC before disconnecting, then allow five seconds per seat, capped at one minute.
    let seats: number | undefined;
    if (child.connected) {
      try { seats = await generationCall(child, randomUUID(), "inspect"); }
      catch { /* Unknown inventory receives the ceiling, never an assumed empty inventory. */ }
    }
    const graceMs = seats === undefined ? 60_000 : Math.min(60_000, 15_000 + seats * 5000);
    if (child.connected) child.disconnect();
    // Signal only this retained ChildProcess. Never rediscover a child from a recorded pid.
    const ended = async (ms: number) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try { return await Promise.race([l.exited!.then(() => true), new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), ms); })]); }
      finally { if (timer) clearTimeout(timer); }
    };
    if (await ended(graceMs)) l.view = { ...l.view, lastStop: "graceful" };
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
    if (closed || l.stopping || l.view.state === "refused") return;
    l.view = { ...l.view, state: "restarting", pid: l.child?.pid };
    if (generationPending) return;
    l.view = { ...l.view, restarts: l.view.restarts + 1 };
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
    try { await reconcile(); }
    catch (error) {
      const reason = `hosted connector reconciliation failed: ${error instanceof Error ? error.message : String(error)}`;
      if (error instanceof ReplacedDaemonGeneration) {
        const paths = daemonHome === undefined ? daemonPaths(process.env, home) : daemonPathsFor(daemonHome);
        let next: string;
        if (daemonStartedByOwnedService(paths, daemonHome)) {
          next = `the verified recorded native service will activate installed CLI ${error.installed} automatically after all hosted seats stop; read cotal daemon status --space ${space}`;
        } else if (existsSync(unitReceiptFile(paths))) {
          let evidence: string;
          try {
            const identity = installedDaemonIdentity(paths, daemonHome);
            evidence = identity.same ? "the recorded service has no verified native launch marker" : "the recorded service points to another installation";
          } catch {
            evidence = "the recorded service source could not be verified";
          }
          next = `${evidence}, so this daemon cannot activate itself; run cotal daemon setup --space ${space} from the installed CLI to verify the recorded service and restart it`;
        } else {
          next = `no recorded native service can activate this foreground daemon; explicitly stop the running foreground daemon, then run cotal daemon serve from the installed CLI`;
        }
        return refuse(l, reason, next);
      }
      refuse(l, reason, "correct the connector cause, run cotal ext seed --repair with the daemon's installed CLI, then retry setup; the daemon will retry automatically");
      if (!closed && !l.stopping && !generationPending) {
        const delay = Math.min(300_000, 5000 * 2 ** Math.min(l.failures++, 6));
        l.timer = setTimeout(() => {
          l.timer = undefined;
          if (closed || l.stopping || generationPending) return;
          l.starting = launch(l).catch((cause) => refuse(l, String(cause), `correct the cause and run cotal daemon setup --space ${space}`)).finally(() => { l.starting = undefined; });
        }, delay);
        l.timer.unref();
      }
      return { ...l.view };
    }
    if (closed || generationPending || l.stopping) return l.view;
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
    l.view = { ...l.view, state: "starting", reason: "waiting for the hosted Manager to initialize and register", observedAt: undefined };
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
    const child = spawn(node!, [...argv, "__machine-manager", "--space", space, "--runtime", "pty", "--console-port", "0", "--session-directory", home, "--expected-connector-generation", version], {
      cwd: root, env: { ...env, COTAL_SKIP_CONNECTOR_SEED: "1" }, windowsHide: true, stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    l.child = child;
    l.view = { ...l.view, pid: child.pid };
    let instanceId: string | undefined;
    let ready = false;
    child.on("message", (message: unknown) => {
      if (!message || typeof message !== "object") return;
      const frame = message as { kind?: unknown; instanceId?: unknown; reason?: unknown; terminal?: unknown; status?: unknown };
      if (frame.kind === "manager-refusal" && typeof frame.reason === "string") {
        nativeReason = safeDiagnostic(frame.reason).slice(0, 1500);
        authorityTerminal = frame.terminal === true;
        authorityStatus = typeof frame.status === "number" ? frame.status : undefined;
        return;
      }
      if (frame.kind === "manager-ready" && frame.instanceId === instanceId && instanceId !== undefined) {
        ready = true;
        l.view = { ...l.view, reason: "the hosted Manager initialized; verifying its pinned endpoint" };
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
        const lastLine = stderr.trim().split("\n").pop()?.slice(-500);
        const exitReason = `Manager exited (${signal ?? `code ${code}`})${lastLine ? `: ${lastLine}` : ""}`;
        l.view = { ...l.view, pid: undefined, lastExit: l.stopping && code === 0 && signal === null ? undefined : exitReason };
        if (!nativeReason) nativeReason = exitReason;
        if (!l.stopping && !closed && (l.view.state === "answering" || (l.view.state === "starting" && !l.starting))) {
          l.view = { ...l.view, reason: exitReason };
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
        if (instanceId && ready) {
          const selected = instanceId;
          l.view = { ...l.view, instanceId: selected };
          const reply = await probe(space, selected);
          if (reply.ok && !ended && !l.stopping && !closed) {
            const path = daemonManagerIntentFile(space, home);
            writeSecretFileAtomic(path, JSON.stringify({ v: 1, space }));
            rmSync(refusalFile(space), { force: true });
            l.view = { ...l.view, state: "answering", registrationCleanup: undefined, connectors: connectors(reply.data), reason: undefined, next: undefined, observedAt: new Date().toISOString() };
            l.failures = 0;
            observe(l);
            return { ...l.view };
          }
          last = reply.error;
        }
      } catch (error) {
        last = error;
        l.view = { ...l.view, reason: safeDiagnostic(error instanceof Error ? error.message : String(error)).slice(0, 1500), observedAt: new Date().toISOString() };
      }
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
    await startRaw(space);
    return status(space);
  };
  const startRaw = async (space: string): Promise<HostedManager> => {
    if (closed || generationPending) throw new HostedManagerRefusal("GENERATION_PENDING", "the daemon is stopping or preparing an installed generation transition", command(`wait for the installed generation transition, then run cotal daemon setup --space ${space}`));
    let l = live.get(space);
    if (!l) {
      const previous = status(space);
      // A start attempt does not supersede an unconfirmed deletion. Failed launches
      // must persist the same fence until a successor actually answers.
      l = { view: { space, state: "starting", restarts: 0,
        ...(previous.lastRefusal ? { lastRefusal: previous.lastRefusal } : {}),
        ...(previous.registrationCleanup === "unknown" ? { registrationCleanup: previous.registrationCleanup, instanceId: previous.instanceId } : {}),
      }, stopping: false, failures: 0 };
      live.set(space, l);
    }
    if (l.starting) return l.starting;
    if (l.child && l.view.instanceId) {
      try {
        const reply = await probe(space, l.view.instanceId);
        if (!reply.ok) throw new Error(reply.error ?? "the hosted Manager did not answer status");
        if (closed || l.stopping || !l.child) throw new Error("the hosted Manager is stopping");
        writeSecretFileAtomic(daemonManagerIntentFile(space, home), JSON.stringify({ v: 1, space }));
        rmSync(refusalFile(space), { force: true });
        l.view = { ...l.view, state: "answering", connectors: connectors(reply.data), reason: undefined, next: undefined, observedAt: new Date().toISOString() };
        if (!l.view.connectors?.some(connector => connector.state === "available")) {
          const child = l.child;
          const seats = await generationCall(child, randomUUID(), "inspect");
          if (seats === undefined || l.child !== child) throw new Error("the hosted Manager changed before its applications could be refreshed");
          if (seats > 0) throw new HostedManagerRefusal("SEATS_ACTIVE", `hosted Manager for ${space} holds ${seats} active seat(s); its applications cannot be refreshed`, command(`stop the seats through Manager ${l.view.instanceId} in space ${space}, then run cotal daemon setup --space ${space}`));
          const attempt = randomUUID();
          generationAttempts.set(child, attempt);
          l.stopping = true;
          if (l.healthTimer) { clearTimeout(l.healthTimer); l.healthTimer = undefined; }
          try {
            await l.healthTask;
            await generationCall(child, attempt, "prepare");
            if (closed || generationPending || l.child !== child) throw new Error("the hosted Manager changed before its applications could be refreshed");
            await stopChild(l);
            generationAttempts.delete(child);
            l.stopping = false;
            l.view = { ...l.view, state: "starting", restarts: l.view.restarts + 1 };
            l.starting = launch(l).finally(() => { l!.starting = undefined; });
            return await l.starting;
          } finally {
            l.stopping = false;
            if (l.child === child) {
              try { await generationCall(child, attempt, "abort"); generationAttempts.delete(child); }
              finally { observe(l); }
            }
          }
        }
      } catch (error) {
        if (error instanceof HostedManagerRefusal) throw error;
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
    start, status, refresh,
    async preparedGenerationEvidence(): Promise<{ prepared: boolean; managers: { space: string; seats: number; fenced: boolean }[] }> {
      // Only a prepared restart has evidence to give. An ordinary status asks no Manager anything.
      if (!generationPrepared) return { prepared: false, managers: [] };
      const rows = await Promise.all([...live.values()].filter(l => l.child).map(async l => {
        const child = l.child!;
        const seats = await generationCall(child, randomUUID(), "inspect");
        if (seats === undefined || l.child !== child) throw new Error(`hosted Manager for ${l.view.space} changed during prepared observation`);
        return { space: l.view.space, seats, fenced: generationPrepared && generationAttempts.has(child) };
      }));
      return { prepared: generationPrepared, managers: rows };
    },
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
          const seats = await generationCall(l.child, randomUUID(), "inspect");
          if (seats !== undefined && seats > 0) throw new HostedManagerRefusal("SEATS_ACTIVE", `hosted Manager for ${l.view.space} holds ${seats} active seat(s)`, command(`stop the seats through Manager ${l.view.instanceId} in space ${l.view.space}, then run cotal daemon setup --space ${l.view.space}`));
        }
        const readinessDeadline = Date.now() + 15_000;
        for (const l of live.values()) {
          if (!l.child) continue;
          if (l.view.state !== "answering") {
            const child = l.child, selected = l.view.instanceId;
            const deadline = readinessDeadline;
            let reason = l.view.reason ?? `last observed state is ${l.view.state}`;
            while (l.view.state !== "answering" && l.child === child && !closed && !l.stopping && selected && Date.now() < deadline) {
              let timer: ReturnType<typeof setTimeout> | undefined;
              try {
                const reply = await Promise.race([probe(l.view.space, selected), new Promise<never>((_, reject) => {
                  timer = setTimeout(() => reject(new Error("the pinned Manager status probe did not answer")), Math.min(3500, deadline - Date.now()));
                })]);
                if (!reply.ok) throw new Error(reply.error ?? "the hosted Manager refused status");
                if (l.child !== child || closed || l.stopping) break;
                l.view = { ...l.view, state: "answering", connectors: connectors(reply.data), reason: undefined, next: undefined, observedAt: new Date().toISOString() };
              } catch (error) { reason = safeDiagnostic(error instanceof Error ? error.message : String(error)).slice(0, 1000); }
              finally { if (timer) clearTimeout(timer); }
              if (l.view.state !== "answering") await pause(Math.min(250, Math.max(0, deadline - Date.now())));
            }
            if (l.child !== child || l.view.state !== "answering" || closed || l.stopping) throw new HostedManagerRefusal("MANAGER_UNAVAILABLE", `hosted Manager for ${l.view.space} could not confirm readiness for restart within 15s: ${reason}; no service restart was authorized`, command(`run cotal daemon status --space ${l.view.space}; restore its connection if needed, then run the same setup command again`));
          }
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
    async disconnect(space: string, options?: { account?: boolean }) {
      // A crash during child shutdown must not restore a withdrawn hosting intent.
      rmSync(daemonManagerIntentFile(space, home), { force: true });
      let l = live.get(space);
      if (l) {
        l.stopping = true;
        if (l.timer) clearTimeout(l.timer);
        if (l.healthTimer) clearTimeout(l.healthTimer);
        await stopChild(l);
        await l.healthTask;
        await l.starting;
      }
      if (!l) { l = { view: status(space), stopping: true, failures: 0 }; live.set(space, l); }
      const held = l;
      let instanceId = held.view.instanceId;
      const remedy = () => instanceId
        ? `inspect the registration, then run cotal endpoint deregister manager ${instanceId} --space ${space} --yes`
        : `inspect the recorded Manager identity for ${space}, then remove its registration with cotal endpoint deregister manager <instance-id> --space ${space} --yes`;
      const incomplete = (reason: string): never => {
        refuse(held, reason, remedy());
        throw new HostedManagerRefusal("MANAGER_UNAVAILABLE", reason, command(remedy()));
      };
      if (held.view.registrationCleanup === "unknown") incomplete("Manager registration removal is unconfirmed; no automatic request was repeated");
      try { instanceId = remoteManagerClient.loadRemoteManagerInstanceId(daemonManagerRoot(space, home), space) ?? instanceId; }
      catch { incomplete("the recorded Manager identity could not be read; its registration may be left behind"); }
      if (instanceId) {
        held.view = { ...held.view, instanceId };
        const entry = findMesh(space);
        const provider = entry?.mode === "user" && entry.userAuth && registry.has("auth-provider", entry.userAuth.provider)
          ? registry.resolve<AuthProvider>("auth-provider", entry.userAuth.provider) : undefined;
        if (!entry || !provider?.deregisterEndpoint) return incomplete("Manager registration is left behind; guarded removal is unsupported for this space");
        const deregister = provider.deregisterEndpoint.bind(provider);
        const request = { v: 1, kind: "endpoint-deregister", space, endpoint: "manager", instanceId } as const;
        // A process death or lost response after this write is an unknown outcome on restart.
        held.view = { ...held.view, registrationCleanup: "unknown" };
        refuse(held, "Manager registration removal is unconfirmed", remedy());
        let result;
        try {
          result = parseRemoteEndpointDeregisterResult(await withIdpSessionDir(home, () => deregister({
            store: workspaceSecretStore(entry.root), dir: userAuthStateDir(entry.root, space, { readOnly: true }), request,
          })), request);
        } catch (error) {
          if ((error as { outcome?: unknown }).outcome === "refused") held.view = { ...held.view, registrationCleanup: undefined };
          return incomplete("Manager registration is left behind; guarded removal did not confirm its deletion");
        }
        if (result.state === "unknown") return incomplete(`Manager registration removal is unconfirmed: ${result.condition}; no automatic request will be repeated`);
        held.view = { ...held.view, registrationCleanup: undefined };
        if (result.state !== "removed" && result.condition !== "not-registered") incomplete(`Manager registration is left behind; guarded removal refused: ${result.condition}`);
      }
      held.view = { ...held.view, state: "stopped", pid: undefined, reason: undefined, lastRefusal: undefined, next: options?.account ? "enable this space for this computer in the dashboard to host its Manager again" : `run cotal daemon setup --space ${space} to host its Manager again` };
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
