import { handleExchange, LOOPBACK_POLICY, ManagerSelectionRefusal } from "./service-exchange-routes.js";
import type { ExchangePolicy } from "./service-exchange-routes.js";
export type { ExchangePolicy } from "./service-exchange-routes.js";
import { handleInteractiveLifecycleRetirement, handleManagedLifecycleRetirement, handleManagedLifecycleActivation, handleVerifyManagedAgentEnrollment, handleManagerInstances, handleManagerServiceAuthority } from "./service-manager-routes.js";
export { dispatchManagerAuthorityRequest, handleManagerServiceAuthority, type ManagerServiceAuthorityCtx } from "./service-manager-routes.js";
import { send, RequestBodyError, sendRequestError, refuseCapability, refuseExchange, REFUSAL_STATUS, readJsonBody } from "./service-http.js";
import { registryStores } from "./lifecycle-registry.js";
import { drainAndClose } from "@cotal-ai/core";
import { makeToolResultConsentRecorder } from "./tool-result-consent.js";
/**
 * The AUTH SERVICE daemon — the one server-side process a user-auth space runs alongside its broker
 * (the delivery-daemon pattern: spawned detached by `cotal up`, pid-filed per space, torn down by
 * `cotal down`). It hosts BOTH halves of the identity plane, which share state and so belong in one
 * isolated process rather than smeared across the manager/delivery daemons:
 *
 *  - **Plane 2 — the NATS auth callout** ({@link serveCallout}): answers `$SYS.REQ.USER.AUTH`
 *    over its own callout-account connection, validating bearers offline against the LOCAL issuer
 *    key set and minting scoped data-account user JWTs.
 *  - **Plane 1 — the token exchange + JWKS, over loopback HTTP**: `POST /exchange` turns a fresh
 *    IdP JWT (from `cotal login`'s cached session) into a Cotal user bearer via the pinned
 *    {@link createIdpBridge}; `GET /jwks` publishes the issuer's public keys.
 *
 * Least-privilege by construction: the daemon loads ONLY provider-owned projected files from its
 * space-scoped state dir (`.cotal/auth/<space>/`) — the data-account signing seed arrives via
 * `service-keys.json` (minting scoped users IS this service's function); the space's operator seed
 * and account seed never enter this process (`prepareServer` wrote the projection and kept the rest).
 *
 * The exchange surface is LOCAL-V1, hardened: loopback bind only; `POST /exchange` requires the
 * per-start high-entropy capability (`Authorization: Bearer <cap>` — readable only from the 0600
 * discovery file, so same-user file ACL is the boundary, or from a hosted context's handle inside
 * the host process); requests carrying an `Origin` header are
 * rejected (a browser page can reach loopback; it must not be able to drive the exchange); bodies
 * must be `application/json`; failed exchanges are rate-limited and logged. No CORS headers, ever.
 *
 * REMOTE EXCHANGE — the OPTIONAL second listener (`--exchange-public-port`, also binding
 * 127.0.0.1; TLS terminates at a reverse proxy — in-process TLS was rejected: it duplicates cert
 * renewal and forks deploy). It serves ONLY `GET /health`, `GET /jwks`, `POST /exchange`,
 * `POST /manager-service-authority`, and `GET /.well-known/cotal-mesh` (the generated discovery
 * bundle), plus, only with `serviceEndpoints`, `/service-endpoint-authority` on both faces;
 * everything else 404s. Its
 * `/exchange` demands NO capability — honestly: the 0600 cap is a same-uid file-ACL boundary with
 * no remote meaning, so requiring its bytes from a remote caller would prove nothing. The proof on
 * the public face is the credential itself: the human arm presents an EdDSA IdP JWT verified
 * against the pinned JWKS/issuer/audience; the agent arm presents an actorToken whose sha256 must
 * match a FRESH ledger row. Origin rejection, JSON-only bodies, the 64 KB bound, and no-CORS-ever
 * hold verbatim. Public views are channel-writer/channel-purger and the one-object transfer-writer
 * (admin-gated) and manager-caller (instance-bound, with no added command scope). Host lifecycle
 * activation and retirement stay capability-gated on the loopback face only. The agent-secret arm
 * may request only manager-caller on either face;
 * failures are bucketed per peer (`--exchange-trusted-proxy` opts into the last X-Forwarded-For
 * hop as the peer key; otherwise the socket remote address) in a bounded LRU, under a global
 * concurrent-admission cap and a hard request deadline — all of it pools SEPARATE from the
 * loopback face's budgets, and peer probing buckets never refuse a request that would
 * succeed (only a principal's own full public pinned or unpinned selection-refusal window
 * sheds that class).
 *
 * Both trust boundaries authorize against the SAME actor ledger, read fresh per request — a revoke
 * bites at the next exchange AND the next connect with no restart.
 *
 * JWKS cache contract (gate 4, explicit): responses carry `Cache-Control: max-age=300`. A verifier
 * may cache the set for up to 5 minutes, so a rotated-out (retired) kid MUST stay published for at
 * least (300s + the max bearer TTL) after rotation before `retire` — otherwise still-live bearers
 * signed by it fail verification at a cold cache. The local callout uses `issuer.localKeySet()`
 * (live, in-process) and is exempt.
 *
 * Readiness contract: the discovery file (`auth-service.json`) is written only AFTER the callout
 * subscription is FLUSHED to the broker and the HTTP listener is bound — its existence (plus a
 * /health probe) IS the readiness signal the provider's `ready()` polls.
 */
import { createHash } from "node:crypto";
import { type IncomingMessage, type ServerResponse } from "node:http";
import { resolve } from "node:path";
import { type NatsConnection } from "@nats-io/transport-node";
import { jetstream, jetstreamManager } from "@nats-io/jetstream";
import { Kvm } from "@nats-io/kv";
import { VOID_SCHEMA, CotalEndpoint, isDerivedOwner, dialerFor, deprovisionAgent, fenceLifecycleAcl, singleDocumentClosure, dlvDurable, dlvStream, dmDurable, dmStream, isChannelFamily, isConcreteChannel, provisionAgentDurables, contractDigest, contractRefToHex, contractStoreContext, fetchContractArtifact, verifyClusterManifest, verifyClusterRoot, admissionBucket, admissionMediatorGrants, assertDerivedOwnerToken, assertLifecycleToken, assertValidOwnerToken, EpEnvelopeError, ensureAuthorityStores, epAuthBucket, mintCreds, mintPublicUserJwt, newIdentity, newTakeoverId, openRecordsBucket, parseEndpointGate, parseServiceSpec, readCheckpointStatus, readRunAdmission, readRunRevocation, readRunRecord, readSvcRecordLeader, replayRunJournal, recordSpecKey, RECORD_KINDS, remoteManagerServePrincipal, retirementFrontierStreams, runDriverCaller, serveIssuanceGateKv, standaloneConnectOpts, STANDING_RENEWABLE_TTL_SEC, withIssuerSession, holdIssuerSession, parseActorLedgerSource, type IssuedSourceRef, type IssuerSession, contractArtifactCanonicalBytes, DEV_OWNER, mintLifecycleUid, principalKey, publishContractArtifact, registerServiceInstance, registerServingInstance, type EpErrorCode, type RemoteManagedAgentEnrollmentRequest, type RemoteManagedAgentEnrollmentResult, type RemoteManagerAdminAuthorizationRequest, type RemoteManagerAuthorityRequest, type RemoteManagerMaintenanceRequest, type RemoteRetainedAgentValidationRequest, type SecretStore, type SpaceAuth, type EpServeGrant, parseServiceAuthorityEnvelope, SERVICE_AUTHORITY_MAX_BYTES, parseServiceRegistrationWitness, serviceWitnessDigest, type ServiceAuthorityRequest, type ServiceRegistrationWitness } from "@cotal-ai/core";
import { createAuthInstanceIdentity, type ManagerInstanceIdentity } from "@cotal-ai/workspace";
import { decodeJwt } from "jose";
import { deriveOwnerForIdpSubject } from "./derive.js";
import { requireManagerAuthorityHolder, type ManagerAuthorityHolder } from "./platform-control.js";
import { OwnedConnections, type AuthNativeConnection, type AuthServiceClosed } from "./owned-connections.js";
import { calloutAuthority, managerGateReads } from "./callout-authority.js";
import { ConnectLimiter } from "./connect-limit.js";
import { verifyIdpToken, verifyToolResultHumanProof, type IdpBridge } from "./idp.js";
import { validateUserToken } from "./token.js";
import { pinnedJwksResolver, type UserTokenIssuer } from "./issuer.js";
import { bootstrapServiceCallerPayload, type ServiceCallerPayloadBootstrap } from "./service-caller-payload-bootstrap.js";
import { handleRemoteRunCancel, parseRemoteRunCancelRequest, admitRemoteRun, handleRemoteRunSubmission, authorizeRemoteRunAttempt, observedRunRequest, parseRemoteRunAdmissionRequest, parseRemoteRunAttemptRequest, parseRemoteRunRevokeRequest, revokeRemoteRun, type ObservedRunRequest } from "./manager-authority.js";
import { authorizeRemoteManagerGoalIndexScan, completeRemoteManagerGoalIndexScan } from "./manager-goal-index.js";
import { authorizeRemoteManagerAdmin } from "./manager-admin-authorization.js";
import { authorizeRemoteManagerParticipation } from "./manager-participation-authorization.js";
import { parseRemoteEndpointDeregisterRequest } from "@cotal-ai/core";
import { remoteManagerSurface, type ManagerCluster } from "./manager-contract.js";
import { authorityBarrierGrants, authorityWriterGrants, openAuthorityClient, openSupervisedConnectReader, remoteManagerIssuerGrants, registrationExecutorGrants, servedRunRequestSubjects, servedRunCancelRequestSubject, servedSpawnRequestSubjects, serviceCalloutWriterGrants, serviceHostDiscoveryGrants, type AuthorityClient } from "./authority-client.js";
import { createNativeServiceCalloutAuthority, type NativeServiceCalloutAuthority } from "./native-service-callout.js";
import { openChatSessionAuthority } from "./chat-session-authority.js";
import { CorruptNativeIssuanceEvidence, pruneNativeIssuance } from "./native-issuance.js";
import { ensureRootCredential } from "./root-credential.js";
import { activateLifecycleAtUid, observeGate, openLifecycleRegistry, readLifecycleHeadForOperation, type LifecycleRegistry } from "./lifecycle-registry.js";
import { parseServiceHostRequest, type ServiceEndpointHost } from "./service-host-contract.js";
import { openServiceHostEffect, openServiceHostOperations, type ServiceHostEffect, type ServiceHostEffectScope, type ServiceHostOperations, type ServiceHostOperationsOptions } from "./service-host-ops.js";
import { S2A_INVOCATION_MS } from "./service-host-kernel.js";
import { SERVICE_ENDPOINT_AUTHORITY_PATH, SERVICE_ENDPOINT_HOST_PATH, answerServiceAuthority, serviceAuthorityDenied, serviceAuthorityInfo, serviceHostGranterFor, type ServiceAuthorityCaller, type ServiceAuthorityDoor } from "./service-endpoint-authority.js";
import { validateServiceRenewalProof } from "./service-renewal.js";
import { openAuthLedgerScannerCandidate } from "./ledger-scanner.js";
import { openRecordsScannerCandidate } from "./records-scanner.js";
import { acquirePlaneClaim, makeDeliveryAdminPlaneOracle, scannerDeathCopy, planeClaimRefusal, type PlaneClaimHold, type PlaneLivenessOracle } from "./plane-claim.js";
import { enumerateOperationIntents, resumeAgentTakeover, type EvictPrincipal } from "./credential-ledger.js";
import { makeDeliveryAdminEvictor } from "./barrier-evict.js";
import { withDeliveryAdminEndpoint } from "./delivery-admin.js";
import { resumeAgentRetirement, runAgentRetirementBarrier, type RetirementDeps } from "./retirement-barrier.js";
import { makeRetirementCleaners } from "./retirement-cleaner.js";
import { makeDrainRepairers } from "./drain-repair.js";
import { serializedFor } from "./serialized.js";
import { RunCancelObservations, type RunCancelLimits } from "./run-cancel-observation.js";
import { jitteredBackoffMs, readCancellationAdmission, type RunDelegation } from "@cotal-ai/core";
import { joinOrStartRetirement, openAuthAdminListener, type RetirementFlights } from "./auth-admin.js";
import { registerSelfAuthorizedInstance } from "./service-registration.js";
import { openAuthRegistry } from "./registry-host.js";
import { type RegistryService } from "@cotal-ai/core";
import { AUTH_SERVICE_ENDPOINT, authClusterArtifacts, authContractArtifactValues } from "./auth-service-contract.js";
import { drainTargetForEndpoint, openAdmissionMediator } from "./admission-mediator.js";
import {
  assertWithinRunDelegation,
  assertWithinSpawnerGrant,
  findInteractiveActor,
  findManagedActor,
  findActorUnified,
  ledgerActorSourceIsLive,
  ledgerAuthorizeGrant,
  revokeManagedActorIf,
  withManagedGrantTransaction,
} from "./ledger.js";
import {
  AUTH_PROVIDER_NAME,
  claimAuthInstanceIdentity,
  dataAccountAuth,
  type ServiceKeys,
} from "./store.js";
import { managedRetirementAuthority } from "./service-managed-retirement.js";
export { authServiceConfiguration, parseAuthHostManifest, checkAdvertisedServer, checkAgentProvisioningUrl } from "./service-config.js";
export type { AuthHostEntry, PublicFaceInput } from "./service-config.js";
export type { AuthAuthorityPlane } from "./service-plane-types.js";
import type { AuthAuthorityPlane } from "./service-plane-types.js";
import { managerIssuanceAuthority } from "./service-manager-issuance.js";
export { authorizeRemoteManagerRetirement } from "./service-manager-issuance.js";
import { managedAgentAuthority } from "./service-managed-agents.js";


/** JWKS max-age seconds — the cache contract's knob. Exported so a rotation tool can compute the
 *  retire floor (max-age + max bearer TTL) from it. */
export const JWKS_MAX_AGE_SEC = 300;

/** Loopback-only operator route used by `cotal actor grant/revoke` before rotating or deleting an interactive lifecycle. */
export const INTERACTIVE_RETIRE_PATH = "/interactive-lifecycle/retire";

/** The user-mode chat-session routes, on the loopback face (capability-gated) and the public face.
 *  Each takes a fresh IdP proof; `bearer` and `retire` also take the session's holder proof. */
export const CHAT_SESSION_PATHS = Object.freeze({ open: "/chat-session/open", bearer: "/chat-session/bearer", retire: "/chat-session/retire" } as const);

/** Loopback-only host route that finishes a managed lifecycle's terminal retirement after the host
 *  revoked its grant, when the remote manager that should have requested it is gone (#2070). */
export const MANAGED_RETIRE_PATH = "/managed-lifecycle/retire";

/** Loopback-only host route that asks this assigned account authority to activate one exact managed
 *  lifecycle at its issued UID. The request repeats the assigned account key so a host that selects
 *  the wrong account authority fails before lifecycle mutation (#5214). */
export const MANAGED_ACTIVATE_PATH = "/managed-lifecycle/activate";

/** The closed request accepted by {@link MANAGED_ACTIVATE_PATH}. */
export interface ManagedLifecycleActivationRequest {
  readonly accountPublicKey: string;
  readonly owner: string;
  readonly actor: string;
  readonly lifecycleUid: string;
}

/** A completed exact activation. HTTP refusals use the native `{ error, code, outcome, details? }`
 *  shape instead, so this result never reports an activation the authority did not complete. */
export interface ManagedLifecycleActivationResult extends ManagedLifecycleActivationRequest {
  readonly activated: true;
}

/** Loopback-only host route a platform calls BEFORE it enrolls or releases a managed agent for a
 *  remote manager (#1972 §2.2). The platform owns the writers; this door owns the decision. It
 *  derives the caller's scope from the local ledger and never accepts one from the caller. */
export const VERIFY_ENROLLMENT_PATH = "/manager-service-authority/verify-enrollment";

/** Host-only, capability-gated proof decision. It neither signs consent nor serves results. */
export const TOOL_RESULT_HUMAN_PROOF_PATH = "/tool-result-human-proof/verify";

/** Host-only signed consent issuance, never private result content. */
export const TOOL_RESULT_CONSENT_PATH = "/tool-result-consent/issue";
const PUBLIC_MAX_IN_FLIGHT = 64; // global concurrent-admission cap on the public listener
export const PUBLIC_DEADLINE_MS = 10_000; // hard wall-clock deadline per public request
export const HOST_FENCE_POLL_MS = 1_000; // how often awaitHostFence re-reads the host gate
const OBSERVED_RUN_REQUEST_WINDOW_MS = 5 * 60_000; // how long an observed served run request can still be forwarded

/** Enrollment and retirement preparation of one managed agent run one at a time, so neither acts on
 *  a grant the other is still writing or releasing. The chain lives at module level, keyed by the
 *  ledger directory, so two plane instances over one ledger share it. */
const MANAGED_ALIAS_CHAINS = new Map<string, Promise<unknown>>();
const serializedForAlias = <T>(dir: string, owner: string, actor: string, fn: () => Promise<T>): Promise<T> =>
  serializedFor(MANAGED_ALIAS_CHAINS, `${resolve(dir)}:${principalKey(owner, actor).key}`, fn);

/** Which exchange arm asks for a manager-caller view. */
export type ManagerCaller = "human" | "agent";

/** How each caller names one manager instance, for the refusal that needs it to. The agent arm's
 *  one client is `cotal agent-bearer`; a connector that runs it for a tool renames the flag to the
 *  tool's `instance` argument. */
const MANAGER_PIN_REMEDY: Record<ManagerCaller | "wire", string> = {
  human: "name one with --on <instanceId>",
  agent: "name one with --manager-instance <instanceId>",
  wire: "name one as managerInstanceId",
};

/** One Manager instance of an owner, as `/manager-instances` lists it. `state` is the verdict
 *  selection reads: `candidate` is an open gate of this owner whose current service registration and
 *  status match the gate's registration revision and process epoch. That is registration evidence,
 *  not proof the instance answers now; a describe pinned to the instance proves that. */
export interface ManagerInstanceRecord {
  instanceId: string;
  /** `remote` is an owner-registered Manager (`cotal manager start`); `local` is this host's own. */
  placement: "remote" | "local";
  state: "candidate" | "unknown" | "not open" | "not this owner's" | "not registered";
}

/** Every Manager gate of one owner at one scan. A failed scan is an error, never a partial list. */
export interface ManagerInstanceCatalog {
  v: 1;
  owner: string;
  complete: true;
  instances: ManagerInstanceRecord[];
}

/** Trusted composition policy for unpinned interactive manager-caller requests. No request or CLI
 *  flag sets it. The local-primary policy refuses an unavailable local Manager without substitution. */
export interface AuthServiceRuntimeOptions {
  /** Trusted space restriction applied to every native payload publish grant. */
  eventPayloadsWithheld?: boolean;
  interactiveManagerSelection?: "local-primary";
  /** Process-lifetime cancellation custody quotas. No eviction or automatic restart on exhaustion. */
  runCancelLimits?: RunCancelLimits;
  /** Default off. The composition root supplies the registry data plane; auth retains its authority. */
  registry?: RegistryService;
  /** Trusted-host only, 5..900 seconds. The native credential source owns renewal. */
  registryCredentialTtlSeconds?: number;
}

export function runtimeSelection(options: AuthServiceRuntimeOptions): AuthServiceRuntimeOptions["interactiveManagerSelection"] {
  if (!options || typeof options !== "object" || Array.isArray(options))
    throw new Error("auth-service runtime options must be an object");
  const selection = options.interactiveManagerSelection;
  if (options.eventPayloadsWithheld !== undefined && typeof options.eventPayloadsWithheld !== "boolean")
    throw new Error("eventPayloadsWithheld must be a boolean when present");
  if (selection !== undefined && selection !== "local-primary")
    throw new Error('interactiveManagerSelection must be "local-primary" when present');
  return selection;
}

/** Inputs to the sealed authority-plane composition. */
export interface OpenAuthAuthorityPlaneOptions extends AuthServiceRuntimeOptions {
  server: string;
  space: string;
  /** The provider state dir — the file-ledger connect arm reads it fresh per connect. */
  dir: string;
  /** The root whose space segment keeps the plane's restart identity: a CLI composition's workspace
   *  root. Never derived from `dir`, which for the CLI sits inside the `.cotal/auth` an operator
   *  copies to another root. With `identityStore`, the state dir an earlier release kept it under. */
  identityRoot: string;
  /** A hosted context's injected store, which then keeps the restart identity with the other auth
   *  secret kinds: its serve seed is a private key. */
  identityStore?: SecretStore;
  /** Required with registry. Explicit on both CLI and hosted paths; no ambient store is discovered. */
  registryStore?: SecretStore;
  dataAccount: ServiceKeys["dataAccount"];
  log: (line: string) => void;
  /** SMOKE-ONLY eviction override for the barrier executor's boot resume. Production
   *  compositions never set this: the real capability is the delivery daemon's
   *  `ctl.delivery-admin` rail ({@link makeDeliveryAdminEvictor}). */
  probeEvictor?: EvictPrincipal;
  /** SMOKE-ONLY plane-liveness override for the plane claim's stale-reclaim adjudication.
   *  Production compositions never set this: the real oracle is the delivery daemon's
   *  `ctl.delivery-admin` rail ({@link makeDeliveryAdminPlaneOracle}). */
  probePlaneOracle?: PlaneLivenessOracle;
  /** SMOKE-ONLY scanner-death injector: receives kill switches for the two plane-owned scanner
   *  connections so a test can force the mid-life fencing path (a non-reconnecting connection has
   *  no natural failure to inject). Production compositions never set this. */
  probePlaneDeath?: (kill: { ledger: () => Promise<void>; records: () => Promise<void> }) => void;
  /** The composition's local manager instance, read per selection. The plane never resolves a
   *  workspace root itself: the CLI wrapper passes its root's persisted identity, and a hosted
   *  context passes none, so only remote manager gates can be candidates. Absent means none. */
  localManager?: () => ManagerInstanceIdentity | undefined;
  /** Bounded trusted-host-only standing renewable credential TTL option for rehearsal (default 24h). */
  standingRenewableTtlSeconds?: number;
  /** Bounded trusted-host-only TTL of the held issuer session's credential, 5..300 seconds (default
   *  the `issuer` profile's five minutes). */
  issuerSessionTtlSeconds?: number;
  /** Delay between completed native-issuance cleanup walks (default 60 s). Startup reads at most
   *  one historical row, then continues in bounded background batches. */
  nativeIssuancePruneMs?: number;
  /** How often one bounded chat-session sweep pass runs (default 60 s). */
  chatSweepMs?: number;
  /** Default off. Present: the plane also opens the service endpoint host over its own plane claim
   *  hold, account and actor ledger. `startup` is required and only `normal` is supported; a restore
   *  or a missing startup refuses the whole open. Absent: no engine, no discovery connection and no
   *  admission write. `callerPayload` explicitly enables actual standalone-broker payload bootstrap
   *  from fresh host-only VARZ observer credentials; omission never enables positive caller issuance. */
  serviceEndpoints?: { startup: NonNullable<ServiceHostOperationsOptions["startup"]>; callerPayload?: ServiceCallerPayloadBootstrap };
  /** SMOKE-ONLY service host hooks: the discovery registry with a kill switch for its connection,
   *  and each effect after it opens and before the engine uses it. Production compositions never
   *  set this. */
  probeServiceHost?: {
    discovery?: (d: { registry: LifecycleRegistry; kill: () => Promise<void> }) => void | Promise<void>;
    effect?: (effect: ServiceHostEffect, scope: ServiceHostEffectScope) => void | Promise<void>;
  };
}

/** The standalone data-account plane's local connection custody, without a callout or HTTP face. */
export interface AuthAuthorityPlaneHandle extends AuthAuthorityPlane {
  /** Tracked live-client bindings only. A host compares these with a complete native account census;
   * the list alone proves neither liveness nor absence of other connections or issuers. */
  nativeConnections(): AuthNativeConnection[];
  /** Resolves only after successful plane-close ordering and all tracked connections have ended. */
  readonly closed: Promise<AuthServiceClosed>;
}

/**
 * Open the authority plane — the PRODUCTION connect/exchange composition (exported so the live
 * deny-new smoke exercises exactly what the daemon runs). Boot order is the readiness contract:
 * the MINT WRITER connects first and ensures both authority stores exist with their normative
 * shape ({@link ensureAuthorityStores}; the reader's bind proof requires them), then the
 * lifecycle registry binds (its own §13.12 shape proof), then the supervised CONNECT READER
 * binds + proves. Any failure throws — the daemon refuses to come up rather than serving
 * connects it cannot credential-check (no file-only fallback).
 *
 * These are STATIC data-account users (signed by the data-account signing key), so they never
 * transit the auth callout — the callout cannot deadlock on its own reader.
 */
export async function openAuthAuthorityPlane(opts: OpenAuthAuthorityPlaneOptions): Promise<AuthAuthorityPlaneHandle> {
  const owned = new OwnedConnections();
  let plane: AuthAuthorityPlane;
  try {
    plane = await openAuthAuthorityPlaneWithCustody(opts, (nc, label) => owned.track(nc, label));
  } catch (cause) {
    try { await owned.closeRemaining(); owned.complete(); await owned.closed; }
    catch (cleanup) { throw new AggregateError([cause, cleanup], "auth authority open failed and its connections did not close"); }
    throw cause;
  }
  return {
    ...plane,
    nativeConnections: () => owned.nativeConnections(),
    closed: owned.closed,
    close: async () => {
      await plane.close();
      await owned.closeRemaining();
      owned.complete();
      await owned.closed;
    },
  };
}

/** The hosted door over a plane's service endpoint host: refused before entry unless the context is
 *  ready, and mapped to the same engine so the internal accessor still finds it. */
export function hostedServiceEndpoints(host: ServiceEndpointHost, ready: () => void): ServiceEndpointHost {
  const door: ServiceEndpointHost = async (request) => { ready(); return await host(request); };
  const engine = SERVICE_HOST_ENGINES.get(host), callout = SERVICE_CALLOUTS.get(host);
  if (engine !== undefined) SERVICE_HOST_ENGINES.set(door, engine);
  if (callout !== undefined) SERVICE_CALLOUTS.set(door, callout);
  return door;
}

/** Package-internal (not exported from the package index): the engine behind a plane's service
 *  endpoint host, whose register admission only a later owner-verifying route may call. */
const SERVICE_HOST_ENGINES = new WeakMap<ServiceEndpointHost, ServiceHostOperations>();
export function serviceHostEngineOf(host: ServiceEndpointHost): ServiceHostOperations | undefined {
  return SERVICE_HOST_ENGINES.get(host);
}
/** Package-internal: the native service callout authority composed with a plane's service host. */
const SERVICE_CALLOUTS = new WeakMap<ServiceEndpointHost, NativeServiceCalloutAuthority>();
export function serviceHostCalloutOf(host: ServiceEndpointHost): NativeServiceCalloutAuthority | undefined {
  return SERVICE_CALLOUTS.get(host);
}

/** The context's custody callback is private. Failed construction unwinds from one place. */
export async function openAuthAuthorityPlaneWithCustody(opts: OpenAuthAuthorityPlaneOptions, onConnection?: import("./authority-client.js").AuthorityClientOpts["onConnection"]): Promise<AuthAuthorityPlane> {
  const unwind: (() => Promise<unknown>)[] = [];
  try {
    return await buildAuthAuthorityPlane(opts, unwind, onConnection);
  } catch (e) {
    for (const close of unwind.reverse()) await close();
    throw e;
  }
}

/** The body of the plane opener, which owns the unwind of a failed construction. */
async function buildAuthAuthorityPlane(opts: OpenAuthAuthorityPlaneOptions, unwind: (() => Promise<unknown>)[], onConnection?: import("./authority-client.js").AuthorityClientOpts["onConnection"]): Promise<AuthAuthorityPlane> {
  const interactiveManagerSelection = runtimeSelection(opts);
  if (opts.registry !== undefined && opts.registryStore === undefined)
    throw new Error("auth-service: registry requires an explicitly assigned secret store");
  if (opts.registry === undefined && opts.registryCredentialTtlSeconds !== undefined)
    throw new Error("auth-service: registryCredentialTtlSeconds requires a registry implementation");
  const { server, space, dataAccount, log } = opts;
  const cancelObservations = new RunCancelObservations(space, opts.runCancelLimits);
  const standingTtl = opts.standingRenewableTtlSeconds ?? STANDING_RENEWABLE_TTL_SEC;
  if (!Number.isSafeInteger(standingTtl) || standingTtl < 5 || standingTtl > STANDING_RENEWABLE_TTL_SEC) {
    throw new Error(`standingRenewableTtlSeconds must be an integer between 5 and ${STANDING_RENEWABLE_TTL_SEC} seconds (got ${standingTtl})`);
  }
  // The plane's held issuer session for connect-time issuance (SPEC 13.15). It dials nothing until
  // the first issuance, and closes with the plane: on close, on a fence and on a failed open.
  const issuer = holdIssuerSession({
    servers: server, space, auth: dataAccountAuth(space, dataAccount), tls: false, name: `cotal:auth-issuer:${space}`,
    ...(opts.issuerSessionTtlSeconds !== undefined ? { ttlSeconds: opts.issuerSessionTtlSeconds } : {}),
  });
  unwind.push(() => issuer.close());
  const writer = await openAuthorityClient({ onConnection, server, space, dataAccount, label: `cotal:auth-mint:${space}`, grants: (id) => authorityWriterGrants(space, id), log });
  unwind.push(() => writer.close());
  await ensureAuthorityStores(await jetstreamManager(writer.nc), new Kvm(writer.nc), space);
  const registry = await openLifecycleRegistry(writer.nc, space);
  // #399 M2: register the auth plane itself as an ordinary `auth` service endpoint — the SAME
  // §13.7 registration ceremony the manager runs (`manager.ts:6562-6690`), before the listener
  // below serves a single request. The persisted instance id + serve nkey (in `identityRoot`,
  // hardened the way the manager's own instance identity is, or in a hosted context's store) so a
  // restart re-registers the SAME instance: `registerServiceInstance` advances the process epoch
  // on a re-registration and fences the predecessor; a first registration stays at epoch 0.
  let authServeInstanceId: string;
  let authServeGrant: EpServeGrant;
  {
    const mint = () => ({ instanceId: mintLifecycleUid(), serveIdentity: newIdentity() });
    const authIdentity = opts.identityStore
      ? await claimAuthInstanceIdentity(opts.identityStore, space, opts.identityRoot, mint)
      : createAuthInstanceIdentity(opts.identityRoot, space, mint);
    const iid = authIdentity.instanceId;
    const artifacts = authClusterArtifacts();
    const values = [...authContractArtifactValues(), artifacts.document, artifacts.manifest];
    const regClient = await openAuthorityClient({ onConnection,
      server, space, dataAccount, label: `cotal:auth-registration:${space}`,
      grants: (id) => registrationExecutorGrants(space, id, AUTH_SERVICE_ENDPOINT, iid),
      log,
    });
    try {
      const { grant } = await registerSelfAuthorizedInstance(regClient.nc, {
        space, endpoint: AUTH_SERVICE_ENDPOINT, instanceId: iid,
        principal: principalKey(DEV_OWNER, authIdentity.serveIdentity.id).key,
        clusterDigest: artifacts.closureDigest, artifacts: values,
      }, registerServingInstance);
      authServeInstanceId = iid;
      authServeGrant = grant;
    } finally {
      await regClient.close();
    }
  }
  const reader = await openSupervisedConnectReader({ onConnection, server, space, dataAccount, log });
  unwind.push(() => reader.close());
  // The typed remote-manager issuer is a distinct self-minted connection. It adds only the
  // endpoint-manager gate/credential family to the root issuance surface and is never exposed as
  // a generic mint endpoint. Its JWTs are signed for caller-generated public nkeys; private seeds
  // stay on the participant machine.
  const remoteIssuer = await openAuthorityClient({ onConnection, server, space, dataAccount, label: `cotal:remote-manager-issuer:${space}`, grants: (id) => remoteManagerIssuerGrants(space, id), log });
  unwind.push(() => remoteIssuer.close());

  // The BARRIER EXECUTOR: the third self-minted connection, with its own registry bind — the
  // mint writer stays the minimal issuance credential ("barriers are NOT this credential's
  // job") and the barrier's stage-write authority lives here alone. The barrier profile holds NO
  // auth-stream `CONSUMER.CREATE` (nats-server#8274): its family/intent/lineage enumeration runs
  // on the SEALED auth-ledger scanner, a FOURTH self-minted connection whose CREATE-capable
  // credential never escapes ({@link openAuthLedgerScannerCandidate}), threaded into the barrier
  // registry. The retirement barrier's OBLIGATION drain (§13.8, records stream) enumerates the
  // same way and for the same #8274 reason: a FIFTH self-minted connection, the SEALED records
  // scanner ({@link openRecordsScannerCandidate}), is opened co-located and threaded into the SAME
  // barrier registry (the ONE records scanner per space the composition owns). The mint-writer
  // registry above carries neither scanner — only the barrier registry enumerates.
  //
  // THE PLANE CLAIM (#29 HIGH 3, SPEC 13.13) gates the whole block: both scanner connections open
  // FIRST as INERT candidates (non-reconnecting, identities captured, no scan capability exists),
  // then the claim is taken by broker-atomic create/CAS on the ONE `plane` auth-KV key. Only the
  // WINNER activates the branded scanners; a loser closes both candidates and this open REFUSES
  // with the operator-legible copy (live peer / inconclusive / concurrent). A stale held claim is
  // reclaimed on LIVENESS ALONE: both claimed tuples conclusively absent under a COMPLETE CONNZ
  // sweep, adjudicated over the delivery-admin rail (auth holds no $SYS). A mid-life scanner
  // disconnect FENCES the plane: the guard refuses every later scan, the sibling closes, and the
  // in-flight enumeration's result is discarded by the post-scan claim check.
  let hold: PlaneClaimHold | undefined;
  let closing = false;
  let closeScanners: Promise<void> | undefined;
  // The plane-fatal channel (fact HIGH: a fenced plane must never keep serving): the mid-life
  // fence resolves it, every authority operation refuses from then on, and the composition root
  // downs the daemon. A clean close never resolves it.
  let fatalReason: string | undefined;
  let registryHost: { refuse(): void; close(): Promise<void> } | undefined;
  const registryFence = new AbortController();
  let settleFatal!: (reason: string) => void;
  const fenced = new Promise<string>((r) => { settleFatal = r; });
  const fireFatal = (reason: string): void => {
    registryFence.abort();
    registryHost?.refuse();
    settleFatal(reason);
  };
  void fenced.then(() => issuer.close());
  const barrier = await openAuthorityClient({ onConnection, server, space, dataAccount, label: `cotal:auth-barrier:${space}`, grants: (id) => authorityBarrierGrants(space, id), log });
  unwind.push(() => barrier.close());
  // Unwound after both scanners close: held → released is valid only once neither scanner can act.
  // A failed open throws its own error, so a release failing on the way out is only logged: the
  // row stays held and the next open reclaims it like a crash.
  unwind.push(async () => hold?.release().catch((r: Error) => log(r.message)));
  const ledgerCand = await openAuthLedgerScannerCandidate({ onConnection, server, space, dataAccount, log });
  unwind.push(() => ledgerCand.close());
  const recordsCand = await openRecordsScannerCandidate({ onConnection, server, space, dataAccount, log });
  unwind.push(() => recordsCand.close());
  const oracle = opts.probePlaneOracle ?? makeDeliveryAdminPlaneOracle({ onConnection, space, server, dataAccount, log });
  hold = await acquirePlaneClaim({ nc: barrier.nc, space, ledger: ledgerCand.tuple, records: recordsCand.tuple, oracle, log });
  const scanner = ledgerCand.activate(hold.guard);
  const recordsScanner = recordsCand.activate(hold.guard);
  // Mid-life disconnect = the FENCING event (security req: an owned scanner that dies must not
  // leave the plane half-running). First death wins: fence the guard with the ux state-3 copy,
  // close the sibling so a successor's reclaim isn't blocked by a half-dead pair, log loud.
  let serviceHost: ServiceHostOperations | undefined;
  const fenceOnDeath = (role: "auth-ledger" | "records", sibling: () => Promise<void>) => {
    const copy = scannerDeathCopy(space, role);
    // A closing plane does not go fatal, but a service host call it is still draining stops here.
    if (closing) { serviceHost?.trip(copy); return; }
    hold?.fence(copy);
    fatalReason = fatalReason ?? copy;
    serviceHost?.trip(copy);
    fireFatal(copy);
    log(`auth-plane: ${copy}`);
    void sibling().catch(() => {});
  };
  void ledgerCand.gone.then(() => fenceOnDeath("auth-ledger", () => recordsCand.close()));
  void recordsCand.gone.then(() => fenceOnDeath("records", () => ledgerCand.close()));
  // A failed open closes the scanners deliberately, which must not fence like a mid-life death.
  unwind.push(async () => { closing = true; });
  opts.probePlaneDeath?.({ ledger: () => ledgerCand.close(), records: () => recordsCand.close() });
  const barrierReg = await openLifecycleRegistry(barrier.nc, space, scanner, recordsScanner);
  const evictPrincipal = opts.probeEvictor ?? makeDeliveryAdminEvictor({ onConnection, space, server, dataAccount, log });
  // The RETIREMENT deps (#29 piece 4): the barrier's injected mechanics, assembled from reviewed
  // §13.9 profiles only. The obligation drain runs per endpoint on a SHORT-LIVED client minted
  // with that endpoint's admission-mediator profile (the daemon owns no standing mediator; the
  // drain is the first production mediator composition), sharing the plane's ONE sealed records
  // scanner. The per-op cleaner/executor credentials come from the piece-2 split factory.
  //
  // THE CONFINED DRAIN REPAIRERS (#29 HIGH 1 functional closure): the mediator hands CLOSED,
  // already-validated repair commands; the per-op executors ({@link makeDrainRepairers}) mint an
  // exact-coordinate credential per repair, execute, and close. Covered classes now COMPLETE on
  // resume instead of freezing: an accepted self-commit re-applies (or classifies landed /
  // superseded), an accepted pool route re-enqueues create-only. THREE distinct operator
  // outcomes (ux):
  //  1. auto-completed - the retirement finishes; the repair is logged, no freeze message;
  //  2. a covered-class repair that still cannot land names its SPECIFIC reason (an out-of-class
  //     commit key refuses in the executor with the confused-deputy copy; a CAS loss reports
  //     "another writer moved the record" and the next pass re-classifies);
  //  3. accepted EFFECTS work terminalizes through the RETIREMENT-CANCEL terminal (§13.8 option
  //     (i)): a first-terminal-wins cancelled marker on the SAME completion coordinate — an
  //     action's goal union already carries the first-class `cancelled` state, a non-action
  //     effect gets the EffectCancelledFact union member. Never a forged success: a reader sees
  //     the effect did NOT run and which retirement cancelled it; a racing real completion wins
  //     by landing first.
  const repairers = makeDrainRepairers({ onConnection, server, space, dataAccount, log });
  const retirement: RetirementDeps = {
    evictPrincipal,
    drainTargetObligations: async (endpoint, targetUid, opId) => {
      const drain = await openAuthorityClient({ onConnection,
        server, space, dataAccount,
        label: `cotal:ep-drain:${space}:${endpoint}`,
        grants: (id) => admissionMediatorGrants(space, endpoint, id),
        log,
      });
      try {
        await drainTargetForEndpoint(await openAdmissionMediator(drain.nc, space, endpoint, { recordsScanner }), targetUid, {
          applyCommit: repairers.applyCommitFor(opId),
          reconcilePoolRoute: repairers.reconcilePoolRouteFor(opId),
          cancelEffectsRoute: repairers.cancelEffectsRouteFor(opId),
        });
      } finally {
        await drain.close();
      }
    },
    ...makeRetirementCleaners({ onConnection, server, space, dataAccount, log }),
    now: Date.now,
  };
  // Boot crash-resume BEFORE the plane answers anything (SPEC 13.1): finish every takeover this
  // executor owes from its durable intents. A garbled intent store fails the boot (we cannot
  // know what we owe); an individual resume failure is LOUD but non-fatal — that alias stays
  // frozen (nothing mints for it, fail-closed) while every other alias keeps working, and a
  // later restart re-drives it.
  await resumeOpenOperations(barrierReg, evictPrincipal, retirement, log);
  // ONE in-flight map for the rail and the loopback managed-retire door: both run the same
  // `managedRetirementOpId(uid)` operation, and a process must never execute it twice at once.
  const retirementFlights: RetirementFlights = new Map();
  // The AUTH CONTROL RAIL (#29 piece 3, SPEC 13.2 CONTROL_AUTH_ADMIN): serve the generic
  // "retire a lifecycle" op over a dedicated minimal listener credential. Every executing right
  // stays with the plane's own registry + retirement deps (the drain rides the ONE sealed records
  // scanner exactly like the boot resume); the listener only authorizes (subject attribution +
  // the FRESH space-manager-lease holder check) and dispatches.
  const authAdmin = await openAuthAdminListener({ onConnection, server, space, dataAccount, reg: barrierReg, retirement, barrierFlight: retirementFlights, instanceId: authServeInstanceId, epoch: authServeGrant.epoch, grant: authServeGrant, log });
  unwind.push(() => authAdmin.close());
  if (opts.registry !== undefined) {
    unwind.push(async () => { await registryHost?.close(); });
    await openAuthRegistry({
      server, space, dataAccount, log, onConnection, store: opts.registryStore!,
      implementation: opts.registry, signal: registryFence.signal,
      ...(opts.registryCredentialTtlSeconds !== undefined ? { ttlSeconds: opts.registryCredentialTtlSeconds } : {}),
      onCustody: (handle) => { registryHost = handle; },
      onFailure: (reason) => {
        if (closing) return;
        hold?.fence(reason);
        fatalReason ??= reason;
        serviceHost?.trip(reason);
        fireFatal(reason);
        log(`auth-plane: ${reason}`);
      },
    });
  }
  const recordToolResultConsent = makeToolResultConsentRecorder(registryStores(registry).authKv, () => refuseIfFenced(), space);
  // Check at most one row before opening. Continue historical cleanup in bounded batches so
  // retained service receipts cannot delay HTTP readiness or make close drain the whole history.
  // Corrupt evidence refuses this open if seen here, or fences the plane when a continuation
  // reaches it. Transient store failures keep the cursor and retry with capped jittered backoff.
  const pruneMs = opts.nativeIssuancePruneMs ?? 60_000;
  if (!Number.isSafeInteger(pruneMs) || pruneMs < 100 || pruneMs > 3_600_000)
    throw new Error(`nativeIssuancePruneMs must be an integer between 100 and 3600000 (got ${pruneMs})`);
  let pruneFailures = 0;
  const pruneRetryMs = (e: unknown): number => {
    if (pruneFailures === 0)
      log(`auth-plane: native-issuance cleanup failed (${e instanceof Error ? e.message : String(e)}) - retrying with backoff; expired evidence stays until a pass succeeds`);
    return jitteredBackoffMs(pruneFailures++, Math.min(pruneMs, 1_000), 60_000);
  };
  const pruneAbort = new AbortController();
  let pruneSeq = 1;
  const pruneBatch = async (maxRows: number): Promise<number> => {
    const result = await pruneNativeIssuance(registry, Math.floor(Date.now() / 1000), {
      seq: pruneSeq, maxRows, signal: pruneAbort.signal,
    });
    pruneSeq = result.nextSeq ?? 1;
    return result.nextSeq === undefined ? pruneMs : 0;
  };
  let firstPruneMs: number;
  try {
    firstPruneMs = await pruneBatch(1);
  } catch (e) {
    if (e instanceof CorruptNativeIssuanceEvidence) throw e;
    firstPruneMs = pruneRetryMs(e);
  }
  let pruneTimer: ReturnType<typeof setTimeout> | undefined;
  let pruneFlight: Promise<void> = Promise.resolve();
  const schedulePrune = (delayMs: number): void => {
    if (closing || fatalReason !== undefined) return;
    pruneTimer = setTimeout(() => {
      pruneFlight = pruneBatch(64).then((nextMs) => {
        pruneFailures = 0;
        schedulePrune(nextMs);
      }, (e: unknown) => {
        if (!(e instanceof CorruptNativeIssuanceEvidence)) {
          if (!closing) schedulePrune(pruneRetryMs(e));
          return;
        }
        const copy = `native-issuance cleanup failed: ${e.message}`;
        // As for a scanner death: a closing plane does not go fatal, but a call it is draining stops.
        if (closing) { serviceHost?.trip(copy); return; }
        hold?.fence(copy);
        fatalReason = fatalReason ?? copy;
        serviceHost?.trip(copy);
        fireFatal(copy);
        log(`auth-plane: ${copy}`);
      });
    }, delayMs);
  };
  const stopPrune = async (): Promise<void> => {
    clearTimeout(pruneTimer);
    pruneAbort.abort();
    await pruneFlight;
  };
  unwind.push(async () => { closing = true; await stopPrune(); });
  schedulePrune(firstPruneMs);
  // The service endpoint host, default off. Its discovery client only reads, on the ordinary
  // renewing profile: a broker loss makes its reads fail until it reconnects, and a renewal failure
  // closes it for good, after which decide and revoke answer unavailable until the plane is opened
  // again. The engine shares this plane's hold; both fatal sites above trip it.
  let discoveryClient: AuthorityClient | undefined, calloutWriter: AuthorityClient | undefined;
  // Every effect connection the host opened whose close has not succeeded, kept past its call's
  // settlement: plane close and a failed construction close it again and fail while any remains.
  const openEffects = new Set<ServiceHostEffect>();
  const closeEffects = async (): Promise<void> => {
    const failed: unknown[] = [];
    for (const e of [...openEffects]) {
      try { await e.close(); } catch (err) { failed.push(err); }
    }
    if (failed.length > 0) throw new AggregateError(failed, `${failed.length} service host effect connection(s) did not close`);
  };
  let verifyCallerPayload: (() => Promise<void>) | undefined;
  const payloadFlights = new Set<Promise<void>>();
  const checkCallerPayload = async (): Promise<void> => {
    refuseIfFenced();
    const flight = verifyCallerPayload!();
    payloadFlights.add(flight);
    try { await flight; refuseIfFenced(); }
    finally { payloadFlights.delete(flight); }
  };
  const drainCallerPayload = async () => { await Promise.allSettled([...payloadFlights]); };
  unwind.push(drainCallerPayload);
  if (opts.serviceEndpoints !== undefined) {
    const label = `cotal:service-host-discovery:${space}`;
    const d = discoveryClient = await openAuthorityClient({ onConnection, server, space, dataAccount, label, grants: (id) => serviceHostDiscoveryGrants(space, id), log,
      onRenewalFailure: () => {
        log(`${label}: credential renewal failed - service host discovery is closed until the auth plane is opened again`);
        void discoveryClient?.close().catch(() => {});
      } });
    unwind.push(() => d.close());
    unwind.push(() => closeEffects());
    const discovery = await openLifecycleRegistry(d.nc, space);
    await opts.probeServiceHost?.discovery?.({ registry: discovery, kill: () => d.close() });
    const probeEffect = opts.probeServiceHost?.effect;
    // Serving reads registered closures from the contract store on the issuer's connection, which
    // holds only the store's exact-subject Direct Get.
    const contractStore = await contractStoreContext(remoteIssuer.nc, space);
    const readContractArtifact = async (digest: string): Promise<unknown> => {
      const bytes = await fetchContractArtifact(contractStore, contractRefToHex(digest));
      if (!bytes) throw new EpEnvelopeError("failed-precondition", `the registered contract artifact ${digest} is not readable`);
      return JSON.parse(new TextDecoder().decode(bytes));
    };
    const engine = await openServiceHostOperations({
      discovery, hold: hold!, accountPublicKey: dataAccount.pub, ledgerDir: opts.dir, startup: opts.serviceEndpoints.startup,
      serving: { readContractArtifact },
      openEffect: async (scope) => {
        const opened = await openServiceHostEffect({ onConnection, server, space, dataAccount, log }, scope);
        const effect: ServiceHostEffect = { ...opened, close: async () => { await opened.close(); openEffects.delete(effect); } };
        openEffects.add(effect);
        if (probeEffect !== undefined) {
          try { await probeEffect(effect, scope); } catch (e) { await effect.close().catch(() => {}); throw e; }
        }
        return effect;
      },
    });
    unwind.push(() => engine.close());
    if (opts.serviceEndpoints.callerPayload !== undefined) {
      verifyCallerPayload = await bootstrapServiceCallerPayload({ onConnection, registry: discovery, hold: hold!, servers: server,
        accountPublicKey: dataAccount.pub, dataAccount, source: opts.serviceEndpoints.callerPayload });
    }
    // The canonical void closure (SPEC 13.7) is the host's to publish: every payload-free command
    // names it, and a registration that submitted only its cluster closures resolves against it.
    // Create-only under an effect scoped to exactly these two artifacts; a store that holds them
    // already answers without a write.
    await publishCanonicalVoidClosure({ onConnection, server, space, dataAccount, log });
    serviceHost = engine;
    SERVICE_HOST_ENGINES.set(engine.handle, engine);
    // A fence while the engine was opening latches it now.
    if (fatalReason !== undefined) engine.trip(fatalReason);
    // The native service callout: a service bearer's connect mints only for the current bound
    // assignment its witness names, read from the engine, on a writer that stages and touches the
    // endpoint gate and credential rows. A fenced plane or a latched engine refuses it.
    const calloutLabel = `cotal:service-callout:${space}`;
    const cw = calloutWriter = await openAuthorityClient({ onConnection, server, space, dataAccount, label: calloutLabel, grants: (id) => serviceCalloutWriterGrants(space, id), log });
    unwind.push(() => cw.close());
    SERVICE_CALLOUTS.set(engine.handle, createNativeServiceCalloutAuthority({
      registry: await openLifecycleRegistry(cw.nc, space), reader: () => reader.current(), dataAccount,
      resolveAssignment: (witness) => engine.serviceBinding(witness), readClusterArtifact: readContractArtifact, assertOpen: () => refuseIfFenced(),
    }));
  }
  const recordsJsm = await jetstreamManager(remoteIssuer.nc);
  const authKv = await new Kvm(remoteIssuer.nc).open(epAuthBucket(space));
  const managerIssuanceGate = (instanceId: string) => serveIssuanceGateKv(authKv, space, { endpoint: "manager", instanceId });
  const loadLocalManager = opts.localManager ?? (() => undefined);
  const gateReads = managerGateReads({ space, authKv, recordsJsm, localManager: loadLocalManager });
  const { observeManagerGate, observeLegacyManagerGate, managerGate } = gateReads;
  // Standing renewal and a served resume or answer read the manager surface from the REGISTERED
  // service spec at the gate's registration revision: spec (leader read) -> closure manifest -> root
  // document, each verified against its content digest. The request never selects the surface.
  const registeredManagerCluster = async (owner: string, instanceId: string, observed: { registrationRevision: number }): Promise<ManagerCluster> => {
    const rec = await readSvcRecordLeader(recordsJsm, space, recordSpecKey(RECORD_KINDS.svc, ["manager", instanceId]));
    if (!rec || "deleted" in rec || rec.revision !== observed.registrationRevision)
      throw new EpEnvelopeError("failed-precondition", "found no manager service spec at the gate's registration revision");
    const spec = parseServiceSpec(rec.value, { endpoint: "manager" });
    if (spec.owner !== owner)
      throw new EpEnvelopeError("permission-denied", "the manager service spec belongs to another owner");
    const store = await contractStoreContext(remoteIssuer.nc, space);
    const read = async (digest: string): Promise<unknown> => {
      const bytes = await fetchContractArtifact(store, contractRefToHex(digest));
      if (!bytes) throw new EpEnvelopeError("failed-precondition", `cannot read registered manager contract artifact ${digest}`);
      return JSON.parse(new TextDecoder().decode(bytes));
    };
    for (const closure of spec.clusterDigests) {
      const { root } = verifyClusterManifest(closure, await read(closure));
      const raw = await read(root);
      const document = verifyClusterRoot(root, raw);
      if (document.urn === "ai.cotal.manager") return { closureDigest: closure, document, raw };
    }
    throw new EpEnvelopeError("failed-precondition", "the manager service spec registers no manager cluster");
  };
  const listManagerInstances = async (owner: string): Promise<ManagerInstanceCatalog> => {
    refuseIfFenced();
    const instances: ManagerInstanceRecord[] = [];
    const localManager = loadLocalManager();
    for (const raw of await scanner.scanManagerGates()) {
      if (raw.op !== undefined) continue;
      const parts = raw.key.split(".");
      if (parts.length !== 3 || parts[0] !== "epgate" || parts[1] !== "manager")
        throw new EpEnvelopeError("internal", `the manager gate scan returned the malformed key ${raw.key}`);
      const instanceId = assertLifecycleToken(parts[2], "managerInstanceId");
      const row = parseEndpointGate(raw.data, raw.key);
      if (row.authorityFamily === "environment-manager") continue;
      if (row.principal === remoteManagerServePrincipal(owner, instanceId))
        instances.push({ instanceId, placement: "remote", state: await managerGate(owner, instanceId) });
      else if (localManager?.instanceId === instanceId && row.principal === `local.${localManager.serveIdentity.id}`)
        instances.push({ instanceId, placement: "local", state: await managerGate(owner, instanceId) });
    }
    return { v: 1, owner, complete: true, instances };
  };
  const selectManagerInstance = async (owner: string, requested?: string, caller?: ManagerCaller): Promise<string> => {
    refuseIfFenced();
    if (requested !== undefined) {
      const instanceId = assertLifecycleToken(requested, "managerInstanceId");
      const verdict = await managerGate(owner, instanceId);
      if (verdict !== "candidate") throw new Error(`manager instance ${instanceId} is ${verdict}`);
      return instanceId;
    }
    // A trusted host may choose the local Manager up front for human defaults. Explicit pins
    // above and managed-agent calls keep their existing selection; no remote is a substitute.
    if (caller === "human" && interactiveManagerSelection === "local-primary") {
      let local: ManagerInstanceIdentity | undefined;
      try { local = loadLocalManager(); }
      catch { throw new Error("interactive local-primary manager identity could not be read"); }
      if (!local) throw new Error("interactive local-primary manager identity is absent");
      const instanceId = assertLifecycleToken(local.instanceId, "managerInstanceId");
      const verdict = await managerGate(owner, instanceId);
      if (verdict !== "candidate") throw new Error(`interactive local-primary manager instance ${instanceId} is ${verdict}`);
      return instanceId;
    }
    const { instances } = await listManagerInstances(owner);
    const remoteInstances = instances.filter((i) => i.placement === "remote").map((i) => i.instanceId);
    const remoteLive = instances.filter((i) => i.placement === "remote" && i.state === "candidate").map((i) => i.instanceId);
    const localCandidate = instances.findLast((i) => i.placement === "local" && i.state === "candidate")?.instanceId;
    remoteLive.sort();
    if (remoteLive.length === 1) return remoteLive[0];
    if (remoteLive.length > 1)
      throw new ManagerSelectionRefusal(`manager-caller selection found ${remoteLive.length} live remote manager candidates for owner ${owner} (${remoteLive.join(", ")}); exactly one is required, so ${MANAGER_PIN_REMEDY[caller ?? "wire"]}`);
    if (remoteInstances.length > 0)
      throw new ManagerSelectionRefusal(`the remote manager for owner ${owner} is unavailable (${remoteInstances.length} gate${remoteInstances.length === 1 ? "" : "s"}, none live); start one with \`cotal manager start\` and retry, as this call is never routed to the local manager`);
    if (localCandidate !== undefined) return localCandidate;
    throw new ManagerSelectionRefusal(`manager-caller selection found no manager candidate for owner ${owner}`);
  };
  // Every authority operation refuses once the plane is fenced: a half-dead plane keeps NO face up.
  // AUDIENCE SPLIT (ux): these refusals reach a CONNECTING AGENT during the brief fence→exit
  // window, not the operator — the agent cannot "restart the auth service", so it gets a retryable
  // unavailability, while the operator's state-3 copy stays on the log and the exit line.
  const refuseIfFenced = () => {
    if (fatalReason !== undefined || closing)
      throw new EpEnvelopeError("unavailable",
        `the auth service for space "${space}" is momentarily unavailable (it detected a fault and is restarting); retry shortly`);
  };
  const issuerAuth = (): SpaceAuth => dataAccountAuth(space, dataAccount);
  // The source check the issuing host resolves with: an actor-ledger row is attested here, from the
  // ledger this service owns; every other coordinate goes to core's check (SPEC 13.15).
  const composedSourceIsLive = (session: IssuerSession) => (source: IssuedSourceRef): Promise<boolean> =>
    parseActorLedgerSource(source) ? Promise.resolve(ledgerActorSourceIsLive(opts.dir)(source)) : session.sourceIsLive(source);
  // A served run-start is admitted, and a served resume or answer issued, only for a request this
  // host saw its caller publish, and only once; a resume or answer only for what that request's
  // envelope asked (SPEC 14.8): the forward's coordinates are the manager's word. The manager
  // forwards from inside the handler serving the request, so an observation older than the window
  // has no forward left to bind; the window also bounds the table.
  remoteIssuer.nc.subscribe(servedRunCancelRequestSubject(space), {
    callback: (error, message) => {
      if (!error) cancelObservations.observe(message.subject, message.data);
    },
  });
  const observedRunRequests = new Map<string, { expires: number; request: ObservedRunRequest }>();
  for (const subject of servedRunRequestSubjects(space))
    remoteIssuer.nc.subscribe(subject, {
      callback: (_err, msg) => {
        const now = Date.now();
        for (const [seen, { expires }] of observedRunRequests) {
          if (expires > now) break;
          observedRunRequests.delete(seen);
        }
        const request = observedRunRequest(msg.subject, msg.data);
        if (request === undefined) return;
        // Re-inserting keeps the table in expiry order, which the prune above stops on.
        observedRunRequests.delete(msg.subject);
        observedRunRequests.set(msg.subject, { expires: now + OBSERVED_RUN_REQUEST_WINDOW_MS, request });
      },
    });
  // The served spawn requests a hosted enrollment may name (SPEC 13.6). A spawn request's subject
  // carries its caller and a per-call nonce, so it enrolls one helper: the first enrollment that
  // names it takes it for its helper and token digest, and only a retry of that enrollment, naming
  // the same helper under the same digest inside the window, is answered again.
  const observedSpawnRequests = new Map<string, { expires: number; takenBy?: { actor: string; tokenHash: string } }>();
  for (const subject of servedSpawnRequestSubjects(space))
    remoteIssuer.nc.subscribe(subject, {
      callback: (_err, msg) => {
        const now = Date.now();
        for (const [seen, { expires }] of observedSpawnRequests) {
          if (expires > now) break;
          observedSpawnRequests.delete(seen);
        }
        // A subject seen again keeps its first window and its taker.
        if (!observedSpawnRequests.has(msg.subject)) observedSpawnRequests.set(msg.subject, { expires: now + OBSERVED_RUN_REQUEST_WINDOW_MS });
      },
    });
  const takeObservedSpawnRequest = async (subject: string, enrollment: { actor: string; tokenHash: string }): Promise<boolean> => {
    await remoteIssuer.nc.flush();
    const observed = observedSpawnRequests.get(subject);
    if (observed === undefined || observed.expires <= Date.now()) return false;
    observed.takenBy ??= { actor: enrollment.actor, tokenHash: enrollment.tokenHash };
    return observed.takenBy.actor === enrollment.actor && observed.takenBy.tokenHash === enrollment.tokenHash;
  };
  // A run's starter, read from its admission; a revoked run enrolls no helper.
  const readRunStarterAdmission = async (runId: string) => {
    const view = await readRunAdmission(recordsJsm, space, "manager", runId);
    if (view.revoked !== undefined) throw new EpEnvelopeError("permission-denied", `run ${runId} was revoked; a revoked run enrolls no helper`);
    return view.admission;
  };
  // What a run's starter holds in the ledger when the run is admitted: the most its spawns hand on.
  // A starter outside the user ledger, such as a local owner, has no row, so its admission records
  // none and its run hands on nothing.
  const ledgerDelegation = (owner: string, actor: string): RunDelegation | undefined => {
    if (!isDerivedOwner(owner)) return undefined;
    const row = findActorUnified(opts.dir, owner, actor);
    return row && { scope: [...row.scope], allowSubscribe: [...row.allowSubscribe], allowPublish: [...row.allowPublish] };
  };
  const takeObservedRunRequest = async (subject: string): Promise<ObservedRunRequest | undefined> => {
    // The broker queued the request to this connection before the manager could read it, and a
    // flush returns only after this connection has read everything its server queued before it.
    await remoteIssuer.nc.flush();
    const observed = observedRunRequests.get(subject);
    observedRunRequests.delete(subject);
    return observed !== undefined && observed.expires > Date.now() ? observed.request : undefined;
  };
  // A managed lifecycle's broker footprint, released under a deprovisioner pinned to that uid, so
  // no call here can reach a same-name successor's durables. The caller names the grant's concrete
  // channels. A family row, or a row on a channel only a wildcard grants, comes from the delivery
  // daemon's lifecycle-exact inventory, read after the lifecycle's ACL row is fenced, as the
  // manager's teardown does (#5638). An inventory that cannot be read still removes what the caller
  // named, then throws, so the caller's retry removes the rest.
  const deprovisionManagedFootprint = async (owner: string, actor: string, lifecycleUid: string, memberChannels: string[]): Promise<void> => {
    const targetId = principalKey(owner, actor).key;
    const pinned = async (channels: string[]) => await mintCreds(issuerAuth(), newIdentity(), "deprovisioner", { deprovisionTarget: { principal: targetId, lifecycleUid, memberChannels: channels } });
    const channels = new Set(memberChannels);
    const missed: string[] = [];
    try {
      await fenceLifecycleAcl({ servers: server, space, targetId, lifecycleUid, creds: await pinned([]) });
    } catch (e) {
      missed.push(`the ACL fence was not written (${(e as Error).message})`);
    }
    try {
      const r = await withDeliveryAdminEndpoint({ space, server, dataAccount, onConnection }, "endpoint-evictor", "auth-retire-inventory", (ep) =>
        ep.requestDeliveryAdmin("lifecycleMemberships", { principal: targetId, lifecycleUid }, 5_000));
      const listed = r.ok ? (r.data as { complete?: unknown; channels?: unknown } | undefined) : undefined;
      if (listed?.complete !== true || !Array.isArray(listed.channels) || !listed.channels.every((c) => typeof c === "string" && (isConcreteChannel(c) || isChannelFamily(c))))
        missed.push(r.ok ? "the inventory reply is malformed" : `the delivery daemon refused the inventory: ${r.error ?? "(no error copy)"}`);
      else for (const c of listed.channels as string[]) channels.add(c);
    } catch (e) {
      missed.push(`the inventory could not be read (${(e as Error).message})`);
    }
    await deprovisionAgent({ servers: server, space, targetId, lifecycleUid, memberChannels: [...channels], creds: await pinned([...channels]) });
    if (missed.length > 0)
      throw new Error(`membership inventory incomplete (${missed.join("; ")}); rows on channels outside the grant stay for uid ${lifecycleUid}`);
  };
  // A chat session's footprint (admission a7): its DM durable, a DELIVER durable when readable, and the
  // read-ACL row the delivery daemon authorizes its history and durable joins from, written by a
  // short-lived provisioner and read back on that same connection (part of a8).
  const provisionChatFootprint = async ({ owner, actor, lifecycleUid, read }: { owner: string; actor: string; lifecycleUid: string; read: string[] }): Promise<void> => {
    const identity = newIdentity();
    let conn: NatsConnection | undefined;
    const provisioner = new CotalEndpoint({
      space,
      servers: server,
      onConnection: (nc) => { conn = nc; onConnection?.(nc, `cotal:chat-provisioner:${space}`); },
      channels: [],
      creds: await mintCreds(issuerAuth(), identity, "provisioner"),
      card: { id: identity.id, name: "provisioner", role: "provisioner", kind: "endpoint" },
      registerPresence: false,
      watchPresence: false,
      watchChannels: false,
      consume: false,
    });
    await provisioner.start();
    try {
      const resolvedRead = await provisionAgentDurables(provisioner, { owner, actor, lifecycleUid }, { subscribe: [], allowSubscribe: read });
      if (conn === undefined) throw new EpEnvelopeError("unavailable", "the chat provisioner connection is unavailable for the read-back", undefined, "unknown");
      const jsm = await jetstreamManager(conn);
      await jsm.consumers.info(dmStream(space), dmDurable(owner, actor, lifecycleUid));
      if (resolvedRead.length > 0)
        await jsm.consumers.info(dlvStream(space), dlvDurable(owner, actor, lifecycleUid));
      const acl = await provisioner.aclForOwner(principalKey(owner, actor).key, lifecycleUid);
      if (acl === undefined || JSON.stringify(acl) !== JSON.stringify(read))
        throw new EpEnvelopeError("unavailable", `the chat session's read-ACL row did not read back for ${lifecycleUid}`, undefined, "unknown");
    } finally {
      await provisioner.stop();
    }
  };
  const chat = openChatSessionAuthority({
    space,
    dir: opts.dir,
    registry,
    managerInstance: `auth-service:${space}`,
    retireLifecycle: async ({ owner, actor, lifecycleUid, opId }) => {
      const flight = joinOrStartRetirement(retirementFlights, barrierReg, { owner, actor, lifecycleUid, opId, frontierStreams: retirementFrontierStreams(space) }, retirement);
      if (flight === undefined) throw new EpEnvelopeError("conflict", `chat retirement operation ${opId} is already in flight for different coordinates`);
      await flight;
    },
    provisionFootprint: provisionChatFootprint,
    deprovisionFootprint: ({ owner, actor, lifecycleUid, memberChannels }) => deprovisionManagedFootprint(owner, actor, lifecycleUid, memberChannels),
    now: Date.now,
    log,
  });
  // One bounded chat sweep pass per interval. A failed pass is logged and the next one retries; it
  // never fences the plane, because every chat authority decision re-reads its own records.
  const chatSweepMs = opts.chatSweepMs ?? 60_000;
  if (!Number.isSafeInteger(chatSweepMs) || chatSweepMs < 100 || chatSweepMs > 3_600_000)
    throw new Error(`chatSweepMs must be an integer between 100 and 3600000 (got ${chatSweepMs})`);
  let chatSweepTimer: ReturnType<typeof setTimeout> | undefined;
  let chatSweepFlight: Promise<void> = Promise.resolve();
  const scheduleChatSweep = (): void => {
    if (closing || fatalReason !== undefined) return;
    chatSweepTimer = setTimeout(() => {
      chatSweepFlight = chat.sweepPass().catch((e: unknown) => {
        if (!closing) log(`auth-plane: chat sweep pass failed: ${e instanceof Error ? e.message : String(e)}`);
      }).then(scheduleChatSweep);
    }, chatSweepMs);
  };
  const stopChatSweep = async (): Promise<void> => { clearTimeout(chatSweepTimer); await chatSweepFlight; };
  unwind.push(async () => { closing = true; await stopChatSweep(); });
  scheduleChatSweep();
  const managedRetirement = managedRetirementAuthority({
    dir: opts.dir, space, dataAccount, barrierReg, retirement, retirementFlights, observeLegacyManagerGate, refuseIfFenced,
    deprovisionManagedFootprint, serializedForAlias,
  });
  const callout = calloutAuthority({
    space, issuer, dir: opts.dir, dataAccount, registry, reader: () => reader.current(), chat, gate: gateReads, recordsJsm,
    ...(verifyCallerPayload !== undefined ? { checkCallerPayload } : {}),
    refuse: refuseIfFenced,
  });
  return {
    ...callout,
    openChatSession: async (args) => {
      refuseIfFenced();
      return chat.admit(args);
    },
    chatSessionBearer: async (args) => {
      refuseIfFenced();
      return chat.exchange(args);
    },
    retireChatSession: async (args) => {
      refuseIfFenced();
      return chat.retire(args);
    },
    recordToolResultConsent,
    mintConnectCredential: (args) => {
      refuseIfFenced();
      return ensureRootCredential(registry, { ...args, managerInstance: `auth-service:${space}` });
    },
    selectManagerInstance,
    listManagerInstances,
    retireInteractiveLifecycle: async (args) => {
      // Everything before the barrier only reads, so a refusal there retired nothing.
      let owner: string, actor: string, lifecycleUid: string;
      try {
        refuseIfFenced();
        owner = assertDerivedOwnerToken(args.owner);
        actor = assertValidOwnerToken(args.actor);
        lifecycleUid = assertLifecycleToken(args.lifecycleUid);
      } catch (e) {
        throw notExecuted(e, "bad-request");
      }
      const head = await readLifecycleHeadForOperation(barrierReg, owner, actor).catch((e: unknown) => { throw notExecuted(e, "unavailable"); });
      if (head === undefined)
        return { retired: false, lifecycleUid, notStarted: true };
      if (head.mapping.lifecycleUid !== lifecycleUid) {
        // A row can rotate again before its fresh uid is ever used. In that state the authority
        // still points at the RETIRED predecessor; there is no live head to retire for this row.
        // An active/retiring foreign uid is different: the ledger and authority disagree, so fail.
        if (head.mapping.state === "retired")
          return { retired: false, lifecycleUid, notStarted: true };
        throw new EpEnvelopeError("conflict", `interactive lifecycle retirement for "${owner}/${actor}" names ${lifecycleUid}, but the authority head is ${head.mapping.state} at ${head.mapping.lifecycleUid}`, undefined, "not-executed");
      }
      if (head.mapping.state === "retired")
        return { retired: true, lifecycleUid, alreadyRetired: true };
      const opId = createHash("sha256").update(`interactive-retire:${lifecycleUid}`).digest("hex").slice(0, 26);
      await runAgentRetirementBarrier(barrierReg, {
        owner,
        actor,
        lifecycleUid,
        opId,
        frontierStreams: retirementFrontierStreams(space),
      }, retirement);
      return { retired: true, lifecycleUid };
    },
    retireManagedLifecycle: managedRetirement.retireManagedLifecycle,
    activateManagedLifecycle: async (args) => {
      refuseIfFenced();
      await activateLifecycleAtUid(registry, {
        owner: assertDerivedOwnerToken(args.owner),
        actor: assertValidOwnerToken(args.actor),
        lifecycleUid: assertLifecycleToken(args.lifecycleUid),
        managerInstance: `auth-service:${space}`,
      });
    },
    ...managerIssuanceAuthority({ server, space, dataAccount, log, standingTtl, remoteIssuer, scanner, authKv, managerIssuanceGate, observeManagerGate, observeLegacyManagerGate, registeredManagerCluster, refuseIfFenced, issuerAuth, onConnection }),
    ...managedAgentAuthority({ server, space, dataAccount, observeLegacyManagerGate, refuseIfFenced, issuerAuth, takeObservedSpawnRequest, readRunStarterAdmission, deprovisionManagedFootprint, managedRetirement, opts, onConnection }),
    scanManagerGoalIndex: async (holder) => {
      refuseIfFenced();
      const { owner } = holder;
      const authorized = await authorizeRemoteManagerGoalIndexScan({
        ...holder, proofSecret: dataAccount.signingSeed, space,
        observeManagerGate: observeLegacyManagerGate,
      });
      return completeRemoteManagerGoalIndexScan(authorized, owner, await recordsScanner.scanManagerGoalIndex(owner));
    },
    authorizeManagerAdmin: async ({ request, ...holder }) => {
      refuseIfFenced();
      return authorizeRemoteManagerAdmin({
        managerOwner: holder.owner,
        ...(holder.holder === "platform" ? { managerAssignment: holder.assignment } : { managerScope: holder.scope }),
        proofSecret: dataAccount.signingSeed,
        space,
        dir: opts.dir,
        request,
        observeManagerGate: observeLegacyManagerGate,
      });
    },
    authorizeManagerParticipation: async ({ request, ...holder }) => {
      refuseIfFenced();
      if (holder.holder === "platform") throw new EpEnvelopeError("permission-denied", "manager participation authorization requires a human owner holder");
      return authorizeRemoteManagerParticipation({
        managerOwner: holder.owner, managerScope: holder.scope, proofSecret: dataAccount.signingSeed,
        space, request, dir: opts.dir, observeManagerGate: observeLegacyManagerGate,
        readLifecycle: (owner, actor) => readLifecycleHeadForOperation(barrierReg, owner, actor),
      });
    },
    submitManagerRun: async ({ request, ...holder }) => {
      refuseIfFenced();
      const { owner } = holder;
      requireManagerAuthorityHolder(holder, String((request as { instanceId?: unknown })?.instanceId), 'keyed run submission needs scope "supervise"');
      return withIssuerSession({ servers: server, space, auth: issuerAuth(), tls: false }, session => handleRemoteRunSubmission({
        request, owner, space, accountPublicKey: dataAccount.pub, proofSecret: dataAccount.signingSeed, endpoint: "manager",
        observeManagerGate: observeLegacyManagerGate, issued: session.store, sourceIsLive: composedSourceIsLive(session),
        takeObserved: takeObservedRunRequest,
        delegationOf: ledgerDelegation,
        registeredCommand: async (instanceId, registrationRevision, command) => {
          const registered = remoteManagerSurface(await registeredManagerCluster(owner, instanceId, { registrationRevision }))[command];
          if (!registered) throw new EpEnvelopeError("failed-precondition", "registered manager has no keyed contract");
          return registered;
        },
        withStore: async (runId, submission, work) => {
          const nc = await dialerFor(server)({ servers: server, ...standaloneConnectOpts({
            creds: await mintCreds(issuerAuth(), newIdentity(), "run-admitter", { runAdmitter: { endpoint: "manager", runId, submission }, expiresInSeconds: 60 }), tls: false,
          }), maxReconnectAttempts: 0 });
          onConnection?.(nc, `cotal:keyed-admitter:${space}`);
          try { return await work(await new Kvm(nc).open(admissionBucket(space)), await jetstreamManager(nc)); }
          finally { await drainAndClose(nc); }
        },
      }));
    },
    admitManagerRun: async ({ request, ...holder }) => {
      refuseIfFenced();
      const { owner } = holder;
      requireManagerAuthorityHolder(holder, String((request as { instanceId?: unknown })?.instanceId), 'manager run admission needs scope "supervise"; spawn/admin do not imply it');
      const parsed = parseRemoteRunAdmissionRequest(request);
      await observeLegacyManagerGate(parsed.instanceId);
      const runId = parsed.run.runId;
      return withIssuerSession({ servers: server, space, auth: issuerAuth(), tls: false }, async (session) => {
        const admitterNc = await dialerFor(server)({
          servers: server,
          ...standaloneConnectOpts({
            creds: await mintCreds(issuerAuth(), newIdentity(), "run-admitter", { runAdmitter: { endpoint: "manager", runId }, expiresInSeconds: 60 }),
            tls: false,
          }),
          maxReconnectAttempts: 0,
        });
        onConnection?.(admitterNc, `cotal:run-admitter:${space}`);
        try {
          return await admitRemoteRun({
            request, owner, space, accountPublicKey: dataAccount.pub, proofSecret: dataAccount.signingSeed, endpoint: "manager",
            observeManagerGate: observeLegacyManagerGate,
            issued: session.store,
            sourceIsLive: composedSourceIsLive(session),
            takeObserved: takeObservedRunRequest,
            delegationOf: ledgerDelegation,
            admissions: await new Kvm(admitterNc).open(admissionBucket(space)),
          });
        } finally {
          await drainAndClose(admitterNc);
        }
      });
    },
    cancelManagerRun: async ({ request, ...holder }) => {
      refuseIfFenced();
      const req = parseRemoteRunCancelRequest(request);
      requireManagerAuthorityHolder(holder, req.instanceId, 'manager run cancellation needs scope "supervise"');
      return withIssuerSession({ servers: server, space, auth: issuerAuth(), tls: false }, session => handleRemoteRunCancel({
        request: req, owner: holder.owner, space, endpoint: "manager", accountPublicKey: dataAccount.pub,
        proofSecret: dataAccount.signingSeed, observeManagerGate: observeLegacyManagerGate,
        observations: cancelObservations, flush: () => remoteIssuer.nc.flush(), assertServing: refuseIfFenced,
        issued: session.store, sourceIsLive: composedSourceIsLive(session),
        interactiveScope: async (caller, sources) => {
          if (sources.length !== 1 || sources[0]!.space !== space) return undefined;
          const source = parseActorLedgerSource(sources[0]!);
          if (!source || source.owner !== caller.owner || source.actor !== caller.actor || source.lifecycleUid !== caller.uid) return undefined;
          const row = findActorUnified(opts.dir, caller.owner, caller.actor);
          return row?.kind === "interactive" && row.lifecycleUid === caller.uid ? [...row.scope] : undefined;
        },
        registeredCommand: async (instanceId, registrationRevision, command) => {
          const registered = remoteManagerSurface(await registeredManagerCluster(holder.owner, instanceId, { registrationRevision }))[command];
          if (!registered) throw new EpEnvelopeError("failed-precondition", "registered manager has no run-cancel contract");
          return registered;
        },
        readAdmission: runId => readCancellationAdmission(recordsJsm, space, "manager", runId),
        readRevocation: runId => readRunRevocation(recordsJsm, space, "manager", runId),
        withStore: async (runId, work) => {
          const nc = await dialerFor(server)({ servers: server, ...standaloneConnectOpts({
            creds: await mintCreds(issuerAuth(), newIdentity(), "run-admitter", { runAdmitter: { endpoint: "manager", runId }, expiresInSeconds: 60 }), tls: false,
          }), maxReconnectAttempts: 0 });
          onConnection?.(nc, `cotal:run-cancel:${space}`);
          try { return await work(await new Kvm(nc).open(admissionBucket(space))); }
          finally { await drainAndClose(nc); }
        },
      }));
    },
    revokeManagerRun: async ({ request, ...holder }) => {
      refuseIfFenced();
      const req = parseRemoteRunRevokeRequest(request);
      await observeLegacyManagerGate(req.instanceId);
      const admitterNc = await dialerFor(server)({
        servers: server,
        ...standaloneConnectOpts({
          creds: await mintCreds(issuerAuth(), newIdentity(), "run-admitter", { runAdmitter: { endpoint: "manager", runId: req.revoke.runId }, expiresInSeconds: 60 }),
          tls: false,
        }),
        maxReconnectAttempts: 0,
      });
      onConnection?.(admitterNc, `cotal:run-revoker:${space}`);
      try {
        return await revokeRemoteRun({
          ...holder, request: req, space, accountPublicKey: dataAccount.pub, proofSecret: dataAccount.signingSeed, endpoint: "manager",
          observeManagerGate: observeLegacyManagerGate,
          readAdmission: (runId) => readRunAdmission(recordsJsm, space, "manager", runId),
          readRevocation: (runId) => readRunRevocation(recordsJsm, space, "manager", runId),
          admissions: await new Kvm(admitterNc).open(admissionBucket(space)),
        });
      } finally {
        await drainAndClose(admitterNc);
      }
    },
    issueManagerRunAttempt: async ({ request, ...holder }) => {
      refuseIfFenced();
      const { owner } = holder;
      requireManagerAuthorityHolder(holder, String((request as { instanceId?: unknown })?.instanceId), 'manager run attempt needs scope "supervise"; spawn/admin do not imply it');
      const req = parseRemoteRunAttemptRequest(request);
      await observeLegacyManagerGate(req.instanceId);
      const recordsKv = await openRecordsBucket(remoteIssuer.nc, space);
      const authorize = (session?: IssuerSession) => authorizeRemoteRunAttempt({
        ...(session ? { issued: session.store, sourceIsLive: composedSourceIsLive(session) } : {}),
        isLiveManagedActor: (owner, actor, lifecycleUid) => {
          const row = findActorUnified(opts.dir, owner, actor);
          return row?.kind === "managed-agent" && row.lifecycleUid === lifecycleUid;
        },
        takeObserved: takeObservedRunRequest,
        registeredCommand: async (instanceId, registrationRevision, command) => {
          const registered = remoteManagerSurface(await registeredManagerCluster(owner, instanceId, { registrationRevision }))[command];
          if (registered === undefined) throw new EpEnvelopeError("failed-precondition", `the registered manager cluster declares no ${command}`);
          return registered;
        },
        request,
        owner,
        space,
        accountPublicKey: dataAccount.pub,
        proofSecret: dataAccount.signingSeed,
        endpoint: "manager",
        observeManagerGate: observeLegacyManagerGate,
        readAdmission: (runId) => readRunAdmission(recordsJsm, space, "manager", runId),
        readRunStatus: async (runId) => (await readRunRecord(recordsKv, "manager", runId))?.status?.value,
        // Replayed under a read operator minted for that one run, the rows the manager's own read rides.
        readJournal: async (runId) => {
          const takeoverId = newTakeoverId();
          const readerNc = await dialerFor(server)({
            servers: server,
            ...standaloneConnectOpts({
              creds: await mintCreds(issuerAuth(), newIdentity(), "run-operator", { runOperator: { endpoint: "manager", takeoverId, runId }, expiresInSeconds: 60 }),
              tls: false,
            }),
            maxReconnectAttempts: 0,
          });
          onConnection?.(readerNc, `cotal:run-attempt-reader:${space}`);
          try {
            return await replayRunJournal(jetstream(readerNc), await jetstreamManager(readerNc), space, runId, takeoverId);
          } finally {
            await drainAndClose(readerNc);
          }
        },
        checkpointWaiting: async (token) => (await readCheckpointStatus(recordsKv, { endpoint: "manager", token }))?.value.state === "waiting",
        checkpointSettled: async (token) => {
          const status = (await readCheckpointStatus(recordsKv, { endpoint: "manager", token }))?.value;
          return status?.state === "resumed" && status.settledAnswerId !== undefined;
        },
      });
      // A served resume or answer resolves its caller's issuance, which needs one issuer window.
      const grant = req.attempt?.served !== undefined || req.operator?.served !== undefined
        ? await withIssuerSession({ servers: server, space, auth: issuerAuth(), tls: false }, (session) => authorize(session))
        : await authorize();
      if (grant.kind === "attempt") {
        const caller = runDriverCaller(grant.driver.runDriver.runId, owner);
        const driver = await mintPublicUserJwt(issuerAuth(), grant.driver.id, "run-driver", {
          principal: { owner, actor: caller.actor },
          lifecycleUid: req.managerLifecycleUid,
          runDriver: grant.driver.runDriver,
          expiresInSeconds: standingTtl,
        });
        const mediator = await mintPublicUserJwt(issuerAuth(), grant.mediator.id, "run-mediator", {
          principal: { owner, actor: caller.actor },
          lifecycleUid: req.managerLifecycleUid,
          runMediator: grant.mediator.runMediator,
          expiresInSeconds: standingTtl,
        });
        return {
          v: 1 as const,
          kind: "manager-run-attempt" as const,
          space,
          owner,
          actor: req.actor,
          instanceId: req.instanceId,
          managerLifecycleUid: req.managerLifecycleUid,
          requestId: req.requestId,
          registrationProof: req.registrationProof,
          accountPublicKey: req.accountPublicKey,
          processEpoch: req.processEpoch,
          identities: req.identities,
          attempt: req.attempt,
          credentials: { driver, mediator },
        };
      }
      const operator = await mintPublicUserJwt(issuerAuth(), grant.operator.id, "run-operator", {
        principal: { owner, actor: req.actor },
        lifecycleUid: req.managerLifecycleUid,
        runOperator: grant.operator.runOperator,
        expiresInSeconds: 60,
      });
      return {
        v: 1 as const,
        kind: "manager-run-attempt" as const,
        space,
        owner,
        actor: req.actor,
        instanceId: req.instanceId,
        managerLifecycleUid: req.managerLifecycleUid,
        requestId: req.requestId,
        registrationProof: req.registrationProof,
        accountPublicKey: req.accountPublicKey,
        processEpoch: req.processEpoch,
        identities: req.identities,
        operator: req.operator,
        credentials: { operator },
      };
    },
    observeManagerInstance: async (instanceId) => {
      refuseIfFenced();
      const gate = await observeManagerGate(instanceId);
      const rec = await readSvcRecordLeader(recordsJsm, space, recordSpecKey(RECORD_KINDS.svc, ["manager", instanceId]));
      return { registered: rec !== undefined && !("deleted" in rec), gate: gate ?? null };
    },
    registerHostInstance: async (host, instanceId) => {
      refuseIfFenced();
      const regClient = await openAuthorityClient({ onConnection,
        server, space, dataAccount, label: `cotal:host-registration:${space}`,
        grants: (id) => registrationExecutorGrants(space, id, host.endpoint, instanceId),
        log,
      });
      try {
        return (await registerSelfAuthorizedInstance(regClient.nc, {
          space, endpoint: host.endpoint, instanceId,
          // The host is minted no serve credential, so the gate binds a principal nothing holds.
          principal: principalKey(DEV_OWNER, `host_serve_${instanceId}`).key,
          clusterDigest: host.clusterDigest, artifacts: host.artifacts,
        }, registerServiceInstance)).processEpoch;
      } finally {
        await regClient.close();
      }
    },
    observeEndpointGate: async (endpoint, instanceId) => {
      refuseIfFenced();
      return await serveIssuanceGateKv(authKv, space, { endpoint, instanceId }).observe();
    },
    fenced,
    ...(serviceHost !== undefined ? { serviceEndpointHost: serviceHost.handle } : {}),
    close: async () => {
      // Clean-close order (SPEC 13.13): the rail stops answering first, then scan-capable
      // clients down, then `held → released` (never released while either scanner can still
      // act), then the barrier that wrote it. An unreachable release keeps the barrier alive
      // for a later close retry; successful scanner teardown is not run a second time.
      closing = true;
      // Before the first await: no service host call enters once close has begun.
      serviceHost?.refuse();
      registryHost?.refuse();
      await registryHost?.close();
      await drainCallerPayload();
      await stopPrune();
      await stopChatSweep();
      // Every service host call that entered returns, discovery and effects included, then every
      // effect connection that did not close is closed again, before discovery closes and before
      // the claim is released. A failure here rejects with the claim still held; close retries it.
      await serviceHost?.close();
      await closeEffects();
      await calloutWriter?.close();
      await issuer.close();
      await discoveryClient?.close();
      const scannerFlight = closeScanners ??= (async () => {
        await authAdmin?.close();
        const results = await Promise.allSettled([reader.close(), recordsScanner.close(), scanner.close()]);
        const errors = results.filter((r): r is PromiseRejectedResult => r.status === "rejected").map((r) => r.reason);
        if (errors.length) throw new AggregateError(errors, "auth scan-capable clients failed to close");
      })();
      try { await scannerFlight; }
      catch (e) { if (closeScanners === scannerFlight) closeScanners = undefined; throw e; }
      let releaseFailure: unknown;
      try { await hold.release(); } catch (e) { releaseFailure = e; }
      // Keep the barrier for an unreachable release retry. All other release refusals terminate
      // the remaining clients but retain the release failure, even if their closes fail too.
      if (planeClaimRefusal(releaseFailure) !== "release-unreachable") {
        const results = await Promise.allSettled([barrier.close(), remoteIssuer.close(), writer.close()]);
        const errors = results.filter((r): r is PromiseRejectedResult => r.status === "rejected").map((r) => r.reason);
        if (releaseFailure !== undefined && errors.length)
          throw new AggregateError([releaseFailure, ...errors], "auth claim release and connection close failed");
        if (errors.length) throw new AggregateError(errors, "auth remaining clients failed to close");
      }
      if (releaseFailure !== undefined) throw releaseFailure;
    },
  };
}

/**
 * Boot crash-resume (SPEC 13.1): enumerate the durable operation intents and finish every
 * barrier this executor OWES. Owed-ness is the CROSS-OBJECT invariant spanning the gate AND the
 * lifecycle alias head — completed and lost operations leave their intent behind by design and
 * are skipped:
 *  - a TAKEOVER is owed while its gate is still FROZEN by that opId, and complete once the gate
 *    reopened (the head epoch advanced in the same op);
 *  - a RETIREMENT is owed while its gate is still FROZEN by that opId, and ALSO when the gate
 *    terminal landed by that op but the head terminal did not (a crash between the barrier's
 *    last two steps): the head is then `retiring`, which per SPEC 13.1 is non-current AND not
 *    replaceable, so the alias can neither mint nor be replaced on any boot — the gate-only
 *    predicate skipped that intent forever (#878). The head decides completion: `retired` at this
 *    op's uid means the barrier's last step ran (skipped), and a head at ANOTHER uid means a
 *    successor already replaced the retired predecessor (skipped, never touched).
 *
 * A resume always re-enters the SAME operation: a frozen TAKEOVER through
 * {@link resumeAgentTakeover}; a RETIREMENT (either owed cell) through
 * {@link resumeAgentRetirement} with the plane's assembled {@link RetirementDeps} (#29 piece 4),
 * whose gate-retired branch finishes ONLY the head terminal from the durable coordinates — it
 * never re-revokes or re-drains a world past the gate terminal. Session-derived descendants
 * fail loud inside the barrier until the session reconciler is wired (the #29 trigger slice);
 * a resume failure is equally loud and non-fatal.
 */
async function resumeOpenOperations(reg: LifecycleRegistry, evictPrincipal: EvictPrincipal, retirement: RetirementDeps, log: (line: string) => void): Promise<void> {
  for (const it of await enumerateOperationIntents(reg)) {
    const gate = await observeGate(reg, it.lifecycleUid);
    // Owed by the gate: a freeze by THIS op is the barrier's live claim (the bar of every
    // barrier). A takeover completed under this predicate reopens the gate, so its completed
    // intent stays skipped exactly as before.
    let owed = gate !== undefined && gate.row.state === "frozen" && gate.row.op.opId === it.opId;
    // #878: a retirement whose gate terminal landed by THIS op but whose head terminal did not.
    // The head decides the completed cell: `retired` at this uid means the barrier's last step ran
    // (skip), and a head at ANOTHER uid means a successor already replaced the retired predecessor
    // — the op completed and is never this resume's touch. A head still `retiring` at this uid is
    // the wedged crash window, and `active` at this uid is a backward head (impossible; a head
    // never un-retires) — both resume, so the barrier either finishes the tail or refuses loud; an
    // absent head is corruption the barrier refuses loud (a head is never deleted, SPEC 13.12).
    if (!owed && it.kind === "retirement" && gate !== undefined && gate.row.state === "retired" && gate.row.op.opId === it.opId) {
      const head = await readLifecycleHeadForOperation(reg, it.owner, it.actor);
      owed = head === undefined
        || (head.mapping.lifecycleUid === it.lifecycleUid && head.mapping.state !== "retired");
    }
    if (!owed) continue;
    if (it.kind === "retirement") {
      try {
        const r = await resumeAgentRetirement(reg, it.opId, retirement);
        log(`auth-barrier: resumed retirement ${it.opId} for ${it.lifecycleUid} (${r.revokedRows} row(s) revoked, ${r.evictedPrincipals.length} principal(s) verified-evicted, ${r.drainedEndpoints.length} endpoint(s) drained, ${Object.keys(r.cleaned).length} pool(s) cleaned, ${Object.keys(r.frontiers).length} frontier stream(s))`);
      } catch (e) {
        log(`auth-barrier: resuming retirement ${it.opId} for ${it.lifecycleUid} FAILED (${e instanceof Error ? e.message : String(e)}) - the gate stays frozen and nothing mints for this alias until a resume succeeds (fail-closed)`);
      }
      continue;
    }
    try {
      const r = await resumeAgentTakeover(reg, it.opId, { evictPrincipal });
      log(`auth-barrier: resumed takeover ${it.opId} for ${it.lifecycleUid} (epoch ${r.toEpoch}, ${r.revokedRows} row(s) revoked, ${r.evictedPrincipals.length} principal(s) verified-evicted)`);
    } catch (e) {
      log(`auth-barrier: resuming takeover ${it.opId} for ${it.lifecycleUid} FAILED (${e instanceof Error ? e.message : String(e)}) - the gate stays frozen and nothing mints for this alias until a resume succeeds (fail-closed)`);
    }
  }
}
/** The HTTP routes authenticate a human, so they only ever supply the human arm. */
type HumanHolder = Extract<ManagerAuthorityHolder, { scope: string[] }>;

export interface HandlerCtx {
  deregisterEndpoint: AuthAuthorityPlane["deregisterEndpoint"];
  /** The callout's connect limits, which the exchange checks before it mints. */
  connectLimiter: ConnectLimiter;
  issueToolResultConsent?: (raw: unknown) => Promise<import("@cotal-ai/core").ToolResultConsent>;
  /** Present only with `serviceEndpoints`: the public service endpoint authority door. */
  serviceAuthority?: ServiceAuthorityDoor;
  /** Present only with `serviceEndpoints`: the in-process host the `/service-endpoint-host` route
   *  answers from, after it has authenticated the granter it passes. */
  serviceHost?: ServiceEndpointHost;
  issuer: UserTokenIssuer;
  bridge: IdpBridge;
  bridgeIdp: { issuer: string; audience: string; key: ReturnType<typeof pinnedJwksResolver> };
  ownerSecret: string | Uint8Array;
  managerServiceAuthority: (args: HumanHolder & { request: RemoteManagerAuthorityRequest }) => ReturnType<AuthAuthorityPlane["issueManagerServiceAuthority"]>;
  maintainRemoteManager: (args: HumanHolder & { request: RemoteManagerMaintenanceRequest }) => ReturnType<AuthAuthorityPlane["maintainRemoteManager"]>;
  validateRetainedAgent: (args: HumanHolder & { request: RemoteRetainedAgentValidationRequest }) => ReturnType<AuthAuthorityPlane["validateRetainedAgent"]>;
  verifyManagedAgentEnrollment: AuthAuthorityPlane["verifyManagedAgentEnrollment"];
  verifyManagedAgentPrepareRetirement: AuthAuthorityPlane["verifyManagedAgentPrepareRetirement"];
  verifyManagedAgentRuntime: AuthAuthorityPlane["verifyManagedAgentRuntime"];
  enrollManagedAgent: (args: HumanHolder & { request: RemoteManagedAgentEnrollmentRequest }) => Promise<RemoteManagedAgentEnrollmentResult>;
  prepareManagedAgentRetirement: AuthAuthorityPlane["prepareManagedAgentRetirement"];
  scanManagerGoalIndex: (args: HumanHolder & { request: import("@cotal-ai/core").RemoteManagerGoalIndexScanRequest }) => ReturnType<AuthAuthorityPlane["scanManagerGoalIndex"]>;
  authorizeManagerAdmin: (args: HumanHolder & { request: RemoteManagerAdminAuthorizationRequest }) => ReturnType<AuthAuthorityPlane["authorizeManagerAdmin"]>;
  authorizeManagerParticipation?: (args: HumanHolder & { request: import("@cotal-ai/core").RemoteManagerParticipationAuthorizationRequest }) => ReturnType<AuthAuthorityPlane["authorizeManagerParticipation"]>;
  admitManagerRun: (args: HumanHolder & { request: unknown }) => ReturnType<AuthAuthorityPlane["admitManagerRun"]>;
  submitManagerRun?: (args: HumanHolder & { request: unknown }) => ReturnType<AuthAuthorityPlane["submitManagerRun"]>;
  revokeManagerRun?: (args: HumanHolder & { request: unknown }) => ReturnType<AuthAuthorityPlane["revokeManagerRun"]>;
  cancelManagerRun?: (args: HumanHolder & { request: unknown }) => ReturnType<AuthAuthorityPlane["cancelManagerRun"]>;
  issueManagerRunAttempt: (args: HumanHolder & { request: unknown }) => ReturnType<AuthAuthorityPlane["issueManagerRunAttempt"]>;
  secrets: SecretStore;
  retireInteractiveLifecycle: AuthAuthorityPlane["retireInteractiveLifecycle"];
  retireManagedLifecycle: AuthAuthorityPlane["retireManagedLifecycle"];
  activateManagedLifecycle: AuthAuthorityPlane["activateManagedLifecycle"];
  accountPublicKey: string;
  authorizeActor: ReturnType<typeof ledgerAuthorizeGrant>;
  cap: string;
  failures: number[];
  badCaps: number[];
  space: string;
  /** The provider state dir — the AGENT grant type reads its ledger rows fresh per exchange. */
  dir: string;
  /** The authority plane's root-credential ensure — the agent-exchange arm stamps from it (the
   *  human arm stamps inside the bridge). */
  mintConnectCredential: (args: { owner: string; actor: string; lifecycleUid: string }) => Promise<string>;
  selectManagerInstance: AuthAuthorityPlane["selectManagerInstance"];
  listManagerInstances: AuthAuthorityPlane["listManagerInstances"];
  verifySession: AuthAuthorityPlane["verifySession"];
  openChatSession: AuthAuthorityPlane["openChatSession"];
  chatSessionBearer: AuthAuthorityPlane["chatSessionBearer"];
  retireChatSession: AuthAuthorityPlane["retireChatSession"];
}

/** `e`, raised before any write, as a refusal that states so (SPEC 13.3). An envelope error keeps
 *  its code; any other error takes `code`. */
function notExecuted(e: unknown, code: EpErrorCode): EpEnvelopeError {
  return e instanceof EpEnvelopeError
    ? new EpEnvelopeError(e.code, e.message, e.details, "not-executed")
    : new EpEnvelopeError(code, e instanceof Error ? e.message : String(e), undefined, "not-executed");
}

type RouteHandler = (req: IncomingMessage, res: ServerResponse, ctx: HandlerCtx) => void | Promise<void>;

/** The loopback route table: /health, /jwks (public keys, cacheable), /exchange (IdP JWT →
 *  bearer; capability-gated). Anything else 404s. A `Map` (not an object literal) so a hostile
 *  request-target like `toString` can never resolve through the prototype chain. */
const ROUTES = new Map<string, RouteHandler>([
  ["/health", (_req, res, ctx) => send(res, 200, { ok: true, issuer: ctx.issuer.issuer })],
  [
    "/jwks",
    (req, res, ctx) => {
      if (req.method !== "GET") return send(res, 405, { error: "GET only" });
      // The explicit cache contract (see the module doc): max-age bounds how stale a verifier's set
      // may be, which in turn floors how long a retired kid must stay published after rotation.
      return send(res, 200, ctx.issuer.jwks(), { "cache-control": `max-age=${JWKS_MAX_AGE_SEC}` });
    },
  ],
  ["/exchange", (req, res, ctx) => handleExchange(req, res, ctx, LOOPBACK_POLICY)],
  ["/manager-service-authority", (req, res, ctx) => handleManagerServiceAuthority(req, res, ctx, LOOPBACK_POLICY)],
  ["/endpoint-deregister", (req, res, ctx) => handleEndpointDeregister(req, res, ctx, LOOPBACK_POLICY)],
  ["/manager-instances", (req, res, ctx) => handleManagerInstances(req, res, ctx, LOOPBACK_POLICY)],
  [SERVICE_ENDPOINT_AUTHORITY_PATH, (req, res, ctx) => handleServiceEndpointAuthority(req, res, ctx, LOOPBACK_POLICY)],
  [SERVICE_ENDPOINT_HOST_PATH, (req, res, ctx) => handleServiceEndpointHost(req, res, ctx, LOOPBACK_POLICY)],
  [INTERACTIVE_RETIRE_PATH, handleInteractiveLifecycleRetirement],
  [MANAGED_ACTIVATE_PATH, handleManagedLifecycleActivation],
  [MANAGED_RETIRE_PATH, handleManagedLifecycleRetirement],
  [VERIFY_ENROLLMENT_PATH, handleVerifyManagedAgentEnrollment],
  [TOOL_RESULT_HUMAN_PROOF_PATH, handleToolResultHumanProof],
  [TOOL_RESULT_CONSENT_PATH, handleToolResultConsent],
  [CHAT_SESSION_PATHS.open, (req, res, ctx) => handleChatSession(req, res, ctx, LOOPBACK_POLICY, "open")],
  [CHAT_SESSION_PATHS.bearer, (req, res, ctx) => handleChatSession(req, res, ctx, LOOPBACK_POLICY, "bearer")],
  [CHAT_SESSION_PATHS.retire, (req, res, ctx) => handleChatSession(req, res, ctx, LOOPBACK_POLICY, "retire")],
]);

/** Route one HTTP request against the loopback route table. Errors are JSON `{ error }`. */
export async function handle(req: IncomingMessage, res: ServerResponse, ctx: HandlerCtx): Promise<void> {
  try {
    const route = ROUTES.get(req.url ?? "");
    if (!route) return send(res, 404, { error: "unknown path - /health, /jwks, /exchange, /manager-service-authority, /manager-instances, /manager-service-authority/verify-enrollment, /interactive-lifecycle/retire, /managed-lifecycle/activate, /managed-lifecycle/retire, /chat-session/open, /chat-session/bearer, /chat-session/retire" });
    await route(req, res, ctx);
  } catch (e) {
    sendRequestError(res, e);
  }
}

/** Each chat-session route's CLOSED body: an unknown or missing field refuses before any read. */
const CHAT_SESSION_FIELDS: Readonly<Record<"open" | "bearer" | "retire", { required: readonly string[]; optional: readonly string[] }>> = {
  open: { required: ["idpToken", "holderHash", "read", "post", "ttlSec"], optional: ["label"] },
  bearer: { required: ["idpToken", "actor", "holderProof"], optional: [] },
  retire: { required: ["idpToken", "actor", "lifecycleUid", "holderProof"], optional: [] },
};

/**
 * The chat-session routes, on both faces. The owner is derived from a fresh IdP proof exactly as
 * `/exchange` derives it; the body never names one. `open` admits, `bearer` exchanges the holder
 * proof for one short bearer, `retire` retires. Every refusal answers `{ error, code, outcome }`:
 * `not-executed` when nothing was written, `executed` when this request wrote before refusing, and
 * `unknown` when a write may have landed (a retry with the SAME holder resolves it). The holder proof
 * and the bearer never reach a log line.
 */
async function handleChatSession(req: IncomingMessage, res: ServerResponse, ctx: HandlerCtx, policy: ExchangePolicy, op: "open" | "bearer" | "retire"): Promise<void> {
  // Every answer before the dispatch is refused with nothing read or written.
  const before = { outcome: "not-executed" } as const;
  if (req.method !== "POST") return send(res, 405, { error: "POST only", code: "bad-request", ...before });
  if (req.headers.origin !== undefined) return send(res, 403, { error: "browser-origin requests are not served here", code: "permission-denied", ...before });
  if (!/^application\/json\b/.test(req.headers["content-type"] ?? ""))
    return send(res, 415, { error: "content-type must be application/json", code: "bad-request", ...before });
  if (policy.requireCapability && (req.headers.authorization ?? "") !== `Bearer ${ctx.cap}`)
    return refuseCapability(res, ctx, "missing/invalid exchange capability - read it from the space's auth-service.json", { code: "unauthenticated", ...before });
  const peer = policy.peerKey(req);
  const peerThrottled = policy.throttled(ctx, peer);
  const body = await readJsonBody(req);
  const malformed = (why: string) => send(res, 400, { error: `chat-session ${op}: ${why}`, code: "bad-request", ...before });
  if (body === null || typeof body !== "object" || Array.isArray(body)) return malformed("the body must be a JSON object");
  const b = body as Record<string, unknown>;
  const fields = CHAT_SESSION_FIELDS[op];
  const extra = Object.keys(b).find((k) => !fields.required.includes(k) && !fields.optional.includes(k));
  if (extra !== undefined) return malformed(`unknown field "${extra}"`);
  const missing = fields.required.find((k) => !Object.hasOwn(b, k));
  if (missing !== undefined) return malformed(`missing field "${missing}"`);
  if (typeof b.idpToken !== "string" || b.idpToken === "") return malformed("idpToken must be a non-empty string");
  if (op === "open" && (typeof b.holderHash !== "string" || !Array.isArray(b.read) || !Array.isArray(b.post) || typeof b.ttlSec !== "number" || (b.label !== undefined && typeof b.label !== "string")))
    return malformed("open takes { idpToken, holderHash: string, read: string[], post: string[], ttlSec: number, label?: string }");
  if (op !== "open" && (typeof b.actor !== "string" || typeof b.holderProof !== "string" || (op === "retire" && typeof b.lifecycleUid !== "string")))
    return malformed(op === "bearer" ? "bearer takes { idpToken, actor: string, holderProof: string }" : "retire takes { idpToken, actor: string, lifecycleUid: string, holderProof: string }");
  // A refusal keeps the effect outcome its source stated; one that states none is unknown.
  const refuse = (status: number, message: string, code: string, outcome: string = "unknown") =>
    refuseExchange(res, ctx, policy, peer, peerThrottled, `refused a chat-session ${op}: ${message}`, status, { error: message, code, outcome }, { code: "resource-exhausted", outcome });
  let owner: string;
  let idpExp: number;
  try {
    const verified = await verifyIdpToken(b.idpToken, ctx.bridgeIdp);
    owner = deriveOwnerForIdpSubject(ctx.ownerSecret, ctx.bridgeIdp.issuer, verified.sub);
    idpExp = verified.exp;
  } catch (e) {
    return refuse(401, e instanceof Error ? e.message : String(e), "unauthenticated", "not-executed");
  }
  try {
    if (op === "open")
      return send(res, 200, await ctx.openChatSession({
        owner, holderHash: b.holderHash as string, read: b.read as string[], post: b.post as string[], ttlSec: b.ttlSec as number,
        ...(typeof b.label === "string" ? { label: b.label } : {}),
      }));
    if (op === "bearer") {
      const minted = await ctx.chatSessionBearer({ owner, actor: b.actor as string, holderProof: b.holderProof as string, idpExp, issuer: ctx.issuer });
      return send(res, 200, { token: minted.token, owner, exp: minted.exp });
    }
    return send(res, 200, await ctx.retireChatSession({ owner, actor: b.actor as string, lifecycleUid: b.lifecycleUid as string, holderProof: b.holderProof as string }));
  } catch (e) {
    if (e instanceof EpEnvelopeError) return refuse(REFUSAL_STATUS[e.code] ?? 500, e.message, e.code, e.outcome ?? "unknown");
    // Anything else came from a store, broker or file read partway through: its effect is unknown.
    return refuse(503, e instanceof Error ? e.message : String(e), "unavailable", "unknown");
  }
}

/** A service renewal or access proof, verified against this context's own signing keys: the
 *  signed witness it binds. A request that carries a witness must name the proof's; a status query
 *  carries none, so its proof's own witness is the expected one. Current native state is the
 *  engine's check, never the proof's. */
async function verifyServiceProof(proof: { kind: "service-renewal" | "service-access"; token: string }, request: ServiceAuthorityRequest,
  issuer: UserTokenIssuer, space: string): Promise<ServiceRegistrationWitness> {
  const key = issuer.localKeySet();
  if (proof.kind === "service-renewal") {
    const expected = "witness" in request ? request.witness : parseServiceRegistrationWitness(decodeJwt(proof.token).witness);
    return (await validateServiceRenewalProof(proof.token, { issuer: issuer.issuer, key, witness: expected })).witness;
  }
  const token = await validateUserToken(proof.token, { issuer: issuer.issuer, audience: space, key });
  if (token.act.view !== "service-endpoint" || token.act.service?.duty !== "serve") throw new Error("the access proof is not a service bearer");
  const witness = parseServiceRegistrationWitness(token.act.service.witness);
  if (token.owner !== witness.principal.owner || token.act.owner !== witness.principal.owner || token.act.actor !== witness.principal.actor
    || token.act.lifecycleUid !== witness.principal.lifecycleUid || token.credentialId !== witness.rootCredentialId)
    throw new Error("the access proof does not bind its witness");
  if ("witness" in request && serviceWitnessDigest(request.witness) !== serviceWitnessDigest(witness)) throw new Error("the access proof binds another witness");
  return witness;
}

/** The authenticated service endpoint host route, on both faces and only with `serviceEndpoints`:
 *  POST takes `{ idpToken, request }`, where `request` is a host request without its granter. The
 *  fresh IdP proof derives the owner, who needs a current interactive row (the engine checks it);
 *  owner operations and reads run under that owner and the engine scopes them to the owner's own
 *  rows. An operator action (`name-bind`, the restore controls, a non-owner revoke) runs only on the
 *  loopback face under the operator exchange capability, with the proved subject as its audit id;
 *  the public face refuses it. The route authenticates the granter and never invents one; the
 *  engine's answer, replay included, is returned as is. */
async function handleServiceEndpointHost(req: IncomingMessage, res: ServerResponse, ctx: HandlerCtx, policy: ExchangePolicy): Promise<void> {
  const host = ctx.serviceHost;
  if (host === undefined) return send(res, 404, { error: "service endpoint host is not enabled for this space" });
  if (req.method !== "POST") return send(res, 405, { error: "POST only" });
  if (req.headers.origin !== undefined) return send(res, 403, { error: "browser-origin requests are not served here" });
  if (!/^application\/json\b/.test(req.headers["content-type"] ?? ""))
    return send(res, 415, { error: "content-type must be application/json" });
  if (policy.requireCapability && req.headers.authorization !== `Bearer ${ctx.cap}`)
    return refuseCapability(res, ctx, "missing/invalid exchange capability - the service endpoint host requires the operator exchange capability on this face");
  const peer = policy.peerKey(req);
  const peerThrottled = policy.throttled(ctx, peer);
  let body: { idpToken?: unknown; request?: unknown } | null;
  try {
    body = await readJsonBody(req, SERVICE_HOST_BODY_MAX_BYTES) as typeof body;
  } catch (e) {
    return sendRequestError(res, e);
  }
  if (typeof body?.idpToken !== "string" || !body.idpToken || body.request === null || typeof body.request !== "object" || Array.isArray(body.request)
      || Object.hasOwn(body.request, "granter"))
    return send(res, 400, { error: "service endpoint host needs { idpToken, request } with the granter left to this route" });
  let proved: { owner: string; subject: string };
  try {
    const verified = await verifyIdpToken(body.idpToken, ctx.bridgeIdp);
    proved = { owner: deriveOwnerForIdpSubject(ctx.ownerSecret, ctx.bridgeIdp.issuer, verified.sub), subject: verified.sub };
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    return refuseExchange(res, ctx, policy, peer, peerThrottled, `refused service endpoint host: ${reason}`, 403, { error: reason });
  }
  const granter = serviceHostGranterFor(body.request as { operation: unknown; input: unknown }, proved, policy.requireCapability);
  if (granter === undefined) return send(res, 403, { error: "this host operation is the operator's; it is served on the loopback face under the exchange capability only" });
  let request: ReturnType<typeof parseServiceHostRequest>;
  try { request = parseServiceHostRequest({ ...(body.request as Record<string, unknown>), granter }); }
  catch (e) { return send(res, 400, { error: e instanceof Error ? e.message : String(e) }); }
  try {
    return send(res, 200, await host(request), { "cache-control": "no-store" });
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    console.error(`auth-service: service endpoint host failed: ${reason}`);
    return send(res, /unavailable/i.test(reason) ? 503 : 500, { error: reason });
  }
}

/** A host request is small: a decision, a binding or a read. */
const SERVICE_HOST_BODY_MAX_BYTES = 64 * 1024;

/** Publish the canonical void closure, manifest and schema, create-only, through one effect whose
 *  credential publishes exactly those two artifacts and reads them back, over the read-only discovery
 *  base every effect credential carries; no other write is granted. Idempotent: a store that holds
 *  them already answers without a write. */
async function publishCanonicalVoidClosure(opts: Parameters<typeof openServiceHostEffect>[0]): Promise<void> {
  const artifacts: unknown[] = [singleDocumentClosure(VOID_SCHEMA).manifest, VOID_SCHEMA];
  const effect = await openServiceHostEffect(opts, { keys: { records: [], auth: [], authFamilies: [] }, deadlineMs: Date.now() + S2A_INVOCATION_MS,
    reads: { records: [], contract: artifacts.map((a) => contractRefToHex(contractDigest(a))) } });
  try {
    for (const a of artifacts) await publishContractArtifact(effect.contract!, contractArtifactCanonicalBytes(a));
  } finally { await effect.close(); }
}

/** The public service endpoint authority route, on both faces and only with `serviceEndpoints`: GET
 *  reads the account info, POST takes one `{request, proof}` envelope. The proof is the credential on
 *  either face; the loopback capability is never read or accepted here. An IdP proof verifies against
 *  the pinned issuer and exact audience, and its subject derives the owner. A service renewal or
 *  access proof verifies against this context's own issuer and binds a witness, never an owner's
 *  authority. A refused proof counts against the face's refusal budget; a valid proof does not,
 *  whatever the answer. */
async function handleServiceEndpointAuthority(req: IncomingMessage, res: ServerResponse, ctx: HandlerCtx, policy: ExchangePolicy): Promise<void> {
  const door = ctx.serviceAuthority;
  if (door === undefined) return send(res, 404, { error: "service endpoint authority is not enabled for this space" });
  if (req.headers.origin !== undefined) return send(res, 403, { error: "browser-origin requests are not served here" });
  const noStore = { "cache-control": "no-store" };
  if (req.method === "GET") return send(res, 200, serviceAuthorityInfo(door, ctx.issuer), noStore);
  if (req.method !== "POST") return send(res, 405, { error: "GET or POST only" });
  if (!/^application\/json\b/.test(req.headers["content-type"] ?? ""))
    return send(res, 415, { error: "content-type must be application/json" });
  const peer = policy.peerKey(req);
  const peerThrottled = policy.throttled(ctx, peer);
  let envelope: ReturnType<typeof parseServiceAuthorityEnvelope>;
  try { envelope = parseServiceAuthorityEnvelope(await readJsonBody(req, SERVICE_AUTHORITY_MAX_BYTES)); }
  catch (e) {
    // The parser's bad-request names the caller's own malformed envelope, so it stays a named 400.
    if (e instanceof EpEnvelopeError && e.code === "bad-request") return send(res, 400, { error: e.message });
    return sendRequestError(res, e);
  }
  const { request, proof } = envelope;
  const answer = (r: { status: number; body: unknown }) => send(res, r.status, r.body, noStore);
  if (request.space !== door.space || request.accountPublicKey !== door.accountPublicKey) return answer(serviceAuthorityDenied(request, "account-mismatch"));
  let caller: ServiceAuthorityCaller;
  try {
    caller = proof.kind === "idp"
      ? { kind: "idp", owner: deriveOwnerForIdpSubject(ctx.ownerSecret, ctx.bridgeIdp.issuer, (await verifyIdpToken(proof.token, ctx.bridgeIdp)).sub) }
      : { kind: "service", witness: await verifyServiceProof(proof, request, ctx.issuer, door.space) };
  } catch (e) {
    policy.recordFailure(ctx, peer);
    console.error(`auth-service: refused a service endpoint authority proof: ${e instanceof Error ? e.message : String(e)}`);
    return answer(serviceAuthorityDenied(request, peerThrottled ? "rate-limited" : "unauthenticated"));
  }
  try {
    return answer(await answerServiceAuthority(door, request, caller));
  } catch (e) {
    // After the proof, a register may already be bound: an unexpected failure is an unknown effect.
    console.error(`auth-service: service endpoint authority ${request.operation} failed: ${e instanceof Error ? e.message : String(e)}`);
    return send(res, 503, { error: "service endpoint authority did not complete; the request may be bound, so retain its request identity" }, noStore);
  }
}

/** Same-account human removal. Operator authority exists only on the trusted in-process door. */
async function handleEndpointDeregister(req: IncomingMessage, res: ServerResponse, ctx: HandlerCtx, policy: ExchangePolicy): Promise<void> {
  if (req.method !== "POST") return send(res, 405, { error: "POST only" });
  if (req.headers.origin !== undefined) return send(res, 403, { error: "browser-origin requests are not served here" });
  if (!/^application\/json\b/.test(req.headers["content-type"] ?? "")) return send(res, 415, { error: "content-type must be application/json" });
  if (policy.requireCapability && req.headers.authorization !== `Bearer ${ctx.cap}`)
    return refuseCapability(res, ctx, "missing/invalid exchange capability");
  const peer = policy.peerKey(req), throttled = policy.throttled(ctx, peer);
  let body: { idpToken: string; request: unknown };
  try {
    const raw = await readJsonBody(req);
    if (!raw || typeof raw !== "object" || Array.isArray(raw) || Object.keys(raw).sort().join(",") !== "idpToken,request" ||
        !("idpToken" in raw) || typeof raw.idpToken !== "string" || !raw.idpToken) return send(res, 400, { error: "endpoint deregistration needs only { idpToken, request }" });
    body = raw as typeof body;
    parseRemoteEndpointDeregisterRequest(body.request);
  } catch (error) {
    if (error instanceof RequestBodyError) return sendRequestError(res, error);
    return send(res, error instanceof EpEnvelopeError && error.code === "unimplemented" ? 422 : 400, { error: "invalid endpoint deregistration request" });
  }
  let owner: string;
  try {
    const verified = await verifyIdpToken(body.idpToken, ctx.bridgeIdp);
    owner = deriveOwnerForIdpSubject(ctx.ownerSecret, ctx.bridgeIdp.issuer, verified.sub);
    const row = findInteractiveActor(ctx.dir, owner, "cli");
    if (!row || !(row.scope ?? []).includes("supervise")) throw new Error("endpoint deregistration requires the current cli supervise grant");
  } catch {
    return refuseExchange(res, ctx, policy, peer, throttled, "endpoint deregistration proof or current grant refused", 403, { error: "endpoint deregistration proof or current grant refused" });
  }
  try {
    return send(res, 200, await ctx.deregisterEndpoint(body.request, { kind: "owner", owner }), { "cache-control": "no-store" });
  } catch {
    return send(res, 503, { error: "endpoint deregistration did not return a confirmed result; inspect the same registration before another request" });
  }
}

/** Minimal host-held inputs for the proof decision; no signing or storage authority is used. */
export type ToolResultHumanProofCtx = Pick<HandlerCtx, "cap" | "bridgeIdp" | "ownerSecret" | "badCaps">;

/** Decide one signed password proof against the host's authenticated session subject.
 * The subject is an equality constraint, never the source of the derived owner. */
export async function handleToolResultHumanProof(
  req: IncomingMessage, res: ServerResponse, ctx: ToolResultHumanProofCtx,
): Promise<void> {
  if (req.method !== "POST") return send(res, 405, { error: "POST only" });
  if (req.headers.origin !== undefined) return send(res, 403, { error: "browser-origin requests are not served here" });
  if (!/^application\/json\b/.test(req.headers["content-type"] ?? ""))
    return send(res, 415, { error: "content-type must be application/json" });
  if (req.headers.authorization !== `Bearer ${ctx.cap}`)
    return refuseCapability(res, ctx, "missing/invalid exchange capability - human proof verification is a loopback host action");
  let body: unknown;
  try { body = await readJsonBody(req); }
  catch (error) { return send(res, error instanceof RequestBodyError ? error.status : 400, { error: "invalid human proof request" }); }
  if (!body || typeof body !== "object" || Array.isArray(body) ||
      Object.keys(body).some(key => key !== "idpToken" && key !== "subject") ||
      !("idpToken" in body) || typeof body.idpToken !== "string" || !body.idpToken ||
      !("subject" in body) || typeof body.subject !== "string" || !body.subject)
    return send(res, 400, { error: "human proof verification needs only { idpToken, subject }" });
  try {
    const proof = await verifyToolResultHumanProof(body.idpToken, ctx.bridgeIdp);
    if (proof.sub !== body.subject) return send(res, 403, { error: "human proof subject does not match the session" });
    const owner = deriveOwnerForIdpSubject(ctx.ownerSecret, ctx.bridgeIdp.issuer, proof.sub);
    return send(res, 200, { authorized: true, owner, ...proof });
  } catch {
    return send(res, 403, { error: "fresh signed password proof required" });
  }
}

/** Consent issuance is confined to the authenticated host face and uses sanitized refusals. */
export async function handleToolResultConsent(req: IncomingMessage, res: ServerResponse,
  ctx: Pick<HandlerCtx, "cap" | "badCaps" | "issueToolResultConsent">): Promise<void> {
  if (req.method !== "POST") return send(res, 405, { error: "POST only" });
  if (req.headers.origin !== undefined) return send(res, 403, { error: "browser-origin requests are not served here" });
  if (!/^application\/json\b/.test(req.headers["content-type"] ?? "")) return send(res, 415, { error: "content-type must be application/json" });
  if (req.headers.authorization !== `Bearer ${ctx.cap}`)
    return refuseCapability(res, ctx, "missing/invalid exchange capability - consent issuance is a loopback host action");
  if (!ctx.issueToolResultConsent) return send(res, 503, { error: "tool-result-consent-unavailable", outcome: "not-executed" });
  let body: unknown;
  try { body = await readJsonBody(req); }
  catch { return send(res, 400, { error: "invalid consent request", outcome: "not-executed" }); }
  try { return send(res, 200, { consent: await ctx.issueToolResultConsent(body) }, { "cache-control": "no-store" }); }
  catch (error) {
    const code = error instanceof EpEnvelopeError ? error.code : "unavailable";
    const status = code === "bad-request" ? 400 : code === "permission-denied" ? 403 : code === "conflict" ? 409 : 503;
    return send(res, status, { error: `tool-result-consent-${code}`, outcome: error instanceof EpEnvelopeError ? error.outcome ?? "unknown" : "unknown" });
  }
}

/** Compose the user bundle the public face serves at /.well-known/cotal-mesh. ONE producer,
 *  exported so the consumer contract (`checkUserBundle` in the CLI) can be asserted against the
 *  real composition rather than a copy. The trust pins ride a `userAuth` arm because that is the
 *  shape the consumer records: registration passes it through `assertUserAuthInfo` and lands it
 *  in the registry entry (plus `remote: true` and the sentinel PATH). `endpoints.url` starts
 *  empty — the daemon finalizes it with {@link finalizeUserBundleEndpoint} after the public
 *  listener binds. */
export function composeUserBundle(args: {
  eventPayloadsWithheld?: boolean;
  space: string;
  server: string;
  idp: { url: string; issuer: string; audience: string };
  sentinelCreds: string;
  /** The deployment's remote agent-provisioning endpoint (U6): where `cotal spawn` POSTs the
   *  login bearer to mint a managed agent in the owner's envelope. Optional — a mesh without one
   *  simply has no self-service remote spawn, and the client refuses with a named message. */
  agentProvisioningUrl?: string;
}): Record<string, unknown> {
  return {
    space: args.space,
    server: args.server,
    tlsRequired: true,
    ...(args.eventPayloadsWithheld === true ? { policy: { eventPayloads: "withheld" } } : {}),
    userAuth: {
      // The same provider name the LOCAL arm records — one exported constant rather than a
      // literal repeated here and in provider.ts, so a remote entry cannot come to name a
      // different provider than the one that serves it.
      provider: AUTH_PROVIDER_NAME,
      idp: args.idp,
      endpoints: {
        url: "",
        managerAuthorityUrl: "",
        ...(args.agentProvisioningUrl ? { agentProvisioningUrl: args.agentProvisioningUrl } : {}),
      },
    },
    sentinelCreds: args.sentinelCreds,
  };
}

/** Pin the bundle's exchange endpoint once the public listener is bound (with `--port 0` the
 *  pre-bind port would advertise an address nothing listens on). Mutates `url` IN PLACE rather
 *  than replacing the endpoints object — replacement once silently dropped every sibling field
 *  the composer had set (agentProvisioningUrl). */
export function finalizeUserBundleEndpoint(bundle: Record<string, unknown>, publicUrl: string): void {
  const endpoints = (bundle.userAuth as { endpoints: { url: string; managerAuthorityUrl: string } }).endpoints;
  endpoints.url = publicUrl;
  endpoints.managerAuthorityUrl = `${publicUrl.replace(/\/$/, "")}/manager-service-authority`;
}

/** Build the PUBLIC listener's request handler: its own closed route table (/health, /jwks,
 *  /exchange and /manager-service-authority under the public policy, /.well-known/cotal-mesh — 404
 *  everything else), behind a
 *  global concurrent-admission cap and a hard wall-clock deadline. All of it is public-face-local
 *  state: nothing here touches the loopback face's windows. */
export function makePublicHandler(
  ctx: HandlerCtx,
  policy: ExchangePolicy,
  bundle: Record<string, unknown>,
): (req: IncomingMessage, res: ServerResponse) => void {
  const routes = new Map<string, RouteHandler>([
    [
      "/health",
      (req, res, c) => {
        if (req.method !== "GET") return send(res, 405, { error: "GET only" });
        return send(res, 200, { ok: true, issuer: c.issuer.issuer });
      },
    ],
    [
      "/jwks",
      (req, res, c) => {
        if (req.method !== "GET") return send(res, 405, { error: "GET only" });
        return send(res, 200, c.issuer.jwks(), { "cache-control": `max-age=${JWKS_MAX_AGE_SEC}` });
      },
    ],
    ["/exchange", (req, res, c) => handleExchange(req, res, c, policy)],
    ["/manager-service-authority", (req, res, c) => handleManagerServiceAuthority(req, res, c, policy)],
    ["/endpoint-deregister", (req, res, c) => handleEndpointDeregister(req, res, c, policy)],
    ["/manager-instances", (req, res, c) => handleManagerInstances(req, res, c, policy)],
    [SERVICE_ENDPOINT_AUTHORITY_PATH, (req, res, c) => handleServiceEndpointAuthority(req, res, c, policy)],
    [SERVICE_ENDPOINT_HOST_PATH, (req, res, c) => handleServiceEndpointHost(req, res, c, policy)],
    [CHAT_SESSION_PATHS.open, (req, res, c) => handleChatSession(req, res, c, policy, "open")],
    [CHAT_SESSION_PATHS.bearer, (req, res, c) => handleChatSession(req, res, c, policy, "bearer")],
    [CHAT_SESSION_PATHS.retire, (req, res, c) => handleChatSession(req, res, c, policy, "retire")],
    [
      "/.well-known/cotal-mesh",
      (req, res) => {
        if (req.method !== "GET") return send(res, 405, { error: "GET only" });
        // GENERATED from the daemon's own recorded config (flags + pinned IdP + callout material)
        // — never hand-written, so it can't drift from what the service actually enforces.
        return send(res, 200, bundle);
      },
    ],
  ]);
  let inFlight = 0;
  return (req, res) => {
    // Global concurrent-admission cap: total public work is bounded regardless of source — and
    // (its own counter) can never consume the loopback face's capacity.
    if (inFlight >= PUBLIC_MAX_IN_FLIGHT) return send(res, 503, { error: "busy - retry shortly" });
    inFlight++;
    // Hard request deadline: a stalled or slow-dripping request is answered and cut, never held.
    const deadline = setTimeout(() => {
      if (!res.headersSent) send(res, 503, { error: "request deadline exceeded" });
      req.destroy();
    }, PUBLIC_DEADLINE_MS);
    res.on("close", () => {
      clearTimeout(deadline);
      inFlight--;
    });
    void (async () => {
      try {
        const route = routes.get(req.url ?? "");
        if (!route) return send(res, 404, { error: "unknown path - /health, /jwks, /exchange, /manager-service-authority, /manager-instances, /chat-session/open, /chat-session/bearer, /chat-session/retire, /.well-known/cotal-mesh" });
        await route(req, res, ctx);
      } catch (e) {
        if (!res.headersSent) sendRequestError(res, e);
      }
    })();
  };
}
