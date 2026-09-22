export type HostedEnvironmentDigest = string;
export type HostedEnvironmentCount = number;

export interface HostedEnvironmentReference {
  kind: string;
  id: string;
}

export interface HostedOperationContext {
  id: string;
  signal: AbortSignal;
  deadline: number;
}

export interface HostedEnvironmentRuntimeReference {
  kind: string;
  id: string;
}

export interface HostedEnvironmentFileReference {
  path: string;
  byteLength: HostedEnvironmentCount;
  sha256: HostedEnvironmentDigest;
}

export interface HostedMaterialDescriptor {
  id: string;
  purpose: "persona" | "customer-config" | "customer-key" | "agent-credential" | "mesh-tls-trust";
  lifetime: "launch" | "persistent";
  generation: HostedEnvironmentCount;
  byteLength: HostedEnvironmentCount;
  sha256: HostedEnvironmentDigest;
  homePath: string | null;
  envName: string | null;
}

export interface HostedAgentCredentialDescriptor extends HostedMaterialDescriptor {
  purpose: "agent-credential";
  lifetime: "launch";
  homePath: null;
  envName: null;
}

export const HOSTED_ENVIRONMENT_RECORD_TEXT_MAX_BYTES = 2048;
export const HOSTED_AUTHORITY_URL_MAX_BYTES = 2048;

const hostedRecordTextBrand: unique symbol = Symbol("HostedEnvironmentRecordText");
const hostedAuthorityUrlBrand: unique symbol = Symbol("HostedAuthorityHttpsUrl");
const hostedPositiveStepBrand: unique symbol = Symbol("HostedPositiveStepMs");

export type HostedEnvironmentRecordText = string & { readonly [hostedRecordTextBrand]: true };
export type HostedAuthorityHttpsUrl = string & { readonly [hostedAuthorityUrlBrand]: true };
export type HostedPositiveStepMs = number & { readonly [hostedPositiveStepBrand]: true };

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

/** Validate a nonsecret string before it enters a dashboard-readable environment record. */
export function validateHostedEnvironmentRecordText(value: unknown, field: string): HostedEnvironmentRecordText {
  if (typeof value !== "string" || !value || utf8Bytes(value) > HOSTED_ENVIRONMENT_RECORD_TEXT_MAX_BYTES)
    throw new Error(`${field} must be a non-empty string of at most ${HOSTED_ENVIRONMENT_RECORD_TEXT_MAX_BYTES} UTF-8 bytes`);
  if (/\p{Cc}/u.test(value)) throw new Error(`${field} contains a control character`);
  if (/-----BEGIN [A-Z ]*(?:PRIVATE KEY|CREDENTIAL)[A-Z ]*-----/.test(value) || /^Bearer\s/i.test(value)
    || /(?:^|[^A-Za-z])(token|secret|api[_-]?key|credential|password)\s*[:=]/i.test(value))
    throw new Error(`${field} carries credential-shaped material`);
  try {
    const url = new URL(value);
    if (url.username || url.password || [...url.searchParams.keys()].some((key) => /token|key|secret|signature|credential|bearer/i.test(key)))
      throw new Error(`${field} carries credential-shaped URL material`);
  } catch (error) {
    if (error instanceof Error && error.message === `${field} carries credential-shaped URL material`) throw error;
  }
  return value as HostedEnvironmentRecordText;
}

/** Validate the remote bearer endpoint. The branded result is the only URL the launch type accepts. */
export function validateHostedAuthorityHttpsUrl(value: unknown): HostedAuthorityHttpsUrl {
  if (typeof value !== "string" || !value || utf8Bytes(value) > HOSTED_AUTHORITY_URL_MAX_BYTES)
    throw new Error(`hosted authority URL must be a non-empty string of at most ${HOSTED_AUTHORITY_URL_MAX_BYTES} UTF-8 bytes`);
  let url: URL;
  try { url = new URL(value); }
  catch { throw new Error("hosted authority URL is not a URL"); }
  if (url.protocol !== "https:") throw new Error("hosted authority URL must use https");
  if (!url.hostname) throw new Error("hosted authority URL must name a host");
  if (url.username || url.password) throw new Error("hosted authority URL must not contain userinfo");
  if (url.search) throw new Error("hosted authority URL must not contain a query");
  if (url.hash) throw new Error("hosted authority URL must not contain a fragment");
  return url.toString() as HostedAuthorityHttpsUrl;
}

/** Validate a provider's fixed positive extension step. */
export function validateHostedPositiveStepMs(value: unknown): HostedPositiveStepMs {
  if (!Number.isSafeInteger(value) || (value as number) <= 0)
    throw new Error("hosted environment extension step must be a positive safe integer");
  return value as HostedPositiveStepMs;
}

export type HostedEnvironmentImageReference =
  | { kind: "oci"; manifest: HostedEnvironmentFileReference }
  | { kind: "template"; ref: HostedEnvironmentRecordText };

export interface HostedEnvironmentRecordImage {
  kind: "template" | "oci";
  ref: HostedEnvironmentRecordText;
  digest?: HostedEnvironmentDigest;
}

export type HostedEnvironmentImageDescription = {
  bundleSha256: HostedEnvironmentDigest;
  architecture: string;
  abi: string;
  protocolVersion: string;
  connector: { name: string; version: string; packageSha256: HostedEnvironmentDigest };
  systemCaSetSha256: HostedEnvironmentDigest;
} & (
  | {
      manifest: HostedEnvironmentFileReference;
      reference?: never;
      record?: HostedEnvironmentRecordImage;
    }
  | {
      manifest?: never;
      reference: { kind: "template"; ref: HostedEnvironmentRecordText };
      record: HostedEnvironmentRecordImage & { kind: "template" };
    }
);

interface HostedEnvironmentPlanBase {
  version: "cotal-environment-plan/v1";
  ownerInstanceId: string;
  profile: { name: string; sha256: HostedEnvironmentDigest };
  limits: { cpus: HostedEnvironmentCount; memoryMiB: HostedEnvironmentCount; diskGiB: HostedEnvironmentCount };
  hostLimits: {
    memoryMaxMiB: HostedEnvironmentCount;
    cpuQuotaMicros: HostedEnvironmentCount;
    cpuPeriodMicros: HostedEnvironmentCount;
    pidsMax: HostedEnvironmentCount;
    nofile: HostedEnvironmentCount;
  };
  workspaceSeed: HostedEnvironmentFileReference | null;
  inputs: { descriptor: HostedMaterialDescriptor; source: HostedEnvironmentFileReference }[];
  providerOptions: unknown;
}

/** The local manifest arm preserves the pending local-provider plan shape. */
export type HostedEnvironmentPlan = HostedEnvironmentPlanBase & (
  | {
      image: {
        manifest: HostedEnvironmentFileReference;
        bundleSha256: HostedEnvironmentDigest;
        architecture: string;
      };
      network?: HostedEnvironmentRecordText | null;
    }
  | {
      image: {
        reference: { kind: "template"; ref: HostedEnvironmentRecordText };
        bundleSha256: HostedEnvironmentDigest;
        architecture: string;
      };
      network: HostedEnvironmentRecordText | null;
    }
);

export interface HostedEnvironmentCapabilities {
  guestBuild: boolean;
  custody: boolean;
  sessionHistory: boolean;
  materialRenewal: boolean;
  coldCheckpoint: boolean;
  memoryCheckpoint: boolean;
  nested: boolean;
  pauseKeepsMemory: boolean;
  snapshot: boolean;
  export: boolean;
  gpu: boolean;
  durableSeatHome: boolean;
  screen: boolean;
  exec: boolean;
  extend: false | { stepMs: HostedPositiveStepMs };
}

export interface HostedEnvironmentPreflightCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface HostedEnvironmentPreflight {
  checks: HostedEnvironmentPreflightCheck[];
  capabilities: HostedEnvironmentCapabilities;
  probedAt: number;
}

export interface HostedEnvironmentLifetime {
  expiresAt: number | null;
  observedAt: number;
}

export interface HostedEnvironmentProviderFileReference {
  environment: HostedEnvironmentReference;
  id: HostedEnvironmentRecordText;
  byteLength: HostedEnvironmentCount;
  sha256: HostedEnvironmentDigest;
}

/** The first arm is the pending local-provider output shape. */
export type HostedCheckpointOutput =
  | { path: string; maxBytes: HostedEnvironmentCount }
  | { kind: "host-path"; path: string; maxBytes: HostedEnvironmentCount }
  | { kind: "provider-file"; maxBytes: HostedEnvironmentCount };

export type HostedCheckpointExport =
  | { kind: "host-path"; file: HostedEnvironmentFileReference }
  | { kind: "provider-file"; file: HostedEnvironmentProviderFileReference };

export type HostedEnvironmentBearerSource =
  | { kind: "socket"; path: HostedEnvironmentRecordText }
  | { kind: "https"; url: HostedAuthorityHttpsUrl };

export interface HostedEnvironmentLaunchAuthentication {
  bearerSource: HostedEnvironmentBearerSource;
}

/** Closed base request fields remain required for both local and hosted providers. */
export interface ProviderEnvironmentLaunchRequest<Intent> {
  version: "cotal-environment-launch/v1";
  intent: Intent;
  intentSha256: HostedEnvironmentDigest;
  environment: HostedEnvironmentReference;
  seat: HostedEnvironmentRuntimeReference;
  guestBootId: string;
  operationId: string;
  issuance: { generation: string; acceptedToken: string };
  credential: HostedAgentCredentialDescriptor;
  materialSetSha256: HostedEnvironmentDigest;
  authentication?: HostedEnvironmentLaunchAuthentication;
}

/** A remote hosted launch requires the validated bearer source in addition to every base field. */
export interface HostedEnvironmentLaunchRequest<Intent> extends ProviderEnvironmentLaunchRequest<Intent> {
  authentication: HostedEnvironmentLaunchAuthentication;
}

export interface HostedEnvironmentProviderFacts {
  environment: HostedEnvironmentReference;
  providerRef: HostedEnvironmentRecordText;
  engine: HostedEnvironmentRecordText;
  volumeId: HostedEnvironmentRecordText;
  state: "creating" | "running" | "stopped" | "failed";
  stoppedAt?: number;
  expiresAt?: number;
  network?: HostedEnvironmentRecordText;
  observedAt: number;
}

/** Methods a driver adds beside the pending local-provider EnvironmentDriver contract. */
export interface HostedEnvironmentDriverExtension {
  describeHostedImage(reference: HostedEnvironmentImageReference, op: HostedOperationContext): Promise<HostedEnvironmentImageDescription>;
  preflightHosted(plan: HostedEnvironmentPlan): Promise<HostedEnvironmentPreflight>;
  reserveHosted(id: HostedEnvironmentRecordText): HostedEnvironmentReference;
  hostedFacts(ref: HostedEnvironmentReference, op: HostedOperationContext): Promise<HostedEnvironmentProviderFacts>;
  extendHosted(ref: HostedEnvironmentReference, op: HostedOperationContext): Promise<HostedEnvironmentLifetime>;
}

/** Methods a handle adds beside the pending local-provider EnvironmentHandle contract. */
export interface HostedEnvironmentHandleExtension {
  exportHostedCheckpoint(
    ref: { environment: HostedEnvironmentReference; id: string },
    output: HostedCheckpointOutput,
    op: HostedOperationContext,
  ): Promise<HostedCheckpointExport>;
  readHostedProviderFile(
    ref: HostedEnvironmentProviderFileReference,
    op: HostedOperationContext,
  ): AsyncIterable<Uint8Array>;
}

export interface ManagedEnvironmentRecord {
  version: "cotal-manager-environment-record/v1";
  id: HostedEnvironmentRecordText;
  provider: HostedEnvironmentRecordText;
  providerRef: HostedEnvironmentRecordText;
  space: HostedEnvironmentRecordText;
  host?: HostedEnvironmentRecordText;
  arch?: HostedEnvironmentRecordText;
  engine?: HostedEnvironmentRecordText;
  volumeId?: HostedEnvironmentRecordText;
  image: HostedEnvironmentRecordImage;
  owner: HostedEnvironmentRecordText;
  createdAt: number;
  state: "creating" | "running" | "stopped" | "failed";
  stoppedAt?: number;
  expiresAt?: number;
  network?: HostedEnvironmentRecordText;
  capabilities: HostedEnvironmentCapabilities;
  probedAt?: number;
}

export interface EnvironmentHostFacts {
  version: "cotal-environment-host-facts/v1";
  instanceId: HostedEnvironmentRecordText;
  host: HostedEnvironmentRecordText;
  arch: HostedEnvironmentRecordText;
  os: { platform: HostedEnvironmentRecordText; release: HostedEnvironmentRecordText };
  engines: { name: HostedEnvironmentRecordText; version?: HostedEnvironmentRecordText }[];
  kvm: { present: boolean; usable: boolean };
  headroom: {
    cpus: HostedEnvironmentCount;
    memoryMiB: HostedEnvironmentCount;
    diskGiB: HostedEnvironmentCount;
    environmentSlots: HostedEnvironmentCount;
  };
  observedAt: number;
}
