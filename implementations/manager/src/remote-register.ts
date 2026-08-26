import { connect } from "@nats-io/transport-node";
import { jetstreamManager } from "@nats-io/jetstream";
import { Kvm } from "@nats-io/kv";
import {
  authorizeServeGrant,
  contractArtifactCanonicalBytes,
  contractStoreContext,
  endpointRegistrationBarrier,
  epAuthBucket,
  fetchContractArtifact,
  provisionEndpointGateOpen,
  publishContractArtifact,
  recordsBucket,
  registerServiceInstance,
  serveIssuanceGateKv,
  standaloneConnectOpts,
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
}): Promise<{ registrationRevision: number; processEpoch: number; serveGrant: Awaited<ReturnType<typeof authorizeServeGrant>> }> {
  const nc = await connect({
    servers: args.server,
    ...standaloneConnectOpts({ creds: args.prepareCreds, tls: false }),
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
      const bytes = await fetchContractArtifact(store, digest);
      return bytes ? JSON.parse(new TextDecoder().decode(bytes)) : undefined;
    };
    const principal = `${args.owner}.${args.serveActor}`;
    const fence = serveIssuanceGateKv(authKv, args.space, { endpoint: MANAGER_ENDPOINT, instanceId: args.instanceId });
    if ((await fence.observe()) === null)
      await provisionEndpointGateOpen(authKv, { endpoint: MANAGER_ENDPOINT, instanceId: args.instanceId, principal });
    const authority = { authorize: (endpoint: string, owner: string) => ({ authorized: endpoint === MANAGER_ENDPOINT && owner === args.owner, revision: 0 }) };
    const barrier = endpointRegistrationBarrier(authKv, args.space, {
      endpoint: MANAGER_ENDPOINT,
      instanceId: args.instanceId,
      opId: args.instanceId,
    });
    await registerServiceInstance(recordsKv, {
      space: args.space,
      spec: { endpoint: MANAGER_ENDPOINT, owner: args.owner, clusterDigests: [artifacts.closureDigest], protocol: { v: 1 } },
      instanceId: args.instanceId,
      registrant: { owner: args.owner },
      authority,
      barrier,
      readClusterArtifact,
    });
    const observed = await fence.observe();
    if (observed === null) throw new Error("remote manager issuance gate vanished after registration");
    const serveGrant = await authorizeServeGrant(recordsKv, {
      space: args.space,
      endpoint: MANAGER_ENDPOINT,
      instanceId: args.instanceId,
      epoch: observed.processEpoch,
      holder: { owner: args.owner },
      authority,
      readProcessEpoch: async () => {
        const current = await fence.observe();
        if (!current) throw new Error("remote manager issuance gate vanished");
        return current.processEpoch;
      },
      readClusterArtifact,
    });
    return { registrationRevision: observed.registrationRevision, processEpoch: observed.processEpoch, serveGrant };
  } finally {
    await nc.drain().catch(() => nc.close());
  }
}
