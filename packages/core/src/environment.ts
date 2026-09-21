type Digest = string;
type Count = number;

export interface EnvironmentReference {
  kind: string;
  id: string;
}

export interface OperationContext {
  id: string;
  signal: AbortSignal;
  deadline: number;
}

export interface EnvironmentFileReference {
  path: string;
  byteLength: Count;
  sha256: Digest;
}

export type EnvironmentImageReference =
  | { kind: "oci"; manifest: EnvironmentFileReference }
  | { kind: "template"; ref: string };

export interface EnvironmentImageDescription {
  reference: EnvironmentImageReference;
  record: { kind: "template" | "oci"; ref: string; digest?: string };
  bundleSha256: Digest;
  architecture: string;
  abi: string;
  protocolVersion: string;
  connector: { name: string; version: string; packageSha256: Digest };
  systemCaSetSha256: Digest;
}

export interface EnvironmentPlan {
  version: "cotal-environment-plan/v1";
  ownerInstanceId: string;
  profile: { name: string; sha256: Digest };
  image: {
    reference: EnvironmentImageReference;
    bundleSha256: Digest;
    architecture: string;
  };
  network: string | null;
  limits: { cpus: Count; memoryMiB: Count; diskGiB: Count };
  hostLimits: {
    memoryMaxMiB: Count;
    cpuQuotaMicros: Count;
    cpuPeriodMicros: Count;
    pidsMax: Count;
    nofile: Count;
  };
  workspaceSeed: EnvironmentFileReference | null;
  inputs: {
    descriptor: {
      id: string;
      purpose: "persona" | "customer-config" | "customer-key" | "agent-credential" | "mesh-tls-trust";
      lifetime: "launch" | "persistent";
      generation: Count;
      byteLength: Count;
      sha256: Digest;
      homePath: string | null;
      envName: string | null;
    };
    source: EnvironmentFileReference;
  }[];
  providerOptions: unknown;
}

export interface EnvironmentCapabilities {
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
  extend: false | { stepMs: number };
}

export interface EnvironmentPreflightCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface EnvironmentPreflight {
  checks: EnvironmentPreflightCheck[];
  capabilities: EnvironmentCapabilities;
  probedAt: number;
}

export interface EnvironmentLifetime {
  expiresAt: number | null;
  observedAt: number;
}

export interface EnvironmentStatus {
  state: "reserved" | "provisioning" | "running" | "paused" | "stopping" | "stopped" | "destroying" | "destroyed" | "unknown";
  operation: null | {
    id: string;
    kind: "provision" | "start" | "stop" | "checkpoint" | "restore" | "import" | "extend" | "destroy" | "maintenance";
    phase: "pending" | "active" | "held";
  };
  seat: { kind: string; id: string } | null;
  observedAt: number;
}

export interface EnvironmentProviderFileReference {
  environment: EnvironmentReference;
  id: string;
  byteLength: Count;
  sha256: Digest;
}

export type CheckpointOutput =
  | { kind: "host-path"; path: string; maxBytes: Count }
  | { kind: "provider-file"; maxBytes: Count };

export type CheckpointExport =
  | { kind: "host-path"; file: EnvironmentFileReference }
  | { kind: "provider-file"; file: EnvironmentProviderFileReference };

export type EnvironmentBearerSource =
  | { kind: "socket"; path: string }
  | { kind: "https"; url: string };

export interface EnvironmentLaunchAuthentication {
  bearerSource: EnvironmentBearerSource;
}

export interface EnvironmentLaunchRequest {
  authentication: EnvironmentLaunchAuthentication;
  credential: {
    id: string;
    purpose: "agent-credential";
    lifetime: "launch";
    generation: Count;
    byteLength: Count;
    sha256: Digest;
    homePath: null;
    envName: null;
  };
}

export interface EnvironmentProviderFacts {
  environment: EnvironmentReference;
  providerRef: string;
  engine: string;
  volumeId: string;
  state: "creating" | "running" | "stopped" | "failed";
  stoppedAt?: number;
  expiresAt?: number;
  network?: string;
  observedAt: number;
}

export interface EnvironmentDriver {
  describeImage(reference: EnvironmentImageReference, op: OperationContext): Promise<EnvironmentImageDescription>;
  preflight(plan: EnvironmentPlan): Promise<EnvironmentPreflight>;
  reserve(id: string): EnvironmentReference;
  facts(ref: EnvironmentReference, op: OperationContext): Promise<EnvironmentProviderFacts>;
  extend(ref: EnvironmentReference, op: OperationContext): Promise<EnvironmentLifetime>;
}

export interface EnvironmentHandle {
  exportCheckpoint(ref: { environment: EnvironmentReference; id: string }, output: CheckpointOutput, op: OperationContext): Promise<CheckpointExport>;
  readProviderFile(ref: EnvironmentProviderFileReference, op: OperationContext): AsyncIterable<Uint8Array>;
}

export interface EnvironmentRecordImage {
  kind: "template" | "oci";
  ref: string;
  digest?: string;
}

export interface EnvironmentRecord {
  version: "cotal-manager-environment-record/v1";
  id: string;
  provider: string;
  providerRef: string;
  space: string;
  host: string;
  arch: string;
  engine: string;
  volumeId: string;
  image: EnvironmentRecordImage;
  owner: string;
  createdAt: number;
  state: "creating" | "running" | "stopped" | "failed";
  stoppedAt?: number;
  expiresAt?: number;
  network?: string;
  capabilities: EnvironmentCapabilities;
  probedAt?: number;
}

export interface EnvironmentHostFacts {
  version: "cotal-environment-host-facts/v1";
  instanceId: string;
  host: string;
  arch: string;
  os: { platform: string; release: string };
  engines: { name: string; version?: string }[];
  kvm: { present: boolean; usable: boolean };
  headroom: {
    cpus: Count;
    memoryMiB: Count;
    diskGiB: Count;
    environmentSlots: Count;
  };
  observedAt: number;
}
