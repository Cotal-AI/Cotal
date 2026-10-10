import type { HostedEnvironmentReference } from "./environment.js";
import type { Extension } from "./registry.js";

/** Infrastructure provisioning only. Agent launch, authority and workflow execution belong to the
 * manager/host. Provider options are trusted operator configuration, never caller-supplied overrides. */
export interface EnvironmentProvisionProfile {
  name: string;
  provider: string;
  image: string;
  resources: { cpus: number; memoryMiB: number; diskGiB: number };
  maxDurationMs: number;
  providerOptions: unknown;
}

export interface EnvironmentObservation {
  environment: HostedEnvironmentReference;
  state: "creating" | "running" | "paused" | "terminating" | "terminated" | "unknown";
  observedAt: number;
}

/** An issued reference must come from the authenticated create response, never a name search. A
 * create error without a reference has an unknown outcome and must not cause another create. */
export interface EnvironmentProvisionDriver {
  readonly name: string;
  validate(profile: EnvironmentProvisionProfile): void;
  create(profile: EnvironmentProvisionProfile, operationId: string): Promise<HostedEnvironmentReference>;
  inspect(reference: HostedEnvironmentReference): Promise<EnvironmentObservation>;
  /** Requests destruction; only a later terminated observation proves it finished. */
  destroy(reference: HostedEnvironmentReference): Promise<void>;
  close(): void;
}

/** Provider factories register on import. Credentials stay with the trusted service process. */
export interface EnvironmentProvisionExtension extends Extension {
  readonly kind: "environment-provider";
  open(options: unknown): EnvironmentProvisionDriver;
}
