import { createHash } from "node:crypto";
import { canonicalJson, contractDigest, isContractDigest } from "./canonical.js";
import { CONTRACT_CLOSURE_MAX_ARTIFACTS } from "./contract-manifest.js";
import { CONTRACT_ARTIFACT_MAX_BYTES } from "./endpoint-contract-store.js";
import { EpEnvelopeError } from "./endpoint-error.js";
import { endpointToken, assertBoundedOwner } from "./endpoint-subjects.js";
import { parseServiceSpec, type ServiceSpec } from "./endpoint-service.js";
import { isAccountNkey } from "./identity.js";
import { assertDerivedOwnerToken, assertLifecycleToken, spacePrefix } from "./subjects.js";

export const SERVICE_ACCESS_TTL_SECONDS = 60;
export const SERVICE_RENEWAL_TTL_SECONDS = 24 * 60 * 60;
export const SERVICE_AUTHORITY_MAX_BYTES = 2 * 1024 * 1024;

export interface ServicePrincipal {
  owner: string;
  actor: string;
  lifecycleUid: string;
}

/** Public registration coordinates. Neither this witness nor its digest is a possession proof. */
export interface ServiceRegistrationWitness {
  accountPublicKey: string;
  space: string;
  endpoint: string;
  instanceId: string;
  principal: ServicePrincipal;
  rootCredentialId: string;
  approvalDigest: string;
  processEpoch: number;
  registrationRevision: number;
  nameAuthorityRevision: number;
  registrationRequestId: string;
  registrationProof: string;
}

export interface ServiceRegistration {
  clusterDigests: string[];
  contractArtifacts: unknown[];
}

/** Authenticated records and bytes, never a serialized EpServeGrant or caller-selected surface. */
export interface ServiceRegistrationSnapshot {
  spec: { value: ServiceSpec; revision: number };
  name: { authorized: true; revision: number };
  processEpoch: number;
  contractArtifacts: unknown[];
}

export interface ServiceAuthorityCoordinates {
  v: 1;
  kind: "service-endpoint-authority";
  requestId: string;
  space: string;
  accountPublicKey: string;
  endpoint: string;
  instanceId: string;
}

export type ServiceAuthorityRequest = ServiceAuthorityCoordinates & (
  | { operation: "register"; registration: ServiceRegistration; expected:
      | { state: "unregistered" }
      | { state: "registered"; witness: ServiceRegistrationWitness } }
  | { operation: "activate" | "renew" | "ready" | "revoke"; witness: ServiceRegistrationWitness }
  | { operation: "status"; target: { kind: "instance" } | { kind: "operation"; requestId: string } }
);

export type ServiceAuthorityProof =
  | { kind: "idp"; token: string }
  | { kind: "service-renewal"; token: string }
  | { kind: "service-access"; token: string };

export interface ServiceAuthorityEnvelope {
  request: ServiceAuthorityRequest;
  proof: ServiceAuthorityProof;
}

export type ServiceAuthorityStatus =
  | { state: "proposed"; proposalId: string; proposalDigest: string }
  | { state: "approved-unregistered"; approvalDigest: string }
  | { state: "registering" | "revoking"; operationId: string; phase: string; notBefore?: number }
  | { state: "registered"; witness: ServiceRegistrationWitness; snapshot: ServiceRegistrationSnapshot }
  | { state: "ready"; witness: ServiceRegistrationWitness; snapshot: ServiceRegistrationSnapshot; reportedAt: number }
  | { state: "retired"; operationId: string; witness: ServiceRegistrationWitness }
  | { state: "refused"; proposalId: string; reason: string }
  | { state: "superseded"; registrationRequestId: string; currentRegistrationRequestId: string };

export type ServiceAuthorityResult = ServiceAuthorityCoordinates & { operation: ServiceAuthorityRequest["operation"] } & (
  | { state: "approval-required"; proposalId: string; proposalDigest: string; approvalUrl?: string }
  | { state: "pending"; operationId: string; phase: string; notBefore?: number }
  | { state: "registered"; witness: ServiceRegistrationWitness; snapshot: ServiceRegistrationSnapshot }
  | { state: "credential"; witness: ServiceRegistrationWitness; duty: "serve";
      accessBearer: string; accessExpiresAt: number; renewalProof: string; renewalExpiresAt: number;
      snapshot: ServiceRegistrationSnapshot }
  | { state: "ready"; witness: ServiceRegistrationWitness; reportedAt: number }
  | { state: "status"; status: ServiceAuthorityStatus }
  | { state: "retired"; operationId: string; witness: ServiceRegistrationWitness }
  | { state: "denied"; reason: string }
);

const COMMON = ["v", "kind", "operation", "requestId", "space", "accountPublicKey", "endpoint", "instanceId"] as const;
const WITNESS = ["accountPublicKey", "space", "endpoint", "instanceId", "principal", "rootCredentialId", "approvalDigest", "processEpoch", "registrationRevision", "nameAuthorityRevision", "registrationRequestId", "registrationProof"] as const;
const OPERATIONS = ["register", "activate", "renew", "ready", "revoke", "status"] as const;
const RESULT_STATES: Record<ServiceAuthorityRequest["operation"], readonly string[]> = {
  register: ["approval-required", "pending", "registered", "denied"],
  activate: ["credential", "denied"],
  renew: ["credential", "denied"],
  ready: ["ready", "denied"],
  revoke: ["pending", "retired", "denied"],
  status: ["status", "denied"],
};
const PROOFS: Record<ServiceAuthorityRequest["operation"], readonly ServiceAuthorityProof["kind"][]> = {
  register: ["idp"], activate: ["idp", "service-renewal"], renew: ["service-renewal"],
  ready: ["service-access"], revoke: ["idp", "service-renewal"],
  status: ["idp", "service-renewal", "service-access"],
};

function invalid(detail: string): never {
  throw new EpEnvelopeError("bad-request", `service-endpoint authority: ${detail}`);
}

function record(raw: unknown, what: string): Record<string, unknown> {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) invalid(`${what} must be an object`);
  const proto = Object.getPrototypeOf(raw);
  if (proto !== Object.prototype && proto !== null) invalid(`${what} must be a plain object`);
  return raw as Record<string, unknown>;
}

function closed(o: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): void {
  if (required.some((k) => !Object.hasOwn(o, k)) ||
    Reflect.ownKeys(o).some((k) => typeof k !== "string" || (!required.includes(k) && !optional.includes(k))))
    invalid("object has missing or unsupported fields");
}

function text(raw: unknown, what: string, max = 128): string {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > max) invalid(`${what} must be bounded nonempty text`);
  return raw;
}

function integer(raw: unknown, what: string): number {
  if (typeof raw !== "number" || !Number.isSafeInteger(raw) || raw < 0) invalid(`${what} must be an unsigned safe integer`);
  return raw;
}

function requestId(raw: unknown): string {
  if (typeof raw !== "string" || !/^[0-9a-f]{32}$/.test(raw)) invalid("requestId must be 32 lowercase hex characters");
  return raw;
}

function digest(raw: unknown, what: string): string {
  if (typeof raw !== "string" || !isContractDigest(raw)) invalid(`${what} must be a canonical sha256 digest`);
  return raw;
}

function coordinates(o: Record<string, unknown>): void {
  if (o.v !== 1 || o.kind !== "service-endpoint-authority") invalid("unsupported version or kind");
  if (!OPERATIONS.includes(o.operation as ServiceAuthorityRequest["operation"])) invalid("unsupported operation");
  requestId(o.requestId);
  spacePrefix(text(o.space, "space"));
  if (typeof o.accountPublicKey !== "string" || !isAccountNkey(o.accountPublicKey)) invalid("invalid account public key");
  endpointToken(text(o.endpoint, "endpoint", 512));
  assertLifecycleToken(text(o.instanceId, "instanceId"), "instanceId");
}

function boundedJson(raw: unknown): string {
  let bytes: string;
  try { bytes = canonicalJson(raw); } catch { invalid("input must be canonicalizable JSON"); }
  if (Buffer.byteLength(bytes!, "utf8") > SERVICE_AUTHORITY_MAX_BYTES) invalid("JSON exceeds the authority envelope limit");
  return bytes!;
}

function artifacts(raw: unknown): void {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > CONTRACT_CLOSURE_MAX_ARTIFACTS)
    invalid("contractArtifacts must be a bounded nonempty array");
  const seen = new Set<string>();
  for (const artifact of raw) {
    record(artifact, "contract artifact");
    const bytes = boundedJson(artifact);
    if (Buffer.byteLength(bytes, "utf8") > CONTRACT_ARTIFACT_MAX_BYTES) invalid("contract artifact exceeds the native byte limit");
    const id = contractDigest(artifact);
    if (seen.has(id)) invalid("duplicate contract artifact");
    seen.add(id);
  }
}

export function parseServiceRegistrationWitness(raw: unknown): ServiceRegistrationWitness {
  const o = record(raw, "registration witness");
  closed(o, WITNESS);
  coordinates({ ...o, v: 1, kind: "service-endpoint-authority", operation: "activate", requestId: o.registrationRequestId });
  const principal = record(o.principal, "service principal");
  closed(principal, ["owner", "actor", "lifecycleUid"]);
  assertDerivedOwnerToken(text(principal.owner, "owner"));
  assertBoundedOwner(text(principal.actor, "actor"), "service actor");
  assertLifecycleToken(text(principal.lifecycleUid, "lifecycleUid"), "lifecycleUid");
  assertLifecycleToken(text(o.rootCredentialId, "rootCredentialId"), "rootCredentialId");
  digest(o.approvalDigest, "approvalDigest");
  digest(o.registrationProof, "registrationProof");
  for (const key of ["processEpoch", "registrationRevision", "nameAuthorityRevision"]) integer(o[key], key);
  const expectedActor = serviceEndpointActor({
    accountPublicKey: o.accountPublicKey as string, space: o.space as string, owner: principal.owner as string,
    endpoint: o.endpoint as string, instanceId: o.instanceId as string,
  });
  if (principal.actor !== expectedActor) invalid("serving actor does not match the assigned tuple");
  return JSON.parse(boundedJson(o)) as ServiceRegistrationWitness;
}

function boundWitness(raw: unknown, request: Record<string, unknown>): ServiceRegistrationWitness {
  const witness = parseServiceRegistrationWitness(raw);
  for (const key of ["accountPublicKey", "space", "endpoint", "instanceId"] as const)
    if (witness[key] !== request[key]) invalid("witness belongs to a different service assignment");
  return witness;
}

/** Parsing binds shape and identity only. Authentication and current native state remain host checks. */
export function parseServiceAuthorityRequest(raw: unknown): ServiceAuthorityRequest {
  const o = record(raw, "request");
  coordinates(o);
  switch (o.operation) {
    case "register": {
      closed(o, [...COMMON, "registration", "expected"]);
      const registration = record(o.registration, "registration");
      closed(registration, ["clusterDigests", "contractArtifacts"]);
      const digests = registration.clusterDigests;
      if (!Array.isArray(digests) || digests.length === 0 || digests.length > CONTRACT_CLOSURE_MAX_ARTIFACTS)
        invalid("clusterDigests must be a bounded nonempty array");
      digests.forEach((d) => digest(d, "cluster digest"));
      if (new Set(digests).size !== digests.length) invalid("duplicate cluster digest");
      artifacts(registration.contractArtifacts);
      const expected = record(o.expected, "expected registration");
      if (expected.state === "unregistered") closed(expected, ["state"]);
      else if (expected.state === "registered") {
        closed(expected, ["state", "witness"]);
        boundWitness(expected.witness, o);
      } else invalid("unsupported expected registration state");
      break;
    }
    case "status": {
      closed(o, [...COMMON, "target"]);
      const target = record(o.target, "status target");
      if (target.kind === "instance") closed(target, ["kind"]);
      else if (target.kind === "operation") {
        closed(target, ["kind", "requestId"]);
        requestId(target.requestId);
      } else invalid("unsupported status target");
      break;
    }
    default:
      closed(o, [...COMMON, "witness"]);
      boundWitness(o.witness, o);
  }
  return JSON.parse(boundedJson(o)) as ServiceAuthorityRequest;
}

export function parseServiceAuthorityEnvelope(raw: unknown): ServiceAuthorityEnvelope {
  const o = record(raw, "envelope");
  closed(o, ["request", "proof"]);
  const request = parseServiceAuthorityRequest(o.request);
  const proof = record(o.proof, "proof");
  closed(proof, ["kind", "token"]);
  if (!PROOFS[request.operation].includes(proof.kind as ServiceAuthorityProof["kind"]))
    invalid("proof kind is not admitted for this operation");
  text(proof.token, "proof token", 64 * 1024);
  boundedJson(o);
  return { request, proof: { kind: proof.kind, token: proof.token } as ServiceAuthorityProof };
}

function snapshot(raw: unknown, witness: ServiceRegistrationWitness): void {
  const o = record(raw, "registration snapshot");
  closed(o, ["spec", "name", "processEpoch", "contractArtifacts"]);
  const spec = record(o.spec, "spec snapshot"), name = record(o.name, "name snapshot");
  closed(spec, ["value", "revision"]);
  closed(name, ["authorized", "revision"]);
  const value = parseServiceSpec(spec.value, { endpoint: witness.endpoint });
  if (value.owner !== witness.principal.owner || spec.revision !== witness.registrationRevision ||
    name.authorized !== true || name.revision !== witness.nameAuthorityRevision || o.processEpoch !== witness.processEpoch)
    invalid("snapshot disagrees with the registration witness");
  artifacts(o.contractArtifacts);
}

function status(raw: unknown, outer: Record<string, unknown>): void {
  const o = record(raw, "status result");
  switch (o.state) {
    case "proposed":
      closed(o, ["state", "proposalId", "proposalDigest"]);
      text(o.proposalId, "proposalId"); digest(o.proposalDigest, "proposalDigest"); break;
    case "approved-unregistered":
      closed(o, ["state", "approvalDigest"]); digest(o.approvalDigest, "approvalDigest"); break;
    case "registering": case "revoking":
      closed(o, ["state", "operationId", "phase"], ["notBefore"]);
      text(o.operationId, "operationId"); text(o.phase, "phase");
      if (o.notBefore !== undefined) integer(o.notBefore, "notBefore"); break;
    case "registered": case "ready": {
      closed(o, ["state", "witness", "snapshot", ...(o.state === "ready" ? ["reportedAt"] : [])]);
      snapshot(o.snapshot, boundWitness(o.witness, outer));
      if (o.state === "ready") integer(o.reportedAt, "reportedAt"); break;
    }
    case "retired":
      closed(o, ["state", "operationId", "witness"]);
      text(o.operationId, "operationId"); boundWitness(o.witness, outer); break;
    case "refused":
      closed(o, ["state", "proposalId", "reason"]);
      text(o.proposalId, "proposalId"); text(o.reason, "reason"); break;
    case "superseded":
      closed(o, ["state", "registrationRequestId", "currentRegistrationRequestId"]);
      requestId(o.registrationRequestId); requestId(o.currentRegistrationRequestId); break;
    default: invalid("unsupported status state");
  }
}

/** Check a response against the request actually sent, not a response-supplied request echo. */
export function parseServiceAuthorityResult(raw: unknown, expected: ServiceAuthorityRequest): ServiceAuthorityResult {
  const request = parseServiceAuthorityRequest(expected);
  const o = record(raw, "result");
  coordinates(o);
  for (const key of COMMON) if (o[key] !== request[key]) invalid("result does not echo the submitted request");
  if (!RESULT_STATES[request.operation].includes(o.state as string)) invalid("result state is not admitted for this operation");
  const common = [...COMMON, "state"];
  switch (o.state) {
    case "approval-required": {
      closed(o, [...common, "proposalId", "proposalDigest"], ["approvalUrl"]);
      text(o.proposalId, "proposalId"); digest(o.proposalDigest, "proposalDigest");
      if (o.approvalUrl !== undefined) {
        let url: URL;
        try { url = new URL(text(o.approvalUrl, "approvalUrl", 2048)); } catch { invalid("invalid approval URL"); }
        if (url!.protocol !== "https:" || url!.username || url!.password || url!.hash) invalid("invalid approval URL");
      }
      break;
    }
    case "pending":
      closed(o, [...common, "operationId", "phase"], ["notBefore"]);
      text(o.operationId, "operationId"); text(o.phase, "phase");
      if (o.notBefore !== undefined) integer(o.notBefore, "notBefore"); break;
    case "registered": {
      closed(o, [...common, "witness", "snapshot"]);
      const witness = boundWitness(o.witness, o);
      if (witness.registrationRequestId !== request.requestId) invalid("registered result belongs to another operation");
      snapshot(o.snapshot, witness); break;
    }
    case "credential": {
      closed(o, [...common, "witness", "snapshot", "duty", "accessBearer", "accessExpiresAt", "renewalProof", "renewalExpiresAt"]);
      if (o.duty !== "serve") invalid("unsupported service duty");
      const witness = boundWitness(o.witness, o);
      if (!("witness" in request) || serviceWitnessDigest(witness) !== serviceWitnessDigest(request.witness))
        invalid("credential does not bind the submitted registration witness");
      snapshot(o.snapshot, witness);
      text(o.accessBearer, "access bearer", 64 * 1024); text(o.renewalProof, "renewal proof", 64 * 1024);
      integer(o.accessExpiresAt, "accessExpiresAt"); integer(o.renewalExpiresAt, "renewalExpiresAt");
      break;
    }
    case "ready": {
      closed(o, [...common, "witness", "reportedAt"]);
      const witness = boundWitness(o.witness, o);
      if (!("witness" in request) || serviceWitnessDigest(witness) !== serviceWitnessDigest(request.witness))
        invalid("ready result does not bind the submitted witness");
      integer(o.reportedAt, "reportedAt"); break;
    }
    case "status":
      closed(o, [...common, "status"]); status(o.status, o); break;
    case "retired": {
      closed(o, [...common, "operationId", "witness"]);
      text(o.operationId, "operationId");
      const witness = boundWitness(o.witness, o);
      if (!("witness" in request) || serviceWitnessDigest(witness) !== serviceWitnessDigest(request.witness))
        invalid("retired result does not bind the submitted witness");
      break;
    }
    case "denied":
      closed(o, [...common, "reason"]); text(o.reason, "reason"); break;
  }
  return JSON.parse(boundedJson(o)) as ServiceAuthorityResult;
}

/** Deterministic bounded spelling; the host must also reject persisted tuple/alias collisions. */
export function serviceEndpointActor(tuple: {
  accountPublicKey: string; space: string; owner: string; endpoint: string; instanceId: string;
}): string {
  if (!isAccountNkey(tuple.accountPublicKey)) invalid("invalid service account public key");
  spacePrefix(tuple.space); assertDerivedOwnerToken(tuple.owner); endpointToken(tuple.endpoint);
  assertLifecycleToken(tuple.instanceId, "instanceId");
  const bytes = canonicalJson([1, tuple.accountPublicKey, tuple.space, tuple.owner, tuple.endpoint, tuple.instanceId, "serve"]);
  return `svc_${createHash("sha256").update(bytes, "utf8").digest("base64url")}`;
}

export function serviceWitnessDigest(witness: ServiceRegistrationWitness): string {
  return contractDigest(parseServiceRegistrationWitness(witness));
}

/** Proof secrets are excluded; changing a request body under its persisted id is a conflict. */
export function serviceAuthorityRequestDigest(request: ServiceAuthorityRequest): string {
  return contractDigest(parseServiceAuthorityRequest(request));
}
