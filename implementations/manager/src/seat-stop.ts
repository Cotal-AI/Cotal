import { assertValidName, clearGoalIndex, clearSpaceHistory, commitGoalResult, DEFAULT_SERVER, deprovisionTargetPrincipal, describeCleanupFailures, DEV_OWNER, EpEnvelopeError, fenceLifecycleAcl, isChannelFamily, isConcreteChannel, managedRetirementOpId, mintCreds, newIdentity, parsePrincipalKey, principalKey, rejectionText, transitionGoal } from "@cotal-ai/core";
import type { CleanupFailure, ControlReply, Presence } from "@cotal-ai/core";
import { agentLifecycleSecretFilePaths } from "@cotal-ai/workspace";
import { controlShutdown } from "./control-shutdown.js";
import { removeInlineSnapshot } from "./launch.js";
import { noteModelSet } from "./seat-model.js";
import { withTimeout } from "./manager-timeout.js";
import type { FreeSlotCause, Manager } from "./manager.js";
import type { TeardownTarget } from "./retirement.js";
import type { ManagedAgent } from "./seat-types.js";
import type { ManagerConfig } from "./manager-config.js";
import type { ManagerStartState } from "./manager-start-state.js";
import type { ManagerParts } from "./manager-parts.js";
import { needsProvedPtyStop } from "./runtime/shared-pty.js";

/** The stop family of {@link FreeSlotCause}: the causes a manager-initiated stop records. */
type FreeSlotStopCause = Extract<FreeSlotCause, { kind: string }>;

/** Upper bound on a detached agent-exit deprovision (#159 B2). A wedged broker must not leave the
 *  fire-and-forget teardown pending forever with no log — past this it rejects into freeSlot's fail-loud
 *  `.catch`. Generous over the helper's 5s connect timeout to allow the two consumer-deletes + ACL purge
 *  + drain on a healthy-but-slow broker. */
export const DEPROVISION_TIMEOUT_MS = 15_000;

/** Operator-facing phrasing per cause. Kept beside the union so adding a member without a sentence
 *  is a type error rather than a blank in the log. The stop family's sentences carry the principal
 *  from the cause, so they render through {@link STOP_CAUSE_TEXT} under the same exhaustive-Record
 *  discipline: a new stop kind without a renderer is a type error too. */
const FREE_SLOT_CAUSE_TEXT: Record<Exclude<FreeSlotCause, FreeSlotStopCause>, string> = {
  "process-exit": "its own process exited and this manager did not stop it",
  "pi-crash-loop": "this manager retired it after a Pi crash loop",
  "pi-recovery-failed": "this manager retired it after Pi session recovery failed",
  "supervise-crash-loop": "this manager retired it after its supervise restart budget was spent",
  "supervise-recovery-failed": "this manager retired it after a supervised restart failed",
  "session-bind-failed": "this manager stopped it: its host session could not be bound at launch",
  "resume-session-rebind-failed": "this manager stopped it: its host session could not be rebound on resume",
  "carried-fork-refused": "this manager stopped it: it recorded no fork of the carried transcript",
  "resume-custody-unrecorded": "this manager stopped it: its custody reference could not be recorded on resume",
  "supervise-record-failed": "this manager stopped it: its supervise policy could not be recorded for a manager restart",
  "inline-snapshot-changed": "this manager retired it instead of restarting it: its inline persona snapshot changed after launch",
};

/** The stop family's sentences — the same job {@link FREE_SLOT_CAUSE_TEXT} does for the string
 *  causes, beside it so both stay the single place a cause becomes a sentence. A requested stop's
 *  sentence embeds the authenticated principal and a recursive reap's embeds the parent that
 *  left, so they cannot sit in a static Record keyed by kind; this exhaustive switch is their
 *  single home, and the `satisfies never` default keeps the discipline: a new stop kind without a
 *  sentence is a type error rather than a blank in the log. */
function stopCauseText(cause: FreeSlotStopCause): string {
  switch (cause.kind) {
    case "stopped-requested": return `this manager stopped it at ${cause.requester}'s request`;
    case "stopped-self": return "it stopped itself (self-stop)";
    case "stopped-reap": return `this manager stopped it because its parent ${cause.parent} left (recursive reap)`;
    case "stopped-shutdown": return "this manager stopped it on manager shutdown";
    case "stopped-once": return `this manager stopped it: its once task ended (${cause.reason})`;
    default: return cause satisfies never;
  }
}

/** The reason a once task is cancelled with when a stop of this kind ends its seat first. */
function onceStopReason(cause: FreeSlotStopCause): string {
  switch (cause.kind) {
    case "stopped-requested": return "despawned";
    case "stopped-self": return "stopped-itself";
    case "stopped-reap": return "parent-left";
    case "stopped-shutdown": return "manager-shutdown";
    case "stopped-once": return cause.reason;
    default: return cause satisfies never;
  }
}

/** What {@link SeatStop} reads from the Manager. Every entry is read at use, so a field the Manager
 *  assigns after construction is always current, and a Manager method a test replaces is the one that runs. */
export interface SeatStopDeps {
  agentGoals: () => Manager["agentGoals"];
  agents: () => Manager["agents"];
  ep: () => Manager["ep"];
  lifecycleInFlight: () => Manager["lifecycleInFlight"];
  setLifecycleInFlight: (value: Manager["lifecycleInFlight"]) => void;
  maintenanceState: () => Manager["maintenanceState"];
  retirement: () => Manager["retirement"];
  unverifiedStops: () => Manager["unverifiedStops"];
  setUnverifiedStops: (value: Manager["unverifiedStops"]) => void;
  assertGoalWriterEpochCurrent: (...args: Parameters<Manager["assertGoalWriterEpochCurrent"]>) => ReturnType<Manager["assertGoalWriterEpochCurrent"]>;
  authorizeNamed: (...args: Parameters<Manager["authorizeNamed"]>) => ReturnType<Manager["authorizeNamed"]>;
  awaitHandleExit: (...args: Parameters<Manager["awaitHandleExit"]>) => ReturnType<Manager["awaitHandleExit"]>;
  beginLifecycle: (...args: Parameters<Manager["beginLifecycle"]>) => ReturnType<Manager["beginLifecycle"]>;
  confirmRetirement: (...args: Parameters<Manager["confirmRetirement"]>) => ReturnType<Manager["confirmRetirement"]>;
  emitGoalProgress: (...args: Parameters<Manager["emitGoalProgress"]>) => ReturnType<Manager["emitGoalProgress"]>;
  executionRefusal: (...args: Parameters<Manager["executionRefusal"]>) => ReturnType<Manager["executionRefusal"]>;
  freeSlot: (...args: Parameters<Manager["freeSlot"]>) => ReturnType<Manager["freeSlot"]>;
  maintenanceError: (...args: Parameters<Manager["maintenanceError"]>) => ReturnType<Manager["maintenanceError"]>;
  managedPrincipal: (...args: Parameters<Manager["managedPrincipal"]>) => ReturnType<Manager["managedPrincipal"]>;
  readManagedSessionState: (...args: Parameters<Manager["readManagedSessionState"]>) => ReturnType<Manager["readManagedSessionState"]>;
  recoverManagedSession: (...args: Parameters<Manager["recoverManagedSession"]>) => ReturnType<Manager["recoverManagedSession"]>;
  refreshSeatRecord: (...args: Parameters<Manager["refreshSeatRecord"]>) => ReturnType<Manager["refreshSeatRecord"]>;
  releaseLifecycle: (...args: Parameters<Manager["releaseLifecycle"]>) => ReturnType<Manager["releaseLifecycle"]>;
  shredUserSecrets: (...args: Parameters<Manager["shredUserSecrets"]>) => ReturnType<Manager["shredUserSecrets"]>;
  trackDeprovision: (...args: Parameters<Manager["trackDeprovision"]>) => ReturnType<Manager["trackDeprovision"]>;
}

/** Builds the {@link SeatStopDeps} for a Manager. It reads Manager members by name at each use, so a
 *  field the Manager assigns later is current and a member a test replaces on the instance is the one that runs. */
export function seatStopDeps(m: Manager): SeatStopDeps {
  return {
    agentGoals: () => m["agentGoals"],
    agents: () => m["agents"],
    ep: () => m["ep"],
    lifecycleInFlight: () => m["lifecycleInFlight"],
    setLifecycleInFlight: (value) => { m["lifecycleInFlight"] = value; },
    maintenanceState: () => m["maintenanceState"],
    retirement: () => m["retirement"],
    unverifiedStops: () => m["unverifiedStops"],
    setUnverifiedStops: (value) => { m["unverifiedStops"] = value; },
    assertGoalWriterEpochCurrent: (...args) => m["assertGoalWriterEpochCurrent"](...args),
    authorizeNamed: (...args) => m["authorizeNamed"](...args),
    awaitHandleExit: (...args) => m["awaitHandleExit"](...args),
    beginLifecycle: (...args) => m["beginLifecycle"](...args),
    confirmRetirement: (...args) => m["confirmRetirement"](...args),
    emitGoalProgress: (...args) => m["emitGoalProgress"](...args),
    executionRefusal: (...args) => m["executionRefusal"](...args),
    freeSlot: (...args) => m["freeSlot"](...args),
    maintenanceError: (...args) => m["maintenanceError"](...args),
    managedPrincipal: (...args) => m["managedPrincipal"](...args),
    readManagedSessionState: (...args) => m["readManagedSessionState"](...args),
    recoverManagedSession: (...args) => m["recoverManagedSession"](...args),
    refreshSeatRecord: (...args) => m["refreshSeatRecord"](...args),
    releaseLifecycle: (...args) => m["releaseLifecycle"](...args),
    shredUserSecrets: (...args) => m["shredUserSecrets"](...args),
    trackDeprovision: (...args) => m["trackDeprovision"](...args),
  };
}

/** Stopping a seat, recording why it left, reaping its children, and the named despawn doors. */
export class SeatStop {
  constructor(private readonly config: Readonly<ManagerConfig>, private readonly deps: SeatStopDeps, private readonly parts: Pick<ManagerParts, "goalWriter" | "servePlane" | "spawnGoal">, private readonly state: ManagerStartState) {}

  // The Manager members these bodies read, under their Manager names. Each reads through its dep at
  // use, so a field the Manager assigns later is current and a method a test replaces on the Manager
  // is the one that runs.
  private get agentGoals() { return this.deps.agentGoals(); }
  private get agents() { return this.deps.agents(); }
  private get auth() { return this.state.auth; }
  private get ep() { return this.deps.ep(); }
  private get lifecycleInFlight() { return this.deps.lifecycleInFlight(); }
  private set lifecycleInFlight(value: Manager["lifecycleInFlight"]) { this.deps.setLifecycleInFlight(value); }
  private get maintenanceState() { return this.deps.maintenanceState(); }
  private get managerInstanceId() { return this.state.managerInstanceId!; }
  private get remoteAuthority() { return this.config.remoteAuthority; }
  private get retirement() { return this.deps.retirement(); }
  private get unverifiedStops() { return this.deps.unverifiedStops(); }
  private set unverifiedStops(value: Manager["unverifiedStops"]) { this.deps.setUnverifiedStops(value); }
  private assertGoalWriterEpochCurrent(...args: Parameters<Manager["assertGoalWriterEpochCurrent"]>): ReturnType<Manager["assertGoalWriterEpochCurrent"]> { return this.deps.assertGoalWriterEpochCurrent(...args); }
  private authorizeNamed(...args: Parameters<Manager["authorizeNamed"]>): ReturnType<Manager["authorizeNamed"]> { return this.deps.authorizeNamed(...args); }
  private awaitHandleExit(...args: Parameters<Manager["awaitHandleExit"]>): ReturnType<Manager["awaitHandleExit"]> { return this.deps.awaitHandleExit(...args); }
  private beginLifecycle(...args: Parameters<Manager["beginLifecycle"]>): ReturnType<Manager["beginLifecycle"]> { return this.deps.beginLifecycle(...args); }
  private confirmRetirement(...args: Parameters<Manager["confirmRetirement"]>): ReturnType<Manager["confirmRetirement"]> { return this.deps.confirmRetirement(...args); }
  private emitGoalProgress(...args: Parameters<Manager["emitGoalProgress"]>): ReturnType<Manager["emitGoalProgress"]> { return this.deps.emitGoalProgress(...args); }
  private executionRefusal(...args: Parameters<Manager["executionRefusal"]>): ReturnType<Manager["executionRefusal"]> { return this.deps.executionRefusal(...args); }
  private freeSlot(...args: Parameters<Manager["freeSlot"]>): ReturnType<Manager["freeSlot"]> { return this.deps.freeSlot(...args); }
  private maintenanceError(...args: Parameters<Manager["maintenanceError"]>): ReturnType<Manager["maintenanceError"]> { return this.deps.maintenanceError(...args); }
  private managedPrincipal(...args: Parameters<Manager["managedPrincipal"]>): ReturnType<Manager["managedPrincipal"]> { return this.deps.managedPrincipal(...args); }
  private readManagedSessionState(...args: Parameters<Manager["readManagedSessionState"]>): ReturnType<Manager["readManagedSessionState"]> { return this.deps.readManagedSessionState(...args); }
  private recoverManagedSession(...args: Parameters<Manager["recoverManagedSession"]>): ReturnType<Manager["recoverManagedSession"]> { return this.deps.recoverManagedSession(...args); }
  private releaseLifecycle(...args: Parameters<Manager["releaseLifecycle"]>): ReturnType<Manager["releaseLifecycle"]> { return this.deps.releaseLifecycle(...args); }
  private shredUserSecrets(...args: Parameters<Manager["shredUserSecrets"]>): ReturnType<Manager["shredUserSecrets"]> { return this.deps.shredUserSecrets(...args); }
  private trackDeprovision(...args: Parameters<Manager["trackDeprovision"]>): ReturnType<Manager["trackDeprovision"]> { return this.deps.trackDeprovision(...args); }

  /** Tear an agent down — the single chokepoint for every stop path (despawn, self-stop, reap). On
   *  Windows a graceful stop can't ride a signal (ConPTY delivers none, so the agent never runs its
   *  exit handlers / leaves the mesh), so first send a cooperative `{op:"shutdown"}` over its authed
   *  control endpoint; the agent exits cleanly and the runtime hard-kills as a fallback after its
   *  grace window. POSIX delivers SIGTERM→SIGKILL natively, so it keeps the signal path. A hard stop
   *  (`graceful:false`, e.g. emergency reap) skips the cooperative step on every platform.
   *
   *  Never throws (#159 B2): a runtime hard-stop CAN throw (tmux `closeWindow` / cmux `closeWorkspace`
   *  are direct calls), and a throwing stop must not abort a caller's cleanup and leak the agent's
   *  footprint, nor (in `reapChildrenOf`) abort the reap of later siblings. The failure is logged and
   *  returned: a caller that must prove exit (shutdown, a failed resume) reports it as the cause at
   *  once instead of waiting out a stop the runtime already refused. */
  stopHandle(a: ManagedAgent, graceful: boolean, cause: FreeSlotCause): string | undefined {
    // The TERMINALIZING latch: flipped SYNCHRONOUSLY, before any await anywhere on
    // this stop path — later renewals refuse, while an already-admitted renewal drains before the
    // durable terminal begins.
    a.terminalizing = true;
    a.stopCause ??= cause;
    try {
      // A delegated seat's close runs only inside its retirement, after the host revoked its grant,
      // so stopping it starts that retirement. Every exit wait on a stop path then settles on that
      // close; the free path's own teardown joins the same flight.
      if (a.handedOff) this.trackDeprovision(this.teardownTarget(a));
      else a.handle.stop({ graceful });
      // The runtime captured its cohort synchronously before the cooperative
      // request can let a root exit and orphan its already-running children.
      if (graceful && process.platform === "win32" && a.control) controlShutdown(a.control);
    } catch (e) {
      const failure = rejectionText(e);
      console.error(`stop ${a.name} (${a.id}): ${failure}`);
      return failure;
    }
  }

  /** Windows PTY stops release their name only after the captured process cohort and PTY exited. */
  async stopWindowsSeat(a: ManagedAgent, graceful: boolean, floor: boolean, cause: FreeSlotStopCause): Promise<void> {
    if (a.once) a.once.stopReason ??= onceStopReason(cause);
    const failure = this.stopHandle(a, graceful, cause);
    this.lifecycleInFlight++;
    try {
      if (failure !== undefined) throw new Error(failure);
      await this.awaitHandleExit(a.handle);
      this.unverifiedStops = this.unverifiedStops.filter((stopped) => stopped.handle !== a.handle);
      this.freeSlot(a, floor, cause, true);
    } catch (error) {
      const detail = `${process.platform === "win32" ? "Windows stop could not prove the captured process tree exited" : "PTY stop could not prove the seat's processes exited"}: ${rejectionText(error)}`;
      this.unverifiedStops = this.unverifiedStops.filter((stopped) => stopped.handle !== a.handle);
      this.unverifiedStops.push({ name: a.name, id: a.id, handle: a.handle, authoritative: true, error: detail });
      throw new EpEnvelopeError("unavailable", detail, undefined, "unknown");
    } finally {
      this.releaseLifecycle();
    }
  }

  /** Keep an accepted stop inside the lifecycle drain until the runtime proves the child is gone,
   * so a maintenance prepare can never fence ahead of a child that is still dying. The `cause` is
   * the stop-family cause the door already knows (which door, and who asked); it rides every
   * freeSlot below so the reap line can say it.
   *
   * An operator-accepted stop frees its slot at once: `stop` replying ✓ means `ps` no longer lists
   * the agent. That cannot omit a still-live child from a cut, because runPreparation drains the
   * lifecycle BEFORE it reads the roster — the exit proof below is what closes the race, not the
   * slot lingering. A recursive reap (`requireAuthoritativeExit`) instead keeps the slot until the
   * wait proves exit: nobody asked for those children to be gone, so they stay managed until the
   * runtime says otherwise, and a runtime that cannot prove exit records an unverified stop. */
  trackStoppedHandle(a: ManagedAgent, floor: boolean, cause: FreeSlotCause, requireAuthoritativeExit = false): void {
    if (needsProvedPtyStop(a.handle)) requireAuthoritativeExit = true;
    // What a once seat's task is cancelled with if this stop ends it before the task has a terminal.
    if (a.once && typeof cause !== "string") a.once.stopReason ??= onceStopReason(cause);
    if (!a.handle.waitForExit) {
      // Preserve ordinary external-runtime stop behavior, but retain enough evidence for a later
      // maintenance prepare to fail if that runtime still cannot prove the surface disappeared.
      this.unverifiedStops.push({
        name: a.name,
        id: a.id,
        handle: a.handle,
        authoritative: requireAuthoritativeExit,
        error: requireAuthoritativeExit
          ? `recursive reap cannot prove exit on runtime "${a.handle.kind}" (AgentHandle.waitForExit is not implemented)`
          : undefined,
      });
      if (requireAuthoritativeExit) return;
      this.freeSlot(a, floor, cause, true);
      return;
    }
    if (!requireAuthoritativeExit) this.freeSlot(a, floor, cause, true);
    this.lifecycleInFlight++;
    void this.awaitHandleExit(a.handle)
      .then(() => {
        this.unverifiedStops = this.unverifiedStops.filter((stopped) => stopped.handle !== a.handle);
        this.freeSlot(a, floor, cause, true);
      }) // no-op once an accepted stop already freed it
      .catch((e) => {
        this.unverifiedStops = this.unverifiedStops.filter((stopped) => stopped.handle !== a.handle);
        this.unverifiedStops.push({
          name: a.name,
          id: a.id,
          handle: a.handle,
          authoritative: true,
          error: `accepted stop could not prove exit: ${rejectionText(e)}`,
        });
      })
      .finally(() => this.releaseLifecycle());
  }

  /**
   * WHY A SEAT LEFT — one line, at the one place every free path passes through.
   *
   * A manager that had held twelve seats could not say why any of them had died: the log carried no
   * per-seat exit line at all, so "the supervisor reaped them" and "they died on their own" were
   * indistinguishable after the fact and the incident was unattributable. `freeSlot` is the single
   * chokepoint for despawn, self-stop, reap and exit, which is why the line lives here rather than
   * being remembered at each of the six callers.
   *
   * THE RUNTIME'S EXIT DETAIL IS OPTIONAL AND ITS ABSENCE IS SAID OUT LOUD. `AgentHandle.exitInfo`
   * is only implemented by backends that own the child process; the rest genuinely cannot see how
   * it ended. Printing `code 0` for those would be a fabricated clean exit on exactly the seats
   * whose death nobody can explain, so an absent answer prints as unavailable and names the runtime
   * that could not provide it.
   */
  logSeatReaped(a: ManagedAgent, cause: FreeSlotCause): void {
    const causeText = typeof cause === "string" ? FREE_SLOT_CAUSE_TEXT[cause] : stopCauseText(cause);
    let detail: string;
    try {
      const info = a.handle.exitInfo?.();
      detail = info === undefined
        ? `exit detail unavailable from runtime "${a.handle.kind}"`
        : `exit code ${info.code ?? "unknown"}${info.signal === undefined ? "" : `, signal ${info.signal}`}${info.diagnostic ? `; diagnostic: ${info.diagnostic}` : ""}`;
    } catch (e) {
      // A runtime that throws while being asked has told us something real; it must not take the
      // log line (or the free path it sits on) down with it.
      detail = `exit detail unreadable from runtime "${a.handle.kind}": ${rejectionText(e)}`;
    }
    console.error(
      `seat reaped: ${a.name} (${a.id}, uid ${a.lifecycleUid}${a.handle.pid !== undefined ? `, pid ${a.handle.pid}` : ""}) - ${causeText}; ${detail}`,
    );
  }

  /**
   * A SEAT THAT LEAVES THE MESH WHILE ITS SLOT IS HELD GETS A LINE, AND SO DOES ITS RETURN.
   *
   * Seats once read `running · mesh offline` for many hours with no manager log line, so a watchdog
   * keyed on process liveness saw nothing wrong and nobody could say when each seat dropped (#1208).
   * The line follows the same state `ps` reads, checked on every roster change and view transition,
   * because not every offline record arrives as a presence event: after a reconnect the fresh snapshot
   * records an already-offline seat quietly. Only a current view is a verdict, so a stale or
   * unpopulated one logs nothing. The match is {@link isOwnPresence}. A seat being stopped is left to
   * the reap line. The heartbeat is the seat's own record and nothing validated it, so an unreadable
   * one prints as unknown instead of throwing inside the watch. A live record also gives the seat's
   * display name, which {@link noteShownName} keeps with the seat, and the model an owner's
   * `set-model` switched it to, which {@link noteModelSet} keeps.
   */
  logSeatMeshTransitions(): void {
    if (typeof this.ep.presenceView === "function" && this.ep.presenceView().state !== "current") return;
    const roster = new Map(this.ep.getRoster().map((p) => [p.card.id, p]));
    for (const a of this.agents.values()) {
      const seen = roster.get(this.managedPrincipal(a));
      if (a.terminalizing || !this.isOwnPresence(a, seen)) continue;
      if (seen.status !== "offline") {
        a.joinIssue = undefined;
        this.noteShownName(a, seen.card.name);
        if (noteModelSet(a, seen, { workspaceRoot: this.config.workspaceRoot, log: (line) => console.error(line) })) this.deps.refreshSeatRecord(a);
      }
      const who = `${a.name} (${a.id}, uid ${a.lifecycleUid}${a.handle.pid !== undefined ? `, pid ${a.handle.pid}` : ""})`;
      if (seen.status === "offline" && !a.offMesh) {
        a.offMesh = true;
        const ts = seen.ts;
        const last = typeof ts === "number" && !Number.isNaN(new Date(ts).getTime()) ? new Date(ts).toISOString() : "unknown";
        console.error(`seat offline on the mesh: ${who} - last heartbeat ${last}; process ${a.handle.status()}`);
      } else if (seen.status !== "offline" && a.offMesh) {
        a.offMesh = false;
        console.error(`seat back on the mesh: ${who}`);
      }
    }
  }

  /** Keep the display name a live seat shows in its own presence (SPEC 13.22 `set-name`), so a
   *  relaunch under the same alias starts with it. The record is the seat's own write and nothing
   *  validated it, so a name the shared rule refuses is not kept and the last good one stays. */
  private noteShownName(a: ManagedAgent, shown: string): void {
    const displayName = shown === a.name ? undefined : shown;
    if (displayName === a.displayName) return;
    if (displayName !== undefined) {
      try {
        assertValidName(displayName);
      } catch {
        return;
      }
    }
    a.displayName = displayName;
    this.deps.refreshSeatRecord(a);
  }

  /** Whether a roster record is this seat's own: the readiness fence's exact principal and
   *  incarnation, so a same-named foreign peer or an older incarnation never speaks for it (#1208). */
  isOwnPresence(a: ManagedAgent, p: Presence | undefined): p is Presence {
    return p !== undefined && p.card.id === this.managedPrincipal(a) && p.lifecycleUid === a.lifecycleUid;
  }

  /** Remove one lifecycle's inline snapshot by the path its uid derives, never by a recorded one, so a
   *  resume inventory cannot point the removal at another file. Returns whether the file is gone. A
   *  failure is logged, never thrown, because the callers must still schedule the teardown. */
  dropInlineSnapshot(name: string, lifecycleUid: string): boolean {
    try {
      removeInlineSnapshot(this.config.workspaceRoot, lifecycleUid);
      return true;
    } catch (e) {
      console.error(`! ${name}: its inline persona snapshot could not be removed: ${rejectionText(e)}`);
      return false;
    }
  }

  /** A live agent's teardown target, built field by field so the rest of its record (handle, seed,
   *  restart state) never rides into the detached teardown or its single-flight map. */
  teardownTarget(a: ManagedAgent): TeardownTarget {
    return { id: a.id, name: a.name, lifecycleUid: a.lifecycleUid, userOwner: a.userOwner, delegated: a.delegated, secretPaths: a.secretPaths, runtime: a.handle?.reference, ...(a.handedOff ? { delegatedHandle: a.handle } : {}), launch: { allowSubscribe: a.launch.allowSubscribe }, staticCredentialRenewal: a.staticCredentialRenewal };
  }

  /** Narrow the retiring lifecycle's read-ACL row to no reads ({@link fenceLifecycleAcl}) through a
   *  `deprovisioner` credential pinned to it. Returns undefined once fenced, or the reason it was not. */
  async fenceRetiringAcl(a: { id: string; lifecycleUid: string }): Promise<string | undefined> {
    try {
      const creds = await mintCreds(this.auth!, newIdentity(), "deprovisioner", { deprovisionTarget: { principal: a.id, lifecycleUid: a.lifecycleUid, memberChannels: [] } });
      await withTimeout(
        fenceLifecycleAcl({ servers: this.config.servers ?? DEFAULT_SERVER, space: this.config.space, targetId: a.id, lifecycleUid: a.lifecycleUid, creds }),
        DEPROVISION_TIMEOUT_MS,
        `fence ${a.id}: the ACL fence timed out`,
      );
      return undefined;
    } catch (e) {
      return rejectionText(e);
    }
  }

  /** The retiring lifecycle's durable membership channels, read from the delivery daemon's
   *  `lifecycleMemberships` admin verb (read-only, lifecycle-exact). Incomplete on any refusal. */
  async lifecycleMembershipInventory(a: { id: string; lifecycleUid: string }): Promise<{ complete: boolean; channels: string[]; reason?: string }> {
    const t = deprovisionTargetPrincipal({ principal: a.id, lifecycleUid: a.lifecycleUid });
    try {
      const r = await this.ep.requestDeliveryAdmin("lifecycleMemberships", { principal: principalKey(t.owner, t.actor).key, lifecycleUid: t.lifecycleUid }, 5_000);
      const data = r.data as { complete?: unknown; channels?: unknown } | undefined;
      if (!r.ok || data?.complete !== true || !Array.isArray(data.channels) || !data.channels.every((c) => typeof c === "string" && (isConcreteChannel(c) || isChannelFamily(c))))
        return { complete: false, channels: [], reason: r.ok ? "malformed inventory reply" : (r.error ?? "refused") };
      return { complete: true, channels: data.channels as string[] };
    } catch (e) {
      return { complete: false, channels: [], reason: rejectionText(e) };
    }
  }

  /** Reap a parent's children on its exit (P4b). Every descendant remains managed until the runtime's
   * authoritative wait proves exit; the wait participates in the lifecycle drain, so preservation can
   * never omit a child that may still be alive. Recursive descendants are scheduled before their parent
   * slot can disappear. */
  reapChildrenOf(parentId: string): void {
    for (const child of [...this.agents.values()]) {
      if (child.spawner !== parentId) continue;
      this.reapChildrenOf(this.managedPrincipal(child));
      const cause = { kind: "stopped-reap", parent: parentId } as const;
      this.stopHandle(child, false, cause);
      this.trackStoppedHandle(child, true, cause, true);
    }
  }

  /** A managed agent's process exited: on its own (crash, /exit, finished), or after a stop this
   *  manager started, whose recorded cause then frees the slot. Continuation-capable Pi seats
   *  restart in place after readiness; a spawn carrying `supervise` restarts any connector the same
   *  way, without classifying a session-state file. Every other exit follows the existing terminal
   *  path. */
  onAgentExit(a: ManagedAgent): void {
    // Preservation owns the child-stop snapshot. Exit watchers must neither delete that snapshot nor
    // trigger normal deprovision/reap while the cut is being formed.
    if (this.maintenanceState !== "active") return;
    // A Windows stop owns the exit proof and its truthful reap cause. The raw
    // terminal event must not release a slot while cohort verification is pending.
    if (process.platform === "win32" && a.handle.kind === "pty" && a.terminalizing) return;
    // A replacement is proving readiness under this row. Its own wait owns a failed
    // relaunch; treating that exit as a seat death would free the slot mid-recovery.
    if (a.restart?.recovering && !a.terminalizing) return;
    if (a.restart?.armed && !a.terminalizing) {
      if (a.restart.policy !== undefined) {
        this.recoverManagedSession(a);
        return;
      }
      try {
        if (this.readManagedSessionState(a).status === "running") {
          this.recoverManagedSession(a);
          return;
        }
      } catch (error) {
        console.error(`! ${a.name}: cannot classify Pi process exit for recovery: ${rejectionText(error)} - retiring the seat`);
      }
    }
    this.freeSlot(a, true, a.stopCause ?? "process-exit");
    this.reapChildrenOf(this.managedPrincipal(a));
  }

  async opStop(args: Record<string, unknown>, caller: string, admin: boolean): Promise<ControlReply> {
    const name = String(args.name ?? "").trim();
    const a = this.agents.get(name);
    if (!a) return { ok: false, error: `no agent "${name}"` };
    try {
      return await this.despawnCore(a, caller, admin, args.graceful !== false);
    } catch (error) {
      return { ok: false, error: rejectionText(error) };
    }
  }

  /** The ONE named-terminal core both doors share: the ctl named `stop`
   *  and the v0.4 targeted `despawn` are the same terminal — authorize by the shared policy
   *  ({@link authorizeNamed}: own-child / owner-domain on privileged, any on admin), stop, track.
   *  The ep door runs the SAME two pieces separately so a policy denial surfaces as the §13.3
   *  `permission-denied` (never a generic failure). */
  private async despawnCore(a: ManagedAgent, caller: string, admin: boolean, graceful: boolean): Promise<ControlReply> {
    const denied = await this.authorizeNamed(a, caller, admin);
    if (denied) return { ok: false, error: denied };
    return this.despawnAuthorized(a, graceful, !admin, caller);
  }

  /** The post-authorization terminal effect (both doors). `trackNonAdmin` mirrors the ctl door's
   *  `trackStoppedHandle(a, !admin)` disposition. The reap line names `caller` — the AUTHENTICATED
   *  wire principal the door already resolved — so an operator reading the log can tell one peer's
   * despawn from another's. */
  despawnAuthorized(a: ManagedAgent, graceful: boolean, trackNonAdmin: boolean, caller: string): ControlReply | Promise<ControlReply> {
    if (needsProvedPtyStop(a.handle)) {
      return this.stopWindowsSeat(a, graceful, trackNonAdmin, { kind: "stopped-requested", requester: caller }).then(() => {
        void this.cancelAgentGoal(a.name, graceful ? "graceful" : "terminate");
        return { ok: true, data: { name: a.name, stopped: true, graceful } };
      });
    }
    const cause = { kind: "stopped-requested", requester: caller } as const;
    this.stopHandle(a, graceful, cause);
    this.trackStoppedHandle(a, trackNonAdmin, cause);
    void this.cancelAgentGoal(a.name, graceful ? "graceful" : "terminate"); // Cancel a live spawn goal
    return { ok: true, data: { name: a.name, stopped: true, graceful } };
  }

  /** Retire one agent this manager launched under a delegated user intent, through the host
   *  (SPEC 13.16). It sends the user's retirement intent for the UID of the running slot or its
   *  retirement hold, and only on `retired: true` for that exact target stops the slot, shreds the
   *  seat's local secret family and frees the name; every other answer leaves the slot running or
   *  the name held, and a failed shred keeps the name held. It never calls the holder's own prepare
   *  or requester. */
  async retireDelegatedAgent(name: string, intentId: string): Promise<ControlReply> {
    const execute = this.remoteAuthority?.executeDelegatedUserIntent;
    if (!execute) return { ok: false, error: `this manager has no host execution for a delegated user intent; "${name}" was not retired` };
    const release = this.beginLifecycle();
    if (!release) return { ok: false, error: this.maintenanceError() };
    try {
      const live = this.agents.get(name);
      const held = live ? undefined : this.retirement.held(name);
      const principal = live?.delegated ? parsePrincipalKey(live.id) : held?.target.delegated ? held : null;
      const lifecycleUid = live?.lifecycleUid ?? held?.target.lifecycleUid;
      if (!principal || !lifecycleUid) return { ok: false, error: `no agent named "${name}" was launched on this manager under a delegated user intent` };
      const target = { owner: principal.owner, actor: principal.actor, lifecycleUid };
      try {
        const result = await execute({ intentId, operation: "retire", target });
        if (result.operation !== "retire" || result.intentId !== intentId || result.opId !== managedRetirementOpId(target.lifecycleUid) ||
            result.target.owner !== target.owner || result.target.actor !== target.actor || result.target.lifecycleUid !== target.lifecycleUid)
          throw new Error(`the host answered delegated intent ${intentId} with another execution`);
        if (result.retired !== true)
          return { ok: false, error: `the host did not confirm the delegated retirement of "${name}" at ${target.lifecycleUid}; "${name}" is unchanged` };
      } catch (e) {
        const error = `the delegated retirement under intent ${intentId} did not complete (${rejectionText(e)})`;
        const hold = this.retirement.held(name);
        if (hold?.target.lifecycleUid === target.lifecycleUid) hold.lastError = error;
        return { ok: false, error: `${error}; "${name}" is unchanged` };
      }
      // The host's retirement closed this UID's provider handle before its barrier, so the stop only
      // reaps the slot, and its hold clears with the confirmation.
      const slot = this.agents.get(name);
      if (slot?.lifecycleUid === target.lifecycleUid) await this.despawnAuthorized(slot, true, false, `delegated retirement ${intentId}`);
      // The host owns the grant and the footprint, but the secret family enrollUserAgent wrote here
      // is this participant's, and no teardown arm of a delegated seat removes it.
      const unshredded: CleanupFailure[] = [];
      await this.shredUserSecrets(unshredded, (live ?? held?.target)?.secretPaths ?? agentLifecycleSecretFilePaths(this.config.workspaceRoot, this.config.space, name, target.lifecycleUid));
      if (unshredded.length) {
        const error = `the host retired "${name}" at ${target.lifecycleUid}, but cleanup failed: ${describeCleanupFailures(unshredded)}; the name stays held until a retried retirement intent removes it`;
        const hold = this.retirement.held(name);
        if (hold?.target.lifecycleUid === target.lifecycleUid) hold.lastError = error;
        return { ok: false, error };
      }
      this.confirmRetirement({ id: principalKey(target.owner, target.actor).key, name, lifecycleUid: target.lifecycleUid });
      return { ok: true, data: { name, lifecycleUid: target.lifecycleUid, retired: true } };
    } finally {
      release();
    }
  }

  /** Resolve a v0.4 TARGET triple (owner, actor, lifecycleUid — broker-validated subject/body
   *  agreement, currency re-checked by the serve boundary's resolver) to the live managed agent it
   *  names. Static agents key `(DEV_OWNER, nkey)`; user-mode agents store the principal dot-form
   *  in `id`. A uid mismatch is a superseded incarnation — never resolved to its successor. */
  findManagedByTarget(t: { owner: string; actor: string; lifecycleUid: string }): ManagedAgent | undefined {
    for (const a of this.agents.values()) {
      const matches = a.userOwner ? a.id === principalKey(t.owner, t.actor).key : t.owner === DEV_OWNER && a.id === t.actor;
      if (matches && a.lifecycleUid === t.lifecycleUid) return a;
    }
    return undefined;
  }

  /** Settle race: a despawn MID-GOAL drives the goal's cancel terminal - transition to
   *  `cancelling`, then commit the `cancel` cause on the goal-writer connection. First-terminal-fact
   *  wins: if the readiness outcome already committed (succeeded/failed/uncertain) the transition or
   *  the create-only commit loses gracefully and the readiness terminal stands. Fire-and-forget from
   *  despawn (the process teardown is authoritative for the agent; this settles the GOAL honestly).
   *  Cancel rides the despawn's own authorizeNamed reach - there is no cancel-by-goalId. */
  async cancelAgentGoal(name: string, mode: "graceful" | "terminate"): Promise<void> {
    const gw = this.parts.goalWriter.goalWriter;
    const ref = this.agentGoals.get(name);
    if (!gw || !ref) return;
    this.agentGoals.delete(name);
    const epoch = this.parts.servePlane.serviceServe?.grant.epoch ?? 0;
    try {
      await this.assertGoalWriterEpochCurrent(epoch); // a superseded corpse never commits a cancel terminal either
      await transitionGoal(gw.ctx, ref, "cancelling", { fields: { cancelMode: mode } });
      const r = await commitGoalResult(gw.ctx, { ref, now: Date.now(), cause: "cancel", data: { cancelledBy: "despawn" }, committer: { instanceId: this.managerInstanceId, epoch } });
      this.parts.spawnGoal.expireGoalAcceptance(ref);
      this.emitGoalProgress(ref, epoch, { phase: "terminal", state: r.fact.state, ...(r.fact.data !== undefined ? { data: r.fact.data } : {}) });
      await clearGoalIndex(gw.ctx, ref); // terminal reached - the successor never reconciles it
    } catch {
      // the goal already terminalized (the readiness outcome won the settle race) - nothing to cancel.
    }
  }

  /** The membership gate: decide a control caller by its
   *  AUTHENTICATED wire principal. A LIVE managed slot passes (unless terminalizing); a RETIRING
   *  hold or a RETIRED static incarnation refuses even with a tier-valid JWT (the
   *  copied-credential vector — its subject can never collide with a successor's, so this match
   *  is non-forgeable); any OTHER principal is not a managed lifecycle (an operator instrument:
   *  the credential tier governs, exactly as before). Never name alone, never a payload field. */
  lifecycleMembershipRefusal(caller: string): string | undefined {
    for (const a of this.agents.values()) {
      if (this.managedPrincipal(a) === caller)
        return a.terminalizing
          ? `the caller's lifecycle ${a.lifecycleUid} is terminalizing; control is refused from the first terminal step`
          : undefined;
    }
    return this.retirement.membershipRefusal(caller);
  }

  /** Purge the space's retained message backlog (chat, optionally DMs). Privileged — the manager mints a
   *  short-lived "purger" cred (same destructive grant as `cotal history clear`, isolated off the
   *  supervisor); regular agents are denied STREAM.PURGE under auth. Cleanup only: leaves live agents and
   *  the TASK queue alone. */
  async opPurge(args: Record<string, unknown>, _caller: string): Promise<ControlReply> {
    if (this.config.execution === "none") throw new EpEnvelopeError("unimplemented", this.executionRefusal());
    const includeDms = args.includeDms === true;
    try {
      const creds = this.auth ? await mintCreds(this.auth, newIdentity(), "purger") : undefined;
      const result = await clearSpaceHistory({
        servers: this.config.servers ?? DEFAULT_SERVER,
        space: this.config.space,
        creds,
        includeDms,
      });
      return { ok: true, data: result };
    } catch (e) {
      return { ok: false, error: rejectionText(e) };
    }
  }
}
