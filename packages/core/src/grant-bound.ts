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
import { permissionsFor } from "./provision.js";
import { issuedPermitsPattern, mintAcceptedToken, type IssuedEvidence, type IssuedSubjectPermissions } from "./issued-authority.js";
import { presenceKeySubject, resolveReadAcl } from "./subjects.js";
import type { EpCapability } from "./endpoint-grants.js";
import type { IssuedCaller } from "./endpoint-subjects.js";

/** Untargeted access to commands on one endpoint, optionally pinned to one instance. A pinned grant
 *  reaches only that instance's rail. */
export interface EndpointGrant {
  readonly endpoint: string;
  readonly commands: readonly string[];
  readonly instanceId?: string;
}

/** What a spawner hands a helper. `subscribe` is the helper's read set after `join`; it is folded
 *  into the read ACL here the way provisioning folds it. */
export interface DelegatedGrant {
  readonly subscribe?: readonly string[];
  readonly allowSubscribe?: readonly string[];
  readonly allowPublish?: readonly string[];
  readonly role?: string;
  readonly capabilities?: readonly string[];
  readonly endpoints?: readonly EndpointGrant[];
}

export type DelegatedField = "allowSubscribe" | "allowPublish" | "role" | "capabilities" | "endpoints";

/** One part of a grant the spawner does not hold, named for the refusal. */
export interface GrantOverreach {
  readonly field: DelegatedField;
  readonly value: string;
}

/** The capability tokens a spawner may hand on, besides `role:<r>`. */
export const DELEGABLE_CAPABILITIES = Object.freeze(["spawn", "run", "admin"] as const);

const ROLE_TOKEN = /^role:([A-Za-z0-9_-]+)$/;

export function isDelegableCapability(token: string): boolean {
  return (DELEGABLE_CAPABILITIES as readonly string[]).includes(token) || ROLE_TOKEN.test(token);
}

/** The ledger's token rule: a child token is within the parent's scope when the parent holds it, or
 *  when it is `spawn` and the parent holds `run`, which carries the whole spawn set. */
export function capabilityWithin(parentScope: readonly string[], token: string): boolean {
  return parentScope.includes(token) || (token === "spawn" && parentScope.includes("run"));
}

/** The endpoint rows an {@link EndpointGrant} list mints: one capability per command, instance-only
 *  when the grant names an instance. */
export function endpointGrantCapabilities(grants: readonly EndpointGrant[]): EpCapability[] {
  return grants.flatMap((g) => g.commands.map((command): EpCapability =>
    g.instanceId === undefined
      ? { endpoint: g.endpoint, command }
      : { endpoint: g.endpoint, command, instanceId: g.instanceId, instanceOnly: true }));
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
    const role = ROLE_TOKEN.exec(token)?.[1];
    const project = role !== undefined ? { role } : isDelegableCapability(token) ? { capabilities: [token] } : undefined;
    out.push({ part: { field: "capabilities", value: token }, ...(project ? { project } : {}) });
  }
  for (const cap of endpointGrantCapabilities(grant.endpoints ?? []))
    out.push({
      part: { field: "endpoints", value: `${cap.endpoint} ${cap.command}${cap.instanceId === undefined ? "" : ` on ${cap.instanceId}`}` },
      project: { endpointCapabilities: [cap] },
    });
  return out;
}

/** Every part of `grant`, named as {@link grantOverreach} names a refusal: what a spawner that holds
 *  no evidence is refused when it asks for any of it. Throws on a malformed grant. */
export function grantParts(grant: DelegatedGrant): GrantOverreach[] {
  return partsOf(grant).map(({ part }) => part);
}

/**
 * Every part of `grant` that `ceiling` does not cover, for a static spawner `caller` whose issued
 * evidence is `ceiling`. Empty means the grant is within. Each channel, the role, each capability
 * token and each endpoint command is tested on its own, so a refusal names what overreached. A part
 * whose projection adds no row cannot be shown to be held and is refused, so an unknown token or an
 * unmapped field fails closed. Throws on a malformed grant (a channel or token the mint refuses).
 */
export function grantOverreach(
  space: string,
  caller: IssuedCaller,
  ceiling: IssuedSubjectPermissions,
  grant: DelegatedGrant,
): GrantOverreach[] {
  // One coordinate, one connection id and one accepted token for every projection, so the rows
  // the coordinate alone produces are identical across projections and cancel exactly.
  const pr = { owner: caller.owner, actor: caller.actor, connId: caller.actor, lifecycleUid: caller.uid };
  const issued = { generation: caller.generation, acceptedToken: mintAcceptedToken() };
  const rows = (extra: MintExtra) => {
    const perms = permissionsFor("agent", space, pr, { lifecycleUid: caller.uid, issued, ...extra }) as {
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
