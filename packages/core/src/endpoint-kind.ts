import type { EndpointKind } from "./types.js";

/** Validate an endpoint **kind** (`card.kind`, `COTAL_KIND`, or an agent file's `kind:`): the
 *  closed `"agent" | "endpoint"` set ({@link EndpointKind}). The endpoint branches on
 *  `card.kind === "agent"` for the authed agent's `dm_` incarnation proof before presence
 *  publishes, so an unvalidated string would skip that proof. */
export function assertValidKind(kind: unknown, where?: string): EndpointKind {
  if (kind === "agent" || kind === "endpoint") return kind;
  throw new Error(
    `${where ? `${where}: ` : `invalid kind ${JSON.stringify(kind)}: `}"kind" must be "agent" or "endpoint"`,
  );
}

