/**
 * The provisioner — the signer capability for a space.
 *
 * A space is one NATS *account*; every agent is a *user* in it. This module mints the
 * decentralized-JWT trust chain (operator → account → user) programmatically with
 * `@nats-io/jwt`, so there is no dependency on the external `nsc` CLI and the signing
 * key stays in one place (whoever holds {@link SpaceAuth.account.signingSeed}).
 *
 * The static mint is out of band: `cotal up` creates the space's trust material
 * once and writes a `nats-server` config (operator + system account + MEMORY resolver);
 * `cotal mint` and the manager load that material and mint per-agent creds files. The auth
 * callout mints at connect time through the same {@link permissionsFor}.
 *
 * Every credential kind is classified in {@link CREDENTIAL_LIFETIMES}: its lifetime class, default
 * expiry and renewal owner.
 */
export { capabilityRole, taskRoles, permissionsFor, listingGrantRows } from "./provision-permissions.js";
export type { Profile } from "./provision-permissions.js";
export { MAX_CONTROL_LINE_BYTES, CONNECT_ENVELOPE_OVERHEAD_BYTES, MAX_MINTED_JWT_BYTES, STANDING_RENEWABLE_TTL_SEC, ROTATION_RENEWED_TTL_SEC, CREDENTIAL_LIFETIMES, credentialLifetime, inspectCredHealth, composeSpaceAuth, assertAccountSignedByBroker, stripSpaceAuth, accountRevocations, revokeAccountUser, retireAccountClaim, rotateSystemAccount, createBrokerAuth, createSpaceAccountAuth, createSpaceAuth, mintCreds, mintPublicUserJwt, mintServiceCalloutJwt, mintMembershipObserverCreds, mintAccountCensusCreds, mintConnectionEvictorCreds } from "./provision-jwt.js";
export type { CredentialLifetimeClass, CredentialKind, CredentialLifetimePolicy, CredHealthState, CredHealth, BrokerAuth, SpaceAccountAuth, SpaceAuth, IssuedBinding, MintOpts, MintPrincipal } from "./provision-jwt.js";
export { provisionAgent, provisionAgentDurables } from "./provision-resources.js";
export type { ProvisionOpts, DurableProvisioner } from "./provision-resources.js";
export { openServerConfig, brokerJetStreamBlock, serverConfig } from "./provision-server-config.js";
export type { AccountResolver } from "./provision-server-config.js";
