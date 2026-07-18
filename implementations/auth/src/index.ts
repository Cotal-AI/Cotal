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
  assertCredentialIdClaim,
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
export { runAuthService, openAuthAuthorityPlane, JWKS_MAX_AGE_SEC, type AuthAuthorityPlane } from "./service.js";
// The R1 connect-arm deny-new READ seam (SPEC 13.1): the reader grant builder, the sealed
// shape-proved reader, and the pure connect-credential check the production composition runs.
// The WRITE side (authority-client, root-credential, activateLifecycleAtUid) stays
// package-internal — the sealed plane is its only production door; smokes import the modules.
export {
  authConnectReaderGrants, openConnectReader, authorizeConnectCredential,
  type ConnectReader,
} from "./connect-reader.js";
export { cotalAuthProvider } from "./provider.js"; // self-registers the "auth-provider" extension
import "./commands.js"; // self-registers `login` / `logout` / `actor` / `auth-service` into the core Registry
// NB: writeEndpointGate (the D14 endpoint-registration stand-in) is deliberately NOT
// re-exported here (import it directly from the module in smokes/provisioning). The public
// surface is the store + hooks + close/sweep seams.
export { openSessionAuthStore, kvSessionLedger, sessionRedemptionHooks, closeSession, sweepSessions, kvServeIssuanceGate, type SessionAuthStore, type EndpointGateRow, type SessionSigner, type SessionHookDeps, type SessionCloser } from "./session-ledger.js";
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
// The D13 (4) admission mediator + admission-policy coordinate (SPEC 13.6/13.8/13.9) is
// PACKAGE-INTERNAL, deliberately: `openAdmissionMediator` requires the BRANDED records
// scanner (site 3, nats-server#8274), whose constructors are not on the package surface, so
// a root export would be an unsatisfiable public seam (a mediator you can name but never
// construct). And a bare `openRecordsScanner` export is refused too: ONE shared records
// scanner per space is the composition rule (fact-5; scans serialize module-wide per space,
// so a stray second instance is safe but never the intended shape), and this package does
// not own that composition (the #29 slice does). Until it lands, the whole coordinate is
// reached by importing the module directly (smokes do); nothing of it is on the package
// surface.
