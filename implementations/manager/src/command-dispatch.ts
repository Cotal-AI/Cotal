import { DEV_OWNER, EpEnvelopeError, firstCommandId, goalRefOf, principalKey, readGoalResult, rejectionText, resolveAuthProvider } from "@cotal-ai/core";
import type { ControlReply, EpCaller, EpCommandDef, EpErrorCode, EpServeContext } from "@cotal-ai/core";
import { userAuthStateDir } from "@cotal-ai/workspace";
import { managerCommandDefs } from "./manager-service-contract.js";
import type { Manager } from "./manager.js";
import { servedRequestSubject } from "./run-hosting.js";
import type { ManagedAgent, StartAgentOpts } from "./seat-types.js";
import type { TerminalInput } from "./terminal-input.js";
import { listStaticSlotObservations, observeStaticSlot, renderStaticSlotObservation, STATIC_SLOT_READ_FAILED_DETAIL, StaticSlotReadError } from "./static-lifecycle.js";
import type { TranscriptReceiveInput } from "./transcript-receive.js";
import { measureManagerVitals } from "./vitals.js";
import { listHarnessCommands } from "./harness-commands.js";
import type { ManagerConfig } from "./manager-config.js";
import type { ManagerStartState } from "./manager-start-state.js";
import type { ManagerParts } from "./manager-parts.js";
import { needsProvedPtyStop } from "./runtime/shared-pty.js";

export function participantKey(owner: string, actor: string, uid: string): string {
  return `${owner}.${actor}.${uid}`;
}

/** What {@link CommandDispatch} reads from the Manager. Every entry is read at use, so a field the Manager
 *  assigns after construction is always current, and a Manager method a test replaces is the one that runs. */
export interface CommandDispatchDeps {
  agents: () => Manager["agents"];
  participants: () => Manager["participants"];
  resumeRequired: () => Manager["resumeRequired"];
  runHosting: () => Manager["runHosting"];
  transcripts: () => Manager["transcripts"];
  attachAuthorized: (...args: Parameters<Manager["attachAuthorized"]>) => ReturnType<Manager["attachAuthorized"]>;
  authorizeNamed: (...args: Parameters<Manager["authorizeNamed"]>) => ReturnType<Manager["authorizeNamed"]>;
  authorizeRunAmend: (...args: Parameters<Manager["authorizeRunAmend"]>) => ReturnType<Manager["authorizeRunAmend"]>;
  authorizeRunAnswer: (...args: Parameters<Manager["authorizeRunAnswer"]>) => ReturnType<Manager["authorizeRunAnswer"]>;
  beginLifecycle: (...args: Parameters<Manager["beginLifecycle"]>) => ReturnType<Manager["beginLifecycle"]>;
  despawnAuthorized: (...args: Parameters<Manager["despawnAuthorized"]>) => ReturnType<Manager["despawnAuthorized"]>;
  executionRefusal: (...args: Parameters<Manager["executionRefusal"]>) => ReturnType<Manager["executionRefusal"]>;
  findManagedByTarget: (...args: Parameters<Manager["findManagedByTarget"]>) => ReturnType<Manager["findManagedByTarget"]>;
  inputAuthorized: (...args: Parameters<Manager["inputAuthorized"]>) => ReturnType<Manager["inputAuthorized"]>;
  interruptAuthorized: (...args: Parameters<TerminalInput["interruptAuthorized"]>) => ReturnType<TerminalInput["interruptAuthorized"]>;
  lifecycleMembershipRefusal: (...args: Parameters<Manager["lifecycleMembershipRefusal"]>) => ReturnType<Manager["lifecycleMembershipRefusal"]>;
  list: (...args: Parameters<Manager["list"]>) => ReturnType<Manager["list"]>;
  loggedSpawnRefusal: <T>(ctx: EpServeContext, serve: () => Promise<T>) => Promise<T>;
  maintenanceError: (...args: Parameters<Manager["maintenanceError"]>) => ReturnType<Manager["maintenanceError"]>;
  managedPrincipal: (...args: Parameters<Manager["managedPrincipal"]>) => ReturnType<Manager["managedPrincipal"]>;
  managerStatusData: (...args: Parameters<Manager["managerStatusData"]>) => ReturnType<Manager["managerStatusData"]>;
  opCommitResume: (...args: Parameters<Manager["opCommitResume"]>) => ReturnType<Manager["opCommitResume"]>;
  opDefinePersona: (...args: Parameters<Manager["opDefinePersona"]>) => ReturnType<Manager["opDefinePersona"]>;
  opFinalizeResume: (...args: Parameters<Manager["opFinalizeResume"]>) => ReturnType<Manager["opFinalizeResume"]>;
  opLaunch: (...args: Parameters<Manager["opLaunch"]>) => ReturnType<Manager["opLaunch"]>;
  opModels: (...args: Parameters<Manager["opModels"]>) => ReturnType<Manager["opModels"]>;
  opPreservationCtl: (...args: Parameters<Manager["opPreservationCtl"]>) => ReturnType<Manager["opPreservationCtl"]>;
  opPurge: (...args: Parameters<Manager["opPurge"]>) => ReturnType<Manager["opPurge"]>;
  opRemovePersona: (...args: Parameters<Manager["opRemovePersona"]>) => ReturnType<Manager["opRemovePersona"]>;
  opResumePreserved: (...args: Parameters<Manager["opResumePreserved"]>) => ReturnType<Manager["opResumePreserved"]>;
  opStart: (...args: Parameters<Manager["opStart"]>) => ReturnType<Manager["opStart"]>;
  openStaticChatSession: (...args: Parameters<Manager["openStaticChatSession"]>) => ReturnType<Manager["openStaticChatSession"]>;
  psOwnerFilter: (...args: Parameters<Manager["psOwnerFilter"]>) => ReturnType<Manager["psOwnerFilter"]>;
  retireStaticChatSession: (...args: Parameters<Manager["retireStaticChatSession"]>) => ReturnType<Manager["retireStaticChatSession"]>;
  runAnswerer: (...args: Parameters<Manager["runAnswerer"]>) => ReturnType<Manager["runAnswerer"]>;
  runHost: (...args: Parameters<Manager["runHost"]>) => ReturnType<Manager["runHost"]>;
  serveGated: <T>(ctx: EpServeContext, fn: () => T | Promise<T>) => Promise<T>;
  serveObservation: <T>(ctx: EpServeContext, fn: () => T | Promise<T>) => Promise<T>;
  serveSpawnGoal: (...args: Parameters<Manager["serveSpawnGoal"]>) => ReturnType<Manager["serveSpawnGoal"]>;
  serveTurnCancel: (...args: Parameters<Manager["serveTurnCancel"]>) => ReturnType<Manager["serveTurnCancel"]>;
  serveTurnGoal: (...args: Parameters<Manager["serveTurnGoal"]>) => ReturnType<Manager["serveTurnGoal"]>;
  serveTurnParticipation: (...args: Parameters<Manager["serveTurnParticipation"]>) => ReturnType<Manager["serveTurnParticipation"]>;
  serveTurnUnconfirmed: (...args: Parameters<Manager["serveTurnUnconfirmed"]>) => ReturnType<Manager["serveTurnUnconfirmed"]>;
  serveTurnYield: (...args: Parameters<Manager["serveTurnYield"]>) => ReturnType<Manager["serveTurnYield"]>;
  spawnPersona: (...args: Parameters<Manager["spawnPersona"]>) => ReturnType<Manager["spawnPersona"]>;
  stopHandle: (...args: Parameters<Manager["stopHandle"]>) => ReturnType<Manager["stopHandle"]>;
  stopWindowsSeat: (...args: Parameters<Manager["stopWindowsSeat"]>) => ReturnType<Manager["stopWindowsSeat"]>;
  turnPendingFor: (...args: Parameters<Manager["turnPendingFor"]>) => ReturnType<Manager["turnPendingFor"]>;
  turnTarget: (...args: Parameters<Manager["turnTarget"]>) => ReturnType<Manager["turnTarget"]>;
}

/** Builds the {@link CommandDispatchDeps} for a Manager. It reads Manager members by name at each use, so a
 *  field the Manager assigns later is current and a member a test replaces on the instance is the one that runs. */
export function commandDispatchDeps(m: Manager): CommandDispatchDeps {
  return {
    agents: () => m["agents"],
    participants: () => m["participants"],
    resumeRequired: () => m["resumeRequired"],
    runHosting: () => m["runHosting"],
    transcripts: () => m["transcripts"],
    attachAuthorized: (...args) => m["attachAuthorized"](...args),
    authorizeNamed: (...args) => m["authorizeNamed"](...args),
    authorizeRunAmend: (...args) => m["authorizeRunAmend"](...args),
    authorizeRunAnswer: (...args) => m["authorizeRunAnswer"](...args),
    beginLifecycle: (...args) => m["beginLifecycle"](...args),
    despawnAuthorized: (...args) => m["despawnAuthorized"](...args),
    executionRefusal: (...args) => m["executionRefusal"](...args),
    findManagedByTarget: (...args) => m["findManagedByTarget"](...args),
    inputAuthorized: (...args) => m["inputAuthorized"](...args),
    interruptAuthorized: (...args) => m["terminalInputComponent"].interruptAuthorized(...args),
    lifecycleMembershipRefusal: (...args) => m["lifecycleMembershipRefusal"](...args),
    list: (...args) => m["list"](...args),
    loggedSpawnRefusal: (ctx, fn) => m["loggedSpawnRefusal"](ctx, fn),
    maintenanceError: (...args) => m["maintenanceError"](...args),
    managedPrincipal: (...args) => m["managedPrincipal"](...args),
    managerStatusData: (...args) => m["managerStatusData"](...args),
    opCommitResume: (...args) => m["opCommitResume"](...args),
    opDefinePersona: (...args) => m["opDefinePersona"](...args),
    opFinalizeResume: (...args) => m["opFinalizeResume"](...args),
    opLaunch: (...args) => m["opLaunch"](...args),
    opModels: (...args) => m["opModels"](...args),
    opPreservationCtl: (...args) => m["opPreservationCtl"](...args),
    opPurge: (...args) => m["opPurge"](...args),
    opRemovePersona: (...args) => m["opRemovePersona"](...args),
    opResumePreserved: (...args) => m["opResumePreserved"](...args),
    opStart: (...args) => m["opStart"](...args),
    openStaticChatSession: (...args) => m["openStaticChatSession"](...args),
    psOwnerFilter: (...args) => m["psOwnerFilter"](...args),
    retireStaticChatSession: (...args) => m["retireStaticChatSession"](...args),
    runAnswerer: (...args) => m["runAnswerer"](...args),
    runHost: (...args) => m["runHost"](...args),
    serveGated: (ctx, fn) => m["serveGated"](ctx, fn),
    serveObservation: (ctx, fn) => m["serveObservation"](ctx, fn),
    serveSpawnGoal: (...args) => m["serveSpawnGoal"](...args),
    serveTurnCancel: (...args) => m["serveTurnCancel"](...args),
    serveTurnGoal: (...args) => m["serveTurnGoal"](...args),
    serveTurnParticipation: (...args) => m["serveTurnParticipation"](...args),
    serveTurnUnconfirmed: (...args) => m["serveTurnUnconfirmed"](...args),
    serveTurnYield: (...args) => m["serveTurnYield"](...args),
    spawnPersona: (...args) => m["spawnPersona"](...args),
    stopHandle: (...args) => m["stopHandle"](...args),
    stopWindowsSeat: (...args) => m["stopWindowsSeat"](...args),
    turnPendingFor: (...args) => m["turnPendingFor"](...args),
    turnTarget: (...args) => m["turnTarget"](...args),
  };
}

/** A spawn's arguments, its first command named by the id its acceptance gives (spawn-goal.ts). */
function spawnArgs(ctx: EpServeContext): Record<string, unknown> {
  const a = (ctx.request.args ?? {}) as Record<string, unknown>;
  return a.firstCommand === undefined ? a : { ...a, firstCommand: { ...(a.firstCommand as object), id: firstCommandId(ctx.request.id) } };
}

/** The typed manager command table, the control admission both doors share, and the admin reach it reads. */
export class CommandDispatch {
  constructor(private readonly config: Readonly<ManagerConfig>, private readonly deps: CommandDispatchDeps, private readonly parts: Pick<ManagerParts, "connectorInventory" | "goalWriter" | "harnessResolution" | "personaCatalog" | "seatLaunch" | "seatStop">, private readonly state: ManagerStartState) {}

  // The Manager members these bodies read, under their Manager names. Each reads through its dep at
  // use, so a field the Manager assigns later is current and a method a test replaces on the Manager
  // is the one that runs.
  private get agents() { return this.deps.agents(); }
  private get auth() { return this.state.auth; }
  private get managerInstanceId() { return this.state.managerInstanceId!; }
  private get participants() { return this.deps.participants(); }
  private get remoteAuthority() { return this.config.remoteAuthority; }
  private get resumeRequired() { return this.deps.resumeRequired(); }
  private get runHosting() { return this.deps.runHosting(); }
  private get transcripts() { return this.deps.transcripts(); }
  private get userMode() { return this.state.userMode; }
  private attachAuthorized(...args: Parameters<Manager["attachAuthorized"]>): ReturnType<Manager["attachAuthorized"]> { return this.deps.attachAuthorized(...args); }
  private authorizeNamed(...args: Parameters<Manager["authorizeNamed"]>): ReturnType<Manager["authorizeNamed"]> { return this.deps.authorizeNamed(...args); }
  private authorizeRunAmend(...args: Parameters<Manager["authorizeRunAmend"]>): ReturnType<Manager["authorizeRunAmend"]> { return this.deps.authorizeRunAmend(...args); }
  private authorizeRunAnswer(...args: Parameters<Manager["authorizeRunAnswer"]>): ReturnType<Manager["authorizeRunAnswer"]> { return this.deps.authorizeRunAnswer(...args); }
  private beginLifecycle(...args: Parameters<Manager["beginLifecycle"]>): ReturnType<Manager["beginLifecycle"]> { return this.deps.beginLifecycle(...args); }
  private despawnAuthorized(...args: Parameters<Manager["despawnAuthorized"]>): ReturnType<Manager["despawnAuthorized"]> { return this.deps.despawnAuthorized(...args); }
  private executionRefusal(...args: Parameters<Manager["executionRefusal"]>): ReturnType<Manager["executionRefusal"]> { return this.deps.executionRefusal(...args); }
  private findManagedByTarget(...args: Parameters<Manager["findManagedByTarget"]>): ReturnType<Manager["findManagedByTarget"]> { return this.deps.findManagedByTarget(...args); }
  private inputAuthorized(...args: Parameters<Manager["inputAuthorized"]>): ReturnType<Manager["inputAuthorized"]> { return this.deps.inputAuthorized(...args); }
  private interruptAuthorized(...args: Parameters<TerminalInput["interruptAuthorized"]>): ReturnType<TerminalInput["interruptAuthorized"]> { return this.deps.interruptAuthorized(...args); }
  private lifecycleMembershipRefusal(...args: Parameters<Manager["lifecycleMembershipRefusal"]>): ReturnType<Manager["lifecycleMembershipRefusal"]> { return this.deps.lifecycleMembershipRefusal(...args); }
  private list(...args: Parameters<Manager["list"]>): ReturnType<Manager["list"]> { return this.deps.list(...args); }
  private loggedSpawnRefusal<T>(ctx: EpServeContext, serve: () => Promise<T>): Promise<T> { return this.deps.loggedSpawnRefusal(ctx, serve); }
  private maintenanceError(...args: Parameters<Manager["maintenanceError"]>): ReturnType<Manager["maintenanceError"]> { return this.deps.maintenanceError(...args); }
  private managedPrincipal(...args: Parameters<Manager["managedPrincipal"]>): ReturnType<Manager["managedPrincipal"]> { return this.deps.managedPrincipal(...args); }
  private managerStatusData(...args: Parameters<Manager["managerStatusData"]>): ReturnType<Manager["managerStatusData"]> { return this.deps.managerStatusData(...args); }
  private opCommitResume(...args: Parameters<Manager["opCommitResume"]>): ReturnType<Manager["opCommitResume"]> { return this.deps.opCommitResume(...args); }
  private opDefinePersona(...args: Parameters<Manager["opDefinePersona"]>): ReturnType<Manager["opDefinePersona"]> { return this.deps.opDefinePersona(...args); }
  private opFinalizeResume(...args: Parameters<Manager["opFinalizeResume"]>): ReturnType<Manager["opFinalizeResume"]> { return this.deps.opFinalizeResume(...args); }
  private opLaunch(...args: Parameters<Manager["opLaunch"]>): ReturnType<Manager["opLaunch"]> { return this.deps.opLaunch(...args); }
  private opModels(...args: Parameters<Manager["opModels"]>): ReturnType<Manager["opModels"]> { return this.deps.opModels(...args); }
  private opPreservationCtl(...args: Parameters<Manager["opPreservationCtl"]>): ReturnType<Manager["opPreservationCtl"]> { return this.deps.opPreservationCtl(...args); }
  private opPurge(...args: Parameters<Manager["opPurge"]>): ReturnType<Manager["opPurge"]> { return this.deps.opPurge(...args); }
  private opRemovePersona(...args: Parameters<Manager["opRemovePersona"]>): ReturnType<Manager["opRemovePersona"]> { return this.deps.opRemovePersona(...args); }
  private opResumePreserved(...args: Parameters<Manager["opResumePreserved"]>): ReturnType<Manager["opResumePreserved"]> { return this.deps.opResumePreserved(...args); }
  private opStart(...args: Parameters<Manager["opStart"]>): ReturnType<Manager["opStart"]> { return this.deps.opStart(...args); }
  private openStaticChatSession(...args: Parameters<Manager["openStaticChatSession"]>): ReturnType<Manager["openStaticChatSession"]> { return this.deps.openStaticChatSession(...args); }
  private psOwnerFilter(...args: Parameters<Manager["psOwnerFilter"]>): ReturnType<Manager["psOwnerFilter"]> { return this.deps.psOwnerFilter(...args); }
  private retireStaticChatSession(...args: Parameters<Manager["retireStaticChatSession"]>): ReturnType<Manager["retireStaticChatSession"]> { return this.deps.retireStaticChatSession(...args); }
  private runAnswerer(...args: Parameters<Manager["runAnswerer"]>): ReturnType<Manager["runAnswerer"]> { return this.deps.runAnswerer(...args); }
  private runHost(...args: Parameters<Manager["runHost"]>): ReturnType<Manager["runHost"]> { return this.deps.runHost(...args); }
  private serveGated<T>(ctx: EpServeContext, fn: () => T | Promise<T>): Promise<T> { return this.deps.serveGated(ctx, fn); }
  private serveObservation<T>(ctx: EpServeContext, fn: () => T | Promise<T>): Promise<T> { return this.deps.serveObservation(ctx, fn); }
  private serveSpawnGoal(...args: Parameters<Manager["serveSpawnGoal"]>): ReturnType<Manager["serveSpawnGoal"]> { return this.deps.serveSpawnGoal(...args); }
  private serveTurnCancel(...args: Parameters<Manager["serveTurnCancel"]>): ReturnType<Manager["serveTurnCancel"]> { return this.deps.serveTurnCancel(...args); }
  private serveTurnGoal(...args: Parameters<Manager["serveTurnGoal"]>): ReturnType<Manager["serveTurnGoal"]> { return this.deps.serveTurnGoal(...args); }
  private serveTurnParticipation(...args: Parameters<Manager["serveTurnParticipation"]>): ReturnType<Manager["serveTurnParticipation"]> { return this.deps.serveTurnParticipation(...args); }
  private serveTurnUnconfirmed(...args: Parameters<Manager["serveTurnUnconfirmed"]>): ReturnType<Manager["serveTurnUnconfirmed"]> { return this.deps.serveTurnUnconfirmed(...args); }
  private serveTurnYield(...args: Parameters<Manager["serveTurnYield"]>): ReturnType<Manager["serveTurnYield"]> { return this.deps.serveTurnYield(...args); }
  private spawnPersona(...args: Parameters<Manager["spawnPersona"]>): ReturnType<Manager["spawnPersona"]> { return this.deps.spawnPersona(...args); }
  private stopHandle(...args: Parameters<Manager["stopHandle"]>): ReturnType<Manager["stopHandle"]> { return this.deps.stopHandle(...args); }
  private stopWindowsSeat(...args: Parameters<Manager["stopWindowsSeat"]>): ReturnType<Manager["stopWindowsSeat"]> { return this.deps.stopWindowsSeat(...args); }
  private turnPendingFor(...args: Parameters<Manager["turnPendingFor"]>): ReturnType<Manager["turnPendingFor"]> { return this.deps.turnPendingFor(...args); }
  private turnTarget(...args: Parameters<Manager["turnTarget"]>): ReturnType<Manager["turnTarget"]> { return this.deps.turnTarget(...args); }

  /** The ONE shared control-admission chokepoint BOTH dispatch doors
   *  run — the v0.3 `ctl` door ({@link handle}) and the v0.4 `ep` service handlers
   *  ({@link serveGated}): the maintenance/resume fence (`beginLifecycle`: a resume-pending or
   *  non-active manager accepts no ordinary control work) and then the membership gate
   *  ({@link lifecycleMembershipRefusal}: a retiring/terminalizing/retired managed incarnation's
   *  AUTHENTICATED principal holds no control authority even with a valid JWT). Refusal carries
   *  WHICH fence refused so the ep door can map onto the §13.3 catalog; admission returns the
   *  accepted-work release. Never re-implemented per door — a fence on one door is a bypass. */
  admitControl(caller: string):
    | { refusal: string; fence: "maintenance" | "membership"; release?: undefined }
    | { refusal?: undefined; release: () => void } {
    const release = this.beginLifecycle();
    if (!release) return { refusal: this.maintenanceError(), fence: "maintenance" };
    const membership = this.lifecycleMembershipRefusal(caller);
    if (membership) {
      release();
      return { refusal: membership, fence: "membership" };
    }
    return { release };
  }

  /** The ep door's ADMIN flag for a caller. Static mesh: `true` — the
   *  admin-grade rows (any-mode despawn/attach, the `manager.admin` family, `launch`) are minted
   *  only into operator instruments (§13.2: `any` is operator-policy-mintable; the agent/spawn
   *  rollups never carry them), so REACHING the handler is holding the admin tier, exactly as
   *  holding `ctl.<admin>` is today. User mesh: the caller's CURRENT ledger scope must carry
   *  `admin`. A local-host manager reads its own ledger fresh. A remote-authority manager relays the
   *  subject-parsed caller tuple to its host-owned authorization callback, with no participant-ledger
   *  fallback. The same fresh authority drives {@link psOwnerFilter}, so a revoked scope demotes the
   *  very next call even on a still-valid bearer. Local ledger read failures authorize nothing;
   *  remote host-state faults throw and fail the operation closed.
   *  NAMED RESIDUAL: the static `true` has no serve-time re-check — a LEAKED static admin
   *  instrument keeps its reach until the credential's bounded
   *  TTL (the one-shot 5-minute profile), the same static-revoke≠reconnect-death class ruled
   *  across this campaign; static revocation is the TTL, not a ledger. */
  async epAdminReach(caller: EpCaller): Promise<boolean> {
    if (!this.userMode) return true;
    if (this.remoteAuthority) {
      // A hosted run's own caller is derived from its id and holds no ledger row: it acts for the
      // caller its run was admitted for, so that caller's current grant decides, and a revoked
      // login demotes the run's next spawn.
      const asked = this.runHosting?.admittedCaller(caller) ?? caller;
      return this.remoteAuthority.authorizeAdmin({ owner: asked.owner, actor: asked.actor, lifecycleUid: asked.uid });
    }
    try {
      const scope = await resolveAuthProvider().actorScope({
        dir: userAuthStateDir(this.config.workspaceRoot, this.config.space),
        owner: caller.owner,
        actor: caller.actor,
      });
      return scope?.includes("admin") === true;
    } catch {
      return false;
    }
  }

  /** A targeted request's admin flag: mode `any` (the operator instrument's cross-agent form,
   *  rev 3) resolves through {@link epAdminReach}; a user-mode any-mode caller whose CURRENT
   *  ledger row lost `admin` since its rows were minted refuses loud rather than silently
   *  downgrading to the owner path (the request's declared mode is honored or denied, never
   *  reinterpreted). Owner mode is always the privileged (own-domain) path. */
  private async epAnyModeAdmin(ctx: EpServeContext): Promise<boolean> {
    if (ctx.subject.target?.mode !== "any") return false;
    if (!(await this.epAdminReach(ctx.subject.caller)))
      throw new EpEnvelopeError("permission-denied", `an any-mode ${ctx.subject.command} is operator reach; the caller's current ledger grant does not carry "admin" (SPEC 13.2)`);
    return true;
  }

  /** The v0.4 typed command table: every ordinary handler runs the SHARED
   *  admission chokepoint ({@link serveGated}) and then delegates to the SAME op core the ctl
   *  door dispatches (one core, two thin doors). The resume/preservation family
   *  deliberately BYPASSES serveGated — exactly as it sits before {@link admitControl} on the ctl
   *  door (those ops must run while `resumeRequired` fences ordinary work) — riding its own state
   *  fences; its ep gate is the admin-grade `manager.admin` capability grant (static
   *  admin-class commands are capability-gated + untargeted, never a fabricated ledger mode).
   *
   *  TIER SEMANTICS on the ep door: the tier lives in the CALLER'S
   *  GRANT, refined per-op exactly as the ctl doors refine their subject tier. Owner-mode
   *  `despawn`/`attach` keep the privileged semantics (`admin=false`, own-domain via
   *  {@link authorizeNamed}) — every spawn-capable agent holds those rows. ANY-mode requests are
   *  the operator instrument's cross-agent reach (rev 3): the any-mode subject row is mintable
   *  only under operator policy (§13.2), so on a static mesh holding it IS the admin tier, and in
   *  user mode the caller's CURRENT ledger scope must still carry `admin`
   *  ({@link epAdminReach}, the same fresh-read authority `psOwnerFilter` consults). The
   *  `manager.admin` family (purge + the resume/preservation ops) is capability-gated at mint AND
   *  re-checked at serve time via {@link epAdminReach} (the `adminGated` wrapper) so a user's
   *  revoked scope demotes the next call. `launch` is OWNER-EQUALITY on this door for everyone:
   *  the deploy path is its only consumer and stamps the caller's own owner,
   *  so cross-owner launch was a ctl-tier incidental never exercised, and keying it on the actor's
   *  ledger scope broke the deployer-view attenuation - uniform owner-equality is the safe tier.
   *  TWO DELIBERATE NARROWINGS vs the ctl doors (NOT bit-exact parity): (1)
   *  `define-persona` is `admin=false` for everyone (own-persona discipline; no ep consumer needs
   *  cross-owner persona writes - an operator redefines via config, not the wire), where the ctl
   *  admin tier allowed operator cross-owner redefine; (2) launch is owner-equality-only, above.
   *  Both are least-privilege reductions, never widenings. */
  managerServiceDefs(): EpCommandDef[] {
    const args = (ctx: EpServeContext): Record<string, unknown> => (ctx.request.args ?? {}) as Record<string, unknown>;
    const callerOf = (ctx: EpServeContext): string => principalKey(ctx.subject.caller.owner, ctx.subject.caller.actor).key;
    // A ctl-core failure reply becomes the §13.3 structured error the serve boundary publishes.
    // The data half of a failure reply (e.g. a degraded resume result) rides the error MESSAGE
    // only — the action model gives failures a typed channel.
    const unwrap = (r: ControlReply): unknown => {
      if (!r.ok) throw new EpEnvelopeError((r.code ?? "failed-precondition") as EpErrorCode, r.error ?? "the operation failed", r.details, r.outcome);
      return r.data;
    };
    // The admin-family serve gate: every `manager.admin`-class
    // command re-checks operator reach AT SERVE TIME - static: true (the mint boundary already
    // gates the rows to instruments); user mesh: the caller's CURRENT ledger scope must still
    // carry `admin` ({@link epAdminReach}'s fresh read), so a revoked scope demotes the very next
    // call instead of riding the bearer's remaining JWT-row lifetime. The resume family keeps its
    // serveGated BYPASS (those ops must run while the maintenance fence holds) but not the gate.
    const adminGated = async <T>(ctx: EpServeContext, fn: () => T | Promise<T>): Promise<T> => {
      if (!(await this.epAdminReach(ctx.subject.caller)))
        throw new EpEnvelopeError("permission-denied", `${ctx.subject.command} is operator reach; the caller's current ledger grant does not carry "admin" (SPEC 13.2)`, undefined, "not-executed");
      return fn();
    };
    const targetAgent = (ctx: EpServeContext): ManagedAgent => {
      if (this.config.execution === "none") throw new EpEnvelopeError("unimplemented", this.executionRefusal());
      const t = ctx.request.target!; // targeted commands only: the serve boundary enforced body-target presence + fresh currency
      const a = this.findManagedByTarget(t);
      if (!a) throw new EpEnvelopeError("expired", `target ${t.owner}.${t.actor} (lifecycle ${t.lifecycleUid}) is not a live managed agent of this manager`, undefined, "not-executed");
      return a;
    };
    return managerCommandDefs({
      vitals: (ctx) => this.serveGated(ctx, () => measureManagerVitals()),
      // A remote Manager files every seat under its own owner, so only a user mesh's shared local
      // Manager narrows the count, and status never waits on a remote admin check.
      status: (ctx) => this.serveObservation(ctx, async () => {
        const ownerFilter = this.remoteAuthority ? undefined : await this.psOwnerFilter(ctx.subject.caller, false);
        // The daemon's status deadline is shorter than an install. Report the current inventory
        // without waiting for the install, which has its own lifecycle admission below.
        return this.managerStatusData(ownerFilter, !this.resumeRequired);
      }),
      ps: (ctx) => this.serveGated(ctx, async () => this.list(await this.psOwnerFilter(ctx.subject.caller, false))),
      inspect: (ctx) => this.serveGated(ctx, async () => {
        const name = String(args(ctx).name ?? "").trim();
        const row = this.list(await this.psOwnerFilter(ctx.subject.caller, false)).find((x) => x.name === name);
        if (!row) {
          // The live hit above stays entirely local. Only a miss widens into durable static state,
          // where `not-found` is honest only after the slot read itself succeeds and returns absent.
          // User-mode lifecycles have no manager-local mgrslot row; their per-name projection remains
          // the live map until the auth service exposes an equivalent mediated reader.
          if (this.auth && !this.userMode) {
            const recordsKv = this.parts.goalWriter.goalWriter?.ctx.kv;
            if (!recordsKv)
              throw new EpEnvelopeError("unavailable", `the durable static slot store is not ready while inspecting "${name}"`, [
                { kind: STATIC_SLOT_READ_FAILED_DETAIL, name, record: "slot", operation: "read" },
              ]);
            let observed;
            try {
              observed = await observeStaticSlot(recordsKv, DEV_OWNER, name, this.managerInstanceId);
            } catch (error) {
              throw new EpEnvelopeError("unavailable", `the durable static slot state for "${name}" could not be read: ${rejectionText(error)}`, [
                { kind: STATIC_SLOT_READ_FAILED_DETAIL, name, record: error instanceof StaticSlotReadError ? error.record : "slot-or-head", operation: "read" },
              ]);
            }
            // A retired row affirms that no agent exists now, so it keeps the old `not-found`
            // result. The changed refusal is reserved for durable NONTERMINAL state that contradicts
            // the live-map miss and needs operator attention.
            //
            // A sibling's nonterminal row is not a contradiction: the name belongs to another
            // manager instance in this space. In a multi-manager space the class queue hands this
            // read to either instance, so a plain `not-found` here read the same as a name that
            // exists nowhere and a caller had no way to tell the two apart (#443).
            if (observed?.ownerInstanceId !== undefined)
              throw new EpEnvelopeError("failed-precondition", `the durable slot for "${name}" belongs to manager instance ${observed.ownerInstanceId}, not ${this.managerInstanceId} which answered; only that instance can act on it ${renderStaticSlotObservation(observed)}`, [observed]);
            if (observed !== undefined && observed.slotPhase !== "retired")
              throw new EpEnvelopeError("failed-precondition", `no live agent "${name}"; durable state contradicts absence ${renderStaticSlotObservation(observed)}`, [observed]);
          }
          throw new EpEnvelopeError("not-found", `no agent "${name}"`, undefined, "not-executed");
        }
        return row;
      }),
      slots: (ctx) => this.serveGated(ctx, async () => {
        // No manager-local durable static slot store exists for a user-mode or open manager: an
        // empty list here would claim nothing is stranded from a store that was never consulted,
        // the very ambiguity #1274 is about.
        if (!this.auth || this.userMode)
          throw new EpEnvelopeError("failed-precondition", "user-mode and open managers own no durable static slot rows; the projection is static-manager local");
        const recordsKv = this.parts.goalWriter.goalWriter?.ctx.kv;
        if (!recordsKv)
          throw new EpEnvelopeError("unavailable", "the durable static slot store is not ready", [
            { kind: STATIC_SLOT_READ_FAILED_DETAIL, name: "*", record: "slot", operation: "scan" },
          ]);
        let observed;
        try {
          const query = args(ctx);
          observed = await listStaticSlotObservations(recordsKv, DEV_OWNER, this.managerInstanceId, {
            ...(query.names === undefined ? {} : { names: query.names as string[] }),
            ...(query.includeRetired === true ? { includeRetired: true } : {}),
          });
        } catch (error) {
          throw new EpEnvelopeError("unavailable", `the durable static slot state could not be scanned: ${rejectionText(error)}`, [
            { kind: STATIC_SLOT_READ_FAILED_DETAIL, name: "*", record: error instanceof StaticSlotReadError ? error.record : "slot-or-head", operation: "scan" },
          ]);
        }
        return observed.map(({ kind: _kind, ...detail }) => ({
          ...detail,
          live: this.agents.has(detail.name),
          managerInstanceId: this.managerInstanceId,
        }));
      }),
      models: (ctx) => this.serveGated(ctx, async () => {
        const data = unwrap(await this.opModels(args(ctx)));
        return { catalogs: Array.isArray(data) ? data : [data] };
      }),
      goalResult: (ctx) => this.serveGated(ctx, async () => {
        const gw = this.parts.goalWriter.goalWriter;
        if (!gw || gw.nc.isClosed()) throw new EpEnvelopeError("unavailable", "the manager goal-reader connection is not standing; the accepted goal is unaffected");
        const goalId = args(ctx).goalId as string;
        // Only the broker-authenticated caller's full incarnation can name this read. The
        // trusted goal-writer keeps the raw EPF authority; serveEndpoint derives the reply rail.
        const result = await readGoalResult(gw.ctx, goalRefOf(ctx.subject, goalId));
        return { goalId, ...(result === undefined ? {} : { result }) };
      }),
      listDir: (ctx) => this.serveGated(ctx, () => this.parts.seatLaunch.listSpawnDirectory(args(ctx))),
      resolveCwd: (ctx) => this.serveGated(ctx, () => this.parts.seatLaunch.resolveSpawnCwd(args(ctx).cwd)),
      harnessCommands: (ctx) => this.serveGated(ctx, () => listHarnessCommands(args(ctx), this.parts, this.config.workspaceRoot)),
      resolveAgent: (ctx) => this.serveGated(ctx, async () => {
        if (this.config.execution === "none") throw new EpEnvelopeError("unimplemented", this.executionRefusal());
        const persona = await this.spawnPersona(args(ctx) as Pick<StartAgentOpts, "name" | "config" | "agent" | "defaultAgent">, callerOf(ctx), ctx.subject.caller);
        if ("error" in persona) throw new EpEnvelopeError(persona.code ?? (persona.error.startsWith("no persona") ? "not-found" : "failed-precondition"), persona.error);
        return { agent: persona.agent };
      }),
      // `spawn` is an ACTION - accept a goal + reply the acceptance floor payload, drive
      // progress + terminal off-handler (no ~30s block). The blocking reply path is gone.
      // #373: arming the event plane (events: true, or the omission that arms it by default)
      // follows owner-domain reach on a user mesh. Resolve the caller's admin tier once for
      // the residual cross-owner case; opStart decides before connector resolution or grant
      // mutation. Static meshes resolve true and nothing changes.
      spawn: (ctx) => this.loggedSpawnRefusal(ctx, () => this.serveGated(ctx, async () => this.serveSpawnGoal(ctx, async (h) => this.opStart(spawnArgs(ctx), callerOf(ctx), await this.epAdminReach(ctx.subject.caller), h, ctx.subject.route, ctx.subject.caller, servedRequestSubject(this.config.space, ctx))))),
      despawn: (ctx) => this.serveGated(ctx, async () => {
        const a = targetAgent(ctx);
        const denied = await this.authorizeNamed(a, callerOf(ctx), await this.epAnyModeAdmin(ctx), ctx.subject.caller);
        if (denied) throw new EpEnvelopeError("permission-denied", denied, undefined, "not-executed");
        return unwrap(await this.despawnAuthorized(a, args(ctx).graceful !== false, true, callerOf(ctx)));
      }),
      attach: (ctx) => this.serveGated(ctx, async () => {
        const a = targetAgent(ctx);
        const denied = await this.authorizeNamed(a, callerOf(ctx), await this.epAnyModeAdmin(ctx), ctx.subject.caller);
        if (denied) throw new EpEnvelopeError("permission-denied", denied, undefined, "not-executed");
        return unwrap(await this.attachAuthorized(a, ctx.subject.caller));
      }),
      // C3 `input`: the SAME authorization as `attach`, deliberately written out rather than
      // factored with it - the two share a policy, not a body, and a shared wrapper would be a
      // place for one of them to quietly acquire a condition the other does not have.
      input: (ctx) => this.serveGated(ctx, async () => {
        const a = targetAgent(ctx);
        const denied = await this.authorizeNamed(a, callerOf(ctx), await this.epAnyModeAdmin(ctx), ctx.subject.caller);
        if (denied) throw new EpEnvelopeError("permission-denied", denied, undefined, "not-executed");
        return this.inputAuthorized(a, args(ctx));
      }),
      // `interrupt`: the same authorization as `input`, written out for the same reason.
      interrupt: (ctx) => this.serveGated(ctx, async () => {
        const a = targetAgent(ctx);
        const denied = await this.authorizeNamed(a, callerOf(ctx), await this.epAnyModeAdmin(ctx), ctx.subject.caller);
        if (denied) throw new EpEnvelopeError("permission-denied", denied, undefined, "not-executed");
        return this.interruptAuthorized(a);
      }),
      // The turn relay (§8 durable actions): `turn` shares despawn/input's reach policy — the
      // caller must hold owner-equality or admin over the TARGET seat — written out for the same
      // reason `input` is (a shared policy, not a shared body).
      turn: (ctx) => this.serveGated(ctx, async () => {
        const target = this.turnTarget(ctx);
        if (target.kind === "managed") {
          const denied = await this.authorizeNamed(target.agent, callerOf(ctx), await this.epAnyModeAdmin(ctx), ctx.subject.caller);
          if (denied) throw new EpEnvelopeError("permission-denied", denied, undefined, "not-executed");
        } else {
          const admitted = this.runHosting?.admittedCaller(ctx.subject.caller);
          if (!admitted || admitted.owner !== target.participant.owner || admitted.actor !== target.participant.actor || admitted.uid !== target.participant.uid)
            throw new EpEnvelopeError("permission-denied", "a personal participant may be turned only by the workflow run admitted for that exact owner, actor and lifecycle", undefined, "not-executed");
          if (!this.remoteAuthority?.authorizeParticipation)
            throw new EpEnvelopeError("unimplemented", "the issuing host supplies no closed personal participation authorization", undefined, "not-executed");
          const authorized = await this.remoteAuthority.authorizeParticipation({
            owner: target.participant.owner,
            actor: target.participant.actor,
            lifecycleUid: target.participant.uid,
          });
          if (!authorized) {
            this.participants.delete(participantKey(target.participant.owner, target.participant.actor, target.participant.uid));
            throw new EpEnvelopeError("permission-denied", "the exact personal lifecycle is no longer foreground-authorized with run scope", undefined, "not-executed");
          }
        }
        return this.serveTurnGoal(ctx, target);
      }),
      // A personal native lifecycle must opt in explicitly. The command is self-targeted and returns
      // only a finite relay lease. It never inserts a ManagedAgent or grants stop/attach/input custody.
      turnParticipate: (ctx) => this.serveGated(ctx, () => this.serveTurnParticipation(ctx.subject.caller)),
      // The seat's own half of the relay (`manager.self`, stop-self's tier): a seat pulls the
      // turns addressed to ITS incarnation and yields them; no reach beyond itself exists here.
      turnPending: (ctx) => this.serveGated(ctx, () => this.turnPendingFor(ctx.subject.caller)),
      turnYield: (ctx) => this.serveGated(ctx, () => this.serveTurnYield(ctx.subject.caller, args(ctx))),
      turnUnconfirmed: (ctx) => this.serveGated(ctx, () => this.serveTurnUnconfirmed(ctx.subject.caller, args(ctx))),
      // The reserved goal cancel (SPEC 13.6 item 4), served for the relay: the goal ref is the
      // authenticated caller's own, so a run withdraws only the turns it submitted.
      cancel: (ctx) => this.serveGated(ctx, () => this.serveTurnCancel(ctx)),
      stopSelf: (ctx) => this.serveGated(ctx, async () => unwrap(await this.opStopSelf(callerOf(ctx), args(ctx)))),
      definePersona: (ctx) => this.serveGated(ctx, async () => unwrap(await this.opDefinePersona(args(ctx), callerOf(ctx), false, ctx.subject.caller))),
      removePersona: (ctx) => this.serveGated(ctx, () => {
        const r = this.opRemovePersona(args(ctx), callerOf(ctx), false);
        if (!r.ok) throw new EpEnvelopeError((r.code ?? "failed-precondition") as EpErrorCode, r.error ?? "the operation failed", r.details, "not-executed");
        return r.data;
      }),
      // Reach is the broker's: only operator instruments carry these rows. The serve gate is the
      // maintenance fence, so neither runs while a shutdown or resume holds control.
      chatSessionOpen: (ctx) => this.serveGated(ctx, () => this.openStaticChatSession(args(ctx))),
      chatSessionRetire: (ctx) => this.serveGated(ctx, () => this.retireStaticChatSession(args(ctx))),
      listPersonas: (ctx) => this.serveGated(ctx, () => unwrap(this.parts.personaCatalog.opListPersonas(callerOf(ctx), false))),
      showPersona: (ctx) => this.serveGated(ctx, () => {
        const r = this.parts.personaCatalog.opShowPersona(args(ctx), callerOf(ctx), false);
        if (!r.ok) {
          const msg = r.error ?? "not found";
          if (msg.startsWith("no persona")) throw new EpEnvelopeError("not-found", msg);
          throw new EpEnvelopeError("failed-precondition", msg);
        }
        return r.data;
      }),
      purge: (ctx) => this.serveGated(ctx, () => adminGated(ctx, async () => unwrap(await this.opPurge(args(ctx), callerOf(ctx))))),
      // launch is OWNER-EQUALITY on the ep door for every caller: the deploy
      // path is the only launch consumer and its spec stamps the CALLER's own owner, so
      // owner-equality always holds for a legitimate deploy; cross-owner launch was a ctl
      // admin-tier INCIDENTAL never exercised by a real flow (static is single-owner, so the flag
      // is a no-op there). Keying admin on epAdminReach read the ACTOR's ledger scope, which does
      // NOT reflect the deployer VIEW's privileged-tier attenuation - an admin user's stolen
      // deployer bearer would then bypass owner-equality (operator launch) despite the view holding
      // no admin rows. Uniform owner-equality removes that divergence in the least-privilege
      // direction.
      // Manifest `launch` is an ACTION through the SAME chokepoint as spawn -
      // the manifest resolve + owner-equality authz run in opLaunch's accept path, then the goal
      // drives progress + terminal. The acceptance floor is the allocated identity + goal coords.
      launch: (ctx) => this.serveGated(ctx, () => this.serveSpawnGoal(ctx, (h) => this.opLaunch(args(ctx), callerOf(ctx), false, h, ctx.subject.route))),
      resumePreserved: (ctx) => adminGated(ctx, async () => unwrap(await this.opResumePreserved(args(ctx)))),
      commitResume: (ctx) => adminGated(ctx, async () => unwrap(await this.opCommitResume(args(ctx)))),
      finalizeResume: (ctx) => adminGated(ctx, async () => unwrap(await this.opFinalizeResume(args(ctx)))),
      // The workflow-run family (SPEC 14.3): the manager hosts the driver. Reach is the broker's
      // (`run` capability / privileged instrument rows); the serve gate is the maintenance fence.
      runStart: (ctx) => this.serveGated(ctx, () => this.runHost().start(ctx, args(ctx) as { source: string; file?: string; timeout?: string })),
      runStartKeyed: (ctx) => this.serveGated(ctx, () => this.runHost().startKeyed(ctx, args(ctx) as { source: string; file?: string; timeout?: string })),
      runSubmissionStatus: (ctx) => this.serveGated(ctx, () => this.runHost().submissionStatus(ctx, String(args(ctx).submissionId))),
      runResume: (ctx) => this.serveGated(ctx, () => this.runHost().resume(args(ctx) as { runId: string; timeout?: string }, ctx)),
      runCancel: (ctx) => {
        const host = this.runHost();
        host.validateCancellation(ctx, args(ctx));
        return this.serveGated(ctx, () => host.cancel(ctx, args(ctx)));
      },
      runAnswer: (ctx) => this.serveGated(ctx, () => {
        const input = args(ctx) as { runId: string; endpoint?: string; stepKey: string; value?: unknown; artifact?: string; amend?: boolean };
        if (input.amend === true)
          return this.runHost().amend(input, this.runAnswerer(ctx), (accepted) => this.authorizeRunAmend(ctx, accepted), ctx);
        return this.runHost().answer(input, this.runAnswerer(ctx), (open) => this.authorizeRunAnswer(ctx, input, open), ctx);
      }),
      runStatus: (ctx) => this.serveGated(ctx, () => this.runHost().status(args(ctx) as { runId: string; endpoint?: string; journal?: { offset: number } }, ctx)),
      runPs: (ctx) => this.serveGated(ctx, () => this.runHost().list(args(ctx) as { endpoint?: string; page?: { limit?: number; cursor?: string } }, ctx)),
      preparePreservation: (ctx) => adminGated(ctx, async () => unwrap(await this.opPreservationCtl("preparePreservation", args(ctx)))),
      commitPreservation: (ctx) => adminGated(ctx, async () => unwrap(await this.opPreservationCtl("commitPreservation", args(ctx)))),
      abortPreservation: (ctx) => adminGated(ctx, async () => unwrap(await this.opPreservationCtl("abortPreservation", args(ctx)))),
      transcriptReceive: (ctx) => this.serveGated(ctx, () => adminGated(ctx, () => {
        if (this.config.execution === "none") throw new EpEnvelopeError("unimplemented", this.executionRefusal());
        if (!this.transcripts)
          throw new EpEnvelopeError("failed-precondition", "transcript-receive: this manager does not receive carried transcripts (its remote authority issues no transfer reader)");
        return this.transcripts.receive(args(ctx) as unknown as TranscriptReceiveInput);
      })),
    });
  }

  /** Self-despawn (P2b): stop the managed agent whose id == the authenticated caller. The
   *  no-name self-op can only ever resolve to the caller's OWN managed entry (ids are unique
   *  per spawn + non-forgeable in auth mode), never a peer — so it's structurally incapable of
   *  hitting another agent. Non-managed callers (human CLI, the manager itself, observers) find
   *  no match and get a loud error, not a silent no-op. */
  opStopSelf(callerId: string, args: Record<string, unknown>): ControlReply | Promise<ControlReply> {
    if (this.config.execution === "none") throw new EpEnvelopeError("unimplemented", this.executionRefusal());
    const target = [...this.agents.values()].find((a) => this.managedPrincipal(a) === callerId);
    if (!target) return { ok: false, error: `self-stop: caller ${callerId} is not a managed agent` };
    const graceful = args.graceful !== false;
    if (needsProvedPtyStop(target.handle)) {
      return this.stopWindowsSeat(target, graceful, true, { kind: "stopped-self" }).then(() => ({ ok: true, data: { name: target.name, stopped: true, graceful } }));
    }
    this.stopHandle(target, graceful, { kind: "stopped-self" });
    this.parts.seatStop.trackStoppedHandle(target, true, { kind: "stopped-self" });
    return { ok: true, data: { name: target.name, stopped: true, graceful } };
  }
}
