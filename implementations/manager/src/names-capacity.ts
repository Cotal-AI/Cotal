import { rmSync } from "node:fs";
import { DEV_OWNER, firstFreeName, managedRetirementOpId, parsePrincipalKey, spawnNameError, type Presence } from "@cotal-ai/core";
import { MAX_AGENTS } from "./resume.js";
import type { ManagedAgent, FreeSlotCause } from "./manager.js";
import type { RetirementHold, TeardownTarget } from "./retirement.js";
import type { AttachEndReason } from "./session/index.js";

type FreeSlotStopCause = Extract<FreeSlotCause, { kind: string }>;
/** Minimum slot lifetime for rate-flooring (P4c). A slot freed (by despawn OR natural exit/reap)
 *  before living this long leaves a cooling stamp that still counts toward the ceiling until it
 *  expires - so churn (spawn↔despawn or spawn↔fast-exit) can't outrun the concurrency bound. */
const MIN_LIFETIME = 10_000;

/** What holds the spawn ceiling's slots, as {@link Manager.occupancy} counts it (#906). */
export type Occupancy = { managed: number; reserved: number; cooling: number; launching: number; used: number; nextCoolingMs?: number };

/** The SPEC 13.6 end reason a live attach session gets when this cause frees its seat. The causes
 *  that free the slot in the same step that saw the seat's own process exit report `process-exit`.
 *  A failed recovery frees it later, after its own stop, so it reports `target-despawn` with every
 *  manager stop. */
const FREE_SLOT_ATTACH_END: Record<Exclude<FreeSlotCause, FreeSlotStopCause>, AttachEndReason> = {
  "process-exit": "process-exit",
  "pi-crash-loop": "process-exit",
  "supervise-crash-loop": "process-exit",
  "inline-snapshot-changed": "process-exit",
  "pi-recovery-failed": "target-despawn",
  "supervise-recovery-failed": "target-despawn",
  "session-bind-failed": "target-despawn",
  "resume-session-rebind-failed": "target-despawn",
  "carried-fork-refused": "target-despawn",
  "resume-custody-unrecorded": "target-despawn",
  "supervise-record-failed": "target-despawn",
};

/** Current manager-owned lifecycle operations used while allocating and releasing names. */
export interface NamesCapacityDeps {
  userMode(): boolean;
  authEnabled(): boolean;
  maintenanceActive(): boolean;
  roster(): readonly Presence[];
  agentFor(name: string): ManagedAgent | undefined;
  hasAgent(name: string): boolean;
  removeAgent(name: string): void;
  managedCount(): number;
  predecessor(name: string): { principal: string; lifecycleUid: string } | undefined;
  hasRetirementHold(name: string): boolean;
  holdRetirement(name: string, hold: RetirementHold): void;
  endSessionsForTarget(name: string, lifecycleUid: string, reason: AttachEndReason): void;
  logSeatReaped: (agent: ManagedAgent, cause: FreeSlotCause) => void;
  recordContinuityAtStop: (agent: ManagedAgent, boundary: string) => void;
  releasedSeatPending: (agent: ManagedAgent) => boolean;
  dropSeatRecord: (agent: ManagedAgent) => void;
  failSeatTurns: (name: string, lifecycleUid: string) => void;
  teardownTarget: (agent: ManagedAgent) => TeardownTarget;
  dropInlineSnapshot: (name: string, lifecycleUid: string) => boolean;
  trackDeprovision: (target: TeardownTarget) => void;
}

/** Allocation reservations, numbered-name history and cooling occupancy for one manager. */
export class NamesCapacity {
  /** Names whose spawn is in flight (reserved synchronously before the provision await) - counted
   *  toward the ceiling (once per name, see {@link Manager.occupancy}) so two concurrent same-name
   *  spawns can't both pass the gate (P4a). Each name carries the OWNER its launch was admitted
   *  for, so the per-owner ceiling ({@link Manager.ownerSeats}) counts a launch from the moment it
   *  is reserved; a cap read only off `agents` would let a burst of concurrent spawns overshoot it,
   *  because none of them has a seat yet when the next one checks. */
  private readonly reserved = new Map<string, string>();
  /** Reserved names whose launch already put its seat in `agents`. The name stays reserved until
   *  the launch settles, so no other spawn can take it, but the ceiling counts that seat through
   *  `agents` and, if it frees young, its cooling stamp, never through the reservation (#906). */
  private readonly reservedLive = new Set<string>();
  /** Every numbered name {@link uniqueName} has issued. A suffix carries nothing but arrival order,
   *  so reissuing a freed one would give a later principal the name an earlier one posted under, and
   *  a reader of that name could not tell the two apart (#382). Never pruned in-process: one string
   *  per numbered spawn. */
  private readonly issuedNumberedNames = new Set<string>();
  /** Expiry stamps (`startedAt + MIN_LIFETIME`) for slots that freed while still young - a
   *  count-only, lazily-pruned recycle floor (P4c). Pruned + summed into the ceiling gate. */
  private cooling: number[] = [];

  constructor(private readonly deps: NamesCapacityDeps) {}

  reserve(name: string, owner: string): void { this.reserved.set(name, owner); }
  placed(name: string): void { this.reservedLive.add(name); }
  release(name: string): void { this.reserved.delete(name); this.reservedLive.delete(name); }
  isReserved(name: string): boolean { return this.reserved.has(name); }
  get reservedCount(): number { return this.reserved.size; }
  numberedIssued(name: string): boolean { return this.issuedNumberedNames.has(name); }
  rememberNumbered(name: string): void { this.issuedNumberedNames.add(name); }
  ownerReservations(owner: string): number {
    let count = 0;
    for (const [name, reservedFor] of this.reserved)
      if (reservedFor === owner && !this.reservedLive.has(name)) count++;
    return count;
  }

  /** Agent names become `.cotal/agents/<name>.md` paths and mesh identities, so they must be bare
   *  tokens, never a path - blocks traversal / arbitrary writes from a model-supplied name. In user
   *  mode the name is ALSO the actor, which is a narrower alphabet still; {@link spawnNameError}
   *  holds both halves so this door and the auto-numbering that feeds it cannot disagree. */
  nameError(name: string): string | undefined {
    return spawnNameError(name, { userMode: this.deps.userMode() });
  }

  /** The roster's LIVE occupant names (status !== offline) - occupants this manager may NOT manage
   *  (a foreground `cotal spawn`, a connector session, ANOTHER manager's agent). Allocating over any
   *  of them mints a sibling the broker/auth then refuses to admit, surfacing as the 30s launch-
   *  uncertain black hole. */
  liveRosterNames(): Set<string> {
    const live = new Set<string>();
    for (const p of this.deps.roster()) {
      if (p.status === "offline") continue;
      const predecessor = this.deps.predecessor(p.card.name);
      if (predecessor !== undefined && predecessor.principal === p.card.id && predecessor.lifecycleUid === p.lifecycleUid) continue;
      live.add(p.card.name);
    }
    return live;
  }

  /** THE single name-liveness predicate both the hard-pinned collision refuse and
   *  uniqueName's numbering consult, so they can never drift: a name is taken if this manager
   *  reserves/manages/retires it OR a roster-live occupant already holds it. Pass a pre-built
   *  {@link liveRosterNames} set when checking many names in one allocation. */
  nameInUse(name: string, live: Set<string> = this.liveRosterNames()): boolean {
    return this.deps.hasAgent(name) || this.reserved.has(name) || this.deps.hasRetirementHold(name) || live.has(name);
  }

  /** First free name in the series `base`, `base_2`, `base_3`, … - checked against live slots,
   *  in-flight (reserved) slots, names held pending retirement, AND the live mesh roster. The
   *  roster check covers occupants this manager does not manage (a foreground `cotal spawn`, a
   *  connector session, another manager's agent): allocating their name would mint a sibling the
   *  broker/auth then refuses to admit, surfacing as a 30s launch-uncertain black hole instead of
   *  the auto-number the join path gives. Presence is ADVISORY (SPEC §6) - this is an availability
   *  choice at allocation, never an authority check (the broker still enforces): a stale
   *  still-live-looking row only costs a numbered suffix, and a missed freshly-joined occupant is
   *  still refused downstream exactly as before. Offline rows do NOT occupy - a properly retired
   *  name stays reusable. A row this manager itself confirmed retired (its alias, principal, and
   *  lifecycleUid all matching a {@link confirmedRetiredPredecessors} entry) does not occupy
   *  either, even while its advisory presence record ages out. A numbered name is never reissued
   *  ({@link issuedNumberedNames}), even after its holder retired. The requested base is exempt
   *  from that history: it is the persona's own name, which stays reusable even when it once came
   *  out of another persona's numbering. */
  uniqueName(base: string, unavailable: ReadonlySet<string> = new Set()): string {
    const live = this.liveRosterNames();
    // The cap belongs to user mode alone: only there is the numbered name the actor. Static and open
    // mode key the actor on the minted nkey, so a numbered name there has no length to fit.
    const name = firstFreeName(base, (n) => unavailable.has(n) || this.nameInUse(n, live) || (n !== base && this.issuedNumberedNames.has(n)),
      this.deps.userMode() ? { actorBound: true } : undefined);
    return name;
  }

  /** Drop a live agent's slot. When `floor` is set and the agent died young (lived less than
   *  MIN_LIFETIME), push a cooling stamp so the freed slot still counts toward the ceiling until it
   *  expires - flooring the RECYCLE, not the call, so both free paths (despawn + exit/reap) are
   *  covered (P4c). Floor self + own-child despawn and natural exit; NEVER admin despawn (operator
   *  emergency-kill stays unthrottled) and NEVER the reserved-rollback path (no cold-start paid). */
  freeSlot(a: ManagedAgent, floor: boolean, cause: FreeSlotCause, acceptedBeforeFence = false): void {
    if (this.deps.agentFor(a.name) !== a) return; // already freed (exit raced despawn, etc.)
    // The terminalizing latch also covers exit/reap paths that never rode stopHandle.
    this.deps.logSeatReaped(a, cause);
    a.terminalizing = true;
    this.deps.removeAgent(a.name);
    this.deps.recordContinuityAtStop(a, "stop");
    if (a.restart?.sessionStatePath) rmSync(a.restart.sessionStatePath, { force: true });
    // A released seat's record is the next manager's only pointer to it. It stays until the
    // retirement is confirmed. Dropping it here let a refused retirement leave the lifecycle active
    // with nothing left for that manager to adopt.
    if (!this.deps.releasedSeatPending(a)) this.deps.dropSeatRecord(a);
    if (a.seatHome) rmSync(a.seatHome, { recursive: true, force: true });
    // End any live §13.6 attach session bound to THIS incarnation with the reason its cause names.
    // Fires once per agent on every free path (despawn / self-stop / reap / exit) via the `agents`
    // guard above; a no-op when no plane or no live session for the target.
    this.deps.endSessionsForTarget(a.name, a.lifecycleUid, typeof cause === "string" ? FREE_SLOT_ATTACH_END[cause] : "target-despawn");
    // The turn relay's reap hook: every pending turn addressed to THIS incarnation is stamped
    // with the death, and its deadline terminal carries it as `agentDownAt`. The addressee is gone
    // and no successor may answer for it; the terminal is still the deadline's, not a new reason.
    this.deps.failSeatTurns(a.name, a.lifecycleUid);
    if (floor && Date.now() - a.startedAt < MIN_LIFETIME) this.cooling.push(a.startedAt + MIN_LIFETIME);
    // The departed agent's own custody reference rides the teardown: the exit that freed this slot
    // is usually the seat ending, but a stop that could not prove the process gone leaves one the
    // terminal must still address before it frees the alias.
    const target = this.deps.teardownTarget(a);
    // On a USER mesh the name is RESERVED PENDING RETIREMENT - despawn started this
    // lifecycle's FULL teardown (footprint + standing-authority revoke + the auth-side retirement),
    // and the alias frees only when all of it completes (not the retirement alone). The detached
    // deprovision below drives it; a failed revoke or an unreachable rail keeps the name held,
    // re-driven by a retry. Gate on userMode BY
    // CONSTRUCTION (NEW-1): a static-auth mint has no user-mode lifecycle head to retire, so the
    // reservation + rail request simply don't apply there (the incidental nkey-parse used to mask
    // this, but the intent is "user mode only", not "any principal-shaped id").
    if (this.deps.userMode()) {
      const p = parsePrincipalKey(a.id);
      if (p) this.deps.holdRetirement(a.name, { opId: managedRetirementOpId(a.lifecycleUid), owner: p.owner, actor: p.actor, target, startedAt: Date.now() });
    } else if (this.deps.authEnabled()) {
      // A STATIC lifecycle now also holds its name pending its own terminal (the
      // static retirement the detached deprovision below drives) - the alias frees only when the
      // gate+head terminal completes, exactly the user-mode discipline. The wire principal is the
      // incarnation-unique nkey; owner is the dev owner.
      this.deps.holdRetirement(a.name, { opId: managedRetirementOpId(a.lifecycleUid), owner: DEV_OWNER, actor: a.id, target, startedAt: Date.now() });
    }
    // Auth mode: tear down the departed agent's minted broker footprint + creds file (#159 B2). The
    // process is already gone, so this must never block the slot free or throw into the caller - it runs
    // detached, and a failure is logged loudly (never swallowed), not retried. The `agents` guard above
    // makes this fire exactly once per agent across every free path (despawn / self-stop / reap / exit).
    if (!a.suppressCleanup && (this.deps.maintenanceActive() || acceptedBeforeFence)) {
      // An inline seat's snapshot goes with the seat on every mesh. An open mesh runs no teardown
      // below, and a preservation cut suppresses this, so a resumed seat still finds its snapshot.
      // Settled means the file is gone or the seat never had one. A removal that failed is left to
      // the teardown, which retries it and reports what it could not remove.
      if (a.launch.source.kind !== "inline" || this.deps.dropInlineSnapshot(a.name, a.lifecycleUid)) target.snapshotSettled = true;
      this.deps.trackDeprovision(target);
    }
  }

  /** Prune expired cooling stamps (drop those at/before now) and return the live count - the
   *  recycle floor's contribution to the ceiling (P4c). Lazy: pruned only when the gate consults it. */
  coolingCount(): number {
    const now = Date.now();
    this.cooling = this.cooling.filter((stamp) => stamp > now);
    return this.cooling.length;
  }

  /** What holds the ceiling's slots, one count per seat (#906). A launching seat sits in `reserved`
   *  from accept until its launch settles, in `agents` once its process exists, and in `cooling`
   *  if it then frees young, so a reservation stops counting once it reaches `agents`. `managed` is
   *  what this manager's `ps` lists, `reserved` is the accepted launches that have no process yet,
   *  and `launching` is every unsettled launch that still holds a slot through `reserved` or
   *  `agents`. A launch whose seat already freed holds no slot but its cooling stamp, so its
   *  failure can free nothing. */
  occupancy(): Occupancy {
    const cooling = this.coolingCount();
    let reserved = 0;
    let launching = 0;
    for (const name of this.reserved.keys()) {
      const placed = this.reservedLive.has(name);
      if (!placed) reserved++;
      if (!placed || this.deps.hasAgent(name)) launching++;
    }
    const managed = this.deps.managedCount();
    return {
      managed,
      reserved,
      cooling,
      launching,
      used: managed + reserved + cooling,
      nextCoolingMs: cooling ? Math.min(...this.cooling) - Date.now() : undefined,
    };
  }

  occupancyText(o: Occupancy): string {
    return `${o.used} of ${MAX_AGENTS} slots: ${o.managed} managed, ${o.reserved} reserved, ${o.cooling} cooling`;
  }

  /** The capacity refusal states the split it enforces and whether waiting can free a slot: a
   *  cooling slot frees at a known time, an unsettled launch frees one only if it fails, and a
   *  managed seat frees one only when it is stopped. */
  capacityRefusal(o: Occupancy): string {
    const remedy = o.nextCoolingMs !== undefined
      ? `waiting frees a cooling slot in ${Math.ceil(o.nextCoolingMs / 1000)}s, or despawn one`
      : o.launching
        ? `waiting frees a slot only if an unsettled launch fails (${o.launching} pending); otherwise despawn one`
        : "waiting frees no slot; despawn one";
    return `at capacity (${this.occupancyText(o)}); ${remedy}`;
  }
}
