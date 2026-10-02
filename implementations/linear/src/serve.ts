/**
 * Serving one Linear account as a registered Cotal endpoint.
 *
 * Two layers. {@link runLinearEndpoint} is the generic runner: it takes an already-authorized,
 * scoped serve bundle (the `authorizeServeGrant` artifact plus a serve credential source) and serves
 * the fixed Linear contract on it. A hosted embedder that issues serve credentials its own way uses
 * it directly. {@link registerLinearEndpoint} is the local operator setup for a static-auth mesh: it
 * walks the same registration path every ordinary endpoint walks (contract-store publish, issuance
 * gate, registration barrier, serve grant, ready status, fenced `endpoint-serve` mint) over one-shot
 * `endpoint-serve-executor` connections, and keeps the space signer inside the operator process for
 * renewal. The signer is never returned, logged, or passed to the runner.
 *
 * The endpoint name comes from operator configuration and must be a reverse-DNS name in a namespace
 * the operator owns. The name authority authorizes exactly that name for the local owner, nothing
 * else. A per-user-auth mesh is refused: its serve credentials come from the remote issuer, which
 * this package has no client for.
 */
import { credsAuthenticator, type NatsConnection } from "@nats-io/transport-node";
import { Kvm, type KV } from "@nats-io/kv";
import {
  authorizeServeGrant,
  contractArtifactCanonicalBytes,
  contractStoreContext,
  CotalEndpoint,
  deregisterServiceInstance,
  DEV_OWNER,
  dialerFor,
  endpointRegistrationBarrier,
  epAuthBucket,
  inspectCredHealth,
  mintCreds,
  mintLifecycleUid,
  newIdentity,
  principalKey,
  provisionAgent,
  provisionEndpointGateOpen,
  publishContractArtifact,
  readEndpointGateGeneration,
  recordsBucket,
  registerServiceInstance,
  serveEndpoint,
  serveIssuanceGateKv,
  SERVICE_READY,
  standaloneConnectOpts,
  writeServiceStatus,
  type EpCapability,
  type EpServeGrant,
  type EpServeHandle,
  type Identity,
  type ServiceNameAuthority,
  type SpaceAuth,
} from "@cotal-ai/core";
import { linearClusterArtifacts, linearCommandDefs, linearContractArtifactValues, LINEAR_COMMANDS } from "./contract.js";
import type { LinearUpstream } from "./upstream.js";

/** A reverse-DNS endpoint name: at least two lowercase labels, as the operator configured it. */
export function assertLinearEndpointName(name: string): string {
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(name) || name.length > 200)
    throw new Error(`"${name}" is not a reverse-DNS endpoint name (for example com.example.linear); use a namespace you own`);
  return name;
}

/** An authorized, scoped serve bundle. `creds` returns the CURRENT serve credential and is read on
 *  every (re)connect, so a renewed credential is adopted without re-registering. */
export interface LinearServeBundle {
  servers: string;
  space: string;
  tls: boolean;
  identity: Identity;
  grant: EpServeGrant;
  creds: () => string;
}

export interface LinearEndpointHandle {
  readonly endpoint: string;
  readonly instanceId: string;
  readonly epoch: number;
  /** Stop serving, then close the upstream session, each within `graceMs`. */
  stop(graceMs?: number): Promise<void>;
  /** Resolves when the serve connection closes for good. */
  closed: Promise<Error | undefined>;
}

function within<T>(p: Promise<T>, ms: number): Promise<T | undefined> {
  return Promise.race([p, new Promise<undefined>((r) => setTimeout(() => r(undefined), ms).unref())]);
}

/** Serve the fixed Linear contract on an authorized bundle. Command names, schemas and the
 *  `linear.mcp` capability are fixed; the upstream result is returned as data and never parsed. */
export async function runLinearEndpoint(bundle: LinearServeBundle, upstream: LinearUpstream): Promise<LinearEndpointHandle> {
  const enc = new TextEncoder();
  const nc: NatsConnection = await dialerFor(bundle.servers)({
    servers: bundle.servers,
    ...(bundle.tls ? { tls: {} } : {}),
    authenticator: (nonce?: string) => credsAuthenticator(enc.encode(bundle.creds()))(nonce),
    inboxPrefix: `_INBOX_${bundle.identity.id}`,
    maxReconnectAttempts: -1,
  });
  let handle: EpServeHandle;
  try {
    handle = serveEndpoint(nc, bundle.space, bundle.grant, linearCommandDefs(upstream), { public: true });
  } catch (e) {
    await nc.drain().catch(() => nc.close());
    throw e;
  }
  return {
    endpoint: bundle.grant.endpoint,
    instanceId: bundle.grant.instanceId,
    epoch: bundle.grant.epoch,
    closed: nc.closed().then((e) => e ?? undefined),
    async stop(graceMs = 10_000) {
      await within(handle.stop(), graceMs);
      await within(nc.drain().catch(() => nc.close()), graceMs);
      if (!nc.isClosed()) await nc.close().catch(() => {});
      await upstream.close(graceMs);
    },
  };
}

export interface LinearRegistration {
  bundle: LinearServeBundle;
  /** Re-mint the serve credential through the same fenced issuance. */
  renew(): Promise<string>;
  /** Remove this instance's service record. The issuance gate stays, as for every endpoint. */
  deregister(): Promise<void>;
}

/**
 * Register `endpoint` as a fresh instance on a static-auth mesh and mint its serve credential.
 * `auth` is the operator's own space authority; it stays in this closure for renewal and
 * deregistration and is never placed in the returned bundle.
 */
export async function registerLinearEndpoint(opts: {
  auth: SpaceAuth;
  servers: string;
  space: string;
  tls: boolean;
  endpoint: string;
}): Promise<LinearRegistration> {
  const { auth, servers, space, tls } = opts;
  if (auth.space !== space) throw new Error(`the space authority is for "${auth.space}", not "${space}"`);
  const endpoint = assertLinearEndpointName(opts.endpoint);
  const instanceId = mintLifecycleUid();
  const opId = mintLifecycleUid();
  const identity = newIdentity();
  const artifacts = linearClusterArtifacts();
  const store = new Map<string, unknown>([[artifacts.rootDigest, artifacts.document], [artifacts.closureDigest, artifacts.manifest]]);
  const readClusterArtifact = (digest: string): unknown => store.get(digest);
  // Operator configuration is the trusted source: this name, for the local owner, and nothing else.
  const authority: ServiceNameAuthority = {
    authorize: (name, owner) => ({ authorized: name === endpoint && owner === DEV_OWNER, revision: 0 }),
  };

  const withExecutor = async <T>(fn: (kv: { recordsKv: KV; authKv: KV; nc: NatsConnection }) => Promise<T>): Promise<T> => {
    const creds = await mintCreds(auth, newIdentity(), "endpoint-serve-executor", { endpointServeExecutor: { endpoint, instanceId } });
    const nc = await dialerFor(servers)({ servers, ...standaloneConnectOpts({ creds, tls }), maxReconnectAttempts: 0 });
    try {
      const kvm = new Kvm(nc);
      return await fn({ recordsKv: await kvm.open(recordsBucket(space)), authKv: await kvm.open(epAuthBucket(space)), nc });
    } finally {
      await nc.drain().catch(() => nc.close());
    }
  };
  const fenceOf = (authKv: KV) => serveIssuanceGateKv(authKv, space, { endpoint, instanceId });
  const epochOf = (authKv: KV) => async (): Promise<number> => {
    const g = await fenceOf(authKv).observe();
    if (g === null) throw new Error(`no issuance gate for ${endpoint}/${instanceId}`);
    return g.processEpoch;
  };

  const { grant, creds: first } = await withExecutor(async ({ recordsKv, authKv, nc }) => {
    const storeCtx = await contractStoreContext(nc, space);
    for (const value of [...linearContractArtifactValues(), artifacts.document, artifacts.manifest])
      await publishContractArtifact(storeCtx, contractArtifactCanonicalBytes(value));
    await provisionEndpointGateOpen(authKv, { endpoint, instanceId, principal: principalKey(DEV_OWNER, identity.id).key });
    // A fresh instance has an empty credential family, so the barrier has nothing to evict.
    const barrier = endpointRegistrationBarrier(authKv, space, { endpoint, instanceId, opId });
    const spec = { endpoint, owner: DEV_OWNER, clusterDigests: [artifacts.closureDigest], protocol: { v: 1 as const } };
    const { registrationRevision } = await registerServiceInstance(recordsKv, {
      space, spec, instanceId, registrant: { owner: DEV_OWNER }, authority, barrier, readClusterArtifact,
      observeHolderGeneration: (holder) => readEndpointGateGeneration(authKv, { endpoint, instanceId: holder }),
    });
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
    const creds = await mintCreds(auth, identity, "endpoint-serve", { serveIssuance: fence, endpointServe: grant });
    return { grant, creds };
  });

  let current = first;
  const renew = async (): Promise<string> => {
    current = await withExecutor(({ authKv }) => mintCreds(auth, identity, "endpoint-serve", { serveIssuance: fenceOf(authKv), endpointServe: grant }));
    return current;
  };
  const deregister = async (): Promise<void> => {
    await withExecutor(async ({ recordsKv, authKv }) => {
      await deregisterServiceInstance(recordsKv, { endpoint, instanceId, observeGeneration: () => readEndpointGateGeneration(authKv, { endpoint, instanceId }) });
    });
  };
  return { bundle: { servers, space, tls, identity, grant, creds: () => current }, renew, deregister };
}

/** Milliseconds until a credential reaches 75% of its remaining lifetime, or undefined when it is
 *  unbounded. */
export function renewalDelayMs(creds: string, nowMs = Date.now()): number | undefined {
  const exp = inspectCredHealth(creds).exp;
  if (exp === undefined) return undefined;
  return Math.max(1_000, Math.floor((exp * 1000 - nowMs) * 0.75));
}

/** The caller rows for every Linear command on `endpoint`: what a least-privilege caller
 *  credential carries, and nothing more. */
export function linearCallerCapabilities(endpoint: string): EpCapability[] {
  assertLinearEndpointName(endpoint);
  return LINEAR_COMMANDS.map((command) => ({ endpoint, command }));
}

/**
 * Provision and mint a standalone caller for a static-auth mesh: the ordinary `agent` profile, its
 * lifecycle-keyed mailboxes, and the exact request rows for the Linear commands on `endpoint`. It
 * carries no spawn, run, admin or provisioner capability. The caller is an isolated, hand-launched
 * seat the operator starts with this credential and lifecycle UID; managed spawns still refuse
 * endpoint capabilities in static mode, which this does not change. The provisioner connection is
 * minted for this call and stopped before it returns.
 */
export async function provisionLinearCaller(
  auth: SpaceAuth,
  target: { servers: string; space: string; tls: boolean },
  endpoint: string,
  opts: { channels?: string[]; expiresInSeconds?: number } = {},
): Promise<{ creds: string; identity: string; lifecycleUid: string }> {
  if (auth.space !== target.space) throw new Error(`the space authority is for "${auth.space}", not "${target.space}"`);
  const identity = newIdentity();
  const lifecycleUid = mintLifecycleUid();
  const channels = opts.channels ?? [];
  const prov = new CotalEndpoint({
    space: target.space,
    servers: target.servers,
    tls: target.tls,
    creds: await mintCreds(auth, newIdentity(), "provisioner"),
    channels: [],
    consume: false,
    registerPresence: false,
    watchPresence: false,
    watchChannels: false,
    card: { name: "linear-caller-provisioner", role: "provisioner", kind: "endpoint" },
  });
  prov.on("error", () => {});
  try {
    await prov.start();
    const creds = await provisionAgent(prov, auth, identity, {
      lifecycleUid,
      endpointCapabilities: linearCallerCapabilities(endpoint),
      allowSubscribe: channels,
      allowPublish: channels,
      subscribe: channels,
      ...(opts.expiresInSeconds !== undefined ? { expiresInSeconds: opts.expiresInSeconds } : {}),
    });
    return { creds, identity: identity.id, lifecycleUid };
  } finally {
    await prov.stop().catch(() => {});
  }
}
