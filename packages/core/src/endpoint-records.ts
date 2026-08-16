/**
 * v0.4 record-contract helpers (SPEC §13.4 "Record", §13.7 kinds, §13.9 writer table, §13.12
 * binding) — the registered kind table with its pinned key grammars, the split-key CAS write
 * discipline, and the merged read/watch with the §13.4 staleness rules.
 *
 * A record is stored in the per-space `cotal_records_<space>` KV as TWO keys with independent
 * revisions, `<key>.spec` and `<key>.status` — the split IS the broker-enforced writer boundary
 * (each writer role holds publish authority on its own key only). The single exception is the
 * lifecycle alias HEAD, one atomic unsplit key. Writes are per-key CAS and a lost race is a
 * LOUD `conflict` the caller re-reads and re-decides (§13.8) — deliberately unlike the ACL
 * registry's internal retry, because record writers are fenced principals whose lost CAS is a
 * decision point, never a last-writer-wins policy.
 *
 * These are the primitives the mediated writer principals (§13.9) build on; nothing here grants
 * anything. Untrusted callers never hold raw reads on this bucket — their reads ride the
 * mediator (§13.9 "Mediated reads"); the helpers below run inside trusted principals.
 */
import { Kvm, type KV, type KvEntry } from "@nats-io/kv";
import type { JetStreamManager } from "@nats-io/jetstream";
import { token } from "./subjects.js";
import {
  endpointToken, assertBoundedOwner, assertIdToken, assertLifecycleToken, assertPoolToken,
} from "./endpoint-subjects.js";
import { EpEnvelopeError } from "./endpoint-envelope.js";

/** The per-space records bucket (§13.12): per-key CAS; `allow_direct=true`, but the lifecycle
 *  head and every FENCED read are leader-served `STREAM.MSG.GET` (§13.9) — helpers here are the
 *  non-fencing paths; a fence is always a revision-pinned CAS WRITE, never a read. */
export function recordsBucket(space: string): string {
  return `cotal_records_${token(space)}`;
}

/** Open the records bucket. Auth mode OPENs the bucket pre-created at space setup; a privileged
 *  caller passes `{ create: true }` to CREATE it (setup only). Mirrors {@link openAclRegistry}. */
export async function openRecordsBucket(
  nc: import("@nats-io/transport-node").NatsConnection,
  space: string,
  opts: { create?: boolean } = {},
): Promise<KV> {
  const kvm = new Kvm(nc);
  return opts.create ? kvm.create(recordsBucket(space)) : kvm.open(recordsBucket(space));
}

/** LEADER-SERVED read of one records-KV key: `STREAM.MSG.GET last_by_subj` on the bucket's
 *  backing stream, never `kv.get`/`DIRECT.GET`. A FENCING read — a fresh-check a mediated
 *  writer acts on before publishing authority state — needs read-your-writes against the
 *  leader; the bucket keeps `allow_direct=true` for the non-fencing paths, and a
 *  follower-served Direct Get may answer with a superseded revision, which is exactly the
 *  staleness a fence must not carry (§13.9, the same rule as {@link readLastFact}).
 *  `undefined` = the key has never been written. A DEL/PURGE marker is a DELETION, never
 *  absence — fail-closed refusal, the caller reconciles the store. */
export async function readRecordLeader(
  jsm: JetStreamManager,
  space: string,
  key: string,
): Promise<{ value: unknown; revision: number } | undefined> {
  const bucket = recordsBucket(space);
  let m;
  try {
    m = await jsm.streams.getMessage(`KV_${bucket}`, { last_by_subj: `$KV.${bucket}.${key}` });
  } catch (e) {
    if ((e as { code?: unknown }).code === 10037) return undefined; // no message on the subject
    throw e;
  }
  if (!m) return undefined;
  const op = m.header?.get("KV-Operation");
  if (op)
    throw new EpEnvelopeError("failed-precondition", `the record ${key} carries a ${op} marker; a deletion is never absence - reconcile the store (SPEC 13.7)`);
  try {
    return { value: JSON.parse(new TextDecoder().decode(m.data)), revision: m.seq };
  } catch (e) {
    throw new EpEnvelopeError("internal", `record ${key} does not decode as JSON: ${(e as Error).message}`);
  }
}

// ---- the kind registry (§13.7 "Record kinds and key grammar") -------------------------------

/** One qualifier token between the kind token and the `.spec`/`.status` suffix. */
export interface RecordQualifier {
  name: string;
  /** Token validator/normalizer — fail-loud, same validators as the subject grammar. */
  assert: (v: string) => string;
}

/** A registered record kind: its pinned key grammar, writer roles, and mediation class —
 *  grants and merged watches are DERIVED from this entry (§13.7), so two implementations
 *  always agree on which key carries what. */
export interface RecordKindDef {
  /** The wire kind token (single-label names are core-reserved; third-party kinds are
   *  reverse-DNS, tokenized `.`→`_` exactly like endpoint names). */
  kind: string;
  qualifiers: RecordQualifier[];
  /** `.spec`/`.status`-split — every kind EXCEPT the lifecycle alias head (§13.7/§13.9). */
  split: boolean;
  /** Writer PROFILES per the §13.9 writer table (declarative names; grant generation reads
   *  them). For the unsplit head both name the one committing principal. */
  writers: { spec: string; status: string };
  mediation: "mediated" | "direct";
}

const qEndpoint: RecordQualifier = { name: "endpoint", assert: (v) => endpointToken(v) };
const qOwner = (name: string): RecordQualifier => ({ name, assert: (v) => assertBoundedOwner(v, name) });
const qUid = (name: string): RecordQualifier => ({ name, assert: (v) => assertLifecycleToken(v, name) });
const qId = (name: string): RecordQualifier => ({ name, assert: (v) => assertIdToken(v, name) });

/** The lifecycle alias HEAD (§13.7/§13.9): `lifecycle.<owner>.<actor>` — ONE atomic unsplit
 *  key, the authoritative current mapping and the only `mappingRevision` source. Activation
 *  and terminal retirement serialize on its CAS; a fresh authority read of it is a
 *  leader-served `STREAM.MSG.GET` by the trusted mapping-reader, never a follower-served get. */
export const LIFECYCLE_HEAD: RecordKindDef = {
  kind: "lifecycle",
  qualifiers: [qOwner("owner"), qOwner("actor")],
  split: false,
  writers: { spec: "minting-manager-commit", status: "minting-manager-commit" },
  mediation: "mediated",
};

/** The §13.1 space-global UID RESERVATION (§13.7): `uid.<lifecycleUid>` — ONE atomic unsplit
 *  key, create-only and NEVER-DELETED for the life of the space. The KEY is the reservation
 *  (the value records the reserving authority + intended alias, audit only): the minting
 *  authority wins this create BEFORE any gate or head write, a create conflict BURNS the
 *  candidate (the alias head alone cannot reject the same UID under a different alias, and
 *  the gate./cred. families key by UID alone), and a DEL/PURGE marker is corruption, never
 *  reusable absence. */
export const UID_RESERVATION: RecordKindDef = {
  kind: "uid",
  qualifiers: [qUid("lifecycleUid")],
  split: false,
  writers: { spec: "minting-authority", status: "minting-authority" },
  mediation: "mediated",
};

/** The fixed sentinel target token for an admission with no target lifecycle (§13.7/§13.8). */
export const OBLIGATION_EP_SENTINEL = "ep";

/** The §13.8 TARGET-INDEXED ACCEPTANCE OBLIGATION (§13.7): one atomic unsplit key per
 *  acceptance identity, `oblig.<targetUid>.<endpoint>.<cOwner>.<cActor>.<cUid>.<id>` — the ONE
 *  durable serialization coordinate on which a durable acceptance/start contends with its
 *  authority head's movement (no cross-stream CAS exists). Target-first, so a retirement
 *  barrier enumerates `oblig.<targetUid>.>`; an admission under policy with NO target lifecycle
 *  keys the row with the fixed sentinel target token `ep` (which the §13.1 UID grammar can
 *  never produce), excluded from retirement drains and included in the endpoint's policy drain
 *  via `oblig.*.<endpoint>.>`. Create-only winner, monotonic value states
 *  (`provisional → accepted → terminal` | `provisional → rejected`), NEVER-DELETED. Writer:
 *  the admission mediator ONLY (§13.9; the canonicalizer holds no raw `oblig.` grant). */
export const OBLIGATION: RecordKindDef = {
  kind: "oblig",
  qualifiers: [
    { name: "targetUid", assert: (v) => (v === OBLIGATION_EP_SENTINEL ? v : assertLifecycleToken(v, "targetUid")) },
    qEndpoint, qOwner("cOwner"), qOwner("cActor"), qUid("cUid"), qId("id"),
  ],
  split: false,
  writers: { spec: "admission-mediator", status: "admission-mediator" },
  mediation: "mediated",
};

/** The §13.6 IMMUTABLE ADMISSION-POLICY VERSION (§13.7): `policy.<endpoint>.<digest-hex>` — one
 *  atomic unsplit key per policy version, create-only, NEVER-DELETED, never overwritten.
 *  `<digest-hex>` is the SHA-256 hex of the record's canonical value bytes, so the key is
 *  SELF-CERTIFYING: a reader re-digests the value it read and refuses a mismatch. The govern
 *  head's `enforcedPolicyKey`/`pendingPolicyKey` name keys of exactly this kind, which is what
 *  keeps both the enforced and the pending policy readable through a mutation's whole drain
 *  window (§13.6). Writer: the provisioner registration path ONLY (§13.9). */
export const POLICY_VERSION: RecordKindDef = {
  kind: "policy",
  qualifiers: [qEndpoint, {
    name: "digestHex",
    assert: (v) => {
      if (!/^[0-9a-f]{64}$/.test(v)) throw new Error(`policy digest ${JSON.stringify(v)} is not 64 lowercase hex chars (SPEC 13.7)`);
      return v;
    },
  }],
  split: false,
  writers: { spec: "provisioner-registration", status: "provisioner-registration" },
  mediation: "mediated",
};

/** The §13.1 PER-STREAM RETIREMENT FRONTIERS (§13.7): `frontier.<lifecycleUid>` — ONE atomic
 *  unsplit key per retired lifecycle, create-only, NEVER-DELETED, written by the terminal
 *  retirement barrier AFTER the obligation drain, the pool cleaner, and the cleaner-credential
 *  revoke+evict, and BEFORE the gate/head terminals (§13.1 order). The value records the
 *  retirement `opId` and each bounded stream's last sequence at retirement — the cutoffs that
 *  bound the predecessor's half-open interval `(activationFrontier, retirementFrontier]`; they
 *  are never a successor's start (a successor captures its OWN activation frontier). */
export const RETIREMENT_FRONTIER: RecordKindDef = {
  kind: "frontier",
  qualifiers: [qUid("lifecycleUid")],
  split: false,
  writers: { spec: "minting-authority", status: "minting-authority" },
  mediation: "mediated",
};

/** The endpoint-wide GOVERNANCE HEAD (§13.7 "a self-published descriptor cannot strip, forge,
 *  or downgrade a governed annotation"): `govern.<endpoint>` — ONE atomic unsplit key holding
 *  the endpoint's MONOTONIC (append-only) BINDING governed-trait imposition per command, plus
 *  the single in-flight registration's PROVISIONAL slot (endpoint-service.ts): the head is the
 *  endpoint's registration linearization point — every registration CAS-takes the slot under
 *  its frozen gate, holds it through spec publication, and promotes its impositions to binding
 *  only after the publish commits. Governance is a HISTORY-bearing, endpoint-wide property, not
 *  a per-instance descriptor state: once BOUND, an imposition persists across instances AND
 *  across command removal (a tombstone), until an authorized revocation (the D18
 *  governance-consent artifact) lifts it — so a re-registration, a fresh instanceId, and a
 *  remove→re-add cannot launder a strip.
 *
 *  NORMATIVE STATUS: `govern` is NOT yet in the frozen SPEC's §13.7 kind table, §13.9 writer
 *  matrix, or §13.12 records-bucket binding — it is implemented ahead of a pending P0
 *  reconciliation decision (the spec's governance-continuity requirement implies a durable,
 *  shared imposition record the frozen text does not name; multiple provisioners must read one
 *  head, so a process-internal store cannot satisfy it). The amendment is recorded in the
 *  control-surface STATUS; the operator decides spec changes. */
export const GOVERN_HEAD: RecordKindDef = {
  kind: "govern",
  qualifiers: [qEndpoint],
  split: false,
  writers: { spec: "provisioner-registration", status: "provisioner-registration" },
  mediation: "mediated",
};

/** The §13.7 core kinds, pinned. Keys: `<kind>.<qualifiers…>` then `.spec`/`.status`. */
export const RECORD_KINDS: Record<string, RecordKindDef> = {
  svc: {
    kind: "svc",
    qualifiers: [qEndpoint, qUid("instanceId")],
    split: true,
    writers: { spec: "provisioner-registration", status: "instance-commit-epoch-fenced" },
    mediation: "mediated",
  },
  signer: {
    kind: "signer",
    qualifiers: [qId("keyId")],
    split: true,
    writers: { spec: "operator-registry", status: "operator-registry" },
    mediation: "mediated",
  },
  handle: {
    // Issuer-namespaced (§13.9): two issuers can never collide or cross-revoke.
    kind: "handle",
    qualifiers: [qId("issuerKeyId"), qId("id")],
    split: true,
    writers: { spec: "issuer-create-only", status: "issuer-or-operator-monotonic" },
    mediation: "mediated",
  },
  contracts: {
    // Advisory browse index; `describe` is authoritative. Readers fail loud on invalid state.
    kind: "contracts",
    qualifiers: [qEndpoint],
    split: true,
    writers: { spec: "instance", status: "instance" },
    mediation: "direct",
  },
  goal: {
    kind: "goal",
    qualifiers: [qEndpoint, qOwner("cOwner"), qOwner("cActor"), qUid("cUid"), qId("goalId")],
    split: true,
    writers: { spec: "commit-path", status: "commit-path" },
    mediation: "mediated",
  },
  goalidx: {
    // The MANAGER-ENDPOINT reconcile index (P2 item 2 must-5, Q-B): one atomic unsplit key per
    // IN-FLIGHT action goal, `goalidx.<e>.<cOwner>.<cActor>.<cUid>.<goalId>`, written CREATE-ONLY
    // by the goal-writer BEFORE the goal bind and DELETED at the terminal. It is the endpoint's
    // OWN durable list of accepted-but-unterminal goals: a successor incarnation (a manager
    // restart takes a fresh instanceId, so the in-memory acceptance map is gone) enumerates
    // `goalidx.<e>.>` over the provisioner and settles every orphan, never dropping an accepted
    // goal. NARROW by construction: a dedicated index the goal-writer alone writes — NOT a broad
    // read over the caller-scoped `goal.<triple>.>` records (the rejected sealed-scanner option).
    // The value carries the goal ref coordinates so the sweep rebuilds the GoalRef without parsing
    // owner/actor tokens out of the key.
    kind: "goalidx",
    qualifiers: [qEndpoint, qOwner("cOwner"), qOwner("cActor"), qUid("cUid"), qId("goalId")],
    split: false,
    writers: { spec: "commit-path", status: "commit-path" },
    mediation: "mediated",
  },
  cp: {
    kind: "cp",
    qualifiers: [qEndpoint, qId("token")],
    split: true,
    writers: { spec: "commit-path", status: "commit-path" },
    mediation: "mediated",
  },
  lease: {
    // The item's acceptance identity (§13.2) keys the lease.
    kind: "lease",
    qualifiers: [qEndpoint, { name: "pool", assert: assertPoolToken }, qOwner("cOwner"), qOwner("cActor"), qUid("cUid"), qId("id")],
    split: true,
    writers: { spec: "pool-owner-lease-command", status: "pool-owner-lease-command" },
    mediation: "mediated",
  },
  run: {
    // The WORKFLOW RUN record: `run.<endpoint>.<runId>`, the last-value-wins state beside the
    // append-only step journal on WFJ. The journal says what happened; this says what the run IS.
    //
    // It is a record rather than a journal entry precisely because it is last-value-wins: the
    // lease holder, the run's state, the artifact refs, and — the part that must never be
    // recomputed — the PIN SET resolved once at run start: seed, startedAt, yieldEvery, stepBudget,
    // effectCeiling, languageVersion. Every one of those selects which effects run, so a resume
    // reads them back and binds them rather than re-deriving them from its own host: `startedAt`
    // is the run's logical epoch, and a resumed run that took the resuming machine's clock would
    // measure an elapsed time the recorded run never saw.
    //
    // `<endpoint>` leads because the driver is hosted by an endpoint (the manager daemon), so a
    // retirement drain and a per-endpoint enumeration both work by prefix. It is a CORE kind and
    // not a registration: `registerRecordKind` reserves single-label names for core.
    kind: "run",
    qualifiers: [qEndpoint, qId("runId")],
    split: true,
    writers: { spec: "commit-path", status: "commit-path" },
    mediation: "mediated",
  },
  answer: {
    // The CHECKPOINT ANSWER: `answer.<endpoint>.<token>.<answerId>`, the payload half of a
    // checkpoint resume. The one-use settle fact stays the small arbiter of the race and NAMES the
    // answerId it accepted; this is where the value and the artifact digest live.
    //
    // `<answerId>` is in the KEY rather than one slot per token because a workflow checkpoint's
    // holder is the run driver and every resolver presents as it: keyed by presenter, two racing
    // resolvers overwrite one slot and the settle fact selects whichever wrote last instead of the
    // one that won. Per-answer keys plus a named winner is the discriminator that key lacked.
    //
    // ATOMIC and create-only: an answer is one thing that happened, written once before its token
    // is presented, never updated and never deleted.
    kind: "answer",
    qualifiers: [qEndpoint, qId("token"), qId("answerId")],
    split: false,
    writers: { spec: "commit-path", status: "commit-path" },
    mediation: "mediated",
  },
  notice: {
    // The RUN NOTICE: `notice.<endpoint>.<runId>.<addresseeId>.<noticeId>`, one bounded decision
    // record written onto the run and addressed to one agent, rendered ahead of that agent's next
    // turn. It is a record and NOT a channel post on purpose: a notice is program-authored bytes
    // moving toward an agent's context, and a channel post would put the program into the
    // conversation as a participant.
    //
    // `<addresseeId>` is DERIVED from the agent's name rather than being the name: an agent name is
    // dotted and a dot is the key separator, so a raw name would silently re-tokenize the key into
    // a different shape. The reader holds the handle and re-derives the same id, so per-addressee
    // enumeration is still one prefix scan.
    //
    // SPLIT because consumption is a fact somebody else establishes later: the spec is the notice
    // (immutable, create-only — a notice is something the program decided) and the status is its
    // consumption, which migrate reads to refuse moving a run whose notice has not landed yet.
    kind: "notice",
    qualifiers: [qEndpoint, qId("runId"), qId("addresseeId"), qId("noticeId")],
    split: true,
    writers: { spec: "commit-path", status: "commit-path" },
    mediation: "mediated",
  },
  migration: {
    // The MIGRATION: `migration.<endpoint>.<runId>.<migrationId>`, one run's move onto edited
    // source — what the walk found, which refusals a person overrode, and who they were.
    //
    // ITS OWN KIND BECAUSE IT IS NEITHER HALF OF THE RUN RECORD. A run's spec is what the run IS,
    // decided once; its status is what the run is DOING, rewritten by every driver heartbeat. A
    // migration is neither: it is append-only history with an actor on it, and a run can be
    // migrated more than once. Last-value-wins would let the second migration erase the first's
    // history; create-only on the run record would collide with the run's own spec.
    //
    // `<migrationId>` is DERIVED FROM THE REPORT'S CONTENT, and that is not a stylistic choice: a
    // migration is decided from a dry walk that may be re-run after a crash, so the same decision
    // must land on the same record rather than filing a second one — and a counter would need a
    // reader-writer to allocate it, which is a second arbiter for a fact the content already
    // determines. The same reasoning as `notice`, for the same reason.
    //
    // SPLIT because deciding and APPLYING are different acts by different parties at different
    // times: the spec is the report (immutable — what the check found), the status is the commit
    // (create-only — which driver actually advanced the run, decided by the CAS and by nothing
    // else, so two drivers racing to apply one migration cannot both believe they did).
    kind: "migration",
    qualifiers: [qEndpoint, qId("runId"), qId("migrationId")],
    split: true,
    writers: { spec: "commit-path", status: "commit-path" },
    mediation: "mediated",
  },
  lifecycle: {
    // The optional per-UID append-only audit detail — never the authority (that is the HEAD).
    kind: "lifecycle",
    qualifiers: [qOwner("owner"), qOwner("actor"), qUid("lifecycleUid")],
    split: true,
    writers: { spec: "minting-manager-commit", status: "minting-manager-commit" },
    mediation: "mediated",
  },
};

/** The canonical AUTHORITY-CONTROL record kinds (§13.9): the mapping head, the UID reservation,
 *  the governance/policy heads, the acceptance obligation, and the retirement frontier. This is
 *  the SINGLE SOURCE consumed BOTH by the registry below AND by the record-reader seam
 *  ({@link ../endpoint-binding.ts}.recordReaderConfig): a caller reader durable may target NONE of
 *  these authority-only subtrees (nats-server#8274, the sealed records scanner owns `oblig.`), so
 *  adding a kind here extends registration AND the reader exclusion together — no parallel
 *  hand-kept deny-list to drift. `lifecycle` is DUAL: its atomic HEAD (`LIFECYCLE_HEAD`) is
 *  authority, while its deeper per-UID `RECORD_KINDS.lifecycle` detail is a caller-readable audit
 *  record; the seam admits the detail but head-guards the atomic key. */
export const AUTHORITY_KIND_DEFS: readonly RecordKindDef[] = [
  LIFECYCLE_HEAD, UID_RESERVATION, GOVERN_HEAD, OBLIGATION, POLICY_VERSION, RETIREMENT_FRONTIER,
];

/** RUNTIME-freeze a def: `readonly` is type-level only, and this module's collections are a
 *  SECURITY classification the reader seam consults, so identity (built here) must also be
 *  integrity (unchangeable after export). Every def, its qualifiers array, each qualifier, and
 *  its writers object freeze; under ESM strict mode a later mutation THROWS instead of silently
 *  removing an exclusion or a head guard (the panel's identity-vs-integrity class, the same as
 *  the sealed-scanner handle). */
function freezeDef(def: RecordKindDef): RecordKindDef {
  for (const q of def.qualifiers) Object.freeze(q);
  Object.freeze(def.qualifiers);
  Object.freeze(def.writers);
  return Object.freeze(def);
}

const registry = new Map<string, RecordKindDef[]>();
for (const def of [...Object.values(RECORD_KINDS), ...AUTHORITY_KIND_DEFS]) {
  freezeDef(def);
  const list = registry.get(def.kind) ?? [];
  list.push(def);
  registry.set(def.kind, list);
}
Object.freeze(AUTHORITY_KIND_DEFS);
Object.freeze(RECORD_KINDS);

/** The record-reader ALLOWLIST predicate (§13.9): a kind is CALLER-READABLE iff the registry holds
 *  a def for it that is NOT an authority-control def — a caller `RECORD_KIND` (core or a registered
 *  third-party kind). A PURE authority kind (`oblig`/`uid`/`govern`/`policy`/`frontier`) and any
 *  UNREGISTERED kind return false (a reader may target neither); a DUAL-token kind (`lifecycle`)
 *  returns true because its audit detail is readable, and the seam then head-guards it. The
 *  record-reader seam calls this instead of a deny-list, so an unregistered/authority kind can
 *  never pass and a new authority kind added to {@link AUTHORITY_KIND_DEFS} is excluded by
 *  construction. */
const AUTHORITY_DEF_SET: ReadonlySet<RecordKindDef> = new Set(AUTHORITY_KIND_DEFS);
export function callerReadableRecordKind(kind: string): boolean {
  const defs = registry.get(kind);
  return defs !== undefined && defs.some((d) => !AUTHORITY_DEF_SET.has(d));
}

/** Register a third-party record kind. Reverse-DNS names ONLY — single-label kind names are
 *  reserved for the kinds this module pins (§13.7); a re-registration throws, no silent
 *  replacement. The kind name tokenizes `.`→`_` exactly like an endpoint name. */
export function registerRecordKind(def: Omit<RecordKindDef, "kind"> & { kind: string }): RecordKindDef {
  const kindToken = endpointToken(def.kind);
  if (!kindToken.includes("_"))
    throw new Error(`record kind "${def.kind}" is single-label: those are reserved for core kinds; third-party kinds are reverse-DNS (SPEC 13.7)`);
  const entry: RecordKindDef = { ...def, kind: kindToken };
  const list = registry.get(kindToken) ?? [];
  if (list.some((d) => d.qualifiers.length === entry.qualifiers.length && d.split === entry.split))
    throw new Error(`record kind "${def.kind}" is already registered with this key arity`);
  freezeDef(entry); // registered defs carry the same runtime integrity as the core ones
  list.push(entry);
  registry.set(kindToken, list);
  return entry;
}

// ---- key grammar (§13.7): build and parse ---------------------------------------------------

function baseTokens(def: RecordKindDef, qualifiers: string[]): string[] {
  if (qualifiers.length !== def.qualifiers.length)
    throw new Error(`record kind "${def.kind}" takes ${def.qualifiers.length} qualifier(s) (${def.qualifiers.map((q) => q.name).join(", ")}); got ${qualifiers.length}`);
  return [def.kind, ...def.qualifiers.map((q, i) => q.assert(qualifiers[i]))];
}

/** The unsplit key of an atomic kind (the lifecycle head). Throws for a split kind. */
export function recordAtomicKey(def: RecordKindDef, qualifiers: string[]): string {
  if (def.split) throw new Error(`record kind "${def.kind}" is .spec/.status-split; it has no atomic key`);
  return baseTokens(def, qualifiers).join(".");
}

/** The `.spec` key of a split kind. */
export function recordSpecKey(def: RecordKindDef, qualifiers: string[]): string {
  if (!def.split) throw new Error(`record kind "${def.kind}" is atomic; it has no .spec key`);
  return [...baseTokens(def, qualifiers), "spec"].join(".");
}

/** The `.status` key of a split kind. */
export function recordStatusKey(def: RecordKindDef, qualifiers: string[]): string {
  if (!def.split) throw new Error(`record kind "${def.kind}" is atomic; it has no .status key`);
  return [...baseTokens(def, qualifiers), "status"].join(".");
}

export interface ParsedRecordKey {
  def: RecordKindDef;
  qualifiers: string[];
  part: "spec" | "status" | "atomic";
}

/** Parse a records-bucket key against the registry. `null` = no registered grammar matches —
 *  fail-closed, MUST NOT be handled (an unknown kind throws at the caller, no silent fallback).
 *  Split-only trust model as in the subject parser: shape and registry dispatch here; token
 *  grammars were enforced at build/mint time. */
export function parseRecordKey(key: string): ParsedRecordKey | null {
  const toks = key.split(".");
  const candidates = registry.get(toks[0]);
  if (!candidates) return null;
  const last = toks[toks.length - 1];
  for (const def of candidates) {
    if (def.split && (last === "spec" || last === "status") && toks.length === def.qualifiers.length + 2)
      return { def, qualifiers: toks.slice(1, -1), part: last };
    if (!def.split && toks.length === def.qualifiers.length + 1)
      return { def, qualifiers: toks.slice(1), part: "atomic" };
  }
  return null;
}

// ---- split-key CAS writes (§13.4/§13.8: a lost CAS is a LOUD conflict) ----------------------

function encodeValue(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}

/** JetStream's expected-last-subject-sequence failure — the ONE broker condition behind every
 *  create-only/revision-pinned CAS loss here and in the journal (§13.4/§13.8). Keyed on the
 *  STRUCTURED `err_code` (`JetStreamApiCodes.StreamWrongLastSequence` 10071 and its
 *  `…Unknown` sibling 10164, the same pair the KV client's own create() classifies), never on
 *  message text: wording varies across server versions and a missed classification would turn
 *  a benign concurrent write into an unhandled throw inside a mediated writer. */
export function isCasLoss(e: unknown): boolean {
  const code = (e as { code?: unknown })?.code;
  return code === 10071 || code === 10164;
}

function conflict(message: string, cause: unknown): never {
  const err = new EpEnvelopeError("conflict", message);
  (err as Error & { cause?: unknown }).cause = cause;
  throw err;
}

/** Create-only write of one record key, CAS-fenced against the key's ENTIRE history (a
 *  revision-0 expectation on the subject): an existing key OR a DEL/PURGE tombstone is a loud
 *  `conflict`. Deliberately NOT the KV client's own `create()`, which silently RECREATES over a
 *  tombstone — that would let whoever can delete a key re-open a one-use identity (rebind a
 *  settled checkpoint's holder, reset a decided lease, resurrect a terminal goal). Here a
 *  deletion permanently CLOSES the key (§13.8's create-only discipline; deletion is fail-closed
 *  state, never absence), and this CAS is the arbiter — a caller's marker pre-check is only a
 *  fast path, since a delete landing between check and create loses here, not there. Residual:
 *  a tombstone COMPACTED out of the bucket's history is indistinguishable from true absence at
 *  the broker; nothing in core compacts or deletes records keys, so that is operator store
 *  surgery — reconcile-the-store territory. Any other broker failure propagates untranslated.
 *  Returns the created revision. */
export async function createRecordEntry(kv: KV, key: string, value: unknown): Promise<number> {
  try {
    return await kv.put(key, encodeValue(value), { previousSeq: 0 });
  } catch (e) {
    if (isCasLoss(e)) conflict(`create of ${key} lost its CAS: the key already exists or carries a deletion marker (re-read and re-decide, SPEC 13.8)`, e);
    throw e;
  }
}

/** Revision-pinned CAS update of one record key. A moved revision is a loud `conflict`; any
 *  other broker failure propagates untranslated. Returns the new revision. */
export async function updateRecordEntry(kv: KV, key: string, value: unknown, expectedRevision: number): Promise<number> {
  try {
    return await kv.update(key, encodeValue(value), expectedRevision);
  } catch (e) {
    if (isCasLoss(e)) conflict(`update of ${key} at revision ${expectedRevision} lost its CAS (re-read and re-decide, SPEC 13.8)`, e);
    throw e;
  }
}

/** Status values MUST carry `observedSpecRevision` (§13.4) — the merged-read staleness rules
 *  key on it. Enforced at the write seam so a status without it can never exist. */
export function assertStatusValue<T extends Record<string, unknown>>(value: T): T & { observedSpecRevision: number } {
  const o = value.observedSpecRevision;
  if (typeof o !== "number" || !Number.isSafeInteger(o) || o < 0)
    throw new Error(`a record status value must carry a non-negative integer observedSpecRevision (SPEC 13.4); got ${JSON.stringify(o)}`);
  return value as T & { observedSpecRevision: number };
}

// ---- merged read (§13.4 staleness discipline) -----------------------------------------------

export interface MergedRecord<S = unknown, T = unknown> {
  spec: { value: S; revision: number };
  status?: { value: T; revision: number; observedSpecRevision: number };
  /** §13.4: `observedSpecRevision < spec.revision` is a STALE-BUT-VALID level-triggered
   *  projection, not an error. `false` when status is absent or caught up. */
  staleProjection: boolean;
}

function decodeEntry<T>(e: KvEntry, key: string): T {
  try {
    return e.json<T>();
  } catch (err) {
    // Mediated-writer state that does not decode is a writer bug; readers fail loud (§13.9).
    throw new EpEnvelopeError("internal", `record ${key} does not decode as JSON: ${(err as Error).message}`);
  }
}

const liveEntry = (e: KvEntry | null): e is KvEntry => !!e && e.operation === "PUT";

/** §13.8 retry/backoff: exponential, base 250 ms, factor 2, cap 15 s, full jitter. */
function backoffMs(attempt: number): number {
  return Math.random() * Math.min(15_000, 250 * 2 ** attempt);
}

/** Merged logical read of a split record (§13.4): both keys, both revisions, the staleness
 *  classification. `observedSpecRevision > spec.revision` (a lagging spec read, possible across
 *  replica freshness points) triggers bounded spec re-reads until caught up or the deadline —
 *  the mismatched pair is NEVER returned. Absent record → `undefined`; a status without its
 *  spec is torn state → `failed-precondition`. */
export async function readRecord<S = unknown, T = unknown>(
  kv: KV,
  def: RecordKindDef,
  qualifiers: string[],
  opts: { deadlineMs?: number } = {},
): Promise<MergedRecord<S, T> | undefined> {
  const sKey = recordSpecKey(def, qualifiers);
  const tKey = recordStatusKey(def, qualifiers);
  const deadline = Date.now() + (opts.deadlineMs ?? 15_000);

  let specEntry = await kv.get(sKey);
  let statusEntry = await kv.get(tKey);

  // Absent spec + live status is USUALLY a read-order artifact, not corruption: the spec get
  // can land just before an ordered create commits spec-then-status, both visible by the time
  // the status get runs. Stabilize with bounded spec re-reads (re-checking status in case the
  // record is mid-deletion) and declare torn state only when the absence is STABLE across the
  // deadline — a transient interleaving must never be classified as corruption (§13.4).
  for (let attempt = 0; !liveEntry(specEntry) && liveEntry(statusEntry); attempt++) {
    if (Date.now() >= deadline)
      throw new EpEnvelopeError("failed-precondition", `record ${tKey} exists without its spec key (stable across bounded re-reads); torn record state, refusing to read`);
    await new Promise((r) => setTimeout(r, Math.min(backoffMs(attempt), Math.max(0, deadline - Date.now()))));
    specEntry = await kv.get(sKey);
    if (!liveEntry(specEntry)) statusEntry = await kv.get(tKey);
  }
  if (!liveEntry(specEntry)) return undefined;

  if (!liveEntry(statusEntry)) {
    return { spec: { value: decodeEntry<S>(specEntry, sKey), revision: specEntry.revision }, staleProjection: false };
  }

  const statusValue = decodeEntry<T & { observedSpecRevision: unknown }>(statusEntry, tKey);
  const observed = statusValue.observedSpecRevision;
  if (typeof observed !== "number" || !Number.isSafeInteger(observed) || observed < 0)
    throw new EpEnvelopeError("internal", `record ${tKey} carries no valid observedSpecRevision (SPEC 13.4)`);

  // A lagging spec read: re-read the spec key, bounded, until it catches up to what the status
  // writer demonstrably observed. Never trust the mismatched pair (§13.4).
  for (let attempt = 0; (specEntry?.revision ?? 0) < observed; attempt++) {
    if (Date.now() >= deadline)
      throw new EpEnvelopeError("deadline-exceeded", `spec ${sKey} (revision ${specEntry?.revision}) never caught up to the status writer's observed revision ${observed} within the deadline`);
    await new Promise((r) => setTimeout(r, Math.min(backoffMs(attempt), Math.max(0, deadline - Date.now()))));
    specEntry = await kv.get(sKey);
    if (!liveEntry(specEntry))
      throw new EpEnvelopeError("failed-precondition", `record ${sKey} disappeared while resolving a lagging spec read`);
  }

  return {
    spec: { value: decodeEntry<S>(specEntry as KvEntry, sKey), revision: (specEntry as KvEntry).revision },
    status: { value: statusValue as T, revision: statusEntry.revision, observedSpecRevision: observed },
    staleProjection: observed < (specEntry as KvEntry).revision,
  };
}

/** Read an atomic (unsplit) record — the lifecycle head. NOT a fence: an authority read of the
 *  head (mapping currency before effect) is a leader-served `STREAM.MSG.GET` by the trusted
 *  mapping-reader (§13.9); this helper is the ordinary non-fencing read, and every fence is a
 *  revision-pinned CAS write against the returned revision. */
export async function readAtomicRecord<V = unknown>(
  kv: KV,
  def: RecordKindDef,
  qualifiers: string[],
): Promise<{ value: V; revision: number } | undefined> {
  const key = recordAtomicKey(def, qualifiers);
  const e = await kv.get(key);
  if (!liveEntry(e)) return undefined;
  return { value: decodeEntry<V>(e, key), revision: e.revision };
}

// ---- merged watch (§13.4/§13.8 snapshot-then-deltas, resync on gap) -------------------------

/** Watch a split record: the current merged snapshot first, then a re-merged view per delta.
 *
 *  Cursor discipline (§13.4/§13.8): ONE ordered consumer supplies BOTH the snapshot (the
 *  per-key last values the watch replays first) and the deltas after it — the cursor is the
 *  consumer's own position, so nothing between "snapshot" and "watch start" can ever be
 *  skipped. (A cursor derived from independent `get` reads — `max(specRev,statusRev)+1` — is
 *  provably gap-prone: mixed-freshness/TOCTOU reads let a higher revision on one key jump the
 *  resume point past an unseen update on the other.) Replay entries accumulate silently; the
 *  first merged view is yielded when the replay completes, and every later delta re-yields the
 *  merged view. A watcher that errors, ends, or observes a status ahead of its cached spec
 *  (impossible from honest writers in an unbroken ordered watch) RESYNCS with a fresh consumer
 *  — a fresh full snapshot, duplicates tolerated, never a patch across a gap.
 *
 *  Resyncs are budgeted on CONSECUTIVE no-progress incarnations, reset once an incarnation
 *  delivers at least one ordered post-snapshot delta (a lifetime-cumulative budget would kill a
 *  long-lived watch on accumulated benign blips; a snapshot alone must not count as progress or
 *  an immediately-ending iterator would spin forever). Ends when the spec key is deleted (the
 *  record is retired — a watch started on an already-retired record ends immediately) or when
 *  `signal` aborts. A status whose spec key NEVER existed in the consistent replay view is real
 *  torn state (`failed-precondition`) — the single-consumer view cannot false-positive this. */
export async function* watchRecord<S = unknown, T = unknown>(
  kv: KV,
  def: RecordKindDef,
  qualifiers: string[],
  opts: { signal?: AbortSignal; maxResyncs?: number } = {},
): AsyncGenerator<MergedRecord<S, T>, void, void> {
  const sKey = recordSpecKey(def, qualifiers);
  const tKey = recordStatusKey(def, qualifiers);
  const maxResyncs = opts.maxResyncs ?? 8;

  let consecutiveNoProgress = 0;
  for (;;) {
    if (consecutiveNoProgress > maxResyncs)
      throw new EpEnvelopeError("unavailable", `watch of ${sKey} exhausted ${maxResyncs} consecutive resyncs without delta progress`);

    // Last values + updates from one ordered consumer. The client marks replay entries with
    // isUpdate=false up to the LAST initial entry (which arrives with isUpdate=true) — so the
    // first isUpdate=true entry completes the snapshot, and a zero-entry replay (absent record)
    // yields nothing until the first live delta arrives.
    const iter = await kv.watch({ key: [sKey, tKey] });
    const stop = () => iter.stop();
    opts.signal?.addEventListener("abort", stop, { once: true });

    let spec: MergedRecord<S, T>["spec"] | undefined;
    let status: MergedRecord<S, T>["status"] | undefined;
    let specSeen = false; // a DEL/PURGE last value counts as seen (retired), just not live
    let initialized = false;
    let progressed = false;
    const merged = (): MergedRecord<S, T> | undefined =>
      spec
        ? { spec, ...(status ? { status } : {}), staleProjection: !!status && status.observedSpecRevision < spec.revision }
        : undefined;

    try {
      for await (const e of iter) {
        if (opts.signal?.aborted) return;
        const completesReplay = !initialized && e.isUpdate;
        if (e.key === sKey) {
          specSeen = true;
          if (e.operation !== "PUT") return; // spec deleted: the record is (or was) retired
          spec = { value: decodeEntry<S>(e, sKey), revision: e.revision };
        } else if (e.key === tKey) {
          if (e.operation !== "PUT") {
            status = undefined;
          } else {
            const v = decodeEntry<T & { observedSpecRevision: unknown }>(e, tKey);
            const observed = v.observedSpecRevision;
            if (typeof observed !== "number" || !Number.isSafeInteger(observed) || observed < 0)
              throw new EpEnvelopeError("internal", `record ${tKey} carries no valid observedSpecRevision (SPEC 13.4)`);
            // Within replay, a status may precede its spec in stream order (older last value
            // first) — judge coherence only once the replay's consistent view is complete.
            if ((initialized || completesReplay) && spec && observed > spec.revision) break; // status ahead of spec: writer anomaly — resync, never patch forward
            status = { value: v as T, revision: e.revision, observedSpecRevision: observed };
          }
        }
        if (!initialized && !e.isUpdate) continue; // mid-replay: accumulate silently
        if (completesReplay) {
          initialized = true;
          // The replay is a consistent view: a live status whose spec key never appeared is
          // REAL torn state, not a read-order artifact — fail loud, never relist over it.
          if (status && !specSeen)
            throw new EpEnvelopeError("failed-precondition", `record ${tKey} exists without its spec key in a consistent watch replay; torn record state`);
        } else {
          progressed = true;
        }
        // Never yield a mismatched ahead-pair — a status observed a spec revision higher than the
        // one we hold (a re-read signal, §13.4). The per-status-entry check above catches a
        // status DELTA arriving ahead; this universal guard also catches the replay case where a
        // status was cached first and the SPEC entry then completed replay behind it, which that
        // check would miss (it fires only while processing a status entry).
        if (spec && status && status.observedSpecRevision > spec.revision) break; // resync, never patch forward
        const m = merged();
        if (m) yield m;
      }
      if (opts.signal?.aborted) return;
      // gap-break or iterator end: stream hiccup / writer anomaly — resync below
    } catch (e) {
      if (e instanceof EpEnvelopeError && (e.code === "internal" || e.code === "failed-precondition")) throw e; // writer bug, not a gap
      // watcher transport error — resync from a fresh consumer
    } finally {
      opts.signal?.removeEventListener("abort", stop);
      iter.stop();
    }
    if (opts.signal?.aborted) return;
    consecutiveNoProgress = progressed ? 0 : consecutiveNoProgress + 1;
  }
}
