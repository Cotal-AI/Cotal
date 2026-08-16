/**
 * `epname` — the durable name claim (SPEC §13.4; the closed machine).
 *
 * A name is an identity that outlives the process holding it. The row answers three questions that
 * a live process cannot answer about itself: who holds this name, which lifecycle it names, and
 * WHICH INCARNATION owns the handle table for it. The third is the one that keeps being got wrong,
 * because it is the only one whose answer is invisible from the row's own subject.
 *
 * TWO RULES THAT COST MORE THAN THEY LOOK.
 *
 * `runtimeOwner` IS MOVED, NOT DERIVED. It is written at `launching → live` from the executor that
 * made the spawn call — recorded at the moment it becomes true rather than reconstructed later —
 * and every subsequent edge CARRIES it. It is deliberately never re-derived from a slot row,
 * because user mode has no slot row at all, so a derivation is unevaluable on a supported path,
 * and an unevaluable predicate is one that either refuses forever or falls back to absence.
 * `instanceId` alone will not do: an identity is not an incarnation, and a restarted process with
 * the same id has an empty handle table, which is the absence of knowledge rather than knowledge
 * of absence.
 *
 * `draining` HAS EXACTLY ONE EXIT, AND IT IS THE OPERATOR. The ordinary edge required its actor to
 * be the row's `runtimeOwner` attesting that the runtime is gone. That actor cannot exist: an owner
 * still alive has no queryable per-attempt handle to attest about, and a restarted one is a
 * different incarnation. The edge was satisfiable only by the party least entitled to satisfy it,
 * so it is removed rather than weakened — and `draining` is a state an operator clears by hand
 * until a durable runtime-attempt token exists. That cost is real and is recorded rather than
 * hidden inside a predicate that reads as satisfiable.
 */
import { EpEnvelopeError } from "./endpoint-error.js";

export type EpNameState =
  | "claimed" | "launching" | "live" | "preserved" | "relaunching" | "draining" | "released";

export interface EpNameIncarnation { instanceId: string; processEpoch: number }

export type EpNameClaimant =
  | { kind: "action"; goalId: string; gen: number }
  | { kind: "direct"; instanceId: string; processEpoch: number; opId: string }
  | { kind: "incumbent"; backfillId: string };

export interface EpNameRow {
  v: 1;
  ts: number;
  state: EpNameState;
  claimant: EpNameClaimant | null;
  lifecycleUid?: string;
  launchAttemptId?: string;
  executor?: EpNameIncarnation;
  runtimeOwner?: EpNameIncarnation;
  enteredAt?: number;
}

/** Who is taking the edge. The actor is NOT inferable from the row — that is the whole reason it is
 *  an argument: a sweeper and a claimant produce byte-identical writes, and the difference between
 *  a legitimate retirement and a split-brain is which of them was entitled to make it. */
export type EpNameActor =
  | { role: "claimant" }
  | { role: "holder"; lifecycleUid: string }
  | { role: "sweeper" }
  | { role: "operator" }
  | { role: "allocator" }
  | { role: "cutover" };

function fail(message: string): never {
  throw new EpEnvelopeError("bad-request", `epname: ${message}`);
}

const BASE = ["v", "ts", "state", "claimant"] as const;
/** The COMPLETE legal field set per state. § S2's variants are per-state for the reason § S1's are:
 *  a single broad object with everything optional cannot say that `executor` is present IFF a launch
 *  is in flight, and "present iff" is the only form in which that field is useful. */
const STATE_FIELDS: Record<EpNameState, readonly string[]> = {
  claimed: BASE,
  launching: [...BASE, "lifecycleUid", "launchAttemptId", "executor"],
  live: [...BASE, "lifecycleUid", "runtimeOwner"],
  preserved: [...BASE, "lifecycleUid", "runtimeOwner"],
  relaunching: [...BASE, "lifecycleUid", "launchAttemptId", "executor"],
  draining: [...BASE, "lifecycleUid", "runtimeOwner", "enteredAt"],
  released: BASE,
};

function parseIncarnation(v: unknown, what: string): EpNameIncarnation {
  if (typeof v !== "object" || v === null || Array.isArray(v)) fail(`\`${what}\` must be an object`);
  const o = v as Record<string, unknown>;
  const extra = Object.keys(o).filter((k) => k !== "instanceId" && k !== "processEpoch");
  if (extra.length > 0) fail(`unknown field(s) on \`${what}\`: ${extra.join(", ")}`);
  if (typeof o.instanceId !== "string" || o.instanceId.length === 0)
    fail(`\`${what}.instanceId\` must be a non-empty string`);
  if (typeof o.processEpoch !== "number" || !Number.isSafeInteger(o.processEpoch) || o.processEpoch < 0)
    fail(`\`${what}.processEpoch\` must be a non-negative safe integer — an incarnation, not an identity`);
  return { instanceId: o.instanceId, processEpoch: o.processEpoch };
}

function parseClaimant(v: unknown): EpNameClaimant {
  if (typeof v !== "object" || v === null || Array.isArray(v)) fail("`claimant` must be an object");
  const o = v as Record<string, unknown>;
  const legal: Record<string, readonly string[]> = {
    action: ["kind", "goalId", "gen"],
    direct: ["kind", "instanceId", "processEpoch", "opId"],
    incumbent: ["kind", "backfillId"],
  };
  const kind = o.kind;
  if (typeof kind !== "string" || !(kind in legal))
    fail(`unknown claimant kind ${JSON.stringify(kind)} — the legal set is action|direct|incumbent`);
  const extra = Object.keys(o).filter((k) => !legal[kind].includes(k));
  if (extra.length > 0) fail(`unknown field(s) on a ${kind} claimant: ${extra.join(", ")}`);
  const missing = legal[kind].filter((k) => !(k in o));
  if (missing.length > 0) fail(`a ${kind} claimant is missing: ${missing.join(", ")}`);
  if (kind === "action") {
    if (typeof o.goalId !== "string" || o.goalId.length === 0) fail("`claimant.goalId` must be a non-empty string");
    if (typeof o.gen !== "number" || !Number.isSafeInteger(o.gen)) fail("`claimant.gen` must be a safe integer");
    return { kind: "action", goalId: o.goalId, gen: o.gen };
  }
  if (kind === "direct") {
    if (typeof o.opId !== "string" || o.opId.length === 0) fail("`claimant.opId` must be a non-empty string");
    const inc = parseIncarnation({ instanceId: o.instanceId, processEpoch: o.processEpoch }, "claimant");
    return { kind: "direct", instanceId: inc.instanceId, processEpoch: inc.processEpoch, opId: o.opId };
  }
  if (typeof o.backfillId !== "string" || o.backfillId.length === 0)
    fail("`claimant.backfillId` must be a non-empty string");
  return { kind: "incumbent", backfillId: o.backfillId };
}

/** Parse a row from CURRENT BYTES with no knowledge of history — which is the property that makes a
 *  sweeper able to act on a row it did not write. */
export function parseEpName(value: unknown): EpNameRow {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    fail("row must be a JSON object");
  const o = value as Record<string, unknown>;

  const state = o.state;
  if (typeof state !== "string" || !(state in STATE_FIELDS))
    fail(`unknown state ${JSON.stringify(state)} — the legal set is ${Object.keys(STATE_FIELDS).join("|")}`);
  const s = state as EpNameState;

  const legal = STATE_FIELDS[s];
  const unknown = Object.keys(o).filter((k) => !legal.includes(k));
  if (unknown.length > 0)
    fail(`unknown field(s) for state ${s}: ${unknown.join(", ")} — each state names the COMPLETE legal set`);
  const missing = legal.filter((k) => !(k in o));
  if (missing.length > 0)
    fail(`state ${s} is missing required field(s): ${missing.join(", ")}`);

  if (o.v !== 1) fail("`v` must be exactly 1");
  if (typeof o.ts !== "number" || !Number.isSafeInteger(o.ts)) fail("`ts` must be a safe integer");

  // `claimant` is NON-NULL in every state but `released`. A `live` row with a null claimant cannot
  // support the identity checks every release depends on, so admitting one moves the failure to
  // whichever release reads it next — far from the write that caused it.
  const row: EpNameRow = { v: 1, ts: o.ts, state: s, claimant: null };
  if (s === "released") {
    if (o.claimant !== null) fail("`released` REQUIRES a null `claimant` — the name is unheld");
  } else {
    if (o.claimant === null)
      fail(`state ${s} REQUIRES a non-null \`claimant\`: a held name with no holder cannot answer the identity check every release makes`);
    row.claimant = parseClaimant(o.claimant);
  }

  if (legal.includes("lifecycleUid")) {
    if (typeof o.lifecycleUid !== "string" || o.lifecycleUid.length === 0)
      fail("`lifecycleUid` must be a non-empty string");
    row.lifecycleUid = o.lifecycleUid;
  }
  if (legal.includes("launchAttemptId")) {
    if (typeof o.launchAttemptId !== "string" || o.launchAttemptId.length === 0)
      fail("`launchAttemptId` must be a non-empty string");
    row.launchAttemptId = o.launchAttemptId;
  }
  if (legal.includes("executor")) row.executor = parseIncarnation(o.executor, "executor");
  if (legal.includes("runtimeOwner")) row.runtimeOwner = parseIncarnation(o.runtimeOwner, "runtimeOwner");
  if (legal.includes("enteredAt")) {
    if (typeof o.enteredAt !== "number" || !Number.isSafeInteger(o.enteredAt))
      fail("`enteredAt` must be a safe integer");
    row.enteredAt = o.enteredAt;
  }
  return row;
}

type Role = EpNameActor["role"];
interface Edge { from: EpNameState | "—"; to: EpNameState; actors: readonly Role[] }

/** The § S2 edge table. Every legal transition, and nothing else.
 *
 *  `live → relaunching` IS ABSENT ON PURPOSE. Round 11 had it, and it reused ONE state for both a
 *  running agent and a stopped one: the holder could rotate the nonce and spawn a second process,
 *  and a crash after the spawn call was byte-identical to the state before it. Both are exactly
 *  what `launching` exists to prevent, reintroduced one level down. Ordinary `live` authorizes NO
 *  relaunch; only `preserved` does.
 *
 *  `draining → released` carries EXACTLY ONE actor, the operator. See the module header. */
const EDGES: readonly Edge[] = [
  { from: "—", to: "claimed", actors: ["allocator"] },
  { from: "released", to: "claimed", actors: ["allocator"] },
  { from: "claimed", to: "launching", actors: ["claimant"] },
  { from: "launching", to: "live", actors: ["claimant"] },
  { from: "live", to: "preserved", actors: ["holder"] },
  { from: "preserved", to: "relaunching", actors: ["holder"] },
  { from: "relaunching", to: "live", actors: ["holder"] },
  { from: "claimed", to: "released", actors: ["claimant", "sweeper"] },
  { from: "launching", to: "draining", actors: ["sweeper"] },
  { from: "live", to: "draining", actors: ["sweeper"] },
  { from: "preserved", to: "draining", actors: ["sweeper"] },
  { from: "relaunching", to: "draining", actors: ["sweeper"] },
  { from: "draining", to: "released", actors: ["operator"] },
  { from: "—", to: "live", actors: ["cutover"] },
];

function sameInc(a: EpNameIncarnation | undefined, b: EpNameIncarnation | undefined): boolean {
  if (a === undefined && b === undefined) return true;
  if (a === undefined || b === undefined) return false;
  return a.instanceId === b.instanceId && a.processEpoch === b.processEpoch;
}
function sameClaimant(a: EpNameClaimant | null, b: EpNameClaimant | null): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Validate a transition against § S2. `prev` is `null` for the two creation edges.
 *
 * `gateSatisfied` is the caller's attestation that the edge's external precondition holds — the
 * `goaleff` election won, the process authoritatively quiesced, the executor dead by the gate
 * predicate, the operator's host-level attestation. It is a REQUIRED argument for the same reason
 * `terminalExists` is in § S1: a precondition the caller can satisfy by not mentioning it is not a
 * precondition.
 */
export function assertEpNameEdge(
  prev: EpNameRow | null,
  next: EpNameRow,
  actor: EpNameActor,
  opts: { gateSatisfied: boolean },
): void {
  const from: EpNameState | "—" = prev === null ? "—" : prev.state;
  const to = next.state;

  const edge = EDGES.find((e) => e.from === from && e.to === to);
  if (edge === undefined) {
    const legal = EDGES.filter((e) => e.from === from).map((e) => e.to);
    fail(legal.length === 0
      ? `\`${from}\` has no outgoing edge at all (attempted ${from} → ${to})`
      : `${from} → ${to} is not a legal edge; from \`${from}\` the legal set is ${legal.join(", ")}`);
  }
  if (!edge.actors.includes(actor.role))
    fail(`a ${actor.role} may not take ${from} → ${to}; that edge belongs to: ${edge.actors.join(", ")}`);
  if (!opts.gateSatisfied)
    fail(`${from} → ${to} requires its gate to hold FIRST, and the caller did not attest it`);

  if (actor.role === "holder" && prev !== null && actor.lifecycleUid !== prev.lifecycleUid)
    fail(`this edge is for the EXACT \`lifecycleUid\` holder only: row ${JSON.stringify(prev.lifecycleUid)}, `
       + `actor ${JSON.stringify(actor.lifecycleUid)}`);

  // ---- creation edges ------------------------------------------------------------------------
  if (prev === null) {
    if (to === "live") {
      // The A6 cutover backfill. `runtimeOwner` comes from the incumbent's LIVE gate row, and if no
      // such row names an incarnation the key is NOT backfilled — it is recorded as a casualty. A
      // `live` row whose owner is unknown is the row § R15-A exists to forbid, and inventing one
      // here puts the unevaluable value in the durable record where every later release reads it.
      if (next.runtimeOwner === undefined)
        fail("the cutover may not backfill a `live` row without a `runtimeOwner` read from the incumbent's "
           + "live gate row — record a cutover CASUALTY instead of inventing an owner");
      if (next.claimant?.kind !== "incumbent")
        fail("a cutover backfill claims as `incumbent`; any other claimant kind is a different edge");
    }
    return;
  }

  // ---- claimant / lifecycle immutability -----------------------------------------------------
  const reclaim = from === "released" && to === "claimed";
  const releasing = to === "released";
  if (!reclaim && !releasing && !sameClaimant(prev.claimant, next.claimant))
    fail(`\`claimant\` is immutable while a claim is held: ${JSON.stringify(prev.claimant)} → ${JSON.stringify(next.claimant)}`);
  if (releasing && next.claimant !== null) fail("a release CLEARS `claimant`");
  if (prev.lifecycleUid !== undefined && next.lifecycleUid !== undefined
      && prev.lifecycleUid !== next.lifecycleUid)
    fail(`\`lifecycleUid\` is immutable while a claim is held: ${prev.lifecycleUid} → ${next.lifecycleUid}`);

  // ---- runtimeOwner: MOVED on the launch-completing edges, CARRIED everywhere else ------------
  const completesLaunch = (from === "launching" || from === "relaunching") && to === "live";
  const drainsFromLaunch = (from === "launching" || from === "relaunching") && to === "draining";
  if (completesLaunch || drainsFromLaunch) {
    // The FULL incarnation moves, both fields. `instanceId` alone is an identity, and the row would
    // then name a process rather than the run of it that holds the handle table.
    if (!sameInc(next.runtimeOwner, prev.executor))
      fail(`${from} → ${to} MOVES the full \`executor\` into \`runtimeOwner\`: expected `
         + `${JSON.stringify(prev.executor)}, got ${JSON.stringify(next.runtimeOwner)} — `
         + `an \`instanceId\` without its \`processEpoch\` is an identity, not the incarnation that holds the handle`);
    if (next.launchAttemptId !== undefined)
      fail(`${from} → ${to} CLEARS \`launchAttemptId\``);
  } else if (to === "draining" || to === "preserved" || to === "live") {
    // CARRIED, never re-derived. The derivation a reader reaches for is the slot row's
    // ownerInstanceId, and user mode has no slot row at all — so it is unevaluable on a supported
    // path, which is the same failure as a predicate whose actor cannot exist.
    if (!sameInc(prev.runtimeOwner, next.runtimeOwner))
      fail(`${from} → ${to} CARRIES \`runtimeOwner\` unchanged (${JSON.stringify(prev.runtimeOwner)} → `
         + `${JSON.stringify(next.runtimeOwner)}) — it is installed once, when the spawn call returns, and never re-derived`);
  }
  if (to === "draining" && next.enteredAt === undefined) fail("`draining` SETS `enteredAt`");
  if (from === "draining" && to === "released") {
    if (next.lifecycleUid !== undefined || next.runtimeOwner !== undefined || next.enteredAt !== undefined)
      fail("the operator edge CLEARS `lifecycleUid`, `runtimeOwner` and `enteredAt`");
  }
}
