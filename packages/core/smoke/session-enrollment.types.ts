import type { NativeOnlySessionEnrollment, ResourceKey } from "../src/index.js";

declare const resourceKey: ResourceKey;
const common = {
  resourceKey,
  ownerPrincipal: "u_alice.owner",
  provenance: { authorizedBy: "u_alice.owner", nativeEvidence: {}, authenticatedAt: 1 },
  incarnationProof: { nativeHostIncarnation: "h", sessionIncarnation: "s", evidence: {} },
  rights: ["discover"] as const,
  expiry: 2,
};

const nativeOnly: NativeOnlySessionEnrollment = { ...common, kind: "native-only" };
void nativeOnly;

// @ts-expect-error native-only enrollment cannot represent renewal key material.
const withPublicId: NativeOnlySessionEnrollment = { ...common, kind: "native-only", enrolledPublicId: "U" };
// @ts-expect-error native-only enrollment cannot represent mesh lifecycle identity.
const withLifecycle: NativeOnlySessionEnrollment = { ...common, kind: "native-only", meshLifecycle: { id: "u_alice.session", lifecycleUid: "uid" } };
// @ts-expect-error native-only enrollment cannot represent a credential authority ceiling.
const withCeiling: NativeOnlySessionEnrollment = { ...common, kind: "native-only", ceiling: { owner: "u_alice", actor: "session", lifecycleUid: "uid", scope: [], allowSubscribe: [], allowPublish: [] } };
void withPublicId;
void withLifecycle;
void withCeiling;
