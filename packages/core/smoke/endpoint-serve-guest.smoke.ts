/**
 * Guest-side serve grant smoke (SPEC §13.6 "Registration returns the host-authorized serving
 * snapshot"): a service that registered through the service door holds a parsed `credential`
 * result, its embedded closure and the pinned issuer's published keys, and no store access.
 *   - Reproduction: the only public constructors were the store-backed `authorizeServeGrant` and
 *     the host-only `authorizeTrustedServeSnapshot`; a grant assembled by hand from the snapshot
 *     refuses at `assertServeGrantAuthorized`, so `serveEndpoint` was unreachable for a guest.
 *   - `authorizeGuestServeGrant` brands a grant from the parsed result, the embedded closure and
 *     a bearer whose EdDSA signature verifies under the issuer's published key.
 *   - It refuses another account; a bearer signed by another key, naming an unpublished kid, with
 *     no signature or a tampered payload, from another issuer or audience, expired or issued in
 *     the future, for another subject, without the serve duty, for another instance, or for
 *     another witness of this same principal; a closure set that is not the
 *     embedded one; an artifact the guest did not embed; a closure that does not read at its
 *     claimed digest; and a mutated copy of the grant it produced.
 *
 * Run: pnpm smoke:ep-serve:guest   (no broker; part of smoke:ci)
 */
import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import {
  EpEnvelopeError, VOID_SCHEMA_DIGEST, assertServeGrantAuthorized, authorizeGuestServeGrant, contractDigest,
  createSpaceAuth, mintLifecycleUid, parseServiceAuthorityResult, serviceEndpointActor, singleDocumentClosure,
  type EpServeGrant, type GuestServeAuthenticity, type ServiceAuthorityRequest, type ServiceAuthorityResult,
  type ServiceIssuerKey, type ServiceRegistration, type ServiceRegistrationWitness,
} from "../src/index.js";

let ok = 0, fail = 0;
const c = (n: string, v: boolean, extra?: unknown) => { if (v) { ok++; console.log(`  ✓ ${n}`); } else { fail++; console.log("  ✗ FAIL:", n, extra ?? ""); } };
const refuses = async (n: string, fn: () => Promise<unknown> | unknown, code: string, message?: string) => {
  try { await fn(); c(n, false, "no throw"); } catch (e) {
    const matches = e instanceof EpEnvelopeError && e.code === code && (message === undefined || e.message.includes(message));
    c(n, matches, `code ${(e as EpEnvelopeError).code ?? "?"}: ${(e as Error).message}`);
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
const witnessFor = (instance: string): ServiceRegistrationWitness => ({
  accountPublicKey: account, space, endpoint: ENDPOINT, instanceId: instance,
  principal: { owner, actor: serviceEndpointActor({ accountPublicKey: account, space, owner, endpoint: ENDPOINT, instanceId: instance }), lifecycleUid: "l".repeat(26) },
  rootCredentialId: "r".repeat(26), approvalDigest: contractDigest({ approval: 1 }),
  processEpoch: 3, registrationRevision: 7, nameAuthorityRevision: 2,
  registrationRequestId: "1".repeat(32), registrationProof: contractDigest({ proof: 1 }),
});
const witness = witnessFor(instanceId);

// The issuer: a real Ed25519 key whose public half is "published", and a second key that is not.
const ISSUER = "https://auth.example/exchange";
const keyPair = generateKeyPairSync("ed25519"), otherPair = generateKeyPairSync("ed25519");
const jwkOf = (key: KeyObject, kid: string): ServiceIssuerKey => ({ ...(key.export({ format: "jwk" }) as { kty: "OKP"; crv: "Ed25519"; x: string }), kid });
const published: ServiceIssuerKey = jwkOf(keyPair.publicKey, "kid-1");
// Bearers are minted on the real clock: the seam reads the process clock, never a caller's.
const NOW = Math.floor(Date.now() / 1000);
const authenticity: GuestServeAuthenticity = { issuer: ISSUER, keys: [published] };

const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
const signed = (header: unknown, payload: unknown, key: KeyObject = keyPair.privateKey) => {
  const signing = `${b64(header)}.${b64(payload)}`;
  return `${signing}.${sign(null, Buffer.from(signing), key).toString("base64url")}`;
};
const claimsFor = (w: ServiceRegistrationWitness, over: Record<string, unknown> = {}, act: Record<string, unknown> = {}, service: Record<string, unknown> = {}) => ({
  iss: ISSUER, aud: space, sub: owner, iat: NOW, nbf: NOW, exp: NOW + 60, scope: [], ver: 1,
  act: { owner, actor: w.principal.actor, scope: [], lifecycleUid: w.principal.lifecycleUid, credentialId: w.rootCredentialId,
    view: "service-endpoint", service: { duty: "serve", witness: w, ...service }, ...act },
  ...over,
});
const HEADER = { alg: "EdDSA", kid: "kid-1" };
const bearerFor = (w: ServiceRegistrationWitness) => signed(HEADER, claimsFor(w));

const request: ServiceAuthorityRequest = {
  v: 1, kind: "service-endpoint-authority", requestId: "2".repeat(32), space, accountPublicKey: account,
  endpoint: ENDPOINT, instanceId, operation: "activate", witness,
};
type Credential = Extract<ServiceAuthorityResult, { state: "credential" }>;
const credentialFor = (opts: { bearer?: string; artifacts?: unknown[]; digests?: string[] } = {}): Credential => {
  const raw = {
    v: 1, kind: "service-endpoint-authority", requestId: request.requestId, space, accountPublicKey: account,
    endpoint: ENDPOINT, instanceId, operation: "activate", state: "credential", witness, duty: "serve",
    snapshot: {
      spec: { value: { endpoint: ENDPOINT, owner, clusterDigests: opts.digests ?? registration.clusterDigests, protocol: { v: 1 } }, revision: witness.registrationRevision },
      name: { authorized: true, revision: witness.nameAuthorityRevision },
      processEpoch: witness.processEpoch,
      contractArtifacts: opts.artifacts ?? registration.contractArtifacts,
    },
    accessBearer: opts.bearer ?? bearerFor(witness), accessExpiresAt: NOW + 60, renewalProof: "renewal", renewalExpiresAt: NOW + 86_400,
  };
  return parseServiceAuthorityResult(raw, request) as Credential;
};
const guest = (over: Partial<Parameters<typeof authorizeGuestServeGrant>[0]> = {}) =>
  authorizeGuestServeGrant({ accountPublicKey: account, result: credentialFor(), registration, authenticity, ...over });
const withBearer = (bearer: string) => guest({ result: credentialFor({ bearer }) });

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

// ---- positive: the seam brands a grant from the parsed result, the closure and a signed bearer --
{
  const grant = await guest();
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

// ---- the bearer must be a signed credential for exactly this witness ---------------------------
await refuses("a bearer signed by a key the issuer does not publish refuses", () => withBearer(signed(HEADER, claimsFor(witness), otherPair.privateKey)), "permission-denied");
await refuses("a bearer naming an unpublished kid refuses", () => withBearer(signed({ alg: "EdDSA", kid: "kid-2" }, claimsFor(witness))), "permission-denied");
await refuses("an unsigned bearer refuses", () => withBearer(`${b64({ alg: "none", kid: "kid-1" })}.${b64(claimsFor(witness))}.`), "permission-denied");
await refuses("a bearer with embedded key material refuses", () => withBearer(signed({ ...HEADER, jwk: published }, claimsFor(witness))), "permission-denied");
{
  const [h, , s] = bearerFor(witness).split(".");
  await refuses("a signed bearer whose payload was changed afterwards refuses", () => withBearer(`${h}.${b64(claimsFor(witness, { exp: NOW + 3600 }))}.${s}`), "permission-denied");
}
await refuses("a bearer from another issuer refuses", () => withBearer(signed(HEADER, claimsFor(witness, { iss: "https://other.example" }))), "permission-denied");
await refuses("a bearer for another space refuses", () => withBearer(signed(HEADER, claimsFor(witness, { aud: "epsother" }))), "permission-denied");
await refuses("a bearer scoped to two audiences refuses", () => withBearer(signed(HEADER, claimsFor(witness, { aud: [space, "epsother"] }))), "permission-denied");
await refuses("an expired bearer refuses", () => withBearer(signed(HEADER, claimsFor(witness, { iat: NOW - 120, nbf: NOW - 120, exp: NOW - 60 }))), "permission-denied", "has expired");
await refuses("a bearer issued in the future refuses", () => withBearer(signed(HEADER, claimsFor(witness, { iat: NOW + 3600, nbf: NOW + 3600, exp: NOW + 3660 }))), "permission-denied", "issued in the future");
await refuses("a bearer with a lifetime past the fixed cap refuses", () => withBearer(signed(HEADER, claimsFor(witness, { exp: NOW + 61 }))), "permission-denied");
await refuses("a bearer for another subject refuses", () => withBearer(signed(HEADER, claimsFor(witness, { sub: `u_${"b".repeat(26)}` }, { owner: `u_${"b".repeat(26)}` }))), "permission-denied");
await refuses("a bearer without the serve duty refuses", () => withBearer(signed(HEADER, claimsFor(witness, {}, {}, { duty: "call" }))), "permission-denied");
await refuses("a bearer with ordinary scope refuses", () => withBearer(signed(HEADER, claimsFor(witness, { scope: ["chat"] }))), "permission-denied");
{
  // Signed by the real issuer, but for another registered instance: the other connection's
  // credential cannot brand this instance's grant.
  const other = witnessFor(mintLifecycleUid());
  await refuses("a bearer validly signed for another instance refuses", () => withBearer(signed(HEADER, claimsFor(other))), "permission-denied");
  // Signed by the real issuer for this same principal, but for another witness of it (a stale
  // epoch): the actor claims all match, and only the witness equality refuses it. That check is
  // what makes the grant's epoch and revisions signed values.
  await refuses("a bearer validly signed for another witness of this principal refuses",
    () => withBearer(signed(HEADER, claimsFor({ ...witness, processEpoch: 2 }))), "permission-denied", "names another registration witness");
}
await refuses("a bearer that is not a JWS refuses", () => withBearer("not-a-token"), "permission-denied");

// ---- the rest of the binding, broken one at a time ---------------------------------------------
const otherAccount = (await createSpaceAuth("epsother")).account.pub;
await refuses("another pinned account refuses", () => guest({ accountPublicKey: otherAccount }), "permission-denied");
{
  const otherClosure = closureOf({ ...CLUSTER, commands: [COMMAND("machine-vitals")] });
  await refuses("a closure set that is not the embedded one refuses",
    () => guest({ result: credentialFor({ digests: otherClosure.clusterDigests, artifacts: otherClosure.contractArtifacts }) }), "permission-denied");
  await refuses("an answered artifact the guest did not embed refuses",
    () => guest({ result: credentialFor({ artifacts: [registration.contractArtifacts[0], otherClosure.contractArtifacts[1]] }) }), "permission-denied");
}
{
  // Same digests on both sides, but the artifacts behind them are not the closure they claim: the
  // byte comparison passes, and the §13.7 read then finds no artifact at the claimed closure
  // digest, because artifacts are addressed by their own content and a forged manifest cannot sit
  // at the original digest.
  const forged = closureOf({ ...CLUSTER, revision: 2 });
  const lying: ServiceRegistration = { clusterDigests: registration.clusterDigests, contractArtifacts: forged.contractArtifacts };
  await refuses("a closure whose claimed digest names no answered artifact refuses",
    () => guest({ result: credentialFor({ artifacts: forged.contractArtifacts }), registration: lying }), "failed-precondition");
}

console.log(`\n${ok} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
