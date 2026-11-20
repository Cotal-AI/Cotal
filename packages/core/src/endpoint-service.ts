/**
 * v0.4 service registry (SPEC §13.7 "Descriptor and describe", §13.5 scatter freeze, §13.9
 * writer table) — the `svc` record kind's value shapes with their consuming-boundary
 * validators, service-name authority enforcement, the mediated registration and epoch-fenced
 * status writes, and the scatter expected-set freeze.
 *
 * Registry entries are DISCOVERY, never authority (§13.9): nothing here grants subscribe or
 * reply authority or scatter membership by itself — the serve credential is the authority, and
 * a foreign credential cannot subscribe a class rail, answer as an instance, or enter a frozen
 * scatter set. The helpers below run inside the trusted writer principals the §13.9 writer
 * table names (`provisioner-registration` for spec, `instance-commit-epoch-fenced` for status).
 */
import type { KV } from "@nats-io/kv";
import type { JetStreamManager } from "@nats-io/jetstream";
import { spacePrefix } from "./subjects.js";
import {
  endpointToken, assertBoundedOwner, assertLifecycleToken,
} from "./endpoint-subjects.js";
import { EpEnvelopeError, EP_NO_LIVE_INSTANCES, lifecycleBlocked, type EpErrorCode, type EpErrorDetail, type EpNoLiveInstancesDetail } from "./endpoint-envelope.js";
import {
  RECORD_KINDS, GOVERN_HEAD, recordSpecKey, recordStatusKey, recordAtomicKey, readRecord, recordsBucket,
  createRecordEntry, updateRecordEntry, deleteRecordEntry, assertStatusValue, decodeRecordJson,
} from "./endpoint-records.js";
import { verifyClusterManifest, verifyClusterRoot, GOVERNED_TRAIT_URNS } from "./endpoint-cluster.js";
import { isSupervisorWrite, type SupervisorWriteGrant } from "./endpoint-supervisor.js";
import { EVICT_PRINCIPALS_MAX } from "./evict.js";
import type { EpRegistrationState } from "./endpoint-verbs.js"; // type-only: the runtime graph stays verbs → service
import { ISSUANCE_GATE_OP_KINDS, type EndpointRepairCursor } from "./lifecycle-state.js";
import { type ServiceSpec, type ServiceStatus, SERVICE_READY, SERVICE_EXITED, SERVICE_ESCALATED, SERVICE_RESTART_HISTORY_FIELD, SERVICE_RETIRED_MARK_FIELD, parseServiceSpec, parseServiceStatus, type ServiceNameAuthority, assertServiceNameAuthority } from "./endpoint-service-spec.js";
import { type EpServeGrant, authorizeServeGrant, type EpGateSuccessor, type EpIssuanceBarrier } from "./endpoint-service-grant.js";
export * from "./endpoint-service-grant.js";
export * from "./endpoint-service-spec.js";

/** The AUTHORITY to originate supervisor-owned state (the restart history, the retirement mark,
 *  the `escalated` state) through {@link writeServiceStatus} — the type only. The MINT lives in
 *  the package-internal `endpoint-supervisor` module (never re-exported), so it is not
 *  ambiently obtainable: possession of a genuine grant proves the write came from a §13.6
 *  supervisor seam, not a scalar flag any caller could set. */
export type { SupervisorWriteGrant };
const wireInt = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
// ---- registration (spec writes, the `provisioner-registration` principal) ---------------------

/** Reconstruct a registered spec's command surface from trusted registry + content-addressed
 *  store state (§13.7): EVERY command name -> the set of governed URNs its verified cluster
 *  document declares (an empty set for an un-governed command; the full command set is needed so
 *  continuity can tell a STRIPPED-but-surviving command from a REMOVED one). The registrar drives
 *  this, so the OWNER never supplies the prior state that continuity compares against - it is read
 *  from the mediated spec + the digest-verified cluster bytes. The governed set is the canonical
 *  {@link GOVERNED_TRAIT_URNS}, pinned STRUCTURALLY - a caller-supplied set was the
 *  subset-narrowing escape (pass guarded-only and a priced imposition is never recorded), the
 *  same class as the required-but-empty policy the panel already rejected. */
async function readGovernedDeclarations(
  readArtifact: (digest: string) => Promise<unknown> | unknown,
  clusterDigests: readonly string[],
): Promise<{ governed: Map<string, Set<string>>; classes: Map<string, string> }> {
  const out = new Map<string, Set<string>>();
  const classes = new Map<string, string>();
  const read = async (digest: string): Promise<unknown> => {
    const raw = await readArtifact(digest);
    if (raw === undefined)
      throw new EpEnvelopeError("failed-precondition", `governed-continuity: cluster artifact ${digest} is not readable; an unverifiable prior/next surface cannot authorize a governance change (SPEC 13.7)`);
    return raw;
  };
  for (const closureDigest of clusterDigests) {
    const { root } = verifyClusterManifest(closureDigest, await read(closureDigest));
    const document = verifyClusterRoot(root, await read(root));
    for (const cmd of document.commands) {
      const set = out.get(cmd.name) ?? new Set<string>();
      for (const t of (cmd.traits ?? [])) if (GOVERNED_TRAIT_URNS.includes(t)) set.add(t);
      // A command name is DECLARED ONCE across the whole closure: a cross-cluster duplicate is
      // an ambiguous surface (serve authorization rejects it later as internal-ambiguous), so
      // registration refuses it up front rather than publishing a surface that cannot serve.
      if (out.has(cmd.name))
        throw new EpEnvelopeError("failed-precondition", `command "${cmd.name}" is declared in more than one cluster of the closure; a duplicate command name is an ambiguous surface (SPEC 13.7)`);
      out.set(cmd.name, set); // present for EVERY command, governed or not
      classes.set(cmd.name, cmd.class);
    }
  }
  return { governed: out, classes };
}

/** Governed-continuity at the mediated registration write (§13.7: removal/downgrade is an
 *  AUTHORIZED contract revision). For every command the NEW spec DECLARES, its governed-trait
 *  set must be a SUPERSET of the endpoint's recorded governance for that command: a
 *  self-published descriptor cannot strip an authority-imposed annotation. A command the new
 *  spec does NOT declare (removed) keeps its recorded governance as a TOMBSTONE (so a later
 *  re-add ungoverned still refuses) but does not itself refuse here; a NEW command and an ADDED
 *  trait are fine.
 *
 *  `prior` is the ENDPOINT-WIDE governance head ({@link readEndpointGovernance}), NOT a single
 *  instance's prior spec: a per-instance head compare is defeated by three launder paths a
 *  history-bearing endpoint record closes — a FRESH instanceId (no prior head of its own), a
 *  REMOVE→RE-ADD across two revisions (the intermediate head carries no governance), and the
 *  optional-policy omission. (The "authority AUTHORIZES stopping governance" path needs the
 *  authority's own consent artifact, the D18 governance-consent record; until then a governed
 *  trait can be lifted by no owner-driven path at all, fail-closed.) */
function assertGovernedDeclarationContinuity(prior: Map<string, Set<string>>, next: Map<string, Set<string>>): void {
  for (const [command, priorTraits] of prior) {
    if (priorTraits.size === 0) continue; // was un-governed - nothing to carry forward
    const nextTraits = next.get(command);
    if (nextTraits === undefined) continue; // the command is not declared by the new spec (removed) - tombstone persists, not a strip
    for (const urn of priorTraits)
      if (!nextTraits.has(urn))
        throw new EpEnvelopeError("permission-denied", `registration drops governed trait "${urn}" from command "${command}", which the endpoint's governance record still imposes; a self-published descriptor cannot strip an authority-imposed annotation via re-registration, a fresh instance, or a remove-then-re-add - land an authority-authorized revision (SPEC 13.7)`);
  }
}

/** The `govern.<endpoint>` value. `commands` is the endpoint's BINDING monotonic governed-trait
 *  imposition per command (sorted URNs for a deterministic form; tombstones survive command
 *  removal). `provisional`, when present, is the endpoint-wide REGISTRATION SLOT: the single
 *  in-flight registration's identity plus the governed declarations it will PROMOTE to binding
 *  once its spec publish commits. The slot is what makes the head the endpoint's registration
 *  linearization point (§13.7): EVERY registration - governed and ungoverned alike - must
 *  CAS-take it under its frozen gate and holds it through spec publication, so no registration
 *  can decide against one governance state and publish under another (the cross-instance
 *  `changed:false` reader race), and no imposition becomes binding for a descriptor that never
 *  published (the phantom-obligation orphan). Absent head = no registration has ever completed
 *  and nothing is in flight. */
interface EndpointGovernance {
  commands: Record<string, string[]>;
  provisional?: { instanceId: string; generation: number; commands: Record<string, string[]> };
}

interface ParsedEndpointGovernance {
  commands: Map<string, Set<string>>;
  provisional: { instanceId: string; generation: number; commands: Map<string, Set<string>> } | null;
}

function parseGovernanceCommands(commands: unknown, key: string, what: string): Map<string, Set<string>> {
  if (commands === null || typeof commands !== "object" || Array.isArray(commands))
    throw new EpEnvelopeError("internal", `the endpoint governance head ${key} has a non-object ${what} map; garbled mediated governance state never authorizes (SPEC 13.7)`);
  const out = new Map<string, Set<string>>();
  for (const [command, urns] of Object.entries(commands as Record<string, unknown>)) {
    if (!Array.isArray(urns) || !urns.every((u) => typeof u === "string" && u.length > 0))
      throw new EpEnvelopeError("internal", `the endpoint governance head ${key} maps ${what} command "${command}" to a non-string-array; garbled state never authorizes (SPEC 13.7)`);
    out.set(command, new Set(urns as string[]));
  }
  return out;
}

function parseEndpointGovernance(raw: unknown, key: string): ParsedEndpointGovernance {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw) || !("commands" in raw))
    throw new EpEnvelopeError("internal", `the endpoint governance head ${key} is not a { commands } record; garbled mediated governance state never authorizes (SPEC 13.7)`);
  const commands = parseGovernanceCommands((raw as { commands: unknown }).commands, key, "binding");
  const p = (raw as { provisional?: unknown }).provisional;
  if (p === undefined) return { commands, provisional: null };
  if (p === null || typeof p !== "object" || Array.isArray(p))
    throw new EpEnvelopeError("internal", `the endpoint governance head ${key} has a non-object provisional slot; garbled state never authorizes (SPEC 13.7)`);
  const slot = p as { instanceId?: unknown; generation?: unknown; commands?: unknown };
  if (typeof slot.instanceId !== "string" || slot.instanceId.length === 0)
    throw new EpEnvelopeError("internal", `the endpoint governance head ${key} provisional slot has no holder instanceId; garbled state never authorizes (SPEC 13.7)`);
  if (typeof slot.generation !== "number" || !Number.isSafeInteger(slot.generation) || slot.generation < 0)
    throw new EpEnvelopeError("internal", `the endpoint governance head ${key} provisional slot has a non-integer generation; garbled state never authorizes (SPEC 13.7)`);
  return {
    commands,
    provisional: { instanceId: slot.instanceId, generation: slot.generation, commands: parseGovernanceCommands(slot.commands, key, "provisional") },
  };
}

/** Read the endpoint-wide governance head fresh under the frozen gate (a KV get, not a fence -
 *  the fence is the slot-take CAS that follows): binding impositions + the in-flight provisional
 *  slot, plus the store `revision` the slot-take must CAS against (`null` = the head does not
 *  exist yet). Fail-closed on anything but a clean read: a garbled head is `internal`, and a
 *  DEL/PURGE marker is REFUSED, never treated as a virgin head - the KV client's get() returns
 *  deletion markers and its create() recreates over them, so mapping non-PUT to "no history"
 *  would let whoever can delete the key erase every tombstone and register a stripped surface
 *  against a reset record. Only TRUE ABSENCE is virgin; a deletion marker on a monotonic
 *  history-bearing authority record is tampering or a storage fault to reconcile, never
 *  authorization to forget (SPEC 13.7). */
async function readEndpointGovernance(kv: KV, endpoint: string): Promise<ParsedEndpointGovernance & { revision: number | null }> {
  const key = recordAtomicKey(GOVERN_HEAD, [endpoint]);
  const entry = await kv.get(key);
  if (!entry) return { commands: new Map(), provisional: null, revision: null };
  if (entry.operation !== "PUT")
    throw new EpEnvelopeError("failed-precondition", `the endpoint governance head ${key} carries a ${entry.operation} marker; a monotonic history-bearing record is never deleted, so this is tampering or a storage fault - reconcile the head before registering, a deletion never resets governance history (SPEC 13.7)`);
  return { ...parseEndpointGovernance(decodeRecordJson(entry.value, key), key), revision: entry.revision };
}

/** Union the new spec's governed declarations into the binding governance (monotonic: a governed
 *  trait is only ever ADDED, never dropped; un-governed commands are not recorded). This is the
 *  PROMOTE content - written only after the spec publish commits. */
function mergeEndpointGovernance(prior: Map<string, Set<string>>, next: Map<string, Set<string>>): Map<string, Set<string>> {
  const merged = new Map<string, Set<string>>();
  for (const [command, urns] of prior) merged.set(command, new Set(urns));
  for (const [command, urns] of next) {
    if (urns.size === 0) continue; // un-governed commands are not recorded (only impositions)
    const into = merged.get(command) ?? new Set<string>();
    for (const urn of urns) into.add(urn);
    merged.set(command, into);
  }
  return merged;
}

function serializeGovernanceCommands(commands: Map<string, Set<string>>): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [command, urns] of commands) if (urns.size > 0) out[command] = [...urns].sort();
  return out;
}

/** Register (or re-register) a service instance: authenticated-registrant binding, name
 *  authority, then the spec-key CAS. The returned `registrationRevision` is the spec key's
 *  store revision (§13.7) — a re-registration advances it, which is exactly what invalidates a
 *  frozen scatter slot (§13.5 `churn`). The returned `processEpoch` is the one its completing
 *  reopen committed, never a later read of the gate, which a successor registration may already
 *  have advanced. A concurrent registration race is a loud `conflict` (§13.8: re-read and
 *  re-decide).
 *
 *  `registrant` is the BROKER-AUTHENTICATED caller of the registration request (its subject
 *  principal, §13.9 — never a payload claim): the descriptor owner must BE that caller, so a
 *  privileged owner's descriptor cannot be registered by anyone else, and a re-registration can
 *  never change an instance's ownership. `instanceId` MUST be provisioner-minted and never
 *  reused (§13.1); the allocator that enforces non-reuse is the lifecycle registry (D13) — this
 *  seam enforces what is checkable at the record: grammar, ownership stability, and CAS.
 *
 *  ISSUANCE-GATE BARRIER (§13.1). A registration is a WRITER on the instance's issuance gate: to
 *  be linearizable against an in-flight serve mint it MUST run the barrier protocol on the SAME
 *  `gate.<lifecycleUid>` key, in order: freeze the gate (so a fresh mint observes `frozen` and
 *  refuses, and a staged-but-uncommitted mint loses its revision-pinned CAS), authorize the owner
 *  under the frozen gate, revoke + VERIFIED-evict the superseded credential family, THEN advance
 *  the spec, then reopen at the successor `registrationRevision`. Old authority dies before new
 *  authority is published. This is REQUIRED, not documented: core exports no bare spec-key advance
 *  that could leave a mint's observed `registrationRevision` permanently equal to its snapshot,
 *  win a never-frozen CAS, and silently release a superseded-surface credential. The gate is
 *  created by the provisioner at instance mint (D13); a missing gate is `failed-precondition`. The
 *  production `barrier` wires to the durable KV CAS (D13/D14); the D4 seam is the typed protocol
 *  and its faithful in-memory model, so the barrier's writes serialize with the mint's on one key. */
export async function registerServiceInstance(
  kv: KV,
  args: {
    space: string; spec: ServiceSpec; instanceId: string; registrant: { owner: string }; authority: ServiceNameAuthority; barrier: EpIssuanceBarrier;
    /** Content-store reader for the spec's cluster digests, REQUIRED (§13.7): governed
     *  continuity is not an optional seam. It is the ONLY policy input - the governed set
     *  itself is pinned internally to the canonical {@link GOVERNED_TRAIT_URNS} (the same
     *  constant feeding serve-side enforcement), never a caller-supplied list: a tunable set
     *  was the subset-narrowing escape (guarded-only wiring silently un-tracks priced), the
     *  `previous:null` class one notch smaller. */
    readClusterArtifact: (digest: string) => Promise<unknown> | unknown;
    /** OPTIONAL observation seam for a FOREIGN instance's issuance-gate generation, consulted only
     *  when another instance holds the endpoint's provisional governance slot (§13.7). It is a READ,
     *  never a freeze, and it mirrors {@link deregisterServiceInstance}'s `observeGeneration`: core
     *  holds this instance's own barrier and the RECORDS store, so it has no handle that reaches a
     *  foreign `epgate` row, and a caller wires it with a credential already scoped for that read.
     *  ABSENT = today's unconditional refusal, so no caller silently gains a reclaim it did not ask
     *  for. See the orphan predicate at the slot-take below. */
    observeHolderGeneration?: (holderInstanceId: string) => Promise<number> | number;
  },
): Promise<{ registrationRevision: number; processEpoch: number }> {
  if (typeof args.readClusterArtifact !== "function")
    throw new EpEnvelopeError("failed-precondition", "registerServiceInstance requires a content-store reader (readClusterArtifact); governed-continuity is not an optional seam (SPEC 13.7)");
  spacePrefix(args.space); // up-front boundary guard on the space arg (mirrors authorizeServeGrant): usable as a subject token, throws on an absent/non-string space at an untyped caller. This is NOT the cross-space authority fence - that is the observed-gate `(space, endpoint, instanceId)` identity check below (trusted-context equality against the per-space KV bucket).
  const spec = parseServiceSpec(args.spec, { endpoint: args.spec.endpoint });
  assertBoundedOwner(args.registrant.owner, "registrant owner");
  if (args.registrant.owner !== spec.owner)
    throw new EpEnvelopeError("permission-denied", `the registration's authenticated caller "${args.registrant.owner}" is not the descriptor owner "${spec.owner}" (SPEC 13.9: authenticated caller binding, never a payload claim)`);
  // The NAME-AUTHORITY decision is deferred until UNDER the frozen gate (phase 1): a transfer must
  // freeze this same gate, so authorizing while we hold the freeze serializes the decision with the
  // transfer — checking here (pre-freeze) would repeat the torn owner-vs-revision read the atomic
  // authorize() closed for authorizeServeGrant.
  const key = recordSpecKey(RECORD_KINDS.svc, [spec.endpoint, assertLifecycleToken(args.instanceId, "instanceId")]);

  // §13.1 barrier: freeze the instance's gate FIRST so no serve mint can win against the surface
  // this registration is about to supersede. A non-open gate or a lost freeze is another barrier
  // holding the key — a loud `conflict` (§13.8: re-read and re-decide), never a bare write.
  const obs = await args.barrier.observe();
  if (obs === null)
    throw new EpEnvelopeError("failed-precondition", `no issuance gate for instance "${args.instanceId}"; a registration writes only behind the provisioner-created gate (SPEC 13.1)`);
  if (obs.space !== args.space || obs.endpoint !== spec.endpoint || obs.lifecycleUid !== args.instanceId)
    throw new EpEnvelopeError("internal", `the issuance gate is for "${obs.space}/${obs.endpoint}/${obs.lifecycleUid}", not "${args.space}/${spec.endpoint}/${args.instanceId}"; a registration drives only its OWN instance's gate, and the instance token is unique only within (space, endpoint) (SPEC 13.1)`);
  if (obs.state === "retired")
    throw lifecycleBlocked("failed-precondition", `the issuance gate for "${args.instanceId}" is retired; the lifecycle is permanently closed and its id is never reused, so a re-read cannot help (SPEC 13.1)`, {
      blockedOp: obs.op.kind === "activation" ? "activation" : "retirement",
      gateState: "retired",
      opId: obs.op.opId,
    });
  const resuming = obs.state === "frozen"
    && obs.op.kind === "registration"
    && args.barrier.operationId !== undefined
    && obs.op.opId === args.barrier.operationId;
  if (obs.state !== "open" && !resuming) {
    if (typeof obs.op?.opId !== "string" || !ISSUANCE_GATE_OP_KINDS.has(obs.op.kind))
      throw new EpEnvelopeError("internal", `the issuance gate for "${args.instanceId}" is frozen without a valid op intent; a frozen gate is op-bound (SPEC 13.1)`);
    throw lifecycleBlocked("conflict", `the issuance gate for "${args.instanceId}" is ${obs.state}; another barrier holds it; if the holder is a dead predecessor, run: \`cotal reconcile-gate\` (SPEC 13.8)`, {
      blockedOp: obs.op.kind,
      gateState: "frozen",
      opId: obs.op.opId,
      remedy: "cotal reconcile-gate",
    });
  }
  const token = resuming ? obs.revision : await args.barrier.freeze(obs.revision);
  if (token === null)
    throw new EpEnvelopeError("conflict", `a concurrent barrier froze the issuance gate for "${args.instanceId}" first; re-read and re-decide (SPEC 13.1/13.8)`);

  if (obs.authorityFamily === "service") {
    if (obs.serviceAuthority?.activationIssued || (await args.barrier.enumerate()).length !== 0)
      throw new EpEnvelopeError("failed-precondition", "unexpected service issuance evidence before activation; registration remains frozen");
  }

  // The gate is frozen; every exit below reopens it (token-pinned, at the original coordinate) or
  // deliberately leaves it FROZEN for reconciliation. The successor the completing reopen targets.
  // `processEpoch` defaults to the frozen gate's epoch (an ABORT reopens the UNCHANGED coordinate);
  // only a completing reopen advances it ({@link successorProcessEpoch}).
  const successorAt = (registrationRevision: number, processEpoch: number = obs.processEpoch): EpGateSuccessor => ({
    generation: obs.generation + 1, processEpoch, registrationRevision, nameAuthorityRevision: obs.nameAuthorityRevision,
  });

  // A fresh executor may be resuming after the Phase-3 publish committed but the old connection
  // died before its read-back or reopen. Finish that SAME frozen operation before repeating any
  // family work or writing the spec again. The held governance slot plus the unchanged gate/op
  // coordinate makes the advanced spec revision attributable to this operation.
  if (resuming) {
    const finished = await completeFrozenRegistrationFromSpec(kv, {
      endpoint: spec.endpoint,
      instanceId: args.instanceId,
      barrier: args.barrier,
      freezeToken: token,
      gate: {
        generation: obs.generation,
        processEpoch: obs.processEpoch,
        registrationRevision: obs.registrationRevision,
        nameAuthorityRevision: obs.nameAuthorityRevision,
      },
    });
    if (finished.completed) {
      // The reopen has committed, so a later registration may already have frozen the gate and
      // saved its own cursor. Clear only the cursor this freeze saved.
      try {
        const stored = await args.barrier.progress?.load();
        if (stored && stored.cursor.opId === args.barrier.operationId && stored.cursor.freezeToken === token)
          await args.barrier.progress?.clear(stored.revision);
      } catch { /* the gate is open; stale progress is freeze-bound and safe to retain */ }
      return { registrationRevision: finished.registrationRevision, processEpoch: finished.processEpoch };
    }
    if (finished.raced)
      throw new EpEnvelopeError("unavailable", `the reopen of the issuance gate for "${args.instanceId}" lost its freeze token (a reconciler or newer barrier superseded this one); re-read and re-decide (SPEC 13.1)`);
  }

  // PHASE 1 — authorize UNDER the frozen gate, then ownership stability. Both are authority /
  // local reads with NO write side-effect, so any failure (owner not authorized, name-authority
  // drift, a garbled stored spec, an ownership change) is a DEFINITE no-write and no revoke has
  // run → reopen the ORIGINAL coordinate and rethrow.
  //  - the name-authority decision is made HERE (holding the freeze), and the authorized revision
  //    MUST equal the frozen gate's `nameAuthorityRevision`: a transfer that raced would have to
  //    freeze this same gate (it can't) or would leave the gate at a different coordinate, so a
  //    mismatch is a raced transfer — a loud `conflict`, never a stale-owner registration.
  let current: Awaited<ReturnType<KV["get"]>>;
  const govKey = recordAtomicKey(GOVERN_HEAD, [spec.endpoint]);
  try {
    const authorizedNameRevision = await assertServiceNameAuthority(spec.endpoint, spec.owner, args.authority);
    if (authorizedNameRevision !== obs.nameAuthorityRevision)
      throw new EpEnvelopeError("conflict", `a name-authority transfer raced this registration: owner "${spec.owner}" is authorized at nameAuthorityRevision ${authorizedNameRevision} but the frozen gate is at ${obs.nameAuthorityRevision}; re-read and re-decide (SPEC 13.9)`);
    current = await kv.get(key);
    if (current && current.operation === "PUT") {
      const stored = parseServiceSpec(decodeRecordJson(current.value, key), { endpoint: spec.endpoint });
      if (stored.owner !== spec.owner)
        throw new EpEnvelopeError("permission-denied", `instance "${args.instanceId}" is registered to owner "${stored.owner}"; a re-registration can never change ownership (SPEC 13.1: instance ids are never reused across identities)`);
    }
    // §13.7 ENDPOINT-WIDE governed-continuity, run on EVERY registration (a first registration
    // included — that is where a fresh-instance strip is caught). The governance head is BOTH the
    // history-bearing imposition record AND the endpoint's registration linearization point:
    //  - read it fresh under the frozen gate; refuse if a FOREIGN registration holds its
    //    provisional slot (`conflict`, re-read and re-decide — per-instance gates do not mutually
    //    exclude across instances, the slot does);
    //  - validate the new spec's digest-verified declarations against the BINDING impositions
    //    (fresh-instance, remove→re-add, and stripped-but-surviving all refuse here);
    //  - CAS-TAKE the slot — every registration takes it, an ungoverned/`changed:false` one
    //    included, or a pure head READER could decide against one governance state and publish
    //    under another (the cross-instance launder). The slot is stamped with this gate's frozen
    //    `generation`; it is HELD through the spec publish AND the Phase-4 reopen, and PROMOTED
    //    to binding after the publish commits (the slot is released only after reopen). No
    //    imposition ever binds for a descriptor that never published (the phantom-obligation
    //    orphan) and neither a concurrent publish nor a concurrent deregister of this instance
    //    slips past the hold.
    // Every failure in this block is a DEFINITE no-spec-write, so the outer catch reopens the
    // ORIGINAL coordinate: a slot-take CAS loss is a raced endpoint registration (`conflict`);
    // an AMBIGUOUS slot-take is also safe to reopen because a committed-but-unacked slot is
    // stamped with the generation this reopen advances PAST — the stale stamp marks it orphaned,
    // this instance's own retry replaces it, and a foreign registration reclaims it once it can
    // OBSERVE that stamp to be behind the holder's live gate ({@link assertForeignSlotIsOrphaned};
    // fail-closed without that observation).
    const gov = await readEndpointGovernance(kv, spec.endpoint);
    let holdsSlot = false;
    if (gov.provisional) {
      if (resuming) {
        if (gov.provisional.instanceId !== args.instanceId || gov.provisional.generation !== obs.generation)
          throw new EpEnvelopeError("unavailable", `the resumed registration no longer holds endpoint "${spec.endpoint}" governance at generation ${obs.generation}; the gate stays frozen for reconciliation (SPEC 13.7/13.1)`);
        holdsSlot = true;
      } else if (gov.provisional.instanceId !== args.instanceId)
        await assertForeignSlotIsOrphaned(gov.provisional, spec.endpoint, args.observeHolderGeneration);
      else if (gov.provisional.generation >= obs.generation)
        throw new EpEnvelopeError("internal", `the governance slot for endpoint "${spec.endpoint}" is held by this very instance at generation ${gov.provisional.generation} while its gate is frozen at ${obs.generation}; a live slot under a re-frozen gate cannot exist (every retry freezes at an advanced generation); reconcile the head before registering (SPEC 13.7)`);
      // else: this instance's OWN orphan from an aborted earlier attempt (the gate has reopened
      // past its stamp since) — the slot-take below replaces it.
    }
    const { governed: next, classes } = await readGovernedDeclarations(args.readClusterArtifact, spec.clusterDigests);
    // §13.6: a VIRTUAL endpoint's commands MUST be journal-class — an ephemeral call to an
    // endpoint with no live instance is an honest `unavailable`, so registering an on-demand
    // activation policy over an ephemeral command would advertise a surface that cannot exist.
    if (spec.activation !== undefined) {
      for (const [name, cls] of classes) {
        if (cls !== "journal")
          throw new EpEnvelopeError("failed-precondition", `endpoint "${spec.endpoint}" registers on-demand activation but declares the ${cls}-class command "${name}"; a virtual endpoint's commands MUST be journal-class (SPEC 13.6)`);
      }
    }
    assertGovernedDeclarationContinuity(gov.commands, next);
    const slotValue: EndpointGovernance = {
      commands: serializeGovernanceCommands(gov.commands),
      provisional: { instanceId: args.instanceId, generation: obs.generation, commands: serializeGovernanceCommands(next) },
    };
    try {
      if (!holdsSlot) {
        if (gov.revision === null) await createRecordEntry(kv, govKey, slotValue);
        else await updateRecordEntry(kv, govKey, slotValue, gov.revision);
      }
    } catch (e) {
      // createRecordEntry/updateRecordEntry translate the broker CAS loss (err_code 10071/10164)
      // into EpEnvelopeError("conflict") — classify on THAT, the numeric code never reaches here.
      if (e instanceof EpEnvelopeError && e.code === "conflict")
        throw new EpEnvelopeError("conflict", `a concurrent registration for endpoint "${spec.endpoint}" took the governance slot first (a definite no-write CAS loss); re-read and re-decide (SPEC 13.7/13.8)`);
      throw new EpEnvelopeError("unavailable", `the governance slot-take for endpoint "${spec.endpoint}" is ambiguous; the registration aborts before any spec write and the gate reopens; a committed-but-unacked slot self-orphans at the reopened generation and this instance's retry replaces it (SPEC 13.7): ${(e as Error)?.message ?? String(e)}`);
    }
  } catch (err) {
    // A resumed freeze may already have revoked part of the old family. Never abort-reopen that
    // coordinate on a repeated Phase-1 read failure. The durable operation remains frozen and can
    // be retried with fresh authority or reconciled.
    if (!resuming) await reopenGateAfterAbort(args.barrier, token, successorAt(obs.registrationRevision), err);
    throw err;
  }

  // PHASE 2 — revoke + VERIFIED eviction of the superseded family BEFORE publishing the new spec
  // (§13.1 order: old authority must die before new authority is visible). Fail-closed: if any
  // revoke/eviction cannot be verified, leave the gate FROZEN for reconciliation — never reopen,
  // or old credentials could come back to life against a pending re-registration.
  //  - revoke every ACTIVE row (an already-`revoked` row was flipped by an earlier barrier);
  //  - but verified-evict the distinct holder principals of the ENTIRE enumerated family: an
  //    already-revoked row from a PARTIALLY FAILED prior barrier may still have a live connection
  //    that was never verified gone, so eviction must not skip it (§13.1).
  let progressRevision: number | null = null;
  try {
    const family = await args.barrier.enumerate();
    // Independent row CASes overlap so historical renewals do not cost two serial round trips
    // apiece. Drain the whole bounded batch, including synchronous throws, before any refusal
    // or eviction. A failed batch leaves completed revocations durable and the gate frozen.
    const active = family.filter((row) => row.state === "active");
    let revoked = family.length - active.length;
    args.barrier.onRevocationProgress?.({ revoked, total: family.length });
    const revokeConcurrency = 16;
    for (let i = 0; i < active.length; i += revokeConcurrency) {
      const results = await Promise.allSettled(active.slice(i, i + revokeConcurrency).map(async (row) => args.barrier.revoke(row)));
      for (const result of results) if (result.status === "rejected") throw result.reason;
      revoked += results.length;
      args.barrier.onRevocationProgress?.({ revoked, total: family.length });
    }
    const holders = [...new Set(family.map((row) => row.holderPrincipal))].sort();
    const opId = args.barrier.operationId ?? obs.op?.opId;
    let progress: EndpointRepairCursor | undefined;
    if (args.barrier.progress && opId) {
      progress = { v: 1, opId, freezeToken: token, holders, verified: [] };
      const stored = await args.barrier.progress.load();
      if (
        stored
        && stored.cursor.opId === progress.opId
        && stored.cursor.freezeToken === progress.freezeToken
        && stored.cursor.holders.length === holders.length
        && stored.cursor.holders.every((h, i) => h === holders[i])
      ) {
        progress = stored.cursor;
        progressRevision = stored.revision;
      } else {
        progressRevision = await args.barrier.progress.save(progress, stored?.revision ?? null);
      }
    }
    const verified = new Set(progress?.verified ?? []);
    const pending = holders.filter((h) => !verified.has(h));
    // Each bounded sweep is recorded before the next starts, so a family whose sweeps outlast one
    // registration executor still advances, and a refused later sweep keeps the earlier verdicts.
    for (let i = 0; i < pending.length; i += EVICT_PRINCIPALS_MAX) {
      const sweep = pending.slice(i, i + EVICT_PRINCIPALS_MAX);
      const gone = await args.barrier.evict(sweep);
      if (gone.length !== sweep.length)
        throw new Error(`the evictor answered ${gone.length} verdict(s) for ${sweep.length} holder(s)`);
      const evicted = sweep.filter((_, j) => gone[j] === true);
      if (args.barrier.progress && progress && evicted.length > 0) {
        progress = { ...progress, verified: [...progress.verified, ...evicted].sort() };
        progressRevision = await args.barrier.progress.save(progress, progressRevision);
      }
      const unverified = sweep.filter((_, j) => gone[j] !== true);
      if (unverified.length > 0)
        throw new Error(`principal(s) ${unverified.map((h) => `"${h}"`).join(", ")} not verified evicted`);
    }
  } catch (err) {
    throw new EpEnvelopeError("unavailable", `re-registration could not revoke + verify-evict the superseded serve family; the gate is left frozen for reconciliation, no new spec published (SPEC 13.1): ${(err as Error)?.message ?? String(err)}`);
  }

  // PHASE 3 — publish the new spec. A write error is infra/ambiguous under this freeze (this
  // registration holds the endpoint governance slot, and {@link deregisterServiceInstance}
  // refuses a spec delete while that slot names this instance at the live gate generation),
  // so we never reopen the OLD coordinate: that would release stale-surface credentials
  // against a spec that may have advanced. A lost ack is
  // recoverable to a fact by reading the spec key back. Matching proposed bytes at a successor
  // revision means THIS write committed, and we continue Phase 3b/4 for the same freeze. A
  // no-commit or unreadable read stays frozen (#1243).
  let newRev: number;
  try {
    // A DEREGISTRATION TOMBSTONE IS RE-REGISTRABLE, and it is the only record kind here that is.
    // `createRecordEntry` fences against the key's entire history, so a create over a DEL marker is
    // a loud conflict — correct for the never-deleted lifecycle families, and fatal here: §13.5
    // makes a deleted spec an EXPLICIT deregistration ({@link deregisterServiceInstance}), so a
    // manager that deregisters on a clean stop could never start again. The tombstone is therefore
    // written OVER, revision-pinned to the marker's own revision, which is still a CAS and still
    // refuses a blind write.
    //
    // Reusing the id is safe because the records key was never what bound it: §13.1 binds the
    // lifecycle to the ISSUANCE GATE, which this registration has already observed (a `retired`
    // gate refuses above, and the gate's principal binding is unchanged by a records delete), and
    // the (name, owner) pair is authorized fresh under the frozen gate. What a tombstone loses is
    // the stored-owner comparison two branches up — it has no value to compare — and that check is
    // a defence-in-depth read of the same fact the name authority decides.
    newRev = current
      ? await updateRecordEntry(kv, key, spec, current.revision)
      : await createRecordEntry(kv, key, spec);
  } catch (err) {
    newRev = await recoverCommittedSpecWrite(kv, key, spec, current, err);
  }

  // PHASE 3b — PROMOTE the governance slot to binding, now that the spec publish committed: the
  // held provisional impositions merge into the binding map and the SAME slot is RETAINED
  // (instanceId + frozen generation). Clearing it here would let a concurrent deregister
  // delete the just-published spec before Phase 4 reopens, and the reopen would then adopt a
  // DEL. The slot is the exclusion: {@link deregisterServiceInstance} refuses while it names
  // this instance at the live gate generation. Only HERE does an imposition become permanent,
  // so a registration that failed in PHASE 2/3 never binds governance for a descriptor that
  // never published (the phantom-obligation orphan), and the slot's hold from decision through
  // reopen is what serializes every concurrent registration of this endpoint AND a concurrent
  // deregister of this instance. Nothing else can have CAS'd the head while we held the slot
  // (a foreign registration refuses on it), so ANY failure — a lost ack, or a CAS loss to a
  // reconciler that stole the slot — leaves the gate FROZEN for reconciliation, consistent
  // with PHASE 3: the spec is published, so reopening without the promote would activate a
  // surface whose imposition never bound. The promote is idempotent for the reconciler
  // (re-CAS the same merge, still holding the slot).
  try {
    await promoteHeldGovernance(kv, spec.endpoint, args.instanceId, obs.generation);
  } catch (err) {
    throw new EpEnvelopeError("unavailable", `the spec for "${args.instanceId}" is published at revision ${newRev} but the governance promote did not complete; the gate is left frozen for reconciliation (the promote is an idempotent re-CAS of the held slot to binding, SPEC 13.7/13.1): ${(err as Error)?.message ?? String(err)}`);
  }

  // PHASE 4 — reopen at the successor, TOKEN-pinned: only this barrier (still holding its freeze)
  // may reopen; a lost CAS means a reconciler/newer barrier superseded us and moved the gate.
  const processEpoch = successorProcessEpoch(obs);
  let reopened: boolean;
  try {
    reopened = await args.barrier.reopen(token, successorAt(newRev, processEpoch));
  } catch (err) {
    throw new EpEnvelopeError("unavailable", `re-registration wrote the spec at revision ${newRev} but the reopen's outcome is unknown: it may have committed, or the gate is still frozen for reconciliation; re-read the gate before retrying (SPEC 13.1): ${(err as Error)?.message ?? String(err)}`);
  }
  if (!reopened)
    throw new EpEnvelopeError("unavailable", `re-registration wrote the spec at revision ${newRev} but the reopen lost its freeze token (a reconciler or newer barrier superseded this one), so this registration reopened nothing; re-read the gate and re-decide (SPEC 13.1)`);
  await releaseHeldGovernance(kv, spec.endpoint, args.instanceId, obs.generation);
  if (args.barrier.progress && progressRevision !== null) {
    try { await args.barrier.progress.clear(progressRevision); }
    catch { /* gate is already open; a stale freeze-bound cursor is safe to retain */ }
  }
  return { registrationRevision: newRev, processEpoch };
}

/** Register an instance that serves: {@link registerServiceInstance}, then its serve grant
 *  ({@link authorizeServeGrant}) and its converged `ready` status ({@link writeServiceStatus}) at
 *  the `processEpoch` and `registrationRevision` that registration committed (§13.1, §13.5, §13.9).
 *  A gate read after the reopen can already show a successor's epoch, so the gate only fences the
 *  grant and the status: a successor makes them refuse rather than serve at its epoch. */
export async function registerServingInstance(
  kv: KV,
  args: Parameters<typeof registerServiceInstance>[1] & {
    /** Fields the `ready` status carries beside the coordinates this registration fixes. */
    status?: Record<string, unknown> & { state?: never; epoch?: never; observedSpecRevision?: never };
  },
): Promise<{ registrationRevision: number; processEpoch: number; grant: EpServeGrant }> {
  const { registrationRevision, processEpoch } = await registerServiceInstance(kv, args);
  const { endpoint } = args.spec;
  const readProcessEpoch = async (): Promise<number> => {
    const gate = await args.barrier.observe();
    if (gate === null)
      throw new EpEnvelopeError("failed-precondition", `no issuance gate for "${endpoint}/${args.instanceId}" after its registration; a gate is never deleted (SPEC 13.12)`);
    return gate.processEpoch;
  };
  const grant = await authorizeServeGrant(kv, {
    space: args.space, endpoint, instanceId: args.instanceId, epoch: processEpoch, holder: args.registrant,
    authority: args.authority, readClusterArtifact: args.readClusterArtifact, readProcessEpoch,
  });
  await writeServiceStatus(kv, {
    endpoint, instanceId: args.instanceId, epoch: processEpoch,
    status: { ...args.status, state: SERVICE_READY, epoch: processEpoch, observedSpecRevision: registrationRevision },
    readProcessEpoch,
  });
  return { registrationRevision, processEpoch, grant };
}

/** Classify a lost spec-write ack. Sole writer under the freeze: proposed bytes at a revision
 *  past the pre-write snapshot means this write committed. Anything else stays frozen. */
async function recoverCommittedSpecWrite(
  kv: KV,
  key: string,
  proposed: unknown,
  prior: Awaited<ReturnType<KV["get"]>>,
  cause: unknown,
): Promise<number> {
  const fail = (extra: string): never => {
    throw new EpEnvelopeError(
      "unavailable",
      `the re-registration spec-write outcome is ambiguous (it may have committed); the gate is left frozen for reconciliation, never reopened at the old coordinate (SPEC 13.1): ${(cause as Error)?.message ?? String(cause)}${extra}`,
    );
  };
  let again: Awaited<ReturnType<KV["get"]>>;
  try {
    again = await kv.get(key);
  } catch (e) {
    return fail(`; spec read-back failed: ${(e as Error)?.message ?? String(e)}`);
  }
  if (!again || again.operation !== "PUT") return fail("; spec read-back shows the write did not commit");
  if (prior && again.revision === prior.revision) return fail("; spec read-back shows the write did not commit");
  let got: unknown;
  try {
    got = decodeRecordJson(again.value, key);
  } catch (e) {
    return fail(`; spec read-back is garbled: ${(e as Error)?.message ?? String(e)}`);
  }
  if (JSON.stringify(got) !== JSON.stringify(proposed)) return fail("; spec read-back does not match the proposed registration");
  return again.revision;
}

/** The `processEpoch` a completing registration reopen commits (SPEC 13.6 item 7,
 *  13.7). A RE-registration is a restarted/superseded incarnation of the SAME instanceId, so it
 *  advances the epoch and the successor FENCES the predecessor's (old-epoch serve/settle is
 *  refused). A FIRST registration keeps the provisioned epoch (0), so a never-restarted instance
 *  stays at epoch 0. The old family was already revoked + verify-evicted under the freeze, so no
 *  old-epoch authority survives the advance.
 *
 *  The question is "did an incarnation of this instanceId exist before me", and only the gate
 *  answers it: its `registrationRevision` is 0 until a registration commits, and a deregistration
 *  leaves it untouched, so a stop-then-start pair never re-registers at the predecessor's epoch.
 *  Both completing reopens ask the gate they hold frozen, never the records store, so the normal
 *  path and a resumed one commit the same epoch for the same history. */
function successorProcessEpoch(gate: { processEpoch: number; registrationRevision: number }): number {
  return gate.registrationRevision === 0 ? gate.processEpoch : gate.processEpoch + 1;
}

/** After holder-gone eviction, complete a frozen registration whose Phase-3 spec write committed
 *  (gate.registrationRevision still names the pre-write spec). Returns `completed: false` when the
 *  spec has not advanced, so the caller may abort-reopen, or when the token-pinned reopen lost its
 *  CAS (`raced`), so nothing was reopened. A failed spec/governance read stays frozen; a reopen that
 *  throws may have committed. */
export async function completeFrozenRegistrationFromSpec(
  recordsKv: KV,
  args: {
    endpoint: string;
    instanceId: string;
    barrier: EpIssuanceBarrier;
    freezeToken: number;
    gate: { generation: number; processEpoch: number; registrationRevision: number; nameAuthorityRevision: number };
  },
): Promise<{ completed: false; raced: boolean } | { completed: true; registrationRevision: number; processEpoch: number }> {
  const specKey = recordSpecKey(RECORD_KINDS.svc, [args.endpoint, assertLifecycleToken(args.instanceId, "instanceId")]);
  let specEntry: Awaited<ReturnType<KV["get"]>>;
  try {
    specEntry = await recordsKv.get(specKey);
  } catch (e) {
    throw new EpEnvelopeError("unavailable", `the frozen registration's spec read-back failed; the gate stays frozen (SPEC 13.1): ${(e as Error)?.message ?? String(e)}`);
  }
  if (!specEntry || specEntry.operation !== "PUT" || specEntry.revision <= args.gate.registrationRevision)
    return { completed: false, raced: false };
  try {
    parseServiceSpec(decodeRecordJson(specEntry.value, specKey), { endpoint: args.endpoint });
  } catch (e) {
    throw new EpEnvelopeError("unavailable", `the frozen registration's spec is unreadable; the gate stays frozen (SPEC 13.1): ${(e as Error)?.message ?? String(e)}`);
  }
  await promoteHeldGovernance(recordsKv, args.endpoint, args.instanceId, args.gate.generation);
  const processEpoch = successorProcessEpoch(args.gate);
  const successor: EpGateSuccessor = {
    generation: args.gate.generation + 1,
    processEpoch,
    registrationRevision: specEntry.revision,
    nameAuthorityRevision: args.gate.nameAuthorityRevision,
  };
  let reopened: boolean;
  try {
    reopened = await args.barrier.reopen(args.freezeToken, successor);
  } catch (err) {
    throw new EpEnvelopeError("unavailable", `the spec for "${args.instanceId}" is published at revision ${specEntry.revision} but the reopen's outcome is unknown: it may have committed, or the gate is still frozen for reconciliation; re-read the gate before retrying (SPEC 13.1): ${(err as Error)?.message ?? String(err)}`);
  }
  if (!reopened) return { completed: false, raced: true };
  await releaseHeldGovernance(recordsKv, args.endpoint, args.instanceId, args.gate.generation);
  return { completed: true, registrationRevision: specEntry.revision, processEpoch };
}

/** `details[].kind` on every refusal of {@link assertForeignSlotIsOrphaned}. A caller that repairs the
 *  holder decides on these facts, because the message is prose and the codes pair unlike cases. */
export const EP_FOREIGN_SLOT_HELD = "ai.cotal.ep.foreign-slot-held";

export type ForeignSlotCondition = "no-seam" | "unreadable" | "garbled" | "behind" | "in-flight";

export interface EpForeignSlotHeldDetail extends EpErrorDetail {
  kind: typeof EP_FOREIGN_SLOT_HELD;
  holderInstanceId: string;
  condition: ForeignSlotCondition;
}

/** The foreign-slot marker on a thrown registration refusal. */
export function foreignSlotHeldFrom(e: unknown): EpForeignSlotHeldDetail | undefined {
  if (!(e instanceof EpEnvelopeError)) return undefined;
  return e.details?.find((d): d is EpForeignSlotHeldDetail => d.kind === EP_FOREIGN_SLOT_HELD);
}

/** THE FOREIGN-SLOT ORPHAN PREDICATE (§13.7). A registration whose endpoint governance slot is held
 *  by ANOTHER instance either waits for a live registration to finish or reclaims a dead one, and
 *  this decides which. It refuses unless the slot is PROVABLY dead.
 *
 *  WHY A STAMP BEHIND THE HOLDER'S LIVE GATE IS DEAD, and not merely old. The slot is stamped with
 *  the generation of the gate its holder had FROZEN when it took the slot, and
 *  {@link promoteHeldGovernance} promotes only when the slot's generation EQUALS the frozen gate's
 *  generation. A freeze preserves the generation; only a token-pinned reopen advances it, and a
 *  reopen releases the freeze. So a holder gate reading a generation ABOVE the stamp proves no
 *  barrier holds a freeze at the stamped generation, which proves the equality promote requires can
 *  never again hold for that slot. It is unpromotable by its holder, by a reconciler, and by anyone
 *  else, so it binds nothing and never will, and the slot-take may replace it.
 *
 *  RECLAIMING ONE CANNOT LAUNDER GOVERNANCE. The slot-take rewrites `provisional` and carries
 *  `commands` (the BINDING map) forward from the same fresh read. Impositions become binding only in
 *  {@link promoteHeldGovernance}, after a spec publish commits. So what a reclaim discards is
 *  provisional declarations that never published, which is the phantom-obligation orphan the slot
 *  exists to prevent, and never a published descriptor's impositions.
 *
 *  EVERY OTHER OBSERVATION FAILS CLOSED, because the cost is asymmetric: refusing a dead slot is a
 *  wait, reclaiming a live one is two registrations publishing against one linearization point.
 *    - no seam wired          → refuse (a caller that cannot observe gets today's behaviour)
 *    - the read throws        → refuse (unreadable, not absent)
 *    - not an unsigned int    → refuse (garbled; never coerced)
 *    - live === stamp         → refuse: genuinely IN FLIGHT, the holder still holds that freeze
 *    - live  <  stamp         → refuse: the observation is BEHIND the stamp, so it is stale or
 *                               garbled, and an ahead-of-us reading never licenses a reclaim
 *    - live  >  stamp         → the ONLY permissive answer, and the proof above is what it rests on
 *
 *  `live === stamp` is deliberately the refusal that covers the operator's frozen residue while the
 *  holder is still up: it is exactly the coordinate a live in-flight registration presents, and no
 *  liveness probe is consulted here because the gate coordinate is the durable, CAS-enforced fact
 *  and a probe is a point-in-time guess. Reopening that gate (a holder retry, its boot heal, or
 *  `cotal reconcile-gate`) is what advances the generation and makes the slot reclaimable. */
async function assertForeignSlotIsOrphaned(
  slot: { instanceId: string; generation: number },
  endpoint: string,
  observeHolderGeneration?: (holderInstanceId: string) => Promise<number> | number,
): Promise<void> {
  const held = `a concurrent registration for endpoint "${endpoint}" (instance "${slot.instanceId}") holds the governance slot through its spec publication`;
  const refuse = (code: EpErrorCode, condition: ForeignSlotCondition, message: string) =>
    new EpEnvelopeError(code, message, [{ kind: EP_FOREIGN_SLOT_HELD, holderInstanceId: slot.instanceId, condition }]);
  if (typeof observeHolderGeneration !== "function")
    throw refuse("conflict", "no-seam", `${held}; re-read and re-decide. This registration cannot observe that instance's issuance gate, so it cannot tell an in-flight registration from an abandoned one and refuses (SPEC 13.7/13.8)`);
  let observed: unknown;
  try {
    observed = await observeHolderGeneration(slot.instanceId);
  } catch (e) {
    throw refuse("unavailable", "unreadable", `${held}, and its issuance-gate generation could not be observed; refusing rather than racing a registration that may still be in flight (SPEC 13.7): ${(e as Error)?.message ?? String(e)}`);
  }
  if (!wireInt(observed))
    throw refuse("unavailable", "garbled", `${held}, and its issuance-gate generation could not be observed; refusing rather than racing a registration that may still be in flight (SPEC 13.7): observed ${JSON.stringify(observed)}, not an unsigned generation`);
  if (observed < slot.generation)
    throw refuse("unavailable", "behind", `${held} at generation ${slot.generation}, ahead of its observed live gate generation ${observed}; refusing rather than treating an ahead or garbled observation as an abandoned slot (SPEC 13.7)`);
  if (observed === slot.generation)
    throw refuse("conflict", "in-flight", `${held}; its issuance gate is still at generation ${slot.generation}, so that registration is IN FLIGHT and this one must wait; re-read and re-decide. If its holder is gone, reopen that instance's gate first (its own restart heals it on boot, or run: \`cotal reconcile-gate --instance ${slot.instanceId}\`), which advances the generation past the slot and lets this registration reclaim it (SPEC 13.7/13.8)`);
  // observed > slot.generation: the holder's gate has reopened past the stamp, so the slot can
  // never satisfy the promote's generation equality. It is dead, and the slot-take replaces it.
}

/** Merge the held provisional declarations into binding WITHOUT clearing the slot. The
 *  retained slot is the exclusion that keeps {@link deregisterServiceInstance} from
 *  deleting the spec until after the issuance gate reopens. Promote only when the slot
 *  names this instance AND its generation equals the frozen gate's generation — that is
 *  what proves the provisional declarations were prepared under THIS freeze, not a stale
 *  same-instance stamp. A generation mismatch stays frozen. */
async function promoteHeldGovernance(kv: KV, endpoint: string, instanceId: string, frozenGeneration: number): Promise<void> {
  const gov = await readEndpointGovernance(kv, endpoint);
  if (!gov.provisional) return;
  if (gov.provisional.instanceId !== instanceId)
    throw new EpEnvelopeError("unavailable", `the governance slot for endpoint "${endpoint}" is held by instance "${gov.provisional.instanceId}", not "${instanceId}"; the gate stays frozen (SPEC 13.7)`);
  if (gov.provisional.generation !== frozenGeneration)
    throw new EpEnvelopeError("unavailable", `the governance slot for endpoint "${endpoint}" is held at generation ${gov.provisional.generation}, not the frozen generation ${frozenGeneration}; the gate stays frozen (SPEC 13.7)`);
  if (gov.revision === null)
    throw new EpEnvelopeError("internal", `the governance head for endpoint "${endpoint}" has a provisional slot but no store revision; garbled state never promotes (SPEC 13.7)`);
  const retained: EndpointGovernance = {
    commands: serializeGovernanceCommands(mergeEndpointGovernance(gov.commands, gov.provisional.commands)),
    provisional: {
      instanceId,
      generation: frozenGeneration,
      commands: serializeGovernanceCommands(gov.provisional.commands),
    },
  };
  try {
    await updateRecordEntry(kv, recordAtomicKey(GOVERN_HEAD, [endpoint]), retained, gov.revision);
  } catch (err) {
    let again: Awaited<ReturnType<typeof readEndpointGovernance>>;
    try {
      again = await readEndpointGovernance(kv, endpoint);
    } catch (readErr) {
      throw new EpEnvelopeError("unavailable", `the spec is published but the governance promote did not complete; the gate is left frozen for reconciliation (SPEC 13.7/13.1): ${(err as Error)?.message ?? String(err)}; promote read-back failed: ${(readErr as Error)?.message ?? String(readErr)}`);
    }
    if (!again.provisional
      || again.provisional.instanceId !== instanceId
      || again.provisional.generation !== frozenGeneration
      || JSON.stringify(serializeGovernanceCommands(again.commands)) !== JSON.stringify(retained.commands)) {
      throw new EpEnvelopeError("unavailable", `the spec is published but the governance promote did not complete; the gate is left frozen for reconciliation (the promote is an idempotent re-CAS of the held slot to binding, SPEC 13.7/13.1): ${(err as Error)?.message ?? String(err)}`);
    }
  }
}

/** Drop the retained slot after a completing registration's reopen. Binding commands stay.
 *  A lost release ack is recovered by re-read: already-cleared is done; still ours at
 *  this generation retries once; anything else leaves the stamp. A leftover stamp is
 *  a slot whose generation is behind the live gate (reopen already advanced past it).
 *  {@link deregisterServiceInstance} treats that as orphaned, not in-flight. It never
 *  throws: the gate stays OPEN, so a release that cannot finish must not report the
 *  registration it follows as failed. */
async function releaseHeldGovernance(kv: KV, endpoint: string, instanceId: string, frozenGeneration: number): Promise<void> {
  const attempt = async (): Promise<"done" | "retry"> => {
    const gov = await readEndpointGovernance(kv, endpoint);
    if (!gov.provisional) return "done";
    if (gov.provisional.instanceId !== instanceId || gov.provisional.generation !== frozenGeneration) return "done";
    if (gov.revision === null)
      throw new EpEnvelopeError("internal", `the governance head for endpoint "${endpoint}" has a provisional slot but no store revision; garbled state never releases (SPEC 13.7)`);
    const cleared: EndpointGovernance = { commands: serializeGovernanceCommands(gov.commands) };
    try {
      await updateRecordEntry(kv, recordAtomicKey(GOVERN_HEAD, [endpoint]), cleared, gov.revision);
      return "done";
    } catch {
      const again = await readEndpointGovernance(kv, endpoint);
      if (!again.provisional) return "done";
      if (again.provisional.instanceId === instanceId && again.provisional.generation === frozenGeneration) return "retry";
      return "done";
    }
  };
  try { if (await attempt() === "retry") await attempt(); }
  catch { /* gate already reopened; a slot stamped behind its live generation is safely orphaned */ }
}

/** Reopen a barrier-frozen gate (token-pinned) after a registration aborted before any spec write
 *  or revoke — the gate returns to `open` at the given successor. A lost CAS means a newer barrier
 *  moved the gate and nothing was reopened; a reopen that throws may have committed. Either is
 *  surfaced with the aborting cause attached (§13.1: fail closed, never a silently stuck gate). */
async function reopenGateAfterAbort(barrier: EpIssuanceBarrier, token: number, successor: EpGateSuccessor, cause: unknown): Promise<void> {
  let e: EpEnvelopeError;
  try {
    if (await barrier.reopen(token, successor)) return;
    e = new EpEnvelopeError("unavailable", "registration aborted and the reopen lost its freeze token (a reconciler or newer barrier superseded this one), so this registration reopened nothing; re-read the gate and re-decide (SPEC 13.1)");
  } catch (err) {
    e = new EpEnvelopeError("unavailable", `registration aborted and the reopen's outcome is unknown: it may have committed, or the gate is still frozen for reconciliation; re-read the gate before retrying (SPEC 13.1): ${(err as Error)?.message ?? String(err)}`);
  }
  (e as Error & { cause?: unknown }).cause = cause;
  throw e;
}

/** Write an instance's status with the FULL §13.9 writer fence. `epoch` is the
 *  WRITER-AUTHENTICATED epoch — in production the record writer reads it from the
 *  broker-authenticated `epr` subject (§13.9), never from the payload; this helper trusts its
 *  caller to be that seam and additionally requires the payload to agree. The fence is
 *  THREE-part, in order:
 *   1. a registered spec must exist and `observedSpecRevision` must not run AHEAD of it — a
 *      spec-less status is the torn record state readers reject (§13.4), never written;
 *   2. the epoch must equal a FRESH read of the authoritative lifecycle mapping's
 *      `processEpoch` (`expired` otherwise) — monotonicity against the stored status alone is
 *      NOT sufficient: between the takeover CAS (N→N+1) and the completed revoke/evict barrier
 *      the superseded N still equals the stored epoch (§13.9);
 *   3. a below-stored epoch is `conflict` (§13.9), distinct from the mapping fence.
 *  `readProcessEpoch` is the trusted mapping-reader seam (leader-served, §13.9; the D13
 *  lifecycle registry provides the production reader). The racing CAS loss is a loud `conflict`.
 *  `expectedStatusRevision` pins the CAS to the CALLER's observed status revision (0 = observed
 *  ABSENT) for read-modify-write callers whose new value derives from the stored one (the §13.6
 *  restart-intensity history): without the pin, this function's own fresh internal read would
 *  let two concurrent derivations silently merge-lose each other's contribution. It is PURELY a
 *  CAS pin — the AUTHORITY to originate supervisor-owned state is the separate branded
 *  {@link SupervisorWriteGrant} (`supervisor`), never revision presence. Without the grant this
 *  is an instance-side write: it may not carry the restart history, the retirement mark, or the
 *  `escalated` state (they are stripped on both create and update, and `escalated` refuses),
 *  and the stored supervisor fields ride forward untouched. */
export async function writeServiceStatus(
  kv: KV,
  args: {
    endpoint: string;
    instanceId: string;
    epoch: number;
    status: ServiceStatus;
    readProcessEpoch: () => Promise<number> | number;
    expectedStatusRevision?: number;
    supervisor?: SupervisorWriteGrant;
  },
): Promise<number> {
  // SNAPSHOT the raw input FIRST (a JSON round-trip reads each getter exactly once, so nothing a
  // caller controls flips between here and the awaits below — validate-then-clone would validate
  // the caller object then re-read it during the clone, a getter/Proxy TOCTOU). An instance-side
  // (ungranted) write cannot ORIGINATE the supervisor-owned state: its reserved fields are
  // stripped from the RAW snapshot BEFORE validation (a forged garbage `restarts`/`retiredAt` is
  // dropped, not rejected — the instance's ordinary `ready`/`exited` write still goes through),
  // and it may not originate `escalated`. Only THEN validate the (possibly stripped) snapshot.
  const raw = JSON.parse(JSON.stringify(args.status)) as Record<string, unknown>;
  const bySupervisor = isSupervisorWrite(args.supervisor);
  if (!bySupervisor) {
    if (raw.state === SERVICE_ESCALATED)
      throw new EpEnvelopeError("failed-precondition", `an instance-side status write cannot ORIGINATE "${SERVICE_ESCALATED}" for "${args.endpoint}/${args.instanceId}"; escalation is the supervisor's branded authority (SPEC 13.6)`);
    delete raw[SERVICE_RESTART_HISTORY_FIELD];
    delete raw[SERVICE_RETIRED_MARK_FIELD];
  }
  const status: ServiceStatus = parseServiceStatus(raw);
  if (status.epoch !== args.epoch)
    throw new EpEnvelopeError("internal", `status.epoch ${status.epoch} disagrees with the writer-authenticated epoch ${args.epoch} (SPEC 13.9: the epoch rides the subject)`);
  assertStatusValue(status);
  // The endpoint NAME rides through: the kind's own qualifier assert tokenizes it exactly once.
  const iId = assertLifecycleToken(args.instanceId, "instanceId");
  const specEntry = await kv.get(recordSpecKey(RECORD_KINDS.svc, [args.endpoint, iId]));
  if (!specEntry || specEntry.operation !== "PUT")
    throw new EpEnvelopeError("failed-precondition", `status write for "${args.endpoint}/${args.instanceId}" has no registered spec; writing it would create the torn record state readers reject (SPEC 13.4)`);
  if (status.observedSpecRevision > specEntry.revision)
    throw new EpEnvelopeError("failed-precondition", `observedSpecRevision ${status.observedSpecRevision} runs AHEAD of the spec revision ${specEntry.revision}; a status can only observe a registration that exists (SPEC 13.4)`);
  const current = await args.readProcessEpoch();
  if (!Number.isSafeInteger(current) || current < 0)
    throw new EpEnvelopeError("internal", `the authoritative mapping read returned ${JSON.stringify(current)}, not an unsigned processEpoch`);
  if (args.epoch !== current)
    throw new EpEnvelopeError("expired", `status write from epoch ${args.epoch} is not the authoritative mapping's current processEpoch ${current}; stored-status monotonicity alone is insufficient during takeover (SPEC 13.9)`);
  const key = recordStatusKey(RECORD_KINDS.svc, [args.endpoint, iId]);
  const stored = await kv.get(key);
  if (args.expectedStatusRevision !== undefined) {
    if (!Number.isSafeInteger(args.expectedStatusRevision) || args.expectedStatusRevision < 0)
      throw new EpEnvelopeError("internal", `expectedStatusRevision ${String(args.expectedStatusRevision)} is not an unsigned integer`);
    const current = stored && stored.operation === "PUT" ? stored.revision : 0;
    if (current !== args.expectedStatusRevision)
      throw new EpEnvelopeError("conflict", `the status for "${args.endpoint}/${args.instanceId}" moved (observed revision ${args.expectedStatusRevision}, stored ${current}); a derived write against a moved base would merge-lose the concurrent write, re-read and re-derive (SPEC 13.6)`);
  }
  if (stored && stored.operation === "PUT") {
    const recorded = parseServiceStatus(decodeRecordJson(stored.value, key));
    // ESCALATED is IRREVERSIBLE here (§13.6): no later write, any epoch, replaces it. The only
    // permitted touch on an escalated row is the supervisor's retirement mark, which the
    // escalation reconciler writes DIRECTLY (never through this writer).
    if (recorded.state === SERVICE_ESCALATED)
      throw new EpEnvelopeError("failed-precondition", `"${args.endpoint}/${args.instanceId}" is escalated; the state is terminal and a status write cannot clear it (SPEC 13.6)`);
    if (args.epoch < recorded.epoch)
      throw new EpEnvelopeError("conflict", `status write from epoch ${args.epoch} is below the stored status epoch ${recorded.epoch} (SPEC 13.9)`);
    if (!bySupervisor) {
      // The supervisor-owned fields ride FORWARD through this instance-side write: they were
      // stripped above, so copy the stored values back (a successor's `ready` convergence
      // survives the history, §13.6).
      const s = status as Record<string, unknown>;
      const r = recorded as Record<string, unknown>;
      if (r[SERVICE_RESTART_HISTORY_FIELD] !== undefined) s[SERVICE_RESTART_HISTORY_FIELD] = r[SERVICE_RESTART_HISTORY_FIELD];
      if (r[SERVICE_RETIRED_MARK_FIELD] !== undefined) s[SERVICE_RETIRED_MARK_FIELD] = r[SERVICE_RETIRED_MARK_FIELD];
    }
    return updateRecordEntry(kv, key, status, stored.revision);
  }
  // A DEREGISTRATION TOMBSTONE on the STATUS key is written over too, and for the same reason the
  // spec key's is (see {@link registerServiceInstance}): §13.5 deletes BOTH keys, so a create-only
  // write here would let the spec come back on a restart while the status never could — the
  // instance would register and then be unable to converge, which reads to every scatter as
  // "registered but never live" and to the operator as a manager that starts and does nothing.
  // Still a CAS, pinned to the marker's own revision; only TRUE ABSENCE creates.
  return stored ? updateRecordEntry(kv, key, status, stored.revision) : createRecordEntry(kv, key, status);
}

// ---- deregistration (§13.5) --------------------------------------------------------------------

/** What a deregistration found and did. `removed: false` is a NORMAL outcome, not a failure: an
 *  already-absent record and a record that moved under the read are both things a caller has to be
 *  able to tell apart from a completed removal, and neither is worth a throw at this layer — the
 *  operator verb refuses loudly on them, a manager's own clean-stop logs and carries on. */
export type ServiceDeregistration =
  | { removed: true; specRevision: number; statusRevision?: number }
  /** No live spec key at the coordinate: never registered, or already deregistered. */
  | { removed: false; reason: "absent" }
  /** The spec is not at the caller's `registrationRevision`: another incarnation owns it. Or the
   *  status observed a later registration than the spec read, or a key moved between the read and
   *  its revision-pinned delete: something is WRITING to this registration, so it is not the dead
   *  record that was inspected. The spec was not removed. A status that was removed observed the
   *  inspected registration or an earlier one. */
  | { removed: false; reason: "superseded" }
  /** This instance currently holds the endpoint governance slot at the live gate generation
   *  (a registration is in flight through spec publish and gate reopen). Nothing was removed. */
  | { removed: false; reason: "registration-in-flight" };

/**
 * DEREGISTER one service instance: the §13.5 explicit deregistration, which is the DELETE of its
 * `svc` spec key (and its status key with it).
 *
 * WHY THIS EXISTS AT ALL. The registry records REGISTRATION, not liveness, and nothing in the model
 * expires a row. An instance whose host dies leaves a record that claims a live state forever, and
 * every class scatter in the space then freezes that slot in and waits out the full deadline for an
 * answer that can never come. Registration therefore needs a way OUT that does not depend on the
 * dead instance's cooperation, and this is it. There is deliberately no automatic sweep behind it:
 * the two callers are an instance removing its OWN row on a clean stop, and an operator naming a
 * hard-dead instance explicitly.
 *
 * ORDER IS PART OF THE CONTRACT: status first, then spec. A reader that catches the pair mid-delete
 * sees "spec without status", which §13.4 already defines (an instance registered but not converged;
 * {@link freezeExpectedSet} skips it) and which {@link readRecord} reads cleanly. The other order
 * produces "status without spec", which is the TORN state readers refuse — a deregistration would
 * hand every concurrent reader a `failed-precondition` for the width of one round trip.
 *
 * BOTH DELETES ARE REVISION-PINNED to what this function just read. A blind delete of a registration
 * is a delete of whatever is there NOW, and what is there now may be a successor that re-registered
 * microseconds ago under the same instanceId — exactly the case a restart produces. A moved key
 * aborts with `superseded`. So does a status that observed a later registration than the spec read:
 * that is a successor landing between the two reads, which the status pin cannot see because the
 * status read returns it. `superseded` never removes the spec, and a status it removed observed the
 * inspected registration or an earlier one.
 *
 * THAT PIN ONLY COVERS A WRITE AFTER THE READ. A successor that registered before the read is what
 * the read returns, and the instanceId persists across restarts, so the read alone cannot tell it
 * from the caller's own row. An instance removing its own row therefore passes the
 * `registrationRevision` it registered at, and a spec at any other revision is another
 * incarnation's: `superseded`, nothing removed. The operator verb names a dead instance, not an
 * incarnation, and passes none.
 *
 * THE RECOVERY PATH, because a deregistration must never be a one-way door: the record is removed,
 * the §13.1 issuance gate is NOT. The same instance can register again and does so on its next
 * start — {@link registerServiceInstance} writes over the tombstone under a revision-pinned CAS and
 * advances the epoch as it does for any other restart.
 *
 * A LIVE GOVERNANCE SLOT AT THE CURRENT GATE GENERATION IS ALSO A REFUSAL. Registration holds that
 * slot from decision through reopen so a delete cannot invalidate the spec the freeze is completing.
 * `observeGeneration` is a READ of this instance's issuance-gate generation, never a freeze. The
 * observation is classified, not trusted as a typed number:
 *   - throw, absent, or not a non-negative safe integer → fail closed (`unavailable`)
 *   - equal to the slot generation → in-flight (refuse)
 *   - strictly greater than the slot generation → leftover after reopen (delete proceeds)
 *   - strictly less than the slot generation → ahead of the live gate (fail closed)
 * Non-equal is not "behind". Only `slot.generation < liveGeneration` is the permissive proof.
 */
export async function deregisterServiceInstance(
  kv: KV,
  args: {
    endpoint: string;
    instanceId: string;
    /** The `registrationRevision` the caller registered at; the delete is refused for any other. */
    registrationRevision?: number;
    /** Read this instance's live issuance-gate generation. A read, never a freeze. */
    observeGeneration: () => Promise<number> | number;
  },
): Promise<ServiceDeregistration> {
  const iId = assertLifecycleToken(args.instanceId, "instanceId");
  const specKey = recordSpecKey(RECORD_KINDS.svc, [args.endpoint, iId]);
  const statusKey = recordStatusKey(RECORD_KINDS.svc, [args.endpoint, iId]);
  const specEntry = await kv.get(specKey);
  if (!specEntry || specEntry.operation !== "PUT") return { removed: false, reason: "absent" };
  if (args.registrationRevision !== undefined && specEntry.revision !== args.registrationRevision)
    return { removed: false, reason: "superseded" };
  // Read the spec FIRST, then the governance slot, never the reverse. A govern-then-spec
  // order would let a delete of a LATER spec ride an earlier empty-slot read: Phase 1
  // takes the slot after the previous release, so an empty-slot snapshot can predate a
  // successor PUT that this GET then observes. Spec-then-govern serializes against the
  // slot this instance holds for the PUT just read.
  {
    const gov = await readEndpointGovernance(kv, args.endpoint);
    if (gov.provisional?.instanceId === iId) {
      let observed: unknown;
      try {
        observed = await args.observeGeneration();
      } catch (e) {
        throw new EpEnvelopeError("unavailable", `could not observe the issuance-gate generation for "${args.endpoint}/${iId}" while its governance slot is held; refusing the delete rather than racing an in-flight registration (SPEC 13.7): ${(e as Error)?.message ?? String(e)}`);
      }
      if (!wireInt(observed))
        throw new EpEnvelopeError("unavailable", `could not observe the issuance-gate generation for "${args.endpoint}/${iId}" while its governance slot is held; refusing the delete rather than racing an in-flight registration (SPEC 13.7): observed ${JSON.stringify(observed)}, not an unsigned generation`);
      const liveGeneration = observed;
      if (gov.provisional.generation === liveGeneration) return { removed: false, reason: "registration-in-flight" };
      if (gov.provisional.generation > liveGeneration)
        throw new EpEnvelopeError("unavailable", `the governance slot for "${args.endpoint}/${iId}" is held at generation ${gov.provisional.generation}, ahead of the observed live gate generation ${liveGeneration}; refusing the delete rather than treating an ahead or garbled observation as a leftover (SPEC 13.7)`);
      // slot.generation < liveGeneration: leftover after a successful reopen whose release ack was lost.
    }
  }
  const statusEntry = await kv.get(statusKey);
  const casLoss = (e: unknown): boolean => e instanceof EpEnvelopeError && e.code === "conflict";
  let statusRevision: number | undefined;
  if (statusEntry && statusEntry.operation === "PUT") {
    // A successor's status: deleting it would leave that successor registered and never live.
    if (parseServiceStatus(decodeRecordJson(statusEntry.value, statusKey)).observedSpecRevision > specEntry.revision)
      return { removed: false, reason: "superseded" };
    try {
      await deleteRecordEntry(kv, statusKey, statusEntry.revision);
      statusRevision = statusEntry.revision;
    } catch (e) {
      if (casLoss(e)) return { removed: false, reason: "superseded" }; // it wrote a status: it is alive
      throw e;
    }
  }
  try {
    await deleteRecordEntry(kv, specKey, specEntry.revision);
  } catch (e) {
    // The status is already gone. That is the deliberate direction of this partial state: the
    // instance is absent from every scatter freeze (a spec with no status is not a live member) and
    // its own next registration rewrites both keys. Reported as `superseded` so the caller says so
    // rather than claiming a removal it did not complete.
    if (casLoss(e)) return { removed: false, reason: "superseded" };
    throw e;
  }
  return { removed: true, specRevision: specEntry.revision, ...(statusRevision !== undefined ? { statusRevision } : {}) };
}

// ---- the scatter freeze (§13.5) ---------------------------------------------------------------

/** One frozen scatter slot: `(instanceId, registrationRevision, epoch)` (§13.5). */
export interface FrozenInstance {
  instanceId: string;
  /** The `svc….spec` key's store revision at freeze time. */
  registrationRevision: number;
  epoch: number;
}

/** Freeze the request-scoped expected set (§13.5): the LIVE instances of a class from the
 *  service registry at send time — VALIDATED registered spec, status present and caught up to
 *  the current registration (a stale projection is an instance not yet live under it, so
 *  freezing `(new registrationRevision, pre-registration epoch)` would combine a registration
 *  with liveness it never had), and not {@link SERVICE_EXITED}. An EMPTY or UNREADABLE registry
 *  is `failed-precondition`, never an empty success (§13.5); a MALFORMED registry record fails
 *  loud (`internal`, §13.9: readers fail loud on invalid mediated-writer state). The read grant
 *  this runs under is a §13.9 matrix row. */
export async function freezeExpectedSet(jsm: JetStreamManager, space: string, endpoint: string): Promise<FrozenInstance[]> {
  const e = endpointToken(endpoint);
  const frozen: FrozenInstance[] = [];
  const instanceIds: string[] = [];
  try {
    // Enumeration is a bounded-lag LIST (which instances exist): a just-registered instance missed
    // here simply is not frozen this round (it falls to the gather/reconcile), so the list read need
    // not be leader-served — but each frozen slot's coordinate reads below ARE.
    //
    // It reads `STREAM.INFO` with a `subjects_filter` rather than `kv.keys()`. Both enumerate the
    // same subjects; `kv.keys()` rides an ORDERED EPHEMERAL CONSUMER, so every caller of this
    // function needs CONSUMER.CREATE/INFO/DELETE on the bucket — three consumer-lifecycle verbs to
    // list keys. `subjects_filter` is the native JetStream feature for exactly this and needs one
    // read-only metadata verb instead. The bucket name is derived from `space` (same derivation
    // `scatterFreezeReadRows` uses for the grant); there is no KV handle parameter because nothing
    // here opens one — per-slot reads are leader-served `STREAM.MSG.GET` via `jsm`.
    //
    // `state.subjects` counts messages per subject, so a key whose latest write is a DELETE marker
    // still appears where `kv.keys()` would omit it. That is already handled and always was — the
    // per-slot read below reports a tombstone as `{ deleted: true }` and the loop skips it as "gone
    // since the enumeration list", which is the same tolerance a bounded-lag list needs anyway.
    const REC = recordsBucket(space);
    const prefix = `$KV.${REC}.`;
    const info = await jsm.streams.info(`KV_${REC}`, { subjects_filter: `${prefix}svc.${e}.*.spec` });
    for (const subject of Object.keys(info.state.subjects ?? {}))
      instanceIds.push(subject.slice(prefix.length).split(".")[2]);
  } catch (err) {
    const wrapped = new EpEnvelopeError("failed-precondition", `the service registry for "${endpoint}" is unreadable; an unreadable registry is failed-precondition, never an empty success (SPEC 13.5): ${(err as Error)?.message ?? String(err)}`);
    (wrapped as Error & { cause?: unknown }).cause = err;
    throw wrapped;
  }
  for (const instanceId of instanceIds) {
    // Leader-served spec + status reads, so the FROZEN registrationRevision comes from the same
    // consistency level as the reconcile's — a follower-stale freeze paired with a leader reconcile
    // would otherwise fabricate registration churn from pure read-skew.
    const spec = await readSvcRecordLeader(jsm, space, recordSpecKey(RECORD_KINDS.svc, [endpoint, instanceId]));
    if (!spec || "deleted" in spec) continue; // gone since the enumeration list: not a live member
    parseServiceSpec(spec.value, { endpoint }); // malformed registry state fails LOUD (§13.9)
    const statusRec = await readSvcRecordLeader(jsm, space, recordStatusKey(RECORD_KINDS.svc, [endpoint, instanceId]));
    if (!statusRec || "deleted" in statusRec) continue; // registered but never converged: not a live class member
    const status = parseServiceStatus(statusRec.value);
    if (status.state === SERVICE_EXITED) continue;
    if (status.state === SERVICE_ESCALATED) continue; // terminally not-startable (§13.6): never a live scatter member
    if (status.observedSpecRevision < spec.revision) continue; // staleProjection: liveness predates the CURRENT registration
    frozen.push({ instanceId, registrationRevision: spec.revision, epoch: status.epoch });
  }
  // An empty registry is never an empty scatter success (SPEC 13.5). The detail reaches operators, so
  // it says what is missing and leaves the rule here.
  if (frozen.length === 0)
    throw new EpEnvelopeError("failed-precondition", `service "${endpoint}" has no live registered instances`, [{ kind: EP_NO_LIVE_INSTANCES, endpoint } satisfies EpNoLiveInstancesDetail]);
  return frozen;
}

/** A LEADER-SERVED read of one `svc` record key (§13.1: every authority currency read is a
 *  leader-served `STREAM.MSG.GET`, never a follower/mirror Direct Get — independent of how a KV
 *  handle was opened, so the public reader seams do not depend on a caller passing a bind-only KV).
 *  `svc` records, unlike the never-deleted lifecycle families, MAY be deleted on deregistration
 *  (§13.5: a deleted spec is an explicit deregistration), so a DELETE/PURGE marker is reported as
 *  `{ deleted: true }`, never a corruption throw. Absent → `undefined`; malformed → loud. */
export async function readSvcRecordLeader(
  jsm: JetStreamManager,
  space: string,
  key: string,
): Promise<{ value: unknown; revision: number } | { deleted: true } | undefined> {
  const bucket = recordsBucket(space);
  let m;
  try {
    m = await jsm.streams.getMessage(`KV_${bucket}`, { last_by_subj: `$KV.${bucket}.${key}` });
  } catch (e) {
    if ((e as { code?: unknown }).code === 10037) return undefined; // no message on the subject: never registered
    const wrapped = new EpEnvelopeError("failed-precondition", `the service registry key ${key} is unreadable (leader read); an unreadable registry is failed-precondition, never a fabricated verdict (SPEC 13.5): ${(e as Error)?.message ?? String(e)}`);
    (wrapped as Error & { cause?: unknown }).cause = e;
    throw wrapped;
  }
  if (!m) return undefined;
  if (m.header?.get("KV-Operation")) return { deleted: true }; // a deregistration, not corruption (§13.5)
  return { value: decodeRecordJson(m.data, key), revision: m.seq };
}

/** The PRODUCTION `reconcileRegistration` hook for {@link epScatter} (§13.5): a bounded post-T
 *  LEADER-SERVED read of every frozen slot's CURRENT `svc….spec` key (the same §13.9 read class as
 *  the freeze). Per slot: a live spec is `{ registered: true, registrationRevision }` (the key's
 *  CURRENT store revision — an advance past the frozen value is what the gather classifies as
 *  `registration` churn); an absent OR deleted spec is the EXPLICIT `{ registered: false }` verdict
 *  (a mid-scatter deregistration, §13.5: not churn). Only the spec KEY is read — the reconcile
 *  compares registration currency, not liveness. A malformed spec fails loud (`internal`, §13.9);
 *  an unreadable registry normalizes to `failed-precondition` (§13.5: never a fabricated verdict).
 *  Leader-served so a follower-stale read can never miss an advanced revision and falsely retain a
 *  counted reply (engineer/distsys). */
export function registrationReconciler(
  jsm: JetStreamManager,
  space: string,
  endpoint: string,
  frozen: readonly FrozenInstance[],
): () => Promise<Map<string, EpRegistrationState>> {
  endpointToken(endpoint); // grammar up front: a malformed endpoint never reaches the read
  return async () => {
    const verdicts = new Map<string, EpRegistrationState>();
    for (const slot of frozen) {
      const rec = await readSvcRecordLeader(jsm, space, recordSpecKey(RECORD_KINDS.svc, [endpoint, slot.instanceId]));
      if (!rec || "deleted" in rec) {
        verdicts.set(slot.instanceId, { registered: false });
        continue;
      }
      parseServiceSpec(rec.value, { endpoint }); // malformed registry state fails LOUD (§13.9)
      verdicts.set(slot.instanceId, { registered: true, registrationRevision: rec.revision });
    }
    return verdicts;
  };
}

/** The PRODUCTION `currentEpoch` hook for {@link epCall} on the `one` rail (§13.2): a LEADER-SERVED
 *  read of the answering instance's CURRENT `svc….status` epoch. An unregistered instance or one
 *  that never converged (no status) has no current epoch to verify a queue winner against and
 *  refuses `failed-precondition` — the read's OWN failure, which {@link epCall} never mislabels as
 *  responder staleness. Leader-served so a follower-stale status read can never accept a
 *  just-superseded queue winner at an old epoch (engineer/distsys). A stale projection does not
 *  refuse: `epoch` advances only through a takeover's status write (§13.5). */
export function serviceEpochReader(jsm: JetStreamManager, space: string, endpoint: string): (instanceId: string) => Promise<number> {
  endpointToken(endpoint);
  return async (instanceId: string) => {
    const rec = await readSvcRecordLeader(jsm, space, recordStatusKey(RECORD_KINDS.svc, [endpoint, instanceId]));
    if (!rec || "deleted" in rec)
      throw new EpEnvelopeError("failed-precondition", `"${endpoint}/${instanceId}" has no live status; a \`one\` responder with no current epoch cannot be verified (SPEC 13.2)`);
    return parseServiceStatus(rec.value).epoch;
  };
}

