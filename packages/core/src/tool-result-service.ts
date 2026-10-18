/**
 * Registering one managed agent's `tool-results` serving instance on a static-auth mesh, and the
 * cluster artifacts that registration publishes (SPEC 13.6, "Private tool results").
 *
 * The launcher (the manager, which holds the space authority) calls
 * {@link registerToolResultServing} at spawn. It walks the ordinary registration path every endpoint
 * walks: contract-store publish, issuance gate, registration barrier, `registerServiceInstance`,
 * `authorizeServeGrant`, ready status and a fenced `endpoint-serve` mint, over one-shot
 * `endpoint-serve-executor` connections. The serving instance id IS the agent's lifecycle UID, so a
 * holder's redeemed rows (`toolResultRedemptionRows`) bind exactly this incarnation, and the
 * credential is minted for the agent's OWN identity, bounded by `expiresAt`. The space authority
 * never leaves the caller. Every command is `handle`-only, so no caller can reach it untargeted or
 * in any other mode.
 *
 * A user-mode mesh has no local space authority; its serve issuance would come from the remote
 * issuer, which does not issue this yet, so the manager refuses there instead of calling this.
 */
import { Kvm, type KV } from "@nats-io/kv";
import type { NatsConnection } from "@nats-io/transport-node";
import { contractDigest } from "./canonical.js";
import { contractArtifactCanonicalBytes, contractStoreContext, publishContractArtifact } from "./endpoint-contract-store.js";
import { epAuthBucket } from "./endpoint-binding.js";
import { recordsBucket } from "./endpoint-records.js";
import { endpointRegistrationBarrier, provisionEndpointGateOpen, readEndpointGateGeneration, serveIssuanceGateKv } from "./endpoint-serve-kv.js";
import { authorizeServeGrant, deregisterServiceInstance, registerServiceInstance, SERVICE_READY, writeServiceStatus, type EpServeGrant, type ServiceDeregistration, type ServiceNameAuthority } from "./endpoint-service.js";
import { dialerFor } from "./endpoint.js";
import { newIdentity, type Identity } from "./identity.js";
import { mintCreds, type SpaceAuth } from "./provision.js";
import { serviceContractTable } from "./schema-profile.js";
import { standaloneConnectOpts } from "./streams.js";
import { DEV_OWNER, mintLifecycleUid, principalKey } from "./subjects.js";
import { TOOL_RESULT_COMMANDS, TOOL_RESULT_CONTRACTS, TOOL_RESULT_ENDPOINT } from "./tool-result-contract.js";

/** The capability every tool-result command declares. */
export const TOOL_RESULT_CAPABILITY = "tool-results";
const TOOL_RESULT_CLUSTER_URN = "urn:cotal:tool-results";

const ROWS = TOOL_RESULT_COMMANDS.map((name) => ({ name, input: TOOL_RESULT_CONTRACTS[name].input, output: TOOL_RESULT_CONTRACTS[name].output }));
const closureDigestOf = (root: unknown): string => contractDigest({ v: 1, root: contractDigest(root), members: [] });

/** Every contract artifact the registration publishes: each distinct schema root and its manifest. */
export const toolResultContractArtifactValues = (): unknown[] => serviceContractTable(ROWS).artifactValues();

/** The registered cluster: the three commands, ephemeral, targeted, `handle` mode ONLY. */
export function toolResultClusterArtifacts() {
  const document = {
    urn: TOOL_RESULT_CLUSTER_URN,
    revision: 1,
    attributes: [] as unknown[],
    events: [] as unknown[],
    commands: ROWS.map((r) => ({
      name: r.name,
      class: "ephemeral" as const,
      targeted: true,
      modes: ["handle" as const],
      capability: TOOL_RESULT_CAPABILITY,
      inputDigest: closureDigestOf(r.input),
      outputDigest: closureDigestOf(r.output),
    })),
  };
  const rootDigest = contractDigest(document);
  const manifest = { v: 1 as const, root: rootDigest, members: [] as string[] };
  return { document, rootDigest, manifest, closureDigest: contractDigest(manifest) };
}

interface ServingTarget {
  auth: SpaceAuth;
  servers: string;
  space: string;
  tls: boolean;
  /** The agent incarnation; also the serving instance id. */
  lifecycleUid: string;
}

/** Run `fn` over a one-shot `endpoint-serve-executor` connection scoped to this one instance. */
async function withExecutor<T>(t: ServingTarget, fn: (kv: { recordsKv: KV; authKv: KV; nc: NatsConnection }) => Promise<T>): Promise<T> {
  if (t.auth.space !== t.space) throw new Error(`the space authority is for "${t.auth.space}", not "${t.space}"`);
  const creds = await mintCreds(t.auth, newIdentity(), "endpoint-serve-executor", { endpointServeExecutor: { endpoint: TOOL_RESULT_ENDPOINT, instanceId: t.lifecycleUid } });
  const nc = await dialerFor(t.servers)({ servers: t.servers, ...standaloneConnectOpts({ creds, tls: t.tls }), maxReconnectAttempts: 0 });
  try {
    const kvm = new Kvm(nc);
    return await fn({ recordsKv: await kvm.open(recordsBucket(t.space)), authKv: await kvm.open(epAuthBucket(t.space)), nc });
  } finally {
    await nc.drain().catch(() => nc.close());
  }
}

/** Take one incarnation's `tool-results` record down. An absent record is reported as such, not
 *  an error, so a retirement that never registered (or already deregistered) completes. */
export async function deregisterToolResultServing(t: ServingTarget): Promise<ServiceDeregistration> {
  return withExecutor(t, async ({ recordsKv, authKv }) =>
    deregisterServiceInstance(recordsKv, { endpoint: TOOL_RESULT_ENDPOINT, instanceId: t.lifecycleUid, observeGeneration: () => readEndpointGateGeneration(authKv, { endpoint: TOOL_RESULT_ENDPOINT, instanceId: t.lifecycleUid }) }));
}

/** What the launcher hands the agent (through its 0600 launch material) and keeps for teardown. */
export interface ToolResultServing {
  /** The serve grant `serveEndpoint` verifies; carries no secret. */
  grant: EpServeGrant;
  /** The agent's own `endpoint-serve` credential, bounded by `expiresAt`. A secret. */
  creds: string;
}

export async function registerToolResultServing(opts: ServingTarget & {
  /** The agent's own identity: the credential is minted for it, nobody else. */
  identity: Identity;
  /** Unix seconds; the serve credential's expiry. */
  expiresAt: number;
}): Promise<ToolResultServing> {
  const { auth, space, identity, lifecycleUid: instanceId } = opts;
  const endpoint = TOOL_RESULT_ENDPOINT;
  const opId = mintLifecycleUid();
  const artifacts = toolResultClusterArtifacts();
  const store = new Map<string, unknown>([[artifacts.rootDigest, artifacts.document], [artifacts.closureDigest, artifacts.manifest]]);
  const readClusterArtifact = (digest: string): unknown => store.get(digest);
  // The single-label core name, for the local operator owner, and nothing else.
  const authority: ServiceNameAuthority = { authorize: (name, owner) => ({ authorized: name === endpoint && owner === DEV_OWNER, revision: 0 }) };

  const fenceOf = (authKv: KV) => serveIssuanceGateKv(authKv, space, { endpoint, instanceId });
  const epochOf = (authKv: KV) => async (): Promise<number> => {
    const g = await fenceOf(authKv).observe();
    if (g === null) throw new Error(`no issuance gate for ${endpoint}/${instanceId}`);
    return g.processEpoch;
  };
  return withExecutor(opts, async ({ recordsKv, authKv, nc }) => {
    const storeCtx = await contractStoreContext(nc, space);
    for (const value of [...toolResultContractArtifactValues(), artifacts.document, artifacts.manifest])
      await publishContractArtifact(storeCtx, contractArtifactCanonicalBytes(value));
    await provisionEndpointGateOpen(authKv, { endpoint, instanceId, principal: principalKey(DEV_OWNER, identity.id).key });
    // A fresh incarnation has an empty credential family, so the barrier has nothing to evict.
    const barrier = endpointRegistrationBarrier(authKv, space, { endpoint, instanceId, opId });
    const spec = { endpoint, owner: DEV_OWNER, clusterDigests: [artifacts.closureDigest], protocol: { v: 1 as const } };
    const { registrationRevision } = await registerServiceInstance(recordsKv, {
      space, spec, instanceId, registrant: { owner: DEV_OWNER }, authority, barrier, readClusterArtifact,
      observeHolderGeneration: (holder) => readEndpointGateGeneration(authKv, { endpoint, instanceId: holder }),
    });
    // From here the record exists; any later failure takes it back down before reporting.
    try {
      const fence = fenceOf(authKv);
      const observed = await fence.observe();
      if (observed === null) throw new Error(`the issuance gate for ${endpoint}/${instanceId} vanished after registration`);
      const grant = await authorizeServeGrant(recordsKv, {
        space, endpoint, instanceId, epoch: observed.processEpoch, holder: { owner: DEV_OWNER }, authority, readClusterArtifact,
        readProcessEpoch: epochOf(authKv),
      });
      await writeServiceStatus(recordsKv, {
        endpoint, instanceId, epoch: observed.processEpoch,
        status: { state: SERVICE_READY, epoch: observed.processEpoch, observedSpecRevision: registrationRevision },
        readProcessEpoch: epochOf(authKv),
      });
      const creds = await mintCreds(auth, identity, "endpoint-serve", { serveIssuance: fence, endpointServe: grant, expiresAt: opts.expiresAt });
      return { grant, creds };
    } catch (e) {
      const why = (e as Error).message;
      try {
        await deregisterServiceInstance(recordsKv, { endpoint, instanceId, observeGeneration: () => readEndpointGateGeneration(authKv, { endpoint, instanceId }) });
      } catch (d) {
        throw new Error(`${why}; the tool-results record for ${instanceId} could not be removed afterwards (${(d as Error).message}) and still advertises an instance nobody serves`);
      }
      throw new Error(`${why}; the tool-results record for ${instanceId} was removed again`);
    }
  });
}
