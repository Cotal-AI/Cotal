/**
 * The STATIC §13.1 lifecycle executor (Unit B): the manager-side adapter that drives the ONE
 * shared core saga (`@cotal-ai/core` lifecycle-saga) over a direct-KV
 * {@link LifecycleStateTransport}, plus the static executor's OWN orchestration — the durable
 * slot mapping (F3 outer spawn intent + the F5-bind alias -> (owner, actor, uid) join), the
 * static credential-ledger rows, and the F1 terminal sequence.
 *
 * Three-way split (the Unit B design note, panel-locked): the key/value GRAMMAR lives in core
 * `lifecycle-state.ts`; the CAS SEQUENCING is the shared core saga this module DELEGATES to
 * (never a hand-ordered local copy); the barrier ORCHESTRATION here is the static executor's
 * own (revoke from the slot's recorded credentialIds, fail-closed broker connection eviction of the
 * holder principals THOSE ROWS name — SPEC 13.1's own target set — that holds the lifecycle
 * terminalizing until a complete scan verifies each gone, then footprint cleanup via the manager's
 * deprovision hooks).
 *
 * F5-bind (the F4 restatement): the wire AUTHORITY coordinate is the incarnation-unique nkey
 * (`actor`); the ALIAS is routing only, protected by the name-keyed slot row + uid reservation +
 * the manager's freeSlot hold — never by the head CAS alone (the head is principal-keyed).
 */
import {
  EpEnvelopeError,
  type LifecycleStateTransport,
  type LifecycleKvEntry,
  type StaticManagedSlotRow,
  type StaticSlotPhase,
  type CredentialLedgerRow,
  staticSlotKey,
  parseStaticSlotRow,
  credRowKey,
  parseLedgerRow,
  SOURCE_ROOT,
  RECORD_KINDS,
  recordSpecKey,
  createRecordEntry,
  updateRecordEntry,
  runActivationSagaAtUid,
  resumeActivationSaga,
  gateObserve,
  gateFreeze,
  gateRetire,
  headCandidate,
  headBeginRetirement,
  headCompleteRetirement,
  type EvictionResult,
} from "@cotal-ai/core";
import type { KV } from "@nats-io/kv";

const enc = new TextEncoder();

export interface StaticLifecycleAuditSpec {
  v: 1; principal: string; alias: string; lifecycleUid: string;
  managerInstance: string; managerProcessUid: string; retirementOpId: string;
  broker: Pick<EvictionResult, "kicked" | "remaining" | "scanComplete" | "verifiedGone">;
  timestamp: string;
}

function sameAudit(a: StaticLifecycleAuditSpec, b: StaticLifecycleAuditSpec): boolean {
  return a.v === b.v && a.principal === b.principal && a.alias === b.alias && a.lifecycleUid === b.lifecycleUid &&
    a.managerInstance === b.managerInstance && a.managerProcessUid === b.managerProcessUid && a.retirementOpId === b.retirementOpId &&
    a.broker.kicked === b.broker.kicked && a.broker.remaining === b.broker.remaining &&
    a.broker.scanComplete === b.broker.scanComplete && a.broker.verifiedGone === b.broker.verifiedGone;
}

/** The terminal barrier's verified-eviction step, over the SPEC'S TARGET SET.
 *
 *  SPEC 13.1 scopes it exactly: "cluster-verified eviction of every revoked credential's live
 *  connections", by the `holderPrincipal` "(from its ledger row)". `holders` is that set, returned
 *  by the B1 revoke above.
 *
 *  An EMPTY set is not a skipped eviction — it is the required eviction of nothing. A lifecycle
 *  whose ledger released no credential (a durable slot row whose spawn never reached its mint: a
 *  crashed provision, a pre-3b-2 legacy row, an orphan reconciled at boot) has no `holderPrincipal`
 *  anywhere, and its incarnation-unique actor nkey (F5-bind) never authenticated to the broker at
 *  all, so no connection can exist under it for an oracle to find. Demanding the liveness oracle
 *  there asks it to prove the absence of a principal that was never issued.
 *
 *  Where the set is NON-empty the barrier is unchanged and fail-closed: every holder is
 *  verify-evicted or the lifecycle stays `terminalizing` and the alias stays held. No fallback arm,
 *  no degraded mode, no skip. */
async function evictAndAudit(
  t: LifecycleStateTransport,
  args: { owner: string; alias: string; actor: string; lifecycleUid: string; opId: string; managerInstance: string; managerProcessUid: string },
  holders: readonly string[],
  evict: (principal: string) => Promise<EvictionResult>,
  log: (line: string) => void,
): Promise<void> {
  if (holders.length === 0) {
    log(`no credential-ledger row was ever released under uid ${args.lifecycleUid}; the barrier's eviction set is empty (SPEC 13.1)`);
    return;
  }
  // Every static ledger row of one lifecycle carries that incarnation's own principal (the mint
  // sites record exactly `principalKey(DEV_OWNER, actor)`), so the set is a singleton and the audit
  // record below is one row per lifecycle. A second holder means the ledger disagrees with the
  // incarnation it is keyed under: refuse rather than evict some of a set we cannot audit.
  if (holders.length > 1)
    throw new EpEnvelopeError("internal", `the ledger rows of uid ${args.lifecycleUid} name ${holders.length} holder principals (${holders.join(", ")}); a static lifecycle has exactly one (SPEC 13.1)`);
  const principal = holders[0]!;
  const result = await evict(principal);
  if (!result.verifiedGone || !result.scanComplete || result.remaining !== 0)
    throw new EpEnvelopeError("unavailable", `static retirement could not verify-evict ${principal}; the lifecycle remains terminalizing and the alias stays held (SPEC 13.1)`);
  const key = recordSpecKey(RECORD_KINDS.lifecycle, [args.owner, args.actor, args.lifecycleUid]);
  const spec: StaticLifecycleAuditSpec = {
    v: 1, principal, alias: args.alias, lifecycleUid: args.lifecycleUid, managerInstance: args.managerInstance,
    managerProcessUid: args.managerProcessUid, retirementOpId: args.opId,
    broker: { kicked: result.kicked, remaining: result.remaining, scanComplete: result.scanComplete, verifiedGone: result.verifiedGone },
    timestamp: new Date().toISOString(),
  };
  try { await t.createRecord(key, spec); }
  catch (e) {
    if (!(e instanceof EpEnvelopeError) || e.code !== "conflict") throw e;
    const existing = await t.getRecord(key);
    if (!existing || existing.operation !== "PUT") throw new EpEnvelopeError("failed-precondition", `lifecycle audit ${key} conflict is unreadable`);
    let value: unknown;
    try { value = JSON.parse(new TextDecoder().decode(existing.value)); }
    catch { throw new EpEnvelopeError("failed-precondition", `lifecycle audit ${key} conflict is malformed`); }
    if (!sameAudit(value as StaticLifecycleAuditSpec, spec)) throw new EpEnvelopeError("already-exists", `lifecycle audit ${key} records different evidence`);
    // Timestamp may differ only after the stable manager identities and retirement op prove the same retry.
  }
}

/** The direct-KV transport over the two authority stores, bound per lifecycle OPERATION on an
 *  ephemeral, key-pinned `lifecycle-executor` connection (the manager mints it; see
 *  `withLifecycleExecutor`). Mirrors the auth implementation's sealed `transportOf` — a
 *  transport carries no sequencing decisions of its own. */
export function staticLifecycleTransport(recordsKv: KV, authKv: KV): LifecycleStateTransport {
  const entryOf = (e: { value: Uint8Array; revision: number; operation: string } | null): LifecycleKvEntry | undefined =>
    e === null ? undefined : { value: e.value, revision: e.revision, operation: e.operation };
  return {
    getRecord: async (key) => entryOf(await recordsKv.get(key)),
    createRecord: (key, value) => createRecordEntry(recordsKv, key, value),
    updateRecord: (key, value, rev) => updateRecordEntry(recordsKv, key, value, rev),
    getAuth: async (key) => entryOf(await authKv.get(key)),
    putAuth: (key, payload, rev) => authKv.put(key, payload, { previousSeq: rev }),
  };
}

/** Read one slot row (DEL/PURGE marker = corruption, never absence — supervision state is
 *  CASed over, never deleted). */
export async function readStaticSlot(
  t: LifecycleStateTransport,
  owner: string,
  alias: string,
): Promise<{ row: StaticManagedSlotRow; revision: number } | undefined> {
  const key = staticSlotKey(owner, alias);
  const entry = await t.getRecord(key);
  if (!entry) return undefined;
  if (entry.operation !== "PUT")
    throw new EpEnvelopeError("failed-precondition", `the static slot row ${key} carries a ${entry.operation} marker; a slot row is never deleted (corruption, not absence)`);
  return { row: parseStaticSlotRow(entry.value, key), revision: entry.revision };
}

/** Persist the F3 durable OUTER spawn intent — phase `provisioning`, written BEFORE the head
 *  activation so a crash between them leaves a discoverable coordinate (the boot sweep or the
 *  next same-alias spawn re-drives it). Create-only for a virgin alias; a CAS over the RETIRED
 *  predecessor row for a reused alias; anything else is a live/terminalizing/crashed slot and
 *  REFUSES loudly (the caller resolves it first — resume or terminal, never silent adoption). */
export async function writeStaticSlotIntent(
  t: LifecycleStateTransport,
  row: Omit<StaticManagedSlotRow, "phase" | "credentialIds">,
): Promise<{ revision: number }> {
  const key = staticSlotKey(row.owner, row.alias);
  const intent: StaticManagedSlotRow = { ...row, phase: "provisioning", credentialIds: [] };
  const existing = await readStaticSlot(t, row.owner, row.alias);
  if (existing === undefined) return { revision: await t.createRecord(key, intent) };
  if (existing.row.phase !== "retired")
    throw new EpEnvelopeError(
      "failed-precondition",
      `the static slot for "${row.owner}/${row.alias}" is ${existing.row.phase} at uid ${existing.row.lifecycleUid}; a new spawn intent may only replace a RETIRED slot - resolve the standing slot first (resume its provisioning or drive its terminal)`,
    );
  return { revision: await t.updateRecord(key, intent, existing.revision) };
}

/** CAS a slot row to a new phase/content at its observed revision. */
export async function casStaticSlot(
  t: LifecycleStateTransport,
  row: StaticManagedSlotRow,
  revision: number,
): Promise<number> {
  return t.updateRecord(staticSlotKey(row.owner, row.alias), row, revision);
}

/** Record a credentialId on the slot BEFORE its ledger row is appended and BEFORE the cred is
 *  minted (the crash-safe order: slot record -> ledger row -> mint/write; a credential never
 *  exists without its id recorded and its row appended first). */
export async function recordSlotCredential(
  t: LifecycleStateTransport,
  owner: string,
  alias: string,
  lifecycleUid: string,
  credentialId: string,
): Promise<void> {
  const slot = await readStaticSlot(t, owner, alias);
  if (slot === undefined || slot.row.lifecycleUid !== lifecycleUid)
    throw new EpEnvelopeError("failed-precondition", `the static slot for "${owner}/${alias}" ${slot === undefined ? "does not exist" : `is at uid ${slot.row.lifecycleUid}`}, not uid ${lifecycleUid}; a credential is recorded only on its own incarnation's slot`);
  if (slot.row.phase === "terminalizing" || slot.row.phase === "retired")
    throw new EpEnvelopeError("failed-precondition", `the static slot for "${owner}/${alias}" is ${slot.row.phase}; no credential is minted after terminalizing (F5(b))`);
  if (slot.row.credentialIds.includes(credentialId)) return; // crash-resume idempotence
  await casStaticSlot(t, { ...slot.row, credentialIds: [...slot.row.credentialIds, credentialId] }, slot.revision);
}

/** Append this incarnation's credential-ledger row (`cred.<uid>.<credId>`, state `active`,
 *  lineage `root` — the manager's seed IS the root authority in static mode). Create-only;
 *  an existing SAME row is crash-resume idempotence, anything else refuses. */
export async function appendStaticCredentialRow(
  t: LifecycleStateTransport,
  args: { lifecycleUid: string; credentialId: string; holderPrincipal: string; exp: number },
): Promise<void> {
  const key = credRowKey(args.lifecycleUid, args.credentialId);
  const row: CredentialLedgerRow = {
    credentialId: args.credentialId,
    holderPrincipal: args.holderPrincipal,
    lifecycleUid: args.lifecycleUid,
    sourceChain: [SOURCE_ROOT],
    state: "active",
    exp: args.exp,
  };
  const existing = await t.getAuth(key);
  if (existing !== undefined) {
    if (existing.operation !== "PUT")
      throw new EpEnvelopeError("failed-precondition", `the ledger row ${key} carries a ${existing.operation} marker; a ledger row is never deleted (SPEC 13.12)`);
    const cur = parseLedgerRow(existing.value, key);
    if (cur.holderPrincipal === args.holderPrincipal && cur.state === "active") return; // our own crash-resume
    throw new EpEnvelopeError("already-exists", `the ledger row ${key} already exists (holder ${cur.holderPrincipal}, state ${cur.state}); a credentialId is never re-issued (SPEC 13.1)`);
  }
  await t.putAuth(key, enc.encode(JSON.stringify(row)), 0);
}

/** The static terminal's B1 revoke: CAS every recorded row `active -> revoked`. Enumeration is
 *  the SLOT's recorded credentialIds (recorded before every mint), never a store listing. An
 *  ABSENT row is the legitimate crash window (id recorded, mint never reached) — no credential
 *  exists for it, logged and skipped; a revoked row is idempotence.
 *
 *  RETURNS the barrier's eviction TARGET SET: the distinct `holderPrincipal` of every ledger row
 *  this revoke COVERED — the rows it just CASed AND the already-`revoked` rows a resume walked
 *  over, because a crash between revoke and eviction must never leave a revoked credential's
 *  connection live. An absent row contributes nothing: no credential exists for it. */
export async function revokeStaticCredentialRows(
  t: LifecycleStateTransport,
  lifecycleUid: string,
  credentialIds: readonly string[],
  log: (line: string) => void,
): Promise<string[]> {
  const holders = new Set<string>();
  for (const id of credentialIds) {
    const key = credRowKey(lifecycleUid, id);
    const entry = await t.getAuth(key);
    if (entry === undefined) {
      log(`ledger row ${key} absent at revoke: the id was recorded but its mint never completed (crash window); no credential exists for it`);
      continue;
    }
    if (entry.operation !== "PUT")
      throw new EpEnvelopeError("failed-precondition", `the ledger row ${key} carries a ${entry.operation} marker; a ledger row is never deleted (SPEC 13.12)`);
    const row = parseLedgerRow(entry.value, key);
    holders.add(row.holderPrincipal);
    if (row.state === "revoked") continue;
    await t.putAuth(key, enc.encode(JSON.stringify({ ...row, state: "revoked" })), entry.revision);
  }
  return [...holders].sort();
}

/** The static ACTIVATION: F3 intent FIRST (durable outer spawn intent, phase `provisioning`),
 *  then the SHARED core activation saga at the spawn's uid (reserve -> gate frozen -> head CAS
 *  -> reopen LAST). Returns the slot revision the spawn path later CASes to `active` once the
 *  managed row owns the slot. */
export async function activateStaticLifecycle(
  t: LifecycleStateTransport,
  args: { owner: string; alias: string; actor: string; lifecycleUid: string; managerInstance: string; ownerInstanceId: string },
): Promise<{ slotRevision: number }> {
  const { revision } = await writeStaticSlotIntent(t, {
    owner: args.owner,
    alias: args.alias,
    actor: args.actor,
    lifecycleUid: args.lifecycleUid,
    managerInstance: args.managerInstance,
    ownerInstanceId: args.ownerInstanceId,
  });
  await runActivationSagaAtUid(t, { owner: args.owner, actor: args.actor, lifecycleUid: args.lifecycleUid, managerInstance: args.managerInstance });
  return { slotRevision: revision };
}

/** The static TERMINAL (F1, the (b2) order): freeze-under-the-retirement-op -> head
 *  `active -> retiring` -> B1 ledger revoke -> broker connection eviction -> cleanup (the injected
 *  footprint teardown; on a normal stop the manager separately proves runtime exit) -> gate
 *  `frozen -> retired` -> head `retiring -> retired` LAST -> slot `retired` (the alias frees).
 *  Every gate/head step DELEGATES to the shared core saga; recovery recognizes a SAME-OP
 *  terminal gate and finishes the head (the lost-ack alias wedge the panel closed).
 *
 *  Total over partial durable state: an alias whose activation never reached the saga (slot
 *  `provisioning`, no gate) terminalizes by slot alone; a crashed activation frozen by its own
 *  activation op is terminalized THROUGH that op (gateRetire is op-pinned) — the exact-op static
 *  retirement F3 requires. */
export async function runStaticTerminal(
  t: LifecycleStateTransport,
  args: { owner: string; alias: string; actor: string; lifecycleUid: string; opId: string; managerInstance: string; managerProcessUid: string },
  hooks: { cleanup: () => Promise<void>; evict: (holderPrincipal: string) => Promise<EvictionResult>; log: (line: string) => void },
): Promise<"retired"> {
  const slot = await readStaticSlot(t, args.owner, args.alias);
  if (slot === undefined)
    throw new EpEnvelopeError("failed-precondition", `no static slot exists for "${args.owner}/${args.alias}"; nothing to terminalize`);
  if (slot.row.lifecycleUid !== args.lifecycleUid)
    throw new EpEnvelopeError("failed-precondition", `the static slot for "${args.owner}/${args.alias}" is at uid ${slot.row.lifecycleUid}, not ${args.lifecycleUid}; a terminal never addresses another incarnation (SPEC 13.1)`);
  if (slot.row.phase === "retired") return "retired"; // completed terminal, idempotent
  // Latch the DURABLE terminal intent first: after this CAS the slot can never mint again
  // (recordSlotCredential refuses terminalizing), the exact window the F5 renewal gate needs.
  let slotRevision = slot.revision;
  if (slot.row.phase !== "terminalizing")
    slotRevision = await casStaticSlot(t, { ...slot.row, phase: "terminalizing" }, slot.revision);
  const gate = await gateObserve(t, args.lifecycleUid);
  if (gate === undefined) {
    // Crash before the saga's first durable write (or before gate creation): only the intent
    // (and possibly the burned uid reservation) exists. No head to retire; settle the slot.
    const head = await headCandidate(t, args.owner, args.actor);
    if (head !== undefined && head.mapping.lifecycleUid === args.lifecycleUid)
      throw new EpEnvelopeError("internal", `the head for "${args.owner}/${args.actor}" names uid ${args.lifecycleUid} but its gate does not exist; an active head without a gate is corruption (SPEC 13.1)`);
    const preGateHolders = await revokeStaticCredentialRows(t, args.lifecycleUid, slot.row.credentialIds, hooks.log);
    await evictAndAudit(t, args, preGateHolders, hooks.evict, hooks.log);
    await hooks.cleanup();
    await casStaticSlot(t, { ...slot.row, phase: "retired" }, slotRevision);
    return "retired";
  }
  if (gate.row.state === "frozen" && gate.row.op?.kind === "activation") {
    // A crashed ACTIVATION. Two durable shapes, decided by the head (§13.1: the saga writes the
    // head BEFORE its reopen):
    const head = await headCandidate(t, args.owner, args.actor);
    if (head !== undefined && head.mapping.state === "active" && head.mapping.lifecycleUid === args.lifecycleUid) {
      // The head won; only the reopen is missing. FINISH the activation under ITS OWN op (the
      // shared resume), then retire the now-live lifecycle normally below.
      await resumeActivationSaga(t, { owner: args.owner, actor: args.actor, lifecycleUid: args.lifecycleUid, opId: gate.row.op.opId });
    } else {
      // The head never won: burn the uid THROUGH the activation's own op (op-pinned exact-op
      // static retirement), then settle the slot — there is no head to retire.
      await gateRetire(t, { lifecycleUid: args.lifecycleUid, revision: gate.revision, opId: gate.row.op.opId });
      const lostHeadHolders = await revokeStaticCredentialRows(t, args.lifecycleUid, slot.row.credentialIds, hooks.log);
      await evictAndAudit(t, args, lostHeadHolders, hooks.evict, hooks.log);
      await hooks.cleanup();
      const cur = await readStaticSlot(t, args.owner, args.alias);
      if (cur !== undefined && cur.row.lifecycleUid === args.lifecycleUid && cur.row.phase !== "retired")
        await casStaticSlot(t, { ...cur.row, phase: "retired" }, cur.revision);
      return "retired";
    }
  } else if (gate.row.state === "frozen" && gate.row.op?.kind !== "retirement") {
    throw new EpEnvelopeError("failed-precondition", `the issuance gate for ${args.lifecycleUid} is frozen by a ${gate.row.op?.kind ?? "<unknown>"} (op ${gate.row.op?.opId ?? "<none>"}); a foreign barrier is in flight - refuse (SPEC 13.1)`);
  } else if (gate.row.state === "frozen" && gate.row.op?.opId !== args.opId) {
    throw new EpEnvelopeError("failed-precondition", `the issuance gate for ${args.lifecycleUid} is frozen by retirement op ${gate.row.op?.opId ?? "<none>"}, not ${args.opId}; one retirement at a time (SPEC 13.1)`);
  }
  // Freeze under OUR retirement op if the gate is open (fresh terminal, or the just-finished
  // activation resume). A gate frozen by our op (crash-resume) or already terminal (same-op
  // recovery, verified below) passes through.
  const gAfter = await gateObserve(t, args.lifecycleUid);
  if (gAfter === undefined)
    throw new EpEnvelopeError("internal", `the issuance gate for ${args.lifecycleUid} vanished mid-terminal; a gate is never deleted (SPEC 13.12)`);
  if (gAfter.row.state === "open")
    await gateFreeze(t, { lifecycleUid: args.lifecycleUid, revision: gAfter.revision, op: { opId: args.opId, kind: "retirement" } });
  // Head containment: `active -> retiring` under our op (idempotent for our own crash-resume;
  // a foreign uid or a foreign retiring op refuses inside the shared step).
  const headNow = await headCandidate(t, args.owner, args.actor);
  if (headNow === undefined)
    throw new EpEnvelopeError("internal", `the head for "${args.owner}/${args.actor}" is absent while its gate exists past activation; corruption (SPEC 13.1)`);
  if (headNow.mapping.lifecycleUid !== args.lifecycleUid)
    throw new EpEnvelopeError("failed-precondition", `the head for "${args.owner}/${args.actor}" names uid ${headNow.mapping.lifecycleUid}, not ${args.lifecycleUid}; foreign movement - refuse (SPEC 13.1)`);
  if (headNow.mapping.state !== "retired")
    await headBeginRetirement(t, { owner: args.owner, actor: args.actor, lifecycleUid: args.lifecycleUid, opId: args.opId });
  const holders = await revokeStaticCredentialRows(t, args.lifecycleUid, slot.row.credentialIds, hooks.log);
  // A crash may leave the prior seat process alive after its manager disappeared. Deny-new is
  // durable above; verify the predecessor principal has no live broker connections before cleanup,
  // then before retiring the gate/head and freeing the alias. This does not reap the OS process.
  // Failure leaves the lifecycle terminalizing, so a successor never gains simultaneous broker rails.
  // The set is the ledger's, not a synthesized alias principal (`evictAndAudit`): a lifecycle that
  // released no credential has no seat to contain, and this narration would be a claim about a
  // principal that never existed.
  for (const principal of holders) hooks.log(`verify-evicting orphan seat principal ${principal} before lifecycle cleanup`);
  await evictAndAudit(t, args, holders, hooks.evict, hooks.log);
  for (const principal of holders) hooks.log(`verified orphan seat principal gone: ${principal}`);
  await hooks.cleanup();
  // The terminal tail, in the (b2) order: gate frozen->retired FIRST (retains the opId, the
  // recovery coordinate), head retiring->retired LAST (drops the op; the alias frees only now).
  // gateRetire is called UNCONDITIONALLY: on a frozen gate it terminalizes; on an already-retired
  // gate it is SAME-OP idempotent and refuses a foreign terminal (the op-pin is the verification).
  const gNow = await gateObserve(t, args.lifecycleUid);
  if (gNow === undefined)
    throw new EpEnvelopeError("internal", `the issuance gate for ${args.lifecycleUid} vanished mid-terminal; a gate is never deleted (SPEC 13.12)`);
  await gateRetire(t, { lifecycleUid: args.lifecycleUid, revision: gNow.revision, opId: args.opId });
  const head = await headCandidate(t, args.owner, args.actor);
  if (head !== undefined && head.mapping.lifecycleUid === args.lifecycleUid && head.mapping.state !== "retired")
    await headCompleteRetirement(t, { owner: args.owner, actor: args.actor, lifecycleUid: args.lifecycleUid, opId: args.opId });
  const cur = await readStaticSlot(t, args.owner, args.alias);
  if (cur === undefined)
    throw new EpEnvelopeError("internal", `the static slot for "${args.owner}/${args.alias}" vanished mid-terminal; a slot row is never deleted`);
  if (cur.row.lifecycleUid === args.lifecycleUid && cur.row.phase !== "retired")
    await casStaticSlot(t, { ...cur.row, phase: "retired" }, cur.revision);
  return "retired";
}

/** The boot-sweep resume decision, TOTAL over the phase enum (F3): what the manager must do
 *  with a durable slot it did not adopt from a live inventory. */
export function planStaticSlotResume(row: StaticManagedSlotRow, adopted: boolean): "none" | "drive-terminal" {
  switch (row.phase) {
    case "retired":
      return "none";
    case "provisioning":
    case "terminalizing":
      // A crashed spawn (it never reached managed ownership) or a crashed terminal: both re-drive the
      // exact-op terminal (runStaticTerminal is total over the partial durable states).
      return "drive-terminal";
    case "active":
      // `adopted` is genuine live membership (the manager holds this incarnation as a managed
      // agent). Adopted -> this manager owns the live incarnation, leave it. NOT adopted -> no live
      // managed owner claimed the incarnation (a non-preserving restart, or an orphan the resume did
      // not claim): contain its broker authority and terminalize. The CALLER supplies `adopted` correctly per sweep: a boot sweep with a
      // resume pending DEFERS active slots (adoption has not run yet) rather than passing a false
      // adopted; the post-adoption sweep passes true membership.
      return adopted ? "none" : "drive-terminal";
    default: {
      const never: never = row.phase;
      throw new EpEnvelopeError("internal", `unhandled static slot phase ${String(never)}; the resume table is total by construction (F3)`);
    }
  }
}
