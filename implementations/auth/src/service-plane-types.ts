/** The auth service's authority-plane surface, the operations the callout authority and the
 *  HTTP routes call. service.ts builds it and re-exports the type. */
import type { ToolResultConsentRecorder } from "./tool-result-consent.js";
import type { EpGateState, RemoteManagedAgentEnrollmentRequest, RemoteManagedAgentEnrollmentResult, RemoteManagedAgentPrepareRetirementRequest, RemoteManagedAgentPrepareRetirementResult, RemoteManagerAdminAuthorizationRequest, RemoteManagerAuthorityRequest, RemoteManagerMaintenanceRequest, RemoteRetainedAgentValidationRequest } from "@cotal-ai/core";
import type { ManagerAuthorityHolder } from "./platform-control.js";
import type { CalloutAuthority } from "./callout-authority.js";
import type { UserTokenIssuer } from "./issuer.js";
import type { RemoteManagedAgentRuntimeDecision } from "./managed-agent-enrollment.js";
import type { EndpointDeregisterGranter } from "./endpoint-deregister.js";
import type { ChatAdmissionRequest, ChatRetireRequest, ChatRetireResult, ChatSessionAdmitted } from "./chat-session-authority.js";
import type { ServiceEndpointHost } from "./service-host-contract.js";
import type { PlatformControlInput } from "./service-host.js";
import type { ManagerCaller, ManagerInstanceCatalog } from "./service.js";

/** The service's AUTHORITY PLANE (R1, SPEC 13.1): the two self-minted data-account connections
 *  behind (a) the composed connect authorizer — the file-ledger arm PLUS the credential deny-new
 *  arm through the supervised, shape-proved reader — and (b) the exchange-time root-credential
 *  ensure both exchange arms stamp `act.credentialId` from. */
export interface AuthAuthorityPlane extends CalloutAuthority {
  deregisterEndpoint: (request: unknown, granter: EndpointDeregisterGranter) => Promise<import("@cotal-ai/core").RemoteEndpointDeregisterResult>;
  recordToolResultConsent: ToolResultConsentRecorder;
  mintConnectCredential: (args: { owner: string; actor: string; lifecycleUid: string }) => Promise<string>;
  /** Admit one user-mode chat session for an owner the route derived from a verified IdP proof
   *  (the chat-only minting authority, SPEC 13.1). Same-holder retries converge on one session. */
  openChatSession: (args: ChatAdmissionRequest) => Promise<ChatSessionAdmitted>;
  /** Exchange a holder proof for one short bearer of an ACTIVE chat session; the parent pin and the
   *  holder index are re-checked before and after signing, and a mismatch discards the bytes. */
  chatSessionBearer: (args: { owner: string; actor: string; holderProof: string; idpExp: number; issuer: UserTokenIssuer }) => Promise<{ token: string; exp: number }>;
  /** Retire a chat session through the retirement barrier; a blocked barrier is `failed` with its
   *  pending reason, never success. */
  retireChatSession: (args: ChatRetireRequest) => Promise<ChatRetireResult>;
  /** `caller` picks the remedy an ambiguity refusal names: `--on` for the human (CLI) arm,
   *  `cotal agent-bearer`'s `--manager-instance` for the agent arm, the wire field otherwise. */
  selectManagerInstance: (owner: string, requested?: string, caller?: ManagerCaller) => Promise<string>;
  /** The owner's Manager instances with the verdict selection reads; selection is built on it. */
  listManagerInstances: (owner: string) => Promise<ManagerInstanceCatalog>;
  /** Retire one interactive lifecycle through the retirement barrier. A refusal raised before the
   *  barrier starts carries `outcome: "not-executed"` (SPEC 13.3); a failure inside the barrier
   *  carries none, because the retirement may have begun. */
  retireInteractiveLifecycle: (args: { owner: string; actor: string; lifecycleUid: string }) => Promise<{
    retired: boolean;
    lifecycleUid: string;
    notStarted?: boolean;
    alreadyRetired?: boolean;
  }>;
  retireManagedLifecycle: AuthAuthorityPlane["retireInteractiveLifecycle"];
  /** Activate a managed agent's lifecycle at the uid its grant carries, under the same minting
   *  authority its first bearer exchange names, and mint nothing (SPEC 13.16). */
  activateManagedLifecycle: (args: { owner: string; actor: string; lifecycleUid: string }) => Promise<void>;
  issueManagerServiceAuthority: (args: ManagerAuthorityHolder & { request: RemoteManagerAuthorityRequest; supervisorExpiresAt?: number }) => Promise<import("@cotal-ai/core").RemoteManagerAuthorityMaterial>;
  /** End one platform supervisor lifecycle at the authority plane: retire its manager gate and its
   *  issued supervisor and executor generations. Both are terminal; nothing reopens them. */
  endPlatformSupervisor: (args: { owner: string; instanceId: string; lifecycleUid: string }) => Promise<void>;
  maintainRemoteManager: (args: ManagerAuthorityHolder & { request: RemoteManagerMaintenanceRequest }) => Promise<import("@cotal-ai/core").RemoteManagerMaintenanceResult>;
  validateRetainedAgent: (args: ManagerAuthorityHolder & {
    request: RemoteRetainedAgentValidationRequest;
  }) => Promise<RemoteRetainedAgentValidationRequest>;
  /** Authorize one host-owned managed-agent enrollment (#1972). The plane reads the manager gate on
   *  its own connection and verifies the proof against the data-account signing seed, so no secret
   *  and no gate read ever crosses to the host platform that called the loopback door. */
  verifyManagedAgentEnrollment: (args: {
    owner: string;
    scope: string[];
    request: import("@cotal-ai/core").RemoteManagedAgentEnrollmentRequest;
  }) => Promise<{ request: import("@cotal-ai/core").RemoteManagedAgentEnrollmentRequest; parent: string }>;
  /** Authorize one host-owned managed-agent terminal release preparation (#1972 phase P0/P1). */
  verifyManagedAgentPrepareRetirement: (args: {
    owner: string;
    scope: string[];
    request: import("@cotal-ai/core").RemoteManagedAgentPrepareRetirementRequest;
  }) => Promise<import("@cotal-ai/core").RemoteManagedAgentPrepareRetirementRequest>;
  /** Host-owned managed-agent enrollment (#1972): the enrollment decision, then the ledger grant at
   *  a host-chosen uid and that uid's durables. A failed provision revokes the grant it wrote. */
  enrollManagedAgent: (args: {
    owner: string;
    scope: string[];
    request: RemoteManagedAgentEnrollmentRequest;
    sentinelCreds: string;
    agentBearerExchangeUrl: string;
  }) => Promise<RemoteManagedAgentEnrollmentResult>;
  /** Host-owned retirement preparation (#1972): the prepare decision, then the target uid's broker
   *  footprint and grant are released, so the participant's terminal rail finds the grant gone. */
  prepareManagedAgentRetirement: (args: {
    owner: string;
    scope: string[];
    request: RemoteManagedAgentPrepareRetirementRequest;
  }) => Promise<RemoteManagedAgentPrepareRetirementResult>;
  /** Decide one hosted runtime create or status read. The plane reads the manager actor's ledger
   *  row, the gate, and the proof itself; it touches no provider and writes nothing. */
  verifyManagedAgentRuntime: (args: {
    owner: string;
    request: import("@cotal-ai/core").RemoteManagedAgentRuntimeRequest;
  }) => Promise<RemoteManagedAgentRuntimeDecision>;
  scanManagerGoalIndex: (args: ManagerAuthorityHolder & {
    request: import("@cotal-ai/core").RemoteManagerGoalIndexScanRequest;
  }) => Promise<import("@cotal-ai/core").RemoteManagerGoalIndexScanResult>;
  authorizeManagerAdmin: (args: ManagerAuthorityHolder & {
    request: RemoteManagerAdminAuthorizationRequest;
  }) => Promise<import("@cotal-ai/core").RemoteManagerAdminAuthorizationResult>;
  authorizeManagerParticipation: (args: ManagerAuthorityHolder & {
    request: import("@cotal-ai/core").RemoteManagerParticipationAuthorizationRequest;
  }) => Promise<import("@cotal-ai/core").RemoteManagerParticipationAuthorizationResult>;
  /** First-run admission for one hosted run-start, asked by a registered signerless manager. The
   *  plane authenticates the registration, resolves the caller's issued generation on its own issuer
   *  connection with live sources, and creates the admission through a run-admitter credential
   *  pinned to that one run. No ceiling, caller or profile is taken from the request. */
  admitManagerRun: (args: ManagerAuthorityHolder & {
    request: unknown;
  }) => Promise<import("@cotal-ai/core").RemoteRunAdmissionResult>;
  submitManagerRun: (args: ManagerAuthorityHolder & { request: unknown }) => Promise<import("@cotal-ai/core").RemoteRunSubmissionResult>;
  cancelManagerRun: (args: ManagerAuthorityHolder & { request: unknown }) => Promise<import("@cotal-ai/core").RemoteRunCancelResult>;
  /** Revoke under the authenticated holder and the recorded admission owner. */
  revokeManagerRun: (args: ManagerAuthorityHolder & { request: unknown }) => Promise<import("@cotal-ai/core").RemoteRunRevokeResult>;
  /** First-attempt/resume or operator issuance for one hosted run, asked by a registered signerless manager.
   *  The plane authenticates the registration, derives coordinates from native admission/records/checkpoints,
   *  and signs ONLY the returned fixed grant args. JWT responses contain no seeds. */
  issueManagerRunAttempt: (args: ManagerAuthorityHolder & {
    request: unknown;
  }) => Promise<import("@cotal-ai/core").RemoteRunAttemptResult>;
  /** Read-only view of one manager instance for the platform control door: whether its
   *  `svc.manager` record is current, and its gate. It probes, freezes and writes nothing. */
  observeManagerInstance: (instanceId: string) => Promise<{ registered: boolean; gate: EpGateState | null }>;
  /** Register one instance of the platform host's endpoint through the §13.7 ceremony this plane
   *  runs for `auth`, and return the process epoch that registration committed (SPEC 13.16). */
  registerHostInstance: (host: NonNullable<PlatformControlInput["host"]>, instanceId: string) => Promise<number>;
  /** The issuance gate of one instance of `endpoint`. It probes, freezes and writes nothing. */
  observeEndpointGate: (endpoint: string, instanceId: string) => Promise<EpGateState | null>;
  /** Resolves with the state-3 copy when a mid-life scanner death FENCES the plane (SPEC 13.13):
   *  the plane is no longer whole, `authorizeConnect`/`mintConnectCredential` refuse from that
   *  moment, and the composition root must take the whole service DOWN loud (a fenced plane that
   *  kept minting would look healthy while a successor reclaims its scanners). Never resolves on a
   *  clean close. */
  fenced: Promise<string>;
  /** Present only with `serviceEndpoints`: the in-process service endpoint host (decide, revoke, the
   *  create-only name binding and the operation and proposal reads). Trusted embedder only: the
   *  caller must authenticate the granter it passes. */
  serviceEndpointHost?: ServiceEndpointHost;
  /** Clean close (SPEC 13.13). Rejects when the plane did not release its claim; the barrier and
   *  the remaining clients still close. */
  close(): Promise<void>;
}
