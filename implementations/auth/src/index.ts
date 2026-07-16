export { deriveOwnerToken, deriveOwnerForIdpSubject } from "./derive.js";
export {
  AUTH_CALLOUT_SUBJECT,
  createCalloutAuth,
  startAuthCallout,
  type CalloutAuth,
  type CalloutProvisionInput,
  type CalloutConnection,
  type CalloutMsg,
  type StartAuthCalloutOpts,
} from "./callout.js";
export {
  validateUserToken,
  USER_TOKEN_VER,
  MAX_TOKEN_TTL_SEC,
  USER_TOKEN_VIEWS,
  VIEW_REQUIRED_SCOPE,
  type UserTokenActor,
  type UserTokenView,
  type ValidatedUserToken,
  type ValidateUserTokenOpts,
} from "./token.js";
export {
  USER_TOKEN_ALG,
  createUserTokenIssuer,
  generateSigningKey,
  exportSigningKey,
  importSigningKey,
  pinnedJwksResolver,
  type SigningKey,
  type SerializedSigningKey,
  type IssueClaims,
  type UserTokenIssuer,
  type CreateIssuerOpts,
} from "./issuer.js";
export {
  createIdpBridge,
  type IdpConfig,
  type ActorGrant,
  type CreateIdpBridgeOpts,
  type ExchangeResult,
  type IdpBridge,
} from "./idp.js";
export {
  deviceLogin,
  establishIdpSession,
  fetchIdpJwt,
  revokeIdpSession,
  loadIdpSession,
  saveIdpSession,
  deleteIdpSession,
  requireIdpSession,
  normalizeIdpUrl,
  probeIdpJwks,
  type IdpSession,
  type DeviceLoginOpts,
  type DeviceLoginPrompt,
} from "./login.js";
export { calloutPermissions, type AclResolver } from "./permissions.js";
export {
  clearAuthServiceInfo,
  ensureCalloutAuth,
  ensureIssuer,
  ensureOwnerSecret,
  ensurePinnedIdp,
  loadAuthServiceInfo,
  loadCalloutAuth,
  loadIssuer,
  loadOwnerSecret,
  loadPinnedIdp,
  loadServiceKeys,
  saveAuthServiceInfo,
  saveServiceKeys,
  spaceIssuer,
  type AuthServiceInfo,
  type PinnedIdp,
  type ServiceKeys,
} from "./store.js";
export {
  actorLedgerDir,
  managedActorLedgerDir,
  findInteractiveActor,
  findManagedActor,
  findActorUnified,
  grantActor,
  grantManagedActor,
  ledgerAclResolver,
  ledgerAuthorizeConnect,
  ledgerAuthorizeGrant,
  ledgerAuthorizeAgentExchange,
  ledgerRowFilename,
  loadActorLedger,
  revokeActor,
  revokeManagedActor,
  newActorToken,
  hashActorToken,
  AGENT_BEARER_TTL_SEC,
  type ActorKind,
  type ActorRow,
} from "./ledger.js";
export { runAuthService, JWKS_MAX_AGE_SEC } from "./service.js";
export { cotalAuthProvider } from "./provider.js"; // self-registers the "auth-provider" extension
import "./commands.js"; // self-registers `login` / `logout` / `actor` / `auth-service` into the core Registry
// NB: writeEndpointGate (the D14 endpoint-registration stand-in) is deliberately NOT
// re-exported here (import it directly from the module in smokes/provisioning). The public
// surface is the store + hooks + close/sweep seams.
export { openSessionAuthStore, kvSessionLedger, sessionRedemptionHooks, closeSession, sweepSessions, type SessionAuthStore, type EndpointGateRow, type SessionSigner, type SessionHookDeps, type SessionCloser } from "./session-ledger.js";
// NB: the package surface is the sealed contexts + the READ seams only. The activation saga,
// the UID reservation, the gate primitives (create/observe/freeze/reopen/retire), the
// normative credential ledger (credential-ledger.ts: rows, source gates, the mint protocol),
// and the takeover barrier are ALL package-internal: their executor seam is the sealed
// registry itself, and exposing a public epoch advance / head retirement / bare gate reopen
// around an incomplete barrier would recreate the half-fence D13 removes. Smokes and
// provisioning tooling import them directly from the modules.
export {
  openLifecycleRegistry, openLifecycleMappingReader,
  readLifecycleMappingLeader, lifecycleProcessEpochReader,
  type LifecycleRegistry, type LifecycleMappingReader, type LifecycleMapping, type EpGateRow,
} from "./lifecycle-registry.js";
// The D13 (4) admission mediator + admission-policy coordinate (SPEC 13.6/13.8/13.9): the
// per-endpoint sealed mediator over the `oblig.` prefix, the immutable `policy` version
// publication, and the govern-head stage/drain/promote selector. The obtain/settle/recover/
// drain entry points are the public seam; the row/proof internals stay module-private.
export {
  openAdmissionMediator, obtainEpfObligation, obtainSelfObligation,
  acceptSelfObligation, recoverSelfObligation, settleEpfOrSelfObligation, assertAdmissionProof,
  readEnforcedPolicy, publishPolicyVersion, stagePolicySelector, promotePolicySelector,
  drainEndpointPolicy, drainTargetForEndpoint,
  type AdmissionMediator, type AdmissionIdentity, type AdmissionProof, type ObtainedObligation,
  type ObligationRow, type ObligationState, type CommitValue, type SelfCommitIntent,
  type PolicySelector, type DrainResult, type DrainQuiescence, type ApplyCommit,
} from "./admission-mediator.js";
