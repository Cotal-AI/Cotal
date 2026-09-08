/** Broker-free authorization tests for the exact `session-manage` family. */
import {
  EpEnvelopeError,
  authorizeSessionManage,
  parseSessionManageGrant,
  type ResourceKey,
  type SessionManageGrant,
  type SessionManageOwnerDelegation,
} from "../src/index.js";

let ok = 0, fail = 0;
const c = (name: string, value: boolean, extra?: unknown) => { if (value) ok++; else { fail++; console.log("  ✗ FAIL:", name, extra ?? ""); } };
const throws = (name: string, fn: () => unknown, code: string) => {
  try { fn(); c(name, false, "no throw"); }
  catch (e) { c(name, e instanceof EpEnvelopeError && e.code === code, (e as Error).message); }
};
const OWNER = "u_alice.operator";
const OTHER = "u_bob.operator";
const MANAGER = "u_alice.manager";
const resource: ResourceKey = {
  hostIdentity: "host-1", provider: "com.cotal.claude", nativeOwnerNamespace: "uid:1000",
  stableSessionId: "session-1", resourceGeneration: "created-1",
};
const selector = {
  resourceOwnerPrincipal: OWNER,
  hostIdentity: "host-1",
  provider: "com.cotal.claude",
  nativeOwnerNamespace: "uid:1000",
  stableSessionId: "session-1",
  resourceGeneration: "created-1",
};
const grant: SessionManageGrant = {
  v: 1, family: "session-manage", ownerPrincipal: OWNER, targetManagerPrincipal: MANAGER,
  selector, actions: ["discover", "adopt", "control", "release", "transfer"], expiresAt: 10_000,
};
const req = { authenticatedActor: MANAGER, managerPrincipal: MANAGER, resourceOwnerPrincipal: OWNER, resourceKey: resource, action: "adopt" as const, now: 1_000 };

console.log("A. exact independent authority family");
c("session-manage grant authorizes its exact owner/manager/resource/action tuple", authorizeSessionManage(grant, req, OWNER).family === "session-manage");
for (const legacy of ["spawn", "admin", "supervise"]) {
  throws(`session-manage is NOT implied by ${legacy}`, () => authorizeSessionManage({ ...grant, family: legacy }, req, OWNER), "internal");
  throws(`${legacy} is not a session-manage action`, () => parseSessionManageGrant({ ...grant, actions: [legacy] }), "internal");
}
throws("actions are independently attenuated", () => authorizeSessionManage({ ...grant, actions: ["discover"] }, req, OWNER), "permission-denied");
throws("target manager is fixed", () => authorizeSessionManage(grant, { ...req, managerPrincipal: "u_alice.othermanager" }, OWNER), "permission-denied");
throws("host selector is fixed", () => authorizeSessionManage(grant, { ...req, resourceKey: { ...resource, hostIdentity: "host-2" } }, OWNER), "permission-denied");
throws("provider selector is fixed", () => authorizeSessionManage(grant, { ...req, resourceKey: { ...resource, provider: "com.cotal.opencode" } }, OWNER), "permission-denied");
throws("resource selector includes generation", () => authorizeSessionManage(grant, { ...req, resourceKey: { ...resource, resourceGeneration: "created-2" } }, OWNER), "permission-denied");
throws("expiry is enforced", () => authorizeSessionManage(grant, { ...req, now: 10_000 }, OWNER), "expired");

console.log("B. authenticated owner and no ledger self-grant");
throws("manager cannot self-grant by writing a ledger row", () => authorizeSessionManage(grant, req, MANAGER), "permission-denied");
throws("caller must be the authenticated target manager principal", () => authorizeSessionManage(grant, { ...req, authenticatedActor: OWNER }, OWNER), "permission-denied");
throws("wire grant is closed", () => parseSessionManageGrant({ ...grant, admin: true }), "internal");
throws("selector is closed", () => parseSessionManageGrant({ ...grant, selector: { ...selector, displayName: "friendly" } }), "internal");

console.log("C. cross-owner wildcard needs explicit owner delegation");
const wildcardGrant: SessionManageGrant = {
  ...grant, selector: { ...selector, resourceOwnerPrincipal: "*", hostIdentity: "*", stableSessionId: "*", resourceGeneration: "*" }, actions: ["discover", "adopt"],
};
const crossReq = { ...req, resourceOwnerPrincipal: OTHER, action: "adopt" as const };
throws("cross-owner wildcard is refused without explicit delegation", () => authorizeSessionManage(wildcardGrant, crossReq, OWNER), "permission-denied");
const delegation: SessionManageOwnerDelegation = {
  v: 1, family: "session-manage-owner-delegation", resourceOwnerPrincipal: OTHER,
  delegateOwnerPrincipal: OWNER, targetManagerPrincipal: MANAGER,
  selector: { hostIdentity: "host-1", provider: "com.cotal.claude", nativeOwnerNamespace: "uid:1000", stableSessionId: "session-1", resourceGeneration: "created-1" },
  actions: ["adopt"], expiresAt: 5_000,
};
c("explicit resource-owner delegation authorizes the fixed cross-owner tuple", authorizeSessionManage(wildcardGrant, crossReq, OWNER, delegation, OTHER).family === "session-manage");
throws("delegation issuer must be the resource owner", () => authorizeSessionManage(wildcardGrant, crossReq, OWNER, delegation, OWNER), "permission-denied");
throws("delegation cannot target another manager", () => authorizeSessionManage(wildcardGrant, crossReq, OWNER, { ...delegation, targetManagerPrincipal: "u_bob.manager" }, OTHER), "permission-denied");
throws("delegation cannot widen its action set", () => authorizeSessionManage(wildcardGrant, { ...crossReq, action: "discover" }, OWNER, delegation, OTHER), "permission-denied");

console.log(`\n${ok} passed, ${fail} failed`);
if (fail) process.exit(1);
