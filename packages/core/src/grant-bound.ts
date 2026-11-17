/**
 * The delegation bound: a spawner may hand a helper any part of what it holds, and never more.
 *
 * Two authorities answer "what does the spawner hold". On a user-auth mesh it is the ledger row,
 * which states scope as capability tokens and channels as patterns; {@link capabilityWithin} is the
 * token rule the ledger walk applies. On a static mesh it is the spawner's issued evidence (SPEC
 * 13.15), which states only the subjects its credential may publish and subscribe;
 * {@link grantOverreach} answers against that.
 *
 * Evidence names subjects under the spawner's own principal, and a helper's rows name the helper,
 * so the two are never compared as literal rows. Each field of the grant is projected through the
 * agent mint at the SPAWNER's coordinate instead: "may the helper post on X" becomes "may the
 * spawner post on X", which its evidence answers. The projection of an empty grant at the same
 * coordinate is subtracted first, so only the rows the field adds are tested, and the baseline
 * every agent receives (inbox, presence, DM, the endpoint baseline) never decides anything.
 */
import { capabilityRole, permissionsFor } from "./provision.js";
import { issuedPermitsPattern, mintAcceptedToken, type IssuedEvidence, type IssuedSubjectAllow, type IssuedSubjectPermissions } from "./issued-authority.js";
import { presenceKeySubject, resolveReadAcl } from "./subjects.js";
import { isIssuedCaller, type EpCaller, type IssuedCaller } from "./endpoint-subjects.js";
import type { EpCapability } from "./endpoint-grants.js";
import { personaEndpointPartName } from "./persona-endpoints.js";

/** What a spawner hands a helper. `subscribe` is the helper's read set after `join`; it is folded
 *  into the read ACL here the way provisioning folds it. */
export interface DelegatedGrant {
  readonly subscribe?: readonly string[];
  readonly allowSubscribe?: readonly string[];
  readonly allowPublish?: readonly string[];
  readonly role?: string;
  readonly capabilities?: readonly string[];
  /** Endpoint commands, as {@link lowerPersonaEndpoints} lowers a persona's `endpoints`. */
  readonly endpoints?: readonly EpCapability[];
}

export type DelegatedField = "allowSubscribe" | "allowPublish" | "role" | "capabilities" | "endpoints";

/** One part of a grant the spawner does not hold, named for the refusal. */
export interface GrantOverreach {
  readonly field: DelegatedField;
  readonly value: string;
}

/** The capability tokens a spawner may hand on, besides `role:<r>`. */
export const DELEGABLE_CAPABILITIES = Object.freeze(["spawn", "run", "admin"] as const);

export function isDelegableCapability(token: string): boolean {
  return (DELEGABLE_CAPABILITIES as readonly string[]).includes(token) || capabilityRole(token) !== undefined;
}

/** The ledger's token rule: a child token is within the parent's scope when the parent holds it, or
 *  when it is `spawn` and the parent holds `run`, which carries the whole spawn set. */
export function capabilityWithin(parentScope: readonly string[], token: string): boolean {
  return parentScope.includes(token) || (token === "spawn" && parentScope.includes("run"));
}

type MintExtra = Parameters<typeof permissionsFor>[3];

/** Each part of a grant, with the mint options that project it alone. `project` is absent for a
 *  token no mint maps, which nothing can be shown to hold. */
function partsOf(grant: DelegatedGrant): { part: GrantOverreach; project?: MintExtra }[] {
  const out: { part: GrantOverreach; project?: MintExtra }[] = [];
  for (const ch of resolveReadAcl([...(grant.subscribe ?? [])], grant.allowSubscribe ? [...grant.allowSubscribe] : undefined))
    out.push({ part: { field: "allowSubscribe", value: ch }, project: { allowSubscribe: [ch] } });
  for (const ch of grant.allowPublish ?? []) out.push({ part: { field: "allowPublish", value: ch }, project: { allowPublish: [ch] } });
  if (grant.role !== undefined) out.push({ part: { field: "role", value: grant.role }, project: { role: grant.role } });
  for (const token of grant.capabilities ?? []) {
    const project = isDelegableCapability(token) ? { capabilities: [token] } : undefined;
    out.push({ part: { field: "capabilities", value: token }, ...(project ? { project } : {}) });
  }
  for (const cap of grant.endpoints ?? [])
    out.push({ part: { field: "endpoints", value: personaEndpointPartName(cap) }, project: { endpointCapabilities: [{ ...cap }] } });
  return out;
}

/** Every part of `grant`, named as {@link grantOverreach} names a refusal: what a spawner that holds
 *  no evidence is refused when it asks for any of it. Throws on a malformed grant. */
export function grantParts(grant: DelegatedGrant): GrantOverreach[] {
  return partsOf(grant).map(({ part }) => part);
}

/**
 * Every part of `grant` that `ceiling` does not cover, for a static spawner at `caller`'s coordinate
 * whose ceiling is `ceiling`: its issued evidence, or a run's admitted ceiling. Empty means the
 * grant is within. Each channel, the role and each capability token is tested on its own, so a
 * refusal names what overreached. A part whose projection adds no row cannot be shown to be held
 * and is refused, so an unknown token or an unmapped field fails closed. A caller with no
 * generation, as a local run's admission records its operator, is projected without one.
 * Throws on a malformed grant (a channel or token the mint refuses).
 */
export function grantOverreach(
  space: string,
  caller: EpCaller,
  ceiling: IssuedSubjectPermissions,
  grant: DelegatedGrant,
): GrantOverreach[] {
  // One coordinate, one connection id and one accepted token for every projection, so the rows
  // the coordinate alone produces are identical across projections and cancel exactly.
  const pr = { owner: caller.owner, actor: caller.actor, connId: caller.actor, lifecycleUid: caller.uid };
  const issued = isIssuedCaller(caller) ? { issued: { generation: caller.generation, acceptedToken: mintAcceptedToken() } } : {};
  const rows = (extra: MintExtra) => {
    const perms = permissionsFor("agent", space, pr, { lifecycleUid: caller.uid, ...issued, ...extra }) as {
      pub: { allow: string[] };
      sub: { allow: string[] };
    };
    return { pub: new Set(perms.pub.allow), sub: new Set(perms.sub.allow) };
  };
  const empty = rows({});
  const held = (extra: MintExtra): boolean => {
    const projected = rows(extra);
    const pub = [...projected.pub].filter((r) => !empty.pub.has(r));
    const sub = [...projected.sub].filter((r) => !empty.sub.has(r));
    if (pub.length + sub.length === 0) return false;
    return pub.every((r) => issuedPermitsPattern(ceiling.publish, r)) && sub.every((r) => issuedPermitsPattern(ceiling.subscribe, r));
  };
  return partsOf(grant).filter(({ project }) => project === undefined || !held(project)).map(({ part }) => part);
}

/**
 * The ceiling a set of named channels yields at `caller`'s coordinate: the rows those channels add
 * to an agent's mint there, in the shape issued evidence states. A local run's admission records it,
 * so {@link grantOverreach} measures the run's helpers as it measures a hosted starter's. No
 * channels in a direction is `none`. Throws on a malformed channel or a coordinate the mint refuses.
 */
export function channelCeiling(space: string, caller: EpCaller, read: readonly string[], publish: readonly string[]): IssuedSubjectPermissions {
  const pr = { owner: caller.owner, actor: caller.actor, connId: caller.actor, lifecycleUid: caller.uid };
  const rows = (extra: MintExtra) => permissionsFor("agent", space, pr, { lifecycleUid: caller.uid, ...extra }) as { pub: { allow: string[] }; sub: { allow: string[] } };
  const empty = rows({});
  const named = rows({ allowSubscribe: [...read], allowPublish: [...publish] });
  const added = (all: string[], base: string[]): IssuedSubjectAllow => {
    const patterns = all.filter((r) => !base.includes(r));
    return patterns.length ? { mode: "patterns", patterns } : { mode: "none" };
  };
  return { publish: { allow: added(named.pub.allow, empty.pub.allow), deny: [] }, subscribe: { allow: added(named.sub.allow, empty.sub.allow), deny: [] } };
}

/** How a static spawner stands toward the bound. */
export type IssuedSpawnerStanding = "instrument" | "admin" | "bounded";

/**
 * Classify a static spawner from its resolved evidence. An operator instrument is issued with no
 * source and holds no presence key of its own, which every agent mint carries; the issuer writes
 * both facts at mint, so neither can be claimed. An instrument and a spawner holding the admin set
 * are exempt, as an admin spawner is on the ledger. Every other spawner is bounded by its evidence.
 */
export function issuedSpawnerStanding(evidence: IssuedEvidence): IssuedSpawnerStanding {
  const { space, owner, actor, uid, generation } = evidence.ref;
  if (evidence.sources.length === 0 && !issuedPermitsPattern(evidence.permissions.publish, presenceKeySubject(space, owner, actor)))
    return "instrument";
  const caller = { owner, actor, uid, generation } as IssuedCaller;
  return grantOverreach(space, caller, evidence.permissions, { capabilities: ["admin"] }).length === 0 ? "admin" : "bounded";
}
