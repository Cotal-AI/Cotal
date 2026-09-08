/** Closed wire grammar and authorization decision for the §4 `session-manage` authority family. */
import { isWellFormedUnicode } from "./canonical.js";
import { EpEnvelopeError } from "./endpoint-envelope.js";
import { endpointToken } from "./endpoint-subjects.js";
import { parsePrincipalKey } from "./subjects.js";
import {
  SESSION_MANAGE_ACTIONS,
  parseResourceKey,
  type ResourceKey,
  type SessionManageAction,
} from "./session-lifecycle-records.js";

const isRec = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const uint = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const ACTIONS: ReadonlySet<string> = new Set(SESSION_MANAGE_ACTIONS);
const GRANT_FIELDS = new Set(["v", "family", "ownerPrincipal", "targetManagerPrincipal", "selector", "actions", "expiresAt"]);
const SELECTOR_FIELDS = new Set(["resourceOwnerPrincipal", "hostIdentity", "provider", "nativeOwnerNamespace", "stableSessionId", "resourceGeneration"]);
const DELEGATION_FIELDS = new Set(["v", "family", "resourceOwnerPrincipal", "delegateOwnerPrincipal", "targetManagerPrincipal", "selector", "actions", "expiresAt"]);

export interface SessionManageSelector {
  readonly resourceOwnerPrincipal: string | "*";
  readonly hostIdentity: string | "*";
  readonly provider: string | "*";
  readonly nativeOwnerNamespace: string | "*";
  readonly stableSessionId: string | "*";
  readonly resourceGeneration: string | "*";
}

/** Complete attenuation tuple. Possession of a binding/ledger row is deliberately not a grant. */
export interface SessionManageGrant {
  readonly v: 1;
  readonly family: "session-manage";
  readonly ownerPrincipal: string;
  readonly targetManagerPrincipal: string;
  readonly selector: SessionManageSelector;
  readonly actions: readonly SessionManageAction[];
  readonly expiresAt: number;
}

/** Separately authenticated resource-owner delegation for cross-owner selection. */
export interface SessionManageOwnerDelegation {
  readonly v: 1;
  readonly family: "session-manage-owner-delegation";
  readonly resourceOwnerPrincipal: string;
  readonly delegateOwnerPrincipal: string;
  readonly targetManagerPrincipal: string;
  readonly selector: Omit<SessionManageSelector, "resourceOwnerPrincipal">;
  readonly actions: readonly SessionManageAction[];
  readonly expiresAt: number;
}

export interface SessionManageRequest {
  readonly authenticatedActor: string;
  readonly managerPrincipal: string;
  readonly resourceOwnerPrincipal: string;
  readonly resourceKey: ResourceKey;
  readonly action: SessionManageAction;
  readonly now: number;
}

function refuse(code: "internal" | "permission-denied" | "expired", message: string): never {
  throw new EpEnvelopeError(code, message);
}
function closed(o: Record<string, unknown>, fields: ReadonlySet<string>, label: string): void {
  for (const k of Object.keys(o)) if (!fields.has(k)) refuse("internal", `${label} carries unknown field ${JSON.stringify(k)}; session-manage wire schemas are closed`);
}
function principal(v: unknown, label: string): string {
  if (typeof v !== "string" || parsePrincipalKey(v) === null) return refuse("internal", `${label} is not a canonical owner.actor principal`);
  return v;
}
function selectorString(v: unknown, label: string): string | "*" {
  if (v === "*") return v;
  if (typeof v !== "string" || v.length === 0 || !isWellFormedUnicode(v)) return refuse("internal", `${label} is not a non-empty string selector`);
  return v;
}
function actions(v: unknown, label: string): readonly SessionManageAction[] {
  if (!Array.isArray(v) || v.length === 0 || v.some((x) => typeof x !== "string" || !ACTIONS.has(x)) || new Set(v).size !== v.length)
    return refuse("internal", `${label} is not a non-empty unique session-manage action set`);
  return Object.freeze([...(v as SessionManageAction[])]);
}

export function parseSessionManageSelector(value: unknown, label = "session-manage selector"): SessionManageSelector {
  if (!isRec(value)) return refuse("internal", `${label} is not an object`);
  closed(value, SELECTOR_FIELDS, label);
  const resourceOwnerPrincipal = value.resourceOwnerPrincipal === "*" ? "*" : principal(value.resourceOwnerPrincipal, `${label}.resourceOwnerPrincipal`);
  const provider = selectorString(value.provider, `${label}.provider`);
  if (provider !== "*") try { endpointToken(provider); } catch { return refuse("internal", `${label}.provider is not a DNS-shaped provider name or *`); }
  return {
    resourceOwnerPrincipal,
    hostIdentity: selectorString(value.hostIdentity, `${label}.hostIdentity`),
    provider,
    nativeOwnerNamespace: selectorString(value.nativeOwnerNamespace, `${label}.nativeOwnerNamespace`),
    stableSessionId: selectorString(value.stableSessionId, `${label}.stableSessionId`),
    resourceGeneration: selectorString(value.resourceGeneration, `${label}.resourceGeneration`),
  };
}

export function parseSessionManageGrant(value: unknown): SessionManageGrant {
  if (!isRec(value)) return refuse("internal", "session-manage grant is not an object");
  closed(value, GRANT_FIELDS, "session-manage grant");
  if (value.v !== 1 || value.family !== "session-manage" || !uint(value.expiresAt)) return refuse("internal", "session-manage grant version/family/expiry does not validate");
  return {
    v: 1, family: "session-manage",
    ownerPrincipal: principal(value.ownerPrincipal, "session-manage grant.ownerPrincipal"),
    targetManagerPrincipal: principal(value.targetManagerPrincipal, "session-manage grant.targetManagerPrincipal"),
    selector: parseSessionManageSelector(value.selector),
    actions: actions(value.actions, "session-manage grant.actions"),
    expiresAt: value.expiresAt,
  };
}

export function parseSessionManageOwnerDelegation(value: unknown): SessionManageOwnerDelegation {
  if (!isRec(value)) return refuse("internal", "session-manage owner delegation is not an object");
  closed(value, DELEGATION_FIELDS, "session-manage owner delegation");
  if (value.v !== 1 || value.family !== "session-manage-owner-delegation" || !uint(value.expiresAt) || !isRec(value.selector))
    return refuse("internal", "session-manage owner delegation version/family/expiry/selector does not validate");
  const selector = parseSessionManageSelector({ ...value.selector, resourceOwnerPrincipal: principal(value.resourceOwnerPrincipal, "session-manage owner delegation.resourceOwnerPrincipal") });
  const { resourceOwnerPrincipal: _owner, ...resourceSelector } = selector;
  return {
    v: 1, family: "session-manage-owner-delegation",
    resourceOwnerPrincipal: principal(value.resourceOwnerPrincipal, "session-manage owner delegation.resourceOwnerPrincipal"),
    delegateOwnerPrincipal: principal(value.delegateOwnerPrincipal, "session-manage owner delegation.delegateOwnerPrincipal"),
    targetManagerPrincipal: principal(value.targetManagerPrincipal, "session-manage owner delegation.targetManagerPrincipal"),
    selector: resourceSelector,
    actions: actions(value.actions, "session-manage owner delegation.actions"),
    expiresAt: value.expiresAt,
  };
}

function componentMatches(selector: string, actual: string): boolean { return selector === "*" || selector === actual; }
function selectorMatches(selector: SessionManageSelector | Omit<SessionManageSelector, "resourceOwnerPrincipal">, owner: string, key: ResourceKey): boolean {
  return (!("resourceOwnerPrincipal" in selector) || componentMatches(selector.resourceOwnerPrincipal, owner))
    && componentMatches(selector.hostIdentity, key.hostIdentity)
    && componentMatches(selector.provider, key.provider)
    && componentMatches(selector.nativeOwnerNamespace, key.nativeOwnerNamespace)
    && componentMatches(selector.stableSessionId, key.stableSessionId)
    && componentMatches(selector.resourceGeneration, key.resourceGeneration);
}

/**
 * Authorize only a verified session-manage grant. `authenticatedGrantIssuer` comes from the trusted
 * auth store read, not from a lifecycle ledger row. Legacy spawn/admin/supervise inputs have no path
 * into this function and therefore cannot imply management authority.
 */
export function authorizeSessionManage(
  grantValue: unknown,
  request: SessionManageRequest,
  authenticatedGrantIssuer: string,
  delegationValue?: unknown,
  authenticatedDelegationIssuer?: string,
): SessionManageGrant {
  const grant = parseSessionManageGrant(grantValue);
  parseResourceKey(request.resourceKey, "session-manage request.resourceKey");
  principal(request.authenticatedActor, "session-manage request.authenticatedActor");
  principal(request.managerPrincipal, "session-manage request.managerPrincipal");
  principal(request.resourceOwnerPrincipal, "session-manage request.resourceOwnerPrincipal");
  if (!uint(request.now)) refuse("permission-denied", "session-manage request time is invalid");
  if (authenticatedGrantIssuer !== grant.ownerPrincipal)
    refuse("permission-denied", "session-manage grant issuer is not its authenticated owner principal; a manager cannot self-grant by writing a ledger row");
  if (request.managerPrincipal !== grant.targetManagerPrincipal)
    refuse("permission-denied", "session-manage grant targets a different manager principal");
  if (request.authenticatedActor !== grant.targetManagerPrincipal)
    refuse("permission-denied", "session-manage caller is not the authenticated target manager principal");
  if (request.now >= grant.expiresAt) refuse("expired", "session-manage grant has expired");
  if (!grant.actions.includes(request.action)) refuse("permission-denied", `session-manage grant does not include ${request.action}`);
  if (!selectorMatches(grant.selector, request.resourceOwnerPrincipal, request.resourceKey))
    refuse("permission-denied", "session-manage resource is outside the grant selector");

  if (request.resourceOwnerPrincipal !== grant.ownerPrincipal) {
    if (delegationValue === undefined || authenticatedDelegationIssuer === undefined)
      refuse("permission-denied", "cross-owner session-manage authority requires explicit owner delegation");
    const delegation = parseSessionManageOwnerDelegation(delegationValue);
    if (authenticatedDelegationIssuer !== request.resourceOwnerPrincipal
      || delegation.resourceOwnerPrincipal !== request.resourceOwnerPrincipal
      || delegation.delegateOwnerPrincipal !== grant.ownerPrincipal
      || delegation.targetManagerPrincipal !== request.managerPrincipal
      || request.now >= delegation.expiresAt
      || !delegation.actions.includes(request.action)
      || !selectorMatches(delegation.selector, request.resourceOwnerPrincipal, request.resourceKey))
      refuse("permission-denied", "cross-owner session-manage delegation does not authorize this owner/manager/resource/action/expiry tuple");
  }
  return grant;
}
