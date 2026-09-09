/**
 * Run admission (SPEC 14.8): the immutable, manager-owned record of WHAT AUTHORITY a hosted
 * workflow run was admitted under, beside the independent marker that revokes it.
 *
 * A hosted run acts on channels through the trusted mediator, whose credential is host-wide. The
 * admission record is what confines that: it snapshots, at `run-start`, the caller's ISSUED
 * ceiling (SPEC 13.15) as the run's channel ceiling, and every channel effect the host performs
 * afterwards is checked against it. The record is created once, create-only, by a one-shot
 * `run-admitter` credential the manager mints per run; the driver holds no grant on this store;
 * the mediator reads it leader-served before each effect.
 *
 * Revocation is a SEPARATE create-only marker under its own key, so absence of revocation is a
 * readable "no marker" on a store the reader can reach, never a missing record on a store it
 * cannot. A failed read on either key is a refusal, not an absence.
 *
 * The store is its own bucket (`cotal_admission_<space>`, `allow_direct=false`): the driver-writable
 * run/program/journal records and the registration-policy records are the wrong place for a
 * record whose whole point is that the driver cannot influence it.
 */
import type { JetStreamManager } from "@nats-io/jetstream";
import type { KV, Kvm } from "@nats-io/kv";
import { canonicalJson } from "./canonical.js";
import { EpEnvelopeError } from "./endpoint-envelope.js";
import { assertIdToken, endpointToken, type EpCaller } from "./endpoint-subjects.js";
import { isCasLoss } from "./endpoint-records.js";
import {
  issuedPermitsPattern,
  issuedPermitsSubject,
  readIssuedSubjectPermissions,
  type IssuedAuthorityRef,
  type IssuedSubjectPermissions,
} from "./issued-authority.js";
import { chatSubject, token } from "./subjects.js";

export function admissionBucket(space: string): string {
  return `cotal_admission_${token(space)}`;
}

export function admissionKey(endpoint: string, runId: string): string {
  return `admission.v1.${endpointToken(endpoint)}.${assertIdToken(runId, "runId")}`;
}

export function revocationKey(endpoint: string, runId: string): string {
  return `revoked.v1.${endpointToken(endpoint)}.${assertIdToken(runId, "runId")}`;
}

/** Where a run's authority came from. `issued` is the only shape a served `run-start` admits;
 *  `operator` is a local drive or an explicit migration, admitted from trusted operator evidence
 *  the operator names, never inferred from program text. */
export type RunAdmissionProvenance =
  | { readonly kind: "issued"; readonly ref: IssuedAuthorityRef; readonly resolvedRevision: number }
  | { readonly kind: "operator"; readonly by: string; readonly reason: string };

export interface RunAdmission {
  readonly version: 1;
  readonly space: string;
  readonly endpoint: string;
  readonly runId: string;
  /** The admitting manager instance. */
  readonly instanceId: string;
  /** The caller the run was admitted for: the issued triple, or the operator's principal. */
  readonly caller: EpCaller;
  /** The channel ceiling the run's effects are checked against: the caller's issued publish and
   *  subscribe ceilings, verbatim. Explicit `none` is deny-all. */
  readonly ceiling: IssuedSubjectPermissions;
  readonly provenance: RunAdmissionProvenance;
  readonly admittedAt: number;
}

export interface RunRevocation {
  readonly version: 1;
  readonly runId: string;
  readonly reason: string;
  readonly by: string;
  readonly revokedAt: number;
}

function closed(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be a plain record`);
  for (const key of Object.keys(value)) if (!keys.includes(key)) throw new Error(`${label} carries an unsupported field ${key}`);
  return value as Record<string, unknown>;
}

function callerSnapshot(value: unknown): EpCaller {
  const raw = closed(value, ["owner", "actor", "uid", "generation"], "admission caller");
  if (typeof raw.owner !== "string" || typeof raw.actor !== "string" || typeof raw.uid !== "string"
    || (raw.generation !== undefined && typeof raw.generation !== "string"))
    throw new Error("admission caller is malformed");
  return Object.freeze({ owner: raw.owner, actor: raw.actor, uid: raw.uid, ...(raw.generation !== undefined ? { generation: raw.generation } : {}) }) as EpCaller;
}

function provenanceSnapshot(value: unknown): RunAdmissionProvenance {
  const raw = closed(value, ["kind", "ref", "resolvedRevision", "by", "reason"], "admission provenance");
  if (raw.kind === "issued") {
    const ref = closed(raw.ref, ["space", "owner", "actor", "uid", "generation"], "admission issued ref");
    if (!["space", "owner", "actor", "uid", "generation"].every((k) => typeof ref[k] === "string")
      || typeof raw.resolvedRevision !== "number" || !Number.isSafeInteger(raw.resolvedRevision) || raw.resolvedRevision <= 0
      || raw.by !== undefined || raw.reason !== undefined)
      throw new Error("issued admission provenance is malformed");
    const pinned: IssuedAuthorityRef = { space: ref.space as string, owner: ref.owner as string, actor: ref.actor as string, uid: ref.uid as string, generation: ref.generation as string };
    return Object.freeze({ kind: "issued", ref: Object.freeze(pinned), resolvedRevision: raw.resolvedRevision });
  }
  if (raw.kind === "operator") {
    if (typeof raw.by !== "string" || raw.by.length === 0 || typeof raw.reason !== "string" || raw.reason.length === 0
      || raw.ref !== undefined || raw.resolvedRevision !== undefined)
      throw new Error("operator admission provenance is malformed");
    return Object.freeze({ kind: "operator", by: raw.by, reason: raw.reason });
  }
  throw new Error("unsupported admission provenance");
}

/** Validate a record at the consuming boundary: closed schema, version, coordinates. */
export function admissionSnapshot(value: unknown): RunAdmission {
  const raw = closed(value, ["version", "space", "endpoint", "runId", "instanceId", "caller", "ceiling", "provenance", "admittedAt"], "run admission");
  if (raw.version !== 1) throw new Error(`unsupported run admission version ${String(raw.version)}`);
  if (typeof raw.space !== "string" || typeof raw.endpoint !== "string" || typeof raw.runId !== "string" || typeof raw.instanceId !== "string"
    || typeof raw.admittedAt !== "number" || !Number.isSafeInteger(raw.admittedAt) || raw.admittedAt <= 0)
    throw new Error("run admission is malformed");
  endpointToken(raw.space);
  endpointToken(raw.endpoint);
  assertIdToken(raw.runId, "runId");
  const caller = callerSnapshot(raw.caller);
  const provenance = provenanceSnapshot(raw.provenance);
  if (provenance.kind === "issued") {
    const r = provenance.ref;
    if (r.space !== raw.space || r.owner !== caller.owner || r.actor !== caller.actor || r.uid !== caller.uid || (caller as { generation?: string }).generation !== r.generation)
      throw new Error("run admission's issued reference disagrees with its caller");
  }
  return Object.freeze({
    version: 1, space: raw.space, endpoint: raw.endpoint, runId: raw.runId, instanceId: raw.instanceId,
    caller, ceiling: readIssuedSubjectPermissions(raw.ceiling), provenance, admittedAt: raw.admittedAt,
  });
}

export function revocationSnapshot(value: unknown, runId: string): RunRevocation {
  const raw = closed(value, ["version", "runId", "reason", "by", "revokedAt"], "run revocation");
  if (raw.version !== 1 || raw.runId !== runId || typeof raw.reason !== "string" || typeof raw.by !== "string"
    || typeof raw.revokedAt !== "number" || !Number.isSafeInteger(raw.revokedAt) || raw.revokedAt <= 0)
    throw new Error("run revocation is malformed");
  return Object.freeze({ version: 1, runId, reason: raw.reason, by: raw.by, revokedAt: raw.revokedAt });
}

const enc = new TextEncoder();
const dec = new TextDecoder("utf-8", { fatal: true });

/** Leader-served point read of one admission-store key. Absence is `undefined`; a deletion
 *  marker or an unreadable value is a refusal. */
async function readLeader(jsm: JetStreamManager, space: string, key: string): Promise<{ value: unknown; revision: number } | undefined> {
  const bucket = admissionBucket(space);
  let m;
  try {
    m = await jsm.streams.getMessage(`KV_${bucket}`, { last_by_subj: `$KV.${bucket}.${key}` });
  } catch (e) {
    if ((e as { code?: unknown }).code === 10037) return undefined;
    throw e;
  }
  if (!m) return undefined;
  if (m.header?.get("KV-Operation"))
    throw new EpEnvelopeError("failed-precondition", `admission row ${key} carries a deletion marker; a deletion is never absence (SPEC 14.8)`);
  return { value: JSON.parse(dec.decode(m.data)), revision: m.seq };
}

/** Create the admission, create-only. A second create for the same run is a conflict: a run is
 *  admitted once, and a re-admission is a new run (a fork) or an explicit migration. */
export async function createRunAdmission(kv: KV, admission: RunAdmission): Promise<number> {
  const snap = admissionSnapshot(admission);
  try {
    return await kv.create(admissionKey(snap.endpoint, snap.runId), enc.encode(canonicalJson(snap)));
  } catch (e) {
    if (isCasLoss(e)) throw new EpEnvelopeError("conflict", `run ${snap.runId} is already admitted; an admission is written once (SPEC 14.8)`);
    throw e;
  }
}

/** Create the revocation marker, create-only and idempotent on an existing marker. */
export async function revokeRunAdmission(kv: KV, endpoint: string, revocation: RunRevocation): Promise<void> {
  const snap = revocationSnapshot(revocation, revocation.runId);
  try {
    await kv.create(revocationKey(endpoint, snap.runId), enc.encode(canonicalJson(snap)));
  } catch (e) {
    if (!isCasLoss(e)) throw e;
  }
}

export interface RunAdmissionView {
  readonly admission: RunAdmission;
  readonly revoked: RunRevocation | undefined;
}

/** The admission a host acts on: the record must exist, match its coordinates, and carry no
 *  revocation marker. Missing, unreadable, malformed, mismatched, or revoked all refuse. */
export async function readRunAdmission(jsm: JetStreamManager, space: string, endpoint: string, runId: string): Promise<RunAdmissionView> {
  const entry = await readLeader(jsm, space, admissionKey(endpoint, runId));
  if (entry === undefined)
    throw new EpEnvelopeError("permission-denied", `run ${runId} has no admission record on endpoint ${endpoint}; a run with no admission runs no channel effect (SPEC 14.8)`);
  let admission: RunAdmission;
  try {
    admission = admissionSnapshot(entry.value);
  } catch (e) {
    throw new EpEnvelopeError("permission-denied", `run ${runId}'s admission record is unreadable (${(e as Error).message}); garbled trusted state never authorizes (SPEC 14.8)`);
  }
  if (admission.space !== space || admission.endpoint !== endpoint || admission.runId !== runId)
    throw new EpEnvelopeError("permission-denied", `run ${runId}'s admission record names other coordinates (${admission.space}/${admission.endpoint}/${admission.runId}); refused (SPEC 14.8)`);
  const marker = await readLeader(jsm, space, revocationKey(endpoint, runId));
  const revoked = marker === undefined ? undefined : revocationSnapshot(marker.value, runId);
  return Object.freeze({ admission, revoked });
}

/** The channel checks a host applies, over the admitted ceiling. Concrete channels only: a
 *  wildcard is not a channel a run can post to or await, and a generated name is checked after
 *  it is derived, by the same rule. */
export class RunAdmissionDenied extends EpEnvelopeError {
  constructor(runId: string, what: string, channel: string) {
    super("permission-denied", `run ${runId} is not admitted to ${what} channel "${channel}" (SPEC 14.8)`);
    this.name = "RunAdmissionDenied";
  }
}

export function assertAdmittedPublish(view: RunAdmissionView, channel: string, caller: EpCaller): void {
  assertNotRevoked(view);
  const subject = chatSubject(view.admission.space, caller.owner, caller.actor, channel);
  if (!issuedPermitsSubject(view.admission.ceiling.publish, subject)) throw new RunAdmissionDenied(view.admission.runId, "publish to", channel);
}

export function assertAdmittedSubscribe(view: RunAdmissionView, channel: string): void {
  assertNotRevoked(view);
  const pattern = chatSubject(view.admission.space, "*", "*", channel);
  if (!issuedPermitsPattern(view.admission.ceiling.subscribe, pattern)) throw new RunAdmissionDenied(view.admission.runId, "read", channel);
}

export function assertNotRevoked(view: RunAdmissionView): void {
  if (view.revoked !== undefined)
    throw new EpEnvelopeError("permission-denied", `run ${view.admission.runId} was revoked by ${view.revoked.by} (${view.revoked.reason}); no further channel effect runs (SPEC 14.8)`);
}

/** Create-or-verify the admission store: `allow_direct=false`, file, no eviction. */
export async function ensureAdmissionStore(jsm: JetStreamManager, kvm: Kvm, space: string): Promise<void> {
  const bucket = admissionBucket(space);
  const stream = `KV_${bucket}`;
  if (await jsm.streams.info(stream).catch(() => undefined) === undefined) await kvm.create(bucket, { allow_direct: false });
  const cfg = (await jsm.streams.info(stream)).config;
  if (cfg.allow_direct !== false || cfg.storage !== "file" || (cfg.max_age ?? 0) !== 0 || (cfg.max_msgs ?? -1) > 0 || (cfg.max_bytes ?? -1) > 0
    || !Array.isArray(cfg.subjects) || cfg.subjects.length !== 1 || cfg.subjects[0] !== `$KV.${bucket}.>`)
    throw new Error(`the run admission store ${bucket} has a drifted shape; an authority store is never silently adopted - reprovision it (SPEC 14.8)`);
}
