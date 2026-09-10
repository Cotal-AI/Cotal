/**
 * Issued authority (SPEC §13.15): binding one invocation to an IMMUTABLE, issuer-accepted
 * permission ceiling, separate from caller identity.
 *
 * `EpCaller` says who is calling. An issued authority says what the credential they are calling
 * with was granted, as the issuer accepted it, and it is what a hosted effect performed on the
 * caller's behalf is confined by. It rides the request subject on a versioned rail
 * (`ep.v1`, the generation second-to-last before the nonce), so the broker pins it with the same
 * grant discipline that pins the caller triple: a credential can publish under exactly the
 * generation its rows name, and a legacy credential cannot publish on the versioned rail at all.
 *
 * Three things live here, in the order an issuance runs them:
 *  - the reference and the permission model (what a ceiling IS: explicit `all`/`none`/`patterns`
 *    allow plus deny, imported from the native JWT fragment so an omitted list can never read as
 *    a narrow one);
 *  - the evidence store (`cotal_issued_<space>`): immutable evidence, a one-field attempt row
 *    whose state is `prepared | active | aborted | revoked`, and a reverse index from each source
 *    gate to the issuances that depend on it. Create-only; a generation is never reused;
 *    activation is a CAS at the revision the prepare observed;
 *  - the accepted row (`cotal_accepted_<space>`): how a connected client learns which generation
 *    the issuer bound, by reading one row keyed by a token it chose, over a per-key `DIRECT.GET`
 *    grant its ceiling carries. The client never trusts what it proposed or what a file says.
 *
 * What this does NOT establish: that a request arriving on a generation-pinned subject was
 * published by the grant holder. Origin is a property of the current grant set (no peer-held
 * profile pairs a write with a raw stream read on one stream), guarded by the auth census, and
 * mediated reads stay the remedy.
 */
import { randomBytes } from "node:crypto";
import { DiscardPolicy, type JetStreamManager, type MsgRequest } from "@nats-io/jetstream";
import type { KV, Kvm } from "@nats-io/kv";
import type { NatsConnection } from "@nats-io/transport-node";
import { canonicalJson, rawDigest } from "./canonical.js";
import { EpEnvelopeError } from "./endpoint-envelope.js";
import { isCasLoss } from "./endpoint-records.js";
import { assertGeneration, callerTokens, endpointToken, type EpCaller } from "./endpoint-subjects.js";
export { assertGeneration, isIssuedCaller, EP_RAIL_V1, type IssuedCaller } from "./endpoint-subjects.js";
import { subjectMatches, token } from "./subjects.js";

// ---- the reference -------------------------------------------------------------------------------

/** The four caller coordinates plus the generation. `generation` is 32 lowercase hex characters
 *  of issuer-chosen entropy (at least 128 bits); it is an identifier, never a bearer secret. */
export interface IssuedAuthorityRef extends EpCaller {
  readonly space: string;
  readonly generation: string;
}

/** A fresh generation: 128 bits, hex. Chosen by the ISSUER, never by the client. */
export function mintGeneration(): string {
  return randomBytes(16).toString("hex");
}

/** A fresh accepted-row token: same grammar, chosen by the party that will connect. */
export function mintAcceptedToken(): string {
  return randomBytes(16).toString("hex");
}

function refSnapshot(value: IssuedAuthorityRef): IssuedAuthorityRef {
  closed(value, ["space", "owner", "actor", "uid", "generation"], "issued reference");
  endpointToken(value.space);
  callerTokens(value);
  assertGeneration(value.generation);
  return Object.freeze({ space: value.space, owner: value.owner, actor: value.actor, uid: value.uid, generation: value.generation });
}

// ---- the permission model ------------------------------------------------------------------------

/** One direction's allow set. Explicit: the native fragment's omitted or empty `allow` means
 *  UNRESTRICTED, and a ceiling that read that as "nothing" would be exactly the inversion a
 *  copied ledger row produces, so the mode is always spelled out. */
export type IssuedSubjectAllow =
  | { readonly mode: "all" }
  | { readonly mode: "none" }
  | { readonly mode: "patterns"; readonly patterns: readonly string[] };

export interface IssuedSubjectPermission {
  readonly allow: IssuedSubjectAllow;
  readonly deny: readonly string[];
}

/** The ceiling: what the credential may publish and subscribe, as the broker enforces it. */
export interface IssuedSubjectPermissions {
  readonly publish: IssuedSubjectPermission;
  readonly subscribe: IssuedSubjectPermission;
}

function closed(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)
    || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null))
    throw new Error(`${label} must be a plain record`);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !keys.includes(key)) throw new Error(`${label} carries an unsupported field ${String(key)}`);
    if (!Object.hasOwn(Object.getOwnPropertyDescriptor(value, key)!, "value")) throw new Error(`${label} cannot carry accessors`);
  }
  return value as Record<string, unknown>;
}

function subjectToken(value: unknown, pattern: boolean): string {
  if (typeof value !== "string" || value.length === 0 || /\s/u.test(value)
    || [...value].some((ch) => ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127))
    throw new Error("a subject must be nonempty without whitespace or control characters; queue-qualified forms are not a ceiling entry");
  const parts = value.split(".");
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (!part || (part.includes("*") && (!pattern || part !== "*"))
      || (part.includes(">") && (!pattern || part !== ">" || i !== parts.length - 1)))
      throw new Error(`subject "${value}" has an invalid token or wildcard`);
  }
  return value;
}

function patterns(value: unknown): readonly string[] {
  if (!Array.isArray(value)) throw new Error("subject patterns must be an explicit array");
  return Object.freeze(value.map((entry) => subjectToken(entry, true)));
}

function permission(allow: IssuedSubjectAllow, deny: readonly string[]): IssuedSubjectPermission {
  return Object.freeze({ allow: Object.freeze(allow), deny });
}

/** Read a stored permission value back, refusing every shape but the explicit one. */
export function readIssuedSubjectPermission(value: unknown): IssuedSubjectPermission {
  const raw = closed(value, ["allow", "deny"], "subject permission");
  const allow = closed(raw.allow, ["mode", "patterns"], "subject allow");
  const deny = patterns(raw.deny);
  if (allow.mode === "all" || allow.mode === "none") {
    if (Object.hasOwn(allow, "patterns")) throw new Error("only patterns mode carries a patterns field");
    return permission({ mode: allow.mode }, deny);
  }
  if (allow.mode !== "patterns") throw new Error("unsupported subject allow mode");
  const listed = patterns(allow.patterns);
  if (listed.length === 0) throw new Error("patterns mode requires a nonempty list");
  return permission({ mode: "patterns", patterns: listed }, deny);
}

export function readIssuedSubjectPermissions(value: unknown): IssuedSubjectPermissions {
  const raw = closed(value, ["publish", "subscribe"], "issued permissions");
  return Object.freeze({ publish: readIssuedSubjectPermission(raw.publish), subscribe: readIssuedSubjectPermission(raw.subscribe) });
}

/** The native NATS fragment (`{pub, sub}` with `allow`/`deny` lists) as the JWT carries it: an
 *  omitted or empty allow is UNRESTRICTED subject to denies. This is the one importer, and it
 *  takes the fragment, never a whole JWT: `resp` and queue-qualified rows need semantics of their
 *  own and are refused rather than dropped. */
export function importNativeSubjectPermissions(value: unknown): IssuedSubjectPermissions {
  const raw = closed(value, ["pub", "sub"], "native permissions");
  const direction = (v: unknown): IssuedSubjectPermission => {
    if (v === undefined) return permission({ mode: "all" }, Object.freeze([]));
    const r = closed(v, ["allow", "deny"], "native subject permission");
    const allow = Object.hasOwn(r, "allow") ? patterns(r.allow) : Object.freeze([]);
    const deny = Object.hasOwn(r, "deny") ? patterns(r.deny) : Object.freeze([]);
    return permission(allow.length ? { mode: "patterns", patterns: allow } : { mode: "all" }, deny);
  };
  for (const key of ["pub", "sub"]) if (Object.hasOwn(raw, key) && raw[key] === undefined) throw new Error("an explicit native direction must not be undefined");
  return Object.freeze({ publish: direction(raw.pub), subscribe: direction(raw.sub) });
}

/** Does the ceiling permit ONE concrete subject? Deny wins; `none` permits nothing. */
export function issuedPermitsSubject(value: IssuedSubjectPermission, concrete: string): boolean {
  const parsed = readIssuedSubjectPermission(value);
  subjectToken(concrete, false);
  if (parsed.deny.some((pattern) => subjectMatches(pattern, concrete))) return false;
  if (parsed.allow.mode === "none") return false;
  return parsed.allow.mode === "all" || parsed.allow.patterns.some((pattern) => subjectMatches(pattern, concrete));
}

/** Does policy pattern `cap` cover EVERY subject `pattern` matches? Token-wise, both in the
 *  NATS grammar; a non-terminal `>` on either side fails closed. */
function patternCovers(cap: string, pattern: string): boolean {
  const c = cap.split(".");
  const p = pattern.split(".");
  if (c.slice(0, -1).includes(">") || p.slice(0, -1).includes(">")) return false;
  for (let i = 0; i < c.length; i++) {
    if (c[i] === ">") return p.length > i;
    if (i >= p.length) return false;
    if (c[i] === "*") { if (p[i] === ">") return false; continue; }
    if (c[i] !== p[i]) return false;
  }
  return c.length === p.length;
}

/** Could patterns `a` and `b` match one common subject? Conservative: a `>` on either side past
 *  the common prefix counts as overlap. */
function patternsOverlap(a: string, b: string): boolean {
  const x = a.split(".");
  const y = b.split(".");
  const n = Math.max(x.length, y.length);
  for (let i = 0; i < n; i++) {
    const s = x[i], t = y[i];
    if (s === ">" || t === ">") return true;
    if (s === undefined || t === undefined) return false;
    if (s === "*" || t === "*") continue;
    if (s !== t) return false;
  }
  return true;
}

/** Does the ceiling permit a SUBSCRIPTION whose filter is `pattern` (which may carry wildcards)?
 *  Every subject the filter could deliver must sit inside one allow entry, and no deny entry may
 *  overlap it: a subscription is a claim over a set of subjects, so a partial cover is a refusal,
 *  never a narrower grant invented on the caller's behalf. */
export function issuedPermitsPattern(value: IssuedSubjectPermission, pattern: string): boolean {
  const parsed = readIssuedSubjectPermission(value);
  subjectToken(pattern, true);
  if (parsed.deny.some((d) => patternsOverlap(d, pattern))) return false;
  if (parsed.allow.mode === "none") return false;
  return parsed.allow.mode === "all" || parsed.allow.patterns.some((a) => patternCovers(a, pattern));
}

// ---- the evidence store --------------------------------------------------------------------------

/** The immutable coordinate of a gate an issuance depends on: one KV row in one bucket. */
export interface IssuedSourceRef {
  readonly space: string;
  readonly bucket: string;
  readonly key: string;
}

/** What the issuer persisted, create-only, before any material was returned. `expiresAt` (unix
 *  seconds) is REQUIRED when `sources` is empty: an issuance bound to no gate is a one-shot
 *  credential's, and its liveness is its expiry. */
export interface IssuedEvidence {
  readonly version: 1;
  readonly ref: IssuedAuthorityRef;
  readonly sources: readonly IssuedSourceRef[];
  readonly permissions: IssuedSubjectPermissions;
  readonly expiresAt?: number;
}

export type IssuedAttemptState = "prepared" | "active" | "aborted" | "revoked";

export interface IssuedResolution {
  readonly evidence: IssuedEvidence;
  /** The attempt row's revision at the second (linearizing) read. */
  readonly revision: number;
}

/** The per-space evidence store. `allow_direct=false`: every read here is a fence (leader-served,
 *  revision-pinned), and Direct Get's follower reads would defeat read-your-writes. */
export function issuedBucket(space: string): string {
  return `cotal_issued_${token(space)}`;
}

/** The per-space accepted-row store. Its own bucket, and `allow_direct` ON: per-key scoping is
 *  only expressible on a `DIRECT.GET` grant, and a stream-wide `STREAM.MSG.GET` on a shared bucket
 *  would let a client read every other client's row. */
export function acceptedBucket(space: string): string {
  return `cotal_accepted_${token(space)}`;
}

export function issuedEvidenceKey(ref: IssuedAuthorityRef): string {
  const snap = refSnapshot(ref);
  return `v1.${callerTokens(snap).join(".")}.${snap.generation}`;
}

export function issuedAttemptKey(ref: IssuedAuthorityRef): string {
  return `attempt.${issuedEvidenceKey(ref)}`;
}

function sourceSnapshot(value: IssuedSourceRef): IssuedSourceRef {
  closed(value, ["space", "bucket", "key"], "issued source");
  endpointToken(value.space);
  if (typeof value.bucket !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(value.bucket)
    || typeof value.key !== "string" || value.key.length > 1024
    || !/^[a-zA-Z0-9_-]+(?:\.[a-zA-Z0-9_-]+)*$/.test(value.key))
    throw new Error("invalid issued source coordinate");
  return Object.freeze({ space: value.space, bucket: value.bucket, key: value.key });
}

/** The reverse index prefix for one source: `bysource.v1.<sha256([1, space, bucket, key])>.`.
 *  The digest keeps the key one token; the generation suffix on the full key is load-bearing, since
 *  without it a reused root credential id would merge two issuances into one entry. */
export function issuedSourcePrefix(source: IssuedSourceRef): string {
  const s = sourceSnapshot(source);
  return `bysource.v1.${rawDigest(JSON.stringify([1, s.space, s.bucket, s.key])).slice("sha256:".length)}.`;
}

export function issuedSourceIndexKey(source: IssuedSourceRef, ref: IssuedAuthorityRef): string {
  if (source.space !== ref.space) throw new Error("an issued source names a foreign space");
  return issuedSourcePrefix(source) + issuedEvidenceKey(ref).slice("v1.".length);
}

function evidenceSnapshot(value: IssuedEvidence): IssuedEvidence {
  const raw = closed(value, ["version", "ref", "sources", "permissions", "expiresAt"], "issued evidence");
  if (raw.version !== 1 || !Array.isArray(raw.sources)) throw new Error("unsupported issued evidence");
  const ref = refSnapshot(raw.ref as IssuedAuthorityRef);
  const sources = Object.freeze((raw.sources as IssuedSourceRef[]).map(sourceSnapshot));
  for (const source of sources) if (source.space !== ref.space) throw new Error("an issued source names a foreign space");
  if (new Set(sources.map(issuedSourcePrefix)).size !== sources.length) throw new Error("duplicate issued source");
  const expiresAt = raw.expiresAt;
  if (expiresAt !== undefined && (typeof expiresAt !== "number" || !Number.isSafeInteger(expiresAt) || expiresAt <= 0))
    throw new Error("issued evidence expiresAt must be a positive integer (unix seconds)");
  if (sources.length === 0 && expiresAt === undefined)
    throw new Error("an issuance bound to no source gate must carry expiresAt; nothing else can end its liveness");
  const permissions = readIssuedSubjectPermissions(raw.permissions);
  return Object.freeze({ version: 1, ref, sources, permissions, ...(expiresAt !== undefined ? { expiresAt } : {}) });
}

export interface PreparedIssuance { readonly key: string }

/** The store bound to one space over one KV handle. The KV is the ISSUER's (a `issuer` or a
 *  `issued-reader` credential); a peer holds no grant on this bucket. */
export interface IssuedStore {
  /** Persist the evidence and a `prepared` attempt, create-only. A generation that already exists
   *  refuses before the CAS, and the CAS is the second line. Nothing is released here. */
  stage(evidence: IssuedEvidence): Promise<PreparedIssuance>;
  /** Run the existing finalizer, then activate by CAS at the revision the prepare observed. If
   *  the finalizer succeeds and the activation loses, the issuance is retired and the call throws:
   *  no material may be released on it. */
  release(prepared: PreparedIssuance, finalizeExisting: () => Promise<void>): Promise<void>;
  /** `prepared` becomes `aborted`, `active` becomes `revoked`; idempotent on a terminal state. */
  retire(ref: IssuedAuthorityRef): Promise<IssuedAttemptState>;
  /** The resolution a consumer acts on: evidence read, attempt `active`, every source live (or
   *  the one-shot expiry not reached), and the attempt still `active` at the SAME revision on a
   *  second read after the source await. That second read is the linearization point. A failed
   *  read on either side is a refusal, never an absence of revocation. */
  resolve(ref: IssuedAuthorityRef, sourceIsLive: (source: IssuedSourceRef) => Promise<boolean>, now?: () => number): Promise<IssuedResolution>;
  /** Retire every issuance indexed under one source. The caller freezes the source gate FIRST. */
  retireSource(source: IssuedSourceRef): Promise<number>;
  /** A RENEWAL under an existing generation: the evidence must exist, its attempt must be
   *  `active`, and its recorded ceiling must EQUAL `permissions`. A generation is reused only when
   *  its immutable ceiling still matches (SPEC 13.15); a changed ceiling is a fresh issuance on a
   *  fresh generation and a new connection, never an update of this one. */
  confirm(ref: IssuedAuthorityRef, permissions: IssuedSubjectPermissions): Promise<void>;
}

/** What an issuing mint hands {@link mintCreds}: the store and accepted-row handles of an
 *  `issuer` connection, the immutable source coordinates the evidence names, and the existing
 *  finalizer (a ledger append) release runs BEFORE activation. `renew` reuses a generation whose
 *  ceiling is unchanged and stages nothing. */
export interface IssuanceSeam {
  readonly mode: "issue" | "renew";
  readonly store: IssuedStore;
  readonly accepted: KV;
  readonly sources: readonly IssuedSourceRef[];
  readonly finalize?: (credentialId: string) => Promise<void>;
}

/** The broker-enforced part of every authority store's immutability (SPEC 13.12): no rollup
 *  header, no message delete, no purge. The records store carries the same three. */
export const AUTHORITY_STORE_IMMUTABLE_FLAGS = Object.freeze({ allow_rollup_hdrs: false, deny_delete: true, deny_purge: true });
/** Write-once per key: one message per subject and `discard: new` applied per subject, so the
 *  broker refuses the SECOND message on a key whatever it carries. Other keys are unaffected. */
export const WRITE_ONCE_PER_KEY = Object.freeze({ max_msgs_per_subject: 1, discard: DiscardPolicy.New, discard_new_per_subject: true });
/** Append-only per key: unlimited per-key history, nothing ever removed. A reader that wants the
 *  row that was created reads the FIRST message on its key. */
export const APPEND_ONLY_PER_KEY = Object.freeze({ max_msgs_per_subject: -1 });

/** Every field of `shape` must read back from the broker as set; the mismatches are named. */
export function assertStoreShape(cfg: Record<string, unknown>, shape: Record<string, unknown>, bucket: string, spec: string): void {
  const drifted = Object.entries(shape).filter(([k, v]) => cfg[k] !== v).map(([k]) => `${k}=${String(cfg[k])}`);
  if (drifted.length > 0)
    throw new Error(`the authority store ${bucket} has a drifted shape (${drifted.join(", ")}); an authority store is never silently adopted - reprovision it (${spec})`);
}

/** The two issued-authority streams, for the provisioner's create-or-verify inventory. */
export function issuedStoreStreamNames(space: string): string[] {
  return [`KV_${issuedBucket(space)}`, `KV_${acceptedBucket(space)}`];
}

const enc = new TextEncoder();
const dec = new TextDecoder("utf-8", { fatal: true });
const bytes = (value: unknown): Uint8Array => enc.encode(canonicalJson(value));

export function openIssuedStore(kv: KV, jsm: JetStreamManager, space: string): IssuedStore {
  endpointToken(space);
  const bucket = issuedBucket(space);
  const stream = `KV_${bucket}`;
  const staged = new WeakMap<PreparedIssuance, { evidence: IssuedEvidence; revision: number; digest: string; consumed: boolean }>();
  const own = (ref: IssuedAuthorityRef): string => {
    if (ref.space !== space) throw new Error("issued reference names a foreign space");
    return issuedEvidenceKey(ref);
  };
  // LEADER-SERVED point read. `kv.get` on an `allow_direct=false` bucket already rides
  // STREAM.MSG.GET, but the fence is stated here rather than inherited from a client default.
  // `first` reads the FIRST message on the key: the store keeps unlimited per-key history and
  // removes nothing (see ensureIssuedStores), so the first message on an immutable row's key is
  // the row that was created, whatever was published on that key since. The attempt row reads
  // last, because it advances by CAS at the revision the last read observed.
  async function read(key: string, at: "first" | "last" = "last"): Promise<{ value: unknown; revision: number } | undefined> {
    let m;
    try {
      const subject = `$KV.${bucket}.${key}`;
      // `next_by_subj` is the wire's first-on-or-after-sequence read (STREAM.MSG.GET, no `seq`
      // means from the start); the client's request union omits it, the implementation forwards it.
      const query = (at === "first" ? { next_by_subj: subject } : { last_by_subj: subject }) as MsgRequest;
      m = await jsm.streams.getMessage(stream, query);
    } catch (e) {
      if ((e as { code?: unknown }).code === 10037) return undefined;
      throw e;
    }
    if (!m) return undefined;
    if (m.header?.get("KV-Operation"))
      throw new EpEnvelopeError("failed-precondition", `issued row ${key} carries a deletion marker; a deletion is never absence (SPEC 13.15)`);
    return { value: JSON.parse(dec.decode(m.data)), revision: m.seq };
  }
  async function readEvidence(ref: IssuedAuthorityRef): Promise<{ evidence: IssuedEvidence; digest: string }> {
    const key = own(ref);
    const entry = await read(key, "first");
    if (entry === undefined) throw new EpEnvelopeError("permission-denied", `no issued evidence for generation ${ref.generation}; an unrecorded generation authorizes nothing (SPEC 13.15)`);
    const evidence = evidenceSnapshot(entry.value as IssuedEvidence);
    if (canonicalJson(evidence.ref) !== canonicalJson(refSnapshot(ref)))
      throw new EpEnvelopeError("permission-denied", `issued evidence at ${key} names a different reference; garbled trusted state never authorizes`);
    return { evidence, digest: rawDigest(canonicalJson(evidence)) };
  }
  async function readAttempt(ref: IssuedAuthorityRef, digest: string): Promise<{ state: IssuedAttemptState; revision: number }> {
    const key = issuedAttemptKey(ref);
    const entry = await read(key);
    if (entry === undefined) throw new EpEnvelopeError("permission-denied", `no issued attempt row at ${key}; evidence without an attempt was never prepared (SPEC 13.15)`);
    const row = closed(entry.value, ["version", "state", "digest"], "issued attempt");
    if (row.version !== 1 || row.digest !== digest || !["prepared", "active", "aborted", "revoked"].includes(row.state as string))
      throw new EpEnvelopeError("permission-denied", `issued attempt row ${key} is malformed or pins a different evidence digest`);
    return { state: row.state as IssuedAttemptState, revision: entry.revision };
  }
  async function retire(ref: IssuedAuthorityRef): Promise<IssuedAttemptState> {
    const { digest } = await readEvidence(ref);
    for (let i = 0; i < 4; i++) {
      const row = await readAttempt(ref, digest);
      if (row.state === "aborted" || row.state === "revoked") return row.state;
      const state: IssuedAttemptState = row.state === "prepared" ? "aborted" : "revoked";
      try {
        await kv.update(issuedAttemptKey(ref), bytes({ version: 1, state, digest }), row.revision);
        return state;
      } catch (error) {
        if (!isCasLoss(error)) throw error;
      }
    }
    throw new Error(`retiring generation ${ref.generation} lost repeated CAS attempts`);
  }
  return Object.freeze({
    async stage(input: IssuedEvidence): Promise<PreparedIssuance> {
      const evidence = evidenceSnapshot(input);
      const key = own(evidence.ref);
      // A fresh generation only: an explicit read refuses first, the create-only CAS is the second line.
      if (await read(key, "first") !== undefined) throw new EpEnvelopeError("conflict", `generation ${evidence.ref.generation} already has issued evidence; a generation is never reused (SPEC 13.15)`);
      const digest = rawDigest(canonicalJson(evidence));
      await kv.create(key, bytes(evidence));
      const revision = await kv.create(issuedAttemptKey(evidence.ref), bytes({ version: 1, state: "prepared", digest }));
      for (const source of evidence.sources) await kv.create(issuedSourceIndexKey(source, evidence.ref), bytes({ source, ref: evidence.ref }));
      const handle: PreparedIssuance = Object.freeze({ key });
      staged.set(handle, { evidence, revision, digest, consumed: false });
      return handle;
    },
    async release(prepared: PreparedIssuance, finalizeExisting: () => Promise<void>): Promise<void> {
      const snap = staged.get(prepared);
      if (snap === undefined || snap.consumed) throw new Error("unknown or already released issuance");
      snap.consumed = true;
      try {
        await finalizeExisting();
        // At the revision the PREPARE observed, never a re-read one: a retirement that landed in
        // between wins here, and re-reading would let a released credential ride a revoked attempt.
        await kv.update(`attempt.${prepared.key}`, bytes({ version: 1, state: "active", digest: snap.digest }), snap.revision);
      } catch (error) {
        try {
          await retire(snap.evidence.ref);
        } catch (cleanup) {
          throw new AggregateError([error, cleanup], "issuance failed and its retirement is unconfirmed; no material may be released");
        }
        throw error;
      }
    },
    retire,
    async resolve(ref: IssuedAuthorityRef, sourceIsLive: (source: IssuedSourceRef) => Promise<boolean>, now: () => number = () => Math.floor(Date.now() / 1000)): Promise<IssuedResolution> {
      const { evidence, digest } = await readEvidence(ref);
      const before = await readAttempt(ref, digest);
      if (before.state !== "active") throw new EpEnvelopeError("permission-denied", `generation ${ref.generation} is ${before.state}; only an active issuance authorizes (SPEC 13.15)`);
      if (evidence.expiresAt !== undefined && now() >= evidence.expiresAt)
        throw new EpEnvelopeError("permission-denied", `generation ${ref.generation} expired at ${evidence.expiresAt} (SPEC 13.15)`);
      for (const source of evidence.sources) {
        if (!(await sourceIsLive(source)))
          throw new EpEnvelopeError("permission-denied", `generation ${ref.generation} depends on ${source.bucket}/${source.key}, which is no longer live (SPEC 13.15)`);
      }
      const after = await readAttempt(ref, digest);
      if (after.state !== "active" || after.revision !== before.revision)
        throw new EpEnvelopeError("permission-denied", `generation ${ref.generation} changed during resolution; refused (SPEC 13.15)`);
      return Object.freeze({ evidence, revision: after.revision });
    },
    async confirm(ref: IssuedAuthorityRef, permissions: IssuedSubjectPermissions): Promise<void> {
      const { evidence, digest } = await readEvidence(ref);
      const row = await readAttempt(ref, digest);
      if (row.state !== "active")
        throw new EpEnvelopeError("permission-denied", `generation ${ref.generation} is ${row.state}; a renewal rides an active issuance only (SPEC 13.15)`);
      if (canonicalJson(evidence.permissions) !== canonicalJson(readIssuedSubjectPermissions(permissions)))
        throw new EpEnvelopeError("failed-precondition", `generation ${ref.generation} was issued for a different ceiling; a permission change is a fresh generation on a new connection, never a renewal (SPEC 13.15)`);
    },
    async retireSource(source: IssuedSourceRef): Promise<number> {
      const s = sourceSnapshot(source);
      if (s.space !== space) throw new Error("an issued source names a foreign space");
      let count = 0;
      const keys = await kv.keys(`${issuedSourcePrefix(s)}>`);
      for await (const key of keys) {
        const entry = await read(key, "first");
        if (entry === undefined) continue;
        const index = closed(entry.value, ["source", "ref"], "issued source index");
        const ref = refSnapshot(index.ref as IssuedAuthorityRef);
        if (canonicalJson(index.source) !== canonicalJson(s) || key !== issuedSourceIndexKey(s, ref))
          throw new Error(`issued source index ${key} does not agree with its own coordinates`);
        const { evidence } = await readEvidence(ref);
        if (!evidence.sources.some((x) => canonicalJson(x) === canonicalJson(s)))
          throw new Error(`issued source index ${key} names a source absent from its evidence`);
        await retire(ref);
        count++;
      }
      return count;
    },
  });
}

/** Create-or-verify the two issued-authority stores. Evidence: `allow_direct=false`, file,
 *  no eviction. Accepted: `allow_direct=true`, file, no eviction. A drifted store fails loud. */
export async function ensureIssuedStores(jsm: JetStreamManager, kvm: Kvm, space: string): Promise<void> {
  // IMMUTABLE AT THE BROKER, not by CAS discipline alone. The `issuer` holds a bucket-wide publish
  // row on the evidence store, and that row carries a plain replacement of a row, a `Nats-Rollup`
  // header, a deletion marker and a per-key purge; none is a CAS write, so the create-only CAS
  // and the deletion-marker read see none of them. The three immutability flags close rollup,
  // message delete and purge on both stores. What closes plain replacement differs by store:
  //
  // - the ACCEPTED store is write-once per key: a row is written once at release and never
  //   advanced, so the broker refuses any second message on its key, and the client's
  //   `DIRECT.GET` still serves the one row there is;
  // - the EVIDENCE store is append-only: the attempt row advances by CAS (`prepared` to `active`
  //   to a terminal state), so a one-message cap is not an option there. Instead nothing on a key
  //   is ever removed, and every immutable row (the evidence, the source index) is read as the
  //   FIRST message on its key, so a later write on the same key is inert to every reader. The
  //   attempt row is read last-by-key, as its CAS requires.
  for (const [bucket, direct] of [[issuedBucket(space), false], [acceptedBucket(space), true]] as const) {
    const stream = `KV_${bucket}`;
    const shape = { ...AUTHORITY_STORE_IMMUTABLE_FLAGS, ...(direct ? WRITE_ONCE_PER_KEY : APPEND_ONLY_PER_KEY) };
    if (await jsm.streams.info(stream).catch(() => undefined) === undefined) {
      await kvm.create(bucket, { allow_direct: direct });
      const created = (await jsm.streams.info(stream)).config;
      await jsm.streams.update(stream, { ...created, ...shape });
    }
    const cfg = (await jsm.streams.info(stream)).config;
    if (cfg.allow_direct !== direct || cfg.storage !== "file" || (cfg.max_age ?? 0) !== 0 || (cfg.max_msgs ?? -1) > 0 || (cfg.max_bytes ?? -1) > 0
      || !Array.isArray(cfg.subjects) || cfg.subjects.length !== 1 || cfg.subjects[0] !== `$KV.${bucket}.>`)
      throw new Error(`the issued-authority store ${bucket} has a drifted shape (allow_direct=${String(cfg.allow_direct)}); an authority store is never silently adopted - reprovision it (SPEC 13.15)`);
    assertStoreShape(cfg as unknown as Record<string, unknown>, shape, bucket, "SPEC 13.15");
  }
}

// ---- the accepted row ----------------------------------------------------------------------------

export function acceptedKey(acceptedToken: string): string {
  return `accepted.v1.${assertGeneration(acceptedToken, "accepted token")}`;
}

/** The read grant an issued ceiling carries for exactly its own accepted row and nothing else. */
export function acceptedReadGrant(space: string, acceptedToken: string): string {
  const bucket = acceptedBucket(space);
  return `$JS.API.DIRECT.GET.KV_${bucket}.$KV.${bucket}.${acceptedKey(acceptedToken)}`;
}

/** Written by the issuer at release, create-only: a token is redeemed once. */
export async function writeAcceptedRow(kv: KV, acceptedToken: string, ref: IssuedAuthorityRef): Promise<void> {
  await kv.create(acceptedKey(acceptedToken), bytes({ version: 1, ref: refSnapshot(ref) }));
}

/** Read by the CLIENT over its own connection: the reference the ISSUER wrote, so a client that
 *  proposed or was told a different generation learns the accepted one here. The broker admits
 *  the read only under the ceiling's per-key grant, which is what binds the answer to the
 *  credential this connection presented. */
export async function readAcceptedRow(nc: NatsConnection, space: string, acceptedToken: string, timeoutMs = 3000): Promise<IssuedAuthorityRef> {
  const bucket = acceptedBucket(space);
  const response = await nc.request(`$JS.API.DIRECT.GET.KV_${bucket}.$KV.${bucket}.${acceptedKey(acceptedToken)}`, new Uint8Array(0), { timeout: timeoutMs });
  const status = response.headers?.get("Status");
  if (status) throw new EpEnvelopeError("permission-denied", `no accepted row for this token (${status}); the connection holds no issued authority (SPEC 13.15)`);
  const row = closed(JSON.parse(dec.decode(response.data)), ["version", "ref"], "accepted row");
  if (row.version !== 1) throw new Error("unsupported accepted-row version");
  const ref = refSnapshot(row.ref as IssuedAuthorityRef);
  if (ref.space !== space) throw new EpEnvelopeError("permission-denied", "the accepted row names a foreign space");
  return ref;
}

/** The named refusal an endpoint returns for a legacy (unversioned) invocation of a command
 *  that requires issued authority (SPEC §13.15 compatibility). */
/** `details[].kind` of the refusal a command requiring issued caller authority returns to a
 *  LEGACY arrival: the request rode the unversioned rail, so no generation binds it (SPEC 13.15). */
export const EP_UNBOUND_CALLER_AUTHORITY = "ai.cotal.ep.unbound-caller-authority";
