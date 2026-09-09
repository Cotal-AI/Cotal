/** Broker-free parse-and-reject coverage for the §4 native session enrollment union. */
import {
  EpEnvelopeError,
  SESSION_ENROLLMENT,
  parseRecordKey,
  parseSessionEnrollment,
  sessionEnrollmentKey,
  type MeshEnrolledSessionEnrollment,
  type NativeOnlySessionEnrollment,
  type ResourceKey,
} from "../src/index.js";

let ok = 0, fail = 0;
const c = (name: string, value: boolean, extra?: unknown) => {
  if (value) ok++;
  else { fail++; console.log("  ✗ FAIL:", name, extra ?? ""); }
};
const throws = (name: string, fn: () => unknown) => {
  try { fn(); c(name, false, "no throw"); }
  catch (e) { c(name, e instanceof EpEnvelopeError && e.code === "internal", (e as Error).message); }
};
const enc = (v: unknown) => new TextEncoder().encode(JSON.stringify(v));

const resource: ResourceKey = {
  hostIdentity: "host-key-sha256:abc",
  provider: "com.cotal.opencode",
  nativeOwnerNamespace: "uid:1000",
  stableSessionId: "native-session-17",
  resourceGeneration: "creation:2026-09-08T20:00:00Z",
};
const proof = {
  nativeHostIncarnation: "native-host-start:41",
  sessionIncarnation: "session-process-start:92",
  evidence: { origin: "provider-inspection", immutableCreationId: "c-17" },
};
const common = {
  resourceKey: resource,
  ownerPrincipal: "u_alice.owner",
  provenance: {
    authorizedBy: "u_alice.owner",
    nativeEvidence: { provider: "com.cotal.opencode", nativeOwner: "uid:1000" },
    authenticatedAt: 1_788_900_000_000,
  },
  incarnationProof: proof,
  rights: ["adopt", "control", "release", "transfer"],
  expiry: 1_788_903_600_000,
} as const;
const nativeOnly: NativeOnlySessionEnrollment = { ...common, kind: "native-only" };
const lifecycleUid = "0123456789abcdefghijklmnop";
const meshEnrolled: MeshEnrolledSessionEnrollment = {
  ...common,
  kind: "mesh-enrolled",
  sessionActor: "u_alice.native_session",
  enrolledPublicId: `U${"A".repeat(55)}`,
  meshLifecycle: { id: "u_alice.native_session", lifecycleUid },
  ceiling: {
    owner: "u_alice",
    actor: "native_session",
    lifecycleUid,
    scope: ["session:control"],
    allowSubscribe: ["general", "review.>"],
    allowPublish: ["general"],
  },
};
const key = sessionEnrollmentKey(resource);

console.log("A. one CAS key and both enrollment arms");
c("enrollment key uses the registered atomic kind", key.startsWith("sessionenroll.") && parseRecordKey(key)?.def === SESSION_ENROLLMENT);
const parsedNative = parseSessionEnrollment(enc(nativeOnly), key);
c("native-only parses without mesh identity", parsedNative.kind === "native-only" && !("enrolledPublicId" in parsedNative));
const parsedMesh = parseSessionEnrollment(enc(meshEnrolled), key);
c("mesh-enrolled parses all retained authority dimensions", parsedMesh.kind === "mesh-enrolled"
  && parsedMesh.ceiling.scope.join(",") === "session:control"
  && parsedMesh.ceiling.allowSubscribe.join(",") === "general,review.>"
  && parsedMesh.ceiling.allowPublish.join(",") === "general");
c("parsed rights are detached and frozen", Object.isFrozen(parsedMesh.rights));
c("parsed ceiling lists are detached and frozen", parsedMesh.kind === "mesh-enrolled"
  && Object.isFrozen(parsedMesh.ceiling.scope)
  && Object.isFrozen(parsedMesh.ceiling.allowSubscribe)
  && Object.isFrozen(parsedMesh.ceiling.allowPublish));

console.log("B. common fields and key/value identity");
throws("enrollment is closed", () => parseSessionEnrollment(enc({ ...nativeOnly, managerPrincipal: "u_alice.manager" }), key));
throws("enrollment kind is closed", () => parseSessionEnrollment(enc({ ...nativeOnly, kind: "native" }), key));
throws("owner principal uses canonical owner.actor grammar", () => parseSessionEnrollment(enc({ ...nativeOnly, ownerPrincipal: "u_alice" }), key));
throws("provenance is closed", () => parseSessionEnrollment(enc({ ...nativeOnly, provenance: { ...nativeOnly.provenance, source: "claim" } }), key));
throws("provenance authorizer uses canonical principal grammar", () => parseSessionEnrollment(enc({ ...nativeOnly, provenance: { ...nativeOnly.provenance, authorizedBy: "owner" } }), key));
throws("provenance authorizer is the enrollment owner", () => parseSessionEnrollment(enc({ ...nativeOnly, provenance: { ...nativeOnly.provenance, authorizedBy: "u_alice.manager" } }), key));
throws("provenance requires native evidence", () => parseSessionEnrollment(enc({ ...nativeOnly, provenance: { ...nativeOnly.provenance, nativeEvidence: undefined } }), key));
throws("provenance evidence is strict JSON", () => parseSessionEnrollment(
  new TextEncoder().encode(new TextDecoder().decode(enc(nativeOnly)).replace(
    JSON.stringify(nativeOnly.provenance.nativeEvidence),
    "1e400",
  )),
  key,
));
throws("provenance authentication time is positive", () => parseSessionEnrollment(enc({ ...nativeOnly, provenance: { ...nativeOnly.provenance, authenticatedAt: 0 } }), key));
throws("incarnation proof is validated", () => parseSessionEnrollment(enc({ ...nativeOnly, incarnationProof: { ...proof, nativeHostIncarnation: "" } }), key));
throws("rights must not be empty", () => parseSessionEnrollment(enc({ ...nativeOnly, rights: [] }), key));
throws("rights use the session-manage vocabulary", () => parseSessionEnrollment(enc({ ...nativeOnly, rights: ["spawn"] }), key));
throws("duplicate rights are refused", () => parseSessionEnrollment(enc({ ...nativeOnly, rights: ["control", "control"] }), key));
throws("expiry is a positive integer", () => parseSessionEnrollment(enc({ ...nativeOnly, expiry: -1 }), key));
throws("expiry follows provenance authentication", () => parseSessionEnrollment(enc({ ...nativeOnly, expiry: common.provenance.authenticatedAt }), key));
throws("enrollment key matches the embedded ResourceKey", () => parseSessionEnrollment(enc(nativeOnly), sessionEnrollmentKey({ ...resource, resourceGeneration: "other" })));
throws("consumer-requested ResourceKey matches the embedded ResourceKey", () => parseSessionEnrollment(enc(nativeOnly), key, { ...resource, stableSessionId: "other" }));

console.log("C. discriminated union boundary");
for (const field of ["sessionActor", "enrolledPublicId", "meshLifecycle", "ceiling"] as const) {
  throws(`native-only cannot carry ${field}`, () => parseSessionEnrollment(enc({ ...nativeOnly, [field]: meshEnrolled[field] }), key));
  const without = { ...meshEnrolled } as Record<string, unknown>;
  delete without[field];
  throws(`mesh-enrolled requires ${field}`, () => parseSessionEnrollment(enc(without), key));
}

console.log("D. mesh identity and retained authority ceiling");
throws("session actor uses canonical principal grammar", () => parseSessionEnrollment(enc({ ...meshEnrolled, sessionActor: "native_session" }), key));
throws("session actor belongs to the enrollment owner", () => parseSessionEnrollment(enc({ ...meshEnrolled, sessionActor: "u_mallory.native_session", meshLifecycle: { ...meshEnrolled.meshLifecycle, id: "u_mallory.native_session" }, ceiling: { ...meshEnrolled.ceiling, owner: "u_mallory" } }), key));
throws("session actor is distinct from the authorizing owner actor", () => parseSessionEnrollment(enc({ ...meshEnrolled, sessionActor: common.ownerPrincipal, meshLifecycle: { ...meshEnrolled.meshLifecycle, id: common.ownerPrincipal }, ceiling: { ...meshEnrolled.ceiling, actor: "owner" } }), key));
throws("enrolled public id is a NATS user nkey", () => parseSessionEnrollment(enc({ ...meshEnrolled, enrolledPublicId: "not-a-key" }), key));
throws("mesh lifecycle is closed", () => parseSessionEnrollment(enc({ ...meshEnrolled, meshLifecycle: { ...meshEnrolled.meshLifecycle, epoch: 3 } }), key));
throws("mesh lifecycle id uses canonical principal grammar", () => parseSessionEnrollment(enc({ ...meshEnrolled, meshLifecycle: { ...meshEnrolled.meshLifecycle, id: "native_session" } }), key));
throws("mesh lifecycle id names the session actor", () => parseSessionEnrollment(enc({ ...meshEnrolled, meshLifecycle: { ...meshEnrolled.meshLifecycle, id: "u_alice.other" } }), key));
throws("mesh lifecycle uid is nonempty", () => parseSessionEnrollment(enc({ ...meshEnrolled, meshLifecycle: { ...meshEnrolled.meshLifecycle, lifecycleUid: "" } }), key));
throws("authority ceiling is closed", () => parseSessionEnrollment(enc({ ...meshEnrolled, ceiling: { ...meshEnrolled.ceiling, extra: true } }), key));
c("authority ceiling may omit role (role-less enrollment stays valid)",
  parseSessionEnrollment(enc(meshEnrolled), key).kind === "mesh-enrolled"
  && !("role" in (parseSessionEnrollment(enc(meshEnrolled), key) as MeshEnrolledSessionEnrollment).ceiling));
c("authority ceiling may record which role was authenticated",
  (parseSessionEnrollment(enc({ ...meshEnrolled, ceiling: { ...meshEnrolled.ceiling, role: "reviewer" } }), key) as MeshEnrolledSessionEnrollment).ceiling.role === "reviewer");
throws("authority ceiling role uses the ledger token grammar", () => parseSessionEnrollment(enc({ ...meshEnrolled, ceiling: { ...meshEnrolled.ceiling, role: "bad role" } }), key));
throws("authority ceiling requires every authority dimension", () => parseSessionEnrollment(enc({ ...meshEnrolled, ceiling: { ...meshEnrolled.ceiling, allowPublish: undefined } }), key));
throws("authority ceiling identity uses principal grammar", () => parseSessionEnrollment(enc({ ...meshEnrolled, ceiling: { ...meshEnrolled.ceiling, actor: "native.session" } }), key));
throws("authority ceiling identity names the session actor", () => parseSessionEnrollment(enc({ ...meshEnrolled, ceiling: { ...meshEnrolled.ceiling, actor: "other" } }), key));
throws("authority ceiling lifecycle names the mesh lifecycle", () => parseSessionEnrollment(enc({ ...meshEnrolled, ceiling: { ...meshEnrolled.ceiling, lifecycleUid: "abcdefghijklmnopqrstuvwx12" } }), key));
throws("authority ceiling lifecycle uses lifecycle grammar", () => parseSessionEnrollment(enc({ ...meshEnrolled, meshLifecycle: { ...meshEnrolled.meshLifecycle, lifecycleUid: "bad" }, ceiling: { ...meshEnrolled.ceiling, lifecycleUid: "bad" } }), key));
throws("authority ceiling scope entries use capability-token grammar", () => parseSessionEnrollment(enc({ ...meshEnrolled, ceiling: { ...meshEnrolled.ceiling, scope: ["x;rm"] } }), key));
throws("authority ceiling scope entries are unique", () => parseSessionEnrollment(enc({ ...meshEnrolled, ceiling: { ...meshEnrolled.ceiling, scope: ["admin", "admin"] } }), key));
throws("authority ceiling subscribe entries use channel grammar", () => parseSessionEnrollment(enc({ ...meshEnrolled, ceiling: { ...meshEnrolled.ceiling, allowSubscribe: ["a.>.b"] } }), key));
throws("authority ceiling publish entries use channel grammar", () => parseSessionEnrollment(enc({ ...meshEnrolled, ceiling: { ...meshEnrolled.ceiling, allowPublish: ["bad channel"] } }), key));

console.log(`\n${ok} passed, ${fail} failed`);
if (fail) process.exit(1);
