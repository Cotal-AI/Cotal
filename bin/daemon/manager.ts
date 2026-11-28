/** Per-space stock Manager children. Only an answered instance records a hosting intent. */
import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { appendFileSync, chmodSync, existsSync, lstatSync, readFileSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { Worker } from "node:worker_threads";
import {
  assertLifecycleToken, BASELINE_LIFECYCLE_ENDPOINT, controlReplyFrom, dialerFor, drainAndClose,
  invokeRepairingSplit, issuedUserCaller, jwtFromCreds, mkSecretDir, parseRemoteEndpointDeregisterResult,
  registry, resolveService, standaloneConnectOpts, unansweredRequest, writeSecretFileAtomic,
  type AuthProvider, type EpCaller,
} from "@cotal-ai/core";
import { daemonArgv } from "@cotal-ai/cli/self-exec";
import { writeDefaultPersonaForLaunch } from "@cotal-ai/cli/default-persona";
import { loadIdpSession, retainManagerAuthorityRoute, withIdpSessionDir } from "@cotal-ai/auth";
import { CommandFailure, controlCaller, findMesh, homeCotalDir, isCommandFailure, liveUpdateClosureOwner, readUpdateRecovery, resolveControlTarget, spaceFromSegment, spaceSegment, userAuthStateDir, workspaceSecretStore } from "@cotal-ai/workspace";
import { DIAL_TIMEOUT_MS, DialNotAdmitted, askManager, dialWithRetry, epRailFailure, managerFailure, notAdmittedRefusal } from "@cotal-ai/workspace/control";
import { installedGenerationVersion, reconcileHostedConnectors, ReplacedDaemonGeneration, UnprotectedConnectorConfig } from "./generation.js";
import { daemonPaths, daemonPathsFor } from "./endpoint.js";
import { daemonStartedByOwnedService, installedDaemonIdentity, unitReceiptFile } from "./install.js";
import type { HostedManager, HostedAgents, ManagerConnection } from "./protocol.js";
import { readHostedAgents, readServeBound } from "./agents.js";
import { lostConnection } from "./lost-connection.js";
import { readManagerCleanup, writeManagerCleanup, validateManagerCleanupAuthority, managerCleanupFile } from "./manager-cleanup.js";
import { processBirth } from "./lifetime.js";
import { probeLiveness } from "@cotal-ai/workspace/liveness";
import { hostedManagerChildren } from "./manager-children.js";

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
export interface ProbeSession {
  readonly child: ChildProcess;
  readonly instanceId: string;
  readonly nc: Awaited<ReturnType<ReturnType<typeof dialerFor>>>;
  readonly caller: EpCaller;
  readonly expiresAtMs: number;
}
export interface Live {
  view: HostedManager;
  agents?: HostedAgents;
  child?: ChildProcess;
  exited?: Promise<void>;
  starting?: Promise<HostedManager>;
  refreshing?: Promise<HostedManager>;
  probeSession?: ProbeSession;
  probeOpening?: Promise<ProbeSession>;
  exchangeFailedUntil?: number;
  lastExchangeError?: unknown;
  timer?: ReturnType<typeof setTimeout>;
  healthTimer?: ReturnType<typeof setTimeout>;
  healthTask?: Promise<void>;
  stopping: boolean;
  stopTask?: Promise<void>;
  failures: number;
  healthFailures?: number;
  /** Consecutive health checks in which the Manager graded its serve connection unbound. */
  unboundSamples?: number;
  /** The wait before the next re-read of a connected Manager left `starting`, and when it ends. */
  rereadWait?: number;
  rereadAt?: number;
}

async function selectRunningAgent(local: Live | undefined, lifecycleUid: string) {
  const child = local?.child;
  const instanceId = local?.view.instanceId;
  if (!local || !child || !instanceId || local.stopping || local.view.state !== "answering")
    throw new CommandFailure("refused", "TARGET_UNAVAILABLE", "The Manager for this local agent is not answering.");
  const selected = (await readHostedAgents(child)).find(agent => agent.lifecycleUid === lifecycleUid);
  if (!selected?.id || selected.state !== "running")
    throw new CommandFailure("refused", "TARGET_NOT_FOUND", "The selected local agent is no longer running.");
  if (local.child !== child || local.stopping || local.view.instanceId !== instanceId)
    throw new CommandFailure("refused", "TARGET_UNAVAILABLE", "The local Manager changed before the action could start.");
  return { local, child, instanceId, name: selected.name, expectedTarget: { id: selected.id, lifecycleUid } };
}

function hostedAgentActions(home: string, live: ReadonlyMap<string, Live>) {
  return {
    async terminalAgent(space: string, lifecycleUid: string): Promise<{ argv: string[] }> {
      const { name, instanceId } = await selectRunningAgent(live.get(space), lifecycleUid);
      const argv = daemonArgv();
      return { argv: [argv[0]!, argv.at(-1)!, "attach", name, "--on", instanceId, "--space", space] };
    },
    async stopAgent(space: string, lifecycleUid: string): Promise<void> {
      const { local, child, instanceId, name, expectedTarget } = await selectRunningAgent(live.get(space), lifecycleUid);
      await withIdpSessionDir(home, async () => {
        const target = await resolveControlTarget({ space }, "control-caller-admin", instanceId, { onRefusal: "throw" });
        if (local.child !== child || local.stopping || local.view.instanceId !== instanceId)
          throw new CommandFailure("refused", "TARGET_UNAVAILABLE", "The local Manager changed before Stop was sent.");
        const reply = await askManager({ versionSkew: text => text, roster: async () => [] }, space, target.server, "stop", { name, graceful: true }, target.auth, target.auth.bearer ? "owner" : "any", undefined, { instanceId, expectedTarget });
        if (!reply.ok) throw managerFailure(reply, "agent stop", { space, managerInstanceId: instanceId, agent: name });
        if ((reply.data as { stopped?: boolean } | undefined)?.stopped !== true)
          throw new CommandFailure("unknown", "OPERATION_UNKNOWN", "The Manager did not confirm that it stopped the agent. Check the agent list before trying again.");
      });
    },
  };
}

export function createHostedManagers(home = homeCotalDir(), version = installedGenerationVersion(), daemonHome?: string, onChange?: () => void) {
  const notify = () => { try { onChange?.(); } catch {} };
  const { generationCall, isRateLimited, closeProbeSession, stopChild, spaces } = hostedManagerChildren({ home, notify });
  const homeArg = daemonHome === undefined ? undefined : /^[A-Za-z0-9_./-]+$/.test(daemonHome) ? daemonHome : JSON.stringify(daemonHome);
  const command = (text: string) => homeArg === undefined ? text : text.replace(/cotal daemon (setup|status|login|serve)\b(?! --daemon-home)/g, (match) => `${match} --daemon-home ${homeArg}`);
  let reconcileTask: Promise<void> | undefined;
  const reconcile = () => reconcileTask ??= reconcileHostedConnectors(version).finally(() => { reconcileTask = undefined; });
  let runtimeTask: Promise<string> | undefined;
  const retainAppRuntime = (source: string): Promise<string> => runtimeTask ??= new Promise<string>((resolve, reject) => {
    const worker = new Worker(new URL("./manager-runtime-worker.js", import.meta.url), { workerData: { home, source }, execArgv: [] });
    worker.once("message", resolve);
    worker.once("error", reject);
    worker.once("exit", (code) => reject(new Error(`desktop Manager runtime worker exited without a result (${code})`)));
  }).finally(() => { runtimeTask = undefined; });
  const connectors = (data: unknown): HostedManager["connectors"] => (data as { connectors?: HostedManager["connectors"] } | undefined)?.connectors;
  const live = new Map<string, Live>();
  let closed = false;
  let generationPending = false;
  let generationPrepared = false;
  let generationTask = Promise.resolve();
  const generationOwners = new Set<string>();
  const generationReleases = new Set<string>();
  let generationAcquisitions = 0;
  const queueGeneration = (operation: () => Promise<void>): Promise<void> => {
    const task = generationTask.then(operation);
    generationTask = task.catch(() => {});
    return task;
  };
  const generationAttempts = new Map<ChildProcess, string>();
  const abortGenerationRestart = (owner: string): Promise<void> => queueGeneration(async () => {
    if (!generationOwners.delete(owner) && !generationReleases.has(owner)) return;
    if (generationOwners.size !== 0) return;
    generationReleases.add(owner);
    generationPrepared = false;
    for (const [child, attemptId] of generationAttempts) {
      await generationCall(child, attemptId, "abort");
      generationAttempts.delete(child);
    }
    generationReleases.clear();
    generationPending = generationAcquisitions !== 0;
    if (!generationPending) for (const l of live.values()) {
      if (!l.child && !l.starting && !l.timer && l.view.state === "restarting") schedule(l);
      else if (l.child) observe(l);
    }
  });
  let reapingGeneration = false;
  const generationReaper = setInterval(() => {
    if (closed || reapingGeneration) return;
    reapingGeneration = true;
    void (async () => {
      for (const owner of new Set([...generationOwners, ...generationReleases])) {
        let record: unknown;
        try { record = JSON.parse(owner); } catch { continue; }
        if (!Array.isArray(record) || record[0] !== "peer" || !Number.isSafeInteger(record[2]) || typeof record[3] !== "string") continue;
        const pid = record[2] as number;
        try {
          const start = processBirth(pid);
          if (start !== undefined ? start !== record[3] : probeLiveness(pid) === "dead") {
            await abortGenerationRestart(owner);
            console.log(`machine daemon: released the preserving hold of updater ${pid} because that process ended`);
          }
        } catch { /* Unknown custody keeps the fence and retries on the next bounded observation. */ }
      }
    })().finally(() => { reapingGeneration = false; });
  }, 1000);
  generationReaper.unref();
  const refusalFile = (space: string) => join(home, "daemon", spaceSegment(space), "manager-refusal.json");
  const recordError = (space: string): string | undefined => {
    try { readManagerCleanup(home, space); } catch { return `invalid hosted Manager cleanup record: ${managerCleanupFile(home, space)}`; }
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
  const refuse = (l: Live, reason: string, next: string, reasonDetail?: HostedManager["reasonDetail"]) => {
    reason = safeDiagnostic(reason).slice(0, 1500);
    l.view = { ...l.view, state: "refused", reason, reasonCode: reasonDetail ? "CONNECTOR_CONFIG_UNPROTECTED" : undefined, reasonDetail, lastRefusal: reason, next };
    persistRefusal(l);
    notify();
    return l.view;
  };
  const status = (space: string): HostedManager => {
    const view = rawStatus(space);
    return { ...view, ...(view.next ? { next: command(view.next) } : {}), ...(view.reason ? { reason: command(view.reason) } : {}), ...(view.lastRefusal ? { lastRefusal: command(view.lastRefusal) } : {}) };
  };
  const rawStatus = (space: string): HostedManager => {
    const current = live.get(space);
    const invalid = recordError(space);
    if (invalid) return { ...(current?.view ?? { space, restarts: 0 }), pid: current?.child?.pid, state: "refused", reason: invalid, lastRefusal: invalid, next: `run \`cotal daemon setup --space ${space}\` to repair its hosting records` };
    if (current) return { ...current.view, pid: current.child?.pid };
    const cleanup = readManagerCleanup(home, space);
    if (cleanup && cleanup.phase !== "hosted") return {
      space, restarts: 0, instanceId: cleanup.instanceId,
      state: cleanup.phase === "unknown" ? "refused" : "stopped", registrationCleanup: cleanup.phase,
      reason: cleanup.phase === "unknown" ? "Manager registration removal is unconfirmed; no automatic request will be repeated" : "Manager stopped here; registration cleanup pending",
      next: `inspect the registration, then run \`cotal endpoint deregister manager ${cleanup.instanceId} --space ${space} --yes\``,
    };
    if (existsSync(refusalFile(space))) {
      const saved = JSON.parse(readFileSync(refusalFile(space), "utf8")) as HostedManager;
      if (saved.space === space && saved.state === "refused") return { ...saved, pid: undefined };
      throw new Error("invalid hosted Manager refusal record");
    }
    return { space, state: "stopped", restarts: 0 };
  };
  const openProbeSession = async (l: Live, child: ChildProcess, selected: string): Promise<ProbeSession> => {
    if (l.exchangeFailedUntil !== undefined && Date.now() < l.exchangeFailedUntil) {
      throw l.lastExchangeError ?? new Error("hosted Manager status exchange failed recently; retrying after backoff");
    }
    let nc: Awaited<ReturnType<ReturnType<typeof dialerFor>>> | undefined;
    try {
      const target = await withIdpSessionDir(home, () => resolveControlTarget({ space: l.view.space }, "control-caller-privileged", selected, { onRefusal: "throw", readOnly: true }));
      const who = controlCaller(target.auth);
      if ("refusal" in who) throw new Error(who.refusal);
      let connectOpts: Record<string, unknown> = {};
      nc = await dialWithRetry(() => {
        connectOpts = standaloneConnectOpts(target.auth.creds ? { creds: target.auth.creds, tls: target.auth.tls === true } : target.auth.bearer ? { bearer: target.auth.bearer, sentinelCreds: target.auth.sentinelCreds, tls: target.auth.tls === true } : { tls: target.auth.tls === true });
        return dialerFor(target.server)({ servers: target.server, ...connectOpts, timeout: DIAL_TIMEOUT_MS, maxReconnectAttempts: 0 });
      }).catch((e: unknown) => {
        if (!(e instanceof DialNotAdmitted)) throw e;
        throw notAdmittedRefusal(e, `manager instance ${selected}`, "nothing was sent to the manager", { space: l.view.space, managerInstanceId: selected }, target.auth.bearer !== undefined);
      });
      const caller = target.auth.bearer !== undefined && target.auth.managerInstanceId !== undefined
        ? await issuedUserCaller(nc, l.view.space, String(connectOpts.name), who.caller)
        : who.caller;
      const token = target.auth.bearer ?? jwtFromCreds(target.auth.creds ?? "");
      let expiresAtMs = Date.now() + 300_000;
      if (token) {
        try {
          const payload = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8")) as { exp?: unknown };
          if (typeof payload.exp === "number" && Number.isFinite(payload.exp)) expiresAtMs = payload.exp * 1000;
        } catch {}
      }
      if (closed || l.stopping || l.child !== child || (l.view.instanceId !== undefined && l.view.instanceId !== selected)) {
        void drainAndClose(nc, 2000).catch(() => {});
        throw new Error("the hosted Manager changed or stopped while opening its control session");
      }
      const session: ProbeSession = { child, instanceId: selected, nc, caller, expiresAtMs };
      l.exchangeFailedUntil = undefined;
      l.lastExchangeError = undefined;
      l.probeSession = session;
      void nc.closed().then(() => { if (l.probeSession === session) l.probeSession = undefined; });
      return session;
    } catch (error) {
      if (nc) void drainAndClose(nc, 2000).catch(() => {});
      l.exchangeFailedUntil = Date.now() + 5000;
      l.lastExchangeError = error;
      throw error;
    }
  };
  const probe = async (l: Live, selected: string) => {
    const child = l.child;
    if (!child) return { ok: false as const, error: "the hosted Manager is not running" };
    let session = l.probeSession;
    if (session && (session.child !== child || session.instanceId !== selected || session.nc.isClosed() || Date.now() + 30_000 >= session.expiresAtMs)) {
      closeProbeSession(l, session);
      session = undefined;
    }
    if (!session) {
      session = await (l.probeOpening ??= openProbeSession(l, child, selected).finally(() => { l.probeOpening = undefined; }));
    }
    try {
      const service = await resolveService(session.nc, l.view.space, BASELINE_LIFECYCLE_ENDPOINT, session.caller, { deadlineMs: 10_000, commands: ["status"], instanceId: selected });
      const r = await invokeRepairingSplit(session.nc, l.view.space, service, "status", undefined, { deadlineMs: 3000, id: randomUUID() });
      if (r.reply.ok !== true) {
        closeProbeSession(l, session);
        return { ok: false as const, error: controlReplyFrom(r.reply).error ?? "the hosted Manager did not answer status" };
      }
      return { ok: true as const, data: r.reply.data };
    } catch (error) {
      if (!unansweredRequest(error) || session.nc.isClosed()) {
        closeProbeSession(l, session);
        l.exchangeFailedUntil = Date.now() + 5000;
        l.lastExchangeError = error;
      }
      return { ok: false as const, error: epRailFailure(controlClient, error, { instanceId: selected }).error ?? (error instanceof Error ? error.message : String(error)) };
    }
  };
  const refresh = async (space: string): Promise<HostedManager> => {
    const l = live.get(space);
    if (generationPending && l?.child) return { ...status(space), state: "starting", reason: "an installed generation transition is pending", next: command(`wait for activation or read \`cotal daemon status --space ${space}\``) };
    if (!l?.child || !l.view.instanceId || l.stopping || l.starting || recordError(space)) return status(space);
    return l.refreshing ??= (async () => {
      const child = l.child!, selected = l.view.instanceId!, before = l.view.state;
      let deadline: ReturnType<typeof setTimeout> | undefined;
      try {
        // This includes caller issuance, broker admission and contract resolution, not only status.
        const reply = await Promise.race([probe(l, selected), new Promise<never>((_, reject) => { deadline = setTimeout(() => reject(new Error("the pinned Manager status observation did not complete within 15000ms")), 15_000); })]);
        if (!reply.ok) throw new Error(reply.error ?? "the hosted Manager did not answer status");
        if (l.child === child && !l.stopping && !closed && !generationPending) l.view = { ...l.view, state: "answering", connectors: connectors(reply.data), reason: undefined, lastRefusal: undefined, next: undefined, observedAt: new Date().toISOString() };
      } catch (error) {
        if (l.child === child && !l.stopping && !closed && !generationPending) {
          const reason = safeDiagnostic(error instanceof Error ? error.message : String(error)).slice(0, 1500);
          if (!isRateLimited(error)) {
            l.view = { ...l.view, state: "starting", reason, observedAt: new Date().toISOString(), next: `inspect \`cotal daemon status --space ${space}\`; restore its connection, then run \`cotal daemon setup --space ${space}\`` };
          } else if (l.view.observedAt === undefined) {
            l.view = { ...l.view, state: "starting", reason, next: `wait for the CLI connect limit to refill, then run \`cotal daemon status --space ${space}\` again` };
          }
        }
      } finally { if (deadline) clearTimeout(deadline); }
      // A status read that changed what this Manager reports reaches the live feed too.
      if (l.view.state !== before) notify();
      return status(space);
    })().finally(() => { l.refreshing = undefined; });
  };
  /** Why `space` cannot be reached. The loss itself is the Manager's own grade; the mesh record only
   *  tells no internet from a space that is not answering, so a record that cannot be read still
   *  leaves the loss to report, with the reason it could not be told apart. */
  const describeLoss = async (space: string): Promise<ManagerConnection> => {
    try {
      const server = findMesh(space)?.server;
      if (!server) throw new Error("no mesh record names its server");
      return await lostConnection(server);
    } catch (error) {
      return { state: "unreachable", reason: `the space is not answering, and its address could not be checked: ${safeDiagnostic(error instanceof Error ? error.message : String(error)).slice(0, 300)}` };
    }
  };
  /** The Manager's own grade of its serve connection. A Manager that came up and then lost it reports
   *  why. Once it reconnects the problem clears, and a Manager a failed status probe left `starting`
   *  is read again until it answers. */
  const observeConnection = async (l: Live, child: ChildProcess, current: () => boolean) => {
    if (l.starting || !l.view.instanceId) return;
    let bound: boolean;
    // A Manager built before this question does not answer it, which says nothing about its connection.
    try { bound = await readServeBound(child); } catch { return; }
    if (!current()) return;
    if (bound) {
      l.unboundSamples = 0;
      if (l.view.connection) {
        console.log(`machine daemon: the hosted Manager for ${l.view.space} is connected again`);
        l.view = { ...l.view, connection: undefined };
        notify();
      }
      // A status read that failed during a loss, or just after it while the space's exchange was not
      // back yet, leaves `starting`. While the app only watches, nothing else reads again. Each read
      // dials the space, so the first comes at once and later ones wait longer, up to 30 s.
      if (l.view.state !== "starting") { l.rereadWait = undefined; l.rereadAt = undefined; return; }
      if (Date.now() < (l.rereadAt ?? 0)) return;
      l.rereadWait = Math.min(30_000, (l.rereadWait ?? 2500) * 2);
      l.rereadAt = Date.now() + l.rereadWait;
      void refresh(l.view.space).catch(() => {});
      return;
    }
    l.rereadWait = undefined; l.rereadAt = undefined;
    // One unbound check can be a re-dial already under way; a loss is two checks in a row.
    l.unboundSamples = (l.unboundSamples ?? 0) + 1;
    if (l.unboundSamples < 2) return;
    const connection = await describeLoss(l.view.space);
    if (!current() || l.starting) return;
    const known = l.view.connection;
    if (known?.state === connection.state && known.reason === connection.reason) return;
    l.view = { ...l.view, connection };
    // The service's log is bounded. A lookup that fails with a different code each time changes only
    // the reason, which the feed carries, so the log gets one line per loss and per change of state.
    if (known?.state !== connection.state) console.log(`machine daemon: the hosted Manager for ${l.view.space} lost its connection (${connection.state}): ${connection.reason}`);
    notify();
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
          if (current()) {
            l.healthFailures = 0;
            try {
              const agents = await readHostedAgents(child);
              if (current()) {
                const prevKey = l.agents?.state === "read" ? JSON.stringify(l.agents.agents) : l.agents?.state;
                const nextKey = JSON.stringify(agents);
                l.agents = { space: l.view.space, observedAt: new Date().toISOString(), state: "read", agents };
                if (prevKey !== nextKey) notify();
              }
            } catch {
              if (current()) {
                const prevState = l.agents?.state;
                l.agents = { space: l.view.space, observedAt: new Date().toISOString(), state: "unreadable", message: "Could not read agents for this space." };
                if (prevState !== "unreadable") notify();
              }
            }
            await observeConnection(l, child, current);
          }
        } catch (error) {
          if (!current()) return;
          l.healthFailures = (l.healthFailures ?? 0) + 1;
          l.view = { ...l.view, state: "starting", reason: "the hosted Manager parent IPC probe did not answer", observedAt: new Date().toISOString(), next: `inspect \`cotal daemon status --space ${l.view.space}\`; restore the Manager connection or stop its seats before running \`cotal daemon setup --space ${l.view.space}\`` };
          notify();
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
  const schedule = (l: Live) => {
    if (closed || l.stopping || l.view.state === "refused") return;
    l.view = { ...l.view, state: "restarting", pid: l.child?.pid };
    if (generationPending) { notify(); return; }
    l.view = { ...l.view, restarts: l.view.restarts + 1 };
    notify();
    const delay = Math.min(30_000, 1000 * 2 ** Math.min(l.failures++, 5));
    l.timer = setTimeout(() => {
      l.timer = undefined;
      l.starting = launch(l).catch((error) => refuse(l, (error as Error).message, `correct the cause and run \`cotal daemon setup --space ${l.view.space}\``)).finally(() => { l.starting = undefined; });
      void l.starting.catch(() => {});
    }, delay);
  };
  async function launch(l: Live): Promise<HostedManager> {
    const space = l.view.space;
    if (closed || generationPending || l.stopping) return l.view;
    const entry = findMesh(space);
    if (!entry) return refuse(l, "this space is no longer registered on this machine", `run \`cotal daemon setup --space ${space} --idp <url>\` to discover it again`);
    if (entry.mode !== "user" || entry.userAuth?.remote !== true) return refuse(l, "hosted Managers require a registered user-auth participant space", "use `cotal manager start` from the folder that hosts the space");
    if (!loadIdpSession(home, entry.userAuth.idp.url)) return refuse(l, "the daemon has no sign-in for this space's provider", `run \`cotal daemon login --idp ${entry.userAuth.idp.url}\`, then \`cotal daemon setup --space ${space}\``);
    try { await reconcile(); }
    catch (error) {
      const reason = `hosted connector reconciliation failed: ${error instanceof Error ? error.message : String(error)}`;
      if (error instanceof ReplacedDaemonGeneration) {
        const paths = daemonHome === undefined ? daemonPaths(process.env, home) : daemonPathsFor(daemonHome);
        let next: string;
        if (daemonStartedByOwnedService(paths, daemonHome)) {
          next = `the verified recorded native service will activate installed CLI ${error.installed} automatically after all hosted seats stop; read \`cotal daemon status --space ${space}\``;
        } else if (existsSync(unitReceiptFile(paths))) {
          let evidence: string;
          try {
            const identity = installedDaemonIdentity(paths, daemonHome);
            evidence = identity.same ? "the recorded service has no verified native launch marker" : "the recorded service points to another installation";
          } catch {
            evidence = "the recorded service source could not be verified";
          }
          next = `${evidence}, so this daemon cannot activate itself; run \`cotal daemon setup --space ${space}\` from the installed CLI to verify the recorded service and restart it`;
        } else {
          next = `no recorded native service can activate this foreground daemon; explicitly stop the running foreground daemon, then run \`cotal daemon serve\` from the installed CLI`;
        }
        return refuse(l, reason, next);
      }
      if (error instanceof UnprotectedConnectorConfig) refuse(l, error.message, error.remedy, error.detail);
      else refuse(l, reason, "correct the connector cause, run \`cotal ext seed --repair\` with the daemon's installed CLI, then retry setup; the daemon will retry automatically");
      if (!closed && !l.stopping && !generationPending) {
        const delay = Math.min(300_000, 5000 * 2 ** Math.min(l.failures++, 6));
        l.timer = setTimeout(() => {
          l.timer = undefined;
          if (closed || l.stopping || generationPending) return;
          l.starting = launch(l).catch((cause) => refuse(l, String(cause), `correct the cause and run \`cotal daemon setup --space ${space}\``)).finally(() => { l.starting = undefined; });
        }, delay);
        l.timer.unref();
      }
      return { ...l.view };
    }
    if (closed || generationPending || l.stopping) return l.view;
    const savedCleanup = readManagerCleanup(home, space);
    const storeIdentity = workspaceSecretStore(entry.root).identity;
    if (storeIdentity.kind !== "fs") throw new Error("hosted Manager cleanup requires the original filesystem store identity");
    if (savedCleanup) {
      validateManagerCleanupAuthority(savedCleanup);
      if (savedCleanup.root !== entry.root || savedCleanup.provider !== entry.userAuth.provider || JSON.stringify(savedCleanup.storeIdentity) !== JSON.stringify(storeIdentity))
        throw new Error("the hosted Manager cleanup coordinates do not match this space's authority");
    } else {
      writeManagerCleanup(home, { version: 1, space, root: entry.root, provider: entry.userAuth.provider, storeIdentity, phase: "hosted" });
    }
    if (entry.userAuth.provider === "cotal") await retainManagerAuthorityRoute(workspaceSecretStore(entry.root), userAuthStateDir(entry.root, space, { readOnly: true }), space);
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
    let [node, ...argv] = daemonArgv();
    const source = dirname(dirname(argv.at(-1)!));
    if ((process.platform === "darwin" || process.platform === "linux") && existsSync(join(source, "desktop-runtime.json"))) {
      const retained = await retainAppRuntime(source);
      if (closed || generationPending || l.stopping) return l.view;
      node = join(retained, "cotal-node");
      argv[argv.length - 1] = join(retained, "runtime", "dist", "cotal.js");
    }
    closeProbeSession(l);
    l.exchangeFailedUntil = undefined;
    l.lastExchangeError = undefined;
    l.view = { ...l.view, state: "starting", reason: "waiting for the hosted Manager to initialize and register", reasonCode: undefined, reasonDetail: undefined, next: undefined, observedAt: undefined };
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
    // The native service does not inherit the updater's environment. Delegate only from the
    // verified journal for this generation, so boot can materialize connectors under its closure.
    const recovery = readUpdateRecovery();
    if (recovery?.phase === "verified-ready" && recovery.installed === version && recovery.owner && liveUpdateClosureOwner(recovery)) {
      env.COTAL_UPDATE_CLOSURE_OWNER = String(recovery.owner.pid);
      env.COTAL_UPDATE_CLOSURE_NONCE = recovery.owner.nonce;
      env.COTAL_UPDATE_CLOSURE_START = recovery.owner.start;
      env.COTAL_UPDATE_CLOSURE_TRANSACTION = "1";
    }
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
      try {
        const nextInstanceId = assertLifecycleToken(frame.instanceId, "instanceId");
        if (instanceId !== undefined && instanceId !== nextInstanceId) closeProbeSession(l);
        instanceId = nextInstanceId;
      } catch { /* an invalid frame never selects another instance */ }
    });
    let ended = false;
    l.exited = new Promise<void>((resolve) => {
      child.once("error", (error) => { closeProbeSession(l); nativeReason = safeDiagnostic(error.message).slice(0, 1500); ended = true; resolve(); });
      child.once("exit", (code, signal) => {
        closeProbeSession(l);
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
        l.unboundSamples = 0;
        l.view = { ...l.view, pid: undefined, connection: undefined, lastExit: l.stopping && code === 0 && signal === null ? undefined : exitReason };
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
          const reply = await probe(l, selected);
          if (reply.ok && !ended && !l.stopping && !closed) {
            const path = daemonManagerIntentFile(space, home);
            const cleanup = readManagerCleanup(home, space);
            if (!cleanup || cleanup.instanceId !== selected) throw new Error("the answering Manager has no matching durable cleanup identity");
            writeManagerCleanup(home, { ...cleanup, phase: "hosted" });
            writeSecretFileAtomic(path, JSON.stringify({ v: 1, space }));
            rmSync(refusalFile(space), { force: true });
            l.view = { ...l.view, state: "answering", registrationCleanup: undefined, connectors: connectors(reply.data), reason: undefined, lastRefusal: undefined, next: undefined, observedAt: new Date().toISOString() };
            l.failures = 0;
            try { l.agents = { space, observedAt: new Date().toISOString(), state: "read", agents: await readHostedAgents(child) }; } catch {}
            notify();
            observe(l);
            return { ...l.view };
          }
          last = reply.error;
        }
      } catch (error) {
        last = error;
        const reason = safeDiagnostic(error instanceof Error ? error.message : String(error)).slice(0, 1500);
        l.view = isRateLimited(error)
          ? { ...l.view, state: "starting", reason, next: `wait for the CLI connect limit to refill, then run \`cotal daemon status --space ${space}\` again` }
          : { ...l.view, reason, observedAt: new Date().toISOString() };
      }
      await pause(250);
    }
    await stopChild(l);
    if (closed || l.stopping) return l.view;
    const reason = safeDiagnostic(nativeReason ?? (last instanceof Error ? last.message : typeof last === "string" ? last : "the Manager exited before answering status")).replaceAll("`cotal login --idp ", "`cotal daemon login --idp ").slice(0, 1500);
    if (authorityTerminal) return refuse(l, reason, authorityStatus === 403
      ? `ask the space owner to grant your cli actor the supervise scope, then run \`cotal daemon setup --space ${space}\``
      : `run \`cotal daemon login --idp ${entry.userAuth.idp.url}\`, correct the reported cause, then run \`cotal daemon setup --space ${space}\``);
    l.view = { ...l.view, reason, next: `read \`cotal daemon status --space ${space}\`; the daemon will retry` };
    schedule(l);
    return { ...l.view };
  }
  const start = async (space: string): Promise<HostedManager> => {
    await startRaw(space);
    return status(space);
  };
  const startRaw = async (space: string): Promise<HostedManager> => {
    if (closed || generationPending) throw new HostedManagerRefusal("GENERATION_PENDING", "the daemon is stopping or preparing an installed generation transition", command(`wait for the installed generation transition, then run \`cotal daemon setup --space ${space}\``));
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
        const reply = await probe(l, l.view.instanceId);
        if (!reply.ok) throw new Error(reply.error ?? "the hosted Manager did not answer status");
        if (closed || l.stopping || !l.child) throw new Error("the hosted Manager is stopping");
        writeSecretFileAtomic(daemonManagerIntentFile(space, home), JSON.stringify({ v: 1, space }));
        rmSync(refusalFile(space), { force: true });
        l.view = { ...l.view, state: "answering", connectors: connectors(reply.data), reason: undefined, lastRefusal: undefined, next: undefined, observedAt: new Date().toISOString() };
        const retryClaudeSetup = l.view.connectors?.some(connector => connector.agent === "claude" && connector.state === "unavailable" && connector.reason?.startsWith("Claude wake channel setup failed:"));
        if (retryClaudeSetup || !l.view.connectors?.some(connector => connector.state === "available")) {
          const child = l.child;
          const seats = await generationCall(child, randomUUID(), "inspect");
          if (seats === undefined || l.child !== child) throw new Error("the hosted Manager changed before its applications could be refreshed");
          if (seats > 0) throw new HostedManagerRefusal("SEATS_ACTIVE", `hosted Manager for ${space} holds ${seats} active seat(s); its applications cannot be refreshed`, command(`stop the seats through Manager ${l.view.instanceId} in space ${space}, then run \`cotal daemon setup --space ${space}\``));
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
        const reason = error instanceof Error ? safeDiagnostic(error.message).slice(0, 1500) : "the hosted Manager did not answer status";
        if (!isRateLimited(error)) {
          l.view = { ...l.view, state: "starting", reason, next: `read \`cotal daemon status --space ${space}\`; correct its connection or restart the daemon`, observedAt: new Date().toISOString() };
        } else if (l.view.observedAt === undefined) {
          l.view = { ...l.view, state: "starting", reason, next: `wait for the CLI connect limit to refill, then run \`cotal daemon status --space ${space}\` again` };
        }
      }
      return { ...l.view };
    }
    if (l.timer) { clearTimeout(l.timer); l.timer = undefined; }
    if (l.healthTask) await l.healthTask;
    l.stopping = false;
    const current = l;
    current.starting = launch(current).catch((error) => refuse(current, (error as Error).message, `correct the cause and run \`cotal daemon setup --space ${space}\``)).finally(() => { current.starting = undefined; });
    return current.starting;
  };
  return {
    start, status, refresh,
    ...hostedAgentActions(home, live),
    async agents(cachedOnly = false): Promise<HostedAgents[]> {
      const observations = await Promise.all([...live.values()].filter(l => l.view.state !== "stopped").map(async l => {
        if (cachedOnly && l.agents && l.child && !l.stopping) return l.agents;
        const child = l.child;
        const space = l.view.space;
        try {
          // The launch already reads inventory after readiness. A booting child does not
          // answer this IPC, so status must not wait for its inventory timeout.
          if (!child || (l.starting && l.view.state !== "answering")) throw new Error("Manager unavailable");
          const agents = await readHostedAgents(child);
          if (l.child !== child || l.stopping) throw new Error("Manager changed");
          const row: HostedAgents = { space, observedAt: new Date().toISOString(), state: "read" as const, agents };
          l.agents = row;
          return row;
        } catch {
          const row: HostedAgents = { space, observedAt: new Date().toISOString(), state: "unreadable" as const, message: "Could not read agents for this space." };
          l.agents = row;
          return row;
        }
      }));
      let bytes = 0;
      return observations.map(row => {
        bytes += Buffer.byteLength(JSON.stringify(row));
        return bytes <= 24 * 1024 ? row : { space: row.space, observedAt: row.observedAt, state: "unreadable" as const, message: "Could not read agents within the local response limit." };
      });
    },
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
    prepareGenerationRestart(owner: string): Promise<void> {
      generationPending = true;
      generationOwners.add(owner);
      generationAcquisitions++;
      return queueGeneration(async () => {
      generationAcquisitions--;
      generationOwners.add(owner);
      if (generationPrepared) return;
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
          if (seats !== undefined && seats > 0) {
            const agents = await readHostedAgents(l.child);
            throw new HostedManagerRefusal("SEATS_ACTIVE", `hosted Manager for ${l.view.space} holds ${seats} active seat(s): ${agents.map(agent => agent.name).join(", ")}`, command(`stop the seats through Manager ${l.view.instanceId} in space ${l.view.space}, then run \`cotal daemon setup --space ${l.view.space}\``));
          }
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
                const reply = await Promise.race([probe(l, selected), new Promise<never>((_, reject) => {
                  timer = setTimeout(() => reject(new Error("the pinned Manager status probe did not answer")), Math.min(3500, deadline - Date.now()));
                })]);
                if (!reply.ok) throw new Error(reply.error ?? "the hosted Manager refused status");
                if (l.child !== child || closed || l.stopping) break;
                l.view = { ...l.view, state: "answering", connectors: connectors(reply.data), reason: undefined, next: undefined, observedAt: new Date().toISOString() };
              } catch (error) { reason = safeDiagnostic(error instanceof Error ? error.message : String(error)).slice(0, 1000); }
              finally { if (timer) clearTimeout(timer); }
              if (l.view.state !== "answering") await pause(Math.min(250, Math.max(0, deadline - Date.now())));
            }
            if (l.child !== child || l.view.state !== "answering" || closed || l.stopping) throw new HostedManagerRefusal("MANAGER_UNAVAILABLE", `hosted Manager for ${l.view.space} could not confirm readiness for restart within 15s: ${reason}; no service restart was authorized`, command(`run \`cotal daemon status --space ${l.view.space}\`; restore its connection if needed, then run the same setup command again`));
          }
          const attemptId = randomUUID();
          generationAttempts.set(l.child, attemptId);
          await generationCall(l.child, attemptId, "prepare");
        }
        // Keep empty-manager admission fences held through the caller's close.
        generationPrepared = true;
        generationOwners.add(owner);
        generationReleases.clear();
      } catch (error) {
        for (const [child, attemptId] of generationAttempts) {
          try { await generationCall(child, attemptId, "abort"); generationAttempts.delete(child); }
          catch { /* Retain the exact attempt for rollback on the next automatic retry. */ }
        }
        if (generationAttempts.size === 0) generationOwners.delete(owner);
        generationPending = generationAttempts.size !== 0 || generationAcquisitions !== 0;
        if (!generationPending) for (const l of live.values()) {
          if (!l.child && !l.starting && !l.timer && l.view.state === "restarting") schedule(l);
          else if (l.child) observe(l);
        }
        throw error;
      }
      });
    },
    abortGenerationRestart,
    all: () => [...new Set([...spaces(true), ...live.keys()])].map(status),
    async disconnect(space: string, options?: { account?: boolean }) {
      // A crash during child shutdown must not restore a withdrawn hosting intent.
      const intent = daemonManagerIntentFile(space, home);
      const hadIntent = existsSync(intent);
      rmSync(intent, { force: true });
      const l = live.get(space);
      if (l) {
        l.stopping = true;
        if (l.timer) clearTimeout(l.timer);
        if (l.healthTimer) clearTimeout(l.healthTimer);
        await stopChild(l);
        await l.healthTask;
        await l.starting;
      }
      const held = l ?? { view: status(space), stopping: true, failures: 0 };
      let instanceId = held.view.instanceId ?? readManagerCleanup(home, space)?.instanceId;
      const remedy = () => instanceId
        ? `inspect the registration, then run \`cotal endpoint deregister manager ${instanceId} --space ${space} --yes\``
        : `inspect the recorded Manager identity for ${space}, then remove its registration with \`cotal endpoint deregister manager <instance-id> --space ${space} --yes\``;
      const incomplete = (reason: string): never => {
        live.set(space, held);
        refuse(held, reason, remedy());
        if (held.view.registrationCleanup === "pending") {
          held.view = { ...held.view, state: "stopped", pid: undefined };
          rmSync(refusalFile(space), { force: true });
        }
        throw new HostedManagerRefusal("MANAGER_UNAVAILABLE", reason, command(remedy()));
      };
      if (held.view.registrationCleanup === "unknown") incomplete("Manager registration removal is unconfirmed; no automatic request was repeated");
      try {
        const { remoteManagerClient } = await import("@cotal-ai/manager");
        instanceId = remoteManagerClient.loadRemoteManagerInstanceId(daemonManagerRoot(space, home), space) ?? instanceId;
      }
      catch { incomplete("the recorded Manager identity could not be read; its registration may be left behind"); }
      if (!l && !hadIntent && !instanceId && !existsSync(refusalFile(space))) return;
      live.set(space, held);
      if (instanceId) {
        held.view = { ...held.view, instanceId };
        let cleanup = readManagerCleanup(home, space);
        if (!cleanup) {
          const entry = findMesh(space);
          if (!entry || entry.mode !== "user" || !entry.userAuth) return incomplete("Manager registration is left behind; its original cleanup authority is unavailable");
          const storeIdentity = workspaceSecretStore(entry.root).identity;
          if (storeIdentity.kind !== "fs") return incomplete("Manager cleanup requires its original filesystem store identity");
          cleanup = { version: 1, space, root: entry.root, provider: entry.userAuth.provider, storeIdentity, instanceId, phase: "pending" };
        }
        if (!cleanup) return incomplete("Manager cleanup coordinates are unavailable");
        if (cleanup.instanceId !== instanceId) return incomplete("Manager cleanup identity differs from its recorded instance");
        if (cleanup.phase === "unknown") return incomplete("Manager registration removal is unconfirmed; no automatic request was repeated");
        cleanup = { ...cleanup, phase: "pending" };
        writeManagerCleanup(home, cleanup);
        held.view = { ...held.view, state: "stopped", registrationCleanup: "pending" };
        try { validateManagerCleanupAuthority(cleanup); }
        catch { return incomplete("Manager registration cleanup is pending; its original authority is unavailable or changed"); }
        const provider = registry.has("auth-provider", cleanup.provider) ? registry.resolve<AuthProvider>("auth-provider", cleanup.provider) : undefined;
        if (!provider?.deregisterEndpoint) return incomplete("Manager registration cleanup is pending; guarded removal is unsupported for its recorded provider");
        const deregister = provider.deregisterEndpoint.bind(provider);
        const request = { v: 1, kind: "endpoint-deregister", space, endpoint: "manager", instanceId } as const;
        // A process death or lost response after this write is an unknown outcome on restart.
        writeManagerCleanup(home, { ...cleanup, phase: "unknown" });
        held.view = { ...held.view, registrationCleanup: "unknown" };
        refuse(held, "Manager registration removal is unconfirmed", remedy());
        let result;
        try {
          result = parseRemoteEndpointDeregisterResult(await withIdpSessionDir(home, () => deregister({
            store: workspaceSecretStore(cleanup.root), dir: userAuthStateDir(cleanup.root, space, { readOnly: true }), request,
          })), request);
        } catch (error) {
          if (isCommandFailure(error) && error.outcome === "refused") {
            writeManagerCleanup(home, { ...cleanup, phase: "pending" });
            held.view = { ...held.view, registrationCleanup: "pending" };
          }
          return incomplete(`Manager registration is left behind; guarded removal did not confirm its deletion: ${safeDiagnostic(error instanceof Error ? error.message : String(error)).slice(0, 400)}`);
        }
        if (result.state === "unknown") return incomplete(`Manager registration removal is unconfirmed: ${result.condition}; no automatic request will be repeated`);
        if (result.state !== "removed" && result.condition !== "not-registered") {
          writeManagerCleanup(home, { ...cleanup, phase: "pending" });
          held.view = { ...held.view, registrationCleanup: "pending" };
          incomplete(`Manager registration is left behind; guarded removal refused: ${result.condition}`);
        }
        rmSync(managerCleanupFile(home, space), { force: true });
        held.view = { ...held.view, registrationCleanup: undefined };
      }
      held.view = { ...held.view, state: "stopped", pid: undefined, reason: undefined, reasonCode: undefined, reasonDetail: undefined, lastRefusal: undefined, next: options?.account ? "enable this space for this computer in the dashboard to host its Manager again" : `run \`cotal daemon setup --space ${space}\` to host its Manager again` };
      held.agents = undefined;
      rmSync(refusalFile(space), { force: true });
      notify();
    },
    async resume() {
      const recordRefusal = (space: string, error: unknown) => {
        const reason = safeDiagnostic(`could not resume hosted Manager: ${error instanceof Error ? error.message : String(error)}`).slice(0, 1500);
        // Keep the original records intact for diagnosis, and trust only the directory's identity.
        live.set(space, { view: { space, state: "refused", restarts: 0, reason, lastRefusal: reason, next: `inspect the hosted Manager records in ${join(home, "daemon", spaceSegment(space))}, then run \`cotal daemon setup --space ${space}\`` }, stopping: false, failures: 0 });
      };
      const intended = spaces();
      await Promise.all(intended.map(async (space) => {
        const invalid = recordError(space);
        if (invalid) { recordRefusal(space, new Error(invalid)); return; }
        try { await start(space); } catch (error) { recordRefusal(space, error); }
      }));
      for (const space of spaces(true).filter(space => !intended.includes(space))) {
        try {
          const cleanup = readManagerCleanup(home, space);
          if (!cleanup) continue;
          if (cleanup.phase === "unknown") { live.set(space, { view: status(space), stopping: true, failures: 0 }); continue; }
          // Hosted coordinates are retained before launch succeeds and before an intent exists.
          // Their presence alone proves neither withdrawal nor a cleanup request. Keep them
          // for an explicit disconnect, without fencing a machine connection being restored.
          if (cleanup.phase === "hosted") continue;
          await this.disconnect(space);
        } catch (error) {
          if (!(error instanceof HostedManagerRefusal)) recordRefusal(space, error);
        }
      }
    },
    async close() {
      closed = true;
      clearInterval(generationReaper);
      await Promise.all([...live.values()].map(async (l) => {
        l.stopping = true;
        closeProbeSession(l);
        if (l.timer) clearTimeout(l.timer);
        if (l.healthTimer) clearTimeout(l.healthTimer);
        await stopChild(l);
        await l.healthTask;
        await l.starting;
        await l.refreshing;
      }));
    },
  };
}
