/**
 * Register an endpoint the delivery daemon serves, and mint its serve credential (A1, plan option A).
 *
 * The daemon holds no signer, so the signer holder does this for it: `ensureDelivery` at start and the
 * manager's credential renewal after. The ceremony is the one every registered endpoint walks: publish
 * the contract artifacts, provision the issuance gate bound to a persisted serve principal, run the
 * registration barrier (which verify-evicts a superseded serve family on a restart, through the delivery
 * daemon's own eviction oracle), then mint `endpoint-serve` behind the fence.
 *
 * It does NOT write `ready` status. The daemon reports a candidate bound only after it has checked the
 * credential's rows against the grant it derived itself and the broker accepted every subscription, and
 * names that candidate by its credential fingerprint. `writeDaemonEndpointReady` writes `ready` only when
 * the daemon's report names the credential minted here.
 *
 * Generic over the endpoint so a later delivery-served endpoint reuses it unchanged.
 */
import { createHash } from "node:crypto";
import {
  authorizeServeGrant, contractArtifactCanonicalBytes, contractStoreContext,
  DEV_OWNER, endpointRegistrationBarrier, epgateKey, GateReconcileRefused, mintCreds, mintLifecycleUid, parseEndpointGate, reconcileEndpointGate,
  principalKey, provisionEndpointGateOpen, publishContractArtifact, readEndpointGateGeneration,
  registerServiceInstance, serveIssuanceGateKv, SERVICE_READY, withEndpointServeExecutorSession,
  writeServiceStatus, jwtFromCreds,
  type ClusterDocument, type ContractClosureManifest, type EpServeGrant, type Identity,
  type ServiceNameAuthority, type SpaceAuth,
} from "@cotal-ai/core";
import { DELIVERY_ADMIN_BOOT_WAIT_MS, makeManagerEndpointHolderEvictor } from "./endpoint-evict.js";
import { makeManagerHolderLivenessProbe } from "./holder-liveness.js";

/** What a daemon-served endpoint brings: its name and its built-in contract. */
export interface DaemonEndpointContract {
  endpoint: string;
  cluster: { document: ClusterDocument; rootDigest: string; manifest: ContractClosureManifest; closureDigest: string };
  /** Every schema artifact the cluster document's commands name. */
  artifactValues: () => unknown[];
}

/** Where the endpoint is registered and who signs for it. */
export interface DaemonEndpointTarget {
  auth: SpaceAuth;
  servers: string;
  space: string;
  tls?: boolean;
  /** The persisted instance id: the same id on every start, so a restart is a takeover. */
  instanceId: string;
  /** The persisted serve identity: the same nkey on every start, so the gate's principal holds. */
  serveIdentity: Identity;
  log: (line: string) => void;
}

/** The SHA-256 of a credential's user JWT, hex: the token a daemon's `serveState` reports. */
export function credentialFingerprint(creds: string): string {
  const jwt = jwtFromCreds(creds);
  if (!jwt) throw new Error("credentialFingerprint: no NATS user JWT in the credential");
  return createHash("sha256").update(jwt).digest("hex");
}

/** The executor session arguments for this endpoint instance. */
const sessionArgs = (t: DaemonEndpointTarget) => ({ auth: t.auth, servers: t.servers, space: t.space, tls: t.tls === true });

/** The core-name authority: the signer holder authorizes exactly this endpoint for exactly
 *  DEV_OWNER, never a general authority (the `manager` rule). */
function nameAuthority(endpoint: string): ServiceNameAuthority {
  return { authorize: (name, owner) => ({ authorized: name === endpoint && owner === DEV_OWNER, revision: 0 }) };
}

/** Register and mint the serve credential behind the fence (a takeover on restart). Returns the grant at
 *  the committed epoch and the minted serve credential. */
export async function registerDaemonEndpoint(t: DaemonEndpointTarget, contract: DaemonEndpointContract): Promise<{ grant: EpServeGrant; creds: string; fingerprint: string }> {
  return withDaemonEndpointSession(t, contract, "register");
}

/** Re-mint the serve credential for the SAME registration at the CURRENT epoch (renewal): no barrier, no
 *  epoch advance. The fence still refuses unless the gate is open at the grant's epoch and revisions. */
export async function remintDaemonEndpointServe(t: DaemonEndpointTarget, contract: DaemonEndpointContract): Promise<{ grant: EpServeGrant; creds: string; fingerprint: string }> {
  return withDaemonEndpointSession(t, contract, "remint");
}

async function withDaemonEndpointSession(t: DaemonEndpointTarget, contract: DaemonEndpointContract, mode: "register" | "remint"): Promise<{ grant: EpServeGrant; creds: string; fingerprint: string }> {
  const { endpoint, cluster } = contract;
  const store = new Map<string, unknown>([[cluster.rootDigest, cluster.document], [cluster.closureDigest, cluster.manifest]]);
  const readClusterArtifact = (digest: string): unknown => store.get(digest);
  const authority = nameAuthority(endpoint);
  const principal = principalKey(DEV_OWNER, t.serveIdentity.id).key;
  const opId = mintLifecycleUid();
  return withEndpointServeExecutorSession(sessionArgs(t), { endpoint, instanceId: t.instanceId }, async ({ recordsKv, authKv, nc }) => {
    const fence = serveIssuanceGateKv(authKv, t.space, { endpoint, instanceId: t.instanceId });
    const readProcessEpoch = async (): Promise<number> => {
      const gate = await fence.observe();
      if (gate === null) throw new Error(`no issuance gate for ${endpoint}/${t.instanceId} after its registration`);
      return gate.processEpoch;
    };
    let processEpoch: number;
    if (mode === "register") {
      const ctx = await contractStoreContext(nc, t.space);
      for (const value of [...contract.artifactValues(), cluster.document, cluster.manifest])
        await publishContractArtifact(ctx, contractArtifactCanonicalBytes(value));
      const prior = await fence.observe();
      if (prior === null)
        await provisionEndpointGateOpen(authKv, { endpoint, instanceId: t.instanceId, principal });
      else if (prior.state === "frozen")
        // A registration that died holding the freeze (E10): finish THAT op by its recorded id, behind
        // the affirmative holder-gone guard, before this one starts. A fresh op id against a frozen gate
        // would never resume it, and the barrier's freeze CAS would refuse forever.
        await resumeFrozenRegistration(t, authKv, recordsKv, endpoint);
      const barrier = endpointRegistrationBarrier(authKv, t.space, {
        endpoint, instanceId: t.instanceId, opId,
        evict: makeManagerEndpointHolderEvictor({ space: t.space, servers: t.servers, auth: t.auth, tlsRequired: t.tls, log: t.log, unreachableWaitMs: DELIVERY_ADMIN_BOOT_WAIT_MS }),
      });
      const spec = { endpoint, owner: DEV_OWNER, clusterDigests: [cluster.closureDigest], protocol: { v: 1 as const } };
      ({ processEpoch } = await registerServiceInstance(recordsKv, {
        space: t.space, spec, instanceId: t.instanceId, registrant: { owner: DEV_OWNER }, authority, barrier, readClusterArtifact,
        observeHolderGeneration: (holder) => readEndpointGateGeneration(authKv, { endpoint, instanceId: holder }),
      }));
    } else {
      const gate = await fence.observe();
      if (gate === null || gate.state !== "open")
        throw new Error(`${endpoint}/${t.instanceId}: the issuance gate is ${gate?.state ?? "absent"}, so nothing is re-minted; a restart re-registers`);
      if (gate.principal !== principal)
        throw new Error(`${endpoint}/${t.instanceId}: the issuance gate names ${gate.principal}, not the persisted serve principal; nothing is re-minted`);
      processEpoch = gate.processEpoch;
    }
    const grant = await authorizeServeGrant(recordsKv, {
      space: t.space, endpoint, instanceId: t.instanceId, epoch: processEpoch, holder: { owner: DEV_OWNER }, authority, readClusterArtifact, readProcessEpoch,
    });
    const creds = await mintCreds(t.auth, t.serveIdentity, "endpoint-serve", { serveIssuance: fence, endpointServe: grant });
    return { grant, creds, fingerprint: credentialFingerprint(creds) };
  });
}

/** The bucket handle the reconciler takes, without a direct `@nats-io/kv` dependency here. */
type GateKv = Parameters<typeof reconcileEndpointGate>[0]["kv"];

/** Reconcile a frozen registration gate with the reconciler the manager's boot self-heal uses: the
 *  freeze-holder must be affirmatively gone (a CONNZ sweep through the delivery daemon), then the dead
 *  op's own obligation is completed under ITS op id and the gate reopens. Live, unknown and
 *  unestablishable holders, and a freeze under another op kind, stay loud refusals. A concurrent
 *  reconciler that already reopened the gate is not a failure. */
async function resumeFrozenRegistration(t: DaemonEndpointTarget, authKv: GateKv, recordsKv: GateKv, endpoint: string): Promise<void> {
  const key = epgateKey(endpoint, t.instanceId);
  try {
    const report = await reconcileEndpointGate({
      kv: authKv, recordsKv, space: t.space, endpoint, instanceId: t.instanceId,
      probeHolder: makeManagerHolderLivenessProbe({ space: t.space, servers: t.servers, auth: t.auth, tlsRequired: t.tls, log: t.log, unreachableWaitMs: DELIVERY_ADMIN_BOOT_WAIT_MS }),
      evictHolders: makeManagerEndpointHolderEvictor({ space: t.space, servers: t.servers, auth: t.auth, tlsRequired: t.tls, log: t.log, unreachableWaitMs: DELIVERY_ADMIN_BOOT_WAIT_MS }),
      log: t.log,
    });
    t.log(`✓ ${endpoint}/${t.instanceId}: a frozen registration was completed and its gate reopened at generation ${report.reopenedAtGeneration}; registering`);
  } catch (e) {
    if (e instanceof GateReconcileRefused && (e.condition === "not-frozen" || e.condition === "raced")) {
      const latest = await authKv.get(key);
      if (latest?.operation === "PUT" && parseEndpointGate(latest.value, key).state === "open") return;
    }
    throw new Error(`${endpoint}/${t.instanceId}: the issuance gate is frozen by an earlier registration that cannot be completed, so nothing registers: ${(e as Error).message}`);
  }
}

/** Write `ready` for the instance only when the daemon reported the credential minted here as bound
 *  at the grant's epoch. A report naming another credential (a last-good connection at the same epoch)
 *  writes nothing and throws, so `ready` never stands for a candidate that did not bind. */
export async function writeDaemonEndpointReady(
  t: DaemonEndpointTarget,
  endpoint: string,
  minted: { grant: EpServeGrant; fingerprint: string },
  reported: { epoch: number; credentialFingerprint: string },
): Promise<void> {
  if (reported.epoch !== minted.grant.epoch || reported.credentialFingerprint !== minted.fingerprint)
    throw new Error(`the delivery daemon reports ${endpoint} bound at epoch ${reported.epoch} on another credential, not the one just minted at epoch ${minted.grant.epoch}; ready was not written`);
  await withEndpointServeExecutorSession(sessionArgs(t), { endpoint, instanceId: t.instanceId }, async ({ recordsKv, authKv }) => {
    const fence = serveIssuanceGateKv(authKv, t.space, { endpoint, instanceId: t.instanceId });
    const readProcessEpoch = async (): Promise<number> => {
      const gate = await fence.observe();
      if (gate === null) throw new Error(`no issuance gate for ${endpoint}/${t.instanceId}`);
      return gate.processEpoch;
    };
    await writeServiceStatus(recordsKv, {
      endpoint, instanceId: t.instanceId, epoch: minted.grant.epoch,
      status: { state: SERVICE_READY, epoch: minted.grant.epoch, observedSpecRevision: minted.grant.registrationRevision },
      readProcessEpoch,
    });
  });
}
