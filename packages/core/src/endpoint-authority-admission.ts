import { EpEnvelopeError, type EndpointRequest } from "./endpoint-envelope.js";
import type { EpServeGrant } from "./endpoint-service.js";
import type { IssuedAuthorityRef } from "./issued-authority.js";
import type { ParsedEpRequest } from "./endpoint-subjects.js";

export type EndpointTerminalOutcome = "executed" | "not-executed" | "unknown";
export interface EndpointHeldAdmission {
  readonly caller: IssuedAuthorityRef;
  readonly commands: readonly string[];
  release(outcome: EndpointTerminalOutcome): Promise<void>;
}
export interface EndpointRequestAuthority {
  admit(args: { serving: EpServeGrant; subject: ParsedEpRequest; request: EndpointRequest; requestSubject: string }): Promise<EndpointHeldAdmission>;
}
/** Private provenance registry. Only the trusted stock authority client module receives the
 * constructor, never package-root consumers or structural callbacks. */
const AUTHORITIES = new WeakSet<EndpointRequestAuthority>();
export function stockEndpointRequestAuthority(admit: EndpointRequestAuthority["admit"]): EndpointRequestAuthority {
  const value = Object.freeze({ admit });
  AUTHORITIES.add(value);
  return value;
}
export function assertStockEndpointRequestAuthority(value: EndpointRequestAuthority | undefined): asserts value is EndpointRequestAuthority {
  if (!value || !AUTHORITIES.has(value)) throw new EpEnvelopeError("permission-denied", "delegated serving requires stock-authenticated request authority; structural callbacks never establish custody");
}
