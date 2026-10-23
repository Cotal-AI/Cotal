import { createHash } from "node:crypto";
import { canonicalJson, contractDigest, isContractDigest } from "./canonical.js";
import { CONTRACT_CLOSURE_MAX_ARTIFACTS } from "./contract-manifest.js";
import { CONTRACT_ARTIFACT_MAX_BYTES } from "./endpoint-contract-store.js";
import { EpEnvelopeError } from "./endpoint-error.js";
import { endpointToken, assertBoundedOwner, assertCommandToken, parseEpSubject, MAX_EP_SUBJECT_BYTES } from "./endpoint-subjects.js";
import { parseServiceSpec, type ServiceSpec } from "./endpoint-service.js";
import { isAccountNkey } from "./identity.js";
import { assertDerivedOwnerToken, assertLifecycleToken, spacePrefix } from "./subjects.js";

import { SERVICE_AUTHORITY_MAX_BYTES, SERVICE_DESCRIBE_QUERY_BUDGET_MS } from "./service-authority-limits.js";
export { SERVICE_ACCESS_TTL_SECONDS, SERVICE_RENEWAL_TTL_SECONDS, SERVICE_AUTHORITY_MAX_BYTES, SERVICE_DESCRIBE_QUERY_BUDGET_MS } from "./service-authority-limits.js";

/** One published Ed25519 verification key of the service authority's issuer: the public
 *  coordinate only, as the door projects its JWKS. */
export interface ServiceIssuerKey {
  kty: "OKP";
  crv: "Ed25519";
  kid: string;
  x: string;
}

/** Non-authorizing account metadata read through the client's already-pinned authority origin,
 *  with the issuer identity a guest verifies its service access bearer under: the same origin,
 *  tenant path included, that mints the bearer. */
export interface ServiceAuthorityInfo {
  v: 1;
  kind: "service-endpoint-authority-info";
  space: string;
  accountPublicKey: string;
  /** The exact `iss` the authority mints into its service access bearers. */
  issuer: string;
  /** The authority's published verification keys, the set its `GET /jwks` serves. */
  keys: readonly ServiceIssuerKey[];
}

/** A transport failure never permits a new mutation identity or an unqualified replay. */
export class ServiceAuthorityTransportError extends Error {
  constructor(message: string, readonly outcome: "not-executed" | "unknown", readonly httpStatus?: number) {
    super(message);
    this.name = "ServiceAuthorityTransportError";
  }
}

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

export interface ServiceDescribeObservation {
  subject: string;
  fingerprint: string;
}

export type ServiceAuthorityRequest = ServiceAuthorityCoordinates & (
  | { operation: "register"; registration: ServiceRegistration; expected:
      | { state: "unregistered" }
      | { state: "registered"; witness: ServiceRegistrationWitness } }
  | { operation: "activate" | "renew" | "ready" | "revoke"; witness: ServiceRegistrationWitness }
  | { operation: "describe-view"; witness: ServiceRegistrationWitness; observation: ServiceDescribeObservation }
  | { operation: "status"; target: ServiceStatusTarget }
);

/** Effectful operations a status query can name; status and Describe queries write nothing to look up. */
export type ServiceStatusOperation = "register" | "activate" | "renew" | "ready" | "revoke";
export type ServiceStatusTarget =
  | { kind: "instance" }
  | { kind: "operation"; operation: ServiceStatusOperation; requestId: string };

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
  | { state: "view"; witness: ServiceRegistrationWitness; observation: ServiceDescribeObservation;
      basis: "principal-policy-v1"; commands: string[]; validForMs: number }
  | { state: "status"; status: ServiceAuthorityStatus }
  | { state: "retired"; operationId: string; witness: ServiceRegistrationWitness }
  | { state: "denied"; reason: string }
);

const COMMON = ["v", "kind", "operation", "requestId", "space", "accountPublicKey", "endpoint", "instanceId"] as const;
const WITNESS = ["accountPublicKey", "space", "endpoint", "instanceId", "principal", "rootCredentialId", "approvalDigest", "processEpoch", "registrationRevision", "nameAuthorityRevision", "registrationRequestId", "registrationProof"] as const;
const OPERATIONS = ["register", "activate", "renew", "ready", "revoke", "status", "describe-view"] as const;
const STATUS_OPERATIONS: readonly ServiceStatusOperation[] = ["register", "activate", "renew", "ready", "revoke"];
const RESULT_STATES: Record<ServiceAuthorityRequest["operation"], readonly string[]> = {
  register: ["approval-required", "pending", "registered", "denied"],
  activate: ["credential", "denied"],
  renew: ["credential", "denied"],
  ready: ["ready", "denied"],
  revoke: ["pending", "retired", "denied"],
  status: ["status", "denied"],
  "describe-view": ["view", "denied"],
};
const PROOFS: Record<ServiceAuthorityRequest["operation"], readonly ServiceAuthorityProof["kind"][]> = {
  register: ["idp"], activate: ["idp", "service-renewal"], renew: ["service-renewal"],
  ready: ["service-access"], revoke: ["idp", "service-renewal"],
  status: ["idp", "service-renewal", "service-access"],
  "describe-view": ["service-access"],
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

function artifacts(raw: unknown, closureCount: number): void {
  // Each native closure counts documents separately from its manifest. The HTTP byte bound
  // still caps the union, and the host must verify each closure's own walk limits.
  if (!Number.isSafeInteger(closureCount) || closureCount < 1 || closureCount > CONTRACT_CLOSURE_MAX_ARTIFACTS)
    invalid("clusterDigests must be a bounded nonempty array");
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > closureCount * (CONTRACT_CLOSURE_MAX_ARTIFACTS + 1))
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

/** How many verification keys an issuer may publish at once: the active key plus the retired
 *  kids still published for their max-age window. */
const ISSUER_KEYS_MAX = 16;
/** Unpadded base64url of a 32-byte Ed25519 public coordinate. */
const ED25519_X = /^[A-Za-z0-9_-]{43}$/;

function issuerKeys(raw: unknown): ServiceIssuerKey[] {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > ISSUER_KEYS_MAX) invalid("keys must be a bounded nonempty array");
  const kids = new Set<string>();
  return raw.map((entry) => {
    const o = record(entry, "issuer key");
    closed(o, ["kty", "crv", "kid", "x"]);
    if (o.kty !== "OKP" || o.crv !== "Ed25519") invalid("issuer key must be an Ed25519 public key");
    const kid = text(o.kid, "kid", 256);
    if (kids.has(kid)) invalid("duplicate issuer kid");
    kids.add(kid);
    if (typeof o.x !== "string" || !ED25519_X.test(o.x)) invalid("issuer key x must be a 32-byte base64url coordinate");
    return { kty: "OKP", crv: "Ed25519", kid, x: o.x };
  });
}

export function parseServiceAuthorityInfo(raw: unknown, expectedSpace: string): ServiceAuthorityInfo {
  const o = record(raw, "authority info");
  closed(o, ["v", "kind", "space", "accountPublicKey", "issuer", "keys"]);
  spacePrefix(expectedSpace);
  if (o.v !== 1 || o.kind !== "service-endpoint-authority-info" || o.space !== expectedSpace)
    invalid("authority info does not match this space and protocol");
  if (typeof o.accountPublicKey !== "string" || !isAccountNkey(o.accountPublicKey)) invalid("invalid DATA-account public key");
  return {
    v: 1, kind: "service-endpoint-authority-info", space: expectedSpace, accountPublicKey: o.accountPublicKey,
    issuer: text(o.issuer, "issuer", 2048), keys: issuerKeys(o.keys),
  };
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

function observation(raw: unknown, outer: Record<string, unknown>): ServiceDescribeObservation {
  const o = record(raw, "Describe observation");
  closed(o, ["subject", "fingerprint"]);
  const subject = text(o.subject, "Describe subject", MAX_EP_SUBJECT_BYTES);
  const parsed = parseEpSubject(subject);
  if (!subject.startsWith(`${spacePrefix(outer.space as string)}.ep.`) || !parsed || parsed.plane !== "request"
    || parsed.command !== "describe" || parsed.endpoint !== outer.endpoint || parsed.target !== null
    || (parsed.route === "inst" && parsed.instanceId !== outer.instanceId))
    invalid("Describe observation does not name this service");
  return { subject, fingerprint: digest(o.fingerprint, "Describe fingerprint") };
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
      artifacts(registration.contractArtifacts, digests.length);
      const expected = record(o.expected, "expected registration");
      if (expected.state === "unregistered") closed(expected, ["state"]);
      else if (expected.state === "registered") {
        closed(expected, ["state", "witness"]);
        boundWitness(expected.witness, o);
      } else invalid("unsupported expected registration state");
      break;
    }
    case "describe-view":
      closed(o, [...COMMON, "witness", "observation"]);
      boundWitness(o.witness, o); observation(o.observation, o); break;
    case "status": {
      closed(o, [...COMMON, "target"]);
      const target = record(o.target, "status target");
      if (target.kind === "instance") closed(target, ["kind"]);
      else if (target.kind === "operation") {
        closed(target, ["kind", "operation", "requestId"]);
        if (!STATUS_OPERATIONS.includes(target.operation as ServiceStatusOperation)) invalid("unsupported status operation");
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

function snapshot(raw: unknown, witness: ServiceRegistrationWitness): ServiceSpec {
  const o = record(raw, "registration snapshot");
  closed(o, ["spec", "name", "processEpoch", "contractArtifacts"]);
  const spec = record(o.spec, "spec snapshot"), name = record(o.name, "name snapshot");
  closed(spec, ["value", "revision"]);
  closed(name, ["authorized", "revision"]);
  const value = parseServiceSpec(spec.value, { endpoint: witness.endpoint });
  if (value.owner !== witness.principal.owner || spec.revision !== witness.registrationRevision ||
    name.authorized !== true || name.revision !== witness.nameAuthorityRevision || o.processEpoch !== witness.processEpoch)
    invalid("snapshot disagrees with the registration witness");
  artifacts(o.contractArtifacts, value.clusterDigests.length);
  return value;
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
      const spec = snapshot(o.snapshot, witness);
      if (request.operation !== "register" || canonicalJson([...spec.clusterDigests].sort()) !== canonicalJson([...request.registration.clusterDigests].sort()))
        invalid("registered result does not bind the submitted closure set");
      break;
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
    case "view": {
      closed(o, [...common, "witness", "observation", "basis", "commands", "validForMs"]);
      if (request.operation !== "describe-view") invalid("view result requires a Describe query");
      const witness = boundWitness(o.witness, o), observed = observation(o.observation, o);
      if (serviceWitnessDigest(witness) !== serviceWitnessDigest(request.witness)
        || canonicalJson(observed) !== canonicalJson(request.observation) || o.basis !== "principal-policy-v1")
        invalid("view result does not bind this query and principal-policy basis");
      if (!Array.isArray(o.commands) || new Set(o.commands).size !== o.commands.length) invalid("view commands must be a unique array");
      for (const command of o.commands) assertCommandToken(text(command, "view command", 32));
      const validity = integer(o.validForMs, "view validity");
      if (validity === 0 || validity > SERVICE_DESCRIBE_QUERY_BUDGET_MS) invalid("view validity exceeds its query budget");
      break;
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
  const hash = createHash("sha256").update(bytes, "utf8").digest("hex");
  return assertBoundedOwner(`svc_${BigInt(`0x${hash}`).toString(36).padStart(50, "0")}`, "service actor");
}

export function serviceWitnessDigest(witness: ServiceRegistrationWitness): string {
  return contractDigest(parseServiceRegistrationWitness(witness));
}

/** Proof secrets are excluded; changing a request body under its persisted id is a conflict. */
export function serviceAuthorityRequestDigest(request: ServiceAuthorityRequest): string {
  return contractDigest(parseServiceAuthorityRequest(request));
}
