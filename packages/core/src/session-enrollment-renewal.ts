/**
 * Independent session-credential remint against an owner-authorized enrollment.
 *
 * The ACL registry is a read-dimension store. A remint that intersects only
 * `aclForAlias.allowSubscribe` reissues allowPublish and scope from the enrollment
 * ceiling even after those grants were revoked. This module intersects a FRESH
 * grant with the authenticated enrollment ceiling across every issued dimension.
 *
 * Every durable enrollment read and write is parsed by {@link parseSessionEnrollment}.
 */
import type { KV } from "@nats-io/kv";
import type { RetainedAgentAuthority } from "./auth-provider.js";
import { canonicalJson } from "./canonical.js";
import { EpEnvelopeError } from "./endpoint-envelope.js";
import { createRecordEntry, updateRecordEntry } from "./endpoint-records.js";
import { mintRenewableSessionAgentJwt, type SpaceAuth } from "./provision.js";
import {
  parseSessionEnrollment,
  sessionEnrollmentKey,
  type AuthorityCeiling,
  type ResourceKey,
  type SessionEnrollment,
} from "./session-lifecycle-records.js";
import { patternInAllow } from "./subjects.js";

const enc = (v: unknown) => new TextEncoder().encode(canonicalJson(v));

function refuse(code: "bad-request" | "permission-denied" | "failed-precondition", message: string): never {
  throw new EpEnvelopeError(code, message);
}

function intersectChannels(ceiling: readonly string[], live: readonly string[]): string[] {
  return live.filter((entry) => patternInAllow([...ceiling], entry));
}

function intersectScope(ceiling: readonly string[], live: readonly string[]): string[] {
  const allowed = new Set(ceiling);
  return live.filter((entry) => allowed.has(entry));
}

/** Persist one enrollment row. The bytes are parsed before the CAS write. */
export async function putSessionEnrollment(
  kv: KV,
  enrollment: SessionEnrollment,
  expectedRevision?: number,
): Promise<number> {
  const key = sessionEnrollmentKey(enrollment.resourceKey);
  parseSessionEnrollment(enc(enrollment), key);
  return expectedRevision === undefined
    ? createRecordEntry(kv, key, enrollment)
    : updateRecordEntry(kv, key, enrollment, expectedRevision);
}

/** Load one enrollment row. Absence and non-PUT markers fail closed. */
export async function getSessionEnrollment(kv: KV, resourceKey: ResourceKey): Promise<SessionEnrollment> {
  const key = sessionEnrollmentKey(resourceKey);
  const entry = await kv.get(key);
  if (!entry) refuse("failed-precondition", `session enrollment ${key} is absent`);
  if (entry.operation !== "PUT")
    refuse("failed-precondition", `session enrollment ${key} carries a ${entry.operation} marker; enrollment rows are never garbage-collected automatically`);
  return parseSessionEnrollment(entry.value, key, resourceKey);
}

export type SessionRenewalGrant = Pick<
  RetainedAgentAuthority,
  "owner" | "actor" | "lifecycleUid" | "scope" | "allowSubscribe" | "allowPublish"
>;

/**
 * Bound a fresh grant by the authenticated enrollment ceiling.
 * Identity (owner, actor, lifecycleUid) must match exactly. Channel lists use
 * allow-pattern containment. Scope uses exact token membership. supervise is refused.
 */
export function issuedSessionRenewalAuthority(args: {
  enrollment: SessionEnrollment;
  grant: SessionRenewalGrant;
}): AuthorityCeiling {
  const { enrollment, grant } = args;
  if (enrollment.kind !== "mesh-enrolled")
    refuse("failed-precondition", "native-only enrollment has no mesh identity and cannot renew a session credential");
  const ceiling = enrollment.ceiling;
  if (grant.owner !== ceiling.owner || grant.actor !== ceiling.actor || grant.lifecycleUid !== ceiling.lifecycleUid)
    refuse("permission-denied", "session renewal grant is not bound to the enrolled owner, actor, and lifecycle");
  if (ceiling.scope.includes("supervise") || grant.scope.includes("supervise"))
    refuse("permission-denied", "session renewal authority must never include supervise; renewal is not management authority");
  return Object.freeze({
    owner: ceiling.owner,
    actor: ceiling.actor,
    lifecycleUid: ceiling.lifecycleUid,
    scope: Object.freeze(intersectScope(ceiling.scope, grant.scope)),
    allowSubscribe: Object.freeze(intersectChannels(ceiling.allowSubscribe, grant.allowSubscribe)),
    allowPublish: Object.freeze(intersectChannels(ceiling.allowPublish, grant.allowPublish)),
  });
}

export interface IssueSessionRenewalArgs {
  kv: KV;
  resourceKey: ResourceKey;
  grant: SessionRenewalGrant;
  auth: Pick<SpaceAuth, "space" | "account">;
}

/**
 * Production remint: parse the stored enrollment, intersect a FRESH grant on
 * every issued dimension, and sign a bounded `session-agent` JWT for the
 * enrolled public nkey. The connector keeps the matching seed. supervise is
 * refused. Native-only enrollments cannot renew.
 */
export async function issueSessionRenewal(args: IssueSessionRenewalArgs): Promise<{
  jwt: string;
  exp: number;
  authority: AuthorityCeiling;
}> {
  const enrollment = await getSessionEnrollment(args.kv, args.resourceKey);
  if (enrollment.kind !== "mesh-enrolled")
    refuse("failed-precondition", "native-only enrollment has no mesh identity and cannot renew a session credential");
  if (args.grant.owner !== enrollment.ceiling.owner
    || args.grant.actor !== enrollment.ceiling.actor
    || args.grant.lifecycleUid !== enrollment.ceiling.lifecycleUid)
    refuse("permission-denied", "session renewal grant is not bound to the enrolled owner, actor, and lifecycle");
  const authority = issuedSessionRenewalAuthority({ enrollment, grant: args.grant });
  const minted = await mintRenewableSessionAgentJwt(args.auth, enrollment.enrolledPublicId, {
    principal: { owner: authority.owner, actor: authority.actor },
    lifecycleUid: authority.lifecycleUid,
    capabilities: [...authority.scope],
    allowSubscribe: [...authority.allowSubscribe],
    allowPublish: [...authority.allowPublish],
  });
  return { jwt: minted.jwt, exp: minted.exp, authority };
}
