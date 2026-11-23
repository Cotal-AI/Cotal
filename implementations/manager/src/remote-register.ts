import { setTimeout as delay } from "node:timers/promises";
import { Kvm } from "@nats-io/kv";
import { UserAuthenticationExpiredError, type NatsConnection } from "@nats-io/transport-node";
import {
  accountFromCreds,
  credsClaims,
  contractArtifactCanonicalBytes,
  contractArtifactDigestHex,
  contractRefToHex,
  contractStoreContext,
  dialerFor,
  endpointRegistrationBarrier,
  epAuthBucket,
  fetchContractArtifact,
  foreignSlotHeldFrom,
  GovernanceSlotCasLost,
  principalKey,
  provisionEndpointGateOpen,
  publishContractArtifact,
  readEndpointGateGeneration,
  rejectionText,
  recordsBucket,
  registerServingInstance,
  serveIssuanceGateKv,
  standaloneConnectOpts,
  type EpServeGrant,
  type EpIssuanceBarrier,
} from "@cotal-ai/core";
import { MANAGER_ENDPOINT, managerAuthorityContractSource, managerClusterArtifacts } from "./manager-service-contract.js";

async function registerAfterContention<T>(register: () => Promise<T>, deadline: number): Promise<T> {
  for (let retries = 0; ; retries++) {
    try {
      return await register();
    } catch (error) {
      // A fresh attempt re-reads the governance head and validates the registration under its gate.
      if (!(error instanceof GovernanceSlotCasLost) && foreignSlotHeldFrom(error)?.condition !== "in-flight") throw error;
      const wait = Math.random() * Math.min(15_000, 250 * 2 ** retries);
      if (Date.now() + wait >= deadline) throw error;
      await delay(wait);
      if (Date.now() >= deadline) throw error;
    }
  }
}

/**
 * Run registration with host-issued prepare authority, scoped to one manager instance. Fresh
 * prepare authority can resume the same frozen operation after the broker expires its executor.
 */
export async function registerRemoteManagerAuthority(args: {
  space: string;
  server: string;
  owner: string;
  instanceId: string;
  serveActor: string;
  prepareCreds: string;
  /** Reissue prepare authority for the same lifecycle and held executor nkey after expiry.
   *  Host refusals propagate. Registration resumes its existing frozen operation. */
  refreshPrepareCreds?: () => Promise<string>;
  /** Whether the registered broker REQUIRES TLS, carried from the mesh record rather than decided
   *  here. A participant reaches its host through whatever the record says, so this can be a
   *  `wss://` edge; hardcoding `false` would send the prepare credential to it in the clear. */
  tlsRequired: boolean;
  evict: (principals: readonly string[]) => Promise<boolean[]>;
  /** Host-side guarded repair for a foreign manager slot holder, used once before a retry. */
  reconcileForeignRegistration?: (instanceId: string) => Promise<void>;
}): Promise<{ registrationRevision: number; processEpoch: number; serveGrant: EpServeGrant }> {
  let prepareCreds = args.prepareCreds;
  const identity = credsClaims(prepareCreds).sub;
  const account = accountFromCreds(prepareCreds);
  let contentionDeadline: number | undefined;
  let lastProgressAt = 0;
  const onRevocationProgress: NonNullable<EpIssuanceBarrier["onRevocationProgress"]> = ({ revoked, total }) => {
    const now = Date.now();
    if (total > 0 && (revoked === total || now - lastProgressAt >= 5_000)) {
      console.error(`manager registration: revoked ${revoked} of ${total} superseded credential rows`);
      lastProgressAt = now;
    }
  };
  for (;;) {
    const expiry = credsClaims(prepareCreds).exp;
    const refresh = async () => {
      const next = await args.refreshPrepareCreds!();
      const claims = credsClaims(next);
      if (claims.sub !== identity || accountFromCreds(next) !== account)
        throw new Error("manager registration prepare refresh must keep the same account and executor identity");
      if (typeof claims.exp !== "number" || claims.exp <= (expiry ?? 0) || claims.exp * 1000 <= Date.now())
        throw new Error("manager registration prepare refresh must advance the executor expiry");
      prepareCreds = next;
      console.error(`manager registration: executor expired; resuming operation ${args.instanceId} with fresh scoped authority`);
    };
    if (args.refreshPrepareCreds && expiry !== undefined && expiry * 1000 <= Date.now()) {
      await refresh();
      continue;
    }
    let nc: NatsConnection | undefined;
    // Host maintenance runs on a separate authority connection. Its refusal must survive even
    // when the prepare connection expires before core can save a partial eviction verdict.
    let maintenanceFailure: { error: unknown } | undefined;
    try {
      // Follow the recorded URL, including ws/wss edges, without widening the executor's grants.
      nc = await dialerFor(args.server)({
        servers: args.server,
        ...standaloneConnectOpts({ creds: prepareCreds, tls: args.tlsRequired }),
        reconnect: false,
        maxReconnectAttempts: 0,
      });
      const kvm = new Kvm(nc);
      const recordsKv = await kvm.open(recordsBucket(args.space));
      const authKv = await kvm.open(epAuthBucket(args.space));
      const store = await contractStoreContext(nc, args.space);
      const artifacts = managerClusterArtifacts();
      const all = [...managerAuthorityContractSource().artifacts, artifacts.document, artifacts.manifest];
      console.error(`manager registration: verifying ${all.length} contract artifacts and publishing any that are missing`);
      // A restart usually finds the same immutable artifacts. Read and verify them instead of
      // spending a failed create before each read. Publish only on an observed miss, using the
      // same create-only fence in case another Manager publishes the artifact first.
      for (let offset = 0; offset < all.length; offset += 32) {
        // Settle all work in the batch before closing a failed connection.
        const results = await Promise.allSettled(all.slice(offset, offset + 32).map(async value => {
          const bytes = contractArtifactCanonicalBytes(value);
          if (await fetchContractArtifact(store, contractArtifactDigestHex(bytes)) === undefined)
            await publishContractArtifact(store, bytes);
        }));
        for (const result of results) if (result.status === "rejected") throw result.reason;
      }
      console.error("manager registration: contract artifacts verified; acquiring the serving registration");
      const readClusterArtifact = async (digest: string): Promise<unknown> => {
        // Manifest references include sha256:, but the store uses the bare hex digest.
        const bytes = await fetchContractArtifact(store, contractRefToHex(digest));
        return bytes ? JSON.parse(new TextDecoder().decode(bytes)) : undefined;
      };
      const principal = principalKey(args.owner, args.serveActor).key;
      if ((await serveIssuanceGateKv(authKv, args.space, { endpoint: MANAGER_ENDPOINT, instanceId: args.instanceId }).observe()) === null)
        await provisionEndpointGateOpen(authKv, { endpoint: MANAGER_ENDPOINT, instanceId: args.instanceId, principal });
      const authority = { authorize: (endpoint: string, owner: string) => ({ authorized: endpoint === MANAGER_ENDPOINT && owner === args.owner, revision: 0 }) };
      const barrier = endpointRegistrationBarrier(authKv, args.space, {
        endpoint: MANAGER_ENDPOINT,
        instanceId: args.instanceId,
        opId: args.instanceId,
        evict: async holders => {
          try {
            const gone = await args.evict(holders);
            if (gone.length !== holders.length || holders.some((_, i) => gone[i] !== true))
              maintenanceFailure = { error: new Error("host eviction did not verify every requested holder") };
            // Core still records successful verdicts before reporting any unverified holders.
            return gone;
          } catch (error) {
            maintenanceFailure = { error };
            throw error;
          }
        },
      });
      const register = () => registerServingInstance(recordsKv, {
        space: args.space,
        spec: { endpoint: MANAGER_ENDPOINT, owner: args.owner, clusterDigests: [artifacts.closureDigest], protocol: { v: 1 } },
        instanceId: args.instanceId,
        registrant: { owner: args.owner },
        authority,
        barrier: { ...barrier, onRevocationProgress },
        readClusterArtifact,
        // A foreign slot is reclaimed only after its gate provably reopens past the slot stamp.
        observeHolderGeneration: (holderInstanceId) =>
          readEndpointGateGeneration(authKv, { endpoint: MANAGER_ENDPOINT, instanceId: holderInstanceId }),
      });
      let registered: Awaited<ReturnType<typeof register>>;
      try {
        contentionDeadline ??= Date.now() + 15_000;
        registered = await registerAfterContention(register, Math.min(contentionDeadline, (expiry ?? Infinity) * 1000));
      } catch (error) {
        // Only a holder still at the slot stamp needs guarded host reconciliation.
        const held = foreignSlotHeldFrom(error);
        if (held?.condition !== "in-flight" || !args.reconcileForeignRegistration) throw error;
        try {
          await args.reconcileForeignRegistration(held.holderInstanceId);
        } catch (error) {
          maintenanceFailure = { error };
          throw error;
        }
        registered = await register();
      }
      const { registrationRevision, processEpoch, grant } = registered;
      return { registrationRevision, processEpoch, serveGrant: grant };
    } catch (error) {
      if (maintenanceFailure) throw maintenanceFailure.error;
      // Retry only an authentication-expiry error or an elapsed credential on a closed connection.
      // Completed row CASes and verified-holder progress belong to the same freeze.
      // Some transports close without retaining the broker's expiry error. In that case require
      // both the executor's elapsed expiry and a closed-connection refusal, never a barrier refusal.
      const expired = error instanceof UserAuthenticationExpiredError || (nc?.isClosed() && (
        await nc.closed() instanceof UserAuthenticationExpiredError
        || (expiry !== undefined && expiry * 1000 <= Date.now()
          && /connection closed|closed connection/i.test(rejectionText(error)))
      ));
      if (!args.refreshPrepareCreds || !expired) throw error;
      await refresh();
    } finally {
      // This executor serves no inbound work. Every request and revoke batch has settled, so
      // close directly rather than draining through a PING that expiry can leave unanswered.
      if (nc) await nc.close();
    }
  }
}
