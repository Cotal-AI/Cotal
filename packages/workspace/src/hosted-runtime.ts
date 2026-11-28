import type { SecretStore, SecretStoreIdentity } from "@cotal-ai/core";

/** One assigned account incarnation. A display name alone cannot identify a hosted context. */
export interface HostedContextKey {
  readonly accountPublicKey: string;
  readonly lifecycleUid: string;
}

/** Inputs a hosted composition must supply rather than resolving them from cwd or process globals. */
export interface HostedContextInputs {
  readonly context: HostedContextKey;
  readonly space: string;
  readonly servers: string;
  readonly store: SecretStore;
  /** Compare this with the actual injected store and the daemon reload identity before serving. */
  readonly storeIdentity: SecretStoreIdentity;
  /** Explicit owner of non-secret local state, such as the auth ledger and IdP pin. */
  readonly stateDir: string;
  /** The endpoints a delivery context serves beside Plane-3, by name (for example `["artifacts"]`).
   *  Omitted or empty: none. The injected store must then hold each endpoint's material, written by
   *  the composition's issuer: see the delivery daemon's served-endpoint docs. */
  readonly endpoints?: readonly string[];
}

/** A context's readiness, separate from worker PID and broker transport liveness. */
export type HostedServiceState =
  | { readonly state: "starting" | "draining"; readonly context: HostedContextKey }
  | { readonly state: "ready"; readonly context: HostedContextKey }
  | { readonly state: "unavailable"; readonly context: HostedContextKey; readonly cause: string };

/** Services own their resources; CLI wrappers, not these handles, own process signals and exits. */
export interface HostedServiceHandle {
  readiness(): HostedServiceState | Promise<HostedServiceState>;
  /** Stop admission and settle only already accepted, bounded work. */
  drain(): Promise<void>;
  /** Idempotently release only the resources this context owns. */
  close(): Promise<void>;
}
