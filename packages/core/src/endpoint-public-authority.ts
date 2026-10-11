import { createHash } from "node:crypto";
import { fromPublic } from "@nats-io/nkeys";
import { importJWK, jwtVerify } from "jose";
import { canonicalJson, rawDigest } from "./canonical.js";
import { EpEnvelopeError } from "./endpoint-envelope.js";
import { endpointToken, assertLifecycleToken, assertBoundedOwner, assertCommandToken, type EpCaller } from "./endpoint-subjects.js";
import { parseEndpointServingAuthorityRef, type EndpointAccountPin, type EndpointServingAuthorityRef } from "./endpoint-authority-policy.js";
import { isLoopbackLiteral } from "./loopback.js";
import type { SecretStore } from "./secret-store.js";
import type { ResolvedService } from "./endpoint-invoke.js";
import { endpointRegisteredClusterSetDigest } from "./endpoint-cluster.js";

export interface EndpointDeploymentAssignment {
  account: EndpointAccountPin;
  lifecycleUid: string;
  state: "active";
  expiresAt: number;
}
/** Trusted deployment adapter. The operation and assignment writers share one transaction lock.
 * The host still checks clock expiry immediately before each material release. */
export interface EndpointAuthorityDeployment {
  assignment: Readonly<EndpointDeploymentAssignment>;
  withCurrentAssignment<T>(expected: Readonly<EndpointDeploymentAssignment>, operation: () => Promise<T>): Promise<T>;
}
export interface EndpointIssuerPublicKey { kty: "OKP"; crv: "Ed25519"; x: string; kid: string; alg: "EdDSA"; use: "sig" }
export interface EndpointNativeAuthorityPin { endpoint: "auth"; instanceId: string; epoch: number }
export interface EndpointDeploymentTrust {
  account: EndpointAccountPin;
  assignmentLifecycleUid: string;
  assignmentExpiresAt: number;
  issuer: string;
  keys: readonly EndpointIssuerPublicKey[];
  accountSigningKey: string;
  authority: EndpointNativeAuthorityPin;
}
export interface EndpointDeploymentTrustRecord {
  v: 2; kind: "cotal.endpoint-deployment-trust"; space: string; exchangeOrigin: string; provisionedAt: number;
  trust: EndpointDeploymentTrust;
}
export interface EndpointCallerSelection { endpoint: string; instanceId: string; commands: readonly string[] }
export interface EndpointCallerAuthorityRequest {
  store: SecretStore; dir: string; space: string; actor: string;
  trust: EndpointDeploymentTrust; selection: EndpointCallerSelection;
}
export interface EndpointServingControlAuthorityRequest extends EndpointCallerAuthorityRequest {
  credentialDigest: string;
  holder: { publicKey: string; sign(bytes: Uint8Array): Promise<Uint8Array> };
}
interface EndpointCallerAuthorityReceiptBase {
  iss: string; aud: string; iat: number; exp: number; jti: string;
  v: 3;
  account: EndpointAccountPin; assignmentLifecycleUid: string; authority: EndpointNativeAuthorityPin;
  principal: EpCaller; selection: EndpointCallerSelection; servingAuthority: EndpointServingAuthorityRef;
  registrationRevision: number; processEpoch: number; clusterDigests: readonly string[]; bearerDigest: string;
}
export type EndpointCallerAuthorityReceipt = EndpointCallerAuthorityReceiptBase & (
  { kind: "cotal.endpoint-caller"; privateClusterDigests: readonly string[] }
  | { kind: "cotal.endpoint-control" }
);
export interface EndpointCallerAuthorityMaterial { bearer: string; sentinelCreds: string; receipt: Readonly<EndpointCallerAuthorityReceipt> }

function denied(message: string): never { throw new EpEnvelopeError("permission-denied", message, undefined, "not-executed"); }
function closed(raw: unknown, fields: readonly string[], name: string): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) denied(`${name} must be an object`);
  const value = raw as Record<string, unknown>;
  if (Object.keys(value).length !== fields.length || fields.some(key => !Object.hasOwn(value, key)) || Object.keys(value).some(key => !fields.includes(key))) denied(`${name} requires its closed shape`);
  return value;
}
function integer(raw: unknown, min: number, label: string): number {
  if (typeof raw !== "number" || !Number.isSafeInteger(raw) || raw < min) denied(`${label} is not a safe integer`);
  return raw;
}
function text(raw: unknown, label: string): string { if (typeof raw !== "string" || !raw) denied(`${label} is not a nonempty string`); return raw; }
function freeze<T>(value: T): Readonly<T> {
  if (value && typeof value === "object") { for (const member of Object.values(value)) freeze(member); Object.freeze(value); }
  return value;
}
export function endpointExchangeOrigin(raw: string): string {
  const url = new URL(raw);
  if (url.username || url.password || url.search || url.hash || (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopbackLiteral(url.hostname)))) denied("endpoint deployment exchange requires HTTPS or literal loopback HTTP without credentials/query/hash");
  return url.origin;
}
export function parseEndpointAccountPin(raw: unknown): Readonly<EndpointAccountPin> {
  const value = closed(raw, ["space", "accountPublicKey", "assignmentRevision"], "endpoint account");
  const space = text(value.space, "space"), accountPublicKey = text(value.accountPublicKey, "account public key");
  endpointToken(space);
  if (!/^A[A-Z2-7]{55}$/.test(accountPublicKey)) denied("invalid endpoint account public key");
  fromPublic(accountPublicKey);
  return freeze({ space, accountPublicKey, assignmentRevision: integer(value.assignmentRevision, 1, "assignment revision") });
}
export function parseEndpointNativeAuthorityPin(raw: unknown): Readonly<EndpointNativeAuthorityPin> {
  const value = closed(raw, ["endpoint", "instanceId", "epoch"], "native endpoint authority");
  if (value.endpoint !== "auth") denied("native endpoint authority must name auth");
  return freeze({ endpoint: "auth" as const, instanceId: assertLifecycleToken(text(value.instanceId, "auth instance")), epoch: integer(value.epoch, 0, "auth epoch") });
}
export function parseEndpointDeploymentAssignment(raw: unknown): Readonly<EndpointDeploymentAssignment> {
  const value = closed(raw, ["account", "lifecycleUid", "state", "expiresAt"], "endpoint deployment assignment");
  if (value.state !== "active") denied("endpoint deployment assignment is not active");
  const expiresAt = integer(value.expiresAt, 1, "assignment expiry");
  if (expiresAt <= Math.floor(Date.now() / 1000)) denied("endpoint deployment assignment expired");
  return freeze({ account: parseEndpointAccountPin(value.account), lifecycleUid: assertLifecycleToken(text(value.lifecycleUid, "assignment lifecycle")), state: "active" as const, expiresAt });
}
export function parseEndpointDeploymentTrust(raw: unknown): Readonly<EndpointDeploymentTrust> {
  const value = closed(raw, ["account", "assignmentLifecycleUid", "assignmentExpiresAt", "issuer", "keys", "accountSigningKey", "authority"], "endpoint deployment trust");
  const account = parseEndpointAccountPin(value.account), assignmentExpiresAt = integer(value.assignmentExpiresAt, 1, "assignment expiry");
  if (assignmentExpiresAt <= Math.floor(Date.now() / 1000)) denied("endpoint deployment trust expired");
  const issuer = text(value.issuer, "endpoint issuer"), accountSigningKey = text(value.accountSigningKey, "account signing key");
  if (issuer.length > 2048 || !/^A[A-Z2-7]{55}$/.test(accountSigningKey)) denied("unsupported endpoint issuer/account signing key");
  fromPublic(accountSigningKey);
  if (!Array.isArray(value.keys) || value.keys.length < 1 || value.keys.length > 8) denied("endpoint trust needs a bounded public issuer key set");
  const keys = value.keys.map(rawKey => {
    const key = closed(rawKey, ["kty", "crv", "x", "kid", "alg", "use"], "endpoint issuer key");
    if (key.kty !== "OKP" || key.crv !== "Ed25519" || key.alg !== "EdDSA" || key.use !== "sig" || typeof key.x !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(key.x)) denied("endpoint issuer key must be public Ed25519");
    const kid = createHash("sha256").update(canonicalJson({ crv: "Ed25519", kty: "OKP", x: key.x })).digest("base64url");
    if (key.kid !== kid || Buffer.from(key.x, "base64url").length !== 32) denied("endpoint issuer key thumbprint mismatch");
    return { kty: "OKP" as const, crv: "Ed25519" as const, x: key.x, kid, alg: "EdDSA" as const, use: "sig" as const };
  });
  if (new Set(keys.map(key => key.kid)).size !== keys.length) denied("duplicate endpoint issuer key");
  return freeze({ account, assignmentLifecycleUid: assertLifecycleToken(text(value.assignmentLifecycleUid, "assignment lifecycle")), assignmentExpiresAt, issuer, keys, accountSigningKey, authority: parseEndpointNativeAuthorityPin(value.authority) });
}
/** Syntax and pin validation only. The workspace reader must first prove its authenticated
 * protected-root configuration boundary. This function does not authenticate arbitrary JSON. */
export function parseEndpointDeploymentTrustRecord(raw: unknown, expected: { space: string; exchangeOrigin: string }): Readonly<EndpointDeploymentTrustRecord> {
  const value = closed(raw, ["v", "kind", "space", "exchangeOrigin", "provisionedAt", "trust"], "endpoint trust record");
  if (value.v !== 2 || value.kind !== "cotal.endpoint-deployment-trust" || value.space !== expected.space) denied("endpoint trust record kind/space mismatch");
  const exchangeOrigin = text(value.exchangeOrigin, "exchange origin"), normalized = endpointExchangeOrigin(exchangeOrigin);
  if (exchangeOrigin !== normalized || normalized !== endpointExchangeOrigin(expected.exchangeOrigin)) denied("endpoint trust record exchange origin mismatch");
  const provisionedAt = integer(value.provisionedAt, 1, "provisioned time"), trust = parseEndpointDeploymentTrust(value.trust);
  if (provisionedAt > Math.floor(Date.now() / 1000) || provisionedAt >= trust.assignmentExpiresAt || trust.account.space !== expected.space) denied("endpoint trust record account/time mismatch");
  return freeze({ v: 2 as const, kind: "cotal.endpoint-deployment-trust" as const, space: expected.space, exchangeOrigin, provisionedAt, trust });
}
export function parseEndpointCallerSelection(raw: unknown): Readonly<EndpointCallerSelection> {
  const value = closed(raw, ["endpoint", "instanceId", "commands"], "endpoint selection");
  const endpoint = text(value.endpoint, "endpoint"), instanceId = assertLifecycleToken(text(value.instanceId, "serving instance")); endpointToken(endpoint);
  if (!Array.isArray(value.commands) || value.commands.length < 1 || value.commands.length > 32 || value.commands.some(command => typeof command !== "string")) denied("endpoint selection needs bounded explicit commands");
  const commands = value.commands.map(command => assertCommandToken(command));
  if (!commands.includes("describe") || new Set(commands).size !== commands.length) denied("endpoint selection requires describe and unique commands");
  return freeze({ endpoint, instanceId, commands: [...commands].sort() });
}
export function endpointControlProof(request: { requestId: string; trust: EndpointDeploymentTrust; selection: EndpointCallerSelection; credentialDigest: string }): Uint8Array {
  return new TextEncoder().encode(canonicalJson({ kind: "cotal.endpoint-control", requestId: request.requestId, account: request.trust.account, assignmentLifecycleUid: request.trust.assignmentLifecycleUid, authority: request.trust.authority, endpoint: request.selection.endpoint, instanceId: request.selection.instanceId, credentialDigest: request.credentialDigest }));
}
export async function verifyEndpointCallerAuthorityReceipt(args: {
  receipt: string; bearer: string; trust: EndpointDeploymentTrust; requestId: string;
  selection: EndpointCallerSelection; principal: EpCaller; control?: boolean;
}): Promise<Readonly<EndpointCallerAuthorityReceipt>> {
  const trust = parseEndpointDeploymentTrust(args.trust), selection = parseEndpointCallerSelection(args.selection);
  if (typeof args.receipt !== "string" || args.receipt.length > 32768 || typeof args.bearer !== "string" || args.bearer.length > 32768) denied("endpoint caller material exceeds byte bound");
  const typ = args.control ? "cotal.endpoint-control+jwt" : "cotal.endpoint-caller+jwt";
  const verified = await jwtVerify(args.receipt, async header => {
    closed(header, ["alg", "kid", "typ"], "endpoint receipt header");
    if (header.alg !== "EdDSA" || header.typ !== typ) denied("unsupported endpoint receipt header");
    const key = trust.keys.find(key => key.kid === header.kid);
    if (!key) denied("unknown endpoint receipt key");
    return importJWK(key, "EdDSA");
  }, { algorithms: ["EdDSA"], issuer: trust.issuer, audience: trust.account.space, clockTolerance: 0 });
  const value = closed(verified.payload, ["iss", "aud", "iat", "exp", "jti", "v", "kind", "account", "assignmentLifecycleUid", "authority", "principal", "selection", "servingAuthority", "registrationRevision", "processEpoch", "clusterDigests", "bearerDigest", ...(args.control ? [] : ["privateClusterDigests"])], "endpoint receipt");
  const now = Math.floor(Date.now() / 1000), iat = integer(value.iat, 1, "receipt iat"), exp = integer(value.exp, 1, "receipt exp");
  if (value.iss !== trust.issuer || value.aud !== trust.account.space || value.jti !== assertLifecycleToken(args.requestId) || value.v !== 3 || value.kind !== (args.control ? "cotal.endpoint-control" : "cotal.endpoint-caller") || iat > now || exp <= iat || exp <= now || exp > iat + 120 || exp > trust.assignmentExpiresAt) denied("endpoint receipt issuer/audience/request/time mismatch");
  const account = parseEndpointAccountPin(value.account), authority = parseEndpointNativeAuthorityPin(value.authority), returnedSelection = parseEndpointCallerSelection(value.selection);
  const p = closed(value.principal, ["owner", "actor", "uid"], "endpoint receipt principal"), principal = { owner: assertBoundedOwner(text(p.owner, "caller owner"), "caller owner"), actor: assertBoundedOwner(text(p.actor, "caller actor"), "caller actor"), uid: assertLifecycleToken(text(p.uid, "caller lifecycle")) };
  if (canonicalJson(account) !== canonicalJson(trust.account) || value.assignmentLifecycleUid !== trust.assignmentLifecycleUid || canonicalJson(authority) !== canonicalJson(trust.authority) || canonicalJson(returnedSelection) !== canonicalJson(selection) || canonicalJson(principal) !== canonicalJson(args.principal) || value.bearerDigest !== rawDigest(args.bearer)) denied("endpoint receipt account/assignment/authority/principal/selection/bearer mismatch");
  const servingAuthority = parseEndpointServingAuthorityRef(value.servingAuthority), registrationRevision = integer(value.registrationRevision, 1, "registration revision"), processEpoch = integer(value.processEpoch, 0, "serving epoch");
  if (!Array.isArray(value.clusterDigests) || value.clusterDigests.length < 1 || value.clusterDigests.length > 64 || value.clusterDigests.some(d => typeof d !== "string" || !/^sha256:[a-f0-9]{64}$/.test(d)) || new Set(value.clusterDigests).size !== value.clusterDigests.length) denied("invalid endpoint receipt contract closures");
  const common = { iss: trust.issuer, aud: trust.account.space, iat, exp, jti: args.requestId, v: 3 as const, account, assignmentLifecycleUid: trust.assignmentLifecycleUid, authority, principal, selection: returnedSelection, servingAuthority, registrationRevision, processEpoch, clusterDigests: [...value.clusterDigests] as string[], bearerDigest: value.bearerDigest as string };
  if (args.control) return freeze({ ...common, kind: "cotal.endpoint-control" as const });
  const privateClusterDigests = value.privateClusterDigests;
  if (!Array.isArray(privateClusterDigests) || privateClusterDigests.length > 64 || privateClusterDigests.some(digest => typeof digest !== "string" || !common.clusterDigests.includes(digest)) || new Set(privateClusterDigests).size !== privateClusterDigests.length) denied("invalid endpoint receipt private contract projection");
  const commands = returnedSelection.commands.filter(command => command !== "describe");
  if ((commands.length === 0) !== (privateClusterDigests.length === 0)) denied("endpoint receipt private projection and selected commands disagree");
  return freeze({ ...common, kind: "cotal.endpoint-caller" as const, privateClusterDigests: [...privateClusterDigests] });
}

/** Compare the actual native private describe to the verified issuance receipt before invoke. */
export function assertEndpointCallerResolvedService(service: ResolvedService, receipt: EndpointCallerAuthorityReceipt): void {
  const descriptor = service.descriptor;
  if (receipt.v !== 3 || receipt.kind !== "cotal.endpoint-caller" || receipt.exp <= Math.floor(Date.now() / 1000) || !descriptor || descriptor.protocol.v !== 3 || service.endpoint !== receipt.selection.endpoint || service.pinnedInstanceId !== receipt.selection.instanceId || service.responder.instanceId !== receipt.selection.instanceId || service.responder.epoch !== receipt.processEpoch || descriptor.registrationRevision !== receipt.registrationRevision || canonicalJson(descriptor.servingAuthority) !== canonicalJson(receipt.servingAuthority) || descriptor.serveRoutes?.kind !== "instance" || descriptor.resources?.kind !== "ephemeral-only" || descriptor.registeredClusterSetDigest !== endpointRegisteredClusterSetDigest(receipt.clusterDigests)) denied("native endpoint descriptor and verified caller receipt currency disagree");
  if (!Array.isArray(receipt.privateClusterDigests) || receipt.privateClusterDigests.length > 64 || new Set(receipt.privateClusterDigests).size !== receipt.privateClusterDigests.length || receipt.privateClusterDigests.some(digest => !receipt.clusterDigests.includes(digest))) denied("invalid endpoint receipt private contract projection");
  if (canonicalJson(descriptor.clusters.map(cluster => cluster.digest).sort()) !== canonicalJson([...receipt.privateClusterDigests].sort())) denied("native endpoint private descriptor and verified caller projection disagree");
  if (service.caller.owner !== receipt.principal.owner || service.caller.actor !== receipt.principal.actor || service.caller.uid !== receipt.principal.uid || !("generation" in service.caller)) denied("native endpoint caller is not the verified issued principal");
  const allowed = receipt.selection.commands.filter(command => command !== "describe").sort();
  if (canonicalJson([...service.commands.keys()].sort()) !== canonicalJson(allowed) || [...service.commands.values()].some(command => command.class !== "ephemeral" || command.targeted)) denied("native endpoint descriptor widened the verified command selection");
}
