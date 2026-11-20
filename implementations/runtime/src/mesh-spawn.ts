/** A run's `spawn` action: the two-phase cwd resolution against the pinned manager instance, the
 *  worktree claim and release that guard a logical worktree against concurrent spawns, the spawn
 *  submission and its terminal await, plus the module helpers only spawn uses. The mesh handler
 *  composes it; every handler input is read through the handler at its use. */
import { isAbsolute } from "node:path";
import {
  IncompleteKvScan,
  invokeCommand,
  readGoalResult,
  readGoalStatus,
  EpEnvelopeError,
  type EpAttributedReply,
  type GoalRef,
  type GoalResultFact,
  type Presence,
  type ResolvedService,
} from "@cotal-ai/core";
import {
  Cancelled,
  EffectError,
  type AgentHandleValue,
  type CancelSignal,
  type EffectContext,
  type InlineSpawnDefinition,
  type SpawnRequest,
  digest,
  journalEntryKeyString,
} from "@cotal-ai/lang";
import { delay } from "./delay.js";
import {
  type CwdResolution,
  GOAL_POLL_MS,
  parseAgentHandle,
  readPermits,
  readSupervise,
  SPAWN_ACCEPT_DEADLINE_MS,
  spawnDespawnTarget,
  WAIT_POLL_MS,
} from "./mesh-handler-shared.js";
import type { MeshHandler } from "./mesh-handler.js";

/** How many incomplete presence scans the worktree guard tolerates before it fails loudly. */
const WORKTREE_SCAN_ATTEMPTS = 5;
/** The single named refusal every phase-A failure direction produces: the target does not serve
 *  `resolve-cwd`, refuses the path, or answers with something that is not an absolute directory.
 *  `L4000` is the host declining the request, and it is raised before any submission, so nothing is
 *  bound, allocated or launched. There is no raw-path arm: a fall-back to the caller's string is
 *  fail-OPEN, and launching somewhere plausible is the outcome being removed. */
function cwdResolutionRefusal(persona: string, instanceId: string, cwd: string, cause: string): EffectError {
  return new EffectError("L4000", "spawn",
    `spawn(${persona}) cwd ${JSON.stringify(cwd)} was not resolved by manager instance ${instanceId}: ${cause}; refusing rather than dispatching a path this host never canonicalized`);
}

/** A journalled phase-A resolution, read back on resume. A garbled entry is treated as absent and
 *  phase A runs again: re-resolving is free (no goal, no reservation), trusting a broken record is
 *  not. */
function readCwdResolution(value: unknown): CwdResolution | undefined {
  const r = value as { cwd?: unknown; endpoint?: unknown; instanceId?: unknown; host?: unknown } | undefined;
  if (typeof r?.cwd !== "string" || r.cwd.length === 0 || typeof r.endpoint !== "string" || typeof r.instanceId !== "string")
    return undefined;
  return { cwd: r.cwd, endpoint: r.endpoint, instanceId: r.instanceId, ...(typeof r.host === "string" ? { host: r.host } : {}) };
}

/** The manager `spawn` args a {@link SpawnRequest} submits: persona names the persona file
 *  (`name`), `join` becomes the seat's channel subscriptions. `permits` stay on the run (they
 *  bind at `turn`); `supervise` travels because the manager is who restarts the process, and
 *  `events` because the manager is who arms the event plane (`false` is `--no-events`). */
export function spawnArgs(req: SpawnRequest): Record<string, unknown> {
  return {
    name: req.persona,
    // An inline persona travels as the manager's `persona` record, whose `name` is the spawn's own.
    ...(req.inline !== undefined ? { persona: Object.fromEntries(Object.entries(req.inline).filter(([k]) => k !== "name")) } : {}),
    ...(req.model !== undefined ? { model: req.model } : {}),
    ...(req.variant !== undefined ? { variant: req.variant } : {}),
    // #1616 item 5: the cwd dispatched here is ALREADY the canonical form, resolved by the serving
    // manager in phase A (see MeshEffectHandler.resolveCwd) and read back off the journalled
    // resolution. This projection no longer canonicalizes anything: `realpathSync` in the driver
    // answers about the DRIVER's filesystem, which is a different host's answer to the question.
    ...(req.cwd !== undefined ? { cwd: req.cwd } : {}),
    ...(req.role !== undefined ? { role: req.role } : {}),
    ...(req.join !== undefined && req.join.length > 0 ? { subscribe: req.join.map((c) => c.channel) } : {}),
    ...(req.supervise !== undefined ? { supervise: readSupervise(req.supervise, req.persona) } : {}),
    ...(req.events !== undefined ? { events: req.events } : {}),
    ...(req.runtime !== undefined ? { runtime: req.runtime } : {}),
  };
}

/** An inline binding read back off a journal entry, or `undefined` when the entry has none. A
 *  binding that is present but unreadable is refused, never read as a catalog spawn. */
function readInlineBinding(value: unknown): { definition: InlineSpawnDefinition; digest: string } | undefined {
  if (value === undefined) return undefined;
  const r = value as { definition?: unknown; digest?: unknown } | null;
  if (r === null || typeof r !== "object" || typeof r.digest !== "string" || r.definition === null || typeof r.definition !== "object"
    || digest(r.definition) !== r.digest)
    throw new Error(`a journalled inline persona binding is unreadable or does not match its digest (${JSON.stringify(value)?.slice(0, 120)}); refused rather than read as a catalog spawn`);
  return { definition: r.definition as InlineSpawnDefinition, digest: r.digest };
}

/** The acceptance-floor fields worth binding: the allocated identity a discharge despawns by, and
 *  the readiness window that bounds its wait for a terminal. Copied field-by-field so a widened
 *  acceptance never smuggles unknown keys into the journal. */
function pickAcceptanceFloor(floor: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of ["name", "owner", "actor", "uid", "readinessDeadlineMs"] as const) {
    if (floor[k] !== undefined) out[k] = floor[k];
  }
  return out;
}
/**
 * The program's value from a spawn terminal. `succeeded` yields the agent handle — `agent` is the
 * `<name>#<lifecycleUid>` composite, one string that addresses the NAME the mesh knows the seat by
 * while pinning WHICH incarnation this run spawned (a respawned namesake is not this handle).
 * Every other state throws the catchable spawn failure (L4002) carrying the terminal's own reason:
 * `failed` and `uncertain` are the manager's readiness verdicts, `cancelled` means a despawn ended
 * the launch under it. Each of them leaves the program with an agent that is not up, which is
 * what L4002 names; each replays identically because the fact is durable. A refusal at accept is
 * a different thing (no agent was ever allocated) and is classed at the accept, in `spawn`. The
 * handle's worktree is the BOUND one: the request's for a spawn this step submitted, the seat's own
 * for one a migration handed it (an adopted seat keeps its tree whether or not the edit names it).
 */
function spawnHandleOf(req: SpawnRequest, ext: Readonly<Record<string, unknown>>, fact: GoalResultFact, endpoint: string): AgentHandleValue {
  if (fact.state !== "succeeded") {
    const d = fact.data as { error?: unknown; reason?: unknown; cancelledBy?: unknown } | undefined;
    const why =
      typeof d?.error === "string" ? d.error
      : typeof d?.reason === "string" ? d.reason
      : d?.cancelledBy !== undefined ? `cancelled by ${JSON.stringify(d.cancelledBy)}`
      : `the ${endpoint} endpoint recorded no reason`;
    throw new EffectError("L4002", "spawn", `spawn(${req.persona}) ${fact.state}: ${why}`, { state: fact.state });
  }
  const d = fact.data as { name?: unknown; lifecycleUid?: unknown; role?: unknown } | undefined;
  if (typeof d?.name !== "string" || typeof d.lifecycleUid !== "string")
    throw new Error(`the spawn goal's succeeded terminal carries no readable agent identity (${JSON.stringify(fact.data)}); a garbled terminal never yields a handle (SPEC 13.6)`);
  return {
    agent: `${d.name}#${d.lifecycleUid}`,
    persona: req.persona,
    ...(typeof ext.worktree === "string" ? { worktree: ext.worktree } : {}),
    ...(typeof d.role === "string" ? { role: d.role } : {}),
  };
}

/** What {@link MeshSpawn} reads from the MeshHandler. Every entry is read at use, so a field the handler
 *  assigns after construction is always current, and a handler method a suite replaces is the one that runs. */
export interface MeshSpawnDeps {
  actionCtx: (...args: Parameters<MeshHandler["actionCtx"]>) => ReturnType<MeshHandler["actionCtx"]>;
  adoptable: () => MeshHandler["adoptable"];
  binding: () => MeshHandler["binding"];
  invokeManager: (...args: Parameters<MeshHandler["invokeManager"]>) => ReturnType<MeshHandler["invokeManager"]>;
  manager: (...args: Parameters<MeshHandler["manager"]>) => ReturnType<MeshHandler["manager"]>;
  nc: () => MeshHandler["nc"];
  now: (...args: Parameters<MeshHandler["now"]>) => ReturnType<MeshHandler["now"]>;
  presenceRows: (...args: Parameters<MeshHandler["presenceRows"]>) => ReturnType<MeshHandler["presenceRows"]>;
  roster: () => MeshHandler["roster"];
  worktreeHolders: () => MeshHandler["worktreeHolders"];
}

/** The spawn members of a mesh handler, over the handler's own inputs. */
export class MeshSpawn {
  constructor(private readonly deps: MeshSpawnDeps) {}

  // The MeshHandler members these bodies read, under their handler names. Each reads through its dep at
  // use, so a field the handler assigns later is current and a method a suite replaces on the handler
  // is the one that runs.
  private actionCtx(...args: Parameters<MeshHandler["actionCtx"]>): ReturnType<MeshHandler["actionCtx"]> { return this.deps.actionCtx(...args); }
  private get adoptable() { return this.deps.adoptable(); }
  private get binding() { return this.deps.binding(); }
  private invokeManager(...args: Parameters<MeshHandler["invokeManager"]>): ReturnType<MeshHandler["invokeManager"]> { return this.deps.invokeManager(...args); }
  private manager(...args: Parameters<MeshHandler["manager"]>): ReturnType<MeshHandler["manager"]> { return this.deps.manager(...args); }
  private get nc() { return this.deps.nc(); }
  private now(...args: Parameters<MeshHandler["now"]>): ReturnType<MeshHandler["now"]> { return this.deps.now(...args); }
  private presenceRows(...args: Parameters<MeshHandler["presenceRows"]>): ReturnType<MeshHandler["presenceRows"]> { return this.deps.presenceRows(...args); }
  private get roster() { return this.deps.roster(); }
  private get worktreeHolders() { return this.deps.worktreeHolders(); }

  /**
   * #1616 item 5 — PHASE A, RESOLVE ON THE HOST THAT WILL LAUNCH. A directory is a fact about one
   * filesystem, so the only process that can canonicalize it is the manager instance that will
   * `chdir` into it. This asks the PINNED instance for the canonical form and returns it together
   * with the identity that answered, so phase B dispatches the resolved path and the journal records
   * which host resolved it. There is deliberately NO envelope `id`: a resolve binds no goal, takes
   * no reservation and allocates nothing, so a retry or a crash between the phases costs nothing.
   *
   * EVERY failure direction is a REFUSAL. A path the target cannot resolve is not passed through as
   * the raw string: the raw string would launch somewhere plausible on the manager's own root, which
   * is the fail-open outcome this repair exists to remove.
   */
  private async resolveCwd(req: SpawnRequest, service: ResolvedService, cwd: string, instanceId: string): Promise<CwdResolution> {
    let reply: EpAttributedReply;
    try {
      reply = await invokeCommand(this.nc, this.binding.space, service, "resolve-cwd", { cwd }, {
        deadlineMs: SPAWN_ACCEPT_DEADLINE_MS,
      });
    } catch (err) {
      // An older manager does not list `resolve-cwd`, and `invokeCommand` refuses an unlisted
      // command with `not-found` before it publishes anything. That is
      // the fail-CLOSED direction and it stays closed: a host that cannot answer the question does
      // not get handed the caller's guess.
      throw cwdResolutionRefusal(req.persona, instanceId, cwd,
        err instanceof EpEnvelopeError && err.code === "not-found"
          ? `this manager serves no resolve-cwd command, so it can state no canonical form (${err.message})`
          : String((err as Error)?.message ?? err));
    }
    if (reply.reply.ok === false)
      throw cwdResolutionRefusal(req.persona, instanceId, cwd, reply.reply.error.message);
    const data = reply.reply.data as { cwd?: unknown; host?: unknown } | undefined;
    if (typeof data?.cwd !== "string" || data.cwd.length === 0 || !isAbsolute(data.cwd))
      throw cwdResolutionRefusal(req.persona, instanceId, cwd,
        `the reply names no absolute directory (${JSON.stringify(data?.cwd)})`);
    // The AUTHORITATIVE identity is the one that answered, off the attributed reply's subject, not
    // the one the caller asked for: the pinned resolve already rejects a reply from another
    // instance, so recording the responder is recording what was checked.
    return {
      cwd: data.cwd,
      endpoint: reply.responder.endpoint,
      instanceId: reply.responder.instanceId,
      ...(typeof data.host === "string" ? { host: data.host } : {}),
    };
  }

  /**
   * The runtime half of "two agents MUST NOT share a worktree concurrently" (spec 6.5; the
   * validator owns the literal case as L3022). The registry records who holds each logical
   * worktree this run spawned into — the live seat, or the spawn still bringing one up — and a
   * new spawn CLAIMS the tree here before anything is submitted: a tree nobody holds is taken in
   * the same synchronous step that read it, so two branches spawning into one computed id cannot
   * both pass; a tree held by a spawn in flight refuses; a tree held by a seat is admitted only
   * when that holder is no longer live on presence, and re-read after the liveness wait, because
   * a sibling may have claimed it meanwhile. Sequential reuse is legal, concurrency is data loss.
   * The liveness read is the same witness `wait(down)` and a conclave join use, so "still
   * holding" and "down" are one definition — a discharged loser or a crashed seat releases its
   * tree the moment its presence row is gone, with no bookkeeping of its own.
   */
  private async claimWorktree(worktree: string, persona: string, goalId: string): Promise<void> {
    const holder = this.worktreeHolders.get(worktree);
    if (holder === undefined) {
      this.worktreeHolders.set(worktree, { pending: goalId });
      return;
    }
    if ("pending" in holder)
      throw new EffectError(
        "L4008", "worktree",
        `spawn(${persona}) would put a second agent into the worktree "${worktree}" while spawn goal ${holder.pending} is still bringing one up in it; two agents MUST NOT share a worktree concurrently (L3022/L4008)`,
      );
    let rows: readonly Presence[];
    for (let attempt = 1; ; attempt += 1) {
      try {
        rows = await this.presenceRows();
        break;
      } catch (e) {
        // A scan that keeps coming back incomplete is a broken presence plane, and a guard that
        // never answers would park the spawn for good: bounded, then the scan's own error.
        if (!(e instanceof IncompleteKvScan) || attempt >= WORKTREE_SCAN_ATTEMPTS) throw e;
        await delay(WAIT_POLL_MS);
      }
    }
    if (rows.some((p) => p.card.name === holder.name && p.lifecycleUid === holder.uid))
      throw new EffectError(
        "L4008", "worktree",
        `spawn(${persona}) would put a second agent into the worktree "${worktree}" while ${holder.name}#${holder.uid} is live in it; two agents MUST NOT share a worktree concurrently (L3022/L4008)`,
      );
    const now = this.worktreeHolders.get(worktree);
    if (now !== undefined && now !== holder)
      throw new EffectError(
        "L4008", "worktree",
        `spawn(${persona}) would put a second agent into the worktree "${worktree}", which ${"pending" in now ? `spawn goal ${now.pending}` : `${now.name}#${now.uid}`} claimed while this spawn read its previous holder's liveness; two agents MUST NOT share a worktree concurrently (L3022/L4008)`,
      );
    this.worktreeHolders.set(worktree, { pending: goalId });
  }

  /**
   * `spawn` is the manager's spawn ACTION, submitted under the step's own identity.
   *
   * **The request id is the goalId.** The envelope id is pinned to `ctx.requestId`, and the
   * manager binds its goal under the envelope id — so a resumed run that re-submits is served the
   * RECORDED acceptance (same fingerprint, same goal) instead of allocating a second seat, and the
   * goal's terminal fact sits on a subject this run can re-derive from nothing but its journal.
   *
   * The ACCEPTANCE is bound as the entry's external state before the terminal is awaited, so a
   * crash mid-await resumes straight into the poll — it must NOT re-invoke, because by then the
   * manager may have restarted and a fresh submission would be judged against a live seat rather
   * than served from its acceptance cache. The terminal await itself is a read of a durable fact,
   * deliberately not `submitAndFollowGoal`: a live progress subscription dies with the process,
   * and the fact is the thing a resume can still read.
   *
   * `permits`, `supervise` and `onFork` are POLICY, not identity (§6.4): they ride the journalled
   * request and are enforced where they bind (`permits` at `turn`, `supervise` as the manager's
   * restart budget on the spawn submission, an `onFork` at fork adoption).
   */
  async spawn(req: SpawnRequest, ctx: EffectContext): Promise<AgentHandleValue> {
    if (ctx.signal.cancelled) throw new Cancelled(ctx.signal.reason ?? "cancelled");
    const goalId = ctx.requestId;

    // Placement is explicit and host-local. Refuse malformed values before manager discovery or
    // submission, so an invalid request can never turn into an omitted `cwd` and inherit the
    // manager's workspace root. Existence and launch authority stay with the serving manager.
    if (req.cwd !== undefined && (typeof req.cwd !== "string" || req.cwd.length === 0 || !isAbsolute(req.cwd)))
      throw new EffectError("L4000", "spawn",
        `spawn(${req.persona}) cwd must be a non-empty absolute directory on the serving manager's host; refusing ${JSON.stringify(req.cwd)} rather than falling back`);

    // #1616 ITEM 2 — THE AFFINITY GATE. A directory is HOST-LOCAL, so a request that names one but
    // names no manager instance rides the class `one` queue and lands wherever the anycast fell.
    // The design record calls that combination not acceptable, so it REFUSES. There is deliberately
    // NO anycast fallback: falling back IS the defect. And the refusal is raised HERE, ahead of
    // `readPermits`, ahead of `this.manager()`'s describe round-trip, ahead of any submission,
    // acceptance or launch — so nothing is reserved, claimed or started before it. Legacy
    // cwd-omitted spawns never reach this line and keep their prior behaviour byte for byte.
    if (req.cwd !== undefined && req.placement === undefined)
      throw new EffectError("L4000", "spawn",
        `spawn(${req.persona}) names a cwd but no placement target: a host-local directory needs an explicit { endpoint, instanceId } manager instance, and this spawn refuses rather than falling back to class anycast`);
    if (req.placement !== undefined
        && (typeof req.placement.endpoint !== "string" || req.placement.endpoint.length === 0
          || typeof req.placement.instanceId !== "string" || req.placement.instanceId.length === 0))
      throw new EffectError("L4000", "spawn",
        `spawn(${req.persona}) placement must name both an endpoint and an instanceId; refusing ${JSON.stringify(req.placement)} rather than dispatching unpinned`);
    // Naming a target the run is not bound to is a mismatched target, not a request to go find it:
    // automatic manager discovery is outside this bounded repair, so it refuses here too.
    if (req.placement !== undefined && req.placement.endpoint !== this.binding.endpoint)
      throw new EffectError("L4000", "spawn",
        `spawn(${req.persona}) placement targets endpoint ${JSON.stringify(req.placement.endpoint)} but this run is bound to ${JSON.stringify(this.binding.endpoint)}; refusing rather than dispatching off-binding`);
    // The manager reads only a boolean `events`, so any other value would arm the default plane
    // the author was trying to opt out of. Refused before anything is submitted.
    if (req.events !== undefined && typeof req.events !== "boolean")
      throw new EffectError("L4000", "spawn",
        `spawn(${req.persona}) events must be true or false; refusing ${JSON.stringify(req.events)} rather than launching with the default event plane`);
    if (req.runtime !== undefined && (typeof req.runtime !== "string" || req.runtime.trim() === ""))
      throw new EffectError("L4000", "spawn",
        `spawn(${req.persona}) runtime must be a non-empty runtime name; refusing ${JSON.stringify(req.runtime)} rather than launching on the manager's own runtime`);

    // A recorded goalId is a previous attempt's ACCEPTANCE: the submission landed and its
    // identity was bound before the crash. Go straight back to the terminal. An entry that says
    // `adoptedFrom` names the goal the ORPHANED spawn submitted, not this step's own request id:
    // that goal is the terminal this step reads on every pass, and no pass ever submits one.
    const recorded = ctx.resume as Readonly<Record<string, unknown>> | undefined;
    let ext: Readonly<Record<string, unknown>> | undefined =
      typeof recorded?.goalId === "string" && (recorded.goalId === goalId || typeof recorded.adoptedFrom === "string")
        ? recorded
        : undefined;
    const checkRecordedPlacement = (floor: Readonly<Record<string, unknown>> | undefined): void => {
      if (req.placement !== undefined && floor?.host !== req.placement.instanceId)
        throw new EffectError("L4000", "spawn", `spawn(${req.persona}) requested placement ${req.placement.instanceId} but the accepted seat's recorded host is ${typeof floor?.host === "string" ? floor.host : "unrecorded"}; an adopted or resumed seat cannot be moved by a new request`);
    };
    if (ext !== undefined) checkRecordedPlacement(ext);
    // An inline persona is bound with its digest before anything is submitted, and every later bind
    // restates it, so a resume submits the definition it recorded and a migration hands a seat only
    // to a spawn of the same definition. The input hash already ties the two; this checks it.
    const inlineDigest = req.inline === undefined ? undefined : digest(req.inline);
    const recordedInline = readInlineBinding(recorded?.inline);
    if (recordedInline !== undefined && recordedInline.digest !== inlineDigest)
      throw new Error(`spawn(${req.persona}): the journal recorded an inline definition with digest ${recordedInline.digest}, and this spawn's is ${inlineDigest ?? "a catalog persona"}; a resume never submits another definition than the one it recorded`);
    let inline = recordedInline ?? (req.inline === undefined ? undefined : { definition: req.inline, digest: inlineDigest! });
    // A budget this host cannot meter is refused before anything is submitted: accepting it and
    // enforcing nothing would be the silent no-op the effect table exists to prevent.
    const permits = req.permits !== undefined ? readPermits(req.permits, req.persona) : undefined;
    // Same rule, for the other policy option. `supervise` is a declarative restart policy: it
    // is parsed here (a malformed or unknown-key record is refused before anything is submitted)
    // and travels on the spawn args so the manager can restart the seat in place. A host that
    // cannot restart in place refuses at accept rather than accepting a silent no-op.
    if (req.supervise !== undefined) readSupervise(req.supervise, req.persona);
    // A seat a migration kept for this persona (§11.2): the orphaned spawn's GOAL becomes this
    // step's own, bound with that spawn's floor and the step it came from. From here the two kinds
    // of spawn are one path — the terminal is read under the bound goal, the handle comes from it,
    // a resume re-reads it, and a discharge despawns by it — so the hand-over is spent exactly
    // once and this step never mints a second seat for a persona it was handed one for.
    const adoptions = ext === undefined ? this.adoptable.get(req.persona) : undefined;
    const adopted = adoptions?.[0];
    if (adopted !== undefined) {
      const handle = adopted.result as AgentHandleValue | undefined;
      const floor = adopted.external as Readonly<Record<string, unknown>> | undefined;
      if (typeof handle?.agent !== "string" || typeof adopted.requestId !== "string")
        throw new Error(`spawn(${req.persona}): the migrated seat's entry carries no readable handle or goal; a garbled hand-over is refused rather than minted over`);
      if (req.worktree !== undefined && handle.worktree !== req.worktree)
        throw new Error(`spawn(${req.persona}) asks for worktree "${req.worktree}" but the seat the migration hands it holds ${handle.worktree === undefined ? "none" : `"${handle.worktree}"`}; an adopted seat keeps its tree, so the edited program names that tree or none`);
      const adoptedInline = readInlineBinding(floor?.inline);
      if (adoptedInline?.digest !== inlineDigest)
        throw new Error(`spawn(${req.persona}) is ${inlineDigest === undefined ? "a catalog spawn" : `an inline definition with digest ${inlineDigest}`}, but the seat the migration hands it was spawned from ${adoptedInline === undefined ? "a catalog persona" : `an inline definition with digest ${adoptedInline.digest}`}; an adopted seat keeps its definition, so the edited program spawns that same definition, or the migration releases the seat`);
      inline = adoptedInline;
      checkRecordedPlacement(floor);
      // Refused validation leaves the hand-over queued; claim it before the first await.
      adoptions!.shift();
      ext = {
        goalId: adopted.requestId,
        ...(floor !== undefined ? pickAcceptanceFloor(floor) : {}),
        ...(inline !== undefined ? { inline } : {}),
        ...(typeof floor?.host === "string" ? { host: floor.host } : {}),
        ...(handle.worktree !== undefined ? { worktree: handle.worktree } : {}),
        ...(req.onFork !== undefined ? { onFork: req.onFork } : {}),
        ...(req.permits !== undefined ? { permits: req.permits } : {}),
        spawnedAt: typeof floor?.spawnedAt === "number" ? floor.spawnedAt : this.now(),
        adoptedFrom: journalEntryKeyString(adopted),
      };
      await ctx.bind(ext);
    }
    // The goal this step reads its terminal under: its own submission, or the adopted spawn's.
    const ref: GoalRef = { endpoint: this.binding.endpoint, caller: this.binding.caller, goalId: typeof ext?.goalId === "string" ? ext.goalId : goalId };
    if (ext === undefined && req.worktree !== undefined) await this.claimWorktree(req.worktree, req.persona, goalId);
    try {
      if (ext === undefined) {
        let reply: EpAttributedReply | undefined;
        // #1616 item 5 — PHASE A, then phase B. A previous attempt's journalled resolution is
        // reused rather than re-asked, so the path a resumed spawn launches in is the one the
        // resolve recorded and cannot drift under a re-resolve. A spawn naming no cwd has nothing
        // to resolve and skips both the invoke and the bind, so its behaviour is unchanged.
        let resolution = readCwdResolution(recorded?.resolution);
        // PERSIST BEFORE SUBMITTING, as the resolution below is: the definition a resume submits is
        // the one this bind recorded.
        if (inline !== undefined && recordedInline === undefined) await ctx.bind({ inline });
        try {
          const command = req.cwd !== undefined && resolution === undefined ? "resolve-cwd" : "spawn";
          const service = await this.manager(command, req.placement?.instanceId);
          if (req.cwd !== undefined && resolution === undefined) {
            // `req.placement` is guaranteed here: a cwd without one refused at the affinity gate above.
            resolution = await this.resolveCwd(req, service, req.cwd, req.placement?.instanceId ?? "");
            // PERSIST BEFORE SUBMITTING. The resolution is what phase B dispatches and what a
            // resume re-reads; binding it after the submission would leave a crash in between with
            // a launched seat whose directory no record names.
            await ctx.bind({ ...(inline !== undefined ? { inline } : {}), resolution });
          }
          const spawnService = service.commands.has("spawn") ? service : await this.manager("spawn", req.placement?.instanceId);
          reply = await this.invokeManager(spawnService, "spawn",
            // The run id lets a static manager that does not host this run, placed or reached through
            // the class queue, read the run's admission and bound the helper by it (SPEC 14.8).
            { ...spawnArgs({ ...req, ...(inline !== undefined ? { inline: inline.definition } : {}), ...(resolution !== undefined ? { cwd: resolution.cwd } : {}) }), runId: this.binding.runId }, {
              id: goalId,
              deadlineMs: SPAWN_ACCEPT_DEADLINE_MS,
            });
        } catch (err) {
          // A refusal this handler RAISED is never a lost reply: it was decided here, before
          // anything was submitted, so it is re-thrown rather than weighed against a goal record.
          if (err instanceof EffectError) throw err;
          // The invoke did not come back — which does not prove nothing happened: the request may
          // have been accepted while the reply was lost. The goal record is the arbiter: a durable
          // trace under this goalId means the submission landed, so proceed to its terminal; none
          // means it never did, and the raised error is the honest outcome.
          if ((await readGoalStatus(await this.actionCtx(), ref)) === undefined) throw err;
        }
        if (reply !== undefined && reply.reply.ok === false) {
          // Refused AT ACCEPT: the manager bound no goal and provisioned nothing, so this is the
          // effect's own failure, catchable as such — and never L4002, because no agent existed to
          // be down. A seat budget the endpoint will not extend is a permit the run does not hold
          // (L4001); every other refusal (persona unknown, name taken) is the host declining the
          // request (L4000), the manager's own code carried in the detail.
          const err = reply.reply.error;
          throw new EffectError(err.code === "resource-exhausted" ? "L4001" : "L4000", "spawn",
            `spawn(${req.persona}) was refused by the ${this.binding.endpoint} endpoint: ${err.message}`,
            { code: err.code });
        }
        const floor = reply === undefined ? undefined : (reply.reply.data as Record<string, unknown> | undefined);
        if (floor !== undefined && floor.goalId !== goalId)
          throw new Error(`the spawn acceptance names goal "${String(floor.goalId)}" but this submission pinned "${goalId}"; a mismatched acceptance never authorizes (SPEC 13.6)`);
        // BIND BEFORE AWAITING: the goalId is re-derivable, but the bind is what tells a resume the
        // submission LANDED — and the identity floor beside it is what a discharge despawns by when
        // the terminal alone carries none (an `uncertain` verdict). The worktree rides along so an
        // adoption re-takes this spawn's reservation; `onFork` so a fork can read the policy.
        ext = {
          goalId,
          ...(floor !== undefined ? pickAcceptanceFloor(floor) : {}),
          // `bind` REPLACES the external record, so the phase-A resolution is re-stated here or the
          // acceptance bind would erase it and a resume would re-resolve against a moved target.
          ...(resolution !== undefined ? { resolution } : {}),
          ...(inline !== undefined ? { inline } : {}),
          ...(req.worktree !== undefined ? { worktree: req.worktree } : {}),
          ...(req.onFork !== undefined ? { onFork: req.onFork } : {}),
          ...(req.permits !== undefined ? { permits: req.permits } : {}),
          // The placed instance hosts the seat, and only its resolver maps it: an adopted run
          // re-addresses this seat's turns there from the journal alone.
          ...(req.placement !== undefined ? { host: req.placement.instanceId } : {}),
          spawnedAt: this.now(),
        };
        await ctx.bind(ext);
      }

      const fact = await this.goalTerminal(ref, ctx.signal);
      const handle = spawnHandleOf(req, ext, fact, this.binding.endpoint);
      // Register the run-roster entry `turn` addresses and a handoff resolves to, by the same
      // identity the discharge despawns (see spawnDespawnTarget).
      const address = spawnDespawnTarget(ext, fact);
      this.roster.set(parseAgentHandle(handle.agent).name, {
        handle,
        uid: parseAgentHandle(handle.agent).uid,
        goalId: ref.goalId,
        ...(address !== undefined ? { owner: address.owner, actor: address.actor } : {}),
        ...(permits !== undefined ? { permits } : {}),
        ...(typeof ext.spawnedAt === "number" ? { spawnedAt: ext.spawnedAt } : {}),
        ...(typeof ext.host === "string" ? { host: ext.host } : {}),
      });
      if (typeof handle.worktree === "string")
        this.worktreeHolders.set(handle.worktree, { name: parseAgentHandle(handle.agent).name, uid: parseAgentHandle(handle.agent).uid });
      return handle;
    } catch (e) {
      const tree = typeof ext?.worktree === "string" ? ext.worktree : req.worktree;
      if (tree !== undefined) this.releaseWorktree(tree, ref.goalId, ext, e instanceof Cancelled);
      throw e;
    }
  }

  /**
   * A spawn that ends without a handle gives its tree back. The one exception is a cancellation
   * while parked on an ACCEPTED submission: the seat may well be up in the tree until its
   * discharge lands, so the reservation becomes a hold by the accepted identity, which presence
   * liveness then releases the way it releases any holder.
   */
  private releaseWorktree(worktree: string, goalId: string, ext: Readonly<Record<string, unknown>> | undefined, parked: boolean): void {
    const holder = this.worktreeHolders.get(worktree);
    if (holder === undefined || !("pending" in holder) || holder.pending !== goalId) return;
    if (parked && typeof ext?.name === "string" && typeof ext.uid === "string") {
      this.worktreeHolders.set(worktree, { name: ext.name, uid: ext.uid });
      return;
    }
    this.worktreeHolders.delete(worktree);
  }

  /** Poll the goal's durable terminal fact, observing cancellation on the poll cadence — the same
   *  discipline as `wait`: a race decided against this branch stops parking within one poll, and
   *  the seat its acceptance may have produced is the DISCHARGE's to release, not this branch's. */
  private async goalTerminal(ref: GoalRef, signal: CancelSignal): Promise<GoalResultFact> {
    const actx = await this.actionCtx();
    for (;;) {
      if (signal.cancelled) throw new Cancelled(signal.reason ?? "cancelled");
      const fact = await readGoalResult(actx, ref);
      if (fact !== undefined) return fact;
      await delay(GOAL_POLL_MS);
    }
  }}
