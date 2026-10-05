import { jetstreamManager } from "@nats-io/jetstream";
import { Kvm } from "@nats-io/kv";
import {
  contractArtifactCanonicalBytes,
  contractRefToHex,
  contractStoreContext,
  dialerFor,
  endpointRegistrationBarrier,
  epAuthBucket,
  fetchContractArtifact,
  foreignSlotHeldFrom,
  provisionEndpointGateOpen,
  publishContractArtifact,
  readEndpointGateGeneration,
  recordsBucket,
  registerServingInstance,
  serveIssuanceGateKv,
  standaloneConnectOpts,
  type EpServeGrant,
  type RemoteManagerAuthorityMaterial,
} from "@cotal-ai/core";
import { MANAGER_ENDPOINT, managerAuthorityContractSource, managerClusterArtifacts } from "./manager-service-contract.js";

/**
 * Run the registration half with the host-issued prepare credential. The credential is pinned to
 * one manager instance's epgate/epcred/svc/govern/contract surface, so the participant can neither
 * register another endpoint nor publish outside the public content-addressed contract store.
 */
export async function registerRemoteManagerAuthority(args: {
  space: string;
  server: string;
  owner: string;
  instanceId: string;
  serveActor: string;
  prepareCreds: string;
  /** Whether the registered broker REQUIRES TLS, carried from the mesh record rather than decided
   *  here. A participant reaches its host through whatever the record says, so this can be a
   *  `wss://` edge; hardcoding `false` would send the prepare credential to it in the clear. */
  tlsRequired: boolean;
  evict: (principal: string) => Promise<boolean>;
  /** Host-side guarded repair for a foreign manager slot holder, used once before a retry. */
  reconcileForeignRegistration?: (instanceId: string) => Promise<void>;
}): Promise<{ registrationRevision: number; processEpoch: number; serveGrant: EpServeGrant }> {
  // The transport follows the RECORDED URL: a remote broker is commonly published through an HTTPS
  // edge, and the raw node transport refuses `ws://`/`wss://` outright instead of dialing it.
  const nc = await dialerFor(args.server)({
    servers: args.server,
    ...standaloneConnectOpts({ creds: args.prepareCreds, tls: args.tlsRequired }),
    maxReconnectAttempts: 0,
  });
  try {
    const kvm = new Kvm(nc);
    const recordsKv = await kvm.open(recordsBucket(args.space));
    const authKv = await kvm.open(epAuthBucket(args.space));
    const store = await contractStoreContext(nc, args.space);
    const artifacts = managerClusterArtifacts();
    const all = [...managerAuthorityContractSource().artifacts, artifacts.document, artifacts.manifest];
    for (const value of all) await publishContractArtifact(store, contractArtifactCanonicalBytes(value));
    const readClusterArtifact = async (digest: string): Promise<unknown> => {
      // `clusterDigests` rows are `sha256:<hex>` references; the store is keyed by the BARE hex.
      const bytes = await fetchContractArtifact(store, contractRefToHex(digest));
      return bytes ? JSON.parse(new TextDecoder().decode(bytes)) : undefined;
    };
    const principal = `${args.owner}.${args.serveActor}`;
    if ((await serveIssuanceGateKv(authKv, args.space, { endpoint: MANAGER_ENDPOINT, instanceId: args.instanceId }).observe()) === null)
      await provisionEndpointGateOpen(authKv, { endpoint: MANAGER_ENDPOINT, instanceId: args.instanceId, principal });
    const authority = { authorize: (endpoint: string, owner: string) => ({ authorized: endpoint === MANAGER_ENDPOINT && owner === args.owner, revision: 0 }) };
    const barrier = endpointRegistrationBarrier(authKv, args.space, {
      endpoint: MANAGER_ENDPOINT,
      instanceId: args.instanceId,
      opId: args.instanceId,
      // The host's maintenance verb evicts one principal per call, so each evict call carries one
      // holder and registration records its verdict before the host is asked about the next.
      evictMax: 1,
      evict: async (principals) => {
        const gone: boolean[] = [];
        for (const principal of principals) gone.push(await args.evict(principal));
        return gone;
      },
    });
    const register = () => registerServingInstance(recordsKv, {
      space: args.space,
      spec: { endpoint: MANAGER_ENDPOINT, owner: args.owner, clusterDigests: [artifacts.closureDigest], protocol: { v: 1 } },
      instanceId: args.instanceId,
      registrant: { owner: args.owner },
      authority,
      barrier,
      readClusterArtifact,
      // #1393: same seam the local registration wires — a foreign slot is reclaimed only when that
      // holder's own gate has provably reopened past the slot's stamp, over this connection's
      // existing auth-bucket read grant.
      observeHolderGeneration: (holderInstanceId) =>
        readEndpointGateGeneration(authKv, { endpoint: MANAGER_ENDPOINT, instanceId: holderInstanceId }),
    });
    let registered: Awaited<ReturnType<typeof register>>;
    try {
      registered = await register();
    } catch (error) {
      // Only a holder whose gate is still at the slot's stamp left a frozen registration the host
      // can reconcile; every other refusal is about this registrant's view of that gate.
      const held = foreignSlotHeldFrom(error);
      if (held?.condition !== "in-flight" || !args.reconcileForeignRegistration) throw error;
      await args.reconcileForeignRegistration(held.holderInstanceId);
      registered = await register();
    }
    const { registrationRevision, processEpoch, grant } = registered;
    return { registrationRevision, processEpoch, serveGrant: grant };
  } finally {
    await nc.drain().catch(() => nc.close());
  }
}
