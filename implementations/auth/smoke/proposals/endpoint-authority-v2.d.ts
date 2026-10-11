/** Proposal only. This file is not exported by a package and implements no runtime behavior. */
import type {
  EpCaller, EpCapability, EpServeGrant, EpServeHandle, EpCommandDef,
  IssuedSourceRef, IssuedAuthorityRef, ParsedEpRequest, EndpointRequest,
  ServiceNameAuthority, SpaceAuth,
} from "@cotal-ai/core";
import type { AuthServiceHandle, ValidatedUserToken } from "@cotal-ai/auth";
import type { NatsConnection } from "@nats-io/transport-node";

export interface AccountPin {
  readonly space: string;
  readonly accountPublicKey: string;
  readonly assignmentRevision: number;
}
/** Issuer-authored immutable coordinates. IDs are never bearer authorization. */
export interface ServingAuthorityRef {
  readonly policyRevision: number;
  readonly namespaceRevision: number;
  readonly delegationId: string;
  readonly delegationRevision: number;
}
/** First U1/U2 implementation supports instance only. Class is schema vocabulary, issuance refuses
 * until the endpoint-wide single receiving set and winner validation pass their native gates. */
export type ServeRoutes =
  | { readonly kind: "instance" }
  | { readonly kind: "class"; readonly classRevision: number };
/** The governor controls the endpoint name and admitted contract. This is not a serving owner. */
export interface NamespacePolicy {
  readonly v: 2;
  readonly account: AccountPin;
  readonly endpoint: string;
  readonly governor: string;
  readonly namespaceRevision: number;
  readonly policyRevision: number;
  readonly clusterDigests: readonly string[];
  readonly classAdmission: "disabled" | "explicit";
}
/** Persisted by the issuer after the host authenticates the namespace governor. */
export interface ServingDelegation {
  readonly v: 2;
  readonly account: AccountPin;
  readonly endpoint: string;
  readonly instanceId: string;
  readonly ref: ServingAuthorityRef;
  readonly holder: { readonly owner: string; readonly actor: string; readonly lifecycleUid: string; readonly publicKey: string };
  readonly clusterDigests: readonly string[];
  readonly routes: ServeRoutes;
  readonly resources: { readonly kind: "ephemeral-only" };
  readonly expiresAt: number;
}
/** Add this to ServiceSpec, EpServeGrant and the corresponding instance gate/ledger snapshot.
 * ServiceSpec.owner remains the actual serving owner. The authority ref is not name ownership.
 */
export interface ServiceSpecAuthorityDelta {
  readonly protocol: { readonly v: 3 };
  readonly servingAuthority: ServingAuthorityRef;
  readonly serveRoutes: ServeRoutes;
  readonly resources: { readonly kind: "ephemeral-only" };
}
/** Additive decision used by generic mediated registration/authorizeServeGrant, not legacy authorize(). */
export interface ServiceNameAuthorityDelta extends Omit<ServiceNameAuthority, "authorizeInstance"> {
  authorizeInstance(args: {
    readonly account: AccountPin;
    readonly endpoint: string;
    readonly instanceId: string;
    readonly holder: ServingDelegation["holder"];
    readonly clusterDigests: readonly string[];
    readonly expected: ServingAuthorityRef;
    readonly ceiling: AuthorityCeiling;
  }): Promise<{ readonly authorized: true; readonly governor: string; readonly ref: ServingAuthorityRef; readonly ceiling: AuthorityCeiling } | { readonly authorized: false }>;
}
/** Unix seconds throughout. The decision requires exact routes/resources/closures/expiry equality
 * with the pinned immutable delegation, including class revision. Unsupported ceilings refuse. */
export interface AuthorityCeiling {
  readonly routes: ServeRoutes;
  readonly resources: { readonly kind: "ephemeral-only" };
  readonly expiresAt: number;
}
export interface ContractArtifact {
  readonly digest: string; // sha256 of RFC8785 canonical value, not its closure manifest
  readonly value: Readonly<Record<string, unknown>> | boolean;
}
/** Fresh requestId identifies transport delivery only. It is excluded from signed operation
 * content. challengeId/operationId and operationDigest bind the stable action, holder and content. */
export interface HolderProof {
  readonly challengeId: string;
  readonly publicKey: string;
  readonly signature: string;
}
export interface LifecycleContent {
  readonly action: "activate" | "renew" | "retire";
  readonly registrationRevision: number; // activate reservation=0, others=current positive revision
  readonly processEpoch: number; // activate reservation=0, others=current epoch
  readonly contractArtifacts: readonly ContractArtifact[]; // nonempty for activate, empty otherwise
}
export type EndpointServiceRequest =
  | { readonly v: 2; readonly operation: "prepare"; readonly operationId: string; readonly account: AccountPin; readonly endpoint: string; readonly requestId: string; readonly holderPublicKey: string }
  | { readonly v: 2; readonly operation: "challenge"; readonly operationId: string; readonly account: AccountPin; readonly endpoint: string; readonly requestId: string; readonly instanceId: string; readonly expected: ServingAuthorityRef; readonly content: LifecycleContent }
  | { readonly v: 2; readonly operation: "commit"; readonly operationId: string; readonly account: AccountPin; readonly endpoint: string; readonly requestId: string; readonly instanceId: string; readonly expected: ServingAuthorityRef; readonly content: LifecycleContent; readonly proof: HolderProof };
export interface HolderChallenge {
  readonly v: 2;
  readonly kind: "cotal.endpoint-holder";
  readonly account: AccountPin;
  readonly holder: ServingDelegation["holder"];
  readonly endpoint: string;
  readonly instanceId: string;
  readonly expected: ServingAuthorityRef;
  readonly operationId: string;
  readonly challengeId: string;
  readonly action: LifecycleContent["action"];
  readonly registrationRevision: number;
  readonly processEpoch: number;
  readonly nonce: string;
  readonly operationDigest: string;
  readonly issuedAt: number;
  readonly expiresAt: number;
}
/** Intention only. Identity, effective capabilities, resource profiles and source refs are server-authored. */
export interface EndpointCallerRequest {
  readonly v: 2;
  readonly account: AccountPin;
  readonly endpoint: string;
  readonly requestId: string;
  readonly selection: { readonly kind: "instance"; readonly instanceId: string } | { readonly kind: "class"; readonly expectedClassRevision: number };
  readonly operations: readonly (
    | { readonly command: string; readonly targetMode?: never; readonly targetOwner?: never }
    | { readonly command: string; readonly targetMode: "self"; readonly targetOwner?: never }
    | { readonly command: string; readonly targetMode: "owner" | "child" | "ledger"; readonly targetOwner: string }
  )[];
}
/** Persisted ceiling material. Not accepted from callers and never returned to endpoint processes. */
export interface EndpointCallerGrant {
  readonly v: 2;
  readonly account: AccountPin;
  readonly endpoint: string;
  readonly grantId: string;
  readonly grantRevision: number;
  readonly policyRevision: number;
  readonly principal: EpCaller;
  readonly selection: EndpointCallerRequest["selection"];
  readonly capabilities: readonly EpCapability[]; // exact derived rows, never supplied by the requesting client
  readonly sources: readonly IssuedSourceRef[];
  readonly expiresAt: number;
}
/** Host policy input only. The stock issuer revalidates refs and compiles rows itself.
 * No arbitrary grants/permissions or SpaceAuth cross this adapter boundary.
 */
export interface EndpointAuthorityPolicy {
  currentAccount(): Promise<AccountPin>;
  authorizeNamespaceGovernor(principal: EpCaller, endpoint: string): Promise<void>;
  namespace(endpoint: string): Promise<NamespacePolicy>;
  serving(principal: EpCaller, endpoint: string): Promise<Omit<ServingDelegation, "instanceId" | "holder">>;
  caller(principal: EpCaller, intention: EndpointCallerRequest): Promise<EndpointCallerGrant>;
}
/** New optional stock startAuthService input. Its native handle and client names are proposed. */
export interface EndpointAuthorityInput {
  readonly version: 2;
  readonly policy: EndpointAuthorityPolicy;
}
export type EndpointServiceResponse =
  | { readonly v: 2; readonly operation: "prepare"; readonly operationId: string; readonly account: AccountPin; readonly endpoint: string; readonly instanceId: string; readonly expected: ServingAuthorityRef; readonly holder: ServingDelegation["holder"]; readonly expiresAt: number }
  | { readonly v: 2; readonly operation: "challenge"; readonly payload: HolderChallenge }
  | { readonly v: 2; readonly operation: "activate" | "renew"; readonly account: AccountPin; readonly endpoint: string; readonly instanceId: string; readonly operationId: string; readonly serveJwt: string; readonly attestation: string }
  | { readonly v: 2; readonly operation: "retire"; readonly operationId: string; readonly completed: true };
export interface EndpointCallerResponse {
  readonly v: 2;
  readonly account: AccountPin;
  readonly bearer: string;
  readonly expiresAt: number;
}
/** Signed compact EdDSA JWS. The trusted authority pin, never this response, selects issuer keys. */
export interface ServeAttestation {
  readonly v: 2;
  readonly kind: "cotal.endpoint-serve";
  readonly issuer: string;
  readonly account: AccountPin;
  readonly endpoint: string;
  readonly instanceId: string;
  readonly operationId: string;
  readonly holder: ServingDelegation["holder"];
  readonly authority: ServingAuthorityRef;
  readonly protocol: { readonly v: 3 };
  readonly registrationRevision: number;
  readonly processEpoch: number;
  readonly clusterDigests: readonly string[];
  readonly ceiling: AuthorityCeiling;
  readonly credentialId: string;
  readonly credentialDigest: string;
  readonly issuedAt: number;
  readonly expiresAt: number;
}
export interface EndpointAuthorityHandle {
  service(principal: ValidatedUserToken, request: EndpointServiceRequest): Promise<EndpointServiceResponse>;
  caller(principal: ValidatedUserToken, request: EndpointCallerRequest): Promise<EndpointCallerResponse>;
}
export type AuthServiceHandleDelta = AuthServiceHandle & { readonly endpointAuthority?: EndpointAuthorityHandle };
/** Generic caller view is revalidated at exchange AND native callout mint, then accepted-row-bound. */
export interface EndpointCallerTokenDelta {
  readonly view: "endpoint-caller";
  readonly authorityVersion: 2;
  readonly endpointGrant: { readonly grantId: string; readonly grantRevision: number; readonly policyRevision: number };
}
/** Native auth endpoint commands ep-admit / ep-release, not Manager or an application proxy.
 * Sender identity comes from the serving holder's issued connection and is revalidated by issuer.
 * Application arg/output bytes never cross this authority transport. */
export interface ServingPin {
  readonly account: AccountPin;
  readonly endpoint: string;
  readonly instanceId: string;
  readonly epoch: number;
  readonly authority: ServingAuthorityRef;
}
export interface EndpointAdmissionRequest {
  readonly v: 2;
  readonly operation: "admit";
  readonly operationId: string;
  readonly serving: ServingPin;
  readonly requestSubject: string; // complete issued native application subject, parsed by stock
  readonly request: { readonly id: string; readonly envelopeDigest: string };
}
export interface EndpointAdmissionResponse {
  readonly v: 2;
  readonly operation: "admit";
  readonly operationId: string;
  readonly admissionId: string;
  readonly serving: ServingPin;
  readonly caller: IssuedAuthorityRef;
  readonly commands: readonly string[]; // fresh private describe view from exact immutable caller ceiling
  readonly requestSubjectDigest: string;
  readonly envelopeDigest: string;
}
export interface EndpointReleaseRequest {
  readonly v: 2;
  readonly operation: "release";
  readonly operationId: string;
  readonly admissionId: string;
  readonly serving: ServingPin;
  readonly outcome: "executed" | "not-executed" | "unknown";
}
export interface EndpointReleaseResponse {
  readonly v: 2;
  readonly operation: "release";
  readonly admissionId: string;
  readonly released: true;
  readonly outcome: EndpointReleaseRequest["outcome"];
}
declare const stockAdmissionBrand: unique symbol;
/** Constructed only by stock authenticated remote client, never arbitrary structural evidence. */
export interface EndpointRequestAuthority {
  readonly [stockAdmissionBrand]: true;
  admit(args: { readonly serving: ServingPin; readonly subject: ParsedEpRequest; readonly request: EndpointRequest }): Promise<{
    readonly caller: IssuedAuthorityRef;
    release(outcome: EndpointReleaseRequest["outcome"]): Promise<void>;
  }>;
}
export interface TrustedEndpointAuthorityPin {
  readonly account: AccountPin;
  readonly issuer: string;
  readonly issuerKeys: readonly { readonly kid: string; readonly publicKey: string }[];
  readonly authInstanceId: string;
  readonly authClusterDigest: string;
}
/** Factory verifies issuer attestation, holder key possession, broker account/credential and
 * current gate before branding. It privately constructs the stock native admission client.
 * No caller-authored admission callback, raw auth/evidence reader, signer or executor is accepted. */
export declare function createEndpointServiceClient(args: {
  readonly nc: NatsConnection;
  readonly trust: TrustedEndpointAuthorityPin;
  readonly holder: { readonly publicKey: string; sign(bytes: Uint8Array): Promise<Uint8Array> };
}): EndpointServiceClient;
export interface EndpointServiceClient {
  start(args: { readonly activation: Extract<EndpointServiceResponse, { readonly operation: "activate" | "renew" }>; readonly contractArtifacts: readonly ContractArtifact[]; readonly commands: readonly EpCommandDef[] }): Promise<{ readonly grant: EpServeGrant; readonly handle: EpServeHandle }>;
}
/** No implementations in this proposal. Existing SpaceAuth/mintCreds stay trusted-host-only. */
export type ForbiddenClientMaterial = SpaceAuth | NatsConnection;
