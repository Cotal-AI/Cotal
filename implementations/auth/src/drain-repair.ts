/**
 * The per-op CONFINED DRAIN-REPAIR executors (#29 HIGH 1, the functional closure of the
 * retirement drain's accepted-work boundary): the COMMIT APPLIER and the POOL-ROUTE RECONCILER,
 * each a short-lived, per-repair, exact-coordinate credential — never a broad records-write
 * grant bolted onto the drain (the shortcut the panel scoped out of 84cd08f).
 *
 * THE SPLIT (fact pin 1): two DISTINCT principals per retirement op, `local.epapl_<opId-hash>`
 * (applier: the guarded record-write of an accepted self-class commit) and
 * `local.eprec_<opId-hash>` (reconciler: the create-only EPW enqueue of an accepted pool route).
 * Their authorities and failure/revocation domains are disjoint; kill-live is by CONNZ principal
 * tag, so the two roles are two principals (the cleaner/executor precedent).
 *
 * THE CONFUSED-DEPUTY CLOSURE (fact pin 2): a grant coordinate is NEVER minted from a raw
 * `ObligationRow.commitKey`. Before any applier mint the key must parse under the CLOSED
 * self-commit class derived from the canonical frozen kind collections: its kind token must be a
 * registered NON-authority record kind ({@link callerReadableRecordKind} over the same
 * single-source registry the reader seam consults), the key arity must match that kind's
 * definition exactly (which structurally excludes the 3-token lifecycle HEAD — the dual-token
 * trap), the split tail must be `spec`/`status`, and every qualifier token must pass its own
 * validator. A forged accepted-self row naming `oblig.`/`lifecycle` head/`govern.`/`policy.`/
 * `uid.`/`frontier.` (or any unregistered kind) refuses BEFORE a credential exists. Registered
 * THIRD-PARTY kinds are deliberately OUTSIDE the applier class in this slice (none exist in
 * production; widening past the core caller kinds is its own reviewed decision, not a default).
 * NAMED RESIDUAL (stated per fact): subject ACLs cannot enforce CAS headers, so within its
 * granted exact key a compromised applier can overwrite/DEL/PURGE that one key for the
 * credential's short life — the confinement is the exact-key set + the op lifetime + the closed
 * class, never write semantics.
 *
 * THE CLOSED-COMMAND BOUNDARY (fact pin 3): the executors receive already-validated commands.
 * The applier's (commitKey, bytes, baseRevision) comes from `recoverSelfCore` AFTER intent
 * resolution + canonical-digest verification + at-base confirmation; the reconciler's
 * {@link PoolRouteRepair} is constructed by the MEDIATOR from the durable acceptance decision
 * fact (read + parsed + row-bound), its bytes the canonical `workItemBytesOf` derivation. The
 * executors re-validate shape (defense in depth) but hold no derivation authority.
 *
 * Lifecycle: one credential per REPAIR CALL — minted, connected non-standing, executed, closed
 * in a finally. A retirement typically repairs zero or a handful of rows; the tighter lifetime
 * beats connection reuse.
 */
import { createHash } from "node:crypto";
import { jetstream } from "@nats-io/jetstream";
import { headers as natsHeaders } from "@nats-io/transport-node";
import {
  AUTHORITY_KIND_DEFS,
  EpEnvelopeError,
  RECORD_KINDS,
  callerReadableRecordKind,
  effectCancelledFactOf,
  goalCancelledResultOf,
  isCasLoss,
  publishFactCreateOnly,
  recordsBucket,
  spacePrefix,
} from "@cotal-ai/core";
import { openAuthorityClient } from "./authority-client.js";
import type { ApplyCommit, CancelEffectsRoute, EffectsCancelRepair, PoolRouteRepair, ReconcilePoolRoute } from "./admission-mediator.js";

/** The infra owner for repair principals: CONNZ-attributable, reserved (the cleaner precedent). */
const INFRA_OWNER = "local";

/** `epapl_<16-hex-of-sha256(opId)>` / `eprec_<...>`: distinct prefixes per role, unique per op —
 *  an evict of one role's principal never touches the other's (the epcln_/epexe_ pattern). */
function opActor(prefix: "epapl" | "eprec" | "epcan", opId: string): string {
  return `${prefix}_${createHash("sha256").update(opId).digest("hex").slice(0, 16)}`;
}

/**
 * Validate one commit key against the CLOSED self-commit class (fact pin 2). Returns the exact
 * key (unchanged) or throws `permission-denied` with the refused reason. The class is derived
 * from the SAME canonical frozen collections the record-reader seam consults — a new authority
 * kind is excluded by construction, never by a parallel hand-kept list.
 */
export function assertAppliableCommitKey(commitKey: string): string {
  if (typeof commitKey !== "string" || commitKey.length === 0 || commitKey.length > 512)
    throw new EpEnvelopeError("permission-denied", `the commit key is not a bounded non-empty string; no applier credential mints for it (SPEC 13.8/13.9)`);
  const tokens = commitKey.split(".");
  const kind = tokens[0]!;
  // Registered AND non-authority (the reader seam's single-source predicate): a pure authority
  // kind (oblig/uid/govern/policy/frontier) and any unregistered kind both refuse here.
  if (!callerReadableRecordKind(kind))
    throw new EpEnvelopeError("permission-denied", `the commit key "${commitKey}" targets "${kind}", which is not a registered non-authority record kind; an accepted self-commit can only name the closed caller-record class, so no applier credential mints for it (SPEC 13.8/13.9; the confused-deputy closure)`);
  const def = RECORD_KINDS[kind] ?? undefined;
  if (def === undefined || AUTHORITY_KIND_DEFS.some((d) => d === def))
    throw new EpEnvelopeError("permission-denied", `the commit key "${commitKey}" has no caller-record definition for "${kind}"; no applier credential mints for it (SPEC 13.8/13.9)`);
  const expected = 1 + def.qualifiers.length + (def.split ? 1 : 0);
  if (tokens.length !== expected)
    throw new EpEnvelopeError("permission-denied", `the commit key "${commitKey}" has ${tokens.length} tokens but the "${kind}" definition requires exactly ${expected}; a shallower or deeper coordinate (including an authority HEAD arity) never mints (SPEC 13.8/13.9)`);
  if (def.split && tokens[expected - 1] !== "spec" && tokens[expected - 1] !== "status")
    throw new EpEnvelopeError("permission-denied", `the commit key "${commitKey}" does not end in spec/status; the "${kind}" kind is split (SPEC 13.7)`);
  // The targeted half's REGISTERED WRITER must be the §13.8 commit path itself: a self-commit is
  // the writer's own guarded record write, so the applier acts only for kinds the canonical
  // writer metadata assigns to "commit-path" (goal/cp today). A kind owned by another writer
  // (provisioner registration, the minting manager, an issuer, the pool-owner lease command)
  // never mints an applier credential, however caller-readable it is.
  const half = def.split ? (tokens[expected - 1] as "spec" | "status") : "spec";
  if (def.writers[half] !== "commit-path")
    throw new EpEnvelopeError("permission-denied", `the commit key "${commitKey}" targets a "${kind}" ${half} whose registered writer is "${def.writers[half]}", not the SPEC 13.8 commit path; an accepted self-commit can only name commit-path kinds, so no applier credential mints for it (SPEC 13.8/13.9)`);
  for (let q = 0; q < def.qualifiers.length; q++) {
    try {
      def.qualifiers[q]!.assert(tokens[1 + q]!);
    } catch (e) {
      throw new EpEnvelopeError("permission-denied", `the commit key "${commitKey}" fails the "${def.qualifiers[q]!.name}" qualifier: ${e instanceof Error ? e.message : String(e)}; no applier credential mints for it (SPEC 13.8/13.9)`);
    }
  }
  return commitKey;
}

/** Validate one pool-route repair's subject shape (defense in depth over the mediator's
 *  derivation): exactly `<space-prefix>.epw.<endpoint>.<pool>.<cO>.<cA>.<cUid>.<id>` for THIS
 *  space. Returns the subject or throws `permission-denied`. */
export function assertPoolRepairSubject(space: string, subject: string): string {
  const prefix = `${spacePrefix(space)}.epw.`;
  if (!subject.startsWith(prefix))
    throw new EpEnvelopeError("permission-denied", `the pool repair subject "${subject}" is not this space's EPW rail; no reconciler credential mints for it (SPEC 13.6/13.9)`);
  const tokens = subject.slice(prefix.length).split(".");
  if (tokens.length !== 6 || tokens.some((t) => t.length === 0 || t.includes(">") || t.includes("*")))
    throw new EpEnvelopeError("permission-denied", `the pool repair subject "${subject}" is not an exact <endpoint>.<pool>.<owner>.<actor>.<uid>.<id> item coordinate (no wildcards, six tokens); no reconciler credential mints for it (SPEC 13.6/13.9)`);
  return subject;
}

/** The COMMIT APPLIER's grant (SPEC 13.9 "Drain commit applier" row): ONE exact records-KV
 *  subject for the validated commit key + the connection-scoped inbox. No reads, no wildcards.
 *  The commitKey MUST have passed {@link assertAppliableCommitKey} before this builder runs. */
export function drainApplierGrants(space: string, commitKey: string, connId: string): { publish: string[]; subscribe: string[] } {
  return {
    publish: [`$KV.${recordsBucket(space)}.${assertAppliableCommitKey(commitKey)}`],
    subscribe: [`_INBOX_${connId}.>`],
  };
}

/** The POOL-ROUTE RECONCILER's grant (SPEC 13.9 "Drain route reconciler" row): ONE exact EPW
 *  item subject + the connection-scoped inbox. No reads, no wildcards. The subject MUST have
 *  passed {@link assertPoolRepairSubject} before this builder runs. */
export function drainReconcilerGrants(space: string, itemSubject: string, connId: string): { publish: string[]; subscribe: string[] } {
  return {
    publish: [assertPoolRepairSubject(space, itemSubject)],
    subscribe: [`_INBOX_${connId}.>`],
  };
}

/** Validate one effects-cancel completion subject (defense in depth over the mediator's
 *  derivation): exactly this space's `epf.<endpoint>.eff.<owner>.<actor>.<uid>.<id>` marker or
 *  `epf.<endpoint>.goal.<owner>.<actor>.<uid>.<goalId>.result` coordinate — the two completion
 *  subjects the drain's established() reads. Returns the subject or throws `permission-denied`. */
export function assertEffectsCancelSubject(space: string, subject: string): string {
  const prefix = `${spacePrefix(space)}.epf.`;
  const refuse = (why: string): never => {
    throw new EpEnvelopeError("permission-denied", `the effects-cancel subject "${subject}" ${why}; no canceller credential mints for it (SPEC 13.8/13.9)`);
  };
  if (!subject.startsWith(prefix)) refuse("is not this space's EPF rail");
  const tokens = subject.slice(prefix.length).split(".");
  if (tokens.some((t) => t.length === 0 || t.includes(">") || t.includes("*"))) refuse("carries a wildcard or empty token");
  const isEff = tokens.length === 6 && tokens[1] === "eff";
  const isGoalResult = tokens.length === 7 && tokens[1] === "goal" && tokens[6] === "result";
  if (!isEff && !isGoalResult) refuse("is neither an exact eff completion marker nor an exact goal result coordinate");
  return subject;
}

/** The EFFECTS CANCELLER's grant (SPEC 13.9 "Drain effects canceller" row): ONE exact completion
 *  subject + the connection-scoped inbox. No reads, no wildcards. The subject MUST have passed
 *  {@link assertEffectsCancelSubject} before this builder runs. */
export function drainCancellerGrants(space: string, completionSubject: string, connId: string): { publish: string[]; subscribe: string[] } {
  return {
    publish: [assertEffectsCancelSubject(space, completionSubject)],
    subscribe: [`_INBOX_${connId}.>`],
  };
}

/**
 * Build the two per-op repair executors over the data-account seed (the cleaner/executor
 * substrate). Each returned function mints its per-repair credential, executes the ONE handed
 * command, and closes — fail-closed on any mint/validation failure (the drain's row stays
 * frozen, loud).
 */
export function makeDrainRepairers(opts: {
  server: string;
  space: string;
  dataAccount: { pub: string; signingSeed: string };
  log: (line: string) => void;
}) {
  const { server, space, dataAccount, log } = opts;
  const kvPrefix = `$KV.${recordsBucket(space)}`;

  const applyCommitFor = (opId: string): ApplyCommit => async (commitKey, valueBytes, baseRevision) => {
    assertAppliableCommitKey(commitKey);
    if (!Number.isSafeInteger(baseRevision) || baseRevision < 0)
      throw new EpEnvelopeError("permission-denied", `the commit base revision ${String(baseRevision)} is not a non-negative integer; no applier credential mints (SPEC 13.8)`);
    const subject = `${kvPrefix}.${commitKey}`;
    const client = await openAuthorityClient({
      server, space, dataAccount,
      label: `cotal:ep-apply:${space}:${commitKey}`,
      principal: { owner: INFRA_OWNER, actor: opActor("epapl", opId) },
      grants: (id) => drainApplierGrants(space, commitKey, id),
      log,
    });
    try {
      // The guarded CAS the acceptance promised: create at 0 / update at the pinned base. A CAS
      // loss means another writer advanced the record; the drain's next pass re-classifies
      // (landed / superseded) — never a blind retry here.
      const h = natsHeaders();
      h.set("Nats-Expected-Last-Subject-Sequence", String(baseRevision));
      try {
        await jetstream(client.nc).publish(subject, valueBytes, { headers: h });
      } catch (e) {
        if (isCasLoss(e))
          throw new EpEnvelopeError("conflict", `another writer moved ${commitKey} past base revision ${baseRevision}; this accepted commit's CAS can no longer land and the next drain pass re-classifies it (landed or superseded, SPEC 13.8)`);
        throw e;
      }
      log(`drain-repair: applied the accepted self-commit ${commitKey} at base ${baseRevision} (op ${opId})`);
    } finally {
      await client.close();
    }
  };

  const reconcilePoolRouteFor = (opId: string): ReconcilePoolRoute => async (repair: PoolRouteRepair) => {
    if (repair.kind !== "pool")
      throw new EpEnvelopeError("permission-denied", `the pool reconciler received a "${String((repair as { kind?: unknown }).kind)}" repair; it executes pool enqueues only (SPEC 13.8/13.9)`);
    assertPoolRepairSubject(space, repair.subject);
    if (!(repair.bytes instanceof Uint8Array) || repair.bytes.length === 0)
      throw new EpEnvelopeError("permission-denied", `the pool repair for ${repair.subject} carries no item bytes; no reconciler credential mints (SPEC 13.6)`);
    const client = await openAuthorityClient({
      server, space, dataAccount,
      label: `cotal:ep-reenqueue:${space}`,
      principal: { owner: INFRA_OWNER, actor: opActor("eprec", opId) },
      grants: (id) => drainReconcilerGrants(space, repair.subject, id),
      log,
    });
    try {
      // CREATE-ONLY (the §13.6 idempotent bridge): a lost create means a concurrent repair or a
      // late canonicalizer won — benign, the drain re-reads establishment either way.
      const h = natsHeaders();
      h.set("Nats-Expected-Last-Subject-Sequence", "0");
      try {
        await jetstream(client.nc).publish(repair.subject, repair.bytes, { headers: h });
        log(`drain-repair: re-enqueued the accepted pool item ${repair.subject} (op ${opId})`);
      } catch (e) {
        if (!isCasLoss(e)) throw e;
        log(`drain-repair: the create for ${repair.subject} lost (a concurrent enqueue won); the drain re-reads establishment (op ${opId})`);
      }
    } finally {
      await client.close();
    }
  };

  const cancelEffectsRouteFor = (opId: string): CancelEffectsRoute => async (repair: EffectsCancelRepair) => {
    if (repair.kind !== "effects-cancel")
      throw new EpEnvelopeError("permission-denied", `the effects canceller received a "${String((repair as { kind?: unknown }).kind)}" repair; it executes completion cancels only (SPEC 13.8/13.9)`);
    assertEffectsCancelSubject(space, repair.subject);
    const target = repair.acceptance.target;
    if (target === undefined)
      throw new EpEnvelopeError("permission-denied", `the accepted work at ${repair.key} binds no target, so no retirement owns it; a target-less acceptance is never retirement-cancelled (SPEC 13.8)`);
    // The core builders refuse a foreign target (a retirement cancels only ITS OWN target's work)
    // and never fabricate success: an action terminalizes through the goal union's FIRST-CLASS
    // `cancelled` state; a non-action effect through the EffectCancelledFact union member.
    const fact = repair.goal
      ? goalCancelledResultOf(repair.acceptance, { opId, target }, Date.now())
      : effectCancelledFactOf(repair.acceptance, { opId, target }, Date.now());
    const client = await openAuthorityClient({
      server, space, dataAccount,
      label: `cotal:ep-cancel:${space}`,
      principal: { owner: INFRA_OWNER, actor: opActor("epcan", opId) },
      grants: (id) => drainCancellerGrants(space, repair.subject, id),
      log,
    });
    try {
      // CREATE-ONLY (first-terminal-wins, §13.8): a racing real completion that landed first
      // WINS and this cancel loses its create harmlessly — the drain re-reads either way.
      const res = await publishFactCreateOnly(jetstream(client.nc), repair.subject, new TextEncoder().encode(JSON.stringify(fact)));
      log(res.won
        ? `drain-repair: the in-flight effect was cancelled by this retirement (${repair.key}, op ${opId})`
        : `drain-repair: the cancel for ${repair.key} lost its create (a real completion landed first); the drain re-reads the winner (op ${opId})`);
    } finally {
      await client.close();
    }
  };

  return { applyCommitFor, reconcilePoolRouteFor, cancelEffectsRouteFor };
}
