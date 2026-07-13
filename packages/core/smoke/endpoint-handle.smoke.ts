/**
 * v0.4 §13.6 CAPABILITY HANDLE core smoke (broker-free: pure artifact crypto + verification).
 * Covers the closed target-tuple schema, the normative compiler (grant entry → subjects), the
 * attenuation containment order (child ⊆ parent), and chain verification (walk every link to a
 * registered anchor, issuer = parent's holder, fail closed on widening / unknown / revoked /
 * expiry / live-epoch mismatch, every sturdy link revocation-checked).
 *
 * Run: pnpm smoke:ep-handle   (broker-free; part of smoke:ci)
 */
import { createUser } from "@nats-io/nkeys";
import {
  EpEnvelopeError, signArtifact,
  parseHandle, handleDigest, compileHandleGrants, assertHandleContainedIn, verifyHandleChain,
  serializeHandle, HANDLE_MAX_LIVE_TTL_MS,
  type SignerAnchor, type AnchorResolver, type CapabilityHandle, type HandleRevocationReader,
} from "../src/index.js";

let ok = 0, fail = 0;
const c = (n: string, v: boolean, extra?: unknown) => { if (v) { ok++; } else { fail++; console.log("  ✗ FAIL:", n, extra ?? ""); } };
const rejects = async (n: string, fn: () => Promise<unknown> | unknown, code?: string) => {
  try { await fn(); c(n, false, "no throw"); } catch (e) {
    c(n, code === undefined || (e instanceof EpEnvelopeError && e.code === code), `code ${(e as EpEnvelopeError).code ?? (e as Error).message}`);
  }
};
const throws = (n: string, fn: () => unknown, code?: string) => { try { fn(); c(n, false, "no throw"); } catch (e) { c(n, code === undefined || (e instanceof EpEnvelopeError && e.code === code), `code ${(e as EpEnvelopeError).code ?? (e as Error).message}`); } };

const SPACE = "ephandle";
const NOW = 1_000_000_000;
// The issuer key (root of trust for the parent) and the parent-holder's key (issues the child).
const rootKp = createUser();
const holderKp = createUser();
const anchors = new Map<string, SignerAnchor>();
const anchor = (keyId: string, kp: { getPublicKey(): string }, owner: string, scope: string[], over: Partial<SignerAnchor> = {}): SignerAnchor => {
  const a: SignerAnchor = { keyId, publicKey: kp.getPublicKey(), owner, roles: ["handles"], scope: { handles: scope }, validFrom: 0, validTo: NOW + 1_000_000_000, ...over };
  anchors.set(keyId, a);
  return a;
};
anchor("root-1", rootKp, "u_iss", ["manager"]);          // root issuer: covers the manager endpoint
anchor("holder-1", holderKp, "u_holder.app", ["manager"]); // the parent holder's key issues children
const resolveAnchor: AnchorResolver = (keyId) => anchors.get(keyId);
const noRevocation: HandleRevocationReader = () => false;

const holderP = { id: "u_holder.app", lifecycleUid: "h".repeat(26) };
const childHolder = { id: "u_sub.worker", lifecycleUid: "s".repeat(26) };

// A ROOT handle held by u_holder.app, signed by the root issuer key.
const rootBody = (over: Partial<CapabilityHandle> = {}): Record<string, unknown> => ({
  v: 1, id: "cap-root", space: SPACE, issuer: { keyId: "root-1" }, holder: holderP,
  grants: [{ endpoint: "manager", commands: [{ name: "deploy", targetOwner: "u_svc", authz: "owner" }, { name: "status" }] }],
  iat: NOW, exp: NOW + 60_000, sturdy: true, ...over,
});
const rootHandle = parseHandle(signArtifact(rootBody(), rootKp));

// ── schema: the closed target-tuple shapes ──
throws("a no-target command with authz is schema-invalid",
  () => parseHandle(signArtifact(rootBody({ grants: [{ endpoint: "manager", commands: [{ name: "status", authz: "owner" }] }] }) as Record<string, unknown>, rootKp)), "contract-invalid");
throws("authz:any in a handle grant is schema-invalid (operator-ceiling authority is never conferred)",
  () => parseHandle(signArtifact(rootBody({ grants: [{ endpoint: "manager", commands: [{ name: "deploy", targetOwner: "u_svc", authz: "any" as never }] }] }) as Record<string, unknown>, rootKp)), "contract-invalid");
throws("an actor-pinned FULL triple with authz is schema-invalid (the triple IS the mode)",
  () => parseHandle(signArtifact(rootBody({ grants: [{ endpoint: "manager", commands: [{ name: "deploy", targetOwner: "u_svc", targetActor: "a", targetLifecycleUid: "l".repeat(26), authz: "owner" as never }] }] }) as Record<string, unknown>, rootKp)), "contract-invalid");
throws("targetActor without targetLifecycleUid is schema-invalid (a partial tuple never weakens into a broader grant)",
  () => parseHandle(signArtifact(rootBody({ grants: [{ endpoint: "manager", commands: [{ name: "deploy", targetOwner: "u_svc", targetActor: "a" }] }] }) as Record<string, unknown>, rootKp)), "contract-invalid");
throws("targetLifecycleUid without targetActor is schema-invalid",
  () => parseHandle(signArtifact(rootBody({ grants: [{ endpoint: "manager", commands: [{ name: "deploy", targetOwner: "u_svc", targetLifecycleUid: "l".repeat(26) }] }] }) as Record<string, unknown>, rootKp)), "contract-invalid");
throws("a live handle (sturdy:false) with NO epoch is schema-invalid",
  () => parseHandle(signArtifact(rootBody({ sturdy: false }) as Record<string, unknown>, rootKp)), "contract-invalid");
throws("a sturdy handle carrying epoch is schema-invalid",
  () => parseHandle(signArtifact(rootBody({ sturdy: true, epoch: 3 }) as Record<string, unknown>, rootKp)), "contract-invalid");
throws("an unknown envelope field is schema-invalid (closed envelope)",
  () => parseHandle(signArtifact(rootBody({ rogue: 1 } as never) as Record<string, unknown>, rootKp)), "contract-invalid");

// ── the normative compiler ──
{
  const caps = compileHandleGrants(rootHandle);
  const deploy = caps.find((k) => k.command === "deploy");
  const status = caps.find((k) => k.command === "status");
  c("an owner-domain command compiles to its authz mode pinning targetOwner",
    deploy?.target?.mode === "owner" && (deploy?.target as { tOwner: string }).tOwner === "u_svc");
  c("a no-target command compiles to no target", status !== undefined && status.target === undefined);
}
{
  const triple = parseHandle(signArtifact(rootBody({ grants: [{ endpoint: "manager", commands: [{ name: "attach", targetOwner: "u_t", targetActor: "svc", targetLifecycleUid: "t".repeat(26) }] }] }), rootKp));
  const cap = compileHandleGrants(triple)[0];
  c("an actor-pinned triple compiles to handle-mode carrying the verified triple",
    cap.target?.mode === "handle" && (cap.target as { tUid: string }).tUid === "t".repeat(26));
}
{
  const inst = parseHandle(signArtifact(rootBody({ grants: [{ endpoint: "manager", instanceId: "i".repeat(26), commands: [{ name: "status" }] }] }), rootKp));
  c("an instance entry compiles pinning the instanceId", compileHandleGrants(inst)[0].instanceId === "i".repeat(26));
}

// ── containment: a child ⊆ its parent ──
const childBody = (over: Partial<CapabilityHandle> = {}): Record<string, unknown> => ({
  v: 1, id: "cap-child", space: SPACE, issuer: { keyId: "holder-1" }, holder: childHolder,
  grants: [{ endpoint: "manager", commands: [{ name: "status" }] }], // a strict subset of the root's commands
  iat: NOW, exp: NOW + 30_000, sturdy: true, parentDigest: handleDigest(rootHandle), ...over,
});
const childHandle = parseHandle(signArtifact(childBody(), holderKp));
c("a well-formed child (command subset, shorter window, same space) is contained", (() => { try { assertHandleContainedIn(childHandle, rootHandle); return true; } catch { return false; } })());
throws("a child adding a command the parent lacks widens (permission-denied)",
  () => assertHandleContainedIn(parseHandle(signArtifact(childBody({ grants: [{ endpoint: "manager", commands: [{ name: "destroy" }] }] }), holderKp)), rootHandle), "permission-denied");
throws("a child extending exp beyond the parent widens",
  () => assertHandleContainedIn(parseHandle(signArtifact(childBody({ exp: NOW + 120_000 }), holderKp)), rootHandle), "permission-denied");
throws("a child in a different space widens",
  () => assertHandleContainedIn(parseHandle(signArtifact(childBody({ space: "other" }), holderKp)), rootHandle), "permission-denied");
throws("a child widening a command's target owner (owner-domain: pinned component changed) widens",
  () => assertHandleContainedIn(parseHandle(signArtifact(childBody({ grants: [{ endpoint: "manager", commands: [{ name: "deploy", targetOwner: "u_OTHER", authz: "owner" }] }] }), holderKp)), rootHandle), "permission-denied");
{
  // reads: a child subtree must be subject-prefix contained (token boundary, not string prefix).
  const parentReads = parseHandle(signArtifact(rootBody({ grants: [{ endpoint: "manager", commands: [{ name: "status" }], reads: ["goal.u_a.b.c"] }] }), rootKp));
  const okChild = parseHandle(signArtifact(childBody({ parentDigest: handleDigest(parentReads), grants: [{ endpoint: "manager", commands: [{ name: "status" }], reads: ["goal.u_a.b.c.g1"] }] }), holderKp));
  throws("a child read subtree crossing a token boundary is NOT contained (goal.u_a.b.cx vs goal.u_a.b.c)",
    () => assertHandleContainedIn(parseHandle(signArtifact(childBody({ parentDigest: handleDigest(parentReads), grants: [{ endpoint: "manager", commands: [{ name: "status" }], reads: ["goal.u_a.b.cx"] }] }), holderKp)), parentReads), "permission-denied");
  c("a child read subtree that is a true descendant is contained", (() => { try { assertHandleContainedIn(okChild, parentReads); return true; } catch { return false; } })());
}

// ── chain verification ──
c("a single ROOT handle verifies (issuer key owner = the root issuer principal; sturdy revocation checked)",
  (await verifyHandleChain([rootHandle], { resolveAnchor, now: NOW, space: SPACE, presenter: holderP, readRevocation: noRevocation })).grants.length === 2);
{
  const res = await verifyHandleChain([childHandle, rootHandle], { resolveAnchor, now: NOW, space: SPACE, presenter: childHolder, readRevocation: noRevocation });
  c("a two-link chain verifies: child issued by the parent's holder key, ⊆ the parent, presented inline", res.leaf.id === "cap-child" && res.grants.length === 1);
}
await rejects("a chain whose leaf is presented to the WRONG holder refuses (holder-bound)",
  () => verifyHandleChain([childHandle, rootHandle], { resolveAnchor, now: NOW, space: SPACE, presenter: holderP, readRevocation: noRevocation }), "permission-denied");
await rejects("a chain missing its presented parent refuses (chains are presented inline in full)",
  () => verifyHandleChain([childHandle], { resolveAnchor, now: NOW, space: SPACE, presenter: childHolder, readRevocation: noRevocation }), "permission-denied");
await rejects("an EXPIRED leaf refuses (window fails closed)",
  () => verifyHandleChain([childHandle, rootHandle], { resolveAnchor, now: NOW + 40_000, space: SPACE, presenter: childHolder, readRevocation: noRevocation }), "permission-denied");
await rejects("a REVOKED ancestor refuses (every sturdy link is checked, not only the leaf)",
  () => verifyHandleChain([childHandle, rootHandle], { resolveAnchor, now: NOW, space: SPACE, presenter: childHolder, readRevocation: (kid) => kid === "root-1" }), "permission-denied");
{
  // the child's issuer key must belong to the PARENT's holder; a child signed by the ROOT key
  // (owner u_iss, not the parent holder u_holder.app) is an issuer-authority violation.
  const forged = parseHandle(signArtifact(childBody({ issuer: { keyId: "root-1" } }), rootKp));
  await rejects("a child whose issuer key is NOT the parent's holder refuses (issuer of a child is the parent's holder)",
    () => verifyHandleChain([forged, rootHandle], { resolveAnchor, now: NOW, space: SPACE, presenter: childHolder, readRevocation: noRevocation }), "permission-denied");
}
{
  // a tampered leaf (grants mutated after signing) fails its signature.
  const raw = signArtifact(childBody(), holderKp) as Record<string, unknown>;
  (raw as { holder: { id: string } }).holder.id = "u_evil"; // change a signed field
  await rejects("a tampered handle fails its signature",
    () => verifyHandleChain([raw, rootHandle], { resolveAnchor, now: NOW, space: SPACE, presenter: { id: "u_evil", lifecycleUid: childHolder.lifecycleUid }, readRevocation: noRevocation }), "permission-denied");
}
{
  // parentDigest mismatch: a child claiming a parent that isn't the one presented.
  const otherParent = parseHandle(signArtifact(rootBody({ id: "cap-other" }), rootKp));
  await rejects("a child whose parentDigest does not match the presented parent refuses (the chain is the one presented)",
    () => verifyHandleChain([childHandle, otherParent], { resolveAnchor, now: NOW, space: SPACE, presenter: childHolder, readRevocation: noRevocation }), "permission-denied");
}
{
  // live handle: epoch binding.
  const live = parseHandle(signArtifact(rootBody({ id: "cap-live", sturdy: false, epoch: 7, exp: NOW + 1000 }), rootKp));
  c("a LIVE handle with a matching presenter epoch verifies",
    (await verifyHandleChain([live], { resolveAnchor, now: NOW, space: SPACE, presenter: { ...holderP, epoch: 7 }, readRevocation: noRevocation })).leaf.id === "cap-live");
  await rejects("a LIVE handle presented at a DIFFERENT epoch refuses (live authority dies on restart)",
    () => verifyHandleChain([live], { resolveAnchor, now: NOW, space: SPACE, presenter: { ...holderP, epoch: 8 }, readRevocation: noRevocation }), "permission-denied");
}
{
  const over = parseHandle(signArtifact(rootBody({ id: "cap-longlive", sturdy: false, epoch: 1, exp: NOW + HANDLE_MAX_LIVE_TTL_MS + 1 }), rootKp));
  await rejects("a LIVE handle whose TTL exceeds the 24h ceiling refuses",
    () => verifyHandleChain([over], { resolveAnchor, now: NOW, space: SPACE, presenter: { ...holderP, epoch: 1 }, readRevocation: noRevocation }), "permission-denied");
}

// ── serialization is strict I-JSON ──
c("a handle serializes to canonical bytes", serializeHandle(rootHandle).length > 0);

console.log(`\nENDPOINT HANDLE SMOKE ${fail === 0 ? "OK ✅ " : "FAILED ❌ "} (${ok} passed, ${fail} failed)`);
if (fail > 0) process.exit(1);
