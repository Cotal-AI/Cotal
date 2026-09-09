/**
 * Native session lifecycle identity and binding grammar (§4 of the R4 design).
 *
 * GRAMMAR ONLY. This module defines key shapes, closed wire values and consuming-boundary
 * validation. Store CAS sequencing and provider effects belong in the lifecycle executor, never
 * here, so every manager and provider adapter consumes one wire grammar without growing a second
 * saga.
 */
import { createHash } from "node:crypto";
import { canonicalJson, isWellFormedUnicode } from "./canonical.js";
import { EpEnvelopeError } from "./endpoint-envelope.js";
import {
  SESSION_BINDING,
  SESSION_ENROLLMENT,
  SESSION_OPERATION,
  SESSION_TRUST_STATE,
  recordAtomicKey,
} from "./endpoint-records.js";
import { assertIdToken, assertLifecycleToken, endpointToken } from "./endpoint-subjects.js";
import type { RetainedAgentAuthority } from "./auth-provider.js";
import { assertValidChannel, parsePrincipalKey } from "./subjects.js";

const dec = new TextDecoder("utf-8", { fatal: true });
const isRec = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);
const uint = (v: unknown): v is number =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const pos = (v: unknown): v is number => uint(v) && v > 0;
const nonEmpty = (v: unknown): v is string =>
  typeof v === "string" && v.length > 0 && isWellFormedUnicode(v);

export const SESSION_MANAGEMENT_MODES = Object.freeze([
  "observed",
  "cooperative-exclusive",
  "receiver-fenced",
] as const);
export type SessionManagementMode = (typeof SESSION_MANAGEMENT_MODES)[number];

export const SESSION_MANAGE_ACTIONS = Object.freeze([
  "discover",
  "adopt",
  "control",
  "release",
  "transfer",
] as const);
export type SessionManageAction = (typeof SESSION_MANAGE_ACTIONS)[number];

/** Stable native resource identity. Process incarnation data is deliberately excluded. */
export interface ResourceKey {
  readonly hostIdentity: string;
  readonly provider: string;
  readonly nativeOwnerNamespace: string;
  readonly stableSessionId: string;
  readonly resourceGeneration: string;
}

/** Evidence that the currently inspected native process is the stable resource named above. */
export interface IncarnationProof {
  readonly nativeHostIncarnation: string;
  readonly sessionIncarnation: string;
  readonly evidence: unknown;
}

/** Authenticated audit context for the owner decision that created an enrollment. */
export interface EnrollmentProvenance {
  /** Canonical owner principal that authorized the enrollment. */
  readonly authorizedBy: string;
  /** Native evidence inspected when that authorization was made. */
  readonly nativeEvidence: unknown;
  /** Epoch milliseconds at which the evidence was authenticated. */
  readonly authenticatedAt: number;
}

/** The retained identity and authority dimensions renewal may reproduce. This is a process
 *  ceiling recorded beside enrollment, not a claim that credential bytes bind the ceiling. */
export interface AuthorityCeiling extends Readonly<Pick<RetainedAgentAuthority,
  "owner" | "actor" | "lifecycleUid">> {
  readonly scope: readonly string[];
  readonly allowSubscribe: readonly string[];
  readonly allowPublish: readonly string[];
  /**
   * Which role was authenticated at enrollment. Optional: absent is a role-less
   * enrollment and stays valid. Roles are non-hierarchical (each maps to its own
   * `svc_<role>` TASK durable), so a later live role S has no meet with enrolled R
   * and renewal must refuse rather than mint S. A later live role cannot be acquired
   * from absence either.
   */
  readonly role?: string;
}

export interface EnrollmentCommon {
  readonly resourceKey: ResourceKey;
  /** Canonical `<owner>.<actor>` of the native session owner, never its manager. */
  readonly ownerPrincipal: string;
  readonly provenance: EnrollmentProvenance;
  readonly incarnationProof: IncarnationProof;
  readonly rights: readonly SessionManageAction[];
  readonly expiry: number;
}

/** Native custody without a Cotal signing key or mesh lifecycle. The `never` fields preserve the
 *  union boundary even when a value reaches TypeScript through a non-literal variable. */
export type NativeOnlySessionEnrollment = EnrollmentCommon & {
  readonly kind: "native-only";
  readonly sessionActor?: never;
  readonly enrolledPublicId?: never;
  readonly meshLifecycle?: never;
  readonly ceiling?: never;
};

/** An enrollment whose session already owns mesh identity and renewal-bound key material. */
export type MeshEnrolledSessionEnrollment = EnrollmentCommon & {
  readonly kind: "mesh-enrolled";
  /** Canonical principal of the session actor, distinct from the authorizing owner actor. */
  readonly sessionActor: string;
  /** NATS user public nkey whose possession a renewal must prove. */
  readonly enrolledPublicId: string;
  readonly meshLifecycle: { readonly id: string; readonly lifecycleUid: string };
  readonly ceiling: AuthorityCeiling;
};

export type SessionEnrollment = NativeOnlySessionEnrollment | MeshEnrolledSessionEnrollment;

export type BindingState =
  | "adopt-prepared"
  | "managed"
  | "release-prepared"
  | "draining"
  | "fence-dispatched"
  | "provider-relinquished"
  | "released"
  | "recovery-required"
  | "identity-unproven";

export interface Binding {
  readonly bindingId: string;
  readonly resourceKey: ResourceKey;
  readonly incarnationProof: IncarnationProof;
  readonly controllerEpoch: number;
  /** Canonical `<owner>.<actor>` authenticated manager identity. */
  readonly managerPrincipal: string;
  readonly mode: SessionManagementMode;
  readonly rights: readonly SessionManageAction[];
  readonly state: BindingState;
  readonly operationId: string;
  readonly desiredRevision: number;
}

export type SessionOperationState =
  | "prepared"
  | "executing"
  | "terminal-success"
  | "terminal-refusal"
  | "indeterminate";

/** A journal receipt proves only that the transition was journalled. It is impossible to present
 *  one as native-effect proof because the distinction is a discriminated wire type. Cooperative
 *  dispatcher retirement is a third origin: an observed local fact (admission closed, dispatcher
 *  settled, retired state persisted). It is strictly more than a journal write and strictly less
 *  than a native receipt. It never proves a native effect. Any possibly-live old request with
 *  unproven completion makes the operation indeterminate, never terminal-success. An empty
 *  unproven set is not itself a drain: liveRequestCollector must be the literal "complete" or
 *  the collector is unproven. Only then, and only for release, may proves be cooperative-retirement. */
export type OperationProofOrigin =
  | { readonly kind: "journal-receipt"; readonly journalRevision: number; readonly proves: "journal-transition-only" }
  | { readonly kind: "receiver-receipt"; readonly receiver: string; readonly highestEpoch: number; readonly proves: "native-effect" }
  | { readonly kind: "native-readback"; readonly provider: string; readonly evidence: unknown; readonly proves: "native-effect" }
  | { readonly kind: "provider-refusal"; readonly provider: string; readonly evidence: unknown; readonly proves: "no-native-effect" }
  | {
      readonly kind: "dispatcher-retirement";
      readonly admissionClosed: true;
      readonly dispatcherSettled: true;
      readonly retiredStatePersisted: true;
      readonly unprovenLiveRequestIds: readonly string[];
      readonly liveRequestCollector: "complete" | "unproven";
      readonly proves: "dispatcher-retirement-only";
    }
  | {
      readonly kind: "dispatcher-retirement";
      readonly admissionClosed: true;
      readonly dispatcherSettled: true;
      readonly retiredStatePersisted: true;
      readonly unprovenLiveRequestIds: readonly [];
      readonly liveRequestCollector: "complete";
      readonly proves: "cooperative-retirement";
    };

/** Immutable operation input plus its recoverable state. `inputDigest` binds operation-id reuse. */
export interface SessionOperationRecord {
  readonly operationId: string;
  readonly resourceKey: ResourceKey;
  readonly incarnationProof: IncarnationProof;
  readonly bindingId: string;
  readonly expectedBindingRevision: number;
  readonly expectedControllerEpoch: number;
  readonly authenticatedActor: string;
  readonly action: SessionManageAction;
  readonly intendedResult: unknown;
  readonly inputDigest: string;
  readonly state: SessionOperationState;
  readonly result?: unknown;
  readonly proofOrigin?: OperationProofOrigin;
}

export interface SessionTrustedState {
  readonly resourceKey: ResourceKey;
  readonly epochFloor: number;
  readonly retiredBindingIds: readonly string[];
  readonly managementMode: "writable" | "management-recovery-read-only";
}

const RESOURCE_FIELDS = new Set([
  "hostIdentity", "provider", "nativeOwnerNamespace", "stableSessionId", "resourceGeneration",
]);
const PROOF_FIELDS = new Set(["nativeHostIncarnation", "sessionIncarnation", "evidence"]);
const PROVENANCE_FIELDS = new Set(["authorizedBy", "nativeEvidence", "authenticatedAt"]);
const NATIVE_ENROLLMENT_FIELDS = new Set([
  "kind", "resourceKey", "ownerPrincipal", "provenance", "incarnationProof", "rights", "expiry",
]);
const MESH_ENROLLMENT_FIELDS = new Set([
  ...NATIVE_ENROLLMENT_FIELDS, "sessionActor", "enrolledPublicId", "meshLifecycle", "ceiling",
]);
const MESH_LIFECYCLE_FIELDS = new Set(["id", "lifecycleUid"]);
const CEILING_FIELDS = new Set([
  "owner", "actor", "lifecycleUid", "scope", "allowSubscribe", "allowPublish", "role",
]);
const BINDING_FIELDS = new Set([
  "bindingId", "resourceKey", "incarnationProof", "controllerEpoch", "managerPrincipal", "mode",
  "rights", "state", "operationId", "desiredRevision",
]);
const OPERATION_FIELDS = new Set([
  "operationId", "resourceKey", "incarnationProof", "bindingId", "expectedBindingRevision",
  "expectedControllerEpoch", "authenticatedActor", "action", "intendedResult", "inputDigest",
  "state", "result", "proofOrigin",
]);
const TRUST_FIELDS = new Set(["resourceKey", "epochFloor", "retiredBindingIds", "managementMode"]);
const OPERATION_STATES: ReadonlySet<string> = new Set<SessionOperationState>([
  "prepared", "executing", "terminal-success", "terminal-refusal", "indeterminate",
]);
const BINDING_STATES: ReadonlySet<string> = new Set<BindingState>([
  "adopt-prepared", "managed", "release-prepared", "draining", "fence-dispatched",
  "provider-relinquished", "released", "recovery-required", "identity-unproven",
]);
const MODES: ReadonlySet<string> = new Set(SESSION_MANAGEMENT_MODES);
const ACTIONS: ReadonlySet<string> = new Set(SESSION_MANAGE_ACTIONS);

function fail(label: string, detail: string): never {
  throw new EpEnvelopeError("internal", `${label} ${detail}; garbled trusted lifecycle state never authorizes`);
}

function parseJson(raw: Uint8Array, label: string): unknown {
  try {
    return JSON.parse(dec.decode(raw));
  } catch {
    return fail(label, "is not valid UTF-8 JSON");
  }
}

function closed(o: Record<string, unknown>, allowed: ReadonlySet<string>, label: string): void {
  for (const k of Object.keys(o)) if (!allowed.has(k)) fail(label, `carries the unknown field ${JSON.stringify(k)} (closed schema)`);
}

function id(v: unknown, label: string): string {
  if (typeof v !== "string") return fail(label, "is not a string id");
  try { return assertIdToken(v, label); }
  catch { return fail(label, "is not a valid id token"); }
}

function principal(v: unknown, label: string): string {
  if (typeof v !== "string" || parsePrincipalKey(v) === null) return fail(label, "is not a canonical owner.actor principal");
  return v;
}

function stringList(
  value: unknown,
  label: string,
  validate: (entry: string) => void,
): readonly string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")
    || new Set(value).size !== value.length) return fail(label, "is not an array of unique strings");
  for (const entry of value as string[]) {
    try { validate(entry); }
    catch { return fail(label, `carries the invalid entry ${JSON.stringify(entry)}`); }
  }
  return Object.freeze([...(value as string[])]);
}

function parseEnrollmentProvenance(value: unknown, ownerPrincipal: string, label: string): EnrollmentProvenance {
  if (!isRec(value)) return fail(label, "is not an object");
  closed(value, PROVENANCE_FIELDS, label);
  const authorizedBy = principal(value.authorizedBy, `${label}.authorizedBy`);
  if (authorizedBy !== ownerPrincipal) return fail(label, "was not authenticated as the enrollment owner principal");
  if (!pos(value.authenticatedAt) || value.nativeEvidence === undefined)
    return fail(label, "does not carry native evidence and a positive authentication time");
  try { canonicalJson(value.nativeEvidence); }
  catch { return fail(label, "carries native evidence that is not strict JSON data"); }
  return Object.freeze({ authorizedBy, nativeEvidence: value.nativeEvidence, authenticatedAt: value.authenticatedAt });
}

function parseMeshLifecycle(
  value: unknown,
  sessionActor: string,
  label: string,
): { readonly id: string; readonly lifecycleUid: string } {
  if (!isRec(value)) return fail(label, "is not an object");
  closed(value, MESH_LIFECYCLE_FIELDS, label);
  const id = principal(value.id, `${label}.id`);
  if (id !== sessionActor) return fail(label, "does not name the enrolled session actor");
  if (!nonEmpty(value.lifecycleUid)) return fail(label, "does not carry a nonempty lifecycleUid string");
  return Object.freeze({ id, lifecycleUid: value.lifecycleUid });
}

function parseAuthorityCeiling(
  value: unknown,
  sessionActor: string,
  lifecycleUid: string,
  label: string,
): AuthorityCeiling {
  if (!isRec(value)) return fail(label, "is not an object");
  closed(value, CEILING_FIELDS, label);
  if (typeof value.owner !== "string" || typeof value.actor !== "string")
    return fail(label, "does not carry owner and actor strings");
  const ceilingPrincipal = principal(`${value.owner}.${value.actor}`, `${label}.owner/actor`);
  if (ceilingPrincipal !== sessionActor) return fail(label, "does not name the enrolled session actor");
  if (typeof value.lifecycleUid !== "string") return fail(label, "does not carry a lifecycleUid string");
  try { assertLifecycleToken(value.lifecycleUid, `${label}.lifecycleUid`); }
  catch { return fail(label, "carries an invalid lifecycleUid"); }
  if (value.lifecycleUid !== lifecycleUid) return fail(label, "does not name the enrolled mesh lifecycle");
  const scope = stringList(value.scope, `${label}.scope`, (entry) => {
    if (!/^[A-Za-z0-9_:-]+$/.test(entry)) throw new Error("invalid scope token");
  });
  const allowSubscribe = stringList(value.allowSubscribe, `${label}.allowSubscribe`, (entry) => { assertValidChannel(entry); });
  const allowPublish = stringList(value.allowPublish, `${label}.allowPublish`, (entry) => { assertValidChannel(entry); });
  let role: string | undefined;
  if (value.role !== undefined) {
    if (typeof value.role !== "string" || !/^[A-Za-z0-9_-]+$/.test(value.role))
      return fail(label, "carries a role that is not a plain token");
    role = value.role;
  }
  return Object.freeze({
    owner: value.owner,
    actor: value.actor,
    lifecycleUid: value.lifecycleUid,
    scope,
    allowSubscribe,
    allowPublish,
    ...(role ? { role } : {}),
  });
}

/** Validate a ResourceKey value. All fields are identity-bearing and the schema is closed. */
export function parseResourceKey(value: unknown, label = "resourceKey"): ResourceKey {
  if (!isRec(value)) return fail(label, "is not an object");
  closed(value, RESOURCE_FIELDS, label);
  if (!nonEmpty(value.hostIdentity) || !nonEmpty(value.nativeOwnerNamespace)
    || !nonEmpty(value.stableSessionId) || !nonEmpty(value.resourceGeneration)
    || typeof value.provider !== "string") return fail(label, "does not validate");
  try { endpointToken(value.provider); }
  catch { return fail(label, "carries a provider that is not a DNS-shaped provider name"); }
  return {
    hostIdentity: value.hostIdentity,
    provider: value.provider,
    nativeOwnerNamespace: value.nativeOwnerNamespace,
    stableSessionId: value.stableSessionId,
    resourceGeneration: value.resourceGeneration,
  };
}

/** Validate current native incarnation evidence without pretending that evidence is a receipt. */
export function parseIncarnationProof(value: unknown, label = "incarnationProof"): IncarnationProof {
  if (!isRec(value)) return fail(label, "is not an object");
  closed(value, PROOF_FIELDS, label);
  if (!nonEmpty(value.nativeHostIncarnation) || !nonEmpty(value.sessionIncarnation)
    || value.evidence === undefined) return fail(label, "does not validate");
  try { canonicalJson(value.evidence); }
  catch { return fail(label, "carries evidence that is not strict JSON data"); }
  return {
    nativeHostIncarnation: value.nativeHostIncarnation,
    sessionIncarnation: value.sessionIncarnation,
    evidence: value.evidence,
  };
}

/** Recovery classification for a fresh provider inspection. A mismatch is never coerced into a
 * new alias or epoch reset: the only safe answer is the plan's explicit `identity-unproven`. */
export function classifyIncarnationProof(
  expected: IncarnationProof,
  observed: IncarnationProof,
): "matched" | "identity-unproven" {
  const a = parseIncarnationProof(expected, "expected incarnation proof");
  const b = parseIncarnationProof(observed, "observed incarnation proof");
  return a.nativeHostIncarnation === b.nativeHostIncarnation
    && a.sessionIncarnation === b.sessionIncarnation
    && canonicalJson(a.evidence) === canonicalJson(b.evidence)
    ? "matched"
    : "identity-unproven";
}

/** Collision-resistant key token for one complete ResourceKey. */
export function resourceKeyId(resourceKey: ResourceKey): string {
  const parsed = parseResourceKey(resourceKey);
  return createHash("sha256").update(canonicalJson(parsed), "utf8").digest("base64url").slice(0, 43);
}

export function sessionBindingKey(resourceKey: ResourceKey): string {
  return recordAtomicKey(SESSION_BINDING, [resourceKeyId(resourceKey)]);
}

export function sessionEnrollmentKey(resourceKey: ResourceKey): string {
  return recordAtomicKey(SESSION_ENROLLMENT, [resourceKeyId(resourceKey)]);
}

export function sessionOperationKey(resourceKey: ResourceKey, operationId: string): string {
  return recordAtomicKey(SESSION_OPERATION, [resourceKeyId(resourceKey), assertIdToken(operationId, "operationId")]);
}

export function sessionTrustStateKey(resourceKey: ResourceKey): string {
  return recordAtomicKey(SESSION_TRUST_STATE, [resourceKeyId(resourceKey)]);
}

/** Parse one owner-authorized enrollment CAS row, including its ResourceKey key binding. */
export function parseSessionEnrollment(
  raw: Uint8Array,
  key: string,
  expectedResourceKey?: ResourceKey,
): SessionEnrollment {
  const label = `session enrollment ${key}`;
  const value = parseJson(raw, label);
  if (!isRec(value)) return fail(label, "is not an object");
  if (value.kind === "native-only") closed(value, NATIVE_ENROLLMENT_FIELDS, label);
  else if (value.kind === "mesh-enrolled") closed(value, MESH_ENROLLMENT_FIELDS, label);
  else return fail(label, "does not carry a known enrollment kind");

  const resourceKey = parseResourceKey(value.resourceKey, `${label}.resourceKey`);
  const ownerPrincipal = principal(value.ownerPrincipal, `${label}.ownerPrincipal`);
  const provenance = parseEnrollmentProvenance(value.provenance, ownerPrincipal, `${label}.provenance`);
  const incarnationProof = parseIncarnationProof(value.incarnationProof, `${label}.incarnationProof`);
  const rights = stringList(value.rights, `${label}.rights`, (entry) => {
    if (!ACTIONS.has(entry)) throw new Error("unknown session manage action");
  }) as readonly SessionManageAction[];
  if (rights.length === 0) return fail(`${label}.rights`, "must not be empty");
  if (!pos(value.expiry) || value.expiry <= provenance.authenticatedAt)
    return fail(`${label}.expiry`, "is not a positive time after provenance authentication");
  const canonicalKey = sessionEnrollmentKey(resourceKey);
  if (key !== canonicalKey) return fail(label, `does not match its embedded ResourceKey (canonical key ${canonicalKey})`);
  if (expectedResourceKey !== undefined && resourceKeyId(expectedResourceKey) !== resourceKeyId(resourceKey))
    return fail(label, "does not match the ResourceKey requested by the consumer");

  const common: EnrollmentCommon = {
    resourceKey,
    ownerPrincipal,
    provenance,
    incarnationProof,
    rights,
    expiry: value.expiry,
  };
  if (value.kind === "native-only") return { ...common, kind: "native-only" };

  const sessionActor = principal(value.sessionActor, `${label}.sessionActor`);
  const owner = parsePrincipalKey(ownerPrincipal)!;
  const actor = parsePrincipalKey(sessionActor)!;
  if (owner.owner !== actor.owner || owner.actor === actor.actor)
    return fail(label, "does not carry a distinct session actor under the enrollment owner");
  if (typeof value.enrolledPublicId !== "string" || !/^U[A-Z2-7]{55}$/.test(value.enrolledPublicId))
    return fail(`${label}.enrolledPublicId`, "is not a NATS user public nkey");
  const meshLifecycle = parseMeshLifecycle(value.meshLifecycle, sessionActor, `${label}.meshLifecycle`);
  const ceiling = parseAuthorityCeiling(value.ceiling, sessionActor, meshLifecycle.lifecycleUid, `${label}.ceiling`);
  return {
    ...common,
    kind: "mesh-enrolled",
    sessionActor,
    enrolledPublicId: value.enrolledPublicId,
    meshLifecycle,
    ceiling,
  };
}

/** Parse an authoritative Binding at its consuming boundary, including key/value identity binding. */
export function parseBinding(raw: Uint8Array, key: string, expectedResourceKey?: ResourceKey): Binding {
  const value = parseJson(raw, `session binding ${key}`);
  if (!isRec(value)) return fail(`session binding ${key}`, "is not an object");
  closed(value, BINDING_FIELDS, `session binding ${key}`);
  const resourceKey = parseResourceKey(value.resourceKey, `session binding ${key}.resourceKey`);
  const proof = parseIncarnationProof(value.incarnationProof, `session binding ${key}.incarnationProof`);
  const bindingId = id(value.bindingId, `session binding ${key}.bindingId`);
  const operationId = id(value.operationId, `session binding ${key}.operationId`);
  const managerPrincipal = principal(value.managerPrincipal, `session binding ${key}.managerPrincipal`);
  if (!pos(value.controllerEpoch) || !uint(value.desiredRevision)
    || typeof value.mode !== "string" || !MODES.has(value.mode)
    || typeof value.state !== "string" || !BINDING_STATES.has(value.state)
    || !Array.isArray(value.rights) || value.rights.length === 0
    || value.rights.some((r) => typeof r !== "string" || !ACTIONS.has(r))
    || new Set(value.rights).size !== value.rights.length) return fail(`session binding ${key}`, "does not validate");
  if (value.mode === "observed" && (value.rights as string[]).some((r) => r !== "discover"))
    return fail(`session binding ${key}`, "is observed but carries management write authority");
  const canonicalKey = sessionBindingKey(resourceKey);
  if (key !== canonicalKey) return fail(`session binding ${key}`, `does not match its embedded ResourceKey (canonical key ${canonicalKey})`);
  if (expectedResourceKey !== undefined && resourceKeyId(expectedResourceKey) !== resourceKeyId(resourceKey))
    return fail(`session binding ${key}`, "does not match the ResourceKey requested by the consumer");
  return {
    bindingId,
    resourceKey,
    incarnationProof: proof,
    controllerEpoch: value.controllerEpoch,
    managerPrincipal,
    mode: value.mode as SessionManagementMode,
    rights: Object.freeze([...(value.rights as SessionManageAction[])]),
    state: value.state as BindingState,
    operationId,
    desiredRevision: value.desiredRevision,
  };
}

/** The immutable input whose digest makes one operation id idempotent rather than ambiguous. */
export function sessionOperationInput(record: Omit<SessionOperationRecord, "inputDigest" | "state" | "result" | "proofOrigin">): object {
  return {
    operationId: record.operationId,
    resourceKey: record.resourceKey,
    incarnationProof: record.incarnationProof,
    bindingId: record.bindingId,
    expectedBindingRevision: record.expectedBindingRevision,
    expectedControllerEpoch: record.expectedControllerEpoch,
    authenticatedActor: record.authenticatedActor,
    action: record.action,
    intendedResult: record.intendedResult,
  };
}

export function sessionOperationInputDigest(input: ReturnType<typeof sessionOperationInput>): string {
  return createHash("sha256").update(canonicalJson(input), "utf8").digest("base64url").slice(0, 43);
}

function parseProofOrigin(value: unknown, label: string): OperationProofOrigin {
  if (!isRec(value) || typeof value.kind !== "string") return fail(label, "is not a proof-origin object");
  if (value.kind === "journal-receipt") {
    closed(value, new Set(["kind", "journalRevision", "proves"]), label);
    if (!pos(value.journalRevision) || value.proves !== "journal-transition-only") return fail(label, "does not validate as journal-only proof");
    return { kind: "journal-receipt", journalRevision: value.journalRevision, proves: "journal-transition-only" };
  }
  if (value.kind === "receiver-receipt") {
    closed(value, new Set(["kind", "receiver", "highestEpoch", "proves"]), label);
    if (!nonEmpty(value.receiver) || !pos(value.highestEpoch) || value.proves !== "native-effect") return fail(label, "does not validate as receiver proof");
    return { kind: "receiver-receipt", receiver: value.receiver, highestEpoch: value.highestEpoch, proves: "native-effect" };
  }
  if (value.kind === "native-readback" || value.kind === "provider-refusal") {
    closed(value, new Set(["kind", "provider", "evidence", "proves"]), label);
    const expected = value.kind === "native-readback" ? "native-effect" : "no-native-effect";
    if (typeof value.provider !== "string" || value.evidence === undefined || value.proves !== expected)
      return fail(label, "does not validate as provider proof");
    try { endpointToken(value.provider); canonicalJson(value.evidence); }
    catch { return fail(label, "carries malformed provider evidence"); }
    return value.kind === "native-readback"
      ? { kind: "native-readback", provider: value.provider, evidence: value.evidence, proves: "native-effect" }
      : { kind: "provider-refusal", provider: value.provider, evidence: value.evidence, proves: "no-native-effect" };
  }
  if (value.kind === "dispatcher-retirement") {
    closed(value, new Set(["kind", "admissionClosed", "dispatcherSettled", "retiredStatePersisted", "unprovenLiveRequestIds", "liveRequestCollector", "proves"]), label);
    if (value.admissionClosed !== true || value.dispatcherSettled !== true || value.retiredStatePersisted !== true)
      return fail(label, "does not prove admission closed, dispatcher settled, and retired state persisted");
    if (!Array.isArray(value.unprovenLiveRequestIds)
      || value.unprovenLiveRequestIds.some((v) => typeof v !== "string")
      || new Set(value.unprovenLiveRequestIds).size !== value.unprovenLiveRequestIds.length)
      return fail(label, "does not validate as dispatcher-retirement proof");
    if (value.liveRequestCollector !== "complete" && value.liveRequestCollector !== "unproven")
      return fail(label, "does not prove the live-request collector ran");
    const unprovenLiveRequestIds = Object.freeze(value.unprovenLiveRequestIds.map((v) => id(v, `${label}.unprovenLiveRequestIds`)));
    if (value.proves === "cooperative-retirement") {
      if (value.liveRequestCollector !== "complete")
        return fail(label, "does not prove the live-request collector ran");
      if (unprovenLiveRequestIds.length !== 0)
        return fail(label, "cannot prove cooperative retirement while live requests remain unproven");
      return {
        kind: "dispatcher-retirement",
        admissionClosed: true,
        dispatcherSettled: true,
        retiredStatePersisted: true,
        unprovenLiveRequestIds: unprovenLiveRequestIds as readonly [],
        liveRequestCollector: "complete",
        proves: "cooperative-retirement",
      };
    }
    if (value.proves !== "dispatcher-retirement-only")
      return fail(label, "does not validate as dispatcher-retirement proof");
    return {
      kind: "dispatcher-retirement",
      admissionClosed: true,
      dispatcherSettled: true,
      retiredStatePersisted: true,
      unprovenLiveRequestIds,
      liveRequestCollector: value.liveRequestCollector,
      proves: "dispatcher-retirement-only",
    };
  }
  return fail(label, `carries unknown proof kind ${JSON.stringify(value.kind)}`);
}

export function parseSessionOperation(raw: Uint8Array, key: string, expectedResourceKey?: ResourceKey): SessionOperationRecord {
  const value = parseJson(raw, `session operation ${key}`);
  if (!isRec(value)) return fail(`session operation ${key}`, "is not an object");
  closed(value, OPERATION_FIELDS, `session operation ${key}`);
  const operationId = id(value.operationId, `session operation ${key}.operationId`);
  const bindingId = id(value.bindingId, `session operation ${key}.bindingId`);
  const resourceKey = parseResourceKey(value.resourceKey, `session operation ${key}.resourceKey`);
  const incarnationProof = parseIncarnationProof(value.incarnationProof, `session operation ${key}.incarnationProof`);
  const authenticatedActor = principal(value.authenticatedActor, `session operation ${key}.authenticatedActor`);
  if (!uint(value.expectedBindingRevision) || !pos(value.expectedControllerEpoch)
    || typeof value.action !== "string" || !ACTIONS.has(value.action)
    || value.intendedResult === undefined || typeof value.inputDigest !== "string"
    || !/^[A-Za-z0-9_-]{43}$/.test(value.inputDigest)
    || typeof value.state !== "string" || !OPERATION_STATES.has(value.state))
    return fail(`session operation ${key}`, "does not validate");
  try { canonicalJson(value.intendedResult); if (value.result !== undefined) canonicalJson(value.result); }
  catch { return fail(`session operation ${key}`, "carries non-JSON intended/result data"); }
  const input = sessionOperationInput({
    operationId, resourceKey, incarnationProof, bindingId,
    expectedBindingRevision: value.expectedBindingRevision,
    expectedControllerEpoch: value.expectedControllerEpoch,
    authenticatedActor, action: value.action as SessionManageAction, intendedResult: value.intendedResult,
  });
  if (sessionOperationInputDigest(input) !== value.inputDigest)
    return fail(`session operation ${key}`, "inputDigest does not bind its transition input");
  if (key !== sessionOperationKey(resourceKey, operationId))
    return fail(`session operation ${key}`, "does not match its embedded ResourceKey and operationId");
  if (expectedResourceKey !== undefined && resourceKeyId(expectedResourceKey) !== resourceKeyId(resourceKey))
    return fail(`session operation ${key}`, "does not match the ResourceKey requested by the consumer");
  const proofOrigin = value.proofOrigin === undefined ? undefined : parseProofOrigin(value.proofOrigin, `session operation ${key}.proofOrigin`);
  if ((value.state === "terminal-success" || value.state === "terminal-refusal") && (value.result === undefined || proofOrigin === undefined))
    return fail(`session operation ${key}`, "is terminal without result and proof origin");
  if (value.state === "terminal-success" && proofOrigin?.proves !== "native-effect" && proofOrigin?.proves !== "cooperative-retirement")
    return fail(`session operation ${key}`, "claims terminal success without native-effect or cooperative-retirement proof");
  if (value.state === "terminal-refusal" && proofOrigin?.proves !== "no-native-effect")
    return fail(`session operation ${key}`, "claims terminal refusal without no-native-effect proof");
  if (proofOrigin?.proves === "cooperative-retirement" && (value.state !== "terminal-success" || value.action !== "release"))
    return fail(`session operation ${key}`, "cooperative-retirement proof can settle only a release as terminal-success");
  if (proofOrigin?.kind === "dispatcher-retirement" && proofOrigin.proves === "dispatcher-retirement-only" && value.state !== "indeterminate")
    return fail(`session operation ${key}`, "dispatcher-retirement proof cannot settle an operation as anything except indeterminate");
  if (proofOrigin?.kind === "receiver-receipt" && proofOrigin.highestEpoch < value.expectedControllerEpoch)
    return fail(`session operation ${key}`, "carries a receiver receipt below its expected controller epoch");
  if ((proofOrigin?.kind === "native-readback" || proofOrigin?.kind === "provider-refusal")
    && proofOrigin.provider !== resourceKey.provider)
    return fail(`session operation ${key}`, "carries proof from a provider other than its ResourceKey provider");
  return {
    operationId, resourceKey, incarnationProof, bindingId,
    expectedBindingRevision: value.expectedBindingRevision,
    expectedControllerEpoch: value.expectedControllerEpoch,
    authenticatedActor, action: value.action as SessionManageAction, intendedResult: value.intendedResult,
    inputDigest: value.inputDigest, state: value.state as SessionOperationState,
    ...(value.result !== undefined ? { result: value.result } : {}),
    ...(proofOrigin !== undefined ? { proofOrigin } : {}),
  };
}

export function parseSessionTrustedState(raw: Uint8Array, key: string, expectedResourceKey?: ResourceKey): SessionTrustedState {
  const value = parseJson(raw, `session trust state ${key}`);
  if (!isRec(value)) return fail(`session trust state ${key}`, "is not an object");
  closed(value, TRUST_FIELDS, `session trust state ${key}`);
  const resourceKey = parseResourceKey(value.resourceKey, `session trust state ${key}.resourceKey`);
  if (!uint(value.epochFloor) || !Array.isArray(value.retiredBindingIds)
    || value.retiredBindingIds.some((v) => typeof v !== "string")
    || new Set(value.retiredBindingIds).size !== value.retiredBindingIds.length
    || (value.managementMode !== "writable" && value.managementMode !== "management-recovery-read-only"))
    return fail(`session trust state ${key}`, "does not validate");
  const retiredBindingIds = value.retiredBindingIds.map((v) => id(v, `session trust state ${key}.retiredBindingIds`));
  if (key !== sessionTrustStateKey(resourceKey)) return fail(`session trust state ${key}`, "does not match its embedded ResourceKey");
  if (expectedResourceKey !== undefined && resourceKeyId(expectedResourceKey) !== resourceKeyId(resourceKey))
    return fail(`session trust state ${key}`, "does not match the ResourceKey requested by the consumer");
  return { resourceKey, epochFloor: value.epochFloor, retiredBindingIds: Object.freeze(retiredBindingIds), managementMode: value.managementMode };
}
