/** A faithful in-memory model of the §13.1 durable issuance gate (`gate.<lifecycleUid>`), for smokes
 *  that register or mint against a barrier without the broker-backed gate. This is the one copy of
 *  the gate's transition rules (#2709): seven suites each carried their own, and a rule change had to
 *  be made in every copy while a missed copy kept passing.
 *
 *  ONE key binds `{lifecycleUid, state, generation, processEpoch, registrationRevision,
 *  nameAuthorityRevision, revision, op}`, and BOTH halves of the seam share it. The mint's `commit`
 *  and every barrier's `freeze` are revision-pinned CAS on the SAME key and each advances `revision`,
 *  so exactly one of a parked mint's commit and a barrier's freeze wins. `freeze` records its
 *  registration op and returns the FROZEN revision as a fencing token; `reopen(token, …)` is a CAS
 *  that only the barrier still holding its token can win (a stale reopen loses), and it clears the
 *  op. `retire` records a retirement op. `stage` is CREATE-ONLY / idempotent-if-identical (a
 *  different row for the same credentialId conflicts). `evict` models verified cluster-wide eviction
 *  (records the principal; `setEvictOk(false)` forces fail-closed). The ledger `rows` carry the
 *  normative §13.1 fields + `active`/`revoked` state.
 *
 *  Not shipped and not imported by shipped code: this file lives under `smoke/`. */
import type { EpGateState, EpIssuanceBarrier, EpIssuanceGate, EpServeLedgerRow } from "../src/endpoint-service.js";
import { mintLifecycleUid } from "../src/subjects.js";

export interface IssuanceGateInit {
  space: string;
  endpoint: string;
  lifecycleUid: string;
  /** The gate's coordinate; each defaults to 0, a gate no registration has advanced yet. */
  generation?: number;
  processEpoch?: number;
  registrationRevision?: number;
  nameAuthorityRevision?: number;
  /** The registered serving principal the mint binds to (§13.1). Defaults to `u_op.mgr`. */
  principal?: string;
  /** Whether `evict` verifies every holder gone. Defaults to true. */
  evictOk?: boolean;
}

export function makeIssuanceGate(init: IssuanceGateInit) {
  let gate: EpGateState = {
    space: init.space,
    endpoint: init.endpoint,
    lifecycleUid: init.lifecycleUid,
    principal: init.principal ?? "u_op.mgr",
    state: "open",
    generation: init.generation ?? 0,
    processEpoch: init.processEpoch ?? 0,
    registrationRevision: init.registrationRevision ?? 0,
    nameAuthorityRevision: init.nameAuthorityRevision ?? 0,
    revision: 1,
  };
  const op = { opId: mintLifecycleUid(), kind: "registration" as const };
  const rows = new Map<string, EpServeLedgerRow>(); // keyed by credentialId; row.state is active|revoked
  const evicted: string[] = [];
  let evictOk = init.evictOk ?? true;
  const observe = (): EpGateState | null => ({ ...gate });
  const revoke = (row: EpServeLedgerRow) => { const e = rows.get(row.credentialId); if (e) e.state = "revoked"; };
  const seam: EpIssuanceGate = {
    observe,
    stage: (row) => {
      const existing = rows.get(row.credentialId);
      if (existing) { // create-only / idempotent-if-identical: a differing row for the same id conflicts
        if (JSON.stringify(existing) !== JSON.stringify(row)) throw new Error(`ledger row conflict: credentialId ${row.credentialId} already staged with a different value`);
        return;
      }
      rows.set(row.credentialId, { ...row });
    },
    commit: (expectedRevision) => {
      if (gate.state !== "open" || gate.revision !== expectedRevision) return false;
      gate.revision++; // a winning mint advances the gate revision, staying open at the same tuple
      return true;
    },
    revoke,
  };
  const barrier: EpIssuanceBarrier = {
    observe,
    freeze: (expectedRevision) => {
      if (gate.state !== "open" || gate.revision !== expectedRevision) return null; // revision-pinned CAS
      gate = { ...gate, state: "frozen", op, revision: gate.revision + 1 };
      return gate.revision; // the fencing token = the frozen revision
    },
    enumerate: () => [...rows.values()],
    revoke,
    evict: (holderPrincipals) => holderPrincipals.map((p) => { if (!evictOk) return false; evicted.push(p); return true; }),
    reopen: (token, succ) => {
      if (gate.state !== "frozen" || gate.revision !== token) return false; // token-pinned CAS: a stale reopen loses
      const { op: _op, ...frozen } = gate;
      gate = {
        ...frozen, state: "open",
        generation: succ.generation, processEpoch: succ.processEpoch,
        registrationRevision: succ.registrationRevision, nameAuthorityRevision: succ.nameAuthorityRevision,
        revision: token + 1,
      };
      return true;
    },
  };
  return {
    seam, barrier, rows, evicted,
    /** CAS-freeze the gate at its CURRENT revision (a barrier's first step); returns the token or null. */
    freezeNow: () => barrier.freeze(gate.revision),
    retire: () => { gate = { ...gate, state: "retired", op: { opId: mintLifecycleUid(), kind: "retirement" }, revision: gate.revision + 1 }; },
    setEvictOk: (v: boolean) => { evictOk = v; },
    /** A copy of the gate as it stands now. */
    coord: () => ({ ...gate }),
    active: () => [...rows.values()].filter((r) => r.state === "active").length,
    revoked: () => [...rows.values()].filter((r) => r.state === "revoked").length,
  };
}

export type IssuanceGate = ReturnType<typeof makeIssuanceGate>;
