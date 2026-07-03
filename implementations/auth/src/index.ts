export { deriveOwnerToken } from "./derive.js";
export {
  AUTH_CALLOUT_SUBJECT,
  createCalloutAuth,
  startAuthCallout,
  type CalloutAuth,
  type CalloutConnection,
  type CalloutMsg,
  type StartAuthCalloutOpts,
} from "./callout.js";
export {
  validateUserToken,
  USER_TOKEN_VER,
  MAX_TOKEN_TTL_SEC,
  type UserTokenActor,
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
  type IdpSession,
  type DeviceLoginOpts,
  type DeviceLoginPrompt,
} from "./login.js";
import "./commands.js"; // self-registers `login` / `logout` into the core Registry
