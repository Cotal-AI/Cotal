import { compactVerify, importJWK, type JWK } from "jose";
import { fromPublic } from "@nats-io/nkeys";
import type { NatsConnection } from "@nats-io/transport-node";
import { canonicalJson, contractDigest, rawDigest } from "./canonical.js";
import { EpEnvelopeError } from "./endpoint-envelope.js";
import { compileContract } from "./schema-profile.js";
import { epCall } from "./endpoint-verbs.js";
import { mintLifecycleUid } from "./subjects.js";
import { parseEndpointDelegatedBinding, type EndpointDelegatedBinding } from "./endpoint-authority-policy.js";
import { authorizeTrustedServeSnapshot, type EpServeGrant, type EpCommandAuthority } from "./endpoint-service.js";
import { verifyClusterManifest, verifyClusterRoot, deriveDescriptor } from "./endpoint-cluster.js";
import { stockEndpointRequestAuthority, type EndpointRequestAuthority, type EndpointTerminalOutcome } from "./endpoint-authority-admission.js";
import type { IssuedAuthorityRef } from "./issued-authority.js";
import type { EpCaller } from "./endpoint-subjects.js";
import { epServeGrantRows } from "./endpoint-grants.js";
import { parseClosureManifest } from "./contract-manifest.js";

import { ENDPOINT_AUTHORITY_INPUT_SCHEMA, ENDPOINT_AUTHORITY_OUTPUT_SCHEMA, endpointServeAttestationContract } from "./endpoint-authority-wire.js";
export { ENDPOINT_AUTHORITY_INPUT_SCHEMA, ENDPOINT_AUTHORITY_OUTPUT_SCHEMA } from "./endpoint-authority-wire.js";
const contract = { input: compileContract({ root: ENDPOINT_AUTHORITY_INPUT_SCHEMA }), output: compileContract({ root: ENDPOINT_AUTHORITY_OUTPUT_SCHEMA }) };
export interface EndpointAuthorityTransportPin { space: string; instanceId: string; epoch: number; caller: EpCaller }
export async function endpointAuthorityCall(nc: NatsConnection, pin: EndpointAuthorityTransportPin, command: "ep-check" | "ep-admit" | "ep-release", args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const reply = await epCall(nc, pin.space, { mode: "inst", instanceId: pin.instanceId, epoch: pin.epoch }, { endpoint: "auth", command, contract, caller: pin.caller, args, bind: { instanceId: pin.instanceId, epoch: pin.epoch } }, { deadlineMs: 5000 });
  if (!reply.reply.ok) {
    const code = command === "ep-admit" && reply.reply.error?.code === "conflict" ? "conflict" : "permission-denied";
    throw new EpEnvelopeError(code, `endpoint authority refused ${command}: ${reply.reply.error?.message ?? "unknown"}`);
  }
  return reply.reply.data as Record<string, unknown>;
}
export interface EndpointServeAttestation {
  v: 2; kind: "cotal.endpoint-serve"; issuer: string;
  endpoint: string; instanceId: string; registrationRevision: number; processEpoch: number;
  operationId: string; account: EndpointDelegatedBinding["account"]; holder: EndpointDelegatedBinding["holder"];
  authority: EndpointDelegatedBinding["authority"]; protocol: { v: 3 }; ceiling: EndpointDelegatedBinding["ceiling"];
  clusterDigests: string[]; credentialId: string; credentialDigest: string;
  issuedAt: number; expiresAt: number;
}
export interface EndpointServeAdoption {
  grant: EpServeGrant;
  requestAuthority: EndpointRequestAuthority;
}
/** Stock authenticated constructor. The caller's connection reaches only the pinned auth endpoint.
 * JWS keys/account are preconfigured trust, never response-selected. No issuer/storage privilege. */
export async function adoptEndpointService(args: {
  nc: NatsConnection; authority: EndpointAuthorityTransportPin;
  trust: { issuer: string; accountPublicKey: string; assignmentRevision: number; keys: readonly JWK[]; accountSigningKey: string };
  serveJwt: string; attestation: string; artifacts: readonly { digest: string; value: Record<string, unknown> | boolean }[];
  holder: { publicKey: string; sign(bytes: Uint8Array): Promise<Uint8Array> };
}): Promise<EndpointServeAdoption> {
  if (args.attestation.length > 32768 || args.serveJwt.length > 32768) throw new Error("endpoint material exceeds byte bound");
  const verified = await compactVerify(args.attestation, async header => {
    if (header.alg !== "EdDSA" || typeof header.kid !== "string") throw new Error("unsupported endpoint attestation key");
    const key = args.trust.keys.find(key => key.kid === header.kid);
    if (!key || key.d !== undefined) throw new Error("unknown or private endpoint attestation key");
    return importJWK(key, "EdDSA");
  }, { algorithms: ["EdDSA"] });
  const raw = JSON.parse(new TextDecoder().decode(verified.payload)) as EndpointServeAttestation;
  if (!endpointServeAttestationContract.validate(raw) || raw.issuer !== args.trust.issuer) throw new Error("endpoint attestation closed payload does not validate");
  const binding = parseEndpointDelegatedBinding({ account: raw.account, holder: raw.holder, authority: raw.authority, ceiling: raw.ceiling }), now = Math.floor(Date.now() / 1000);
  if (binding.account.space !== args.authority.space || binding.account.accountPublicKey !== args.trust.accountPublicKey || binding.account.assignmentRevision !== args.trust.assignmentRevision || binding.holder.publicKey !== args.holder.publicKey || raw.expiresAt > binding.ceiling.expiresAt || raw.expiresAt <= now || raw.issuedAt > now || raw.issuedAt >= raw.expiresAt || raw.credentialDigest !== rawDigest(args.serveJwt) || raw.credentialId !== raw.credentialDigest.replace("sha256:", "sha256-")) throw new Error("endpoint attestation account/holder/credential/time disagreement");
  const [header, payload, signature, extra] = args.serveJwt.split(".");
  if (!header || !payload || !signature || extra !== undefined || !fromPublic(args.trust.accountSigningKey).verify(new TextEncoder().encode(header + "." + payload), Buffer.from(signature, "base64url"))) throw new Error("serve credential signature does not verify");
  const credential = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { sub: string; iss: string; exp: number; nats: { issuer_account: string; pub: { allow: string[] }; sub: { allow: string[] } } };
  if (credential.sub !== binding.holder.publicKey || credential.iss !== args.trust.accountSigningKey || credential.nats.issuer_account !== binding.account.accountPublicKey || credential.exp !== raw.expiresAt) throw new Error("serve JWT disagrees with trusted attestation");
  const artifactMap = new Map<string, Record<string, unknown> | boolean>();
  let bytes = 0;
  for (const artifact of args.artifacts) {
    const encoded = canonicalJson(artifact.value); bytes += Buffer.byteLength(encoded);
    if (contractDigest(artifact.value) !== artifact.digest || artifactMap.has(artifact.digest) || Buffer.byteLength(encoded) > 262144 || bytes > 1048576) throw new Error("invalid or oversized endpoint contract artifacts");
    artifactMap.set(artifact.digest, artifact.value);
  }
  const surface: Record<string, EpCommandAuthority> = Object.create(null);
  const clusters = raw.clusterDigests.map(digest => {
    const { root } = verifyClusterManifest(digest, artifactMap.get(digest));
    const document = verifyClusterRoot(root, artifactMap.get(root));
    if (document.attributes.length || document.events.length || document.commands.some(c => c.class !== "ephemeral" || c.action || c.effect === undefined)) throw new Error("unsupported delegated contract resources/effects");
    for (const command of document.commands) {
      if (surface[command.name]) throw new Error("duplicate endpoint command");
      for (const schemaDigest of [command.inputDigest, command.outputDigest]) {
        const manifest = parseClosureManifest(artifactMap.get(schemaDigest), "endpoint schema closure");
        if (contractDigest(manifest) !== schemaDigest || manifest.members.length !== 0) throw new Error("unsupported or mismatched schema closure");
        const schema = artifactMap.get(manifest.root);
        if (schema === undefined || compileContract({ root: schema }).closureDigest !== schemaDigest) throw new Error("schema closure did not verify");
      }
      surface[command.name] = { clusterDigest: digest, class: command.class, targeted: command.targeted, modes: command.modes ?? [], capability: command.capability, inputDigest: command.inputDigest, outputDigest: command.outputDigest, traits: command.traits ?? [] };
    }
    return { digest, document, raw: artifactMap.get(root) as Record<string, unknown> };
  });
  const descriptor = deriveDescriptor({ endpoint: raw.endpoint, owner: binding.holder.owner, protocol: { v: 3 }, servingAuthority: binding.authority, serveRoutes: binding.ceiling.routes, resources: binding.ceiling.resources }, clusters);
  const expectedRows = epServeGrantRows(binding.account.space, { endpoint: raw.endpoint, instanceId: raw.instanceId, epoch: raw.processEpoch, ephemeralCommands: Object.keys(surface), routes: binding.ceiling.routes });
  const expectedSub = [...expectedRows.sub, `_INBOX_${binding.holder.publicKey}.>`].sort();
  if (canonicalJson([...credential.nats.pub.allow].sort()) !== canonicalJson([...expectedRows.pub].sort()) || canonicalJson([...credential.nats.sub.allow].sort()) !== canonicalJson(expectedSub)) throw new Error("serve JWT native permissions do not equal the attested ceiling");
  const nonce = mintLifecycleUid();
  const proofBytes = new TextEncoder().encode(canonicalJson({ kind: "cotal.endpoint-adopt", nonce, credentialDigest: raw.credentialDigest, binding, endpoint: raw.endpoint, instanceId: raw.instanceId, processEpoch: raw.processEpoch, registrationRevision: raw.registrationRevision }));
  const freshness = await endpointAuthorityCall(args.nc, args.authority, "ep-check", { v: 2, endpoint: raw.endpoint, instanceId: raw.instanceId, credentialDigest: raw.credentialDigest, nonce, signature: Buffer.from(await args.holder.sign(proofBytes)).toString("base64url") });
  if (freshness.current !== true || freshness.credentialDigest !== raw.credentialDigest) throw new Error("stock authority did not verify fresh serving custody");
  const grant = authorizeTrustedServeSnapshot({ space: binding.account.space, endpoint: raw.endpoint, instanceId: raw.instanceId, epoch: raw.processEpoch, owner: binding.holder.owner, registrationRevision: raw.registrationRevision, nameAuthorityRevision: binding.authority.namespaceRevision, commands: Object.keys(surface), surface, descriptor, routes: binding.ceiling.routes, delegated: binding });
  const requestAuthority = stockEndpointRequestAuthority(async request => {
    const operationId = mintLifecycleUid(), envelopeDigest = contractDigest(request.request);
    const serving = { account: binding.account, endpoint: grant.endpoint, instanceId: grant.instanceId, epoch: grant.epoch, authority: binding.authority };
    const response = await endpointAuthorityCall(args.nc, args.authority, "ep-admit", { v: 2, operation: "admit", operationId, serving, requestSubject: request.requestSubject, request: { id: request.request.id, envelopeDigest } });
    if (typeof response.admissionId !== "string" || !Array.isArray(response.commands) || response.commands.some(c => typeof c !== "string" || !(c in surface)) || response.requestSubjectDigest !== rawDigest(request.requestSubject) || response.envelopeDigest !== envelopeDigest) throw new Error("endpoint admission response binding mismatch");
    const admissionId = response.admissionId;
    return { caller: response.caller as unknown as IssuedAuthorityRef, commands: Object.freeze([...response.commands] as string[]), async release(outcome: EndpointTerminalOutcome) {
      const released = await endpointAuthorityCall(args.nc, args.authority, "ep-release", { v: 2, operation: "release", operationId, admissionId, serving, outcome });
      if (released.released !== true || released.admissionId !== admissionId || released.outcome !== outcome) throw new Error("endpoint terminal release response mismatch");
    } };
  });
  return { grant, requestAuthority };
}
