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
import { issuedPermitsPattern, mintAcceptedToken, type IssuedSubjectPermissions } from "./issued-authority.js";
import { resolveReadAcl } from "./subjects.js";
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

/** The token rule: a child token is within the parent's scope when the parent holds it, or when it
 *  is `spawn` and the parent holds `run`, which carries the whole spawn set. An unknown token is
 *  never within. */
export function capabilityWithin(parentScope: readonly string[], token: string): boolean {
  if (!isDelegableCapability(token)) return false;
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
  const rows = (extra: Parameters<typeof permissionsFor>[3]) => {
    const perms = permissionsFor("agent", space, pr, { lifecycleUid: caller.uid, issued, ...extra }) as {
      pub: { allow: string[] };
      sub: { allow: string[] };
    };
    return { pub: new Set(perms.pub.allow), sub: new Set(perms.sub.allow) };
  };
  const empty = rows({});
  const held = (extra: Parameters<typeof permissionsFor>[3]): boolean => {
    const projected = rows(extra);
    const pub = [...projected.pub].filter((r) => !empty.pub.has(r));
    const sub = [...projected.sub].filter((r) => !empty.sub.has(r));
    if (pub.length + sub.length === 0) return false;
    return pub.every((r) => issuedPermitsPattern(ceiling.publish, r)) && sub.every((r) => issuedPermitsPattern(ceiling.subscribe, r));
  };

  const over: GrantOverreach[] = [];
  for (const ch of resolveReadAcl([...(grant.subscribe ?? [])], grant.allowSubscribe ? [...grant.allowSubscribe] : undefined))
    if (!held({ allowSubscribe: [ch] })) over.push({ field: "allowSubscribe", value: ch });
  for (const ch of grant.allowPublish ?? [])
    if (!held({ allowPublish: [ch] })) over.push({ field: "allowPublish", value: ch });
  if (grant.role !== undefined && !held({ role: grant.role })) over.push({ field: "role", value: grant.role });
  for (const token of grant.capabilities ?? []) {
    const role = ROLE_TOKEN.exec(token)?.[1];
    const within = role !== undefined
      ? held({ role })
      : isDelegableCapability(token) && held({ capabilities: [token] });
    if (!within) over.push({ field: "capabilities", value: token });
  }
  for (const cap of endpointGrantCapabilities(grant.endpoints ?? []))
    if (!held({ endpointCapabilities: [cap] }))
      over.push({ field: "endpoints", value: `${cap.endpoint} ${cap.command}${cap.instanceId === undefined ? "" : ` on ${cap.instanceId}`}` });
  return over;
}
