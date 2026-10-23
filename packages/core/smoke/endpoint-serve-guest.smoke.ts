/**
 * Guest-side serve grant smoke (SPEC §13.9 "Registration returns the host-authorized serving
 * snapshot"): a service that registered through the service door holds a parsed `credential`
 * result and its embedded closure, and no store access.
 *   - Reproduction: the only public constructors were the store-backed `authorizeServeGrant` and
 *     the host-only `authorizeTrustedServeSnapshot`; a grant assembled by hand from the snapshot
 *     refuses at `assertServeGrantAuthorized`, so `serveEndpoint` was unreachable for a guest.
 *   - `authorizeGuestServeGrant` brands a grant from the parsed result and the embedded closure.
 *   - It refuses another account, a bearer naming another witness or no serve duty, a closure set
 *     that is not the embedded one, an artifact the guest did not embed, a closure whose manifest
 *     does not verify, and a mutated copy of the grant it produced.
 *
 * Run: pnpm smoke:ep-serve:guest   (no broker; part of smoke:ci)
 */
import {
  EpEnvelopeError, VOID_SCHEMA_DIGEST, assertServeGrantAuthorized, authorizeGuestServeGrant, contractDigest,
  createSpaceAuth, mintLifecycleUid, parseServiceAuthorityResult, serviceEndpointActor, singleDocumentClosure,
  type EpServeGrant, type ServiceAuthorityRequest, type ServiceAuthorityResult, type ServiceRegistration,
  type ServiceRegistrationWitness,
} from "../src/index.js";

let ok = 0, fail = 0;
const c = (n: string, v: boolean, extra?: unknown) => { if (v) { ok++; console.log(`  ✓ ${n}`); } else { fail++; console.log("  ✗ FAIL:", n, extra ?? ""); } };
const refuses = async (n: string, fn: () => Promise<unknown> | unknown, code: string) => {
  try { await fn(); c(n, false, "no throw"); } catch (e) {
    c(n, e instanceof EpEnvelopeError && e.code === code, `code ${(e as EpEnvelopeError).code ?? (e as Error).message}`);
  }
};

const ENDPOINT = "ai.cotal.machine";
const COMMAND = (name: string) => ({ name, class: "ephemeral", targeted: false, capability: "read", inputDigest: VOID_SCHEMA_DIGEST, outputDigest: VOID_SCHEMA_DIGEST });
const CLUSTER = { urn: ENDPOINT, revision: 1, attributes: [], events: [], commands: [COMMAND("machine-status")] };
const closureOf = (document: unknown): ServiceRegistration => {
  const closure = singleDocumentClosure(document);
  return { clusterDigests: [closure.closureDigest], contractArtifacts: [closure.manifest, document] };
};
const registration = closureOf(CLUSTER);

const space = "epsguest";
const account = (await createSpaceAuth(space)).account.pub;
const owner = `u_${"a".repeat(26)}`;
const instanceId = mintLifecycleUid();
const witness: ServiceRegistrationWitness = {
  accountPublicKey: account, space, endpoint: ENDPOINT, instanceId,
  principal: { owner, actor: serviceEndpointActor({ accountPublicKey: account, space, owner, endpoint: ENDPOINT, instanceId }), lifecycleUid: mintLifecycleUid() },
  rootCredentialId: mintLifecycleUid(), approvalDigest: contractDigest({ approval: 1 }),
  processEpoch: 3, registrationRevision: 7, nameAuthorityRevision: 2,
  registrationRequestId: "1".repeat(32), registrationProof: contractDigest({ proof: 1 }),
};
const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
const bearerFor = (w: ServiceRegistrationWitness, view = "service-endpoint", duty = "serve") =>
  `${b64({ alg: "EdDSA", kid: "k1" })}.${b64({ iss: "https://idp.example", act: { view, service: { duty, witness: w } }, exp: 2_000_000_000 })}.${b64("sig")}`;

const request: ServiceAuthorityRequest = {
  v: 1, kind: "service-endpoint-authority", requestId: "2".repeat(32), space, accountPublicKey: account,
  endpoint: ENDPOINT, instanceId, operation: "activate", witness,
};
type Credential = Extract<ServiceAuthorityResult, { state: "credential" }>;
const credentialFor = (opts: { bearer?: string; artifacts?: unknown[]; digests?: string[]; w?: ServiceRegistrationWitness } = {}): Credential => {
  const w = opts.w ?? witness;
  const raw = {
    v: 1, kind: "service-endpoint-authority", requestId: request.requestId, space, accountPublicKey: account,
    endpoint: ENDPOINT, instanceId, operation: "activate", state: "credential", witness: w, duty: "serve",
    snapshot: {
      spec: { value: { endpoint: ENDPOINT, owner, clusterDigests: opts.digests ?? registration.clusterDigests, protocol: { v: 1 } }, revision: w.registrationRevision },
      name: { authorized: true, revision: w.nameAuthorityRevision },
      processEpoch: w.processEpoch,
      contractArtifacts: opts.artifacts ?? registration.contractArtifacts,
    },
    accessBearer: opts.bearer ?? bearerFor(w), accessExpiresAt: 2_000_000_000, renewalProof: "renewal", renewalExpiresAt: 2_000_100_000,
  };
  return parseServiceAuthorityResult(raw, request) as Credential;
};

// ---- reproduction: no public path from a credential result to a branded grant -------------------
{
  const credential = credentialFor();
  const byHand: EpServeGrant = Object.freeze({
    space, endpoint: ENDPOINT, instanceId, epoch: witness.processEpoch, owner,
    registrationRevision: credential.snapshot.spec.revision, nameAuthorityRevision: credential.snapshot.name.revision,
    commands: Object.freeze(["machine-status"]), surface: Object.freeze({}), journalClass: false, pools: Object.freeze([]),
    descriptor: Object.freeze({ endpoint: ENDPOINT, owner, protocol: { v: 1 as const }, clusters: [] }),
  });
  await refuses("a grant assembled by hand from the host snapshot carries no serve authority", () => assertServeGrantAuthorized(byHand), "permission-denied");
}

// ---- positive: the seam brands a grant from the parsed result and the embedded closure ----------
{
  const grant = await authorizeGuestServeGrant({ accountPublicKey: account, result: credentialFor(), registration });
  const snap = assertServeGrantAuthorized(grant);
  c("the guest grant is authorized at the witness coordinates",
    snap.space === space && snap.endpoint === ENDPOINT && snap.instanceId === instanceId && snap.epoch === 3 && snap.owner === owner
    && snap.registrationRevision === 7 && snap.nameAuthorityRevision === 2, snap);
  c("the grant's surface is the verified registered command set", grant.commands.length === 1 && grant.commands[0] === "machine-status"
    && grant.surface["machine-status"]?.capability === "read" && grant.journalClass === false && grant.pools.length === 0, grant.commands);
  c("the descriptor advertises the embedded closure digest with its verified document inline",
    grant.descriptor.clusters.length === 1 && grant.descriptor.clusters[0].digest === registration.clusterDigests[0]
    && grant.descriptor.clusters[0].commands[0] === "machine-status", grant.descriptor.clusters);
  const copy: EpServeGrant = Object.freeze({ ...grant, commands: Object.freeze([...grant.commands, "extra"]) });
  await refuses("a mutated copy of the guest grant refuses", () => assertServeGrantAuthorized(copy), "permission-denied");
}

// ---- negatives: every binding the seam proves, broken one at a time ----------------------------
const otherAccount = (await createSpaceAuth("epsother")).account.pub;
await refuses("another pinned account refuses", () => authorizeGuestServeGrant({ accountPublicKey: otherAccount, result: credentialFor(), registration }), "permission-denied");
{
  const other = { ...witness, instanceId: mintLifecycleUid() };
  await refuses("a bearer naming another witness refuses", () => authorizeGuestServeGrant({ accountPublicKey: account, result: credentialFor({ bearer: bearerFor({ ...other, principal: { ...witness.principal, actor: serviceEndpointActor({ accountPublicKey: account, space, owner, endpoint: ENDPOINT, instanceId: other.instanceId }) } }) }), registration }), "permission-denied");
}
await refuses("a bearer without the serve duty refuses", () => authorizeGuestServeGrant({ accountPublicKey: account, result: credentialFor({ bearer: bearerFor(witness, "service-endpoint", "call") }), registration }), "permission-denied");
await refuses("a bearer that is not a JWS refuses", () => authorizeGuestServeGrant({ accountPublicKey: account, result: credentialFor({ bearer: "not-a-token" }), registration }), "permission-denied");
{
  const otherClosure = closureOf({ ...CLUSTER, commands: [COMMAND("machine-vitals")] });
  await refuses("a closure set that is not the embedded one refuses",
    () => authorizeGuestServeGrant({ accountPublicKey: account, result: credentialFor({ digests: otherClosure.clusterDigests, artifacts: otherClosure.contractArtifacts }), registration }), "permission-denied");
  await refuses("an answered artifact the guest did not embed refuses",
    () => authorizeGuestServeGrant({ accountPublicKey: account, result: credentialFor({ artifacts: [registration.contractArtifacts[0], otherClosure.contractArtifacts[1]] }), registration }), "permission-denied");
}
{
  // Same digests on both sides, but the artifacts behind them are not the closure they claim: the
  // byte comparison passes, and the §13.7 read then finds no artifact at the claimed closure
  // digest, because artifacts are addressed by their own content and a forged manifest cannot sit
  // at the original digest.
  const forged = closureOf({ ...CLUSTER, revision: 2 });
  const lying: ServiceRegistration = { clusterDigests: registration.clusterDigests, contractArtifacts: forged.contractArtifacts };
  await refuses("a closure whose claimed digest names no answered artifact refuses",
    () => authorizeGuestServeGrant({ accountPublicKey: account, result: credentialFor({ artifacts: forged.contractArtifacts }), registration: lying }), "failed-precondition");
}

console.log(`\n${ok} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
