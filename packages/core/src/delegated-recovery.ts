import type { RetainedAgentAuthority } from "./auth-provider.js";
import { canonicalJson, contractDigest } from "./canonical.js";
import { EpEnvelopeError } from "./endpoint-error.js";
import { isAccountNkey } from "./identity.js";
import { managedRuntimeKey } from "./managed-handoff.js";
import {
  parseRemoteDelegatedUserIntentExecutionRequest,
  parseRemoteManagerEnvelope,
  type RemoteDelegatedUserIntentExecutionRequest,
  type RemoteManagerEnvelope,
} from "./remote-manager-authority.js";
import { assertDerivedOwnerToken, assertLifecycleToken, assertValidOwnerToken, parsePrincipalKey } from "./subjects.js";

export interface DelegatedRecoveryTarget {
  owner: string;
  actor: string;
  lifecycleUid: string;
}

export interface DelegatedRecoveryOrigin {
  space: string;
  accountPublicKey: string;
  managerInstanceId: string;
  managerLifecycleUid: string;
  assignmentRevision: number;
  enrollmentRegistrationRevision: number;
  enrollmentRegistrationDigest: string;
  enrollmentServeEpoch: number;
  intentId: string;
  target: DelegatedRecoveryTarget;
}

export interface DelegatedRecoveryLaunchPlan {
  agent: string;
  model?: string;
  variant?: string;
  events: boolean;
  sourceDigest: string;
}

export interface DelegatedRecoveryDescriptor {
  v: 1;
  intentId: string;
  origin: DelegatedRecoveryOrigin;
  target: DelegatedRecoveryTarget;
  runtimeKind: string;
  runtimeKey: string;
  launchIdentity: DelegatedRecoveryLaunchPlan & { role?: string; spawner: string; authorityParent: string };
  authorityDigest: string;
  localStoreBindingDigest: string;
  localStoreIdentityDigest: string;
}

export interface DelegatedRecoveryLocalProof {
  storeBindingDigest: string;
  storeIdentityDigest: string;
  actorTokenDigest: string;
  sentinelDigest: string;
}

export interface DelegatedRecoveryScanBinding {
  scanId: string;
  accountPublicKey: string;
  managerInstanceId: string;
  managerLifecycleUid: string;
  assignmentRevision: number;
  currentRegistrationRevision: number;
  currentServeEpoch: number;
  sourceRevision: number;
  memberCount: number;
  membersDigest: string;
}

export const DELEGATED_RECOVERY_REASONS = Object.freeze([
  "provider-unknown", "store-unavailable", "authority-unavailable", "identity-unverified",
  "descriptor-incomplete", "retiring", "authority-drift", "identity-changed", "scope-changed",
] as const);
export type DelegatedRecoveryReason = (typeof DELEGATED_RECOVERY_REASONS)[number];

export interface DelegatedRecoveryRecord {
  intentId: string;
  intentRevision: number;
  recoveryRevision: number;
  target: DelegatedRecoveryTarget;
  phase: "incomplete" | "prepared" | "create-unknown" | "eligible" | "bound" | "retiring" | "terminal";
  descriptor: DelegatedRecoveryDescriptor | null;
  descriptorDigest: string | null;
  authority: RetainedAgentAuthority | null;
  localProof: DelegatedRecoveryLocalProof | null;
  startedAt: string | null;
  executionIdentityDigest: string | null;
  reasonCode: DelegatedRecoveryReason | null;
}

interface RecoveryEnvelope extends RemoteManagerEnvelope {
  v: 1;
  kind: "manager-delegated-recovery";
  actor: "cli";
  accountPublicKey: string;
  assignmentRevision: number;
  currentRegistrationRevision: number;
  serveEpoch: number;
}

type RecoveryOperation =
  | { operation: "confirm"; body: { intentId: string; target: DelegatedRecoveryTarget; expectedIntentRevision: number; localProof: DelegatedRecoveryLocalProof } }
  | { operation: "scan"; body: { scanBinding?: DelegatedRecoveryScanBinding; cursor?: string } }
  | { operation: "claim"; body: { intentId: string; target: DelegatedRecoveryTarget; expectedRecoveryRevision: number; expectedOrigin: DelegatedRecoveryOrigin; attemptId: string; scanBinding: DelegatedRecoveryScanBinding } }
  | { operation: "settle"; body: { claimId: string; expectedRecoveryRevision: number; settleId: string } & ({ observation: "bound"; executionIdentityDigest: string } | { observation: "held"; reasonCode: DelegatedRecoveryReason }) }
  | { operation: "finish"; body: { scanBinding: DelegatedRecoveryScanBinding; finishId: string; expectedScopeRevision: number } }
  | { operation: "watch"; body: { afterRevision: number } };

/** Contract only. A host must opt in; the existing authority dispatch does not admit this family. */
export type RemoteDelegatedRecoveryRequest = RecoveryEnvelope & RecoveryOperation;

type RecoveryResultEnvelope = Pick<RecoveryEnvelope,
  "v" | "kind" | "space" | "accountPublicKey" | "assignmentRevision" | "instanceId" |
  "managerLifecycleUid" | "currentRegistrationRevision" | "serveEpoch" | "requestId">;

type RecoveryResult =
  | { operation: "confirm"; result: { intentId: string; target: DelegatedRecoveryTarget; intentRevision: number; recoveryRevision: number; prepared: true } }
  | { operation: "scan"; result: { scanBinding: DelegatedRecoveryScanBinding; records: DelegatedRecoveryRecord[]; nextCursor: string | null; complete: boolean } }
  | { operation: "claim"; result: { claimId: string; attemptId: string; record: DelegatedRecoveryRecord; claimEpoch: number } }
  | { operation: "settle"; result: { claimId: string; settleId: string; recoveryRevision: number; observation: "bound" | "held" } }
  | { operation: "finish"; result: { finishId: string; scanId: string; scopeRevision: number; admission: "open" } }
  | { operation: "watch"; result: { revision: number; scanInvalidated: boolean } };

export type RemoteDelegatedRecoveryResult = RecoveryResultEnvelope & (
  | ({ ok: true } & RecoveryResult)
  | { ok: false; operation: RecoveryOperation["operation"]; error: { code: "bad-request" | "permission-denied" | "conflict" | "unavailable" | "failed-precondition" | "unimplemented"; reasonCode?: DelegatedRecoveryReason } }
);

/** The separate parser keeps legacy hosts rejecting the extended launch instead of ignoring it. */
export type RemoteDelegatedRecoveryLaunchRequest = Omit<RemoteDelegatedUserIntentExecutionRequest, "execute"> & {
  execute: {
    operation: "launch";
    target: { actor: string; tokenHash: string };
    recoveryPlan: {
      runtimeKind: string;
      launch: DelegatedRecoveryLaunchPlan;
      localStoreBindingDigest: string;
      localStoreIdentityDigest: string;
    };
  };
};

function refuse(detail: string): never {
  throw new EpEnvelopeError("bad-request", `delegated recovery ${detail}`);
}

function object(raw: unknown, keys: readonly string[], required: readonly string[] = keys): Record<string, unknown> {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) refuse("requires an object");
  const value = raw as Record<string, unknown>;
  if (Reflect.ownKeys(value).some(key => typeof key !== "string" || !keys.includes(key))) refuse("carries an unknown field");
  if (required.some(key => !Object.hasOwn(value, key))) refuse("is missing a required field");
  return value;
}

function text(raw: unknown): string {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 1024 || /[\x00-\x1f]/.test(raw)) refuse("requires a bounded nonempty string");
  return raw;
}
function token(raw: unknown): string { return assertLifecycleToken(text(raw), "delegated recovery id"); }
function count(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isSafeInteger(raw) || raw < 0) refuse("requires a non-negative safe integer");
  return raw;
}
function flag(raw: unknown): boolean {
  if (typeof raw !== "boolean") refuse("requires a boolean");
  return raw;
}
function digest(raw: unknown): string {
  if (typeof raw !== "string" || !/^[0-9a-f]{64}$/.test(raw)) refuse("requires a SHA-256 digest");
  return raw;
}
function account(raw: unknown): string {
  if (!isAccountNkey(raw)) refuse("requires an account nkey");
  return raw;
}
function choice<const T extends readonly string[]>(raw: unknown, choices: T): T[number] {
  if (typeof raw !== "string" || !choices.includes(raw)) refuse("carries an unsupported value");
  return raw as T[number];
}
function nullable<T>(raw: unknown, parse: (value: unknown) => T): T | null { return raw === null ? null : parse(raw); }
function strings(raw: unknown): string[] {
  if (!Array.isArray(raw) || raw.length > 64) refuse("requires a list of at most 64 strings");
  return raw.map(text);
}
function sameTarget(a: DelegatedRecoveryTarget, b: DelegatedRecoveryTarget): void {
  if (a.owner !== b.owner || a.actor !== b.actor || a.lifecycleUid !== b.lifecycleUid) refuse("target does not match its binding");
}
function target(raw: unknown): DelegatedRecoveryTarget {
  const o = object(raw, ["owner", "actor", "lifecycleUid"]);
  return { owner: assertDerivedOwnerToken(text(o.owner)), actor: assertValidOwnerToken(text(o.actor)), lifecycleUid: token(o.lifecycleUid) };
}
function localProof(raw: unknown): DelegatedRecoveryLocalProof {
  const o = object(raw, ["storeBindingDigest", "storeIdentityDigest", "actorTokenDigest", "sentinelDigest"]);
  return { storeBindingDigest: digest(o.storeBindingDigest), storeIdentityDigest: digest(o.storeIdentityDigest), actorTokenDigest: digest(o.actorTokenDigest), sentinelDigest: digest(o.sentinelDigest) };
}
function launchPlan(raw: unknown): DelegatedRecoveryLaunchPlan {
  const o = object(raw, ["agent", "model", "variant", "events", "sourceDigest"], ["agent", "events", "sourceDigest"]);
  return { agent: text(o.agent), ...(Object.hasOwn(o, "model") ? { model: text(o.model) } : {}), ...(Object.hasOwn(o, "variant") ? { variant: text(o.variant) } : {}), events: flag(o.events), sourceDigest: digest(o.sourceDigest) };
}
function origin(raw: unknown): DelegatedRecoveryOrigin {
  const o = object(raw, ["space", "accountPublicKey", "managerInstanceId", "managerLifecycleUid", "assignmentRevision", "enrollmentRegistrationRevision", "enrollmentRegistrationDigest", "enrollmentServeEpoch", "intentId", "target"]);
  return { space: text(o.space), accountPublicKey: account(o.accountPublicKey), managerInstanceId: token(o.managerInstanceId), managerLifecycleUid: token(o.managerLifecycleUid), assignmentRevision: count(o.assignmentRevision), enrollmentRegistrationRevision: count(o.enrollmentRegistrationRevision), enrollmentRegistrationDigest: digest(o.enrollmentRegistrationDigest), enrollmentServeEpoch: count(o.enrollmentServeEpoch), intentId: token(o.intentId), target: target(o.target) };
}
function scanBinding(raw: unknown): DelegatedRecoveryScanBinding {
  const o = object(raw, ["scanId", "accountPublicKey", "managerInstanceId", "managerLifecycleUid", "assignmentRevision", "currentRegistrationRevision", "currentServeEpoch", "sourceRevision", "memberCount", "membersDigest"]);
  return { scanId: token(o.scanId), accountPublicKey: account(o.accountPublicKey), managerInstanceId: token(o.managerInstanceId), managerLifecycleUid: token(o.managerLifecycleUid), assignmentRevision: count(o.assignmentRevision), currentRegistrationRevision: count(o.currentRegistrationRevision), currentServeEpoch: count(o.currentServeEpoch), sourceRevision: count(o.sourceRevision), memberCount: count(o.memberCount), membersDigest: digest(o.membersDigest) };
}
function scopeMatches(binding: DelegatedRecoveryScanBinding, request: RecoveryEnvelope): void {
  if (binding.accountPublicKey !== request.accountPublicKey || binding.managerInstanceId !== request.instanceId || binding.managerLifecycleUid !== request.managerLifecycleUid || binding.assignmentRevision !== request.assignmentRevision || binding.currentRegistrationRevision !== request.currentRegistrationRevision || binding.currentServeEpoch !== request.serveEpoch) refuse("scan belongs to another scope or epoch");
}
function originMatches(binding: DelegatedRecoveryOrigin, request: RecoveryEnvelope): void {
  if (binding.space !== request.space || binding.accountPublicKey !== request.accountPublicKey || binding.managerInstanceId !== request.instanceId || binding.managerLifecycleUid !== request.managerLifecycleUid || binding.assignmentRevision !== request.assignmentRevision) refuse("origin belongs to another manager or assignment");
}

export function parseDelegatedRecoveryDescriptor(raw: unknown): DelegatedRecoveryDescriptor {
  const o = object(raw, ["v", "intentId", "origin", "target", "runtimeKind", "runtimeKey", "launchIdentity", "authorityDigest", "localStoreBindingDigest", "localStoreIdentityDigest"]);
  if (o.v !== 1) refuse("descriptor version is unsupported");
  const enrolled = origin(o.origin), child = target(o.target), intentId = token(o.intentId);
  sameTarget(enrolled.target, child);
  if (enrolled.intentId !== intentId) refuse("descriptor intent does not match its origin");
  const identity = object(o.launchIdentity, ["agent", "model", "variant", "events", "sourceDigest", "role", "spawner", "authorityParent"], ["agent", "events", "sourceDigest", "spawner", "authorityParent"]);
  const { role, spawner, authorityParent, ...plan } = identity;
  const launch = launchPlan(plan);
  const parent = text(authorityParent), principal = parsePrincipalKey(parent);
  if (!principal || principal.owner !== child.owner || text(spawner) !== parent) refuse("delegated spawner must be its original user's authority parent");
  const runtimeKey = text(o.runtimeKey);
  if (runtimeKey !== managedRuntimeKey({ space: enrolled.space, ...child })) refuse("runtime key does not match the lifecycle");
  return { v: 1, intentId, origin: enrolled, target: child, runtimeKind: text(o.runtimeKind), runtimeKey, launchIdentity: { ...launch, ...(Object.hasOwn(identity, "role") ? { role: text(role) } : {}), spawner: parent, authorityParent: parent }, authorityDigest: digest(o.authorityDigest), localStoreBindingDigest: digest(o.localStoreBindingDigest), localStoreIdentityDigest: digest(o.localStoreIdentityDigest) };
}

/** Parse structure and scope bindings; fresh host authority and durable CAS remain separate checks. */
export function parseRemoteDelegatedRecoveryRequest(raw: unknown): RemoteDelegatedRecoveryRequest {
  const o = object(raw, ["v", "kind", "actor", "space", "accountPublicKey", "assignmentRevision", "instanceId", "managerLifecycleUid", "currentRegistrationRevision", "serveEpoch", "registrationProof", "requestId", "identities", "operation", "body"]);
  const parsed = parseRemoteManagerEnvelope(o, "manager-delegated-recovery", "delegated recovery");
  if (parsed.actor !== "cli") refuse('actor must be "cli"');
  const envelope: RecoveryEnvelope = { ...parsed, v: 1, kind: "manager-delegated-recovery", actor: "cli", accountPublicKey: account(o.accountPublicKey), assignmentRevision: count(o.assignmentRevision), currentRegistrationRevision: count(o.currentRegistrationRevision), serveEpoch: count(o.serveEpoch) };
  switch (o.operation) {
    case "confirm": {
      const b = object(o.body, ["intentId", "target", "expectedIntentRevision", "localProof"]);
      return { ...envelope, operation: "confirm", body: { intentId: token(b.intentId), target: target(b.target), expectedIntentRevision: count(b.expectedIntentRevision), localProof: localProof(b.localProof) } };
    }
    case "scan": {
      const b = object(o.body, ["scanBinding", "cursor"], []);
      if (Object.hasOwn(b, "scanBinding") !== Object.hasOwn(b, "cursor")) refuse("scan cursor and binding must occur together");
      if (!Object.hasOwn(b, "scanBinding")) return { ...envelope, operation: "scan", body: {} };
      const binding = scanBinding(b.scanBinding);
      scopeMatches(binding, envelope);
      return { ...envelope, operation: "scan", body: { scanBinding: binding, cursor: text(b.cursor) } };
    }
    case "claim": {
      const b = object(o.body, ["intentId", "target", "expectedRecoveryRevision", "expectedOrigin", "attemptId", "scanBinding"]);
      const expectedOrigin = origin(b.expectedOrigin), child = target(b.target), intentId = token(b.intentId), binding = scanBinding(b.scanBinding);
      originMatches(expectedOrigin, envelope);
      scopeMatches(binding, envelope);
      sameTarget(expectedOrigin.target, child);
      if (expectedOrigin.intentId !== intentId) refuse("claim intent does not match its origin");
      return { ...envelope, operation: "claim", body: { intentId, target: child, expectedRecoveryRevision: count(b.expectedRecoveryRevision), expectedOrigin, attemptId: token(b.attemptId), scanBinding: binding } };
    }
    case "settle": {
      const b = object(o.body, ["claimId", "expectedRecoveryRevision", "settleId", "observation", "executionIdentityDigest", "reasonCode"], ["claimId", "expectedRecoveryRevision", "settleId", "observation"]);
      const common = { claimId: token(b.claimId), expectedRecoveryRevision: count(b.expectedRecoveryRevision), settleId: token(b.settleId) };
      if (b.observation === "bound" && !Object.hasOwn(b, "reasonCode")) return { ...envelope, operation: "settle", body: { ...common, observation: "bound", executionIdentityDigest: digest(b.executionIdentityDigest) } };
      if (b.observation === "held" && !Object.hasOwn(b, "executionIdentityDigest")) return { ...envelope, operation: "settle", body: { ...common, observation: "held", reasonCode: choice(b.reasonCode, DELEGATED_RECOVERY_REASONS) } };
      return refuse("settle must report bound identity or held reason, not both");
    }
    case "finish": {
      const b = object(o.body, ["scanBinding", "finishId", "expectedScopeRevision"]), binding = scanBinding(b.scanBinding);
      scopeMatches(binding, envelope);
      return { ...envelope, operation: "finish", body: { scanBinding: binding, finishId: token(b.finishId), expectedScopeRevision: count(b.expectedScopeRevision) } };
    }
    case "watch": {
      const b = object(o.body, ["afterRevision"]);
      return { ...envelope, operation: "watch", body: { afterRevision: count(b.afterRevision) } };
    }
    default: return refuse("operation is unsupported");
  }
}

export function parseRemoteDelegatedRecoveryLaunchRequest(raw: unknown): RemoteDelegatedRecoveryLaunchRequest {
  const o = object(raw, ["v", "kind", "space", "actor", "accountPublicKey", "assignmentRevision", "instanceId", "managerLifecycleUid", "requestId", "registrationProof", "serveEpoch", "identities", "intentId", "execute"]);
  const execute = object(o.execute, ["operation", "target", "recoveryPlan"]);
  const { recoveryPlan, ...legacyExecute } = execute;
  const legacy = parseRemoteDelegatedUserIntentExecutionRequest({ ...o, execute: legacyExecute });
  if (legacy.execute.operation !== "launch") refuse("recovery plan is only valid for a launch");
  const plan = object(recoveryPlan, ["runtimeKind", "launch", "localStoreBindingDigest", "localStoreIdentityDigest"]);
  return { ...legacy, execute: { ...legacy.execute, recoveryPlan: { runtimeKind: text(plan.runtimeKind), launch: launchPlan(plan.launch), localStoreBindingDigest: digest(plan.localStoreBindingDigest), localStoreIdentityDigest: digest(plan.localStoreIdentityDigest) } } };
}

function authority(raw: unknown): RetainedAgentAuthority {
  const o = object(raw, ["owner", "actor", "lifecycleUid", "scope", "allowSubscribe", "allowPublish", "role", "parent"], ["owner", "actor", "lifecycleUid", "scope", "allowSubscribe", "allowPublish"]);
  return { owner: assertDerivedOwnerToken(text(o.owner)), actor: assertValidOwnerToken(text(o.actor)), lifecycleUid: token(o.lifecycleUid), scope: strings(o.scope), allowSubscribe: strings(o.allowSubscribe), allowPublish: strings(o.allowPublish), ...(Object.hasOwn(o, "role") ? { role: text(o.role) } : {}), ...(Object.hasOwn(o, "parent") ? { parent: text(o.parent) } : {}) };
}
function record(raw: unknown): DelegatedRecoveryRecord {
  const o = object(raw, ["intentId", "intentRevision", "recoveryRevision", "target", "phase", "descriptor", "descriptorDigest", "authority", "localProof", "startedAt", "executionIdentityDigest", "reasonCode"]);
  const child = target(o.target), intentId = token(o.intentId), descriptor = nullable(o.descriptor, parseDelegatedRecoveryDescriptor), retained = nullable(o.authority, authority);
  if (descriptor) {
    sameTarget(descriptor.target, child);
    if (descriptor.intentId !== intentId) refuse("record intent does not match its descriptor");
  }
  if (retained) sameTarget(retained, child);
  const startedAt = nullable(o.startedAt, text), descriptorDigest = nullable(o.descriptorDigest, digest);
  const proof = nullable(o.localProof, localProof), executionIdentityDigest = nullable(o.executionIdentityDigest, digest);
  const phase = choice(o.phase, ["incomplete", "prepared", "create-unknown", "eligible", "bound", "retiring", "terminal"]);
  if (startedAt !== null && (!Number.isFinite(Date.parse(startedAt)) || new Date(startedAt).toISOString() !== startedAt)) refuse("birth time must be a canonical ISO instant");
  if ((descriptor === null) !== (descriptorDigest === null)) refuse("descriptor and its digest must occur together");
  if (descriptor && descriptorDigest !== contractDigest(descriptor).slice("sha256:".length)) refuse("descriptor digest does not match its content");
  if (descriptor && retained && (descriptor.authorityDigest !== contractDigest(retained).slice("sha256:".length) || retained.parent !== descriptor.launchIdentity.authorityParent || retained.role !== descriptor.launchIdentity.role)) refuse("retained authority does not match its descriptor");
  if (descriptor && proof && (proof.storeBindingDigest !== descriptor.localStoreBindingDigest || proof.storeIdentityDigest !== descriptor.localStoreIdentityDigest)) refuse("local store proof does not match its descriptor");
  if ((phase === "eligible" || phase === "bound") && [descriptor, retained, proof, startedAt, executionIdentityDigest].some(value => value === null)) refuse("eligible recovery lacks required evidence");
  return { intentId, intentRevision: count(o.intentRevision), recoveryRevision: count(o.recoveryRevision), target: child, phase, descriptor, descriptorDigest, authority: retained, localProof: proof, startedAt, executionIdentityDigest, reasonCode: nullable(o.reasonCode, value => choice(value, DELEGATED_RECOVERY_REASONS)) };
}

/** Bind every response to its request before a caller may act on any returned record. */
export function parseRemoteDelegatedRecoveryResult(raw: unknown, request: RemoteDelegatedRecoveryRequest): RemoteDelegatedRecoveryResult {
  const keys = ["v", "kind", "space", "accountPublicKey", "assignmentRevision", "instanceId", "managerLifecycleUid", "currentRegistrationRevision", "serveEpoch", "requestId", "operation", "ok"];
  const o = object(raw, [...keys, "result", "error"], keys);
  const header: RecoveryResultEnvelope = { v: request.v, kind: request.kind, space: request.space, accountPublicKey: request.accountPublicKey, assignmentRevision: request.assignmentRevision, instanceId: request.instanceId, managerLifecycleUid: request.managerLifecycleUid, currentRegistrationRevision: request.currentRegistrationRevision, serveEpoch: request.serveEpoch, requestId: request.requestId };
  for (const key of Object.keys(header) as (keyof RecoveryResultEnvelope)[]) if (o[key] !== header[key]) refuse(`response ${key} does not match its request`);
  if (o.operation !== request.operation) refuse("response operation does not match its request");
  if (o.ok === false && !Object.hasOwn(o, "result")) {
    const e = object(o.error, ["code", "reasonCode"], ["code"]);
    return { ...header, operation: request.operation, ok: false, error: { code: choice(e.code, ["bad-request", "permission-denied", "conflict", "unavailable", "failed-precondition", "unimplemented"]), ...(Object.hasOwn(e, "reasonCode") ? { reasonCode: choice(e.reasonCode, DELEGATED_RECOVERY_REASONS) } : {}) } };
  }
  if (o.ok !== true || Object.hasOwn(o, "error")) refuse("response must contain one result or error");
  switch (request.operation) {
    case "confirm": {
      const r = object(o.result, ["intentId", "target", "intentRevision", "recoveryRevision", "prepared"]), child = target(r.target);
      sameTarget(child, request.body.target);
      if (r.intentId !== request.body.intentId || r.prepared !== true) refuse("preparation reply does not match its request");
      return { ...header, ok: true, operation: "confirm", result: { intentId: request.body.intentId, target: child, intentRevision: count(r.intentRevision), recoveryRevision: count(r.recoveryRevision), prepared: true } };
    }
    case "scan": {
      const r = object(o.result, ["scanBinding", "records", "nextCursor", "complete"]), binding = scanBinding(r.scanBinding);
      scopeMatches(binding, request);
      if (request.body.scanBinding && canonicalJson(binding) !== canonicalJson(request.body.scanBinding)) refuse("scan binding changed during pagination");
      if (!Array.isArray(r.records) || r.records.length > 1024) refuse("scan page exceeds its bound");
      const records = r.records.map(record), nextCursor = nullable(r.nextCursor, text), complete = flag(r.complete);
      if (complete !== (nextCursor === null) || records.length > binding.memberCount) refuse("scan completeness is inconsistent");
      const seen = new Set<string>();
      for (const item of records) {
        if (seen.has(item.intentId)) refuse("scan page repeats an intent");
        seen.add(item.intentId);
        if (item.descriptor) originMatches(item.descriptor.origin, request);
      }
      return { ...header, ok: true, operation: "scan", result: { scanBinding: binding, records, nextCursor, complete } };
    }
    case "claim": {
      const r = object(o.result, ["claimId", "attemptId", "record", "claimEpoch"]), retained = record(r.record);
      if (r.attemptId !== request.body.attemptId || r.claimEpoch !== request.serveEpoch || retained.intentId !== request.body.intentId) refuse("claim reply does not match its request");
      sameTarget(retained.target, request.body.target);
      if (!retained.descriptor || canonicalJson(retained.descriptor.origin) !== canonicalJson(request.body.expectedOrigin)) refuse("claim origin differs from the expected origin");
      return { ...header, ok: true, operation: "claim", result: { claimId: token(r.claimId), attemptId: request.body.attemptId, record: retained, claimEpoch: request.serveEpoch } };
    }
    case "settle": {
      const r = object(o.result, ["claimId", "settleId", "recoveryRevision", "observation"]);
      if (r.claimId !== request.body.claimId || r.settleId !== request.body.settleId || r.observation !== request.body.observation) refuse("settlement reply does not match its request");
      return { ...header, ok: true, operation: "settle", result: { claimId: request.body.claimId, settleId: request.body.settleId, recoveryRevision: count(r.recoveryRevision), observation: request.body.observation } };
    }
    case "finish": {
      const r = object(o.result, ["finishId", "scanId", "scopeRevision", "admission"]);
      if (r.finishId !== request.body.finishId || r.scanId !== request.body.scanBinding.scanId || r.admission !== "open") refuse("finish reply does not match its request");
      return { ...header, ok: true, operation: "finish", result: { finishId: request.body.finishId, scanId: request.body.scanBinding.scanId, scopeRevision: count(r.scopeRevision), admission: "open" } };
    }
    case "watch": {
      const r = object(o.result, ["revision", "scanInvalidated"]);
      return { ...header, ok: true, operation: "watch", result: { revision: count(r.revision), scanInvalidated: flag(r.scanInvalidated) } };
    }
  }
}
