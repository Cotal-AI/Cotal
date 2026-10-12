import { EpEnvelopeError } from "./endpoint-envelope.js";
import { assertBoundedOwner, assertLifecycleToken, endpointToken } from "./endpoint-subjects.js";

export interface EndpointAccountPin { space: string; accountPublicKey: string; assignmentRevision: number }
export interface EndpointServingAuthorityRef { namespaceRevision: number; policyRevision: number; delegationId: string; delegationRevision: number }
export interface EndpointServingHolder { owner: string; actor: string; lifecycleUid: string; publicKey: string }
export interface EndpointServeCeiling { routes: { kind: "instance" }; resources: { kind: "ephemeral-only" }; expiresAt: number }
export interface EndpointDelegatedBinding { account: EndpointAccountPin; holder: EndpointServingHolder; authority: EndpointServingAuthorityRef; ceiling: EndpointServeCeiling }
export interface EndpointInstanceAuthorityRequest {
  account: EndpointAccountPin;
  endpoint: string;
  instanceId: string;
  holder: EndpointServingHolder;
  clusterDigests: readonly string[];
  expected: EndpointServingAuthorityRef;
  ceiling: EndpointServeCeiling;
}
export type EndpointInstanceAuthorityDecision = { authorized: false } | {
  authorized: true; governor: string; ref: EndpointServingAuthorityRef; ceiling: EndpointServeCeiling;
};
export interface EndpointInstanceAuthority {
  authorizeInstance(args: EndpointInstanceAuthorityRequest): Promise<EndpointInstanceAuthorityDecision> | EndpointInstanceAuthorityDecision;
}
function deny(message: string): never { throw new EpEnvelopeError("failed-precondition", message, undefined, "not-executed"); }
function closed(value: unknown, fields: string[], label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) deny(`${label} must be an object`);
  const o = value as Record<string, unknown>;
  if (Object.keys(o).length !== fields.length || fields.some(key => !Object.hasOwn(o, key)) || Object.keys(o).some(key => !fields.includes(key))) deny(`${label} has an invalid closed shape`);
  return o;
}
function positive(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) deny(`${label} must be a positive safe integer`);
  return value;
}
export function parseEndpointServingAuthorityRef(value: unknown): Readonly<EndpointServingAuthorityRef> {
  const o = closed(value, ["namespaceRevision", "policyRevision", "delegationId", "delegationRevision"], "servingAuthority");
  if (typeof o.delegationId !== "string") deny("delegationId must be a lifecycle token");
  return Object.freeze({ namespaceRevision: positive(o.namespaceRevision, "namespaceRevision"), policyRevision: positive(o.policyRevision, "policyRevision"), delegationId: assertLifecycleToken(o.delegationId, "delegationId"), delegationRevision: positive(o.delegationRevision, "delegationRevision") });
}
export function parseEndpointServeCeiling(value: unknown): Readonly<EndpointServeCeiling> {
  const o = closed(value, ["routes", "resources", "expiresAt"], "ceiling");
  if (closed(o.routes, ["kind"], "routes").kind !== "instance") deny("class/scatter serving is unsupported in the first slice");
  if (closed(o.resources, ["kind"], "resources").kind !== "ephemeral-only") deny("non-ephemeral serving resources are unsupported");
  return Object.freeze({ routes: Object.freeze({ kind: "instance" as const }), resources: Object.freeze({ kind: "ephemeral-only" as const }), expiresAt: positive(o.expiresAt, "expiresAt") });
}
export function sameEndpointServingAuthority(a: EndpointServingAuthorityRef, b: EndpointServingAuthorityRef): boolean {
  return a.namespaceRevision === b.namespaceRevision && a.policyRevision === b.policyRevision && a.delegationId === b.delegationId && a.delegationRevision === b.delegationRevision;
}
export function parseEndpointDelegatedBinding(value: unknown): Readonly<EndpointDelegatedBinding> {
  const o = closed(value, ["account", "holder", "authority", "ceiling"], "delegated binding");
  const account = closed(o.account, ["space", "accountPublicKey", "assignmentRevision"], "account pin");
  const holder = closed(o.holder, ["owner", "actor", "lifecycleUid", "publicKey"], "holder");
  if (typeof account.space !== "string" || typeof account.accountPublicKey !== "string" || !/^A[A-Z2-7]{55}$/.test(account.accountPublicKey)) deny("invalid account pin");
  endpointToken(account.space);
  if (typeof holder.owner !== "string" || typeof holder.actor !== "string" || typeof holder.lifecycleUid !== "string" || typeof holder.publicKey !== "string" || !/^U[A-Z2-7]{55}$/.test(holder.publicKey)) deny("invalid delegated holder");
  assertBoundedOwner(holder.owner, "holder owner"); assertBoundedOwner(holder.actor, "holder actor"); assertLifecycleToken(holder.lifecycleUid);
  return Object.freeze({ account: Object.freeze({ space: account.space, accountPublicKey: account.accountPublicKey, assignmentRevision: positive(account.assignmentRevision, "assignmentRevision") }), holder: Object.freeze({ owner: holder.owner, actor: holder.actor, lifecycleUid: holder.lifecycleUid, publicKey: holder.publicKey }), authority: parseEndpointServingAuthorityRef(o.authority), ceiling: parseEndpointServeCeiling(o.ceiling) });
}
/** Trusted issuer decision over the complete pinned tuple, not a name-wide owner allow-list.
 * Reads do not release material. The issuer must serialize this under its policy-head CAS. */
export async function assertEndpointInstanceAuthority(args: EndpointInstanceAuthorityRequest, authority: EndpointInstanceAuthority): Promise<EndpointInstanceAuthorityDecision & { authorized: true }> {
  endpointToken(args.endpoint);
  assertLifecycleToken(args.instanceId, "instanceId");
  assertBoundedOwner(args.holder.owner, "serving owner");
  assertLifecycleToken(args.holder.lifecycleUid, "holder lifecycleUid");
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(args.holder.actor) || !/^U[A-Z2-7]{55}$/.test(args.holder.publicKey)) deny("invalid serving holder actor/key");
  if (!/^A[A-Z2-7]{55}$/.test(args.account.accountPublicKey) || args.account.space.length === 0) deny("invalid serving account pin");
  positive(args.account.assignmentRevision, "assignmentRevision");
  if (args.clusterDigests.length === 0 || args.clusterDigests.length > 64 || new Set(args.clusterDigests).size !== args.clusterDigests.length || args.clusterDigests.some(d => !/^sha256:[0-9a-f]{64}$/.test(d))) deny("invalid delegated cluster closures");
  const expected = parseEndpointServingAuthorityRef(args.expected), ceiling = parseEndpointServeCeiling(args.ceiling);
  if (ceiling.expiresAt <= Math.floor(Date.now() / 1000)) deny("serving delegation expired");
  if (typeof authority.authorizeInstance !== "function") deny("delegated serving requires instance authority");
  const verdict = await authority.authorizeInstance({ ...args, account: { ...args.account }, holder: { ...args.holder }, expected, ceiling, clusterDigests: Object.freeze([...args.clusterDigests]) });
  if (!verdict.authorized) throw new EpEnvelopeError("permission-denied", "serving instance is not delegated to this holder/contract/account", undefined, "not-executed");
  const ref = parseEndpointServingAuthorityRef(verdict.ref), allowed = parseEndpointServeCeiling(verdict.ceiling);
  assertBoundedOwner(verdict.governor, "namespace governor");
  if (!sameEndpointServingAuthority(expected, ref) || allowed.expiresAt !== ceiling.expiresAt || allowed.expiresAt <= Math.floor(Date.now() / 1000)) deny("delegated instance authority changed or expired");
  return Object.freeze({ authorized: true, governor: verdict.governor, ref, ceiling: allowed });
}
