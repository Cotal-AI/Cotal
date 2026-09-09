/**
 * Independent remint against a stored enrollment and a fresh grant.
 *
 * The red at 1a01ef1bc used aclForAlias as the only non-manager ceiling read, which
 * narrowed subscribe and reissued revoked publish/scope. This suite now drives the
 * production entry points: putSessionEnrollment / getSessionEnrollment (parse on
 * every CAS), issuedSessionRenewalAuthority, and issueSessionRenewal.
 *
 * PRODUCTION CALLER: packages/core/src/session-enrollment-renewal.ts
 * putSessionEnrollment / getSessionEnrollment / issuedSessionRenewalAuthority /
 * issueSessionRenewal. HTTP production caller is implementations/auth/src/session-renewal.ts
 * (handleSessionRenewal), proven by implementations/auth/smoke/session-renewal.smoke.ts.
 */
import {
  EpEnvelopeError,
  createSpaceAuth,
  getSessionEnrollment,
  issueSessionRenewal,
  issuedSessionRenewalAuthority,
  newIdentity,
  putSessionEnrollment,
  type MeshEnrolledSessionEnrollment,
  type NativeOnlySessionEnrollment,
  type ResourceKey,
} from "../src/index.js";
import type { KV } from "@nats-io/kv";

let ok = 0, fail = 0;
const c = (name: string, value: boolean, extra?: unknown) => {
  if (value) { ok++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log("  ✗ FAIL:", name, extra ?? ""); }
};
const rejects = async (name: string, fn: () => Promise<unknown> | unknown, code: string) => {
  try { await fn(); c(name, false, "no throw"); }
  catch (e) { c(name, e instanceof EpEnvelopeError && e.code === code, (e as Error).message); }
};

type Row = { value: Uint8Array; revision: number; operation: "PUT" };
class MemKv {
  rows = new Map<string, Row>();
  seq = 0;
  async get(key: string) { return this.rows.get(key) as never; }
  async put(key: string, value: Uint8Array, opts?: { previousSeq?: number }) {
    const row = this.rows.get(key);
    if ((opts?.previousSeq ?? -1) !== 0 || row) throw Object.assign(new Error("cas"), { code: 10071 });
    const revision = ++this.seq;
    this.rows.set(key, { value, revision, operation: "PUT" });
    return revision;
  }
}

const resource: ResourceKey = {
  hostIdentity: "host-key-sha256:abc",
  provider: "com.cotal.opencode",
  nativeOwnerNamespace: "uid:1000",
  stableSessionId: "native-session-17",
  resourceGeneration: "creation:2026-09-08T20:00:00Z",
};
const lifecycleUid = "0123456789abcdefghijklmnop";
const identity = newIdentity();
const common = {
  resourceKey: resource,
  ownerPrincipal: "u_alice.owner",
  provenance: {
    authorizedBy: "u_alice.owner",
    nativeEvidence: { provider: "com.cotal.opencode", nativeOwner: "uid:1000" },
    authenticatedAt: Date.now() - 60_000,
  },
  incarnationProof: {
    nativeHostIncarnation: "native-host-start:41",
    sessionIncarnation: "session-process-start:92",
    evidence: { origin: "provider-inspection", immutableCreationId: "c-17" },
  },
  rights: ["adopt", "control", "release", "transfer"] as const,
  expiry: Date.now() + 3_600_000,
};
const meshEnrolled: MeshEnrolledSessionEnrollment = {
  ...common,
  kind: "mesh-enrolled",
  sessionActor: "u_alice.native_session",
  enrolledPublicId: identity.id,
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
const nativeOnly: NativeOnlySessionEnrollment = { ...common, kind: "native-only" };

const kv = new MemKv() as unknown as KV;
await putSessionEnrollment(kv, meshEnrolled);
const enrollment = await getSessionEnrollment(kv, resource);
if (enrollment.kind !== "mesh-enrolled") throw new Error("expected mesh-enrolled row");

const grant = {
  owner: "u_alice",
  actor: "native_session",
  lifecycleUid,
  scope: ["session:control"],
  allowSubscribe: ["general"],
  allowPublish: ["general"],
};

const reminted = issuedSessionRenewalAuthority({ enrollment, grant });

console.log("A. stored enrollment remint intersects every issued dimension");
c("getSessionEnrollment parses stored bytes through parseSessionEnrollment", enrollment.kind === "mesh-enrolled"
  && enrollment.ceiling.allowPublish.join(",") === "general,ops");
c("subscribe revocation through the fresh grant does take effect",
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
const narrowerCeiling = issuedSessionRenewalAuthority({
  enrollment: {
    ...meshEnrolled,
    ceiling: { ...meshEnrolled.ceiling, allowSubscribe: ["review.pua"], allowPublish: ["general"] },
  },
  grant: { ...grant, allowSubscribe: ["review.>"], allowPublish: ["general"] },
});
c("a narrower ceiling survives a broader live grant",
  narrowerCeiling.allowSubscribe.join(",") === "review.pua"
  && !narrowerCeiling.allowSubscribe.includes("review.>"),
  narrowerCeiling.allowSubscribe);

console.log("B. identity, native-only, and supervise refusals");
await rejects("native-only enrollment cannot renew a session credential",
  () => issuedSessionRenewalAuthority({ enrollment: nativeOnly, grant }), "failed-precondition");
await rejects("grant bound to a different actor is refused",
  () => issuedSessionRenewalAuthority({ enrollment, grant: { ...grant, actor: "other" } }), "permission-denied");
await rejects("supervise is refused on session renewal",
  () => issuedSessionRenewalAuthority({ enrollment, grant: { ...grant, scope: ["session:control", "supervise"] } }), "permission-denied");

console.log("C. production issuer mints and refuses expired enrollment");
const auth = await createSpaceAuth("demo");
const minted = await issueSessionRenewal({ kv, resourceKey: resource, grant, auth });
c("PRODUCTION CALLER issueSessionRenewal returns a session-agent JWT",
  minted.jwt.split(".").length === 3 && minted.authority.allowPublish.join(",") === "general");
const expiredKv = new MemKv() as unknown as KV;
await putSessionEnrollment(expiredKv, { ...meshEnrolled, expiry: Date.now() - 1 });
await rejects("expired enrollment cannot renew a session credential",
  () => issueSessionRenewal({ kv: expiredKv, resourceKey: resource, grant, auth, now: Date.now() }),
  "failed-precondition");

console.log(`${ok} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
