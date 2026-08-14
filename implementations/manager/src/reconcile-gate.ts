/**
 * GUARDED RECONCILIATION of an endpoint issuance gate left FROZEN by a crashed re-registration
 * (Cotal #391; SPEC 13.1 "the gate is left frozen for reconciliation").
 *
 * THE STATE THIS REPAIRS, and the only one it accepts: a manager restart was killed between the
 * barrier's freeze and the successor's completion. The gate is `frozen` under a `registration` op
 * whose holder no longer exists, so the freeze token's owner can never resume. Fail-closed is
 * correct and stays correct — but in THAT state the freeze protects nothing while blocking every
 * restart, and before this the operator's only exits were hand-driving internals or discarding
 * state.
 *
 * The repair itself is not new: it is the SHIPPED composition (`endpointRegistrationBarrier` +
 * a verified evictor), driven in the §13.1 order, with no raw writes. What is new is the GUARD in
 * front of it, which is the whole point of the command:
 *
 *   1. VERIFY THE HOLDER IS GONE, AFFIRMATIVELY. Not "the holder did not answer", not "a timeout
 *      elapsed" — a COMPLETE, single-server-proven CONNZ sweep that PROVES no connection attributes
 *      to the freeze-holder. Absence of evidence is `unknown`, and `unknown` REFUSES.
 *   2. LOG WHAT WAS FOUND, before mutating anything.
 *   3. REFUSE LOUD, NAMING WHICH CONDITION FAILED — an operator staring at a wedged mesh needs to
 *      know whether the holder is alive, whether liveness could not be established, or whether the
 *      gate simply is not in the state this repairs. "It refused" is not actionable.
 *
 * The probe sits ON TOP OF the barrier's own fail-closed eviction, never in place of it: BOTH must
 * pass. There is deliberately NO force flag and no path that discards gate state — a recovery path
 * whose failure mode is killing a live manager does not get an override.
 */
import {
  endpointRegistrationBarrier, parseEndpointGate, epgateKey,
  type EndpointGateRow,
} from "@cotal-ai/core";
import type { KV } from "@nats-io/kv";

/** Which guard refused. The command prints this verbatim, and the smoke asserts on it, so a refusal
 *  can never be confused with a different refusal — the failure mode where an operator reads
 *  "refused" and force-retries the wrong thing. */
export type GateReconcileCondition =
  /** No gate row at the coordinate — nothing to reconcile (a typo'd endpoint/instanceId). */
  | "no-gate"
  /** The gate is `open` or `retired`: this repairs a frozen gate only. */
  | "not-frozen"
  /** Frozen under a takeover/activation/retirement op — this completes a REGISTRATION's obligation. */
  | "wrong-op-kind"
  /** The freeze-holder still holds a live connection. The freeze is protecting a live op. */
  | "holder-alive"
  /** The sweep under-reported (no responder, truncation, unproven single-server mode). May be live. */
  | "holder-unknown"
  /** The oracle could not be consulted at all, or answered unusably (unreachable, unprovisioned,
   *  garbled, or a reply that did not echo the principal asked about). */
  | "liveness-unestablishable"
  /** A holder's eviction was not VERIFIED gone — the barrier's own fail-closed step. */
  | "eviction-unverified"
  /** The token-pinned reopen lost its CAS: a newer barrier moved the gate. Re-observe. */
  | "raced";

/** A refusal, carrying the condition as DATA rather than only as prose. */
export class GateReconcileRefused extends Error {
  constructor(
    readonly condition: GateReconcileCondition,
    message: string,
  ) {
    super(message);
    this.name = "GateReconcileRefused";
  }
}

/** The freeze-holder liveness verdict as the reconciler consumes it. `unestablishable` is kept
 *  DISTINCT from `unknown`: both refuse, but they tell the operator to fix different things (start
 *  the daemon vs. re-observe a mesh that could not be swept completely). */
export type HolderLiveness =
  | { state: "live"; detail: string }
  | { state: "gone"; detail: string }
  | { state: "unknown"; detail: string }
  | { state: "unestablishable"; detail: string };

/** What the reconciliation found and did — returned on success, and logged either way. */
export interface GateReconcileReport {
  endpoint: string;
  instanceId: string;
  holderPrincipal: string;
  opId: string;
  freezeToken: number;
  /** The coordinate before the repair; the reopen advances `generation` by one and NOTHING else. */
  before: { generation: number; processEpoch: number; registrationRevision: number; nameAuthorityRevision: number };
  liveness: HolderLiveness;
  familyRows: number;
  revoked: string[];
  evicted: string[];
  reopenedAtGeneration: number;
}

/**
 * Reconcile ONE frozen gate. Every seam the guard depends on is injected, so the command wires the
 * real ones and the smoke drives the real barrier against an ephemeral broker.
 *
 * `probeHolder` is the AFFIRMATIVE check. It must return `gone` only on a proven-absent verdict;
 * everything else — including any form of "we did not hear back" — must be `unknown` or
 * `unestablishable`. It is a parameter and not an inlined call so that this ordering (probe, then
 * refuse, THEN mutate) is structural: the barrier is not even constructed until the probe passed.
 */
export async function reconcileEndpointGate(opts: {
  kv: KV;
  space: string;
  endpoint: string;
  instanceId: string;
  probeHolder: (principal: string) => Promise<HolderLiveness>;
  evict: (holderPrincipal: string) => Promise<boolean>;
  log: (line: string) => void;
}): Promise<GateReconcileReport> {
  const { kv, space, endpoint, instanceId, log } = opts;

  // ---- 1. Observe the gate RAW: the freeze token IS the row revision, and the dead op's opId is
  // on the row. Both are needed to complete that op's obligation rather than start a new one.
  const key = epgateKey(endpoint, instanceId);
  const entry = await kv.get(key);
  if (!entry || entry.operation !== "PUT")
    throw new GateReconcileRefused("no-gate", `no endpoint gate at ${key} — nothing to reconcile (check the endpoint and instanceId)`);
  const row: EndpointGateRow = parseEndpointGate(entry.value, key);
  const freezeToken = entry.revision;

  log(`gate ${key}: state=${row.state} generation=${row.generation} processEpoch=${row.processEpoch} registrationRevision=${row.registrationRevision} nameAuthorityRevision=${row.nameAuthorityRevision} op=${JSON.stringify(row.op ?? null)} holder=${row.principal} revision=${freezeToken}`);

  if (row.state !== "frozen")
    throw new GateReconcileRefused("not-frozen", `the gate at ${key} is "${row.state}", not "frozen" — this reconciles a frozen gate only, and an open gate needs no repair`);
  if (row.op?.kind !== "registration")
    throw new GateReconcileRefused("wrong-op-kind", `the gate at ${key} is frozen under a "${row.op?.kind}" op, not a registration — this completes a crashed REGISTRATION's §13.1 obligation only; refusing to reinterpret another op's intent`);
  const opId = row.op.opId;

  // ---- 2. THE GUARD. Affirmative liveness, before anything is mutated.
  const liveness = await opts.probeHolder(row.principal);
  log(`freeze-holder ${row.principal}: ${liveness.state} — ${liveness.detail}`);
  if (liveness.state === "live")
    throw new GateReconcileRefused(
      "holder-alive",
      `the freeze-holder "${row.principal}" is ALIVE (${liveness.detail}) — the freeze is protecting an op that is still running. Refusing: reconciling here would revoke and evict a live incarnation's credential family. Stop that process first, then re-run.`,
    );
  if (liveness.state === "unknown")
    throw new GateReconcileRefused(
      "holder-unknown",
      `the liveness of freeze-holder "${row.principal}" is UNKNOWN (${liveness.detail}) — the sweep could not prove it absent, and absence of evidence is not evidence of absence. Refusing: a holder that may still be live is treated as live.`,
    );
  if (liveness.state === "unestablishable")
    throw new GateReconcileRefused(
      "liveness-unestablishable",
      `liveness for freeze-holder "${row.principal}" CANNOT BE ESTABLISHED (${liveness.detail}) — without the oracle this repair has no affirmative check to stand on, and it will not infer death from silence.`,
    );

  // ---- 3. Only now: the shipped composition, in the §13.1 order, over the DEAD op's own id.
  const barrier = endpointRegistrationBarrier(kv, space, { endpoint, instanceId, opId, evict: opts.evict });

  const rows = await barrier.enumerate();
  log(`family: ${rows.length} ledger row(s)`);
  const revoked: string[] = [];
  for (const r of rows) {
    if (r.state === "active") {
      await barrier.revoke(r); // deny-new BEFORE kill-live — the precondition eviction's name carries
      revoked.push(r.credentialId);
      log(`  revoked ${r.credentialId} (${r.holderPrincipal})`);
    } else log(`  ${r.state}: ${r.credentialId} (${r.holderPrincipal})`);
  }

  // Evict every distinct family holder, and the freeze-holder itself even when it staged no rows —
  // the probe proved it gone, and the barrier's verify is what makes that durable rather than a
  // snapshot. An unverified eviction aborts and LEAVES THE GATE FROZEN (unchanged §13.1 posture).
  const holders = [...new Set([row.principal, ...rows.map((r) => r.holderPrincipal)])];
  const evicted: string[] = [];
  for (const h of holders) {
    if (!(await barrier.evict(h)))
      throw new GateReconcileRefused(
        "eviction-unverified",
        `eviction of "${h}" was NOT verified gone — the gate stays frozen (fail-closed, SPEC 13.1). Nothing was reopened; the revocations above are deny-new and safe to leave.`,
      );
    evicted.push(h);
    log(`  verified evicted: ${h}`);
  }

  // ---- 4. Token-pinned abort-reopen at the UNCHANGED coordinate. The dead op wrote nothing
  // forward, so only `generation` advances; the successor's normal takeover then runs end-to-end.
  const reopenedAtGeneration = row.generation + 1;
  const ok = await barrier.reopen(freezeToken, {
    generation: reopenedAtGeneration,
    processEpoch: row.processEpoch,
    registrationRevision: row.registrationRevision,
    nameAuthorityRevision: row.nameAuthorityRevision,
  });
  if (!ok)
    throw new GateReconcileRefused(
      "raced",
      `the token-pinned reopen of ${key} lost its CAS — a newer barrier moved the gate while this repair ran. Nothing was reopened; re-observe before retrying.`,
    );

  log(`✓ gate ${key} reopened at generation=${reopenedAtGeneration}, processEpoch unchanged (${row.processEpoch}); family revoked (${revoked.length}) and verify-evicted (${evicted.length} holder(s))`);
  return {
    endpoint, instanceId, holderPrincipal: row.principal, opId, freezeToken,
    before: {
      generation: row.generation, processEpoch: row.processEpoch,
      registrationRevision: row.registrationRevision, nameAuthorityRevision: row.nameAuthorityRevision,
    },
    liveness, familyRows: rows.length, revoked, evicted, reopenedAtGeneration,
  };
}
