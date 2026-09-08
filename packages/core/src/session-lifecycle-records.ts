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
  SESSION_OPERATION,
  SESSION_TRUST_STATE,
  recordAtomicKey,
} from "./endpoint-records.js";
import { assertIdToken, endpointToken } from "./endpoint-subjects.js";
import { parsePrincipalKey } from "./subjects.js";

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

const RESOURCE_FIELDS = new Set([
  "hostIdentity", "provider", "nativeOwnerNamespace", "stableSessionId", "resourceGeneration",
]);
const PROOF_FIELDS = new Set(["nativeHostIncarnation", "sessionIncarnation", "evidence"]);
const BINDING_FIELDS = new Set([
  "bindingId", "resourceKey", "incarnationProof", "controllerEpoch", "managerPrincipal", "mode",
  "rights", "state", "operationId", "desiredRevision",
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

/** Collision-resistant key token for one complete ResourceKey. */
export function resourceKeyId(resourceKey: ResourceKey): string {
  const parsed = parseResourceKey(resourceKey);
  return createHash("sha256").update(canonicalJson(parsed), "utf8").digest("base64url").slice(0, 43);
}

export function sessionBindingKey(resourceKey: ResourceKey): string {
  return recordAtomicKey(SESSION_BINDING, [resourceKeyId(resourceKey)]);
}

export function sessionOperationKey(resourceKey: ResourceKey, operationId: string): string {
  return recordAtomicKey(SESSION_OPERATION, [resourceKeyId(resourceKey), assertIdToken(operationId, "operationId")]);
}

export function sessionTrustStateKey(resourceKey: ResourceKey): string {
  return recordAtomicKey(SESSION_TRUST_STATE, [resourceKeyId(resourceKey)]);
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
