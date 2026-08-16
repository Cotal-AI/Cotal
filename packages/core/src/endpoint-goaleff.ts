/**
 * `goaleff` — the at-most-one-launch election (SPEC §13.4 effects; the closed machine).
 *
 * The row is the durable answer to "has this accepted goal already been launched, and by whom",
 * and it is the ONLY thing standing between an at-least-once effects durable and two processes for
 * one acceptance. A shared durable redelivers; two handlers on the same executor can be live at
 * once; a winner's reply can be dropped and its re-read is byte-identical to what it would have
 * written. None of that is detectable from the payload — it is detectable only from this row.
 *
 * TWO PROPERTIES, AND THEY FAIL DIFFERENTLY.
 *
 *  1. The SHAPE is per-phase. Each phase names the complete set of fields legal in it; unknown and
 *     missing fields are both refused. A single broad object with `addr?` cannot express the rule,
 *     because `claimed → settled` is legal: require `addr` on `settled` and that edge becomes
 *     unrepresentable, allow it absent and "an address, once you have one, is carried forward"
 *     stops being checkable. `settled.addr` is therefore OPTIONAL BUT DETERMINED — present iff the
 *     row passed through `launching`.
 *
 *  2. The MOVEMENT is a table, and a revision-CAS does not enforce it. A CAS prevents two writers
 *     moving one row concurrently. It says nothing at all about WHAT the winner writes: the same
 *     CAS admits `launching → launched` with a different `executor`, a different `attemptId`, or a
 *     re-pointed `addr`. An "exhaustive" edge list is fully satisfied by a row that changed hands
 *     mid-flight. So `v`, `executor` and `attemptId` are immutable after creation on EVERY edge,
 *     `addr` is immutable once written, and these are byte comparisons against the pinned
 *     revision rather than advisory rules.
 */
import { EpEnvelopeError } from "./endpoint-error.js";

export type GoalEffPhase = "claimed" | "launching" | "launched" | "settled";

export interface GoalEffExecutor { instanceId: string; processEpoch: number }
export interface GoalEffAddr { nameToken: string; lifecycleUid: string }

interface GoalEffCommon {
  v: 1;
  executor: GoalEffExecutor;
  attemptId: string;
  ts: number;
}

export type GoalEffRow =
  | (GoalEffCommon & { phase: "claimed" })
  | (GoalEffCommon & { phase: "launching"; addr: GoalEffAddr })
  | (GoalEffCommon & { phase: "launched"; addr: GoalEffAddr })
  | (GoalEffCommon & { phase: "settled"; addr?: GoalEffAddr });

/** Who is taking the edge. A sweeper acts for an executor that is GONE — which is exactly why it
 *  may only settle: advancing a launch phase on a dead executor's behalf is the split-brain the
 *  election exists to prevent, and it is indistinguishable in the row from the executor doing it. */
export type GoalEffActor =
  | { role: "executor"; executor: GoalEffExecutor; attemptId: string }
  | { role: "sweeper" };

function fail(message: string): never {
  throw new EpEnvelopeError("bad-request", `goaleff: ${message}`);
}

const COMMON_FIELDS = ["v", "executor", "attemptId", "ts", "phase"] as const;
/** The COMPLETE legal field set per phase. Extra and missing are both refused, and the two are
 *  reported separately: an unknown field is a writer speaking a different dialect, a missing one
 *  is a writer speaking this one badly, and an operator who cannot tell them apart cannot tell a
 *  version skew from a bug. */
const PHASE_FIELDS: Record<GoalEffPhase, readonly string[]> = {
  claimed: COMMON_FIELDS,
  launching: [...COMMON_FIELDS, "addr"],
  launched: [...COMMON_FIELDS, "addr"],
  settled: [...COMMON_FIELDS, "addr"], // `addr` optional here, and ONLY here
};
const ADDR_REQUIRED: Record<GoalEffPhase, boolean> = {
  claimed: false, launching: true, launched: true, settled: false,
};
// There is no ADDR_FORBIDDEN table. `claimed` is the only phase that forbids `addr`, and it forbids
// it by not listing it in PHASE_FIELDS — so the unknown-field check above has already refused it,
// with a better message, before any such table could be consulted. A second check for the same case
// would never once execute.

function parseExecutor(v: unknown): GoalEffExecutor {
  if (typeof v !== "object" || v === null || Array.isArray(v)) fail("`executor` must be an object");
  const o = v as Record<string, unknown>;
  const extra = Object.keys(o).filter((k) => k !== "instanceId" && k !== "processEpoch");
  if (extra.length > 0) fail(`unknown field(s) on \`executor\`: ${extra.join(", ")}`);
  if (typeof o.instanceId !== "string" || o.instanceId.length === 0)
    fail("`executor.instanceId` must be a non-empty string");
  if (typeof o.processEpoch !== "number" || !Number.isSafeInteger(o.processEpoch) || o.processEpoch < 0)
    fail("`executor.processEpoch` must be a non-negative safe integer");
  return { instanceId: o.instanceId, processEpoch: o.processEpoch };
}

function parseAddr(v: unknown): GoalEffAddr {
  if (typeof v !== "object" || v === null || Array.isArray(v)) fail("`addr` must be an object");
  const o = v as Record<string, unknown>;
  const extra = Object.keys(o).filter((k) => k !== "nameToken" && k !== "lifecycleUid");
  if (extra.length > 0) fail(`unknown field(s) on \`addr\`: ${extra.join(", ")}`);
  if (typeof o.nameToken !== "string" || o.nameToken.length === 0)
    fail("`addr.nameToken` must be a non-empty string");
  if (typeof o.lifecycleUid !== "string" || o.lifecycleUid.length === 0)
    fail("`addr.lifecycleUid` must be a non-empty string");
  return { nameToken: o.nameToken, lifecycleUid: o.lifecycleUid };
}

/** Parse a row from CURRENT BYTES — never from a prior in-memory value. The `settled` variant is
 *  the one that cannot be validated any other way: both of its shapes are legal and nothing in the
 *  bytes distinguishes them, which is acceptable precisely because nothing downstream branches on
 *  it. The address is for repair, and a settled row needs no repair. */
export function parseGoalEff(value: unknown): GoalEffRow {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    fail("row must be a JSON object");
  const o = value as Record<string, unknown>;

  const phase = o.phase;
// `Object.hasOwn`, NOT `in`: the `in` operator walks the PROTOTYPE CHAIN, so a row whose
// discriminant is `toString`, `constructor` or `hasOwnProperty` passed this test and then
// crashed with an uncontrolled TypeError instead of the declared bad-request refusal. An
// attacker-supplied string reaching a plain-object lookup is exactly where that matters.
  if (typeof phase !== "string" || !Object.hasOwn(PHASE_FIELDS, phase))
    fail(`unknown phase ${JSON.stringify(phase)} — the legal set is claimed|launching|launched|settled`);
  const p = phase as GoalEffPhase;

  const legal = PHASE_FIELDS[p];
  const unknown = Object.keys(o).filter((k) => !legal.includes(k));
  if (unknown.length > 0)
    fail(`unknown field(s) for phase ${p}: ${unknown.join(", ")} — each phase names the COMPLETE legal set`);

  if (o.v !== 1) fail("`v` must be exactly 1");
  if (typeof o.attemptId !== "string" || o.attemptId.length === 0)
    fail("`attemptId` must be a non-empty string");
  if (typeof o.ts !== "number" || !Number.isSafeInteger(o.ts))
    fail("`ts` must be a safe integer");
  const executor = parseExecutor(o.executor);

  const hasAddr = "addr" in o && o.addr !== undefined;
  if (ADDR_REQUIRED[p] && !hasAddr) fail(`phase ${p} REQUIRES \`addr\``);

  const common = { v: 1 as const, executor, attemptId: o.attemptId, ts: o.ts };
  if (p === "claimed") return { ...common, phase: "claimed" };
  if (p === "launching") return { ...common, phase: "launching", addr: parseAddr(o.addr) };
  if (p === "launched") return { ...common, phase: "launched", addr: parseAddr(o.addr) };
  return hasAddr
    ? { ...common, phase: "settled", addr: parseAddr(o.addr) }
    : { ...common, phase: "settled" };
}

/** The § S1 edge table. `settled` is absent as a source: it is terminal, and its absence here IS
 *  the terminality rule rather than a separate check that could disagree with it. */
const EDGES: Record<string, { to: GoalEffPhase; sweeperMay: boolean }[]> = {
  claimed: [
    { to: "launching", sweeperMay: false },
    { to: "settled", sweeperMay: true },
  ],
  launching: [
    { to: "launched", sweeperMay: false },
    { to: "settled", sweeperMay: true },
  ],
  launched: [
    { to: "settled", sweeperMay: true },
  ],
};

function sameExecutor(a: GoalEffExecutor, b: GoalEffExecutor): boolean {
  return a.instanceId === b.instanceId && a.processEpoch === b.processEpoch;
}
/** The first argument is REQUIRED, and that is not a style choice: the only call site is inside the
 *  branch where `prevAddr === undefined` is already false, so the both-undefined and first-undefined
 *  cases were unreachable. They read as protection and covered nothing — the fourth such guard found
 *  in this file, and the first found by someone other than its author. */
function sameAddr(a: GoalEffAddr, b: GoalEffAddr | undefined): boolean {
  if (b === undefined) return false;
  return a.nameToken === b.nameToken && a.lifecycleUid === b.lifecycleUid;
}
function addrOf(r: GoalEffRow): GoalEffAddr | undefined {
  return r.phase === "claimed" ? undefined : r.addr;
}

/**
 * Validate a transition against § S1: the edge exists, the actor is entitled to take it, and the
 * immutable fields did not move. Throws on any violation; returns nothing on success.
 *
 * `terminalExists` gates every settle. It is a REQUIRED argument rather than an assumed
 * precondition because a settle whose terminal has not been written is precisely the goal that
 * looks finished and is not — and a gate the caller can satisfy by forgetting to mention it is not
 * a gate.
 */
export function assertGoalEffEdge(
  prev: GoalEffRow,
  next: GoalEffRow,
  actor: GoalEffActor,
  opts: { terminalExists: boolean },
): void {
  const from = prev.phase, to = next.phase;

  const legal = EDGES[from];
  if (legal === undefined)
    fail(`\`${from}\` is TERMINAL — no edge leaves it (attempted ${from} → ${to})`);
  const edge = legal.find((e) => e.to === to);
  if (edge === undefined)
    fail(`${from} → ${to} is not a legal edge; from \`${from}\` the legal set is ${legal.map((e) => e.to).join(", ")}`);

  // CLOSED AT RUNTIME. The union is a compile-time claim about callers this module does not
  // have yet; an unknown role fell through both branches below and was ACCEPTED, which is the
  // most permissive possible answer to "who are you". Refuse first, then discriminate.
  if (actor.role !== "sweeper" && actor.role !== "executor")
    fail(`unknown actor role ${JSON.stringify((actor as { role: unknown }).role)} — the legal set is executor|sweeper`);
  if (actor.role === "sweeper" && !edge.sweeperMay)
    fail(`a sweeper may only settle — it may never advance a launch phase (attempted ${from} → ${to}) `
       + `on behalf of an executor it believes is gone`);
  if (actor.role === "executor") {
    if (!sameExecutor(actor.executor, prev.executor))
      fail(`the acting executor is not the row's executor: row ${JSON.stringify(prev.executor)}, actor ${JSON.stringify(actor.executor)}`);
    if (actor.attemptId !== prev.attemptId)
      fail(`the acting attemptId ${JSON.stringify(actor.attemptId)} is not the row's ${JSON.stringify(prev.attemptId)} — `
         + `a re-read that finds a FOREIGN nonce is a loss, never a licence to proceed`);
  }

  if (to === "settled" && !opts.terminalExists)
    fail("a settle requires the terminal to exist FIRST — settling without one publishes a finished goal that never finished");

  // IMMUTABILITY, checked as comparisons and not as documentation. The revision-CAS that got us
  // here proves nobody moved the row concurrently; it proves nothing about what this writer wrote.
  //
  // `v` IS DELIBERATELY NOT CHECKED HERE, and its absence is the point. Both arguments are
  // `GoalEffRow`, which means both came through `parseGoalEff`, which refuses anything but `v: 1`.
  // A `next.v !== prev.v` comparison at this point can never be true — it would be a guard that
  // reads as protection and has no case that reaches it, which is worse than no guard, because a
  // later reader counts it as covering something. § S1's immutability rule for `v` is enforced,
  // once, by the parser refusing every other value.
  if (!sameExecutor(next.executor, prev.executor))
    fail(`\`executor\` is immutable after creation: ${JSON.stringify(prev.executor)} → ${JSON.stringify(next.executor)} `
       + `would hand the election to a different process while taking an otherwise-legal edge`);
  if (next.attemptId !== prev.attemptId)
    fail(`\`attemptId\` is immutable after creation: ${JSON.stringify(prev.attemptId)} → ${JSON.stringify(next.attemptId)}`);

  const prevAddr = addrOf(prev), nextAddr = addrOf(next);
  if (prevAddr === undefined) {
    // No address yet. It may be SET on `claimed → launching` — and only there. A settle out of
    // `claimed` never had one and must not invent one: an address on a row that never launched
    // names something that does not exist.
    // `claimed → launching` MUST set `addr`, and that is enforced by the parser rather than here:
    // a `launching` row without one is not a `GoalEffRow` at all. The edge case that IS reachable
    // is the other one below — a settle out of `claimed` inventing an address, which parses fine
    // because `settled.addr` is legal, and is wrong because this row never launched.
    if (to !== "launching" && nextAddr !== undefined) {
      fail(`\`addr\` must stay ABSENT on ${from} → ${to}: this row never passed through \`launching\`, `
         + `so there is no address it could be carrying`);
    }
  } else if (!sameAddr(prevAddr, nextAddr)) {
    fail(`\`addr\` is immutable once written: ${JSON.stringify(prevAddr)} → ${JSON.stringify(nextAddr)}`);
  }
}
