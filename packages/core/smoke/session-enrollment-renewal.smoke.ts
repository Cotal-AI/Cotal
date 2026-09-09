/**
 * Reproduce the §106 issuer defect at this enroll-issuer base: the only non-manager
 * ceiling read (`aclForAlias`) carries subscribe + lifecycleUid and nothing else.
 * A remint that intersects that read with the enrollment ceiling therefore narrows
 * allowSubscribe and reissues allowPublish and scope from the enrollment unnarrowed.
 *
 * The cells below drive a stored enrollment row through parseSessionEnrollment (bytes
 * from the KV, not a parser literal) and then the remint that today's primitives
 * actually permit. The publish cell is the requirement. It is red until the issuer
 * intersects a fresh grant across every issued dimension.
 *
 * PRODUCTION CALLER: NONE (issuer unwritten). This file is the reproduction.
 */
import {
  parseSessionEnrollment,
  patternInAllow,
  sessionEnrollmentKey,
  type AuthorityCeiling,
  type MeshEnrolledSessionEnrollment,
  type ResourceKey,
} from "../src/index.js";
import type { KV } from "@nats-io/kv";

let ok = 0, fail = 0;
const c = (name: string, value: boolean, extra?: unknown) => {
  if (value) { ok++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log("  ✗ FAIL:", name, extra ?? ""); }
};

type Row = { value: Uint8Array; revision: number; operation: "PUT" };
class MemKv {
  rows = new Map<string, Row>();
  seq = 0;
  async get(key: string) { return this.rows.get(key) as never; }
  async put(key: string, value: Uint8Array) {
    const revision = ++this.seq;
    this.rows.set(key, { value, revision, operation: "PUT" });
    return revision;
  }
}

const enc = (v: unknown) => new TextEncoder().encode(JSON.stringify(v));
const intersect = (ceiling: readonly string[], live: readonly string[]): string[] =>
  live.filter((entry) => patternInAllow([...ceiling], entry));

/**
 * The remint composition available at this base without the manager and without a
 * publish/scope registry: intersect subscribe against aclForAlias, copy the rest
 * from the authenticated enrollment ceiling.
 */
function remintUsingAclAliasCeiling(args: {
  enrollment: MeshEnrolledSessionEnrollment;
  aclForAlias: { allowSubscribe: string[]; issuedAllowSubscribe: string[]; lifecycleUid: string };
  grant: {
    owner: string;
    actor: string;
    lifecycleUid: string;
    scope: string[];
    allowSubscribe: string[];
    allowPublish: string[];
  };
}): AuthorityCeiling {
  const { enrollment, aclForAlias, grant } = args;
  if (aclForAlias.lifecycleUid !== enrollment.ceiling.lifecycleUid
    || grant.lifecycleUid !== enrollment.ceiling.lifecycleUid
    || grant.owner !== enrollment.ceiling.owner
    || grant.actor !== enrollment.ceiling.actor) {
    throw new Error("renewal identity is not bound to the enrolled actor/lifecycle");
  }
  const subscribeLive = intersect(aclForAlias.allowSubscribe, grant.allowSubscribe);
  return {
    owner: enrollment.ceiling.owner,
    actor: enrollment.ceiling.actor,
    lifecycleUid: enrollment.ceiling.lifecycleUid,
    scope: [...enrollment.ceiling.scope],
    allowSubscribe: intersect(enrollment.ceiling.allowSubscribe, subscribeLive),
    allowPublish: [...enrollment.ceiling.allowPublish],
  };
}

const resource: ResourceKey = {
  hostIdentity: "host-key-sha256:abc",
  provider: "com.cotal.opencode",
  nativeOwnerNamespace: "uid:1000",
  stableSessionId: "native-session-17",
  resourceGeneration: "creation:2026-09-08T20:00:00Z",
};
const lifecycleUid = "0123456789abcdefghijklmnop";
const meshEnrolled: MeshEnrolledSessionEnrollment = {
  resourceKey: resource,
  ownerPrincipal: "u_alice.owner",
  provenance: {
    authorizedBy: "u_alice.owner",
    nativeEvidence: { provider: "com.cotal.opencode", nativeOwner: "uid:1000" },
    authenticatedAt: 1_788_900_000_000,
  },
  incarnationProof: {
    nativeHostIncarnation: "native-host-start:41",
    sessionIncarnation: "session-process-start:92",
    evidence: { origin: "provider-inspection", immutableCreationId: "c-17" },
  },
  rights: ["adopt", "control", "release", "transfer"],
  expiry: 1_788_903_600_000,
  kind: "mesh-enrolled",
  sessionActor: "u_alice.native_session",
  enrolledPublicId: `U${"A".repeat(55)}`,
  meshLifecycle: { id: "u_alice.native_session", lifecycleUid },
  ceiling: {
    owner: "u_alice",
    actor: "native_session",
    lifecycleUid,
    scope: ["session:control", "spawn"],
    allowSubscribe: ["general", "review.>"],
    allowPublish: ["general", "ops"],
  },
};

const kv = new MemKv() as unknown as KV;
const key = sessionEnrollmentKey(resource);
await kv.put(key, enc(meshEnrolled));
const stored = await kv.get(key);
if (!stored || stored.operation !== "PUT") throw new Error("enrollment row was not stored");
const enrollment = parseSessionEnrollment(stored.value, key, resource);
if (enrollment.kind !== "mesh-enrolled") throw new Error("expected mesh-enrolled row");

const aclForAlias = {
  allowSubscribe: ["general"],
  issuedAllowSubscribe: ["general", "review.>"],
  lifecycleUid,
};
const grant = {
  owner: "u_alice",
  actor: "native_session",
  lifecycleUid,
  scope: ["session:control"],
  allowSubscribe: ["general"],
  allowPublish: ["general"],
};

const reminted = remintUsingAclAliasCeiling({ enrollment, aclForAlias, grant });

console.log("A. aclForAlias remint at the enroll-issuer base");
c("stored enrollment bytes parse through parseSessionEnrollment", enrollment.kind === "mesh-enrolled"
  && enrollment.ceiling.allowPublish.join(",") === "general,ops");
c("subscribe revocation through aclForAlias does take effect",
  reminted.allowSubscribe.join(",") === "general"
  && !reminted.allowSubscribe.includes("review.>"),
  reminted.allowSubscribe);
c("revoked allowPublish does not survive a renewal",
  reminted.allowPublish.join(",") === "general"
  && !reminted.allowPublish.includes("ops"),
  reminted.allowPublish);
c("revoked scope does not survive a renewal",
  reminted.scope.join(",") === "session:control"
  && !reminted.scope.includes("spawn"),
  reminted.scope);

console.log(`${ok} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
