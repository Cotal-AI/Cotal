/** Smoke fixtures: register an endpoint instance as an operator does with the space authority, and
 *  run a registry on its own serve and reader credentials. How a space hosts its registry is not
 *  what these exercise. */
import type { NatsConnection } from "@nats-io/transport-node";
import { Kvm, type KV } from "@nats-io/kv";
import {
  DEV_OWNER, SERVICE_READY, VOID_SCHEMA_DIGEST, authorizeServeGrant, contractArtifactCanonicalBytes, contractStoreContext, dialerFor,
  endpointRegistrationBarrier, epAuthBucket, mintCreds, mintLifecycleUid, newIdentity, principalKey, provisionEndpointGateOpen,
  publishContractArtifact, readEndpointGateGeneration, recordsBucket, registerServiceInstance, registryClusterArtifacts,
  registryContractArtifactValues, serveIssuanceGateKv, singleDocumentClosure, standaloneConnectOpts, writeServiceStatus,
  type EpServeGrant, type ServiceNameAuthority, type SpaceAuth,
} from "@cotal-ai/core";
import { natsRegistryReads, serveRegistry } from "../src/index.js";

export interface FixtureMesh {
  auth: SpaceAuth;
  servers: string;
  space: string;
}

const dial = (mesh: FixtureMesh, creds: string): Promise<NatsConnection> =>
  dialerFor(mesh.servers)({ servers: mesh.servers, ...standaloneConnectOpts({ creds, tls: false }) });

/** A cluster document whose commands are untargeted, ephemeral and take no payload. */
export function fixtureCluster(urn: string, names: string[]): unknown {
  return {
    urn, revision: 1, attributes: [], events: [],
    commands: names.map((name) => ({ name, class: "ephemeral", targeted: false, capability: name, inputDigest: VOID_SCHEMA_DIGEST, outputDigest: VOID_SCHEMA_DIGEST })),
  };
}

/** Register one instance of `endpoint` with the space authority, and return its serve grant and
 *  serve credential. */
export async function registerFixture(mesh: FixtureMesh, endpoint: string, document: unknown, extra: unknown[] = []): Promise<{ grant: EpServeGrant; creds: string }> {
  const { auth, space } = mesh;
  const { manifest, closureDigest } = singleDocumentClosure(document);
  const store = new Map<string, unknown>([[closureDigest, manifest], [(manifest as { root: string }).root, document]]);
  const readClusterArtifact = (digest: string): unknown => store.get(digest);
  const authority: ServiceNameAuthority = { authorize: (name, owner) => ({ authorized: name === endpoint && owner === DEV_OWNER, revision: 0 }) };
  const instanceId = mintLifecycleUid();
  const identity = newIdentity();
  const nc = await dial(mesh, await mintCreds(auth, newIdentity(), "endpoint-serve-executor", { endpointServeExecutor: { endpoint, instanceId } }));
  try {
    const kvm = new Kvm(nc);
    const recordsKv: KV = await kvm.open(recordsBucket(space));
    const authKv: KV = await kvm.open(epAuthBucket(space));
    const ctx = await contractStoreContext(nc, space);
    for (const value of [...extra, document, manifest]) await publishContractArtifact(ctx, contractArtifactCanonicalBytes(value));
    await provisionEndpointGateOpen(authKv, { endpoint, instanceId, principal: principalKey(DEV_OWNER, identity.id).key });
    const barrier = endpointRegistrationBarrier(authKv, space, { endpoint, instanceId, opId: mintLifecycleUid() });
    const { registrationRevision } = await registerServiceInstance(recordsKv, {
      space, spec: { endpoint, owner: DEV_OWNER, clusterDigests: [closureDigest], protocol: { v: 1 } }, instanceId, registrant: { owner: DEV_OWNER },
      authority, barrier, readClusterArtifact, observeHolderGeneration: (holder) => readEndpointGateGeneration(authKv, { endpoint, instanceId: holder }),
    });
    const fence = serveIssuanceGateKv(authKv, space, { endpoint, instanceId });
    const readProcessEpoch = async () => (await fence.observe())!.processEpoch;
    const epoch = await readProcessEpoch();
    const grant = await authorizeServeGrant(recordsKv, { space, endpoint, instanceId, epoch, holder: { owner: DEV_OWNER }, authority, readClusterArtifact, readProcessEpoch });
    await writeServiceStatus(recordsKv, { endpoint, instanceId, epoch, status: { state: SERVICE_READY, epoch, observedSpecRevision: registrationRevision }, readProcessEpoch });
    return { grant, creds: await mintCreds(auth, identity, "endpoint-serve", { serveIssuance: fence, endpointServe: grant }) };
  } finally {
    await nc.drain().catch(() => nc.close());
  }
}

/** Register and serve a registry: its serve connection on the registered grant, its reads on a
 *  `registry-reader` credential. */
export async function runRegistryFixture(mesh: FixtureMesh): Promise<{ stop(): Promise<void> }> {
  const { grant, creds } = await registerFixture(mesh, "registry", registryClusterArtifacts().document, registryContractArtifactValues());
  const reader = await dial(mesh, await mintCreds(mesh.auth, newIdentity(), "registry-reader"));
  const serving = await dial(mesh, creds);
  const handle = serveRegistry(serving, grant, { space: mesh.space, mode: "authed", reads: await natsRegistryReads(reader, mesh.space) });
  return {
    async stop() {
      await handle.stop();
      for (const nc of [serving, reader]) await nc.close().catch(() => {});
    },
  };
}
