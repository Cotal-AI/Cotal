import { Kvm, type KV } from "@nats-io/kv";
import { credsAuthenticator, type NatsConnection } from "@nats-io/transport-node";
import {
  CONTRACT_ARTIFACT_MAX_BYTES, CONTRACT_CLOSURE_MAX_ARTIFACTS, DEV_OWNER, SERVICE_READY,
  authorizeServeGrant, buildContractClosureManifest, contractArtifactCanonicalBytes,
  contractDigest, contractStoreContext, deregisterServiceInstance, dialerFor,
  endpointRegistrationBarrier, epAuthBucket, inspectCredHealth, mintCreds, mintLifecycleUid,
  newIdentity, principalKey, provisionEndpointGateOpen,
  publishContractArtifact, readEndpointGateGeneration, recordsBucket, registerServiceInstance,
  requireBrokerFloor, serveIssuanceGateKv, standaloneConnectOpts, writeServiceStatus,
  type EpServeGrant, type ServiceNameAuthority, type SpaceAuth,
} from "@cotal-ai/core";
import { CommandFailure } from "@cotal-ai/workspace";
import type { ExecEndpointInput } from "./definition.js";

/** Keep signing and executor authority in the host, outside every handler's environment and stdin. */
export class ExecEndpointRegistration {
  readonly instanceId = mintLifecycleUid();
  private readonly identity = newIdentity();
  private readonly opId = mintLifecycleUid();
  private readonly artifacts = new Map<string, unknown>();
  private readonly authority: ServiceNameAuthority;
  private registrationRevision: number | undefined;
  private currentCreds: string | undefined;
  private authorized: EpServeGrant | undefined;

  constructor(private readonly input: ExecEndpointInput, private readonly auth: SpaceAuth) {
    const add = (value: unknown) => {
      if (contractArtifactCanonicalBytes(value).length > CONTRACT_ARTIFACT_MAX_BYTES) throw new CommandFailure("refused", "SCHEMA_INVALID", "an executable contract artifact exceeds the native publication bound; no registration was submitted");
      this.artifacts.set(contractDigest(value), value);
    };
    for (const command of input.contract.source.cluster.commands) for (const bundle of [command.input, command.output]) {
      add(bundle.root);
      for (const value of Object.values(bundle.members ?? {})) add(value);
      add(buildContractClosureManifest(contractDigest(bundle.root), Object.keys(bundle.members ?? {})));
    }
    add(input.contract.document); add(input.contract.manifest);
    if (this.artifacts.size > CONTRACT_CLOSURE_MAX_ARTIFACTS) throw new CommandFailure("refused", "SCHEMA_INVALID", "the executable contract exceeds the native artifact-count bound; no registration was submitted");
    this.authority = { authorize: (name, owner) => ({ authorized: name === input.contract.source.endpoint && owner === DEV_OWNER, revision: 0 }) };
  }

  coordinates() { return { endpoint: this.input.contract.source.endpoint, instanceId: this.instanceId, owner: DEV_OWNER, actor: this.identity.id }; }

  get grant(): EpServeGrant {
    if (!this.authorized) throw new Error("no authorized executable serve grant");
    return this.authorized;
  }

  private fence(authKv: KV) { return serveIssuanceGateKv(authKv, this.input.target.space, { endpoint: this.input.contract.source.endpoint, instanceId: this.instanceId }); }

  private async executor<T>(run: (value: { recordsKv: KV; authKv: KV; nc: NatsConnection }) => Promise<T>): Promise<T> {
    const target = this.input.target, identity = newIdentity();
    const creds = await mintCreds(this.auth, identity, "endpoint-serve-executor", { endpointServeExecutor: { endpoint: this.input.contract.source.endpoint, instanceId: this.instanceId } });
    const nc = await dialerFor(target.server)({ servers: target.server, ...standaloneConnectOpts({ creds, tls: target.tlsRequired }), inboxPrefix: `_INBOX_${identity.id}`, reconnect: false, maxReconnectAttempts: 0 });
    try {
      requireBrokerFloor(nc);
      const kvm = new Kvm(nc);
      return await run({ recordsKv: await kvm.open(recordsBucket(target.space)), authKv: await kvm.open(epAuthBucket(target.space)), nc });
    } finally { await nc.close(); }
  }

  async register(): Promise<void> {
    await this.executor(async ({ recordsKv, authKv, nc }) => {
      const { space } = this.input.target, endpoint = this.input.contract.source.endpoint;
      const store = await contractStoreContext(nc, space);
      for (const value of this.artifacts.values()) await publishContractArtifact(store, contractArtifactCanonicalBytes(value));
      await provisionEndpointGateOpen(authKv, { endpoint, instanceId: this.instanceId, principal: principalKey(DEV_OWNER, this.identity.id).key });
      const barrier = endpointRegistrationBarrier(authKv, space, { endpoint, instanceId: this.instanceId, opId: this.opId });
      const registered = await registerServiceInstance(recordsKv, {
        space, spec: { endpoint, owner: DEV_OWNER, clusterDigests: [this.input.contract.closureDigest], protocol: { v: 1 } },
        instanceId: this.instanceId, registrant: { owner: DEV_OWNER }, authority: this.authority, barrier,
        readClusterArtifact: (digest) => this.artifacts.get(digest),
        observeHolderGeneration: (holder) => readEndpointGateGeneration(authKv, { endpoint, instanceId: holder }),
      });
      this.registrationRevision = registered.registrationRevision;
      const grant = await authorizeServeGrant(recordsKv, {
        space, endpoint, instanceId: this.instanceId, epoch: registered.processEpoch, holder: { owner: DEV_OWNER }, authority: this.authority,
        readClusterArtifact: (digest) => this.artifacts.get(digest),
        readProcessEpoch: async () => {
          const gate = await this.fence(authKv).observe();
          if (!gate) throw new Error("executable issuance gate is absent");
          return gate.processEpoch;
        },
      });
      this.currentCreds = await mintCreds(this.auth, this.identity, "endpoint-serve", { serveIssuance: this.fence(authKv), endpointServe: grant });
      this.authorized = grant;
    });
  }

  async connect(): Promise<NatsConnection> {
    const target = this.input.target;
    if (!this.currentCreds) throw new Error("no fenced executable serve credential");
    const nc = await dialerFor(target.server)({
      servers: target.server, ...(target.tlsRequired ? { tls: {} } : {}),
      authenticator: (nonce?: string) => credsAuthenticator(new TextEncoder().encode(this.currentCreds!))(nonce),
      inboxPrefix: `_INBOX_${this.identity.id}`, ignoreClusterUpdates: true,
      maxReconnectAttempts: 1, reconnectTimeWait: 0, reconnectJitter: 0, reconnectJitterTLS: 0,
    });
    try { requireBrokerFloor(nc); return nc; }
    catch (error) { await nc.close(); throw error; }
  }

  /** Publish ready only after the host has constructed its real serve subscriptions and flushed. */
  async ready(): Promise<void> {
    const grant = this.grant;
    await this.executor(({ recordsKv, authKv }) => writeServiceStatus(recordsKv, {
      endpoint: grant.endpoint, instanceId: grant.instanceId, epoch: grant.epoch,
      status: { state: SERVICE_READY, epoch: grant.epoch, observedSpecRevision: grant.registrationRevision },
      readProcessEpoch: async () => {
        const gate = await this.fence(authKv).observe();
        if (!gate) throw new Error("executable issuance gate is absent");
        return gate.processEpoch;
      },
    }));
  }

  renewalDelay(): number {
    const expiration = inspectCredHealth(this.currentCreds!).exp;
    if (expiration === undefined) throw new Error("the native standing serve credential has no bounded renewal window");
    const remaining = expiration * 1000 - Date.now();
    if (remaining <= 0) throw new Error("the native standing serve credential expired");
    return Math.max(1, Math.floor(remaining * 0.75));
  }

  async renew(nc: NatsConnection): Promise<void> {
    this.currentCreds = await this.executor(({ authKv }) => mintCreds(this.auth, this.identity, "endpoint-serve", { serveIssuance: this.fence(authKv), endpointServe: this.grant }));
    await nc.reconnect(); await nc.flush();
    requireBrokerFloor(nc);
  }

  async deregister(): Promise<boolean> {
    if (this.registrationRevision === undefined) return false;
    const result = await this.executor(({ recordsKv, authKv }) => deregisterServiceInstance(recordsKv, {
      endpoint: this.input.contract.source.endpoint, instanceId: this.instanceId,
      registrationRevision: this.registrationRevision,
      observeGeneration: () => readEndpointGateGeneration(authKv, { endpoint: this.input.contract.source.endpoint, instanceId: this.instanceId }),
    }));
    if (!result.removed && result.reason !== "absent") throw new Error("original executable registration was not removed; a successor or governance slot was retained");
    return true;
  }
}
