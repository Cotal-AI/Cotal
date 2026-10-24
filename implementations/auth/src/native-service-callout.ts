import {
  SERVICE_ACCESS_TTL_SECONDS, authorizeServeGrant, contractDigest, mintServiceCalloutJwt, parseServiceConnectionBinding,
  parseServiceRegistrationWitness, principalKey, serveIssuanceGateKv, type ServiceConnectionBinding, type ServiceRegistrationWitness,
} from "@cotal-ai/core";
import type { ConnectReader } from "./connect-reader.js";
import { registryStores, type LifecycleRegistry } from "./lifecycle-registry.js";
import { makeNativeIssuanceRecorder } from "./native-issuance.js";
import { readNativeServiceAccess, readNativeServiceGate, type ServiceAssignmentBinding } from "./native-service-gate.js";
import { nativeServiceNameAuthority } from "./native-service-name.js";
import type { ValidatedUserToken } from "./token.js";

export interface NativeServiceCalloutAuthority { readonly space: string; readonly accountPublicKey: string }
interface ServiceCalloutContext { connection: ServiceConnectionBinding; inboxNonce: string; admittedAt: number }
interface ServiceCalloutResult { jwt: string; principal: string; exp: number }
type Issue = (token: ValidatedUserToken, context: ServiceCalloutContext) => Promise<ServiceCalloutResult>;
const authorities = new WeakMap<NativeServiceCalloutAuthority, Issue>();

/** Native host composition only. Assignment lookup and restore/mutation readiness belong to the
 * host; neither callback is a public approval hook. Services receive no registry or signing key.
 */
export function createNativeServiceCalloutAuthority(opts: {
  registry: LifecycleRegistry; reader: () => ConnectReader; dataAccount: { pub: string; signingSeed: string };
  resolveAssignment: (witness: ServiceRegistrationWitness) => Promise<ServiceAssignmentBinding>;
  readClusterArtifact: (digest: string) => unknown | Promise<unknown>; assertOpen: () => void;
}): NativeServiceCalloutAuthority {
  const { registry, reader, resolveAssignment, readClusterArtifact, assertOpen } = opts;
  const dataAccount = { ...opts.dataAccount }, stores = registryStores(registry), space = stores.space;
  const authority: NativeServiceCalloutAuthority = Object.freeze({ space, accountPublicKey: dataAccount.pub });
  const names = nativeServiceNameAuthority(registry, { space, accountPublicKey: dataAccount.pub });
  authorities.set(authority, async (raw, supplied) => {
    const token = structuredClone(raw), connection = parseServiceConnectionBinding(supplied.connection);
    const { inboxNonce, admittedAt } = supplied, expiresAt = Math.min(token.exp, admittedAt + SERVICE_ACCESS_TTL_SECONDS);
    if (!Number.isSafeInteger(admittedAt) || admittedAt <= 0 || admittedAt > Math.floor(Date.now() / 1000)
      || !Number.isSafeInteger(expiresAt) || expiresAt <= Math.floor(Date.now() / 1000))
      throw new Error("service callout requires its original live admission deadline");
    if (token.act.view !== "service-endpoint" || !token.act.service) throw new Error("service callout requires a validated service bearer");
    const witness = parseServiceRegistrationWitness(token.act.service.witness);
    if (witness.accountPublicKey !== dataAccount.pub || witness.space !== space)
      throw new Error("service callout bearer belongs to another native account or space");
    assertOpen();
    const binding = { ...await resolveAssignment(witness) }, bindingDigest = contractDigest(binding);
    if (binding.accountPublicKey !== dataAccount.pub || binding.space !== space)
      throw new Error("service callout assignment belongs to another native account or space");
    await readNativeServiceAccess(registry, reader(), binding, token, expiresAt);
    const serve = await authorizeServeGrant(stores.recordsKv, { space, endpoint: witness.endpoint, instanceId: witness.instanceId,
      epoch: witness.processEpoch, holder: { owner: witness.principal.owner }, authority: names, readClusterArtifact,
      readProcessEpoch: async () => {
        const gate = await readNativeServiceGate(registry, binding);
        if (!gate) throw new Error("service callout has no native gate");
        return gate.row.processEpoch;
      } });
    assertOpen();
    const minted = await mintServiceCalloutJwt({ space, account: dataAccount }, { serve,
      gate: serveIssuanceGateKv(stores.authKv, space, { endpoint: witness.endpoint, instanceId: witness.instanceId }),
      principal: witness.principal, connection, inboxNonce, admittedAt, accessExpiresAt: token.exp, expiresAt });
    const record = makeNativeIssuanceRecorder(registry, async (currentToken) => {
      assertOpen();
      const current = { ...await resolveAssignment(witness) };
      if (contractDigest(current) !== bindingDigest) throw new Error("service assignment changed before callout release");
      await readNativeServiceAccess(registry, reader(), current, currentToken, expiresAt);
      assertOpen();
    });
    await record({ userNkey: connection.userNkey, token, connId: inboxNonce, iat: minted.iat, exp: minted.exp,
      service: { credentialId: minted.credentialId, connection } });
    assertOpen();
    if (expiresAt <= Math.floor(Date.now() / 1000)) throw new Error("service callout expired before response");
    return { jwt: minted.jwt, principal: principalKey(witness.principal.owner, witness.principal.actor).key, exp: expiresAt };
  });
  return authority;
}

/** A structural object cannot opt into native service minting or select another tenant account. */
export function assertNativeServiceCalloutAuthority(authority: NativeServiceCalloutAuthority, space: string, accountPublicKey: string): void {
  if (!authorities.has(authority) || authority.space !== space || authority.accountPublicKey !== accountPublicKey)
    throw new Error("service callout authority is not native or belongs to another account/space");
}

export function issueNativeServiceCallout(authority: NativeServiceCalloutAuthority, token: ValidatedUserToken,
  context: ServiceCalloutContext): Promise<ServiceCalloutResult> {
  const issue = authorities.get(authority);
  if (!issue) throw new Error("service callout authority is not native");
  return issue(token, context);
}
