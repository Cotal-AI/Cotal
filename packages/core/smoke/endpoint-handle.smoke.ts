/**
 * v0.4 §13.6 CAPABILITY HANDLE core smoke (broker-free: pure artifact crypto + verification).
 * Covers the closed target-tuple schema, the normative compiler (grant entry → subjects,
 * reads + explicit routes + journal seam, instance pin never granting the class rail), the
 * attenuation containment order (child ⊆ parent), the STRUCTURED issuer scope (full grant
 * dimensions, containment-checked), and chain verification: exact-raw D28 signatures, per-link
 * currency (window, clock-anchored TTL ceilings, no future iat, live-ancestor epoch), the
 * lifecycle-bound child issuer (recycled-alias defense), strict-false revocation, bounded
 * chain length + await budget, issuer = parent's holder, fail closed everywhere.
 *
 * Run: pnpm smoke:ep-handle   (broker-free; part of smoke:ci)
 */
import { createUser } from "@nats-io/nkeys";
import {
  EpEnvelopeError, signArtifact,
  parseHandle, handleDigest, compileHandleGrants, assertHandleContainedIn, verifyHandleChain,
  serializeHandle, HANDLE_MAX_LIVE_TTL_MS, HANDLE_MAX_STURDY_TTL_MS, HANDLE_MAX_CHAIN_LENGTH,
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
const holderP = { id: "u_holder.app", lifecycleUid: "h".repeat(26) };
const childHolder = { id: "u_sub.worker", lifecycleUid: "s".repeat(26) };
// STRUCTURED handles scope (§13.10): ceiling entries in the handle-grant shape itself — the
// full dimensions (commands, modes, target components, reads) the key may issue for.
const ROOT_CEILING = JSON.stringify({
  endpoint: "manager",
  commands: [
    { name: "deploy", targetOwner: "u_svc", authz: "owner" },
    { name: "status" },
    { name: "attach", targetOwner: "u_t", targetActor: "svc", targetLifecycleUid: "t".repeat(26) },
  ],
  reads: ["goal.u_a.b.c"],
});
const HOLDER_CEILING = JSON.stringify({
  endpoint: "manager",
  commands: [{ name: "status" }, { name: "deploy", targetOwner: "u_svc", authz: "owner" }],
  reads: ["goal.u_a.b.c"],
});
const anchor = (keyId: string, kp: { getPublicKey(): string }, owner: string, scope: string[], over: Partial<SignerAnchor> = {}): SignerAnchor => {
  const a: SignerAnchor = { keyId, publicKey: kp.getPublicKey(), owner, roles: ["handles"], scope: { handles: scope }, validFrom: 0, validTo: NOW + 10_000_000_000, ...over };
  anchors.set(keyId, a);
  return a;
};
anchor("root-1", rootKp, "u_iss", [ROOT_CEILING]);
anchor("holder-1", holderKp, "u_holder.app", [HOLDER_CEILING], { ownerLifecycleUid: holderP.lifecycleUid });
const resolveAnchor: AnchorResolver = (keyId) => anchors.get(keyId);
const noRevocation: HandleRevocationReader = () => false;
const notJournal = (): boolean => false;
const baseOpts = { resolveAnchor, space: SPACE, readRevocation: noRevocation, isJournalCommand: notJournal };

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
throws("nbf after exp is schema-invalid (an empty window is garbled)",
  () => parseHandle(signArtifact(rootBody({ nbf: NOW + 70_000 }) as Record<string, unknown>, rootKp)), "contract-invalid");
throws("a wildcard read scope is schema-invalid (reads are literal subtrees; the containment order supplies the prefix semantics)",
  () => parseHandle(signArtifact(rootBody({ grants: [{ endpoint: "manager", commands: [{ name: "status" }], reads: ["goal.*.b"] }] }) as Record<string, unknown>, rootKp)), "contract-invalid");

// ── the normative compiler: reads + explicit routes + journal seam ──
{
  const compiled = compileHandleGrants(rootHandle, { isJournalCommand: notJournal });
  const deploy = compiled.caps.find((k) => k.command === "deploy");
  const status = compiled.caps.find((k) => k.command === "status");
  c("an owner-domain command compiles to its authz mode pinning targetOwner",
    deploy?.target?.mode === "owner" && (deploy?.target as { tOwner: string }).tOwner === "u_svc");
  c("a no-target command compiles to no target", status !== undefined && status.target === undefined);
  c("a CLASS entry compiles with EXPLICIT routes [one] (never an implicit default downstream)",
    deploy?.routes?.length === 1 && deploy?.routes?.[0] === "one" && status?.routes?.[0] === "one");
  c("a request-class command compiles with NO journal flag", deploy?.journal === undefined);
}
{
  const triple = parseHandle(signArtifact(rootBody({ grants: [{ endpoint: "manager", commands: [{ name: "attach", targetOwner: "u_t", targetActor: "svc", targetLifecycleUid: "t".repeat(26) }] }] }), rootKp));
  const cap = compileHandleGrants(triple, { isJournalCommand: notJournal }).caps[0];
  c("an actor-pinned triple compiles to handle-mode carrying the verified triple",
    cap.target?.mode === "handle" && (cap.target as { tUid: string }).tUid === "t".repeat(26));
}
{
  const inst = parseHandle(signArtifact(rootBody({ grants: [{ endpoint: "manager", instanceId: "i".repeat(26), commands: [{ name: "status" }] }] }), rootKp));
  const cap = compileHandleGrants(inst, { isJournalCommand: notJournal }).caps[0];
  c("an instance entry compiles pinning the instanceId with routes [] (the exact ep.inst rails ONLY, never also the class rail)",
    cap.instanceId === "i".repeat(26) && Array.isArray(cap.routes) && cap.routes.length === 0);
}
{
  const withReads = parseHandle(signArtifact(rootBody({ grants: [{ endpoint: "manager", commands: [{ name: "status" }], reads: ["goal.u_a.b.c"] }] }), rootKp));
  const compiled = compileHandleGrants(withReads, { isJournalCommand: notJournal });
  c("signed read subtrees are COMPILED (consumed, never silently dropped)",
    compiled.reads.length === 1 && compiled.reads[0] === "goal.u_a.b.c");
  const journal = compileHandleGrants(withReads, { isJournalCommand: () => true });
  c("a journal-class command (per the REQUIRED class seam) compiles with journal: true", journal.caps[0].journal === true);
  throws("compiling without the command-class seam refuses (the compiler never guesses a class)",
    () => compileHandleGrants(withReads, undefined as never), "failed-precondition");
  throws("a class seam answering non-boolean never compiles",
    () => compileHandleGrants(withReads, { isJournalCommand: (() => "yes") as unknown as () => boolean }), "internal");
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
c("a single ROOT handle verifies (sturdy revocation strict-false; compiled bundle returned)",
  (await verifyHandleChain([rootHandle], { ...baseOpts, now: NOW, presenter: holderP })).compiled.caps.length === 2);
{
  const res = await verifyHandleChain([childHandle, rootHandle], { ...baseOpts, now: NOW, presenter: childHolder });
  c("a two-link chain verifies: child issued by the parent's holder key (lifecycle-bound), ⊆ the parent, presented inline",
    res.leaf.id === "cap-child" && res.compiled.caps.length === 1);
}
await rejects("a chain whose leaf is presented to the WRONG holder refuses (holder-bound)",
  () => verifyHandleChain([childHandle, rootHandle], { ...baseOpts, now: NOW, presenter: holderP }), "permission-denied");
await rejects("a chain missing its presented parent refuses (chains are presented inline in full)",
  () => verifyHandleChain([childHandle], { ...baseOpts, now: NOW, presenter: childHolder }), "permission-denied");
await rejects("an EXPIRED leaf refuses (window fails closed)",
  () => verifyHandleChain([childHandle, rootHandle], { ...baseOpts, now: NOW + 40_000, presenter: childHolder }), "permission-denied");
await rejects("a REVOKED ancestor refuses (every sturdy link is checked, not only the leaf)",
  () => verifyHandleChain([childHandle, rootHandle], { ...baseOpts, now: NOW, presenter: childHolder, readRevocation: (kid) => kid === "root-1" }), "permission-denied");
await rejects("a revocation reader answering UNDEFINED refuses (strict-false-only: an unreadable status is revoked)",
  () => verifyHandleChain([childHandle, rootHandle], { ...baseOpts, now: NOW, presenter: childHolder, readRevocation: (() => undefined) as unknown as HandleRevocationReader }), "permission-denied");
{
  // the child's issuer key must belong to the PARENT's holder; a child signed by the ROOT key
  // (owner u_iss, not the parent holder u_holder.app) is an issuer-authority violation.
  const forged = parseHandle(signArtifact(childBody({ issuer: { keyId: "root-1" } }), rootKp));
  await rejects("a child whose issuer key is NOT the parent's holder refuses (issuer of a child is the parent's holder)",
    () => verifyHandleChain([forged, rootHandle], { ...baseOpts, now: NOW, presenter: childHolder }), "permission-denied");
}
{
  // RECYCLED-ALIAS DEFENSE: the child issuer key must be LIFECYCLE-bound to the parent's
  // holder, not owner-text-matched. A key registered under the same owner id but another (or
  // no) lifecycle never issues off the predecessor's handles.
  const saved = anchors.get("holder-1")!;
  anchors.set("holder-1", { ...saved, ownerLifecycleUid: undefined });
  await rejects("a child issuer anchor WITHOUT a lifecycle binding refuses (owner text alone fails closed)",
    () => verifyHandleChain([childHandle, rootHandle], { ...baseOpts, now: NOW, presenter: childHolder }), "permission-denied");
  anchors.set("holder-1", { ...saved, ownerLifecycleUid: "z".repeat(26) });
  await rejects("a child issuer anchor bound to a DIFFERENT lifecycle (recycled alias) refuses",
    () => verifyHandleChain([childHandle, rootHandle], { ...baseOpts, now: NOW, presenter: childHolder }), "permission-denied");
  anchors.set("holder-1", saved);
}
{
  // STRUCTURED issuer scope: dimensions a flat endpoint.command list cannot express.
  const evilTarget = parseHandle(signArtifact(rootBody({ id: "cap-evil", grants: [{ endpoint: "manager", commands: [{ name: "deploy", targetOwner: "u_EVIL", authz: "owner" }] }] }), rootKp));
  await rejects("a handle granting a command against a TARGET OWNER outside the key's structured ceiling refuses",
    () => verifyHandleChain([evilTarget], { ...baseOpts, now: NOW, presenter: holderP }), "permission-denied");
  const evilReads = parseHandle(signArtifact(rootBody({ id: "cap-evilreads", grants: [{ endpoint: "manager", commands: [{ name: "status" }], reads: ["secret.x"] }] }), rootKp));
  await rejects("a handle granting READ SUBTREES outside the key's structured ceiling refuses",
    () => verifyHandleChain([evilReads], { ...baseOpts, now: NOW, presenter: holderP }), "permission-denied");
  const saved = anchors.get("root-1")!;
  anchors.set("root-1", { ...saved, scope: { handles: ["not json"] } });
  await rejects("a garbled (non-grant-shaped) scope ceiling never authorizes",
    () => verifyHandleChain([rootHandle], { ...baseOpts, now: NOW, presenter: holderP }), "permission-denied");
  anchors.set("root-1", saved);
}
{
  // D28 EXACT-RAW verification: an owner-domain command WITHOUT an explicit authz is legal and
  // must verify — the signature is over the raw signed bytes; the projection injects nothing.
  const noAuthz = signArtifact(rootBody({ id: "cap-noauthz", grants: [{ endpoint: "manager", commands: [{ name: "deploy", targetOwner: "u_svc" }] }] }), rootKp);
  const res = await verifyHandleChain([noAuthz], { ...baseOpts, now: NOW, presenter: holderP });
  c("an owner-domain command with the DEFAULT (absent) authz verifies over the exact raw bytes and compiles to owner mode",
    res.compiled.caps[0].target?.mode === "owner");
}
{
  // a tampered leaf (grants mutated after signing) fails its signature.
  const raw = signArtifact(childBody(), holderKp) as Record<string, unknown>;
  (raw as { holder: { id: string } }).holder.id = "u_evil"; // change a signed field
  await rejects("a tampered handle fails its signature",
    () => verifyHandleChain([raw, rootHandle], { ...baseOpts, now: NOW, presenter: { id: "u_evil", lifecycleUid: childHolder.lifecycleUid } }), "permission-denied");
}
{
  // parentDigest mismatch: a child claiming a parent that isn't the one presented.
  const otherParent = parseHandle(signArtifact(rootBody({ id: "cap-other" }), rootKp));
  await rejects("a child whose parentDigest does not match the presented parent refuses (the chain is the one presented)",
    () => verifyHandleChain([childHandle, otherParent], { ...baseOpts, now: NOW, presenter: childHolder }), "permission-denied");
}
{
  // live handle: leaf epoch binding.
  const live = parseHandle(signArtifact(rootBody({ id: "cap-live", sturdy: false, epoch: 7, exp: NOW + 1000 }), rootKp));
  c("a LIVE handle with a matching presenter epoch verifies",
    (await verifyHandleChain([live], { ...baseOpts, now: NOW, presenter: { ...holderP, epoch: 7 } })).leaf.id === "cap-live");
  await rejects("a LIVE handle presented at a DIFFERENT epoch refuses (live authority dies on restart)",
    () => verifyHandleChain([live], { ...baseOpts, now: NOW, presenter: { ...holderP, epoch: 8 } }), "permission-denied");
}
{
  // PER-LINK currency: a live ANCESTOR binds ITS holder's epoch, fresh-checked.
  const liveParentRaw = signArtifact(rootBody({ id: "cap-liveparent", sturdy: false, epoch: 7, exp: NOW + 1000 }), rootKp);
  const liveParent = parseHandle(liveParentRaw);
  const liveChild = parseHandle(signArtifact(childBody({ id: "cap-livechild", sturdy: false, epoch: 3, exp: NOW + 900, parentDigest: handleDigest(liveParent) }), holderKp));
  const chain = [liveChild, liveParent];
  await rejects("a chain with a LIVE ancestor and NO holder-epoch seam refuses (epoch currency is never assumed)",
    () => verifyHandleChain(chain, { ...baseOpts, now: NOW, presenter: { ...childHolder, epoch: 3 } }), "failed-precondition");
  await rejects("a LIVE ancestor whose holder RESTARTED (current epoch advanced) kills the chain",
    () => verifyHandleChain(chain, { ...baseOpts, now: NOW, presenter: { ...childHolder, epoch: 3 }, resolveHolderEpoch: () => 8 }), "permission-denied");
  c("a LIVE ancestor at its CURRENT epoch verifies",
    (await verifyHandleChain(chain, { ...baseOpts, now: NOW, presenter: { ...childHolder, epoch: 3 }, resolveHolderEpoch: () => 7 })).leaf.id === "cap-livechild");
}
{
  const over = parseHandle(signArtifact(rootBody({ id: "cap-longlive", sturdy: false, epoch: 1, exp: NOW + HANDLE_MAX_LIVE_TTL_MS + 1 }), rootKp));
  await rejects("a LIVE handle whose TTL exceeds the 24h ceiling refuses",
    () => verifyHandleChain([over], { ...baseOpts, now: NOW, presenter: { ...holderP, epoch: 1 } }), "permission-denied");
}
{
  // PER-LINK ceilings: an ANCESTOR violating the sturdy ceiling refuses even under a tight leaf.
  const longParent = parseHandle(signArtifact(rootBody({ id: "cap-longparent", exp: NOW + HANDLE_MAX_STURDY_TTL_MS + 60_000 }), rootKp));
  const tightChild = parseHandle(signArtifact(childBody({ id: "cap-tight", parentDigest: handleDigest(longParent) }), holderKp));
  await rejects("an ANCESTOR whose validity span exceeds the sturdy ceiling refuses (per-link, not leaf-only)",
    () => verifyHandleChain([tightChild, longParent], { ...baseOpts, now: NOW, presenter: childHolder }), "permission-denied");
}
{
  // CLOCK-ANCHORED ceiling: a forward-dated iat cannot manufacture validity beyond the ceiling.
  const bypass = parseHandle(signArtifact(rootBody({
    id: "cap-bypass", sturdy: false, epoch: 1,
    nbf: NOW - 1_000, iat: NOW + HANDLE_MAX_LIVE_TTL_MS + 50_000, exp: NOW + HANDLE_MAX_LIVE_TTL_MS + 60_000,
  }), rootKp));
  await rejects("a future-iat handle refuses outright (no forward-dated signing time)",
    () => verifyHandleChain([bypass], { ...baseOpts, now: NOW, presenter: { ...holderP, epoch: 1 } }), "permission-denied");
  const anchoredBypass = parseHandle(signArtifact(rootBody({
    id: "cap-anchored", sturdy: false, epoch: 1,
    nbf: NOW - 1_000, iat: NOW - 500, exp: NOW + HANDLE_MAX_LIVE_TTL_MS + 60_000,
  }), rootKp));
  await rejects("exp beyond now + ceiling refuses (the ceiling is clock-anchored, not iat-relative)",
    () => verifyHandleChain([anchoredBypass], { ...baseOpts, now: NOW, presenter: { ...holderP, epoch: 1 } }), "permission-denied");
}
await rejects("a chain longer than the verification bound refuses",
  () => verifyHandleChain(new Array(HANDLE_MAX_CHAIN_LENGTH + 1).fill({}), { ...baseOpts, now: NOW, presenter: holderP }), "permission-denied");
await rejects("a HUNG revocation reader refuses `unavailable` within the verify budget, never a hung verification",
  () => verifyHandleChain([rootHandle], { ...baseOpts, now: NOW, presenter: holderP, readRevocation: (() => ({ then() { /* never settles */ } })) as unknown as HandleRevocationReader, verifyBudgetMs: 100 }), "unavailable");

// ── serialization is strict I-JSON ──
c("a handle serializes to canonical bytes", serializeHandle(rootHandle).length > 0);

console.log(`\nENDPOINT HANDLE SMOKE ${fail === 0 ? "OK ✅ " : "FAILED ❌ "} (${ok} passed, ${fail} failed)`);
if (fail > 0) process.exit(1);
