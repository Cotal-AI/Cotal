import { Kvm, type KV } from "@nats-io/kv";
import type { NatsConnection } from "@nats-io/transport-node";
import {
  DEV_OWNER, EpEnvelopeError, contractArtifactCanonicalBytes, contractDigest, contractStoreContext,
  endpointRegistrationBarrier, epAuthBucket, mintLifecycleUid, provisionEndpointGateOpen,
  publishContractArtifact, reconcileEndpointGate, recordsBucket, registerServiceInstance,
  serveIssuanceGateKv, type ServiceNameAuthority,
} from "@cotal-ai/core";

/** The signing holder authorizes one built-in name for DEV_OWNER; no guest receives this seam. */
export function selfNameAuthority(endpoint: string): ServiceNameAuthority {
  return { authorize: (name, owner) => ({ authorized: name === endpoint && owner === DEV_OWNER, revision: 0 }) };
}

/** Read the exact published contract closure used by a self-authorized registration. */
export function contractArtifactReader(values: unknown[]): (digest: string) => unknown {
  const store = new Map(values.map((v) => [contractDigest(v), v]));
  return (digest) => store.get(digest);
}

/** Register an auth-owned endpoint through the native gate ceremony. Optional recovery uses the
 * native holder-gone guard and retained repair cursor before starting a new registration. */
export async function registerSelfAuthorizedInstance<R extends { registrationRevision: number; processEpoch: number }>(nc: NatsConnection, args: {
  space: string;
  endpoint: string;
  instanceId: string;
  principal: string;
  clusterDigest: string;
  artifacts: unknown[];
  recovery?: Pick<Parameters<typeof reconcileEndpointGate>[0], "probeHolder" | "evictHolders" | "log">;
}, register: (kv: KV, args: Parameters<typeof registerServiceInstance>[1]) => Promise<R>): Promise<R> {
  const { space, endpoint, instanceId } = args;
  const authKv = await new Kvm(nc).open(epAuthBucket(space));
  const recordsKv = await new Kvm(nc).open(recordsBucket(space));
  const storeCtx = await contractStoreContext(nc, space);
  for (const value of args.artifacts) await publishContractArtifact(storeCtx, contractArtifactCanonicalBytes(value));
  const gate = serveIssuanceGateKv(authKv, space, { endpoint, instanceId });
  const prior = await gate.observe();
  if (args.recovery && prior !== null && prior.principal !== args.principal)
    throw new EpEnvelopeError("permission-denied", "the registry's retained identity does not own its registration gate");
  if (prior === null) await provisionEndpointGateOpen(authKv, { endpoint, instanceId, principal: args.principal });
  else if (prior.state === "frozen" && args.recovery)
    await reconcileEndpointGate({ kv: authKv, recordsKv, space, endpoint, instanceId, ...args.recovery });
  const barrier = endpointRegistrationBarrier(authKv, space, {
    endpoint, instanceId, opId: mintLifecycleUid(),
    ...(args.recovery ? { evict: args.recovery.evictHolders } : {}),
  });
  const spec = { endpoint, owner: DEV_OWNER, clusterDigests: [args.clusterDigest], protocol: { v: 1 as const } };
  const registered = await register(recordsKv, {
    space, spec, instanceId, registrant: { owner: DEV_OWNER }, authority: selfNameAuthority(endpoint), barrier,
    readClusterArtifact: contractArtifactReader(args.artifacts),
  });
  const { registrationRevision, processEpoch } = registered;
  const observed = await gate.observe();
  if (observed?.state !== "open" || observed.processEpoch !== processEpoch || observed.registrationRevision !== registrationRevision)
    throw new EpEnvelopeError("conflict", `the issuance gate of ${endpoint}/${instanceId} is no longer open at this registration (process epoch ${processEpoch}, revision ${registrationRevision}); a later barrier fenced this start (SPEC 13.1)`);
  return registered;
}
