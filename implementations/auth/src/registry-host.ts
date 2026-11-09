import { Kvm } from "@nats-io/kv";
import type { NatsConnection } from "@nats-io/transport-node";
import {
  CotalEndpoint, DEV_OWNER, EpEnvelopeError, REGISTRY_ENDPOINT, SERVICE_EXITED, SERVICE_READY,
  authorizeServeGrant, epAuthBucket, mintCreds, newIdentity, principalKey, recordsBucket,
  registerServiceInstance, registryClusterArtifacts, registryContractArtifactValues, serveIssuanceGateKv,
  writeServiceStatus, type RegistryService, type RegistryServiceHandle, type SecretStore,
} from "@cotal-ai/core";
import { openAuthorityClient, registrationExecutorGrants, type AuthorityClient, type AuthorityClientOpts } from "./authority-client.js";
import { makeDeliveryAdminHolderEvictor } from "./barrier-evict.js";
import { makeDeliveryAdminPrincipalOracle } from "./plane-claim.js";
import { claimRegistryIdentity } from "./registry-state.js";
import { contractArtifactReader, registerSelfAuthorizedInstance, selfNameAuthority } from "./service-registration.js";
import { dataAccountAuth, type ServiceKeys } from "./store.js";

/** This is opened only under the auth lane's held plane claim. The factory gets no signing key. */
export async function openAuthRegistry(opts: {
  server: string;
  space: string;
  store: SecretStore;
  dataAccount: ServiceKeys["dataAccount"];
  implementation: RegistryService;
  signal: AbortSignal;
  log: (line: string) => void;
  onConnection?: AuthorityClientOpts["onConnection"];
  onFailure: (reason: string) => void;
  /** Retain cleanup before startup has effects, including a failed start whose close must retry. */
  onCustody: (handle: { refuse(): void; close(): Promise<void> }) => void;
  /** Trusted-host fixture option; ordinary endpoint renewal still owns the timer and fenced mint. */
  ttlSeconds?: number;
}): Promise<{ refuse(): void; close(): Promise<void> }> {
  const { server, space, store, dataAccount, implementation, signal, log, onConnection } = opts;
  const ttl = opts.ttlSeconds;
  if (ttl !== undefined && (!Number.isSafeInteger(ttl) || ttl < 5 || ttl > 900))
    throw new Error("registry rehearsal credential lifetime must be an integer from 5 to 900 seconds");
  const lifetime = ttl === undefined ? {} : { expiresInSeconds: ttl };
  if (implementation.kind !== "registry-service" || typeof implementation.start !== "function")
    throw new Error("the registry implementation must be a registry-service extension");
  const controller = new AbortController();
  const handles = new Set<RegistryServiceHandle>();
  const pending = new Set<Promise<void>>();
  let executor: AuthorityClient | undefined;
  let reader: CotalEndpoint | undefined, serverEndpoint: CotalEndpoint | undefined;
  let readerNc: NatsConnection | undefined, servingNc: NatsConnection | undefined;
  let closing = false, ready = false;
  let writeStatus: ((state: string) => Promise<void>) | undefined;
  const refuse = (): void => {
    controller.abort();
    for (const h of handles) h.refuse();
  };
  const available = (): void => {
    if (controller.signal.aborted || signal.aborted)
      throw new EpEnvelopeError("unavailable", "the registry's auth lane is unavailable");
  };
  const failure = (error: unknown): void => {
    refuse();
    if (!closing) opts.onFailure(`registry: ${error instanceof Error ? error.message : String(error)}`);
  };
  const onAbort = (): void => {
    refuse();
    // A plane fence must also stop registration/issuance already in progress during startup.
    void executor?.close().catch(failure);
  };
  signal.addEventListener("abort", onAbort, { once: true });
  let closingPromise: Promise<void> | undefined;
  const close = (): Promise<void> => {
    closing = true;
    refuse();
    return closingPromise ??= (async () => {
      // Start drains before closing connections; a closed reader cancels pending disclosure reads.
      const stopped = await Promise.allSettled([
        ...[...handles].map((h) => h.stop()), reader?.stop(), serverEndpoint?.stop(),
      ]);
      // A failed start is not a failed close, but every start must settle before custody ends.
      await Promise.allSettled([...pending]);
      await Promise.all([...handles].map((h) => h.stop()));
      const failed = stopped.find((r): r is PromiseRejectedResult => r.status === "rejected");
      if (failed) throw failed.reason;
      if (ready && !signal.aborted) { await writeStatus!(SERVICE_EXITED); ready = false; }
      await executor?.close();
      signal.removeEventListener("abort", onAbort);
    })().catch((error) => { closingPromise = undefined; throw error; });
  };
  opts.onCustody({ refuse, close });
  try {
    available();
    const identity = await claimRegistryIdentity(store, space, dataAccount.pub);
    available();
    const { instanceId, serveIdentity } = identity;
    const cluster = registryClusterArtifacts();
    const artifacts = [...registryContractArtifactValues(), cluster.document, cluster.manifest];
    executor = await openAuthorityClient({ server, space, dataAccount, log, onConnection,
      label: `cotal:registry-registration:${space}`,
      grants: (id) => registrationExecutorGrants(space, id, REGISTRY_ENDPOINT, instanceId),
      onRenewalFailure: () => failure(new Error("registry registration credential renewal failed")),
    });
    available();
    const principalOracle = makeDeliveryAdminPrincipalOracle({ server, space, dataAccount, log, onConnection });
    const evict = makeDeliveryAdminHolderEvictor({ server, space, dataAccount, log, onConnection });
    const registration = await registerSelfAuthorizedInstance(executor.nc, {
      space, endpoint: REGISTRY_ENDPOINT, instanceId,
      principal: principalKey(DEV_OWNER, serveIdentity.id).key,
      clusterDigest: cluster.closureDigest, artifacts,
      recovery: {
        probeHolder: async (principal) => {
          available();
          const result = await principalOracle(principal);
          available();
          return { state: result.state, detail: result.note ?? `delivery principal sweep complete=${String(result.sweepComplete)}` };
        },
        evictHolders: async (holders) => {
          available();
          const result = await evict(holders);
          available();
          return result.map((r) => r.verifiedGone);
        },
        log,
      },
    }, registerServiceInstance);
    available();
    const kvm = new Kvm(executor.nc);
    const records = await kvm.open(recordsBucket(space));
    const gate = serveIssuanceGateKv(await kvm.open(epAuthBucket(space)), space, { endpoint: REGISTRY_ENDPOINT, instanceId });
    const readProcessEpoch = async () => {
      const current = await gate.observe();
      if (!current) throw new EpEnvelopeError("unavailable", "the registry issuance gate is missing");
      return current.processEpoch;
    };
    const grant = await authorizeServeGrant(records, {
      space, endpoint: REGISTRY_ENDPOINT, instanceId, epoch: registration.processEpoch,
      holder: { owner: DEV_OWNER }, authority: selfNameAuthority(REGISTRY_ENDPOINT),
      readClusterArtifact: contractArtifactReader(artifacts), readProcessEpoch,
    });
    writeStatus = async (state) => {
      await writeServiceStatus(records, {
        endpoint: REGISTRY_ENDPOINT, instanceId, epoch: registration.processEpoch, readProcessEpoch,
        status: { state, epoch: registration.processEpoch, observedSpecRevision: registration.registrationRevision },
      });
    };
    const auth = dataAccountAuth(space, dataAccount);
    const readerIdentity = newIdentity();
    reader = new CotalEndpoint({
      space, servers: server, channels: [], consume: false, registerPresence: false, watchPresence: false, watchChannels: false,
      card: { id: readerIdentity.id, name: "registry-reader", kind: "endpoint" },
      creds: async () => {
        try {
          available();
          const creds = await mintCreds(auth, readerIdentity, "registry-reader", lifetime);
          available();
          return creds;
        } catch (error) { failure(error); throw error; }
      },
      onConnection: (nc) => {
        readerNc = nc;
        onConnection?.(nc, `cotal:registry-reader:${space}`);
        void nc.closed().then(() => {
          if (!closing && !controller.signal.aborted) failure(new Error("registry reader connection closed"));
        });
      },
    });
    reader.on("error", failure);
    reader.on("warning", (error: Error) => log(`registry reader: ${error.message}`));
    await reader.start();
    available();
    serverEndpoint = new CotalEndpoint({
      space, servers: server, channels: [], consume: false, registerPresence: false, watchPresence: false, watchChannels: false,
      card: { id: serveIdentity.id, name: "registry", kind: "endpoint" },
      creds: async () => {
        try {
          available();
          // Every renewal is an ordinary issuance CAS against the same captured grant, never a
          // re-sign of cached permissions or adoption of a successor's registration coordinates.
          const creds = await mintCreds(auth, serveIdentity, "endpoint-serve", {
            endpointServe: grant, serveIssuance: gate, ...lifetime,
          });
          available();
          return creds;
        } catch (error) { failure(error); throw error; }
      },
      onConnection: (nc) => {
        servingNc = nc;
        onConnection?.(nc, `cotal:registry-serve:${space}`);
        const bind = (async () => {
          available();
          const handle = await implementation.start({ space, connection: nc, reader: readerNc!, grant, signal: controller.signal, log, onFailure: failure });
          handles.add(handle);
          if (controller.signal.aborted) { handle.refuse(); await handle.stop(); }
          void nc.closed().then(() => {
            if (!closing && !controller.signal.aborted) failure(new Error("registry serving connection closed"));
            return handle.stop();
          }).catch(failure).finally(() => handles.delete(handle));
        })();
        pending.add(bind);
        void bind.catch(failure).finally(() => pending.delete(bind));
      },
    });
    serverEndpoint.on("error", failure);
    serverEndpoint.on("warning", (error: Error) => log(`registry serve: ${error.message}`));
    await serverEndpoint.start();
    await Promise.all([...pending]);
    available();
    await servingNc!.flush();
    // A lost ready acknowledgement can still have published the status; close must compensate.
    ready = true;
    await writeStatus(SERVICE_READY);
    available();
    return { refuse, close };
  } catch (error) {
    await close();
    throw error;
  }
}
