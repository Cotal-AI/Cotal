import type { NatsConnection } from "@nats-io/transport-node";
import type { EpServeGrant } from "./endpoint-service.js";
import type { EpServeHandle } from "./endpoint-serve.js";
import type { Extension } from "./registry.js";

/** One registry data plane, with its account authority and connections owned by its host. */
export interface RegistryServiceInputs {
  space: string;
  connection: NatsConnection;
  /** A separate connection carrying only the registry-reader profile. */
  reader: NatsConnection;
  grant: EpServeGrant;
  /** The host aborts before releasing its authority-plane claim, including during startup. */
  signal: AbortSignal;
  log: (line: string) => void;
  /** A failed reader rebind makes the owning lane unavailable; it never becomes an empty listing. */
  onFailure: (reason: string) => void;
}

/** Refusal is synchronous; stop also awaits the registry's in-flight handlers. */
export interface RegistryServiceHandle extends EpServeHandle {
  refuse(): void;
}

/** The composition root supplies the registry implementation without transferring signing custody. */
export interface RegistryService extends Extension {
  readonly kind: "registry-service";
  start(inputs: RegistryServiceInputs): Promise<RegistryServiceHandle>;
}
